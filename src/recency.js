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
