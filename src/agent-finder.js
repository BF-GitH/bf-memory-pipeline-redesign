// BF Memory Pipeline - Agent 4: Fact Finder (Stage 2 of two-stage retrieval)
// Receives the FULL facts (key = value, with context/aliases) under the branches Agent 1
// picked from the MENU, PLUS — always, unconditionally — every active fact in the Unsorted
// catch-all. Returns the precise subset of facts that actually matter for the current
// scene, bounded by a size cap. "The second agent goes into detail."
//
// Uses the existing CMRS LLM-call path. Reuses Agent 1's connection profile by default
// (or a dedicated agent4Profile when configured). On any error/timeout/empty result the
// CALLER (pipeline.js) falls back to the deterministic retrieveFacts path — this module
// itself just surfaces the error so that fallback can fire.

import { addDebugLog } from './settings.js';
import { callAgentLLM } from './llm-call.js';
import { isFactVisible } from './fact-retrieval.js';
import { deriveSubject, deriveAspect } from './database.js';
import * as host from './host.js';

// Lazy import to avoid circular dependency (settings imports our DEFAULT_FINDER_PROMPT)
function getSettingsSafe() {
    return host.getExtensionSettings();
}

export const DEFAULT_FINDER_PROMPT = `You are a memory fact-finder for a roleplay. You are given:
1. A short scene direction (what is about to happen / the draft of the next reply).
2. The recent chat.
3. A CANDIDATE LIST of stored facts, each on its own line as: \`Category/key = value\`.

Your job is to choose the facts that genuinely matter for writing the NEXT reply consistently — the facts a writer must respect right now. PREFER RECALL OVER OMISSION: including a relevant fact is cheap; dropping a load-bearing one breaks continuity. Aim for a useful SET (typically ~12 when the candidate list supports it), not the bare minimum. Do NOT pad with irrelevant facts, but never omit an identity / current-state / active-relationship anchor for any character present in the scene. Do NOT invent facts. Do NOT rewrite values.

OUTPUT FORMAT (follow EXACTLY):
#Facts:
[One chosen fact per line, copied VERBATIM as \`Category/key\` (the identifier only — no value). Choose only from the candidate list. If NOTHING is relevant, output a single line: none]

RULES:
- Output ONLY \`Category/key\` identifiers that appear in the candidate list, one per line.
- ALWAYS include each present character's identity, current state, and active relationships — these anchors are load-bearing even when not just mentioned.
- Prefer facts about who/what is present in the scene and any active goal or open thread.
- Aim for the TARGET range you are given; lean toward the upper end when the candidates support it, rather than returning a tight handful.
- Skip facts about people/places not relevant to the current moment.
- Stay within the limit you are given; if over, keep the most load-bearing facts.`;

/**
 * Run Agent 4 (the finder). Picks the relevant subset of candidate facts for the scene.
 * @param {object} args
 * @param {Array<{fact: Object, category: string}>} args.candidates - facts under picked
 *   branches + all Unsorted (already visibility-filtered by the caller, but re-filtered here
 *   defensively).
 * @param {string} args.draft - Agent 1's draft / scene direction
 * @param {string} args.recentChat - formatted recent chat
 * @param {string} [args.characterInfo]
 * @param {string} [args.userPersona]
 * @param {string|null} [args.profileId] - connection profile (defaults handled by caller)
 * @param {number} [args.maxFacts] - hard cap on returned facts (size bound)
 * @param {number} [args.targetFacts] - SOFT target the prompt aims for (a floor, not a cap) so the
 *   finder returns a useful set (~12) instead of a tight 5–7. Clamped below maxFacts.
 * @param {AbortSignal} [args.signal] - caller-scoped abort (the budget timer). When it fires, the
 *   in-flight finder LLM call aborts and stops burning tokens — only THIS call, not Agent 1.
 * @returns {Promise<FinderResult>}
 */
export async function runFinderAgent({
    candidates,
    draft,
    recentChat,
    characterInfo = '',
    userPersona = '',
    profileId = null,
    maxFacts = 24,
    targetFacts = 0,
    signal = null,
}) {
    const list = Array.isArray(candidates) ? candidates : [];
    // Empty candidate set: nothing to find. Treat as a clean empty result (not an error) so
    // the caller can decide whether to fall back to the wider deterministic store.
    if (list.length === 0) {
        return { facts: [], formatted: '(No stored facts available)', raw: '', empty: true, tokensIn: 0, tokensOut: 0 };
    }

    const { systemPrompt, userPrompt } = buildFinderPrompt({ candidates: list, draft, recentChat, characterInfo, userPersona, maxFacts, targetFacts });
    addDebugLog('info', `Agent 4 (finder) prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars, ${list.length} candidates, target=${targetFacts || 'n/a'}, max=${maxFacts}`);

    let resultStr = '';
    try {
        resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId, 'finder', signal);
    } catch (error) {
        addDebugLog('fail', `Agent 4 (finder) LLM error: ${error.message || error}`);
        return { facts: [], formatted: '', raw: '', error: error.message || String(error), tokensIn: 0, tokensOut: 0 };
    }

    if (!resultStr || !resultStr.trim()) {
        addDebugLog('fail', 'Agent 4 (finder) returned empty');
        return { facts: [], formatted: '', raw: '', error: 'empty finder response', tokensIn: 0, tokensOut: 0 };
    }

    addDebugLog('info', `Agent 4 (finder) reply (${resultStr.length} chars):\n${resultStr}`);

    const tokensIn = await host.getTokenCount(systemPrompt + '\n' + userPrompt);
    const tokensOut = await host.getTokenCount(resultStr);

    const chosen = parseFinderResult(resultStr, list, maxFacts);
    const formatted = formatChosenFacts(chosen);
    addDebugLog('info', `Agent 4 (finder) chose ${chosen.length}/${list.length} fact(s)`);
    return { facts: chosen, formatted, raw: resultStr, empty: chosen.length === 0, tokensIn, tokensOut };
}

/**
 * Build the finder prompt. The candidate list is rendered as `Category/key = value`
 * (with aliases folded into the value-line as a hint, mirroring how retrieval treats them
 * as match-only — but here the finder benefits from seeing them to bridge paraphrase).
 */
function buildFinderPrompt({ candidates, draft, recentChat, characterInfo, userPersona, maxFacts, targetFacts = 0 }) {
    const sysPrompt = getSettingsSafe()?.finderPrompt || DEFAULT_FINDER_PROMPT;
    const systemPrompt = sysPrompt;

    const candidateLines = candidates.map(({ fact, category }) => {
        const aliases = Array.isArray(fact.aliases) && fact.aliases.length
            ? ` (aka ${fact.aliases.join(', ')})` : '';
        return `${category}/${fact.key} = ${fact.value}${aliases}`;
    });

    const dataParts = [];
    if (characterInfo) dataParts.push(`## Character Info\n${characterInfo}`);
    if (userPersona) dataParts.push(`## User Persona\n${userPersona}`);
    if (draft && draft.trim()) dataParts.push(`## Scene Direction (draft of next reply)\n${draft.trim()}`);
    dataParts.push(`## Recent Chat\n${recentChat}`);
    dataParts.push(`## Candidate Facts (choose from these, by Category/key)\n${candidateLines.join('\n')}`);
    // TARGET RANGE (floor + ceiling), not a bare ceiling. A soft floor counters the "be selective"
    // bias that returned 5–7 of 40+ candidates; the cap still hard-bounds the injection. When the
    // candidate pool is smaller than the target, aim for "as many as are relevant" up to the pool.
    if (targetFacts && targetFacts > 0 && candidates.length > 0) {
        const floor = Math.min(targetFacts, candidates.length);
        dataParts.push(`\nChoose the relevant facts — aim for about ${floor}${floor < maxFacts ? `–${maxFacts}` : ''} (prefer including a relevant fact over omitting it), and AT MOST ${maxFacts}. Always include every present character's identity/current-state/relationship anchors. Output ONLY the #Facts: section listing the chosen Category/key identifiers.`);
    } else {
        dataParts.push(`\nChoose AT MOST ${maxFacts} facts. Output ONLY the #Facts: section listing the chosen Category/key identifiers.`);
    }

    return { systemPrompt, userPrompt: dataParts.join('\n\n') };
}

/**
 * Parse the finder's #Facts: section into the matching candidate objects. Each output line
 * is expected to be a `Category/key` identifier from the candidate list; we resolve it back
 * to the candidate by identity (case-insensitive, punctuation-tolerant) so a hallucinated or
 * malformed line simply matches nothing. Bounded to maxFacts.
 * @param {string} response
 * @param {Array<{fact: Object, category: string}>} candidates
 * @param {number} maxFacts
 * @returns {Array<{fact: Object, category: string}>}
 */
function parseFinderResult(response, candidates, maxFacts) {
    // Index candidates by normalized `category/key` for O(1) resolution.
    const norm = (s) => String(s ?? '')
        .trim()
        .replace(/^[\s\-*•"'`(\[\{]+/, '')
        .replace(/[\s.,;:"'`)\]\}]+$/, '')
        .trim()
        .toLowerCase();
    const byId = new Map();
    for (const c of candidates) {
        byId.set(`${norm(c.category)}/${norm(c.fact.key)}`, c);
        // Non-leaf picks (`Category/aspect`, or a back-compat `Category/subject`) are resolved
        // below by matching deriveAspect/deriveSubject, not via this exact-key index.
    }

    // Isolate the #Facts: block (tolerant of label variants); fall back to whole text.
    let block = response;
    const m = response.match(/#Facts:?\s*([\s\S]*?)(?=\n#[A-Za-z]|$)/i);
    if (m) block = m[1];

    const chosen = [];
    const taken = new Set();
    for (const rawLine of block.split('\n')) {
        let line = rawLine.replace(/^[\s\-*\d.)\]]+/, '').trim();
        if (!line) continue;
        if (/^none$/i.test(line)) continue;
        // A line may carry a trailing ` = value` the model echoed — keep only the identifier.
        const eq = line.indexOf('=');
        const idPart = (eq >= 0 ? line.slice(0, eq) : line).trim();
        const slashIdx = idPart.indexOf('/');
        if (slashIdx < 0) continue; // not a Category/key identifier
        const cat = norm(idPart.slice(0, slashIdx));
        const key = norm(idPart.slice(slashIdx + 1));
        if (!cat || !key) continue;

        const exact = byId.get(`${cat}/${key}`);
        if (exact) {
            const id = `${exact.category}:${exact.fact.key}`;
            if (!taken.has(id)) { taken.add(id); chosen.push(exact); }
            if (chosen.length >= maxFacts) break;
            continue;
        }
        // Tolerate a non-leaf pick (no exact key): admit all candidates in that category
        // whose derived Layer-2 ASPECT matches (the 3-layer menu axis), OR — for back-compat —
        // whose derived subject matches. Keeps the finder useful if it picks at branch
        // granularity (`Category/aspect`) instead of leaf-key granularity.
        for (const c of candidates) {
            if (norm(c.category) !== cat) continue;
            if (deriveAspect(c.fact) !== key && deriveSubject(c.fact) !== key) continue;
            const id = `${c.category}:${c.fact.key}`;
            if (taken.has(id)) continue;
            taken.add(id);
            chosen.push(c);
            if (chosen.length >= maxFacts) break;
        }
        if (chosen.length >= maxFacts) break;
    }
    return chosen;
}

/**
 * Format the chosen facts for the writer, IDENTICAL in shape to fact-retrieval's
 * formatFactsForWriter so the injection stays uniform: `[knownBy] Category/key = value`
 * with the optional context note appended. Re-applies the rename-tolerant visibility filter
 * defensively (the finder should only see visible facts, but never inject a hidden one).
 * @param {Array<{fact: Object, category: string}>} results
 * @returns {string}
 */
export function formatChosenFacts(results) {
    const visible = (results || []).filter(({ fact }) => isFactVisible(fact));
    if (visible.length === 0) return '(No stored facts available)';
    const lines = [];
    for (const { fact, category } of visible) {
        const knownBy = (fact.knownBy || []).join(', ');
        const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
        const hasValue = String(fact.value ?? '').trim() !== '';
        const note = (typeof fact.context === 'string' && fact.context.trim()) ? fact.context.trim() : '';
        // Episodic-memory feature (mirror of formatFactsForWriter): append a `moment`'s short
        // emotional `tone` compactly so the beat reads with its feeling, e.g. `Events/key: <note> (tense)`.
        const tone = (typeof fact.tone === 'string' && fact.tone.trim()) ? fact.tone.trim() : '';
        // INJECTION DE-DUPLICATION (mirror of formatFactsForWriter): storage keeps
        // BOTH value and note, but when a note exists it already carries the fact, so
        // inject the NOTE IN PLACE OF the value. With no note, inject `key = value`.
        let line;
        if (note) {
            line = `${prefix} ${category}/${fact.key}: ${note}${tone ? ` (${tone})` : ''}`;
        } else if (hasValue) {
            line = `${prefix} ${category}/${fact.key} = ${fact.value}`;
        } else {
            line = `${prefix} ${category}/${fact.key}`;
        }
        lines.push(line);
    }
    return lines.join('\n');
}

/**
 * @typedef {Object} FinderResult
 * @property {Array<{fact: Object, category: string}>} facts - chosen facts
 * @property {string} formatted - writer-ready formatted string
 * @property {string} raw - raw LLM response
 * @property {boolean} [empty] - true when nothing was chosen / no candidates
 * @property {string} [error] - error message if the LLM call failed
 * @property {number} tokensIn
 * @property {number} tokensOut
 */
