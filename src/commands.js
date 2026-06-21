// BF Memory Pipeline - Slash commands + macro (A8)
// =============================================================================
// Adds a single `/bfmem` slash command (with subcommands) and a `{{bf_facts}}` macro so users can
// act WITHOUT opening the settings panel — mirroring how every comparable extension (Qvink's
// /qm-*, Timeline's {{timeline}}, MemoryBooks' /creatememory) exposes quick actions.
//
// DEFENSIVE BY DESIGN (matches the rest of this codebase): SillyTavern's slash-command and macro
// APIs differ across versions, so EVERY registration is feature-detected and wrapped in try/catch.
// If an API shape is missing the feature simply no-ops — it never throws into extension init.
//
// Subcommands:
//   /bfmem on|off|toggle   — enable/disable the pipeline
//   /bfmem status          — toast a one-line status (enabled? preset? fact count)
//   /bfmem recall <query>  — search long-term memory, return the formatted facts (pipeable)
//   /bfmem facts [N]       — list up to N (default 20) stored facts (pipeable)
//
// Macro:
//   {{bf_facts}}           — a compact newline list of the current character's stored facts
//                            (bounded), usable inside any prompt/preset.
// =============================================================================

import { getSettings, setPipelineEnabled, addDebugLog } from './settings.js';

const MACRO_FACT_CAP = 40;        // bound the {{bf_facts}} macro so a huge store can't blow up a prompt
const MACRO_VALUE_CHARS = 120;    // per-fact value clamp for the macro

/** Resolve the live ST context, null-safe. */
function ctx() {
    try { return (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null; } catch { return null; }
}

/** Best-effort toast. */
function toast(level, msg, title = 'BF Memory') {
    try { if (typeof toastr !== 'undefined' && toastr[level]) toastr[level](msg, title); } catch { /* noop */ }
}

// --- Action implementations (return a STRING for the slash-command pipe) ------

function actionToggle(target) {
    const s = getSettings();
    const cur = !!(s && s.enabled);
    const next = target === 'on' ? true : target === 'off' ? false : !cur;
    setPipelineEnabled(next);
    const msg = `BF Memory ${next ? 'enabled' : 'disabled'}`;
    toast('info', msg);
    return msg;
}

async function actionStatus() {
    const s = getSettings() || {};
    let factCount = 0;
    try {
        const { getAllDatabases } = await import('./database.js');
        const dbs = await getAllDatabases();
        factCount = Object.values(dbs).reduce((n, db) => n + ((db.facts || []).length), 0);
    } catch { /* count is best-effort */ }
    const msg = `BF Memory: ${s.enabled ? 'ON' : 'OFF'} · preset "${s.uiPreset || 'custom'}" · ${factCount} fact(s) stored`;
    toast('info', msg);
    return msg;
}

async function actionRecall(query) {
    const q = String(query || '').trim();
    if (!q) { toast('warning', 'Usage: /bfmem recall <query>'); return ''; }
    try {
        const { searchMemoryForRecall } = await import('./fact-retrieval.js');
        const { text, count } = await searchMemoryForRecall({ query: q });
        addDebugLog('info', `Slash recall "${q.slice(0, 60)}" → ${count} fact(s)`, { subsystem: 'settings', event: 'slash.recall', actor: 'USER', data: { query: q.slice(0, 120), count } });
        return text || '(no matching facts)';
    } catch (e) {
        addDebugLog('fail', `Slash recall failed: ${e?.message || e}`);
        return '(memory search failed)';
    }
}

/** Build a compact, bounded list of the current character's facts. Shared by `/bfmem facts` + macro. */
async function buildFactList(limit) {
    const cap = Math.max(1, Math.min(MACRO_FACT_CAP * 4, Number(limit) || 20));
    try {
        const { getAllDatabases, isActiveFact, isColdFact } = await import('./database.js');
        const dbs = await getAllDatabases();
        const lines = [];
        for (const [category, db] of Object.entries(dbs)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact) || isColdFact(fact)) continue; // active + hot only
                const val = String(fact.value ?? '').trim().slice(0, MACRO_VALUE_CHARS);
                lines.push(`${category}/${fact.key}${val ? ` = ${val}` : ''}`);
                if (lines.length >= cap) break;
            }
            if (lines.length >= cap) break;
        }
        return lines;
    } catch {
        return [];
    }
}

async function actionFacts(n) {
    const lines = await buildFactList(n);
    if (lines.length === 0) { toast('info', 'No stored facts yet.'); return ''; }
    return lines.join('\n');
}

// --- Registration -------------------------------------------------------------

/** Register the `{{bf_facts}}` macro (feature-detected; no-op if the macro API is absent). */
function registerMacro(context) {
    try {
        // Macros must resolve synchronously, but our fact store is async. We keep a small
        // async-refreshed cache and return its last snapshot. KNOWN 1-TURN LAG: the value
        // returned reflects the store as of the PREVIOUS read, not the live store. We seed the
        // cache with a non-empty placeholder so the very first use never returns an empty string
        // (which some prompt templates treat as "macro failed"); once the first refresh resolves,
        // `seeded` flips and subsequent reads return the real (possibly empty) snapshot.
        const PLACEHOLDER = '(facts loading…)';
        let cache = PLACEHOLDER;
        let seeded = false;
        const refresh = () => {
            buildFactList(MACRO_FACT_CAP)
                .then(l => { cache = l.join('\n'); seeded = true; })
                .catch(() => { seeded = true; }); // on error, stop showing the placeholder forever
        };
        refresh();
        // Returns last snapshot (1-turn lag) and refreshes for the next read. While the first
        // refresh is still pending we return the placeholder instead of an empty string.
        const getter = () => { refresh(); return seeded ? cache : PLACEHOLDER; };
        if (typeof context.registerMacro === 'function') {
            context.registerMacro('bf_facts', getter);
            return true;
        }
        if (context.MacrosParser && typeof context.MacrosParser.registerMacro === 'function') {
            context.MacrosParser.registerMacro('bf_facts', getter);
            return true;
        }
    } catch (e) {
        addDebugLog('info', `{{bf_facts}} macro registration skipped: ${e?.message || e}`);
    }
    return false;
}

/** Route a parsed `/bfmem` invocation to the right action. `sub` is the first positional arg. */
async function dispatch(sub, rest) {
    switch (String(sub || '').trim().toLowerCase()) {
        case 'on': return actionToggle('on');
        case 'off': return actionToggle('off');
        case 'toggle': case '': return actionToggle('toggle');
        case 'status': return await actionStatus();
        case 'recall': return await actionRecall(rest);
        case 'facts': return await actionFacts(rest);
        default:
            toast('info', 'Usage: /bfmem on|off|toggle|status|recall <query>|facts [N]');
            return '';
    }
}

/**
 * Register the `/bfmem` slash command. Tries the modern SlashCommandParser API first (so it shows
 * in autocomplete with help), then falls back to the legacy registerSlashCommand. Idempotent-ish:
 * guarded so a double-init doesn't throw. Never throws into the caller.
 */
export function initCommands() {
    const context = ctx();
    if (!context) return;

    registerMacro(context);

    // MODERN API: SlashCommandParser.addCommandObject(SlashCommand.fromProps({...})).
    try {
        const SCP = context.SlashCommandParser;
        const SC = context.SlashCommand;
        const SCA = context.SlashCommandArgument;
        const ARG = context.ARGUMENT_TYPE || (SCA && SCA.ARGUMENT_TYPE);
        if (SCP && SC && typeof SC.fromProps === 'function' && typeof SCP.addCommandObject === 'function') {
            const unnamedArgs = [];
            if (SCA && typeof SCA.fromProps === 'function') {
                unnamedArgs.push(SCA.fromProps({
                    description: 'subcommand: on | off | toggle | status | recall | facts',
                    typeList: ARG ? [ARG.STRING] : undefined,
                    isRequired: false,
                }));
                unnamedArgs.push(SCA.fromProps({
                    description: 'argument (recall query, or fact count)',
                    typeList: ARG ? [ARG.STRING] : undefined,
                    isRequired: false,
                }));
            }
            SCP.addCommandObject(SC.fromProps({
                name: 'bfmem',
                helpString: 'BF Memory control: <code>/bfmem on|off|toggle|status|recall &lt;query&gt;|facts [N]</code>.',
                unnamedArgumentList: unnamedArgs,
                callback: async (_namedArgs, unnamed) => {
                    // unnamed may be a string (single arg) or an array (multiple). Normalize.
                    const parts = Array.isArray(unnamed) ? unnamed : [unnamed];
                    const sub = parts[0] || '';
                    const rest = parts.slice(1).join(' ').trim();
                    return await dispatch(sub, rest);
                },
            }));
            addDebugLog('info', 'Registered /bfmem slash command (modern API)', { subsystem: 'settings', event: 'slash.registered', data: { api: 'SlashCommandParser' } });
            return;
        }
    } catch (e) {
        addDebugLog('info', `Modern slash registration failed, trying legacy: ${e?.message || e}`);
    }

    // LEGACY API: context.registerSlashCommand(name, callback, aliases, help, ...).
    try {
        if (typeof context.registerSlashCommand === 'function') {
            context.registerSlashCommand('bfmem', async (_args, value) => {
                const str = String(value || '').trim();
                const sp = str.indexOf(' ');
                const sub = sp >= 0 ? str.slice(0, sp) : str;
                const rest = sp >= 0 ? str.slice(sp + 1).trim() : '';
                return await dispatch(sub, rest);
            }, [], 'BF Memory: /bfmem on|off|toggle|status|recall <query>|facts [N]', true, true);
            addDebugLog('info', 'Registered /bfmem slash command (legacy API)', { subsystem: 'settings', event: 'slash.registered', data: { api: 'registerSlashCommand' } });
        }
    } catch (e) {
        addDebugLog('info', `/bfmem slash command unavailable on this ST build: ${e?.message || e}`);
    }
}
