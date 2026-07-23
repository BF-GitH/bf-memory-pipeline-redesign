// Pipeline health self-test (Health tab). Two data sources, deliberately split:
// recordHealthEvent() stores what actually HAPPENED this session (pipeline hooks
// push pass/fail facts as they occur), while buildHealthReport() pulls live state
// on demand — so each step can distinguish "configured but never ran" (gray)
// from "ran and broke" (red). The event store is session-only on purpose: a
// stale green from a previous browser session would hide a now-broken step.
import { getSettings, getMemorySheet, getStorySpine, getCurrentScene } from './settings.js';
import { getDebugLogEntries } from './debug-log.js';
import { getContext } from './ui-util.js';

// Matches BEAT_MAX_CHARS in agent-memory.js — a beat past this slipped through
// the brevity enforcement (or predates it) and bloats every injected sheet.
const BEAT_WARN_CHARS = 300;

// How many newest debug-log entries the "recent errors" step scans.
const RECENT_LOG_WINDOW = 50;

const healthEvents = {};

export function recordHealthEvent(key, payload) {
    if (!key) return;
    healthEvents[String(key)] = { ts: Date.now(), ...(payload && typeof payload === 'object' ? payload : {}) };
}

// Same stale-green reasoning as the session-only store: events from chat A must
// not report as chat B's health. Called from the pipeline's CHAT_CHANGED reset.
export function clearHealthEvents() {
    for (const key of Object.keys(healthEvents)) delete healthEvents[key];
}

function ev(key) {
    const e = healthEvents[key];
    return (e && typeof e === 'object') ? e : null;
}

function ageText(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export async function buildHealthReport() {
    const settings = getSettings();
    const steps = [];

    // a. Extension enabled — everything below is moot when this is off.
    steps.push(settings?.enabled
        ? { id: 'enabled', label: 'Extension', status: 'ok', detail: 'enabled' }
        : { id: 'enabled', label: 'Extension', status: 'fail', detail: 'disabled — the pipeline does nothing' });

    // b. Agent LLM profile.
    steps.push(settings?.agent3Profile
        ? { id: 'profile', label: 'Agent LLM profile', status: 'ok', detail: 'dedicated connection profile configured' }
        : { id: 'profile', label: 'Agent LLM profile', status: 'warn', detail: 'uses main API profile' });

    // c. Memory sheet. getMemorySheet() auto-seeds, so null only on a hard failure.
    let sheet = null;
    try { sheet = getMemorySheet(); } catch {  }
    if (!sheet || !String(sheet.text || '').trim()) {
        steps.push({ id: 'sheet', label: 'Memory sheet', status: 'fail', detail: 'no sheet yet' });
    } else if (sheet.seeded) {
        steps.push({ id: 'sheet', label: 'Memory sheet', status: 'warn', detail: 'seed skeleton only — memory agent has not produced a sheet yet' });
    } else {
        const ts = Date.parse(sheet.updatedAt || '');
        steps.push({
            id: 'sheet', label: 'Memory sheet', status: 'ok',
            detail: `${sheet.text.length} chars`,
            ts: Number.isFinite(ts) ? ts : undefined,
        });
    }

    // d. Prompt injection — last recorded outcome this session.
    const inj = ev('injection');
    if (!inj) {
        steps.push({ id: 'injection', label: 'Prompt injection', status: 'none', detail: 'no generation observed yet' });
    } else if (inj.status === 'ok') {
        const tokens = (Number(inj.baselineInput) || Number(inj.actualInput))
            ? `, tokens ${Number(inj.baselineInput) || 0} → ${Number(inj.actualInput) || 0}`
            : '';
        const trimmed = Number.isFinite(Number(inj.trimmedCount)) ? `, trimmed ${Number(inj.trimmedCount)} msg(s)` : '';
        steps.push({ id: 'injection', label: 'Prompt injection', status: 'ok', detail: `injected (${inj.path || 'chat'} path${tokens}${trimmed})`, ts: inj.ts });
    } else if (inj.status === 'empty') {
        steps.push({ id: 'injection', label: 'Prompt injection', status: 'warn', detail: 'sheet was empty at generation time — nothing injected', ts: inj.ts });
    } else {
        steps.push({ id: 'injection', label: 'Prompt injection', status: 'fail', detail: String(inj.reason || 'injection failed'), ts: inj.ts });
    }

    // e. History trim. Trim only exists on the chat-completion injection path;
    // GENERATE_AFTER_DATA (text-completion) never trims, so a green "keeps last N"
    // claim would be false there — key off the last injection's path.
    const trimN = Math.max(0, Math.floor(Number(settings?.agent2ContextMessages) || 0));
    if (trimN === 0) {
        steps.push({ id: 'trim', label: 'History trim', status: 'warn', detail: 'trim disabled — full history is sent' });
    } else if (inj && inj.path === 'text') {
        steps.push({ id: 'trim', label: 'History trim', status: 'warn', detail: `configured (last ${trimN}) but the text-completion path never trims — full history is sent` });
    } else if (!inj) {
        steps.push({ id: 'trim', label: 'History trim', status: 'none', detail: `configured (last ${trimN}) — no generation observed yet (chat-completion path only)` });
    } else {
        const lastTrim = Number.isFinite(Number(inj.trimmedCount)) ? `, last run removed ${Number(inj.trimmedCount)}` : '';
        steps.push({ id: 'trim', label: 'History trim', status: 'ok', detail: `keeps last ${trimN} messages${lastTrim}` });
    }

    // f. Memory agent (extraction).
    const ext = ev('extraction');
    if (!ext) {
        steps.push({ id: 'extraction', label: 'Memory agent', status: 'none', detail: 'no extraction run yet this session' });
    } else if (ext.status === 'ok') {
        steps.push({
            id: 'extraction', label: 'Memory agent', status: 'ok',
            detail: `${Number(ext.writes) || 0} write(s), ${Number(ext.rounds) || 0} round(s), ${Number(ext.durationMs) || 0}ms`,
            ts: ext.ts,
        });
    } else {
        steps.push({ id: 'extraction', label: 'Memory agent', status: 'fail', detail: String(ext.error || 'extraction failed'), ts: ext.ts });
    }

    // g. Story spine — coverage vs. current chat length.
    let spine = [];
    try { spine = getStorySpine(); } catch {  }
    let chatLen = 0;
    try { chatLen = Array.isArray(getContext()?.chat) ? getContext().chat.length : 0; } catch {  }
    // Must mirror the pipeline's clamp exactly (pipeline.js spine batching):
    // 4..30, non-finite falls back to 10 — 0 clamps to 4, it does not mean 10.
    const rawBatch = Number(settings?.spineBatchSize);
    const batchSize = Number.isFinite(rawBatch) ? Math.min(30, Math.max(4, Math.floor(rawBatch))) : 10;
    const spineEv = ev('spine');
    if (!Array.isArray(spine) || spine.length === 0) {
        steps.push(chatLen > batchSize
            ? { id: 'spine', label: 'Story spine', status: 'warn', detail: `no spine yet after ${chatLen} messages (expected first sentence after ~${batchSize})` }
            : { id: 'spine', label: 'Story spine', status: 'none', detail: 'not enough messages yet' });
    } else {
        const lastEnd = Number(spine[spine.length - 1].endMsg);
        const lag = (chatLen - 1) - (Number.isFinite(lastEnd) ? lastEnd : -1);
        steps.push(lag > 2 * batchSize
            ? { id: 'spine', label: 'Story spine', status: 'warn', detail: `${spine.length} sentence(s), but coverage lags: last covered msg ${lastEnd} of ${chatLen} (${lag} behind)`, ts: spineEv?.ts }
            : { id: 'spine', label: 'Story spine', status: 'ok', detail: `${spine.length} sentence(s), covered through msg ${lastEnd} of ${chatLen}`, ts: spineEv?.ts });
    }

    // h. Scene card.
    let scene = null;
    try { scene = getCurrentScene(); } catch {  }
    if (!scene) {
        steps.push({ id: 'scene', label: 'Scene card', status: 'none', detail: 'no scene open yet' });
    } else {
        const beats = Array.isArray(scene.beats) ? scene.beats : [];
        const overLong = beats.some(b => String(b?.sentence || '').length > BEAT_WARN_CHARS);
        const name = scene.name || '(unnamed)';
        steps.push(overLong
            ? { id: 'scene', label: 'Scene card', status: 'warn', detail: `"${name}", ${beats.length} beat(s) — over-long beat detected (>${BEAT_WARN_CHARS} chars)` }
            : { id: 'scene', label: 'Scene card', status: 'ok', detail: `"${name}", ${beats.length} beat(s)` });
    }

    // i. Reflection.
    const refl = ev('reflection');
    if (!refl) {
        steps.push({ id: 'reflection', label: 'Reflection', status: 'none', detail: 'has not run yet (runs every ~12 replies)' });
    } else if (refl.status === 'ok') {
        steps.push({ id: 'reflection', label: 'Reflection', status: 'ok', detail: `last pass ${Number(refl.durationMs) || 0}ms`, ts: refl.ts });
    } else {
        steps.push({ id: 'reflection', label: 'Reflection', status: 'fail', detail: String(refl.error || 'reflection failed'), ts: refl.ts });
    }

    // j. Recent errors — scan the newest debug-log entries (newest first).
    let failCount = 0;
    let scanned = 0;
    try {
        const entries = getDebugLogEntries() || [];
        const window = entries.slice(0, RECENT_LOG_WINDOW);
        scanned = window.length;
        failCount = window.filter(e => (e?.level || e?.type) === 'fail').length;
    } catch {
        // Debug log unavailable — fall back to health-recorded failures only.
        scanned = 0;
        failCount = Object.values(healthEvents).filter(e => e?.status === 'fail').length;
    }
    steps.push(failCount > 0
        ? { id: 'errors', label: 'Recent errors', status: 'warn', detail: scanned ? `${failCount} failure(s) in the last ${scanned} log entries` : `${failCount} recorded failure(s) this session` }
        : { id: 'errors', label: 'Recent errors', status: 'ok', detail: scanned ? `no failures in the last ${scanned} log entries` : 'no failures recorded this session' });

    return steps;
}

export { ageText as formatHealthAge };
