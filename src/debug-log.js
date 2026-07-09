// BF Memory Pipeline - Debug-log storage engine (F-UX-8 split from settings.js)
// The RAM ring buffer, chat_metadata slice + attachment-file persistence, runId threading,
// level/subsystem filters, the Debug-tab renderers (log + "What Claude did"), text/JSON export,
// and the Copy Diagnostics bundle. The mutable state (ring buffer, flush bookkeeping, filters)
// moved HERE together with the functions that close over it — settings.js re-exports the public
// API so every importer keeps using './settings.js'.
//
// NOTE on cycles: the static imports from settings.js / turn-state.js below form intentional
// ESM cycles. Every cross-module use happens inside a function body at CALL time (never during
// module evaluation), which ESM resolves safely via hoisted function declarations.

import { getSettings } from './settings.js';
import { getContext, escapeHtml, safeStringify, fmt } from './ui-util.js';
import {
    addToolLoopTokens, getLastRunTokens, getSessionTokens,
    getLastGenerated, getLastInserted, getLastInjection, getScene,
} from './turn-state.js';

// debugLog is the RAM RING BUFFER: holds ALL kept entries (incl. debug/verbose when
// enabled), newest-first, capped at MAX_DEBUG_ENTRIES_MEM. The chat_metadata copy is a
// verbose-stripped, byte-budgeted SLICE (MAX_DEBUG_ENTRIES_PERSIST). See addDebugLog /
// saveDebugLogToMeta below. Kept named `debugLog` so existing readers are unaffected.
let debugLog = [];
// Persisted slice cap — unchanged contract for the chat_metadata.bf_mem_log copy.
const MAX_DEBUG_ENTRIES = 500; // FIX #10: raised from 200 so a long session isn't truncated (still bounded)
// Two-cap scheme (debug-log redesign): the RAM ring buffer holds far more (the firehose,
// incl. debug/verbose) while only a non-verbose slice of MAX_DEBUG_ENTRIES_PERSIST reaches
// chat_metadata so the chat .jsonl stays small.
const MAX_DEBUG_ENTRIES_MEM = 2000;       // RAM ring buffer (drop-oldest)
const MAX_DEBUG_ENTRIES_PERSIST = MAX_DEBUG_ENTRIES; // persisted, verbose-stripped slice
// Byte budget for the JSON-serialized persisted slice (protects the chat .jsonl round-trip).
const LOG_PERSIST_BYTE_BUDGET = 256 * 1024; // ~256 KB
// Monotonic per-entry sequence — stable ordering within an identical timestamp.
let logSeq = 0;
// Ambient run id (set by beginRun/endRun). addDebugLog calls with no explicit opts.runId
// inherit this so leaf logs (db/retrieval) auto-tag without signature churn.
let currentRunId = null;
// Valid level/subsystem vocabularies (anything else falls back to a safe default).
const LOG_LEVELS = new Set(['fail', 'pass', 'info', 'debug', 'verbose']);
const LOG_SUBSYSTEMS = new Set([
    'pipeline', 'agent1', 'agent3', 'finder', 'retrieval', 'db',
    'entity', 'reflection', 'settings', 'import', 'cache', 'writer',
]);
// DISPLAY-only aliases for subsystem machine keys (the keys themselves are stable,
// for back-compat with persisted log entries + the filter dropdown values).
const SUBSYSTEM_DISPLAY = {
    agent1: 'Drafter',
    agent2: 'Writer',
    writer: 'Writer',
    agent3: 'Scribe',
    agent4: 'Librarian',
    finder: 'Librarian',
};
function subsystemLabel(key) {
    return SUBSYSTEM_DISPLAY[key] || key;
}

// --- Debug Log (persistent — stored in chat_metadata.bf_mem_log so it survives page reload) ---

const LOG_META_KEY = 'bf_mem_log';

// FIX #8: ctx.saveMetadata() is DEBOUNCED — rapid addDebugLog bursts each schedule
// a save the next call supersedes, so only entries that happen to coincide with
// ST's own chat-save reach disk. We add a throttled IMMEDIATE chat save (at most
// once per LOG_FLUSH_THROTTLE_MS) plus a guaranteed synchronous flush on
// beforeunload (the primary fix, since reload is exactly when data is lost).
const LOG_FLUSH_THROTTLE_MS = 5000;
let lastLogFlushAt = 0;

// --- Persistent debug-log FILE (full firehose, incl. verbose) ---
// The chat_metadata slice above stays small & verbose-STRIPPED for instant load; the FULL
// RAM ring buffer (incl. verbose) is ALSO mirrored to a dedicated per-chat attachment file
// (bf_mem_debuglog_<chatId>.json) via database.js, reusing the fact-DB attachment infra.
// That re-uploads the whole file each write (ST has no append), so we THROTTLE it on the
// same cadence as the metadata flush and only force it on beforeunload.
const LOG_FILE_FLUSH_THROTTLE_MS = 15000; // file write is heavier than metadata — throttle harder
let lastLogFileFlushAt = 0;               // last successful/attempted file write
let logFileDirty = false;                 // entries changed since the last file write
let logFileWriteInFlight = false;         // guard against overlapping async uploads
// The chatId the in-RAM `debugLog` buffer currently belongs to. Tracked so a CHAT_CHANGED can
// flush the OUTGOING chat's tail to the OUTGOING chat's file BEFORE the buffer is swapped — by
// the time CHAT_CHANGED fires, getContext().chatId is already the NEW chat, so flushing to the
// live chatId would mis-file the old tail. Set whenever reloadDebugLogFromChat resolves a chatId.
let _logBufferChatId = '';
// FILE CAP: how many newest entries (incl. verbose) the file retains. Bounds the re-upload
// size — at ~0.5 KB/entry this is roughly a 1.5–2 MB JSON ceiling. Oldest entries beyond
// this are dropped (the RAM ring buffer is the smaller MAX_DEBUG_ENTRIES_MEM cap).
const MAX_DEBUG_ENTRIES_FILE = 4000;

// --- runId threading (debug-log redesign §2) ---
// Ambient current run id. Any addDebugLog with no explicit opts.runId inherits this, so
// leaf logs (db/retrieval/eviction) auto-group without taking a runId parameter. An explicit
// opts.runId always wins. pendingRun generalizes the old reflectionPending pattern: it carries
// the inline run's id across the MESSAGE_RECEIVED boundary so a turn's pre-reply and post-reply
// events (extraction, reflection) share ONE id. Stored here (not in pipeline.js) so endRun/the
// summary can read it; pipeline owns arming/consuming it via the helpers below.
let pendingRun = null;

/** Set the ambient run id for the current turn. Explicit opts.runId on a log still overrides. */
export function beginRun(runId) {
    currentRunId = runId || null;
    return currentRunId;
}

/** Clear the ambient run id. Call at the end of a turn's logging window. */
export function endRun() {
    currentRunId = null;
}

/** Current ambient run id (null when no run active). */
export function getCurrentRunId() {
    return currentRunId;
}

/**
 * Arm post-reply work to share the inline run's id across the MESSAGE_RECEIVED boundary.
 * Generalizes reflectionPending — the post-reply extraction path calls consumePendingRun()
 * (or beginRun(getPendingRun().runId)) so Agent 3 extraction + reflection tag the SAME run
 * the user saw start, instead of minting a fresh `M…` id.
 * @param {{runId:string, startTime?:number}} info
 */
export function setPendingRun(info) {
    pendingRun = info && info.runId ? { ...info } : null;
}

/** Peek the armed pendingRun without clearing it. */
export function getPendingRun() {
    return pendingRun;
}

/** Read AND clear the armed pendingRun (one-shot consume across the reply boundary). */
export function consumePendingRun() {
    const p = pendingRun;
    pendingRun = null;
    return p;
}

/** Best-effort immediate (non-debounced) persist of the debug log to chat .jsonl. */
export function flushDebugLogNow() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();
        // Immediate, non-debounced chat write so the metadata reaches disk.
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
        lastLogFlushAt = Date.now();
    } catch { /* best-effort */ }
    // Also force the FULL (incl-verbose) file to flush. This is async/fire-and-forget;
    // on beforeunload the browser may not await it, but the throttled writes during the
    // session mean at most the last <throttle-window of verbose entries are at risk —
    // the metadata slice (above) and earlier file writes already reached disk.
    try { void flushDebugLogFile(true); } catch { /* best-effort */ }
}

/**
 * Build the FULL file payload: the whole RAM ring buffer (incl. verbose) capped at
 * MAX_DEBUG_ENTRIES_FILE newest entries. Kept newest-first to match the buffer; the loader
 * preserves order. This is what lands in the dedicated attachment file (NOT chat_metadata).
 */
function buildFileEntries() {
    return debugLog.slice(0, MAX_DEBUG_ENTRIES_FILE);
}

/**
 * Throttled, best-effort write of the FULL debug log to its dedicated attachment file.
 * Re-uploading the whole file is expensive, so this respects LOG_FILE_FLUSH_THROTTLE_MS
 * and never overlaps an in-flight upload. `force` (beforeunload / explicit flush) bypasses
 * the throttle. Async + fire-and-forget from addDebugLog; all errors are swallowed inside
 * database.js so the RAM buffer is never at risk.
 * @param {boolean} [force]
 * @param {string|null} [chatIdOverride] - target this chatId instead of the live one. Used on
 *   CHAT_CHANGED to file the OUTGOING chat's tail against the OUTGOING chatId (the live chatId
 *   has already advanced to the new chat by the time the event fires).
 */
async function flushDebugLogFile(force = false, chatIdOverride = null) {
    if (!logFileDirty && !force) return;
    if (logFileWriteInFlight) return; // a write is already running; dirty flag stays set
    if (!force && (Date.now() - lastLogFileFlushAt < LOG_FILE_FLUSH_THROTTLE_MS)) return;
    let chatId = chatIdOverride || '';
    if (!chatId) {
        try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
    }
    if (!chatId) return; // no chat open — keep entries in RAM until one is
    logFileWriteInFlight = true;
    lastLogFileFlushAt = Date.now();
    const snapshot = buildFileEntries(); // capture before the await so concurrent appends aren't lost-tracked
    logFileDirty = false;                // optimistic; re-set on failure below
    try {
        const { saveDebugLogFile } = await import('./database.js');
        const ok = await saveDebugLogFile(chatId, snapshot);
        if (!ok) logFileDirty = true; // upload failed/skipped — retry on the next tick
    } catch {
        logFileDirty = true;          // never throws into callers; just mark for retry
    } finally {
        logFileWriteInFlight = false;
    }
}

/**
 * Build the persisted slice: verbose-STRIPPED (the firehose stays RAM-only) and capped at
 * MAX_DEBUG_ENTRIES_PERSIST, then byte-budgeted so the chat .jsonl round-trip can't bloat.
 */
function buildPersistSlice() {
    // Drop verbose entries entirely — they never reach disk. Old entries (no `level`) are kept.
    let slice = debugLog.filter(e => e.level !== 'verbose').slice(0, MAX_DEBUG_ENTRIES_PERSIST);
    // Byte guard: if the serialized slice exceeds the budget, trim oldest (tail) until under.
    try {
        while (slice.length > 1 && JSON.stringify(slice).length > LOG_PERSIST_BYTE_BUDGET) {
            slice = slice.slice(0, slice.length - 1);
        }
    } catch { /* serialization guard is best-effort */ }
    return slice;
}

function loadDebugLogFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return [];
        const stored = md[LOG_META_KEY];
        // Shape-check: must be array of {type, message, timestamp}
        if (!Array.isArray(stored)) return [];
        return stored
            .filter(e => e && typeof e === 'object' && typeof e.message === 'string')
            .map(backfillEntry);
    } catch { return []; }
}

/**
 * Back-fill a persisted entry that may pre-date the structured schema (just {type,message,
 * timestamp}). Additive: derives level/subsystem/ts/seq if absent and parses a leading
 * [Rxxxx]/[Mxxxx] runId prefix from the message so OLD logs still group. Never overwrites
 * fields that are already present.
 */
function backfillEntry(e) {
    if (e.v == null) e.v = 1;
    if (typeof e.type !== 'string') e.type = 'info';
    if (typeof e.level !== 'string') e.level = e.type; // legacy type is a valid 3-value level
    if (typeof e.subsystem !== 'string') e.subsystem = 'settings';
    if (e.runId == null) {
        const m = /^\[([RM][0-9a-z]+)\]/.exec(e.message || '');
        e.runId = m ? m[1] : null;
    }
    if (typeof e.seq !== 'number') e.seq = ++logSeq;
    if (typeof e.ts !== 'number') {
        const parsed = e.iso ? Date.parse(e.iso) : NaN;
        e.ts = Number.isFinite(parsed) ? parsed : Date.now();
    }
    return e;
}

function saveDebugLogToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return; // no chat loaded — log lives in-memory only until a chat opens
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();
        // FIX #8: throttled immediate flush so a burst of entries doesn't all get
        // lost to the debounce on reload. Bounded to once per LOG_FLUSH_THROTTLE_MS
        // to avoid thrashing disk; the beforeunload handler guarantees the tail.
        if (Date.now() - lastLogFlushAt >= LOG_FLUSH_THROTTLE_MS) {
            if (typeof ctx.saveChat === 'function') ctx.saveChat();
            else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
            lastLogFlushAt = Date.now();
        }
    } catch { /* best-effort */ }
}

/**
 * Re-load the debug log on chat open / CHAT_CHANGED. Two-stage:
 *   1) SYNC: load the small verbose-stripped chat_metadata slice for an INSTANT render.
 *   2) ASYNC: fetch the dedicated per-chat attachment FILE (the full firehose, incl.
 *      verbose) and, if it has more entries than the metadata slice, swap it in. The file
 *      is the superset/preferred source; the slice is just the fast first paint. A new chat
 *      with no file keeps the (possibly empty) metadata slice — graceful missing-file path.
 * A token guards against an out-of-order resolve when the user switches chats mid-fetch.
 */
let debugLogLoadToken = 0;

/**
 * Flush the OUTGOING chat's debug-log tail to ITS OWN file before the buffer is swapped to a new
 * chat. Must run on CHAT_CHANGED *before* reloadDebugLogFromChat(): at that point `debugLog` still
 * holds the old chat's entries and `_logBufferChatId` still names the old chat, but the live
 * getContext().chatId has already advanced — so we force-flush the full buffer against the tracked
 * old chatId. Best-effort + never throws. Without this, the last <throttle-window of (esp. verbose)
 * entries for the chat you're leaving would be lost.
 */
export async function flushOutgoingChatLog() {
    const outgoing = _logBufferChatId;
    if (!outgoing) return;
    try { await flushDebugLogFile(true, outgoing); } catch { /* best-effort */ }
}

export function reloadDebugLogFromChat() {
    debugLog = loadDebugLogFromMeta();
    renderDebugLog();
    // Reset file-flush bookkeeping so the freshly-loaded chat starts clean.
    logFileDirty = false;
    const myToken = ++debugLogLoadToken;
    let chatId = '';
    try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
    // Remember which chat the RAM buffer now belongs to, so a later CHAT_CHANGED can flush this
    // chat's tail to this chat's file (see flushOutgoingChatLog).
    _logBufferChatId = chatId;
    if (!chatId) return;
    (async () => {
        try {
            const { loadDebugLogFile } = await import('./database.js');
            const fileEntries = await loadDebugLogFile(chatId);
            // Bail if the user switched chats (or this chat reloaded) while we were fetching.
            if (myToken !== debugLogLoadToken) return;
            if (Array.isArray(fileEntries) && fileEntries.length) {
                // The file is the superset (it carries verbose + more history). Prefer it
                // whenever it has at least as many entries as the metadata slice.
                const merged = fileEntries.map(backfillEntry).slice(0, MAX_DEBUG_ENTRIES_MEM);
                if (merged.length >= debugLog.length) {
                    debugLog = merged;
                    renderDebugLog();
                }
            }
        } catch { /* best-effort — keep the metadata slice already loaded */ }
    })();
}

/** Map a legacy `type` to a 5-value level (for existing 2-arg call sites). */
function typeToLevel(type) {
    return LOG_LEVELS.has(type) ? type : 'info';
}

/** Derive the 3-value legacy `type` from a 5-value level (so old readers never break). */
function levelToType(level) {
    return (level === 'fail' || level === 'pass') ? level : 'info';
}

/**
 * Append a debug-log entry. BACKWARD-COMPATIBLE:
 *   addDebugLog('info', 'message')                       // legacy 2-arg — unchanged behavior
 *   addDebugLog('info', 'message', { runId, subsystem,   // new structured form
 *     event, level, data, reason, actor, before, after })
 *
 * The stored entry ALWAYS keeps the legacy keys {type, message, timestamp} verbatim, so old
 * readers (renderDebugLog, exportLogs, the shape-check on load) keep working. New optional
 * fields are additive. `level` (5-value) is the superset of `type` (3-value); whichever is
 * supplied derives the other. Verbose entries are gated by the debugVerbose setting and are
 * NEVER persisted (RAM-only).
 *
 * @param {string} type  legacy type OR (when opts.level absent) the level shorthand
 * @param {string} message human-readable string (unchanged contract)
 * @param {object} [opts] { runId, level, subsystem, event, data, reason, actor, before, after }
 */
export function addDebugLog(type, message, opts = {}) {
    if (!opts || typeof opts !== 'object') opts = {};

    // Level/type derivation: opts.level (5-value) wins; else derive from the legacy `type`.
    const level = LOG_LEVELS.has(opts.level) ? opts.level : typeToLevel(type);
    const legacyType = levelToType(level);

    // Verbose gating: drop at INGESTION when the firehose toggle is off, so verbose never
    // costs ring-buffer space, render time, or storage.
    if (level === 'verbose' && !getSettings()?.debugVerbose) return;

    const subsystem = LOG_SUBSYSTEMS.has(opts.subsystem) ? opts.subsystem : 'settings';
    // runId: explicit opts.runId overrides the ambient currentRunId set by beginRun().
    const runId = (opts.runId != null && opts.runId !== '') ? opts.runId : currentRunId;

    const now = new Date();
    const entry = {
        // --- legacy keys (kept EXACTLY for back-compat readers / text export) ---
        type: legacyType,
        message,
        timestamp: now.toLocaleTimeString(),
        // --- structured fields (additive, all optional to downstream readers) ---
        v: 1,
        ts: now.getTime(),
        iso: now.toISOString(),
        seq: ++logSeq,
        level,
        subsystem,
        runId: runId ?? null,
    };
    // Only attach optional structured fields when provided (keeps small entries small).
    if (opts.event != null) entry.event = opts.event;
    if (opts.data != null) entry.data = opts.data;
    if (opts.reason != null) entry.reason = opts.reason;
    if (opts.actor != null) entry.actor = opts.actor;
    if (opts.before !== undefined) entry.before = opts.before;
    if (opts.after !== undefined) entry.after = opts.after;

    // RAM ring buffer: newest-first, drop-oldest beyond MAX_DEBUG_ENTRIES_MEM.
    debugLog.unshift(entry);
    if (debugLog.length > MAX_DEBUG_ENTRIES_MEM) debugLog.length = MAX_DEBUG_ENTRIES_MEM;

    // Persist a verbose-stripped, byte-budgeted slice to chat_metadata (survives reload,
    // instant load). The FULL buffer (incl. verbose) goes to the dedicated attachment file.
    saveDebugLogToMeta();
    logFileDirty = true;
    void flushDebugLogFile(false); // throttled; async fire-and-forget (errors swallowed)
    renderDebugLog();
    // Tool-first redesign: refresh the "What Claude did" panel on tool-call events so memory
    // recalls/writes appear live. Cheap (scans the small ring buffer); guarded inside.
    // Each such event is ONE tool invocation → also fold its estimated re-billed prompt
    // round-trip into the run/session token records (addToolLoopTokens).
    if (entry.event === 'tool.search_memory' || entry.event === 'tool.remember_fact') {
        addToolLoopTokens();
        renderToolActivity();
    }

    if (getSettings()?.debugMode) {
        const tag = level.toUpperCase();
        const sub = subsystem !== 'settings' ? ` ${subsystem}` : '';
        const rid = runId ? ` [${runId}]` : '';
        console.log(`[BFMemory] [${tag}]${rid}${sub} ${message}`);
    }
}

// Per-turn tool-call count beyond which a turn is flagged as a possible runaway tool loop (Phase 2
// observability). Soft — purely visual; nothing is blocked.
const TOOL_ACTIVITY_SOFTCAP = 8;

/**
 * "What Claude did" panel (tool-first redesign). Scans the in-memory debug ring buffer for the
 * main model's memory tool calls (`search_memory` recall + `remember_fact` pin), groups them by
 * runId (one turn), and renders the most recent turns so the user can SEE the tool-driven memory
 * working. A high per-turn call count is flagged. Pure read of `debugLog`; safe to call anytime.
 */
export function renderToolActivity() {
    const el = document.getElementById('bf_mem_tool_activity');
    if (!el) return; // panel not in DOM (older template / tab not built) — no-op
    const summaryEl = document.getElementById('bf_mem_tool_activity_summary');
    const calls = debugLog.filter(e => e.event === 'tool.search_memory' || e.event === 'tool.remember_fact');
    if (calls.length === 0) {
        el.innerHTML = '<div class="bf-mem-hint" style="opacity:.7;">No memory tool calls recorded yet. When the main model calls <code>search_memory</code> / <code>remember_fact</code>, they appear here.</div>';
        if (summaryEl) summaryEl.textContent = '';
        return;
    }
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Group by runId (a turn), preserving the newest-first order of the buffer.
    const groups = new Map(); // runId -> { rid, search: [], write: [] }
    for (const e of calls) {
        const rid = e.runId || '(no turn id)';
        if (!groups.has(rid)) groups.set(rid, { rid, search: [], write: [] });
        const g = groups.get(rid);
        (e.event === 'tool.search_memory' ? g.search : g.write).push(e);
    }
    const turns = [...groups.values()].slice(0, 12); // most recent 12 turns
    // Per-call token ESTIMATE: each tool call re-bills the whole prompt as an extra round-trip,
    // priced at the LAST measured main-model prompt input (see addToolLoopTokens). One current
    // figure is applied to every listed turn — older turns had a different prompt size, so their
    // line is an approximation (0 → estimate hidden when no run has measured input yet).
    const perCall = Number(getLastRunTokens()?.actualInput) || Number(getLastRunTokens()?.baselineInput) || 0;
    let totalSearch = 0, totalWrite = 0;
    const html = turns.map(g => {
        const n = g.search.length + g.write.length;
        totalSearch += g.search.length; totalWrite += g.write.length;
        const hot = n > TOOL_ACTIVITY_SOFTCAP;
        const rows = [];
        for (const e of g.search) {
            const d = e.data || {};
            const cnt = d.resultCount != null ? d.resultCount : '?';
            rows.push(`<div class="bf-mem-tool-row"><span class="bf-mem-tool-badge bf-mem-tool-search">recall</span> <code>${esc(d.query || '')}</code>${d.category ? ` <span class="bf-mem-dim">[${esc(d.category)}]</span>` : ''}${d.with ? ` <span class="bf-mem-dim">with ${esc(d.with)}</span>` : ''} → <b>${esc(cnt)}</b> fact(s)</div>`);
        }
        for (const e of g.write) {
            const d = e.data || {};
            rows.push(`<div class="bf-mem-tool-row"><span class="bf-mem-tool-badge bf-mem-tool-write">pin</span> <code>${esc(d.category)}/${esc(d.key)}</code> = ${esc(String(d.value || '').slice(0, 80))}</div>`);
        }
        return `<details class="bf-mem-tool-turn" open>`
            + `<summary>Turn <code>${esc(g.rid)}</code> — ${g.search.length} recall, ${g.write.length} pin`
            + (perCall ? ` <span class="bf-mem-dim" title="Estimated re-billed prompt tokens: ${n} call(s) × last measured prompt input (${fmt(perCall)}). Each tool call re-sends the whole prompt as an extra round-trip.">· ~${fmt(n * perCall)} tok</span>` : '')
            + (hot ? ` <span class="bf-mem-tool-warn" title="High tool-call count this turn — possible runaway loop">⚠ ${n} calls</span>` : '')
            + `</summary>${rows.join('')}</details>`;
    }).join('');
    el.innerHTML = html;
    if (summaryEl) summaryEl.textContent = `${turns.length} turn(s) · ${totalSearch} recall, ${totalWrite} pin`
        + (perCall ? ` · ~${fmt((totalSearch + totalWrite) * perCall)} tok est.` : '');
}

/**
 * "Copy Diagnostics" (Debug tab). Bundles EVERYTHING needed to debug the extension into one JSON
 * blob — settings, the full debug log (inputs/outputs/events), the entire fact database INCLUDING
 * each fact's relationships (the graph/web), the current scene, the entity registry, and any pending
 * review — then downloads it as a file AND copies it to the clipboard so the user can paste it for
 * support. Best-effort throughout: a failure in any one section is captured inline, never aborts the
 * export. NOTE: this contains roleplay content (facts/logs); it does NOT include API keys (those
 * live in ST connection profiles, not this extension's settings).
 */
export async function copyDiagnostics() {
    let payload;
    try {
        const ctx = getContext();
        let databases = {}, scene = null, entities = {}, review = null, extVersion = null;
        try { const m = await (await fetch(new URL('../manifest.json', import.meta.url))).json(); extVersion = m.version; } catch { /* version best-effort */ }
        try { const dbm = await import('./database.js'); databases = await dbm.getAllDatabases(); } catch (e) { databases = { __error: String(e?.message || e) }; }
        try { scene = getScene(); } catch { /* none */ }
        try { const ent = await import('./agent-entities.js'); entities = ent.getEntities() || {}; } catch { /* none */ }
        try { review = (ctx.chatMetadata || ctx.chat_metadata || {}).bf_mem_review || null; } catch { /* none */ }
        let factCount = 0, linkCount = 0;
        for (const cdb of Object.values(databases || {})) {
            for (const f of (cdb?.facts || [])) {
                factCount++;
                const r = f.relationships || {};
                linkCount += (r.primary?.length || 0) + (r.secondary?.length || 0) + (r.tertiary?.length || 0);
            }
        }
        const diag = {
            meta: {
                exported: new Date().toISOString(),
                extensionVersion: extVersion,
                stVersion: ctx?.version ?? null,
                character: (() => { try { return ctx.characters?.[ctx.characterId]?.name ?? null; } catch { return null; } })(),
                chatId: (() => { try { return ctx.chatId ?? ctx.getCurrentChatId?.() ?? null; } catch { return null; } })(),
                counts: {
                    categories: Object.keys(databases || {}).length,
                    facts: factCount, links: linkCount,
                    entities: Object.keys(entities || {}).length,
                    logEntries: debugLog.length,
                },
                // Honesty note: this is EVERYTHING the extension itself holds. The model's full
                // assembled prompt (chat history + persona + ST's own additions) is built by
                // SillyTavern, not this extension, so it is not captured here — but the memory block
                // this extension injected IS (see `lastInjection`).
                note: 'Complete extension state. The model\'s full ST-assembled prompt is outside this extension; the memory block it injected is in lastInjection.',
            },
            settings: getSettings(),   // all extension settings (no API keys)
            tokens: {                      // "tokens used" — per-run breakdown + session totals
                lastRun: getLastRunTokens(),
                session: getSessionTokens(),
            },
            lastInjection: getLastInjection(), // the memory CONTEXT block injected into the writer last turn (facts + approx tokens)
            lastGenerated: getLastGenerated(), // the Scribe's extracted updates last turn (agent OUTPUT)
            lastInserted: getLastInserted(),  // what was actually written to the DB last turn
            scene,
            entities,                      // recurring-characters registry
            reviewPending: review,
            databases,                     // facts INCLUDE their relationships = the graph/web
            debugLog,                      // all inputs/outputs/events (newest-first ring buffer)
        };
        payload = JSON.stringify(diag, null, 2);
    } catch (e) {
        payload = JSON.stringify({ error: 'diagnostics build failed: ' + String(e?.message || e) }, null, 2);
    }
    // Download as a file (mirrors Export JSON) AND copy to clipboard.
    let chatId = 'diag';
    try { chatId = String(getContext().chatId ?? 'diag'); } catch { /* none */ }
    try {
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `bf-mem-diagnostics-${chatId}-${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { /* download best-effort */ }
    try {
        await navigator.clipboard.writeText(payload);
        try { toastr.success(`Diagnostics copied + downloaded (${Math.round(payload.length / 1024)} KB)`, 'BF Memory'); } catch { /* toast best-effort */ }
    } catch {
        // Clipboard blocked (common for large payloads / mobile) — show a select-all textarea overlay.
        try {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1a1a2e);padding:16px;border-radius:8px;max-width:720px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:8px;';
            const title = document.createElement('div'); title.textContent = 'Copy diagnostics'; title.style.cssText = 'font-weight:bold;color:#7bb3ff;';
            const hint = document.createElement('div'); hint.textContent = 'Clipboard was blocked. Ctrl+A / long-press in the box, then Copy. (It was also downloaded as a file.)'; hint.style.cssText = 'font-size:12px;opacity:0.7;';
            const ta = document.createElement('textarea'); ta.value = payload; ta.style.cssText = 'width:100%;flex:1;min-height:320px;font-family:monospace;font-size:11px;';
            const close = document.createElement('button'); close.textContent = 'Close'; close.className = 'menu_button'; close.onclick = () => overlay.remove();
            card.append(title, hint, ta, close); overlay.appendChild(card); document.body.appendChild(overlay);
            ta.focus(); ta.select();
        } catch { /* file download already succeeded */ }
    }
}

// --- Debug-log filter state (client-side over the in-memory ring buffer) ---
// Level checkboxes default to fail+pass+info; debug/verbose opt-in. The verbose level is
// further gated by the debugVerbose SETTING (capture-side) — when off, verbose entries
// never enter the buffer regardless of this display filter.
const DEFAULT_LOG_LEVEL_FILTER = new Set(['fail', 'pass', 'info']);
let logLevelFilter = new Set(DEFAULT_LOG_LEVEL_FILTER);
let logSubsystemFilter = '';
let logSearchFilter = '';

/** Read the current filter UI into module state (no-op when the controls aren't mounted). */
function syncLogFilterFromUI() {
    const boxes = document.querySelectorAll('.bf-mem-log-level');
    if (boxes.length) {
        logLevelFilter = new Set();
        boxes.forEach(b => { if (b.checked) logLevelFilter.add(b.value); });
    }
    const sub = document.getElementById('bf_mem_log_subsystem');
    if (sub) logSubsystemFilter = sub.value || '';
    const search = document.getElementById('bf_mem_log_search');
    if (search) logSearchFilter = (search.value || '').trim().toLowerCase();
}

/** True if an entry passes the active level/subsystem/text filters. */
function entryMatchesFilter(entry) {
    const level = entry.level || entry.type || 'info';
    if (logLevelFilter.size && !logLevelFilter.has(level)) return false;
    if (logSubsystemFilter && (entry.subsystem || 'settings') !== logSubsystemFilter) return false;
    if (logSearchFilter) {
        const hay = (
            (entry.message || '') + ' ' +
            (entry.runId || '') + ' ' +
            (entry.event || '') + ' ' +
            (entry.subsystem || '') + ' ' +
            (entry.data != null ? safeStringify(entry.data) : '')
        ).toLowerCase();
        if (!hay.includes(logSearchFilter)) return false;
    }
    return true;
}

/** Compact human header for a run, derived from its run.summary entry's `data` blob. */
function formatRunSummary(runId, summaryEntry) {
    const shortId = runId || '(run)';
    if (!summaryEntry || !summaryEntry.data) {
        return `Run ${shortId}`;
    }
    const d = summaryEntry.data;
    const parts = [`Run ${shortId}`];
    if (Number.isFinite(d.durationMs)) parts.push(`${d.durationMs}ms`);
    if (d.agents) {
        const mark = (s) => s === 'ok' ? '✓' : s === 'failed' ? '✗' : s === 'skipped' ? '–' : '?';
        const ag = [];
        if (d.agents.agent1) ag.push(`Drafter${mark(d.agents.agent1)}`);
        if (d.agents.agent3) ag.push(`Scribe${mark(d.agents.agent3)}`);
        if (ag.length) parts.push(ag.join(' '));
    }
    if (d.facts) {
        const f = d.facts;
        const fstr = `facts ${f.NEW ?? 0}N/${f.UPDATED ?? 0}U/${f.SKIPPED ?? 0}S` +
            (f.EVICTED ? `/${f.EVICTED}E` : '');
        parts.push(fstr);
    }
    if (d.tokens && Number.isFinite(d.tokens.netIn)) {
        const n = d.tokens.netIn;
        const tok = Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        parts.push(`${n >= 0 ? '+' : ''}${tok} tok`);
    }
    if (d.cancelled) parts.push('CANCELLED');
    return parts.join(' · ');
}

/** Render one entry as an HTML string (shared by flat + grouped paths). */
function renderEntryHtml(entry) {
    const level = entry.level || entry.type || 'info';
    const meta = [];
    if (entry.subsystem && entry.subsystem !== 'settings') meta.push(escapeHtml(subsystemLabel(entry.subsystem)));
    const metaHtml = meta.length ? `<span class="bf-mem-log-sub">${meta.join(' ')}</span> ` : '';
    return `
        <div class="bf-mem-debug-entry ${escapeHtml(level)}" data-event="${escapeHtml(entry.event || '')}" data-run="${escapeHtml(entry.runId || '')}">
            <span class="bf-mem-log-time">[${escapeHtml(entry.timestamp)}]</span> ${metaHtml}${escapeHtml(entry.message).replace(/\n/g, '<br>')}
        </div>`;
}

export function renderDebugLog() {
    const container = document.getElementById('bf_mem_debug_log');
    if (!container) return;

    syncLogFilterFromUI();

    const total = debugLog.length;
    const visible = debugLog.filter(entryMatchesFilter);

    // Group visible entries by runId, newest run first. The ring buffer is already
    // newest-first, so the first time we see a runId fixes its display order. Entries with
    // no runId collect under a synthetic "Ungrouped / manual" block at the end.
    const order = [];
    const groups = new Map(); // runId -> entries[]
    const ungrouped = [];
    for (const e of visible) {
        const rid = e.runId;
        if (!rid) { ungrouped.push(e); continue; }
        if (!groups.has(rid)) { groups.set(rid, []); order.push(rid); }
        groups.get(rid).push(e);
    }

    // Map each runId to its summary entry (search the FULL buffer, not just the visible
    // slice, so a filtered-out summary still drives the header). Within a run, summary is
    // typically present once; fall back to a generic header when absent.
    const summaryByRun = new Map();
    for (const e of debugLog) {
        if (e.runId && e.event === 'run.summary' && !summaryByRun.has(e.runId)) {
            summaryByRun.set(e.runId, e);
        }
    }

    const blocks = [];
    for (const rid of order) {
        const entries = groups.get(rid);
        const summary = summaryByRun.get(rid);
        const headerLevel = (summary && (summary.level || summary.type)) || 'info';
        const header = escapeHtml(formatRunSummary(rid, summary));
        const body = entries.map(renderEntryHtml).join('');
        blocks.push(
            `<details class="bf-mem-run-group ${escapeHtml(headerLevel)}">` +
            `<summary>${header} <span class="bf-mem-run-count">(${entries.length})</span></summary>` +
            `<div class="bf-mem-run-body">${body}</div>` +
            `</details>`,
        );
    }
    if (ungrouped.length) {
        const body = ungrouped.map(renderEntryHtml).join('');
        blocks.push(
            `<details class="bf-mem-run-group ungrouped" open>` +
            `<summary>Ungrouped / manual <span class="bf-mem-run-count">(${ungrouped.length})</span></summary>` +
            `<div class="bf-mem-run-body">${body}</div>` +
            `</details>`,
        );
    }

    container.innerHTML = blocks.join('') ||
        '<div class="bf-mem-summary-empty">No log entries match the current filter.</div>';

    const countEl = document.getElementById('bf_mem_log_count');
    if (countEl) countEl.textContent = `showing ${visible.length} / ${total}`;
}

export function exportLogs() {
    // Export what the user is actually looking at: respect the active level/subsystem/search
    // filters so "Copy log" matches the on-screen view rather than dumping the whole buffer.
    try { syncLogFilterFromUI(); } catch { /* filter UI may not be mounted */ }
    const total = debugLog.length;
    const visible = debugLog.filter(entryMatchesFilter);
    const header = `=== BF Memory Pipeline Debug Logs ===\nExported: ${new Date().toISOString()}\nEntries: ${visible.length} of ${total} (filtered)\n${'='.repeat(40)}\n\n`;
    const logText = visible.map(entry => `[${entry.timestamp}] [${(entry.type || entry.level || 'info').toUpperCase().padEnd(5)}] ${entry.message}`).join('\n');
    const out = header + logText;
    addDebugLog('info', `Logs exported (${visible.length} of ${total} entries)`, {
        subsystem: 'settings', event: 'log.exported', actor: 'USER', data: { entryCount: visible.length, totalCount: total },
    });
    return out;
}

/**
 * Machine-readable export of the FULL RAM ring buffer (incl. debug/verbose when present) as
 * pretty JSON — the artifact for "investigate what changed why". Full `data` blobs included.
 * Returns the JSON string; callers handle download/clipboard.
 */
export function exportLogsJSON() {
    let chatId = null;
    try { chatId = getContext().chatId ?? null; } catch { /* no chat */ }
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        chatId,
        entries: debugLog,
    }, null, 2);
}

// --- F-UX-8 split additions ---------------------------------------------------------------

/**
 * Clear the debug log everywhere it lives (Debug tab "Clear log" button): the RAM ring buffer,
 * the persisted chat_metadata slice, the file-dirty flag, and (best-effort, async) the dedicated
 * per-chat attachment file — then re-render. Moved verbatim from the settings.js click handler
 * during the F-UX-8 split; behavior unchanged.
 */
export function clearDebugLog() {
    debugLog = [];
    saveDebugLogToMeta(); // also clear the persistent metadata slice
    // Also delete the dedicated debug-log FILE for this chat (best-effort, async).
    logFileDirty = false;
    let chatId = '';
    try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
    if (chatId) {
        (async () => {
            try { const { deleteDebugLogFile } = await import('./database.js'); await deleteDebugLogFile(chatId); }
            catch { /* best-effort */ }
        })();
    }
    renderDebugLog();
}

/**
 * The in-RAM ring buffer (newest-first). Read-only accessor for settings.js (entry-count
 * toasts) — the buffer itself stays module-private here so there is exactly one owner.
 */
export function getDebugLogEntries() {
    return debugLog;
}
