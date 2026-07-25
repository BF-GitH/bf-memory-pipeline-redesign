import { addDebugLog, isTraceRecording, traceCapture } from './settings.js';

import { parseAgentReply, REFLECTION_WRITE_TOOLS } from './memory-tools.js';
import * as host from './host.js';

// The ONLY tool calls executed when they ride alongside the closing block. The
// final round gets no TOOL RESULTS message, so anything run here is run blind:
// the model never sees the outcome and cannot correct a refusal. write_fact and
// link_facts are admitted because extraction routinely batches its last writes
// with #DONE and a link may target a fact written just above it; reflection's
// merge_facts/mark_cold are NOT, and its prompt says so in as many words
// ("merge_facts and mark_cold lines sent alongside the closing sections are
// dropped unexecuted") — a merge or a demotion is too consequential to fire
// with no feedback round and no chance to refuse-and-retry.
export const FINAL_BLOCK_WRITE_TOOLS = ['write_fact', 'link_facts'];

// Does this tool MUTATE the store? Used only to tell a DISCARDED WRITE apart
// from an ignored read when classifying what was thrown away alongside the final
// block: a dropped read costs nothing, a dropped write is work the model
// believed it had done.
//
// Deliberately a function, not a module-level array: memory-tools -> settings ->
// agent-reflect -> llm-call -> memory-tools is a real import cycle, so when
// memory-tools happens to be the module entered first, llm-call's BODY runs
// while memory-tools is still evaluating and REFLECTION_WRITE_TOOLS is in its
// temporal dead zone. Spreading it at module scope would throw at load; reading
// it inside a call cannot, because nothing calls this before the loop runs.
// (parseAgentReply survives the same cycle only because it is a hoisted function
// declaration.)
function isMutatingTool(tool) {
    return tool === 'write_fact' || tool === 'link_facts' || tool === 'add_alias'
        || REFLECTION_WRITE_TOOLS.includes(tool);
}

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

// Trace event namespace, keyed on the agent that owns the call.
//
// This file is shared transport: it serves the memory agent, reflection, the
// story spine and the health ping, but it used to stamp every capture with the
// memory agent's own prefix (`agent3.`). So a reader filtering `reflect.` in the
// Debug tab saw agent-reflect.js's captures and NONE of reflection's prompts,
// replies or tool results — the owning agent was recoverable only from the
// payload's `agent` field. The values below are the prefixes the owning modules
// already use for their own captures (agent-memory.js emits `agent3.*`,
// agent-reflect.js emits `reflect.*`), so one prefix now selects a whole pass.
// beats / sheet-head / beat-backfill / beat-brevity are the memory agent's own
// sub-calls and stay under `agent3`.
const TRACE_NS_BY_AGENT = {
    'memory-agent': 'agent3',
    'beats': 'agent3',
    'sheet-head': 'agent3',
    'beat-backfill': 'agent3',
    'beat-brevity': 'agent3',
    'reflection': 'reflect',
    'story-spine': 'spine',
    'story-spine-rewrite': 'spine',
    'health-ping': 'health',
};
// An unlisted agent falls back to `llm.` rather than to any one agent's prefix:
// a capture filed under the WRONG agent is worse than one filed under none, and
// the payload's `agent` field names the caller either way. Only ever called from
// inside an isTraceRecording() block, so this costs nothing when off.
function traceNs(agent) {
    return TRACE_NS_BY_AGENT[String(agent || '')] || 'llm';
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

// `trace` is optional test-run correlation, `{ runId, callId }` (both plain
// strings, see newTraceCallId). Positional and last because this function's
// contract is positional and every existing caller passes at most five
// arguments — beats, sheet-head, story-spine, the reflection repair retry and
// the health ping keep working untouched. Building the little object
// unconditionally at a single-shot call site costs one allocation per LLM call,
// which is nothing; inside the tool loop, where it would be one per ROUND, it is
// built only while recording (see callAgentLLMWithTools).
export async function callAgentLLM(systemPrompt, userPrompt, profileId = null, agent = 'unknown', externalSignal = null, trace = null) {
    // Legacy string-returning contract (used by the reflection agent): swallow the
    // failure and return '' so callers that expect a plain string keep working.
    try {
        return await callAgentLLMMessages([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ], profileId, agent, externalSignal, trace);
    } catch (err) {
        addDebugLog('info', `callAgentLLM returning empty after failure: ${err?.message || err}`);
        return '';
    }
}

async function callAgentLLMMessages(messages, profileId = null, agent = 'unknown', externalSignal = null, trace = null) {
    const callStart = Date.now();

    const systemPrompt = (Array.isArray(messages) && messages[0]?.role === 'system')
        ? String(messages[0].content || '')
        : '';
    // Hoisted out of the try below so the trace block further down can name the
    // exact hash the cache log reports. cheapHash walks a string and cannot
    // throw, so nothing that needed the guard has left it.
    const sysHash = cheapHash(systemPrompt);
    try {
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
            // systemPromptHash rides along unconditionally (a few bytes) so EVERY
            // call is attributable to a specific prompt text — including in the
            // persisted log, where the full-text trace never goes. It is also
            // what makes the once-per-call system capture below checkable rather
            // than merely asserted.
            data: { agent, systemPromptStable, systemPromptTokens: sysTokens, systemPromptHash: sysHash, personaChanged, note: 'server-side cache HITS are not observable from the extension; this is prefix-stability only' },
        });

        if (prevHash !== undefined && !systemPromptStable && !personaChanged) {
            addDebugLog('info', `Cache drift [${agent}]: system prompt changed between calls — variable per-turn data may have leaked into the static system block (hurts prompt-cache hits). Keep variable data in the USER message.`, {
                subsystem: 'cache', event: 'cache.drift', reason: 'SYSTEM_PROMPT_CHANGED',
                data: { agent, systemPromptTokens: sysTokens },
            });
        }
    } catch {  }

    // ---- Test-run capture (no-op unless the record switch is on) --------------
    // isTraceRecording() gates the WHOLE block, not just the payloads: with
    // recording off this costs one function call and one property read, and not
    // a single object literal, closure or .map() is allocated.
    //
    // The two prompt BODIES are captured once per LLM CALL, not once per round.
    // The key is trace.round: callAgentLLMWithTools builds its messages array
    // once and afterwards only PUSHES to it, so messages[0] and the first user
    // message are byte-identical on every round of a call — round 1 is the only
    // round on which they are new. A single-shot callAgentLLM passes no round at
    // all, which is likewise "capture it". The claim is verifiable instead of
    // asserted: cache.eligibility above reports systemPromptHash on EVERY round,
    // so a reader who ever sees that hash change within one callId knows this
    // capture missed a variant.
    if (isTraceRecording()) {
        const traceRound = trace?.round ?? null;
        const topts = { runId: trace?.runId, callId: trace?.callId, round: traceRound };
        // The namespace of the AGENT, not of this file — see TRACE_NS_BY_AGENT.
        const ns = traceNs(agent);
        if (traceRound === null || traceRound === 1) {
            traceCapture(`${ns}.prompt.system`, () => ({
                agent, hash: sysHash, chars: systemPrompt.length, system: systemPrompt,
            }), topts);
            // A separate entry, deliberately: the trace string budget is per
            // ENTRY, so pairing a 10k system prompt with a 20k task block would
            // truncate both. Apart, each gets the full per-string cap.
            traceCapture(`${ns}.prompt.user`, () => {
                const um = (Array.isArray(messages) ? messages : []).find(m => m?.role === 'user');
                const text = String(um?.content || '');
                return { agent, chars: text.length, user: text };
            }, topts);
        }
        // What was actually handed to the transport THIS round. Bodies are not
        // repeated here — every one of them is captured elsewhere (system/user
        // above, each assistant turn as <ns>.reply.raw, each TOOL RESULTS block
        // as its per-call <ns>.tool.call entries, the grace correction as
        // <ns>.prompt.correction). This is the manifest that proves the order
        // and lets a reader reassemble the exact array from those parts, at a few
        // dozen bytes instead of re-dumping the whole conversation every round.
        traceCapture(`${ns}.request.shape`, () => ({
            agent, profileId: profileId || null,
            parts: (Array.isArray(messages) ? messages : [])
                .map(m => ({ role: m?.role || '?', chars: String(m?.content || '').length })),
        }), topts);
    }

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
                    // The reply, for SINGLE-SHOT calls only. Until now the only
                    // reply capture lived in callAgentLLMWithTools, so beats,
                    // sheet-head, story-spine, beat-backfill, beat-brevity and the
                    // reflection repair retry showed a prompt going in and nothing
                    // coming out — for sheet-head that meant the head reply was
                    // invisible and only the composed sheet survived.
                    //
                    // Keyed on round == null because the tool loop is the only
                    // caller that passes a round, and it emits its own
                    // <ns>.reply.raw per round WITH the parse verdict alongside.
                    // Without this test that reply would be captured twice, at
                    // full length, doubling the entry's cost for nothing.
                    //
                    // Only a non-empty success reaches here: an empty reply is
                    // retried and a failed call already lands in the ordinary log
                    // at fail level, so neither is silently absent.
                    if (isTraceRecording() && (trace?.round ?? null) === null) {
                        traceCapture(`${traceNs(agent)}.reply.raw`, () => {
                            const text = String(result);
                            return {
                                agent, singleShot: true, replyChars: text.length,
                                // Last field: the entry's shared char budget is
                                // spent in key order, so a long reply can be cut
                                // without taking the metadata above it with it.
                                reply: text,
                            };
                        }, { runId: trace?.runId, callId: trace?.callId });
                    }
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
    // a restricted roster (reflection accepts reads plus its three repair tools,
    // nothing else) pass a tool their executor actually accepts, so a confused
    // model is never steered into a rejection.
    protocolExample = null,
    signal = null,
    // Test-run trace correlation, both plain strings, both optional.
    // runId MUST be passed explicitly: it is populated automatically only inside
    // beginRun/endRun, and reflection runs entirely outside that window, so
    // relying on the ambient one would silently produce null-run traces for half
    // the pipeline. traceCallId comes from newTraceCallId('extract'|'reflect'|…)
    // and is what ties one system prompt, one task block and every round of this
    // loop together — runId alone cannot, because one run makes several calls.
    runId = null,
    traceCallId = null,
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
            // Built only while recording: off, this is one property read and a
            // null, so a run that is not being traced allocates nothing per round.
            const traceCtx = isTraceRecording() ? { runId, callId: traceCallId, round } : null;
            reply = await callAgentLLMMessages(messages, profileId, agent, signal, traceCtx);
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
        // The reply in full, EXACTLY ONCE per round, for every outcome — good
        // round, malformed round, round that carries the final block. Nothing is
        // computed that did not already exist: out.transcript has held this text
        // all along. The callers do read it back (both scan it for the last
        // non-empty reply), but neither ever LOGS it, so until now the only round
        // whose reply reached a log was a failing one, sliced to 4000 chars.
        //
        // Placed BEFORE that failure branch and never repeated inside it, so the
        // trace layer emits one reply entry per round and no more. The pre-existing
        // toolloop.rawreply entry below is untouched — it is the fail-level,
        // PERSISTED, 4000-char record and it must keep working when recording is
        // off; the note here points a reader at it so the overlap is stated
        // rather than discovered.
        if (isTraceRecording()) {
            traceCapture(`${traceNs(agent)}.reply.raw`, () => ({
                agent, round, replyChars: reply.length,
                toolCalls: parsed.calls.map(c => c.tool),
                malformedCount: parsed.malformed.length,
                done: !!parsed.done, isChatter,
                // Last field: the entry's shared char budget is spent in key
                // order, so the verdict above always survives intact.
                reply,
            }), {
                runId, callId: traceCallId, round,
                note: (parsed.malformed.length > 0 || isChatter)
                    ? 'protocol parse failed — this is the full text; the fail-level toolloop.rawreply entry carries the same reply sliced to 4000 chars'
                    : undefined,
            });
        }
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
            const correction = `ERROR: ${detail}. Re-emit as bare protocol: put each tool call alone on its own line as strict JSON, e.g.\n${example}\nand end with a line that is exactly ${finalToken} (nothing else on that line).`;
            messages.push({ role: 'user', content: correction });
            // Injected context the model actually saw, and the only piece of the
            // conversation not reconstructible from the other captures: the
            // grace correction is the sole message this file writes itself, and
            // `detail` is elsewhere logged only sliced to 200 chars.
            if (isTraceRecording()) {
                traceCapture(`${traceNs(agent)}.prompt.correction`, () => ({
                    agent, round, detail: String(detail), correction,
                }), { runId, callId: traceCallId, round });
            }
            continue;
        }

        if (parsed.calls.length > 0 && out.toolCallCount + parsed.calls.length > maxToolCalls) {
            out.error = `tool-call cap exceeded (${out.toolCallCount} + ${parsed.calls.length} > ${maxToolCalls})`;
            entry.note = 'tool-call cap overrun';
            break;
        }

        if (parsed.done) {

            if (parsed.calls.length > 0) {
                // Emission order is preserved so a link_facts line can target a
                // fact written just above it in the same reply.
                const writes = parsed.calls.filter(c => FINAL_BLOCK_WRITE_TOOLS.includes(c.tool));
                for (const [wIdx, call] of writes.entries()) {
                    if (signal?.aborted) break;
                    out.toolCallCount++;
                    try {
                        const result = await runTool(call);
                        // Same one-entry-per-call shape as the normal-round loop
                        // below; finalBlock marks the writes that rode alongside
                        // the closing block and therefore never got a feedback
                        // round. See the comment there for why args and result
                        // share an entry.
                        if (isTraceRecording()) {
                            traceCapture(`${traceNs(agent)}.tool.call`, () => {
                                const res = String(result ?? '');
                                return {
                                    agent, round, index: wIdx, tool: call?.tool || null, finalBlock: true,
                                    args: call?.args ?? null,
                                    line: String(call?.line || ''),
                                    resultChars: res.length,
                                    isError: /^\s*ERROR\b/.test(res),
                                    result: res,
                                };
                            }, { runId, callId: traceCallId, round, step: wIdx });
                        }
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
                    } catch (e) {
                        addDebugLog('fail', `write_fact alongside final block threw: ${e?.message || e}`, { subsystem: 'agent3', event: 'toolloop.write_error', data: { agent, round } });
                        // The existing line above names the error but not the
                        // CALL; without this the arguments of the one write that
                        // blew up would be the only ones missing from the trace.
                        if (isTraceRecording()) {
                            traceCapture(`${traceNs(agent)}.tool.call`, () => ({
                                agent, round, index: wIdx, tool: call?.tool || null, finalBlock: true,
                                args: call?.args ?? null,
                                line: String(call?.line || ''),
                                threw: String(e?.message || e),
                            }), { runId, callId: traceCallId, round, step: wIdx, reason: 'TOOL_THREW' });
                        }
                    }
                }
                // Everything else on the final round is thrown away. Split the
                // two cases: an ignored read is free, a dropped WRITE is a
                // repair the model believed it had made and nothing downstream
                // will ever redo it — that has to reach the log as a failure,
                // not be filed under "reads ignored" the way it used to be.
                const dropped = parsed.calls.filter(c => !FINAL_BLOCK_WRITE_TOOLS.includes(c.tool));
                const droppedWrites = dropped.filter(c => isMutatingTool(c.tool));
                if (dropped.length > 0) {
                    const parts = [];
                    if (droppedWrites.length) parts.push(`${droppedWrites.length} write tool call(s) DROPPED`);
                    if (dropped.length > droppedWrites.length) parts.push(`${dropped.length - droppedWrites.length} read tool call(s) ignored`);
                    entry.note = `${parts.join(', ')} (final block present)`;
                }
                if (droppedWrites.length > 0) {
                    const names = [...new Set(droppedWrites.map(c => c.tool))].join(', ');
                    addDebugLog('fail', `[${agent}] ${droppedWrites.length} write tool call(s) (${names}) sent alongside the final block were DROPPED unexecuted — they must be emitted in an earlier reply`, {
                        subsystem: 'agent3', event: 'toolloop.write_dropped', reason: 'FINAL_BLOCK_WRITE_DROPPED',
                        data: {
                            agent, round, tools: names, count: droppedWrites.length,
                            lines: droppedWrites.slice(0, 5).map(c => String(c.line || '').slice(0, 200)),
                        },
                    });
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
        for (const [callIdx, call] of parsed.calls.entries()) {
            if (signal?.aborted) break;
            out.toolCallCount++;
            let result;
            try {
                result = await runTool(call);
            } catch (e) {
                result = `ERROR: ${call.tool} failed internally (${e?.message || e})`;
            }
            // THE capture that makes "what was this write based on" answerable.
            // resultParts is assembled here, fed to the next round and then
            // discarded, so a read_facts payload the model repaired against has
            // never been recoverable after the fact.
            //
            // Arguments and result share ONE entry rather than being paired by a
            // correlation rule: call N and result N cannot drift apart if they
            // were never apart. `index`/`step` is the call's position within the
            // round, which is also its position in the TOOL RESULTS block the
            // model reads next. `result` is the last key because the entry's char
            // budget is spent in key order — a 40k read_facts dump gets cut, the
            // arguments that produced it never do, and either cut is listed in
            // the entry's __truncated manifest.
            if (isTraceRecording()) {
                traceCapture(`${traceNs(agent)}.tool.call`, () => {
                    const res = String(result ?? '');
                    return {
                        agent, round, index: callIdx, tool: call?.tool || null, finalBlock: false,
                        args: call?.args ?? null,
                        line: String(call?.line || ''),
                        resultChars: res.length,
                        isError: /^\s*ERROR\b/.test(res),
                        result: res,
                    };
                }, { runId, callId: traceCallId, round, step: callIdx });
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
