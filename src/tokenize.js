// BF Memory Pipeline - Shared Unicode word tokenizer (community adoption: unicode-tokenization)
// ONE tokenizer for BOTH the index side (database.factTokens) and every query side
// (searchFactsIndexed / scopedScribeCandidates / fuzzyFallback / ...). Index and query tokens
// MUST come from the same function with the same length policy, or non-ASCII facts index under
// tokens that queries never produce and recall silently dies for non-English chats.
//
// DESIGN:
//   - ASCII FAST-PATH: pure-ASCII text uses the exact legacy `split(/[^a-z0-9]+/)` + length
//     gate, so existing ENGLISH behavior stays byte-identical (and English users pay zero
//     Segmenter cost). Every call site passes its own legacy gate via `min`.
//   - NON-ASCII: a module-level cached `Intl.Segmenter(undefined, { granularity: 'word' })`
//     yields word-like segments (dictionary-segmented for CJK). Script-aware minimum length:
//     Latin keeps the caller's `min`; CJK (Han/Hiragana/Katakana/Hangul) admits at >= 2 (a lone
//     Han char only when the whole segment is that one char); other scripts (Cyrillic/Greek/
//     Arabic/...) admit at >= 3 — never above the caller's `min`.
//   - FALLBACK (no Intl.Segmenter, e.g. Firefox < 125): a Unicode `[^\p{L}\p{N}]+` split with
//     the same length policy. Degrades CJK (no word boundaries -> long runs) but keeps
//     Cyrillic/Greek/etc. fully working and never throws.
//
// NO persistence concerns: tokens are only ever held in the per-turn in-memory index
// (database.buildMemoryIndex), which is rebuilt after every write/chat change — so a browser/ICU
// segmentation difference can never desync a stored index (nothing token-shaped is stored).
// CYCLE SAFETY: zero imports — safe to import from anywhere.

/** Cached word Segmenter (undefined locale = host default dictionary). Null when unsupported. */
let _segmenter = null;
export let hasSegmenter = false;
try {
    _segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    hasSegmenter = true;
} catch {
    _segmenter = null; hasSegmenter = false;
    // One-time notice (module init runs once): fallback keeps Cyrillic/Greek/etc. fully
    // working but degrades CJK tokenization to long unsegmented runs.
    try { console.warn('[BFMemory] Intl.Segmenter unavailable (e.g. Firefox < 125) — using regex tokenizer fallback; CJK word segmentation degraded.'); } catch { /* ignore */ }
}

const ASCII_RE = /^[\x00-\x7F]*$/;
const CJK_RE = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}]/u;
const HAN_ONLY_RE = /^\p{sc=Han}$/u;
const LATIN_RE = /^[\p{sc=Latin}0-9]+$/u;

/**
 * Script-aware admission gate for a (lowercased, punctuation-stripped) token.
 * Latin keeps the caller's `min` (matching the legacy per-site gates exactly); CJK admits at
 * >= 2 (lone Han char at 1); other scripts at >= 3. Never raises a caller's LOWER `min`.
 * @param {string} tok
 * @param {number} min - the caller's Latin/ASCII minimum length
 * @returns {boolean}
 */
function admitToken(tok, min) {
    if (!tok) return false;
    if (CJK_RE.test(tok)) {
        if (tok.length >= Math.min(min, 2)) return true;
        return tok.length === 1 && HAN_ONLY_RE.test(tok); // a lone Han char is a whole word
    }
    if (LATIN_RE.test(tok)) return tok.length >= min;
    return tok.length >= Math.min(min, 3); // Cyrillic/Greek/Arabic/... names can be short
}

/**
 * Tokenize text into lowercased, deduped word tokens. THE shared tokenizer — every index-side
 * and query-side token in the extension routes through here so the two can never diverge.
 * `min` is the caller's legacy ASCII length gate (default 4 = the historical `length > 3`).
 * @param {string} text
 * @param {{min?: number}} [opts]
 * @returns {string[]} unique tokens
 */
export function wordTokens(text, { min = 4 } = {}) {
    const lower = String(text ?? '').toLowerCase();
    if (!lower) return [];
    const out = new Set();
    if (ASCII_RE.test(lower)) {
        // ASCII fast-path: byte-identical to the legacy split(/[^a-z0-9]+/) + length gate.
        for (const tok of lower.split(/[^a-z0-9]+/)) {
            if (tok.length >= min) out.add(tok);
        }
        return [...out];
    }
    if (hasSegmenter) {
        for (const seg of _segmenter.segment(lower)) {
            if (!seg.isWordLike) continue;
            const tok = seg.segment.replace(/[^\p{L}\p{N}]/gu, ''); // strip interior punctuation
            if (admitToken(tok, min)) out.add(tok);
        }
    } else {
        for (const tok of lower.split(/[^\p{L}\p{N}]+/u)) {
            if (admitToken(tok, min)) out.add(tok);
        }
    }
    return [...out];
}

/**
 * Set wrapper over wordTokens for Jaccard/membership callers.
 * @param {string} text
 * @param {{min?: number}} [opts]
 * @returns {Set<string>}
 */
export function tokenSet(text, opts) {
    return new Set(wordTokens(text, opts));
}

/**
 * Strip everything but letters/digits from a single word (Unicode-preserving replacement for
 * the legacy `[^a-zA-Z0-9]` clean, which DELETED every non-ASCII letter and made Cyrillic/
 * Greek/CJK proper-noun candidates vanish). Case is preserved for the capitalization test.
 * @param {string} word
 * @returns {string}
 */
export function cleanWord(word) {
    return String(word ?? '').replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Is a cleaned word Capitalized (proper-noun candidate)? The upper!==lower guard means caseless
 * scripts (CJK, digits) return false — same test as before, it just receives letters cleanWord
 * no longer deletes, so it works for Cyrillic/Greek names too.
 * @param {string} clean - output of cleanWord
 * @returns {boolean}
 */
export function isCapitalizedWord(clean) {
    const c = String(clean ?? '');
    return !!c && c[0] === c[0].toUpperCase() && c[0] !== c[0].toLowerCase();
}

/** Tiny CJK particle/function-word stop-set (the caseless-script analogue of sentence-starter
 * stop words). Kept deliberately small — keywords only ever SELECT existing facts. */
const CJK_PARTICLES = new Set([
    'の', 'は', 'が', 'を', 'に', 'で', 'と', 'です', 'ます', 'する', 'いる', 'ある',
    '的', '了', '是', '我', '你', '他', '她', '이', '그', '있', '하',
]);

/**
 * Segmenter word tokens that CONTAIN CJK characters (length >= 2, minus common particles).
 * Used only by extractContextKeywords' caseless-script path — CJK has no capitalization
 * signal, so without this a Japanese/Chinese/Korean chat yields zero speculative keywords.
 * Returns [] when the Segmenter is unavailable (fallback runs can't word-split CJK usefully).
 * @param {string} text
 * @returns {string[]} unique tokens
 */
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

/**
 * Normalize a name/key to a snake_case key token — the Unicode-preserving replacement for the
 * duplicated `.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'').toLowerCase()` cleanups. ASCII
 * behavior is identical; non-Latin letters now SURVIVE, so a Cyrillic/CJK Scribe key no longer
 * cleans to '' (which silently dropped the whole fact line before storage).
 * @param {string} s
 * @returns {string}
 */
export function keyToken(s) {
    return String(s ?? '').trim().replace(/\s+/g, '_').replace(/[^\p{L}\p{N}_]/gu, '').toLowerCase();
}
