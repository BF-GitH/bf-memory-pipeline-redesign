// BF Memory Pipeline - First-run onboarding wizard (redesign-v2)
// A short 3-step guided setup shown ONCE on first run (finish OR skip both mark it done —
// it never nags twice). Reopen any time via "Re-run setup guide" in the General tab.
//
// DESIGN: every settings write is routed through the REAL on-screen control
// (.val(...).trigger('change')) so the EXISTING change handlers do the persist + debug-log
// + side-effects — the wizard never invents a second write path. Fully guarded: a wizard
// failure can never break extension load.

import { getSettings, addDebugLog } from './settings.js';
import { saveSettingsDebounced } from './host.js';

const OVERLAY_ID = 'bf_mem_onboarding_overlay';

/** Persist onboardingDone=true through the normal settings save path. Never throws. */
function markDone(how) {
    try {
        const s = getSettings();
        if (s && s.onboardingDone !== true) {
            s.onboardingDone = true;
            saveSettingsDebounced();
        }
        addDebugLog('info', `Onboarding ${how}`, {
            subsystem: 'settings', event: 'settings.onboarding', actor: 'USER', data: { how },
        });
    } catch { /* best-effort */ }
}

/**
 * Apply a wizard choice via the real settings control (same code path as a manual edit).
 * Falls back to a direct settings write only if the control isn't in the DOM.
 */
function applyViaControl(selector, value, settingsKey) {
    try {
        const el = document.querySelector(selector);
        if (el && typeof $ !== 'undefined') {
            if ($(el).val() !== value) $(el).val(value).trigger('change');
            return;
        }
        const s = getSettings();
        if (s && settingsKey && s[settingsKey] !== value) {
            s[settingsKey] = value;
            saveSettingsDebounced();
        }
    } catch { /* a failed apply must never break the wizard */ }
}

/** Build the 3 step definitions against the CURRENT settings. */
function buildSteps() {
    // Memory-agent profile options are CLONED from the live select (populated by the existing
    // reloadProfiles() helper), so the wizard always matches the real dropdown — including
    // the "-- Use default profile --" blank option.
    const scribeSelect = document.getElementById('bf_mem_agent3_profile');
    const scribeOptions = scribeSelect
        ? scribeSelect.innerHTML
        : '<option value="">-- Use default profile --</option>';

    return [
        {
            title: 'Welcome to BF’s Memory Pipeline',
            body: `
                <p>A background Memory Agent watches your chat and, after each reply, saves the lasting facts — names, promises, injuries, secrets — and keeps a compact <b>memory sheet</b> up to date.</p>
                <p>Before each reply, that memory sheet is handed to your AI automatically (pure code — it never slows the reply down), so characters remember things from hundreds of messages ago.</p>
                <p><b>Nothing here changes your main model or presets.</b></p>`,
        },
        {
            title: 'Which AI runs the Memory Agent?',
            body: `
                <p>The Memory Agent runs as separate, small background calls after each reply — a fast, cheap model is perfectly fine here and saves money. Leave the default to just use your normal AI.</p>
                <select id="bf_mem_ob_scribe" class="text_pole" style="width:100%;">${scribeOptions}</select>`,
            apply(card) {
                const sel = card.querySelector('#bf_mem_ob_scribe');
                if (sel) applyViaControl('#bf_mem_agent3_profile', sel.value || '', 'agent3Profile');
            },
        },
        {
            title: 'You’re set. Where to look while it runs:',
            body: `
                <ul class="bf-mem-onboarding-list">
                    <li><b>🧠 Brain icon on messages</b> — click to see the facts saved from that message (free). Shift+click re-extracts (makes an AI call).</li>
                    <li><b>Database tab</b> — browse, search, and graph everything the agent has stored; import an existing long chat with the catch-up import.</li>
                    <li><b>/bfmem</b> — slash-command quick controls (status, on/off, search, catch-up).</li>
                    <li><b>Review popup</b> — every so often it shows the facts it saved so you can fix or delete any that are wrong (Review Interval; 0 = never show it).</li>
                </ul>`,
        },
    ];
}

/**
 * Show the wizard. force=true reopens it even after it was completed (the re-run button).
 * @param {boolean} force
 */
export function showOnboarding(force = false) {
    try {
        const s = getSettings();
        if (!s) return;
        if (!force && s.onboardingDone === true) return;
        if (document.getElementById(OVERLAY_ID)) return; // already open

        const steps = buildSteps();
        let step = 0;

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        const card = document.createElement('div');
        card.className = 'bf-mem-review-popup bf-mem-onboarding';
        overlay.appendChild(card);

        const close = (how) => { markDone(how); overlay.remove(); };

        const render = () => {
            const st = steps[step];
            const last = step === steps.length - 1;
            card.innerHTML = `
                <h3>${st.title}</h3>
                <div class="bf-mem-onboarding-progress">Step ${step + 1} of ${steps.length}</div>
                <div class="bf-mem-onboarding-body">${st.body}</div>
                <div class="bf-mem-review-actions">
                    ${step > 0 ? '<button id="bf_mem_ob_back" class="menu_button">Back</button>' : ''}
                    ${last ? '' : '<button id="bf_mem_ob_skip" class="menu_button">Skip</button>'}
                    <button id="bf_mem_ob_next" class="menu_button">${last ? 'Start chatting' : 'Next'}</button>
                </div>`;
            card.querySelector('#bf_mem_ob_back')?.addEventListener('click', () => { step--; render(); });
            card.querySelector('#bf_mem_ob_skip')?.addEventListener('click', () => close('skipped'));
            card.querySelector('#bf_mem_ob_next')?.addEventListener('click', () => {
                try { steps[step].apply?.(card); } catch { /* apply is best-effort */ }
                if (step === steps.length - 1) { close('finished'); return; }
                step++;
                render();
            });
        };

        // Backdrop click closes AND marks done (same contract as Skip — never nag twice).
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close('dismissed'); });

        render();
        document.body.appendChild(overlay);
    } catch (err) {
        console.error('[BFMemory] onboarding failed (non-fatal):', err);
    }
}

/** Show the wizard only if it has never been finished/skipped. */
export function maybeShowOnboarding() {
    try {
        const s = getSettings();
        if (s && s.onboardingDone !== true) showOnboarding(false);
    } catch { /* best-effort */ }
}
