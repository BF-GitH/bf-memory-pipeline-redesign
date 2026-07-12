import { getScene } from './turn-state.js';

function computeNowContext() {
    let msgIndex = null;
    try {
        const chat = SillyTavern.getContext()?.chat;
        if (Array.isArray(chat) && chat.length > 0) msgIndex = chat.length - 1;
    } catch {  }
    let sceneNo = null;
    try {
        const s = getScene();
        sceneNo = (s && s.sceneNo != null) ? s.sceneNo : null;
    } catch { sceneNo = null; }
    return { msgIndex, sceneNo, storyNowMs: null };
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

    let sceneHop = '';
    const factScene = (fact.sceneNo != null) ? Number(fact.sceneNo) : null;
    if (factScene != null && Number.isFinite(factScene) && nowCtx.sceneNo != null && factScene !== Number(nowCtx.sceneNo)) {
        sceneHop = `, scene ${factScene}`;
    }
    return ` (${phrase}${sceneHop})`;
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
export const CHRONO_SECTION_HEADER = 'CHRONOLOGY — past events and background, oldest first; context only, do NOT replay as happening now:';

export function buildPrecedencePreamble(nowCtx) {
    let current = '';
    if (nowCtx && Number.isInteger(nowCtx.msgIndex)) {
        current = ` — current: turn ~${Math.max(1, Math.ceil((nowCtx.msgIndex + 1) / 2))}`;
        if (nowCtx.sceneNo != null) current += `, scene ${nowCtx.sceneNo}`;
    }
    return `[Memory precedence${current}]`;
}
