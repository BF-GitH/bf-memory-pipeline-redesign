import { injectMemoryContext } from './agent-writer.js';
import { runMemoryAgent } from './agent-memory.js';
import { runReflection } from './agent-reflect.js';
import { cancelInFlightLLM, callAgentLLM } from './llm-call.js';
import { extractSentenceLine, countSentenceEnds } from './sentence-util.js';
import { recordHealthEvent, clearHealthEvents } from './health.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, saveCurrentToActiveProfile, setRunTokens, setMainOutputTokens, addAgent3Tokens, addReflectionTokens, getReflection, getMemorySheet, setMemorySheet, getStorySpine, appendStorySpineBatch, beginRun, endRun, setPendingRun, getPendingRun, consumePendingRun, isTriviallyEmptyForExtraction } from './settings.js';

let internalCallDepth = 0;
const isInternalCall = () => internalCallDepth > 0;
let pipelineJustInjected = false; 
let injectedResetTimer = null; 
let pipelineCancelled = false; 
let groupSkipToastShown = false; 
let runRecordedInput = false; 

let successfulRunsSinceReflection = 0;
let reflectionPending = null; 
let reflectionInFlight = false; 

let memoryExtractionInFlight = false;

let extractionRetryAfterBusy = false;
let cancelledRetryArmed = false;

// --- User-visible error stream (separate from the debug log) ---------------
// A memory-pipeline run failing must NOT interrupt chat (the run is post-reply
// and every branch is already caught) — it should only raise a toast. Throttled
// so a per-turn recurring failure can't spam: an identical message is suppressed
// within the window; a *different* error always surfaces immediately.
let lastErrToastMsg = '';
let lastErrToastAt = 0;
const ERROR_TOAST_THROTTLE_MS = 60000;

function toastPipelineError(msg) {
    try {
        const settings = getSettings();
        if (!settings || settings.showToast === false) return;
        if (typeof toastr === 'undefined') return;
        const now = Date.now();
        if (msg === lastErrToastMsg && (now - lastErrToastAt) < ERROR_TOAST_THROTTLE_MS) return;
        lastErrToastMsg = msg;
        lastErrToastAt = now;
        toastr.error(String(msg), 'BF Memory', { timeOut: 6000, preventDuplicates: true });
    } catch {  }
}

function firstInjectableArray(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.chat, data.messages, data.prompt, data.chatCompletion, data.messageArray];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return null;
}

async function countChatTokens(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const ctx = SillyTavern.getContext();
    try {
        if (ctx.countTokensOpenAIAsync) return await ctx.countTokensOpenAIAsync(arr, true);

        let total = 0;
        for (const m of arr) total += await (ctx.getTokenCountAsync?.(m.content || m.mes || '') ?? 0);
        return total;
    } catch { return 0; }
}

function recordRunTokens({ baselineInput, actualInput, sheetTokens, path }) {
    try {
        setRunTokens({
            baselineInput: baselineInput || 0,
            actualInput: actualInput || 0,
            sheetTokens: sheetTokens || 0,
            mainOutput: 0,
            // 'chat' (chat-completion, trim possible) or 'text' (text-completion,
            // no trim exists) — drives which banner the tokens panel shows.
            path: path || 'chat',
        });
        runRecordedInput = true;
    } catch (err) {
        addDebugLog('info', `Token recording failed (non-fatal): ${err.message || err}`);
    }
}

async function countTextTokens(text) {
    const t = String(text ?? '');
    if (!t) return 0;
    try {
        const ctx = SillyTavern.getContext();
        return await (ctx.getTokenCountAsync?.(t) ?? 0);
    } catch { return 0; }
}

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

function getCharacterInfoBrief() {
    const context = SillyTavern.getContext();
    const char = context?.characters?.[context?.characterId];
    if (!char) return '';
    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 400)}`);
    return parts.join('\n');
}

function getUserPersona() {
    const context = SillyTavern.getContext();
    return context.persona?.description || context.name1 || '';
}

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

export function cancelActiveRun(reason = 'cancel') {
    pipelineCancelled = true;
    clearInjectedGuard();
    runRecordedInput = false;

    try { cancelInFlightLLM(reason); } catch {  }
    hideWorkingIndicator();
    updateStatus('idle');
    addDebugLog('info', `Active pipeline run cancelled (${reason}) — in-flight LLM calls aborted`, {
        subsystem: 'pipeline', event: 'pipeline.cancel', reason: reason.toUpperCase(),
    });
}

function setInjectedGuard() {
    pipelineJustInjected = true;
    if (injectedResetTimer) clearTimeout(injectedResetTimer);
    injectedResetTimer = setTimeout(() => {
        injectedResetTimer = null;
        pipelineJustInjected = false;
    }, 2000);
}

function clearInjectedGuard() {
    pipelineJustInjected = false;
    if (injectedResetTimer) { clearTimeout(injectedResetTimer); injectedResetTimer = null; }
}

function isGenuineMessage(m) {
    return !!(m && m.mes && !m.is_system && !m.extra?.type);
}

// Build a stable, position-independent id for a message the first time we touch
// it, and stash it on the message itself (extra.bf_uid) so it survives message
// deletes, edits, and branches. Composite of chatId (separates chats/branches),
// a to-the-second timestamp (human-readable), and a random token (uniqueness).
function makeMsgUid(m) {
    const ctx = SillyTavern.getContext();
    const chatId = String(ctx.getCurrentChatId?.() || ctx.chatId || 'chat').replace(/\s+/g, '_');
    let ts = NaN;
    try { ts = (m?.send_date != null) ? new Date(m.send_date).getTime() : NaN; } catch { ts = NaN; }
    const t = Number.isFinite(ts) ? ts : Date.now();
    const stamp = new Date(t).toISOString().slice(0, 19).replace(/[-:]/g, ''); // e.g. 20260712T142233
    let rand = '';
    try { rand = (globalThis.crypto?.randomUUID?.() || '').replace(/-/g, '').slice(0, 12); } catch {  }
    if (!rand) rand = (Date.now().toString(36) + Math.random().toString(36).slice(2)).slice(0, 12);
    return `${chatId}::${stamp}::${rand}`;
}

function ensureMsgUid(m) {
    if (!m || typeof m !== 'object') return '';
    if (m.extra?.bf_uid) return m.extra.bf_uid;
    const uid = makeMsgUid(m);
    m.extra = { ...(m.extra || {}), bf_uid: uid };
    return uid;
}

function toAgentMessage(m, index) {
    return { index, uid: ensureMsgUid(m), role: m.is_user ? 'USER' : 'CHAR', name: String(m.name || '').trim(), text: m.mes };
}

// The spine contract is ONE sentence per batch. Enforcement is cooperative,
// not destructive: the LLM must put its sentence on an explicit "SENTENCE:"
// line (survives chatty preambles), and the reply is VALIDATED with the shared
// sentence-util counters. A multi-sentence reply triggers ONE rewrite call over
// the same batch; if it is STILL multi-sentence it is accepted as-is, because
// an extra sentence hurts the story far less than a sentence chopped off in
// the middle.
function spineSentencePrompt(count) {
    return `Summarize these ${count} roleplay messages as EXACTLY ONE past-tense sentence capturing what happened. Reply in exactly this format and nothing else:\nSENTENCE: <the one sentence>`;
}

// Deterministic "story so far" spine: for every completed block of N SETTLED
// genuine messages (N = settings.spineBatchSize, default 10), make ONE cheap
// LLM call to distil the block into a single past-tense sentence and APPEND it
// to the growing spine. Append-only — a batch is never re-summarized. The next
// block resumes AFTER the last covered message, located by its stable bf_uid
// (chat-index fallback), so deleting older messages or changing the batch size
// mid-chat can't double-cover or skip messages. Only SETTLED messages (older
// than the hold-back) are eligible — a message that can still be swiped/edited
// never ends up in a spine sentence. Fired once per successful memory run.
async function maybeAppendStorySpine(runId, profileId, capturedChatId = '') {
    try {
        const settings = getSettings();
        const ctx = SillyTavern.getContext();
        const chat = ctx.chat;
        if (!Array.isArray(chat) || chat.length === 0) return;

        const liveChatId0 = String(ctx.getCurrentChatId?.() || ctx.chatId || '');
        if (capturedChatId && liveChatId0 && liveChatId0 !== capturedChatId) {
            addDebugLog('info', `[${runId}] Story spine skipped — chat changed before spine update (${capturedChatId} -> ${liveChatId0})`);
            return;
        }

        const rawBatch = Number(settings?.spineBatchSize);
        const batchSize = Number.isFinite(rawBatch) ? Math.min(30, Math.max(4, Math.floor(rawBatch))) : 10;

        const rawHoldBack = Number(settings?.bufferHoldBack);
        const holdBack = Number.isFinite(rawHoldBack) ? Math.min(10, Math.max(0, Math.floor(rawHoldBack))) : 4;
        const maxIdx = chat.length - 1 - holdBack;
        if (maxIdx < 0) return;

        const genuine = [];
        for (let i = 0; i <= maxIdx; i++) {
            if (isGenuineMessage(chat[i])) genuine.push({ index: i, m: chat[i] });
        }
        if (genuine.length === 0) return;

        const spine = getStorySpine();

        // Resume AFTER the last covered message: find it by stable uid first,
        // then by chat index (uid missing on legacy batches, or message deleted).
        let startPos = 0;
        if (spine.length > 0) {
            const last = spine[spine.length - 1];
            let pos = -1;
            if (last.endUid) pos = genuine.findIndex(g => g.m.extra?.bf_uid === last.endUid);
            if (pos < 0 && Number.isInteger(last.endMsg)) {
                for (let p = genuine.length - 1; p >= 0; p--) {
                    if (genuine[p].index <= last.endMsg) { pos = p; break; }
                }
            }
            if (pos < 0) {
                // Every message up to the last covered one was deleted — the settled
                // survivors were never summarized, so restart coverage at the front.
                addDebugLog('info', `[${runId}] Story spine anchor lost (covered messages deleted) — resuming coverage from the earliest settled message`);
            }
            startPos = pos + 1;
        }

        // Catch up incrementally: at most a couple of batches per run so a long or
        // freshly-imported chat (many complete blocks at once) doesn't fire a burst
        // of serial LLM calls in a single turn. The uid anchor makes spreading the
        // backfill across turns safe.
        const MAX_BATCHES_PER_RUN = 2;
        const nextIndex = spine.length > 0 ? (spine[spine.length - 1].batchIndex + 1) : 0;
        let appendedThisRun = 0;

        while (genuine.length - startPos >= batchSize && appendedThisRun < MAX_BATCHES_PER_RUN) {
            const slice = genuine.slice(startPos, startPos + batchSize);
            const startMsg = slice[0].index;
            const endMsg = slice[slice.length - 1].index;
            const endUid = ensureMsgUid(slice[slice.length - 1].m);
            const batchIndex = nextIndex + appendedThisRun;
            const transcript = slice
                .map(({ m }) => `${m.is_user ? 'USER' : 'CHAR'}${m.name ? ` (${String(m.name).trim()})` : ''}: ${String(m.mes || '').trim()}`)
                .join('\n\n');

            let sentence = '';
            try {
                sentence = extractSentenceLine(await callAgentLLM(
                    spineSentencePrompt(slice.length), transcript, profileId, 'story-spine',
                ));
                const ends = sentence ? countSentenceEnds(sentence) : 0;
                if (ends > 1) {
                    // Too many sentences: ONE rewrite call over the same batch.
                    addDebugLog('info', `[${runId}] Story spine batch ${batchIndex}: reply had ${ends} sentences — one rewrite call to condense`);
                    const rewritten = extractSentenceLine(await callAgentLLM(
                        `Your previous summary used more than one sentence. Condense these ${slice.length} roleplay messages into EXACTLY ONE past-tense sentence. Reply in exactly this format and nothing else:\nSENTENCE: <the one sentence>`,
                        transcript, profileId, 'story-spine-rewrite',
                    ));
                    if (rewritten) sentence = rewritten;
                    const stillEnds = countSentenceEnds(sentence);
                    if (stillEnds > 1) {
                        addDebugLog('info', `[${runId}] Story spine batch ${batchIndex}: still ${stillEnds} sentences after rewrite — accepting as-is (never chopped)`);
                    }
                }
            } catch (err) {
                addDebugLog('info', `[${runId}] Story spine batch ${batchIndex} skipped (LLM error) — will retry next turn: ${err?.message || err}`);
                break;
            }
            if (!sentence) {
                addDebugLog('info', `[${runId}] Story spine batch ${batchIndex} produced no sentence — will retry next turn`);
                break;
            }

            // The LLM call awaited — re-check the chat so a mid-call switch can
            // never write this chat's sentence into the newly-opened chat's spine.
            const liveCtx = SillyTavern.getContext();
            const liveChatId = String(liveCtx.getCurrentChatId?.() || liveCtx.chatId || '');
            if (capturedChatId && liveChatId && liveChatId !== capturedChatId) {
                addDebugLog('info', `[${runId}] Story spine batch ${batchIndex} discarded — chat changed mid-call (${capturedChatId} -> ${liveChatId})`);
                return;
            }

            if (!appendStorySpineBatch({ batchIndex, startMsg, endMsg, endUid, sentence })) break;
            recordHealthEvent('spine', { status: 'ok', batchIndex, endMsg });
            appendedThisRun++;
            startPos += batchSize;
            addDebugLog('info', `[${runId}] Story spine: appended batch ${batchIndex} (msgs ${startMsg}–${endMsg}, ${sentence.length} chars)`, {
                subsystem: 'pipeline', event: 'spine.append',
                data: { batchIndex, startMsg, endMsg, chars: sentence.length },
            });
        }
    } catch (err) {
        addDebugLog('info', `Story spine update failed (non-fatal): ${err?.message || err}`);
    }
}

async function runMemoryExtraction() {
    if (memoryExtractionInFlight) {

        if (!extractionRetryAfterBusy) {
            extractionRetryAfterBusy = true;
            addDebugLog('info', 'Memory agent (post-reply): prior extraction still committing — ONE retry chained to its completion');
        }
        return; 
    }
    const settings = getSettings();
    if (!settings || !settings.enabled) return;
    if (isInternalCall()) return; 
    if (pipelineCancelled) {

        if (!cancelledRetryArmed) {
            cancelledRetryArmed = true;
            addDebugLog('info', 'Memory agent (post-reply): skipped — generation was stopped/cancelled; scheduling ONE retry so the completed exchange isn\'t silently dropped');

            // The retry must CLEAR the cancelled flag first — nothing else resets it
            // until the next MESSAGE_RECEIVED, so without this the retry would land
            // right back in this branch and never do anything.
            setTimeout(() => { pipelineCancelled = false; runMemoryExtraction(); }, 0);
        } else {
            addDebugLog('info', 'Memory agent (post-reply): still cancelled on retry — exchange left unprocessed (no further retries)');
        }
        return;
    }
    const ctx0 = SillyTavern.getContext();
    if (ctx0.groupId || ctx0.selected_group) return; 

    try {
        const { isCatchupRunning } = await import('./catchup-import.js');
        if (isCatchupRunning()) {
            addDebugLog('info', 'Memory agent (post-reply): catch-up import in progress — skipping (importer rebuilds the sheet itself)');
            return;
        }
    } catch {  }

    const chat = ctx0.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    const rawHoldBack = Number(settings.bufferHoldBack);
    const holdBack = Number.isFinite(rawHoldBack) ? Math.min(10, Math.max(0, Math.floor(rawHoldBack))) : 4;
    const maxIdx = chat.length - 1 - holdBack;
    const SETTLED_BATCH_MAX = 12;

    const settledMessages = [];
    const trivialIndices = []; 
    for (let i = 0; i <= maxIdx; i++) {
        const m = chat[i];
        if (!isGenuineMessage(m)) continue;

        // true = done; false/absent = todo. A persisted 'in-flight' stamp can only
        // be a leftover from a run the browser/tab killed mid-flight (no extraction
        // is running while this scan executes) — treat it as unprocessed so those
        // messages get re-extracted instead of being skipped forever.
        if (m.extra?.bf_mem_processed === true) continue;
        if (isTriviallyEmptyForExtraction(m.mes)) { trivialIndices.push(i); continue; }
        settledMessages.push(toAgentMessage(m, i));
    }
    if (settledMessages.length > SETTLED_BATCH_MAX) {
        // Keep the OLDEST slice of the backlog: extraction must stay chronological
        // ACROSS runs. Keeping the newest would extract the leftover OLD messages
        // on a LATER run, letting stale values overwrite fresher state (a fact from
        // msg 5 clobbering the update from msg 15). The dropped newer tail stays
        // unstamped and is picked up next run.
        settledMessages.length = SETTLED_BATCH_MAX;
    }

    const tentativeMessages = [];
    for (let i = Math.max(0, maxIdx + 1); i < chat.length; i++) {
        const m = chat[i];
        if (!isGenuineMessage(m)) continue;
        tentativeMessages.push(toAgentMessage(m, i));
    }

    if (trivialIndices.length > 0) {
        for (const i of trivialIndices) {
            chat[i].extra = { ...(chat[i].extra || {}), bf_mem_processed: true };
        }
        SillyTavern.getContext().saveChatDebounced?.();
        addDebugLog('info', `Memory agent (post-reply): ${trivialIndices.length} trivially-empty settled msg(s) stamped processed without an LLM call`);
    }

    // Only run once there is at least one SETTLED message to extract (index
    // <= chat.length-1-holdBack, not yet processed). With no settled messages
    // there is nothing new to store, and firing a sheet-refresh-only run this
    // early (e.g. on the first message, when everything is still tentative)
    // just makes the agent reply with prose — no tool call, no #SHEET — which
    // trips the protocol "second offense" abort for no reason. This is the
    // n-4 rule: nothing runs until a message is old enough to settle.
    if (settledMessages.length === 0) {
        addDebugLog('info', `Memory agent (post-reply): no settled messages yet (hold-back ${holdBack}) — nothing new to extract, skipping the run`);
        return;
    }

    const capturedDbProfile = settings.activeDbProfile;
    const capturedCharAvatar = ctx0.characters?.[ctx0.characterId]?.avatar || '';
    const capturedChatId = String(ctx0.getCurrentChatId?.() || ctx0.chatId || '');
    const startTime = Date.now();

    const pending = getPendingRun();
    const runId = pending?.runId || `M${startTime.toString(36).slice(-5)}`;
    beginRun(runId);

    const postStageMs = { agent3Ms: null, snapshotMs: null };

    const BF_MEM_IN_FLIGHT = 'in-flight';
    const settledIndices = settledMessages.map(m => m.index);
    // Stamp by stable uid, not by captured position: deleting a message while the
    // run is in flight shifts positions, and a positional stamp would then hit the
    // WRONG message. The uid lookup finds each settled message wherever it now
    // sits and silently skips ones that were deleted mid-run.
    const settledUids = new Set(settledMessages.map(m => m.uid).filter(Boolean));
    const setWatermark = (val) => {
        let changed = false;
        for (const msg of chat) {
            const uid = msg?.extra?.bf_uid;
            if (!uid || !settledUids.has(uid)) continue;
            if (msg.extra.bf_mem_processed !== val) {
                msg.extra = { ...msg.extra, bf_mem_processed: val };
                changed = true;
            }
        }
        if (changed) SillyTavern.getContext().saveChatDebounced?.();
        // Repaint the on-screen brain icons when the flag settles to true/false
        // (skip the transient 'in-flight' marker) so green appears immediately.
        if (val === true || val === false) {
            import('./message-icon.js').then(m => m.refreshMessageIcons?.()).catch(() => {});
        }
    };
    setWatermark(BF_MEM_IN_FLIGHT);

    memoryExtractionInFlight = true;

    cancelledRetryArmed = false;
    internalCallDepth++; 
    let memoryResult = null;

    let reachedCommit = false;
    try {
        showWorkingIndicator();

        const characterInfo = getCharacterInfoBrief();
        const userPersona = getUserPersona();

        addDebugLog('info', `[${runId}] Memory agent (post-reply): ${settledMessages.length} settled (hold-back ${holdBack}, msgs ${settledIndices.length ? `${settledIndices[0]}–${settledIndices[settledIndices.length - 1]}` : '—'}), ${tentativeMessages.length} tentative`);

        const agent3ProfileId = settings.agent3Profile || null;
        const agent3Start = Date.now();

        let observationDate;
        try {
            const newest = settledMessages[settledMessages.length - 1] || tentativeMessages[tentativeMessages.length - 1];
            const sd = (newest && Number.isInteger(newest.index)) ? chat[newest.index]?.send_date : null;
            const ts = (sd != null) ? new Date(sd).getTime() : NaN;
            observationDate = (Number.isFinite(ts) ? new Date(ts) : new Date()).toISOString();
        } catch (_) {
            observationDate = new Date().toISOString();
        }

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
        postStageMs.agent3Ms = Date.now() - agent3Start; 

        addAgent3Tokens({ agent3Input: memoryResult?.tokensIn || 0, agent3Output: memoryResult?.tokensOut || 0 });

        if (!memoryResult || memoryResult.error) {
            if (memoryResult?.error) addDebugLog('fail', `[${runId}] Memory agent error: ${memoryResult.error}`, {
                subsystem: 'agent3', event: 'agent3.run', reason: 'ERROR',
                data: { agent: 'memory-agent', profileId: agent3ProfileId, success: false, error: memoryResult.error, durationMs: Date.now() - startTime },
            });
            if (memoryResult?.error) toastPipelineError(`Memory update failed: ${memoryResult.error}`);
            recordHealthEvent('extraction', { status: 'fail', error: memoryResult?.error || 'no result' });

            setWatermark(false);
            return;
        }

        reachedCommit = true;

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

        if (pipelineCancelled) {
            addDebugLog('info', `[${runId}] Cancelled mid-extraction — withholding watermark/sheet (${committed.length} write(s) already stored)`);
            setWatermark(false); 
            setLastInserted(committed);
            return;
        }

        const liveCtx = SillyTavern.getContext();
        const currentCharAvatar = liveCtx.characters?.[liveCtx.characterId]?.avatar || '';
        const currentChatId = String(liveCtx.getCurrentChatId?.() || liveCtx.chatId || '');
        // Guard BOTH character switches and chat/branch switches (same character,
        // different chat) — either way the sheet/watermark must not be applied to
        // the chat that is now active.
        if (currentCharAvatar !== capturedCharAvatar || (capturedChatId && currentChatId && currentChatId !== capturedChatId)) {
            addDebugLog('fail', `[${runId}] Character or chat changed mid-extraction (${capturedCharAvatar}/${capturedChatId} -> ${currentCharAvatar}/${currentChatId}) — withholding watermark/sheet`);
            if (typeof toastr !== 'undefined') {
                toastr.warning('BF Memory: extraction result discarded — you switched characters or chats');
            }
            setWatermark(false);
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
        recordHealthEvent('extraction', { status: 'ok', writes: committed.length, rounds: memoryResult.rounds, durationMs: Date.now() - startTime });

        if (memoryResult.sheetText) {
            setMemorySheet(memoryResult.sheetText, { runId, sourceMessageIndex: chat.length - 1 });
        }

        setWatermark(true);

        if (committed.length > 0) {
            const snapStart = Date.now();
            await saveCurrentToActiveProfile(capturedDbProfile);
            postStageMs.snapshotMs = Date.now() - snapStart; 
        }

        await maybeAppendStorySpine(runId, agent3ProfileId, capturedChatId);

        successfulRunsSinceReflection++;
        const REFLECTION_INTERVAL = 12;
        if (successfulRunsSinceReflection >= REFLECTION_INTERVAL && !reflectionPending && !reflectionInFlight) {
            reflectionPending = {
                runId, charAvatar: capturedCharAvatar,
                profileId: settings.agent3Profile || null,
                characterInfo: getCharacterInfo(), userPersona,
            };
            addDebugLog('info', `[${runId}] Reflection armed (will run after settle; ${successfulRunsSinceReflection}/${REFLECTION_INTERVAL} runs)`);
        }
    } catch (err) {

        addDebugLog('fail', `[${runId}] Memory agent (post-reply) failed (non-fatal): ${err.message || err}`);
        recordHealthEvent('extraction', { status: 'fail', error: err.message || String(err) });
        toastPipelineError(`Memory update failed: ${err.message || err}`);

        if (!reachedCommit) {
            try {
                setWatermark(false);
                addDebugLog('info', `[${runId}] Memory agent: reset 'in-flight' watermark (throw before commit) — exchange will re-extract next turn`);
            } catch {  }
        }
    } finally {
        memoryExtractionInFlight = false;

        internalCallDepth = Math.max(0, internalCallDepth - 1);
        hideWorkingIndicator();

        if (extractionRetryAfterBusy) {
            extractionRetryAfterBusy = false;
            setTimeout(() => { runMemoryExtraction(); }, 0);
        }

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
        } catch {  }
        endRun(); 
    }
}

async function maybeRunReflection() {
    const pending = reflectionPending;
    if (!pending || reflectionInFlight) return;
    const settings = getSettings();
    if (!settings || !settings.enabled) { reflectionPending = null; return; }
    if (pipelineCancelled) { reflectionPending = null; return; }
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) { reflectionPending = null; return; }

    const currentCharAvatar = ctx.characters?.[ctx.characterId]?.avatar || '';
    if (currentCharAvatar !== pending.charAvatar) {
        addDebugLog('info', `[${pending.runId}] Reflection skipped (character changed since arming)`);
        reflectionPending = null;
        return;
    }

    reflectionPending = null;
    reflectionInFlight = true;
    successfulRunsSinceReflection = 0; 
    internalCallDepth++; 
    const reflectStart = Date.now();
    try {
        updateStatus('running', 'Reflecting (consolidating memory)...');
        const reflResult = await runReflection({
            runId: pending.runId,
            characterInfo: pending.characterInfo || '',
            userPersona: pending.userPersona || '',
            profileId: pending.profileId || null,
        });

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
        } catch {  }

        try { await saveCurrentToActiveProfile(settings.activeDbProfile); } catch {  }
        const reflectionMs = Date.now() - reflectStart;
        recordHealthEvent('reflection', { status: 'ok', durationMs: reflectionMs });
        addDebugLog('info', `[${pending.runId}] Reflection pass complete (${reflectionMs}ms)`, {
            subsystem: 'reflection', event: 'reflection.run',
            data: { agent: 'reflection', profileId: pending.profileId || null, success: true, durationMs: reflectionMs },
        });
        addDebugLog('debug', `[${pending.runId}] Stage timing (reflection): reflection=${reflectionMs}ms`, {
            runId: pending.runId, subsystem: 'pipeline', event: 'pipeline.timing',
            data: { phase: 'reflection', reflectionMs, totalMs: reflectionMs },
        });
    } catch (err) {
        recordHealthEvent('reflection', { status: 'fail', error: err.message || String(err) });
        addDebugLog('fail', `Reflection pass failed (non-fatal): ${err.message || err}`, {
            subsystem: 'reflection', event: 'reflection.run', reason: 'ERROR',
            data: { agent: 'reflection', profileId: pending.profileId || null, success: false, error: err.message || String(err), durationMs: Date.now() - reflectStart },
        });
    } finally {
        reflectionInFlight = false;

        internalCallDepth = Math.max(0, internalCallDepth - 1);
        updateStatus('idle');
    }
}

export function initPipeline() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

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

    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, async (data) => {
        try {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;
            if (data?.dryRun) return;
            if (isInternalCall()) return; 
            if (pipelineJustInjected) return; 
            if (isGroupChatSkip(settings)) return;

            const rec = getMemorySheet(); 

            const arr = firstInjectableArray(data);
            const baselineInput = await countChatTokens(arr);

            // Trim is independent of sheet state: history stays bounded even when the
            // sheet is empty or still the seed skeleton (0 keeps trim off).
            const trimToLast = Math.max(0, Math.floor(settings.agent2ContextMessages || 0));
            const result = injectMemoryContext(data, rec.text, { trimToLast });
            if (!result.injected) {
                if (result.reason === 'EMPTY_SHEET') {
                    recordHealthEvent('injection', { status: 'empty', path: 'chat', trimmedCount: result.trimmedCount });
                    addDebugLog('info', `Memory sheet is empty — injection skipped (trim ${result.trimmedCount > 0 ? `removed ${result.trimmedCount} messages` : 'did not remove anything'})`, {
                        subsystem: 'writer', event: 'inject.empty_sheet',
                        data: { trimToLast, trimmedCount: result.trimmedCount },
                    });
                } else {
                    recordHealthEvent('injection', { status: 'fail', path: 'chat', reason: 'no usable prompt container' });
                    addDebugLog('fail', 'Memory sheet injection failed — no usable prompt container', {
                        subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
                    });
                }
                return;
            }
            if (rec.seeded) {
                addDebugLog('info', `Memory sheet is still the seed skeleton — injected as-is (trim ${result.trimmedCount > 0 ? `removed ${result.trimmedCount} messages` : 'did not remove anything'})`, {
                    subsystem: 'writer', event: 'inject.seeded',
                    data: { trimToLast, trimmedCount: result.trimmedCount },
                });
            }
            setInjectedGuard();
            const actualInput = await countChatTokens(arr);
            const sheetTokens = await countTextTokens(rec.text);
            recordRunTokens({ baselineInput, actualInput, sheetTokens, path: 'chat' });
            recordHealthEvent('injection', { status: 'ok', path: 'chat', baselineInput, actualInput, sheetTokens, trimmedCount: result.trimmedCount });
            addDebugLog('pass', `Memory sheet injected (${rec.text.length} chars${rec.seeded ? ', seed' : ''}; trim=${trimToLast || 'off'}; tokens ${baselineInput} → ${actualInput})`, {
                subsystem: 'writer', event: 'inject.ok',
                data: { chars: rec.text.length, seeded: !!rec.seeded, trimToLast, trimmedCount: result.trimmedCount, baselineInput, actualInput },
            });
        } catch (err) {

            recordHealthEvent('injection', { status: 'fail', path: 'chat', reason: err.message || String(err) });
            addDebugLog('fail', `Sheet injection failed (non-fatal): ${err.message || err}`);
        }
    });

    eventSource.on(eventTypes.GENERATE_AFTER_DATA, async (data, dryRun) => {
        try {
            if (dryRun) return;
            try {
                if (SillyTavern.getContext().mainApi === 'openai') return;
            } catch {  }
            const settings = getSettings();
            if (!settings || !settings.enabled) return;
            if (isInternalCall()) return;
            if (pipelineJustInjected) return; 
            if (isGroupChatSkip(settings)) return;

            const rec = getMemorySheet();
            const result = injectMemoryContext(data, rec.text);
            if (result.injected) {
                setInjectedGuard();
                // Token recording (text-completion path). Injection stays first and
                // synchronous; counting only reads. No trim happens on this path,
                // so baseline (= prompt without the extension) is actual − sheet.
                try {
                    const arr = firstInjectableArray(data);
                    const promptStr = (!arr && typeof data?.prompt === 'string') ? data.prompt : null;
                    const actualInput = arr ? await countChatTokens(arr) : await countTextTokens(promptStr);
                    const sheetTokens = await countTextTokens(rec.text);
                    if (actualInput > 0) {
                        recordRunTokens({ baselineInput: Math.max(0, actualInput - sheetTokens), actualInput, sheetTokens, path: 'text' });
                    }
                } catch {  }
                recordHealthEvent('injection', { status: 'ok', path: 'text' });
                addDebugLog('pass', `Memory sheet injected (text-completion, ${rec.text.length} chars${rec.seeded ? ', seed' : ''})`, {
                    subsystem: 'writer', event: 'inject.ok',
                    data: { chars: rec.text.length, seeded: !!rec.seeded, path: 'text-completion' },
                });
            } else if (result.reason === 'EMPTY_SHEET') {
                recordHealthEvent('injection', { status: 'empty', path: 'text' });
                addDebugLog('info', 'Memory sheet is empty — injection skipped (text-completion, no trim on this path)', {
                    subsystem: 'writer', event: 'inject.empty_sheet',
                    data: { path: 'text-completion' },
                });
            } else {
                recordHealthEvent('injection', { status: 'fail', path: 'text', reason: 'no usable prompt container' });
                addDebugLog('fail', 'Memory sheet injection failed (text-completion) — no usable prompt container', {
                    subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
                });
            }
        } catch (err) {
            recordHealthEvent('injection', { status: 'fail', path: 'text', reason: err.message || String(err) });
            addDebugLog('fail', `Sheet injection failed (text-completion, non-fatal): ${err.message || err}`);
        }
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
        // Runs inside ST's awaited emit chain: keep this handler SYNCHRONOUS so
        // the reply finalizes and the send button re-activates immediately.
        clearInjectedGuard();

        pipelineCancelled = false;
        updateStatus('idle');

        const shouldRecordOutput = runRecordedInput;
        runRecordedInput = false;

        // Detached memory stream — the chat is never blocked while memory runs.
        // Re-entrancy is guarded by memoryExtractionInFlight in runMemoryExtraction();
        // a run that is still in flight when the next reply arrives is coalesced
        // into a single chained catch-up retry, so runs never stack.
        (async () => {
            try {
                if (shouldRecordOutput) {
                    const ctx = SillyTavern.getContext();
                    const lastMsg = ctx.chat?.[ctx.chat.length - 1];
                    if (lastMsg && !lastMsg.is_user && lastMsg.mes) {
                        const n = await (ctx.getTokenCountAsync?.(lastMsg.mes) ?? 0);
                        setMainOutputTokens(n);
                    }
                }
            } catch {  }

            try {
                await runMemoryExtraction();
                maybeRunReflection();
            } catch (err) {
                addDebugLog('fail', `Settle extraction failed (non-fatal): ${err.message || err}`);
                toastPipelineError(`Memory update failed: ${err.message || err}`);
            } finally {
                consumePendingRun();
            }
        })();
    });

    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        cancelActiveRun('stopped');
        addDebugLog('info', 'Generation stopped — in-flight agent calls aborted, writes discarded', { subsystem: 'pipeline', event: 'pipeline.cancel', reason: 'STOPPED' });
    });

    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        addDebugLog('info', 'Message deleted — per-message watermarks remain the extraction source of truth');
    });

    eventSource.on(eventTypes.CHAT_CHANGED, async () => {

        const { invalidateDatabaseCache } = await import('./database.js');
        invalidateDatabaseCache();

        internalCallDepth = 0;
        clearInjectedGuard();

        extractionRetryAfterBusy = false;
        cancelledRetryArmed = false;
        groupSkipToastShown = false;
        lastErrToastMsg = '';
        lastErrToastAt = 0;

        successfulRunsSinceReflection = 0;
        reflectionPending = null;

        // Event-backed health rows must not carry the previous chat's results.
        clearHealthEvents();

        setPendingRun(null);
        endRun();
        hideWorkingIndicator();
        updateStatus('idle');

        addDebugLog('info', 'Chat changed - pipeline state reset');
    });

    console.log('[BFMemory] Pipeline initialized (redesign-v2: pure-code sheet injection + background Memory Agent)');
}
