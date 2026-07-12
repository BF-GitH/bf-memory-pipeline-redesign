import { addDebugLog } from './debug-log.js';
import { ensurePopup, Popup, POPUP_TYPE, escapeHtml } from './ui-util.js';

export async function refreshDatabaseView() {
    const { getAllDatabases, withSkeleton, MENU_CATEGORY_ORDER } = await import('./database.js');
    const real = await getAllDatabases();

    const databases = withSkeleton(real);

    const ordered = [];
    for (const c of MENU_CATEGORY_ORDER) if (databases[c]) ordered.push(c);
    for (const c of Object.keys(databases)) if (!ordered.includes(c)) ordered.push(c);
    const categories = ordered;

    const statsEl = document.getElementById('bf_mem_db_stats');
    if (!statsEl) return;

    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    statsEl.innerHTML = `<b>${categories.length}</b> databases | <b>${totalFacts}</b> total facts`;
}

const SPIDERWEB_COLORS = {
    People: '#7bb3ff', World: '#5fd38d', Events: '#f5a35c', Relationships: '#e879c9',
    Objects: '#d4c25f', Knowledge: '#9b8cff', Unsorted: '#9aa0a6',
};
function spiderwebColor(cat) { return SPIDERWEB_COLORS[cat] || '#c08aff'; }

export async function showSpiderwebPopup() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();

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

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of P) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const pad = 80, sw = (maxX - minX) || 1, sh = (maxY - minY) || 1;
    const layoutScale = Math.min((W - 2 * pad) / sw, (H - 2 * pad) / sh);
    const X = i => pad + (P[i].x - minX) * layoutScale;
    const Y = i => pad + (P[i].y - minY) * layoutScale;

    const tierStroke = { primary: 'rgba(150,180,255,0.85)', secondary: 'rgba(140,160,190,0.45)', tertiary: 'rgba(130,140,160,0.25)' };
    const tierW = { primary: 2, secondary: 1.2, tertiary: 0.7 };
    let svgEdges = '';
    E.forEach((e, ei) => {
        svgEdges += `<line class="bf-web-edge" data-ei="${ei}" data-s="${e.s}" data-t="${e.t}" data-tier="${e.tier}" x1="${X(e.s).toFixed(1)}" y1="${Y(e.s).toFixed(1)}" x2="${X(e.t).toFixed(1)}" y2="${Y(e.t).toFixed(1)}" stroke="${tierStroke[e.tier]}" stroke-width="${tierW[e.tier]}" />`;
    });

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

            const adj = Array.from({ length: N }, () => new Set());
            for (const e of E) { adj[e.s].add(e.t); adj[e.t].add(e.s); }

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
            svg.addEventListener('pointerdown', (e) => { dragging = true; moved = false; last = toSvg(e); svg.style.cursor = 'grabbing'; try { svg.setPointerCapture(e.pointerId); } catch {  } });
            svg.addEventListener('pointermove', (e) => { if (!dragging) return; const p = toSvg(e); px += p.x - last.x; py += p.y - last.y; last = p; moved = true; apply(); });
            const endDrag = () => { dragging = false; svg.style.cursor = 'grab'; };
            svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
            svg.style.cursor = 'grab';

            const clearFocus = () => { nodeEls.forEach(el => el.classList.remove('dim', 'focus')); edgeEls.forEach(el => el.classList.remove('dim', 'focus')); };
            const focusNode = (i) => {
                const keep = new Set([i, ...adj[i]]);
                nodeEls.forEach(el => { const ni = +el.dataset.i; el.classList.toggle('dim', !keep.has(ni)); el.classList.toggle('focus', ni === i); });
                edgeEls.forEach(el => { const on = (+el.dataset.s === i) || (+el.dataset.t === i); el.classList.toggle('focus', on); el.classList.toggle('dim', !on); });
            };
            nodeEls.forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); if (!moved) focusNode(+el.dataset.i); }));
            svg.addEventListener('click', (ev) => { if ((ev.target === bg || ev.target === svg) && !moved) clearFocus(); });

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
