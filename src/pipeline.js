import { injectMemoryContext } from './agent-writer.js';
import { runMemoryAgent } from './agent-memory.js';
import { runReflection } from './agent-reflect.js';
import { cancelInFlightLLM } from './llm-call.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, saveCurrentToActiveProfile, setRunTokens, setMainOutputTokens, addAgent3Tokens, addReflectionTokens, getScene, getReflection, getMemorySheet, setMemorySheet, beginRun, endRun, setPendingRun, getPendingRun, consumePendingRun, isTriviallyEmptyForExtraction } from './settings.js';

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

function toAgentMessage(m, index) {
    return { index, role: m.is_user ? 'USER' : 'CHAR', name: String(m.name || '').trim(), text: m.mes };
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

            setTimeout(() => { runMemoryExtraction(); }, 0);
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

        if (m.extra?.bf_mem_processed) continue;
        if (isTriviallyEmptyForExtraction(m.mes)) { trivialIndices.push(i); continue; }
        settledMessages.push(toAgentMessage(m, i));
    }
    if (settledMessages.length > SETTLED_BATCH_MAX) {
        settledMessages.splice(0, settledMessages.length - SETTLED_BATCH_MAX); 
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

    if (settledMessages.length === 0 && tentativeMessages.length === 0) {
        addDebugLog('info', 'Memory agent (post-reply): no genuine messages — skipping');
        return;
    }

    const capturedDbProfile = settings.activeDbProfile;
    const capturedCharAvatar = ctx0.characters?.[ctx0.characterId]?.avatar || '';
    const startTime = Date.now();

    const pending = getPendingRun();
    const runId = pending?.runId || `M${startTime.toString(36).slice(-5)}`;
    beginRun(runId);

    const postStageMs = { agent3Ms: null, snapshotMs: null };

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
        if (currentCharAvatar !== capturedCharAvatar) {
            addDebugLog('fail', `[${runId}] Character changed mid-extraction (${capturedCharAvatar} -> ${currentCharAvatar}) — withholding watermark/sheet`);
            if (typeof toastr !== 'undefined') {
                toastr.warning('BF Memory: extraction result discarded — you switched characters');
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

        if (memoryResult.sheetText) {
            setMemorySheet(memoryResult.sheetText, { runId, sourceMessageIndex: chat.length - 1 });
        }

        setWatermark(true);

        if (committed.length > 0) {
            const snapStart = Date.now();
            await saveCurrentToActiveProfile(capturedDbProfile);
            postStageMs.snapshotMs = Date.now() - snapStart; 
        }

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
            scene: getScene(),
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
            const ok = injectMemoryContext(data, rec.text); 
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

    eventSource.on(eventTypes.MESSAGE_RECEIVED, async () => {
        clearInjectedGuard();

        pipelineCancelled = false;
        updateStatus('idle');

        try {
            if (runRecordedInput) {
                const ctx = SillyTavern.getContext();
                const lastMsg = ctx.chat?.[ctx.chat.length - 1];
                if (lastMsg && !lastMsg.is_user && lastMsg.mes) {
                    const n = await (ctx.getTokenCountAsync?.(lastMsg.mes) ?? 0);
                    setMainOutputTokens(n);
                }
            }
        } catch {  }

        runRecordedInput = false;

        try {
            await runMemoryExtraction();

            maybeRunReflection();
        } catch (err) {
            addDebugLog('fail', `Settle extraction failed (non-fatal): ${err.message || err}`);
        } finally {

            consumePendingRun();
        }
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

        successfulRunsSinceReflection = 0;
        reflectionPending = null;

        setPendingRun(null);
        endRun();
        hideWorkingIndicator();
        updateStatus('idle');

        addDebugLog('info', 'Chat changed - pipeline state reset');
    });

    console.log('[BFMemory] Pipeline initialized (redesign-v2: pure-code sheet injection + background Memory Agent)');
}
