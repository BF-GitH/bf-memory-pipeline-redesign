// One-sentence enforcement helpers shared by the story spine (pipeline.js) and
// the sheet head / scene-beat brevity (agent-memory.js). Sentence ends are
// counted with an abbreviation list so "Dr.", "e.g." or "3.50" never count as
// sentence ends, and quoted dialogue punctuation is ignored.
export const SPINE_ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Capt|Sgt|Lt|Col|Gen|St|Ave|Sr|Jr|vs|etc|approx|dept|est|inc|no|nr|e\.g|i\.e|p\.m|a\.m|u\.s|u\.k)\./gi;

// Hard cap for ONE spine batch sentence. Measured (two 150-turn Opus runs):
// every batch came back as 4–14 sentences of roleplay prose (~1 200 chars),
// so the joined spine reached 35 k chars at turn 150 — 59 % of the sheet.
export const SPINE_SENTENCE_MAX_CHARS = 280;

// `required` (default): a reply without a "SENTENCE:" line is a FAILURE ('').
// The measured runs answered the spine prompt with raw roleplay prose, and
// the old fallback ("no label — take the whole reply") is exactly how those
// 1 200-char blocks got accepted into the spine. Callers whose prompt does
// not ask for the label (the head condense re-ask) pass required:false and
// keep the whole-reply behaviour.
export function extractSentenceLine(raw, { required = true } = {}) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const m = /SENTENCE\s*:\s*(.+)$/i.exec(t);
    if (m) return m[1].trim();
    return required ? '' : t;
}

// A spine reply that continued the roleplay instead of summarizing it: the
// transcript lines are "CHAR (Name): …" / "USER (Name): …", and a model that
// echoes that shape has written the next turn, not a recap. Rejected outright
// even when a "SENTENCE:" label appears further down.
// Also caught when the model put the label in front of the continuation
// ("SENTENCE: CHAR (Wren): She stops.") — extractSentenceLine would otherwise
// hand that back as a sentence with the transcript speaker tag on it.
export function looksLikeRoleplayProse(raw) {
    const t = String(raw || '').trimStart();
    return /^(?:SENTENCE\s*:\s*)?(?:CHAR|USER)\s*(?:\(|:)/i.test(t);
}

export function countSentenceEnds(text) {
    const cleaned = String(text || '')
        .replace(/"[^"]*"|“[^”]*”/g, '""')                  // quoted dialogue punctuation is not a sentence end
        .replace(SPINE_ABBREVIATIONS, m => m.slice(0, -1)) // drop abbreviation dots
        .replace(/\d[.,]\d/g, '0')                          // decimals are not sentence ends
        .replace(/\.{2,}|…/g, '.');                         // an ellipsis counts once
    const matches = cleaned.match(/[.!?]+(?=[\s"')\]]|$)/g);
    return matches ? matches.length : 0;
}

// Sentence-end positions of `text` (index just past the terminator), using the
// same exclusions countSentenceEnds applies — quoted dialogue, abbreviation
// dots, decimals — so the two never disagree about where a sentence ends.
// Closing quotes/brackets right after the terminator are included in the
// boundary.
export function sentenceBoundaries(text) {
    const out = [];
    // Spans of quoted dialogue: a terminator INSIDE one ('She said "Stop!" and
    // left.') is not a sentence end, exactly as countSentenceEnds blanks them.
    const quoted = [];
    const qre = /"[^"]*"|“[^”]*”/g;
    let q;
    while ((q = qre.exec(text)) !== null) quoted.push([q.index, q.index + q[0].length]);
    const inQuote = (i) => quoted.some(([a, b]) => i > a && i < b - 1);
    const re = /[.!?]+["'”’)\]]*(?=\s|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (inQuote(m.index)) continue;
        const end = m.index + m[0].length;
        const before = text.slice(Math.max(0, m.index - 12), m.index + 1);
        if (/\d\.$/.test(before) && /^\d/.test(text.slice(end))) continue;          // decimal
        if (new RegExp(SPINE_ABBREVIATIONS.source + '$', 'i').test(before)) continue; // "Dr."
        out.push(end);
    }
    return out;
}

// Deterministic clip shared by the head caps (backup 2) and the spine clamp:
// cut at the LAST sentence boundary that keeps the text within both caps,
// never mid-sentence; a first sentence that is alone over the char cap is
// hard-clipped at a word break with an ellipsis. Returns the input untouched
// when it is already within the caps.
export function clipAtSentenceBoundary(text, maxSentences, maxChars) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const bounds = sentenceBoundaries(t);
    const ends = countSentenceEnds(t);
    if (t.length <= maxChars && ends <= maxSentences) return t;
    let cut = -1;
    for (let i = 0; i < bounds.length && i < maxSentences; i++) {
        if (bounds[i] <= maxChars) cut = bounds[i];
        else break;
    }
    // A sentence-count overflow with every boundary inside the char cap: the
    // loop above stops at maxSentences and `cut` is the last allowed boundary.
    if (cut > 0) return t.slice(0, cut).trim();
    const hard = t.slice(0, Math.max(1, maxChars - 1));
    const ws = hard.lastIndexOf(' ');
    return (ws > maxChars / 2 ? hard.slice(0, ws) : hard).replace(/[\s,;:—-]+$/, '') + '…';
}

// The spine contract made deterministic: ONE sentence, at most
// SPINE_SENTENCE_MAX_CHARS. The first sentence survives intact whenever it
// fits; only a first sentence that is alone over the cap gets the ellipsis.
export function clampSpineSentence(text) {
    return clipAtSentenceBoundary(text, 1, SPINE_SENTENCE_MAX_CHARS);
}
