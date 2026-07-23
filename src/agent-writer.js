function writerLog(level, message, opts = {}) {
    import('./settings.js')
        .then(({ addDebugLog }) => { try { addDebugLog(level, message, opts); } catch {  } })
        .catch(() => {  });
}

// Returns { injected, trimmedCount, reason }. Trimming runs BEFORE the empty-injection
// check so history is bounded even when the sheet has nothing to inject; an empty sheet
// is therefore not a container failure (reason 'EMPTY_SHEET' vs 'NO_CONTAINER').
export function injectMemoryContext(data, injection, options = {}) {
    const trimToLast = Math.max(0, options.trimToLast || 0);

    const arrCandidate = firstMessageArray(data);
    const trimmedCount = (arrCandidate && trimToLast > 0) ? trimChatHistory(arrCandidate, trimToLast) : 0;

    if (!injection) {
        return { injected: false, trimmedCount, reason: 'EMPTY_SHEET' };
    }

    if (arrCandidate) {
        return { injected: injectIntoMessages(arrCandidate, injection), trimmedCount, reason: null };
    }

    if (data && typeof data.prompt === 'string') {
        data.prompt = injection + '\n\n' + data.prompt;
        return { injected: true, trimmedCount, reason: null };
    }

    writerLog('fail', 'injectMemoryContext: no usable prompt container on this event payload', {
        subsystem: 'writer', event: 'inject.failed', reason: 'NO_CONTAINER',
        data: describeInjectPayload(data),
    });
    return { injected: false, trimmedCount, reason: 'NO_CONTAINER' };
}

function firstMessageArray(data) {
    if (!data || typeof data !== 'object') return null;
    const candidates = [data.chat, data.messages, data.prompt, data.chatCompletion, data.messageArray];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    return null;
}

function describeInjectPayload(data) {
    const out = { dataType: typeof data, keys: [] };
    if (!data || typeof data !== 'object') return out;
    try { out.keys = Object.keys(data); } catch {  }
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

// Returns the number of messages removed.
function trimChatHistory(messages, keepLast) {
    if (!Array.isArray(messages)) return 0;

    const isChatMsg = (m) => m && (m.role === 'user' || m.role === 'assistant');
    let chatCount = 0;
    for (const m of messages) {
        if (isChatMsg(m)) chatCount++;
    }
    let removeCount = chatCount - keepLast;
    if (removeCount <= 0) return 0;

    let removed = 0;
    for (let i = 0; i < messages.length && removeCount > 0;) {
        if (isChatMsg(messages[i])) {
            messages.splice(i, 1);
            removeCount--;
            removed++;
        } else {
            i++;
        }
    }
    return removed;
}

function injectIntoMessages(messages, injection) {
    if (!Array.isArray(messages)) return false;

    if (messages.length === 0) {
        messages.push({ role: 'system', content: injection });
        console.log('[BFMemory] Memory context injected into empty prompt');
        return true;
    }

    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === 'user') {
            lastUserIdx = i;
            break;
        }
    }

    if (lastUserIdx === -1) {

        messages.push({ role: 'system', content: injection });
        console.log('[BFMemory] Memory context injected as system-message fallback (no user message found)');
    } else {

        const target = messages[lastUserIdx];
        if (typeof target.content === 'string') {
            target.content = injection + '\n\n' + target.content;
        } else if (Array.isArray(target.content)) {
            target.content.unshift({ type: 'text', text: injection + '\n\n' });
        } else {
            target.content = injection + '\n\n' + String(target.content ?? '');
        }
        console.log('[BFMemory] Memory context concatenated onto last user message');
    }

    return true;
}
