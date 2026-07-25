import { addDebugLog, isTraceRecording } from './debug-log.js';

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
    recordSheetHistory(memorySheet);
    saveSheetToMeta();
    renderMemorySheet();
    addDebugLog('info', `Memory sheet updated (${t.length} chars, source msg ${memorySheet.sourceMessageIndex})`, {
        subsystem: 'pipeline', event: 'sheet.updated',
        data: { chars: t.length, sourceMessageIndex: memorySheet.sourceMessageIndex, runId: memorySheet.runId },
    });
}

// --- Injected-sheet history (RAM ONLY, test-run recording) ------------------
//
// setMemorySheet OVERWRITES chatMetadata.bf_mem_sheet every turn and the
// sheet.updated line above carries only a character count, so once a reply has
// been generated there is no way left to see WHICH sheet sat above it. That is
// exactly the question "the memory forgot Portugal" asks.
//
// The ring lives here rather than on the debug ring on purpose. The debug ring
// is 2000 entries shared with every other capture, so a long recording evicts
// the oldest sheets first — the ones a regression hunt reaches furthest back
// for. Keeping it separate also stores each sheet ONCE instead of once per trace
// entry that would otherwise quote it.
//
// Nothing here is persisted: no chatMetadata write, no attachment, and the ring
// is dropped on chat switch (reloadSheetFromChat) so one chat's sheets can never
// turn up in another chat's export.
//
// N = 50. The sizing rule is "every trace entry still on the debug ring should
// still have its sheet". A recorded turn emits on the order of 40 trace entries
// (three LLM calls with their prompts and replies, plus the tool reads and
// writes), so the 2000-entry debug ring spans roughly 50 turns. Matching that
// costs at most 50 x SHEET_HISTORY_MAX_CHARS = 600 KB of strings — a rounding
// error next to the debug ring's own worst case, and typically far less because
// a real sheet is a few KB.
const SHEET_HISTORY_MAX = 50;
// Mirrors the trace layer's per-string cap. A sheet is normally well under this;
// the cap exists only so a runaway sheet cannot make the ring unbounded, and the
// cut is marked in the text rather than hidden.
const SHEET_HISTORY_MAX_CHARS = 12000;

let sheetHistory = [];

// Guarded on the record switch: with recording off this is one property read and
// a return — no copy, no string work, no growth.
function recordSheetHistory(rec) {
    if (!isTraceRecording()) return;
    try {
        const text = String(rec?.text ?? '');
        sheetHistory.push({
            runId: String(rec?.runId ?? ''),
            sourceMessageIndex: Number.isInteger(rec?.sourceMessageIndex) ? rec.sourceMessageIndex : -1,
            updatedAt: String(rec?.updatedAt ?? ''),
            chars: text.length,
            text: text.length > SHEET_HISTORY_MAX_CHARS
                ? text.slice(0, SHEET_HISTORY_MAX_CHARS) + `\n…[BF-TRACE TRUNCATED: kept ${SHEET_HISTORY_MAX_CHARS} of ${text.length} chars]`
                : text,
        });
        if (sheetHistory.length > SHEET_HISTORY_MAX) sheetHistory.splice(0, sheetHistory.length - SHEET_HISTORY_MAX);
    } catch {  }
}

// Oldest first, newest last — the order the sheets were injected in, which is
// the order an export wants to read them. Fresh array of fresh entries so a
// consumer cannot reorder or edit the ring.
export function getSheetHistory() {
    return sheetHistory.map(e => ({ ...e }));
}

// NOT called when the record switch goes off — that was the old behaviour, and
// it destroyed the recording the UI had just promised was still downloadable.
// The ring now lives until reload or chat switch (reloadSheetFromChat below),
// which is what the switch's toast says. Kept as an exported escape hatch for a
// caller that genuinely wants the several hundred KB of sheet text back.
export function clearSheetHistory() {
    sheetHistory = [];
}

export function reloadSheetFromChat() {
    memorySheet = loadSheetFromMeta();
    memorySheetLoaded = true;
    // Chat-scoped, like every trace: entries carry no chat id, so keeping them
    // across a switch would silently mix two stories in one export.
    sheetHistory = [];
    renderMemorySheet();
}

export function getMemorySheetText() {
    try { return String(memorySheet?.text || ''); } catch { return ''; }
}

// --- Which facts a composed sheet actually carried -------------------------
//
// The sheet TEXT is the only record of what the storyteller really saw: it
// includes the premise-floor rows and the random-walk extras that no ref list
// ever passes through, and it EXCLUDES refs composeSheet resolved away as
// inactive/invisible/cold. getLastNeedRefs() is neither — it is the agent's
// request, not the delivery. So "what was injected" is answered by parsing the
// sheet back, which is the same conclusion agent-memory.js reached for its
// "## Injected last turn" block.
//
// DUPLICATION, stated plainly: agent-memory.js holds a private SHEET_REF_RE and
// extractPriorSheetRefs() with this exact grammar. This is a second copy, not a
// reuse — the injection path lives in pipeline.js and the prompt-side helper is
// not exported. They must be changed together; the intended cleanup is to delete
// the private copy and import this one.
//
// Grammar (copied verbatim, see agent-memory.js for the full derivation): a fact
// row is `[knownBy] Category/key` followed by end, whitespace, `:`, `=` or the
// recency `(`. Keys come from keyToken() so any Unicode letter/digit is legal;
// categories are user-extensible and unsanitized beyond a trim, hence the lazy
// unrestricted category capture terminated by the first `/` that is followed by
// a key and a real terminator. The sheet's other bracketed lines (header,
// precedence preamble) end at the `]` and never match.
const SHEET_FACT_REF_RE = /^\[[^\]]*\]\s+(.+?)\/([\p{L}\p{N}_]+)(?=$|[\s:=(])/u;

// Returns "Category/key" strings, deduped, in sheet order. Pure — no state, no
// context read — so a caller can hold a sheet string captured at injection time
// and resolve it much later without the live sheet having to still be that one.
export function extractSheetFactRefs(sheetText) {
    const out = [];
    const seen = new Set();
    for (const line of String(sheetText || '').split('\n')) {
        const m = SHEET_FACT_REF_RE.exec(line.trim());
        if (!m) continue;
        const category = m[1].trim();
        if (!category) continue;
        const ref = `${category}/${m[2]}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push(ref);
    }
    return out;
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

// STICKY RECOVERED REFS. A ref the extraction agent recovers via OMISSION
// RECOVERY (fact IS in the store, was ABSENT from the sheet the fumbled reply
// saw) used to survive exactly ONE turn: the next turn it appeared on the
// "## Injected last turn" list, and the prompt's "a ref ON it is already
// covered, do NOT re-list it" rule dropped it straight back out — so the
// identical fumble could recur immediately. A recovered ref therefore carries a
// TTL in turns and composeSheet re-injects it until the TTL runs out.
//
// K = 4 turns. It mirrors bufferHoldBack's default (4): that is how many replies
// stay TENTATIVE, i.e. how long the SAME fumbled exchange keeps being re-judged
// by the extraction agent — so the ref stays on the sheet for the whole span in
// which the agent can still see whether the storyteller actually used it. Four
// turns is also ~8 messages: long enough for a hedged topic to come back up,
// short enough that a mistaken recovery costs a handful of rows and then expires
// on its own without anyone having to undo it.
const RECOVERED_REF_TTL_TURNS = 4;
// The prompt allows at most 3 recoveries per turn; enforced here too, because
// prompt compliance is never a guarantee. TTL x per-turn is therefore a HARD
// ceiling on the sticky set — it cannot grow without bound. The set lives in the
// scene store, i.e. in chatMetadata, so it is chat-scoped: reloadSceneFromChat
// swaps it out on CHAT_CHANGED and it can never leak into a different chat.
const RECOVERED_REFS_PER_TURN = 3;
const RECOVERED_REFS_MAX = RECOVERED_REF_TTL_TURNS * RECOVERED_REFS_PER_TURN;

function normalizeRecoveredRefs(raw) {
    const out = [];
    const seen = new Set();
    for (const r of (Array.isArray(raw) ? raw : [])) {
        const category = typeof r?.category === 'string' ? r.category.trim() : '';
        const key = typeof r?.key === 'string' ? r.key.trim() : '';
        if (!category || !key) continue;
        const id = `${category.toLowerCase()}/${key.toLowerCase()}`;
        if (seen.has(id)) continue;
        const ttl0 = Math.floor(Number(r?.ttl));
        // A persisted entry with a junk/absent ttl is treated as its LAST turn
        // rather than a fresh one — a corrupt record must expire, not stick.
        const ttl = Number.isInteger(ttl0) ? Math.min(RECOVERED_REF_TTL_TURNS, Math.max(1, ttl0)) : 1;
        seen.add(id);
        out.push({ category, key, ttl });
        if (out.length >= RECOVERED_REFS_MAX) break;
    }
    return out;
}

function emptySceneStore() {
    return { current: null, closed: [], timeline: '', needRefs: [], recoveredRefs: [] };
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
    if (closed.length > MAX_CLOSED_SCENES) closed.splice(0, closed.length - MAX_CLOSED_SCENES);
    const timeline = typeof raw.timeline === 'string' ? raw.timeline.trim() : '';
    const needRefs = [];
    if (Array.isArray(raw.needRefs)) {
        for (const r of raw.needRefs) {
            const category = typeof r?.category === 'string' ? r.category.trim() : '';
            const key = typeof r?.key === 'string' ? r.key.trim() : '';
            if (category && key) needRefs.push({ category, key });
        }
    }
    const recoveredRefs = normalizeRecoveredRefs(raw.recoveredRefs);
    if (!current && closed.length === 0 && !timeline && needRefs.length === 0 && recoveredRefs.length === 0) return null;
    return { current: current || null, closed, timeline, needRefs, recoveredRefs };
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
        sceneStore = loadSceneFromMeta() || emptySceneStore();
        sceneStoreLoaded = true;
    }
    return (sceneStore && typeof sceneStore === 'object') ? sceneStore : emptySceneStore();
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
    // Replay guard: a watermark-held retry regenerates beats for messages whose
    // beats already live in a CLOSED card (the previous run's marker partition
    // put them there before Call A failed). The de-dup sets below only see the
    // CURRENT card, so check closed cards too — by stable uid, and for uid-less
    // beats by index but only BELOW the current card's start (indices can be
    // reused after message deletions; below-start a beat can only belong to an
    // already-closed scene).
    const closedUid = new Set();
    const closedIdx = new Set();
    for (const c of (Array.isArray(store.closed) ? store.closed : [])) {
        for (const cb of (Array.isArray(c?.beats) ? c.beats : [])) {
            if (cb?.uid) closedUid.add(cb.uid);
            if (Number.isInteger(cb?.msgIndex) && cb.msgIndex >= 0) closedIdx.add(cb.msgIndex);
        }
    }
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
        if (b.uid && closedUid.has(b.uid)) continue;
        if (!b.uid && b.msgIndex >= 0 && cur.startMsg >= 0 && b.msgIndex < cur.startMsg && closedIdx.has(b.msgIndex)) continue;
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
    sceneStore = normalizeSceneStore(raw) || emptySceneStore();
    sceneStoreLoaded = true;
    saveSceneToMeta();
}

export function reloadSceneFromChat() {
    sceneStore = loadSceneFromMeta() || emptySceneStore();
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

// Last SUCCESSFUL NEED selection (Call A). Persisted so an isolated extraction
// failure can re-render the previous run's NEED rows instead of dropping every
// below-floor fact row from the sheet until a later successful run refreshes it.
// An explicit empty selection is stored too — "none needed" must not resurrect
// stale rows forever.
export function getLastNeedRefs() {
    const refs = getSceneStore().needRefs;
    return Array.isArray(refs) ? refs : [];
}

export function setLastNeedRefs(refs) {
    const out = [];
    for (const r of (Array.isArray(refs) ? refs : [])) {
        const category = typeof r?.category === 'string' ? r.category.trim() : '';
        const key = typeof r?.key === 'string' ? r.key.trim() : '';
        if (category && key) out.push({ category, key });
    }
    const store = getSceneStore();
    store.needRefs = out;
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
}

// The sticky recovered set as plain refs, for composeSheet and for tagging the
// "## Injected last turn" list (a tagged ref is exempt from the prompt's
// do-not-re-list rule while its TTL lasts). Entries with a spent TTL are already
// gone — tickRecoveredRefs drops them.
export function getRecoveredRefs() {
    const refs = getSceneStore().recoveredRefs;
    return Array.isArray(refs) ? refs.map(r => ({ category: r.category, key: r.key })) : [];
}

// One turn passed: age every entry and drop the spent ones. Called ONCE per
// successful full extraction run, BEFORE markRecoveredRefs, so a ref the agent
// re-recovers this turn is refreshed to the full TTL rather than aged first.
// A failed run does not tick — a recovery must not burn a turn of its life on a
// turn where the agent never got to judge anything.
export function tickRecoveredRefs() {
    const store = getSceneStore();
    const kept = [];
    for (const r of (Array.isArray(store.recoveredRefs) ? store.recoveredRefs : [])) {
        const ttl = Math.floor(Number(r?.ttl)) - 1;
        if (ttl >= 1) kept.push({ category: r.category, key: r.key, ttl });
    }
    const expired = (Array.isArray(store.recoveredRefs) ? store.recoveredRefs.length : 0) - kept.length;
    store.recoveredRefs = kept;
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
    return expired;
}

// Stamp this turn's recoveries with a fresh TTL. Re-recovering an already-sticky
// ref refreshes it instead of duplicating it, so a fumble that keeps recurring
// keeps its fact on the sheet. Returns how many entries were added or refreshed.
export function markRecoveredRefs(refs) {
    const store = getSceneStore();
    const list = Array.isArray(store.recoveredRefs) ? store.recoveredRefs : [];
    let touched = 0;
    // The prompt's "max 3 per turn" is re-applied here: the cap on the sticky set
    // only holds if the per-turn intake is actually bounded.
    for (const r of (Array.isArray(refs) ? refs : []).slice(0, RECOVERED_REFS_PER_TURN)) {
        const category = typeof r?.category === 'string' ? r.category.trim() : '';
        const key = typeof r?.key === 'string' ? r.key.trim() : '';
        if (!category || !key) continue;
        const id = `${category.toLowerCase()}/${key.toLowerCase()}`;
        const existing = list.find(e => `${e.category.toLowerCase()}/${e.key.toLowerCase()}` === id);
        if (existing) existing.ttl = RECOVERED_REF_TTL_TURNS;
        else list.push({ category, key, ttl: RECOVERED_REF_TTL_TURNS });
        touched++;
    }
    // Hard ceiling. Evict the entries closest to expiry first — the oldest
    // recoveries, whose fumble the storyteller has had the most turns to fix.
    while (list.length > RECOVERED_REFS_MAX) {
        let worst = 0;
        for (let i = 1; i < list.length; i++) if (list[i].ttl < list[worst].ttl) worst = i;
        list.splice(worst, 1);
    }
    store.recoveredRefs = list;
    sceneStore = store;
    sceneStoreLoaded = true;
    saveSceneToMeta();
    return touched;
}

// The whole scene store as plain data, for the test-run export.
//
// The getters above each hand back one slice, and two of them lose detail the
// export needs: getRecoveredRefs drops the TTL (composeSheet does not need it,
// but "why did this ref keep reappearing" is exactly a TTL question), and the
// closed-scene archive is only reachable one scene at a time. Deep-copied on the
// way out — these are the live objects the pipeline keeps appending beats to.
export function getSceneStoreSnapshot() {
    const s = getSceneStore();
    const cloneScene = (sc) => sc ? {
        startMsg: sc.startMsg,
        name: sc.name,
        beats: (Array.isArray(sc.beats) ? sc.beats : []).map(b => ({ ...b })),
        present: [...(Array.isArray(sc.present) ? sc.present : [])],
    } : null;
    return {
        current: cloneScene(s.current),
        closed: (Array.isArray(s.closed) ? s.closed : []).map(cloneScene).filter(Boolean),
        timeline: typeof s.timeline === 'string' ? s.timeline : '',
        needRefs: (Array.isArray(s.needRefs) ? s.needRefs : []).map(r => ({ ...r })),
        recoveredRefs: (Array.isArray(s.recoveredRefs) ? s.recoveredRefs : []).map(r => ({ ...r })),
        limits: { maxClosedScenes: MAX_CLOSED_SCENES, recoveredRefTtlTurns: RECOVERED_REF_TTL_TURNS, recoveredRefsMax: RECOVERED_REFS_MAX },
    };
}

// bf_mem_reflect_runs (how many passes have STARTED in this chat — agent-reflect
// bumps it mid-pass, before the pass can succeed or fail, because its real job is
// to step the scan phase) and
// bf_mem_conflict_ok (the settled-conflict set that suppresses re-reporting) are
// written straight into chatMetadata by agent-reflect.js and have never had a
// reader outside it — so "why did reflection not run" and "why was this conflict
// never raised again" are unanswerable from an export without this.
//
// `reflectProgress` is the other half of that first question and the one that
// actually gates a pass: successful extraction runs accumulated since the last
// one, against pipeline.js's REFLECTION_INTERVAL. reflectRuns alone cannot
// distinguish "no pass has been due yet" from "passes are due and never fire".
//
// STRICTLY READ-ONLY: returns copies, and never creates any of the keys. Calling
// it cannot shift reflection's cadence or its settled set.
export function getReflectionMetaState() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return { reflectRuns: 0, reflectProgress: 0, settledConflicts: [] };
        return {
            reflectRuns: Number(md.bf_mem_reflect_runs) || 0,
            reflectProgress: Number(md[REFLECT_PROGRESS_META_KEY]) || 0,
            settledConflicts: Array.isArray(md.bf_mem_conflict_ok) ? [...md.bf_mem_conflict_ok] : [],
        };
    } catch { return { reflectRuns: 0, reflectProgress: 0, settledConflicts: [] }; }
}

// --- Reflection cadence progress (chat-scoped) -----------------------------
//
// How many successful extraction runs have accumulated since the last reflection
// pass. pipeline.js arms a pass at REFLECTION_INTERVAL (12).
//
// This used to be a MODULE variable in pipeline.js, zeroed on CHAT_CHANGED. A
// run of ~2 messages means 12 runs is roughly 24 messages, so any user who
// reloads the page or switches chats more often than that never reached the
// interval and got ZERO reflection passes — silently, forever, with nothing in
// the log to say a pass was even due. The analysed session had eight chat
// switches and one pass in 47 minutes only because it stayed in one chat.
//
// Progress belongs to the CHAT, not to the browser session: two chats each
// accumulate their own runs, and a chat resumed tomorrow resumes where it
// stopped. Stored in chatMetadata beside bf_mem_reflect_runs (the pass/phase
// counter agent-reflect.js writes) and read/written LIVE from
// getContext().chatMetadata on every call — no module cache, so the value is
// chat-scoped by construction and no CHAT_CHANGED reset hook can forget it.
//
// Branch chats inherit this value, exactly as they already inherit
// bf_mem_reflect_runs: a branch carries the parent's story and the parent's
// facts, so it also carries how overdue that story is for an audit. No
// ownerChatId guard here, deliberately — bf_mem_tokens has one because token
// TOTALS would double-count, and a cadence counter is not a total.
const REFLECT_PROGRESS_META_KEY = 'bf_mem_reflect_progress';

// Not exported: the only readers are the two mutators below, and
// getReflectionMetaState() already exposes the value for the test-run export.
function getReflectionProgress() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return 0;
        const n = Math.floor(Number(md[REFLECT_PROGRESS_META_KEY]));
        return Number.isInteger(n) && n > 0 ? n : 0;
    } catch { return 0; }
}

// Returns true when the value actually reached chatMetadata. A write that cannot
// land is the ORIGINAL bug wearing a different hat — the counter would stall at
// the same number and no pass would ever arm — so bumpReflectionProgress reports
// it instead of returning a number that looks like progress. A failed RESET is
// harmless by comparison: the count stays over the interval, so the next run
// re-arms and the pass simply runs again.
function writeReflectionProgress(n) {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return false;
        md[REFLECT_PROGRESS_META_KEY] = n;
        ctx.saveMetadata?.();
        return true;
    } catch { return false; }
}

// One successful extraction run. Returns the new count, or 0 when it could not
// be persisted — 0 never arms a pass, and the stall is never silent: this logs a
// fail every time it happens, which is exactly what the old module variable
// never did.
export function bumpReflectionProgress() {
    const next = getReflectionProgress() + 1;
    if (!writeReflectionProgress(next)) {
        addDebugLog('fail', 'Reflection progress could not be persisted (no chat metadata) — the cadence counter is not advancing', {
            subsystem: 'reflection', event: 'reflection.progress', reason: 'NO_METADATA',
            data: { attempted: next },
        });
        return 0;
    }
    return next;
}

// A pass has started: the accumulated runs are spent. Called from the pass
// itself, not from arming, so a pass that never runs (character changed, group
// chat, extension disabled) leaves the progress standing and the next settle
// re-arms rather than losing the interval.
export function resetReflectionProgress() {
    if (getReflectionProgress() === 0) return;
    writeReflectionProgress(0);
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
