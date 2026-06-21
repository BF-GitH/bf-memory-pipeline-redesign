// BF Memory Pipeline - AI "Suggest new labels" (taxonomy growth, manual)
//
// The LAST piece of the user-extensible taxonomy feature. A MANUAL, on-demand maintenance
// action (button in the Database tab) that:
//   (1) MINES the fact DB for facts that never found a specific home — everything in the
//       Unsorted catch-all + any fact that resolved to its category's DEFAULT aspect (a sign
//       the extractor couldn't place it). Bounded (newest/most-important first, capped).
//   (2) Bundles those candidates + the CURRENT effective leaf vocab of the touched categories
//       and makes ONE LLM call (reusing the reflection/Scribe profile via callAgentLLM) asking
//       the model to cluster them and EITHER map each cluster to an existing leaf (a synonym
//       refile suggestion) OR propose a NEW leaf (category / sub-area / snake_case label /
//       one-line definition / 2-3 example facts), self-checking each proposal for duplication.
//   (3) Parses the structured #PROPOSALS / #SYNONYMS response (tolerant, mirrors agent-reflect).
//
// COST: this is the ONLY new LLM call, and it is NEVER on the hot path — it fires solely from
// the button click. NO per-turn cost, NO eventSource hookup, NO automatic firing. A failure
// degrades gracefully (toast + log, never a crash).
//
// APPROVAL GATE + WRITE PATH live in settings.js (showLabelSuggestionsPopup), which owns the
// Database tab + the addUserLeaf/addUserCategory overlay path. NOTHING is added without
// explicit user approval, and approval routes through the SAME persist+dedup the manual
// "Add your own label" controls use (so canonicalization / dedup / cache invalidation /
// view refresh are identical). This module only MINES, PROMPTS and PARSES — it never writes.

import {
    getAllDatabases, isActiveFact, isColdFact, deriveAspect, deriveSubject,
    defaultAspectFor, flatVocab, effectiveCategories, mapLegacyCategory, groupedTaxonomyMenu,
} from './database.js';
import { addDebugLog, addAgent3Tokens } from './settings.js';
import { callAgentLLM } from './llm-call.js';
import * as host from './host.js';

// Hard cap on candidate facts sent to the model (newest / most-important first) so a huge DB
// can't blow up the call. Mirrors the bounded-bundle discipline of agent-reflect.
const MAX_CANDIDATE_FACTS = 80;
// Trim each candidate's value/note so one verbose fact can't dominate the budget.
const MAX_FACT_VALUE_CHARS = 160;
// Defensive caps on what we accept back from the model (a runaway response can't flood the UI).
const MAX_PROPOSALS = 24;
const MAX_SYNONYMS = 24;
// Per-proposal definition + example clamps (the model is asked to be terse anyway).
const MAX_DEFINITION_CHARS = 160;
const MAX_EXAMPLES_PER_PROPOSAL = 3;

export const DEFAULT_SUGGEST_PROMPT = `You are a taxonomy-maintenance assistant for a long-running memory system. You are given a pile of "homeless" stored facts (facts the per-message extractor filed to a generic catch-all or to a category's DEFAULT aspect because it could not find a specific shelf for them) together with the CURRENT taxonomy (the existing Layer-1 categories and their Layer-2 leaf labels). Your job is to help GROW the taxonomy so these facts get a proper home — WITHOUT reinventing labels that already exist.

Work in three steps:
1. CLUSTER the homeless facts into a small number of coherent themes (a few facts that are clearly about the same kind of thing).
2. For EACH cluster decide ONE of:
   - MAP-TO-EXISTING: the cluster already fits an existing leaf shown in the taxonomy (it was just mis-filed). Emit it under #SYNONYMS as "Category/leaf <= short why".
   - PROPOSE-NEW: no existing leaf fits, so a NEW leaf is warranted. Emit it under #PROPOSALS. Pick the BEST existing Layer-1 category for it (only invent a brand-new category if NONE of the existing categories could ever hold this theme). Give a snake_case label (lowercase, words joined by _), a sub-area grouping, a one-line definition, and 2-3 example facts copied from the pile.
3. SELF-CHECK every PROPOSE-NEW against the shown vocab: if your proposed label is a synonym of, or already covered by, an existing leaf, DO NOT propose it — emit a #SYNONYMS line instead. State your dedup check in the proposal's definition note.

# OUTPUT FORMAT (exactly this, nothing else)

#PROPOSALS
+ <Category>/<SubArea>/<snake_case_label> | <one-line definition; include your dedup check> | <example fact>; <example fact>
+ <Category>/<SubArea>/<snake_case_label> | <one-line definition; include your dedup check> | <example fact>
.
#SYNONYMS
+ <Category>/<existing_leaf> <= <short reason this cluster already fits that leaf>
+ <Category>/<existing_leaf> <= <short reason>
.

Rules: keep labels snake_case and singular where natural. NEVER propose a label that duplicates an existing leaf (route it to #SYNONYMS instead). Only propose a NEW category when truly warranted. If you have no new labels to propose, put a single "." under #PROPOSALS. If you have no synonym mappings, put a single "." under #SYNONYMS. Do not invent facts; only use the facts given.`;

/**
 * One mined candidate fact (a fact with no specific home worth showing the model).
 * @typedef {Object} SuggestCandidate
 * @property {string} category - the fact's (raw) Layer-1 category
 * @property {string} key - the fact key
 * @property {string} value - the fact value/note, trimmed
 * @property {string} reason - why it was mined ('unsorted' | 'default_aspect')
 * @property {number} importance
 * @property {number} lastUpdated
 */

/**
 * MINING STEP — collect candidate facts that never found a specific home:
 *   (a) every ACTIVE fact in the Unsorted catch-all category (or with aspect 'misc'), and
 *   (b) every ACTIVE fact that resolved to its category's DEFAULT aspect (deriveAspect ===
 *       defaultAspectFor(category)) — a sign the extractor couldn't place it specifically.
 * Skips cold-tiered facts, superseded history snapshots and timeline (track) steps. Sorted
 * most-important-then-newest first and capped at MAX_CANDIDATE_FACTS so the call stays cheap.
 * Pure read — never mutates the DB.
 *
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases
 * @returns {{candidates: SuggestCandidate[], touchedCategories: string[]}}
 */
export function collectLabelCandidates(databases) {
    const candidates = [];
    const touched = new Set();
    for (const [category, db] of Object.entries(databases || {})) {
        // Precompute the category default ONCE (cheap, but avoid per-fact recompute).
        let defAspect = '';
        try { defAspect = defaultAspectFor(category); } catch { defAspect = 'misc'; }
        for (const fact of (db.facts || [])) {
            if (!fact || !isActiveFact(fact) || isColdFact(fact)) continue; // active + hot only
            if (fact.track) continue; // skip timeline steps
            const canon = mapLegacyCategory(category);
            const aspect = (() => { try { return deriveAspect(fact); } catch { return ''; } })();
            const isUnsorted = canon === 'Unsorted' || String(fact.aspect || '').toLowerCase() === 'misc';
            const isDefaultAspect = !!aspect && !!defAspect && aspect === defAspect;
            if (!isUnsorted && !isDefaultAspect) continue; // it found a specific home — leave it
            let value = String(fact.value ?? '').trim();
            const note = (typeof fact.context === 'string' && fact.context.trim()) ? ` (${fact.context.trim()})` : '';
            value = (value + note).slice(0, MAX_FACT_VALUE_CHARS);
            candidates.push({
                category: canon,
                key: String(fact.key || '').trim(),
                value,
                reason: isUnsorted ? 'unsorted' : 'default_aspect',
                importance: Number(fact.importance) || 0,
                lastUpdated: Number(fact.lastUpdated) || 0,
            });
            touched.add(canon);
        }
    }
    // Most-important first, then newest — the candidates most worth a real shelf lead the pile.
    candidates.sort((a, b) => (b.importance - a.importance) || (b.lastUpdated - a.lastUpdated));
    return { candidates: candidates.slice(0, MAX_CANDIDATE_FACTS), touchedCategories: [...touched] };
}

/**
 * Build the compact, bounded user-prompt bundle: the candidate facts (one terse line each,
 * tagged with their current category + mine reason) PLUS the CURRENT effective taxonomy so the
 * model proposes INTO the existing structure and reuses synonyms. The taxonomy block lists the
 * full grouped menu (cheap, bounded by the vocab size) so the model can see every existing leaf
 * to dedup against; the touched categories' leaves are additionally spelled out flat for emphasis.
 *
 * @param {SuggestCandidate[]} candidates
 * @param {string[]} touchedCategories
 * @returns {string}
 */
export function buildSuggestInput(candidates, touchedCategories) {
    const parts = [];

    // Current taxonomy (full grouped menu) — the model must propose INTO this and dedup against it.
    let menu = '';
    try { menu = groupedTaxonomyMenu(); } catch { menu = ''; }
    if (menu) parts.push(`## Current taxonomy (existing categories ▸ sub-areas: leaves — DO NOT duplicate these)\n${menu}`);

    // The existing leaf vocab for the touched categories, flat, for emphasis on where these
    // homeless facts most likely belong.
    const flatLines = [];
    for (const cat of (touchedCategories || [])) {
        let vocab = [];
        try { vocab = flatVocab(cat); } catch { vocab = []; }
        if (vocab.length) flatLines.push(`${cat}: ${vocab.join(', ')}`);
    }
    if (flatLines.length) parts.push(`## Existing leaves in the affected categories\n${flatLines.join('\n')}`);

    // The homeless facts. `[unsorted]`/`[default_aspect]` marks why each was mined.
    const factLines = (candidates || []).map(c => {
        const body = c.value ? ` = ${c.value}` : '';
        return `- [${c.reason}] ${c.category}/${c.key}${body}`;
    });
    parts.push(`## Homeless facts (${factLines.length}) — cluster these and propose homes\n${factLines.join('\n')}`);

    parts.push('\nNow output ONLY the #PROPOSALS and #SYNONYMS sections.');
    return parts.join('\n\n');
}

/**
 * A parsed NEW-leaf proposal from the model.
 * @typedef {Object} LabelProposal
 * @property {string} category - target Layer-1 category (an existing or newly-proposed name)
 * @property {boolean} newCategory - true when `category` is NOT an existing effective category
 * @property {string} subArea - sub-area grouping for the menu
 * @property {string} label - the proposed snake_case leaf label
 * @property {string} definition - one-line definition + the model's dedup note
 * @property {string[]} examples - 2-3 example facts copied from the pile
 */
/**
 * A parsed map-to-existing (synonym / refile) suggestion.
 * @typedef {Object} LabelSynonym
 * @property {string} category
 * @property {string} leaf - the EXISTING leaf this cluster already fits
 * @property {string} reason
 */

/**
 * Parse the suggest LLM output into { proposals[], synonyms[] }. Tolerant `#`-block grammar
 * mirroring agent-reflect.parseReflectResult — strips code fences, ignores junk/non-`+` lines,
 * and treats a bare "." / "(none)" section as empty. NEVER throws on garbage/empty input.
 *
 * @param {string} response
 * @returns {{proposals: LabelProposal[], synonyms: LabelSynonym[]}}
 */
export function parseSuggestResult(response) {
    const out = { proposals: [], synonyms: [] };
    if (!response || !String(response).trim()) return out;

    const existingCats = (() => { try { return effectiveCategories(); } catch { return []; } })();
    const existingLower = new Set(existingCats.map(c => String(c).toLowerCase()));
    // Map a model-emitted category name to its canonical existing spelling when it matches one.
    const canonCat = (name) => {
        const lc = String(name || '').trim().toLowerCase();
        const hit = existingCats.find(c => String(c).toLowerCase() === lc);
        return hit || String(name || '').trim();
    };

    let text = String(response).replace(/```[\s\S]*?```/g, m => m.replace(/```\w*/g, '').trim()).replace(/```/g, '');

    // #PROPOSALS — `+ Category/SubArea/label | definition | ex; ex; ex`. Bounded before #SYNONYMS.
    const propMatch = text.match(/#PROPOSALS\s*([\s\S]*?)(?=\n\s*#SYNONYMS|$)/i);
    if (propMatch) {
        const block = propMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const segs = line.split('|').map(s => s.trim());
                const path = segs[0] || '';
                const definition = (segs[1] || '').slice(0, MAX_DEFINITION_CHARS).trim();
                const examplesRaw = segs[2] || '';
                // path = Category/SubArea/label (SubArea optional → Category/label).
                const pieces = path.split('/').map(s => s.trim()).filter(Boolean);
                if (pieces.length < 2) continue; // need at least Category + label
                const category = canonCat(pieces[0]);
                const label = pieces[pieces.length - 1];
                const subArea = pieces.length >= 3 ? pieces.slice(1, -1).join(' / ') : '';
                if (!category || !label) continue;
                const examples = examplesRaw
                    .split(/[;\n]/).map(s => s.trim()).filter(Boolean).slice(0, MAX_EXAMPLES_PER_PROPOSAL);
                out.proposals.push({
                    category,
                    newCategory: !existingLower.has(String(category).toLowerCase()),
                    subArea,
                    label,
                    definition,
                    examples,
                });
                if (out.proposals.length >= MAX_PROPOSALS) break;
            }
        }
    }

    // #SYNONYMS — `+ Category/leaf <= reason`. Bounded to end of text.
    const synMatch = text.match(/#SYNONYMS\s*([\s\S]*?)$/i);
    if (synMatch) {
        const block = synMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                // Split on the first "<=" (fall back to ":" if the model used that).
                let path = line, reason = '';
                const arrowIdx = line.indexOf('<=');
                if (arrowIdx >= 0) {
                    path = line.slice(0, arrowIdx).trim();
                    reason = line.slice(arrowIdx + 2).trim();
                }
                const slashIdx = path.indexOf('/');
                if (slashIdx < 0) continue;
                const category = canonCat(path.slice(0, slashIdx).trim());
                const leaf = path.slice(slashIdx + 1).trim().toLowerCase();
                if (!category || !leaf) continue;
                out.synonyms.push({ category, leaf, reason });
                if (out.synonyms.length >= MAX_SYNONYMS) break;
            }
        }
    }
    return out;
}

/**
 * Run the suggest-new-labels mining + LLM pass. ONE LLM call (callAgentLLM, reflection/Scribe
 * profile). Returns the parsed proposals/synonyms for the caller to show in the APPROVAL popup;
 * it NEVER writes to the taxonomy itself (the overlay write happens on user approval in
 * settings.js). Degrades gracefully: returns a structured result with `error`/`noCandidates`
 * flags instead of throwing, so the UI can toast and never crash.
 *
 * @param {object} args
 * @param {string|null} args.profileId - connection profile (reuse the Scribe/Agent-3 profile)
 * @returns {Promise<{proposals: LabelProposal[], synonyms: LabelSynonym[], candidateCount: number, noCandidates?: boolean, error?: string, raw?: string}>}
 */
export async function runLabelSuggestion({ profileId = null } = {}) {
    const runId = `suggest_${Date.now().toString(36)}`;
    try {
        const databases = await getAllDatabases();
        const { candidates, touchedCategories } = collectLabelCandidates(databases);

        if (candidates.length === 0) {
            addDebugLog('info', `[${runId}] Suggest labels: no homeless facts to analyze`, {
                subsystem: 'reflection', event: 'taxonomy.suggest', reason: 'NO_CANDIDATES',
                data: { candidateCount: 0 },
            });
            return { proposals: [], synonyms: [], candidateCount: 0, noCandidates: true };
        }

        const settings = host.getExtensionSettings();
        const substitute = host.getSubstituteParams();
        const systemPrompt = substitute(settings?.suggestLabelsPrompt || DEFAULT_SUGGEST_PROMPT);
        const userPrompt = substitute(buildSuggestInput(candidates, touchedCategories));

        addDebugLog('info', `[${runId}] Suggest labels: ${candidates.length} candidate fact(s) across ${touchedCategories.length} category(ies); system=${systemPrompt.length}, user=${userPrompt.length} chars`, {
            subsystem: 'reflection', event: 'taxonomy.suggest', reason: 'START',
            data: { candidateCount: candidates.length, touchedCategories },
        });

        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId, 'taxonomy-suggest');

        // Token accounting (mirror agent-reflect: count in/out, fold into the Agent-3 totals).
        let tokensIn = 0, tokensOut = 0;
        try {
            tokensIn = await host.getTokenCount(systemPrompt + '\n' + userPrompt);
            tokensOut = await host.getTokenCount(resultStr);
            addAgent3Tokens({ agent3Input: tokensIn, agent3Output: tokensOut });
        } catch { /* token accounting is best-effort */ }

        if (!resultStr || !resultStr.trim()) {
            addDebugLog('fail', `[${runId}] Suggest labels: LLM returned empty`, {
                subsystem: 'reflection', event: 'taxonomy.suggest', reason: 'EMPTY_RESPONSE',
                data: { candidateCount: candidates.length, tokensIn, tokensOut },
            });
            return { proposals: [], synonyms: [], candidateCount: candidates.length, error: 'The model returned an empty response.' };
        }

        const parsed = parseSuggestResult(resultStr);

        addDebugLog('pass', `[${runId}] Suggest labels: parsed ${parsed.proposals.length} proposal(s), ${parsed.synonyms.length} synonym(s) from ${candidates.length} candidate(s)`, {
            subsystem: 'reflection', event: 'taxonomy.suggest', reason: 'DONE',
            data: { candidateCount: candidates.length, proposals: parsed.proposals.length, synonyms: parsed.synonyms.length, tokensIn, tokensOut },
        });
        // Per-proposal debug log so the Debug tab shows exactly what the model proposed.
        for (const p of parsed.proposals) {
            addDebugLog('info', `[${runId}] Proposed label: ${p.category}/${p.subArea || '—'}/${p.label}${p.newCategory ? ' (NEW category)' : ''}`, {
                subsystem: 'reflection', event: 'label.proposed', actor: 'AI',
                data: { category: p.category, subArea: p.subArea || undefined, label: p.label, newCategory: p.newCategory, definition: p.definition },
            });
        }

        return { proposals: parsed.proposals, synonyms: parsed.synonyms, candidateCount: candidates.length, raw: resultStr };
    } catch (error) {
        addDebugLog('fail', `[${runId}] Suggest labels error (non-fatal): ${error.message || error}`, {
            subsystem: 'reflection', event: 'taxonomy.suggest', reason: 'ERROR',
        });
        return { proposals: [], synonyms: [], candidateCount: 0, error: error.message || String(error) };
    }
}
