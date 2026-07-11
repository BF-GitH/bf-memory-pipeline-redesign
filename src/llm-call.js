// BF Memory Pipeline - Direct LLM Call
// Uses ConnectionManagerRequestService when a profile is specified (no DOM/UI switching).
// Falls back to a direct fetch against ST's backend proxy. There is deliberately NO
// generateQuietPrompt fallback leg (F-WRITE-4): it dragged the FULL chat context through
// the user's MAIN model (billed, slow), could not be aborted by our cancel/budget signals,
// and polluted the agents' strict parser format with roleplay prose. When both transports
// fail, the call returns '' and callers degrade to deterministic retrieval instead.

import { addDebugLog } from './settings.js';
// Text-protocol parser for the Memory Agent tool loop (redesign-v2 S2). IMPORT DIRECTION:
// llm-call.js -> memory-tools.js only; memory-tools NEVER imports llm-call (cycle guard).
import { parseAgentReply } from './memory-tools.js';
import * as host from './host.js';

// LATENCY BUDGET (latency/abort fix). The agent LLM calls sit on the user's reply-critical
// path, so they must be hard-bounded — never the old 60s × 3 transports × 2 attempts = ~360s.
// - PER_TRANSPORT timeout: one transport leg (CMRS / proxy / quiet) may take this long before
//   we abort it and try the next. ~28s is generous for a real reply yet far below a 60s stall.
// - WALL-CLOCK budget: the TOTAL time callAgentLLM may spend across ALL transports AND the one
//   permitted retry. Once exceeded we stop trying further legs/attempts and return empty. This
//   is the single number that caps the whole cascade (≈ the worst case for a fully-failing API).
const LLM_TIMEOUT_MS = 28000;          // 28s per transport leg (was 60s, per-leg, unbounded)
const LLM_WALLCLOCK_BUDGET_MS = 45000; // 45s total across all legs + the one retry (hard cap)

/**
 * Minimal Promise-based counting semaphore (atomic #17). `acquire()` resolves to a release
 * function once a slot is free (FIFO). Pure JS, no deps. Used to cap concurrent LLM calls
 * during a full-chat rebuild so the provider isn't hammered. Applied locally by the rebuild.
 * @param {number} n - max concurrent holders
 */
export function createSemaphore(n) {
    let running = 0;
    const queue = [];
    const release = () => { running--; if (queue.length) { running++; queue.shift()(); } };
    return {
        acquire() {
            return new Promise((resolve) => {
                if (running < n) { running++; resolve(release); }
                else queue.push(() => resolve(release));
            });
        },
    };
}

// CACHE-ELIGIBILITY tracking (HONEST — server-side cache HITS are NOT observable from an
// extension; see the long note in callAgentLLMOnce). We can only observe what makes the
// cacheable PREFIX stable: the agent's system-prompt bytes (hash vs the last call for that
// agent) and the active persona. These per-agent last-seen values let us emit a truthful
// `systemPromptStable` flag without ever claiming a cache hit.
const lastSystemHashByAgent = new Map();   // agent -> last system-prompt hash (this session)
let lastPersonaName = undefined;            // active persona name at the last agent call

/** Cheap, dependency-free 32-bit string hash (FNV-1a-ish) for prefix-stability comparison. */
function cheapHash(str) {
    let h = 0x811c9dc5;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

// ── In-flight abort registry (cancel hook) ───────────────────────────────────
// The pipeline must be able to ABORT in-flight agent calls when the user clicks Stop
// (GENERATION_STOPPED) or toggles the extension OFF mid-run. Each active callAgentLLM
// registers its AbortController here; cancelInFlightLLM() aborts them all at once.
// This is what makes "disable / stop actually cancels" real — not just "refuse to commit".
const _activeControllers = new Set();

/**
 * Abort every in-flight agent LLM call. Called by the pipeline's cancelActiveRun() when the
 * user disables the extension or clicks Stop mid-run. Idempotent and safe to call with none
 * in flight. The aborted calls reject with an AbortError, which propagates as a normal
 * (non-retryable) failure so the caller falls back to deterministic retrieval immediately.
 * @param {string} [reason='cancel'] - short reason tag for the debug log
 */
export function cancelInFlightLLM(reason = 'cancel') {
    const n = _activeControllers.size;
    if (n === 0) return;
    for (const ctrl of _activeControllers) {
        try { ctrl.abort(new DOMException('Aborted by BF Memory cancel', 'AbortError')); } catch { /* best-effort */ }
    }
    _activeControllers.clear();
    try {
        addDebugLog('info', `Aborted ${n} in-flight LLM call(s) (${reason})`, {
            subsystem: 'pipeline', event: 'llm.abort', reason, data: { aborted: n },
        });
    } catch { /* logging must never break cancel */ }
}

/** True when an error represents an abort (cancel) rather than a transport failure. */
function isAbortError(err) {
    return !!err && (err.name === 'AbortError' || /\babort/i.test(String(err.message || err)));
}

/**
 * True when an error is a DETERMINISTIC failure that a retry cannot fix — HTTP 4xx
 * (Bad Request / Unauthorized / quota 429) or an abort. Retrying these just burns the
 * wall-clock budget on a guaranteed-identical failure, so we short-circuit instead.
 * @param {Error} err
 * @returns {boolean}
 */
function isNonRetryableError(err) {
    if (isAbortError(err)) return true;
    const msg = String(err?.message || err || '');
    // callSTProxy throws EXACTLY `ST proxy <status>: <body>` — anchor on that structured
    // prefix. The old bare `/\b4\d\d\b/` matched ANY 3-digit run in the message (":443" in a
    // URL, IP octets like 192.168.0.404, byte counts), misclassifying transient network
    // errors as deterministic 4xx and skipping the single retry they deserved.
    if (/^ST proxy 4\d\d:/.test(msg)) return true;
    if (/bad request|unauthorized|forbidden|quota|insufficient|invalid api key/i.test(msg)) return true;
    return false;
}

/**
 * Race a transport leg against (a) a per-leg timeout and (b) an external AbortSignal, and
 * ABORT the underlying work when either fires. Unlike a bare Promise.race, the timeout here
 * calls controller.abort() so a transport that supports the signal (the proxy fetch) actually
 * STOPS rather than lingering in the background billing tokens. Legs that can't take a signal
 * (CMRS) at least stop being awaited the instant the timeout/abort fires.
 * @param {(signal: AbortSignal) => Promise<any>} fn - receives the leg's abort signal
 * @param {number} ms - per-leg timeout
 * @param {AbortSignal} [parentSignal] - the call-level signal (budget/cancel)
 * @returns {Promise<any>}
 */
function withTimeout(fn, ms, parentSignal) {
    const legCtrl = new AbortController();
    // Cascade the parent (budget/cancel) abort down to this leg.
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

/**
 * Detect the current chat completion source and model from ST settings.
 * Used only as fallback when CMRS is unavailable and no profile is specified.
 * @returns {{ source: string, model: string } | null}
 */
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

        // Fallback: try context properties
        if (!source) source = context.chat_completion_source || context.mainApi || '';
        if (!model) model = context.onlineStatus?.model || '';

        return (source || model) ? { source, model } : null;
    } catch (e) {
        console.warn('[BFMemory] detectCurrentConfig failed:', e);
        return null;
    }
}

/**
 * Get ST's ConnectionManagerRequestService if available.
 * @returns {object|null}
 */
function getCMRS() {
    return host.getCMRS();
}

/**
 * Call LLM via ConnectionManagerRequestService (safe, no profile switching).
 * @param {string} profileId - The connection profile ID to use
 * @param {Array} messages - Chat messages array
 * @returns {Promise<string>} The LLM response text
 */
async function callViaCMRS(profileId, messages, signal) {
    const CMRS = getCMRS();
    if (!CMRS) {
        throw new Error('ConnectionManagerRequestService not available');
    }

    const profile = CMRS.getProfile(profileId);
    if (!profile) {
        throw new Error(`Connection profile "${profileId}" not found`);
    }

    addDebugLog('info', `CMRS call via profile "${profile.name || profileId}"`);

    // CMRS.sendRequest exposes no documented AbortSignal param, so we can't truly abort its
    // underlying request. withTimeout still aborts the LEG (stops awaiting) on timeout/cancel,
    // and we honor an already-aborted signal here so a cancel before/at dispatch short-circuits.
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

/**
 * Call LLM directly via ST's backend proxy, without chat context.
 * @param {string} systemPrompt - System instruction for the agent
 * @param {string} userPrompt - The user/data prompt
 * @param {string|null} [profileId=null] - Optional connection profile ID.
 *   When provided, uses ConnectionManagerRequestService (no UI/DOM switching needed).
 *   This is safe to call during mid-generation because it doesn't touch the active profile.
 * @param {string} [agent='unknown'] - agent tag for cache-eligibility logging
 * @param {AbortSignal} [externalSignal] - optional CALLER-OWNED signal scoped to THIS call only
 *   (e.g. the finder's budget timer). When it aborts, only this call's controller aborts — the
 *   global cancelInFlightLLM() still reaches it too. This is how the pipeline cancels a
 *   timed-out finder WITHOUT aborting a concurrent Agent-1 call (which has no such signal).
 * @returns {Promise<string>} The LLM response text
 */
export async function callAgentLLM(systemPrompt, userPrompt, profileId = null, agent = 'unknown', externalSignal = null) {
    return callAgentLLMMessages([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ], profileId, agent, externalSignal);
}

/**
 * Generalized agent call over an ARBITRARY messages array (redesign-v2 S2). Same retry /
 * wall-clock budget / abort-registry / cache-eligibility machinery as callAgentLLM (which is
 * now a 2-message wrapper over this). Used by the Memory Agent tool loop, whose conversation
 * grows by an assistant + user (TOOL RESULTS) pair per round.
 * @param {Array<{role:string, content:string}>} messages - full conversation to send
 * @param {string|null} [profileId=null]
 * @param {string} [agent='unknown']
 * @param {AbortSignal|null} [externalSignal=null]
 * @returns {Promise<string>} the LLM response text ('' on failure — callers degrade)
 */
export async function callAgentLLMMessages(messages, profileId = null, agent = 'unknown', externalSignal = null) {
    // Up to 2 attempts. Retry on:
    // - Empty response (providers like Deepseek intermittently return empty)
    // - Network errors (mobile users hit ERR_NETWORK_CHANGED on WiFi↔cellular switch)
    // CACHE-ELIGIBILITY (honest): observe prefix stability, NEVER a cache hit. Computed once
    // per call (before the retry loop) so a retry doesn't double-log or falsely flip the flag.
    // The stability hash is computed over the leading SYSTEM message (the cacheable prefix);
    // a messages array without one simply skips the check.
    const systemPrompt = (Array.isArray(messages) && messages[0]?.role === 'system')
        ? String(messages[0].content || '')
        : '';
    try {
        const sysHash = cheapHash(systemPrompt);
        const sysTokens = Math.round((String(systemPrompt || '').length) / 4); // ~4 chars/token estimate
        const prevHash = lastSystemHashByAgent.get(agent);
        const systemPromptStable = prevHash !== undefined && prevHash === sysHash;
        lastSystemHashByAgent.set(agent, sysHash);
        let personaName = '';
        try { personaName = host.getUserPersonaName(); } catch { /* best-effort */ }
        const personaChanged = lastPersonaName !== undefined && lastPersonaName !== personaName;
        lastPersonaName = personaName;
        addDebugLog('debug', `Cache eligibility [${agent}]: systemPromptStable=${systemPromptStable}, ~${sysTokens} sys tokens${personaChanged ? ', persona CHANGED' : ''}`, {
            subsystem: 'cache', event: 'cache.eligibility',
            data: { agent, systemPromptStable, systemPromptTokens: sysTokens, personaChanged, note: 'server-side cache HITS are not observable from the extension; this is prefix-stability only' },
        });
        // CACHE-DRIFT GUARD (tool-first): if the static system prompt CHANGED between calls for the
        // same agent (prevHash existed and differs) WITHOUT a legitimate persona change, per-turn
        // variable data has likely leaked into the system block — which breaks server-side prompt
        // caching for that agent. Surface it at info level so a future edit that introduces such a
        // leak is caught early. The fix is always: keep per-turn data in the USER message.
        if (prevHash !== undefined && !systemPromptStable && !personaChanged) {
            addDebugLog('info', `Cache drift [${agent}]: system prompt changed between calls — variable per-turn data may have leaked into the static system block (hurts prompt-cache hits). Keep variable data in the USER message.`, {
                subsystem: 'cache', event: 'cache.drift', reason: 'SYSTEM_PROMPT_CHANGED',
                data: { agent, systemPromptTokens: sysTokens },
            });
        }
    } catch { /* logging must never break the call */ }

    // ── Bounded retry under a WALL-CLOCK budget + real abort ──────────────────
    // One AbortController governs the WHOLE call (all transport legs + the one retry). It is
    // aborted by: (a) the wall-clock budget timer, or (b) cancelInFlightLLM() when the user
    // disables/stops mid-run. Registered so the pipeline's cancel hook can reach it.
    const callCtrl = new AbortController();
    _activeControllers.add(callCtrl);
    // CALLER-SCOPED ABORT: cascade an optional external signal (e.g. the finder budget timer)
    // into this call's controller, so a timed-out finder aborts ONLY its own LLM call and stops
    // burning tokens — without touching a concurrent agent call that owns no such signal.
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
            // Stop before a fresh attempt if the wall-clock budget is spent / call was cancelled.
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
                // NEVER retry deterministic failures (HTTP 4xx / Bad Request / quota) or an abort
                // (cancel/budget): a retry would fail identically and just burn the budget. Only a
                // transient (network / empty) failure earns the single retry.
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

    // All permitted attempts failed / budget spent — return empty string. Callers
    // (agent-draft, agent-memory, finder) handle empty defensively and surface an error.
    if (lastError) {
        addDebugLog('fail', `LLM call failed: ${lastError.message || lastError}`);
    } else {
        addDebugLog('fail', 'LLM returned empty response / budget exhausted');
    }
    return '';
}

async function callAgentLLMOnce(messages, profileId, agent = 'unknown', signal) {
    // ── Prompt-caching note (Claude / OpenRouter / Electron Hub etc.) ─────────────
    // We CANNOT attach `cache_control: {type:'ephemeral'}` markers from an extension.
    // SillyTavern's chat-completions backend rebuilds every message into a fresh
    // {role, content} object (convertClaudeMessages in prompt-converters.js), so any
    // client-supplied cache_control field on these message objects is dropped before
    // the request reaches the provider. Caching is applied SERVER-SIDE only, driven
    // by config.yaml: `claude.enableSystemPromptCache` (caches the whole system block)
    // and `claude.cachingAtDepth` (caches message-array prefixes at role boundaries),
    // with `claude.extendedTTL` choosing 1h vs 5m. There is no per-request/per-message
    // API to toggle these from CMRS/sendRequest.
    //
    // What we CAN guarantee — and the only thing that makes those server-side knobs
    // pay off — is a cache-STABLE prefix: the big STATIC agent rulebook lives entirely
    // in the system message (byte-stable within a session; changes only when the user
    // edits the prompt setting), and ALL per-turn variable data (character card,
    // persona, DB summary, the message being analyzed) lives in the user message AFTER
    // it. Do NOT interleave variable data into the system message or the static prefix
    // stops matching and `enableSystemPromptCache` can no longer reuse it. Agent 3
    // (note-taker) sends the full uncapped DB summary in the user message; the cacheable
    // part is its system rulebook, which this ordering preserves. (redesign-v2 S2: this
    // function now receives the FULL messages array — callAgentLLMMessages/callAgentLLM own
    // its construction; the tool loop appends assistant/user rounds AFTER the stable prefix.)

    // Each leg below stops short the instant the call-level signal aborts (wall-clock budget
    // spent OR user cancel), and a deterministic 4xx from the proxy is RE-THROWN so the outer
    // loop short-circuits the retry. A timeout/abort on one leg still falls through to the next
    // transport — but only while the shared budget permits (the signal gates re-entry).

    const aborted = () => signal?.aborted;
    if (aborted()) throw new DOMException('Aborted before dispatch', 'AbortError');

    // Priority 1: Use CMRS with the specified profile (safe, no profile switching)
    if (profileId) {
        try {
            const result = await withTimeout((sig) => callViaCMRS(profileId, messages, sig), LLM_TIMEOUT_MS, signal);
            return result;
        } catch (cmrsErr) {
            if (isAbortError(cmrsErr)) throw cmrsErr; // budget/cancel — stop the whole call
            addDebugLog('info', `CMRS failed (${cmrsErr.message}), falling back to direct proxy`);
        }
    }
    if (aborted()) throw new DOMException('Aborted after CMRS', 'AbortError');

    // Priority 2 (LAST leg): Direct ST proxy fetch (reads current DOM config)
    try {
        const result = await withTimeout((sig) => callSTProxy(messages, sig), LLM_TIMEOUT_MS, signal);
        return result;
    } catch (proxyErr) {
        if (isAbortError(proxyErr)) throw proxyErr;
        // A deterministic 4xx (Bad Request / quota) will fail identically on a retry —
        // re-throw so callAgentLLM short-circuits instead of burning the budget.
        if (isNonRetryableError(proxyErr)) throw proxyErr;
        // F-WRITE-4: there is NO generateQuietPrompt fallback leg anymore. It dragged the FULL
        // chat context through the user's MAIN model, could not be aborted, and its roleplay-
        // flavored output broke the agents' strict #Section parsers. Log clearly what failed and
        // that the deterministic fallback takes over, then surface the failure exactly like the
        // error path does: re-throw so callAgentLLM's retry/empty-return handling applies (one
        // retry for this transient failure, then return '' — callers fall back to deterministic
        // retrieval, which is memory > a polluted parse).
        addDebugLog('fail', `All LLM transports failed (CMRS${profileId ? '' : ' skipped — no profile'}, then ST proxy: ${proxyErr.message}) — no generateQuietPrompt fallback (F-WRITE-4); deterministic retrieval takes over for this call`, {
            subsystem: 'pipeline', event: 'llm.transports_exhausted', reason: 'ALL_TRANSPORTS_FAILED',
            data: { agent, profileId: profileId || null, error: String(proxyErr.message || proxyErr) },
        });
        throw proxyErr;
    }
}

/**
 * Call ST's backend proxy endpoint directly with custom messages.
 * No chat history, no character card, no system prompt injection.
 * NOTE: This reads source/model from the DOM, so it uses whatever profile is currently active.
 * @param {Array} messages
 * @returns {Promise<string>}
 */
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

    // Include source/model if detected
    if (config?.source) body.chat_completion_source = config.source;
    if (config?.model) body.model = config.model;

    addDebugLog('info', `Direct LLM call: source=${config?.source || '?'} model=${(config?.model || '?').substring(0, 40)}`);

    // Pass the leg's AbortSignal so a timeout/cancel TRULY aborts this fetch (the request
    // stops, stops billing) instead of lingering in the background as the old withTimeout did.
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

// =============================================================================
// MEMORY AGENT TOOL LOOP (redesign-v2 S2) — text-protocol tool calling that works on ANY
// backend (no provider function-call API). The agent replies with lines of strict JSON
// tool calls and/or a final `#SHEET` (or `#DONE` in extractOnly mode) block; we execute
// the calls against the memory store, append the results as ONE user message, and re-call.
// Grammar + parsing live in memory-tools.js (parseAgentReply); execution is injected by
// the caller (`executeTool`, normally memory-tools.executeMemoryTool bound to a run ctx)
// so this loop stays pure transport and memory-tools never has to import llm-call.
// =============================================================================

/** ~4 chars/token estimate over a messages array (internal accounting only). */
function approxMessagesTokens(messages) {
    let chars = 0;
    for (const m of (Array.isArray(messages) ? messages : [])) {
        chars += String(m?.content || '').length;
    }
    return Math.ceil(chars / 4);
}

/**
 * Run the Memory Agent's bounded tool-loop session (G1 protocol).
 *
 * Per round: call the LLM with the running conversation, parse the reply via
 * parseAgentReply, then:
 *   - final block (`#SHEET`/`#DONE`) with NO tool lines → accept and stop;
 *   - final block WITH tool lines → execute only the write_fact calls (read results could
 *     never be observed), accept the sheet, stop;
 *   - tool lines only → execute them sequentially, append ONE user message
 *     `TOOL RESULTS:\n<echoed JSON line>\n<result>...`, re-call;
 *   - malformed JSON / unknown tool / pure chatter → ONE grace: send back
 *     `ERROR: <detail>. Re-emit valid protocol lines or the #SHEET block.` and re-call;
 *     a SECOND offense fails the loop.
 * Failure modes (error set, caller commits nothing new, keeps the prior sheet, does NOT
 * watermark — F-SCRIBE-1 generalized): empty LLM reply, second malformed reply, round cap
 * without a final block, tool-call cap overrun, abort.
 *
 * @param {Object} opts
 * @param {string} opts.systemPrompt - static agent rulebook (cache-stable prefix — keep
 *   per-turn variable data in userPrompt, per the caching contract in callAgentLLMOnce)
 * @param {string} opts.userPrompt - per-run data block (messages, DB overview, prior sheet)
 * @param {string|null} [opts.profileId=null] - connection profile (CMRS) for the agent
 * @param {string} [opts.agent='memory-agent'] - agent tag for logs/cache tracking
 * @param {number} [opts.maxRounds=6] - max LLM calls in this session
 * @param {number} [opts.maxToolCalls=20] - max tool executions across all rounds
 * @param {(call: {tool:string, args:Object, line:string}) => Promise<string>} opts.executeTool
 *   - executor for ONE parsed call (normally executeMemoryTool bound to a run ctx)
 * @param {boolean} [opts.extractOnly=false] - final block is `#DONE` (no sheet expected)
 * @param {AbortSignal|null} [opts.signal=null] - caller-owned abort (cancel/stop)
 * @returns {Promise<{sheet: string|null, done: boolean, rounds: number, toolCallCount: number,
 *   error: string|null, tokensInApprox: number, tokensOutApprox: number,
 *   transcript: Array<{round:number, reply:string, toolCalls:string[], malformed:number, note:string}>}>}
 */
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
    let graceUsed = false; // exactly ONE malformed-reply grace per session

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
            // callAgentLLMMessages already retried transient failures internally — an empty
            // reply here is terminal for the session (no grace: there is nothing to correct).
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

        // ── Malformed protocol (or pure chatter): one grace, then fail ────────────
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
            messages.push({ role: 'user', content: `ERROR: ${detail}. Re-emit valid protocol lines or the ${finalToken} block.` });
            continue;
        }

        // ── Tool-call cap (across ALL rounds) ─────────────────────────────────────
        if (parsed.calls.length > 0 && out.toolCallCount + parsed.calls.length > maxToolCalls) {
            out.error = `tool-call cap exceeded (${out.toolCallCount} + ${parsed.calls.length} > ${maxToolCalls})`;
            entry.note = 'tool-call cap overrun';
            break;
        }

        // ── Final block present ────────────────────────────────────────────────────
        if (parsed.done) {
            // Mixed reply: execute ONLY write_fact calls (their results can never be
            // observed — read tools are ignored), then accept the final block and stop.
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
            out.sheet = parsed.sheet; // null on #DONE — extractOnly's expected shape
            if (!extractOnly && (out.sheet === null || out.sheet === '')) {
                // A bare #DONE (or empty #SHEET) where a sheet was required: the caller
                // treats a missing sheet as failure (F-SCRIBE-1) — surface it as an error
                // here so no watermark/commit can ride a sheetless "success".
                out.error = `final block on round ${round} carried no sheet content`;
                out.sheet = null;
            }
            break;
        }

        // ── Tool rounds: execute sequentially, feed results back, re-call ────────
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
            // No budget left for another call — the reply needed one more round to emit
            // the final block, which the cap forbids (missing-final-on-last-round rule).
            out.error = `max rounds (${maxRounds}) reached without a ${finalToken} block`;
            entry.note = 'round cap without final block';
            break;
        }
        messages.push({ role: 'assistant', content: reply });
        messages.push({ role: 'user', content: `TOOL RESULTS:\n${resultParts.join('\n\n')}` });
    }

    if (!out.error && !out.done) {
        // Defensive: loop exited without a final block and without a recorded error
        // (e.g. maxRounds=0). Never report a silent non-success.
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
