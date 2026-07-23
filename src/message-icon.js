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
        ? 'The Memory Agent processed this message. Click to see the memories it stored · Shift+click to re-extract.'
        : 'The Memory Agent has NOT processed this message yet. Click to see memories (none yet) · Shift+click to extract (makes an AI call).';
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
        updateCatchupBadge();
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
    // Prefer the stable per-message id (survives deletes/branches); fall back to
    // the legacy positional `source` for facts written before srcId existed.
    let wantUid = '';
    try { wantUid = SillyTavern.getContext()?.chat?.[mesId]?.extra?.bf_uid || ''; } catch {  }
    const dbs = await getAllDatabases();
    const out = [];
    for (const [category, db] of Object.entries(dbs)) {
        for (const fact of (db.facts || [])) {
            if (!isActiveFact(fact)) continue;

            if ((wantUid && fact.srcId === wantUid) || fact.source === want) out.push({ category, fact });
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
    // Same renderer + Edit/Delete handler the Memory Sheet popup uses, so the
    // per-message view is the identical expandable fact list.
    const { renderStoredFactHtml, onSheetPopupClick } = await import('./commands.js');
    const rows = await collectFactsForMessage(mesId);

    let body;
    if (rows.length === 0) {
        body = '<div class="bf-mem-summary-empty">No stored memories came from this message. Shift+click the brain icon to (re-)run extraction.</div>';
    } else {
        // Group into per-category sections like the sheet popup does.
        const byCat = new Map();
        for (const { category, fact } of rows) {
            if (!byCat.has(category)) byCat.set(category, []);
            byCat.get(category).push(fact);
        }
        const parts = [];
        for (const [category, facts] of byCat) {
            parts.push('<div class="bf-mem-sheet-section">');
            parts.push(`<div class="bf-mem-sheet-section-head">${escapeHtmlMsg(category)} <span class="bf-mem-sheet-count">${facts.length}</span></div>`);
            for (const fact of facts) parts.push(renderStoredFactHtml(category, fact));
            parts.push('</div>');
        }
        body = parts.join('');
    }

    // The bf-mem-sheet-pop wrapper is what scopes onSheetPopupClick and pulls
    // in the sheet popup's CSS.
    const html = `<div class="bf-mem-sheet-pop bf-mem-msgfacts" data-mesid="${mesId}">
        <div class="bf-mem-sheet-title"><i class="fa-solid fa-brain"></i> Facts from message #${mesId} <span class="bf-mem-sheet-count">${rows.length}</span></div>
        <p style="opacity:0.7;font-size:0.9em;margin:2px 0 8px;">Memories the Memory Agent stored from this message. Expand one to edit or delete it. Shift+click the brain icon to re-extract.</p>
        ${body}
    </div>`;

    const popup = new _Popup(html, _POPUP_TYPE.TEXT, '', { okButton: 'Close', wide: true, allowVerticalScrolling: true });
    document.addEventListener('click', onSheetPopupClick, true);
    try {
        await popup.show();
    } finally {
        document.removeEventListener('click', onSheetPopupClick, true);
    }
}

function injectAllIcons() {
    document.querySelectorAll('.mes[mesid]').forEach(el => injectIcon(el));
    updateCatchupBadge();
}

// Catch-up badge: a small pill above the send form (same anchor as the working
// indicator in pipeline.js) showing how many settled messages the memory
// pipeline has not extracted yet. Visible only while the backlog is non-zero;
// re-checked from every repaint path (watermark commits, renders, deletes,
// chat switches), so it disappears on its own as extraction catches up.
// Dynamic import of pipeline.js: pipeline.js dynamically imports this module,
// so a static back-edge would create an import cycle.
const CATCHUP_BADGE_ID = 'bf_mem_catchup_badge';

function updateCatchupBadge() {
    import('./pipeline.js').then(({ computeCatchupLag }) => {
        const { count } = computeCatchupLag();
        let badge = document.getElementById(CATCHUP_BADGE_ID);
        if (count <= 0) {
            if (badge) badge.style.display = 'none';
            return;
        }
        if (!badge) {
            badge = document.createElement('div');
            badge.id = CATCHUP_BADGE_ID;
            badge.className = 'bf-mem-catchup-badge';
            const sendForm = document.getElementById('send_form');
            if (!sendForm?.parentNode) return;
            sendForm.parentNode.insertBefore(badge, sendForm);
        }
        badge.title = `${count} settled message(s) not yet extracted into memory. The context window is widened so they are never trimmed away; the badge disappears as the pipeline catches up.`;
        badge.innerHTML = `<i class="fa-solid fa-brain"></i> ${count} behind`;
        badge.style.display = '';
    }).catch(() => {  });
}

// Re-read every on-screen message's processed state and repaint its brain icon.
// The pipeline calls this after a background run commits (or clears) the
// watermark, so the green "processed" colour appears immediately instead of
// only after the message next re-renders (scroll/edit/chat reload).
export function refreshMessageIcons() {
    try { injectAllIcons(); } catch {  }
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
        // A new message shifts the settled window — the backlog may have grown.
        updateCatchupBadge();
    });
    eventSource.on(eventTypes.USER_MESSAGE_RENDERED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);
        injectIcon(el);
        updateCatchupBadge();
    });
    eventSource.on(eventTypes.MESSAGE_UPDATED, (mesId) => {
        const el = document.querySelector(`.mes[mesid="${mesId}"]`);

        const msg = ctx.chat?.[mesId];
        if (msg?.extra?.bf_mem_processed) {
            msg.extra.bf_mem_processed = false;
            ctx.saveChatDebounced?.();
        }
        injectIcon(el);
        // The edit cleared the watermark — the message is unprocessed again.
        updateCatchupBadge();
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
