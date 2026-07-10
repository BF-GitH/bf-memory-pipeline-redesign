// BF Memory Pipeline - Catch-up import (community adoption §2.1)
// =============================================================================
// CHUNKED backlog onboarding: runs the Scribe over an existing chat's UNPROCESSED history in
// consecutive chunks of N messages (one LLM call per chunk — the chunk's last message is the
// extraction target, the rest ride along as prior context), with progress + cancel, feeding the
// existing Review popup at the end. This is the "I have a 100k-token thread from before I
// installed this" migration path (prior art: Summaryception's Process All / One Batch / Skip,
// STMB's /stmb-catchup) — one call per CHUNK instead of the per-message "Run the Scribe on full
// chat" button, so a 300-message backlog costs ~40 calls instead of ~300.
//
// DELIBERATE DIFFERENCES from runAgent3OnFullChat (settings.js — which stays untouched):
//   - SEQUENTIAL chunk loop, NOT the semaphore fan-out: later chunks' scoped-dedup context must
//     see earlier chunks' committed facts, or a fact revealed in chunk 1 gets re-proposed in
//     chunk 9.
//   - Eligibility tests bf_mem_processed !== true (STRICT), not truthy: a message stranded
//     'in-flight' by a crashed live run is RECOVERED here instead of skipped forever. The old
//     button keeps its truthy test — no regression there.
//   - Per-chunk watermark stamp = the RESUME point: cancel/fail mid-import and re-running picks
//     up exactly where it stopped (failed chunks stay unstamped → retried).
//   - The Review popup shows UNCONDITIONALLY at the end (explicit user action, independent of
//     reviewInterval). NOTE: it drains ALL pendingReviewItems, so it may include facts queued
//     earlier by normal turns — acceptable, they were pending for review anyway.
//
// KNOWN COARSENESS (documented, inherent to chunking): every fact from a chunk carries the
// chunk TARGET's sourceMsgIndex, so the per-message brain icon shows mid-chunk facts on the
// chunk's last message, not the exact line they came from.
//
// Self-contained module (keeps settings.js from growing): statically imports only the settings
// facade + review popup; the heavy agent/DB modules are dynamically imported inside the runner,
// mirroring runAgent3OnFullChat's pattern (and avoiding import cycles).
// =============================================================================

import {
    getSettings, addDebugLog, setLastGenerated, setLastInserted, appendLastInserted,
    saveCurrentToActiveProfile, isTriviallyEmptyForExtraction, getPendingRun,
} from './settings.js';
import { trackUpdate, showReviewPopup, getPendingItems } from './review-popup.js';

/** Resolve the live ST context, null-safe (same helper shape as commands.js). */
function ctx() {
    try { return (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null; } catch { return null; }
}

// ONE shared in-flight/cancel flag pair so the settings button and /bfmem catchup can't run two
// imports at once and either surface can cancel the other's run.
let catchupInFlight = false;
let catchupCancelled = false;

/** Is a catch-up import currently running? (shared by the button + slash command) */
export function isCatchupRunning() {
    return catchupInFlight;
}

/**
 * Request cancellation of the running import. Takes effect at the NEXT chunk boundary — we
 * deliberately do NOT abort the in-flight LLM call (cancelInFlightLLM would also abort a live
 * turn's unrelated agent calls), so on a slow model the current chunk still finishes first.
 * @returns {boolean} true if an import was running and is now flagged to stop
 */
export function cancelCatchupImport() {
    if (!catchupInFlight) return false;
    catchupCancelled = true;
    return true;
}

/**
 * Scan the chat and group every still-unprocessed message into consecutive chunks of up to
 * batchSize (clamped 2-30). Doubles as the COST ESTIMATOR for the confirm dialog: LLM calls =
 * chunks.length. Skip rules mirror runAgent3OnFullChat's work-list build, with one deliberate
 * change: bf_mem_processed !== true (strict) so stranded 'in-flight' messages are recovered.
 * Trivially-empty messages are stamped processed immediately (no LLM call ever helps them),
 * exactly as the full-chat button does.
 *
 * @param {Array} chat - the live ST chat array
 * @param {number} batchSize - messages per Scribe call (clamped 2-30)
 * @returns {{chunks: number[][], eligibleCount: number, totalMsgs: number}} chunks = arrays of chat indices
 */
export function planCatchupChunks(chat, batchSize) {
    const size = Math.max(2, Math.min(30, Math.floor(Number(batchSize) || 8)));
    const totalMsgs = Array.isArray(chat) ? chat.length : 0;
    const chunks = [];
    let current = [];
    let eligibleCount = 0;
    for (let i = 0; i < totalMsgs; i++) {
        const msg = chat[i];
        if (!msg || !msg.mes) continue;
        if (msg.is_system) continue;
        if (msg.extra?.type) continue;
        // STRICT === true test (recovery): 'in-flight' strandings from a crashed live run count
        // as unprocessed here. The live pipeline + old full-chat button keep their truthy test.
        if (msg.extra?.bf_mem_processed === true) continue;
        if (isTriviallyEmptyForExtraction(msg.mes)) {
            // No content to extract, ever — stamp now so neither this run nor a future one
            // wastes a call on it (same immediate stamp as runAgent3OnFullChat).
            msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
            continue;
        }
        eligibleCount++;
        current.push(i);
        if (current.length >= size) { chunks.push(current); current = []; }
    }
    if (current.length > 0) chunks.push(current);
    return { chunks, eligibleCount, totalMsgs };
}

/**
 * Run the chunked catch-up import over the current chat.
 *
 * Guards: refuses re-entry, group chats (same gate as shouldRunPipeline), and a mid-flight
 * generation/turn (getPendingRun() stays non-null from generation start until the settle
 * extraction consumes it — same signal idle consolidation uses). Captures chatId + character
 * avatar + active DB profile at start (capture-at-write, mirroring pipeline.js) and aborts
 * BETWEEN chunks if any of them changed.
 *
 * @param {object} options
 * @param {number} [options.batchSize] - messages per Scribe call (default: catchupBatchSize setting)
 * @param {(p: {chunk: number, chunks: number, msgsDone: number, msgsTotal: number, factsAdded: number}) => void} [options.onProgress]
 * @param {() => boolean} [options.shouldCancel] - extra cancel probe, checked before each chunk
 * @returns {Promise<{refused?: string, chunks: number, processedChunks: number, failedChunks: number,
 *   msgsDone: number, msgsTotal: number, factsAdded: number, cancelled: boolean, aborted: boolean}>}
 */
export async function runCatchupImport({ batchSize, onProgress, shouldCancel } = {}) {
    const empty = { chunks: 0, processedChunks: 0, failedChunks: 0, msgsDone: 0, msgsTotal: 0, factsAdded: 0, cancelled: false, aborted: false };
    const refuse = (reason, msg) => {
        addDebugLog('info', `Catch-up import refused: ${msg}`, {
            subsystem: 'import', event: 'catchup.refused', actor: 'USER', reason,
        });
        if (typeof toastr !== 'undefined') toastr.warning(msg, 'BF Memory');
        return { ...empty, refused: reason };
    };

    if (catchupInFlight) return refuse('ALREADY_RUNNING', 'A catch-up import is already running.');
    const context = ctx();
    if (!context) return refuse('NO_CONTEXT', 'SillyTavern context unavailable.');
    if (context.groupId || context.selected_group) return refuse('GROUP_CHAT', 'Catch-up import does not support group chats.'); // same gate as shouldRunPipeline
    if (getPendingRun()) return refuse('GENERATION_IN_FLIGHT', 'A reply is still generating/settling — wait for the turn to finish, then retry.');
    const chat = context.chat || [];
    if (chat.length === 0) return refuse('EMPTY_CHAT', 'No messages in the current chat.');

    const settings = getSettings() || {};
    const size = Math.max(2, Math.min(30, Math.floor(Number(batchSize) || settings.catchupBatchSize || 8)));
    const plan = planCatchupChunks(chat, size);
    if (plan.chunks.length === 0) {
        addDebugLog('info', 'Catch-up import: nothing to do (all messages processed or trivially empty)', {
            subsystem: 'import', event: 'catchup.nothingToDo', actor: 'USER', data: { totalMsgs: plan.totalMsgs },
        });
        context.saveChatDebounced?.(); // persist any trivial-message stamps the plan pass made
        return { ...empty, msgsTotal: plan.eligibleCount };
    }

    catchupInFlight = true;
    catchupCancelled = false;

    // CAPTURE-AT-WRITE (mirrors pipeline.js): pin the chat, character, and DB profile at start
    // so a mid-import switch can't land facts in the wrong slot or another character's store.
    const capturedChatId = context.chatId;
    const capturedCharAvatar = context.characters?.[context.characterId]?.avatar || '';
    const capturedDbProfile = settings.activeDbProfile;

    const allUpdates = [];
    const allApplied = [];
    let factsAdded = 0, msgsDone = 0, processedChunks = 0, failedChunks = 0;
    let aborted = false;
    const startMs = Date.now();

    try {
        // Heavy modules loaded lazily inside the runner (runAgent3OnFullChat's pattern — no cycles).
        const { runMemoryUpdater } = await import('./agent-memory.js');
        const { getAgent3ProfileId } = await import('./profiler.js');
        const { getAllDatabases } = await import('./database.js');

        const profileId = getAgent3ProfileId(settings);
        // Short character brief (B4 pattern): the Scribe extracts from message text, not the card.
        const charInfo = (function () {
            const char = context.characters?.[context.characterId];
            if (!char) return '';
            const parts = [];
            if (char.name) parts.push(`Name: ${char.name}`);
            if (char.description) parts.push(`Description: ${char.description.substring(0, 400)}`);
            return parts.join('\n');
        })();
        const userPersona = context.persona?.description || context.name1 || '';

        // Load the databases ONCE before the loop (settings.js precedent): applyUpdates mutates
        // this map in place and persists each touched category, so the same reference stays
        // current across chunks — and each later chunk's scoped-dedup context sees the earlier
        // chunks' committed facts.
        const databases = await getAllDatabases();

        addDebugLog('info', `Catch-up import start: ${plan.chunks.length} chunk(s) × ≤${size} msgs (${plan.eligibleCount} eligible of ${plan.totalMsgs})`, {
            subsystem: 'import', event: 'catchup.start', actor: 'USER',
            data: { chunks: plan.chunks.length, batchSize: size, eligible: plan.eligibleCount, total: plan.totalMsgs, profileId: profileId || null },
        });

        for (let c = 0; c < plan.chunks.length; c++) {
            // Cancel is honored at CHUNK BOUNDARIES only (see cancelCatchupImport).
            if (catchupCancelled || shouldCancel?.()) {
                catchupCancelled = true;
                addDebugLog('info', `Catch-up import cancelled at chunk ${c + 1}/${plan.chunks.length} — already-stamped chunks are kept; re-run to resume`, {
                    subsystem: 'import', event: 'catchup.cancelled', actor: 'USER', data: { chunk: c + 1, chunks: plan.chunks.length },
                });
                break;
            }
            // Abort BETWEEN chunks if the chat / character / DB profile changed mid-import
            // (capture-at-write). Everything committed so far is already stamped + saved.
            const live = ctx();
            const liveSettings = getSettings() || {};
            const liveAvatar = live?.characters?.[live?.characterId]?.avatar || '';
            if (!live || live.chatId !== capturedChatId || liveAvatar !== capturedCharAvatar
                || liveSettings.activeDbProfile !== capturedDbProfile) {
                aborted = true;
                addDebugLog('fail', `Catch-up import aborted at chunk ${c + 1}/${plan.chunks.length}: chat/character/profile changed mid-import`, {
                    subsystem: 'import', event: 'catchup.aborted', reason: 'CONTEXT_CHANGED',
                    data: { chunk: c + 1, chunks: plan.chunks.length, chatChanged: live?.chatId !== capturedChatId, charChanged: liveAvatar !== capturedCharAvatar, profileChanged: liveSettings.activeDbProfile !== capturedDbProfile },
                });
                if (typeof toastr !== 'undefined') toastr.warning('Catch-up import stopped — you switched chats/characters mid-import.', 'BF Memory');
                break;
            }

            const idxs = plan.chunks[c];
            const targetIdx = idxs[idxs.length - 1];
            const target = chat[targetIdx];
            if (!target || !target.mes) { failedChunks++; continue; } // defensive: chat mutated under us

            // Prior context = every chunk message but the target (pipeline.js prior-message shape).
            const priorMessages = [];
            for (let k = 0; k < idxs.length - 1; k++) {
                const m = chat[idxs[k]];
                if (m && m.mes) priorMessages.push({ role: m.is_user ? 'USER' : 'CHAR', text: m.mes });
            }
            // Latest USER message in the chunk (absolute chat index) for @src:user attribution.
            let lastUserIdx = null;
            for (let k = idxs.length - 1; k >= 0; k--) {
                const m = chat[idxs[k]];
                if (m && m.is_user) { lastUserIdx = idxs[k]; break; }
            }

            const stampChunk = () => {
                for (const i of idxs) {
                    if (chat[i]) chat[i].extra = { ...(chat[i].extra || {}), bf_mem_processed: true };
                }
                live.saveChatDebounced?.(); // per-chunk stamp = the resume watermark
            };

            // EMPTY-SCOPE PRE-LLM SKIP (mirrors pipeline.js agent3EmptyScopeSkip): if EVERY
            // message in the chunk is trivially empty, stamp + move on without spending a call.
            if (settings.agent3EmptyScopeSkip !== false) {
                const windowTexts = [target.mes, ...priorMessages.map(m => m.text)];
                if (windowTexts.every(t => isTriviallyEmptyForExtraction(t))) {
                    addDebugLog('info', `Catch-up: chunk ${c + 1}/${plan.chunks.length} trivially empty — skipping LLM call`, {
                        subsystem: 'import', event: 'catchup.chunkSkipped', reason: 'EMPTY_SCOPE', data: { chunk: c + 1, msgs: idxs.length },
                    });
                    stampChunk();
                    processedChunks++;
                    msgsDone += idxs.length;
                    onProgress?.({ chunk: c + 1, chunks: plan.chunks.length, msgsDone, msgsTotal: plan.eligibleCount, factsAdded });
                    continue;
                }
            }

            // TEMPORAL GROUNDING: the chunk target's real-world send date (mirrors pipeline.js —
            // never throws, degrades to now()).
            let observationDate;
            try {
                const sd = target.send_date;
                const ts = (sd != null) ? new Date(sd).getTime() : NaN;
                observationDate = (Number.isFinite(ts) ? new Date(ts) : new Date()).toISOString();
            } catch (_) {
                observationDate = new Date().toISOString();
            }

            try {
                const result = await runMemoryUpdater(
                    target.mes, targetIdx, charInfo, databases, profileId,
                    !!target.is_user, userPersona, priorMessages, lastUserIdx,
                    String(target.name || '').trim(), // source speaker (per-character namespacing)
                    observationDate,
                );
                if (result?.error) throw new Error(result.error);
                const n = result?.updates?.length || 0;
                factsAdded += n;
                if (Array.isArray(result?.updates)) {
                    allUpdates.push(...result.updates);
                    for (const update of result.updates) trackUpdate(update); // queue for the final review popup
                }
                if (Array.isArray(result?.applied)) allApplied.push(...result.applied);
                stampChunk(); // success: stamp EVERY message in the chunk (resume watermark)
                processedChunks++;
                msgsDone += idxs.length;
                addDebugLog('info', `Catch-up: chunk ${c + 1}/${plan.chunks.length} (msgs ${idxs[0] + 1}–${targetIdx + 1}) → +${n} facts`, {
                    subsystem: 'import', event: 'catchup.perChunk',
                    data: { chunk: c + 1, chunks: plan.chunks.length, firstMsg: idxs[0], targetMsgIndex: targetIdx, msgs: idxs.length, factsAdded: n, tokensIn: result?.tokensIn ?? null, tokensOut: result?.tokensOut ?? null },
                });
            } catch (err) {
                // Per-chunk failure: leave the chunk UNSTAMPED (retryable on the next run), continue.
                failedChunks++;
                addDebugLog('fail', `Catch-up: chunk ${c + 1}/${plan.chunks.length} failed: ${err.message || err} — left unstamped (retryable)`, {
                    subsystem: 'import', event: 'catchup.chunkFailed', reason: 'ERROR',
                    data: { chunk: c + 1, chunks: plan.chunks.length, targetMsgIndex: targetIdx, error: String(err.message || err) },
                });
            }
            onProgress?.({ chunk: c + 1, chunks: plan.chunks.length, msgsDone, msgsTotal: plan.eligibleCount, factsAdded });
        }
    } finally {
        // COMPLETION (success OR cancel OR abort): surface what this import produced in the
        // Last Generated / Last Inserted tabs (settings.js full-chat precedent) and snapshot the
        // working store into the CAPTURED profile slot (capture-at-write).
        setLastGenerated(allUpdates);
        setLastInserted(allApplied);
        // RE-VERIFY the live context before snapshotting (pipeline.js character-changed guard
        // precedent): saveCurrentToActiveProfile reads getAllDatabases(), which is keyed by the
        // NOW-current avatar/chat, so after a mid-import switch it would snapshot the NEW
        // context's working store into the OLD captured profile slot. The `aborted` flag alone
        // is not enough — a switch during the FINAL chunk's LLM call ends the loop with
        // aborted === false. Skipping is safe: committed facts are already persisted per-category
        // by applyUpdates, and the next extraction in the original chat re-snapshots.
        const doneCtx = ctx();
        const doneAvatar = doneCtx?.characters?.[doneCtx?.characterId]?.avatar || '';
        const contextUnchanged = !!doneCtx && doneCtx.chatId === capturedChatId
            && doneAvatar === capturedCharAvatar
            && (getSettings() || {}).activeDbProfile === capturedDbProfile;
        if (contextUnchanged) {
            try {
                await saveCurrentToActiveProfile(capturedDbProfile);
            } catch (err) {
                addDebugLog('fail', `Catch-up: profile snapshot failed (facts are still in the working store): ${err.message || err}`, {
                    subsystem: 'import', event: 'catchup.snapshotFailed', reason: 'ERROR',
                });
            }
        } else {
            addDebugLog('fail', 'Catch-up: profile snapshot skipped — chat/character/profile changed mid-import (facts are still in the working store)', {
                subsystem: 'import', event: 'catchup.snapshotSkipped', reason: 'CONTEXT_CHANGED',
            });
        }
        catchupInFlight = false;
    }

    addDebugLog(failedChunks > 0 ? 'info' : 'pass', `Catch-up import ${catchupCancelled ? 'cancelled' : aborted ? 'aborted' : 'complete'}: ${processedChunks}/${plan.chunks.length} chunk(s), ${msgsDone} msg(s), +${factsAdded} facts${failedChunks ? `, ${failedChunks} chunk(s) failed (retryable)` : ''}`, {
        subsystem: 'import', event: 'catchup.complete', actor: 'USER',
        data: { chunks: plan.chunks.length, processedChunks, failedChunks, msgsDone, msgsTotal: plan.eligibleCount, factsAdded, cancelled: catchupCancelled, aborted, durationMs: Date.now() - startMs },
    });

    // Review popup — UNCONDITIONAL for this explicit user action (independent of reviewInterval).
    // NOTE: getPendingItems() drains the WHOLE pending queue, so items queued by normal turns
    // before this import may ride along — acceptable, they were pending for review anyway.
    // Guarded on the captured chat so it can't pop over a different chat after an abort.
    if (ctx()?.chatId === capturedChatId && getPendingItems().length > 0) {
        await showReviewPopup(
            () => addDebugLog('info', 'Catch-up: user confirmed reviewed facts (Looks good)'),
            async (editedItems) => {
                // Same edit-commit body as pipeline.js's review popup: never upsert informational
                // conflict items; cross-key supersede rules apply ONLY to a material NEW/UPDATED
                // write (isMaterialFactWrite — mirrors applyUpdates' update.changed gate). The
                // queue re-upserts ALREADY-SAVED items, and an unchanged death/departure/loss
                // item must never re-fire a rule against facts written after the original trigger.
                const { getAllDatabases, createEmptyDatabase, upsertFact, saveDatabase, applyCrossKeySupersedeRules, isMaterialFactWrite } = await import('./database.js');
                const writable = editedItems.filter(i => i.action !== 'conflict');
                addDebugLog('info', `Catch-up: user edited ${writable.length} items`);
                appendLastInserted(writable.map(i => ({ ...i, status: 'UPDATED' })));
                const dbs = await getAllDatabases();
                const toSave = new Set();
                for (const item of writable) {
                    if (!dbs[item.category]) dbs[item.category] = createEmptyDatabase(item.category);
                    const material = isMaterialFactWrite(dbs[item.category], item);
                    upsertFact(dbs[item.category], item);
                    toSave.add(item.category);
                    if (material) {
                        for (const cat of applyCrossKeySupersedeRules(dbs, item, item.category)) toSave.add(cat);
                    }
                }
                for (const cat of toSave) {
                    if (dbs[cat]) await saveDatabase(dbs[cat]);
                }
            },
        );
    }

    return {
        chunks: plan.chunks.length, processedChunks, failedChunks,
        msgsDone, msgsTotal: plan.eligibleCount, factsAdded,
        cancelled: catchupCancelled, aborted,
    };
}
