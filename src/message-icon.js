// BF Memory Pipeline - per-message Agent 3 icon
// Adds a brain icon next to each message's edit icon. Green = already processed
// by Agent 3, grey = not yet. Click to force Agent 3 on that specific message.

import { addDebugLog } from './settings.js';
// F-UX-8 dedup: the popup loader + HTML escaper below used to be copy-pasted here and in
// settings.js — both now live in ui-util.js. Aliased to the original local names so the
// function bodies in this file are byte-identical to before the dedup.
import { ensurePopup, Popup as _Popup, POPUP_TYPE as _POPUP_TYPE, escapeHtml as escapeHtmlMsg } from './ui-util.js';

const ICON_CLASS = 'bf_mem_msg_icon';
const ICON_PROCESSED_CLASS = 'bf_mem_msg_icon_processed';
const ICON_LOADING_CLASS = 'bf_mem_msg_icon_loading';

/**
 * Inject the brain icon into a single message's button toolbar.
 * Idempotent — if already injected, just updates the state.
 */
function injectIcon(messageEl) {
    if (!messageEl) return;
    const buttons = messageEl.querySelector('.mes_buttons');
    if (!buttons) return;

    const mesId = parseInt(messageEl.getAttribute('mesid'));
    if (Number.isNaN(mesId)) return;

    const chat = SillyTavern.getContext().chat;
    const msg = chat?.[mesId];
    if (!msg) return;

    // Skip system messages / non-user-non-ai
    if (msg.is_system) return;
    if (msg.extra?.type) return;

    let icon = buttons.querySelector(`.${ICON_CLASS}`);
    if (!icon) {
        icon = document.createElement('div');
        icon.className = `mes_button ${ICON_CLASS} fa-solid fa-brain interactable`;
        icon.setAttribute('tabindex', '0');
        icon.addEventListener('click', (e) => onIconClick(e, mesId));
        // Insert before the existing edit button if present, otherwise prepend
        const editBtn = buttons.querySelector('.mes_edit');
        if (editBtn) {
            buttons.insertBefore(icon, editBtn);
        } else {
            buttons.prepend(icon);
        }
    }

    // Update visual state based on current data
    updateIconState(icon, msg);
}

function updateIconState(iconEl, msg) {
    const processed = !!msg.extra?.bf_mem_processed;
    iconEl.classList.toggle(ICON_PROCESSED_CLASS, processed);
    // C2: plain click now OPENS the per-message fact viewer (see/delete what this line taught);
    // Shift+click forces (re-)extraction. The old behavior (click = extract) was a footgun — a
    // plain click could fire a billable LLM call. The title documents both gestures.
    iconEl.title = processed
        ? 'Scribe processed this message. Click to see the facts it produced · Shift+click to re-extract.'
        : 'Scribe has NOT processed this message. Click to see facts (none yet) · Shift+click to extract (makes an AI call).';
}

/**
 * C2 — INLINE CURATION. Click handler now branches:
 *   - Shift+click (or an unprocessed message with no facts to show) → force (re-)extraction (the
 *     original behavior), so the destructive/billable action is now explicit.
 *   - Plain click → open a small popup listing the facts THIS message produced (matched by the
 *     `source: "msg_<id>"` stamp every fact carries), each with a Delete button. Read-only-ish:
 *     viewing costs nothing; deleting routes through the same removeFact + saveDatabase path the
 *     Database tab uses. Fully guarded — never throws into the UI.
 */
async function onIconClick(e, mesId) {
    e.stopPropagation();
    const ctx = SillyTavern.getContext();
    const msg = ctx.chat?.[mesId];
    if (!msg) return;

    const iconEl = e.currentTarget;
    if (iconEl.classList.contains(ICON_LOADING_CLASS)) return; // prevent double-click

    // Plain click ALWAYS opens the free fact viewer (it handles the zero-facts case with a
    // Shift+click hint). Only Shift+click runs the billable extraction — a plain click on an
    // unprocessed message must never fire an LLM call (audit F-UX-2; the C2 footgun).
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
        // EXTRACT-ONLY Memory Agent session over just this message (redesign-v2 S3). A
        // protocol failure returns result.error and we THROW below, so the watermark is only
        // ever stamped on a successful run (F-SCRIBE-1).
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

        // Mark processed + persist
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

// C2 — the lazy-loaded ST Popup module (ensurePopup/_Popup/_POPUP_TYPE) and escapeHtmlMsg now
// come from ui-util.js (F-UX-8 dedup) — see the aliased import at the top of this file.

/**
 * C2 — collect the facts a given message produced. Every fact stamps `source: "msg_<index>"`
 * (agent-memory.js applyUpdates), so we match active facts whose source index equals this mesId.
 * NOTE: @src:user facts are attributed to the USER message index, so a fact disclosed by the user
 * but extracted on the AI turn is found under the USER message's icon — which is the correct,
 * intuitive home for it. Returns `{category, fact}[]`.
 * @param {number} mesId
 * @returns {Promise<Array<{category:string, fact:Object}>>}
 */
async function collectFactsForMessage(mesId) {
    const { getAllDatabases, isActiveFact } = await import('./database.js');
    const want = `msg_${mesId}`;
    const dbs = await getAllDatabases();
    const out = [];
    for (const [category, db] of Object.entries(dbs)) {
        for (const fact of (db.facts || [])) {
            if (!isActiveFact(fact)) continue;
            // Match on the canonical source stamp, or the equivalent sourceMsg provenance handle.
            if (fact.source === want || fact.sourceMsg === want) out.push({ category, fact });
        }
    }
    return out;
}

/**
 * C2 — show a popup of the facts THIS message produced, each with a Delete button, plus a
 * "Re-extract" action. Deleting routes through removeFact + saveDatabase (the same path the
 * Database tab uses) and re-renders the list live. Best-effort; never throws.
 * @param {number} mesId
 */
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

    // Wire delete buttons (delegated). Each delete re-reads the live store, removes by key, saves,
    // updates the row, and refreshes the icon state if the message now has zero facts.
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
            // Remove the row from the DOM.
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

/**
 * Walk every message in the current chat and inject icons.
 * Called on extension load + on CHAT_CHANGED.
 */
function injectAllIcons() {
    document.querySelectorAll('.mes[mesid]').forEach(el => injectIcon(el));
}

/**
 * Wire ST events so icons appear on newly-rendered + edited messages.
 */
export function initMessageIcons() {
    const ctx = SillyTavern.getContext();
    const { eventSource, eventTypes } = ctx;

    if (!eventSource || !eventTypes) {
        console.warn('[BFMemory] No eventSource; per-message icons disabled');
        return;
    }

    // Per-message render events
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
        // Editing a message invalidates prior extraction — reset the flag.
        const msg = ctx.chat?.[mesId];
        if (msg?.extra?.bf_mem_processed) {
            msg.extra.bf_mem_processed = false;
            ctx.saveChatDebounced?.();
        }
        injectIcon(el);
    });

    // Swipe: the pipeline's MESSAGE_SWIPED handler clears bf_mem_processed on the swiped
    // message (its content was replaced), but without this listener the brain icon never
    // repaints and stays green — so clicking it opens the (now-stale) fact viewer instead
    // of re-extracting. Re-derive the icon state from the live message so green == actually
    // processed. We re-read ctx via getContext() each time so a stale closure-captured chat
    // can't mislead us. Defensive: also handle the case where the flag wasn't cleared yet.
    eventSource.on(eventTypes.MESSAGE_SWIPED, (mesId) => {
        const liveCtx = SillyTavern.getContext();
        const idx = Number.isInteger(mesId)
            ? mesId
            : (Array.isArray(liveCtx?.chat) ? liveCtx.chat.length - 1 : -1);
        const el = document.querySelector(`.mes[mesid="${idx}"]`);
        injectIcon(el); // injectIcon → updateIconState re-derives green from msg.extra.bf_mem_processed
    });

    // Delete: with no listener, the brain icon for a deleted message lingers in the DOM and,
    // because mesid attributes get re-indexed after a delete, can target the wrong message.
    // injectIcon is idempotent and REUSES an existing icon element (it does not re-bind the
    // click handler, which closes over the now-stale mesId). So we first strip every existing
    // brain icon, then re-walk all rendered messages — guaranteeing each icon is freshly
    // re-created with a click handler bound to the correct current mesId. Deferred so ST
    // finishes its own row re-render/re-index first.
    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        setTimeout(() => {
            document.querySelectorAll(`.${ICON_CLASS}`).forEach(el => el.remove());
            injectAllIcons();
        }, 50);
    });

    // Full re-render on chat change (new chat → all messages rendered fresh)
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        // Defer so ST finishes rendering first
        setTimeout(injectAllIcons, 100);
    });

    // Initial injection in case extension loads after chat already rendered
    setTimeout(injectAllIcons, 500);
}
