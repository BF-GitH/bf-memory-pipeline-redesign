import { addDebugLog } from './settings.js';

import { ensurePopup, Popup as _Popup, POPUP_TYPE as _POPUP_TYPE, escapeHtml as escapeHtmlMsg } from './ui-util.js';

const ICON_CLASS = 'bf_mem_msg_icon';
const ICON_PROCESSED_CLASS = 'bf_mem_msg_icon_processed';
const ICON_LOADING_CLASS = 'bf_mem_msg_icon_loading';

function injectIcon(messageEl) {
    if (!messageEl) return;
    const buttons = messageEl.querySelector('.mes_buttons');
    if (!buttons) return;

    const mesId = parseInt(messageEl.getAttribute('mesid'));
    if (Number.isNaN(mesId)) return;

    const chat = SillyTavern.getContext().chat;
    const msg = chat?.[mesId];
    if (!msg) return;

    if (msg.is_system) return;
    if (msg.extra?.type) return;

    let icon = buttons.querySelector(`.${ICON_CLASS}`);
    if (!icon) {
        icon = document.createElement('div');
        icon.className = `mes_button ${ICON_CLASS} fa-solid fa-brain interactable`;
        icon.setAttribute('tabindex', '0');
        icon.addEventListener('click', (e) => onIconClick(e, mesId));

        const editBtn = buttons.querySelector('.mes_edit');
        if (editBtn) {
            buttons.insertBefore(icon, editBtn);
        } else {
            buttons.prepend(icon);
        }
    }

    updateIconState(icon, msg);
}

function updateIconState(iconEl, msg) {
    const processed = !!msg.extra?.bf_mem_processed;
    iconEl.classList.toggle(ICON_PROCESSED_CLASS, processed);

    iconEl.title = processed
        ? 'Scribe processed this message. Click to see the facts it produced · Shift+click to re-extract.'
        : 'Scribe has NOT processed this message. Click to see facts (none yet) · Shift+click to extract (makes an AI call).';
}

async function onIconClick(e, mesId) {
    e.stopPropagation();
    const ctx = SillyTavern.getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return;

    const iconEl = e.currentTarget;
    if (iconEl.classList.contains(ICON_LOADING_CLASS)) return; 

    const wantExtract = e.shiftKey;
    if (!wantExtract) {
        try {
            await showMessageFacts(mesId);
        } catch (err) {
            addDebugLog('fail', `Per-msg fact viewer failed for msg ${mesId}: ${err.message || err}`);
            if (typeof toastr !== 'undefined') toastr.error(`Couldn't open facts: ${err.message || err}`, 'BF Memory');
        }
        return;
    }

    iconEl.classList.add(ICON_LOADING_CLASS);

    try {
        const { runMemoryAgent } = await import('./agent-memory.js');
        const { getSettings, saveCurrentToActiveProfile } = await import('./settings.js');

        const settings = getSettings();
        const profileId = settings?.agent3Profile || null;

        const char = ctx.characters?.[ctx.characterId];
        const charInfo = char ? [
            char.name && `Name: ${char.name}`,
            char.description && `Description: ${char.description.substring(0, 400)}`,
        ].filter(Boolean).join('\n') : '';
        const userPersona = ctx.persona?.description || ctx.name1 || '';

        addDebugLog('info', `Per-msg icon: forcing the Memory Agent on msg ${mesId}`);

        const result = await runMemoryAgent({
            settledMessages: [{ index: mesId, role: msg.is_user ? 'USER' : 'CHAR', name: String(msg.name || '').trim(), text: msg.mes }],
            tentativeMessages: [],
            characterInfo: charInfo,
            userPersona,
            profileId,
            runId: `I${Date.now().toString(36).slice(-5)}`,
            extractOnly: true,
        });
        if (result?.error) throw new Error(result.error);
        const n = result?.applied?.length || 0;

        msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
        ctx.saveChatDebounced?.();
        if (n > 0) await saveCurrentToActiveProfile();

        updateIconState(iconEl, msg);
        if (typeof toastr !== 'undefined') {
            toastr.success(`Memory Agent: ${n} facts stored from msg ${mesId}`, 'BF Memory', { timeOut: 3000 });
        }
    } catch (err) {
        addDebugLog('fail', `Per-msg icon failed for msg ${mesId}: ${err.message || err}`);
        if (typeof toastr !== 'undefined') {
            toastr.error(`Extraction failed: ${err.message}`, 'BF Memory');
        }
    } finally {
        iconEl.classList.remove(ICON_LOADING_CLASS);
    }
}

async function collectFactsForMessage(mesId) {
    const { getAllDatabases, isActiveFact } = await import('./database.js');
    const want = `msg_${mesId}`;
    const dbs = await getAllDatabases();
    const out = [];
    for (const [category, db] of Object.entries(dbs)) {
        for (const fact of (db.facts || [])) {
            if (!isActiveFact(fact)) continue;

            if (fact.source === want || fact.sourceMsg === want) out.push({ category, fact });
        }
    }
    return out;
}

async function showMessageFacts(mesId) {
    const ok = await ensurePopup();
    if (!ok || !_Popup) {
        if (typeof toastr !== 'undefined') toastr.info('Popup API unavailable on this build.', 'BF Memory');
        return;
    }
    const rows = await collectFactsForMessage(mesId);

    const body = rows.length === 0
        ? '<div class="bf-mem-summary-empty">No stored facts came from this message. Shift+click the brain icon to (re-)run extraction.</div>'
        : rows.map(({ category, fact }) => {
            const val = String(fact.value ?? '').trim();
            const note = (typeof fact.context === 'string' && fact.context.trim()) ? fact.context.trim() : '';
            const shown = val || note;
            return `<div class="bf-mem-fact-item" data-cat="${escapeHtmlMsg(category)}" data-key="${escapeHtmlMsg(fact.key)}" style="display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                <span style="flex:1;min-width:0;"><span class="bf-mem-category">${escapeHtmlMsg(category)}</span> <strong>${escapeHtmlMsg(fact.key)}</strong>${shown ? ` = ${escapeHtmlMsg(shown.slice(0, 160))}` : ''}</span>
                <button class="bf-mem-msgfact-del menu_button" data-cat="${escapeHtmlMsg(category)}" data-key="${escapeHtmlMsg(fact.key)}" title="Delete this fact">✕</button>
            </div>`;
        }).join('');

    const html = `<div class="bf-mem-msgfacts" data-mesid="${mesId}">
        <h3>Facts from message #${mesId} <span style="opacity:0.6;font-weight:normal;">(${rows.length})</span></h3>
        <p style="opacity:0.7;font-size:0.9em;margin:2px 0 8px;">What the Scribe learned from this line. Delete anything wrong. Shift+click the brain icon to re-extract.</p>
        <div class="bf-mem-msgfacts-list">${body}</div>
    </div>`;

    const popup = new _Popup(html, _POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, allowVerticalScrolling: true });
    const shown = popup.show();
    const root = popup.dlg || popup.content || document;

    root.querySelector?.('.bf-mem-msgfacts-list')?.addEventListener('click', async (ev) => {
        const btn = ev.target.closest('.bf-mem-msgfact-del');
        if (!btn) return;
        const category = btn.getAttribute('data-cat');
        const key = btn.getAttribute('data-key');
        if (!category || !key) return;
        btn.disabled = true;
        try {
            const { getAllDatabases, removeFact, saveDatabase } = await import('./database.js');
            const dbs = await getAllDatabases();
            const db = dbs[category];
            if (db) { removeFact(db, key); await saveDatabase(db); }

            const row = btn.closest('.bf-mem-fact-item');
            if (row) row.remove();
            addDebugLog('info', `Per-msg viewer: deleted ${category}/${key} (from msg ${mesId})`, {
                subsystem: 'settings', event: 'fact.deleted', actor: 'USER', data: { category, key, mesId },
            });
            if (typeof toastr !== 'undefined') toastr.success(`Deleted ${category}/${key}`, 'BF Memory', { timeOut: 2000 });
        } catch (err) {
            btn.disabled = false;
            addDebugLog('fail', `Per-msg viewer delete failed for ${category}/${key}: ${err.message || err}`);
            if (typeof toastr !== 'undefined') toastr.error(`Delete failed: ${err.message || err}`, 'BF Memory');
        }
    });

    await shown;
}

function injectAllIcons() {
    document.querySelectorAll('.mes[mesid]').forEach(el => injectIcon(el));
}

export function initMessageIcons() {
    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes } = ctx;

    if (!eventSource || !eventTypes) {
        console.warn('[BFMemory] No eventSource; per-message icons disabled');
        return;
    }

    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        injectIcon(el);
    });
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        injectIcon(el);
    });
    eventSource.on(eventTypes.MESSAGE_UPDATED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);

        const msg = ctx.chat?.[mesId];
        if (msg?.extra?.bf_mem_processed) {
            msg.extra.bf_mem_processed = false;
            ctx.saveChatDebounced?.();
        }
        injectIcon(el);
    });

    eventSource.on(eventTypes.MESSAGE_SWIPED, (mesId) => {
        const liveCtx = SillyTavern.getContext();
        const idx = Number.isInteger(mesId)
            ? mesId
            : (Array.isArray(liveCtx?.chat) ? liveCtx.chat.length - 1 : -1);
        const el = document.querySelector(`.mes[mesid="${idx}"]`);
        injectIcon(el); 
    });

    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        setTimeout(() => {
            document.querySelectorAll(`.${ICON_CLASS}`).forEach(el => el.remove());
            injectAllIcons();
        }, 50);
    });

    eventSource.on(eventTypes.CHAT_CHANGED, () => {

        setTimeout(injectAllIcons, 100);
    });

    setTimeout(injectAllIcons, 500);
}
