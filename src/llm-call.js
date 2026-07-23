import { addDebugLog } from './settings.js';

import { parseAgentReply } from './memory-tools.js';
import * as host from './host.js';

const LLM_TIMEOUT_MS = 300000;          // per-attempt cap (300s). Generous on purpose: a slow reasoning model or a self-hosted bridge (e.g. Claude Code CLI on Termux) chewing a ~20k-char prompt can take several minutes. The memory agent runs in the BACKGROUND (post-reply, detached), so a long wait never blocks the chat.
const LLM_WALLCLOCK_BUDGET_MS = 300000; // total budget (300s) across the (up to 2) attempts of a single round.
// Total tool-loop budget across ALL rounds of one run (10 min). Deliberately
// looser than the per-round budgets above: a slow-but-progressing extraction
// (e.g. 6 rounds x 70s ≈ 7 min) must never die mid-run while every individual
// round is fine. Checked BETWEEN rounds only — an in-flight round is never
// chopped, the loop just refuses to start another one past the budget, and
// exhaustion is logged distinctly (toolloop.budget) so it can't be mistaken
// for a single-round timeout.
const TOOL_LOOP_BUDGET_MS = 600000;

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

    const text = typeof content === 'string' ? content : String(content);
    // Some backends return an auth/API error as 200-OK *content* (nothing
    // throws), so the error string would otherwise be mistaken for a model
    // "reply" that fails protocol parsing (the confusing "malformed protocol
    // reply" symptom). Detect an error-shaped reply and throw, so it surfaces
    // as a real transport error (→ toast) AND triggers the existing fallback
    // to the direct ST proxy (which uses the main chat's working credentials).
    if (text.length < 600
        && /^\s*(?:error|api error|unauthorized|forbidden)\b/i.test(text)
        && /\b(?:401|403|429|5\d\d|authenticat\w*|invalid[^.]*credential|unauthorized|forbidden|rate.?limit|quota|api[ _-]?key)\b/i.test(text)) {
        throw new Error(`profile "${profile.name || profileId}" returned an API error: ${text.trim().slice(0, 200)}`);
    }
    return text;
}

export async function callAgentLLM(systemPrompt, userPrompt, profileId = null, agent = 'unknown', externalSignal = null) {
    // Legacy string-returning contract (used by the reflection agent): swallow the
    // failure and return '' so callers that expect a plain string keep working.
    try {
        return await callAgentLLMMessages([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ], profileId, agent, externalSignal);
    } catch (err) {
        addDebugLog('info', `callAgentLLM returning empty after failure: ${err?.message || err}`);
        return '';
    }
}

async function callAgentLLMMessages(messages, profileId = null, agent = 'unknown', externalSignal = null) {
    const callStart = Date.now();

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
                if (result && result.trim()) {
                    recordAgentCallSafe({ ok: true, ms: Date.now() - callStart, agent, profileId: profileId || null });
                    return result;
                }
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
        // A user cancel is not a transport fault — it must not paint the Health
        // 'Agent connection' row red.
        const userCancel = lastError.name === 'AbortError' && /cancel/i.test(String(lastError.message || ''));
        if (!userCancel) {
            recordAgentCallSafe({ ok: false, ms: Date.now() - callStart, agent, profileId: profileId || null, error: String(lastError.message || lastError).slice(0, 200) });
        }
        addDebugLog('fail', `LLM call failed: ${lastError.message || lastError}`);
        throw lastError;
    }
    recordAgentCallSafe({ ok: false, ms: Date.now() - callStart, agent, profileId: profileId || null, error: 'empty response / budget exhausted' });
    addDebugLog('fail', 'LLM returned empty response / budget exhausted');
    throw new Error('LLM returned empty response');
}

async function callAgentLLMOnce(messages, profileId, agent = 'unknown', signal) {

    const aborted = () => signal?.aborted;
    if (aborted()) throw new DOMException('Aborted before dispatch', 'AbortError');

    if (profileId) {
        // A dedicated connection profile is configured for this agent — use ONLY
        // that profile. NO silent fallback to the main ST proxy: a fallback would
        // hit a different (often unconfigured) model and hide the real failure.
        // On error the exception propagates so a toast can tell the user exactly
        // what broke (e.g. a timeout) instead of masking it behind a wrong-model
        // reply or a 502.
        return await withTimeout((sig) => callViaCMRS(profileId, messages, sig), LLM_TIMEOUT_MS, signal);
    }

    // No dedicated profile configured: the direct ST proxy is the only transport.
    return await withTimeout((sig) => callSTProxy(messages, sig), LLM_TIMEOUT_MS, signal);
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

// Tool-usage telemetry for the Health tab. Dynamic import because a static one
// would close a cycle: llm-call.js -> health.js -> settings.js -> agent-memory.js
// -> llm-call.js. Cached after first load; failures never break the tool loop.
let _healthModPromise = null;
function healthModSafe() {
    if (!_healthModPromise) _healthModPromise = import('./health.js').catch(() => null);
    return _healthModPromise;
}
async function recordToolUseSafe(agentTag, toolName, epoch = null) {
    try { (await healthModSafe())?.recordToolUse(agentTag, toolName, epoch); } catch {  }
}
// Bridge/connection telemetry: every agent-LLM call outcome feeds the Health
// tab's 'Agent connection' row (fire-and-forget — never blocks the call path).
async function recordAgentCallSafe(payload) {
    try { (await healthModSafe())?.recordHealthEvent('agentCall', payload); } catch {  }
}
async function getToolUsageEpochSafe() {
    try { return (await healthModSafe())?.getToolUsageEpoch() ?? null; } catch { return null; }
}

export async function callAgentLLMWithTools({
    systemPrompt,
    userPrompt,
    profileId = null,
    agent = 'memory-agent',
    // Health-tab telemetry tag ('memory' | 'reflection'); null disables recording.
    agentTag = null,
    maxRounds = 8,
    maxToolCalls = 24,
    executeTool,
    extractOnly = false,
    // Example tool-call line shown in the grace-round correction. Callers with
    // a restricted roster (reflection is read-only) pass a tool their executor
    // actually accepts, so a confused model is never steered into a rejection.
    protocolExample = null,
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
    // Telemetry epoch captured at loop start: recordToolUse drops calls whose
    // epoch predates the last CHAT_CHANGED reset, so a loop still in flight
    // across a chat switch cannot repopulate the new chat's just-cleared store.
    const telemetryEpoch = agentTag ? await getToolUsageEpochSafe() : null;
    // Single choke point for every REAL tool execution — both normal rounds and
    // write_fact calls riding alongside the final block go through here, while
    // parse attempts that never execute are deliberately not counted. Recording
    // happens AFTER the executor returns and only when the call neither threw
    // nor was rejected/failed (executors signal both as 'ERROR: ...' strings),
    // so the Health tab counts only tool calls that actually executed.
    const runTool = async (call) => {
        const result = await executeTool(call);
        if (agentTag && call?.tool && !/^\s*ERROR\b/.test(String(result ?? ''))) {
            await recordToolUseSafe(agentTag, call.tool, telemetryEpoch);
        }
        return result;
    };
    const finalToken = extractOnly ? '#DONE' : '#SHEET';
    const messages = [
        { role: 'system', content: String(systemPrompt || '') },
        { role: 'user', content: String(userPrompt || '') },
    ];
    let graceUsed = false;
    const loopStart = Date.now();

    for (let round = 1; round <= maxRounds; round++) {
        if (signal?.aborted) {
            out.error = 'aborted before round ' + round;
            break;
        }
        // Total-run budget (between rounds only — never chops an in-flight round).
        if (round > 1 && Date.now() - loopStart >= TOOL_LOOP_BUDGET_MS) {
            out.error = `run budget exhausted after ${Math.round((Date.now() - loopStart) / 1000)}s (${round - 1} round(s) completed, budget ${TOOL_LOOP_BUDGET_MS / 1000}s)`;
            addDebugLog('fail', `[${agent}] Tool-loop total run budget exhausted: ${out.error}`, {
                subsystem: 'agent3', event: 'toolloop.budget', reason: 'RUN_BUDGET',
                data: { agent, rounds: round - 1, toolCallCount: out.toolCallCount, budgetMs: TOOL_LOOP_BUDGET_MS },
            });
            break;
        }
        out.rounds = round;
        out.tokensInApprox += approxMessagesTokens(messages);
        let reply;
        try {
            reply = await callAgentLLMMessages(messages, profileId, agent, signal);
        } catch (err) {
            // No fallback — surface the real reason. Normalize timeouts/budget
            // aborts into a plain "timed out" message so the toast is honest.
            const raw = String(err?.message || err || '');
            out.error = /timed out|wall-clock|budget|abort/i.test(raw)
                ? `timed out — no response from the memory-agent connection after ${Math.round(LLM_WALLCLOCK_BUDGET_MS / 1000)}s (check the connection profile / bridge)`
                : (raw || `LLM call failed on round ${round}`);
            out.transcript.push({ round, reply: '', toolCalls: [], malformed: 0, note: out.error });
            break;
        }
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
            // Capture the RAW model reply so a protocol failure can be diagnosed
            // from the exported debug log (what did the model actually return?).
            addDebugLog('fail', `[${agent}] Protocol parse failed (round ${round}, ${isChatter ? 'chatter' : 'malformed'}): raw reply is ${String(reply).length} chars. First 2000: ${String(reply).slice(0, 2000)}`, {
                subsystem: 'agent3', event: 'toolloop.rawreply', reason: 'PROTOCOL_DEBUG',
                data: { agent, round, replyChars: String(reply).length, isChatter, graceUsed, rawReply: String(reply).slice(0, 4000) },
            });
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
            const example = protocolExample || '{"tool":"write_fact","args":{"category":"People","key":"x_name","value":"..."}}';
            messages.push({ role: 'user', content: `ERROR: ${detail}. Re-emit as bare protocol: put each tool call alone on its own line as strict JSON, e.g.\n${example}\nand end with a line that is exactly ${finalToken} (nothing else on that line).` });
            continue;
        }

        if (parsed.calls.length > 0 && out.toolCallCount + parsed.calls.length > maxToolCalls) {
            out.error = `tool-call cap exceeded (${out.toolCallCount} + ${parsed.calls.length} > ${maxToolCalls})`;
            entry.note = 'tool-call cap overrun';
            break;
        }

        if (parsed.done) {

            if (parsed.calls.length > 0) {
                // write_fact AND link_facts may ride alongside the final block.
                // Emission order is preserved so a link_facts line can target a
                // fact written just above it in the same reply.
                const writes = parsed.calls.filter(c => c.tool === 'write_fact' || c.tool === 'link_facts');
                for (const call of writes) {
                    if (signal?.aborted) break;
                    out.toolCallCount++;
                    try {
                        const result = await runTool(call);
                        // Final-round calls get no feedback round, so a failure
                        // must be surfaced here or it vanishes entirely —
                        // executeMemoryTool never throws, it returns the error
                        // as an 'ERROR: ...' string.
                        if (/^\s*ERROR\b/.test(String(result ?? ''))) {
                            addDebugLog('fail', `[${agent}] ${call.tool} alongside final block failed (no retry round): ${String(result).slice(0, 300)}`, {
                                subsystem: 'agent3', event: 'toolloop.write_error', reason: 'FINAL_WRITE_FAILED',
                                data: { agent, round, tool: call.tool, line: String(call.line || '').slice(0, 300), result: String(result).slice(0, 300) },
                            });
                        }
                    } catch (e) { addDebugLog('fail', `write_fact alongside final block threw: ${e?.message || e}`, { subsystem: 'agent3', event: 'toolloop.write_error', data: { agent, round } }); }
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
                result = await runTool(call);
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
