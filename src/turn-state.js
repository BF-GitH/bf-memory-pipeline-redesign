import { addDebugLog } from './debug-log.js';

import { getContext, escapeHtml, fmt, getCurrentChatId, isBranchChat } from './ui-util.js';

let lastGenerated = { runId: null, timestamp: null, updates: [] };
let lastInserted = { runId: null, timestamp: null, updates: [] };
let lastRunTokens = null; 
let sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };

let reflection = null;

let summaryPyramid = null; 

const GENERATED_META_KEY = 'bf_mem_generated';
const INSERTED_META_KEY = 'bf_mem_inserted';

function loadFactsFromMeta(key) {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        const stored = md[key];
        if (!stored || typeof stored !== 'object' || !Array.isArray(stored.updates)) return null;
        return stored;
    } catch { return null; }
}

function saveFactsToMeta(key, data) {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[key] = data;
        ctx.saveMetadata?.();
    } catch {  }
}

export function setLastGenerated(updates) {
    lastGenerated = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(GENERATED_META_KEY, lastGenerated);
}

export function setLastInserted(updates) {
    lastInserted = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(INSERTED_META_KEY, lastInserted);
}

export function reloadFactsFromChat() {
    lastGenerated = loadFactsFromMeta(GENERATED_META_KEY) || { runId: null, timestamp: null, updates: [] };
    lastInserted = loadFactsFromMeta(INSERTED_META_KEY) || { runId: null, timestamp: null, updates: [] };
}

const TOKENS_META_KEY = 'bf_mem_tokens';

function loadTokensFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return;
        const stored = md[TOKENS_META_KEY];
        if (stored && typeof stored === 'object') {

            const currentChatId = getCurrentChatId();
            const owner = typeof stored.ownerChatId === 'string' ? stored.ownerChatId : null;
            const inherited = !!currentChatId && owner !== null && owner !== currentChatId;
            if (inherited) {
                lastRunTokens = null;
                sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
                addDebugLog('info', `Tokens reset for inherited/branch chat ${currentChatId} (record owned by ${owner})`, {
                    subsystem: 'settings', event: 'tokens.reset', actor: 'SYSTEM', reason: 'BRANCH_INHERITED',
                    data: { chatId: currentChatId, ownerChatId: owner, isBranch: isBranchChat(currentChatId) },
                });

                saveTokensToMeta();
                return;
            }
            lastRunTokens = (stored.lastRun && typeof stored.lastRun === 'object') ? stored.lastRun : null;
            sessionTokens = (stored.session && typeof stored.session === 'object')
                ? stored.session
                : { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
        }
    } catch {  }
}

function saveTokensToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;

        md[TOKENS_META_KEY] = { lastRun: lastRunTokens, session: sessionTokens, ownerChatId: getCurrentChatId() || '' };
        ctx.saveMetadata?.();
    } catch {  }
}

export function setRunTokens(run) {

    const baselineInput = Number(run?.baselineInput) || 0;
    const actualInput   = Number(run?.actualInput) || 0;

    const agentInput    = Number(run?.agent3Input) || 0;
    const agentOutput   = Number(run?.agent3Output) || 0;

    lastRunTokens = { ...run, ts: Date.now(), approx: true };

    sessionTokens.baselineInput += baselineInput;
    sessionTokens.actualInput   += actualInput;
    sessionTokens.agentInput    += agentInput;
    sessionTokens.agentOutput   += agentOutput;

    if (baselineInput || actualInput || agentInput || agentOutput) {
        sessionTokens.runs += 1;
    }
    saveTokensToMeta();
    renderTokens();
}

export function addAgent3Tokens({ agent3Input = 0, agent3Output = 0 } = {}) {
    const inN = Number(agent3Input) || 0;
    const outN = Number(agent3Output) || 0;
    if (!inN && !outN) return;
    sessionTokens.agentInput += inN;
    sessionTokens.agentOutput += outN;
    if (lastRunTokens) {
        lastRunTokens.agent3Input = (Number(lastRunTokens.agent3Input) || 0) + inN;
        lastRunTokens.agent3Output = (Number(lastRunTokens.agent3Output) || 0) + outN;
    }
    saveTokensToMeta();
    renderTokens();
}

export function addReflectionTokens({ reflectionInput = 0, reflectionOutput = 0 } = {}) {
    const inN = Number(reflectionInput) || 0;
    const outN = Number(reflectionOutput) || 0;
    if (!inN && !outN) return;
    sessionTokens.agentInput += inN;
    sessionTokens.agentOutput += outN;
    if (lastRunTokens) {
        lastRunTokens.reflectionInput = (Number(lastRunTokens.reflectionInput) || 0) + inN;
        lastRunTokens.reflectionOutput = (Number(lastRunTokens.reflectionOutput) || 0) + outN;
    }
    saveTokensToMeta();
    renderTokens();
}

export function setMainOutputTokens(n) {
    const out = Number(n) || 0;
    if (lastRunTokens) lastRunTokens.mainOutput = out;
    sessionTokens.mainOutput += out;
    saveTokensToMeta();
    renderTokens();
}

export function reloadTokensFromChat() {
    lastRunTokens = null;
    sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
    loadTokensFromMeta();
    renderTokens();
}

const SHEET_META_KEY = 'bf_mem_sheet';

export const SHEET_SEED_TEXT = 'Story just beginning — no memories yet.';

let memorySheet = null;
let memorySheetLoaded = false; 

function seedSheet() {
    return {
        text: SHEET_SEED_TEXT,
        updatedAt: new Date().toISOString(),
        runId: '',
        sourceMessageIndex: -1,
        seeded: true,
    };
}

function normalizeSheet(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) return null; 
    const srcIdx = Math.floor(Number(raw.sourceMessageIndex));
    return {
        text,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
        sourceMessageIndex: Number.isInteger(srcIdx) ? srcIdx : -1,
        seeded: raw.seeded === true,
    };
}

function loadSheetFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizeSheet(md[SHEET_META_KEY]);
    } catch { return null; }
}

function saveSheetToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[SHEET_META_KEY] = memorySheet;
        ctx.saveMetadata?.();
    } catch {  }
}

export function getMemorySheet() {
    if (!memorySheetLoaded) {
        memorySheet = loadSheetFromMeta();
        memorySheetLoaded = true;
    }
    if (!memorySheet || !String(memorySheet.text || '').trim()) {
        memorySheet = seedSheet();
        saveSheetToMeta(); 
    }
    return memorySheet;
}

export function setMemorySheet(text, { runId = '', sourceMessageIndex = -1 } = {}) {
    const t = String(text ?? '').trim();
    if (!t) {
        addDebugLog('fail', 'setMemorySheet refused an empty sheet — keeping the previous one', {
            subsystem: 'pipeline', event: 'sheet.refused', reason: 'EMPTY_SHEET',
        });
        return;
    }
    const srcIdx = Math.floor(Number(sourceMessageIndex));
    memorySheet = {
        text: t,
        updatedAt: new Date().toISOString(),
        runId: typeof runId === 'string' ? runId : '',
        sourceMessageIndex: Number.isInteger(srcIdx) ? srcIdx : -1,
        seeded: false,
    };
    memorySheetLoaded = true;
    saveSheetToMeta();
    renderMemorySheet();
    addDebugLog('info', `Memory sheet updated (${t.length} chars, source msg ${memorySheet.sourceMessageIndex})`, {
        subsystem: 'pipeline', event: 'sheet.updated',
        data: { chars: t.length, sourceMessageIndex: memorySheet.sourceMessageIndex, runId: memorySheet.runId },
    });
}

export function reloadSheetFromChat() {
    memorySheet = loadSheetFromMeta();
    memorySheetLoaded = true;
    renderMemorySheet();
}

export function getMemorySheetText() {
    try { return String(memorySheet?.text || ''); } catch { return ''; }
}

export function renderMemorySheet() {
    try {
        const el = document.getElementById('bf_mem_sheet_view');
        if (!el) return;
        const rec = memorySheet;
        if (!rec || !String(rec.text || '').trim()) {
            el.innerHTML = '<div class="bf-mem-summary-empty">No memory sheet yet. It is rebuilt in the background after each reply.</div>';
            return;
        }
        el.innerHTML = `<pre style="white-space:pre-wrap;margin:0;">${escapeHtml(rec.text)}</pre>`;
    } catch {  }
}

const REFLECTION_META_KEY = 'bf_mem_reflection';

function normalizeReflection(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const observations = Array.isArray(raw.observations)
        ? raw.observations.map(x => String(x ?? '').trim()).filter(Boolean)
        : [];
    if (!summary && observations.length === 0) return null;
    return {
        summary,
        observations,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadReflectionFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizeReflection(md[REFLECTION_META_KEY]);
    } catch { return null; }
}

function saveReflectionToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[REFLECTION_META_KEY] = reflection;
        ctx.saveMetadata?.();
    } catch {  }
}

export function getReflection() {
    return reflection;
}

export function setReflection(patch, runId = '') {
    const next = normalizeReflection({ ...(patch || {}), updatedAt: Date.now(), runId });
    if (!next) return; 
    reflection = next;
    saveReflectionToMeta();
}

export function reloadReflectionFromChat() {
    reflection = loadReflectionFromMeta();
}

const PYRAMID_META_KEY = 'bf_mem_pyramid';

function normalizePyramid(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const story = typeof raw.story === 'string' ? raw.story.trim() : '';
    const shelves = {};
    if (raw.shelves && typeof raw.shelves === 'object' && !Array.isArray(raw.shelves)) {
        for (const [bucketKey, entry] of Object.entries(raw.shelves)) {
            if (!bucketKey || !entry || typeof entry !== 'object') continue;
            const text = typeof entry.text === 'string' ? entry.text.trim() : '';
            if (!text) continue; 
            shelves[String(bucketKey)] = {
                text,
                factCount: Number(entry.factCount) || 0,
                updatedAt: Number(entry.updatedAt) || Date.now(),
            };
        }
    }
    if (!story && Object.keys(shelves).length === 0) return null;
    return {
        story,
        shelves,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadPyramidFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizePyramid(md[PYRAMID_META_KEY]);
    } catch { return null; }
}

function savePyramidToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[PYRAMID_META_KEY] = summaryPyramid;
        ctx.saveMetadata?.();
    } catch {  }
}

export function getSummaryPyramid() {
    return summaryPyramid;
}

export function setSummaryPyramid(pyramid, runId = '') {
    const next = normalizePyramid({ ...(pyramid || {}), updatedAt: Date.now(), runId });
    if (!next) return; 
    summaryPyramid = next;
    savePyramidToMeta();
}

export function reloadPyramidFromChat() {
    summaryPyramid = loadPyramidFromMeta();
}

const STORY_SPINE_META_KEY = 'bf_mem_story_spine';

let storySpine = null;
let storySpineLoaded = false;

function normalizeStorySpineBatch(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const sentence = typeof raw.sentence === 'string' ? raw.sentence.trim() : '';
    if (!sentence) return null;
    const batchIndex = Math.floor(Number(raw.batchIndex));
    if (!Number.isInteger(batchIndex) || batchIndex < 0) return null;
    const startMsg = Math.floor(Number(raw.startMsg));
    const endMsg = Math.floor(Number(raw.endMsg));
    return {
        batchIndex,
        startMsg: Number.isInteger(startMsg) ? startMsg : batchIndex * 10,
        endMsg: Number.isInteger(endMsg) ? endMsg : batchIndex * 10 + 9,
        sentence,
    };
}

function normalizeStorySpine(raw) {
    if (!Array.isArray(raw)) return null;
    const seen = new Set();
    const out = [];
    for (const entry of raw) {
        const b = normalizeStorySpineBatch(entry);
        if (!b || seen.has(b.batchIndex)) continue;
        seen.add(b.batchIndex);
        out.push(b);
    }
    out.sort((a, b) => a.batchIndex - b.batchIndex);
    return out;
}

function loadStorySpineFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizeStorySpine(md[STORY_SPINE_META_KEY]);
    } catch { return null; }
}

function saveStorySpineToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[STORY_SPINE_META_KEY] = storySpine;
        ctx.saveMetadata?.();
    } catch {  }
}

export function getStorySpine() {
    if (!storySpineLoaded) {
        storySpine = loadStorySpineFromMeta() || [];
        storySpineLoaded = true;
    }
    return Array.isArray(storySpine) ? storySpine : [];
}

// Append-only: a given batchIndex is summarized ONCE. Re-appending an existing
// batch is a no-op (idempotency guard), so the deterministic spine only grows.
export function appendStorySpineBatch(batch) {
    const b = normalizeStorySpineBatch(batch);
    if (!b) return false;
    const spine = getStorySpine();
    if (spine.some(e => e.batchIndex === b.batchIndex)) return false;
    spine.push(b);
    spine.sort((a, b) => a.batchIndex - b.batchIndex);
    storySpine = spine;
    storySpineLoaded = true;
    saveStorySpineToMeta();
    return true;
}

export function setStorySpine(arr) {
    storySpine = normalizeStorySpine(arr) || [];
    storySpineLoaded = true;
    saveStorySpineToMeta();
}

export function reloadStorySpineFromChat() {
    storySpine = loadStorySpineFromMeta() || [];
    storySpineLoaded = true;
}

// SCENE STORE: the agent-decided current scene { startMsg, name, beats:[{msgIndex,
// sentence}] } plus the list of scenes it has already closed. Unlike the spine
// (deterministic 10-message batches), scene boundaries are chosen by the agent via
// a SCENE_MARKER, and each newly-settled message adds ONE beat to the current card.
const SCENE_META_KEY = 'bf_mem_scene';

let sceneStore = null;
let sceneStoreLoaded = false;

function normalizeBeat(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const sentence = typeof raw.sentence === 'string' ? raw.sentence.trim() : '';
    if (!sentence) return null;
    const msgIndex = Math.floor(Number(raw.msgIndex));
    return { msgIndex: Number.isInteger(msgIndex) ? msgIndex : -1, sentence };
}

const SCENE_PRESENT_CAP = 16;

function normalizePresent(raw) {
    const out = [];
    const seen = new Set();
    for (const entry of (Array.isArray(raw) ? raw : [])) {
        const n = String(entry ?? '').trim().replace(/^@/, '');
        if (!n) continue;
        const k = n.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(n);
        if (out.length >= SCENE_PRESENT_CAP) break;
    }
    return out;
}

function normalizeScene(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    const startMsg = Math.floor(Number(raw.startMsg));
    const beats = [];
    const seen = new Set();
    if (Array.isArray(raw.beats)) {
        for (const entry of raw.beats) {
            const b = normalizeBeat(entry);
            if (!b) continue;
            if (b.msgIndex >= 0) {
                if (seen.has(b.msgIndex)) continue;
                seen.add(b.msgIndex);
            }
            beats.push(b);
        }
    }
    const present = normalizePresent(raw.present);
    if (!name && beats.length === 0 && present.length === 0 && !Number.isInteger(startMsg)) return null;
    return { startMsg: Number.isInteger(startMsg) ? startMsg : -1, name, beats, present };
}

function normalizeSceneStore(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const current = normalizeScene(raw.current);
    const closed = [];
    if (Array.isArray(raw.closed)) {
        for (const s of raw.closed) {
            const ns = normalizeScene(s);
            if (ns) closed.push(ns);
        }
    }
    if (!current && closed.length === 0) return null;
    return { current: current || null, closed };
}

function loadSceneFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizeSceneStore(md[SCENE_META_KEY]);
    } catch { return null; }
}

function saveSceneToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[SCENE_META_KEY] = sceneStore;
        ctx.saveMetadata?.();
    } catch {  }
}

function getSceneStore() {
    if (!sceneStoreLoaded) {
        sceneStore = loadSceneFromMeta() || { current: null, closed: [] };
        sceneStoreLoaded = true;
    }
    return (sceneStore && typeof sceneStore === 'object') ? sceneStore : { current: null, closed: [] };
}

export function getCurrentScene() {
    return getSceneStore().current || null;
}

export function getClosedScenes() {
    const closed = getSceneStore().closed;
    return Array.isArray(closed) ? closed : [];
}

// A new marker fired: close the current card (if it holds anything) and open a
// fresh one starting at startMsg with the given name.
export function startScene({ startMsg = -1, name = '' } = {}) {
    const store = getSceneStore();
    const cur = store.current;
    if (cur && (cur.beats.length > 0 || cur.name)) store.closed.push(cur);
    const s = Math.floor(Number(startMsg));
    store.current = { startMsg: Number.isInteger(s) ? s : -1, name: String(name || '').trim(), beats: [], present: [] };
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
    return store.current;
}

// Who is physically in the current scene (agent-reported via the sheet's
// PRESENT line). Replaces the whole list each time — presence is a snapshot,
// not an accumulator. Auto-opens an unnamed scene card when none is active.
export function setScenePresent(names) {
    const present = normalizePresent(names);
    const store = getSceneStore();
    if (!store.current) store.current = { startMsg: -1, name: '', beats: [], present: [] };
    store.current.present = present;
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
    return present;
}

export function getScenePresent() {
    const cur = getSceneStore().current;
    return (cur && Array.isArray(cur.present)) ? cur.present : [];
}

// Append newly-settled beats to the current card, de-duping by msgIndex. Auto-opens
// an unnamed card when no scene is active yet (beats without a prior marker).
export function appendSceneBeats(beats) {
    const list = Array.isArray(beats) ? beats : [];
    if (list.length === 0) return false;
    const store = getSceneStore();
    if (!store.current) {
        const first = normalizeBeat(list[0]);
        store.current = { startMsg: (first && first.msgIndex >= 0) ? first.msgIndex : -1, name: '', beats: [], present: [] };
    }
    const cur = store.current;
    const seen = new Set(cur.beats.filter(b => b.msgIndex >= 0).map(b => b.msgIndex));
    // Index-less beats (agent omitted the "| <index>") can't be de-duped by msgIndex,
    // so track their sentence text too — otherwise a re-emitted index-less beat would
    // stack a duplicate line every run.
    const seenText = new Set(cur.beats.filter(b => b.msgIndex < 0).map(b => String(b.sentence || '').trim().toLowerCase()));
    let added = 0;
    for (const raw of list) {
        const b = normalizeBeat(raw);
        if (!b) continue;
        if (b.msgIndex >= 0) {
            if (seen.has(b.msgIndex)) continue;
            seen.add(b.msgIndex);
        } else {
            const t = String(b.sentence || '').trim().toLowerCase();
            if (!t || seenText.has(t)) continue;
            seenText.add(t);
        }
        cur.beats.push(b);
        added++;
    }
    if (added === 0) return false;
    cur.beats.sort((a, b) => (a.msgIndex < 0 || b.msgIndex < 0) ? 0 : a.msgIndex - b.msgIndex);
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
    return true;
}

export function setSceneStore(raw) {
    sceneStore = normalizeSceneStore(raw) || { current: null, closed: [] };
    sceneStoreLoaded = true;
    saveSceneToMeta();
}

export function reloadSceneFromChat() {
    sceneStore = loadSceneFromMeta() || { current: null, closed: [] };
    sceneStoreLoaded = true;
}

function renderTokens() {
    const lastEl = document.getElementById('bf_mem_tokens_lastrun');
    const sessEl = document.getElementById('bf_mem_tokens_session');
    const banner = document.getElementById('bf_mem_tokens_banner');
    if (!lastEl) return;

    if (!lastRunTokens) {
        lastEl.innerHTML = '<div class="bf-mem-summary-empty">No generations yet. Send a message — token comparison appears after the first pipeline run.</div>';
        if (sessEl) sessEl.innerHTML = '<div class="bf-mem-summary-empty">No generations yet this session.</div>';
        if (banner) banner.style.display = 'none';
        return;
    }

    const L = lastRunTokens;

    const rIn = L.reflectionInput || 0, rOut = L.reflectionOutput || 0;
    const extIn = (L.actualInput || 0) + (L.agent3Input || 0) + rIn;
    const extOut = (L.mainOutput || 0) + (L.agent3Output || 0) + rOut;
    const netIn = extIn - (L.baselineInput || 0);   
    const netOut = extOut - (L.mainOutput || 0);     

    const trimOff = (L.baselineInput > 0) && (L.actualInput >= L.baselineInput * 0.97);
    if (banner) {
        banner.style.display = trimOff ? 'block' : 'none';
        banner.textContent = trimOff
            ? 'Writer trim is OFF — the main model sees the full chat, so there are no input savings. The agent calls below are pure overhead (the tradeoff for memory recall). Turn on "Context Limit" in the Writer tab to save input tokens.'
            : '';
    }

    const netInClass = netIn < 0 ? 'bf-mem-tok-save' : 'bf-mem-tok-bad';
    const netInStr = (netIn < 0 ? '' : '+') + fmt(netIn);

    lastEl.innerHTML = `
        <table class="bf-mem-db-table">
            <thead><tr><th></th><th>Input</th><th>Output</th></tr></thead>
            <tbody>
                <tr><td>Baseline (full chat)</td><td>${fmt(L.baselineInput)}</td><td>${fmt(L.mainOutput)}</td></tr>
                <tr><td>— Main model</td><td>${fmt(L.actualInput)}</td><td>${fmt(L.mainOutput)}</td></tr>
                <tr><td>— Memory Agent</td><td>${fmt(L.agent3Input)}</td><td>${fmt(L.agent3Output)}</td></tr>
                <tr><td>— Reflection</td><td>${fmt(rIn)}</td><td>${fmt(rOut)}</td></tr>
                <tr><td><b>Extension total</b></td><td><b>${fmt(extIn)}</b></td><td><b>${fmt(extOut)}</b></td></tr>
                <tr><td><b>NET vs baseline</b></td><td class="${netInClass}">${netInStr}</td><td class="bf-mem-tok-cost">+${fmt(netOut)}</td></tr>
            </tbody>
        </table>
        <small class="bf-mem-hint">Approx. token counts (local tokenizer). Negative input = saved; output overhead is the agent calls.</small>`;

    if (sessEl) {
        const s = sessionTokens;
        const sExtIn = (s.actualInput || 0) + (s.agentInput || 0);
        const sExtOut = (s.mainOutput || 0) + (s.agentOutput || 0);
        const sNetIn = sExtIn - (s.baselineInput || 0);
        const sNetClass = sNetIn < 0 ? 'bf-mem-tok-save' : 'bf-mem-tok-bad';
        sessEl.innerHTML = `
            <table class="bf-mem-db-table">
                <thead><tr><th>${s.runs} run(s)</th><th>Input</th><th>Output</th></tr></thead>
                <tbody>
                    <tr><td>Baseline total</td><td>${fmt(s.baselineInput)}</td><td>${fmt(s.mainOutput)}</td></tr>
                    <tr><td>Extension total</td><td>${fmt(sExtIn)}</td><td>${fmt(sExtOut)}</td></tr>
                    <tr><td><b>NET</b></td><td class="${sNetClass}">${(sNetIn < 0 ? '' : '+') + fmt(sNetIn)}</td><td class="bf-mem-tok-cost">+${fmt(sExtOut - (s.mainOutput || 0))}</td></tr>
                </tbody>
            </table>`;
    }
}

export function getLastRunTokens() {
    return lastRunTokens;
}

export function getSessionTokens() {
    return sessionTokens;
}

export function getLastGenerated() {
    return lastGenerated;
}

export function getLastInserted() {
    return lastInserted;
}

export function resetSessionTokens() {
    sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
    saveTokensToMeta();
    renderTokens();
}
