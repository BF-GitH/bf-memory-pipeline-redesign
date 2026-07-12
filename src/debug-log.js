import { getSettings } from './settings.js';
import { getContext, escapeHtml, safeStringify } from './ui-util.js';
import {
    getLastRunTokens, getSessionTokens,
    getLastGenerated, getLastInserted,
} from './turn-state.js';

let debugLog = [];

const MAX_DEBUG_ENTRIES = 500; 

const MAX_DEBUG_ENTRIES_MEM = 2000;       
const MAX_DEBUG_ENTRIES_PERSIST = MAX_DEBUG_ENTRIES; 

const LOG_PERSIST_BYTE_BUDGET = 256 * 1024; 

let logSeq = 0;

let currentRunId = null;

const LOG_LEVELS = new Set(['fail', 'pass', 'info', 'debug', 'verbose']);
const LOG_SUBSYSTEMS = new Set([
    'pipeline', 'agent1', 'agent3', 'finder', 'retrieval', 'db',
    'entity', 'reflection', 'settings', 'import', 'cache', 'writer',
]);

const SUBSYSTEM_DISPLAY = {
    agent2: 'Writer',
    writer: 'Writer',
    agent3: 'Scribe',
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
    return debugLog.slice(0, MAX_DEBUG_ENTRIES_FILE);
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

    if (level === 'verbose' && !getSettings()?.debugVerbose) return;

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

    debugLog.unshift(entry);
    if (debugLog.length > MAX_DEBUG_ENTRIES_MEM) debugLog.length = MAX_DEBUG_ENTRIES_MEM;

    saveDebugLogToMeta();
    logFileDirty = true;
    void flushDebugLogFile(false); 
    renderDebugLog();

    if (getSettings()?.debugMode) {
        const tag = level.toUpperCase();
        const sub = subsystem !== 'settings' ? ` ${subsystem}` : '';
        const rid = runId ? ` [${runId}]` : '';
        console.log(`[BFMemory] [${tag}]${rid}${sub} ${message}`);
    }
}

export async function copyDiagnostics() {
    let payload;
    try {
        const ctx = getContext();
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
                    logEntries: debugLog.length,
                },

                note: 'Complete extension state. The model\'s full ST-assembled prompt is outside this extension.',
            },
            settings: getSettings(),   
            tokens: {                      
                lastRun: getLastRunTokens(),
                session: getSessionTokens(),
            },
            lastGenerated: getLastGenerated(),
            lastInserted: getLastInserted(),
            reviewPending: review,
            databases,                     
            debugLog,                      
        };
        payload = JSON.stringify(diag, null, 2);
    } catch (e) {
        payload = JSON.stringify({ error: 'diagnostics build failed: ' + String(e?.message || e) }, null, 2);
    }

    let chatId = 'diag';
    try { chatId = String(getContext().chatId ?? 'diag'); } catch {  }
    try {
        const blob = new Blob([payload], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `bf-mem-diagnostics-${chatId}-${Date.now()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {  }
    try {
        await navigator.clipboard.writeText(payload);
        try { toastr.success(`Diagnostics copied + downloaded (${Math.round(payload.length / 1024)} KB)`, 'BF Memory'); } catch {  }
    } catch {

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
        } catch {  }
    }
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

export function exportLogs() {

    try { syncLogFilterFromUI(); } catch {  }
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

export function exportLogsJSON() {
    let chatId = null;
    try { chatId = getContext().chatId ?? null; } catch {  }
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        chatId,
        entries: debugLog,
    }, null, 2);
}

export function clearDebugLog() {
    debugLog = [];
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

export function getDebugLogEntries() {
    return debugLog;
}
