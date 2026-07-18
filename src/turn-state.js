import { addDebugLog } from './debug-log.js';

import { getContext, escapeHtml, fmt, getCurrentChatId, isBranchChat } from './ui-util.js';

let lastGenerated = { runId: null, timestamp: null, updates: [] };
let lastInserted = { runId: null, timestamp: null, updates: [] };
let lastRunTokens = null;

// Per-chat running totals (persisted in chatMetadata). memIn/memOut = Memory
// Agent, reflIn/reflOut = Reflection — kept separate so the Agents panel can
// split them. Older saves stored a combined agentInput/agentOutput pair;
// normalizeSession() migrates those into the memory-agent bucket on load.
function emptySession() {
    return { baselineInput: 0, actualInput: 0, mainOutput: 0, sheetTokens: 0, memInput: 0, memOutput: 0, reflInput: 0, reflOutput: 0, runs: 0 };
}

function normalizeSession(raw) {
    const s = (raw && typeof raw === 'object') ? raw : {};
    return {
        baselineInput: Number(s.baselineInput) || 0,
        actualInput: Number(s.actualInput) || 0,
        mainOutput: Number(s.mainOutput) || 0,
        sheetTokens: Number(s.sheetTokens) || 0,
        memInput: Number(s.memInput ?? s.agentInput) || 0,
        memOutput: Number(s.memOutput ?? s.agentOutput) || 0,
        reflInput: Number(s.reflInput) || 0,
        reflOutput: Number(s.reflOutput) || 0,
        runs: Number(s.runs) || 0,
    };
}

let sessionTokens = emptySession();

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
            const owner = typeof stored.ownerChatId === 'string' ? stored.ownerChatId : '';
            // Only a NON-EMPTY owner that differs marks a branch/inherited copy.
            // An empty owner (saved while the chat id was briefly unavailable)
            // must NOT wipe this chat's own totals on reload.
            const inherited = !!currentChatId && !!owner && owner !== currentChatId;
            if (inherited) {
                lastRunTokens = null;
                sessionTokens = emptySession();
                addDebugLog('info', `Tokens reset for inherited/branch chat ${currentChatId} (record owned by ${owner})`, {
                    subsystem: 'settings', event: 'tokens.reset', actor: 'SYSTEM', reason: 'BRANCH_INHERITED',
                    data: { chatId: currentChatId, ownerChatId: owner, isBranch: isBranchChat(currentChatId) },
                });

                saveTokensToMeta();
                return;
            }
            lastRunTokens = (stored.lastRun && typeof stored.lastRun === 'object') ? stored.lastRun : null;
            sessionTokens = normalizeSession(stored.session);
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

// One call per generation, from the injection hook: baseline = the prompt as
// SillyTavern built it WITHOUT the extension (full chat up to the context
// limit); actual = what was really sent (trimmed chat + memory sheet).
// Starts a fresh lastRun record — agent/reflection/output tokens for this turn
// arrive later via the add*/set* calls below.
export function setRunTokens(run) {

    const baselineInput = Number(run?.baselineInput) || 0;
    const actualInput   = Number(run?.actualInput) || 0;
    const sheetTokens   = Number(run?.sheetTokens) || 0;

    lastRunTokens = { ...run, ts: Date.now(), approx: true };

    sessionTokens.baselineInput += baselineInput;
    sessionTokens.actualInput   += actualInput;
    sessionTokens.sheetTokens   += sheetTokens;

    if (baselineInput || actualInput) {
        sessionTokens.runs += 1;
    }
    saveTokensToMeta();
    renderTokens();
}

export function addAgent3Tokens({ agent3Input = 0, agent3Output = 0 } = {}) {
    const inN = Number(agent3Input) || 0;
    const outN = Number(agent3Output) || 0;
    if (!inN && !outN) return;
    sessionTokens.memInput += inN;
    sessionTokens.memOutput += outN;
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
    sessionTokens.reflInput += inN;
    sessionTokens.reflOutput += outN;
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
    sessionTokens = emptySession();
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
    const out = {
        batchIndex,
        startMsg: Number.isInteger(startMsg) ? startMsg : batchIndex * 10,
        endMsg: Number.isInteger(endMsg) ? endMsg : batchIndex * 10 + 9,
        sentence,
    };
    // Stable uid of the LAST message this batch covers — the deletion-proof
    // anchor the pipeline resumes from when computing the next batch.
    const endUid = typeof raw.endUid === 'string' ? raw.endUid.trim() : '';
    if (endUid) out.endUid = endUid;
    return out;
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
    const out = { msgIndex: Number.isInteger(msgIndex) ? msgIndex : -1, sentence };
    // Stable per-message id (extra.bf_uid) when the caller could resolve one —
    // survives message deletions that shift raw chat indices.
    const uid = typeof raw.uid === 'string' ? raw.uid.trim() : '';
    if (uid) out.uid = uid;
    return out;
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

// Closed scenes are a browsable archive in the sheet popup, but chatMetadata
// travels with every chat save — cap the archive at the newest entries so a
// very long roleplay can't grow the chat file without bound.
const MAX_CLOSED_SCENES = 50;

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
    if (closed.length > MAX_CLOSED_SCENES) closed.splice(0, closed.length - MAX_CLOSED_SCENES);
    const timeline = typeof raw.timeline === 'string' ? raw.timeline.trim() : '';
    if (!current && closed.length === 0 && !timeline) return null;
    return { current: current || null, closed, timeline };
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
        sceneStore = loadSceneFromMeta() || { current: null, closed: [], timeline: '' };
        sceneStoreLoaded = true;
    }
    return (sceneStore && typeof sceneStore === 'object') ? sceneStore : { current: null, closed: [], timeline: '' };
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
    const s0 = Math.floor(Number(startMsg));
    const s = Number.isInteger(s0) ? s0 : -1;
    const nm = String(name || '').trim();
    // Idempotency guard: agents sometimes re-emit the marker for the scene that
    // is already open (same start index, or same name without a usable index).
    // Without this the open card would be closed and reopened, fragmenting its
    // beats across duplicate cards. Treat a repeat as "scene continues".
    if (cur) {
        const sameStart = s >= 0 && s === cur.startMsg;
        const sameName = !!nm && !!cur.name && nm.toLowerCase() === cur.name.toLowerCase();
        if (sameStart || (sameName && s < 0)) {
            if (nm && !cur.name) { cur.name = nm; saveSceneToMeta(); }
            return cur;
        }
    }
    // A marker pointing at an ALREADY-CLOSED scene's start index is a stale
    // re-emission (e.g. a retry replaying an old sheet) — never reopen it.
    if (s >= 0 && store.closed.some(c => c && c.startMsg === s)) return cur || null;
    if (cur && (cur.beats.length > 0 || cur.name)) {
        store.closed.push(cur);
        if (store.closed.length > MAX_CLOSED_SCENES) store.closed.splice(0, store.closed.length - MAX_CLOSED_SCENES);
    }
    store.current = { startMsg: s, name: nm, beats: [], present: [] };
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
    // Primary de-dup key: the stable per-message uid (extra.bf_uid). Chat indices
    // shift when older messages are deleted, so a raw index can be REUSED by a
    // different message — the uid disambiguates and prevents a genuinely new beat
    // from being swallowed by a stale index match.
    const seenUid = new Set(cur.beats.map(b => b.uid).filter(Boolean));
    // Index-less beats (agent omitted the "| <index>") can't be de-duped by msgIndex,
    // so track their sentence text too — otherwise a re-emitted index-less beat would
    // stack a duplicate line every run.
    const seenText = new Set(cur.beats.filter(b => b.msgIndex < 0).map(b => String(b.sentence || '').trim().toLowerCase()));
    let added = 0;
    for (const raw of list) {
        const b = normalizeBeat(raw);
        if (!b) continue;
        if (b.uid) {
            // Skip when either key already covers this message: the uid, or the
            // index (beats stored before uids existed carry only the index).
            if (seenUid.has(b.uid) || (b.msgIndex >= 0 && seen.has(b.msgIndex))) continue;
            seenUid.add(b.uid);
            if (b.msgIndex >= 0) seen.add(b.msgIndex);
        } else if (b.msgIndex >= 0) {
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
    // Transitive comparator: index-less beats sort to the end (stable, so they
    // keep their insertion order); indexed beats sort strictly by msgIndex.
    cur.beats.sort((a, b) => {
        const ai = a.msgIndex >= 0 ? a.msgIndex : Number.MAX_SAFE_INTEGER;
        const bi = b.msgIndex >= 0 ? b.msgIndex : Number.MAX_SAFE_INTEGER;
        return ai - bi;
    });
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
    return true;
}

export function setSceneStore(raw) {
    sceneStore = normalizeSceneStore(raw) || { current: null, closed: [], timeline: '' };
    sceneStoreLoaded = true;
    saveSceneToMeta();
}

export function reloadSceneFromChat() {
    sceneStore = loadSceneFromMeta() || { current: null, closed: [], timeline: '' };
    sceneStoreLoaded = true;
}

// Last known "Timeline & place" line. Persisted so a single agent run that
// omits TIMELINE doesn't blank the sheet's time/place grounding — composeSheet
// falls back to this value until a later run refreshes it.
export function getSceneTimeline() {
    const t = getSceneStore().timeline;
    return typeof t === 'string' ? t : '';
}

export function setSceneTimeline(text) {
    const t = String(text ?? '').trim();
    if (!t) return;
    const store = getSceneStore();
    store.timeline = t;
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
}

// Signed diff cell: negative (saved) renders green, positive (extra cost) red.
function diffCell(n) {
    const cls = n < 0 ? 'bf-mem-tok-save' : (n > 0 ? 'bf-mem-tok-bad' : '');
    return `<td class="${cls}">${(n > 0 ? '+' : '') + fmt(n)}</td>`;
}

// Three panels, each showing the LAST message next to the CHAT total:
//   1. Input — what the main model would read without the extension (full chat)
//      vs. what it actually read (trimmed context + memory sheet). Input only.
//   2. Agents — what the background Memory Agent / Reflection calls consumed.
//   3. Total — everything combined: without extension vs. with extension.
export function renderTokens() {
    const inputEl = document.getElementById('bf_mem_tokens_input');
    const agentsEl = document.getElementById('bf_mem_tokens_agents');
    const totalEl = document.getElementById('bf_mem_tokens_total');
    const banner = document.getElementById('bf_mem_tokens_banner');
    if (!inputEl && !agentsEl && !totalEl) return;

    const s = sessionTokens;
    const L = lastRunTokens;

    if (!L && !s.runs) {
        const empty = '<div class="bf-mem-summary-empty">No generations yet. Send a message — numbers appear after the first reply.</div>';
        if (inputEl) inputEl.innerHTML = empty;
        if (agentsEl) agentsEl.innerHTML = empty;
        if (totalEl) totalEl.innerHTML = empty;
        if (banner) banner.style.display = 'none';
        return;
    }

    // Last-message cell: '—' when the last run isn't known (e.g. after reload
    // before the next reply) so the chat totals still show.
    const lv = (n) => L ? fmt(Number(n) || 0) : '—';
    const num = (n) => Number(n) || 0;

    // Text-completion APIs (Kobold, textgen, Horde …) have no trim path at all —
    // the sheet always rides on top of the full prompt, so "turn on trim" would
    // be misleading advice there.
    const isTextPath = L?.path === 'text';
    const trimOff = L && !isTextPath && (num(L.baselineInput) > 0) && (num(L.actualInput) >= num(L.baselineInput) * 0.97);
    if (banner) {
        banner.style.display = (trimOff || isTextPath) ? 'block' : 'none';
        banner.textContent = isTextPath
            ? 'Text-completion API detected — the extension cannot trim chat history on this path, so the memory sheet is always a small extra cost (the tradeoff for memory recall). Input savings require a chat-completion API with the Writer history limit enabled.'
            : (trimOff
                ? 'Writer trim is OFF — the main model sees the full chat, so there are no input savings. The agent calls are pure overhead (the tradeoff for memory recall). Turn on "Context Limit" in the Writer tab to save input tokens.'
                : '');
    }

    if (inputEl) {
        const lDiff = L ? num(L.actualInput) - num(L.baselineInput) : 0;
        const sDiff = num(s.actualInput) - num(s.baselineInput);
        inputEl.innerHTML = `
            <table class="bf-mem-db-table">
                <thead><tr><th></th><th>Last message</th><th>Chat total (${s.runs} run${s.runs === 1 ? '' : 's'})</th></tr></thead>
                <tbody>
                    <tr><td>Without extension (full chat)</td><td>${lv(L?.baselineInput)}</td><td>${fmt(num(s.baselineInput))}</td></tr>
                    <tr><td>With extension (context + memory sheet)</td><td>${lv(L?.actualInput)}</td><td>${fmt(num(s.actualInput))}</td></tr>
                    <tr><td class="bf-mem-hint">&nbsp;&nbsp;of which memory sheet</td><td class="bf-mem-hint">${lv(L?.sheetTokens)}</td><td class="bf-mem-hint">${fmt(num(s.sheetTokens))}</td></tr>
                    <tr><td><b>Difference</b></td>${L ? diffCell(lDiff) : '<td>—</td>'}${diffCell(sDiff)}</tr>
                </tbody>
            </table>
            <small class="bf-mem-hint">Input tokens for the main model only. Negative difference (green) = the extension saved that many input tokens.</small>`;
    }

    if (agentsEl) {
        const lMemIn = num(L?.agent3Input), lMemOut = num(L?.agent3Output);
        const lRefIn = num(L?.reflectionInput), lRefOut = num(L?.reflectionOutput);
        agentsEl.innerHTML = `
            <table class="bf-mem-db-table">
                <thead><tr><th></th><th colspan="2">Last message</th><th colspan="2">Chat total</th></tr>
                <tr><th></th><th>In</th><th>Out</th><th>In</th><th>Out</th></tr></thead>
                <tbody>
                    <tr><td>Memory Agent</td><td>${lv(lMemIn)}</td><td>${lv(lMemOut)}</td><td>${fmt(num(s.memInput))}</td><td>${fmt(num(s.memOutput))}</td></tr>
                    <tr><td>Reflection</td><td>${lv(lRefIn)}</td><td>${lv(lRefOut)}</td><td>${fmt(num(s.reflInput))}</td><td>${fmt(num(s.reflOutput))}</td></tr>
                    <tr><td><b>Agents total</b></td><td><b>${lv(lMemIn + lRefIn)}</b></td><td><b>${lv(lMemOut + lRefOut)}</b></td><td><b>${fmt(num(s.memInput) + num(s.reflInput))}</b></td><td><b>${fmt(num(s.memOutput) + num(s.reflOutput))}</b></td></tr>
                </tbody>
            </table>
            <small class="bf-mem-hint">Background LLM calls this extension makes on top of your chat. Reflection runs only every ~12 replies, so it is often 0.</small>`;
    }

    if (totalEl) {
        const lWithoutIn = num(L?.baselineInput), lWithoutOut = num(L?.mainOutput);
        const lWithIn = num(L?.actualInput) + num(L?.agent3Input) + num(L?.reflectionInput);
        const lWithOut = num(L?.mainOutput) + num(L?.agent3Output) + num(L?.reflectionOutput);
        const sWithIn = num(s.actualInput) + num(s.memInput) + num(s.reflInput);
        const sWithOut = num(s.mainOutput) + num(s.memOutput) + num(s.reflOutput);
        totalEl.innerHTML = `
            <table class="bf-mem-db-table">
                <thead><tr><th></th><th colspan="2">Last message</th><th colspan="2">Chat total</th></tr>
                <tr><th></th><th>In</th><th>Out</th><th>In</th><th>Out</th></tr></thead>
                <tbody>
                    <tr><td>Without extension</td><td>${lv(lWithoutIn)}</td><td>${lv(lWithoutOut)}</td><td>${fmt(num(s.baselineInput))}</td><td>${fmt(num(s.mainOutput))}</td></tr>
                    <tr><td>With extension</td><td>${lv(lWithIn)}</td><td>${lv(lWithOut)}</td><td>${fmt(sWithIn)}</td><td>${fmt(sWithOut)}</td></tr>
                    <tr><td><b>Difference</b></td>${L ? diffCell(lWithIn - lWithoutIn) : '<td>—</td>'}${L ? diffCell(lWithOut - lWithoutOut) : '<td>—</td>'}${diffCell(sWithIn - num(s.baselineInput))}${diffCell(sWithOut - num(s.mainOutput))}</tr>
                </tbody>
            </table>
            <small class="bf-mem-hint">The whole picture: everything the LLM reads and writes with the extension vs. without it. Approx. counts (local tokenizer).</small>`;
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
    sessionTokens = emptySession();
    lastRunTokens = null;
    saveTokensToMeta();
    renderTokens();
}
