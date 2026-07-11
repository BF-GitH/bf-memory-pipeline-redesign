// BF Memory Pipeline - per-chat turn state (F-UX-8 split from settings.js)
// Scene card, reflection summary, summary pyramid, the Last Generated / Last Inserted /
// Injection Viewer panels, and the token-comparison records — each persisted in chat_metadata
// and reloaded on CHAT_CHANGED. The mutable state moved HERE together with the functions that
// close over it — settings.js re-exports the public API so importers keep using './settings.js'.
//
// NOTE on cycles: the static import from debug-log.js below forms an intentional ESM cycle
// (debug-log.js imports token accessors from this module). Every cross-module use happens
// inside a function body at CALL time, which ESM resolves safely via hoisted declarations.

import { addDebugLog, getCurrentRunId } from './debug-log.js';
// Intentional ESM cycle (same class as the debug-log one above): settings.js re-exports this
// module's scene API. getSettings is a hoisted function declaration and is only ever called
// inside function bodies at CALL time, which ESM resolves safely.
import { getSettings } from './settings.js';
import { wordTokens } from './tokenize.js';
import { getContext, escapeHtml, fmt, getCurrentChatId, isBranchChat } from './ui-util.js';

let lastGenerated = { runId: null, timestamp: null, updates: [] };
let lastInserted = { runId: null, timestamp: null, updates: [] };
// A4 — Injection Viewer state: the facts ACTUALLY injected into the Writer this turn (distinct from
// lastInserted, which is what the Scribe EXTRACTED to the DB). Populated by setLastInjection() from
// pipeline.js right after a successful injection; rendered on the Tokens tab so a user can SEE, at a
// glance, what memory the reply was given and roughly what it cost.
let lastInjection = { runId: null, timestamp: null, facts: [], approxTokens: 0 };
let lastRunTokens = null; // {baselineInput, actualInput, agent1Input, agent1Output, agent3Input, agent3Output, finderInput, finderOutput, selectorInput, selectorOutput, reflectionInput, reflectionOutput, mainOutput, toolCalls, toolLoopIn, ts, approx}
let sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, toolCalls: 0, toolLoopIn: 0, runs: 0 };
// Scene card — the always-injected "what is true right now" core working-memory block.
// Persisted per-chat in chat_metadata.bf_mem_scene, reloaded on CHAT_CHANGED.
// null = no scene yet (back-compatible: absent scene behaves as no scene card).
let sceneCard = null; // { location, present[], goals[], beats[], sceneNo, sceneName, lastSeen{}, ownerChatId, updatedAt, runId }
// Relationship re-entry (community adoption): the characters who just RETURNED to the scene
// after a long absence, detected inside setScene() from the persisted per-character lastSeen
// stamps. Per-turn signal keyed by runId — deliberately NOT persisted (a swipe of the same turn
// reuses the cached injection; a NEW turn after an aborted one won't re-fire, which is fine
// because the lastSeen stamps already advanced). Read via getSceneReentries().
let lastReentries = { runId: '', names: [] };
// Reflection / consolidation summary — the rolling "story so far" + last synthesized
// observations. Persisted per-chat in chat_metadata.bf_mem_reflection, reloaded on
// CHAT_CHANGED. null = none yet (back-compatible: absent reflection = no injection).
let reflection = null; // { summary, observations[], updatedAt, runId }
// Summary pyramid — hierarchical zoom-out state. TOP level reuses the reflection #STORY
// summary (NOT duplicated — copied in at generation time); MIDDLE level holds one SHORT
// summary per populated (category, aspect) "shelf/bucket". Persisted per-chat in
// chat_metadata.bf_mem_pyramid, reloaded on CHAT_CHANGED. null = none yet (back-compatible:
// absent pyramid = no Big Picture injection). Derived/regenerable — never deletes facts.
let summaryPyramid = null; // { story, shelves: { 'cat||aspect': { text, factCount, updatedAt } }, updatedAt, runId }

// --- Last Generated / Last Inserted Facts (replaces old Summary tab) ---

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
    } catch { /* best-effort */ }
}

export function setLastGenerated(updates) {
    lastGenerated = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(GENERATED_META_KEY, lastGenerated);
    renderGenerated();
}

export function setLastInserted(updates) {
    lastInserted = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(INSERTED_META_KEY, lastInserted);
    renderInserted();
}

/**
 * A4 — record what was INJECTED into the Writer this turn (the facts the reply was actually given,
 * plus an approximate token cost) and refresh the Injection Viewer. Called from pipeline.js right
 * after a successful injection. `facts` is the chosen `{fact, category, tier?}[]` (finder /
 * deterministic / speculative all share this shape). Best-effort + never throws.
 * @param {Array<{fact:Object, category:string, tier?:string}>} facts
 * @param {number} approxTokens - rough injected token cost (chars/4 of the injection block)
 */
export function setLastInjection(facts, approxTokens) {
    try {
        lastInjection = {
            runId: getCurrentRunId() || null,
            timestamp: Date.now(),
            facts: Array.isArray(facts) ? facts : [],
            approxTokens: Number(approxTokens) || 0,
        };
        renderInjectionViewer();
    } catch { /* viewer is best-effort — never break the turn */ }
}

// Cap rows rendered in the viewer so a huge injection can't bloat the DOM.
const INJECTION_VIEWER_MAX_ROWS = 60;

/**
 * A4 — render the Injection Viewer panel: a glanceable list of the facts injected last turn with a
 * one-line headline (count + approx tokens). Pure DOM render; no-ops if the panel isn't present.
 */
function renderInjectionViewer() {
    const el = document.getElementById('bf_mem_injection_view');
    if (!el) return;
    const facts = Array.isArray(lastInjection.facts) ? lastInjection.facts : [];
    if (facts.length === 0) {
        el.innerHTML = '<div class="bf-mem-summary-empty">Nothing injected yet. After a reply, the facts the Writer was given appear here.</div>';
        return;
    }
    const head = `<div class="bf-mem-hint" style="margin-bottom:6px;"><b>${facts.length}</b> fact(s) injected last turn · ≈<b>${lastInjection.approxTokens.toLocaleString()}</b> tokens</div>`;
    const rows = facts.slice(0, INJECTION_VIEWER_MAX_ROWS).map(({ fact, category, tier }) => {
        const t = (tier && typeof tier === 'string') ? tier[0].toUpperCase() : '';
        const badge = t ? `<span class="bf-mem-action-badge" title="${escapeHtml(tier)}">${t}</span> ` : '';
        const val = String(fact?.value ?? '').trim();
        const valHtml = val ? ` = ${escapeHtml(val.slice(0, 120))}` : '';
        return `<div class="bf-mem-fact-item">${badge}<span class="bf-mem-category">${escapeHtml(category)}</span> <strong>${escapeHtml(String(fact?.key ?? ''))}</strong>${valHtml}</div>`;
    }).join('');
    const more = facts.length > INJECTION_VIEWER_MAX_ROWS
        ? `<div class="bf-mem-hint">(+${facts.length - INJECTION_VIEWER_MAX_ROWS} more)</div>` : '';
    el.innerHTML = head + rows + more;
}

export function appendLastInserted(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return;
    lastInserted.updates = [...(lastInserted.updates || []), ...updates];
    lastInserted.timestamp = new Date().toLocaleTimeString();
    saveFactsToMeta(INSERTED_META_KEY, lastInserted);
    renderInserted();
}

export function reloadFactsFromChat() {
    lastGenerated = loadFactsFromMeta(GENERATED_META_KEY) || { runId: null, timestamp: null, updates: [] };
    lastInserted = loadFactsFromMeta(INSERTED_META_KEY) || { runId: null, timestamp: null, updates: [] };
    renderGenerated();
    renderInserted();
}

function renderFactList(containerId, data, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (data.runId === null) {
        container.innerHTML = `<div class="bf-mem-summary-empty">${escapeHtml(opts.emptyMsg || 'No pipeline runs yet.')}</div>`;
        return;
    }
    if (!data.updates || data.updates.length === 0) {
        container.innerHTML = `<div class="bf-mem-summary-empty">${escapeHtml(opts.zeroMsg || 'Last run extracted 0 facts.')}</div>`;
        return;
    }

    const header = `<div class="bf-mem-fact-header"><b>${escapeHtml(data.timestamp || '')}</b> · ${data.updates.length} fact${data.updates.length === 1 ? '' : 's'}</div>`;
    const items = data.updates.map(u => {
        const cat = escapeHtml(u.category || '?');
        const key = escapeHtml(u.key || '');
        const value = escapeHtml(String(u.value ?? ''));
        const knownBy = (u.knownBy || []).map(k => `<span class="bf-mem-chip">@${escapeHtml(k)}</span>`).join(' ');
        const tags = (u.tags || []).map(t => `<span class="bf-mem-chip bf-mem-chip-tag">#${escapeHtml(t)}</span>`).join(' ');
        const source = u.source ? `<span class="bf-mem-fact-source">from ${escapeHtml(u.source)}</span>` : '';
        const status = u.status
            ? `<span class="bf-mem-fact-status bf-mem-fact-status-${u.status.toLowerCase()}">${escapeHtml(u.status)}</span>`
            : '';
        return `
            <div class="bf-mem-fact-row">
                <div class="bf-mem-fact-line"><span class="bf-mem-fact-cat">${cat}</span> <code class="bf-mem-fact-key">${key}</code> = <span class="bf-mem-fact-val">${value}</span></div>
                <div class="bf-mem-fact-meta">${knownBy} ${tags} ${source} ${status}</div>
            </div>`;
    }).join('');
    container.innerHTML = header + items;
}

function renderGenerated() {
    renderFactList('bf_mem_generated_list', lastGenerated, {
        emptyMsg: 'No pipeline runs yet. Send a message to see what the Scribe extracts.',
        zeroMsg: 'Last run extracted 0 facts (the Scribe found nothing worth storing).',
    });
}

function renderInserted() {
    renderFactList('bf_mem_inserted_list', lastInserted, {
        emptyMsg: 'No pipeline runs yet.',
        zeroMsg: 'Nothing to insert (the Scribe returned no facts, or run was cancelled).',
    });
}

// --- Token Comparison (persistent — stored in chat_metadata.bf_mem_tokens) ---

const TOKENS_META_KEY = 'bf_mem_tokens';

function loadTokensFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return;
        const stored = md[TOKENS_META_KEY];
        if (stored && typeof stored === 'object') {
            // BRANCH TOKEN-RESET (Fix #3a): ST creates a branch by COPYING the parent chat's
            // chat_metadata, so a freshly-branched chat inherits the parent's bf_mem_tokens and the
            // Tokens tab shows the parent's stale counters until the branch's first run. We stamp
            // each saved record with the chatId it belongs to (ownerChatId); when the stored record's
            // owner does NOT match the current chat, it was inherited (branch copy or any metadata
            // clone) — so we DROP it and start this chat's own tally at zero rather than show
            // inherited numbers. A run on this chat re-stamps the record via saveTokensToMeta.
            const currentChatId = getCurrentChatId();
            const owner = typeof stored.ownerChatId === 'string' ? stored.ownerChatId : null;
            const inherited = !!currentChatId && owner !== null && owner !== currentChatId;
            if (inherited) {
                lastRunTokens = null;
                sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, toolCalls: 0, toolLoopIn: 0, runs: 0 };
                addDebugLog('info', `Tokens reset for inherited/branch chat ${currentChatId} (record owned by ${owner})`, {
                    subsystem: 'settings', event: 'tokens.reset', actor: 'SYSTEM', reason: 'BRANCH_INHERITED',
                    data: { chatId: currentChatId, ownerChatId: owner, isBranch: isBranchChat(currentChatId) },
                });
                // Re-stamp the metadata to this chat so it doesn't keep re-detecting as inherited.
                saveTokensToMeta();
                return;
            }
            lastRunTokens = (stored.lastRun && typeof stored.lastRun === 'object') ? stored.lastRun : null;
            sessionTokens = (stored.session && typeof stored.session === 'object')
                ? stored.session
                : { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, toolCalls: 0, toolLoopIn: 0, runs: 0 };
        }
    } catch { /* ignore */ }
}

function saveTokensToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        // Stamp the owning chatId so a later branch (which copies this metadata) can detect the
        // record as inherited and reset it instead of showing this chat's counters (see loadTokensFromMeta).
        md[TOKENS_META_KEY] = { lastRun: lastRunTokens, session: sessionTokens, ownerChatId: getCurrentChatId() || '' };
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

// Called by pipeline.js after a run's input metrics are known.
export function setRunTokens(run) {
    // Coerce every field to a finite number so a tokenizer returning undefined/NaN
    // can't poison the running session totals (they'd become NaN and stop adding up).
    const baselineInput = Number(run?.baselineInput) || 0;
    const actualInput   = Number(run?.actualInput) || 0;
    // Agent overhead now includes the Stage-2 finder (Agent 4) and the opt-in Selector
    // (semantic shelf selection — 0 when the pass is off). Scribe (agent3) is still folded
    // in later via addAgent3Tokens, and reflection via addReflectionTokens (both post-reply).
    const agentInput    = (Number(run?.agent1Input) || 0) + (Number(run?.agent3Input) || 0) + (Number(run?.finderInput) || 0) + (Number(run?.selectorInput) || 0);
    const agentOutput   = (Number(run?.agent1Output) || 0) + (Number(run?.agent3Output) || 0) + (Number(run?.finderOutput) || 0) + (Number(run?.selectorOutput) || 0);

    lastRunTokens = { ...run, ts: Date.now(), approx: true };
    // accumulate session
    sessionTokens.baselineInput += baselineInput;
    sessionTokens.actualInput   += actualInput;
    sessionTokens.agentInput    += agentInput;
    sessionTokens.agentOutput   += agentOutput;
    // Only count this as a run if it produced at least one usable token figure.
    // A no-op run (all zero — e.g. tokenizer unavailable) would otherwise inflate
    // the run count and skew per-run averages.
    if (baselineInput || actualInput || agentInput || agentOutput) {
        sessionTokens.runs += 1;
    }
    saveTokensToMeta();
    renderTokens();
}

// Called by pipeline.js MESSAGE_RECEIVED handler once Agent 3 (memory extraction)
// runs off the blocking path. Agent 3 no longer participates in the pre-generation
// setRunTokens call, so its input/output tokens are folded into the session totals
// here WITHOUT bumping the run count (the run was already counted on the blocking
// path) and WITHOUT touching baseline/actual input. Also stamps the figures onto
// lastRunTokens so the per-run breakdown still shows the Agent 3 line.
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

// Called by pipeline.js maybeRunReflection() once the (post-reply, off-blocking-path)
// reflection/consolidation pass completes. Mirrors addAgent3Tokens: folds the reflection
// LLM call's input/output into the session AGENT overhead totals WITHOUT bumping the run
// count (the run was already counted on the blocking path) and WITHOUT touching
// baseline/actual input. Stamps the figures onto lastRunTokens so the per-run breakdown
// shows the Reflection line. Reflection runs every N turns, so most runs add 0 here.
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

// redesign-v2 (S1): addToolLoopTokens was removed with the writer-side function tools —
// the main model never makes tool round-trips anymore, so there is nothing to estimate.

// Called by pipeline.js MESSAGE_RECEIVED handler when the main reply lands.
export function setMainOutputTokens(n) {
    const out = Number(n) || 0;
    if (lastRunTokens) lastRunTokens.mainOutput = out;
    sessionTokens.mainOutput += out;
    saveTokensToMeta();
    renderTokens();
}

export function reloadTokensFromChat() {
    lastRunTokens = null;
    sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, toolCalls: 0, toolLoopIn: 0, runs: 0 };
    loadTokensFromMeta();
    renderTokens();
}

// --- Memory Sheet (persistent — stored in chat_metadata.bf_mem_sheet) --------------------------
// redesign-v2 (S3, G2): the ONE block of memory the writer ever sees. Rebuilt in the background
// by the Memory Agent after each settled reply (agent-memory.js runMemoryAgent → composeSheet);
// injected by PURE CODE on the prompt-ready events (pipeline.js, S4). The sheet is NEVER empty:
// a chat without one yet reads the seed text, so injection is unconditional and cache-friendly.

const SHEET_META_KEY = 'bf_mem_sheet';

/** Seed text a brand-new chat's sheet carries until the first Memory Agent run replaces it. */
export const SHEET_SEED_TEXT = 'Story just beginning — no memories yet.';

// Cached per-chat sheet record (reloaded on CHAT_CHANGED via reloadSheetFromChat; lazily
// loaded on first read). Shape per G2:
// { text: string, updatedAt: ISOstring, runId: string, sourceMessageIndex: number, seeded: boolean }
let memorySheet = null;
let memorySheetLoaded = false; // distinguishes "not loaded yet" from "loaded, chat has none"

/** Build a fresh seed-sheet record. */
function seedSheet() {
    return {
        text: SHEET_SEED_TEXT,
        updatedAt: new Date().toISOString(),
        runId: '',
        sourceMessageIndex: -1,
        seeded: true,
    };
}

/** Coerce a stored value into the sheet shape, or null if unusable/blank. */
function normalizeSheet(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!text) return null; // a blank sheet is treated as absent — getMemorySheet re-seeds
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
    } catch { /* best-effort */ }
}

/**
 * The current chat's memory-sheet record. NEVER returns an empty/absent sheet: when the chat
 * has none (or a blank one), a seed record is minted, lazily persisted, and returned — so the
 * injection path can splice unconditionally and the "empty-seeded → skip trimming" signal is
 * just `rec.seeded`.
 * @returns {{text:string, updatedAt:string, runId:string, sourceMessageIndex:number, seeded:boolean}}
 */
export function getMemorySheet() {
    if (!memorySheetLoaded) {
        memorySheet = loadSheetFromMeta();
        memorySheetLoaded = true;
    }
    if (!memorySheet || !String(memorySheet.text || '').trim()) {
        memorySheet = seedSheet();
        saveSheetToMeta(); // lazily persist the seed so the metadata always carries a sheet
    }
    return memorySheet;
}

/**
 * Store a freshly-composed memory sheet (replaces the prior one — it's rolling state, not a
 * log). An empty/blank `text` is REFUSED (never leave the sheet empty — F-SCRIBE-1's
 * generalized "keep the previous sheet" contract lives here).
 * @param {string} text - the full rendered sheet (composeSheet output)
 * @param {{runId?: string, sourceMessageIndex?: number}} [opts]
 */
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

/** Re-load the sheet from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadSheetFromChat() {
    memorySheet = loadSheetFromMeta();
    memorySheetLoaded = true;
    renderMemorySheet();
}

/**
 * Render the read-only sheet preview panel (S5 wires a `bf_mem_sheet_view` element into the
 * Memory tab; until then this is a harmless no-op). Best-effort, never throws.
 */
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
    } catch { /* preview is best-effort */ }
}

// --- Scene Card (persistent — stored in chat_metadata.bf_mem_scene) ---
// Always-on "what is true right now" core block. Updated by Agent 1 each turn,
// injected above the fact list every turn (when enabled and a scene exists).

const SCENE_META_KEY = 'bf_mem_scene';
const SCENE_BEATS_MAX = 3; // rolling window: keep the last N one-line beats

// Scene-boundary detector (deterministic, NOT LLM-named). A new scene number is minted only when
// the location MATERIALLY changes. We compare the normalized (lowercased/trim/token-set) locations
// by Jaccard token overlap: when overlap is HIGH the locations are "the same place" (synonym drift
// like "the bar" -> "the dim bar", or room-flapping A->B->A back to a recently-seen place) and the
// scene number is held. Sticky on omission (a turn with no location keeps the current scene).
const SCENE_SIM_THRESHOLD = 0.5; // Jaccard token-overlap >= this => "same place" (hold the counter)
const SCENE_NAME_MAX = 60;       // hard clamp on a derived/refined scene name (lean storage)
const SCENE_LASTSEEN_MAX = 40;   // cap the per-character lastSeen map (oldest dropped — lean chat_metadata)

/** Normalize a location string into a lowercased token set for similarity comparison.
 * Shared Unicode tokenizer (ASCII path identical to the old [^a-z0-9] split + >=3 gate) —
 * without it every CJK/Cyrillic location normalized to the EMPTY set and the scene counter
 * could never advance for non-Latin chats. */
function sceneLocTokens(loc) {
    return new Set(
        wordTokens(loc, { min: 3 })
            // Drop tiny stop-ish tokens so "the bar" vs "bar" reads as identical (English-only).
            .filter(t => !/^(the|and|for|with|near|into|onto)$/.test(t)),
    );
}

/**
 * Decide whether `nextLoc` is MATERIALLY different from `prevLoc` (a scene boundary). Returns false
 * (NOT a boundary) when either is empty (sticky on omission), when they normalize identically, or
 * when their token sets overlap at/above SCENE_SIM_THRESHOLD (synonym drift / minor rewording).
 * Pure + deterministic — no LLM, no randomness.
 * @param {string} prevLoc
 * @param {string} nextLoc
 * @returns {boolean}
 */
function isMaterialLocationChange(prevLoc, nextLoc) {
    const a = String(prevLoc || '').trim();
    const b = String(nextLoc || '').trim();
    if (!a || !b) return false;                 // sticky on omission (no location => keep scene)
    if (a.toLowerCase() === b.toLowerCase()) return false;
    const sa = sceneLocTokens(a);
    const sb = sceneLocTokens(b);
    if (sa.size === 0 || sb.size === 0) return false;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const union = sa.size + sb.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    return jaccard < SCENE_SIM_THRESHOLD;       // low overlap => a genuinely different place
}

/** Derive a default scene name from a location string (trimmed + clamped). */
function deriveSceneName(loc) {
    const s = String(loc || '').trim().replace(/\s+/g, ' ');
    return s.length > SCENE_NAME_MAX ? s.slice(0, SCENE_NAME_MAX).trim() : s;
}

/** Coerce a stored value into the scene shape, or return null if unusable. */
function normalizeScene(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const arr = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];
    const loc = typeof raw.location === 'string' ? raw.location.trim() : '';
    const present = arr(raw.present);
    const goals = arr(raw.goals);
    const beats = arr(raw.beats).slice(-SCENE_BEATS_MAX);
    // A scene is meaningful only if it carries at least one field.
    if (!loc && present.length === 0 && goals.length === 0 && beats.length === 0) return null;
    // Scene counter (Spiderweb 2): monotonic int starting at 1; name auto-derived from the
    // location by default (the Drafter MAY refine it but it is never required).
    const rawNo = Math.floor(Number(raw.sceneNo));
    const sceneNo = Number.isInteger(rawNo) && rawNo >= 1 ? rawNo : 1;
    let sceneName = typeof raw.sceneName === 'string' ? raw.sceneName.trim() : '';
    if (sceneName.length > SCENE_NAME_MAX) sceneName = sceneName.slice(0, SCENE_NAME_MAX).trim();
    if (!sceneName) sceneName = deriveSceneName(loc);
    // Relationship re-entry: per-character last-seen stamps (lowercased name -> {sceneNo, updatedAt}).
    // Coerced fully defensively — a bad/corrupt lastSeen entry is DROPPED, never allowed to nuke the
    // whole scene card — and capped at SCENE_LASTSEEN_MAX entries (oldest updatedAt evicted first)
    // so chat_metadata stays bounded even in a chat with a huge cast.
    const lastSeen = {};
    if (raw.lastSeen && typeof raw.lastSeen === 'object' && !Array.isArray(raw.lastSeen)) {
        for (const [name, v] of Object.entries(raw.lastSeen)) {
            const key = String(name ?? '').trim().toLowerCase();
            if (!key || !v || typeof v !== 'object' || Array.isArray(v)) continue;
            const sn = Math.floor(Number(v.sceneNo));
            if (!Number.isInteger(sn) || sn < 1) continue;
            lastSeen[key] = { sceneNo: sn, updatedAt: Number(v.updatedAt) || 0 };
        }
        const names = Object.keys(lastSeen);
        if (names.length > SCENE_LASTSEEN_MAX) {
            names.sort((a, b) => lastSeen[b].updatedAt - lastSeen[a].updatedAt);
            for (const stale of names.slice(SCENE_LASTSEEN_MAX)) delete lastSeen[stale];
        }
    }
    return {
        location: loc,
        present,
        goals,
        beats,
        sceneNo,
        sceneName,
        lastSeen,
        // Branch-safe ownership stamp (mirrors the token-tab fix): the chatId that owns this record.
        ownerChatId: typeof raw.ownerChatId === 'string' ? raw.ownerChatId : '',
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadSceneFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        const scene = normalizeScene(md[SCENE_META_KEY]);
        if (!scene) return null;
        // BRANCH-SAFE SCENE OWNERSHIP (Spiderweb 2; mirrors the token-tab ownerChatId fix). ST
        // creates a branch by COPYING the parent chat's chat_metadata, so a freshly-branched chat
        // inherits the parent's bf_mem_scene record. We must not let the branch and parent
        // double-write the SAME record (corrupting the parent's scene state). When the stored
        // record's owner ≠ the current chat, it was inherited: we CONTINUE numbering from the
        // inherited sceneNo (the safer option per web-C — monotonic per chat, no jump back to a
        // beat the branch never produced) and RE-STAMP ownership to this chat so subsequent writes
        // target the branch's own record, leaving the parent's untouched.
        const currentChatId = getCurrentChatId();
        const owner = scene.ownerChatId || '';
        if (currentChatId && (!owner || owner !== currentChatId)) {
            scene.ownerChatId = currentChatId;
            sceneCard = scene;
            saveSceneToMeta(); // re-stamp so it stops re-detecting as inherited (or claim ownership of an unowned/legacy record)
            if (owner) {
                addDebugLog('info', `Scene inherited by branch chat ${currentChatId} (was owned by ${owner}); continuing at scene ${scene.sceneNo}`, {
                    subsystem: 'settings', event: 'scene.inherited', actor: 'SYSTEM', reason: 'BRANCH_INHERITED',
                    data: { chatId: currentChatId, ownerChatId: owner, sceneNo: scene.sceneNo, isBranch: isBranchChat(currentChatId) },
                });
            }
            return scene;
        }
        return scene;
    } catch { return null; }
}

function saveSceneToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[SCENE_META_KEY] = sceneCard;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/** Current scene card (or null). Read by pipeline.js to build the injection. */
export function getScene() {
    return sceneCard;
}

/**
 * Per-turn relationship re-entry signal: `{runId, names[]}` — the characters who RETURNED to the
 * scene on the run that last called setScene() (empty most turns). Consumed by pipeline.js
 * (runId-matched) to build the guaranteed re-entry pack. NOT persisted — see lastReentries above.
 * @returns {{runId: string, names: string[]}}
 */
export function getSceneReentries() {
    return lastReentries;
}

/**
 * Update the scene card from an Agent 1 #SCENE parse. Merges defensively:
 *   - location / present / goals: replaced when the new value is non-empty,
 *     otherwise the prior value is kept (Agent 1 may omit a field on a given turn).
 *   - beats: rolling window — append the newest beat(s), drop the oldest, cap at 3.
 * @param {{location?:string, present?:string[], goals?:string[], newBeats?:string[], name?:string}} patch
 * @param {string} runId
 */
export function setScene(patch, runId = '') {
    if (!patch || typeof patch !== 'object') return;
    const prev = sceneCard || { location: '', present: [], goals: [], beats: [], sceneNo: 1, sceneName: '' };
    const cleanArr = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];

    const location = (typeof patch.location === 'string' && patch.location.trim())
        ? patch.location.trim() : prev.location;
    const present = (Array.isArray(patch.present) && patch.present.length)
        ? cleanArr(patch.present) : prev.present;
    const goals = (Array.isArray(patch.goals) && patch.goals.length)
        ? cleanArr(patch.goals) : prev.goals;

    // Rolling beats window: append new beats, keep last SCENE_BEATS_MAX, de-dupe
    // a newest beat that exactly repeats the prior tail (Agent 1 echoing itself).
    let beats = [...(prev.beats || [])];
    for (const b of cleanArr(patch.newBeats)) {
        if (beats.length && beats[beats.length - 1] === b) continue;
        beats.push(b);
    }
    beats = beats.slice(-SCENE_BEATS_MAX);

    // SCENE COUNTER (Spiderweb 2). The number is a DETERMINISTIC, debounced boundary detector —
    // it advances only when the location MATERIALLY changes (isMaterialLocationChange: low token
    // overlap with the prior location). Synonym drift / room-flapping back to a recently-seen place
    // and turns with no location are sticky (the number holds). The advance is driven by the
    // (deterministic) location, NOT a per-run counter, so re-rolling/swiping the same message —
    // which yields the same location — does NOT bump the scene.
    const prevNo = Number.isInteger(prev.sceneNo) && prev.sceneNo >= 1 ? prev.sceneNo : 1;
    const boundary = isMaterialLocationChange(prev.location, location);
    const sceneNo = boundary ? prevNo + 1 : prevNo;

    // Scene NAME: the Drafter MAY refine it (patch.name, parsed leniently); otherwise the
    // location-derived name stands. On a boundary we always re-derive from the new location so the
    // name tracks the new scene unless the Drafter overrides; within a scene we keep the prior name
    // (or adopt a Drafter refinement / fill from the location if it was empty).
    const refined = (typeof patch.name === 'string' && patch.name.trim()) ? patch.name.trim() : '';
    let sceneName;
    if (refined) sceneName = refined;
    else if (boundary) sceneName = deriveSceneName(location);
    else sceneName = prev.sceneName || deriveSceneName(location);

    // RELATIONSHIP RE-ENTRY DETECTION (community adoption). A character RE-ENTERS when they are
    // in the NEW present list, were NOT in the previous one, and were last seen at least
    // `reentryAbsenceScenes` scene-boundaries ago (per the persisted lastSeen stamps). Detected
    // here at #SCENE-parse time — PUSH mode only (hybrid/tool-only never produce a fresh parse,
    // so present is stale there and re-entry deliberately never fires; see pipeline.js). Coarse
    // by design: sceneNo only advances on a MATERIAL location change, so a long single-room chat
    // never triggers this — deterministic beats clever. Every present name is then re-stamped at
    // the new sceneNo so the map rides the scene card (normalizeScene coerces + caps it).
    const prevSeen = (prev.lastSeen && typeof prev.lastSeen === 'object' && !Array.isArray(prev.lastSeen)) ? prev.lastSeen : {};
    const prevPresentSet = new Set((prev.present || []).map(p => String(p ?? '').trim().toLowerCase()).filter(Boolean));
    const absenceScenes = 2; // redesign-v2 (S1): fixed (the reentryAbsenceScenes setting was removed)
    const reentries = [];
    const stampNow = Date.now();
    const lastSeen = { ...prevSeen };
    for (const rawName of present) {
        const name = String(rawName ?? '').trim();
        const nameLower = name.toLowerCase();
        if (!nameLower) continue;
        const seen = prevSeen[nameLower];
        if (!prevPresentSet.has(nameLower) && seen && (sceneNo - seen.sceneNo) >= absenceScenes) {
            reentries.push(name);
        }
        lastSeen[nameLower] = { sceneNo, updatedAt: stampNow };
    }

    const next = normalizeScene({
        location, present, goals, beats, sceneNo, sceneName, lastSeen,
        ownerChatId: getCurrentChatId() || '',
        updatedAt: Date.now(), runId,
    });
    if (!next) return; // nothing meaningful to store

    // Publish the per-turn re-entry signal (only once the card is actually storable) and log it.
    lastReentries = { runId: runId || '', names: reentries };
    if (reentries.length) {
        addDebugLog('info', `Scene re-entry: ${reentries.join(', ')} returned after >=${absenceScenes} scene(s) away`, {
            subsystem: 'settings', event: 'scene.reentry', actor: 'SYSTEM', reason: 'REENTRY',
            data: { names: reentries, sceneNo, absenceScenes },
        });
    }

    if (boundary) {
        addDebugLog('info', `Scene advanced: ${prevNo} "${prev.sceneName || ''}" → ${next.sceneNo} "${next.sceneName}"`, {
            subsystem: 'settings', event: 'scene.advanced', actor: 'SYSTEM', reason: 'LOCATION_CHANGE',
            data: { fromNo: prevNo, toNo: next.sceneNo, fromName: prev.sceneName || '', toName: next.sceneName, fromLoc: prev.location || '', toLoc: location },
        });
    } else {
        addDebugLog('debug', `Scene continued: ${next.sceneNo} "${next.sceneName}"`, {
            subsystem: 'settings', event: 'scene.continued',
            data: { sceneNo: next.sceneNo, sceneName: next.sceneName, location },
        });
    }

    sceneCard = next;
    saveSceneToMeta();
    renderScene();
}

/** Re-load the scene card from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadSceneFromChat() {
    sceneCard = loadSceneFromMeta();
    renderScene();
}

/** Render the read-only live scene card in the Agent 1 tab (if present). */
export function renderScene() {
    const el = document.getElementById('bf_mem_scene_view');
    if (!el) return;
    if (!sceneCard) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No scene yet. It updates each turn once the pipeline runs.</div>';
        return;
    }
    const s = sceneCard;
    const row = (label, val) => val ? `<div class="bf-mem-fact-line"><span class="bf-mem-fact-cat">${escapeHtml(label)}</span> ${escapeHtml(val)}</div>` : '';
    // Scene No + name (Spiderweb 2): the monotonic scene number + its (location-derived or
    // Drafter-refined) name, so the boundary detector is visible in the Agent 1 tab.
    const sceneLabel = Number.isInteger(s.sceneNo) ? `#${s.sceneNo}${s.sceneName ? ` · ${s.sceneName}` : ''}` : '';
    el.innerHTML =
        row('Scene', sceneLabel) +
        row('Location', s.location) +
        row('Present', (s.present || []).join(', ')) +
        row('Goals', (s.goals || []).join('; ')) +
        row('Recently', (s.beats || []).join('; '));
}

// --- Reflection / Consolidation (persistent — stored in chat_metadata.bf_mem_reflection) ---
// Rolling "story so far" summary + last synthesized observations. Mirrors the scene-card
// persistence pattern: per-chat, shape-checked reload, best-effort save.

const REFLECTION_META_KEY = 'bf_mem_reflection';

/** Coerce a stored value into the reflection shape, or null if unusable. */
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
    } catch { /* best-effort */ }
}

/** Current reflection summary object (or null). Read by pipeline.js for injection. */
export function getReflection() {
    return reflection;
}

/**
 * Store a fresh reflection (replaces the prior one — it's a rolling summary, not a log).
 * @param {{summary?:string, observations?:string[]}} patch
 * @param {string} runId
 */
export function setReflection(patch, runId = '') {
    const next = normalizeReflection({ ...(patch || {}), updatedAt: Date.now(), runId });
    if (!next) return; // nothing meaningful to store
    reflection = next;
    saveReflectionToMeta();
    renderReflection();
}

/** Re-load the reflection from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadReflectionFromChat() {
    reflection = loadReflectionFromMeta();
    renderReflection();
}

/** Render the read-only live reflection summary in the Agent 3 tab (if present). */
export function renderReflection() {
    const el = document.getElementById('bf_mem_reflection_view');
    if (!el) return;
    if (!reflection) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No reflection yet. It is generated periodically once the pipeline has run several turns.</div>';
        return;
    }
    const r = reflection;
    let html = '';
    if (r.summary) html += `<div class="bf-mem-fact-line">${escapeHtml(r.summary)}</div>`;
    if ((r.observations || []).length) {
        html += '<div class="bf-mem-fact-meta" style="margin-top:6px;">' +
            r.observations.map(o => `<span class="bf-mem-chip bf-mem-chip-tag">${escapeHtml(o)}</span>`).join(' ') +
            '</div>';
    }
    el.innerHTML = html || '<div class="bf-mem-summary-empty">No reflection yet.</div>';
}

// --- Summary Pyramid (persistent — stored in chat_metadata.bf_mem_pyramid) ---
// Hierarchical zoom-out: a SHORT summary per (category, aspect) "shelf/bucket" rolling up
// into the whole-story summary (reused from reflection's #STORY). Mirrors the reflection
// persistence pattern: per-chat, shape-checked reload, best-effort save. Read by the writer
// injection builder (agent-writer.js) and written by the reflection pass (agent-reflect.js).

const PYRAMID_META_KEY = 'bf_mem_pyramid';

/** Coerce a stored value into the pyramid shape, or null if unusable. */
function normalizePyramid(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const story = typeof raw.story === 'string' ? raw.story.trim() : '';
    const shelves = {};
    if (raw.shelves && typeof raw.shelves === 'object' && !Array.isArray(raw.shelves)) {
        for (const [bucketKey, entry] of Object.entries(raw.shelves)) {
            if (!bucketKey || !entry || typeof entry !== 'object') continue;
            const text = typeof entry.text === 'string' ? entry.text.trim() : '';
            if (!text) continue; // an empty shelf summary carries no value — drop it
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
    } catch { /* best-effort */ }
}

/**
 * Current summary pyramid object (or null). Read by agent-writer.js (Big Picture injection)
 * and agent-reflect.js (changed-bucket detection — compares stored shelf factCount/updatedAt
 * against the live index).
 * @returns {{story:string, shelves:Object<string,{text:string,factCount:number,updatedAt:number}>, updatedAt:number, runId:string}|null}
 */
export function getSummaryPyramid() {
    return summaryPyramid;
}

/**
 * Store a fresh summary pyramid (replaces the prior one — it's rolling derived state, not a
 * log). Mirrors setReflection. Best-effort persist to chat_metadata.
 * @param {{story?:string, shelves?:Object}} pyramid
 * @param {string} runId
 */
export function setSummaryPyramid(pyramid, runId = '') {
    const next = normalizePyramid({ ...(pyramid || {}), updatedAt: Date.now(), runId });
    if (!next) return; // nothing meaningful to store
    summaryPyramid = next;
    savePyramidToMeta();
}

/** Re-load the pyramid from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadPyramidFromChat() {
    summaryPyramid = loadPyramidFromMeta();
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
    // Extension total = the background agent LLM calls (Memory Agent + Reflection) on top of
    // the main model's own input/output. Legacy fields (agent1/finder/selector) render as 0
    // on records that pre-date the redesign-v2 purge.
    const fIn = L.finderInput || 0, fOut = L.finderOutput || 0;
    const selIn = L.selectorInput || 0, selOut = L.selectorOutput || 0;
    const rIn = L.reflectionInput || 0, rOut = L.reflectionOutput || 0;
    const extIn = (L.actualInput || 0) + (L.agent1Input || 0) + (L.agent3Input || 0) + fIn + selIn + rIn;
    const extOut = (L.mainOutput || 0) + (L.agent1Output || 0) + (L.agent3Output || 0) + fOut + selOut + rOut;
    const netIn = extIn - (L.baselineInput || 0);   // negative = saved
    const netOut = extOut - (L.mainOutput || 0);     // agent output overhead (always >= 0)

    // Trim-off detection: actual main input ~= baseline (within 3%)
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
                <tr><td>— Drafter</td><td>${fmt(L.agent1Input)}</td><td>${fmt(L.agent1Output)}</td></tr>
                ${(fIn || fOut) ? `<tr><td>— Librarian (finder)</td><td>${fmt(fIn)}</td><td>${fmt(fOut)}</td></tr>` : ''}
                ${(selIn || selOut) ? `<tr><td>— Selector (semantic pass)</td><td>${fmt(selIn)}</td><td>${fmt(selOut)}</td></tr>` : ''}
                <tr><td>— Scribe</td><td>${fmt(L.agent3Input)}</td><td>${fmt(L.agent3Output)}</td></tr>
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

// --- F-UX-8 split accessors -----------------------------------------------------------------
// Read-only views over the module state above, for debug-log.js's "What Claude did" panel +
// Copy Diagnostics bundle and settings.js's Tokens-tab reset button. The state itself must
// live here (single owner) — these expose it without duplicating it.

/** Latest per-run token record (or null before the first run). */
export function getLastRunTokens() {
    return lastRunTokens;
}

/** Running session token totals. */
export function getSessionTokens() {
    return sessionTokens;
}

/** Last Scribe-extracted updates panel record. */
export function getLastGenerated() {
    return lastGenerated;
}

/** Last DB-inserted updates panel record. */
export function getLastInserted() {
    return lastInserted;
}

/** Last Writer-injection record (facts + approx tokens). */
export function getLastInjection() {
    return lastInjection;
}

/**
 * Reset the session token totals (Tokens tab "Reset" button). Moved verbatim from the
 * settings.js click handler during the F-UX-8 split: zero the totals, persist, re-render.
 */
export function resetSessionTokens() {
    sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, toolCalls: 0, toolLoopIn: 0, runs: 0 };
    saveTokensToMeta();
    renderTokens();
}
