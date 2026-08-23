function computeNowContext() {
    let msgIndex = null;
    try {
        const chat = SillyTavern.getContext()?.chat;
        if (Array.isArray(chat) && chat.length > 0) msgIndex = chat.length - 1;
    } catch {  }
    return { msgIndex, storyNowMs: null };
}

let _turnCtxKey = '';
let _turnCtx = null;

export function getTurnNowContext() {
    let chatLen = -1;
    try {
        const chat = SillyTavern.getContext()?.chat;
        if (Array.isArray(chat)) chatLen = chat.length;
    } catch {  }
    const key = `${chatLen}|${Math.floor(Date.now() / 30000)}`;
    if (_turnCtx && _turnCtxKey === key) return _turnCtx;
    _turnCtxKey = key;
    _turnCtx = computeNowContext();
    return _turnCtx;
}

export function recencyTail(fact, nowCtx) {
    if (!fact || !nowCtx) return '';
    let phrase = '';

    if (!phrase && fact.validAt != null && Number.isInteger(nowCtx.msgIndex)) {
        const validAt = Number(fact.validAt);
        if (Number.isInteger(validAt)) {
            const delta = nowCtx.msgIndex - validAt;
            if (delta >= 0) {
                const turns = Math.ceil(delta / 2);
                phrase = turns <= 0 ? 'this turn' : `~${turns} turn${turns === 1 ? '' : 's'} ago`;
            }
        }
    }
    if (!phrase) return '';

    return ` (${phrase})`;
}

export function splitInjectionSections(results) {
    const state = [];
    const chrono = [];
    for (const r of (results || [])) {
        const kind = String(r?.fact?.kind ?? '').toLowerCase();
        if (kind === 'event' || kind === 'moment') chrono.push(r);
        else state.push(r);
    }

    chrono.sort((a, b) => {
        const av = Number.isFinite(Number(a?.fact?.validAt)) && a?.fact?.validAt != null ? Number(a.fact.validAt) : -1;
        const bv = Number.isFinite(Number(b?.fact?.validAt)) && b?.fact?.validAt != null ? Number(b.fact.validAt) : -1;
        return av - bv;
    });
    return { state, chrono };
}

// ===========================================================================
// SHEET BUDGET — a character cap per sheet section, user settings.
//
// Why a budget and not just a smaller floor: the premise floor counts ROWS, and
// a row's size is whatever the store wrote into it. On the 0.83.0 150-turn runs
// (469-fact store) the fact sections alone were 21-23 k chars and "Story so
// far:" 34 k — the cap the slider promised said nothing about what a turn cost.
// Each value is chars (≈ tokens x 4, the chars/4 convention used everywhere
// else here). Defaults: facts 8000 (~2 k tokens), chronology/scene/story 2000
// (~0.5 k each), head 700 (~0.17 k — room for SUMMARY_MAX_CHARS +
// TIMELINE_MAX_CHARS, i.e. what runHeadCall's caps already allow; the budget
// is the deterministic backstop for a prior-head fallback, not the primary cap).
//
// Lives in this leaf module (no imports) so settings.js can read the defaults
// inside its DEFAULT_SETTINGS literal: a leaf module is fully evaluated before
// any importer's body runs, cycle or not — the temporal-dead-zone trap that
// forced `premiseFloorMax: undefined` does not exist here. No UI yet; the
// settings keys are the contract a slider can bind to later.
//
// SETTINGS CONTRACT: one numeric key per section, clamped to SHEET_BUDGET_CLAMP
// by validateSettings; absent / not a number -> the default.
export const SHEET_BUDGET_DEFAULT = Object.freeze({ facts: 8000, chronology: 2000, scene: 2000, story: 2000, head: 700 });
export const SHEET_BUDGET_SETTING_KEYS = Object.freeze({
    facts: 'sheetBudgetFacts',
    chronology: 'sheetBudgetChronology',
    scene: 'sheetBudgetScene',
    story: 'sheetBudgetStory',
    head: 'sheetBudgetHead',
});
// [min, max]. The minimums are what keeps a hand-edited 0 from producing a
// sheet with no facts at all; the maximums are "the whole store, rendered".
export const SHEET_BUDGET_CLAMP = Object.freeze({
    facts: [1000, 60000],
    chronology: [300, 20000],
    scene: [300, 10000],
    story: [300, 30000],
    head: [200, 3000],
});

// Resolves the five budgets off a settings object. `clamped` lists the sections
// whose stored value was out of range, so settings.js can log it the way it
// logs a clamped premise floor. Same type rule as resolvePremiseFloorCap: only
// a number or an all-numeric string is a value; anything else is "not set".
export function resolveSheetBudget(settings) {
    const out = { clamped: [] };
    for (const [section, key] of Object.entries(SHEET_BUDGET_SETTING_KEYS)) {
        const raw = settings?.[key];
        const numeric = typeof raw === 'number'
            || (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw)));
        const n = numeric ? Math.trunc(Number(raw)) : NaN;
        if (!numeric || Number.isNaN(n)) { out[section] = SHEET_BUDGET_DEFAULT[section]; continue; }
        const [lo, hi] = SHEET_BUDGET_CLAMP[section];
        const v = Math.min(hi, Math.max(lo, n));
        if (v !== n) out.clamped.push({ section, key, raw, value: v });
        out[section] = v;
    }
    return out;
}

export const STATE_SECTION_HEADER = 'CURRENT STATE — what is true RIGHT NOW; absolute truth, overrides CHRONOLOGY and anything older in the chat:';
// RESOLVED lifecycle: a fact whose tension the story has worked through stays on
// the sheet — the model still needs it as background — but it must stop shipping
// under the "true RIGHT NOW" header, which is what kept the measured run
// re-litigating settled conflicts every turn. Rendered as its own subsection
// directly below CURRENT STATE; deliberately NOT matching the fact-row grammar,
// so extractPriorStateLines closes the state block before these rows and no
// recheck verdict is ever owed on an already-resolved fact.
export const RESOLVED_SECTION_HEADER = 'RESOLVED (settled earlier — still true as background; do NOT re-open or re-litigate unprompted):';
export const CHRONO_SECTION_HEADER = 'CHRONOLOGY — past events and background, oldest first; context only, do NOT replay as happening now:';

export function buildPrecedencePreamble(nowCtx) {
    let current = '';
    if (nowCtx && Number.isInteger(nowCtx.msgIndex)) {
        current = ` — current: turn ~${Math.max(1, Math.ceil((nowCtx.msgIndex + 1) / 2))}`;
    }
    return `[Memory precedence${current}]`;
}
