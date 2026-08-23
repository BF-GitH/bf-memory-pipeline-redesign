import { explainFactRetrieval } from './fact-retrieval.js';

import {
    ensurePopup, Popup, POPUP_TYPE, escapeHtml, getContext, getCurrentChatId, isBranchChat,
    safeStringify,
} from './ui-util.js';
import {
    addDebugLog, reloadDebugLogFromChat, flushDebugLogNow, flushOutgoingChatLog,
    renderDebugLog, clearDebugLog, getDebugLogEntries,
    exportLogs, exportLogsJSON, copyDiagnostics, downloadTestRunExport,
    // Local binding as well as the re-export below: `export … from` creates no
    // local name, and the debug-tab filter wiring here has to ask whether any
    // trace entries are still on the ring.
    getTraceEntries,
} from './debug-log.js';
import {
    setLastGenerated, setLastInserted, reloadFactsFromChat,
    reloadTokensFromChat, resetSessionTokens, renderTokens,
    reloadReflectionFromChat,
    reloadPyramidFromChat,
    reloadSheetFromChat,
    reloadStorySpineFromChat,
    reloadSceneFromChat,
} from './turn-state.js';
import {
    refreshDatabaseView, showSpiderwebPopup,
} from './db-panel.js';
import {
    DEFAULT_MEMORY_AGENT_PROMPT,
    // The premise-floor setting contract. Nothing in this file re-derives the
    // key name, the bounds or the sentinel: a second copy of "0 means
    // unlimited" is a second place to get it wrong, and the sheet builder is
    // the one that has to be right.
    PREMISE_FLOOR_SETTING_KEY, PREMISE_FLOOR_UNLIMITED, PREMISE_FLOOR_MIN,
    PREMISE_FLOOR_SLIDER_MAX, PREMISE_FLOOR_DEFAULT,
    resolvePremiseFloorCap, estimatePremiseFloorCost,
} from './agent-memory.js';
// Read inside the settings-init function only. agent-lookup.js imports
// addDebugLog/traceCapture back out of this file, so this is a cycle — the same
// one agent-memory.js above already forms, and safe for the same reason: nothing
// here touches the binding while either module is still evaluating.
import { LOOKUP_TIMEOUT_DEFAULT_MS } from './agent-lookup.js';
import { DEFAULT_REFLECT_PROMPT } from './agent-reflect.js';
// recency.js is a LEAF module (no imports), so its constants are safe to read
// in the DEFAULT_SETTINGS literal below — unlike agent-memory.js's, see the
// premiseFloorMax note there.
import { SHEET_BUDGET_DEFAULT, SHEET_BUDGET_SETTING_KEYS, SHEET_BUDGET_CLAMP, resolveSheetBudget } from './recency.js';

export {
    beginRun, endRun,
    addDebugLog,
    // Test-run trace capture. Re-exported here because every agent module
    // already imports addDebugLog from this file — a trace call should not need
    // a second import statement.
    isTraceRecording, traceCapture, newTraceCallId, getTraceEntries,
} from './debug-log.js';
export {
    setLastGenerated, setLastInserted,
    setRunTokens, addAgent3Tokens, addReflectionTokens, setMainOutputTokens,
    getReflection, setReflection,
    getSummaryPyramid, setSummaryPyramid,
    getMemorySheet, setMemorySheet,
    getStorySpine, appendStorySpineBatch, setStorySpine,
    getCurrentScene, getClosedScenes, startScene, appendSceneBeats, setSceneStore,
} from './turn-state.js';

const EXTENSION_NAME = (() => {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/');
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx > 0) return parts[srcIdx - 1];
    } catch {  }
    return 'bf-memory-pipeline';
})();

let extensionSettings = null;

function getConnectionProfiles() {
    try {
        const profiles = getContext().extensionSettings?.connectionManager?.profiles;
        return Array.isArray(profiles) ? profiles : [];
    } catch {
        return [];
    }
}

function getCurrentProfileId() {
    try {
        return getContext().extensionSettings?.connectionManager?.selectedProfile || null;
    } catch {
        return null;
    }
}

const DEFAULT_SETTINGS = {
    enabled: false,

    agent3Profile: '',

    // THE LOOKUP PASS (agent-lookup.js). Default OFF, and it is the only setting
    // in this file that defaults off for a reason other than caution: every other
    // pass runs post-reply and detached, this one runs INSIDE the user's
    // generation and spends real wall-clock time before the storyteller sees the
    // prompt. Opting in is the user's call, not ours.
    lookupEnabled: false,
    // Its own connection profile, independent of agent3Profile. Not a nicety: the
    // background agent may sit on a slow, cheap or self-hosted model where a
    // single call measures in tens of seconds, and this pass has an 8s deadline.
    // Empty falls back to agent3Profile, then to the main ST connection.
    lookupProfile: '',
    // Wall-clock deadline for the lookup pass, in ms. The ONE budget the user
    // sits and waits for, so it is theirs to set: a fast hosted model needs ~2s,
    // a slow proxy or a local model can genuinely need 15-20s, and neither is
    // guessable from here. Clamped to LOOKUP_TIMEOUT_MIN_MS..MAX_MS on load.
    lookupTimeoutMs: 8000,

    memoryPrompt: '',

    memoryAgentPrompt: '',
    reflectionPrompt: '',

    // Per prompt-override key: the fingerprint of the built-in default the user
    // last dismissed the "your custom prompt is out of date" notice against.
    // Storing the fingerprint rather than a boolean means the NEXT time a
    // capability ships the notice comes back on its own.
    dismissedPromptWarnings: {},

    // Per prompt-override key: fingerprints of the built-in defaults THIS
    // installation has actually loaded, newest first. Written by the app from
    // the same expression the agents run, so unlike `legacyFingerprints` it
    // cannot be computed against the wrong string. See
    // syncPromptDefaultWitnesses.
    knownDefaultFingerprints: {},

    // How many stored memories the sheet re-injects every turn no matter what
    // the scene asks for. 1..100, or 0 (PREMISE_FLOOR_UNLIMITED) for all of
    // them. Declared here so the schema-v3 key sweep keeps it and the fill loop
    // in initSettings claims it — but deliberately WITHOUT a value: the default
    // is agent-memory.js's (PREMISE_FLOOR_DEFAULT, moved 15 -> 50 on measured
    // coverage, then 50 -> 30 once the sheet got a char budget per section),
    // and validateSettings resolves `undefined` through the very
    // function the sheet builder uses. A number here would be a second copy of
    // that default, free to drift.
    //
    // Written as a LITERAL key rather than [PREMISE_FLOOR_SETTING_KEY] on
    // purpose: this object literal is evaluated while the module body runs, and
    // agent-memory.js imports this file back (see the note above its import),
    // so reading an imported const here would be a temporal-dead-zone crash the
    // moment anything other than index.js's settings-first order loads the
    // graph. assertPremiseFloorKey() checks the string at runtime instead.
    premiseFloorMax: undefined,

    // SHEET BUDGET — chars per sheet section (see SHEET_BUDGET_DEFAULT in
    // recency.js for the measured reason). Literal keys for the same schema-v3
    // sweep reason as premiseFloorMax; the values come from the one constant
    // composeSheet resolves against, so nothing here can drift from it.
    // No slider yet — the keys are the contract a settings UI can bind to later.
    sheetBudgetFacts: SHEET_BUDGET_DEFAULT.facts,
    sheetBudgetChronology: SHEET_BUDGET_DEFAULT.chronology,
    sheetBudgetScene: SHEET_BUDGET_DEFAULT.scene,
    sheetBudgetStory: SHEET_BUDGET_DEFAULT.story,
    sheetBudgetHead: SHEET_BUDGET_DEFAULT.head,

    agent2ContextMessages: 10,

    bufferHoldBack: 4,

    spineBatchSize: 10,

    enforceKnownBy: true,

    graphExtrasCount: 3,

    contradictionScanEnabled: true,
    // 1 = scan on every Reflect pass. See validateSettings for why this is no
    // longer 2, and migrateContradictionInterval for what happens to profiles
    // that already stored the old default.
    contradictionInterval: 1,

    catchupBatchSize: 8,
    showToast: true,
    debugMode: false,

    debugVerbose: false,

    // "Testlauf aufzeichnen" — record a test run. While on, the agents capture
    // full-text context (system prompts, task blocks, raw replies, tool
    // arguments and tool results) via traceCapture. Those captures go to their
    // own RAM ring in debug-log.js, which no persistence path reads at all — so
    // they never reach the chat file or the character attachment, and they never
    // evict ordinary diagnostics. Off costs nothing: traceCapture returns before
    // its payload thunk is ever called.
    //
    // This flag is PERSISTED, so recording survives a reload and a chat switch
    // even though the captured data does not. The hint text under the checkbox
    // says so, because it is a genuine trap.
    debugTraceRun: false,

    dbProfiles: {},
    activeDbProfile: '',

    unlinkedChats: [],

    taxonomyOverlay: { categories: [], aspects: {}, subAreas: {} },

};

export function getSettings() {
    return extensionSettings;
}

export function setPipelineEnabled(next) {
    next = !!next;
    if (!extensionSettings) return next;
    if (next !== extensionSettings.enabled) {
        addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} via slash command`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled', via: 'slash' }, before: !!extensionSettings.enabled, after: next });
    }
    extensionSettings.enabled = next;
    saveSettings();
    try { $('#bf_mem_enabled').prop('checked', next); } catch {  }
    try { updateStatus('idle'); } catch {  }
    if (!next) {
        import('./pipeline.js').then(({ cancelActiveRun }) => cancelActiveRun?.('disabled')).catch(() => {});
    }
    return next;
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[EXTENSION_NAME] = extensionSettings;
    context.saveSettingsDebounced();
}

function clamp(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

// The one thing the literal `premiseFloorMax:` key in DEFAULT_SETTINGS cannot
// check for itself. If agent-memory.js ever renames the setting, the literal
// would silently become a dead key: the fill loop would seed a name nothing
// reads, the schema-v3 sweep would delete the real one as obsolete, and the
// slider would look like it does nothing. Runtime, so no TDZ.
let premiseFloorKeyChecked = false;
function assertPremiseFloorKey() {
    if (premiseFloorKeyChecked) return;
    premiseFloorKeyChecked = true;
    if (Object.hasOwn(DEFAULT_SETTINGS, PREMISE_FLOOR_SETTING_KEY)) return;
    addDebugLog('fail', `Premise-floor setting key is "${PREMISE_FLOOR_SETTING_KEY}" but DEFAULT_SETTINGS declares ${Object.keys(DEFAULT_SETTINGS).filter(k => /premiseFloor/i.test(k)).join(', ') || 'no matching key'} — the slider writes a key nothing reads`, {
        subsystem: 'settings', event: 'settings.changed', actor: 'SYSTEM',
        reason: 'PREMISE_FLOOR_KEY_MISMATCH', data: { key: PREMISE_FLOOR_SETTING_KEY },
    });
}

function validateSettings(s) {
    s.agent2ContextMessages = Math.floor(clamp(s.agent2ContextMessages, 0, 50, 10));
    s.bufferHoldBack = Math.floor(clamp(s.bufferHoldBack, 0, 10, 4));

    if (s.agent2ContextMessages !== 0 && s.bufferHoldBack >= s.agent2ContextMessages) {
        const clamped = Math.max(0, s.agent2ContextMessages - 1);
        addDebugLog('fail', 'bufferHoldBack (' + s.bufferHoldBack + ') >= agent2ContextMessages (' + s.agent2ContextMessages + '); clamped to ' + clamped + ' to prevent a memory gap');
        s.bufferHoldBack = clamped;
    }
    s.spineBatchSize = Math.floor(clamp(s.spineBatchSize, 4, 30, 10));
    s.graphExtrasCount = Math.floor(clamp(s.graphExtrasCount, 0, 8, 3));

    // PREMISE FLOOR. Not clamped with the helper above, because the sentinel
    // makes 0 legal while 0.5 and 250 are not — the one expression allowed to
    // decide that is agent-memory.js's, since it is the expression the sheet
    // builder itself resolves the setting with. Normalizing through it here
    // means the number in the slider and the number the sheet is built to
    // cannot disagree, and an out-of-range hand edit is CLAMPED, not discarded:
    // a settings file saying 250 that quietly produced a 50-row sheet would be
    // unexplainable from the UI.
    assertPremiseFloorKey();
    const floorSetting = resolvePremiseFloorCap(s);
    const floorValue = floorSetting.unlimited ? PREMISE_FLOOR_UNLIMITED : floorSetting.cap;
    if (floorSetting.source === 'clamped') {
        addDebugLog('fail', `Premise floor ${safeStringify(floorSetting.raw)} is outside ${PREMISE_FLOOR_MIN}..${PREMISE_FLOOR_SLIDER_MAX} (0 = unlimited); clamped to ${floorValue}`, {
            subsystem: 'settings', event: 'settings.migrated', actor: 'SYSTEM',
            reason: 'PREMISE_FLOOR_CLAMPED', data: { key: PREMISE_FLOOR_SETTING_KEY },
            before: floorSetting.raw, after: floorValue,
        });
    }
    s[PREMISE_FLOOR_SETTING_KEY] = floorValue;

    // SHEET BUDGET. Resolved through the same function composeSheet uses, so
    // the stored number and the number the sheet is built to cannot disagree;
    // out-of-range hand edits are clamped and logged, not discarded.
    const budget = resolveSheetBudget(s);
    for (const c of budget.clamped) {
        addDebugLog('fail', `Sheet budget ${c.key} ${safeStringify(c.raw)} is outside ${SHEET_BUDGET_CLAMP[c.section][0]}..${SHEET_BUDGET_CLAMP[c.section][1]} chars; clamped to ${c.value}`, {
            subsystem: 'settings', event: 'settings.migrated', actor: 'SYSTEM',
            reason: 'SHEET_BUDGET_CLAMPED', data: { key: c.key },
            before: c.raw, after: c.value,
        });
    }
    for (const [section, key] of Object.entries(SHEET_BUDGET_SETTING_KEYS)) s[key] = budget[section];

    // Read by agent-reflect.js as `Math.max(1, Number(...) || CONTRADICTION_INTERVAL_DEFAULT)`.
    // The fallback below is 1 and that module's constant is still 2 — they no
    // longer match, and that is survivable rather than a lie only because the
    // two are reached on different paths: this line runs on every load and
    // always leaves a number in the key, so agent-reflect.js's own constant is
    // only ever consulted for a settings object that never passed through here.
    // Why 1: Reflect runs rarely to begin with, so an interval of 2 gave a
    // measured 78-message chat exactly ONE contradiction scan in the whole run.
    // (agent-reflect.js is not this agent's file to edit; its constant should
    // follow.)
    s.contradictionInterval = Math.floor(clamp(s.contradictionInterval, 1, 10, 1));
    s.catchupBatchSize = Math.floor(clamp(s.catchupBatchSize, 2, 30, 8));
    if (typeof s.enabled !== 'boolean') {

        if (s.enabled) {
            addDebugLog('fail', 'enabled coerced to false (was non-boolean: ' + JSON.stringify(s.enabled) + ')');
        }
        s.enabled = false;
    }
    if (typeof s.showToast !== 'boolean')        s.showToast = true;
    if (typeof s.debugMode !== 'boolean')        s.debugMode = false;
    if (typeof s.debugVerbose !== 'boolean')     s.debugVerbose = false;
    if (typeof s.debugTraceRun !== 'boolean')    s.debugTraceRun = false;
    if (typeof s.agent3Profile !== 'string')     s.agent3Profile = '';
    if (typeof s.lookupEnabled !== 'boolean')    s.lookupEnabled = false;
    if (typeof s.lookupProfile !== 'string')     s.lookupProfile = '';
    // Same bounds agent-lookup.js clamps to at read time. Doing it here as well
    // means a hand-edited settings file shows the corrected value in the slider
    // rather than a number the pass silently ignores.
    s.lookupTimeoutMs = Math.floor(clamp(s.lookupTimeoutMs, 3000, 45000, 8000));
    if (typeof s.enforceKnownBy !== 'boolean') s.enforceKnownBy = true;
    if (typeof s.contradictionScanEnabled !== 'boolean') s.contradictionScanEnabled = true;
    if (typeof s.memoryPrompt !== 'string')      s.memoryPrompt = '';
    if (typeof s.memoryAgentPrompt !== 'string') s.memoryAgentPrompt = '';
    if (typeof s.reflectionPrompt !== 'string')  s.reflectionPrompt = '';
    // agent-reflect.js reads `settings.reflectionPrompt || DEFAULT_REFLECT_PROMPT`,
    // so a whitespace-only override is TRUTHY and would ship as the entire system
    // prompt. Today's input handler stores '' for blank; this catches whatever an
    // older build persisted.
    if (!s.memoryAgentPrompt.trim()) s.memoryAgentPrompt = '';
    if (!s.reflectionPrompt.trim())  s.reflectionPrompt = '';
    if (!s.dismissedPromptWarnings || typeof s.dismissedPromptWarnings !== 'object' || Array.isArray(s.dismissedPromptWarnings)) {
        s.dismissedPromptWarnings = {};
    }
    normalizePromptDefaultWitnesses(s);
    if (typeof s.activeDbProfile !== 'string')   s.activeDbProfile = '';
    if (!s.dbProfiles || typeof s.dbProfiles !== 'object' || Array.isArray(s.dbProfiles)) {
        s.dbProfiles = {};
    }

    if (!Array.isArray(s.unlinkedChats)) {
        s.unlinkedChats = [];
    } else {
        s.unlinkedChats = s.unlinkedChats.filter(id => typeof id === 'string' && id);
    }

    if (!s.taxonomyOverlay || typeof s.taxonomyOverlay !== 'object' || Array.isArray(s.taxonomyOverlay)) {
        s.taxonomyOverlay = { categories: [], aspects: {}, subAreas: {} };
    } else {
        const ov = s.taxonomyOverlay;
        if (!Array.isArray(ov.categories)) ov.categories = [];
        if (!ov.aspects || typeof ov.aspects !== 'object' || Array.isArray(ov.aspects)) ov.aspects = {};
        if (!ov.subAreas || typeof ov.subAreas !== 'object' || Array.isArray(ov.subAreas)) ov.subAreas = {};
    }
    return s;
}

// ---------------------------------------------------------------------------
// Stale prompt-override handling.
//
// memoryAgentPrompt / reflectionPrompt store a FULL COPY of an agent's system
// prompt, and both agents PREFER the stored copy over the built-in default
// (agent-memory.js, agent-reflect.js). A copy taken before a capability shipped
// therefore silently disables that capability: the model is never told the tool
// or the output section exists, so it never emits one, and nothing errors —
// which is the worst possible failure shape. Two cases, handled differently:
//
//   1. The copy is byte-identical to a default WE used to ship. The user opened
//      the box and never really customised it (older save paths persisted the
//      default verbatim; today's `input` handler stores '' on an exact match).
//      Silently adopt the new default — there is nothing of theirs to lose.
//   2. The copy genuinely differs. Never touch it. The System Prompts tab shows
//      a per-capability notice with a one-click reset instead.
//
// Recognition is by fingerprint, not by shipping ~90 KB of dead prompt text.
// The length half makes a collision across this fixed list implausible.
//
// Recognition has TWO sources, deliberately:
//   - `legacyFingerprints`, hand-maintained, the only way to know about builds
//     that predate this mechanism. It is written by a human and can be wrong.
//   - `knownDefaultFingerprints`, written by the app itself every time it
//     loads, from `spec.getDefault()` — the same expression the agents send.
//     A stored copy of build N's default can only exist if build N ran here, so
//     build N recorded it. This half cannot be computed against the wrong
//     string, which is precisely how the hand-maintained half went wrong: both
//     defaults are COMPOSED (`` `…` + TEMPORAL_GROUNDING_RULE ``), and every
//     memory-agent entry in the list was a hash of the bare template literal —
//     a string no textarea has ever shown and no user has ever stored.
// ---------------------------------------------------------------------------
function promptFingerprint(text) {
    const s = String(text || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        // FNV-1a's 32-bit prime (16777619) as shifts — keeps every step in int32
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return s.length + ':' + h.toString(16).padStart(8, '0');
}

// Bumped whenever a stored setting needs a one-off sweep. v4 introduced the
// prompt-override sweep; v5 exists ONLY because both default prompts changed
// again — `migratePromptOverrides` can adopt a stored copy only if the build
// running it recognises that copy's fingerprint, so a build that ships new
// defaults must re-run the sweep or every v4 user who kept an unmodified copy
// is misreported as having customised it. v6 for the same reason: the sweep's
// recognition set changed (every memoryAgentPrompt fingerprint was corrected,
// and `knownDefaultFingerprints` was added), so it has to run again.
//
// v7 is the first bump that is NOT about prompts: the contradiction-scan
// interval default dropped 2 -> 1, and a default change alone would never reach
// anybody, because every profile that has ever loaded has the old default
// written into it as a concrete number (validateSettings leaves no key empty).
// It re-runs the prompt sweep as a side effect, which is harmless — that sweep
// only drops an override byte-identical to a default we shipped.
//
// v8: both default prompts changed again (the transcript-continuation guard
// sentence, and reflection's rewritten promise about ride-along merge_facts /
// mark_cold lines), so the sweep must recognise the outgoing 0.83.0 copies.
const SETTINGS_SCHEMA_VERSION = 8;

// WHEN YOU CHANGE EITHER DEFAULT PROMPT, three edits, no more:
//   1. prepend the OUTGOING default's fingerprint to `legacyFingerprints`
//      (newest first — the list is only ever searched, the order is for humans).
//      TAKE THE VALUE FROM THE RUNNING APP: the previous build logged it as
//      `NEW_BUILTIN_DEFAULT` (debug log, subsystem `settings`), or evaluate
//      `promptFingerprint(PROMPT_OVERRIDES.<key>.getDefault())` in a console.
//      NEVER hash the prompt source by hand — both defaults are COMPOSED
//      expressions (`` `…` + TEMPORAL_GROUNDING_RULE ``), the textarea shows and
//      stores the COMPOSED string, and hashing the template literal alone
//      produces a fingerprint nothing can ever match. That is exactly how all
//      ten memoryAgentPrompt entries were wrong for two rounds.
//   2. add a `capabilities` entry naming a short verbatim string that ONLY the
//      new prompt contains — verify against every historical version, not just
//      the one you replaced, or a stale copy silently reads as up to date;
//   3. bump SETTINGS_SCHEMA_VERSION so the sweep runs again.
// Everything else — migration, notice, reset, dismissal expiry — follows.
//
// Steps 1 and 3 are now survivable when you get them wrong, which is the point:
// `syncPromptDefaultWitnesses` records each default's real fingerprint on load,
// so a user who ran the outgoing build is migrated even if the list entry is
// wrong or missing, and a forgotten version bump is detected and swept anyway.
// The list still matters for builds older than that mechanism.
const PROMPT_OVERRIDES = {
    memoryAgentPrompt: {
        label: 'Memory Agent prompt',
        textareaId: 'bf_mem_memory_agent_prompt',
        noticeId: 'bf_mem_memory_agent_prompt_stale',
        getDefault: () => DEFAULT_MEMORY_AGENT_PROMPT,
        // Fingerprints of the COMPOSED default (template + TEMPORAL_GROUNDING_RULE),
        // i.e. of the exact string the textarea has always been populated with and
        // therefore the exact string an override stores. Recomputed from
        // `git show <sha>:src/agent-memory.js` for every commit that touched the
        // file; the previous list hashed the bare template literal and so could
        // never match anything. Newest first:
        //   6146:6134fcc3  the round-1 default (never committed; recovered by
        //                  rolling the old list's bare hash forward over the
        //                  238-char TEMPORAL_GROUNDING_RULE, which FNV-1a permits
        //                  because the fingerprint IS the rolling state — verified
        //                  exact against all 21 committed versions)
        //   5497:ba738ab6  9af88bd   10321:1f57dd75 400f91c   11798:01a9b06a 4c32f3a
        //   10915:1df4f2c5 6414917   9309:cba0dc1a  85d4287   8685:d2d7dbc1  bb65b09
        //   8753:6529783e  4692330   7019:2f4058a7  97400e3   6251:de16a77b  ecb9257
        // No round-2 entry: round 2's default IS this build's default
        // (6747:19ca94c1), so a stored copy of it is caught by `isCurrent`.
        // The moment this prompt changes, prepend that value — the previous
        // build's NEW_BUILTIN_DEFAULT log line hands it to you.
        //   8217:0ca67433  the 0.83.0 default (447c397), taken from that build's
        //                  NEW_BUILTIN_DEFAULT log line on the long-run export
        legacyFingerprints: [
            '8217:0ca67433',
            '6146:6134fcc3', '5497:ba738ab6', '10321:1f57dd75', '11798:01a9b06a',
            '10915:1df4f2c5', '9309:cba0dc1a', '8685:d2d7dbc1', '8753:6529783e',
            '7019:2f4058a7', '6251:de16a77b',
        ],
        capabilities: [
            {
                marker: 'OMISSION RECOVERY',
                name: 'Omission recovery (the backward look)',
                detail: 'the agent is handed the list of memories the LAST sheet actually carried, but without this instruction it never reads it — so a fact the storyteller hedged on or forgot never gets re-selected, and the loop repeats forever.',
            },
            {
                marker: '## Store candidates',
                name: 'Stored-fact candidates (VALUES, not just key names)',
                detail: 'the prompt now carries the VALUES of stored facts about whoever the checked reply names but the sheet did not carry — that block is the only place the actual wording ("always wants to go to Portugal") appears. An older copy never mentions it, so the agent goes on guessing from key names alone and misses the fumble it was supposed to catch.',
            },
            {
                marker: 'RECOVERED:',
                name: 'Sticky recovered refs (the RECOVERED line)',
                detail: 'a recovery is now marked on its own RECOVERED line and stays injected for several turns instead of one. Without the line the agent never marks anything, nothing goes sticky, and the memory drops back out on the very next turn — the same fumble can recur immediately.',
            },
            {
                marker: 'never write TOOL RESULTS or a user turn yourself',
                name: 'Transcript-continuation guard',
                detail: 'text-completion style backends let the model keep writing the conversation after its own reply — a fake TOOL RESULTS message with invented results. The loop now cuts such a reply at that point, and the prompt tells the model to stop after its tool-call lines; an older copy never says so, and every such reply costs a grace round or the whole extraction.',
            },
        ],
    },
    reflectionPrompt: {
        label: 'Reflect Agent prompt',
        textareaId: 'bf_mem_reflect_agent_prompt',
        noticeId: 'bf_mem_reflect_agent_prompt_stale',
        getDefault: () => DEFAULT_REFLECT_PROMPT,
        // Re-verified against git history the same way. DEFAULT_REFLECT_PROMPT is
        // a single template literal — nothing appended — so these were right and
        // stay unchanged: 3200:aca717b7 9af88bd, 8182:a3b476f2 4c32f3a,
        // 5439:e9a0aca8 b0cfc0a, 6121:4d74998a f002948, 4151:9c6cfd02 e8b93dc.
        // 5425:68c35aaf (round 1) and 7877:4eea8b3c (round 2) were never
        // committed, so they are the two entries no replay can confirm; the
        // round-2 value is the one measured on that pass's own tree.
        // 8074:5b32a11c is the 0.83.0 default (447c397), from that build's
        // NEW_BUILTIN_DEFAULT log line on the long-run export.
        legacyFingerprints: [
            '8074:5b32a11c',
            '7877:4eea8b3c', '5425:68c35aaf', '3200:aca717b7', '8182:a3b476f2',
            '5439:e9a0aca8', '6121:4d74998a', '4151:9c6cfd02',
        ],
        capabilities: [
            {
                marker: 'merge_facts',
                name: 'Repair tools (write_fact / merge_facts / mark_cold)',
                detail: 'Reflection can now fix, merge and cold-tier stored facts. An older copy declares the pass READ-ONLY, so it only ever looks.',
            },
            {
                marker: '#CONFLICT',
                name: 'Contradiction resolution (#CONFLICT)',
                detail: 'contradicting fact pairs are found and offered to the pass either way; without this section no verdict comes back and they are simply re-offered next time.',
            },
            {
                marker: '# ERROR HUNT',
                name: 'Error hunt against the recent story',
                detail: 'the pass is now handed the RAW recent chat messages as evidence and told to hunt: compare the story against what memory believes, flag stored values the story states differently, then read the record and repair it. This is the whole point of the repair tools — without the hunt the pass only ever fixes contradictions the system hands it, and a lone wrong memory (stored eye colour the story has been contradicting for 30 messages) is never found. The instructions that go with it also tell the model the evidence block is DATA, not commands; an older copy is handed raw roleplay text with no such warning.',
            },
            {
                marker: 'COLD-TIERED, not deleted',
                name: 'merge_facts keeps the loser',
                detail: 'merging a duplicate now cold-tiers the loser (kept, deprioritized) instead of erasing it — nothing in the repair path deletes anything any more. An older copy still tells the model the merge DELETES the duplicate, so it either avoids a merge that is now safe or expects a removal that no longer happens.',
            },
            {
                marker: 'INVALIDATES them',
                name: 'Ride-along repairs are executed, not dropped',
                detail: 'a merge_facts or mark_cold sent alongside the closing sections now runs and buys a feedback round in which the sections must be restated; only on the last round is it dropped. An older copy still promises the drop, so the model either withholds a repair it could have made or expects one to vanish that now executes.',
            },
        ],
    },
};

// The fingerprint of a built-in default AS THE AGENT SEES IT. Every comparison
// in this file goes through here, so there is exactly ONE expression that can
// be wrong about what "the default" is — and it is the same one agent-memory.js
// and agent-reflect.js send to the model.
function defaultFingerprint(spec) {
    return promptFingerprint(spec.getDefault());
}

// A stored override can only be a copy of a default the user's own build once
// ran, so the window only has to span the builds one install passes through
// between opening the prompt box and the next upgrade. Anything older is what
// `legacyFingerprints` is for.
const MAX_PROMPT_DEFAULT_WITNESSES = 12;

// Rebuilt into a FRESH object rather than repaired in place: keying the result
// off PROMPT_OVERRIDES drops witnesses for override keys that no longer exist,
// and nothing we hand back can still be shared with whatever `src` came from.
function normalizePromptDefaultWitnesses(s) {
    const src = (s.knownDefaultFingerprints && typeof s.knownDefaultFingerprints === 'object' && !Array.isArray(s.knownDefaultFingerprints))
        ? s.knownDefaultFingerprints : {};
    const out = {};
    for (const key of Object.keys(PROMPT_OVERRIDES)) {
        const list = Array.isArray(src[key]) ? src[key] : [];
        out[key] = [...new Set(list.filter(v => typeof v === 'string' && /^\d+:[0-9a-f]{8}$/.test(v)))]
            .slice(0, MAX_PROMPT_DEFAULT_WITNESSES);
    }
    s.knownDefaultFingerprints = out;
    return out;
}

// The self-announcing half of stale-override recognition. Runs on EVERY load,
// before the schema-version gate, and does three things:
//   - records this build's default fingerprint so a FUTURE build can recognise
//     a copy of it without anyone hand-maintaining a list correctly;
//   - prints that fingerprint, so the next person to change the prompt copies a
//     value the runtime computed instead of hashing the source text;
//   - returns the keys whose default is new here, which is the signal that a
//     new default shipped — used below to run the sweep even if the schema
//     version bump was forgotten.
// Also flags the one shape of hand-list error that IS locally checkable: the
// current default appearing in its own legacy list.
function syncPromptDefaultWitnesses(s) {
    const witnesses = normalizePromptDefaultWitnesses(s);
    const fresh = [];
    for (const [key, spec] of Object.entries(PROMPT_OVERRIDES)) {
        const fp = defaultFingerprint(spec);
        if (spec.legacyFingerprints.includes(fp)) {
            addDebugLog('fail', `${spec.label}: the CURRENT built-in default (${fp}) is listed in its own legacyFingerprints — the list was built against the wrong string, or the prompt was never actually changed`, {
                subsystem: 'settings', event: 'settings.migrated', actor: 'SYSTEM',
                reason: 'LEGACY_LIST_CONTAINS_CURRENT', data: { key, fingerprint: fp },
            });
        }
        if (witnesses[key].includes(fp)) continue;
        witnesses[key] = [fp, ...witnesses[key]].slice(0, MAX_PROMPT_DEFAULT_WITNESSES);
        fresh.push(key);
        addDebugLog('info', `${spec.label}: built-in default is new to this install, fingerprint ${fp} — when this prompt next changes, THIS is the value to prepend to legacyFingerprints (never re-derive it from the source text)`, {
            subsystem: 'settings', event: 'settings.migrated', actor: 'SYSTEM',
            reason: 'NEW_BUILTIN_DEFAULT',
            data: { key, fingerprint: fp, chars: spec.getDefault().length },
        });
    }
    return fresh;
}

// Which shipped capabilities a stored override cannot possibly use. Empty for a
// user who hand-merged the new instructions in — marker presence is the test,
// so nobody gets nagged about work they already did.
function missingPromptCapabilities(key) {
    const spec = PROMPT_OVERRIDES[key];
    const stored = String(extensionSettings?.[key] || '');
    if (!spec || !stored.trim()) return [];
    return spec.capabilities.filter(c => !stored.includes(c.marker));
}

// Case 1 above. Runs once per schema bump — it is idempotent (a cleared
// override is skipped by the `!stored.trim()` guard), and it MUST re-run every
// time a default prompt changes, because it can only recognise the defaults
// this build knows about.
function migratePromptOverrides(s) {
    const witnesses = normalizePromptDefaultWitnesses(s);
    for (const [key, spec] of Object.entries(PROMPT_OVERRIDES)) {
        const stored = typeof s[key] === 'string' ? s[key] : '';
        if (!stored.trim()) continue;
        const fp = promptFingerprint(stored);
        const isCurrent = fp === defaultFingerprint(spec);
        // A default this install is on record as having RUN outranks the
        // hand-maintained list: it was measured, not typed.
        const witnessed = !isCurrent && witnesses[key].includes(fp);
        if (!isCurrent && !witnessed && !spec.legacyFingerprints.includes(fp)) continue;
        s[key] = '';
        addDebugLog('info', `${spec.label}: stored override was an unmodified ${isCurrent ? 'copy of the current' : 'older built-in'} default — dropped so the built-in prompt is used again`, {
            subsystem: 'settings', event: 'settings.migrated', actor: 'SYSTEM',
            reason: isCurrent ? 'REDUNDANT_COPY' : (witnessed ? 'STALE_DEFAULT_WITNESSED' : 'STALE_DEFAULT'),
            data: { key, fingerprint: fp },
        });
    }
}

// Shared by the section's "Reset to default" button and the stale notice's.
function resetPromptToDefault(key, reason) {
    const spec = PROMPT_OVERRIDES[key];
    if (!spec) return;
    extensionSettings[key] = '';
    $('#' + spec.textareaId).val(spec.getDefault());
    // A dismissal only ever suppressed a warning about the text we just threw
    // away, so it must not outlive it.
    if (extensionSettings.dismissedPromptWarnings) delete extensionSettings.dismissedPromptWarnings[key];
    addDebugLog('info', `${spec.label} reset to default`, {
        subsystem: 'settings', event: 'settings.changed', actor: 'USER', reason,
        data: { key, isDefault: true },
    });
    saveSettings();
    renderPromptStaleNotices();
    toastr.info(`${spec.label} reset to default`, 'BF Memory');
}

// Case 2 of the migration: the override is genuinely the user's, so say what it
// costs them and let them choose. Re-run after every edit/reset/dismiss.
function renderPromptStaleNotices() {
    for (const [key, spec] of Object.entries(PROMPT_OVERRIDES)) {
        const el = document.getElementById(spec.noticeId);
        if (!el) continue;

        const missing = missingPromptCapabilities(key);
        // Dismissal is keyed to the default it was dismissed AGAINST, so the
        // next capability to ship raises the notice again without any bookkeeping.
        const dismissed = extensionSettings?.dismissedPromptWarnings?.[key] === defaultFingerprint(spec);

        // This runs on every keystroke in the textarea; only touch the DOM when
        // the verdict actually changed, or the buttons get rebuilt per character.
        const sig = (!missing.length || dismissed) ? '' : missing.map(c => c.marker).join('|');
        if (el.dataset.staleSig === sig) continue;
        el.dataset.staleSig = sig;

        if (!sig) {
            el.style.display = 'none';
            el.innerHTML = '';
            continue;
        }

        el.style.display = 'block';
        el.innerHTML = `
            <b>Your custom ${escapeHtml(spec.label.toLowerCase())} predates this build.</b>
            It is missing ${missing.length === 1 ? 'an instruction' : 'instructions'} the current default carries, so ${missing.length === 1 ? 'this capability does' : 'these capabilities do'} nothing while it is active:
            <ul style="margin:6px 0 6px 16px;padding:0;">
                ${missing.map(c => `<li><b>${escapeHtml(c.name)}</b> — ${escapeHtml(c.detail)}</li>`).join('')}
            </ul>
            Your text has not been changed. Paste the missing parts in yourself (Reset, copy, re-apply your edits), or:
            <div class="bf-mem-db-actions" style="margin-top:6px;">
                <button id="${spec.noticeId}_reset" class="menu_button"><i class="fa-solid fa-undo"></i> Reset to new default</button>
                <button id="${spec.noticeId}_dismiss" class="menu_button" title="Hide this until the built-in prompt changes again">Dismiss</button>
            </div>`;

        $(`#${spec.noticeId}_reset`).on('click', () => resetPromptToDefault(key, 'STALE_PROMPT_NOTICE'));
        $(`#${spec.noticeId}_dismiss`).on('click', () => {
            if (!extensionSettings.dismissedPromptWarnings) extensionSettings.dismissedPromptWarnings = {};
            extensionSettings.dismissedPromptWarnings[key] = defaultFingerprint(spec);
            addDebugLog('info', `${spec.label}: out-of-date warning dismissed (custom prompt kept, missing: ${missing.map(c => c.marker).join(', ')})`, {
                subsystem: 'settings', event: 'settings.changed', actor: 'USER', reason: 'STALE_PROMPT_DISMISSED',
                data: { key, missing: missing.map(c => c.marker) },
            });
            saveSettings();
            renderPromptStaleNotices();
        });
    }
}

// v7. The old default of 2 is rewritten to 1, ONCE. Only the exact value 2 is
// touched: a user who typed 3 or 7 chose it, and this must not read as the app
// overruling them. Someone who deliberately set 2 loses that — unavoidable, the
// stored number carries no record of who wrote it — which is why the sweep runs
// once and says so in the log instead of enforcing 1 on every load.
function migrateContradictionInterval(s) {
    if (Number(s.contradictionInterval) !== 2) return;
    s.contradictionInterval = 1;
    addDebugLog('info', 'Contradiction scan interval 2 → 1 (the old default): at 2, Reflect runs so rarely that a measured 78-message chat got a single scan in the whole run. Set it back in the Memory tab if you meant 2.', {
        subsystem: 'settings', event: 'settings.migrated', actor: 'SYSTEM',
        reason: 'CONTRADICTION_INTERVAL_DEFAULT_CHANGED',
        data: { key: 'contradictionInterval' }, before: 2, after: 1,
    });
}

function migrateLegacySettings(s) {

    // Before the version gate, always: this is what lets a stale-override sweep
    // arm itself. `fresh` is non-empty exactly when a built-in default changed
    // since this profile last loaded.
    const fresh = syncPromptDefaultWitnesses(s);

    // Below the gate, above every early return: the v7 sweep has to reach both
    // the ">= 3" shortcut and the full v3 body, and running it before either
    // keeps that from being two call sites that can fall out of step.
    if ((s.schemaVersion ?? 0) < 7) migrateContradictionInterval(s);

    if ((s.schemaVersion ?? 0) >= SETTINGS_SCHEMA_VERSION) {
        // The schema says the sweep is done, yet a default just changed — i.e.
        // step 3 of the recipe above was skipped. Sweep anyway and say so,
        // rather than leaving the user on a prompt we no longer ship.
        if (fresh.length > 0) {
            addDebugLog('fail', `Built-in prompt default changed without a SETTINGS_SCHEMA_VERSION bump (${fresh.join(', ')}) — running the stale-override sweep anyway`, {
                subsystem: 'settings', event: 'settings.migrated', actor: 'SYSTEM',
                reason: 'MISSING_SCHEMA_BUMP',
                data: { keys: fresh, schemaVersion: s.schemaVersion ?? 0 },
            });
            migratePromptOverrides(s);
        }
        return;
    }

    // v4, v5 and v6 consist of nothing but the prompt-override sweep (v5/v6
    // because the defaults and then the recognition set changed again, see
    // SETTINGS_SCHEMA_VERSION); everything below this branch is the v3 body and
    // must not run twice for someone who already reached v3.
    if ((s.schemaVersion ?? 0) >= 3) {
        migratePromptOverrides(s);
        s.schemaVersion = SETTINGS_SCHEMA_VERSION;
        return;
    }

    const context = getContext();
    const legacy = context.extensionSettings?.bf_memory;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        if (typeof legacy.customExtractorPrompt === 'string' && !s.memoryPrompt) {
            s.memoryPrompt = legacy.customExtractorPrompt;
        }
        if (typeof legacy.extractorProfileId === 'string' && legacy.extractorProfileId && !s.agent3Profile && !s.memoryProfile) {
            s.agent3Profile = legacy.extractorProfileId;
        }
        console.log('[BFMemory] Migrated legacy bf_memory settings (old key preserved for rollback)');
    }

    if (typeof s.memoryProfile === 'string' && s.memoryProfile && !s.agent3Profile) {
        s.agent3Profile = s.memoryProfile;
    }

    let dropped = 0;
    for (const key of Object.keys(s)) {
        if (key === 'schemaVersion') continue;
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
            delete s[key];
            dropped++;
        }
    }
    if (dropped > 0) {
        console.log(`[BFMemory] Settings migration dropped ${dropped} obsolete key(s) (schema v3)`);
    }

    migratePromptOverrides(s);

    s.schemaVersion = SETTINGS_SCHEMA_VERSION;
}

export function updateStatus(status, message = '') {
    const dot = document.getElementById('bf_mem_status_dot');
    const text = document.getElementById('bf_mem_status_text');

    if (dot) {
        dot.className = 'bf-mem-status-dot';
        if (status === 'running') dot.classList.add('running');
        else if (status === 'error') dot.classList.add('error');
        else if (extensionSettings?.enabled) dot.classList.add('active');
    }

    if (text && message) {
        text.textContent = message;
    } else if (text) {
        text.textContent = extensionSettings?.enabled ? 'Active' : 'Disabled';
    }
}

// Fills ONE profile <select>. Factored out of reloadProfiles when the lookup
// pass got its own profile: the two selects differ only in their element id, in
// which stored setting they fall back to, and in what an empty option MEANS —
// the memory agent falls back to the main ST connection, the lookup pass falls
// back to the memory agent's profile first (agent-lookup's caller does that
// resolution), so labelling both "-- Use default profile --" would be wrong.
function fillProfileSelect(elementId, settingKey, emptyLabel) {
    const select = document.getElementById(elementId);
    if (!select) return;

    const profiles = getConnectionProfiles();
    const activeProfile = getCurrentProfileId();

    const currentValue = select.value;
    select.innerHTML = `<option value="">${emptyLabel}</option>`;
    profiles.forEach(profile => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name + (profile.id === activeProfile ? ' (current)' : '');
        select.appendChild(option);
    });
    if (currentValue && profiles.find(p => p.id === currentValue)) {
        select.value = currentValue;
    } else if (extensionSettings?.[settingKey]) {
        select.value = extensionSettings[settingKey];
    }
}

function reloadProfiles() {
    fillProfileSelect('bf_mem_agent3_profile', 'agent3Profile', '-- Use default profile --');
    fillProfileSelect('bf_mem_lookup_profile', 'lookupProfile', '-- Same as the Memory Agent --');
}

// Health tab: pull-based self-test. Dynamic import keeps health.js out of this
// module's static graph (health.js imports settings.js for live getters).
async function renderHealthTab() {
    const list = document.getElementById('bf_mem_health_list');
    if (!list) return;
    list.innerHTML = '<div class="bf-mem-summary-empty">Checking&hellip;</div>';
    try {
        const { buildHealthReport, formatHealthAge } = await import('./health.js');
        const steps = await buildHealthReport();
        list.innerHTML = steps.map(step => {
            // Section headers (per-agent tool telemetry) render without a dot;
            // their tool rows carry `indent` to nest visually under the header.
            if (step.header) {
                return `<div class="bf-mem-health-section">${escapeHtml(step.label)}</div>`;
            }
            const status = ['ok', 'warn', 'fail', 'none'].includes(step.status) ? step.status : 'none';
            const when = step.ts ? `<span class="bf-mem-health-ts">${escapeHtml(formatHealthAge(step.ts))}</span>` : '';
            return `<div class="bf-mem-health-row${step.indent ? ' indent' : ''}">
                <span class="bf-mem-health-dot ${status}"></span>
                <span class="bf-mem-health-label">${escapeHtml(step.label)}</span>
                <span class="bf-mem-health-detail">${escapeHtml(step.detail || '')}</span>
                ${when}
            </div>`;
        }).join('');
    } catch (err) {
        list.innerHTML = `<div class="bf-mem-summary-empty">Health check failed: ${escapeHtml(err?.message || String(err))}</div>`;
    }
}

// ---------------------------------------------------------------------------
// PREMISE-FLOOR SLIDER — value <-> slider position, and the live cost readout.
//
// UNLIMITED is slider position 101, not a companion checkbox. The axis is
// "more rows to the right" and "no limit" is its far end, so one control holds
// one state; a checkbox would leave the slider parked on a number that no
// longer applies and the user guessing which of the two wins. 101 is a UI
// coordinate only — the stored value is PREMISE_FLOOR_UNLIMITED (0).
// ---------------------------------------------------------------------------
const PREMISE_FLOOR_SLIDER_UNLIMITED_POS = PREMISE_FLOOR_SLIDER_MAX + 1;

function premiseFloorToSliderPos(value) {
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return PREMISE_FLOOR_DEFAULT;
    if (n === PREMISE_FLOOR_UNLIMITED) return PREMISE_FLOOR_SLIDER_UNLIMITED_POS;
    return Math.min(PREMISE_FLOOR_SLIDER_MAX, Math.max(PREMISE_FLOOR_MIN, n));
}

function sliderPosToPremiseFloor(pos) {
    const n = Math.trunc(Number(pos));
    if (!Number.isFinite(n)) return PREMISE_FLOOR_DEFAULT;
    if (n >= PREMISE_FLOOR_SLIDER_UNLIMITED_POS) return PREMISE_FLOOR_UNLIMITED;
    return Math.min(PREMISE_FLOOR_SLIDER_MAX, Math.max(PREMISE_FLOOR_MIN, n));
}

function premiseFloorLabel(value) {
    return Number(value) === PREMISE_FLOOR_UNLIMITED ? '∞ no limit' : String(value);
}

// Both guards matter. The debounce is because every repaint runs
// selectPremiseFloor over the whole store TWICE (this cap and the unlimited
// ceiling) behind an IndexedDB read, and a slider drag fires per pixel. The
// sequence number is because those reads finish out of order — without it the
// figure left on screen is whichever estimate happened to be slowest, i.e. some
// cap the user dragged past.
let premiseFloorCostSeq = 0;
let premiseFloorCostTimer = null;

function renderPremiseFloorCost(capValue = undefined, { delay = 0 } = {}) {
    const el = document.getElementById('bf_mem_premise_floor_cost');
    if (!el) return;
    const seq = ++premiseFloorCostSeq;
    clearTimeout(premiseFloorCostTimer);
    premiseFloorCostTimer = setTimeout(async () => {
        let est = null;
        try {
            est = await estimatePremiseFloorCost(capValue);
        } catch (err) {
            if (seq !== premiseFloorCostSeq) return;
            el.textContent = `Could not measure this chat's memory sheet: ${err?.message || err}`;
            return;
        }
        if (seq !== premiseFloorCostSeq) return;

        const num = (n) => Number(n || 0).toLocaleString();
        // `total.rows` is floor + NEED + sticky recovered, all drawn from the
        // store and de-duplicated against each other, so rows/storeFacts is a
        // real coverage figure — and a conservative one: bonus connected
        // memories are not in it, and they can only add.
        const pct = est.storeFacts > 0 ? Math.min(100, Math.round((est.total.rows / est.storeFacts) * 100)) : 0;
        const ceilPct = est.storeFacts > 0 ? Math.min(100, Math.round((est.ceiling.rows / est.storeFacts) * 100)) : 0;

        if (!est.storeFacts) {
            el.innerHTML = 'Nothing stored for this chat yet, so there is nothing to price. Numbers appear here once the first memories are written.';
            return;
        }
        // NEVER say "all N" — that sentence was the defect. storeFacts now counts
        // every active fact including the cold ones, so rows and storeFacts are
        // separate numbers and the gap between them is real. Always print both
        // sides of the fraction, at every setting, so the figure cannot flatter
        // itself by shrinking its own denominator.
        const head = est.unlimited
            ? `<b>No limit:</b> ${num(est.total.rows)} of your ${num(est.storeFacts)} stored memories on the sheet (${pct}%), <b>~${num(est.total.tokens)} tokens every turn</b>.`
            : `<b>At ${num(est.cap)} rows:</b> ${num(est.total.rows)} of your ${num(est.storeFacts)} stored memories on the sheet (${pct}%), <b>~${num(est.total.tokens)} tokens every turn</b>.`;

        // Anything held back for a reason the slider cannot overrule gets named.
        // Silence here is what let the old readout show 100% while a third of the
        // store sat cold and invisible.
        const ex = est.excluded || {};
        const held = [];
        if (ex.cold > 0) held.push(`${num(ex.cold)} set aside as wrong or duplicate`);
        if (ex.invisible > 0) held.push(`${num(ex.invisible)} not known to anyone present`);
        const excludedNote = held.length
            ? ` ${num(ex.total)} are held back regardless of this slider — ${held.join(', ')}; raising it will not bring them in.`
            : '';

        const tail = est.unlimited
            ? ' Every memory this chat adds from here is added to that bill, on every turn.'
            : ` No limit would be ${num(est.ceiling.rows)} of ${num(est.storeFacts)} (${ceilPct}%) for ~${num(est.ceiling.tokens)} tokens — and it keeps growing with the chat.`;
        el.innerHTML = head + excludedNote + tail;
    }, delay);
}

function setupTabs() {
    const tablist = document.querySelector('.bf-mem-tabs[role="tablist"]');
    if (!tablist) return;

    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));

    function activateTab(tab) {
        tabs.forEach(t => {
            t.setAttribute('aria-selected', 'false');
            t.setAttribute('tabindex', '-1');
            t.classList.remove('active');
            const panel = document.getElementById(t.getAttribute('aria-controls'));
            if (panel) panel.style.display = 'none';
        });

        tab.setAttribute('aria-selected', 'true');
        tab.setAttribute('tabindex', '0');
        tab.classList.add('active');

        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        if (panel) panel.style.display = '';

        // The floor estimate is priced against the LIVE store, which grows every
        // turn — a figure rendered when the panel was first built is stale by
        // the time the user comes back to look at it.
        if (tab.getAttribute('aria-controls') === 'bf_mem_tab_memory') {
            renderPremiseFloorCost();
        }
        if (tab.getAttribute('aria-controls') === 'bf_mem_tab_database') {
            refreshDatabaseView();
        }
        if (tab.getAttribute('aria-controls') === 'bf_mem_tab_tokens') {
            renderTokens();
        }
        if (tab.getAttribute('aria-controls') === 'bf_mem_tab_health') {
            renderHealthTab();
        }
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => activateTab(tab));
        tab.addEventListener('keydown', (e) => {
            const idx = tabs.indexOf(tab);
            let target = null;
            if (e.key === 'ArrowRight') target = tabs[(idx + 1) % tabs.length];
            else if (e.key === 'ArrowLeft') target = tabs[(idx - 1 + tabs.length) % tabs.length];
            if (target) { e.preventDefault(); activateTab(target); }
        });
    });
}

function unlinkCurrentChat() {
    const chatId = getCurrentChatId();
    if (!chatId) { toastr.warning('No chat currently open', 'BF Memory'); return; }
    const profiles = extensionSettings?.dbProfiles || {};
    const linkedTo = Object.entries(profiles).filter(([, p]) => (p?.linkedChats || []).includes(chatId)).map(([n]) => n);
    if (linkedTo.length === 0 && isChatUnlinked(chatId)) {
        toastr.info('Current chat is already unlinked', 'BF Memory');
        return;
    }
    if (!confirm('Unlink the current chat from its DB profile? It will stop auto-loading/auto-relinking. Your facts stay in the live store.')) return;
    for (const name of linkedTo) {
        const p = profiles[name];
        if (p?.linkedChats) p.linkedChats = p.linkedChats.filter(id => id !== chatId);
    }

    markChatUnlinked(chatId);
    if (extensionSettings.activeDbProfile && linkedTo.includes(extensionSettings.activeDbProfile)) {
        extensionSettings.activeDbProfile = '';
    }
    lastAutoLoadedChat = '';
    saveSettings();
    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    addDebugLog('info', `Unlinked current chat ${chatId} from ${linkedTo.length} profile(s) (detached)`, {
        subsystem: 'settings', event: 'profile.unlinked', actor: 'USER', reason: 'USER_UNLINK_CURRENT',
        data: { chatId, profiles: linkedTo },
    });
    toastr.success('Current chat unlinked', 'BF Memory');
}

function refreshDbProfileDropdown() {
    const select = document.getElementById('bf_mem_db_profile_select');
    if (!select) return;

    const profiles = extensionSettings?.dbProfiles || {};
    const active = extensionSettings?.activeDbProfile || '';

    select.innerHTML = '<option value="">-- No profile loaded --</option>';
    for (const [name, profile] of Object.entries(profiles)) {
        const option = document.createElement('option');
        option.value = name;
        const factCount = Object.values(profile.databases || {}).reduce((sum, db) => sum + (db.facts?.length || 0), 0);
        const dbCount = Object.keys(profile.databases || {}).length;
        const linkCount = (profile.linkedChats || []).length;
        option.textContent = `${name} (${dbCount} dbs, ${factCount} facts${linkCount ? `, ${linkCount} chats` : ''})`;
        select.appendChild(option);
    }

    if (active && profiles[active]) {
        select.value = active;
    }
}

async function loadDbProfile(profileName) {
    if (!profileName) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) {
        toastr.error(`Profile "${profileName}" not found`, 'BF Memory');
        return;
    }

    const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

    const existing = await getAllDatabases();
    for (const category of Object.keys(existing)) {
        await deleteDatabase(category);
    }

    for (const [category, db] of Object.entries(profile.databases || {})) {
        if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
        await saveDatabase({ ...db, category });
    }

    extensionSettings.activeDbProfile = profileName;
    saveSettings();
    refreshDbProfileDropdown();
    refreshDatabaseView();
    toastr.success(`Loaded profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile loaded: "${profileName}"`, {
        subsystem: 'import', event: 'profile.switched', actor: 'USER', data: { profileName },
    });
}

async function saveDbProfile(profileName) {
    if (!profileName) return;

    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();

    if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
    const existing = (extensionSettings.dbProfiles[profileName] && typeof extensionSettings.dbProfiles[profileName] === 'object')
        ? extensionSettings.dbProfiles[profileName]
        : {};
    extensionSettings.dbProfiles[profileName] = {
        ...existing,
        databases: JSON.parse(JSON.stringify(databases)),
        savedAt: Date.now(),
    };
    extensionSettings.activeDbProfile = profileName;

    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        linkChatToProfile(profileName, currentChatId);

        lastAutoLoadedChat = currentChatId;
    }
    saveSettings();
    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    toastr.success(`Saved profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile saved: "${profileName}" (${Object.keys(databases).length} dbs)${currentChatId ? ` + linked to chat ${currentChatId}` : ''}`, {
        subsystem: 'db', event: 'profile.saved', actor: 'USER', reason: 'SAVE_AS_NEW',
        data: { profileName, dbCount: Object.keys(databases).length, linkedChat: currentChatId || null },
    });
}

async function deleteDbProfile(profileName) {
    if (!profileName) return;
    if (!confirm(`Delete saved profile "${profileName}"? This cannot be undone.`)) return;

    const wasActive = extensionSettings.activeDbProfile === profileName;
    const profile = extensionSettings.dbProfiles?.[profileName];
    const linkedChats = [...(profile?.linkedChats || [])];
    const currentChatId = getCurrentChatId();

    let alsoWipe = false;
    if (wasActive && currentChatId && linkedChats.includes(currentChatId)) {
        alsoWipe = confirm(`"${profileName}" is the active profile for THIS chat. Also clear its facts from this chat's working store?\n\nOK = delete profile AND wipe this chat's facts.\nCancel = delete profile only (facts stay in the live store).`);
    }

    delete extensionSettings.dbProfiles[profileName];
    if (wasActive) {
        extensionSettings.activeDbProfile = '';
        lastAutoLoadedChat = '';
    }

    if (Array.isArray(extensionSettings.unlinkedChats)) {
        extensionSettings.unlinkedChats = extensionSettings.unlinkedChats.filter(id => !!findProfileForChat(id));
    }
    saveSettings();

    if (alsoWipe) {
        try {
            const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
            cancelPendingSnapshot();
            const dbs = await getAllDatabases();
            for (const category of Object.keys(dbs)) await deleteDatabase(category);
            await flushSnapshotNow();

            markChatUnlinked(currentChatId);
            saveSettings();
            refreshDatabaseView();
        } catch (err) {
            addDebugLog('fail', `Profile-delete working-store wipe failed: ${err.message || err}`);
        }
    }

    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    addDebugLog('info', `DB profile deleted: "${profileName}"${alsoWipe ? ' (+ working store wiped)' : ''}`, {
        subsystem: 'settings', event: 'profile.deleted', actor: 'USER', reason: 'USER_DELETE',
        data: { profileName, wasActive, linkedChatCount: linkedChats.length, wipedWorkingStore: alsoWipe },
    });
    toastr.success(`Deleted profile "${profileName}"`, 'BF Memory');
}

let lastAutoLoadedChat = '';

let _lastChatId = '';

function getCurrentChatLabel() {
    const context = getContext();
    const charName = context.characters?.[context.characterId]?.name || '';
    const chatId = getCurrentChatId();

    return charName || chatId || '';
}

function findProfileForChat(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    for (const [name, profile] of Object.entries(extensionSettings.dbProfiles)) {
        if ((profile.linkedChats || []).includes(chatId)) return name;
    }
    return null;
}

function parentChatIdOfBranch(chatId) {
    if (typeof chatId !== 'string') return chatId;

    let id = chatId;
    let prev;
    do {
        prev = id;
        id = id.replace(/\s*-\s*Branch\s*#\s*\d+\s*$/i, '');
    } while (id !== prev);
    return id;
}

function resolveBranchParentProfile(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    const parentId = parentChatIdOfBranch(chatId);
    if (parentId && parentId !== chatId) {
        const byParent = findProfileForChat(parentId);
        if (byParent) return byParent;
    }

    const charName = getContext()?.characters?.[getContext()?.characterId]?.name || '';
    if (charName && extensionSettings.dbProfiles[charName]) return charName;
    return null;
}

function linkChatToProfile(profileName, chatId) {
    if (!profileName || !chatId) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) return;

    if (!profile.linkedChats) profile.linkedChats = [];

    for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
        if (name !== profileName && p.linkedChats) {
            p.linkedChats = p.linkedChats.filter(id => id !== chatId);
        }
    }

    if (!profile.linkedChats.includes(chatId)) {
        profile.linkedChats.push(chatId);
    }

    clearChatUnlinked(chatId);
    saveSettings();
}

async function ensureActiveProfileForCurrentChat() {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) return null;

        const active = extensionSettings?.activeDbProfile;
        if (active && extensionSettings?.dbProfiles?.[active]) {

            if (!(extensionSettings.dbProfiles[active].linkedChats || []).includes(chatId) && !isChatUnlinked(chatId)) {
                linkChatToProfile(active, chatId);
            }
            return active;
        }

        if (isChatUnlinked(chatId)) return null;

        if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
        const isBranch = isBranchChat(chatId);
        let resolved = null;
        let how = 'none';

        resolved = findProfileForChat(chatId);
        if (resolved) how = 'linked';

        if (!resolved && isBranch) {
            const parentProfile = resolveBranchParentProfile(chatId);
            if (parentProfile) { resolved = parentProfile; how = 'inherited-branch'; }
        }

        if (!resolved) {
            const chatLabel = getCurrentChatLabel();
            if (chatLabel) {
                if (!extensionSettings.dbProfiles[chatLabel]) {
                    const { buildSkeletonDatabases } = await import('./database.js');
                    extensionSettings.dbProfiles[chatLabel] = {
                        databases: buildSkeletonDatabases(),
                        savedAt: Date.now(),
                        linkedChats: [],
                    };
                    how = 'auto-created';
                } else {
                    how = 'linked';
                }
                resolved = chatLabel;
            }
        }

        if (!resolved) return null;

        linkChatToProfile(resolved, chatId);
        extensionSettings.activeDbProfile = resolved;

        lastAutoLoadedChat = chatId;
        saveSettings();
        try { refreshDbProfileDropdown(); refreshLinkedChatsField(); } catch {  }
        addDebugLog('info', `Ensured active DB profile "${resolved}" for chat ${chatId} at fact-write (${how})`, {
            subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'EAGER_ENSURE',
            data: { chatId, resolvedProfile: resolved, linkState: how, isBranch, eager: true },
        });
        return resolved;
    } catch (err) {
        addDebugLog('fail', `Eager profile ensure failed (non-fatal): ${err.message || err}`);
        return null;
    }
}

export async function saveCurrentToActiveProfile(profileKey = null, { allowEmpty = false } = {}) {
    let profileName = profileKey || extensionSettings?.activeDbProfile;

    if (!profileName && !profileKey) {
        profileName = await ensureActiveProfileForCurrentChat();
    }
    if (!profileName) return;

    if (!extensionSettings.dbProfiles?.[profileName]) {
        addDebugLog('fail', `Skipped save: profile "${profileName}" no longer exists (was current profile deleted?)`);
        if (typeof toastr !== 'undefined') {
            toastr.warning(`BF Memory: skipped saving facts — profile "${profileName}" was deleted.`);
        }
        return;
    }
    try {
        const { getAllDatabases } = await import('./database.js');
        const databasesRaw = await getAllDatabases();

        const databases = {};
        for (const [cat, sdb] of Object.entries(databasesRaw || {})) {
            const facts = Array.isArray(sdb?.facts) ? sdb.facts.filter(f => !(f && f.__sharedOrigin)) : [];
            databases[cat] = sdb ? { ...sdb, facts } : { category: cat, facts };
        }
        const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);

        if (totalFacts === 0 && !allowEmpty) return;

        // Feature 4: the story spine + scene card travel WITH the DB profile, so a
        // new chat later pointed at this DB shows the story-so-far and current scene
        // instead of starting blank. Snapshot them from the current chat's metadata.
        const { getStorySpine, getCurrentScene, getClosedScenes, getSceneTimeline } = await import('./turn-state.js');
        const storySpine = JSON.parse(JSON.stringify(getStorySpine() || []));
        const sceneStore = JSON.parse(JSON.stringify({ current: getCurrentScene() || null, closed: getClosedScenes() || [], timeline: getSceneTimeline() || '' }));

        extensionSettings.dbProfiles[profileName] = {
            ...extensionSettings.dbProfiles[profileName],
            databases: JSON.parse(JSON.stringify(databases)),
            storySpine,
            sceneStore,
            savedAt: Date.now(),
        };
        saveSettings();
        addDebugLog('info', `Saved to active profile "${profileName}" (${totalFacts} facts)`, {
            subsystem: 'db', event: 'profile.saved', data: { profileName, totalFacts, allowEmpty },
        });
    } catch (err) {
        addDebugLog('fail', `Failed to save active profile: ${err.message}`);
    }
}

function pruneActiveProfile(category = null) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return { profilesPruned: [], factsPruned: 0 };

    const targets = new Set();
    const active = extensionSettings?.activeDbProfile;
    if (active && profiles[active]) targets.add(active);
    const chatId = getCurrentChatId();
    if (chatId) {
        for (const [name, profile] of Object.entries(profiles)) {
            if ((profile?.linkedChats || []).includes(chatId)) targets.add(name);
        }
    }

    const profilesPruned = [];
    let factsPruned = 0;
    for (const name of targets) {
        const profile = profiles[name];
        if (!profile || typeof profile !== 'object' || !profile.databases) continue;
        let changed = false;
        if (category == null) {

            for (const db of Object.values(profile.databases)) {
                factsPruned += (db?.facts?.length || 0);
            }
            profile.databases = {};
            changed = true;
        } else if (Object.prototype.hasOwnProperty.call(profile.databases, category)) {
            factsPruned += (profile.databases[category]?.facts?.length || 0);
            delete profile.databases[category];
            changed = true;
        }
        if (changed) {
            profile.savedAt = Date.now();
            profilesPruned.push(name);
        }
    }
    if (profilesPruned.length > 0) saveSettings();
    return { profilesPruned, factsPruned };
}

function markChatUnlinked(chatId) {
    if (!chatId) return;
    if (!Array.isArray(extensionSettings.unlinkedChats)) extensionSettings.unlinkedChats = [];
    if (!extensionSettings.unlinkedChats.includes(chatId)) {
        extensionSettings.unlinkedChats.push(chatId);
        saveSettings();
    }
}

function clearChatUnlinked(chatId) {
    if (!chatId || !Array.isArray(extensionSettings.unlinkedChats)) return;
    const before = extensionSettings.unlinkedChats.length;
    extensionSettings.unlinkedChats = extensionSettings.unlinkedChats.filter(id => id !== chatId);
    if (extensionSettings.unlinkedChats.length !== before) saveSettings();
}

function isChatUnlinked(chatId) {
    return !!chatId && Array.isArray(extensionSettings?.unlinkedChats) && extensionSettings.unlinkedChats.includes(chatId);
}

function detachCurrentChatIfNeeded(unlinkedChatId, profileName) {
    const currentChatId = getCurrentChatId();
    if (!unlinkedChatId || unlinkedChatId !== currentChatId) return;

    if (!findProfileForChat(currentChatId)) {
        markChatUnlinked(currentChatId);
    }
    if (extensionSettings.activeDbProfile === profileName) {
        extensionSettings.activeDbProfile = '';
    }
    lastAutoLoadedChat = '';
    addDebugLog('info', `Unlinked current chat ${currentChatId} from profile "${profileName}" (detached: no auto-relink)`, {
        subsystem: 'settings', event: 'profile.unlinked', actor: 'USER', reason: 'USER_UNLINK',
        data: { chatId: currentChatId, profileName, stillLinkedElsewhere: !!findProfileForChat(currentChatId) },
    });
}

export function isTriviallyEmptyForExtraction(mes) {
    const raw = String(mes ?? '');

    const visible = raw.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (visible.length === 0) return true;
    if (visible.length < 15) return true;

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
        const allOoc = lines.every(l =>
            /^\(\(.*\)\)$/.test(l) || /^ooc\b/i.test(l) || /^\[ooc/i.test(l));
        if (allOoc) return true;
    }
    return false;
}

async function autoSaveDbProfile() {
    try {
        const chatId = getCurrentChatId();
        const chatLabel = getCurrentChatLabel();

        if (!chatId) return;
        if (chatId === lastAutoLoadedChat) return; 

        const isBranch = isBranchChat(chatId);
        let linkState = 'none';

        let profileToLoad = findProfileForChat(chatId);
        if (profileToLoad) linkState = 'linked';

        if (!profileToLoad && isChatUnlinked(chatId)) {

            if (extensionSettings.activeDbProfile && !findProfileForChat(chatId)) {
                extensionSettings.activeDbProfile = '';
                saveSettings();
                refreshDbProfileDropdown();
                refreshLinkedChatsField();
            }
            addDebugLog('info', `Auto-link suppressed: chat ${chatId} was explicitly unlinked by user`, {
                subsystem: 'settings', event: 'profile.autolinkSuppressed', actor: 'USER', reason: 'EXPLICIT_UNLINK',
                data: { chatId },
            });

            try {
                const { getAllDatabases } = await import('./database.js');
                const live = await getAllDatabases();
                const cats = Object.keys(live || {});
                const factsLoaded = cats.reduce((n, c) => n + ((live[c]?.facts || []).length), 0);
                addDebugLog('info', `DB connect: chat ${chatId} -> (unlinked, suppressed) ${factsLoaded} facts`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                    data: {
                        chatId, resolvedProfile: null, linkState: 'unlinked-suppressed',
                        factsLoaded, categories: cats.length,
                        source: factsLoaded > 0 ? 'idb' : 'empty', isBranch,
                    },
                });
            } catch {  }
            lastAutoLoadedChat = chatId;
            return;
        }

        if (!profileToLoad && isBranch) {
            const parentProfile = resolveBranchParentProfile(chatId);
            if (parentProfile) {
                linkChatToProfile(parentProfile, chatId);
                profileToLoad = parentProfile;
                linkState = 'inherited-branch';
                addDebugLog('info', `Branch inherited parent DB profile "${parentProfile}" for chat ${chatId}`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'BRANCH_INHERIT',
                    data: { chatId, resolvedProfile: parentProfile, parentChatId: parentChatIdOfBranch(chatId), isBranch: true },
                });
            }
        }

        if (!profileToLoad && chatLabel) {

            if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
            if (!extensionSettings.dbProfiles[chatLabel]) {

                const { buildSkeletonDatabases } = await import('./database.js');
                const seeded = buildSkeletonDatabases();
                extensionSettings.dbProfiles[chatLabel] = {
                    databases: seeded,
                    savedAt: Date.now(),
                    linkedChats: [chatId],
                };
                addDebugLog('info', `Auto-created DB profile "${chatLabel}" (seeded Layer-1 skeleton) for chat ${chatId}`, {
                    subsystem: 'import', event: 'db.seeded', actor: 'SYSTEM',
                    data: { profileName: chatLabel, chatId, categoriesSeeded: Object.keys(seeded) },
                });
                linkState = 'auto-created';
            } else {

                linkChatToProfile(chatLabel, chatId);

                linkState = 'linked';
            }
            profileToLoad = chatLabel;
        }

        if (profileToLoad && extensionSettings.dbProfiles?.[profileToLoad]) {
            const profile = extensionSettings.dbProfiles[profileToLoad];
            const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

            const profileFactCount = Object.values(profile.databases || {})
                .reduce((n, db) => n + ((db && Array.isArray(db.facts)) ? db.facts.length : 0), 0);

            if (profileFactCount === 0) {

                const live = await getAllDatabases();
                const liveFacts = Object.values(live || {})
                    .reduce((n, db) => n + ((db?.facts || []).length), 0);
                addDebugLog('info', `Auto-load SKIPPED clear: profile "${profileToLoad}" has 0 facts — kept live store (${liveFacts} facts)`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'NON_DESTRUCTIVE_EMPTY_PROFILE',
                    data: { chatId, resolvedProfile: profileToLoad, decision: 'KEEP_LIVE_STORE', profileFactCount, liveFacts, isBranch },
                });
            } else {

                const existing = await getAllDatabases();
                for (const category of Object.keys(existing)) {
                    await deleteDatabase(category);
                }
                for (const [category, db] of Object.entries(profile.databases || {})) {
                    if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
                    await saveDatabase({ ...db, category });
                }
            }

            extensionSettings.activeDbProfile = profileToLoad;
            saveSettings();
            refreshDbProfileDropdown();
            refreshLinkedChatsField();
            addDebugLog('info', `Auto-loaded DB profile "${profileToLoad}" (linked to chat ${chatId})`, {
                subsystem: 'import', event: 'profile.switched', actor: 'SYSTEM', reason: 'AUTO_LOADED', data: { profileName: profileToLoad, chatId },
            });

            // Feature 4: restore the profile's saved story spine + scene card onto this
            // chat so composeSheet renders "Story so far:" / "Scene:" immediately instead
            // of blank. Sync the in-memory caches from THIS chat's metadata first, then
            // only restore when the chat hasn't advanced its own spine/scene yet (never
            // clobber a chat that already has one). A branch inherits the parent profile,
            // so this seamlessly carries the parent's spine/scene without double-applying.
            try {
                reloadStorySpineFromChat();
                reloadSceneFromChat();
                const { getStorySpine, setStorySpine, getCurrentScene, getClosedScenes, setSceneStore } = await import('./turn-state.js');

                const savedSpine = Array.isArray(profile.storySpine) ? profile.storySpine : null;
                if (savedSpine && savedSpine.length > 0 && getStorySpine().length === 0) {
                    setStorySpine(savedSpine);
                }

                const savedScene = (profile.sceneStore && typeof profile.sceneStore === 'object') ? profile.sceneStore : null;
                const chatHasScene = !!getCurrentScene() || getClosedScenes().length > 0;
                if (savedScene && !chatHasScene) {
                    setSceneStore(savedScene);
                }

                reloadSheetFromChat();
            } catch (e) {
                addDebugLog('fail', `Feature 4 spine/scene restore failed (non-fatal): ${e?.message || e}`);
            }

            try {
                const live = await getAllDatabases();
                const cats = Object.keys(live || {});
                const factsLoaded = cats.reduce((n, c) => n + ((live[c]?.facts || []).length), 0);
                addDebugLog('info', `DB connect: chat ${chatId} -> profile "${profileToLoad}" (${linkState}) ${factsLoaded} facts`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                    data: {
                        chatId, resolvedProfile: profileToLoad, linkState,
                        factsLoaded, categories: cats.length,
                        source: factsLoaded > 0 ? 'profile' : 'empty', isBranch,
                    },
                });
            } catch {  }
        } else {

            addDebugLog('info', `DB connect: chat ${chatId} -> (no profile resolved)`, {
                subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                data: {
                    chatId, resolvedProfile: null, linkState: 'none',
                    factsLoaded: null, categories: null, source: 'empty', isBranch,
                },
            });
        }

        lastAutoLoadedChat = chatId;
    } catch (err) {
        addDebugLog('fail', `Auto-save DB profile failed: ${err.message}`);
    }
}

const NEW_EMPTY_DB_CHOICE = '__bf_new_empty_db__';

function uniqueEmptyDbName() {
    const base = getCurrentChatLabel() || 'New DB';
    const profiles = extensionSettings?.dbProfiles || {};
    if (!profiles[base]) return base;
    let i = 2;
    while (profiles[`${base} ${i}`]) i++;
    return `${base} ${i}`;
}

async function createEmptyDbForNewChat(chatId) {
    const { buildSkeletonDatabases, getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
    const name = uniqueEmptyDbName();
    // wipe the live working store so the new DB genuinely starts empty (same shape as the New-empty path)
    cancelPendingSnapshot();
    const existing = await getAllDatabases();
    for (const category of Object.keys(existing)) await deleteDatabase(category);
    await flushSnapshotNow();
    if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
    extensionSettings.dbProfiles[name] = {
        databases: buildSkeletonDatabases(),
        savedAt: Date.now(),
        linkedChats: [],
    };
    addDebugLog('info', `New empty DB profile created for new chat: "${name}" (chat ${chatId})`, {
        subsystem: 'db', event: 'profile.saved', actor: 'USER', reason: 'NEW_EMPTY',
        data: { profileName: name, linkedChat: chatId || null },
    });
    return name;
}

// Feature 3: on a genuinely new chat, let the user pick which DB profile it uses.
// Returns true if a selection was applied (caller must then SKIP autoSaveDbProfile so it
// does not auto-create/clobber), false if dismissed (caller falls back to auto behavior).
async function promptNewChatDbChoice(toChatId) {
    await ensurePopup();
    if (!Popup) return false;

    const profiles = extensionSettings?.dbProfiles || {};

    const container = document.createElement('div');
    container.className = 'bf-mem-newchat-db-popup';
    const heading = document.createElement('h4');
    heading.textContent = 'Choose a memory database for this new chat';
    const desc = document.createElement('p');
    desc.textContent = 'Pick an existing database to load, or start a fresh empty one. Cancel to keep the default automatic behavior.';
    const select = document.createElement('select');
    select.className = 'text_pole';
    // populate exactly like refreshDbProfileDropdown, plus a New-empty option
    for (const [name, profile] of Object.entries(profiles)) {
        const option = document.createElement('option');
        option.value = name;
        const factCount = Object.values(profile.databases || {}).reduce((sum, db) => sum + (db.facts?.length || 0), 0);
        const dbCount = Object.keys(profile.databases || {}).length;
        const linkCount = (profile.linkedChats || []).length;
        option.textContent = `${name} (${dbCount} dbs, ${factCount} facts${linkCount ? `, ${linkCount} chats` : ''})`;
        select.appendChild(option);
    }
    const newOption = document.createElement('option');
    newOption.value = NEW_EMPTY_DB_CHOICE;
    newOption.textContent = '+ New empty DB';
    select.appendChild(newOption);

    container.appendChild(heading);
    container.appendChild(desc);
    container.appendChild(select);

    const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', { allowVerticalScrolling: true, okButton: 'Use selected DB' });
    const result = await popup.show();
    if (!result) return false;

    const choice = select.value;
    try {
        let profileName;
        if (choice === NEW_EMPTY_DB_CHOICE) {
            profileName = await createEmptyDbForNewChat(toChatId);
        } else {
            profileName = choice;
            await loadDbProfile(profileName);
        }
        if (!profileName) return false;

        linkChatToProfile(profileName, toChatId);
        extensionSettings.activeDbProfile = profileName;
        lastAutoLoadedChat = toChatId;
        saveSettings();
        refreshDbProfileDropdown();
        refreshLinkedChatsField();
        refreshDatabaseView();
        addDebugLog('info', `New chat ${toChatId} bound to DB profile "${profileName}" via picker`, {
            subsystem: 'db', event: 'db.connect', actor: 'USER', reason: 'NEW_CHAT_PICKER',
            data: { chatId: toChatId, resolvedProfile: profileName, newEmpty: choice === NEW_EMPTY_DB_CHOICE },
        });

        // Feature 4: the picker path skips autoSaveDbProfile, so restore the chosen
        // profile's saved story spine + scene card onto this new (empty) chat here,
        // matching autoSaveDbProfile's restore, so they render immediately not blank.
        try {
            reloadStorySpineFromChat();
            reloadSceneFromChat();
            const prof = extensionSettings.dbProfiles?.[profileName] || {};
            const { getStorySpine, setStorySpine, getCurrentScene, getClosedScenes, setSceneStore } = await import('./turn-state.js');
            const savedSpine = Array.isArray(prof.storySpine) ? prof.storySpine : null;
            if (savedSpine && savedSpine.length > 0 && getStorySpine().length === 0) setStorySpine(savedSpine);
            const savedScene = (prof.sceneStore && typeof prof.sceneStore === 'object') ? prof.sceneStore : null;
            if (savedScene && !(getCurrentScene() || getClosedScenes().length > 0)) setSceneStore(savedScene);
            reloadSheetFromChat();
        } catch (e) {
            addDebugLog('fail', `New-chat picker spine/scene restore failed (non-fatal): ${e?.message || e}`);
        }

        return true;
    } catch (err) {
        addDebugLog('fail', `New-chat DB picker failed: ${err?.message || err}`, {
            subsystem: 'db', event: 'db.connect', actor: 'USER', reason: 'NEW_CHAT_PICKER',
        });
        return false;
    }
}

function refreshLinkedChatsField() {
    const display = document.getElementById('bf_mem_db_linked_chats');
    if (!display) return;
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        display.textContent = '(none)';
        return;
    }
    const profile = extensionSettings.dbProfiles[profileName];
    const chats = profile.linkedChats || [];
    display.textContent = chats.length > 0 ? chats.join(', ') : '(none)';
}

async function showLinkedChatsPopup() {
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        toastr.warning('No profile selected', 'BF Memory');
        return;
    }

    const profile = extensionSettings.dbProfiles[profileName];
    const linkedChats = [...(profile.linkedChats || [])];
    const currentChatId = getCurrentChatId();

    let html = `<div class="bf-mem-linked-popup">
        <h4>Linked Chats for "${escapeHtml(profileName)}"</h4>
        <p>These chats will auto-load this DB profile when opened.</p>
        <div class="bf-mem-linked-list" id="bf_mem_linked_list">`;

    if (linkedChats.length === 0) {
        html += '<div class="bf-mem-empty">No chats linked yet.</div>';
    } else {
        for (const chatId of linkedChats) {
            const isCurrent = chatId === currentChatId;
            html += `<div class="bf-mem-linked-item">
                <span class="bf-mem-linked-name">${escapeHtml(chatId)}${isCurrent ? ' (current)' : ''}</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
        }
    }

    html += `</div>
        <div class="bf-mem-linked-add-row" style="margin-top: 10px;">
            <button id="bf_mem_link_current" class="menu_button">
                <i class="fa-solid fa-plus"></i> Link Current Chat
            </button>
        </div>
    </div>`;

    await ensurePopup();
    if (!Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
    await popup.show();

    document.querySelectorAll('.bf-mem-linked-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const chatId = btn.dataset.chat;
            const idx = profile.linkedChats.indexOf(chatId);
            if (idx >= 0) {
                profile.linkedChats.splice(idx, 1);
                detachCurrentChatIfNeeded(chatId, profileName);
                saveSettings();
                refreshLinkedChatsField();
                refreshDbProfileDropdown();
                btn.closest('.bf-mem-linked-item').remove();
                toastr.success(`Unlinked "${chatId}"`, 'BF Memory');
            }
        });
    });

    document.getElementById('bf_mem_link_current')?.addEventListener('click', () => {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('No chat currently open', 'BF Memory');
            return;
        }
        if (!profile.linkedChats) profile.linkedChats = [];
        if (profile.linkedChats.includes(chatId)) {
            toastr.info('Current chat is already linked', 'BF Memory');
            return;
        }

        for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
            if (name !== profileName && p.linkedChats) {
                p.linkedChats = p.linkedChats.filter(id => id !== chatId);
            }
        }
        profile.linkedChats.push(chatId);

        clearChatUnlinked(chatId);
        extensionSettings.activeDbProfile = profileName;
        lastAutoLoadedChat = '';
        saveSettings();
        refreshLinkedChatsField();
        refreshDbProfileDropdown();
        toastr.success(`Linked current chat to "${profileName}"`, 'BF Memory');

        const listEl = document.getElementById('bf_mem_linked_list');
        if (listEl) {
            const item = document.createElement('div');
            item.className = 'bf-mem-linked-item';
            item.innerHTML = `<span class="bf-mem-linked-name">${escapeHtml(chatId)} (current)</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>`;
            listEl.querySelector('.bf-mem-empty')?.remove();
            listEl.appendChild(item);
        }
    });
}

export async function initSettings() {
    const context = getContext();

    if (!context.extensionSettings) context.extensionSettings = {};
    let resetClobberedEnabled = false; 
    let freshInstall = false; 
    try {
        const current = context.extensionSettings[EXTENSION_NAME];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {

            if (current == null) freshInstall = true;
            if (current && typeof current === 'object' && current.enabled === true) resetClobberedEnabled = true;
            context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
    } catch (err) {
        console.error('[BFMemory] corrupt settings, resetting:', err);
        try { if (context.extensionSettings?.[EXTENSION_NAME]?.enabled === true) resetClobberedEnabled = true; } catch {  }
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        if (typeof toastr !== 'undefined') {
            toastr.warning('BF Memory settings were corrupt and have been reset.');
        }
    }
    extensionSettings = context.extensionSettings[EXTENSION_NAME];

    // Object/array defaults are CLONED, never assigned: a bare assignment aliases
    // the module literal, so the first saveDbProfile / markChatUnlinked writes
    // into DEFAULT_SETTINGS itself and the reset paths above then restore that
    // accumulated state instead of a clean default. validateSettings won't catch
    // it either — a mutated object still passes its type test.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings, key)) {
            extensionSettings[key] = (value && typeof value === 'object') ? structuredClone(value) : value;
        }
    }

    migrateLegacySettings(extensionSettings);

    validateSettings(extensionSettings);

    if (resetClobberedEnabled && !extensionSettings.enabled) {
        addDebugLog('fail', 'Pipeline DISABLED by corrupt-settings reset (was enabled before reset)');
    }

    let path = `scripts/extensions/third-party/${EXTENSION_NAME}`;
    let html = null;

    try {
        html = await $.get(`${path}/templates/settings.html`);
    } catch {
        path = `scripts/extensions/${EXTENSION_NAME}`;
        try {
            html = await $.get(`${path}/templates/settings.html`);
        } catch {
            console.error('[BFMemory] Failed to load UI template');
            return;
        }
    }

    $('#extensions_settings').append(html);

    try {
        const manifest = await $.getJSON(`${path}/manifest.json`);
        if (manifest?.version) {
            $('#bf_mem_version').text(`v${manifest.version}`);
        }
    } catch (err) {
        console.warn('[BFMemory] Could not load manifest for version label:', err?.message);
    }

    setupTabs();

    if (freshInstall && typeof toastr !== 'undefined') {
        try {
            toastr.info(
                'Tick Enable, then pick a memory model for the background Memory Agent (a cheap one is fine).',
                'BF Memory — quick start',
                { timeOut: 12000, extendedTimeOut: 6000 },
            );
        } catch {  }
        addDebugLog('info', 'First-run install detected (disabled until user enables)', {
            subsystem: 'settings', event: 'settings.first_run', actor: 'SYSTEM',
        });
    }

    $('#bf_mem_enabled').prop('checked', extensionSettings.enabled).on('change', function () {
        const next = $(this).prop('checked');

        if (next !== extensionSettings.enabled) {
            addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} by user`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled' }, before: !!extensionSettings.enabled, after: !!next });
        }
        extensionSettings.enabled = next;
        updateStatus('idle');
        saveSettings();

        if (!next) {
            import('./pipeline.js')
                .then(({ cancelActiveRun }) => cancelActiveRun?.('disabled'))
                .catch(() => {  });
        }
    });

    reloadProfiles();
    $('#bf_mem_agent3_profile').val(extensionSettings.agent3Profile || '').on('change', function () {
        extensionSettings.agent3Profile = $(this).val() || '';
        addDebugLog('info', `Agent 3 profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent3Profile', value: extensionSettings.agent3Profile } });
        saveSettings();
    });

    // Both refresh buttons rebuild BOTH selects — the profile list is one list,
    // and a user who clicks refresh next to the lookup select is not asking for
    // half of it.
    $('#bf_mem_refresh_profiles, #bf_mem_refresh_profiles_lookup').on('click', () => {
        reloadProfiles();
        toastr.info('Profiles refreshed', 'BF Memory');
    });

    // --- The lookup pass (agent-lookup.js) ---------------------------------
    // The deadline label is written from the stored setting (below, with the
    // slider) rather than typed into the HTML, so the number the user reads is
    // the number the code enforces — a UI that quotes a stale value is the same
    // defect as a comment that does. LOOKUP_TIMEOUT_DEFAULT_MS is the fallback
    // for a settings object that predates the slider.
    $('#bf_mem_lookup_enabled').prop('checked', extensionSettings.lookupEnabled === true).on('change', function () {
        const before = extensionSettings.lookupEnabled === true;
        const next = $(this).prop('checked');
        extensionSettings.lookupEnabled = next;
        addDebugLog('info', `Lookup pass ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'lookupEnabled' }, before, after: !!next });
        saveSettings();
        // Re-arms the deadline-strike latch: someone who just changed this
        // setting (or the profile below it) is asking for another try, and
        // without this a session that switched itself off stays off until a chat
        // switch — with no visible reason, because the toast has long gone.
        import('./pipeline.js').then(({ resetLookupBreaker }) => resetLookupBreaker?.()).catch(() => {  });
    });

    $('#bf_mem_lookup_profile').val(extensionSettings.lookupProfile || '').on('change', function () {
        extensionSettings.lookupProfile = $(this).val() || '';
        addDebugLog('info', 'Lookup pass profile changed', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'lookupProfile', value: extensionSettings.lookupProfile } });
        saveSettings();
        import('./pipeline.js').then(({ resetLookupBreaker }) => resetLookupBreaker?.()).catch(() => {  });
    });

    // Deadline slider, in whole seconds. Raising it also re-arms the session
    // breaker: three strikes at 8s says nothing about whether 20s would have been
    // enough, and leaving the pass switched off after the user just widened the
    // budget would look broken.
    const lookupSecs = Math.round((Number(extensionSettings.lookupTimeoutMs) || LOOKUP_TIMEOUT_DEFAULT_MS) / 1000);
    $('#bf_mem_lookup_timeout').val(lookupSecs);
    $('#bf_mem_lookup_timeout_val').text(`${lookupSecs}s`);
    $('#bf_mem_lookup_timeout').on('input', function () {
        const secs = parseInt($(this).val(), 10);
        if (!Number.isFinite(secs)) return;
        const before = extensionSettings.lookupTimeoutMs;
        const after = secs * 1000;
        extensionSettings.lookupTimeoutMs = after;
        $('#bf_mem_lookup_timeout_val').text(`${secs}s`);
        if (before !== after) {
            addDebugLog('info', `Lookup deadline: ${Math.round(before / 1000)}s → ${secs}s`, {
                subsystem: 'settings', event: 'settings.changed', actor: 'USER',
                data: { key: 'lookupTimeoutMs' }, before, after,
            });
        }
        saveSettings();
        import('./pipeline.js').then(({ resetLookupBreaker }) => resetLookupBreaker?.()).catch(() => {  });
    });

    // Premise floor. The slider carries one extra position past 100 for
    // UNLIMITED (see premiseFloorToSliderPos); the stored value is 0 there, so
    // nothing downstream ever sees 101.
    const floorStored = extensionSettings[PREMISE_FLOOR_SETTING_KEY];
    $('#bf_mem_premise_floor').val(premiseFloorToSliderPos(floorStored));
    $('#bf_mem_premise_floor_val').text(premiseFloorLabel(floorStored));
    renderPremiseFloorCost(floorStored);
    $('#bf_mem_premise_floor').on('input', function () {
        const next = sliderPosToPremiseFloor($(this).val());
        const before = extensionSettings[PREMISE_FLOOR_SETTING_KEY];
        extensionSettings[PREMISE_FLOOR_SETTING_KEY] = next;
        $('#bf_mem_premise_floor_val').text(premiseFloorLabel(next));
        // Priced for the position under the user's thumb, not for the saved
        // value: the whole point of the readout is to show the bill BEFORE
        // letting go of the slider.
        renderPremiseFloorCost(next, { delay: 150 });
        if (before !== next) {
            addDebugLog('info', `Premise floor: ${premiseFloorLabel(before)} → ${premiseFloorLabel(next)} rows per sheet`, {
                subsystem: 'settings', event: 'settings.changed', actor: 'USER',
                data: { key: PREMISE_FLOOR_SETTING_KEY, unlimited: next === PREMISE_FLOOR_UNLIMITED },
                before, after: next,
            });
        }
        saveSettings();
    });

    $('#bf_mem_agent2_context').val(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context_val').text(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.agent2ContextMessages = val;
        $('#bf_mem_agent2_context_val').text(val);
        saveSettings();
    });

    $('#bf_mem_buffer_holdback').val(extensionSettings.bufferHoldBack);
    $('#bf_mem_buffer_holdback_val').text(extensionSettings.bufferHoldBack);
    $('#bf_mem_buffer_holdback').on('input', function () {
        const val = parseInt($(this).val(), 10);
        const before = extensionSettings.bufferHoldBack;
        extensionSettings.bufferHoldBack = val;
        $('#bf_mem_buffer_holdback_val').text(val);
        if (before !== val) addDebugLog('debug', `Buffer hold-back: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'bufferHoldBack' }, before, after: val });
        saveSettings();
    });

    $('#bf_mem_spine_batch').val(extensionSettings.spineBatchSize);
    $('#bf_mem_spine_batch_val').text(extensionSettings.spineBatchSize);
    $('#bf_mem_spine_batch').on('input', function () {
        const val = parseInt($(this).val(), 10);
        const before = extensionSettings.spineBatchSize;
        extensionSettings.spineBatchSize = val;
        $('#bf_mem_spine_batch_val').text(val);
        if (before !== val) addDebugLog('debug', `Story spine batch size: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'spineBatchSize' }, before, after: val });
        saveSettings();
    });

    $('#bf_mem_graph_extras').val(extensionSettings.graphExtrasCount);
    $('#bf_mem_graph_extras_val').text(extensionSettings.graphExtrasCount);
    $('#bf_mem_graph_extras').on('input', function () {
        const val = parseInt($(this).val(), 10);
        const before = extensionSettings.graphExtrasCount;
        extensionSettings.graphExtrasCount = val;
        $('#bf_mem_graph_extras_val').text(val);
        if (before !== val) addDebugLog('debug', `Graph extras count: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'graphExtrasCount' }, before, after: val });
        saveSettings();
    });

    $('#bf_mem_contradiction_scan').prop('checked', extensionSettings.contradictionScanEnabled !== false).on('change', function () {
        const before = extensionSettings.contradictionScanEnabled !== false;
        const next = $(this).prop('checked');
        extensionSettings.contradictionScanEnabled = next;
        addDebugLog('info', `Contradiction scan ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'contradictionScanEnabled' }, before, after: !!next });
        saveSettings();
    });

    $('#bf_mem_contradiction_interval').val(extensionSettings.contradictionInterval);
    $('#bf_mem_contradiction_interval_val').text(extensionSettings.contradictionInterval);
    $('#bf_mem_contradiction_interval').on('input', function () {
        const val = parseInt($(this).val(), 10);
        const before = extensionSettings.contradictionInterval;
        extensionSettings.contradictionInterval = val;
        $('#bf_mem_contradiction_interval_val').text(val);
        if (before !== val) addDebugLog('debug', `Contradiction scan interval: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'contradictionInterval' }, before, after: val });
        saveSettings();
    });

    $('#bf_mem_knownby_enforced').prop('checked', extensionSettings.enforceKnownBy !== false).on('change', function () {
        const before = extensionSettings.enforceKnownBy !== false;
        const next = $(this).prop('checked');
        extensionSettings.enforceKnownBy = next;
        addDebugLog('info', `knownBy enforcement ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enforceKnownBy' }, before, after: !!next });
        saveSettings();
    });

    $('#bf_mem_toast').prop('checked', extensionSettings.showToast).on('change', function () {
        extensionSettings.showToast = $(this).prop('checked');
        saveSettings();
    });

    $('#bf_mem_memory_prompt').val(extensionSettings.memoryPrompt || '').off('input').on('input', function () {
        extensionSettings.memoryPrompt = String($(this).val() || '').trim() ? String($(this).val()) : '';
        saveSettings();
    });

    $('#bf_mem_reset_memory_prompt').on('click', () => {
        extensionSettings.memoryPrompt = '';
        $('#bf_mem_memory_prompt').val('');
        addDebugLog('info', 'Memory Agent extra instructions cleared', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'memoryPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Memory Agent extra instructions cleared', 'BF Memory');
    });

    $('#bf_mem_memory_agent_prompt').val(extensionSettings.memoryAgentPrompt || DEFAULT_MEMORY_AGENT_PROMPT).off('input').on('input', function () {
        const v = String($(this).val() || '');
        extensionSettings.memoryAgentPrompt = (!v.trim() || v === DEFAULT_MEMORY_AGENT_PROMPT) ? '' : v;
        saveSettings();
        // Typing is exactly when a missing capability can appear or disappear.
        renderPromptStaleNotices();
    });

    $('#bf_mem_reset_memory_agent_prompt').on('click', () => resetPromptToDefault('memoryAgentPrompt', 'USER_RESET'));

    $('#bf_mem_reflect_agent_prompt').val(extensionSettings.reflectionPrompt || DEFAULT_REFLECT_PROMPT).off('input').on('input', function () {
        const v = String($(this).val() || '');
        extensionSettings.reflectionPrompt = (!v.trim() || v === DEFAULT_REFLECT_PROMPT) ? '' : v;
        saveSettings();
        renderPromptStaleNotices();
    });

    $('#bf_mem_reset_reflect_agent_prompt').on('click', () => resetPromptToDefault('reflectionPrompt', 'USER_RESET'));

    renderPromptStaleNotices();

    refreshDbProfileDropdown();

    $('#bf_mem_db_profile_load').on('click', async () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to load', 'BF Memory');
            return;
        }
        try {
            await loadDbProfile(selected);
        } catch (err) {
            addDebugLog('fail', `Load profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.load', actor: 'USER' });
            toastr.error('Failed to load profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_save').on('click', async () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select an existing profile to overwrite, or use "Save As New"', 'BF Memory');
            return;
        }
        try {
            await saveDbProfile(selected);
        } catch (err) {
            addDebugLog('fail', `Save profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to save profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_save_new').on('click', async () => {
        const name = prompt('Enter a name for this database profile:');
        if (!name || !name.trim()) return;
        const cleanName = name.trim();
        if (extensionSettings.dbProfiles?.[cleanName]) {
            if (!confirm(`Profile "${cleanName}" already exists. Overwrite?`)) return;
        }
        try {
            await saveDbProfile(cleanName);
        } catch (err) {
            addDebugLog('fail', `Save-as-new profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to save profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_new').on('click', async () => {
        const name = prompt('Name for the new (empty) memory database:');
        if (!name || !name.trim()) return;
        const cleanName = name.trim();
        if (extensionSettings.dbProfiles?.[cleanName]) {
            toastr.warning(`Profile "${cleanName}" already exists — pick another name`, 'BF Memory');
            return;
        }
        if (!confirm(`Create empty database "${cleanName}" and switch this chat to it?\n\nThis clears the current live facts from the working store (use "Save" / "Save As New" first if you want to keep them).`)) return;
        try {
            const { buildSkeletonDatabases, getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
            // wipe the live working store so the new DB genuinely starts empty
            cancelPendingSnapshot();
            const existing = await getAllDatabases();
            for (const category of Object.keys(existing)) await deleteDatabase(category);
            await flushSnapshotNow();
            // create the empty profile (same shape as the auto-create path)
            if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
            extensionSettings.dbProfiles[cleanName] = {
                databases: buildSkeletonDatabases(),
                savedAt: Date.now(),
                linkedChats: [],
            };
            extensionSettings.activeDbProfile = cleanName;
            // link the current chat so it auto-loads this DB next time
            const currentChatId = getCurrentChatId();
            if (currentChatId) {
                linkChatToProfile(cleanName, currentChatId);
                lastAutoLoadedChat = currentChatId;
            }
            saveSettings();
            refreshDbProfileDropdown();
            refreshLinkedChatsField();
            refreshDatabaseView();
            toastr.success(`Created empty database "${cleanName}"`, 'BF Memory');
            addDebugLog('info', `New empty DB profile created: "${cleanName}"${currentChatId ? ` + linked to chat ${currentChatId}` : ''}`, {
                subsystem: 'db', event: 'profile.saved', actor: 'USER', reason: 'NEW_EMPTY',
                data: { profileName: cleanName, linkedChat: currentChatId || null },
            });
        } catch (err) {
            addDebugLog('fail', `New DB profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to create database', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_delete').on('click', () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to delete', 'BF Memory');
            return;
        }
        deleteDbProfile(selected);
    });

    refreshLinkedChatsField();
    $('#bf_mem_db_profile_select').on('change', () => refreshLinkedChatsField());
    $('#bf_mem_db_linked_manage').on('click', () => showLinkedChatsPopup());

    $('#bf_mem_refresh_db').on('click', () => refreshDatabaseView());
    $('#bf_mem_view_web').on('click', () => showSpiderwebPopup());

    $('#bf_mem_db_unlink_current').on('click', () => unlinkCurrentChat());

    $('#bf_mem_clear_db').on('click', async () => {
        if (!confirm('Reset memory to EMPTY for this character? This wipes every stored fact across all storage layers. This cannot be undone.')) return;
        const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
        const dbs = await getAllDatabases();
        const clearedCats = Object.keys(dbs);
        const clearedFacts = Object.values(dbs).reduce((s, db) => s + (db.facts?.length || 0), 0);

        cancelPendingSnapshot();

        for (const category of clearedCats) {
            await deleteDatabase(category);
        }

        const { profilesPruned, factsPruned } = pruneActiveProfile(null);

        await saveCurrentToActiveProfile(null, { allowEmpty: true });

        await flushSnapshotNow();
        addDebugLog('pass', `Reset to empty: cleared ${clearedFacts} facts across ${clearedCats.length} categories + profile pruned`, {
            subsystem: 'db', event: 'db.cleared', actor: 'USER', reason: 'USER_CLEAR_ALL',
            data: {
                dbCount: clearedCats.length, totalFacts: clearedFacts, categories: clearedCats,
                profilesPruned, factsPrunedFromProfile: factsPruned,
            },
        });
        toastr.success('Memory reset to empty (all layers)', 'BF Memory');
        refreshDatabaseView();
    });

    $('#bf_mem_catchup_batch').val(extensionSettings.catchupBatchSize);
    $('#bf_mem_catchup_batch_val').text(extensionSettings.catchupBatchSize);
    $('#bf_mem_catchup_batch').on('input', function () {
        const val = parseInt($(this).val(), 10) || 8;
        const before = extensionSettings.catchupBatchSize;
        extensionSettings.catchupBatchSize = val;
        $('#bf_mem_catchup_batch_val').text(val);
        if (before !== val) addDebugLog('debug', `Catch-up batch size: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'catchupBatchSize' }, before, after: val });
        saveSettings();
    });

    $('#bf_mem_catchup_run').on('click', async () => {
        const btn = $('#bf_mem_catchup_run');
        const cancelBtn = $('#bf_mem_catchup_cancel');
        const progress = $('#bf_mem_catchup_progress');
        const progressText = $('#bf_mem_catchup_progress_text');
        const progressFill = $('#bf_mem_catchup_progress_fill');
        try {
            const { planCatchupChunks, runCatchupImport, isCatchupRunning } = await import('./catchup-import.js');
            if (isCatchupRunning()) {
                toastr.warning('A catch-up import is already running.', 'BF Memory');
                return;
            }

            const chat = getContext().chat || [];
            const { chunks, eligibleCount, totalMsgs } = planCatchupChunks(chat, extensionSettings.catchupBatchSize);
            if (chunks.length === 0) {
                toastr.info(`Nothing to catch up: all ${totalMsgs} message(s) are already done or trivially empty.`, 'BF Memory');
                return;
            }
            if (!confirm(`Catch-up import this chat in chunks?\n\nThis will make ~${chunks.length} LLM call(s) (one per chunk of ≤${extensionSettings.catchupBatchSize} messages; ${eligibleCount} unprocessed message(s) out of ${totalMsgs} total). Per-chunk prompts are bigger than per-message ones.\n\nDon't chat in this conversation while it runs. Proceed?`)) return;

            btn.prop('disabled', true).text('Importing...');
            cancelBtn.show().prop('disabled', false);
            progress.show();
            progressText.text('Starting…');
            progressFill.css('width', '0%');

            const result = await runCatchupImport({
                batchSize: extensionSettings.catchupBatchSize,
                onProgress: ({ chunk, chunks, msgsDone, msgsTotal, factsAdded }) => {
                    progressText.text(`Chunk ${chunk}/${chunks} · ${msgsDone}/${msgsTotal} messages · ${factsAdded} facts`);
                    progressFill.css('width', `${Math.round((chunk / Math.max(1, chunks)) * 100)}%`);
                },
            });
            if (result.refused) {
                progressText.text('Not started (see toast).');
                return;
            }
            const verb = result.cancelled ? 'cancelled' : result.aborted ? 'stopped' : 'finished';
            toastr.success(`Catch-up ${verb}: ${result.processedChunks}/${result.chunks} chunk(s), ${result.msgsDone} message(s), ${result.factsAdded} facts${result.failedChunks ? `, ${result.failedChunks} failed (re-run to retry)` : ''}`, 'BF Memory');
            progressText.text(`${verb}: ${result.processedChunks}/${result.chunks} chunks · ${result.msgsDone} msgs · ${result.factsAdded} facts`);
            refreshDatabaseView();
        } catch (err) {
            toastr.error(`Catch-up import failed: ${err.message || err}`, 'BF Memory');
            progressText.text(`Failed: ${err.message || err}`);
        } finally {
            btn.prop('disabled', false).html('<i class="fa-solid fa-forward-fast"></i> Catch-up import');
            cancelBtn.hide().prop('disabled', false).html('<i class="fa-solid fa-stop"></i> Cancel');
        }
    });

    $('#bf_mem_catchup_cancel').on('click', async () => {
        const { cancelCatchupImport } = await import('./catchup-import.js');
        if (cancelCatchupImport()) {

            $('#bf_mem_catchup_cancel').prop('disabled', true).text('Cancelling (finishing current chunk)…');
        }
    });

    $('#bf_mem_tokens_reset').on('click', () => {

        resetSessionTokens();
    });

    $('#bf_mem_health_recheck').on('click', () => renderHealthTab());

    // Auto-refresh: re-render the Health tab (when visible) after every recorded
    // health event — i.e. after each agent run/injection — instead of requiring
    // the Re-check button. The listener is debounced on the health.js side.
    import('./health.js').then(m => m.setHealthChangeListener(() => {
        const panel = document.getElementById('bf_mem_tab_health');
        if (panel && panel.style.display !== 'none') renderHealthTab();
    })).catch(() => {  });

    // Bridge liveness probe: one tiny request through the SAME transport the
    // background agents use (dedicated profile or main API). 15s cap — a probe
    // must answer fast or the bridge counts as asleep. The call outcome lands in
    // the 'agentCall' health event, so the row updates via the auto-refresh.
    $('#bf_mem_health_testconn').on('click', async function () {
        const btn = this;
        btn.disabled = true;
        try {
            const { callAgentLLM } = await import('./llm-call.js');
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(new DOMException('Connection test timed out after 15s', 'TimeoutError')), 15000);
            const reply = await callAgentLLM('Reply with the single word OK.', 'ping', extensionSettings.agent3Profile || null, 'health-ping', ctrl.signal);
            clearTimeout(timer);
            if (reply && reply.trim()) {
                toastr.success('Agent connection OK', 'BF Memory');
            } else {
                // callAgentLLM swallows transport errors into '' — the real error
                // is in the debug log and the Health row.
                toastr.error('Agent connection test failed — see the Health row / debug log', 'BF Memory');
            }
        } catch (err) {
            toastr.error(`Agent connection test failed: ${err?.message || err}`, 'BF Memory');
        } finally {
            btn.disabled = false;
            renderHealthTab();
        }
    });

    // Sent-prompt proof: copies the last generation's FULL post-injection
    // message array (role + text, after trim + sheet) as JSON. Clipboard-bound,
    // so nothing is HTML-escaped. Dynamic import — pipeline.js statically
    // imports this module, a static back-edge would close a cycle.
    $('#bf_mem_health_copy_prompt').on('click', async () => {
        try {
            const { getLastSentPrompt } = await import('./pipeline.js');
            const snap = getLastSentPrompt();
            if (!snap || !Array.isArray(snap.messages) || snap.messages.length === 0) {
                toastr.info('No generation captured yet this session', 'BF Memory');
                return;
            }
            await navigator.clipboard.writeText(JSON.stringify(snap.messages, null, 2));
            toastr.success(`Copied ${snap.messages.length} message(s) — post-injection prompt (${snap.path} path)`, 'BF Memory');
        } catch (err) {
            toastr.error(`Copy failed: ${err?.message || err}`, 'BF Memory');
        }
    });

    $('#bf_mem_debug').prop('checked', extensionSettings.debugMode).on('change', function () {
        extensionSettings.debugMode = $(this).prop('checked');
        saveSettings();
    });

    // The verbose LEVEL FILTER is usable whenever verbose entries can be SHOWN,
    // and addDebugLog admits them on either switch — so gating this control on
    // debugVerbose alone would hide every recorded trace behind a checkbox that
    // has nothing to do with recording.
    //
    // The third term is what keeps a stopped recording visible. Stopping only
    // stops new captures; the trace ring keeps what it holds until the chat
    // switch or reload (see the record switch below). Without this check the
    // stop handler would untick and disable verbose and the run the user just
    // recorded would vanish from the tab while still sitting in RAM and still
    // being downloadable — the same "stopping destroys the recording" trap in a
    // different disguise. getTraceEntries() copies 600 references at worst and
    // only runs on a switch change, not per render.
    //
    // Known and harmless: once the ring empties (chat switch, Clear, reload)
    // nothing re-runs this, so the checkbox stays enabled and simply matches
    // nothing. An enabled filter over an empty set beats a disabled one hiding
    // live data.
    const syncVerboseLevelControl = () => {
        const on = !!extensionSettings.debugVerbose || !!extensionSettings.debugTraceRun
            || getTraceEntries().length > 0;
        const vbox = document.querySelector('.bf-mem-log-level[value="verbose"]');
        const wrap = document.getElementById('bf_mem_log_level_verbose_wrap');
        if (vbox) { vbox.disabled = !on; if (!on) vbox.checked = false; }
        if (wrap) wrap.classList.toggle('bf-mem-disabled', !on);
    };
    $('#bf_mem_debug_verbose').prop('checked', extensionSettings.debugVerbose).on('change', function () {
        extensionSettings.debugVerbose = $(this).prop('checked');
        saveSettings();
        syncVerboseLevelControl();
        renderDebugLog();
    });

    // "Testlauf aufzeichnen". This one setting is the whole record switch:
    // isTraceRecording() reads it directly, so every capture site in every agent
    // module goes live the moment it flips, with no re-registration.
    //
    // Turning it OFF stops new captures AND NOTHING ELSE. It deliberately does
    // not drop any buffer: the toast below promises the run is still
    // downloadable after stopping, and record → stop → download is the workflow
    // this UI teaches. Clearing the injected-sheet ring here (as this handler
    // used to) emptied `memory.sheetHistory` in the export — the one block whose
    // note says "every sheet injected while recording was on" — for exactly the
    // user who followed that instruction.
    //
    // So both RAM buffers now have one lifetime, and it is the one the toast and
    // the hint text state: the trace ring and the sheet ring are dropped together
    // on a chat switch (reloadDebugLogFromChat / reloadSheetFromChat) and by a
    // page reload. Cost of holding the sheet ring to the end of the session is
    // capped at 50 × 12000 chars ≈ 600 KB — a rounding error next to the trace
    // ring's own ceiling, and not worth losing the data over.
    $('#bf_mem_trace_run').prop('checked', extensionSettings.debugTraceRun).on('change', function () {
        const on = $(this).prop('checked');
        extensionSettings.debugTraceRun = on;
        saveSettings();
        syncVerboseLevelControl();
        addDebugLog('info', `Test-run recording ${on ? 'STARTED' : 'STOPPED'}`, {
            subsystem: 'settings', event: 'settings.changed', actor: 'USER',
            data: { key: 'debugTraceRun' }, before: !on, after: on,
        });
        if (on) {
            // Starting a recording and then seeing nothing in the log is the
            // obvious trap: the captures ARE landing, they are just filtered out
            // by default. Verbose is the only level trace entries are emitted at,
            // so ticking it here is what makes them visible at all.
            const vbox = document.querySelector('.bf-mem-log-level[value="verbose"]');
            if (vbox && !vbox.checked) vbox.checked = true;
        }
        renderDebugLog();
        if (extensionSettings.showToast !== false && typeof toastr !== 'undefined') {
            toastr.info(on
                ? 'Recording a test run — RAM only, lost on reload or chat switch. Download it before you leave this chat.'
                : 'Recording stopped. The captured run is still downloadable until you reload or switch chats.', 'BF Memory');
        }
    });
    syncVerboseLevelControl();

    $(document).on('change', '.bf-mem-log-level', () => renderDebugLog());

    // Trace entries are emitted at verbose level, so picking "Trace (test run)"
    // while verbose is unticked filters the tab down to exactly nothing — two
    // controls that have to agree, with no hint that they do. Make the dropdown
    // say what it promises.
    $('#bf_mem_log_subsystem').on('change', function () {
        if (this.value === 'trace') {
            const vbox = document.querySelector('.bf-mem-log-level[value="verbose"]');
            if (vbox && !vbox.disabled && !vbox.checked) vbox.checked = true;
        }
        renderDebugLog();
    });

    // Debounced, unlike the two selects above. renderDebugLog() rebuilds the
    // whole visible list, and with a search term set entryMatchesFilter
    // stringifies every ORDINARY entry's `data` on every pass — trace payloads
    // are memoised in debug-log.js because they are frozen snapshots, ordinary
    // ones are held by reference and their callers mutate them, so they cannot
    // be. Rendering per keystroke ran that over the whole ring once per letter.
    // One render per pause instead; 150 ms is below the threshold where a filter
    // box feels laggy.
    let logSearchRenderTimer = null;
    $('#bf_mem_log_search').on('input', () => {
        clearTimeout(logSearchRenderTimer);
        logSearchRenderTimer = setTimeout(() => renderDebugLog(), 150);
    });

    $('#bf_mem_clear_log').on('click', () => clearDebugLog());

    $('#bf_mem_copy_all').on('click', () => copyDiagnostics());

    // Full test-run export. Download-only and potentially multi-MB, so the
    // button is disabled for the duration — a second click while the first is
    // still assembling would build the whole payload twice.
    $('#bf_mem_export_testrun').on('click', async function () {
        const btn = this;
        btn.disabled = true;
        try { await downloadTestRunExport(); }
        catch (err) { toastr.error(`Test-run export failed: ${err?.message || err}`, 'BF Memory'); }
        finally { btn.disabled = false; }
    });

    $('#bf_mem_export_json').on('click', async () => {
        const json = exportLogsJSON();
        let chatId = 'log';
        try { chatId = String(getContext().chatId ?? 'log'); } catch {  }
        const fname = `bf-mem-log-${chatId}-${Date.now()}.json`;

        try {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {  }

        try {
            await navigator.clipboard.writeText(json);
            toastr.success(`Log JSON downloaded + copied (${getDebugLogEntries().length} entries)`, 'BF Memory');
        } catch {
            toastr.success(`Log JSON downloaded (${getDebugLogEntries().length} entries)`, 'BF Memory');
        }
    });

    const runProbe = async () => {
        const input = document.getElementById('bf_mem_probe_key');
        const out = document.getElementById('bf_mem_probe_result');
        if (!out) return;
        const key = (input?.value || '').trim();
        if (!key) { out.textContent = 'Enter a fact key (e.g. Status/location) to probe.'; return; }
        out.textContent = 'Checking…';
        try {
            const res = await explainFactRetrieval(key);
            const detail = res.detail ? safeStringify(res.detail) : '';
            out.innerHTML =
                `<span class="bf-mem-probe-reason ${res.found ? 'found' : 'missing'}">${escapeHtml(res.reason || 'unknown')}</span> ` +
                `<span class="bf-mem-probe-detail">${escapeHtml(detail)}</span>`;
        } catch (err) {
            out.textContent = `Probe failed: ${err?.message || err}`;
        }
    };
    $('#bf_mem_probe_btn').on('click', runProbe);
    $('#bf_mem_probe_key').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runProbe(); } });

    $('#bf_mem_copy_log').on('click', async () => {
        const logText = exportLogs();
        try {
            await navigator.clipboard.writeText(logText);
            toastr.success('Logs copied to clipboard', 'BF Memory');
        } catch {

            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1a1a2e);padding:16px;border-radius:8px;max-width:600px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:8px;';
            const title = document.createElement('div');
            title.textContent = 'Copy debug log';
            title.style.cssText = 'font-weight:bold;color:#7bb3ff;';
            const hint = document.createElement('div');
            hint.textContent = 'Long-press the text area to Select All, then Copy.';
            hint.style.cssText = 'font-size:12px;opacity:0.7;';
            const textarea = document.createElement('textarea');
            textarea.value = logText;
            textarea.readOnly = true;
            textarea.style.cssText = 'width:100%;min-height:200px;flex:1;font-family:monospace;font-size:11px;background:#000;color:#eee;padding:8px;';
            const buttonRow = document.createElement('div');
            buttonRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            const selectAllBtn = document.createElement('button');
            selectAllBtn.textContent = 'Select All';
            selectAllBtn.className = 'menu_button';
            selectAllBtn.onclick = () => { textarea.select(); textarea.setSelectionRange(0, textarea.value.length); };
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.className = 'menu_button';
            closeBtn.onclick = () => overlay.remove();
            buttonRow.appendChild(selectAllBtn);
            buttonRow.appendChild(closeBtn);
            card.appendChild(title);
            card.appendChild(hint);
            card.appendChild(textarea);
            card.appendChild(buttonRow);
            overlay.appendChild(card);
            document.body.appendChild(overlay);

            setTimeout(() => { textarea.focus(); textarea.select(); }, 0);
        }
    });

    context.eventSource?.on(context.eventTypes?.CONNECTION_PROFILE_LOADED, () => reloadProfiles());

    context.eventSource?.on(context.eventTypes?.CHAT_CHANGED, async () => {

        const fromChatId = _lastChatId;
        const toChatId = getCurrentChatId();

        if (fromChatId && fromChatId !== toChatId) {
            addDebugLog('info', `Leaving chat ${fromChatId} (active profile "${extensionSettings?.activeDbProfile || ''}")`, {
                subsystem: 'db', event: 'db.disconnect', actor: 'SYSTEM',
                data: {
                    chatId: fromChatId,
                    activeProfile: extensionSettings?.activeDbProfile || null,
                    isBranch: isBranchChat(fromChatId),
                },
            });
        }

        addDebugLog('info', `Chat switch: ${fromChatId || '(none)'} -> ${toChatId || '(none)'}`, {
            subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM',
            data: { from: fromChatId || null, to: toChatId || null, isBranch: isBranchChat(toChatId) },
        });

        await flushOutgoingChatLog();

        try {
            const { flushSnapshotNow, invalidateDatabaseCache } = await import('./database.js');
            const outgoingAvatar = getContext()?.characters?.[getContext()?.characterId]?.avatar || null;
            await flushSnapshotNow({ avatar: outgoingAvatar, reconcileDeletes: false });

            invalidateDatabaseCache();
            addDebugLog('debug', `Coordinated flush before autoload (outgoing avatar pinned)`, {
                subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM', reason: 'COORDINATED_FLUSH',
                data: { from: fromChatId || null, to: toChatId || null, avatar: outgoingAvatar || null },
            });
        } catch (e) {
            console.error('[BFMemory] coordinated chat-switch flush failed', e);
        }

        // Feature 3: on a genuinely NEW chat (not a branch, not already linked, not explicitly
        // unlinked) let the user choose the DB profile BEFORE autoSaveDbProfile could
        // auto-create/clobber. Branches keep the current auto-inherit behavior.
        let handledByPicker = false;
        if (
            toChatId &&
            fromChatId !== toChatId &&
            toChatId !== lastAutoLoadedChat &&
            !isBranchChat(toChatId) &&
            !isChatUnlinked(toChatId) &&
            findProfileForChat(toChatId) === null
        ) {
            handledByPicker = await promptNewChatDbChoice(toChatId);
        }

        if (!handledByPicker) {
            await autoSaveDbProfile();
        }

        reloadDebugLogFromChat();
        reloadFactsFromChat();
        reloadTokensFromChat();
        reloadReflectionFromChat();
        reloadPyramidFromChat();
        reloadSheetFromChat();
        reloadStorySpineFromChat();
        reloadSceneFromChat();

        refreshDatabaseView();

        _lastChatId = toChatId;
    });

    _lastChatId = getCurrentChatId();

    reloadDebugLogFromChat();
    reloadFactsFromChat();
    reloadTokensFromChat();
    reloadReflectionFromChat();
    reloadPyramidFromChat();
    reloadSheetFromChat();
    reloadStorySpineFromChat();
    reloadSceneFromChat();

    refreshDatabaseView();

    window.addEventListener('beforeunload', () => {

        const profileName = extensionSettings?.activeDbProfile;
        if (profileName && extensionSettings?.dbProfiles?.[profileName]) {

            saveSettings();
        }

        flushDebugLogNow();

        import('./database.js').then(m => m.flushSnapshotNow?.({ reconcileDeletes: false })).catch(() => {});
    });

    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
