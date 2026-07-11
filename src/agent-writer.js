// BF Memory Pipeline - Writer injection seam (redesign-v2)
// The main (reply) model NEVER uses tools and never sees agent prompts. This module is now
// ONLY the pure-code injection seam: injectMemoryContext() splices the persistent MEMORY
// SHEET into the prompt (chat-completion message array or text-completion string) right
// before the last user message, optionally trimming the visible chat history first.
// Everything else that used to live here (writer templates, scene/big-picture/echo blocks,
// the search_memory / remember_fact function tools) was removed in the redesign-v2 purge.

/**
 * Best-effort fire-and-forget debug log from the synchronous injection seam. settings.js is
 * imported lazily to dodge the agent-writer <-> settings import cycle; we do NOT await (this seam
 * runs inside ST's synchronous CHAT_COMPLETION_PROMPT_READY handler and must return its boolean
 * immediately). Logging must never break injection — all errors are swallowed.
 * @param {string} level
 * @param {string} message
 * @param {object} [opts]
 */
function writerLog(level, message, opts = {}) {
    import('./settings.js')
        .then(({ addDebugLog }) => { try { addDebugLog(level, message, opts); } catch { /* never throw */ } })
        .catch(() => { /* settings unavailable — logging is non-essential */ });
}

/**
 * Inject the memory context into the chat completion prompt
 * Called via CHAT_COMPLETION_PROMPT_READY event
 * @param {object} data - Prompt data from ST event
 * @param {string} injection - The memory injection text
 * @param {object} [options]
 * @param {number} [options.trimToLast=0] - If > 0, trim the chat history to the last N
 *   user/AI messages BEFORE injecting (preserves ALL system messages — the leading
 *   prefix AND depth-injected world info / Author's Note). Lets the main model see only a
 *   focused window — relies on stored facts to fill the gap.
 * @returns {boolean} True if injection succeeded
 */
export function injectMemoryContext(data, injection, options = {}) {
    if (!injection) return false;
    const trimToLast = Math.max(0, options.trimToLast || 0);

    // Try the known message-array container shapes IN ORDER. Different ST builds deliver the
    // CHAT_COMPLETION_PROMPT_READY array under different property names; we try each so memory
    // reaches the Writer on more builds than just the documented `data.chat`. The pipeline caller
    // reads `data.chat || data.messages` for its baseline count, so those two are the primary
    // shapes; the rest are defensive fallbacks for builds that nest the array elsewhere.
    const arrCandidate = firstMessageArray(data);
    if (arrCandidate) {
        if (trimToLast > 0) trimChatHistory(arrCandidate, trimToLast);
        return injectIntoMessages(arrCandidate, injection);
    }

    // Text completion format: prompt is a single string, no per-message trimming possible.
    if (data && typeof data.prompt === 'string') {
        data.prompt = injection + '\n\n' + data.prompt;
        return true;
    }

    // FAILURE PATH: no usable prompt container on this ST build. DUMP what was actually received
    // so the next exported Debug log reveals the real container shape (instead of a bare "Failed
    // to inject"). Fire-and-forget — this seam is synchronous and must return its boolean now.
    writerLog('fail', 'injectMemoryContext: no usable prompt container on this event payload', {
        subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
        data: describeInjectPayload(data),
    });
    return false;
}

/**
 * Return the first usable message-ARRAY container on a CHAT_COMPLETION_PROMPT_READY payload,
 * trying the known shapes in order: the documented `data.chat`, then `data.messages`, then a
 * couple of nested fallbacks some ST builds use (`data.prompt` when it is itself an array,
 * `data.chatCompletion`, `data.messageArray`). Returns null when none is an array. Empty arrays
 * ARE returned (a no-op chat is still a valid injection target — injectIntoMessages pushes into
 * it rather than dropping memory on a greeting/first turn).
 * @param {object} data
 * @returns {Array|null}
 */
function firstMessageArray(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.chat, data.messages, data.prompt, data.chatCompletion, data.messageArray];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return null;
}

/**
 * Build a compact, non-throwing diagnostic of a CHAT_COMPLETION_PROMPT_READY payload for the
 * fail-level inject log: the keys present on `data` and the type/length of the candidate
 * containers, so a maintainer reading the exported log can see exactly which container shape the
 * user's ST build delivered. Never includes message CONTENT (privacy + log size).
 * @param {*} data
 * @returns {object}
 */
function describeInjectPayload(data) {
    const out = { dataType: typeof data, keys: [] };
    if (!data || typeof data !== 'object') return out;
    try { out.keys = Object.keys(data); } catch { /* exotic object — leave keys empty */ }
    const describe = (v) => {
        if (Array.isArray(v)) return { type: 'array', length: v.length };
        if (typeof v === 'string') return { type: 'string', length: v.length };
        return { type: typeof v };
    };
    out.chat = describe(data.chat);
    out.messages = describe(data.messages);
    out.prompt = describe(data.prompt);
    return out;
}

/**
 * Trim a messages array IN-PLACE to keep at most `keepLast` user/assistant messages.
 * ALL system messages are preserved — the leading prefix (character card, system prompt)
 * AND system messages injected at depth INSIDE the chat (world info, Author's Note,
 * other extensions' injections). Used to hide old chat history from the main model when
 * the user opts into facts-replace-history mode.
 *
 * F-WRITE-3: the old implementation preserved only the LEADING system run, then counted
 * and spliced everything after it as "chat" — so depth-injected system messages both
 * consumed the keepLast window AND were deleted outright. Now only role user/assistant
 * messages count toward keepLast, and removal walks oldest-first skipping every
 * non-user/assistant entry (system/tool/etc. survive in place).
 */
function trimChatHistory(messages, keepLast) {
    if (!Array.isArray(messages)) return;
    // Only genuine chat turns count toward the window; anything else (system, tool, …)
    // is invisible to the budget and immune to removal.
    const isChatMsg = (m) => m && (m.role === 'user' || m.role === 'assistant');
    let chatCount = 0;
    for (const m of messages) {
        if (isChatMsg(m)) chatCount++;
    }
    let removeCount = chatCount - keepLast;
    if (removeCount <= 0) return;
    // Remove the OLDEST chat messages first, skipping (and thus preserving) every
    // system-role entry in place so world info / Author's Note injects survive.
    for (let i = 0; i < messages.length && removeCount > 0;) {
        if (isChatMsg(messages[i])) {
            messages.splice(i, 1);
            removeCount--;
        } else {
            i++;
        }
    }
}

/**
 * Insert memory context as a system message near the end of the messages array
 * Places it before the last user message so the model sees facts before responding
 * @param {Array} messages
 * @param {string} injection
 * @returns {boolean}
 */
function injectIntoMessages(messages, injection) {
    if (!Array.isArray(messages)) return false;

    // Empty messages array (greeting / first turn): a no-op chat is still a valid injection
    // target — PUSH the system message rather than dropping memory by returning false.
    if (messages.length === 0) {
        messages.push({ role: 'system', content: injection });
        console.log('[BFMemory] Memory context injected into empty prompt');
        return true;
    }

    // Find the last user message
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            lastUserIdx = i;
            break;
        }
    }

    if (lastUserIdx === -1) {
        // No user message found, insert at end
        messages.push({ role: 'system', content: injection });
    } else {
        // Insert before the last user message
        messages.splice(lastUserIdx, 0, { role: 'system', content: injection });
    }

    console.log('[BFMemory] Memory context injected into prompt');
    return true;
}
