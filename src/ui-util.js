export let Popup, POPUP_TYPE;
export async function ensurePopup() {
    if (Popup) return true;
    const paths = ['../../../../popup.js', '../../../../../popup.js', '../../../../scripts/popup.js'];
    for (const p of paths) {
        try {
            const mod = await import(p);
            Popup = mod.Popup;
            POPUP_TYPE = mod.POPUP_TYPE;
            return true;
        } catch {  }
    }
    return false;
}

export function getContext() {
    return SillyTavern.getContext();
}

export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function safeStringify(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
}

export function fmt(n) { return (typeof n === 'number' && Number.isFinite(n)) ? n.toLocaleString() : '—'; }

export function isBranchChat(chatId) {
    return typeof chatId === 'string' && /Branch\s*#/i.test(chatId);
}

export function getCurrentChatId() {
    const context = getContext();

    return context.getCurrentChatId?.() || context.chatId || '';
}
