// BF Memory Pipeline - First-run onboarding wizard
// A short 5-step guided setup shown ONCE on first run (finish OR skip both mark it done —
// it never nags twice). Reopen any time via "Re-run setup guide" in the General tab.
//
// DESIGN: every settings write is routed through the REAL on-screen control
// (.val(...).trigger('change')) so the EXISTING change handlers do the persist + debug-log
// + side-effects (e.g. applyPreset for the cost preset) — the wizard never invents a second
// write path. Fully guarded: a wizard failure can never break extension load.

import { getSettings, addDebugLog } from './settings.js';
import { saveSettingsDebounced } from './host.js';

const OVERLAY_ID = 'bf_mem_onboarding_overlay';

function esc(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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

/** Radio-group HTML for one step. */
function radios(name, options, current) {
    return options.map(o => `
        <label class="bf-mem-onboarding-choice">
            <input type="radio" name="${name}" value="${esc(o.value)}" ${o.value === current ? 'checked' : ''} />
            <span><b>${esc(o.label)}</b><br /><small>${o.hint}</small></span>
        </label>`).join('');
}

/** Build the 5 step definitions against the CURRENT settings. */
function buildSteps(s) {
    // Scribe profile options are CLONED from the live select (populated by the existing
    // reloadProfiles() helper), so the wizard always matches the real dropdown — including
    // the "-- Use default profile --" blank option.
    const scribeSelect = document.getElementById('bf_mem_agent3_profile');
    const scribeOptions = scribeSelect
        ? scribeSelect.innerHTML
        : '<option value="">-- Use default profile --</option>';

    const presetOptions = [
        { value: 'cheap', label: 'Cheap — fewest tokens', hint: 'Trims chat history shown to the AI, small fact budget (~300 tokens injected), tidies up less often.' },
        { value: 'balanced', label: 'Balanced — recommended', hint: 'Modest history trim with a medium fact budget (~800 tokens injected). A good starting point.' },
        { value: 'maxrecall', label: 'Max Recall — best memory, costs more', hint: 'Full chat history plus the widest fact budget (~1600 tokens injected). The most expensive option.' },
    ];
    // A user re-running the wizard with hand-tuned knobs gets an honest "keep mine" choice
    // instead of being silently bulk-reset to a preset.
    if (s.uiPreset === 'custom') {
        presetOptions.push({ value: 'custom', label: 'Custom — keep my current settings', hint: 'You have hand-tuned values. Picking this changes nothing.' });
    }

    return [
        {
            title: 'Welcome to BF’s Memory Pipeline',
            body: `
                <p>A note-taker AI watches your chat and saves the lasting facts after each reply — names, promises, injuries, secrets.</p>
                <p>Before each reply, the most relevant facts are automatically handed back to the AI within a small token budget, so characters remember things from hundreds of messages ago.</p>
                <p>If your main AI can call tools, it can also look things up mid-reply (<code>search_memory</code>) and pin new facts itself (<code>remember_fact</code>).</p>
                <p><b>Nothing here changes your main model or presets.</b></p>`,
        },
        {
            title: 'How should memory reach your AI?',
            body: `
                <p>Just want it to work? Leave <b>Hybrid</b> selected.</p>
                ${radios('bf_mem_ob_mode', [
                    { value: 'hybrid', label: 'Hybrid — recommended', hint: 'A small set of facts is injected each turn, and the AI looks up anything deeper itself. Fastest replies; needs a tool-calling AI (e.g. Claude).' },
                    { value: 'push', label: 'Push (classic)', hint: 'A planner AI picks the facts to inject every turn — one extra AI call per reply, but works with any model (no tool calling needed).' },
                    { value: 'tool-only', label: 'Tool-only', hint: 'The AI drives all recall through lookups. Honest note: right now this behaves the same as Hybrid.' },
                ], s.memoryMode || 'hybrid')}`,
            apply(card) {
                const v = card.querySelector('input[name="bf_mem_ob_mode"]:checked')?.value;
                if (v) applyViaControl('#bf_mem_memory_mode', v, 'memoryMode');
            },
        },
        {
            title: 'How much should it spend on recall?',
            body: `
                <p>One dial for cost vs. memory depth. You can fine-tune everything later in the settings tabs.</p>
                ${radios('bf_mem_ob_preset', presetOptions, s.uiPreset === 'custom' ? 'custom' : (s.uiPreset || 'balanced'))}`,
            apply(card) {
                const v = card.querySelector('input[name="bf_mem_ob_preset"]:checked')?.value;
                // Same code path as the real dropdown: trigger('change') -> applyPreset(id),
                // so all governed keys stay consistent. 'custom' is a no-op write there.
                if (v) applyViaControl('#bf_mem_preset', v, null);
            },
        },
        {
            title: 'Which AI takes the notes?',
            body: `
                <p>The note-taker (Scribe) runs as separate, small background calls after each reply — a fast, cheap model is perfectly fine here and saves money. Leave the default to just use your normal AI.</p>
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
                    <li><b>Debug tab → “What Claude did”</b> — shows every <code>search_memory</code> / <code>remember_fact</code> call the AI made, so you can see memory actually working.</li>
                    <li><b>Review popup</b> — every so often it shows the facts it saved so you can fix or delete any that are wrong (Scribe tab → Review Interval; 0 = never show it).</li>
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

        const steps = buildSteps(s);
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
