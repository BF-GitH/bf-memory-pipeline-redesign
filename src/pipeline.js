// BF Memory Pipeline - Main Orchestrator (redesign-v2)
//
// THREE PATHS (S4):
//  (1) INJECTION — pure code, no LLM call ever blocks reply generation. The
//      CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_DATA handlers read the persistent
//      MEMORY SHEET from chat_metadata (getMemorySheet — never empty; seed text on new
//      chats) and splice it before the last user message, optionally trimming the visible
//      chat history to the last agent2ContextMessages user/AI turns (skipped while the
//      sheet is still the seed — no memory yet to replace history with).
//  (2) SETTLE AGENT RUN — MESSAGE_RECEIVED selects the newest SETTLED unprocessed messages
//      honoring the bufferHoldBack hold-back window (§7), hands the held-back tail to the
//      Memory Agent as clearly labeled TENTATIVE planning context, and on success stores the
//      rebuilt sheet + promotes the per-message bf_mem_processed watermarks. A failed run keeps
//      the prior sheet and never watermarks (F-SCRIBE-1). The hold-back window is what keeps us
//      off the still-swipable newest messages — no swipe/settle debounce is needed.
//  (3) LIFECYCLE — Stop/chat-change/delete handlers: cancel, per-chat state resets.

import { injectMemoryContext } from './agent-writer.js';
import { runMemoryAgent } from './agent-memory.js';
import { runReflection } from './agent-reflect.js';
import { getAllDatabases } from './database.js';
import { cancelInFlightLLM } from './llm-call.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, saveCurrentToActiveProfile, setRunTokens, setMainOutputTokens, addAgent3Tokens, addReflectionTokens, getScene, getReflection, getMemorySheet, setMemorySheet, reloadEntitiesUI, beginRun, endRun, setPendingRun, getPendingRun, consumePendingRun, isTriviallyEmptyForExtraction } from './settings.js';
import { detectAndRecord, showEntityPopup } from './agent-entities.js';

// G4 hardcoded-on (redesign-v2): the character-registry scan no longer has settings keys.
const CHARACTER_CHECK_INTERVAL = 10;

// Pipeline state
// F-ORCH-2 (overlapping internal-call windows): a REFERENCE COUNT (never a boolean) —
// every internal flow increments on entry and decrements in its own `finally` (clamped
// at 0 — CHAT_CHANGED force-resets to 0, so a straggling finally must not drive it
// negative), so overlapping windows compose correctly. Read ONLY via isInternalCall().
let internalCallDepth = 0;
const isInternalCall = () => internalCallDepth > 0;
let pipelineJustInjected = false; // guards against double-fire of CHAT_COMPLETION_PROMPT_READY
let injectedResetTimer = null; // auto-clears pipelineJustInjected so an aborted generation can't block the NEXT turn's injection
let pipelineCancelled = false; // set true when user clicks Stop / disables mid-run; checked before DB writes
let groupSkipToastShown = false; // show-once toast when skipping group chats
let runRecordedInput = false; // true once setRunTokens fired this generation cycle; gates main-output attribution so swipes don't desync the counters
// Reflection / consolidation cadence state — armed from the settled memory-agent run.
let successfulRunsSinceReflection = 0;
let reflectionPending = null; // {runId, charAvatar, profileId, characterInfo, userPersona}
let reflectionInFlight = false; // guard so overlapping turns can't double-fire the pass
// Post-reply extraction guard: prevents two MESSAGE_RECEIVED events from launching
// overlapping extractions that race on the same DB save.
let memoryExtractionInFlight = false;
// F-ORCH-3 (silent memory loss): ONE-SHOT retry state for extraction attempts dropped by the
// busy / cancelled early-returns in runMemoryExtraction (see the comments at each use).
let extractionRetryAfterBusy = false;
let cancelledRetryArmed = false;
// Character registry cadence (deterministic scan, no LLM). Per-chat: reset on CHAT_CHANGED.
let runsSinceEntityCheck = 0;
let entityCheckInFlight = false;

/**
 * Return the first message-ARRAY container on a CHAT_COMPLETION_PROMPT_READY payload (same
 * candidate order as agent-writer.js's private firstMessageArray, so the token comparison
 * counts EXACTLY the array injectMemoryContext will mutate). Null when none is an array.
 * @param {*} data
 * @returns {Array|null}
 */
function firstInjectableArray(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.chat, data.messages, data.prompt, data.chatCompletion, data.messageArray];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return null;
}

/**
 * Count tokens for a chat-completion message array (role wrappers included).
 * Uses ST's local tokenizer — approximate, but same tokenizer both sides so the delta holds.
 * Used by the sheet-injection token comparison (Tokens tab). PURE CODE — no LLM call.
 */
async function countChatTokens(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const ctx = SillyTavern.getContext();
    try {
        if (ctx.countTokensOpenAIAsync) return await ctx.countTokensOpenAIAsync(arr, true);
        // fallback: sum per-message
        let total = 0;
        for (const m of arr) total += await (ctx.getTokenCountAsync?.(m.content || m.mes || '') ?? 0);
        return total;
    } catch { return 0; }
}

/**
 * Record this generation's injection token comparison for the Tokens tab (baseline = prompt
 * before trim+sheet, actual = after). Wrapped in try/catch so a tokenizer failure can never
 * abort injection. The Memory Agent's own tokens are folded in later via addAgent3Tokens
 * (post-reply, background). Sets runRecordedInput so the MESSAGE_RECEIVED handler only
 * attributes main-model output to a run that actually recorded input this generation cycle
 * (prevents swipe-driven counter desync).
 */
function recordRunTokens({ baselineInput, actualInput }) {
    try {
        setRunTokens({
            baselineInput: baselineInput || 0,
            actualInput: actualInput || 0,
            mainOutput: 0,
        });
        runRecordedInput = true;
    } catch (err) {
        addDebugLog('info', `Token recording failed (non-fatal): ${err.message || err}`);
    }
}

/**
 * Get recent chat messages (generic utility — kept for slash commands / future callers).
 */
function getRecentMessages(count) {
    const context = SillyTavern.getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return [];

    const messages = [];
    const startIndex = Math.max(0, chat.length - count);
    for (let i = startIndex; i < chat.length; i++) {
        if (chat[i] && chat[i].mes) {
            messages.push(chat[i]);
        }
    }
    return messages;
}

/**
 * Get character info for prompts (full card). KEPT for reflection arming (S4).
 */
function getCharacterInfo() {
    const context = SillyTavern.getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return '';

    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 2000)}`);
    if (char.personality) parts.push(`Personality: ${char.personality.substring(0, 1000)}`);
    if (char.scenario) parts.push(`Scenario: ${char.scenario.substring(0, 1000)}`);
    return parts.join('\n');
}

/**
 * B4 (token cut): a SHORT character brief for the background agents (they extract facts from
 * message text, not the card). Name + the first ~400 chars of the description — typically ~10×
 * smaller than the full card. Returns '' when no character is selected.
 * @returns {string}
 */
function getCharacterInfoBrief() {
    const context = SillyTavern.getContext();
    const char = context?.characters?.[context?.characterId];
    if (!char) return '';
    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 400)}`);
    return parts.join('\n');
}

/**
 * Get user persona info
 */
function getUserPersona() {
    const context = SillyTavern.getContext();
    return context.persona?.description || context.name1 || '';
}

// --- UI: Indicator ---

function showWorkingIndicator() {
    let indicator = document.getElementById('bf_mem_working_indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'bf_mem_working_indicator';
        indicator.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Memory Pipeline: updating memory...';
        indicator.style.cssText = `
            display: flex; align-items: center; gap: 8px;
            padding: 10px 15px; margin: 5px 0;
            background: var(--SmartThemeBlurTintColor, #1a1a2e);
            border: 1px solid var(--SmartThemeBorderColor, #444);
            border-radius: 6px; color: #7bb3ff; font-size: 13px;
        `;
        const sendForm = document.getElementById('send_form');
        if (sendForm) {
            sendForm.parentNode.insertBefore(indicator, sendForm);
        }
    }
    indicator.style.display = 'flex';
}

function hideWorkingIndicator() {
    const indicator = document.getElementById('bf_mem_working_indicator');
    if (indicator) indicator.style.display = 'none';
}

/**
 * Cancel the in-flight pipeline run PROMPTLY (cancel fix). Sets pipelineCancelled (so the
 * pre-write gates bail) AND aborts any in-flight agent LLM call via the llm-call cancel
 * hook. Wired to:
 *   - the `enabled` toggle handler when toggled OFF (settings.js), and
 *   - the GENERATION_STOPPED event (Stop button).
 * Idempotent and safe to call when nothing is running.
 * @param {string} [reason='cancel'] - short reason tag for the debug log (e.g. 'disabled', 'stopped')
 */
export function cancelActiveRun(reason = 'cancel') {
    pipelineCancelled = true;
    clearInjectedGuard();
    runRecordedInput = false;
    // Truly abort in-flight agent calls — not just refuse to commit their results.
    try { cancelInFlightLLM(reason); } catch { /* best-effort */ }
    hideWorkingIndicator();
    updateStatus('idle');
    addDebugLog('info', `Active pipeline run cancelled (${reason}) — in-flight LLM calls aborted`, {
        subsystem: 'pipeline', event: 'pipeline.cancel', reason: reason.toUpperCase(),
    });
}

/**
 * Set the injection double-fire guard with a short auto-clear. The guard exists to stop a
 * SECOND CHAT_COMPLETION_PROMPT_READY within the same generation from splicing a second
 * sheet copy; those double-fires land within milliseconds, so a 2s auto-clear is generous.
 * Without the auto-clear, a generation that errored out without ever firing
 * MESSAGE_RECEIVED / GENERATION_STOPPED left the guard stuck true and silently dropped the
 * NEXT turn's injection.
 */
function setInjectedGuard() {
    pipelineJustInjected = true;
    if (injectedResetTimer) clearTimeout(injectedResetTimer);
    injectedResetTimer = setTimeout(() => {
        injectedResetTimer = null;
        pipelineJustInjected = false;
    }, 2000);
}

/** Clear the injection double-fire guard (and its pending auto-clear timer). */
function clearInjectedGuard() {
    pipelineJustInjected = false;
    if (injectedResetTimer) { clearTimeout(injectedResetTimer); injectedResetTimer = null; }
}

/** A genuine chat turn: has text, isn't a system/narrator line or an extension-typed entry. */
function isGenuineMessage(m) {
    return !!(m && m.mes && !m.is_system && !m.extra?.type);
}

/** Coerce a chat message into the {index, role, name, text} shape runMemoryAgent expects. */
function toAgentMessage(m, index) {
    return { index, role: m.is_user ? 'USER' : 'CHAR', name: String(m.name || '').trim(), text: m.mes };
}

/**
 * Post-reply Memory Agent run — fires OFF the latency-critical pre-generation path.
 * SETTLED BUFFER (§7): facts may only be extracted from messages at
 * index <= chat.length-1-bufferHoldBack; the held-back tail is passed ONLY as clearly
 * labeled TENTATIVE planning context (the agent must not write_fact from it). The agent
 * runs on EVERY settled reply — even with zero settled messages it refreshes the sheet
 * from the store + tentative context. Watermarks (bf_mem_processed) are stamped ONLY on
 * the settled messages actually sent AND only when the run succeeded (F-SCRIBE-1).
 */
async function runMemoryExtraction() {
    if (memoryExtractionInFlight) {
        // F-ORCH-3 (silent memory loss): returning silently here permanently dropped this
        // exchange. Arm a ONE-SHOT retry chained to the in-flight run's completion: its
        // `finally` re-schedules the settle extraction ('retry-busy') once the store is free.
        // Never re-armed while already armed — no retry loop possible.
        if (!extractionRetryAfterBusy) {
            extractionRetryAfterBusy = true;
            addDebugLog('info', 'Memory agent (post-reply): prior extraction still committing — ONE retry chained to its completion');
        }
        return; // a prior extraction is still committing
    }
    const settings = getSettings();
    if (!settings || !settings.enabled) return;
    if (isInternalCall()) return; // never extract off our own agent calls
    if (pipelineCancelled) {
        // F-ORCH-3: a true flag here means the user pressed Stop on a LATER generation — yet the
        // silent drop skipped the EARLIER, completed exchange forever. Schedule ONE timer retry:
        // if the cancel has cleared by fire time the exchange is recovered; if the user stayed
        // stopped+idle the retry drops again WITH a log and does NOT re-arm (one-shot; reset
        // when a run actually proceeds, and on CHAT_CHANGED).
        if (!cancelledRetryArmed) {
            cancelledRetryArmed = true;
            addDebugLog('info', 'Memory agent (post-reply): skipped — generation was stopped/cancelled; scheduling ONE retry so the completed exchange isn\'t silently dropped');
            // ONE-SHOT retry (no post-passes), deferred to the next tick so the cancel can clear
            // (MESSAGE_RECEIVED resets pipelineCancelled). If still cancelled at fire time,
            // cancelledRetryArmed being set drops it without re-arming — no retry loop.
            setTimeout(() => { runMemoryExtraction(); }, 0);
        } else {
            addDebugLog('info', 'Memory agent (post-reply): still cancelled on retry — exchange left unprocessed (no further retries)');
        }
        return;
    }
    const ctx0 = SillyTavern.getContext();
    if (ctx0.groupId || ctx0.selected_group) return; // group chats unsupported

    // Catch-up import owns the store while it runs — its chunked watermark/resume logic and
    // this path racing on the same messages/saves would double-extract. The importer ends
    // with its own sheet rebuild, so nothing is lost by deferring.
    try {
        const { isCatchupRunning } = await import('./catchup-import.js');
        if (isCatchupRunning()) {
            addDebugLog('info', 'Memory agent (post-reply): catch-up import in progress — skipping (importer rebuilds the sheet itself)');
            return;
        }
    } catch { /* module unavailable — proceed */ }

    const chat = ctx0.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    // ── SETTLED BUFFER (§7) ─────────────────────────────────────────────────────────
    // H = hold-back: the newest H messages are NOT extraction-eligible (they may still be
    // swiped/edited). Everything at index <= maxIdx that is genuine + unprocessed is the
    // settled extraction window (capped to the NEWEST 12 so a long backlog batches);
    // everything after maxIdx is the TENTATIVE planning tail.
    const rawHoldBack = Number(settings.bufferHoldBack);
    const holdBack = Number.isFinite(rawHoldBack) ? Math.min(10, Math.max(0, Math.floor(rawHoldBack))) : 4;
    const maxIdx = chat.length - 1 - holdBack;
    const SETTLED_BATCH_MAX = 12;

    const settledMessages = [];
    const trivialIndices = []; // trivially-empty settled messages — stamped processed WITHOUT an LLM
    for (let i = 0; i <= maxIdx; i++) {
        const m = chat[i];
        if (!isGenuineMessage(m)) continue;
        // bf_mem_processed gating (source of truth): true = done; a stuck 'in-flight' from a
        // crashed run is terminal (don't blindly re-extract a possibly half-written exchange).
        if (m.extra?.bf_mem_processed) continue;
        if (isTriviallyEmptyForExtraction(m.mes)) { trivialIndices.push(i); continue; }
        settledMessages.push(toAgentMessage(m, i));
    }
    if (settledMessages.length > SETTLED_BATCH_MAX) {
        settledMessages.splice(0, settledMessages.length - SETTLED_BATCH_MAX); // keep the NEWEST 12
    }

    const tentativeMessages = [];
    for (let i = Math.max(0, maxIdx + 1); i < chat.length; i++) {
        const m = chat[i];
        if (!isGenuineMessage(m)) continue;
        tentativeMessages.push(toAgentMessage(m, i));
    }

    // EMPTY-SCOPE SKIP, per message (atomic #13, hardcoded ON): trivially-empty settled
    // messages (pure asterisk actions / OOC / very short) carry no extractable facts — stamp
    // them processed directly, no token spent, no memory-loss risk.
    if (trivialIndices.length > 0) {
        for (const i of trivialIndices) {
            chat[i].extra = { ...(chat[i].extra || {}), bf_mem_processed: true };
        }
        SillyTavern.getContext().saveChatDebounced?.();
        addDebugLog('info', `Memory agent (post-reply): ${trivialIndices.length} trivially-empty settled msg(s) stamped processed without an LLM call`);
    }

    // Degenerate chat (nothing genuine anywhere) — nothing to extract OR plan from.
    if (settledMessages.length === 0 && tentativeMessages.length === 0) {
        addDebugLog('info', 'Memory agent (post-reply): no genuine messages — skipping');
        return;
    }

    // CAPTURE-AT-WRITE at extraction start: pin the active DB profile + character avatar so a
    // mid-extraction chat/character switch can't land facts in the wrong slot or contaminate
    // another character.
    const capturedDbProfile = settings.activeDbProfile;
    const capturedCharAvatar = ctx0.characters?.[ctx0.characterId]?.avatar || '';
    const startTime = Date.now();
    // Debug-log redesign §2: REUSE the turn's armed pendingRun id so a turn's events group under
    // ONE id. Fall back to minting `M…` only when there's no armed run.
    const pending = getPendingRun();
    const runId = pending?.runId || `M${startTime.toString(36).slice(-5)}`;
    beginRun(runId);

    // PER-STAGE TIMING for the POST-REPLY path (observability only — no behavior change).
    const postStageMs = { agent3Ms: null, snapshotMs: null };

    // WATERMARK AT SCOPE-TIME (atomic #12). Stamp the settled messages actually being sent
    // with an 'in-flight' marker BEFORE the agent LLM call, not only after commit. A mid-run
    // error or character switch then never leaves the window un-watermarked and re-extracted
    // next turn. States: 'in-flight' while running → true on commit; reset to false on
    // explicit discard (cancel / character change / returned agent error — F-SCRIBE-1: none
    // of those may promote the watermark) so the next genuine turn reprocesses; left
    // 'in-flight' on an unexpected throw AFTER the agent's writes committed (terminal —
    // don't blindly re-extract a possibly half-written exchange).
    const BF_MEM_IN_FLIGHT = 'in-flight';
    const settledIndices = settledMessages.map(m => m.index);
    const setWatermark = (val) => {
        let changed = false;
        for (const i of settledIndices) {
            if (chat[i] && chat[i].extra?.bf_mem_processed !== val) {
                chat[i].extra = { ...(chat[i].extra || {}), bf_mem_processed: val };
                changed = true;
            }
        }
        if (changed) SillyTavern.getContext().saveChatDebounced?.();
    };
    setWatermark(BF_MEM_IN_FLIGHT); // no-op on a sheet-only run (settled window empty)

    memoryExtractionInFlight = true;
    // F-ORCH-3: a run is genuinely proceeding — re-open the one-shot cancelled-retry window so a
    // FUTURE cancelled drop (a distinct event) may schedule its own single retry again.
    cancelledRetryArmed = false;
    internalCallDepth++; // F-ORCH-2: ref-counted internal window (paired with the finally below)
    let memoryResult = null;
    // H7: track whether we got far enough that the agent may have written to the store. Until
    // runMemoryAgent resolves successfully, NOTHING here has persisted to the DB, so an unexpected
    // throw before that point resets the watermark to false so a later turn can retry. After the
    // agent's writes begin we keep the prior terminal behavior (don't re-extract a possibly
    // half-written exchange).
    let reachedCommit = false;
    try {
        showWorkingIndicator();
        // B4: the agent extracts facts from the MESSAGE TEXT, not the character card — a short
        // brief is enough to anchor {{char}}.
        const characterInfo = getCharacterInfoBrief();
        const userPersona = getUserPersona();

        addDebugLog('info', `[${runId}] Memory agent (post-reply): ${settledMessages.length} settled (hold-back ${holdBack}, msgs ${settledIndices.length ? `${settledIndices[0]}–${settledIndices[settledIndices.length - 1]}` : '—'}), ${tentativeMessages.length} tentative`);

        const agent3ProfileId = settings.agent3Profile || null;
        const agent3Start = Date.now();
        // TEMPORAL GROUNDING: derive the observation timestamp (ISO) from the NEWEST settled
        // message (facts come only from settled text), falling back to the newest tentative
        // message, then to now. Never throws — degrades to current time.
        let observationDate;
        try {
            const newest = settledMessages[settledMessages.length - 1] || tentativeMessages[tentativeMessages.length - 1];
            const sd = (newest && Number.isInteger(newest.index)) ? chat[newest.index]?.send_date : null;
            const ts = (sd != null) ? new Date(sd).getTime() : NaN;
            observationDate = (Number.isFinite(ts) ? new Date(ts) : new Date()).toISOString();
        } catch (_) {
            observationDate = new Date().toISOString();
        }
        // THE MEMORY AGENT (redesign-v2): one background tool-loop session that extracts new
        // facts from the SETTLED window, anticipates the next scene off the TENTATIVE tail,
        // AND rebuilds the persistent memory sheet. It saves its own touched categories; the
        // durable profile snapshot below stays here. Use-it-or-lose-it buffered bumps are
        // drained inside runMemoryAgent (they ride its per-category saves).
        memoryResult = await runMemoryAgent({
            settledMessages,
            tentativeMessages,
            characterInfo,
            userPersona,
            profileId: agent3ProfileId,
            priorSheetText: getMemorySheet()?.text || '',
            reflection: getReflection(),
            observationDate,
            runId,
            extractOnly: false,
        }).catch(err => ({ sheetText: null, applied: [], error: err.message, tokensIn: 0, tokensOut: 0, rounds: 0, toolCallCount: 0 }));
        postStageMs.agent3Ms = Date.now() - agent3Start; // observability: agent LLM call wall-clock

        // Fold the agent's tokens into the session totals WITHOUT bumping the run count
        // and update lastRunTokens.
        addAgent3Tokens({ agent3Input: memoryResult?.tokensIn || 0, agent3Output: memoryResult?.tokensOut || 0 });

        if (!memoryResult || memoryResult.error) {
            if (memoryResult?.error) addDebugLog('fail', `[${runId}] Memory agent error: ${memoryResult.error}`, {
                subsystem: 'agent3', event: 'agent3.run', reason: 'ERROR',
                data: { agent: 'memory-agent', profileId: agent3ProfileId, success: false, error: memoryResult.error, durationMs: Date.now() - startTime },
            });
            // F-SCRIBE-1: a failed run (loop error / missing #SHEET) persisted nothing — clear
            // the watermark so a later turn retries, and KEEP the prior sheet (never blanked).
            setWatermark(false);
            return;
        }

        // H7: the agent resolved successfully — its tool-loop writes are now committed to the
        // store (runMemoryAgent saved the touched categories). From here on a throw is terminal.
        reachedCommit = true;

        // The committed writes, in the updates-like shape the Last Generated / Last Inserted
        // panels render. write_fact only records CHANGED writes on .applied, so generated ==
        // inserted here (no-op re-writes never reach either panel).
        const committed = (memoryResult.applied || []).map(({ category, key, fact, status }) => ({
            category,
            key,
            value: String(fact?.value ?? ''),
            tags: Array.isArray(fact?.tags) ? fact.tags : [],
            knownBy: Array.isArray(fact?.knownBy) ? fact.knownBy : [],
            context: (typeof fact?.context === 'string' && fact.context) ? fact.context : undefined,
            source: fact?.source,
            status: status || 'NEW',
            changed: true,
        }));
        setLastGenerated(committed);

        // pipelineCancelled may have flipped (user clicked Stop) while we awaited the LLM.
        // The agent's writes are already saved (same exposure as the old applyUpdates path);
        // we only withhold the watermark + sheet so the next genuine turn reprocesses.
        if (pipelineCancelled) {
            addDebugLog('info', `[${runId}] Cancelled mid-extraction — withholding watermark/sheet (${committed.length} write(s) already stored)`);
            setWatermark(false); // user stopped — let the next genuine turn reprocess
            setLastInserted(committed);
            return;
        }

        // Character-changed guard: don't stamp/sheet another character's chat.
        const liveCtx = SillyTavern.getContext();
        const currentCharAvatar = liveCtx.characters?.[liveCtx.characterId]?.avatar || '';
        if (currentCharAvatar !== capturedCharAvatar) {
            addDebugLog('fail', `[${runId}] Character changed mid-extraction (${capturedCharAvatar} -> ${currentCharAvatar}) — withholding watermark/sheet`);
            if (typeof toastr !== 'undefined') {
                toastr.warning('BF Memory: extraction result discarded — you switched characters');
            }
            setWatermark(false); // wrong character now active — let this char's next turn reprocess
            setLastInserted(committed);
            return;
        }

        addDebugLog('info', `[${runId}] Memory agent: ${committed.length} committed write(s), ${memoryResult.rounds} round(s), ${memoryResult.toolCallCount} tool call(s)`, {
            subsystem: 'agent3', event: 'agent3.run',
            data: {
                agent: 'memory-agent', profileId: agent3ProfileId, success: true,
                durationMs: Date.now() - startTime, settled: settledMessages.length, tentative: tentativeMessages.length, holdBack,
                tokensIn: memoryResult.tokensIn ?? null, tokensOut: memoryResult.tokensOut ?? null,
                committed: committed.length, rounds: memoryResult.rounds, toolCallCount: memoryResult.toolCallCount,
            },
        });
        setLastInserted(committed);

        // PERSISTENT MEMORY SHEET: store the freshly-composed sheet so the pure-code injection
        // path reads it on the next prompt. A failed run never reaches here, so the prior
        // sheet is only ever REPLACED by a good one.
        if (memoryResult.sheetText) {
            setMemorySheet(memoryResult.sheetText, { runId, sourceMessageIndex: chat.length - 1 });
        }

        // Promote the in-flight watermark to committed (true). setWatermark only saves when a
        // value actually changes (no redundant full-chat write).
        setWatermark(true);

        // Persist to the captured DB profile slot (capture-at-write). runMemoryAgent already
        // saved each touched category (including use-it-or-lose-it bump categories) — this is
        // the durable profile snapshot on top.
        if (committed.length > 0) {
            const snapStart = Date.now();
            await saveCurrentToActiveProfile(capturedDbProfile);
            postStageMs.snapshotMs = Date.now() - snapStart; // observability: durable snapshot wall-clock
        }

        // Reflection cadence (G4 hardcoded interval 12): armed from the settled memory-agent
        // run and executed by maybeRunReflection() on the same settle chain. Its #STORY
        // summary feeds the memory sheet's rolling story summary on the NEXT agent run.
        successfulRunsSinceReflection++;
        const REFLECTION_INTERVAL = 12; // G4 hardcoded-on
        if (successfulRunsSinceReflection >= REFLECTION_INTERVAL && !reflectionPending && !reflectionInFlight) {
            reflectionPending = {
                runId, charAvatar: capturedCharAvatar,
                profileId: settings.agent3Profile || null,
                characterInfo: getCharacterInfo(), userPersona,
            };
            addDebugLog('info', `[${runId}] Reflection armed (will run after settle; ${successfulRunsSinceReflection}/${REFLECTION_INTERVAL} runs)`);
        }
    } catch (err) {
        // Graceful degradation: a memory-extraction failure must never break the next turn.
        addDebugLog('fail', `[${runId}] Memory agent (post-reply) failed (non-fatal): ${err.message || err}`);
        // H7: if we threw BEFORE the agent committed anything, the exchange is un-written —
        // reset the 'in-flight' watermark to false so a later genuine turn re-extracts it.
        if (!reachedCommit) {
            try {
                setWatermark(false);
                addDebugLog('info', `[${runId}] Memory agent: reset 'in-flight' watermark (throw before commit) — exchange will re-extract next turn`);
            } catch { /* watermark reset is best-effort — never rethrow from the catch */ }
        }
    } finally {
        memoryExtractionInFlight = false;
        // F-ORCH-2: decrement (never assign false) — clamped, see the counter's declaration.
        internalCallDepth = Math.max(0, internalCallDepth - 1);
        hideWorkingIndicator();
        // F-ORCH-3: consume a busy-drop retry chained to THIS run — re-run the extraction ONCE
        // now that the store is free (memoryExtractionInFlight was cleared above). Deferred to
        // the next tick (no post-passes); every guard re-evaluates at fire time.
        if (extractionRetryAfterBusy) {
            extractionRetryAfterBusy = false;
            setTimeout(() => { runMemoryExtraction(); }, 0);
        }
        // OBSERVABILITY: one concise post-reply timing line (debug level).
        try {
            const postTotalMs = Date.now() - startTime;
            addDebugLog('debug',
                `[${runId}] Stage timing (post-reply): agent3=${postStageMs.agent3Ms ?? '-'}ms ` +
                `snapshot=${postStageMs.snapshotMs ?? '-'}ms total=${postTotalMs}ms`,
                {
                    runId, subsystem: 'pipeline', event: 'pipeline.timing',
                    data: { phase: 'post-reply', ...postStageMs, totalMs: postTotalMs },
                },
            );
        } catch { /* logging must never break the turn */ }
        endRun(); // clear the ambient run id once post-reply extraction's logging window closes
    }
}

/**
 * Run an armed reflection pass. Called from the settle path so it never blocks the
 * latency-critical pre-generation path. Fully guarded: skips if disabled, cancelled,
 * in a group chat, the character changed since arming, or another pass is in flight.
 * Wrapped in try/catch — a reflection failure must never break the pipeline.
 * Reflection is hardcoded ON (G4); its #STORY summary feeds the memory sheet (S3).
 */
async function maybeRunReflection() {
    const pending = reflectionPending;
    if (!pending || reflectionInFlight) return;
    const settings = getSettings();
    if (!settings || !settings.enabled) { reflectionPending = null; return; }
    if (pipelineCancelled) { reflectionPending = null; return; }
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) { reflectionPending = null; return; }
    // Character-changed guard (same class as extraction writes): don't synthesize observations
    // onto the wrong character's attachments if the user switched mid-session.
    const currentCharAvatar = ctx.characters?.[ctx.characterId]?.avatar || '';
    if (currentCharAvatar !== pending.charAvatar) {
        addDebugLog('info', `[${pending.runId}] Reflection skipped (character changed since arming)`);
        reflectionPending = null;
        return;
    }

    reflectionPending = null;
    reflectionInFlight = true;
    successfulRunsSinceReflection = 0; // reset the cadence regardless of outcome
    internalCallDepth++; // F-ORCH-2: the reflection LLM call can't re-trigger the pipeline (paired with the finally)
    const reflectStart = Date.now();
    try {
        updateStatus('running', 'Reflecting (consolidating memory)...');
        const reflResult = await runReflection({
            runId: pending.runId,
            scene: getScene(),
            characterInfo: pending.characterInfo || '',
            userPersona: pending.userPersona || '',
            profileId: pending.profileId || null,
        });
        // TOKEN TRACKING (Tokens tab): fold the reflection pass's in/out tokens into the current
        // run's totals (mirrors addAgent3Tokens — post-reply update, no run-count bump).
        try {
            const rIn = Number(reflResult?.tokensIn) || 0;
            const rOut = Number(reflResult?.tokensOut) || 0;
            if (rIn || rOut) {
                addReflectionTokens({ reflectionInput: rIn, reflectionOutput: rOut });
                addDebugLog('info', `[${pending.runId}] Reflection tokens: in=${rIn} out=${rOut}`, {
                    subsystem: 'reflection', event: 'reflection.run',
                    data: { agent: 'reflection', profileId: pending.profileId || null, tokensIn: rIn, tokensOut: rOut },
                });
            }
        } catch { /* token recording is best-effort — never break reflection */ }
        // Persist any observation facts the pass wrote to the active DB profile.
        try { await saveCurrentToActiveProfile(settings.activeDbProfile); } catch { /* best-effort */ }
        const reflectionMs = Date.now() - reflectStart;
        addDebugLog('info', `[${pending.runId}] Reflection pass complete (${reflectionMs}ms)`, {
            subsystem: 'reflection', event: 'reflection.run',
            data: { agent: 'reflection', profileId: pending.profileId || null, success: true, durationMs: reflectionMs },
        });
        addDebugLog('debug', `[${pending.runId}] Stage timing (reflection): reflection=${reflectionMs}ms`, {
            runId: pending.runId, subsystem: 'pipeline', event: 'pipeline.timing',
            data: { phase: 'reflection', reflectionMs, totalMs: reflectionMs },
        });
    } catch (err) {
        addDebugLog('fail', `Reflection pass failed (non-fatal): ${err.message || err}`, {
            subsystem: 'reflection', event: 'reflection.run', reason: 'ERROR',
            data: { agent: 'reflection', profileId: pending.profileId || null, success: false, error: err.message || String(err), durationMs: Date.now() - reflectStart },
        });
    } finally {
        reflectionInFlight = false;
        // F-ORCH-2: decrement (never assign false) — clamped, see the counter's declaration.
        internalCallDepth = Math.max(0, internalCallDepth - 1);
        updateStatus('idle');
    }
}

/**
 * Character registry detection — runs after the settled extraction, OFF the critical path,
 * gated to fire at most once every CHARACTER_CHECK_INTERVAL successful extraction runs
 * (G4: hardcoded ON at 10). Performs a DETERMINISTIC scan of the fact store (no LLM call)
 * for newly-seen NAMED entities not yet classified; when there are candidates, opens ONE
 * batched popup (deferred, never blocking). Fully self-guarded + try/catch'd.
 */
async function maybeRunEntityCheck() {
    if (entityCheckInFlight) return;
    const settings = getSettings();
    if (!settings || !settings.enabled) return;
    if (pipelineCancelled) return;
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) return; // group chats unsupported

    runsSinceEntityCheck++;
    if (runsSinceEntityCheck < CHARACTER_CHECK_INTERVAL) return;
    runsSinceEntityCheck = 0; // reset cadence regardless of outcome

    entityCheckInFlight = true;
    try {
        const databases = await getAllDatabases();
        const candidates = detectAndRecord(databases);
        // Refresh the settings-panel list so newly-detected names show even before the popup.
        try { reloadEntitiesUI(); } catch { /* ignore */ }
        if (!candidates || candidates.length === 0) {
            addDebugLog('info', 'Character check: no new named candidates');
            return;
        }
        addDebugLog('info', `Character check: ${candidates.length} new named candidate(s) — opening popup`);
        // Defer the popup so it never lands mid-generation: capture the chat id and only
        // show if we're still in the same chat after a short settle window.
        const targetChatId = ctx.chatId;
        setTimeout(async () => {
            try {
                if (SillyTavern.getContext().chatId !== targetChatId) {
                    addDebugLog('info', 'Character popup skipped: chat changed since detection');
                    return;
                }
                await showEntityPopup(candidates);
                try { reloadEntitiesUI(); } catch { /* ignore */ }
            } catch (err) {
                addDebugLog('fail', `Character popup failed (non-fatal): ${err.message || err}`);
            }
        }, 2200);
    } catch (err) {
        addDebugLog('fail', `Character check failed (non-fatal): ${err.message || err}`);
    } finally {
        entityCheckInFlight = false;
    }
}

// --- Main Pipeline Init ---

export function initPipeline() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // Shared show-once group-chat gate for both injection seams.
    const isGroupChatSkip = (settings) => {
        const ctx = SillyTavern.getContext();
        if (!ctx.groupId && !ctx.selected_group) return false;
        if (!groupSkipToastShown) {
            groupSkipToastShown = true;
            addDebugLog('info', 'Injection skipped: group chats are not supported (show-once per chat)');
            if (settings.showToast && typeof toastr !== 'undefined') {
                toastr.info('BF Memory: group chats are not supported — memory injection skipped', 'BF Memory', { timeOut: 4000 });
            }
        }
        return true;
    };

    // INJECTION SEAM (chat-completion): PURE CODE only — reads the stored memory sheet and
    // splices it as ONE system message immediately before the last user message
    // (cache-friendly). No LLM call ever blocks reply generation here. When the sheet has
    // real content (not the seed), the visible chat history is first trimmed to the last
    // agent2ContextMessages user/AI turns (0 = off; system/WI/AN messages always survive —
    // trimChatHistory semantics in agent-writer.js).
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, async (data) => {
        try {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;
            if (data?.dryRun) return;
            if (isInternalCall()) return; // never inject into our own background agent calls
            if (pipelineJustInjected) return; // double-fire guard (auto-clears after 2s)
            if (isGroupChatSkip(settings)) return;

            const rec = getMemorySheet(); // never empty — seed text on brand-new chats (G2)
            // Token comparison (Tokens tab): same local tokenizer both sides, so the delta holds.
            const arr = firstInjectableArray(data);
            const baselineInput = await countChatTokens(arr);
            // Seeded sheet = no memories yet — trimming history would DELETE context without
            // replacing it, so the trim is skipped until the first real sheet lands.
            const trimToLast = rec.seeded ? 0 : Math.max(0, Math.floor(settings.agent2ContextMessages || 0));
            const ok = injectMemoryContext(data, rec.text, { trimToLast });
            if (!ok) {
                addDebugLog('fail', 'Memory sheet injection failed — no usable prompt container', {
                    subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
                });
                return;
            }
            setInjectedGuard();
            const actualInput = await countChatTokens(arr);
            recordRunTokens({ baselineInput, actualInput });
            addDebugLog('pass', `Memory sheet injected (${rec.text.length} chars${rec.seeded ? ', seed' : ''}; trim=${trimToLast || 'off'}; tokens ${baselineInput} → ${actualInput})`, {
                subsystem: 'writer', event: 'inject.ok',
                data: { chars: rec.text.length, seeded: !!rec.seeded, trimToLast, baselineInput, actualInput },
            });
        } catch (err) {
            // Injection must NEVER break the user's generation — log and let the turn proceed.
            addDebugLog('fail', `Sheet injection failed (non-fatal): ${err.message || err}`);
        }
    });

    // INJECTION SEAM (text-completion twin): string-prompt path, PURE CODE, no per-message
    // trim possible. Chat-completion backends (mainApi === 'openai') emit BOTH events for a
    // single generation — defer entirely to the handler above for those.
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, async (data, dryRun) => {
        try {
            if (dryRun) return;
            try {
                if (SillyTavern.getContext().mainApi === 'openai') return;
            } catch { /* unknown backend — fall through */ }
            const settings = getSettings();
            if (!settings || !settings.enabled) return;
            if (isInternalCall()) return;
            if (pipelineJustInjected) return; // already handled this generation
            if (isGroupChatSkip(settings)) return;

            const rec = getMemorySheet();
            const ok = injectMemoryContext(data, rec.text); // string path — prepends, no trim
            if (ok) {
                setInjectedGuard();
                addDebugLog('pass', `Memory sheet injected (text-completion, ${rec.text.length} chars${rec.seeded ? ', seed' : ''})`, {
                    subsystem: 'writer', event: 'inject.ok',
                    data: { chars: rec.text.length, seeded: !!rec.seeded, path: 'text-completion' },
                });
            } else {
                addDebugLog('fail', 'Memory sheet injection failed (text-completion) — no usable prompt container', {
                    subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
                });
            }
        } catch (err) {
            addDebugLog('fail', `Sheet injection failed (text-completion, non-fatal): ${err.message || err}`);
        }
    });

    // After generation complete: reset status and double-fire guard, then schedule the
    // settled background memory-agent run.
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async () => {
        clearInjectedGuard();
        // Clear the cancellation flag now that this generation cycle finished.
        // Without this, a Stop on one turn left pipelineCancelled=true and poisoned
        // every later turn.
        pipelineCancelled = false;
        updateStatus('idle');

        // Count the main model's reply tokens for the Tokens tab — BUT only attribute
        // it to a run that actually recorded input this cycle. Swipes/regens fire
        // MESSAGE_RECEIVED without a fresh pipeline run, so unconditionally adding
        // output desynced input vs output counts over a long session.
        try {
            if (runRecordedInput) {
                const ctx = SillyTavern.getContext();
                const lastMsg = ctx.chat?.[ctx.chat.length - 1];
                if (lastMsg && !lastMsg.is_user && lastMsg.mes) {
                    const n = await (ctx.getTokenCountAsync?.(lastMsg.mes) ?? 0);
                    setMainOutputTokens(n);
                }
            }
        } catch { /* ignore */ }
        // One run = one input record = one output attribution. Disarm until the next run.
        runRecordedInput = false;

        // Post-reply work, off the latency-critical path. The bufferHoldBack window (§7) guarantees
        // we never extract the newest (still-swipable) messages, so we run the settled extraction
        // directly — no settle debounce needed. Fully try/catch'd: this must never break the turn.
        try {
            await runMemoryExtraction();
            // Reflection / consolidation + character-registry detection, off the critical path.
            // Self-guarded + try/catch'd internally. Reflection carries its own runId via
            // reflectionPending, so it stays grouped with the turn.
            maybeRunReflection();
            maybeRunEntityCheck();
        } catch (err) {
            addDebugLog('fail', `Settle extraction failed (non-fatal): ${err.message || err}`);
        } finally {
            // The turn's post-reply work has now been dispatched — disarm the pendingRun so a
            // later turn mints/reuses its own id and can't inherit this run's id.
            consumePendingRun();
        }
    });

    // Also reset on generation stop/failure (user clicks Stop, or error).
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        cancelActiveRun('stopped');
        addDebugLog('info', 'Generation stopped — in-flight agent calls aborted, writes discarded', { subsystem: 'pipeline', event: 'pipeline.cancel', reason: 'STOPPED' });
    });

    // Message deletion (e.g. /cut): extraction dedup is handled by the per-message
    // bf_mem_processed flag (stamped on extracted messages, checked by runMemoryExtraction) —
    // indices shifting after a deletion can't skip new AI replies.
    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        addDebugLog('info', 'Message deleted — per-message watermarks remain the extraction source of truth');
    });

    // Swipes only ever affect the NEWEST message, which lives inside the bufferHoldBack window
    // and is therefore never extracted or watermarked — so there is nothing to invalidate and
    // no MESSAGE_SWIPED handler is needed.

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        // Drop the per-turn DB cache so this handler can't serve a stale (pre-switch) map.
        // (The durable IDB→attachment flush is coordinated inside settings.js's CHAT_CHANGED
        // handler — see the data-safety note there.)
        const { invalidateDatabaseCache } = await import('./database.js');
        invalidateDatabaseCache();
        // F-ORCH-2: force-reset the internal-call ref-count — a stuck window must never outlive
        // the chat. In-flight flows' finally blocks decrement CLAMPED at 0, so this can't go
        // negative afterwards.
        internalCallDepth = 0;
        clearInjectedGuard();
        // F-ORCH-3: drop armed extraction retries too — they belong to the OLD chat's exchange
        // and must not schedule/consume a retry against the new chat.
        extractionRetryAfterBusy = false;
        cancelledRetryArmed = false;
        groupSkipToastShown = false;
        // Reflection cadence is per-chat: reset the counter and drop any armed pass so a
        // chat switch can't fire a consolidation against the new chat using old context.
        successfulRunsSinceReflection = 0;
        reflectionPending = null;
        // Debug-log redesign §2: drop any armed pendingRun + clear the ambient run id so a chat
        // switch can't leak the prior chat's runId onto the new chat's logs.
        setPendingRun(null);
        endRun();
        // Character-registry cadence is per-chat too.
        runsSinceEntityCheck = 0;
        hideWorkingIndicator();
        updateStatus('idle');
        // Memory-sheet reload rides settings.js's CHAT_CHANGED handler (reloadSheetFromChat,
        // alongside reloadSceneFromChat and the other per-chat reloads).

        addDebugLog('info', 'Chat changed - pipeline state reset');
    });

    console.log('[BFMemory] Pipeline initialized (redesign-v2: pure-code sheet injection + background Memory Agent)');
}
