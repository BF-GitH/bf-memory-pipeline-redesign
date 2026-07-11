// BF Memory Pipeline - Injection recency & precedence helpers (community adoption Tier 1)
// Small, dependency-light module: computes the per-turn "now" anchors (message index, scene
// number, best-effort in-story date) and renders the compact per-fact recency tails plus the
// CURRENT STATE / CHRONOLOGY section split used by pipeline.js formatChosenFacts.
//
// CYCLE SAFETY: imports ONLY turn-state.js (getScene). fact-retrieval.js and pipeline.js import
// THIS module — never the other way round — so no new ESM cycles are introduced.
//
// FAIL-SOFT CONTRACT: every helper returns '' / null on missing or unparseable data. A legacy
// fact without `validAt` gets NO tail (never a wrong one), and a free-form `validFrom` like
// "the winter festival" that doesn't parse falls back to the turn-based phrase.

import { getScene } from './turn-state.js';

/**
 * Best-effort parse of a story-world date stamp ("2024-05-01", "May 3 2024", ISO, ...) into
 * epoch ms. Free-form labels that aren't dates return null. Never throws.
 * @param {*} str
 * @returns {number|null}
 */
export function parseStoryDate(str) {
    try {
        const s = String(str ?? '').trim();
        if (!s) return null;
        const ms = Date.parse(s);
        return Number.isFinite(ms) ? ms : null;
    } catch { return null; }
}

/**
 * Compute the current-turn "now" anchors the recency tails are measured against.
 *   - msgIndex: index of the NEWEST chat message (chat.length - 1), or null when no chat is
 *     available (mirrors the defensive chat-length read in agent-reflect.js).
 *   - sceneNo: the current scene card's number (turn-state getScene), or null.
 *   - storyNowMs: ALWAYS null here — the caller (pipeline.js formatChosenFacts) fills it as the
 *     max parseStoryDate over the visible facts' validFrom/validUntil, so no DB scan is needed.
 * @returns {{msgIndex: number|null, sceneNo: number|null, storyNowMs: number|null}}
 */
export function computeNowContext() {
    let msgIndex = null;
    try {
        const chat = SillyTavern.getContext()?.chat;
        if (Array.isArray(chat) && chat.length > 0) msgIndex = chat.length - 1;
    } catch { /* no chat context — tails that need it simply don't render */ }
    let sceneNo = null;
    try {
        const s = getScene();
        sceneNo = (s && s.sceneNo != null) ? s.sceneNo : null;
    } catch { sceneNo = null; }
    return { msgIndex, sceneNo, storyNowMs: null };
}

// Per-turn memo of the now-context so estimateInjectionTokens (fact-retrieval.js) and
// formatChosenFacts (pipeline.js) measure against the SAME object — the estimator must charge
// exactly the bytes the injected formatter emits (audit F-RETR-3 invariant). Keyed on chat
// length plus a coarse 30s timestamp bucket (mirroring the estimator's best-effort settings
// read): a new turn or a stale bucket recomputes; within one pipeline run every caller gets
// the identical object, so a storyNowMs filled by the formatter stays visible to later reads.
let _turnCtxKey = '';
let _turnCtx = null;

/**
 * Memoized computeNowContext() — the shared per-turn instance. Callers gate on the
 * `injectRecencyLabels` setting themselves and pass null when the feature is off.
 * @returns {{msgIndex: number|null, sceneNo: number|null, storyNowMs: number|null}}
 */
export function getTurnNowContext() {
    let chatLen = -1;
    try {
        const chat = SillyTavern.getContext()?.chat;
        if (Array.isArray(chat)) chatLen = chat.length;
    } catch { /* keyed as -1 — still memoizes within the time bucket */ }
    const key = `${chatLen}|${Math.floor(Date.now() / 30000)}`;
    if (_turnCtx && _turnCtxKey === key) return _turnCtx;
    _turnCtxKey = key;
    _turnCtx = computeNowContext();
    return _turnCtx;
}

/**
 * Compact "how long ago" tail for one injected fact line, e.g. ` (~3 turns ago, scene 2)`.
 * Returns '' when nothing is known (legacy facts without validAt get NO tail — never a wrong
 * one). The phrase is the turn phrase from validAt: delta = msgIndex - validAt, turns =
 * ceil(delta/2). A `, scene N` hop is appended only when the fact's sceneNo differs from the
 * current one. All phrases are hedged with `~` — validAt is a message index, so trimmed/branched
 * chats can overstate age; the tail is a hint, not a claim.
 * (redesign-v2 S1: the bi-temporal in-story phrase was removed; `biTemporalOn` is retained as a
 * now-ignored parameter for call-site compatibility and is always false.)
 * @param {Object} fact
 * @param {{msgIndex: number|null, sceneNo: number|null, storyNowMs: number|null}|null} nowCtx
 * @param {boolean} [biTemporalOn=false] - vestigial (always false); no longer consulted
 * @returns {string}
 */
export function recencyTail(fact, nowCtx, biTemporalOn = false) {
    if (!fact || !nowCtx) return '';
    let phrase = '';
    // redesign-v2 (S1): the opt-in in-story phrase (bi-temporal validFrom vs nowCtx.storyNowMs)
    // was removed with the biTemporal feature. `biTemporalOn` is now always false, so only the
    // turn-based phrase below is emitted; freeform validFrom stamps are no longer consulted.
    // Turn phrase from validAt (integer source message index; ~2 messages per turn).
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
    // Scene hop — only when the fact's scene and the current scene BOTH exist and differ.
    let sceneHop = '';
    const factScene = (fact.sceneNo != null) ? Number(fact.sceneNo) : null;
    if (factScene != null && Number.isFinite(factScene) && nowCtx.sceneNo != null && factScene !== Number(nowCtx.sceneNo)) {
        sceneHop = `, scene ${factScene}`;
    }
    return ` (${phrase}${sceneHop})`;
}

/**
 * Split chosen retrieval rows into the truth-hierarchy sections:
 *   - chrono: kind `event` / `moment` rows, stable-sorted ascending by validAt (missing → -1,
 *     so undated events lead) — CHRONOLOGY reads oldest-first.
 *   - state: everything else (kind state/trait AND kind-less legacy facts) in ORIGINAL order.
 * Deliberately conservative: only explicit event/moment kinds leave CURRENT STATE, so a legacy
 * fact can never be demoted to "context only" by a guess.
 * @param {Array<{fact: Object, category: string}>} results
 * @returns {{state: Array, chrono: Array}}
 */
export function splitInjectionSections(results) {
    const state = [];
    const chrono = [];
    for (const r of (results || [])) {
        const kind = String(r?.fact?.kind ?? '').toLowerCase();
        if (kind === 'event' || kind === 'moment') chrono.push(r);
        else state.push(r);
    }
    // Array.prototype.sort is stable — equal validAt rows keep their retrieval order.
    chrono.sort((a, b) => {
        const av = Number.isFinite(Number(a?.fact?.validAt)) && a?.fact?.validAt != null ? Number(a.fact.validAt) : -1;
        const bv = Number.isFinite(Number(b?.fact?.validAt)) && b?.fact?.validAt != null ? Number(b.fact.validAt) : -1;
        return av - bv;
    });
    return { state, chrono };
}

/** Section headers for the truth-hierarchy injection (pipeline.js formatChosenFacts). */
export const STATE_SECTION_HEADER = 'CURRENT STATE — what is true RIGHT NOW; absolute truth, overrides CHRONOLOGY and anything older in the chat:';
export const CHRONO_SECTION_HEADER = 'CHRONOLOGY — past events and background, oldest first; context only, do NOT replay as happening now:';

/**
 * One-line precedence preamble above the sectioned fact block (Summaryception-adapted wrapper):
 * `[Memory precedence — current: turn ~T, scene S]`. Turn/scene parts are omitted when unknown.
 * @param {{msgIndex: number|null, sceneNo: number|null}|null} nowCtx
 * @returns {string}
 */
export function buildPrecedencePreamble(nowCtx) {
    let current = '';
    if (nowCtx && Number.isInteger(nowCtx.msgIndex)) {
        current = ` — current: turn ~${Math.max(1, Math.ceil((nowCtx.msgIndex + 1) / 2))}`;
        if (nowCtx.sceneNo != null) current += `, scene ${nowCtx.sceneNo}`;
    }
    return `[Memory precedence${current}]`;
}
