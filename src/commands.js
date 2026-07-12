import { getSettings, setPipelineEnabled, addDebugLog } from './settings.js';
import { ensurePopup, Popup, POPUP_TYPE, escapeHtml } from './ui-util.js';
import { getMemorySheetText } from './turn-state.js';

const MACRO_FACT_CAP = 40;        
const MACRO_VALUE_CHARS = 120;    

function ctx() {
    try { return (typeof SillyTavern !== 'undefined') ? SillyTavern.getContext() : null; } catch { return null; }
}

function toast(level, msg, title = 'BF Memory') {
    try { if (typeof toastr !== 'undefined' && toastr[level]) toastr[level](msg, title); } catch {  }
}

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
    } catch {  }
    const msg = `BF Memory: ${s.enabled ? 'ON' : 'OFF'} · ${factCount} fact(s) stored`;
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

async function buildFactList(limit) {
    const cap = Math.max(1, Math.min(MACRO_FACT_CAP * 4, Number(limit) || 20));
    try {
        const { getAllDatabases, isActiveFact, isColdFact } = await import('./database.js');
        const dbs = await getAllDatabases();
        const lines = [];
        for (const [category, db] of Object.entries(dbs)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact) || isColdFact(fact)) continue; 
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

async function actionCatchup(rest) {
    const arg = String(rest || '').trim().toLowerCase();
    try {
        const { runCatchupImport, cancelCatchupImport, isCatchupRunning } = await import('./catchup-import.js');
        if (arg === 'cancel') {
            const wasRunning = cancelCatchupImport();
            const msg = wasRunning
                ? 'Catch-up import cancelling (stops after the current chunk)…'
                : 'No catch-up import is running.';
            toast('info', msg);
            return msg;
        }
        if (isCatchupRunning()) {
            const msg = 'A catch-up import is already running (/bfmem catchup cancel to stop it).';
            toast('warning', msg);
            return msg;
        }
        const batchOverride = /^\d+$/.test(arg) ? parseInt(arg, 10) : undefined;
        toast('info', 'Catch-up import started — progress in the Database tab / toasts.');
        const result = await runCatchupImport({
            batchSize: batchOverride,
            onProgress: ({ chunk, chunks, msgsDone, msgsTotal, factsAdded }) => {

                if (chunk === chunks || chunk % 5 === 0) {
                    toast('info', `Catch-up: chunk ${chunk}/${chunks} · ${msgsDone}/${msgsTotal} msgs · ${factsAdded} facts`);
                }
            },
        });
        if (result.refused) return `catch-up refused: ${result.refused}`;
        const verb = result.cancelled ? 'cancelled' : result.aborted ? 'stopped' : 'done';
        const msg = `catch-up ${verb}: ${result.processedChunks}/${result.chunks} chunks, ${result.msgsDone} msgs, ${result.factsAdded} facts${result.failedChunks ? ` (${result.failedChunks} chunk(s) failed — re-run to retry)` : ''}`;
        toast(result.failedChunks ? 'warning' : 'success', msg);
        return msg;
    } catch (e) {
        addDebugLog('fail', `Slash catchup failed: ${e?.message || e}`);
        return '(catch-up import failed)';
    }
}

async function showMemorySheetPopup() {
    try { await ensurePopup?.(); } catch {  }
    const text = String(getMemorySheetText() || '').trim();
    const body = text
        ? '<pre style="white-space:pre-wrap;margin:0;">' + escapeHtml(text) + '</pre>'
        : '<div class="bf-mem-summary-empty">No memory sheet yet. It is rebuilt in the background after each reply.</div>';
    const html = '<div class="bf-mem-section-header"><i class="fa-solid fa-file-lines"></i> BF Memory Sheet</div>' + body;
    await new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true, okButton: 'Close' }).show();
}

function addSheetWandMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    if (document.getElementById('bf_mem_sheet_menu_item')) return true;
    const item = document.createElement('div');
    item.id = 'bf_mem_sheet_menu_item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-file-lines extensionsMenuExtensionButton"></div><span>BF Memory Sheet</span>';
    item.addEventListener('click', () => { try { document.getElementById('extensionsMenu')?.classList.remove('open'); } catch {  } showMemorySheetPopup(); });
    menu.appendChild(item);
    return true;
}

function initSheetWandMenuItem() {
    let attempts = 0;
    const tryAdd = () => {
        attempts += 1;
        try { if (addSheetWandMenuItem()) return; } catch {  }
        if (attempts < 10) setTimeout(tryAdd, 500);
    };
    tryAdd();
}

function registerMacro(context) {
    try {

        const PLACEHOLDER = '(facts loading…)';
        let cache = PLACEHOLDER;
        let seeded = false;
        const refresh = () => {
            buildFactList(MACRO_FACT_CAP)
                .then(l => { cache = l.join('\n'); seeded = true; })
                .catch(() => { seeded = true; }); 
        };
        refresh();

        const getter = () => { refresh(); return seeded ? cache : PLACEHOLDER; };

        try {
            const m = context.macros;
            const registerFn = typeof m?.register === 'function' ? m.register.bind(m)
                : (typeof m?.registry?.registerMacro === 'function' ? m.registry.registerMacro.bind(m.registry) : null);
            if (registerFn) {
                const def = registerFn('bf_facts', {
                    description: 'The facts BF Memory Pipeline has stored for the current character (compact list).',
                    handler: getter,
                });
                if (def) {
                    addDebugLog('info', '{{bf_facts}} macro registered (macros.register API)');
                    return true;
                }
                addDebugLog('info', 'macros.register returned null, falling back to legacy APIs');
            }
        } catch (e) {
            addDebugLog('info', `macros.register registration failed, falling back: ${e?.message || e}`);
        }
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

async function dispatch(sub, rest) {
    switch (String(sub || '').trim().toLowerCase()) {
        case 'on': return actionToggle('on');
        case 'off': return actionToggle('off');
        case 'toggle': case '': return actionToggle('toggle');
        case 'status': return await actionStatus();
        case 'recall': return await actionRecall(rest);
        case 'facts': return await actionFacts(rest);
        case 'catchup': return await actionCatchup(rest);
        default:
            toast('info', 'Usage: /bfmem on|off|toggle|status|recall <query>|facts [N]|catchup [N|cancel]');
            return '';
    }
}

export function initCommands() {
    const context = ctx();
    if (!context) return;

    registerMacro(context);
    initSheetWandMenuItem();

    try {
        const SCP = context.SlashCommandParser;
        const SC = context.SlashCommand;
        const SCA = context.SlashCommandArgument;
        const ARG = context.ARGUMENT_TYPE || (SCA && SCA.ARGUMENT_TYPE);
        if (SCP && SC && typeof SC.fromProps === 'function' && typeof SCP.addCommandObject === 'function') {
            const unnamedArgs = [];
            if (SCA && typeof SCA.fromProps === 'function') {
                unnamedArgs.push(SCA.fromProps({
                    description: 'subcommand: on | off | toggle | status | recall | facts | catchup',
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
                helpString: 'BF Memory control: <code>/bfmem on|off|toggle|status|recall &lt;query&gt;|facts [N]|catchup [N|cancel]</code>.',
                unnamedArgumentList: unnamedArgs,
                callback: async (_namedArgs, unnamed) => {

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

    try {
        if (typeof context.registerSlashCommand === 'function') {
            context.registerSlashCommand('bfmem', async (_args, value) => {
                const str = String(value || '').trim();
                const sp = str.indexOf(' ');
                const sub = sp >= 0 ? str.slice(0, sp) : str;
                const rest = sp >= 0 ? str.slice(sp + 1).trim() : '';
                return await dispatch(sub, rest);
            }, [], 'BF Memory: /bfmem on|off|toggle|status|recall <query>|facts [N]|catchup [N|cancel]', true, true);
            addDebugLog('info', 'Registered /bfmem slash command (legacy API)', { subsystem: 'settings', event: 'slash.registered', data: { api: 'registerSlashCommand' } });
        }
    } catch (e) {
        addDebugLog('info', `/bfmem slash command unavailable on this ST build: ${e?.message || e}`);
    }
}
