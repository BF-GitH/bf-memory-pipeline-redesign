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
    getSettings, saveSettings, pruneActiveProfile, pruneFactFromProfiles, updateFactInProfiles,
} from './settings.js';

// Monotonic token guarding the async graph-view render against a race: a rapid second click starts
// a new render; only the LATEST may paint, so an earlier slow resolve can't overwrite a newer node.
let graphViewToken = 0;

/**
 * Graph view (Phase 4 — "true graphline memory" visibility). Resolves a fact by Category/key (or
 * bare key) and shows its linked neighbors: relationship-ref links (primary/secondary, the same
 * refs recall traversal follows) + one-hop scope-graph neighbors (place⇄event⇄people via expandLinks).
 * Neighbors are clickable to walk the graph. Read-only; lazy-imports the heavy db modules.
 * @param {string} keyQuery
 */
export async function renderGraphView(keyQuery) {
    const el = document.getElementById('bf_mem_graph_result');
    if (!el) return;
    const myToken = ++graphViewToken; // this render's claim; a newer render supersedes it
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const q = String(keyQuery ?? '').trim();
    if (!q) { el.innerHTML = '<div class="bf-mem-hint">Enter a Category/key or key.</div>'; return; }
    el.innerHTML = '<div class="bf-mem-hint">Loading…</div>';
    try {
        const db = await import('./database.js');
        const fr = await import('./fact-retrieval.js');
        const databases = await db.getAllDatabases();
        const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const slash = q.indexOf('/');
        const wantCat = slash >= 0 ? norm(q.slice(0, slash)) : null;
        const wantKey = norm(slash >= 0 ? q.slice(slash + 1) : q);
        let target = null, targetCat = null;
        for (const [cat, cdb] of Object.entries(databases)) {
            if (wantCat && norm(cat) !== wantCat) continue;
            for (const f of (cdb.facts || [])) { if (norm(f.key) === wantKey) { target = f; targetCat = cat; break; } }
            if (target) break;
        }
        if (!target) { el.innerHTML = `<div class="bf-mem-hint">No fact found for "<code>${esc(q)}</code>".</div>`; return; }
        const resolveRef = (ref) => {
            const rk = norm(ref);
            for (const [cat, cdb] of Object.entries(databases)) for (const f of (cdb.facts || [])) if (norm(f.key) === rk) return { cat, fact: f };
            return null;
        };
        const rels = target.relationships || {};
        const primary = (rels.primary || []).map(resolveRef).filter(Boolean);
        const secondary = (rels.secondary || []).map(resolveRef).filter(Boolean);
        // One-hop scope graph via the same exported helper recall uses (mutates the array in place).
        const seedRow = [{ fact: target, category: targetCat, tier: 'primary' }];
        const seen = new Set([`${targetCat}:${target.key}`]);
        try { fr.expandLinks(databases, seedRow, seen); } catch { /* best-effort */ }
        const scopeNeighbors = seedRow.slice(1).map(r => ({ cat: r.category, fact: r.fact }));
        const factLine = (cat, f) => `<a href="#" class="bf-mem-graph-link" data-key="${esc(cat)}/${esc(f.key)}"><code>${esc(cat)}/${esc(f.key)}</code></a> ${esc(String(f.value || f.note || '').slice(0, 80))}`;
        const section = (title, list) => list.length
            ? `<div class="bf-mem-graph-section"><div class="bf-mem-graph-title">${title} (${list.length})</div>${list.map(n => `<div class="bf-mem-graph-row">↳ ${factLine(n.cat, n.fact)}</div>`).join('')}</div>`
            : '';
        let html = `<div class="bf-mem-graph-node"><b>${esc(targetCat)}/${esc(target.key)}</b>: ${esc(String(target.value || '').slice(0, 160))}</div>`;
        html += section('Primary links', primary);
        html += section('Secondary links', secondary);
        html += section('Scope-graph neighbors (1 hop)', scopeNeighbors);
        if (!primary.length && !secondary.length && !scopeNeighbors.length) {
            html += '<div class="bf-mem-hint">No links yet — this fact is an island. Auto-linking connects facts that share a subject, location, or participants.</div>';
        }
        if (myToken !== graphViewToken) return; // a newer render started while we awaited — let it win
        el.innerHTML = html;
        el.querySelectorAll('.bf-mem-graph-link').forEach(a => a.addEventListener('click', (ev) => {
            ev.preventDefault();
            const k = a.getAttribute('data-key');
            const inp = document.getElementById('bf_mem_graph_key');
            if (inp) inp.value = k;
            renderGraphView(k);
        }));
    } catch (e) {
        el.innerHTML = `<div class="bf-mem-hint">Graph view error: ${esc(String(e).slice(0, 140))}</div>`;
    }
}

/**
 * "Recurring characters" entity panel (Phase 4). Lists the entity registry for this chat (named /
 * NPC / deferred) and lets the user PROMOTE an NPC/deferred entity to a first-class recurring
 * subject (re-keys its facts under its own name via promoteEntity). Lazy-imports agent-entities.js.
 */
export async function renderEntityPanel() {
    const el = document.getElementById('bf_mem_entities_list');
    if (!el) return;
    const sumEl = document.getElementById('bf_mem_entities_summary');
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    try {
        const ent = await import('./agent-entities.js');
        const entities = ent.getEntities() || {};
        const names = Object.keys(entities);
        if (!names.length) {
            el.innerHTML = '<div class="bf-mem-hint" style="opacity:.7;">No entities tracked yet this chat. As characters recur, they appear here.</div>';
            if (sumEl) sumEl.textContent = '';
            return;
        }
        const badge = st => `<span class="bf-mem-ent-badge bf-mem-ent-${esc(st)}">${esc(st)}</span>`;
        el.innerHTML = names.sort().map(name => {
            const e = entities[name] || {};
            const st = e.status || 'deferred';
            const canPromote = st !== 'named';
            return `<div class="bf-mem-ent-row"><span class="bf-mem-ent-name">${esc(name)}</span> ${badge(st)}`
                + (Array.isArray(e.aliases) && e.aliases.length ? ` <span class="bf-mem-dim">aka ${esc(e.aliases.join(', '))}</span>` : '')
                + (canPromote ? ` <button class="menu_button bf-mem-ent-promote" data-name="${esc(name)}" title="Promote to a first-class recurring subject (re-keys its facts)">Mark recurring</button>` : '')
                + `</div>`;
        }).join('');
        if (sumEl) sumEl.textContent = `${names.length} entit${names.length === 1 ? 'y' : 'ies'}`;
        el.querySelectorAll('.bf-mem-ent-promote').forEach(b => b.addEventListener('click', async () => {
            const nm = b.getAttribute('data-name');
            b.disabled = true; b.textContent = 'Promoting…';
            try { const r = await ent.promoteEntity(nm); b.textContent = `Promoted (${r?.moved || 0} facts)`; }
            catch { b.textContent = 'Failed'; }
            setTimeout(() => renderEntityPanel(), 900);
        }));
    } catch (e) {
        el.innerHTML = `<div class="bf-mem-hint">Entity panel error: ${esc(String(e).slice(0, 140))}</div>`;
    }
}

// --- Database View ---

/**
 * Populate the "Add aspect" category dropdown with the built-in L1 order followed by any
 * user-added (custom) categories, preserving the current selection when possible. Custom
 * categories are suffixed " (custom)" so they're distinguishable.
 * @param {string[]} builtinOrder - MENU_CATEGORY_ORDER (built-in L1)
 * @param {Set<string>} customCats - user-added overlay category names
 * @returns {void}
 */
function populateAddLabelCategoryDropdown(builtinOrder, customCats) {
    const select = document.getElementById('bf_mem_addleaf_category');
    if (!select) return;
    const prev = select.value;
    const names = [...builtinOrder, ...[...customCats].filter(c => !builtinOrder.includes(c))];
    select.innerHTML = names.map(c =>
        `<option value="${escapeHtml(c)}">${escapeHtml(c)}${customCats.has(c) ? ' (custom)' : ''}</option>`
    ).join('');
    if (prev && names.includes(prev)) select.value = prev;
}

/**
 * Add a user Layer-2 leaf to the persisted taxonomy overlay (with dedup). Normalizes the surface
 * form, checks it against the EXISTING effective vocab + synonyms for the category; if already
 * covered, it logs a dedup redirect and does NOT add a duplicate. Otherwise it appends the leaf
 * (and its optional sub-area) to settings.taxonomyOverlay, persists, invalidates the taxonomy
 * memo, and refreshes the Database view.
 * @param {string} category - target Layer-1 category (built-in or custom)
 * @param {string} rawLeaf - raw user leaf input
 * @param {string} [rawSubArea] - optional sub-area grouping for the menu
 * @returns {Promise<void>}
 */
export async function addUserLeaf(category, rawLeaf, rawSubArea) {
    const {
        canonicalizeLeafSurface, findExistingLeaf, invalidateTaxonomyOverlayCache, mapLegacyCategory,
    } = await import('./database.js');
    const cat = mapLegacyCategory(category); // canonical spelling (built-in or overlay)
    const leaf = canonicalizeLeafSurface(rawLeaf);
    if (!leaf) {
        toastr.warning('Enter a valid aspect name.', 'BF Memory');
        return;
    }
    // Dedup: already a leaf or a known synonym of an existing leaf for this category.
    const existing = findExistingLeaf(leaf, cat);
    if (existing) {
        addDebugLog('info', `Label not added — "${leaf}" already covered by "${existing}" (${cat})`, {
            subsystem: 'settings', event: 'label.merged', reason: 'SYNONYM_DEDUP', actor: 'USER',
            data: { tier: 'aspect', category: cat, label: leaf, existing },
        });
        toastr.info(`"${leaf}" is already covered by "${existing}".`, 'BF Memory');
        return;
    }

    // Persist into the overlay (well-formed shape guaranteed by validateSettings).
    const ov = getSettings().taxonomyOverlay = getSettings().taxonomyOverlay || { categories: [], aspects: {}, subAreas: {} };
    if (!Array.isArray(ov.aspects[cat])) ov.aspects[cat] = [];
    ov.aspects[cat].push(leaf);
    const subArea = String(rawSubArea || '').trim();
    if (subArea) {
        if (!ov.subAreas[cat] || typeof ov.subAreas[cat] !== 'object') ov.subAreas[cat] = {};
        if (!Array.isArray(ov.subAreas[cat][subArea])) ov.subAreas[cat][subArea] = [];
        ov.subAreas[cat][subArea].push(leaf);
    }
    saveSettings();
    invalidateTaxonomyOverlayCache();
    addDebugLog('pass', `Custom aspect added: "${leaf}" → ${cat}${subArea ? ` (${subArea})` : ''}`, {
        subsystem: 'settings', event: 'label.added', actor: 'USER',
        data: { tier: 'aspect', category: cat, label: leaf, subArea: subArea || undefined },
    });
    toastr.success(`Added aspect "${leaf}" to ${cat}.`, 'BF Memory');
    const nameEl = document.getElementById('bf_mem_addleaf_name');
    const subEl = document.getElementById('bf_mem_addleaf_subarea');
    if (nameEl) nameEl.value = '';
    if (subEl) subEl.value = '';
    refreshDatabaseView();
}

/**
 * Add a user Layer-1 category to the persisted taxonomy overlay (with dedup against built-ins +
 * existing overlay categories). Persists, invalidates the taxonomy memo, and refreshes the view.
 * @param {string} rawName - raw user category name
 * @returns {Promise<void>}
 */
export async function addUserCategory(rawName) {
    const { MENU_CATEGORY_ORDER, effectiveCategories, invalidateTaxonomyOverlayCache } = await import('./database.js');
    // Keep the user's casing but trim; reject empty.
    const name = String(rawName || '').trim().replace(/\s+/g, ' ');
    if (!name) {
        toastr.warning('Enter a category name.', 'BF Memory');
        return;
    }
    const lc = name.toLowerCase();
    const existing = effectiveCategories().find(c => c.toLowerCase() === lc);
    if (existing) {
        const isBuiltin = MENU_CATEGORY_ORDER.some(c => c.toLowerCase() === lc);
        addDebugLog('info', `Category not added — "${name}" already exists as "${existing}"`, {
            subsystem: 'settings', event: 'label.merged', reason: 'SYNONYM_DEDUP', actor: 'USER',
            data: { tier: 'category', category: name, label: name, existing },
        });
        toastr.info(`Category "${existing}" already exists${isBuiltin ? ' (built-in)' : ''}.`, 'BF Memory');
        return;
    }
    if (!confirm(`Add a new top-level category "${name}"?`)) return;

    const ov = getSettings().taxonomyOverlay = getSettings().taxonomyOverlay || { categories: [], aspects: {}, subAreas: {} };
    if (!Array.isArray(ov.categories)) ov.categories = [];
    ov.categories.push(name);
    saveSettings();
    invalidateTaxonomyOverlayCache();
    addDebugLog('pass', `Custom category added: "${name}"`, {
        subsystem: 'settings', event: 'label.added', actor: 'USER',
        data: { tier: 'category', category: name, label: name },
    });
    toastr.success(`Added category "${name}".`, 'BF Memory');
    const nameEl = document.getElementById('bf_mem_addcat_name');
    if (nameEl) nameEl.value = '';
    refreshDatabaseView();
}

/**
 * AI "Suggest new labels" handler (Database tab button). MANUAL, on-demand: mines the fact DB
 * for homeless facts, makes ONE LLM call (taxonomy-suggest.js, Scribe/Agent-3 profile), then
 * shows the parsed proposals in a MANDATORY human-approval popup. Approved leaves are written
 * through the SAME overlay path the manual "Add your own label" controls use (addUserLeaf /
 * addUserCategory) so dedup/canonicalization/cache-invalidation/refresh are identical — re-running
 * dedup here is correct (a proposal that collides with an existing/just-added leaf is absorbed as
 * a synonym, not duplicated). NOTHING is added without explicit approval. Never throws into the UI.
 * @returns {Promise<void>}
 */
export async function onSuggestLabelsClick() {
    const btn = document.getElementById('bf_mem_suggest_labels_btn');
    if (btn && btn.dataset.busy === '1') return; // guard against double-click while the call is in flight
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
    try {
        const { getAgent3ProfileId } = await import('./profiler.js');
        const { runLabelSuggestion } = await import('./taxonomy-suggest.js');
        const profileId = getAgent3ProfileId(getSettings());

        toastr.info('Scanning facts and asking the model for label ideas…', 'BF Memory');
        const result = await runLabelSuggestion({ profileId });

        if (result.noCandidates) {
            toastr.info('No homeless facts to analyze — everything already has a specific home.', 'BF Memory');
            return;
        }
        if (result.error) {
            toastr.error(`Suggest labels failed: ${result.error}`, 'BF Memory');
            return;
        }
        if (result.proposals.length === 0 && result.synonyms.length === 0) {
            toastr.info(`Analyzed ${result.candidateCount} fact(s); the model proposed no new labels.`, 'BF Memory');
            return;
        }
        await showLabelSuggestionsPopup(result);
    } catch (err) {
        addDebugLog('fail', `Suggest labels handler failed (non-fatal): ${err.message || err}`);
        toastr.error('Suggest labels failed. See the Debug tab for details.', 'BF Memory');
    } finally {
        if (btn) { btn.dataset.busy = '0'; btn.disabled = false; }
    }
}

/**
 * MANDATORY human-approval popup for AI-suggested labels. Reuses ST's Popup API (same
 * Popup + POPUP_TYPE.TEXT + custom OK/Cancel pattern showEntityPopup uses). Each NEW-leaf
 * proposal gets an Approve/Reject radio (default Reject — dismiss-safe); map-to-existing
 * synonym suggestions are shown read-only (informational; v1 doesn't auto-refile). On Save,
 * each Approved proposal is written via addUserCategory (new category) + addUserLeaf (leaf) —
 * the same dedup+persist+invalidate+refresh the manual controls use. NOTHING is added unless
 * the user explicitly Approves it and clicks Save.
 *
 * NOTE (v1): approved labels are ADDED to the taxonomy only — existing homeless facts are NOT
 * auto-refiled onto the new leaf. The late-bound aspect resolver + future Scribe turns pick the
 * new label up. (TODO: optional opt-in refile via a safe upsertFact of just the clustered facts.)
 *
 * @param {{proposals: Array, synonyms: Array, candidateCount: number}} result
 * @returns {Promise<void>}
 */
async function showLabelSuggestionsPopup(result) {
    const proposals = result.proposals || [];
    const synonyms = result.synonyms || [];

    const ok = await ensurePopup();
    if (!ok || !Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    const proposalRows = proposals.map((p, idx) => {
        const grp = `bf_mem_suggest_choice_${idx}`;
        const examples = (p.examples || []).length
            ? `<div class="bf-mem-suggest-examples" style="font-size:0.85em;opacity:0.8;margin-top:2px;">e.g. ${p.examples.map(e => escapeHtml(e)).join('; ')}</div>`
            : '';
        const catBadge = p.newCategory ? ` <span class="bf-mem-action-badge" title="A brand-new top-level category">NEW CAT</span>` : '';
        return `
            <div class="bf-mem-suggest-row" data-idx="${idx}" style="display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                <div><b>${escapeHtml(p.category)}</b> ▸ ${escapeHtml(p.subArea || 'Custom')} ▸ <b>${escapeHtml(p.label)}</b>${catBadge}</div>
                ${p.definition ? `<div style="font-size:0.9em;">${escapeHtml(p.definition)}</div>` : ''}
                ${examples}
                <div class="bf-mem-suggest-choices" style="display:flex;gap:14px;flex-wrap:wrap;">
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="approve" /> <span>Approve</span></label>
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="reject" checked /> <span>Reject</span></label>
                </div>
            </div>`;
    }).join('');

    const synonymRows = synonyms.length
        ? `<div class="bf-mem-suggest-synonyms" style="margin-top:10px;">
                <h4 style="margin:0 0 4px 0;">Already covered (the model suggests these clusters fit an existing leaf — informational, not added)</h4>
                ${synonyms.map(s => `<div style="font-size:0.9em;padding:2px 0;">${escapeHtml(s.category)}/<b>${escapeHtml(s.leaf)}</b>${s.reason ? ` — ${escapeHtml(s.reason)}` : ''}</div>`).join('')}
            </div>`
        : '';

    const html = `
        <div class="bf-mem-suggest-popup" data-count="${proposals.length}">
            <h3>AI label suggestions (${proposals.length})</h3>
            <p>Reviewed ${result.candidateCount} homeless fact(s). Approve the labels you want added to your taxonomy. Approved labels are de-duplicated against the existing vocab before they're added. Nothing is added unless you Approve it and click Save.</p>
            ${proposals.length ? `<div class="bf-mem-suggest-list" style="max-height:50vh;overflow-y:auto;">${proposalRows}</div>` : '<p><i>No new-label proposals.</i></p>'}
            ${synonymRows}
        </div>`;

    let decisions = [];
    try {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
            okButton: 'Save approved',
            cancelButton: 'Cancel (add nothing)',
            wide: true,
            allowVerticalScrolling: true,
        });
        const popupResult = await popup.show();
        const root = popup.dlg || popup.content || document;
        const cancelled = !popupResult;
        if (!cancelled) {
            root.querySelectorAll('.bf-mem-suggest-row')?.forEach((row) => {
                const idx = parseInt(row.getAttribute('data-idx'), 10);
                const p = proposals[idx];
                if (!p) return;
                const sel = row.querySelector('input[type="radio"]:checked');
                if (sel && sel.value === 'approve') decisions.push(p);
            });
        }
    } catch (err) {
        addDebugLog('fail', `Suggest labels popup failed (non-fatal): ${err.message || err}`);
        return;
    }

    if (decisions.length === 0) {
        addDebugLog('info', `Suggest labels: user approved 0 of ${proposals.length} proposal(s)`, {
            subsystem: 'settings', event: 'taxonomy.suggest', reason: 'NONE_APPROVED', actor: 'USER',
            data: { proposed: proposals.length },
        });
        toastr.info('No labels added.', 'BF Memory');
        return;
    }

    // Apply approved proposals through the SAME overlay path the manual add controls use. A new
    // category is added first (so its leaf can attach to it), then the leaf — both re-run their
    // own dedup (a collision is absorbed as a synonym, never duplicated). They each persist,
    // invalidate the taxonomy memo, and refresh the Database view, and emit label.added /
    // label.merged logs, so no extra wiring is needed here.
    for (const p of decisions) {
        try {
            if (p.newCategory) {
                await addUserCategory(p.category);
            }
            await addUserLeaf(p.category, p.label, p.subArea);
        } catch (err) {
            addDebugLog('fail', `Suggest labels: failed to add "${p.category}/${p.label}" (non-fatal): ${err.message || err}`);
        }
    }
    addDebugLog('pass', `Suggest labels: user approved ${decisions.length} of ${proposals.length} proposal(s)`, {
        subsystem: 'settings', event: 'taxonomy.suggest', reason: 'APPROVED', actor: 'USER',
        data: { approved: decisions.length, proposed: proposals.length, labels: decisions.map(d => `${d.category}/${d.label}`) },
    });
}

export async function refreshDatabaseView() {
    const {
        getAllDatabases, withSkeleton, MENU_CATEGORY_ORDER, aspectVocabFor, deriveAspect,
        isActiveFact, isColdFact, effectiveCategories, flatVocab,
    } = await import('./database.js');
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

    // Custom (user-added) markers so the UI can distinguish overlay labels from built-ins.
    const customCats = new Set(effectiveCategories().filter(c => !MENU_CATEGORY_ORDER.includes(c)));
    const overlay = getSettings()?.taxonomyOverlay || { aspects: {} };

    // Keep the "Add aspect" category dropdown in sync with the effective category set.
    populateAddLabelCategoryDropdown(MENU_CATEGORY_ORDER, customCats);

    const statsEl = document.getElementById('bf_mem_db_stats');
    const listEl = document.getElementById('bf_mem_db_list');

    if (!statsEl || !listEl) return;

    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    statsEl.innerHTML = `<b>${categories.length}</b> databases | <b>${totalFacts}</b> total facts`;

    listEl.innerHTML = categories.map(cat => {
        const db = databases[cat];
        const factCount = db.facts.length;
        // Never-delete / cold-tier: the old 50-cap is gone, so show the real count plus how many
        // are cold-tiered (deprioritized but kept), not a fake "/50".
        const coldCount = db.facts.filter(f => { try { return isColdFact(f); } catch { return false; } }).length;
        const countLabel = coldCount ? `${factCount} (${coldCount} cold)` : `${factCount}`;
        const isCustomCat = customCats.has(cat);
        // Overlay (user-added) leaves for this category, so we can chip them in the breakdown.
        const overlayLeaves = new Set((Array.isArray(overlay.aspects?.[cat]) ? overlay.aspects[cat] : [])
            .map(l => String(l || '').trim().toLowerCase()));
        const knowers = [...new Set(db.facts.flatMap(f => f.knownBy || []))];
        // Layer-2 aspect breakdown: show the full effective vocab for this category (built-in +
        // overlay) with active counts (0 when empty) so the skeleton is visible from turn 1.
        const aspectCounts = new Map();
        for (const f of db.facts) {
            if (!isActiveFact(f)) continue;
            const a = deriveAspect(f);
            aspectCounts.set(a, (aspectCounts.get(a) || 0) + 1);
        }
        // DECLUTTER (user request): the Database tab used to dump the ENTIRE built-in vocab for
        // every category — ~940 leaves, nearly all `:0`. The planner (Drafter) already only sees
        // NON-EMPTY labels, so showing hundreds of empty slots here was pure noise ("1000 categories").
        // Show ONLY aspects that actually carry facts (count > 0) plus the user's own custom (overlay)
        // leaves, and report how many empty built-in slots were hidden. The full vocab is untouched —
        // the Scribe still files into it and the "Add label" dropdown still lists it.
        const fullVocab = flatVocab(cat);
        const shownAspectNames = fullVocab.filter(a => (aspectCounts.get(a) || 0) > 0 || overlayLeaves.has(a));
        // Surface any populated aspect that isn't in the built-in vocab (legacy/unknown) so no real fact hides.
        for (const a of aspectCounts.keys()) {
            if ((aspectCounts.get(a) || 0) > 0 && !shownAspectNames.includes(a)) shownAspectNames.push(a);
        }
        const hiddenEmptyCount = fullVocab.length - fullVocab.filter(a => (aspectCounts.get(a) || 0) > 0 || overlayLeaves.has(a)).length;
        const aspectStr = shownAspectNames.length
            ? shownAspectNames.map(a => {
                const label = `${a}:${aspectCounts.get(a) || 0}`;
                return overlayLeaves.has(a) ? `${label}*` : label;
            }).join(', ')
            : '— no facts filed yet —';
        return `
            <div class="bf-mem-db-card" data-category="${escapeHtml(cat)}">
                <div class="bf-mem-db-card-header">
                    <span class="bf-mem-db-card-name">${escapeHtml(cat)}${isCustomCat ? ' <span class="bf-mem-custom-chip" title="User-added category">custom</span>' : ''}</span>
                    <span class="bf-mem-db-card-count">${escapeHtml(countLabel)}</span>
                </div>
                <div class="bf-mem-db-card-meta">
                    <div class="bf-mem-db-card-aspects">${escapeHtml(aspectStr)}</div>
                    ${hiddenEmptyCount ? `<small class="bf-mem-hint">+${hiddenEmptyCount} empty aspect slot(s) hidden</small>` : ''}
                    ${overlayLeaves.size ? '<small class="bf-mem-hint">* = your custom aspect</small>' : ''}
                    ${knowers.length ? `Known by: ${escapeHtml(knowers.join(', '))}` : ''}
                </div>
                <div class="bf-mem-db-card-actions">
                    <button class="bf-mem-db-view menu_button" data-category="${escapeHtml(cat)}">
                        <i class="fa-solid fa-eye"></i> View
                    </button>
                    <button class="bf-mem-db-delete menu_button" data-category="${escapeHtml(cat)}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>`;
    }).join('');

    // Bind view buttons
    listEl.querySelectorAll('.bf-mem-db-view').forEach(btn => {
        btn.addEventListener('click', () => viewSingleDatabase(btn.dataset.category, databases));
    });

    // Bind delete buttons
    listEl.querySelectorAll('.bf-mem-db-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const category = btn.dataset.category;
            if (!confirm(`Delete database "${category}"?`)) return;
            const { deleteDatabase, flushSnapshotNow } = await import('./database.js');
            // Layer A (IDB) + Layer B (attachment file) — also cancels the armed snapshot timer.
            await deleteDatabase(category);
            // Layer C (dbProfiles snapshot): prune the category so autoSaveDbProfile can't resurrect
            // it on the next CHAT_CHANGED. Without this, deleting from IDB+attachments leaves the
            // full copy in the linked profile and it reloads on chat switch.
            const { profilesPruned, factsPruned } = pruneActiveProfile(category);
            // Force a reconciling snapshot now so the durable attachment layer reflects the deletion
            // immediately (deletes the emptied category's file) rather than on the throttled cadence.
            await flushSnapshotNow();
            addDebugLog('pass', `Deleted category "${category}" (Layer A+B+C)`, {
                subsystem: 'db', event: 'db.deleteCategory', actor: 'USER', reason: 'USER_DELETE',
                data: { category, profilesPruned, factsPrunedFromProfile: factsPruned },
            });
            toastr.success(`Database "${category}" deleted`, 'BF Memory');
            refreshDatabaseView();
        });
    });
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
        // Spiderweb 2: the fact's origin scene (No + name) + source-message provenance.
        const sceneLine = Number.isInteger(fact.sceneNo)
            ? `<div class="bf-mem-fact-source">scene: #${fact.sceneNo}${fact.sceneName ? ` · ${escapeHtml(fact.sceneName)}` : ''}${fact.sourceMsg ? ` · from ${escapeHtml(fact.sourceMsg)}` : ''}</div>`
            : (fact.sourceMsg ? `<div class="bf-mem-fact-source">from ${escapeHtml(fact.sourceMsg)}</div>` : '');
        return `
            <div class="bf-mem-fact-row" data-key="${escapeHtml(fact.key)}" style="border-bottom:1px solid var(--SmartThemeBorderColor,#444);padding:6px 0;">
                <div style="display:flex;gap:8px;align-items:flex-start;">
                    <input type="checkbox" class="bf-mem-fact-check" data-key="${escapeHtml(fact.key)}" style="margin-top:4px;" />
                    <div style="flex:1 1 auto;min-width:0;">
                        <div><b>${escapeHtml(fact.key)}</b>${coldBadge}${superseded}
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

/**
 * Cross-category live search wired to #bf_mem_db_search. On a non-empty query it hides the
 * per-category cards and lists matching facts (key/value/note/tags/knownBy substring) grouped by
 * category, each with an "Open" button into that category's manager (where it can be edited/deleted).
 * On an empty query it restores the normal card view. Cap the rendered matches so a broad query on
 * a 10k store can't jank the UI.
 */
export async function runDatabaseSearch() {
    const input = document.getElementById('bf_mem_db_search');
    const resultsEl = document.getElementById('bf_mem_db_search_results');
    const listEl = document.getElementById('bf_mem_db_list');
    if (!input || !resultsEl || !listEl) return;
    const q = (input.value || '').trim().toLowerCase();
    if (!q) {
        resultsEl.style.display = 'none';
        resultsEl.innerHTML = '';
        listEl.style.display = '';
        return;
    }
    const { getAllDatabases, withSkeleton, isColdFact } = await import('./database.js');
    const databases = withSkeleton(await getAllDatabases());
    const MAX_RESULTS = 300;
    const matches = [];
    for (const [category, db] of Object.entries(databases)) {
        for (const fact of (db.facts || [])) {
            const hay = `${fact.key || ''} ${fact.value || ''} ${fact.context || ''} ${(fact.tags || []).join(' ')} ${(fact.knownBy || []).join(' ')}`.toLowerCase();
            if (hay.includes(q)) matches.push({ category, fact });
            if (matches.length >= MAX_RESULTS) break;
        }
        if (matches.length >= MAX_RESULTS) break;
    }
    listEl.style.display = 'none';
    resultsEl.style.display = '';
    if (matches.length === 0) {
        resultsEl.innerHTML = '<div class="bf-mem-empty">No facts match.</div>';
        return;
    }
    resultsEl.innerHTML = `<div class="bf-mem-hint" style="margin-bottom:6px;">${matches.length}${matches.length >= MAX_RESULTS ? '+' : ''} match(es)${matches.length >= MAX_RESULTS ? ' (showing first ' + MAX_RESULTS + ')' : ''}. Click Open to edit/delete.</div>`
        + matches.map(({ category, fact }) => {
            const cold = (() => { try { return isColdFact(fact); } catch { return false; } })();
            return `<div class="bf-mem-fact-row" style="border-bottom:1px solid var(--SmartThemeBorderColor,#444);padding:6px 0;display:flex;gap:8px;align-items:flex-start;">
                <div style="flex:1 1 auto;min-width:0;">
                    <div><span class="bf-mem-fact-source">[${escapeHtml(category)}]</span> <b>${escapeHtml(fact.key)}</b>${cold ? ' <span class="bf-mem-custom-chip" title="Cold-tiered">cold</span>' : ''}</div>
                    <div class="bf-mem-fact-value">${escapeHtml(fact.value)}</div>
                </div>
                <button class="bf-mem-search-open menu_button" data-category="${escapeHtml(category)}" style="flex:0 0 auto;"><i class="fa-solid fa-up-right-from-square"></i> Open</button>
            </div>`;
        }).join('');
    resultsEl.querySelectorAll('.bf-mem-search-open').forEach(btn => {
        btn.addEventListener('click', () => viewSingleDatabase(btn.dataset.category, databases));
    });
}
