// BF Memory Pipeline - usability presets (F-UX-8 split from settings.js)
// C1 presets (Cheap · Balanced · Max Recall · Custom): the governed-key signatures, preset
// detection, and apply logic. The _applyingPreset flag moved here WITH applyPreset (its only
// writer); settings.js reads it through isApplyingPreset().
//
// NOTE on cycles: the static import from settings.js below is an intentional ESM cycle; every
// use is inside a function body at CALL time, which ESM resolves via hoisted declarations.

import { addDebugLog } from './debug-log.js';
import { getSettings, saveSettings, validateSettings } from './settings.js';

// =============================================================================
// C1 — USABILITY PRESETS (Cheap · Balanced · Max Recall)
// -----------------------------------------------------------------------------
// One dropdown that maps a single choice onto the many token/retrieval knobs, so a new user
// doesn't have to understand ~40 settings. This is ALSO the delivery vehicle for the token
// cuts (Parts A/B): "Cheap" flips on history-trimming, turns on the pull-on-demand recall
// tool, and tightens the injection caps. Everything else stays under the existing per-tab
// controls ("Advanced").
//
// DESIGN: a preset only writes the keys listed in GOVERNED_KEYS — never `enabled`, never the
// connection profiles, never prompts. Detection compares ONLY those keys, so a user's unrelated
// tweaks never force the dropdown to "Custom". Applying validates+saves through the SAME paths a
// manual edit uses, re-syncs the on-screen controls, and re-syncs the optional Writer tools.
// =============================================================================

export const PRESET_IDS = new Set(['cheap', 'balanced', 'maxrecall', 'custom']);

// The exact knobs a preset governs. Detection + apply both operate on ONLY these keys.
const GOVERNED_KEYS = [
    'agent2ContextMessages',
    'enableSummaryPyramid', 'enableWriterRecallTool',
    'retrievalTokenBudget', 'finderAnchorsPerCharacter',
    'reflectionInterval', 'reentryMomentCount',
];

// Preset signatures.
const PRESETS = {
    // CHEAP — fewest tokens: trim history so facts replace old turns, lean on the
    // pull-on-demand recall tool + a small overview, tight caps, consolidate less often.
    cheap: {
        agent2ContextMessages: 10,
        enableSummaryPyramid: true,
        enableWriterRecallTool: true,
        retrievalTokenBudget: 300,
        finderAnchorsPerCharacter: 2,
        reflectionInterval: 20,
        reentryMomentCount: 2,
    },
    // BALANCED — the recommended default: modest history trim, overview + recall tool on,
    // default caps.
    balanced: {
        agent2ContextMessages: 10,
        enableSummaryPyramid: true,
        enableWriterRecallTool: true,
        retrievalTokenBudget: 800,
        finderAnchorsPerCharacter: 3,
        reflectionInterval: 12,
        reentryMomentCount: 3,
    },
    // MAX RECALL — quality over cost: full history (no trim), wide caps, more anchors, frequent
    // consolidation. The most expensive option.
    maxrecall: {
        agent2ContextMessages: 0,
        enableSummaryPyramid: true,
        enableWriterRecallTool: true,
        retrievalTokenBudget: 1600,
        finderAnchorsPerCharacter: 4,
        reflectionInterval: 10,
        reentryMomentCount: 3,
    },
};

/** Human label for a preset id (dropdown + toasts). */
function presetLabel(id) {
    return ({ cheap: 'Cheap', balanced: 'Balanced', maxrecall: 'Max Recall', custom: 'Custom' })[id] || 'Custom';
}

/**
 * Which preset (if any) the CURRENT settings match — compares ONLY GOVERNED_KEYS so unrelated
 * tweaks never force 'custom'. Returns a preset id or 'custom'. Pure read; never mutates.
 * @returns {string}
 */
export function detectPreset() {
    for (const [id, sig] of Object.entries(PRESETS)) {
        let match = true;
        for (const k of GOVERNED_KEYS) {
            // Compare loosely against the signature; booleans use the same "!== false"/"=== true"
            // truth the rest of the code uses so legacy/undefined values still match cleanly.
            const want = sig[k];
            const have = getSettings()[k];
            const eq = (typeof want === 'boolean')
                ? (!!have === want)
                : (Number(have) === Number(want));
            if (!eq) { match = false; break; }
        }
        if (match) return id;
    }
    return 'custom';
}

// Set true WHILE applyPreset() is writing, so the "manual edit → Custom" delegated listener
// (wired in initSettings) doesn't fire on our own programmatic control updates.
let _applyingPreset = false;

/**
 * Push the governed settings values onto their on-screen controls (range/checkbox + value labels).
 * jQuery no-ops on a missing selector, so this is safe even if a control isn't in the DOM yet.
 */
function syncPresetControls() {
    $('#bf_mem_pyramid_enabled').prop('checked', getSettings().enableSummaryPyramid === true);
    $('#bf_mem_recall_tool_enabled').prop('checked', getSettings().enableWriterRecallTool === true);
    $('#bf_mem_agent2_context').val(getSettings().agent2ContextMessages);
    $('#bf_mem_agent2_context_val').text(getSettings().agent2ContextMessages);
    $('#bf_mem_reflection_interval').val(getSettings().reflectionInterval);
    $('#bf_mem_reflection_interval_val').text(getSettings().reflectionInterval);
    // Retrieval token budget (F-UX-4): governed AND on-screen (Writer tab), so keep it in sync.
    $('#bf_mem_retrieval_budget').val(getSettings().retrievalTokenBudget);
    $('#bf_mem_retrieval_budget_val').text(getSettings().retrievalTokenBudget);
    // Re-entry shared-moment count: governed AND on-screen (relationship re-entry pack section).
    $('#bf_mem_reentry_moments').val(getSettings().reentryMomentCount);
    $('#bf_mem_reentry_moments_val').text(getSettings().reentryMomentCount);
    // NOTE: finderAnchorsPerCharacter is governed by presets but has NO on-screen control
    // (no slider in settings.html) — nothing to sync for it. It's still written by
    // applyPreset() and consumed by the pipeline; it simply can't be hand-edited from the
    // UI, so it can never drift a preset to "Custom".
}

/**
 * Apply a preset by id: write ONLY the governed keys, validate+save through the normal path,
 * re-sync the on-screen controls, re-sync the optional Writer recall tool (its registration is a
 * side-effect of enableWriterRecallTool), update the dropdown, and toast. 'custom' is a no-op
 * write (just records the id). Fully guarded — never throws into the caller.
 * @param {string} id
 */
export function applyPreset(id) {
    if (!PRESET_IDS.has(id)) id = 'custom';
    const sig = PRESETS[id];
    _applyingPreset = true;
    try {
        const before = {};
        if (sig) {
            for (const k of GOVERNED_KEYS) { before[k] = getSettings()[k]; getSettings()[k] = sig[k]; }
        }
        getSettings().uiPreset = id;
        validateSettings(getSettings());
        saveSettings();
        syncPresetControls();
        $('#bf_mem_preset').val(id);
        addDebugLog('info', `Applied "${presetLabel(id)}" preset`, {
            subsystem: 'settings', event: 'settings.preset', actor: 'USER',
            data: { preset: id, governed: sig ? GOVERNED_KEYS.reduce((o, k) => (o[k] = getSettings()[k], o), {}) : null, before: sig ? before : null },
        });
        // The recall tool registers/unregisters as a side-effect of enableWriterRecallTool — sync it
        // the same way the manual toggle handler does (dynamic import avoids a static cycle).
        if (sig) {
            import('./agent-writer.js')
                .then(({ syncWriterRecallTool }) => syncWriterRecallTool?.())
                .catch(() => { /* tool API not ready — will sync on next init */ });
        }
        if (sig && typeof toastr !== 'undefined') {
            toastr.success(`Memory preset: ${presetLabel(id)}`, 'BF Memory', { timeOut: 2500 });
        }
    } catch (err) {
        addDebugLog('fail', `Applying preset "${id}" failed (non-fatal): ${err?.message || err}`);
    } finally {
        _applyingPreset = false;
    }
}

/**
 * True while applyPreset() is programmatically writing the governed controls. Read by the
 * delegated "manual edit → Custom" listener wired in settings.js initSettings (the flag moved
 * here with applyPreset, its only writer — F-UX-8 split).
 */
export function isApplyingPreset() {
    return _applyingPreset;
}
