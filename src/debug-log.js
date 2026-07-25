import { getSettings } from './settings.js';
import { getContext, escapeHtml, safeStringify } from './ui-util.js';
import {
    getLastRunTokens, getSessionTokens,
    getLastGenerated, getLastInserted,
    getMemorySheet, getSheetHistory, getStorySpine, getSummaryPyramid, getReflection,
    getSceneStoreSnapshot, getScenePresent, getLastNeedRefs, getRecoveredRefs,
    getReflectionMetaState,
} from './turn-state.js';

let debugLog = [];

const MAX_DEBUG_ENTRIES = 500;

const MAX_DEBUG_ENTRIES_MEM = 2000;
const MAX_DEBUG_ENTRIES_PERSIST = MAX_DEBUG_ENTRIES;

const LOG_PERSIST_BYTE_BUDGET = 256 * 1024;

const TRACE_SUBSYSTEM = 'trace';

// ---------------------------------------------------------------------------
// THE TRACE RING IS SEPARATE FROM THE DIAGNOSTIC RING. This is the single most
// important structural fact about test-run recording.
//
// Trace entries used to share `debugLog`. A recorded turn emits roughly 51 of
// them against ~20 ordinary entries, so within three turns the 2000 ordinary
// slots were down to ~560 survivors — and because flushDebugLogFile DELETES the
// character attachment and re-uploads whatever is left in RAM, that eviction was
// written to disk every 15 seconds. Turning recording off did not bring the lost
// history back. Recording a run must never cost you the diagnostics you were
// recording it to explain.
//
// So: ordinary entries go to `debugLog` exactly as before — same ring, same
// eviction, same persistence, same attachment rewrite — and trace entries go
// here instead. addDebugLog is the fork (see the routing block there).
//
// This buffer is RAM-ONLY and has no writer to chatMetadata or to the
// attachment: nothing in this file passes `traceLog` to buildPersistSlice,
// buildFileEntries or saveDebugLogFile, and a trace entry never enters the array
// those three read. It is dropped on chat switch (reloadDebugLogFromChat) and on
// reload, which is what the UI text promises.
//
// CAP. Sized against the memory ceiling, not against the diagnostic ring: one
// entry is capped at TRACE_MAX_ENTRY_CHARS (32000), so 600 entries is a worst
// case of 19.2 M chars ≈ 38 MB of UTF-16 — a third of what the shared 2000-slot
// ring could reach, and roughly 2-4 MB in practice at a typical 2-6 KB/entry.
// At ~51 entries per recorded turn that holds about 11 full turns, which is
// several turns of regression hunting without putting the tab at risk. Raising
// it trades tab stability for depth, linearly.
const MAX_TRACE_ENTRIES_MEM = 600;

let traceLog = [];

let logSeq = 0;

let currentRunId = null;

const LOG_LEVELS = new Set(['fail', 'pass', 'info', 'debug', 'verbose']);
const LOG_SUBSYSTEMS = new Set([
    'pipeline', 'agent1', 'agent3', 'finder', 'retrieval', 'db',
    'entity', 'reflection', 'settings', 'import', 'cache', 'writer',
    // Full-text test-run captures. Deliberately its own subsystem rather than
    // the capturing agent's: filtering to it shows the whole recorded run in
    // one place, and the owning agent is already named in the event.
    'trace',
]);

const SUBSYSTEM_DISPLAY = {
    trace: 'Trace',
    agent2: 'Writer',
    writer: 'Writer',
    agent3: 'Memory Agent',
    agent4: 'Librarian',
    finder: 'Librarian',
};
function subsystemLabel(key) {
    return SUBSYSTEM_DISPLAY[key] || key;
}

const LOG_META_KEY = 'bf_mem_log';

const LOG_FLUSH_THROTTLE_MS = 5000;
let lastLogFlushAt = 0;

const LOG_FILE_FLUSH_THROTTLE_MS = 15000; 
let lastLogFileFlushAt = 0;               
let logFileDirty = false;                 
let logFileWriteInFlight = false;         

let _logBufferChatId = '';

const MAX_DEBUG_ENTRIES_FILE = 4000;

let pendingRun = null;

export function beginRun(runId) {
    currentRunId = runId || null;
    return currentRunId;
}

export function endRun() {
    currentRunId = null;
}

export function setPendingRun(info) {
    pendingRun = info && info.runId ? { ...info } : null;
}

export function getPendingRun() {
    return pendingRun;
}

export function consumePendingRun() {
    const p = pendingRun;
    pendingRun = null;
    return p;
}

export function flushDebugLogNow() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();

        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
        lastLogFlushAt = Date.now();
    } catch {  }

    try { void flushDebugLogFile(true); } catch {  }
}

function buildFileEntries() {
    // Same verbose exclusion as buildPersistSlice, for the same reason. This
    // tier writes a character ATTACHMENT (database.js saveDebugLogFile) and
    // reloadDebugLogFromChat reads it straight back into the ring, so a verbose
    // entry leaking here would come back as a persisted one on the next chat
    // load.
    //
    // Traces are NOT what this filter is for any more — they are on their own
    // ring and are not in `debugLog` at all, so they neither reach this slice
    // nor consume a file slot. The filter is kept because `debugVerbose` (the
    // manual firehose checkbox) admits verbose entries from ANY subsystem into
    // the ordinary ring, and for those this is the only guard there is.
    return debugLog.filter(e => e.level !== 'verbose').slice(0, MAX_DEBUG_ENTRIES_FILE);
}

async function flushDebugLogFile(force = false, chatIdOverride = null) {
    if (!logFileDirty && !force) return;
    if (logFileWriteInFlight) return; 
    if (!force && (Date.now() - lastLogFileFlushAt < LOG_FILE_FLUSH_THROTTLE_MS)) return;
    let chatId = chatIdOverride || '';
    if (!chatId) {
        try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch {  }
    }
    if (!chatId) return; 
    logFileWriteInFlight = true;
    lastLogFileFlushAt = Date.now();
    const snapshot = buildFileEntries(); 
    logFileDirty = false;                
    try {
        const { saveDebugLogFile } = await import('./database.js');
        const ok = await saveDebugLogFile(chatId, snapshot);
        if (!ok) logFileDirty = true; 
    } catch {
        logFileDirty = true;          
    } finally {
        logFileWriteInFlight = false;
    }
}

function buildPersistSlice() {

    // Verbose is dropped here for the same reason as in buildFileEntries, and
    // `debugLog` already contains no trace entries — see the trace-ring note at
    // the top of the file.
    let slice = debugLog.filter(e => e.level !== 'verbose').slice(0, MAX_DEBUG_ENTRIES_PERSIST);

    try {
        while (slice.length > 1 && JSON.stringify(slice).length > LOG_PERSIST_BYTE_BUDGET) {
            slice = slice.slice(0, slice.length - 1);
        }
    } catch {  }
    return slice;
}

function loadDebugLogFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return [];
        const stored = md[LOG_META_KEY];

        if (!Array.isArray(stored)) return [];
        return stored
            .filter(e => e && typeof e === 'object' && typeof e.message === 'string')
            .map(backfillEntry);
    } catch { return []; }
}

function backfillEntry(e) {
    if (e.v == null) e.v = 1;
    if (typeof e.type !== 'string') e.type = 'info';
    if (typeof e.level !== 'string') e.level = e.type; 
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
        if (!md) return; 
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();

        if (Date.now() - lastLogFlushAt >= LOG_FLUSH_THROTTLE_MS) {
            if (typeof ctx.saveChat === 'function') ctx.saveChat();
            else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
            lastLogFlushAt = Date.now();
        }
    } catch {  }
}

let debugLogLoadToken = 0;

export async function flushOutgoingChatLog() {
    const outgoing = _logBufferChatId;
    if (!outgoing) return;
    try { await flushDebugLogFile(true, outgoing); } catch {  }
}

export function reloadDebugLogFromChat() {
    debugLog = loadDebugLogFromMeta();
    // Traces belong to the chat they were captured in and there is no persisted
    // copy to reload, so the ring is dropped rather than carried across. Same
    // observable behaviour as when traces lived on the shared ring (which this
    // function replaced wholesale) — the UI's "lost on chat switch" text stays
    // true.
    traceLog = [];
    renderDebugLog();

    logFileDirty = false;
    const myToken = ++debugLogLoadToken;
    let chatId = '';
    try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch {  }

    _logBufferChatId = chatId;
    if (!chatId) return;
    (async () => {
        try {
            const { loadDebugLogFile } = await import('./database.js');
            const fileEntries = await loadDebugLogFile(chatId);

            if (myToken !== debugLogLoadToken) return;
            if (Array.isArray(fileEntries) && fileEntries.length) {

                const merged = fileEntries.map(backfillEntry).slice(0, MAX_DEBUG_ENTRIES_MEM);
                if (merged.length >= debugLog.length) {
                    debugLog = merged;
                    renderDebugLog();
                }
            }
        } catch {  }
    })();
}

function typeToLevel(type) {
    return LOG_LEVELS.has(type) ? type : 'info';
}

function levelToType(level) {
    return (level === 'fail' || level === 'pass') ? level : 'info';
}

export function addDebugLog(type, message, opts = {}) {
    if (!opts || typeof opts !== 'object') opts = {};

    const level = LOG_LEVELS.has(opts.level) ? opts.level : typeToLevel(type);
    const legacyType = levelToType(level);

    // Two independent switches ask for verbose entries: `debugVerbose` (the
    // manual firehose checkbox) and `debugTraceRun` (the "record a test run"
    // switch that drives traceCapture). Either one being on means the user
    // asked for them. For traces this is only a backstop — traceCapture returns
    // before it builds anything.
    if (level === 'verbose') {
        const s = getSettings();
        if (!s?.debugVerbose && !s?.debugTraceRun) return;
    }

    const subsystem = LOG_SUBSYSTEMS.has(opts.subsystem) ? opts.subsystem : 'settings';

    const runId = (opts.runId != null && opts.runId !== '') ? opts.runId : currentRunId;

    const now = new Date();
    const entry = {

        type: legacyType,
        message,
        timestamp: now.toLocaleTimeString(),

        v: 1,
        ts: now.getTime(),
        iso: now.toISOString(),
        seq: ++logSeq,
        level,
        subsystem,
        runId: runId ?? null,
    };

    if (opts.event != null) entry.event = opts.event;
    if (opts.data != null) entry.data = opts.data;
    if (opts.reason != null) entry.reason = opts.reason;
    if (opts.actor != null) entry.actor = opts.actor;
    if (opts.before !== undefined) entry.before = opts.before;
    if (opts.after !== undefined) entry.after = opts.after;

    // THE FORK. A trace payload goes to its own ring and nowhere near the
    // persistence machinery: no chatMetadata write, no dirty flag, no attachment
    // rewrite. Besides protecting the ordinary history from eviction (see the
    // trace-ring note at the top), this is what stops ~51 captures per turn from
    // triggering ~51 saveMetadata() calls and ~51 stringifications of the 256 KB
    // persist slice for entries that could never be persisted anyway.
    //
    // Discriminated on level AND subsystem so that only real traceCapture output
    // is diverted: the `trace.misuse` entry traceCapture logs at `fail` level is
    // a code bug, and it belongs in the ordinary log where the user will see it.
    if (level === 'verbose' && subsystem === TRACE_SUBSYSTEM) {
        traceLog.unshift(entry);
        if (traceLog.length > MAX_TRACE_ENTRIES_MEM) traceLog.length = MAX_TRACE_ENTRIES_MEM;
        renderDebugLog();
    } else {
        debugLog.unshift(entry);
        if (debugLog.length > MAX_DEBUG_ENTRIES_MEM) debugLog.length = MAX_DEBUG_ENTRIES_MEM;

        saveDebugLogToMeta();
        logFileDirty = true;
        void flushDebugLogFile(false);
        renderDebugLog();
    }

    if (getSettings()?.debugMode) {
        const tag = level.toUpperCase();
        const sub = subsystem !== 'settings' ? ` ${subsystem}` : '';
        const rid = runId ? ` [${runId}]` : '';
        console.log(`[BFMemory] [${tag}]${rid}${sub} ${message}`);
    }
}

// ---------------------------------------------------------------------------
// Test-run trace capture ("Testlauf aufzeichnen").
//
// Every memory WRITE is already logged with before/after values. What is not
// logged anywhere is the CONTEXT a write was based on: the system prompt an
// agent was given, the task block it was handed, the raw reply it produced, the
// arguments it passed to a tool and what that tool handed back. Without those
// you can see that a fact was repaired but not why the agent thought so.
//
// All of that is far too big to keep in a chat file — a single extraction
// prompt is multiple KB, a reflection story window is up to 12000 chars. So
// traces land on their OWN ring (`traceLog`, see the note at the top of this
// file), which no persistence path reads. They are RAM-only by construction:
// the Debug tab renders them and the export groups them, and they never reach
// chatMetadata or the character attachment. They also ride the `verbose` level,
// which is what keeps them out of the Debug tab's default view and what the
// export's level filters key on. Nothing in the codebase emitted `verbose`
// before this block existed.
//
// Recording is off by default and must cost nothing when off — see traceCapture
// for the thunk contract that keeps it that way.
// ---------------------------------------------------------------------------

// Per-string cap. Sized so the single biggest legitimate field — the reflection
// story window, which agent-reflect.js already caps at 12000 chars — arrives
// WHOLE. A trace that clips the evidence cannot answer the one question it was
// built to answer.
const TRACE_MAX_STRING_CHARS = 12000;

// Total string budget for ONE entry, shared by every string in its payload.
// Roughly a system prompt plus a task block plus a reply. Without it a payload
// with thirty string fields could reach 360 KB, and 2000 of those would be
// three quarters of a gigabyte of ring.
const TRACE_MAX_ENTRY_CHARS = 32000;

// Structural caps. Tool-call and transcript arrays are short by nature; a fact
// record has roughly twenty fields, so 60 keys leaves room for growth without
// letting a whole database through. The depth cap doubles as the cycle guard —
// a self-referential object bottoms out at TRACE_MAX_DEPTH instead of blowing
// the stack.
const TRACE_MAX_ARRAY_ITEMS = 50;
const TRACE_MAX_OBJECT_KEYS = 60;
const TRACE_MAX_DEPTH = 6;

// Caps on the TRUNCATION MANIFEST itself. Note count scales with NODE count,
// not with the char cap: once the budget is spent every remaining string pushes
// a note, and every node past TRACE_MAX_DEPTH pushes one too. A deeply nested
// tool argument therefore used to produce tens of thousands of notes and push an
// entry an order of magnitude past TRACE_MAX_ENTRY_CHARS in `__truncated` alone.
// 200 notes at roughly 60 chars each is ~12 KB, and each note's path string is
// charged against the same entry budget the payload spends, so the stated cap is
// now a cap on the WHOLE entry rather than only on its payload strings.
const TRACE_MAX_NOTES = 200;
const TRACE_NOTE_OVERHEAD_CHARS = 40;
// Same problem via __bfTraceDroppedKeys, which stored every dropped key name.
const TRACE_MAX_DROPPED_KEYS = 40;

let traceCallSeq = 0;

// Cheap synchronous predicate. Called before any payload is built, on every LLM
// call and every tool call, so it must be trivial and must not throw:
// getSettings() hands back null until the extension has loaded its settings.
export function isTraceRecording() {
    return getSettings()?.debugTraceRun === true;
}

// Mints a correlation id for ONE llm call — one system prompt, one task block
// and the whole tool loop that follows. `runId` groups a pipeline run; this
// groups the call inside it, which runId alone cannot do because a single run
// makes several calls (extract, beats, head) and reflection makes its own.
export function newTraceCallId(label) {
    return `${label || 'call'}#${++traceCallSeq}`;
}

// Rewrites a captured value into a fresh, capped, plain-data structure.
//
// Two jobs, done in one pass because both need the same walk:
//   1. SNAPSHOT. addDebugLog stores opts.data BY REFERENCE, and every payload
//      worth capturing is still owned and mutated by its caller — the fact
//      record that is about to be repaired in place, the resultParts array that
//      is about to be fed into the next tool round. Returning fresh objects and
//      arrays is what makes the entry stable. Strings need no copy: they are
//      immutable in JS, so sharing one is already a snapshot.
//   2. TRUNCATION, recorded rather than hidden. Every cut appends a visible
//      marker to the value AND pushes a note onto state.notes, which traceCapture
//      attaches to the entry as `__truncated`. A trace that quietly drops half a
//      prompt is worse than no trace at all.
//
// Notes go through pushTraceNote so the manifest obeys the same budget the
// payload does — see TRACE_MAX_NOTES. A manifest that itself blows the entry cap
// is the same defect as an uncapped payload, one indirection further away.
function pushTraceNote(state, note) {
    if (state.notes.length >= TRACE_MAX_NOTES) { state.notesDropped++; return; }
    state.budget -= String(note.path || '').length + TRACE_NOTE_OVERHEAD_CHARS;
    state.notes.push(note);
}

function sanitizeTraceValue(value, path, depth, state) {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string') {
        const total = value.length;
        // The shared entry budget can bite before the per-field cap does, so
        // take whichever is tighter.
        const allowed = Math.max(0, Math.min(TRACE_MAX_STRING_CHARS, state.budget));
        if (total <= allowed) {
            state.budget -= total;
            return value;
        }
        state.budget -= allowed;
        pushTraceNote(state, { path: path || '(root)', kind: 'string', chars: total, kept: allowed });
        return value.slice(0, allowed) + `\n…[BF-TRACE TRUNCATED: kept ${allowed} of ${total} chars]`;
    }
    if (t === 'number' || t === 'boolean') return value;
    if (t === 'undefined') return undefined; // JSON drops the key; nothing was there to see
    if (t === 'bigint') return String(value);
    if (t === 'function' || t === 'symbol') return `[BF-TRACE ${t}]`;
    if (depth >= TRACE_MAX_DEPTH) {
        pushTraceNote(state, { path: path || '(root)', kind: 'depth', limit: TRACE_MAX_DEPTH });
        return `[BF-TRACE depth limit ${TRACE_MAX_DEPTH}]`;
    }
    if (Array.isArray(value)) {
        const keep = Math.min(value.length, TRACE_MAX_ARRAY_ITEMS);
        const out = [];
        for (let i = 0; i < keep; i++) {
            out.push(sanitizeTraceValue(value[i], `${path}[${i}]`, depth + 1, state));
        }
        if (value.length > keep) {
            pushTraceNote(state, { path: path || '(root)', kind: 'array', items: value.length, kept: keep });
            out.push(`[BF-TRACE TRUNCATED: kept ${keep} of ${value.length} items]`);
        }
        return out;
    }
    // Map, Set and Date have NO own enumerable keys, so the generic object
    // branch below would turn each of them into `{}` and push no note — a silent
    // total loss, which is precisely what this function promises never to do.
    // No current call site passes one, so these are guards, not fixes.
    if (value instanceof Date) {
        return Number.isFinite(value.getTime()) ? value.toISOString() : '[BF-TRACE invalid Date]';
    }
    if (value instanceof Map || value instanceof Set) {
        const isMap = value instanceof Map;
        const label = isMap ? 'Map' : 'Set';
        const out = isMap ? {} : [];
        let n = 0;
        for (const item of value) {
            if (n >= TRACE_MAX_OBJECT_KEYS) break;
            if (isMap) {
                const k = String(item[0]);
                out[k] = sanitizeTraceValue(item[1], path ? `${path}.${k}` : k, depth + 1, state);
            } else {
                out.push(sanitizeTraceValue(item, `${path}[${n}]`, depth + 1, state));
            }
            n++;
        }
        if (value.size > n) {
            pushTraceNote(state, { path: path || '(root)', kind: label.toLowerCase(), entries: value.size, kept: n });
        }
        pushTraceNote(state, { path: path || '(root)', kind: 'converted', from: label, to: isMap ? 'object' : 'array', entries: value.size });
        return out;
    }
    if (t === 'object') {
        const out = {};
        const keys = Object.keys(value); // own enumerable only — no prototype chain
        const keep = Math.min(keys.length, TRACE_MAX_OBJECT_KEYS);
        for (let i = 0; i < keep; i++) {
            const k = keys[i];
            let v;
            // Accessors on a live model object can throw; one bad field must not
            // cost the whole capture.
            try { v = value[k]; } catch (e) { v = `[BF-TRACE getter threw: ${e?.message || e}]`; }
            out[k] = sanitizeTraceValue(v, path ? `${path}.${k}` : k, depth + 1, state);
        }
        if (keys.length > keep) {
            const named = keys.slice(keep, keep + TRACE_MAX_DROPPED_KEYS);
            pushTraceNote(state, {
                path: path || '(root)', kind: 'object', keys: keys.length, kept: keep,
                namedDropped: named.length, unnamedDropped: keys.length - keep - named.length,
            });
            // Charged against the entry budget like any other string this entry
            // carries — an object with 20000 keys must not smuggle 20000 key
            // names past TRACE_MAX_ENTRY_CHARS.
            for (const k of named) state.budget -= k.length + 4;
            out.__bfTraceDroppedKeys = keys.length - keep > named.length
                ? [...named, `[BF-TRACE TRUNCATED: named ${named.length} of ${keys.length - keep} dropped keys]`]
                : named;
        }
        return out;
    }
    return String(value);
}

/**
 * Record one full-text capture. NO-OP unless the "record a test run" switch is on.
 *
 * THE ONE RULE CALLERS MUST FOLLOW: the payload is a THUNK, never an object.
 *
 *     traceCapture('agent3.prompt.system', () => ({ system: sys, hash }), { runId, callId });
 *
 * JS evaluates arguments eagerly, so `traceCapture(ev, { system: buildSystemPrompt() })`
 * would build the multi-KB string on every single run with recording OFF —
 * precisely the cost this API exists to avoid. Passing a non-function is
 * therefore treated as a bug and logged as one, not silently tolerated.
 *
 * Inside a loop that runs per item, guard with isTraceRecording() instead so the
 * closure is not allocated at all:
 *
 *     if (isTraceRecording()) for (const p of resultParts) traceCapture(...);
 *
 * @param {string} event      Dot path naming the capture, e.g. 'agent3.tool.result'.
 *                            Stored as `trace.<event>`; put the owning agent first.
 * @param {() => any} payloadFn  Builds the payload. Called ONLY when recording.
 * @param {object} [opts]
 * @param {string} [opts.runId]  Pipeline run id. PASS IT EXPLICITLY — see below.
 * @param {string} [opts.callId] From newTraceCallId(); ties one llm call together.
 * @param {number} [opts.round]  Tool-loop round index.
 * @param {string|number} [opts.step] Finer ordinal inside a round (e.g. tool index).
 * @param {string} [opts.note]   Short human text appended to the log message.
 * @param {string} [opts.reason] Passed through to the entry's `reason`.
 * @returns {boolean} true if an entry was recorded.
 */
export function traceCapture(event, payloadFn, opts = {}) {
    if (!isTraceRecording()) return false;
    if (!opts || typeof opts !== 'object') opts = {};
    if (typeof payloadFn !== 'function') {
        addDebugLog('fail', `Trace payload for "${event}" was not a thunk — pass () => ({...}), not the built object`, {
            subsystem: TRACE_SUBSYSTEM, event: 'trace.misuse', reason: 'PAYLOAD_NOT_FUNCTION',
        });
        return false;
    }

    const state = { budget: TRACE_MAX_ENTRY_CHARS, notes: [], notesDropped: 0 };
    let out;
    try {
        out = sanitizeTraceValue(payloadFn(), '', 0, state);
    } catch (e) {
        // Record the HOLE. A capture that vanishes silently reads as "this step
        // never ran", which is the wrong conclusion to hand someone debugging.
        out = { __bfTraceFailed: String(e?.message || e) };
    }
    // Reserved keys are assigned last so a payload field can never shadow them.
    if (out === null || typeof out !== 'object' || Array.isArray(out)) out = { value: out };
    out.__trace = { event, callId: opts.callId ?? null };
    if (opts.round != null) out.__trace.round = opts.round;
    if (opts.step != null) out.__trace.step = opts.step;
    if (state.notes.length) out.__truncated = state.notes;
    // The manifest can itself be capped, and a manifest that hides its own cut
    // is the one field in the entry that must not.
    if (state.notesDropped) {
        out.__truncatedIncomplete = {
            listed: state.notes.length,
            notListed: state.notesDropped,
            limit: TRACE_MAX_NOTES,
            note: 'Payload had more truncation points than the manifest lists. The cut markers are still in the values.',
        };
    }

    const tag = [opts.callId, opts.round != null ? `r${opts.round}` : ''].filter(Boolean).join(' ');
    addDebugLog('verbose', `trace: ${event}${tag ? ` (${tag})` : ''}${opts.note ? ` — ${opts.note}` : ''}`, {
        level: 'verbose',
        subsystem: TRACE_SUBSYSTEM,
        event: `trace.${event}`,
        runId: opts.runId,
        reason: opts.reason,
        data: out,
    });
    // addDebugLog just unshifted it onto traceLog. Remember what this entry cost
    // so the export's pre-flight can size itself without stringifying the ring
    // to find out (see estimateTraceChars). A WeakMap rather than a field on the
    // entry: it must not turn up in the exported JSON, and it must be collected
    // with the entry when the ring evicts it.
    const stored = traceLog[0];
    if (stored && stored.subsystem === TRACE_SUBSYSTEM) {
        traceEntryChars.set(stored, Math.max(0, TRACE_MAX_ENTRY_CHARS - state.budget));
    }
    return true;
}

const traceEntryChars = new WeakMap();

// Rough char footprint of the trace ring, free to compute (one WeakMap read per
// entry, no stringify). Used by the export pre-flight.
function estimateTraceChars() {
    let n = 0;
    for (const e of traceLog) n += (traceEntryChars.get(e) ?? 2000) + 300;
    return n;
}

// Trace entries only, oldest-first. The ring is newest-first (addDebugLog
// unshifts), but an export wants the run in the order it happened. Returns a
// fresh array so a consumer cannot reorder the live ring.
export function getTraceEntries() {
    return traceLog.slice().reverse();
}

// ---------------------------------------------------------------------------
// Diagnostics / test-run export.
//
// TWO MODES, ONE ASSEMBLER. "Copy Diagnostics" (basic) is the small bundle that
// has always existed: settings, databases, the log. "Download Test Run" (full)
// adds every piece of pipeline state that has an accessor, plus the trace
// entries GROUPED BY RUN — which is the whole point, because a flat log of 2000
// interleaved entries does not answer "which memories were written, and on what
// context". Both go through buildDiagnostics() and deliverDiagnostics() so the
// meta block, the version lookup, the counting, the download and the
// clipboard-blocked fallback exist once.
// ---------------------------------------------------------------------------

// Persisted-log events that represent memory WORK. Counted for the export's
// summary block so the top of the file answers "what did this session do to my
// memory" without reading the entries. Keys are the export's field names; the
// left side must stay equal to the `event:` strings the emitting call sites
// pass, or a row silently reads zero.
const WORK_EVENT_FIELDS = {
    'fact.created': 'written',
    'fact.updated': 'updated',
    'fact.unchanged': 'checkedUnchanged',
    'fact.repaired': 'repaired',
    'fact.merged': 'merged',
    'fact.demoted': 'coldTiered',
    'fact.superseded': 'superseded',
    'fact.remapped': 'remapped',
    'fact.resurfaced': 'resurfaced',
    'fact.reeval_promoted': 'reevalPromoted',
    'fact.autolink': 'autoLinked',
    'fact.agentlink': 'agentLinked',
    'conflict.resolved': 'conflictsResolved',
};

// Some events mean different work depending on WHY they were emitted, and the
// field name has to follow the meaning or it lies. execMarkCold (memory-tools.js)
// cold-tiers a fact but emits `fact.repaired` with reason REFLECT_MARK_COLD, so
// `coldTiered` read 0 on runs that cold-tiered something while `repaired`
// over-counted. Keyed on (event, reason) and applied after the plain lookup, so
// re-eventing that call site to `fact.demoted` later simply makes this row
// unreachable rather than double-counting.
const WORK_EVENT_REASON_FIELDS = {
    'fact.repaired|REFLECT_MARK_COLD': 'coldTiered',
};

// --- summary.byFact -------------------------------------------------------
//
// `work` answers "how many", never "which": you read `repaired: 2` and then have
// to scan the whole log to learn WHICH fact. These caps bound the index that
// answers it. 200 keys × 30 events is generous for one chat session's ring (the
// ring itself holds 2000 entries) and costs a few hundred KB at worst.
const BYFACT_MAX_KEYS = 200;
const BYFACT_MAX_EVENTS_PER_KEY = 30;
const BYFACT_MAX_TRACE_REFS_PER_KEY = 60;
// Fact values are free text and a few of them are long. The index is a pointer,
// not a copy — the full before/after is on the entry it points at.
const BYFACT_VALUE_CHARS = 400;

function clipIndexValue(v) {
    if (v === undefined) return undefined;
    if (v === null) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    const s = typeof v === 'string' ? v : safeStringify(v);
    return s.length > BYFACT_VALUE_CHARS ? `${s.slice(0, BYFACT_VALUE_CHARS)}…[+${s.length - BYFACT_VALUE_CHARS}]` : s;
}

// "Category/key", the same reference form serializeRetrievalIndex and the memory
// sheet use, so an index row can be pasted straight into the key probe.
function factRefOf(category, key) {
    if (typeof category !== 'string' || !category) return null;
    if (typeof key !== 'string' || !key) return null;
    return `${category}/${key}`;
}

// "Category:key" or "Category/key" -> canonical "Category/key". Anything else
// (a bare key, a sentence, a nested object) yields null rather than a guess.
function parseFactRefString(v) {
    if (typeof v !== 'string' || !v) return null;
    const m = /^\s*([^\s:/]+)\s*[:/]\s*([^\s:/]+)\s*$/.exec(v);
    return m ? factRefOf(m[1], m[2]) : null;
}

// The tool layer names records three different ways, and byFact has to understand
// all three or it silently misses the reads it exists to point at:
//   {category, key}                    write_fact, mark_cold, add_alias, gate refusals
//   {category, requestedKeys:[...]}    read_facts — one payload, many records
//   "Cat:key" as a string              merge_facts (from/into), link_facts (from/to)
// Matching only the first shape is what made a repair's own read_facts step
// invisible in traceSeqs — the single most useful pointer this index has.
function factRefsFromPayload(d) {
    if (!d || typeof d !== 'object') return [];
    const out = [];
    const push = (ref) => { if (ref) out.push(ref); };

    const cat = (typeof d.category === 'string' && d.category) ? d.category : d.requestedCategory;
    push(factRefOf(cat, d.key));
    push(factRefOf(d.fromCategory, d.fromKey));
    for (const k of (Array.isArray(d.requestedKeys) ? d.requestedKeys : [])) push(factRefOf(cat, k));
    for (const k of (Array.isArray(d.keys) ? d.keys : [])) push(factRefOf(cat, k));
    for (const field of ['from', 'into', 'to']) push(parseFactRefString(d[field]));

    return out;
}

// Index buckets are unbounded by nature (one token per distinct word across
// every fact), so the serializer caps them. Generous enough that a normal chat
// exports whole; the cap exists so a 5000-fact database cannot turn a 2 MB
// export into a 60 MB one.
const INDEX_MAX_BUCKETS = 4000;
const INDEX_MAX_REFS_PER_BUCKET = 50;

// Watermark rows are one line per chat message. Newest-first truncation, because
// "why was this recent message never processed" is the question that gets asked.
const WATERMARK_MAX_MESSAGES = 5000;

// Counts memory work over whatever the log ring currently holds. Deliberately
// NOT called "this session": the ring is 2000 entries in RAM and is rebuilt from
// the persisted slice on chat load, so its span is reported alongside the counts
// rather than assumed.
function summarizeMemoryWork(entries, traceEntries = []) {
    const work = {};
    for (const field of Object.values(WORK_EVENT_FIELDS)) work[field] = { count: 0, byReason: {} };
    for (const field of Object.values(WORK_EVENT_REASON_FIELDS)) {
        if (!work[field]) work[field] = { count: 0, byReason: {} };
    }
    let oldest = null, newest = null, failures = 0;

    // byFact is built in THIS pass — one walk of the ring, not a second one.
    const facts = new Map();
    let keysDropped = 0;
    const rowFor = (ref) => {
        let row = facts.get(ref);
        if (row) return row;
        if (facts.size >= BYFACT_MAX_KEYS) { keysDropped++; return null; }
        row = { events: [], eventCount: 0, eventsNotListed: 0, traceSeqs: [], traceSeqsNotListed: 0 };
        facts.set(ref, row);
        return row;
    };

    for (const e of entries) {
        if ((e.level || e.type) === 'fail') failures++;
        if (Number.isFinite(e.ts)) {
            if (oldest === null || e.ts < oldest) oldest = e.ts;
            if (newest === null || e.ts > newest) newest = e.ts;
        }
        const reason = e.reason || '(none)';
        const field = WORK_EVENT_REASON_FIELDS[`${e.event}|${e.reason}`] || WORK_EVENT_FIELDS[e.event];
        if (field) {
            const row = work[field];
            row.count++;
            row.byReason[reason] = (row.byReason[reason] || 0) + 1;
        }

        // Index every fact.*/conflict.* entry that names a record, whether or
        // not it counts as "work" — "nothing happened to this key" is an answer
        // too, and the caller asked which key, not which counter.
        if (typeof e.event !== 'string') continue;
        if (!e.event.startsWith('fact.') && !e.event.startsWith('conflict.')) continue;
        const d = (e.data && typeof e.data === 'object') ? e.data : {};
        // A merge names two records; the loser is exactly the key someone goes
        // looking for after it stops showing up on the sheet.
        const refs = [factRefOf(d.category, d.key), factRefOf(d.fromCategory, d.fromKey)];
        for (const ref of refs) {
            if (!ref) continue;
            const row = rowFor(ref);
            if (!row) continue;
            row.eventCount++;
            if (row.events.length >= BYFACT_MAX_EVENTS_PER_KEY) { row.eventsNotListed++; continue; }
            const step = {
                seq: e.seq ?? null,
                at: e.iso ?? e.timestamp ?? null,
                runId: e.runId ?? null,
                event: e.event,
                reason: e.reason ?? null,
                oldValue: clipIndexValue(e.before !== undefined ? e.before : d.oldValue),
                newValue: clipIndexValue(e.after !== undefined ? e.after : (d.newValue !== undefined ? d.newValue : d.value)),
            };
            if (step.oldValue === undefined) delete step.oldValue;
            if (step.newValue === undefined) delete step.newValue;
            row.events.push(step);
        }
    }
    // `entries` is newest-first; a history reads oldest-first.
    for (const row of facts.values()) row.events.reverse();

    // Pointers from "this was repaired" to "here is what the agent read first".
    // STRUCTURAL, not full-text: a trace payload is matched only when it names
    // the record in a field — see factRefsFromPayload for the three shapes the
    // tool layer uses. The payload is checked both at the top level (memtool.*)
    // and under .args (<agent>.tool.call), because the same call is captured
    // twice, once from each side. A key that appears only inside a prompt or a
    // raw reply body is NOT matched — search the Debug tab for those. Full-text
    // matching here would mean scanning up to 19 M chars per export.
    for (const e of traceEntries) {
        const d = (e.data && typeof e.data === 'object') ? e.data : null;
        if (!d) continue;
        const refs = factRefsFromPayload(d).concat(factRefsFromPayload(d.args));
        const seen = new Set();
        for (const ref of refs) {
            if (!ref || seen.has(ref)) continue;
            seen.add(ref);
            const row = facts.get(ref); // never CREATE a key from a trace alone
            if (!row) continue;
            if (row.traceSeqs.length >= BYFACT_MAX_TRACE_REFS_PER_KEY) { row.traceSeqsNotListed++; continue; }
            row.traceSeqs.push(e.seq ?? null);
        }
    }

    return {
        window: {
            logEntries: entries.length,
            oldest: oldest === null ? null : new Date(oldest).toISOString(),
            newest: newest === null ? null : new Date(newest).toISOString(),
            note: 'Counts cover the in-memory log ring only (' + MAX_DEBUG_ENTRIES_MEM + ' entries max, ' +
                  'rebuilt from the persisted slice on chat load). Older work has been evicted, not undone. '
                + 'Trace entries are NOT in this window — they have their own ring and are in `traceRuns`.',
        },
        failures,
        work,
        byFact: {
            note: 'Which record, not how many. One row per "Category/key" touched by a fact.*/conflict.* entry still '
                + 'on the ring, oldest event first. `traceSeqs` are `seq` values of trace steps that NAME this record '
                + '— look them up in traceRuns[].calls[].steps[].seq to see the reads and tool arguments the change '
                + 'was based on. Empty traceSeqs means recording was off, or the record is named only inside prompt '
                + 'or reply text, which this index does not scan.',
            keys: facts.size,
            keysNotListed: keysDropped,
            limits: {
                keys: BYFACT_MAX_KEYS,
                eventsPerKey: BYFACT_MAX_EVENTS_PER_KEY,
                traceRefsPerKey: BYFACT_MAX_TRACE_REFS_PER_KEY,
                valueChars: BYFACT_VALUE_CHARS,
                onCap: 'Keys past the limit are counted in keysNotListed and have no row at all; events and trace refs '
                    + 'past their limit keep the NEWEST and report the remainder in eventsNotListed / traceSeqsNotListed. '
                    + 'Nothing is lost — the full entries are in `debugLog` and `traceRuns`.',
            },
            facts: Object.fromEntries(facts),
        },
    };
}

// Trace entries, regrouped into the shape they were emitted in.
//
// The trace API defines the correlation key as runId (the pipeline run) plus
// data.__trace.callId (one LLM call inside it) plus round/step. The ring stores
// entries flat and newest-first; this rebuilds run → call → step, keeping
// EMISSION ORDER within a call because that is the order things happened: the
// system prompt, the task block, the reply, the tool calls with their arguments
// and results, then the next round's reply.
//
// Reflection runs outside beginRun/endRun and passes its runId explicitly; an
// entry that still has none lands in a '(no run id)' bucket rather than being
// dropped, because a capture with a missing correlation id is itself a finding.
function groupTraceRuns(entries) {
    const runs = [];
    const byRun = new Map();
    for (const e of entries) {
        const runKey = e.runId || '(no run id)';
        let run = byRun.get(runKey);
        if (!run) {
            run = { runId: e.runId ?? null, firstSeen: e.iso, lastSeen: e.iso, entryCount: 0, calls: [], _byCall: new Map() };
            byRun.set(runKey, run);
            runs.push(run);
        }
        run.lastSeen = e.iso;
        run.entryCount++;

        const t = (e.data && typeof e.data === 'object' && e.data.__trace) || {};
        const callKey = t.callId || '(no call id)';
        let call = run._byCall.get(callKey);
        if (!call) {
            call = { callId: t.callId ?? null, steps: [] };
            run._byCall.set(callKey, call);
            run.calls.push(call);
        }

        // __trace is lifted onto the step (it is correlation, not payload);
        // __truncated stays on the payload, next to the fields it cut.
        let payload = e.data;
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            const { __trace, ...rest } = payload;
            payload = rest;
        }
        call.steps.push({
            seq: e.seq,
            at: e.iso,
            event: t.event || e.event || null,
            round: t.round ?? null,
            step: t.step ?? null,
            reason: e.reason ?? null,
            message: e.message,
            data: payload,
        });
    }
    for (const run of runs) delete run._byCall;
    return runs;
}

// The retrieval index as plain data.
//
// buildMemoryIndex returns Maps of {fact, category} entries, and the SAME fact
// object appears in every token bucket it matched — JSON.stringify would emit a
// full copy of the record per bucket and blow the file up by an order of
// magnitude. So buckets are serialized as "Category/key" REFERENCES into the
// `databases` block, which is also the form a reader wants: the index question
// is "which keys does this token reach", not "what do those facts say".
function serializeRetrievalIndex(index, manifest) {
    if (!index) return null;
    const refOf = (entry) => `${entry?.category ?? '?'}/${entry?.fact?.key ?? '?'}`;
    const dumpBuckets = (map, label) => {
        const out = {};
        if (!(map instanceof Map)) return out;
        let n = 0;
        // Per-bucket cuts are aggregated into ONE manifest row rather than one
        // row per bucket: a wide index would otherwise put thousands of rows in
        // the manifest. Reported at all because the manifest claims to enumerate
        // everything that was cut, and this is a cut.
        let cutBuckets = 0, cutRefs = 0;
        for (const [key, entries] of map) {
            if (n++ >= INDEX_MAX_BUCKETS) {
                manifest.push({ what: `retrievalIndex.${label}`, limit: INDEX_MAX_BUCKETS, of: map.size, unit: 'buckets' });
                break;
            }
            const list = Array.isArray(entries) ? entries : [];
            out[key] = list.slice(0, INDEX_MAX_REFS_PER_BUCKET).map(refOf);
            if (list.length > INDEX_MAX_REFS_PER_BUCKET) {
                out[key].push(`[TRUNCATED: kept ${INDEX_MAX_REFS_PER_BUCKET} of ${list.length}]`);
                cutBuckets++;
                cutRefs += list.length - INDEX_MAX_REFS_PER_BUCKET;
            }
        }
        if (cutBuckets) {
            manifest.push({
                what: `retrievalIndex.${label}[*]`, limit: INDEX_MAX_REFS_PER_BUCKET, unit: 'refs per bucket',
                bucketsAffected: cutBuckets, refsDropped: cutRefs,
                note: 'Each affected bucket carries its own [TRUNCATED] marker. The facts themselves are all in `databases`.',
            });
        }
        return out;
    };
    const aspectCounts = {};
    if (index.aspectCounts instanceof Map) {
        for (const [category, perAspect] of index.aspectCounts) {
            aspectCounts[category] = (perAspect instanceof Map) ? Object.fromEntries(perAspect) : {};
        }
    }
    return {
        note: 'Buckets hold "Category/key" references into `databases`, not fact copies — one fact is in many buckets.',
        totalFacts: index.totalFacts ?? null,
        aspectCounts,
        byCatAspect: dumpBuckets(index.byCatAspect, 'byCatAspect'),
        bySubject: dumpBuckets(index.bySubject, 'bySubject'),
        byToken: dumpBuckets(index.byToken, 'byToken'),
    };
}

// settings, minus the database copies each saved DB profile carries.
//
// Every dbProfiles[name] stores a full snapshot of every database, and this
// export already dumps the live databases once — so with three saved profiles
// the same facts appeared FOUR times. The snapshot is replaced by per-profile
// counts, which is what a reader actually needs from a profile ("does this
// profile have the facts I think it has"); the profile's own storySpine and
// sceneStore stay, they are small and have no other copy in the export.
//
// Rebuilt into fresh objects — the live settings object is the running
// extension's state and must not be edited to shrink a file.
function stripProfileDatabases(settings, manifest) {
    if (!settings || typeof settings !== 'object') return settings;
    const profiles = settings.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return settings;

    const out = { ...settings, dbProfiles: {} };
    let savedChars = 0, stripped = 0;
    for (const [name, profile] of Object.entries(profiles)) {
        if (!profile || typeof profile !== 'object' || !profile.databases) { out.dbProfiles[name] = profile; continue; }
        const counts = {};
        let facts = 0;
        for (const [category, cdb] of Object.entries(profile.databases)) {
            const n = Array.isArray(cdb?.facts) ? cdb.facts.length : 0;
            counts[category] = n;
            facts += n;
        }
        try { savedChars += JSON.stringify(profile.databases).length; } catch {  }
        stripped++;
        const { databases, ...rest } = profile;
        out.dbProfiles[name] = {
            ...rest,
            databasesOmitted: {
                note: 'Fact snapshot dropped from the export — a saved profile duplicates the whole database. Counts only.',
                categories: Object.keys(counts).length,
                facts,
                perCategory: counts,
            },
        };
    }
    if (stripped) {
        manifest.push({
            what: 'settings.dbProfiles[*].databases',
            action: 'omitted, replaced by per-category fact counts',
            profiles: stripped,
            savedChars,
            savedKB: Math.round(savedChars / 1024),
        });
    }
    return out;
}

// One row per chat message: the bf_mem_processed watermark and just enough
// identity to line a row up against the chat. See the `chat` block's own note
// for why the message TEXT is not here.
function collectWatermarks(chat, manifest) {
    if (!Array.isArray(chat)) return null;
    const from = Math.max(0, chat.length - WATERMARK_MAX_MESSAGES);
    if (from > 0) {
        manifest.push({ what: 'chat.watermarks', limit: WATERMARK_MAX_MESSAGES, of: chat.length, unit: 'messages', note: 'kept the newest' });
    }
    const rows = [];
    for (let i = from; i < chat.length; i++) {
        const m = chat[i];
        rows.push({
            index: i,
            isUser: !!m?.is_user,
            name: m?.name ?? null,
            chars: String(m?.mes ?? '').length,
            processed: m?.extra?.bf_mem_processed === true ? true : (m?.extra?.bf_mem_processed === false ? false : null),
            swipeId: Number.isFinite(m?.swipe_id) ? m.swipe_id : null,
            swipes: Array.isArray(m?.swipes) ? m.swipes.length : null,
        });
    }
    return rows;
}

// Which system prompt ACTUALLY ran, for one agent call.
//
// settings.memoryAgentPrompt / .reflectionPrompt normalize to '' when the
// built-in default is in use, so an export that just printed the setting would
// show an empty string for the single most important input to the run. Each row
// therefore names the source, states the selection rule the owning module
// really uses (they differ — extraction trims, reflection does not), and carries
// the effective text.
function promptRow({ source, effective, storedOverride, defaultText, rule }) {
    const stored = typeof storedOverride === 'string' ? storedOverride : null;
    return {
        ranWhichPrompt: source,
        selectionRule: rule,
        effectiveChars: effective.length,
        equalsBuiltInDefault: effective === defaultText,
        storedOverrideChars: stored === null ? null : stored.length,
        storedOverride: stored,
        effective,
    };
}

async function buildPromptsBlock(settings) {
    const [mem, refl] = await Promise.all([
        import('./agent-memory.js'),
        import('./agent-reflect.js'),
    ]);
    const { DEFAULT_MEMORY_AGENT_PROMPT, DEFAULT_BEATS_PROMPT, DEFAULT_HEAD_PROMPT } = mem;
    const { DEFAULT_REFLECT_PROMPT } = refl;

    // Mirrors agent-memory.js: String(settings?.memoryAgentPrompt || '').trim().
    const extractOverride = String(settings?.memoryAgentPrompt || '').trim();
    // Mirrors agent-reflect.js: settings?.reflectionPrompt || DEFAULT — UNTRIMMED,
    // so a whitespace-only override is truthy there and ships as the whole prompt.
    const reflectOverride = settings?.reflectionPrompt;

    return {
        note: 'The text below is the SYSTEM prompt each agent call is given, read at EXPORT time — edit a prompt '
            + 'after a run and this describes a prompt that never ran. With recording on, the trace carries the '
            + 'prompt as dispatched, post-substitution, under <agent>.prompt.system — extract.*, beats.*, head.* '
            + 'and reflect.* respectively, NOT a single agent3.* namespace — together with the task block it was '
            + 'paired with, and that copy is the authoritative one.',
        extraction: promptRow({
            source: extractOverride ? 'settings.memoryAgentPrompt (user override)' : 'DEFAULT_MEMORY_AGENT_PROMPT (built-in)',
            effective: extractOverride || DEFAULT_MEMORY_AGENT_PROMPT,
            storedOverride: settings?.memoryAgentPrompt ?? '',
            defaultText: DEFAULT_MEMORY_AGENT_PROMPT,
            rule: 'agent-memory.js: String(settings.memoryAgentPrompt || "").trim() || DEFAULT_MEMORY_AGENT_PROMPT',
        }),
        beats: promptRow({
            source: 'DEFAULT_BEATS_PROMPT (built-in — no override can reach this call)',
            effective: DEFAULT_BEATS_PROMPT,
            storedOverride: null,
            defaultText: DEFAULT_BEATS_PROMPT,
            rule: 'agent-memory.js: DEFAULT_BEATS_PROMPT passed unconditionally',
        }),
        sheetHead: promptRow({
            source: 'DEFAULT_HEAD_PROMPT (built-in — no override can reach this call)',
            effective: DEFAULT_HEAD_PROMPT,
            storedOverride: null,
            defaultText: DEFAULT_HEAD_PROMPT,
            rule: 'agent-memory.js: DEFAULT_HEAD_PROMPT passed unconditionally',
        }),
        reflection: promptRow({
            source: reflectOverride ? 'settings.reflectionPrompt (user override)' : 'DEFAULT_REFLECT_PROMPT (built-in)',
            effective: reflectOverride || DEFAULT_REFLECT_PROMPT,
            storedOverride: settings?.reflectionPrompt ?? '',
            defaultText: DEFAULT_REFLECT_PROMPT,
            rule: 'agent-reflect.js: substitute(settings.reflectionPrompt || DEFAULT_REFLECT_PROMPT) — UNTRIMMED truthiness; '
                + '{{user}}/{{char}} are substituted after selection, so the shipped text can differ from this by those tokens',
        }),
    };
}

/**
 * Builds the diagnostics object.
 * @param {boolean} full  false = the classic Copy Diagnostics bundle.
 *                        true  = every accessor plus the grouped trace.
 */
async function buildDiagnostics(full) {
    const ctx = getContext();
    const truncation = [];
    let databases = {}, review = null, extVersion = null;
    try { const m = await (await fetch(new URL('../manifest.json', import.meta.url))).json(); extVersion = m.version; } catch {  }
    try { const dbm = await import('./database.js'); databases = await dbm.getAllDatabases(); } catch (e) { databases = { __error: String(e?.message || e) }; }
    try { review = (ctx.chatMetadata || ctx.chat_metadata || {}).bf_mem_review || null; } catch {  }
    let factCount = 0, linkCount = 0;
    for (const cdb of Object.values(databases || {})) {
        for (const f of (cdb?.facts || [])) {
            factCount++;
            const r = f.relationships || {};
            linkCount += (r.primary?.length || 0) + (r.secondary?.length || 0) + (r.tertiary?.length || 0);
        }
    }
    const settings = getSettings();
    const recording = settings?.debugTraceRun === true;

    const diag = {
        meta: {
            exported: new Date().toISOString(),
            mode: full ? 'full-test-run' : 'basic',
            extensionVersion: extVersion,
            stVersion: ctx?.version ?? null,
            character: (() => { try { return ctx.characters?.[ctx.characterId]?.name ?? null; } catch { return null; } })(),
            chatId: (() => { try { return ctx.chatId ?? ctx.getCurrentChatId?.() ?? null; } catch { return null; } })(),
            counts: {
                categories: Object.keys(databases || {}).length,
                facts: factCount, links: linkCount,
                // Ordinary diagnostics only. Trace captures live on their own
                // ring and are counted separately as meta.traceEntries.
                logEntries: debugLog.length,
                traceEntries: traceLog.length,
            },

            note: 'Complete extension state. The model\'s full ST-assembled prompt is outside this extension.',
        },
    };

    if (!full) {
        diag.settings = settings;
        diag.tokens = { lastRun: getLastRunTokens(), session: getSessionTokens() };
        diag.lastGenerated = getLastGenerated();
        diag.lastInserted = getLastInserted();
        diag.reviewPending = review;
        diag.databases = databases;
        // Ordinary diagnostics only, and that is now a property of the RING, not
        // of a filter here: traceCapture output never enters `debugLog`. This
        // matters because copyDiagnostics writes this bundle to the CLIPBOARD
        // under a "paste it to share for debugging" tooltip — before the rings
        // were split, doing that with recording on pasted every system prompt,
        // every raw model reply and every tool result into wherever it landed.
        diag.debugLog = debugLog;
        return diag;
    }

    // --- full mode ---------------------------------------------------------
    const traceEntries = getTraceEntries();
    diag.meta.recording = recording;
    diag.meta.traceEntries = traceEntries.length;
    diag.meta.contentWarning =
        'This file contains raw roleplay text: fact values and notes, the story spine, scene cards, the memory '
        + 'sheet and reflection observations, `lastSentPrompt` (the character card, system prompt and last N chat '
        + 'messages verbatim, as ST actually sent them for the LAST generation — present whether or not recording '
        + 'was on) and `health.events` (raw provider error bodies) — and, if recording was on, the agents\' full '
        + 'prompts and the model\'s full replies. Read it before sharing it.';

    diag.summary = summarizeMemoryWork(debugLog, traceEntries);
    diag.summary.trace = {
        recording,
        entries: traceEntries.length,
        withTruncatedFields: traceEntries.filter(e => e.data && e.data.__truncated).length,
        note: recording
            ? 'Recording was ON when this file was written.'
            : 'Recording was OFF when this file was written — any trace entries below are from earlier in this page session.',
    };

    diag.settings = stripProfileDatabases(settings, truncation);
    // The prompt block dynamically imports the two agent modules; if either
    // fails to load, the rest of the export is still worth having.
    try { diag.prompts = await buildPromptsBlock(settings); }
    catch (e) { diag.prompts = { __error: String(e?.message || e) }; }

    diag.tokens = { lastRun: getLastRunTokens(), session: getSessionTokens() };
    diag.lastGenerated = getLastGenerated();
    diag.lastInserted = getLastInserted();

    const sheetHistory = safeCall(getSheetHistory, []);
    diag.memory = {
        // getMemorySheet() is NOT a pure read: with no sheet in chatMetadata it
        // calls seedSheet() + saveSheetToMeta(), so pressing an export button on
        // a fresh chat would CREATE and persist a seeded sheet. A pure-observation
        // feature must not write, so the accessor is only called once its own
        // precondition already holds; setMemorySheet always persists, so an
        // existing bf_mem_sheet is the honest test for "a sheet exists".
        //
        // This closes the export's path only. buildHealthReport() (health.js)
        // reaches getMemorySheet() too — the real fix is a non-seeding
        // peekMemorySheet() in turn-state.js, which this file does not own.
        sheet: (() => {
            const md = (() => { try { return ctx.chatMetadata || ctx.chat_metadata || {}; } catch { return {}; } })();
            if (!md.bf_mem_sheet) {
                return { note: 'No memory sheet in chatMetadata yet. Not read through getMemorySheet(), because that '
                    + 'accessor would seed and persist one — the export does not write.', exists: false };
            }
            return safeCall(getMemorySheet, null);
        })(),
        sheetHistory: {
            note: 'Every sheet injected while recording was on, oldest first. RAM-only ring, cleared on chat switch — '
                + 'chatMetadata keeps only the newest sheet, so this is the only record of what earlier turns actually read.',
            entries: sheetHistory,
        },
        storySpine: safeCall(getStorySpine, []),
        scenes: safeCall(getSceneStoreSnapshot, null),
        present: safeCall(getScenePresent, []),
        summaryPyramid: safeCall(getSummaryPyramid, null),
        reflection: safeCall(getReflection, null),
        lastNeedRefs: safeCall(getLastNeedRefs, []),
        recoveredRefs: safeCall(getRecoveredRefs, []),
        reflectionMeta: safeCall(getReflectionMetaState, null),
    };

    // chatMetadata keys that no accessor covers. bf_mem_review is the pending
    // review queue; the other two decide whether reflection runs at all and
    // which conflicts it has stopped re-reporting — the direct answers to
    // "why has reflection not fixed this".
    diag.chatMetadataRaw = (() => {
        const md = (() => { try { return ctx.chatMetadata || ctx.chat_metadata || {}; } catch { return {}; } })();
        return {
            note: 'Raw bf_mem_* chatMetadata keys under their real names, copied not referenced. Read-only — reading '
                + 'them here never creates a key that reflection would otherwise treat as absent.',
            bf_mem_review: review,
            bf_mem_reflect_runs: Number.isFinite(md.bf_mem_reflect_runs) ? md.bf_mem_reflect_runs : (md.bf_mem_reflect_runs ?? null),
            bf_mem_conflict_ok: Array.isArray(md.bf_mem_conflict_ok) ? [...md.bf_mem_conflict_ok] : (md.bf_mem_conflict_ok ?? null),
        };
    })();

    // The chat array itself: DELIBERATELY NOT INCLUDED.
    //
    // It is the largest object in reach and it is the one thing here that is
    // already saved elsewhere — SillyTavern owns the chat file, and a user who
    // needs to share the story can share that. Including it would multiply the
    // export size for a copy of something that is not this extension's state.
    //
    // More importantly it would be the WRONG copy. The question this export
    // answers is what the agents saw, and they never see the raw chat: they see
    // the settled-message window, neutralised for reflection, clamped to a
    // character budget. Those exact strings are already in the trace. A raw chat
    // next to them invites reading the wrong one.
    //
    // What has no other home is the per-message bf_mem_processed watermark —
    // that is what decides which messages get processed at all — so the rows
    // below carry it plus enough identity to line them up against the chat.
    diag.chat = {
        included: false,
        why: 'SillyTavern already stores the chat, and the agents never read it raw — the windows they were actually '
            + 'given are in the trace. Only the pipeline watermarks are exported here.',
        messageCount: Array.isArray(ctx?.chat) ? ctx.chat.length : null,
        watermarks: collectWatermarks(ctx?.chat, truncation),
    };

    // The one true full-prompt artifact: what ST actually sent for the LAST
    // generation, after trim and after this extension's injection.
    try {
        const { getLastSentPrompt } = await import('./pipeline.js');
        const snap = getLastSentPrompt();
        diag.lastSentPrompt = snap
            ? { note: 'Post-injection message array for the LAST generation only — not a history.', ...snap }
            : { note: 'No generation captured yet this page session.', messages: [] };
    } catch (e) {
        diag.lastSentPrompt = { __error: String(e?.message || e) };
    }

    try {
        const h = await import('./health.js');
        diag.health = {
            report: await h.buildHealthReport(),
            events: h.getHealthEvents(),
            toolUsage: h.getToolUsage(),
        };
    } catch (e) {
        diag.health = { __error: String(e?.message || e) };
    }

    diag.databases = databases;
    try {
        const dbm = await import('./database.js');
        diag.retrievalIndex = serializeRetrievalIndex(await dbm.getMemoryIndex(), truncation);
    } catch (e) {
        diag.retrievalIndex = { __error: String(e?.message || e) };
    }

    diag.traceRuns = {
        note: 'One block per pipeline run, then per LLM call inside it, then its steps in true emission order: '
            + 'system prompt, task block, raw reply, then per tool call the memtool.* before/after images FIRST and '
            + 'the <agent>.tool.call carrying its arguments and result AFTER them — the executor runs before the '
            + 'call is captured, and the order here is not rearranged to hide that. Correlated by runId + '
            + '__trace.callId + round/step.',
        runs: groupTraceRuns(traceEntries),
    };

    // The flat log. It contains no trace entries and there is no filter here to
    // make that true: traces are on their own ring (see the note at the top of
    // this file), so `traceRuns` above is the only copy of them in the file.
    // What DOES stay here is any `trace.misuse` entry — that is a code bug at
    // `fail` level, not a capture, and it belongs where failures are read.
    diag.debugLog = debugLog;

    truncation.push({
        what: 'debugLog',
        limit: MAX_DEBUG_ENTRIES_MEM,
        unit: 'entries',
        note: 'Ring buffer — once full, the oldest entry is dropped on every new one. Trace captures are NOT on this '
            + 'ring and never evict from it.',
    });
    truncation.push({
        what: 'traceRuns (the trace ring)',
        limit: MAX_TRACE_ENTRIES_MEM,
        unit: 'entries',
        held: traceEntries.length,
        note: 'Separate RAM-only ring, roughly 50 captures per recorded turn. Dropped on chat switch and on reload; '
            + 'never written to chatMetadata or to the character attachment.',
    });
    truncation.push({
        what: 'trace entry payloads',
        limit: `${TRACE_MAX_ENTRY_CHARS} chars/entry, ${TRACE_MAX_STRING_CHARS} chars/string, ${TRACE_MAX_ARRAY_ITEMS} items/array, ${TRACE_MAX_OBJECT_KEYS} keys/object, depth ${TRACE_MAX_DEPTH}`,
        note: 'Every cut leaves a [BF-TRACE …] marker in the value and is listed in that entry\'s own `__truncated`. '
            + `That list is itself capped at ${TRACE_MAX_NOTES} notes; an entry that hit the cap carries `
            + '`__truncatedIncomplete` saying how many were not listed.',
        entriesAffected: diag.summary.trace.withTruncatedFields,
    });
    truncation.push({
        what: 'summary.byFact',
        limit: `${BYFACT_MAX_KEYS} keys, ${BYFACT_MAX_EVENTS_PER_KEY} events/key, ${BYFACT_MAX_TRACE_REFS_PER_KEY} trace refs/key, ${BYFACT_VALUE_CHARS} chars/value`,
        keysNotListed: diag.summary.byFact.keysNotListed,
        note: 'An index, not a copy — everything it points at is in `debugLog` and `traceRuns` in full.',
    });
    truncation.push({
        what: 'memory.sheetHistory',
        limit: 50,
        unit: 'sheets',
        note: 'RAM-only ring in turn-state.js; each sheet is itself capped at 12000 chars.',
    });
    truncation.push({
        what: 'lastSentPrompt',
        limit: '2 MB, oldest messages dropped first',
        note: 'Capped in pipeline.js at capture time, not here.',
    });
    // The chat array is the one deliberate OMISSION, and "omitted" is exactly
    // what this manifest claims to enumerate — so it is listed here as well as
    // explained at diag.chat.why.
    truncation.push({
        what: 'chat (the message array)',
        action: 'omitted entirely; only per-message watermarks are exported',
        of: diag.chat.messageCount,
        note: 'SillyTavern owns the chat file, and the agents never read it raw — the windows they were actually given '
            + 'are in `traceRuns`. See diag.chat.why.',
    });
    diag.truncation = {
        note: 'Everything this export capped or omitted, including its own manifests. Anything cut inside a value also '
            + 'carries an inline marker at the cut, so a truncation can be spotted without reading this list.',
        items: truncation,
    };
    return diag;
}

// Accessors reach into chatMetadata and the DOM and can throw while a chat is
// mid-switch. One dead accessor must not cost the whole export, so each failure
// becomes a visible field instead of an abort.
function safeCall(fn, fallback) {
    try { return fn(); } catch (e) { return { __error: String(e?.message || e), __fallback: fallback }; }
}

// Download + clipboard + the clipboard-blocked textarea fallback. Shared by both
// modes; `clipboard` is off for the full export because a multi-megabyte
// clipboard write is slow, frequently rejected, and useless for a file that is
// meant to be attached rather than pasted.
async function deliverDiagnostics(payload, filename, { clipboard, title, successText }) {
    let downloaded = false;
    try {
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        downloaded = true;
    } catch {  }

    if (clipboard) {
        try {
            await navigator.clipboard.writeText(payload);
            try { toastr.success(successText, 'BF Memory'); } catch {  }
            return;
        } catch {  }
    } else if (downloaded) {
        try { toastr.success(successText, 'BF Memory'); } catch {  }
        return;
    }

    // Either the clipboard was blocked or the download failed — show the text so
    // the user still has a way to get the payload out.
    try {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1a1a2e);padding:16px;border-radius:8px;max-width:720px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:8px;';
        const titleEl = document.createElement('div'); titleEl.textContent = title; titleEl.style.cssText = 'font-weight:bold;color:#7bb3ff;';
        const hint = document.createElement('div');
        hint.textContent = (clipboard ? 'Clipboard was blocked. ' : 'The download did not start. ')
            + 'Ctrl+A / long-press in the box, then Copy.'
            + (downloaded ? ' (It was also downloaded as a file.)' : '');
        hint.style.cssText = 'font-size:12px;opacity:0.7;';
        const ta = document.createElement('textarea'); ta.value = payload; ta.style.cssText = 'width:100%;flex:1;min-height:320px;font-family:monospace;font-size:11px;';
        const close = document.createElement('button'); close.textContent = 'Close'; close.className = 'menu_button'; close.onclick = () => overlay.remove();
        card.append(titleEl, hint, ta, close); overlay.appendChild(card); document.body.appendChild(overlay);
        ta.focus(); ta.select();
    } catch {  }
}

function diagChatId() {
    try { return String(getContext().chatId ?? 'diag'); } catch { return 'diag'; }
}

export async function copyDiagnostics() {
    let payload;
    try {
        payload = JSON.stringify(await buildDiagnostics(false), null, 2);
    } catch (e) {
        payload = JSON.stringify({ error: 'diagnostics build failed: ' + String(e?.message || e) }, null, 2);
    }
    await deliverDiagnostics(payload, `bf-mem-diagnostics-${diagChatId()}-${Date.now()}.json`, {
        clipboard: true,
        title: 'Copy diagnostics',
        successText: `Diagnostics copied + downloaded (${Math.round(payload.length / 1024)} KB)`,
    });
}

// Pre-flight size limits.
//
// JSON.stringify(diag, null, 2) is ONE synchronous allocation of the entire
// file, then Blob copies it, then — if the download fails — the fallback drops
// the whole thing into a textarea. On a big database plus a full trace ring that
// chain is three copies of a nine-figure string, and when it breaks it breaks as
// a bare RangeError that the catch below turned into a one-line error file where
// the user expected their run. So: estimate first, and if it fails anyway, say
// what was too big and what to do about it.
//
// V8's hard limit is ~2^29 chars (~512 M). WARN is where the three-copy chain
// starts to be felt (~200 MB of UTF-16 at the peak); ABORT is where attempting
// it is more likely to kill the tab than to produce a file.
const EXPORT_WARN_CHARS = 50_000_000;
const EXPORT_ABORT_CHARS = 200_000_000;

// Cheap, no stringify: the trace ring's cost is already known per entry, the
// rest is counted from the sizes the export block reports. Deliberately a rough
// over-estimate — its only job is to catch the case that would otherwise die
// without an explanation.
function estimateExportChars(factCount, logEntries) {
    return estimateTraceChars()
        + factCount * 900        // a fact record with relationships, pretty-printed
        + logEntries * 500       // one ordinary log entry with its data block
        + 200_000;               // prompts, sheet, spine, scenes, watermarks, health
}

// The "Download Test Run" button. Everything copyDiagnostics has, plus every
// pipeline accessor, the health events, the retrieval index and the trace
// regrouped per run. Download only — see deliverDiagnostics.
export async function downloadTestRunExport() {
    let payload, entries = 0;
    try {
        const diag = await buildDiagnostics(true);
        entries = diag?.meta?.traceEntries ?? 0;
        const estimate = estimateExportChars(diag?.meta?.counts?.facts ?? 0, diag?.meta?.counts?.logEntries ?? 0);
        if (estimate > EXPORT_ABORT_CHARS) {
            throw new Error(`estimated ${Math.round(estimate / 1e6)} M characters, over the ${Math.round(EXPORT_ABORT_CHARS / 1e6)} M limit`);
        }
        if (estimate > EXPORT_WARN_CHARS) {
            try { toastr.warning(`Building a large export (~${Math.round(estimate / 1e6)} MB). This may freeze the tab for a few seconds.`, 'BF Memory'); } catch {  }
        }
        payload = JSON.stringify(diag, null, 2);
    } catch (e) {
        // A failed export must still tell the user WHY and what to change —
        // the previous one-line error file was indistinguishable from a bug.
        const why = String(e?.message || e);
        payload = JSON.stringify({
            error: 'test-run export build failed: ' + why,
            likelyCause: /range|invalid string|allocation|memory/i.test(why)
                ? 'The assembled JSON was too large for one string.'
                : 'See the message above.',
            sizes: {
                traceEntries: traceLog.length,
                traceCharsApprox: estimateTraceChars(),
                logEntries: debugLog.length,
            },
            whatToDo: [
                'Turn "record a test run" off — the trace ring is usually the biggest part.',
                'Download again immediately after the turn you want, before the ring fills.',
                'Clear the debug log, reproduce the one turn, then export.',
                'Use "Copy Diagnostics" for the smaller bundle if you only need settings, databases and the log.',
            ],
        }, null, 2);
        try { toastr.error(`Test-run export failed: ${why}`, 'BF Memory'); } catch {  }
    }
    addDebugLog('info', `Test-run export written (${Math.round(payload.length / 1024)} KB, ${entries} trace entries)`, {
        subsystem: 'settings', event: 'log.exported', actor: 'USER',
        data: { mode: 'full-test-run', chars: payload.length, traceEntries: entries, recording: getSettings()?.debugTraceRun === true },
    });
    await deliverDiagnostics(payload, `bf-mem-testrun-${diagChatId()}-${Date.now()}.json`, {
        clipboard: false,
        title: 'Test-run export',
        successText: `Test run downloaded (${Math.round(payload.length / 1024)} KB, ${entries} trace entries)`,
    });
}

const DEFAULT_LOG_LEVEL_FILTER = new Set(['fail', 'pass', 'info']);
let logLevelFilter = new Set(DEFAULT_LOG_LEVEL_FILTER);
let logSubsystemFilter = '';
let logSearchFilter = '';

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

// THE DEBUG-TAB VIEW. The two rings are merged HERE, at render time, and only
// here — nothing downstream of this function is allowed to put a trace entry
// back into `debugLog`.
//
// Traces are merged in only when the verbose level is ticked, which is the only
// filter that can display them at all (traceCapture emits at verbose and nothing
// else does), so a user who is not looking at traces pays nothing. Both arrays
// are newest-first and `seq` is one global counter shared by both rings, so a
// two-pointer merge restores true emission order without sorting.
function logEntriesForView() {
    if (!traceLog.length || !logLevelFilter.has('verbose')) return debugLog;
    const out = [];
    let i = 0, j = 0;
    while (i < debugLog.length && j < traceLog.length) {
        out.push((debugLog[i].seq >= traceLog[j].seq) ? debugLog[i++] : traceLog[j++]);
    }
    while (i < debugLog.length) out.push(debugLog[i++]);
    while (j < traceLog.length) out.push(traceLog[j++]);
    return out;
}

// Search haystacks, memoised for TRACE entries only.
//
// entryMatchesFilter stringifies entry.data for every visible entry on every
// render, and renderDebugLog runs on every single capture — so with a search
// term active a recorded turn used to re-stringify the whole ring ~51 times.
// A trace payload is up to TRACE_MAX_ENTRY_CHARS, so that is millions of chars
// per keystroke. Trace payloads are frozen snapshots (sanitizeTraceValue rebuilds
// them into fresh plain data and nothing writes to them afterwards), so the cache
// can never go stale. Ordinary entries store opts.data BY REFERENCE and their
// callers do mutate it, so those are still stringified fresh — they are small.
// A WeakMap rather than a field on the entry: it must not reach the exported JSON
// and it must be collected when the ring evicts the entry.
const traceHaystacks = new WeakMap();

function entryMatchesFilter(entry) {
    const level = entry.level || entry.type || 'info';
    if (logLevelFilter.size && !logLevelFilter.has(level)) return false;
    if (logSubsystemFilter && (entry.subsystem || 'settings') !== logSubsystemFilter) return false;
    if (logSearchFilter) {
        const isTrace = entry.subsystem === TRACE_SUBSYSTEM;
        let hay = isTrace ? traceHaystacks.get(entry) : undefined;
        if (hay === undefined) {
            hay = (
                (entry.message || '') + ' ' +
                (entry.runId || '') + ' ' +
                (entry.event || '') + ' ' +
                (entry.subsystem || '') + ' ' +
                (entry.data != null ? safeStringify(entry.data) : '')
            ).toLowerCase();
            if (isTrace) traceHaystacks.set(entry, hay);
        }
        if (!hay.includes(logSearchFilter)) return false;
    }
    return true;
}

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

    const source = logEntriesForView();
    const total = source.length;
    const visible = source.filter(entryMatchesFilter);

    const order = [];
    const groups = new Map(); 
    const ungrouped = [];
    for (const e of visible) {
        const rid = e.runId;
        if (!rid) { ungrouped.push(e); continue; }
        if (!groups.has(rid)) { groups.set(rid, []); order.push(rid); }
        groups.get(rid).push(e);
    }

    const blocks = [];
    for (const rid of order) {
        const entries = groups.get(rid);
        const label = escapeHtml(`Run ${rid || '(run)'}`);
        const body = entries.map(renderEntryHtml).join('');
        blocks.push(
            `<details class="bf-mem-run-group">` +
            `<summary>${label} <span class="bf-mem-run-count">(${entries.length})</span></summary>` +
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

// The plain-text log export ("Copy Logs"). Mirrors exactly what the Debug tab is
// showing, traces included when they are visible — safe to do because this
// format emits only the one-line MESSAGE of each entry and never `data`, which
// is where every prompt, reply and tool result lives.
export function exportLogs() {

    try { syncLogFilterFromUI(); } catch {  }
    const source = logEntriesForView();
    const total = source.length;
    const visible = source.filter(entryMatchesFilter);
    const header = `=== BF Memory Pipeline Debug Logs ===\nExported: ${new Date().toISOString()}\nEntries: ${visible.length} of ${total} (filtered)\n${'='.repeat(40)}\n\n`;
    const logText = visible.map(entry => `[${entry.timestamp}] [${(entry.type || entry.level || 'info').toUpperCase().padEnd(5)}] ${entry.message}`).join('\n');
    const out = header + logText;
    addDebugLog('info', `Logs exported (${visible.length} of ${total} entries)`, {
        subsystem: 'settings', event: 'log.exported', actor: 'USER', data: { entryCount: visible.length, totalCount: total },
    });
    return out;
}

// The JSON log export. settings.js downloads this AND writes it to the
// clipboard, so it must never carry trace payloads — `debugLog` holds none
// because traces are on their own ring, and this is deliberately the raw ring
// rather than the merged view for exactly that reason. Use "Download Test Run"
// to get the recorded run.
export function exportLogsJSON() {
    let chatId = null;
    try { chatId = getContext().chatId ?? null; } catch {  }
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        chatId,
        note: 'Ordinary diagnostics only. Recorded test-run captures are in the "Download Test Run" file.',
        entries: debugLog,
    }, null, 2);
}

export function clearDebugLog() {
    debugLog = [];
    // The button clears "the log", and the Debug tab shows both rings — leaving
    // the recorded run behind would look like the clear had failed.
    traceLog = [];
    saveDebugLogToMeta();

    logFileDirty = false;
    let chatId = '';
    try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch {  }
    if (chatId) {
        (async () => {
            try { const { deleteDebugLogFile } = await import('./database.js'); await deleteDebugLogFile(chatId); }
            catch {  }
        })();
    }
    renderDebugLog();
}

// ORDINARY DIAGNOSTIC ENTRIES ONLY, newest first — never trace captures, whether
// or not recording is on. Callers scan a fixed window of this (health.js takes
// the newest 50 to find failures); a recorded turn emits ~51 captures, so while
// they shared a ring one recorded turn pushed every real failure out of that
// window and the Health tab reported "no failures". Use getTraceEntries() for
// the recorded run.
export function getDebugLogEntries() {
    return debugLog;
}
