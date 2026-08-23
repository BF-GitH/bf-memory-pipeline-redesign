import { addDebugLog, isTraceRecording, traceCapture } from './settings.js';

import { parseAgentReply, REFLECTION_WRITE_TOOLS } from './memory-tools.js';
import * as host from './host.js';

// The tool calls executed when they ride alongside the closing block ON THE
// LAST ROUND, where no TOOL RESULTS message follows and anything run is run
// blind: the model never sees the outcome and cannot correct a refusal.
// write_fact and link_facts are admitted because extraction routinely batches
// its last writes with #DONE and a link may target a fact written just above
// it; reflection's merge_facts/mark_cold are NOT — a merge or a demotion is too
// consequential to fire with no feedback round and no chance to refuse-and-retry.
// add_alias earns its slot the same way link_facts does: additive, idempotent,
// and touching no stored value — there is nothing a feedback round could veto.
// Measured cost of leaving it out (v0.81.0 test run): the only add_alias of the
// whole session rode alongside the final block and was dropped, and no later
// round ever re-issued it.
//
// WHILE A ROUND REMAINS the list is a much weaker filter, by design. The
// exclusion above is justified by ONE thing only: no feedback round. Whenever
// the loop can still open a round it DEFERS the block instead of dropping the
// call — the block is discarded, the calls run on the ordinary path, the results
// go back, and the model restates. Three things trigger that (all guarded by
// `round < maxRounds` at the deferral site):
//   - a READ next to the block, for callers that pass readsForceAnotherRound
//     (the lookup agent: read-only, so dropping reads dropped its whole pass);
//   - a WRITE outside this list next to the block (merge_facts, mark_cold) —
//     for every caller, because the feedback round removes the reason to drop it;
//   - a write ON this list that ran and answered ERROR — it ran, the others ran,
//     nothing is re-executed, but the model gets to see the refusal and fix it.
// Measured cost of not deferring (0.83.0 long run, 50 turns): 6 final-block
// writes failed with "(no retry round)" — mistyped link refs, an agent-link cap,
// a read-before-write refusal — and one reflection merge_facts dropped outright.
//
// The reflection prompt (agent-reflect.js) describes this contract in the same
// words: a merge_facts/mark_cold next to the closing sections invalidates them
// and is executed, and only on the last round is it dropped. Keep the two in
// step — a prompt that promises a drop the loop no longer makes would be lying.
export const FINAL_BLOCK_WRITE_TOOLS = ['write_fact', 'link_facts', 'add_alias'];

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
// Total budget across the (up to 2) attempts of a single round. MUST stay larger
// than LLM_TIMEOUT_MS, and that is not a style point: both were 300000, so a
// first attempt that ran to its own timeout consumed the ENTIRE round budget and
// the deadline check below killed attempt 2 before it was ever made. The retry
// existed in the code and could never once fire — measured on the Lightning
// export as `LLM wall-clock budget exhausted before attempt 2` immediately after
// a 300s timeout, losing that turn's extraction outright. Derived from the
// per-attempt cap rather than hand-written so the two cannot drift back into
// equality; the +30s covers the parse/dispatch overhead between attempts.
const LLM_WALLCLOCK_BUDGET_MS = LLM_TIMEOUT_MS * 2 + 30000;
// Total tool-loop budget across ALL rounds of one run (15 min). Deliberately
// looser than the per-round budgets above: a slow-but-progressing extraction
// (e.g. 6 rounds x 70s ≈ 7 min) must never die mid-run while every individual
// round is fine. Checked BETWEEN rounds only — an in-flight round is never
// chopped, the loop just refuses to start another one past the budget, and
// exhaustion is logged distinctly (toolloop.budget) so it can't be mistaken
// for a single-round timeout. Raised from 600000 alongside the round budget
// above and for the same reason: one round that spends its full retry allowance
// (630s) would have exhausted the whole run's budget, so restoring the retry
// without this would have traded a dead retry for a truncated run.
const TOOL_LOOP_BUDGET_MS = 900000;

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
    'sheet-head-condense': 'agent3',
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
    // LOOKUP PATH ONLY (agent-lookup.js passes true; nothing else does). When a
    // reply carries the closing block AND a non-mutating tool call, the read wins
    // and the block is discarded: the call is executed like any ordinary round,
    // its output is fed back, and the model must restate its verdict next round.
    // Default false keeps extraction and reflection ignoring ride-along READS as
    // before; ride-along WRITES defer for every caller (FINAL_BLOCK_WRITE_TOOLS).
    readsForceAnotherRound = false,
    // LOOKUP PATH ONLY (agent-lookup.js passes true; nothing else does). A final
    // verdict delivered with ZERO tool calls executed across the whole run gets
    // ONE correction round demanding an actual search before the verdict stands.
    // Protocol-legal but unverified: measured on the v0.81.0 test run, ~93% of
    // lookup passes answered "REFS: none" without a single search — the pass ran
    // its latency budget every turn and looked at nothing. Second idle verdict
    // after the correction is accepted as-is: a model that searched and STILL
    // says none is the honest outcome this option exists to force, and a model
    // that refuses to search twice should not cost a third round every turn.
    requireToolCallBeforeDone = false,
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
        // WHAT KIND of failure `error` is, as a token rather than as prose. Callers
        // that act on a failure — the lookup breaker in pipeline.js is the only one
        // today — must not have to regex the message to tell "the endpoint is dead"
        // from "the model would not follow the format", because those two need
        // opposite advice and the message text is written for humans and changes.
        //
        //   'transport' — the call itself failed or came back empty. Evidence about
        //                 the CONNECTION (URL, key, bridge, model availability).
        //   'protocol'  — the model answered, inside budget, and did not follow the
        //                 tool/closing-block contract. Evidence about the MODEL's
        //                 formatting, and positive evidence that the connection works.
        //   'budget'    — the total-run budget ran out between rounds. Speed.
        //   'aborted'   — WE stopped (chat switch, user cancel). Evidence about nothing.
        //   'internal'  — this function was called wrong.
        //
        // Stays null when `error` is null. Additive: every existing caller reads
        // `error` and ignores this.
        errorKind: null,
        tokensInApprox: 0,
        tokensOutApprox: 0,
        transcript: [],
    };
    if (typeof executeTool !== 'function') {
        out.error = 'callAgentLLMWithTools requires an executeTool function';
        out.errorKind = 'internal';
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
    let idleGraceUsed = false;
    // Set once the model has been told the tool-call cap is spent (see the cap
    // block inside the loop); a second batch of calls after that aborts the run.
    let capNoticeGiven = false;
    // Failed final-block writes buy a retry round (see the final-block branch),
    // but a model that re-sends the same refused call every round would burn
    // the whole round budget on it; after this many retries the failure is
    // logged and the block accepted, as it always was.
    const MAX_FAILED_WRITE_DEFERRALS = 2;
    let failedWriteDeferrals = 0;
    const loopStart = Date.now();

    for (let round = 1; round <= maxRounds; round++) {
        if (signal?.aborted) {
            out.error = 'aborted before round ' + round;
            out.errorKind = 'aborted';
            break;
        }
        // Total-run budget (between rounds only — never chops an in-flight round).
        if (round > 1 && Date.now() - loopStart >= TOOL_LOOP_BUDGET_MS) {
            out.error = `run budget exhausted after ${Math.round((Date.now() - loopStart) / 1000)}s (${round - 1} round(s) completed, budget ${TOOL_LOOP_BUDGET_MS / 1000}s)`;
            out.errorKind = 'budget';
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
            // 'transport' even for the timeout wording: a call that never returned
            // is evidence about the endpoint/bridge, not about formatting. The
            // lookup pass never gets here on ITS deadline — that one is a race in
            // agent-lookup.js and reports timedOut instead.
            out.errorKind = 'transport';
            out.transcript.push({ round, reply: '', toolCalls: [], malformed: 0, note: out.error });
            break;
        }
        out.tokensOutApprox += Math.ceil(String(reply || '').length / 4);

        if (!reply || !reply.trim()) {

            out.error = `empty LLM reply on round ${round}`;
            // An empty body is a transport/endpoint symptom, not a formatting one:
            // there is no reply to have formatted badly.
            out.errorKind = 'transport';
            out.transcript.push({ round, reply: '', toolCalls: [], malformed: 0, note: 'empty reply' });
            break;
        }

        const parsed = parseAgentReply(reply);
        const entry = {
            round,
            reply,
            toolCalls: parsed.calls.map(c => c.tool),
            malformed: parsed.malformed.length,
            // Set when parseAgentReply cut a transcript continuation off the
            // reply ({ line, marker }); the lines above the cut are what parsed.
            truncatedAt: parsed.truncatedAt || null,
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
                out.errorKind = 'protocol';
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

        // TOOL-CALL CAP. A reply carrying more calls than the cap has room for
        // used to abort the whole run before executing ANY of them — measured on
        // the 0.83.0 long run as 15 lookup passes dead on arrival with "cap
        // exceeded (0 + 8 > 4)": the model batched every search into round 1,
        // exactly as its prompt asks, and the cap threw the batch away whole.
        // Now the calls that fit run in emission order, the rest are dropped,
        // and the TOOL RESULTS message says so and asks for the final answer.
        // The run is aborted only when the cap is already spent AND the model
        // sends calls again after that notice — at that point it is ignoring
        // the contract, not merely over-batching.
        let capNote = '';
        if (parsed.calls.length > 0) {
            const remaining = Math.max(0, maxToolCalls - out.toolCallCount);
            if (remaining === 0 && capNoticeGiven && !parsed.done) {
                out.error = `tool-call cap exceeded (${maxToolCalls} reached; ${parsed.calls.length} more call(s) sent after the cap notice)`;
                out.errorKind = 'protocol';
                entry.note = 'tool-call cap overrun after notice';
                break;
            }
            if (parsed.calls.length > remaining) {
                const dropped = parsed.calls.length - remaining;
                const droppedTools = parsed.calls.slice(remaining).map(c => c.tool);
                parsed.calls = parsed.calls.slice(0, remaining);
                capNoticeGiven = true;
                entry.droppedCalls = dropped;
                capNote = `\n\n${dropped} call(s) dropped — tool-call cap (${maxToolCalls}) reached; finish with your final answer now.`;
                addDebugLog('info', `[${agent}] ${dropped} tool call(s) dropped on round ${round} — cap ${maxToolCalls} reached (${remaining} executed of ${remaining + dropped} sent)`, {
                    subsystem: 'agent3', event: 'toolloop.calls_dropped', reason: 'TOOL_CALL_CAP',
                    data: { agent, round, cap: maxToolCalls, sent: remaining + dropped, executed: remaining, dropped, droppedTools, toolCallCount: out.toolCallCount },
                });
            }
        }

        // The idle-verdict correction (requireToolCallBeforeDone above). Fires
        // at most once per run, only when the reply closes with the final token,
        // carries no tool call, and no tool has run in any earlier round either.
        // `round < maxRounds` for the same reason the deferral below guards on
        // it: with no round left to restate the verdict in, the correction could
        // only destroy the answer, so the idle verdict stands.
        if (requireToolCallBeforeDone && parsed.done && !idleGraceUsed
            && out.toolCallCount === 0 && parsed.calls.length === 0
            && round < maxRounds) {
            idleGraceUsed = true;
            entry.note = 'idle verdict — search demanded';
            addDebugLog('info', `[${agent}] Verdict with zero tool calls executed — correction round issued demanding at least one search`, {
                subsystem: 'agent3', event: 'toolloop.idlefinal', reason: 'SEARCH_REQUIRED',
                data: { agent, round },
            });
            const idleCorrection = 'Your reply delivered a verdict without executing a single tool call this run. Do not judge from the prompt alone: emit at least one {"tool":"search",...} (or read_facts / list_keys / search_scenes) line NOW — batching several in one reply is fine. You will get their TOOL RESULTS back, then restate your final answer with the results in hand. If they genuinely add nothing, your original verdict remains a valid final answer.';
            messages.push({ role: 'assistant', content: reply });
            messages.push({ role: 'user', content: idleCorrection });
            if (isTraceRecording()) {
                traceCapture(`${traceNs(agent)}.prompt.correction`, () => ({
                    agent, round, detail: 'idle final: verdict with zero executed tool calls', correction: idleCorrection,
                }), { runId, callId: traceCallId, round });
            }
            continue;
        }

        // A READ that arrived in the same reply as the closing block. For
        // extraction and reflection dropping it costs nothing: their product is
        // the block, and the read was at most a confirmation they chose to skip.
        // For the LOOKUP agent it is the whole pass — that agent is read-only, so
        // EVERY call it can make is a read, and its prompt tells it batching is
        // fine. Measured with the drop in place: 26 lookup runs, 0 executed tool
        // calls, 0 refs. So here the read wins and the block loses; the model gets
        // TOOL RESULTS and has to restate its verdict with them in hand.
        //
        // `round < maxRounds` is the guard that keeps this from destroying the
        // answer: on the last round there is no round left to restate it in, so
        // the block stands and the reads drop as they always did.
        const canDefer = round < maxRounds;
        const readDeferred = parsed.done
            && readsForceAnotherRound
            && canDefer
            && parsed.calls.some(c => !isMutatingTool(c.tool));
        // A WRITE outside FINAL_BLOCK_WRITE_TOOLS (merge_facts, mark_cold) next to
        // the closing block. It used to be dropped unexecuted — the whitelist
        // exists because the final round has no feedback round, and a merge or a
        // demotion must not fire blind. Deferring the block CREATES that feedback
        // round, which removes the only reason to withhold the call: it runs on
        // the ordinary path below, its result goes back to the model, and the
        // model restates the block. Measured cost of the drop (0.83.0 long run):
        // a reflection merge_facts lost with "DROPPED unexecuted" and never
        // re-issued. Last round: no round to restate in, so the drop stands.
        const writeDeferred = parsed.done
            && !readDeferred
            && canDefer
            && parsed.calls.some(c => isMutatingTool(c.tool) && !FINAL_BLOCK_WRITE_TOOLS.includes(c.tool));
        const deferredFinalBlock = readDeferred || writeDeferred;
        // Filled by the final-block branch when a whitelisted write FAILED with a
        // round still left: the block is discarded, the results of the writes that
        // already ran (OK and ERROR alike — none is re-executed) go back as TOOL
        // RESULTS, and the model gets to fix the failed call and restate. Before
        // this, a link_facts whose ref the model mistyped, or a write_fact refused
        // by the read-before-write gate, failed with "(no retry round)" and that
        // was the end of it — 6 such losses on the 0.83.0 long run.
        let finalWriteFailures = null;
        let resultParts = [];

        if (parsed.done && !deferredFinalBlock) {

            if (parsed.calls.length > 0) {
                // Emission order is preserved so a link_facts line can target a
                // fact written just above it in the same reply.
                const writes = parsed.calls.filter(c => FINAL_BLOCK_WRITE_TOOLS.includes(c.tool));
                const failed = [];
                for (const [wIdx, call] of writes.entries()) {
                    if (signal?.aborted) break;
                    out.toolCallCount++;
                    try {
                        const result = await runTool(call);
                        resultParts.push(`${call.line}\n${result}`);
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
                        // executeMemoryTool never throws, it returns the error
                        // as an 'ERROR: ...' string. Collected here, judged below:
                        // with a round left the failure buys a retry round, on
                        // the last round it can only be logged.
                        if (/^\s*ERROR\b/.test(String(result ?? ''))) failed.push({ call, result: String(result) });
                    } catch (e) {
                        resultParts.push(`${call.line}\nERROR: ${call.tool} failed internally (${e?.message || e})`);
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
                // (With a round left, writeDeferred above has already routed any
                // such write onto the ordinary path, so droppedWrites is
                // non-empty here only on the last round.)
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
                    addDebugLog('fail', `[${agent}] ${droppedWrites.length} write tool call(s) (${names}) sent alongside the final block on the last round were DROPPED unexecuted — no round left to feed their results back`, {
                        subsystem: 'agent3', event: 'toolloop.write_dropped', reason: 'FINAL_BLOCK_WRITE_DROPPED',
                        data: {
                            agent, round, tools: names, count: droppedWrites.length,
                            lines: droppedWrites.slice(0, 5).map(c => String(c.line || '').slice(0, 200)),
                        },
                    });
                }
                if (failed.length > 0 && canDefer && !signal?.aborted && failedWriteDeferrals < MAX_FAILED_WRITE_DEFERRALS) {
                    failedWriteDeferrals++;
                    finalWriteFailures = failed;
                    const names = [...new Set(failed.map(f => f.call.tool))].join(', ');
                    entry.note = `${finalToken} deferred — ${failed.length} of ${writes.length} write(s) alongside it failed (${names}); results fed back for a retry`;
                    addDebugLog('info', `[${agent}] ${failed.length} write(s) (${names}) alongside the final block failed — the block was discarded and the results go back; round ${round + 1} must fix the call and restate it: ${failed[0].result.slice(0, 200)}`, {
                        subsystem: 'agent3', event: 'toolloop.final_deferred', reason: 'FINAL_WRITE_FAILED_DEFERRED',
                        data: {
                            agent, round, maxRounds, tools: names, failed: failed.length, executed: writes.length,
                            lines: failed.slice(0, 5).map(f => String(f.call.line || '').slice(0, 200)),
                            results: failed.slice(0, 5).map(f => f.result.slice(0, 200)),
                        },
                    });
                } else {
                    // Last round, aborted, or retries used up: the failure can
                    // only be recorded.
                    for (const f of failed) {
                        addDebugLog('fail', `[${agent}] ${f.call.tool} alongside final block failed (no retry round): ${f.result.slice(0, 300)}`, {
                            subsystem: 'agent3', event: 'toolloop.write_error', reason: 'FINAL_WRITE_FAILED',
                            data: { agent, round, tool: f.call.tool, line: String(f.call.line || '').slice(0, 300), result: f.result.slice(0, 300) },
                        });
                    }
                }
            }
            if (!finalWriteFailures) {
                out.done = true;
                out.sheet = parsed.sheet;
                if (!extractOnly && (out.sheet === null || out.sheet === '')) {

                    out.error = `final block on round ${round} carried no sheet content`;
                    out.errorKind = 'protocol';
                    out.sheet = null;
                }
                break;
            }
        }

        if (deferredFinalBlock) {
            const tools = [...new Set(parsed.calls.map(c => c.tool))];
            const why = readDeferred ? 'a read' : 'a write outside the final-block whitelist';
            entry.note = `${finalToken} deferred — ${parsed.calls.length} tool call(s) in the same reply were executed instead (${tools.join(', ')})`;
            addDebugLog('info', `[${agent}] ${finalToken} arrived alongside ${parsed.calls.length} tool call(s) (${tools.join(', ')}) — ${why} next to the block means the calls RAN and the block was discarded; round ${round + 1} must restate it`, {
                subsystem: 'agent3', event: 'toolloop.final_deferred', reason: readDeferred ? 'FINAL_BLOCK_DEFERRED' : 'FINAL_WRITE_DEFERRED',
                data: { agent, round, maxRounds, tools, calls: parsed.calls.length, readDeferred, writeDeferred },
            });
        }

        // Skipped when the final-block branch above already ran the writes: those
        // results are in resultParts and must NOT be executed a second time.
        const roundCalls = finalWriteFailures ? [] : parsed.calls;
        for (const [callIdx, call] of roundCalls.entries()) {
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
            out.errorKind = 'aborted';
            break;
        }
        addDebugLog('debug', `Memory Agent round ${round}: executed ${roundCalls.length} tool call(s) (${out.toolCallCount}/${maxToolCalls} total)`, {
            subsystem: 'agent3', event: 'toolloop.round',
            data: { agent, round, calls: roundCalls.map(c => c.tool), toolCallCount: out.toolCallCount },
        });

        if (round === maxRounds) {

            out.error = `max rounds (${maxRounds}) reached without a ${finalToken} block`;
            out.errorKind = 'protocol';
            entry.note = 'round cap without final block';
            break;
        }
        messages.push({ role: 'assistant', content: reply });
        // On a deferral the model believes it already finished. Saying so is the
        // difference between it restating the verdict and it sitting silent on a
        // round it thinks is over — and naming the round left tells it not to
        // spend this one on more tools.
        //
        // Three deferral flavours, one note each, because the model must know
        // which of its lines to redo: after a FAILED write it must fix THAT call
        // and nothing else (the OK lines above already ran and must not be sent
        // again); after a ride-along read or write it must only restate.
        const lastRoundNote = `This is round ${round + 1} of ${maxRounds}${round + 1 >= maxRounds ? ', the last one' : ''}`;
        let deferNote = '';
        if (finalWriteFailures) {
            const failedLines = finalWriteFailures.map(f => String(f.call.line || '').slice(0, 200)).join('\n');
            deferNote = `\n\nNOTE: your ${finalToken} block was NOT accepted — ${finalWriteFailures.length} write(s) sent alongside it FAILED (see the ERROR result(s) above):\n${failedLines}\nEvery call listed above has already been executed: do NOT re-send the ones that answered OK. ${lastRoundNote}: if the failed call can be corrected (verify the ref first if you must), re-send only that call, then restate your final answer ending in ${finalToken}.`;
        } else if (deferredFinalBlock) {
            const reason = writeDeferred
                ? 'you sent a merge_facts/mark_cold-class write in the same reply, so it was executed first and these results arrived after the block'
                : 'you sent tool calls in the same reply, so these results arrived after it';
            deferNote = `\n\nNOTE: your ${finalToken} block was NOT accepted — ${reason}. ${lastRoundNote}: give your final answer ending in ${finalToken}, and call no further tools.`;
        }
        // The round that comes next is the last one: say so even when nothing was
        // deferred. The model otherwise learns the cap only from its own system
        // prompt, and on the 0.83.0 long runs the lookup agent — told "3 rounds"
        // — searched again in round 2 on 7 of 66 passes and needed round 3 to
        // close. Its cap is now 2, so a second searching round would end the pass
        // as "max rounds reached without a block" with the refs it found thrown
        // away; one line here keeps that from depending on prompt obedience.
        const lastRoundPlain = (!deferNote && round + 1 >= maxRounds)
            ? `\n\nNOTE: ${lastRoundNote} — give your final answer ending in ${finalToken}. Tool calls sent now cannot be answered any more.`
            : '';
        messages.push({ role: 'user', content: `TOOL RESULTS:\n${resultParts.join('\n\n')}${capNote}${deferNote}${lastRoundPlain}` });
    }

    if (!out.error && !out.done) {

        out.error = out.rounds === 0 ? 'no rounds executed' : `no ${finalToken} block produced`;
        // THE fall-through class, and the one the lookup deferral made reachable:
        // rounds ran, replies came back, no closing block survived. That is the
        // model failing the contract, never the connection failing — the connection
        // demonstrably worked, we read its answers. 'no rounds executed' cannot be
        // reached with maxRounds >= 1 and is filed as internal.
        out.errorKind = out.rounds === 0 ? 'internal' : 'protocol';
    }
    if (out.error) {
        addDebugLog('fail', `Memory Agent tool loop failed: ${out.error}`, {
            subsystem: 'agent3', event: 'toolloop.failed', reason: 'LOOP_ERROR',
            data: { agent, rounds: out.rounds, toolCallCount: out.toolCallCount, error: out.error, errorKind: out.errorKind },
        });
    } else {
        addDebugLog('pass', `Memory Agent tool loop done: ${out.rounds} round(s), ${out.toolCallCount} tool call(s)${out.sheet ? `, sheet ${out.sheet.length} chars` : ''}`, {
            subsystem: 'agent3', event: 'toolloop.done',
            data: { agent, rounds: out.rounds, toolCallCount: out.toolCallCount, sheetChars: out.sheet ? out.sheet.length : 0 },
        });
    }
    return out;
}
