// BF Memory Pipeline - Database tab UI (F-UX-8 split from settings.js)
// The Database-tab surface: category cards, the per-fact manager (edit/delete/bulk), the
// cross-category search, taxonomy add-label controls + AI label suggestions, the spiderweb and
// graph views, and the recurring-characters panel. The Layer-C dbProfiles write-through helpers
// (pruneActiveProfile / pruneFactFromProfiles / updateFactInProfiles) stay in settings.js —
// it owns the dbProfiles state — and are imported here so every destructive/edit op keeps the
// same 3-layer anti-resurrection guarantee as before the split.
//
// NOTE on cycles: the static import from settings.js below is an intentional ESM cycle; every
// use is inside a function body at CALL time, which ESM resolves via hoisted declarations.

import { addDebugLog } from './debug-log.js';
import { ensurePopup, Popup, POPUP_TYPE, escapeHtml } from './ui-util.js';
import {
    pruneFactFromProfiles, updateFactInProfiles,
} from './settings.js';

// --- Database View ---

export async function refreshDatabaseView() {
    const { getAllDatabases, withSkeleton, MENU_CATEGORY_ORDER } = await import('./database.js');
    const real = await getAllDatabases();
    // 3-layer model: overlay the empty Layer-1 skeleton so the FULL taxonomy (every category,
    // count 0 when empty) is always shown — never "No databases yet". The skeleton is purely
    // in-memory here (no empty files are written; categories persist only when a fact lands).
    // The skeleton already includes user-added overlay categories (effectiveCategories).
    const databases = withSkeleton(real);
    // Stable Layer-1 order first, then any custom extras.
    const ordered = [];
    for (const c of MENU_CATEGORY_ORDER) if (databases[c]) ordered.push(c);
    for (const c of Object.keys(databases)) if (!ordered.includes(c)) ordered.push(c);
    const categories = ordered;

    const statsEl = document.getElementById('bf_mem_db_stats');
    if (!statsEl) return;

    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    statsEl.innerHTML = `<b>${categories.length}</b> databases | <b>${totalFacts}</b> total facts`;
}

// Cap the number of fact rows rendered into the (innerHTML-built) view at once so a 10k-fact
// category can't freeze the UI with a multi-MB DOM write. The user filters or pages past it.
const FACT_VIEW_PAGE_SIZE = 200;

/**
 * Build the HTML for the per-fact rows of the single-category viewer. Re-run on every
 * filter/page change. Each row carries a checkbox (bulk-select), a cold badge when cold,
 * and per-row Edit/Delete buttons. Only the facts in [0, limit) of the FILTERED set render.
 * @param {import('./database.js').FactSchema[]} facts - already filtered + ordered
 * @param {number} limit - max rows to render now (pagination cap)
 * @param {(f) => boolean} isColdFact
 * @param {(f) => string} deriveAspect
 * @returns {string}
 */
function renderFactRows(facts, limit, isColdFact, deriveAspect) {
    const shown = facts.slice(0, limit);
    return shown.map((fact) => {
        const cold = (() => { try { return isColdFact(fact); } catch { return false; } })();
        const aspect = (() => { try { return deriveAspect(fact); } catch { return ''; } })();
        const importance = Number.isFinite(Number(fact.importance)) ? Number(fact.importance) : 3;
        const note = fact.context || '';
        const coldBadge = cold ? ' <span class="bf-mem-custom-chip" title="Cold-tiered: kept but deprioritized by retrieval">cold</span>' : '';
        const superseded = fact.active === false ? ' <span class="bf-mem-custom-chip" title="Superseded (historical)">old</span>' : '';
        // Open-threads feature: make plot-thread state visible/auditable (editable-memory doctrine).
        const threadChip = fact.thread === 'open'
            ? ' <span class="bf-mem-custom-chip" title="Open plot thread: unresolved hook — surfaced in the Big Picture and protected from cold-tiering until resolved">thread: open</span>'
            : (fact.thread === 'resolved' ? ' <span class="bf-mem-custom-chip" title="Plot thread resolved by the maintenance (reflection) pass">thread: resolved</span>' : '');
        // Spiderweb 2: the fact's origin scene (No + name) + source-message provenance.
        const sceneLine = Number.isInteger(fact.sceneNo)
            ? `<div class="bf-mem-fact-source">scene: #${fact.sceneNo}${fact.sceneName ? ` · ${escapeHtml(fact.sceneName)}` : ''}${fact.sourceMsg ? ` · from ${escapeHtml(fact.sourceMsg)}` : ''}</div>`
            : (fact.sourceMsg ? `<div class="bf-mem-fact-source">from ${escapeHtml(fact.sourceMsg)}</div>` : '');
        return `
            <div class="bf-mem-fact-row" data-key="${escapeHtml(fact.key)}" style="border-bottom:1px solid var(--SmartThemeBorderColor,#444);padding:6px 0;">
                <div style="display:flex;gap:8px;align-items:flex-start;">
                    <input type="checkbox" class="bf-mem-fact-check" data-key="${escapeHtml(fact.key)}" style="margin-top:4px;" />
                    <div style="flex:1 1 auto;min-width:0;">
                        <div><b>${escapeHtml(fact.key)}</b>${coldBadge}${superseded}${threadChip}
                            <span class="bf-mem-fact-source"> [${escapeHtml(aspect)} · imp ${importance}]</span></div>
                        <div class="bf-mem-fact-value">${escapeHtml(fact.value)}</div>
                        ${note ? `<div class="bf-mem-fact-source">note: ${escapeHtml(note)}</div>` : ''}
                        ${sceneLine}
                        ${(fact.knownBy || []).length ? `<div class="bf-mem-fact-source">known by: ${escapeHtml((fact.knownBy || []).join(', '))}</div>` : ''}
                        ${(fact.involved || []).length ? `<div class="bf-mem-fact-source">involved: ${escapeHtml((fact.involved || []).join(', '))}</div>` : ''}
                        ${fact.location ? `<div class="bf-mem-fact-source">location: ${escapeHtml(String(fact.location))}</div>` : ''}
                        ${fact.kind ? `<div class="bf-mem-fact-source">kind: ${escapeHtml(String(fact.kind))}</div>` : ''}
                        ${(() => {
                            // SPIDERWEB: surface the fact's connections (primary/secondary/tertiary links to
                            // other facts). These were stored + used for retrieval but never shown — this is
                            // why the viewer looked like "only simple facts".
                            const r = fact.relationships || {};
                            const parts = [];
                            if ((r.primary || []).length) parts.push(`◆ ${escapeHtml((r.primary || []).join(', '))}`);
                            if ((r.secondary || []).length) parts.push(`◇ ${escapeHtml((r.secondary || []).join(', '))}`);
                            if ((r.tertiary || []).length) parts.push(`· ${escapeHtml((r.tertiary || []).join(', '))}`);
                            return parts.length ? `<div class="bf-mem-fact-links">🕸 linked: ${parts.join(' &nbsp; ')}</div>` : '';
                        })()}
                        ${(fact.tags || []).length ? `<div class="bf-mem-fact-source">tags: ${escapeHtml((fact.tags || []).join(', '))}</div>` : ''}
                    </div>
                    <div style="flex:0 0 auto;display:flex;gap:4px;">
                        <button class="bf-mem-fact-edit menu_button" data-key="${escapeHtml(fact.key)}" title="Edit"><i class="fa-solid fa-pen"></i></button>
                        <button class="bf-mem-fact-del menu_button redWarningBG" data-key="${escapeHtml(fact.key)}" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>`;
    }).join('');
}

/**
 * Interactive per-category fact manager: VIEW + FILTER + per-fact EDIT/DELETE + BULK DELETE, with
 * cold-tier badges and a rendered-row cap for huge categories. Every destructive/edit op goes
 * through the 3-layer-safe path (working store via removeFact/saveDatabase, PLUS the dbProfiles
 * snapshot via pruneFactFromProfiles/updateFactInProfiles) so changes can't be resurrected by
 * autoSaveDbProfile on the next CHAT_CHANGED — the same guarantee as the category-delete in
 * commit 4e281b7.
 * @param {string} category
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases - the withSkeleton map
 */
async function viewSingleDatabase(category, databases) {
    const { isColdFact, deriveAspect } = await import('./database.js');
    const db = databases[category];
    if (!db) return;
    await ensurePopup();
    if (!Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    // Working copy of the facts we render (re-read from the live store on every mutation so the
    // list reflects deletes/edits without reopening). filter + page are popup-local UI state.
    let allFacts = [...db.facts];
    let renderLimit = FACT_VIEW_PAGE_SIZE;

    const html = `<div class="bf-mem-db-browser" data-category="${escapeHtml(category)}">
        <h4>${escapeHtml(category)} — <span id="bf_mem_fact_count">${allFacts.length}</span> facts</h4>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
            <input type="text" id="bf_mem_fact_filter" class="text_pole" placeholder="Filter by key / value / note…" style="flex:1 1 180px;min-width:140px;" />
            <label class="checkbox_label" style="flex:0 0 auto;"><input type="checkbox" id="bf_mem_fact_selall" /> <span>Select all (filtered)</span></label>
            <button id="bf_mem_fact_bulkdel" class="menu_button redWarningBG" style="flex:0 0 auto;"><i class="fa-solid fa-trash"></i> Delete selected</button>
        </div>
        <div id="bf_mem_fact_list"></div>
        <div id="bf_mem_fact_more" style="margin-top:8px;text-align:center;"></div>
    </div>`;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    // Show without awaiting so we can wire the live DOM while the popup is open.
    const shownPromise = popup.show();
    const root = popup.dlg || popup.content || document;
    const listEl = root.querySelector('#bf_mem_fact_list');
    const moreEl = root.querySelector('#bf_mem_fact_more');
    const filterEl = root.querySelector('#bf_mem_fact_filter');
    const countEl = root.querySelector('#bf_mem_fact_count');
    const selAllEl = root.querySelector('#bf_mem_fact_selall');

    // Current filtered set (recomputed by applyFilter), used by render + bulk select.
    let filtered = allFacts;

    const applyFilter = () => {
        const q = (filterEl?.value || '').trim().toLowerCase();
        filtered = !q ? allFacts : allFacts.filter(f => {
            const hay = `${f.key || ''} ${f.value || ''} ${f.context || ''} ${(f.tags || []).join(' ')} ${(f.knownBy || []).join(' ')}`.toLowerCase();
            return hay.includes(q);
        });
    };

    const render = () => {
        applyFilter();
        if (countEl) countEl.textContent = `${filtered.length}${filtered.length !== allFacts.length ? ` / ${allFacts.length}` : ''}`;
        if (listEl) listEl.innerHTML = filtered.length
            ? renderFactRows(filtered, renderLimit, isColdFact, deriveAspect)
            : '<div class="bf-mem-empty">No matching facts.</div>';
        if (moreEl) {
            const remaining = Math.max(0, filtered.length - renderLimit);
            moreEl.innerHTML = remaining > 0
                ? `<button id="bf_mem_fact_showmore" class="menu_button">Show more (${remaining} hidden)</button>`
                : '';
        }
        if (selAllEl) selAllEl.checked = false;
        bindRowHandlers();
    };

    // Re-read the live store and refresh, after a mutation. Keeps the popup authoritative.
    const reloadFromStore = async () => {
        const { getAllDatabases } = await import('./database.js');
        const fresh = await getAllDatabases();
        allFacts = [...((fresh[category] && fresh[category].facts) || [])];
        renderLimit = Math.max(FACT_VIEW_PAGE_SIZE, renderLimit); // keep what was paged
        render();
        refreshDatabaseView();
    };

    // Single-fact DELETE through ALL THREE layers (working store + every profile the chat reloads
    // from) so it can't resurrect. Mirrors the category-delete anti-resurrection contract.
    const deleteOne = async (key) => {
        if (!confirm(`Delete fact "${key}" from "${category}"?`)) return;
        const { getAllDatabases, removeFact, saveDatabase, flushSnapshotNow } = await import('./database.js');
        const fresh = await getAllDatabases();
        const liveDb = fresh[category];
        if (!liveDb) return;
        removeFact(liveDb, key);                       // Layer A (IDB) + arms Layer B (attachment)
        await saveDatabase({ ...liveDb, category });
        const { profilesPruned, factsPruned } = pruneFactFromProfiles(category, key); // Layer C
        await flushSnapshotNow();                       // reconcile durable attachment now
        addDebugLog('pass', `Deleted single fact "${key}" from "${category}" (Layer A+B+C)`, {
            subsystem: 'db', event: 'fact.deleted', actor: 'USER', reason: 'USER_DELETE',
            data: { category, key, profilesPruned, factsPrunedFromProfile: factsPruned },
        });
        await reloadFromStore();
    };

    // BULK delete the currently-checked rows (or all filtered when "select all" was used) — one
    // saveDatabase per category, one profile prune per key, one durable flush at the end.
    const deleteSelected = async () => {
        // When "Select all (filtered)" is on, operate on the ENTIRE filtered set — not just the
        // rendered (paginated) rows. The DOM only contains up to `renderLimit` checkboxes, so
        // reading checked DOM rows would silently miss the overflow on large categories.
        const keys = (selAllEl && selAllEl.checked)
            ? filtered.map(f => f.key)
            : [...root.querySelectorAll('.bf-mem-fact-check:checked')].map(c => c.dataset.key);
        if (keys.length === 0) { toastr.info('No facts selected', 'BF Memory'); return; }
        if (!confirm(`Delete ${keys.length} selected fact(s) from "${category}"? This cannot be undone.`)) return;
        const { getAllDatabases, saveDatabase, flushSnapshotNow } = await import('./database.js');
        const fresh = await getAllDatabases();
        const liveDb = fresh[category];
        if (!liveDb) return;
        const keySet = new Set(keys);
        const before = liveDb.facts.length;
        liveDb.facts = liveDb.facts.filter(f => !keySet.has(f.key));   // Layer A
        liveDb.updatedAt = Date.now();
        await saveDatabase({ ...liveDb, category });                   // persist Layer A + arm B
        let profilesTouched = new Set();
        for (const key of keys) {                                      // Layer C, per key
            const { profilesPruned } = pruneFactFromProfiles(category, key);
            profilesPruned.forEach(p => profilesTouched.add(p));
        }
        await flushSnapshotNow();
        addDebugLog('pass', `Bulk-deleted ${before - liveDb.facts.length} fact(s) from "${category}" (Layer A+B+C)`, {
            subsystem: 'db', event: 'fact.bulkDeleted', actor: 'USER', reason: 'USER_BULK_DELETE',
            data: { category, requested: keys.length, removed: before - liveDb.facts.length, profilesPruned: [...profilesTouched] },
        });
        toastr.success(`Deleted ${before - liveDb.facts.length} fact(s)`, 'BF Memory');
        await reloadFromStore();
    };

    // Per-fact EDIT modal: value + note (always) + aspect + importance. Writes through Layer A+B+C.
    const editOne = async (key) => {
        const { getAllDatabases, saveDatabase, deriveAspect: da, flatVocab, flushSnapshotNow } = await import('./database.js');
        const fresh = await getAllDatabases();
        const liveDb = fresh[category];
        const fact = liveDb?.facts.find(f => f.key === key);
        if (!fact) { toastr.warning('Fact no longer exists', 'BF Memory'); await reloadFromStore(); return; }
        const vocab = (() => { try { return flatVocab(category); } catch { return []; } })();
        const curAspect = (() => { try { return da(fact); } catch { return ''; } })();
        const curImp = Number.isFinite(Number(fact.importance)) ? Number(fact.importance) : 3;
        const aspectOptions = vocab.map(a => `<option value="${escapeHtml(a)}"${a === curAspect ? ' selected' : ''}>${escapeHtml(a)}</option>`).join('');
        const impOptions = [1, 2, 3, 4, 5].map(n => `<option value="${n}"${n === curImp ? ' selected' : ''}>${n}</option>`).join('');
        const editHtml = `<div class="bf-mem-db-browser">
            <h4>Edit fact: ${escapeHtml(key)}</h4>
            <div class="bf-mem-field"><label>Value</label>
                <textarea id="bf_mem_edit_value" class="text_pole" rows="3" style="width:100%;">${escapeHtml(fact.value || '')}</textarea></div>
            <div class="bf-mem-field" style="margin-top:6px;"><label>Note (context)</label>
                <textarea id="bf_mem_edit_note" class="text_pole" rows="2" style="width:100%;">${escapeHtml(fact.context || '')}</textarea></div>
            <div class="bf-mem-field" style="margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;">
                <div style="flex:1 1 140px;"><label>Aspect</label>
                    <select id="bf_mem_edit_aspect" class="text_pole" style="width:100%;">${aspectOptions || `<option value="${escapeHtml(curAspect)}" selected>${escapeHtml(curAspect)}</option>`}</select></div>
                <div style="flex:0 0 90px;"><label>Importance</label>
                    <select id="bf_mem_edit_imp" class="text_pole" style="width:100%;">${impOptions}</select></div>
            </div>
        </div>`;
        const editPopup = new Popup(editHtml, POPUP_TYPE.TEXT, '', { okButton: 'Save', cancelButton: 'Cancel', wide: true, allowVerticalScrolling: true });
        const result = await editPopup.show();
        if (!result) return; // cancelled
        const eroot = editPopup.dlg || editPopup.content || document;
        const newValue = eroot.querySelector('#bf_mem_edit_value')?.value ?? fact.value;
        const newNote = eroot.querySelector('#bf_mem_edit_note')?.value ?? fact.context;
        const newAspect = eroot.querySelector('#bf_mem_edit_aspect')?.value ?? fact.aspect;
        const newImp = Number(eroot.querySelector('#bf_mem_edit_imp')?.value) || curImp;
        const before = { value: fact.value, context: fact.context || '', aspect: fact.aspect || curAspect, importance: curImp };

        // Mutate the live fact in place + persist Layer A/B.
        fact.value = String(newValue);
        fact.context = String(newNote || '');
        if (newAspect) fact.aspect = newAspect;
        fact.importance = Math.min(5, Math.max(1, Math.round(newImp)));
        fact.lastUpdated = Date.now();
        liveDb.updatedAt = Date.now();
        await saveDatabase({ ...liveDb, category });
        // Layer C write-through so the edit survives a CHAT_CHANGED reload.
        const { profilesUpdated } = updateFactInProfiles(category, key, fact);
        await flushSnapshotNow();
        addDebugLog('pass', `Edited fact "${key}" in "${category}" (Layer A+B+C)`, {
            subsystem: 'db', event: 'fact.edited', actor: 'USER', reason: 'USER_EDIT',
            data: { category, key, profilesUpdated },
            before, after: { value: fact.value, context: fact.context, aspect: fact.aspect, importance: fact.importance },
        });
        toastr.success(`Fact "${key}" updated`, 'BF Memory');
        await reloadFromStore();
    };

    function bindRowHandlers() {
        root.querySelectorAll('.bf-mem-fact-del').forEach(btn =>
            btn.addEventListener('click', () => deleteOne(btn.dataset.key)));
        root.querySelectorAll('.bf-mem-fact-edit').forEach(btn =>
            btn.addEventListener('click', () => editOne(btn.dataset.key)));
        const showMore = root.querySelector('#bf_mem_fact_showmore');
        if (showMore) showMore.addEventListener('click', () => { renderLimit += FACT_VIEW_PAGE_SIZE; render(); });
    }

    filterEl?.addEventListener('input', () => { renderLimit = FACT_VIEW_PAGE_SIZE; render(); });
    selAllEl?.addEventListener('change', () => {
        const on = selAllEl.checked;
        root.querySelectorAll('.bf-mem-fact-check').forEach(c => { c.checked = on; });
    });
    root.querySelector('#bf_mem_fact_bulkdel')?.addEventListener('click', () => deleteSelected());

    render();
    await shownPromise;
}

export async function showAllDatabases() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();
    const categories = Object.keys(databases);

    if (categories.length === 0) {
        toastr.info('No databases yet.', 'BF Memory');
        return;
    }

    let html = '<div class="bf-mem-db-browser">';
    for (const [category, db] of Object.entries(databases)) {
        html += `<div class="bf-mem-db-section">
            <h4>${escapeHtml(category)} (${db.facts.length} facts)</h4>
            <table class="bf-mem-db-table">
                <tr><th>Key</th><th>Value</th><th>Known By</th><th>Tags</th></tr>`;
        for (const fact of db.facts) {
            html += `<tr>
                <td><b>${escapeHtml(fact.key)}</b></td>
                <td>${escapeHtml(fact.value)}</td>
                <td>${escapeHtml((fact.knownBy || []).join(', '))}</td>
                <td>${escapeHtml((fact.tags || []).join(', '))}</td>
            </tr>`;
        }
        html += '</table></div>';
    }
    html += '</div>';

    await ensurePopup();
    if (Popup) {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
        await popup.show();
    }
}

// Stable per-category node colours for the spiderweb (the 7 built-in L1 categories + a fallback).
const SPIDERWEB_COLORS = {
    People: '#7bb3ff', World: '#5fd38d', Events: '#f5a35c', Relationships: '#e879c9',
    Objects: '#d4c25f', Knowledge: '#9b8cff', Unsorted: '#9aa0a6',
};
function spiderwebColor(cat) { return SPIDERWEB_COLORS[cat] || '#c08aff'; }

/**
 * SPIDERWEB VIEW (user request: "the web is visually represented via a new button").
 * Renders the fact graph — each fact is a node, each primary/secondary/tertiary link is an edge —
 * as a dependency-free force-directed SVG (no D3). Shows ONLY the connected sub-graph by default
 * (the actual web), reports how many isolated facts are hidden, and colours nodes by category.
 * Read-only; purely a visualization of `fact.relationships`, which were always stored but never drawn.
 */
export async function showSpiderwebPopup() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();

    // --- Collect nodes (unique by fact key) + edges (links to OTHER existing facts) ---
    const nodes = [];
    const idByKey = new Map();
    const addNode = (key, cat, value, imp) => {
        if (idByKey.has(key)) return idByKey.get(key);
        const id = nodes.length;
        idByKey.set(key, id);
        nodes.push({ key, cat, value: value || '', imp: Number(imp) || 3, deg: 0 });
        return id;
    };
    for (const [cat, db] of Object.entries(databases)) {
        for (const f of (db.facts || [])) { if (f && f.key) addNode(f.key, cat, f.value, f.importance); }
    }
    const edges = [];
    const seenEdge = new Set();
    for (const [, db] of Object.entries(databases)) {
        for (const f of (db.facts || [])) {
            if (!f || !f.key || !idByKey.has(f.key)) continue;
            const r = f.relationships || {};
            for (const tier of ['primary', 'secondary', 'tertiary']) {
                for (const tgt of (r[tier] || [])) {
                    if (tgt === f.key || !idByKey.has(tgt)) continue;
                    const a = idByKey.get(f.key), b = idByKey.get(tgt);
                    const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
                    if (seenEdge.has(ek)) continue;
                    seenEdge.add(ek);
                    edges.push({ s: a, t: b, tier });
                    nodes[a].deg++; nodes[b].deg++;
                }
            }
        }
    }

    const totalFacts = nodes.length;
    // Keep only connected nodes — the web — and remap to a compact index set.
    const connectedIdx = nodes.map((n, i) => i).filter(i => nodes[i].deg > 0);
    const isolated = totalFacts - connectedIdx.length;

    await ensurePopup();
    if (!Popup) { toastr.error('Popup not available', 'BF Memory'); return; }

    if (connectedIdx.length === 0) {
        const msg = `<div class="bf-mem-db-browser"><h4>🕸 Memory Web</h4>
            <p>No connections to draw yet. You have <b>${totalFacts}</b> fact(s), but none are linked to each other.</p>
            <p class="bf-mem-hint">Links form automatically as the Scribe records related facts (auto-linking) and during reflection. Keep chatting and they'll appear here.</p></div>`;
        await new Popup(msg, POPUP_TYPE.TEXT, '', { wide: true }).show();
        return;
    }

    // Cap for layout cost (O(n^2) force sim). Keep the highest-degree nodes if huge.
    const CAP = 280;
    let pick = connectedIdx;
    let capped = 0;
    if (pick.length > CAP) {
        pick = [...connectedIdx].sort((a, b) => nodes[b].deg - nodes[a].deg).slice(0, CAP);
        capped = connectedIdx.length - CAP;
    }
    const pickSet = new Set(pick);
    const local = pick.map((gi, li) => ({ gi, li }));
    const liByGi = new Map(local.map(o => [o.gi, o.li]));
    const N = local.length;

    // CATEGORY-CLUSTERED seed (no Math.random — reproducible). Big virtual canvas; each category
    // gets its own region on a ring so the graph reads as separated clusters you can pan between,
    // not one central blob. Nodes start near their category centre.
    const W = 2000, H = 1400, cx = W / 2, cy = H / 2;
    const catList = [...new Set(local.map(o => nodes[o.gi].cat))];
    const ringR = catList.length > 1 ? 540 : 0;
    const catCenter = {};
    catList.forEach((c, k) => { const a = (2 * Math.PI * k) / catList.length; catCenter[c] = { x: cx + ringR * Math.cos(a), y: cy + ringR * Math.sin(a) }; });
    const P = local.map((o, i) => {
        const c = catCenter[nodes[o.gi].cat]; const a = (2 * Math.PI * i) / N; const rad = 50 + (i % 8) * 20;
        return { x: c.x + rad * Math.cos(a), y: c.y + rad * Math.sin(a), vx: 0, vy: 0 };
    });
    const E = edges.filter(e => pickSet.has(e.s) && pickSet.has(e.t))
        .map(e => ({ s: liByGi.get(e.s), t: liByGi.get(e.t), tier: e.tier }));

    // --- Force-directed layout: stronger repulsion (spread, not a blob) + edge springs +
    //     per-node gravity toward its CATEGORY centre (keeps clusters together) + mild global pull. ---
    const ITER = 420, kRep = 26000, kSpring = 0.015, springLen = 90, catGrav = 0.03, grav = 0.004, damp = 0.85;
    for (let it = 0; it < ITER; it++) {
        for (let i = 0; i < N; i++) {
            let fx = 0, fy = 0;
            for (let j = 0; j < N; j++) {
                if (i === j) continue;
                let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
                let d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
                const f = kRep / d2;
                const d = Math.sqrt(d2);
                fx += (dx / d) * f; fy += (dy / d) * f;
            }
            const cc = catCenter[nodes[local[i].gi].cat];
            fx += (cc.x - P[i].x) * catGrav + (cx - P[i].x) * grav;
            fy += (cc.y - P[i].y) * catGrav + (cy - P[i].y) * grav;
            P[i].vx = (P[i].vx + fx) * damp; P[i].vy = (P[i].vy + fy) * damp;
        }
        for (const e of E) {
            const a = P[e.s], b = P[e.t];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = kSpring * (d - springLen);
            const ux = dx / d, uy = dy / d;
            a.vx += ux * f; a.vy += uy * f;
            b.vx -= ux * f; b.vy -= uy * f;
        }
        for (let i = 0; i < N; i++) {
            P[i].x += Math.max(-45, Math.min(45, P[i].vx));
            P[i].y += Math.max(-45, Math.min(45, P[i].vy));
        }
    }
    // Normalize into the padded viewBox. X()/Y() map a node index to its on-canvas position.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of P) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const pad = 80, sw = (maxX - minX) || 1, sh = (maxY - minY) || 1;
    const layoutScale = Math.min((W - 2 * pad) / sw, (H - 2 * pad) / sh);
    const X = i => pad + (P[i].x - minX) * layoutScale;
    const Y = i => pad + (P[i].y - minY) * layoutScale;

    // --- Build SVG (edges + nodes carry data-attrs so the interactivity below can highlight) ---
    const tierStroke = { primary: 'rgba(150,180,255,0.85)', secondary: 'rgba(140,160,190,0.45)', tertiary: 'rgba(130,140,160,0.25)' };
    const tierW = { primary: 2, secondary: 1.2, tertiary: 0.7 };
    let svgEdges = '';
    E.forEach((e, ei) => {
        svgEdges += `<line class="bf-web-edge" data-ei="${ei}" data-s="${e.s}" data-t="${e.t}" data-tier="${e.tier}" x1="${X(e.s).toFixed(1)}" y1="${Y(e.s).toFixed(1)}" x2="${X(e.t).toFixed(1)}" y2="${Y(e.t).toFixed(1)}" stroke="${tierStroke[e.tier]}" stroke-width="${tierW[e.tier]}" />`;
    });
    // Hub labels (top-degree) show always; the rest reveal on hover/focus to keep the map readable.
    const degOrder = [...Array(N).keys()].sort((a, b) => nodes[local[b].gi].deg - nodes[local[a].gi].deg);
    const hubSet = new Set(degOrder.slice(0, Math.min(24, N)));
    let svgNodes = '';
    for (let i = 0; i < N; i++) {
        const n = nodes[local[i].gi];
        const r = 4 + Math.min(9, n.deg) + (Number(n.imp) || 3) * 0.5;
        const x = X(i), y = Y(i);
        const label = escapeHtml(n.key.length > 26 ? n.key.slice(0, 25) + '…' : n.key);
        const title = escapeHtml(`${n.key} — ${n.cat}\n${n.value}\n${n.deg} link(s)`);
        svgNodes += `<g class="bf-web-node" data-i="${i}"><title>${title}</title>`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${spiderwebColor(n.cat)}" stroke="rgba(0,0,0,0.45)" stroke-width="1"/>`
            + `<text class="bf-web-label${hubSet.has(i) ? ' hub' : ''}" x="${(x + r + 3).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="11">${label}</text>`
            + `</g>`;
    }

    const catCounts = {};
    for (const o of local) { const c = nodes[o.gi].cat; catCounts[c] = (catCounts[c] || 0) + 1; }
    const legend = Object.entries(catCounts).sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `<span class="bf-mem-web-legend-item"><span class="bf-mem-web-dot" style="background:${spiderwebColor(c)}"></span>${escapeHtml(c)} (${n})</span>`).join('');

    const html = `<div class="bf-mem-web-wrap">
        <h4>🕸 Memory Web — ${N} fact(s), ${E.length} link(s)</h4>
        <div class="bf-mem-web-toolbar">
            <input id="bf_web_search" class="text_pole" placeholder="Find a fact by key…" style="flex:1 1 160px;min-width:120px;" />
            <label class="checkbox_label" style="flex:0 0 auto;"><input type="checkbox" id="bf_web_faint" /> <span>show faint links</span></label>
            <button id="bf_web_reset" class="menu_button" style="flex:0 0 auto;">Reset view</button>
        </div>
        <div class="bf-mem-web-legend">${legend}</div>
        <small class="bf-mem-hint"><b>Drag</b> to pan · <b>scroll</b> to zoom · <b>click a dot</b> to see what it's attached to · click empty space to clear.${isolated ? ` &nbsp;${isolated} unlinked fact(s) hidden.` : ''}${capped ? ` &nbsp;${capped} extra node(s) capped.` : ''}</small>
        <div class="bf-mem-web-stage">
            <svg id="bf_web_svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="bf-mem-web-svg">
                <rect id="bf_web_bg" x="0" y="0" width="${W}" height="${H}" fill="transparent"></rect>
                <g id="bf_web_vp"><g id="bf_web_edges">${svgEdges}</g><g id="bf_web_nodes">${svgNodes}</g></g>
            </svg>
        </div>
    </div>`;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: false });
    const shown = popup.show();
    const root = popup.dlg || popup.content || document;
    try {
        const svg = root.querySelector('#bf_web_svg');
        const vp = root.querySelector('#bf_web_vp');
        const bg = root.querySelector('#bf_web_bg');
        if (svg && vp) {
            const nodeEls = [...root.querySelectorAll('.bf-web-node')];
            const edgeEls = [...root.querySelectorAll('.bf-web-edge')];
            // adjacency for click-to-focus ("what is this attached to")
            const adj = Array.from({ length: N }, () => new Set());
            for (const e of E) { adj[e.s].add(e.t); adj[e.t].add(e.s); }

            // pan + zoom via a transform on the viewport group (accurate via screen CTM)
            let sc = 1, px = 0, py = 0;
            const apply = () => vp.setAttribute('transform', `translate(${px} ${py}) scale(${sc})`);
            const toSvg = (evt) => { const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY; const m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 }; };
            svg.addEventListener('wheel', (e) => {
                e.preventDefault();
                const p = toSvg(e); const wx = (p.x - px) / sc, wy = (p.y - py) / sc;
                sc = Math.max(0.2, Math.min(8, sc * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
                px = p.x - wx * sc; py = p.y - wy * sc; apply();
            }, { passive: false });
            let dragging = false, last = null, moved = false;
            svg.addEventListener('pointerdown', (e) => { dragging = true; moved = false; last = toSvg(e); svg.style.cursor = 'grabbing'; try { svg.setPointerCapture(e.pointerId); } catch { /* ok */ } });
            svg.addEventListener('pointermove', (e) => { if (!dragging) return; const p = toSvg(e); px += p.x - last.x; py += p.y - last.y; last = p; moved = true; apply(); });
            const endDrag = () => { dragging = false; svg.style.cursor = 'grab'; };
            svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
            svg.style.cursor = 'grab';

            // focus / clear: dim everything except a node + its direct neighbours
            const clearFocus = () => { nodeEls.forEach(el => el.classList.remove('dim', 'focus')); edgeEls.forEach(el => el.classList.remove('dim', 'focus')); };
            const focusNode = (i) => {
                const keep = new Set([i, ...adj[i]]);
                nodeEls.forEach(el => { const ni = +el.dataset.i; el.classList.toggle('dim', !keep.has(ni)); el.classList.toggle('focus', ni === i); });
                edgeEls.forEach(el => { const on = (+el.dataset.s === i) || (+el.dataset.t === i); el.classList.toggle('focus', on); el.classList.toggle('dim', !on); });
            };
            nodeEls.forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); if (!moved) focusNode(+el.dataset.i); }));
            svg.addEventListener('click', (ev) => { if ((ev.target === bg || ev.target === svg) && !moved) clearFocus(); });

            // faint links (secondary/tertiary) hidden by default to cut clutter
            const setFaint = (show) => edgeEls.forEach(el => { if (el.dataset.tier !== 'primary') el.style.display = show ? '' : 'none'; });
            setFaint(false);
            const faintCb = root.querySelector('#bf_web_faint');
            if (faintCb) faintCb.addEventListener('change', () => setFaint(faintCb.checked));

            const resetBtn = root.querySelector('#bf_web_reset');
            if (resetBtn) resetBtn.addEventListener('click', () => { sc = 1; px = 0; py = 0; apply(); clearFocus(); });

            const search = root.querySelector('#bf_web_search');
            if (search) search.addEventListener('input', () => {
                const q = search.value.trim().toLowerCase();
                if (!q) { clearFocus(); return; }
                const hit = local.findIndex(o => nodes[o.gi].key.toLowerCase().includes(q));
                if (hit >= 0) { focusNode(hit); const vb = svg.viewBox.baseVal; px = vb.width / 2 - X(hit) * sc; py = vb.height / 2 - Y(hit) * sc; apply(); }
            });
            apply();
        }
    } catch (err) { addDebugLog('info', `Memory Web interactivity failed (non-fatal): ${err.message || err}`); }
    await shown;
}
