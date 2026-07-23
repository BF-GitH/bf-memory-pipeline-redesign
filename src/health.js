// Pipeline health self-test (Health tab). Two data sources, deliberately split:
// recordHealthEvent() stores what actually HAPPENED this session (pipeline hooks
// push pass/fail facts as they occur), while buildHealthReport() pulls live state
// on demand — so each step can distinguish "configured but never ran" (gray)
// from "ran and broke" (red). The event store is session-only on purpose: a
// stale green from a previous browser session would hide a now-broken step.
import { getSettings, getMemorySheet, getStorySpine, getCurrentScene } from './settings.js';
import { getDebugLogEntries } from './debug-log.js';
import { getContext } from './ui-util.js';
import { KNOWN_TOOLS as MEMORY_AGENT_TOOLS, REFLECTION_READ_TOOLS } from './memory-tools.js';

// Matches BEAT_MAX_CHARS in agent-memory.js — a beat past this slipped through
// the brevity enforcement (or predates it) and bloats every injected sheet.
const BEAT_WARN_CHARS = 300;

// How many newest debug-log entries the "recent errors" step scans.
const RECENT_LOG_WINDOW = 50;

const healthEvents = {};

// Session-scoped per-agent tool telemetry: { [agentTag]: { [tool]: { count, lastTs } } }.
// agentTag is 'memory' or 'reflection'. Recorded from the tool-loop choke point
// in llm-call.js AFTER the executor returns success, so only tool calls that
// actually EXECUTED are counted — parse attempts, malformed calls, rejected
// calls (reflection's read-only gate) and failed calls never show up here.
const toolUsage = {};

// Bumped on every clearHealthEvents (CHAT_CHANGED). A tool loop still in
// flight across a chat switch carries the OLD epoch on its records, which are
// dropped — the previous chat's calls never bleed into the new chat's rows.
let toolUsageEpoch = 0;

export function getToolUsageEpoch() {
    return toolUsageEpoch;
}

export function recordToolUse(agentTag, toolName, epoch = null) {
    if (epoch !== null && epoch !== toolUsageEpoch) return; // stale loop from before a chat switch
    const tag = String(agentTag || '').trim();
    const tool = String(toolName || '').trim();
    if (!tag || !tool) return;
    const byTool = toolUsage[tag] || (toolUsage[tag] = {});
    const entry = byTool[tool] || (byTool[tool] = { count: 0, lastTs: 0 });
    entry.count++;
    entry.lastTs = Date.now();
}

export function getToolUsage() {
    return toolUsage;
}

export function recordHealthEvent(key, payload) {
    if (!key) return;
    healthEvents[String(key)] = { ts: Date.now(), ...(payload && typeof payload === 'object' ? payload : {}) };
    notifyHealthChange();
}

// Auto-refresh plumbing: settings.js registers a listener that re-renders the
// Health tab when it is visible. Debounced so a burst of events at the end of
// a run (injection + extraction + spine) repaints once, not once per event.
let healthChangeListener = null;
let healthNotifyTimer = null;
export function setHealthChangeListener(fn) {
    healthChangeListener = (typeof fn === 'function') ? fn : null;
}
function notifyHealthChange() {
    if (!healthChangeListener || healthNotifyTimer) return;
    healthNotifyTimer = setTimeout(() => {
        healthNotifyTimer = null;
        try { healthChangeListener(); } catch {  }
    }, 800);
}

// Same stale-green reasoning as the session-only store: events from chat A must
// not report as chat B's health. Called from the pipeline's CHAT_CHANGED reset.
export function clearHealthEvents() {
    for (const key of Object.keys(healthEvents)) delete healthEvents[key];
    for (const key of Object.keys(toolUsage)) delete toolUsage[key];
    toolUsageEpoch++; // invalidates records from loops started before the reset
    notifyHealthChange(); // a visible Health tab must not keep showing the old chat
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

    // b2. Agent connection (bridge). Fed by every agent-LLM call outcome
    // (llm-call.js records 'agentCall'); user cancels are never recorded.
    // Covers self-hosted bridges (e.g. Claude Code CLI on Termux) that can be
    // asleep/unreachable while the main chat API still works fine.
    const bridge = ev('agentCall');
    if (!bridge) {
        steps.push({ id: 'bridge', label: 'Agent connection', status: 'none', detail: 'no agent call this session yet — use Test connection' });
    } else if (bridge.ok) {
        steps.push({ id: 'bridge', label: 'Agent connection', status: 'ok', detail: `${bridge.profileId ? 'agent profile' : 'main API'} reachable — last call ${(Math.max(0, Number(bridge.ms) || 0) / 1000).toFixed(1)}s (${bridge.agent || 'agent'})`, ts: bridge.ts });
    } else {
        steps.push({ id: 'bridge', label: 'Agent connection', status: 'fail', detail: `last ${bridge.profileId ? 'agent-profile' : 'main-API'} call failed after ${(Math.max(0, Number(bridge.ms) || 0) / 1000).toFixed(1)}s: ${bridge.error || 'unknown error'}`, ts: bridge.ts });
    }

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
        const kFmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
        if (Number.isFinite(Number(inj.totalMsgs))) {
            // Post-injection snapshot: what was ACTUALLY sent after trim + sheet.
            // External capture tools hook the prompt event BEFORE this extension's
            // injection and show a pre-injection prompt — this row is ground truth.
            const parts = [];
            if (Number.isFinite(Number(inj.chatMsgs))) parts.push(`${Number(inj.chatMsgs)} chat`);
            parts.push(inj.sheetPresent ? `sheet ${kFmt(Number(inj.sheetChars) || 0)} chars` : 'no sheet');
            const tokens = Number(inj.actualInput) > 0 ? `, ~${kFmt(Number(inj.actualInput))} tokens` : '';
            let trimTxt = '';
            if ((inj.path || 'chat') === 'chat') {
                const cfg = Math.max(0, Number(inj.trimToLast) || 0);
                const eff = Math.max(0, Number(inj.effectiveTrim) || 0);
                trimTxt = cfg === 0 ? ', trim off' : (eff > cfg ? `, trim ${cfg} (+${eff - cfg} lag)` : `, trim ${cfg}`);
            }
            const pathTxt = inj.path === 'text' ? ' — text path' : '';
            steps.push({
                id: 'injection', label: 'Prompt injection', status: 'ok',
                detail: `sent ${Number(inj.totalMsgs)} msgs (${parts.join(' + ')})${tokens}${trimTxt}${pathTxt}`,
                ts: inj.ts,
            });
        } else {
            // Pre-snapshot event shape (or a string-prompt text path) — old detail.
            // Text-path events never carry baselineInput: a missing baseline must
            // not render as "tokens 0 → N" (that would claim a 0-token prompt).
            const base = Number(inj.baselineInput) || 0;
            const act = Number(inj.actualInput) || 0;
            const tokens = base ? `, tokens ${base} → ${act}` : (act ? `, ~${act} tokens` : '');
            const trimmed = Number.isFinite(Number(inj.trimmedCount)) ? `, trimmed ${Number(inj.trimmedCount)} msg(s)` : '';
            steps.push({ id: 'injection', label: 'Prompt injection', status: 'ok', detail: `injected (${inj.path || 'chat'} path${tokens}${trimmed})`, ts: inj.ts });
        }
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

    // e2. Catch-up — settled-but-unprocessed backlog. When behind, the trim
    // window auto-widens to the lag depth (pipeline.js computeCatchupLag) so an
    // unprocessed message is never cut out of the storyteller's context.
    // Dynamic import: pipeline.js statically imports this module, so a static
    // back-edge would create an import cycle.
    try {
        const { computeCatchupLag } = await import('./pipeline.js');
        const { lag, count } = computeCatchupLag();
        if (count === 0) {
            steps.push({ id: 'catchup', label: 'Catch-up', status: 'ok', detail: 'up to date' });
        } else if (trimN === 0) {
            steps.push({ id: 'catchup', label: 'Catch-up', status: 'warn', detail: `${count} message(s) behind — trim is off, full history keeps them in context` });
        } else if (inj && inj.path === 'text') {
            // Widening only exists on the chat-completion path; the text path
            // never trims, so the backlog stays in context via full history —
            // claiming a "widened" window here would contradict the trim row.
            steps.push({ id: 'catchup', label: 'Catch-up', status: 'warn', detail: `${count} message(s) behind — the text-completion path never trims, full history keeps them in context` });
        } else {
            const effective = Math.max(trimN, lag);
            steps.push({ id: 'catchup', label: 'Catch-up', status: 'warn', detail: `${count} message(s) behind — context window widens to ${effective} (chat-completion path)` });
        }
    } catch {
        steps.push({ id: 'catchup', label: 'Catch-up', status: 'none', detail: 'backlog state unavailable' });
    }

    // f. Memory agent (extraction) — ONE row. When the run reported per-call
    // outcomes (3-call split: extract tool-loop / beats / sheet-head), render
    // the composite detail; the row's dot is the worst sub-call outcome. An
    // extract failure is red (facts/NEED lost, watermark held); a beats/head
    // failure only yellow (non-fatal — the sheet still composed around it).
    const ext = ev('extraction');
    const extractionComposite = (calls) => {
        if (!calls || typeof calls !== 'object') return null;
        const parts = [];
        let worst = 'ok';
        const bump = (s) => { if (s === 'fail') worst = 'fail'; else if (worst !== 'fail') worst = 'warn'; };
        const e = calls.extract;
        if (e) {
            if (e.status === 'ok') parts.push(`extract ok (${Number(e.writes) || 0} write(s), ${Number(e.rounds) || 0} round(s))`);
            else { parts.push(`extract FAIL (${String(e.error || 'error').slice(0, 80)})`); bump('fail'); }
        }
        const b = calls.beats;
        if (b) {
            const ratio = `${Number(b.got) || 0}/${Number(b.want) || 0}`;
            if (b.status === 'ok') parts.push(`beats ok (${ratio})`);
            else if (b.status === 'partial') { parts.push(`beats partial (${ratio})`); bump('warn'); }
            else { parts.push(`beats FAIL (${ratio})`); bump('warn'); }
        }
        const h = calls.head;
        if (h) {
            if (h.status === 'ok') parts.push('head ok');
            else { parts.push(`head FAIL (${String(h.error || 'error').slice(0, 80)})`); bump('warn'); }
        }
        return parts.length > 0 ? { status: worst, detail: parts.join(' · ') } : null;
    };
    const composite = ext ? extractionComposite(ext.calls) : null;
    if (!ext) {
        steps.push({ id: 'extraction', label: 'Memory agent', status: 'none', detail: 'no extraction run yet this session' });
    } else if (composite) {
        // A pipeline-level failure AFTER a clean agent run (commit guard, throw
        // in a later step) must not render as an all-green composite.
        let compStatus = composite.status;
        let compDetail = composite.detail;
        if (ext.status === 'fail' && compStatus !== 'fail') {
            compStatus = 'fail';
            compDetail += ` · run FAIL (${String(ext.error || 'error').slice(0, 80)})`;
        }
        steps.push({ id: 'extraction', label: 'Memory agent', status: compStatus, detail: compDetail, ts: ext.ts });
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
        const loopInfo = Number(refl.rounds) > 0
            ? `, ${Number(refl.rounds)} round(s), ${Number(refl.toolCallCount) || 0} tool call(s)`
            : '';
        steps.push({ id: 'reflection', label: 'Reflection', status: 'ok', detail: `last pass ${Number(refl.durationMs) || 0}ms${loopInfo}`, ts: refl.ts });
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

    // k. Per-agent tool telemetry — which tools each agent has and when each was
    // last actually executed this session. `header: true` rows are section
    // headers (no dot), `indent: true` rows nest under them.
    const toolRow = (tag, tool) => {
        const u = toolUsage[tag]?.[tool];
        return (u && u.count > 0)
            ? { id: `tools_${tag}_${tool}`, label: tool, status: 'ok', detail: `${u.count} call(s), last ${ageText(u.lastTs)}`, indent: true }
            : { id: `tools_${tag}_${tool}`, label: tool, status: 'none', detail: 'never used', indent: true };
    };

    steps.push({ id: 'tools_memory', label: 'Memory agent tools', header: true });
    // Known roster first (stable order), then any extras that showed up in the
    // usage store but are not in the constant (future-proofing, should be rare).
    const memoryExtras = Object.keys(toolUsage['memory'] || {}).filter(t => !MEMORY_AGENT_TOOLS.includes(t));
    for (const tool of [...MEMORY_AGENT_TOOLS, ...memoryExtras]) steps.push(toolRow('memory', tool));

    steps.push({ id: 'tools_reflection', label: 'Reflection tools', header: true });
    // Reflection's fixed read-only roster first (stable order), then any extras
    // recorded under the tag that are not in the constant (future-proofing).
    const reflectionExtras = Object.keys(toolUsage['reflection'] || {}).filter(t => !REFLECTION_READ_TOOLS.includes(t));
    for (const tool of [...REFLECTION_READ_TOOLS, ...reflectionExtras]) steps.push(toolRow('reflection', tool));

    return steps;
}

export { ageText as formatHealthAge };
