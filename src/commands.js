import { getSettings, setPipelineEnabled, addDebugLog, saveCurrentToActiveProfile } from './settings.js';
import { ensurePopup, Popup, POPUP_TYPE, escapeHtml } from './ui-util.js';
import { getMemorySheetText } from './turn-state.js';

const MACRO_FACT_CAP = 40;        
const MACRO_VALUE_CHARS = 120;    

function ctx() {
    try { return (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null; } catch { return null; }
}

function toast(level, msg, title = 'BF Memory') {
    try { if (typeof toastr !== 'undefined' && toastr[level]) toastr[level](msg, title); } catch {  }
}

function actionToggle(target) {
    const s = getSettings();
    const cur = !!(s && s.enabled);
    const next = target === 'on' ? true : target === 'off' ? false : !cur;
    setPipelineEnabled(next);
    const msg = `BF Memory ${next ? 'enabled' : 'disabled'}`;
    toast('info', msg);
    return msg;
}

async function actionStatus() {
    const s = getSettings() || {};
    let factCount = 0;
    try {
        const { getAllDatabases } = await import('./database.js');
        const dbs = await getAllDatabases();
        factCount = Object.values(dbs).reduce((n, db) => n + ((db.facts || []).length), 0);
    } catch {  }
    const msg = `BF Memory: ${s.enabled ? 'ON' : 'OFF'} · ${factCount} fact(s) stored`;
    toast('info', msg);
    return msg;
}

async function actionRecall(query) {
    const q = String(query || '').trim();
    if (!q) { toast('warning', 'Usage: /bfmem recall <query>'); return ''; }
    try {
        const { searchMemoryForRecall } = await import('./fact-retrieval.js');
        const { text, count } = await searchMemoryForRecall({ query: q });
        addDebugLog('info', `Slash recall "${q.slice(0, 60)}" → ${count} fact(s)`, { subsystem: 'settings', event: 'slash.recall', actor: 'USER', data: { query: q.slice(0, 120), count } });
        return text || '(no matching facts)';
    } catch (e) {
        addDebugLog('fail', `Slash recall failed: ${e?.message || e}`);
        return '(memory search failed)';
    }
}

async function buildFactList(limit) {
    const cap = Math.max(1, Math.min(MACRO_FACT_CAP * 4, Number(limit) || 20));
    try {
        const { getAllDatabases, isActiveFact, isColdFact } = await import('./database.js');
        const dbs = await getAllDatabases();
        const lines = [];
        for (const [category, db] of Object.entries(dbs)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact) || isColdFact(fact)) continue; 
                const val = String(fact.value ?? '').trim().slice(0, MACRO_VALUE_CHARS);
                lines.push(`${category}/${fact.key}${val ? ` = ${val}` : ''}`);
                if (lines.length >= cap) break;
            }
            if (lines.length >= cap) break;
        }
        return lines;
    } catch {
        return [];
    }
}

async function actionFacts(n) {
    const lines = await buildFactList(n);
    if (lines.length === 0) { toast('info', 'No stored facts yet.'); return ''; }
    return lines.join('\n');
}

async function actionCatchup(rest) {
    const arg = String(rest || '').trim().toLowerCase();
    try {
        const { runCatchupImport, cancelCatchupImport, isCatchupRunning } = await import('./catchup-import.js');
        if (arg === 'cancel') {
            const wasRunning = cancelCatchupImport();
            const msg = wasRunning
                ? 'Catch-up import cancelling (stops after the current chunk)…'
                : 'No catch-up import is running.';
            toast('info', msg);
            return msg;
        }
        if (isCatchupRunning()) {
            const msg = 'A catch-up import is already running (/bfmem catchup cancel to stop it).';
            toast('warning', msg);
            return msg;
        }
        const batchOverride = /^\d+$/.test(arg) ? parseInt(arg, 10) : undefined;
        toast('info', 'Catch-up import started — progress in the Database tab / toasts.');
        const result = await runCatchupImport({
            batchSize: batchOverride,
            onProgress: ({ chunk, chunks, msgsDone, msgsTotal, factsAdded }) => {

                if (chunk === chunks || chunk % 5 === 0) {
                    toast('info', `Catch-up: chunk ${chunk}/${chunks} · ${msgsDone}/${msgsTotal} msgs · ${factsAdded} facts`);
                }
            },
        });
        if (result.refused) return `catch-up refused: ${result.refused}`;
        const verb = result.cancelled ? 'cancelled' : result.aborted ? 'stopped' : 'done';
        const msg = `catch-up ${verb}: ${result.processedChunks}/${result.chunks} chunks, ${result.msgsDone} msgs, ${result.factsAdded} facts${result.failedChunks ? ` (${result.failedChunks} chunk(s) failed — re-run to retry)` : ''}`;
        toast(result.failedChunks ? 'warning' : 'success', msg);
        return msg;
    } catch (e) {
        addDebugLog('fail', `Slash catchup failed: ${e?.message || e}`);
        return '(catch-up import failed)';
    }
}

// ---- Memory sheet: parse the composed sheet text into structured sections ----

const SHEET_STATE_PREFIX = 'CURRENT STATE';
const SHEET_CHRONO_PREFIX = 'CHRONOLOGY';

// Escape, then apply a minimal, safe subset of markdown (bold / italic / code /
// line breaks). Runs AFTER escapeHtml so no raw markup can slip through.
function sheetMarkdown(s) {
    let h = escapeHtml(String(s || ''));
    h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
    h = h.replace(/\n/g, '<br>');
    return h;
}

function humanizeKey(key) {
    return String(key || '').replace(/_/g, ' ').trim();
}

// One fact line: "[known] Category/key = value" | "[known] Category/key: note" | "[known] Category/key"
function parseFactLine(line) {
    const km = /^\[([^\]]*)\]\s*(.*)$/.exec(line);
    const knownBy = km ? km[1].trim() : '';
    const rest = (km ? km[2] : line).trim();

    let ref = rest, detail = '';
    const eq = rest.indexOf(' = ');
    const colon = rest.search(/:\s/);
    if (eq !== -1) { ref = rest.slice(0, eq).trim(); detail = rest.slice(eq + 3).trim(); }
    else if (colon !== -1) { ref = rest.slice(0, colon).trim(); detail = rest.slice(colon + 1).trim(); }

    let category = '', key = ref;
    const slash = ref.indexOf('/');
    if (slash !== -1) { category = ref.slice(0, slash).trim(); key = ref.slice(slash + 1).trim(); }
    return { knownBy, category, key, ref, detail, raw: line };
}

function parseSheetText(text) {
    const out = { summary: '', rightNow: '', scene: '', sceneBeats: [], timeline: '', present: '', notes: '', precedence: '', sections: [] };
    let cur = null;
    let inScene = false; // collecting the stacked one-line beats under a Scene header
    const startSection = (label) => { cur = { label, facts: [] }; out.sections.push(cur); inScene = false; };

    for (const raw of String(text || '').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (!line.trim()) continue;
        if (line.startsWith('[MEMORY SHEET')) continue;
        if (line.startsWith('[Memory precedence')) { out.precedence = line.replace(/^\[|\]$/g, ''); continue; }

        let m;
        if ((m = /^Story so far:\s*(.*)$/i.exec(line))) { out.summary = m[1]; cur = null; inScene = false; continue; }
        if ((m = /^Right now:\s*(.*)$/i.exec(line))) { out.rightNow = m[1]; cur = null; inScene = false; continue; }
        if ((m = /^Scene:\s*(.*)$/i.exec(line))) { out.scene = m[1]; cur = null; inScene = true; continue; }
        if ((m = /^Timeline & place:\s*(.*)$/i.exec(line))) { out.timeline = m[1]; cur = null; inScene = false; continue; }
        if ((m = /^Present:\s*(.*)$/i.exec(line))) { out.present = m[1]; cur = null; inScene = false; continue; }
        if ((m = /^Notes:\s*(.*)$/i.exec(line))) { out.notes = m[1]; cur = null; inScene = false; continue; }
        if (line.startsWith(SHEET_STATE_PREFIX)) { startSection('Current state'); continue; }
        if (line.startsWith(SHEET_CHRONO_PREFIX)) { startSection('Chronology'); continue; }
        if (/^Connected memories:/i.test(line)) { startSection('Connected memories'); continue; }

        if (line.startsWith('[')) {
            inScene = false;
            if (!cur) startSection('Memories');
            cur.facts.push(parseFactLine(line));
            continue;
        }
        // Under a Scene header, plain lines are the stacked beats of the scene card.
        if (inScene) { out.sceneBeats.push(line); continue; }
        // Unrecognised line: treat as a continuation of the summary if we are not in a section.
        if (cur) cur.facts.push({ knownBy: '', category: '', key: '', ref: line, detail: line, raw: line });
        else out.summary += (out.summary ? ' ' : '') + line;
    }
    return out;
}

function renderFact(f) {
    const title = f.key ? humanizeKey(f.key) : (f.ref || f.raw);
    const detail = String(f.detail || f.ref || '').trim();
    const preview = detail.length > 70 ? detail.slice(0, 70).trim() + '…' : detail;

    const tags = [];
    if (f.category) tags.push('<span class="bf-mem-fact-tag">' + escapeHtml(f.category) + '</span>');
    if (f.knownBy && f.knownBy.toLowerCase() !== 'everyone') {
        tags.push('<span class="bf-mem-fact-tag bf-mem-fact-secret"><i class="fa-solid fa-lock"></i> ' + escapeHtml(f.knownBy) + '</span>');
    }

    // Edit/Delete are offered only for facts we can trace back to a real stored
    // record (i.e. the sheet line carried a "Category/key" ref). Free-text
    // continuation lines have no key, so they get no controls.
    const editable = !!(f.category && f.key);
    const actions = editable
        ? '<div class="bf-mem-fact-actions" data-cat="' + escapeHtml(f.category) + '" data-key="' + escapeHtml(f.key) + '">'
        +   '<button type="button" class="bf-mem-fact-btn bf-mem-fact-edit"><i class="fa-solid fa-pen"></i> Edit</button>'
        +   '<button type="button" class="bf-mem-fact-btn bf-mem-fact-del"><i class="fa-solid fa-trash"></i> Delete</button>'
        + '</div>'
        : '';

    return '<details class="bf-mem-fact">'
        + '<summary class="bf-mem-fact-sum">'
        +   '<span class="bf-mem-fact-key">' + escapeHtml(title) + '</span>'
        +   (preview ? '<span class="bf-mem-fact-preview">' + escapeHtml(preview) + '</span>' : '')
        + '</summary>'
        + '<div class="bf-mem-fact-body">'
        +   '<div class="bf-mem-fact-detail">' + sheetMarkdown(detail || '(no value)') + '</div>'
        +   (tags.length ? '<div class="bf-mem-fact-tags">' + tags.join('') + '</div>' : '')
        +   (f.ref ? '<div class="bf-mem-fact-ref">' + escapeHtml(f.ref) + '</div>' : '')
        +   actions
        + '</div>'
        + '</details>';
}

// Render one REAL stored fact (from database.js) with the exact same expandable
// <details> UI the Memory Sheet popup uses — key + preview in the summary,
// value/note, tags, ref and Edit/Delete controls in the body. Used by the
// per-message brain-icon popup so both viewers look and behave identically.
export function renderStoredFactHtml(category, fact) {
    const val = String(fact?.value ?? '').trim();
    const note = String(fact?.context ?? '').trim();
    const detail = val && note ? `${val}\n*${note}*` : (val || note);
    const knownBy = Array.isArray(fact?.knownBy) ? fact.knownBy.join(', ') : String(fact?.knownBy || '');
    const key = String(fact?.key || '').trim();
    return renderFact({
        knownBy,
        category: String(category || '').trim(),
        key,
        ref: `${String(category || '').trim()}/${key}`,
        detail,
        raw: '',
    });
}

function renderSheetHtml(text) {
    const s = parseSheetText(text);
    const p = [];
    p.push('<div class="bf-mem-sheet-pop">');
    p.push('<div class="bf-mem-sheet-title"><i class="fa-solid fa-file-lines"></i> BF Memory Sheet</div>');

    if (s.scene || s.sceneBeats.length || s.timeline || s.present) {
        p.push('<div class="bf-mem-sheet-meta">');
        if (s.scene || s.sceneBeats.length) {
            let sceneVal = s.scene ? sheetMarkdown(s.scene) : '';
            if (s.sceneBeats.length) {
                sceneVal += '<ul class="bf-mem-sheet-beats">'
                    + s.sceneBeats.map(b => '<li>' + sheetMarkdown(b) + '</li>').join('')
                    + '</ul>';
            }
            p.push('<div class="bf-mem-sheet-card"><div class="bf-mem-sheet-label"><i class="fa-solid fa-location-dot"></i> Scene</div><div class="bf-mem-sheet-val">' + sceneVal + '</div></div>');
        }
        if (s.timeline) p.push('<div class="bf-mem-sheet-card"><div class="bf-mem-sheet-label"><i class="fa-solid fa-clock"></i> Timeline &amp; place</div><div class="bf-mem-sheet-val">' + sheetMarkdown(s.timeline) + '</div></div>');
        if (s.present) p.push('<div class="bf-mem-sheet-card"><div class="bf-mem-sheet-label"><i class="fa-solid fa-users"></i> Present</div><div class="bf-mem-sheet-val">' + sheetMarkdown(s.present) + '</div></div>');
        p.push('</div>');
    }

    if (s.summary) {
        p.push('<div class="bf-mem-sheet-card bf-mem-sheet-summary">'
            + '<div class="bf-mem-sheet-label"><i class="fa-solid fa-book"></i> Story so far</div>'
            + '<div class="bf-mem-sheet-val">' + sheetMarkdown(s.summary) + '</div></div>');
    }

    for (const sec of s.sections) {
        if (!sec.facts.length) continue;
        p.push('<div class="bf-mem-sheet-section">');
        p.push('<div class="bf-mem-sheet-section-head">' + escapeHtml(sec.label)
            + ' <span class="bf-mem-sheet-count">' + sec.facts.length + '</span></div>');
        for (const f of sec.facts) p.push(renderFact(f));
        p.push('</div>');
    }

    if (s.notes) {
        p.push('<div class="bf-mem-sheet-card bf-mem-sheet-notes">'
            + '<div class="bf-mem-sheet-label"><i class="fa-solid fa-lightbulb"></i> Notes</div>'
            + '<div class="bf-mem-sheet-val">' + sheetMarkdown(s.notes) + '</div></div>');
    }

    p.push('</div>');
    return p.join('');
}

// ---- Memory sheet popup: per-fact edit / delete, operating on the real store ----

// Resolve the DB + the actual stored fact for a sheet row's Category/key ref.
// findFactMatch may resolve a fuzzy/aliased key, so we always act on fact.key
// (never the raw ref) when mutating.
async function resolveStoredFact(category, key) {
    const { getAllDatabases, findFactMatch, mapLegacyCategory } = await import('./database.js');
    const cat = mapLegacyCategory(String(category || '').trim() || 'Unsorted');
    const dbs = await getAllDatabases();
    const db = dbs[cat] || null;
    const fact = db ? findFactMatch(db, String(key || '').trim()) : null;
    return { cat, db, fact };
}

// Mirror an IDB write into the active per-chat profile so a chat-switch
// autoload doesn't resurrect the old state from settings.json (IDB-only writes
// are wiped and reloaded from the profile). Same helper the pipeline runs
// after a committed memory run.
async function mirrorToActiveProfile(what) {
    try {
        await saveCurrentToActiveProfile();
    } catch (err) {
        addDebugLog('fail', `Sheet popup: failed to mirror ${what} to active profile: ${err?.message || err}`);
    }
}

async function deleteSheetFact(factEl, btn, category, key) {
    // Two-step confirm on the button itself — no nested modal.
    if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.classList.add('bf-mem-fact-btn-danger');
        btn.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> Confirm';
        clearTimeout(btn._disarm);
        btn._disarm = setTimeout(() => {
            btn.dataset.armed = '';
            btn.classList.remove('bf-mem-fact-btn-danger');
            btn.innerHTML = '<i class="fa-solid fa-trash"></i> Delete';
        }, 3500);
        return;
    }
    clearTimeout(btn._disarm);
    try {
        const { saveDatabase, removeFact } = await import('./database.js');
        const { cat, db, fact } = await resolveStoredFact(category, key);
        if (!db) { toast('warning', `Category "${category}" not in store`); return; }
        removeFact(db, fact ? fact.key : key);
        await saveDatabase(db);
        await mirrorToActiveProfile(`delete of ${cat}/${fact ? fact.key : key}`);
        factEl.remove();
        addDebugLog('info', `Sheet popup: deleted fact ${cat}/${fact ? fact.key : key}`, {
            subsystem: 'settings', event: 'sheet.fact.delete', actor: 'USER', data: { category: cat, key: fact ? fact.key : key },
        });
        toast('success', `Deleted "${key}" from the store — the sheet refreshes next turn.`);
    } catch (err) {
        toast('error', `Delete failed: ${err?.message || err}`);
    }
}

async function editSheetFact(factEl, category, key) {
    const body = factEl.querySelector('.bf-mem-fact-body');
    if (!body || body.querySelector('.bf-mem-fact-edit-box')) return; // already editing

    let curVal = '', curNote = '';
    try {
        const { fact } = await resolveStoredFact(category, key);
        if (!fact) { toast('warning', `"${key}" is no longer in the store.`); return; }
        curVal = String(fact.value ?? '');
        curNote = String(fact.context ?? '');   // the "note" is stored in context
    } catch (err) {
        toast('error', `Could not load fact: ${err?.message || err}`);
        return;
    }

    const detailEl = body.querySelector('.bf-mem-fact-detail');
    const actionsEl = body.querySelector('.bf-mem-fact-actions');
    if (actionsEl) actionsEl.style.display = 'none';

    const box = document.createElement('div');
    box.className = 'bf-mem-fact-edit-box';
    box.innerHTML = '<label class="bf-mem-edit-label">Value</label>'
        + '<textarea class="bf-mem-fact-edit-input bf-edit-value" rows="2"></textarea>'
        + '<label class="bf-mem-edit-label">Note <span class="bf-mem-edit-hint">(optional)</span></label>'
        + '<textarea class="bf-mem-fact-edit-input bf-edit-note" rows="2"></textarea>'
        + '<div class="bf-mem-fact-edit-actions">'
        +   '<button type="button" class="bf-mem-fact-btn bf-mem-fact-save"><i class="fa-solid fa-check"></i> Save</button>'
        +   '<button type="button" class="bf-mem-fact-btn bf-mem-fact-cancel">Cancel</button>'
        + '</div>';
    const valTa = box.querySelector('.bf-edit-value');
    const noteTa = box.querySelector('.bf-edit-note');
    valTa.value = curVal;
    noteTa.value = curNote;
    body.appendChild(box);
    valTa.focus();
    valTa.setSelectionRange(valTa.value.length, valTa.value.length);

    const cleanup = () => { box.remove(); if (actionsEl) actionsEl.style.display = ''; };

    box.querySelector('.bf-mem-fact-cancel').addEventListener('click', (ev) => {
        ev.preventDefault(); ev.stopPropagation(); cleanup();
    });
    box.querySelector('.bf-mem-fact-save').addEventListener('click', async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        const newVal = valTa.value.trim();
        const newNote = noteTa.value.trim();
        if (!newVal) { toast('warning', 'Value cannot be empty — use Delete to remove the fact.'); return; }
        try {
            const { saveDatabase } = await import('./database.js');
            const { cat, db, fact } = await resolveStoredFact(category, key);
            if (!db || !fact) { toast('warning', `"${key}" is no longer in the store.`); cleanup(); return; }
            let changed = false;
            if (newVal !== String(fact.value ?? '')) { fact.value = newVal; changed = true; }
            if (newNote !== String(fact.context ?? '')) {
                if (newNote) fact.context = newNote; else delete fact.context;
                changed = true;
            }
            if (changed) {
                fact.lastUpdated = Date.now();
                await saveDatabase(db);
                await mirrorToActiveProfile(`edit of ${cat}/${fact.key}`);
                addDebugLog('info', `Sheet popup: edited fact ${cat}/${fact.key}`, {
                    subsystem: 'settings', event: 'sheet.fact.edit', actor: 'USER', data: { category: cat, key: fact.key },
                });
            }
            const shown = newVal || newNote || '(no value)';
            if (detailEl) detailEl.innerHTML = sheetMarkdown(shown);
            const preview = factEl.querySelector('.bf-mem-fact-preview');
            if (preview) preview.textContent = shown.length > 70 ? shown.slice(0, 70).trim() + '…' : shown;
            toast('success', `Updated "${fact.key}" — the sheet refreshes next turn.`);
            cleanup();
        } catch (err) {
            toast('error', `Save failed: ${err?.message || err}`);
        }
    });
}

// One delegated handler for every Edit/Delete button inside the sheet popup.
// Capture phase so we run before the <details> toggles. Exported so the
// per-message brain-icon popup can reuse it for its identical fact rows.
export function onSheetPopupClick(e) {
    const editBtn = e.target.closest?.('.bf-mem-fact-edit');
    const delBtn = e.target.closest?.('.bf-mem-fact-del');
    const btn = editBtn || delBtn;
    if (!btn || !btn.closest('.bf-mem-sheet-pop')) return;
    e.preventDefault(); e.stopPropagation();
    const actions = btn.closest('.bf-mem-fact-actions');
    const factEl = btn.closest('.bf-mem-fact');
    const category = actions?.getAttribute('data-cat') || '';
    const key = actions?.getAttribute('data-key') || '';
    if (!factEl || !category || !key) return;
    if (editBtn) editSheetFact(factEl, category, key);
    else deleteSheetFact(factEl, btn, category, key);
}

async function showMemorySheetPopup() {
    try { await ensurePopup?.(); } catch {  }
    const text = String(getMemorySheetText() || '').trim();
    const html = text
        ? renderSheetHtml(text)
        : '<div class="bf-mem-sheet-pop"><div class="bf-mem-sheet-title"><i class="fa-solid fa-file-lines"></i> BF Memory Sheet</div>'
          + '<div class="bf-mem-summary-empty">No memory sheet yet. It is rebuilt in the background after each reply.</div></div>';
    document.addEventListener('click', onSheetPopupClick, true);
    try {
        await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' }).show();
    } finally {
        document.removeEventListener('click', onSheetPopupClick, true);
    }
}

function addSheetWandMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById('bf_mem_sheet_menu_item')) return true;
    const item = document.createElement('div');
    item.id = 'bf_mem_sheet_menu_item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-file-lines extensionsMenuExtensionButton"></div><span>BF Memory Sheet</span>';
    item.addEventListener('click', () => { try { document.getElementById('extensionsMenu')?.classList.remove('open'); } catch {  } showMemorySheetPopup(); });
    menu.appendChild(item);
    return true;
}

function initSheetWandMenuItem() {
    let attempts = 0;
    const tryAdd = () => {
        attempts += 1;
        try { if (addSheetWandMenuItem()) return; } catch {  }
        if (attempts < 10) setTimeout(tryAdd, 500);
    };
    tryAdd();
}

function registerMacro(context) {
    try {

        const PLACEHOLDER = '(facts loading…)';
        let cache = PLACEHOLDER;
        let seeded = false;
        const refresh = () => {
            buildFactList(MACRO_FACT_CAP)
                .then(l => { cache = l.join('\n'); seeded = true; })
                .catch(() => { seeded = true; }); 
        };
        refresh();

        const getter = () => { refresh(); return seeded ? cache : PLACEHOLDER; };

        try {
            const m = context.macros;
            const registerFn = typeof m?.register === 'function' ? m.register.bind(m)
                : (typeof m?.registry?.registerMacro === 'function' ? m.registry.registerMacro.bind(m.registry) : null);
            if (registerFn) {
                const def = registerFn('bf_facts', {
                    description: 'The facts BF Memory Pipeline has stored for the current character (compact list).',
                    handler: getter,
                });
                if (def) {
                    addDebugLog('info', '{{bf_facts}} macro registered (macros.register API)');
                    return true;
                }
                addDebugLog('info', 'macros.register returned null, falling back to legacy APIs');
            }
        } catch (e) {
            addDebugLog('info', `macros.register registration failed, falling back: ${e?.message || e}`);
        }
        if (typeof context.registerMacro === 'function') {
            context.registerMacro('bf_facts', getter);
            return true;
        }

        if (context.MacrosParser && typeof context.MacrosParser.registerMacro === 'function') {
            context.MacrosParser.registerMacro('bf_facts', getter);
            return true;
        }
    } catch (e) {
        addDebugLog('info', `{{bf_facts}} macro registration skipped: ${e?.message || e}`);
    }
    return false;
}

async function dispatch(sub, rest) {
    switch (String(sub || '').trim().toLowerCase()) {
        case 'on': return actionToggle('on');
        case 'off': return actionToggle('off');
        case 'toggle': case '': return actionToggle('toggle');
        case 'status': return await actionStatus();
        case 'recall': return await actionRecall(rest);
        case 'facts': return await actionFacts(rest);
        case 'catchup': return await actionCatchup(rest);
        default:
            toast('info', 'Usage: /bfmem on|off|toggle|status|recall <query>|facts [N]|catchup [N|cancel]');
            return '';
    }
}

export function initCommands() {
    const context = ctx();
    if (!context) return;

    registerMacro(context);
    initSheetWandMenuItem();

    try {
        const SCP = context.SlashCommandParser;
        const SC = context.SlashCommand;
        const SCA = context.SlashCommandArgument;
        const ARG = context.ARGUMENT_TYPE || (SCA && SCA.ARGUMENT_TYPE);
        if (SCP && SC && typeof SC.fromProps === 'function' && typeof SCP.addCommandObject === 'function') {
            const unnamedArgs = [];
            if (SCA && typeof SCA.fromProps === 'function') {
                unnamedArgs.push(SCA.fromProps({
                    description: 'subcommand: on | off | toggle | status | recall | facts | catchup',
                    typeList: ARG ? [ARG.STRING] : undefined,
                    isRequired: false,
                }));
                unnamedArgs.push(SCA.fromProps({
                    description: 'argument (recall query, or fact count)',
                    typeList: ARG ? [ARG.STRING] : undefined,
                    isRequired: false,
                }));
            }
            SCP.addCommandObject(SC.fromProps({
                name: 'bfmem',
                helpString: 'BF Memory control: <code>/bfmem on|off|toggle|status|recall &lt;query&gt;|facts [N]|catchup [N|cancel]</code>.',
                unnamedArgumentList: unnamedArgs,
                callback: async (_namedArgs, unnamed) => {

                    const parts = Array.isArray(unnamed) ? unnamed : [unnamed];
                    const sub = parts[0] || '';
                    const rest = parts.slice(1).join(' ').trim();
                    return await dispatch(sub, rest);
                },
            }));
            addDebugLog('info', 'Registered /bfmem slash command (modern API)', { subsystem: 'settings', event: 'slash.registered', data: { api: 'SlashCommandParser' } });
            return;
        }
    } catch (e) {
        addDebugLog('info', `Modern slash registration failed, trying legacy: ${e?.message || e}`);
    }

    try {
        if (typeof context.registerSlashCommand === 'function') {
            context.registerSlashCommand('bfmem', async (_args, value) => {
                const str = String(value || '').trim();
                const sp = str.indexOf(' ');
                const sub = sp >= 0 ? str.slice(0, sp) : str;
                const rest = sp >= 0 ? str.slice(sp + 1).trim() : '';
                return await dispatch(sub, rest);
            }, [], 'BF Memory: /bfmem on|off|toggle|status|recall <query>|facts [N]|catchup [N|cancel]', true, true);
            addDebugLog('info', 'Registered /bfmem slash command (legacy API)', { subsystem: 'settings', event: 'slash.registered', data: { api: 'registerSlashCommand' } });
        }
    } catch (e) {
        addDebugLog('info', `/bfmem slash command unavailable on this ST build: ${e?.message || e}`);
    }
}
