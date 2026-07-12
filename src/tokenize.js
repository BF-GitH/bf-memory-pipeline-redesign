let _segmenter = null;
export let hasSegmenter = false;
try {
    _segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    hasSegmenter = true;
} catch {
    _segmenter = null; hasSegmenter = false;

    try { console.warn('[BFMemory] Intl.Segmenter unavailable (e.g. Firefox < 125) — using regex tokenizer fallback; CJK word segmentation degraded.'); } catch {  }
}

const ASCII_RE = /^[\x00-\x7F]*$/;
const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const HAN_ONLY_RE = /^\p{sc=Han}$/u;
const LATIN_RE = /^[\p{sc=Latin}0-9]+$/u;

function admitToken(tok, min) {
    if (!tok) return false;
    if (CJK_RE.test(tok)) {
        if (tok.length >= Math.min(min, 2)) return true;
        return tok.length === 1 && HAN_ONLY_RE.test(tok); 
    }
    if (LATIN_RE.test(tok)) return tok.length >= min;
    return tok.length >= Math.min(min, 3); 
}

export function wordTokens(text, { min = 4 } = {}) {
    const lower = String(text ?? '').toLowerCase();
    if (!lower) return [];
    const out = new Set();
    if (ASCII_RE.test(lower)) {

        for (const tok of lower.split(/[^a-z0-9]+/)) {
            if (tok.length >= min) out.add(tok);
        }
        return [...out];
    }
    if (hasSegmenter) {
        for (const seg of _segmenter.segment(lower)) {
            if (!seg.isWordLike) continue;
            const tok = seg.segment.replace(/[^\p{L}\p{N}]/gu, ''); 
            if (admitToken(tok, min)) out.add(tok);
        }
    } else {
        for (const tok of lower.split(/[^\p{L}\p{N}]+/u)) {
            if (admitToken(tok, min)) out.add(tok);
        }
    }
    return [...out];
}

export function tokenSet(text, opts) {
    return new Set(wordTokens(text, opts));
}

export function cleanWord(word) {
    return String(word ?? '').replace(/[^\p{L}\p{N}]/gu, '');
}

export function isCapitalizedWord(clean) {
    const c = String(clean ?? '');
    return !!c && c[0] === c[0].toUpperCase() && c[0] !== c[0].toLowerCase();
}

const CJK_PARTICLES = new Set([
    'の', 'は', 'が', 'を', 'に', 'で', 'と', 'です', 'ます', 'する', 'いる', 'ある',
    '的', '了', '是', '我', '你', '他', '她', '이', '그', '있', '하',
]);

export function cjkTokens(text) {
    const s = String(text ?? '');
    if (!hasSegmenter || !CJK_RE.test(s)) return [];
    const out = new Set();
    for (const seg of _segmenter.segment(s)) {
        if (!seg.isWordLike) continue;
        const tok = seg.segment.replace(/[^\p{L}\p{N}]/gu, '');
        if (tok.length < 2 || !CJK_RE.test(tok) || CJK_PARTICLES.has(tok)) continue;
        out.add(tok);
    }
    return [...out];
}

export function keyToken(s) {
    return String(s ?? '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
}
