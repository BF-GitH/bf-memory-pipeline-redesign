// BF Memory Pipeline - shared UI/host utilities (F-UX-8 split from settings.js)
// Dependency-free helpers used by settings.js and the modules extracted from it
// (debug-log.js / turn-state.js / db-panel.js / presets.js), plus message-icon.js.
// escapeHtml and ensurePopup used to be COPY-PASTED in settings.js and message-icon.js —
// this module is now their single home (behavior unchanged).

// Live-binding exports: ensurePopup() assigns these once the lazy ST popup import resolves.
// Importers (settings.js / db-panel.js / message-icon.js) observe the updated values through
// ESM live bindings, so the pre-split 'if (!Popup)' guards keep working unchanged.
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
        } catch { /* try next */ }
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

/**
 * Heuristic branch detector for observability logs. ST names branched chats with a
 * "Branch #N" segment (e.g. "<name> - <date> - Branch #1"). Read-only — used only to tag
 * log entries, never to drive storage/profile behavior.
 * @param {string} chatId
 * @returns {boolean}
 */
export function isBranchChat(chatId) {
    return typeof chatId === 'string' && /Branch\s*#/i.test(chatId);
}

export function getCurrentChatId() {
    const context = getContext();
    // ST stores the current chat filename (unique per chat)
    return context.getCurrentChatId?.() || context.chatId || '';
}
