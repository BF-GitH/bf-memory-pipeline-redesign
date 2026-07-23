// One-sentence enforcement helpers shared by the story spine (pipeline.js) and
// scene-beat brevity (agent-memory.js). Sentence ends are counted with an
// abbreviation list so "Dr.", "e.g." or "3.50" never count as sentence ends,
// and quoted dialogue punctuation is ignored.
export const SPINE_ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Capt|Sgt|Lt|Col|Gen|St|Ave|Sr|Jr|vs|etc|approx|dept|est|inc|no|nr|e\.g|i\.e|p\.m|a\.m|u\.s|u\.k)\./gi;

export function extractSentenceLine(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    const m = /SENTENCE\s*:\s*(.+)$/i.exec(t);
    return (m ? m[1] : t).trim();
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
