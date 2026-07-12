import {
    getSettings, addDebugLog, setLastGenerated, setLastInserted,
    saveCurrentToActiveProfile, isTriviallyEmptyForExtraction, getPendingRun,
    getMemorySheet, setMemorySheet, getReflection,
} from './settings.js';

function ctx() {
    try { return (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null; } catch { return null; }
}

let catchupInFlight = false;
let catchupCancelled = false;

export function isCatchupRunning() {
    return catchupInFlight;
}

export function cancelCatchupImport() {
    if (!catchupInFlight) return false;
    catchupCancelled = true;
    return true;
}

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

        if (msg.extra?.bf_mem_processed === true) continue;
        if (isTriviallyEmptyForExtraction(msg.mes)) {

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
    if (context.groupId || context.selected_group) return refuse('GROUP_CHAT', 'Catch-up import does not support group chats.'); 
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
        context.saveChatDebounced?.(); 
        return { ...empty, msgsTotal: plan.eligibleCount };
    }

    catchupInFlight = true;
    catchupCancelled = false;

    const capturedChatId = context.chatId;
    const capturedCharAvatar = context.characters?.[context.characterId]?.avatar || '';
    const capturedDbProfile = settings.activeDbProfile;

    const allUpdates = [];
    const allApplied = [];
    let factsAdded = 0, msgsDone = 0, processedChunks = 0, failedChunks = 0;
    let aborted = false;
    const startMs = Date.now();

    try {

        const { runMemoryAgent } = await import('./agent-memory.js');

        const profileId = settings.agent3Profile || null;

        const charInfo = (function () {
            const char = context.characters?.[context.characterId];
            if (!char) return '';
            const parts = [];
            if (char.name) parts.push(`Name: ${char.name}`);
            if (char.description) parts.push(`Description: ${char.description.substring(0, 400)}`);
            return parts.join('\n');
        })();
        const userPersona = context.persona?.description || context.name1 || '';

        addDebugLog('info', `Catch-up import start: ${plan.chunks.length} chunk(s) × ≤${size} msgs (${plan.eligibleCount} eligible of ${plan.totalMsgs})`, {
            subsystem: 'import', event: 'catchup.start', actor: 'USER',
            data: { chunks: plan.chunks.length, batchSize: size, eligible: plan.eligibleCount, total: plan.totalMsgs, profileId: profileId || null },
        });

        for (let c = 0; c < plan.chunks.length; c++) {

            if (catchupCancelled || shouldCancel?.()) {
                catchupCancelled = true;
                addDebugLog('info', `Catch-up import cancelled at chunk ${c + 1}/${plan.chunks.length} — already-stamped chunks are kept; re-run to resume`, {
                    subsystem: 'import', event: 'catchup.cancelled', actor: 'USER', data: { chunk: c + 1, chunks: plan.chunks.length },
                });
                break;
            }

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
            if (!target || !target.mes) { failedChunks++; continue; } 

            const settledMessages = [];
            for (const i of idxs) {
                const m = chat[i];
                if (!m || !m.mes) continue;
                settledMessages.push({ index: i, role: m.is_user ? 'USER' : 'CHAR', name: String(m.name || '').trim(), text: m.mes });
            }
            if (settledMessages.length === 0) { failedChunks++; continue; }

            const stampChunk = () => {
                for (const i of idxs) {
                    if (chat[i]) chat[i].extra = { ...(chat[i].extra || {}), bf_mem_processed: true };
                }
                live.saveChatDebounced?.(); 
            };

            if (settings.agent3EmptyScopeSkip !== false) {
                const windowTexts = settledMessages.map(m => m.text);
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

            let observationDate;
            try {
                const sd = target.send_date;
                const ts = (sd != null) ? new Date(sd).getTime() : NaN;
                observationDate = (Number.isFinite(ts) ? new Date(ts) : new Date()).toISOString();
            } catch (_) {
                observationDate = new Date().toISOString();
            }

            try {

                const result = await runMemoryAgent({
                    settledMessages,
                    tentativeMessages: [],
                    characterInfo: charInfo,
                    userPersona,
                    profileId,
                    observationDate,
                    runId: `C${Date.now().toString(36).slice(-5)}`,
                    extractOnly: true,
                });
                if (result?.error) throw new Error(result.error);
                const applied = Array.isArray(result?.applied) ? result.applied : [];
                const updatesLike = applied.map(({ category, key, fact, status }) => ({
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
                const n = updatesLike.length;
                factsAdded += n;
                allUpdates.push(...updatesLike);
                allApplied.push(...updatesLike);
                stampChunk(); 
                processedChunks++;
                msgsDone += idxs.length;
                addDebugLog('info', `Catch-up: chunk ${c + 1}/${plan.chunks.length} (msgs ${idxs[0] + 1}–${targetIdx + 1}) → +${n} facts`, {
                    subsystem: 'import', event: 'catchup.perChunk',
                    data: { chunk: c + 1, chunks: plan.chunks.length, firstMsg: idxs[0], targetMsgIndex: targetIdx, msgs: idxs.length, factsAdded: n, tokensIn: result?.tokensIn ?? null, tokensOut: result?.tokensOut ?? null },
                });
            } catch (err) {

                failedChunks++;
                addDebugLog('fail', `Catch-up: chunk ${c + 1}/${plan.chunks.length} failed: ${err.message || err} — left unstamped (retryable)`, {
                    subsystem: 'import', event: 'catchup.chunkFailed', reason: 'ERROR',
                    data: { chunk: c + 1, chunks: plan.chunks.length, targetMsgIndex: targetIdx, error: String(err.message || err) },
                });
            }
            onProgress?.({ chunk: c + 1, chunks: plan.chunks.length, msgsDone, msgsTotal: plan.eligibleCount, factsAdded });
        }

        if (!catchupCancelled && !aborted && processedChunks > 0) {
            try {
                const tentative = [];
                for (let i = Math.max(0, chat.length - 4); i < chat.length; i++) {
                    const m = chat[i];
                    if (!m || !m.mes || m.is_system || m.extra?.type) continue;
                    tentative.push({ index: i, role: m.is_user ? 'USER' : 'CHAR', name: String(m.name || '').trim(), text: m.mes });
                }
                const sheetRunId = `C${Date.now().toString(36).slice(-5)}`;
                const sheetRun = await runMemoryAgent({
                    settledMessages: [],
                    tentativeMessages: tentative,
                    characterInfo: charInfo,
                    userPersona,
                    profileId,
                    priorSheetText: getMemorySheet()?.text || '',
                    reflection: getReflection(),
                    observationDate: new Date().toISOString(),
                    runId: sheetRunId,
                    extractOnly: false,
                });
                if (!sheetRun?.error && sheetRun?.sheetText) {
                    setMemorySheet(sheetRun.sheetText, { runId: sheetRunId, sourceMessageIndex: chat.length - 1 });
                    addDebugLog('pass', 'Catch-up: memory sheet rebuilt from the imported store', {
                        subsystem: 'import', event: 'catchup.sheetRebuilt', data: { chars: sheetRun.sheetText.length },
                    });
                } else {
                    addDebugLog('info', `Catch-up: sheet rebuild skipped/failed (${sheetRun?.error || 'no sheet'}) — prior sheet kept`, {
                        subsystem: 'import', event: 'catchup.sheetFailed', reason: 'SHEET_ERROR',
                    });
                }
            } catch (err) {
                addDebugLog('fail', `Catch-up: sheet rebuild threw (non-fatal): ${err.message || err}`, {
                    subsystem: 'import', event: 'catchup.sheetFailed', reason: 'ERROR',
                });
            }
        }
    } finally {

        setLastGenerated(allUpdates);
        setLastInserted(allApplied);

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

    return {
        chunks: plan.chunks.length, processedChunks, failedChunks,
        msgsDone, msgsTotal: plan.eligibleCount, factsAdded,
        cancelled: catchupCancelled, aborted,
    };
}
