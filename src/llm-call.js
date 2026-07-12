import { addDebugLog } from './settings.js';

import { parseAgentReply } from './memory-tools.js';
import * as host from './host.js';

const LLM_TIMEOUT_MS = 28000;          
const LLM_WALLCLOCK_BUDGET_MS = 45000; 

const lastSystemHashByAgent = new Map();   
let lastPersonaName = undefined;            

function cheapHash(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

const _activeControllers = new Set();

export function cancelInFlightLLM(reason = 'cancel') {
    const n = _activeControllers.size;
    if (n === 0) return;
    for (const ctrl of _activeControllers) {
        try { ctrl.abort(new DOMException('Aborted by BF Memory cancel', 'AbortError')); } catch {  }
    }
    _activeControllers.clear();
    try {
        addDebugLog('info', `Aborted ${n} in-flight LLM call(s) (${reason})`, {
            subsystem: 'pipeline', event: 'llm.abort', reason, data: { aborted: n },
        });
    } catch {  }
}

function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || /\babort/i.test(String(err.message || err)));
}

function isNonRetryableError(err) {
    if (isAbortError(err)) return true;
    const msg = String(err?.message || err || '');

    if (/^ST proxy 4\d\d:/.test(msg)) return true;
    if (/bad request|unauthorized|forbidden|quota|insufficient|invalid api key/i.test(msg)) return true;
    return false;
}

function withTimeout(fn, ms, parentSignal) {
    const legCtrl = new AbortController();

    const onParentAbort = () => legCtrl.abort(parentSignal.reason);
    if (parentSignal) {
        if (parentSignal.aborted) legCtrl.abort(parentSignal.reason);
        else parentSignal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            legCtrl.abort(new DOMException(`LLM leg timed out after ${ms / 1000}s`, 'TimeoutError'));
            reject(new Error(`LLM call timed out after ${ms / 1000}s`));
        }, ms);
    });
    let work;
    try {
        work = Promise.resolve(fn(legCtrl.signal));
    } catch (e) {
        work = Promise.reject(e);
    }
    return Promise.race([work, timeout]).finally(() => {
        clearTimeout(timer);
        if (parentSignal) parentSignal.removeEventListener?.('abort', onParentAbort);
    });
}

function detectCurrentConfig() {
    try {
        const context = host.getCtx();

        let source = '';
        let model = '';

        if (typeof window !== 'undefined') {
            const chatCompletionSource = document.getElementById('chat_completion_source');
            if (chatCompletionSource) {
                source = chatCompletionSource.value || '';
            }
            const modelSelect = document.getElementById('model_openai_select')
                || document.getElementById('openrouter_model');
            if (modelSelect) {
                model = modelSelect.value || '';
            }
        }

        if (!source) source = context.chat_completion_source || context.mainApi || '';
        if (!model) model = context.onlineStatus?.model || '';

        return (source || model) ? { source, model } : null;
    } catch (e) {
        console.warn('[BFMemory] detectCurrentConfig failed:', e);
        return null;
    }
}

async function callViaCMRS(profileId, messages, signal) {
    const CMRS = host.getCMRS();
    if (!CMRS) {
        throw new Error('ConnectionManagerRequestService not available');
    }

    const profile = CMRS.getProfile(profileId);
    if (!profile) {
        throw new Error(`Connection profile "${profileId}" not found`);
    }

    addDebugLog('info', `CMRS call via profile "${profile.name || profileId}"`);

    if (signal?.aborted) throw new DOMException('Aborted before CMRS dispatch', 'AbortError');
    const result = await CMRS.sendRequest(profileId, messages, 0, {
        stream: false,
        extractData: true,
        includePreset: true,
    });

    const content = result?.content;
    if (content == null) {
        throw new Error(`CMRS returned no content: ${JSON.stringify(result).substring(0, 200)}`);
    }

    return typeof content === 'string' ? content : String(content);
}

export async function callAgentLLM(systemPrompt, userPrompt, profileId = null, agent = 'unknown', externalSignal = null) {
    return callAgentLLMMessages([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], profileId, agent, externalSignal);
}

async function callAgentLLMMessages(messages, profileId = null, agent = 'unknown', externalSignal = null) {

    const systemPrompt = (Array.isArray(messages) && messages[0]?.role === 'system')
        ? String(messages[0].content || '')
        : '';
    try {
        const sysHash = cheapHash(systemPrompt);
        const sysTokens = Math.round((String(systemPrompt || '').length) / 4); 
        const prevHash = lastSystemHashByAgent.get(agent);
        const systemPromptStable = prevHash !== undefined && prevHash === sysHash;
        lastSystemHashByAgent.set(agent, sysHash);
        let personaName = '';
        try { personaName = host.getUserPersonaName(); } catch {  }
        const personaChanged = lastPersonaName !== undefined && lastPersonaName !== personaName;
        lastPersonaName = personaName;
        addDebugLog('debug', `Cache eligibility [${agent}]: systemPromptStable=${systemPromptStable}, ~${sysTokens} sys tokens${personaChanged ? ', persona CHANGED' : ''}`, {
            subsystem: 'cache', event: 'cache.eligibility',
            data: { agent, systemPromptStable, systemPromptTokens: sysTokens, personaChanged, note: 'server-side cache HITS are not observable from the extension; this is prefix-stability only' },
        });

        if (prevHash !== undefined && !systemPromptStable && !personaChanged) {
            addDebugLog('info', `Cache drift [${agent}]: system prompt changed between calls — variable per-turn data may have leaked into the static system block (hurts prompt-cache hits). Keep variable data in the USER message.`, {
                subsystem: 'cache', event: 'cache.drift', reason: 'SYSTEM_PROMPT_CHANGED',
                data: { agent, systemPromptTokens: sysTokens },
            });
        }
    } catch {  }

    const callCtrl = new AbortController();
    _activeControllers.add(callCtrl);

    let onExternalAbort = null;
    if (externalSignal) {
        if (externalSignal.aborted) {
            callCtrl.abort(externalSignal.reason || new DOMException('Aborted by caller signal', 'AbortError'));
        } else {
            onExternalAbort = () => callCtrl.abort(externalSignal.reason || new DOMException('Aborted by caller signal', 'AbortError'));
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }
    const deadline = Date.now() + LLM_WALLCLOCK_BUDGET_MS;
    const budgetTimer = setTimeout(
        () => callCtrl.abort(new DOMException(`LLM wall-clock budget ${LLM_WALLCLOCK_BUDGET_MS / 1000}s exceeded`, 'TimeoutError')),
        LLM_WALLCLOCK_BUDGET_MS,
    );

    let lastError = null;
    try {
        for (let attempt = 1; attempt <= 2; attempt++) {

            if (callCtrl.signal.aborted || Date.now() >= deadline) {
                addDebugLog('fail', `LLM wall-clock budget exhausted before attempt ${attempt} [${agent}]`, {
                    subsystem: 'pipeline', event: 'llm.budget', reason: 'WALLCLOCK', data: { agent, budgetMs: LLM_WALLCLOCK_BUDGET_MS },
                });
                break;
            }
            try {
                const result = await callAgentLLMOnce(messages, profileId, agent, callCtrl.signal);
                if (result && result.trim()) return result;
                if (attempt === 1) {
                    addDebugLog('info', 'LLM returned empty response, retrying once...');
                }
            } catch (err) {
                lastError = err;

                if (isNonRetryableError(err)) {
                    addDebugLog('info', `LLM call not retried (${isAbortError(err) ? 'aborted/cancelled' : 'deterministic 4xx/quota'}) [${agent}]: ${err.message || err}`, {
                        subsystem: 'pipeline', event: 'llm.no_retry', reason: isAbortError(err) ? 'ABORTED' : 'DETERMINISTIC_4XX', data: { agent, error: String(err.message || err) },
                    });
                    break;
                }
                if (attempt === 1) {
                    addDebugLog('info', `LLM call threw (${err.message || err}), retrying once...`);
                }
            }
        }
    } finally {
        clearTimeout(budgetTimer);
        if (externalSignal && onExternalAbort) externalSignal.removeEventListener?.('abort', onExternalAbort);
        _activeControllers.delete(callCtrl);
    }

    if (lastError) {
        addDebugLog('fail', `LLM call failed: ${lastError.message || lastError}`);
    } else {
        addDebugLog('fail', 'LLM returned empty response / budget exhausted');
    }
    return '';
}

async function callAgentLLMOnce(messages, profileId, agent = 'unknown', signal) {

    const aborted = () => signal?.aborted;
    if (aborted()) throw new DOMException('Aborted before dispatch', 'AbortError');

    if (profileId) {
        try {
            const result = await withTimeout((sig) => callViaCMRS(profileId, messages, sig), LLM_TIMEOUT_MS, signal);
            return result;
        } catch (cmrsErr) {
            if (isAbortError(cmrsErr)) throw cmrsErr; 
            addDebugLog('info', `CMRS failed (${cmrsErr.message}), falling back to direct proxy`);
        }
    }
    if (aborted()) throw new DOMException('Aborted after CMRS', 'AbortError');

    try {
        const result = await withTimeout((sig) => callSTProxy(messages, sig), LLM_TIMEOUT_MS, signal);
        return result;
    } catch (proxyErr) {
        if (isAbortError(proxyErr)) throw proxyErr;

        if (isNonRetryableError(proxyErr)) throw proxyErr;

        addDebugLog('fail', `All LLM transports failed (CMRS${profileId ? '' : ' skipped — no profile'}, then ST proxy: ${proxyErr.message}) — no generateQuietPrompt fallback (F-WRITE-4); deterministic retrieval takes over for this call`, {
            subsystem: 'pipeline', event: 'llm.transports_exhausted', reason: 'ALL_TRANSPORTS_FAILED',
            data: { agent, profileId: profileId || null, error: String(proxyErr.message || proxyErr) },
        });
        throw proxyErr;
    }
}

async function callSTProxy(messages, signal) {
    const headers = host.getRequestHeaders();
    if (!headers) {
        throw new Error('Cannot get ST request headers');
    }

    const config = detectCurrentConfig();

    const body = {
        messages,
        stream: false,
    };

    if (config?.source) body.chat_completion_source = config.source;
    if (config?.model) body.model = config.model;

    addDebugLog('info', `Direct LLM call: source=${config?.source || '?'} model=${(config?.model || '?').substring(0, 40)}`);

    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
    });

    if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`ST proxy ${response.status}: ${errorBody.substring(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content == null) {
        throw new Error(`Unexpected proxy response: ${JSON.stringify(data).substring(0, 200)}`);
    }

    return content;
}

function approxMessagesTokens(messages) {
    let chars = 0;
    for (const m of (Array.isArray(messages) ? messages : [])) {
        chars += String(m?.content || '').length;
    }
    return Math.ceil(chars / 4);
}

export async function callAgentLLMWithTools({
    systemPrompt,
    userPrompt,
    profileId = null,
    agent = 'memory-agent',
    maxRounds = 6,
    maxToolCalls = 20,
    executeTool,
    extractOnly = false,
    signal = null,
} = {}) {
    const out = {
        sheet: null,
        done: false,
        rounds: 0,
        toolCallCount: 0,
        error: null,
        tokensInApprox: 0,
        tokensOutApprox: 0,
        transcript: [],
    };
    if (typeof executeTool !== 'function') {
        out.error = 'callAgentLLMWithTools requires an executeTool function';
        return out;
    }
    const finalToken = extractOnly ? '#DONE' : '#SHEET';
    const messages = [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: String(userPrompt || '') },
    ];
    let graceUsed = false; 

    for (let round = 1; round <= maxRounds; round++) {
        if (signal?.aborted) {
            out.error = 'aborted before round ' + round;
            break;
        }
        out.rounds = round;
        out.tokensInApprox += approxMessagesTokens(messages);
        const reply = await callAgentLLMMessages(messages, profileId, agent, signal);
        out.tokensOutApprox += Math.ceil(String(reply || '').length / 4);

        if (!reply || !reply.trim()) {

            out.error = `empty LLM reply on round ${round}`;
            out.transcript.push({ round, reply: '', toolCalls: [], malformed: 0, note: 'empty reply' });
            break;
        }

        const parsed = parseAgentReply(reply);
        const entry = {
            round,
            reply,
            toolCalls: parsed.calls.map(c => c.tool),
            malformed: parsed.malformed.length,
            note: '',
        };
        out.transcript.push(entry);

        const isChatter = parsed.calls.length === 0 && !parsed.done && parsed.malformed.length === 0;
        if (parsed.malformed.length > 0 || isChatter) {
            const detail = parsed.malformed.length > 0
                ? parsed.malformed[0].error
                : 'no tool-call lines and no final block found in the reply';
            if (graceUsed) {
                out.error = `malformed protocol reply (second offense): ${detail}`;
                entry.note = 'malformed — second offense';
                break;
            }
            graceUsed = true;
            entry.note = 'malformed — grace round issued';
            addDebugLog('info', `Memory Agent protocol error (grace issued): ${detail}`, {
                subsystem: 'agent3', event: 'toolloop.malformed', reason: 'PROTOCOL_ERROR',
                data: { agent, round, detail: String(detail).slice(0, 200) },
            });
            messages.push({ role: 'assistant', content: reply });
            messages.push({ role: 'user', content: `ERROR: ${detail}. Re-emit as bare protocol: put each tool call alone on its own line as strict JSON, e.g.\n{"tool":"write_fact","args":{"category":"People","key":"x_name","value":"..."}}\nand end with a line that is exactly ${finalToken} (nothing else on that line).` });
            continue;
        }

        if (parsed.calls.length > 0 && out.toolCallCount + parsed.calls.length > maxToolCalls) {
            out.error = `tool-call cap exceeded (${out.toolCallCount} + ${parsed.calls.length} > ${maxToolCalls})`;
            entry.note = 'tool-call cap overrun';
            break;
        }

        if (parsed.done) {

            if (parsed.calls.length > 0) {
                const writes = parsed.calls.filter(c => c.tool === 'write_fact');
                for (const call of writes) {
                    if (signal?.aborted) break;
                    out.toolCallCount++;
                    try { await executeTool(call); }
                    catch (e) { addDebugLog('fail', `write_fact alongside final block threw: ${e?.message || e}`, { subsystem: 'agent3', event: 'toolloop.write_error', data: { agent, round } }); }
                }
                if (writes.length < parsed.calls.length) {
                    entry.note = `${parsed.calls.length - writes.length} read tool call(s) ignored (final block present)`;
                }
            }
            out.done = true;
            out.sheet = parsed.sheet; 
            if (!extractOnly && (out.sheet === null || out.sheet === '')) {

                out.error = `final block on round ${round} carried no sheet content`;
                out.sheet = null;
            }
            break;
        }

        const resultParts = [];
        for (const call of parsed.calls) {
            if (signal?.aborted) break;
            out.toolCallCount++;
            let result;
            try {
                result = await executeTool(call);
            } catch (e) {
                result = `ERROR: ${call.tool} failed internally (${e?.message || e})`;
            }
            resultParts.push(`${call.line}\n${result}`);
        }
        if (signal?.aborted) {
            out.error = `aborted during tool execution on round ${round}`;
            break;
        }
        addDebugLog('debug', `Memory Agent round ${round}: executed ${parsed.calls.length} tool call(s) (${out.toolCallCount}/${maxToolCalls} total)`, {
            subsystem: 'agent3', event: 'toolloop.round',
            data: { agent, round, calls: parsed.calls.map(c => c.tool), toolCallCount: out.toolCallCount },
        });

        if (round === maxRounds) {

            out.error = `max rounds (${maxRounds}) reached without a ${finalToken} block`;
            entry.note = 'round cap without final block';
            break;
        }
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: `TOOL RESULTS:\n${resultParts.join('\n\n')}` });
    }

    if (!out.error && !out.done) {

        out.error = out.rounds === 0 ? 'no rounds executed' : `no ${finalToken} block produced`;
    }
    if (out.error) {
        addDebugLog('fail', `Memory Agent tool loop failed: ${out.error}`, {
            subsystem: 'agent3', event: 'toolloop.failed', reason: 'LOOP_ERROR',
            data: { agent, rounds: out.rounds, toolCallCount: out.toolCallCount, error: out.error },
        });
    } else {
        addDebugLog('pass', `Memory Agent tool loop done: ${out.rounds} round(s), ${out.toolCallCount} tool call(s)${out.sheet ? `, sheet ${out.sheet.length} chars` : ''}`, {
            subsystem: 'agent3', event: 'toolloop.done',
            data: { agent, rounds: out.rounds, toolCallCount: out.toolCallCount, sheetChars: out.sheet ? out.sheet.length : 0 },
        });
    }
    return out;
}
