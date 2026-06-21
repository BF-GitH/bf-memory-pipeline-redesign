// BF Memory Pipeline - Fact Retrieval Module
// Automation Step 1: Query databases and assemble facts with tiered relevance
// No LLM calls - pure database lookup with smart fallback matching

import { getAllDatabases, getMemoryIndex, searchFacts, searchFactsIndexed, getTrackSteps, getFactsByScene, getRelationshipMomentThread, isSequenceFact, isActiveFact, isColdFact, clampImportance, normalizeKind, deriveSubject, deriveScope, useBonus, effectiveRecencyTs, sinceIso } from './database.js';
import { addDebugLog, getSettings } from './settings.js';
import { callEmbeddingAPI } from './llm-call.js';
import { getEmbeddingProfileId } from './profiler.js';
import * as host from './host.js';

// Smart fallback mappings: when a concept appears, also check related categories
// Memory Updater (Agent 3) maintains these in the DB relationships,
// but these are hardcoded fallbacks for common patterns.
//
// RETAINED, not superseded by the item #4 sim-links (`expandSimLinks`). Evaluated for
// removal and kept: the two mechanisms are ORTHOGONAL, not old-vs-new.
//   - This table is a CONCEPT -> CATEGORY bridge (chat word "apartment" -> search the
//     Furniture/Rooms/Decor categories). It needs no stored facts and works at cold-start.
//   - sim-links are a FACT -> textually-similar-FACT edge that only fires from an existing
//     PRIMARY hit and only after an Agent 3 write cycle has populated `fact.simLinks`.
// So sim-links cannot reproduce this recall: a chat word matching NO stored fact yields no
// primary seed (sim-links contribute nothing), and conceptually-related-but-textually-
// dissimilar categories share too few trigrams to ever link. The semantic layer (item #1)
// is the only true conceptual analogue, and it is opt-in/default-off. Gating removal behind
// an accumulated-fact count does not help — the gap is structural, not a warm-up phase.
const FALLBACK_MAPPINGS = {
    // Location triggers
    'apartment': ['Furniture', 'Rooms', 'Decor'],
    'restaurant': ['Food', 'Menu', 'Food_Preferences'],
    'kitchen': ['Food', 'Cooking', 'Food_Preferences'],
    'bedroom': ['Furniture', 'Sleep', 'Intimacy'],
    'school': ['Classes', 'Teachers', 'Students'],
    'office': ['Work', 'Colleagues', 'Projects'],
    'park': ['Nature', 'Weather', 'Activities'],

    // Activity triggers
    'eating': ['Food', 'Food_Preferences', 'Allergies', 'Restaurants'],
    'cooking': ['Food', 'Food_Preferences', 'Recipes', 'Kitchen'],
    'date': ['Relationship', 'Restaurants', 'Activities', 'Gifts'],
    'shopping': ['Money', 'Preferences', 'Clothing'],
    'working': ['Work', 'Skills', 'Projects'],
    'sleeping': ['Sleep', 'Dreams', 'Bedroom'],
    'fighting': ['Conflict', 'Relationship', 'Emotions'],

    // Food triggers
    'food': ['Allergies', 'Food_Preferences', 'Cooking'],
    'drink': ['Beverages', 'Allergies', 'Preferences'],
    'snack': ['Food', 'Food_Preferences'],

    // Relationship triggers
    'gift': ['Preferences', 'Relationship', 'Special_Dates'],
    'birthday': ['Special_Dates', 'Gifts', 'Preferences'],
    'anniversary': ['Special_Dates', 'Relationship', 'Memories'],
};

/**
 * RENAME-TOLERANT knownBy visibility check. A fact is visible when its `knownBy` is empty
 * (everyone knows) OR when any stored name matches the current persona/character.
 *
 * Matching is tolerant so a RENAME (persona/character renamed mid-chat) never hides facts
 * stored under the old name:
 *   - case-insensitive + trimmed comparison (was exact-string before),
 *   - the literal templates `{{char}}`/`{{user}}` and the words `everyone`/`all` always match
 *     (so a fact tagged with the placeholder rather than the resolved name stays visible),
 *   - the current resolved persona name and character name both match.
 * This widens the prior exact-string compare; it does not change which third-party names
 * fail to match — only that the active user/char are matched robustly across whitespace and
 * case differences a rename can introduce.
 * @param {Object} fact
 * @param {{charName?:string, userName?:string}} [names] - precomputed current names (optional)
 * @returns {boolean}
 */
export function isFactVisible(fact, names = null) {
    const kb = (fact && fact.knownBy) || [];
    if (kb.length === 0) return true; // everyone knows
    let charName = names?.charName;
    let userName = names?.userName;
    if (charName === undefined || userName === undefined) {
        const ctx = host.getCtx();
        charName = ctx.characters?.[ctx.characterId]?.name || '';
        userName = ctx.name1 || '';
    }
    const cn = String(charName).trim().toLowerCase();
    const un = String(userName).trim().toLowerCase();
    return kb.some(name => {
        const n = String(name).trim().toLowerCase();
        if (!n) return false;
        if (n === '{{char}}' || n === '{{user}}' || n === 'everyone' || n === 'all') return true;
        if (cn && n === cn) return true;
        if (un && n === un) return true;
        return false;
    });
}

/**
 * UNIFIED EXPANSION BUDGET (anti-hub). The three expansions (scope-graph links, sequence-track
 * continuity, relationship-ref chasing) used to each push independently with their own implicit
 * bounds, so a single hub (a busy place / a much-involved person / a hub subject) could fill the
 * whole secondary tier by itself. They now flow through ONE admitter under these two caps:
 *   - MAX_EXPANSION_PER_SEED — a single seed/hub may contribute at most this many EXPANSION facts,
 *     so the budget is spread across query-relevant seeds rather than monopolized by the most-
 *     connected one (the SOTA "fan-out cap"). Sequence-track continuity is exempt (continuity is
 *     mandatory once a track is in scope) — the per-seed cap targets the graph/ref hubs.
 *   - MAX_EXPANSION_TOTAL — the total facts ALL expansions may add this turn, ranked by
 *     `retrievalSalience` (importance + recency + use — NEVER connectedness/degree). The existing
 *     MAX_SECONDARY/MAX_TERTIARY injection caps remain the final backstop; the smaller wins.
 * Connectedness gates CANDIDACY here (which facts are eligible to be pulled), never RANKING.
 */
const MAX_EXPANSION_PER_SEED = 3;
const MAX_EXPANSION_TOTAL = 16;

/**
 * Approximate injection token cost of a candidate (atomic #10), mirroring the writer line
 * `[knownBy] Category/key = value [— context]`, ~4 chars/token.
 * @param {{fact: Object, category: string, tier: string}} r
 * @returns {number}
 */
function estimateInjectionTokens(r) {
    const f = r.fact;
    const kb = (f.knownBy || []).join(', ');
    const prefix = kb ? `[${kb}]` : '[everyone]';
    let line = `${prefix} ${r.category}/${f.key} = ${f.value || ''}`;
    if (r.tier === 'primary' && typeof f.context === 'string' && f.context.trim()) line += ` — ${f.context.trim()}`;
    return Math.ceil(line.length / 4);
}

// Max semantic (embedding) hits admitted as secondary per retrieval (atomic #1).
const SEMANTIC_MAX_SECONDARY = 8;
// SEMANTIC PRIORITY: how many front-of-line secondary slots are RESERVED for semantic hits so the
// meaning-matched facts survive the salience-ranked secondary cap (otherwise a low-importance but
// on-topic semantic hit gets CAP_SECONDARY'd out, which is exactly what made enabling semantic
// barely change the injected set). Kept well below MAX_SECONDARY so salience/MMR still own most slots.
const SEMANTIC_RESERVED_SECONDARY = 4;

/** Cosine similarity of two equal-length numeric vectors. 0 on mismatch/empty. */
function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Semantic expansion (atomic #1, opt-in). Embeds the query keywords and admits the top
 * cosine-closest active+visible facts (carrying a cached `embedding`) above the configured
 * threshold as SECONDARY. Fully guarded: no-ops when semantic retrieval is off, no endpoint
 * responds, or no facts are embedded yet — so it never breaks keyword/graph retrieval.
 * @param {Object} databases
 * @param {string[]} allKeywords
 * @param {Array} results - mutated in place
 * @param {Set<string>} alreadyFound - `category:key` ids already present (mutated)
 */
async function semanticLayer(databases, allKeywords, results, alreadyFound) {
    const s = (() => { try { return getSettings(); } catch { return null; } })();
    if (!s?.semanticRetrieval) return;
    const queryText = (allKeywords || []).join(' ').trim();
    if (!queryText) return;

    // ST 1.18 does server-side embeddings only (no raw vectors back), so we delegate to its vector
    // store: query the per-character collection by the turn text and resolve the matched hashes to
    // facts in scope. Verified to do true semantic matching via OpenRouter. Fully guarded — any
    // failure yields an empty set and keyword/graph retrieval is untouched.
    let ids;
    try {
        const { querySemanticIds } = await import('./st-vectors.js');
        ids = await querySemanticIds(queryText, SEMANTIC_MAX_SECONDARY, databases);
    } catch { return; }
    if (!ids || ids.size === 0) return;

    let admitted = 0;
    for (const [category, db] of Object.entries(databases || {})) {
        if (admitted >= SEMANTIC_MAX_SECONDARY) break;
        for (const fact of (db.facts || [])) {
            const id = `${category}:${fact.key}`;
            if (!ids.has(id) || alreadyFound.has(id)) continue;
            if (!isActiveFact(fact) || !isFactVisible(fact)) continue;
            results.push({ fact, category, tier: 'secondary', via: 'semantic' });
            alreadyFound.add(id);
            if (++admitted >= SEMANTIC_MAX_SECONDARY) break;
        }
    }
    if (admitted > 0) addDebugLog('info', `Semantic expansion (ST vectors): admitted ${admitted} fact(s)`);
}

/**
 * Retrieve relevant facts based on Agent 1's needed info list
 * @param {string[]} neededInfo - Array of fact categories/keywords from Agent 1
 * @param {string[]} [contextKeywords=[]] - Additional keywords extracted from recent messages
 * @returns {Promise<RetrievalResult>}
 */
export async function retrieveFacts(neededInfo, contextKeywords = []) {
    const databases = await getAllDatabases();
    // Build the per-turn in-memory fact index once (memoized; reused by every indexed query this
    // turn). Keyword matching now resolves via this index instead of scanning every fact.
    const index = await getMemoryIndex();
    const dbCount = Object.keys(databases).length;
    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    addDebugLog('info', `Retrieval: ${dbCount} databases loaded (${totalFacts} total facts)`);

    if (dbCount === 0) {
        addDebugLog('info', 'No databases exist yet, skipping retrieval');
        return { facts: [], formatted: '', stats: { primary: 0, secondary: 0, tertiary: 0 } };
    }

    // Combine explicit requests with context keywords
    const allKeywords = [...new Set([...neededInfo, ...contextKeywords])];
    addDebugLog('info', `Retrieval keywords: ${allKeywords.join(', ')}`);

    // EXACT-KEY RESOLUTION (Feature #1): Agent 1 now requests facts by their exact
    // `Category/key` from the inventory it was given. Resolve those by identity so a
    // requested key reliably appears as primary, independent of the fuzzy path below.
    // The fuzzy keyword search still runs on the SAME list afterwards — exact and
    // fuzzy coexist; identity hits just guarantee the requested key is included.
    const directResults = resolveExactKeys(databases, neededInfo);
    const exactIds = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));

    // Search databases for direct (fuzzy) matches, skipping anything already resolved exactly.
    for (const r of searchFactsIndexed(index, databases, allKeywords)) {
        const id = `${r.category}:${r.fact.key}`;
        if (!exactIds.has(id)) {
            if (r.via == null) r.via = 'keyword';
            directResults.push(r);
            exactIds.add(id);
        }
    }

    // LAYER B — local fuzzy fallback (deterministic, zero API). For each needed-info entry
    // that yielded ZERO primary hits via the exact+keyword path above, run a character-
    // trigram similarity match against every ACTIVE fact's `key value tags aliases` text and
    // admit anything at/above FUZZY_THRESHOLD as SECONDARY (so the existing MAX_SECONDARY cap
    // bounds it). This catches typos/morphology the lexical layers miss
    // ("apartments"->"apartment", "<name>s"->"<name>"). Deterministic — no Math.random. Skips
    // `Category/key` requests (Layer C already resolved those exactly). Never duplicates a
    // fact already found by exact/keyword.
    fuzzyFallback(databases, neededInfo, directResults, exactIds);

    // Smart fallback: check related categories
    const fallbackKeywords = new Set();
    for (const keyword of allKeywords) {
        const kw = keyword.toLowerCase();
        for (const [trigger, related] of Object.entries(FALLBACK_MAPPINGS)) {
            if (kw.includes(trigger)) {
                for (const cat of related) {
                    fallbackKeywords.add(cat);
                }
            }
        }
    }

    // Search for FALLBACK-MAPPING category matches (these become secondary if not already found).
    // NOTE: relationship-ref following is NO LONGER folded in here — it now flows through the
    // UNIFIED expansion below so all graph/ref/track expansions share ONE cap.
    const fallbackResults = searchFactsIndexed(index, databases, [...fallbackKeywords]);
    const alreadyFound = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));

    for (const result of fallbackResults) {
        const id = `${result.category}:${result.fact.key}`;
        if (!alreadyFound.has(id)) {
            // Demote: direct fallback hits become secondary, relationship hits become tertiary
            result.tier = result.tier === 'primary' ? 'secondary' : 'tertiary';
            if (result.via == null) result.via = 'link';
            directResults.push(result);
            alreadyFound.add(id);
        }
    }

    // UNIFIED, BOUNDED, DETERMINISTIC EXPANSION (Spiderweb Phase 1). The three former expansions —
    // scope-graph link-following (place⇄event⇄people), relationship-ref chasing, and depth-dice
    // sequence-track continuity — used to push independently with three separate implicit bounds,
    // letting one hub monopolize the secondary tier. They now run as ONE pass: each gathers
    // CANDIDATES (attributed to the seed/hub that produced them), then a single admitter applies a
    // per-seed cap (so no hub takes more than its share) and a shared total cap, ranked by
    // `retrievalSalience` (importance + recency + use — NEVER connectedness). No Math.random (the
    // sequence reach is now deterministic), one hop, deduped by id. The existing MAX_SECONDARY/
    // MAX_TERTIARY injection caps below remain the final backstop.
    gatherExpansionCandidates(databases, index, directResults, alreadyFound);

    // SEMANTIC EXPANSION (atomic #1, opt-in). Embed the query and admit facts whose cached
    // vector is cosine-close to it — catching meaning the keyword/trigram/graph lanes miss
    // ("safe snack?" → peanut-allergy fact). No-ops gracefully when semantic retrieval is off,
    // no facts are embedded yet, or no embedding endpoint responds.
    await semanticLayer(databases, allKeywords, directResults, alreadyFound);

    // DETERMINISTIC tier inclusion (Feature #2a). The old code rolled Math.random()
    // against secondaryChance/tertiaryChance and silently dropped correctly-retrieved
    // facts — the real cause of "the writer skips facts." We now include facts by tier
    // up to fixed CAPS so inclusion is predictable while the token budget stays bounded.
    // Always keep all primary; then fill secondary up to MAX_SECONDARY, then tertiary up
    // to MAX_TERTIARY. The legacy secondaryChance/tertiaryChance settings are no longer
    // used for gating (kept in settings for persistence; see settings.js note).
    // SALIENCE-RANKED capping. Primary facts are ALWAYS kept (unsorted, unchanged). When
    // secondary/tertiary candidates exceed their caps we must drop some — rank them by a
    // DETERMINISTIC salience score (importance + recency, no Math.random) so higher-
    // importance and more-recent facts win the slots instead of arbitrary match order.
    // COUNT caps remain the hard backstop; a TOKEN budget (#10) is the finer limit (smaller wins).
    const MAX_SECONDARY = 12;
    const MAX_TERTIARY = 6;
    const now = Date.now();
    const cfg = (() => { try { return getSettings(); } catch { return null; } })() || {};
    const budget = Number(cfg.retrievalTokenBudget) || 800;
    const cutoffDays = Number(cfg.recencyCutoffDays) || 0;
    const cutoffIso = cutoffDays > 0 ? sinceIso(cutoffDays) : null;
    const passesRecency = (r) => !cutoffIso || !r.fact.createdAt || r.fact.createdAt >= cutoffIso;

    const primary = directResults.filter(r => r.tier === 'primary');
    let secondary = directResults.filter(r => r.tier === 'secondary');
    let tertiary = directResults.filter(r => r.tier === 'tertiary');

    // EXCLUSION LEDGER — record candidates dropped at the cap/recency/budget cliffs so
    // "why it forgot X" is answerable. Only candidates that ACTUALLY entered a tier are logged.
    const excludedByReason = {};
    const recordExclude = (r, reason, extra = {}) => {
        excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
        addDebugLog('debug', `Retrieval excluded ${r.category}/${r.fact.key} (${reason})`, {
            subsystem: 'retrieval', event: 'retrieval.exclude', reason,
            data: { key: r.fact.key, category: r.category, tier: r.tier, ...extra },
        });
    };

    // RECENCY CUTOFF (#14): drop secondary/tertiary older than the cutoff. Primary is never cut;
    // legacy facts with no createdAt are always kept (back-compat — never silently drop undated).
    if (cutoffIso) {
        for (const r of [...secondary, ...tertiary]) {
            if (!passesRecency(r)) recordExclude(r, 'RECENCY_CUTOFF', { createdAt: r.fact.createdAt || null, cutoff: cutoffIso });
        }
        secondary = secondary.filter(passesRecency);
        tertiary = tertiary.filter(passesRecency);
    }

    const byScore = (a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now);
    secondary.sort(byScore);
    tertiary.sort(byScore);

    // MMR DIVERSITY RERANK (#mmr; Graphiti/Zep maximal_marginal_relevance). Pure salience order
    // can stack several near-duplicate facts into the scarce overflow slots. MMR reorders each
    // candidate list so a pick balances salience against being DIFFERENT from what's already
    // chosen: score(c) = lambda*normSalience(c) - (1-lambda)*maxTrigramSim(c, chosen). Reuses the
    // deterministic trigramSimilarity over each candidate's "key value tags" text (embeddings off
    // by default) → fully deterministic, so swipe/regen reuse is stable. Reordering only changes
    // WHICH overflow candidates admitTier keeps under the same caps; primary is never touched.
    if (cfg.mmrEnabled !== false) {
        try {
            const lambda = (typeof cfg.mmrLambda === 'number' && cfg.mmrLambda >= 0 && cfg.mmrLambda <= 1) ? cfg.mmrLambda : 0.7;
            secondary = mmrRerank(secondary, lambda, now);
            tertiary = mmrRerank(tertiary, lambda, now);
        } catch (e) {
            // Degrade to the salience order already computed above — never break retrieval.
            addDebugLog('debug', `MMR rerank skipped: ${e?.message || e}`, { subsystem: 'retrieval', event: 'retrieval.mmr.error' });
        }
    }

    // SEMANTIC PRIORITY (move-to-front). retrievalSalience + MMR order `secondary` by importance/
    // recency/diversity — none of which is MEANING. So a semantic hit that's the most ON-TOPIC fact
    // for this turn but low-importance/cold would sink below the MAX_SECONDARY cap and never reach
    // the Writer (the reason enabling semantic barely changed the injected set). Reserve up to
    // SEMANTIC_RESERVED_SECONDARY front slots for `via:'semantic'` admits so they survive the cap;
    // the remaining slots stay in salience/MMR order. Stable + bounded → can't flood the prompt, and
    // it's a no-op when semantic is off (no `via:'semantic'` entries exist).
    if (secondary.some(r => r.via === 'semantic')) {
        const sem = secondary.filter(r => r.via === 'semantic');
        const rest = secondary.filter(r => r.via !== 'semantic');
        secondary = [...sem.slice(0, SEMANTIC_RESERVED_SECONDARY), ...rest, ...sem.slice(SEMANTIC_RESERVED_SECONDARY)];
    }

    // TOKEN-BUDGET admission (#10): primary tokens charged first; secondary then tertiary
    // admitted by salience until the token budget OR the count cap is reached (smaller wins).
    // The first overflow candidate is always admitted (never an empty overflow on a tiny budget).
    let usedTokens = primary.reduce((sum, r) => sum + estimateInjectionTokens(r), 0);
    const admitted = [];
    const admitTier = (list, maxCount, capReason) => {
        let n = 0;
        for (const r of list) {
            if (n >= maxCount) { recordExclude(r, capReason, { rank: n + 1, of: list.length, score: Number(retrievalSalience(r.fact, now).toFixed(3)) }); continue; }
            const cost = estimateInjectionTokens(r);
            if (admitted.length > 0 && usedTokens + cost > budget) {
                recordExclude(r, 'CAP_TOKENS', { usedTokens, budget, score: Number(retrievalSalience(r.fact, now).toFixed(3)) });
                continue;
            }
            admitted.push(r); usedTokens += cost; n++;
        }
    };
    admitTier(secondary, MAX_SECONDARY, 'CAP_SECONDARY');
    admitTier(tertiary, MAX_TERTIARY, 'CAP_TERTIARY');
    const filteredResults = [...primary, ...admitted];

    // Filter by knownBy: only include facts the current character knows.
    // Empty knownBy means "everyone knows" (no filter).
    const visibleResults = filteredResults.filter((r) => {
        if (isFactVisible(r.fact)) return true;
        recordExclude(r, 'KNOWNBY_INVISIBLE', { knownBy: r.fact.knownBy || [] });
        return false;
    });

    // Per-fact ADMIT ledger (debug firehose): one line per fact that made it in.
    for (const r of visibleResults) {
        addDebugLog('debug', `Retrieval admit ${r.category}/${r.fact.key} (${r.tier[0].toUpperCase()}, via ${r.via || 'keyword'})`, {
            subsystem: 'retrieval', event: 'retrieval.admit',
            data: { key: r.fact.key, category: r.category, tier: r.tier, via: r.via || 'keyword' },
        });
    }

    // Format for Agent 2
    const formatted = formatFactsForWriter(visibleResults);

    const stats = {
        primary: visibleResults.filter(r => r.tier === 'primary').length,
        secondary: visibleResults.filter(r => r.tier === 'secondary').length,
        tertiary: visibleResults.filter(r => r.tier === 'tertiary').length,
    };

    addDebugLog('info', `Retrieval result: ${visibleResults.length} facts (P:${stats.primary} S:${stats.secondary} T:${stats.tertiary})`);
    if (visibleResults.length > 0) {
        const factSummary = visibleResults.slice(0, 5).map(r => `[${r.tier[0].toUpperCase()}] ${r.category}:${r.fact.key}`).join(', ');
        addDebugLog('info', `Top facts: ${factSummary}${visibleResults.length > 5 ? ` (+${visibleResults.length - 5} more)` : ''}`);
    }

    // One-line retrieval summary: admitted by via, excluded by reason.
    const admittedByVia = visibleResults.reduce((acc, r) => {
        const v = r.via || 'keyword'; acc[v] = (acc[v] || 0) + 1; return acc;
    }, {});
    const totalExcluded = Object.values(excludedByReason).reduce((a, b) => a + b, 0);
    addDebugLog('info', `Retrieval summary: in=${visibleResults.length} excluded=${totalExcluded}`, {
        subsystem: 'retrieval', event: 'retrieval.summary',
        data: { admitted: visibleResults.length, admittedByVia, excluded: totalExcluded, excludedByReason },
    });

    return { facts: visibleResults, formatted, stats };
}

/**
 * LAYER B threshold: minimum character-trigram Jaccard similarity for a fuzzy fallback
 * match to be admitted. ~0.4 catches typos/morphology ("apartments"->"apartment",
 * "<name>s"->"<name>") without flooding in unrelated facts. Named const so it's tunable.
 */
const FUZZY_THRESHOLD = 0.4;

/**
 * Character-trigram Jaccard similarity between two strings (Layer B, deterministic, zero
 * dependencies). Lowercases, pads with spaces so word edges form trigrams, builds the set
 * of 3-char shingles for each side, and returns |A∩B| / |A∪B| in [0,1]. Robust to typos
 * and morphological variants (shared stems share most trigrams) while staying cheap enough
 * to run over a few hundred facts in well under 1ms. No randomness.
 * @param {string} a
 * @param {string} b
 * @returns {number} similarity in [0,1]
 */
export function trigramSimilarity(a, b) {
    const grams = (s) => {
        const t = `  ${String(s || '').toLowerCase().trim()}  `;
        const set = new Set();
        for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
        return set;
    };
    const A = grams(a);
    const B = grams(b);
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    const union = A.size + B.size - inter;
    return union === 0 ? 0 : inter / union;
}

/**
 * The text MMR diversifies over: "key value tags" for a retrieval candidate. This is the
 * surface the trigram similarity compares so near-duplicate facts (same key restated, same
 * value with different phrasing, overlapping tags) score high and get spread apart. Cheap,
 * deterministic, no allocation beyond the joined string.
 * @param {{fact: Object}} r
 * @returns {string}
 */
function mmrCandidateText(r) {
    const f = r.fact || {};
    const tags = Array.isArray(f.tags) ? f.tags.join(' ') : '';
    return `${f.key || ''} ${f.value || ''} ${tags}`.trim();
}

/**
 * MMR DIVERSITY RERANK (#mmr; Graphiti/Zep maximal_marginal_relevance). Greedily reorders a
 * SALIENCE-SORTED candidate list so each successive pick maximizes
 *   score(c) = lambda * normSalience(c) - (1 - lambda) * maxTrigramSim(c, alreadyChosen)
 * where normSalience is min-max normalized across the list (so the two terms share the [0,1]
 * scale) and similarity reuses the existing deterministic trigramSimilarity over each
 * candidate's "key value tags" text. lambda=1 → pure salience order; lambda=0 → pure diversity.
 *
 * Fully DETERMINISTIC (no Math.random / PRNG): same inputs → same order, so swipe/regen reuse
 * is stable. The first pick is always the top-salience candidate (empty chosen set → similarity
 * penalty is 0). Ties break by original (salience) index — stable and reproducible. O(n^2) over
 * a list already bounded to a few dozen overflow candidates → well under 1ms.
 *
 * NOTE: this only changes ORDER. The caller still admits under the same count/token caps, so
 * MMR changes WHICH near-duplicates win slots, never how many facts are injected.
 * @param {Array<{fact: Object}>} list  salience-sorted candidates (not mutated)
 * @param {number} lambda  salience↔diversity tradeoff in [0,1]
 * @param {number} now  Date.now() for retrievalSalience
 * @returns {Array} reordered copy
 */
function mmrRerank(list, lambda, now) {
    if (!Array.isArray(list) || list.length <= 2) return list; // nothing to diversify
    // Precompute salience + normalize to [0,1] so it shares scale with trigram sim (also [0,1]).
    const sal = list.map(r => retrievalSalience(r.fact, now));
    let lo = Infinity, hi = -Infinity;
    for (const s of sal) { if (s < lo) lo = s; if (s > hi) hi = s; }
    const span = hi - lo;
    const norm = (i) => (span > 0 ? (sal[i] - lo) / span : 1); // all-equal salience → all 1 (order by diversity)
    const texts = list.map(mmrCandidateText);

    const remaining = list.map((_, i) => i); // indices into list, kept in salience order
    const chosenIdx = [];
    while (remaining.length > 0) {
        let bestPos = 0, bestScore = -Infinity;
        for (let p = 0; p < remaining.length; p++) {
            const i = remaining[p];
            let maxSim = 0;
            for (const j of chosenIdx) {
                const s = trigramSimilarity(texts[i], texts[j]);
                if (s > maxSim) maxSim = s;
            }
            const score = lambda * norm(i) - (1 - lambda) * maxSim;
            // Strict > keeps the first (higher-salience, since `remaining` is salience-ordered)
            // candidate on ties → deterministic, salience-preferring tie-break.
            if (score > bestScore) { bestScore = score; bestPos = p; }
        }
        chosenIdx.push(remaining[bestPos]);
        remaining.splice(bestPos, 1);
    }
    return chosenIdx.map(i => list[i]);
}

/**
 * LAYER B fuzzy fallback (mutates `results` in place). For each needed-info entry that the
 * exact+keyword path failed to surface as a PRIMARY hit, fuzzy-match it (character-trigram
 * Jaccard) against every active fact's `key value tags aliases` text and push matches at/
 * above FUZZY_THRESHOLD as SECONDARY. Skips `Category/key` requests (Layer C handles those)
 * and any fact already present (deduped via `seenIds`). Deterministic.
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string[]} neededInfo - Agent 1's needed-info entries (NOT the context keywords)
 * @param {Array<{fact: Object, category: string, tier: string}>} results - mutated in place
 * @param {Set<string>} seenIds - `category:key` ids already in results (mutated)
 */
function fuzzyFallback(databases, neededInfo, results, seenIds) {
    // Which entries already have a primary hit? An entry "covered" if any primary result's
    // match text contains an entry word (cheap re-check against the existing primaries) — if
    // not, it's a candidate for fuzzy rescue. We only fuzzy entries with NO primary coverage.
    const primaries = results.filter(r => r.tier === 'primary');
    const primaryText = primaries
        .map(r => `${r.fact.key} ${r.fact.value} ${(r.fact.tags || []).join(' ')} ${(r.fact.aliases || []).join(' ')}`.toLowerCase())
        .join('  ');

    let admitted = 0;
    for (const raw of (neededInfo || [])) {
        const entry = String(raw || '').trim();
        if (!entry) continue;
        if (entry.indexOf('/') >= 0) continue; // Category/key request — Layer C's job
        const entryLower = entry.toLowerCase();
        // Skip entries that the exact/keyword path already covered as primary (any
        // meaningful word of the entry already present in a primary fact's text).
        const words = entryLower.split(/\s+/).filter(w => w.length > 3);
        const covered = words.length > 0 && words.some(w => primaryText.includes(w));
        if (covered) continue;

        // Compare each WORD of the entry against each TOKEN of the fact and take the best
        // pair similarity. Token-level matching is the right granularity for typo/morphology
        // rescue ("apartments"~"apartment"); a whole-string Jaccard would be diluted by a
        // long value's unrelated trigrams and never clear the threshold.
        const entryWords = words.length > 0 ? words : [entryLower];
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact)) continue; // never fuzzy-surface superseded history
                const id = `${category}:${fact.key}`;
                if (seenIds.has(id)) continue; // already found by exact/keyword path
                const factText = `${fact.key} ${fact.value} ${(fact.tags || []).join(' ')} ${(fact.aliases || []).join(' ')}`.toLowerCase();
                const tokens = factText.split(/[^a-z0-9]+/).filter(t => t.length > 2);
                let best = 0;
                for (const ew of entryWords) {
                    for (const tok of tokens) {
                        const sim = trigramSimilarity(ew, tok);
                        if (sim > best) best = sim;
                        if (best >= FUZZY_THRESHOLD) break;
                    }
                    if (best >= FUZZY_THRESHOLD) break;
                }
                if (best >= FUZZY_THRESHOLD) {
                    results.push({ fact, category, tier: 'secondary', via: 'fuzzy', fuzzyScore: Number(best.toFixed(2)) });
                    seenIds.add(id);
                    admitted++;
                }
            }
        }
    }
    if (admitted > 0) {
        addDebugLog('info', `Fuzzy fallback (Layer B): admitted ${admitted} secondary fact(s) at threshold ${FUZZY_THRESHOLD}`);
    }
}

/**
 * Resolve Agent 1's requested facts by EXACT identity (Feature #1).
 * Agent 1 is given a `Category/key` inventory and asked to request facts by their
 * exact key. Any requested item of the form `Category/key` is matched here against
 * the stored fact whose category + key match (case-insensitive). Exact hits are
 * returned as `primary` so they're always included. Items without a slash are left
 * for the existing fuzzy keyword path. Coexists with — does not replace — fuzzy match.
 *
 * LAYER C hardening: the match is case-insensitive AND tolerant of surrounding
 * whitespace/punctuation Agent 1 may wrap a pick in (bullets, trailing periods, brackets,
 * quotes). Crucially it is VALIDATED against the actual inventory — a request only yields a
 * result when a stored fact's category+key genuinely match, so a HALLUCINATED key simply
 * matches nothing and is silently dropped (never injected as an empty/placeholder fact).
 * @param {Object<string, DatabaseSchema>} databases
 * @param {string[]} requests - Agent 1's neededInfo entries
 * @returns {Array<{fact: Object, category: string, tier: string}>}
 */
function resolveExactKeys(databases, requests) {
    const results = [];
    const seen = new Set();
    // Strip surrounding whitespace and stray punctuation (bullets, quotes, brackets,
    // trailing/leading separators) Agent 1 might wrap an identifier in, then lowercase.
    const norm = (s) => String(s)
        .trim()
        .replace(/^[\s\-*•"'`(\[\{]+/, '')
        .replace(/[\s.,;:"'`)\]\}]+$/, '')
        .trim()
        .toLowerCase();
    for (const raw of (requests || [])) {
        const slashIdx = String(raw).indexOf('/');
        if (slashIdx < 0) continue; // not a Category/key request — leave to fuzzy path
        const reqCat = norm(raw.slice(0, slashIdx));
        const reqKey = norm(raw.slice(slashIdx + 1));
        if (!reqCat || !reqKey) continue;
        for (const [category, db] of Object.entries(databases)) {
            if (category.toLowerCase() !== reqCat) continue;
            for (const fact of (db.facts || [])) {
                if (String(fact.key).toLowerCase() !== reqKey) continue;
                if (!isActiveFact(fact)) continue; // never surface superseded history via exact-key
                const id = `${category}:${fact.key}`;
                if (seen.has(id)) continue;
                seen.add(id);
                results.push({ fact, category, tier: 'primary', via: 'exact' });
            }
        }
    }
    if (results.length > 0) {
        addDebugLog('info', `Exact-key resolution: ${results.length} fact(s) matched by identity`);
    }
    return results;
}

/**
 * Deterministic salience score used to RANK which secondary/tertiary facts fill the
 * limited slots (no Math.random). Mirrors the eviction blend at a coarse level: higher
 * importance and more-recent facts score higher. kind modulates recency the same way as
 * eviction (traits decay slowly; states/events fade fast). Primary facts never go through
 * this — they're always kept — so this only orders the overflow tiers.
 * @param {Object} fact
 * @param {number} now - reference timestamp (ms)
 * @returns {number}
 */
const RETRIEVAL_IMPORTANCE_WEIGHT = 0.65;
const RETRIEVAL_RECENCY_WEIGHT = 0.35;
// Mirrors database.js HALF_LIFE_DAYS so keep-score and slot-rank decay identically. `moment`
// (episodic scene beat) is emotionally sticky: decays far slower than a transient state(3) or a
// plain event(7) but well short of a foundational trait(90), so significant beats stay recallable.
const RETRIEVAL_HALF_LIFE_DAYS = { trait: 90, state: 3, event: 7, moment: 30 };
// COLD DEPRIORITIZATION (infinite-facts feature). A cold-tiered fact is still FINDABLE (it
// remains in db.facts and passes through every match path unchanged), but when overflow tiers
// are capped we want HOT facts to fill the limited slots FIRST. A large fixed penalty pushes
// cold candidates below every hot candidate in the salience ranking, so a cold fact only takes
// a capped slot when no hot fact contends for it — i.e. it surfaces on a direct/strong match
// (exact-key, keyword, fuzzy all still admit it) but loses ties for scarce slots to hot facts.
const RETRIEVAL_COLD_PENALTY = 1000;
// CONFIDENCE-GATED RETRIEVAL (Zep minRating + mem0 confidence). A fact's stored `confidence`
// ('high'|'med'|'low' or a 0..1 number; written by agent-memory.js from the `conf:` marker) is
// otherwise ignored at retrieval. Here we map it to a 0..1 factor so the OVERFLOW ranking can let
// solid facts out-compete low-confidence guesses for scarce secondary/tertiary slots. Absent or
// unrecognized => 1.0 (treated as high), matching the prompt's "omit => high" contract. Primaries
// never pass through retrievalSalience, so they're never gated.
const CONFIDENCE_FACTOR = { high: 1.0, med: 0.8, medium: 0.8, low: 0.5 };
function confidenceFactor(fact) {
    const c = fact?.confidence;
    if (c === undefined || c === null || c === '') return 1.0;
    if (typeof c === 'number') return Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 1.0;
    const f = CONFIDENCE_FACTOR[String(c).toLowerCase()];
    return f === undefined ? 1.0 : f;
}
function retrievalSalience(fact, now) {
    const importance = clampImportance(fact?.importance);
    const kind = normalizeKind(fact?.kind);
    // USE-IT-OR-LOSE-IT: rank from the MORE RECENT of lastUpdated/lastUsedAt (using a fact
    // refreshes it like an update) plus a bounded log-scaled frequency bonus from useCount, so
    // recently/frequently-injected facts win scarce slots. Same blend as the keep-score
    // (salienceScore), sharing useBonus/effectiveRecencyTs so the two never drift apart.
    const last = effectiveRecencyTs(fact);
    const ageDays = last > 0 ? Math.max(0, (now - last) / 86400000) : 36500;
    const halfLife = RETRIEVAL_HALF_LIFE_DAYS[kind] || RETRIEVAL_HALF_LIFE_DAYS.trait;
    const recency = Math.pow(0.5, ageDays / halfLife);
    let base = RETRIEVAL_IMPORTANCE_WEIGHT * (importance / 5) + RETRIEVAL_RECENCY_WEIGHT * recency + useBonus(fact?.useCount);
    // CONFIDENCE GATE (overflow ranking only). Gated behind settings.confidenceRanking (default ON)
    // and degrades to the ungated score on any error. Applied as a BOUNDED multiplier blended
    // toward 1.0 by (1 - confidenceWeight): effectiveMult = 1 - w*(1 - factor). A small weight
    // nudges low-confidence facts down without ever zeroing them — they still surface on a direct
    // match (which doesn't use this) and merely lose ties for scarce overflow slots to solid facts.
    try {
        const cfg = getSettings();
        if (cfg?.confidenceRanking) {
            const w = Math.min(1, Math.max(0, Number(cfg.confidenceWeight ?? 0.3)));
            const mult = 1 - w * (1 - confidenceFactor(fact));
            base *= mult;
        }
    } catch { /* degrade to ungated base score */ }
    return isColdFact(fact) ? base - RETRIEVAL_COLD_PENALTY : base;
}

/**
 * Default depth-dice "reach weights" (Feature #4). Each is how strongly we want to reach that
 * many steps back from the current step. Overridden by settings.depthDice* when present.
 * Historically these were rolled against Math.random per turn; the reach is now DETERMINISTIC
 * (see deterministicTrackReach) so a swipe/regen — which re-injects from the cached snapshot and
 * MUST yield the same fact set (pipeline.js ~26-27) — can never silently pull a different slice
 * of history. The weights are reinterpreted as a fixed include-threshold, not a dice roll.
 */
const DEFAULT_DEPTH_PROBS = [0.70, 0.50, 0.25, 0.10]; // depth 1,2,3,4

/**
 * DETERMINISTIC-INCLUDE threshold for the depth-dice weights. A depth tier is INCLUDED when its
 * configured weight is at/above this threshold (≥ 0.5 = "more likely than not"), and the reach is
 * the FURTHEST CONTIGUOUS depth that clears it (a gap stops the reach so continuity holds). With
 * the defaults [0.70, 0.50, 0.25, 0.10] this yields reach 2 — the same expected behavior the dice
 * used to average to, but now stable across swipes. No Math.random anywhere in the path.
 */
const DEPTH_INCLUDE_THRESHOLD = 0.5;

/** Read configured depth probabilities (clamped 0..1), falling back to defaults. */
function getDepthProbs() {
    const s = (() => { try { return getSettings(); } catch { return null; } })() || {};
    const pick = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
    };
    return [
        pick(s.depthDice1, DEFAULT_DEPTH_PROBS[0]),
        pick(s.depthDice2, DEFAULT_DEPTH_PROBS[1]),
        pick(s.depthDice3, DEFAULT_DEPTH_PROBS[2]),
        pick(s.depthDice4, DEFAULT_DEPTH_PROBS[3]),
    ];
}

/**
 * DETERMINISTIC reach from the depth-dice weights (replaces the old per-turn Math.random roll).
 * The reach is the FURTHEST CONTIGUOUS depth whose configured weight clears
 * DEPTH_INCLUDE_THRESHOLD — a gap (a tier below threshold) stops the reach so continuity is
 * preserved. Same inputs (settings) → same reach, every time, so swipes/regens that re-derive
 * retrieval get an identical history slice (no silent drift; pipeline.js ~26-27 invariant).
 * @param {number[]} probs - configured depth weights for depths 1..N
 * @returns {number} reach in [0, probs.length] (0 = current step only)
 */
function deterministicTrackReach(probs) {
    let reach = 0;
    for (let depth = 1; depth <= probs.length; depth++) {
        if (probs[depth - 1] >= DEPTH_INCLUDE_THRESHOLD) reach = depth;
        else break; // contiguity: a below-threshold tier stops the reach (no gaps)
    }
    return reach;
}

/**
 * Depth-dice sequence expansion with mandatory continuity (Feature #4) — DETERMINISTIC.
 * Identifies every track touched by the seed facts, then for each track collects the current
 * (highest-ord) step plus a CONTIGUOUS run of older steps back to a deterministically-derived
 * reach (no Math.random). Returns CANDIDATE rows (it does NOT push) so the unified expansion
 * (gatherExpansionCandidates) can apply the shared per-seed + total caps; the track itself is
 * the "seed" each step is attributed to. Sequence steps stay tier `primary` (continuity is
 * mandatory once a track is in scope).
 * @param {Object<string, DatabaseSchema>} databases
 * @param {Array<{fact: Object, category: string, tier: string}>} seeds - the seed result rows
 * @param {Set<string>} alreadyFound - `category:key` ids already in results
 * @returns {Array<{fact: Object, category: string, tier: string, via: string, seedId: string}>}
 */
function expandSequenceTracks(databases, seeds, alreadyFound) {
    // Collect relevant tracks from the seed facts.
    const tracks = new Set();
    for (const r of seeds) {
        if (isSequenceFact(r.fact)) tracks.add(r.fact.track);
    }
    if (tracks.size === 0) return [];

    const probs = getDepthProbs();
    const candidates = [];

    for (const track of tracks) {
        const steps = getTrackSteps(databases, track); // ascending by ord
        if (steps.length === 0) continue;

        // DETERMINISTIC reach (was a Math.random dice roll) — stable across swipes.
        const reach = deterministicTrackReach(probs);
        // Number of steps to include from the tail: current + `reach` older = reach+1,
        // bounded by how many steps actually exist.
        const includeCount = Math.min(reach + 1, steps.length);
        const slice = steps.slice(steps.length - includeCount); // contiguous tail — no gaps

        for (const { fact, category } of slice) {
            const id = `${category}:${fact.key}`;
            if (alreadyFound.has(id)) continue;
            candidates.push({ fact, category, tier: 'primary', via: 'link', seedId: `track:${track}` });
        }
        addDebugLog('info', `Depth-dice track "${track}": deterministic reach ${reach} → ${includeCount}/${steps.length} step(s) eligible`);
    }
    return candidates;
}

/**
 * Lowercase + trim a link token (a subject/place/person name) for case-insensitive
 * comparison across `subject`, `location`, and `involved` fields. Returns '' for empty.
 * @param {*} s
 * @returns {string}
 */
function linkToken(s) {
    return String(s ?? '').trim().toLowerCase();
}

/**
 * LINK-FOLLOWING + SCOPE-AWARE EXPANSION (Phase 4b). After candidate generation, traverse
 * the scope graph ONE hop so a fact arrives with its linked context. Mutates `results` in
 * place; newly pulled facts enter as SECONDARY (so the existing MAX_SECONDARY cap bounds
 * them) and respect isFactVisible. Deterministic — no Math.random, no LLM. Deduped by
 * `category:key` via `alreadyFound`; a single hop (newly added facts are NOT re-expanded)
 * so it can never loop.
 *
 * Four link directions (each keyed off scope/subject, NOT the owning character, so a place
 * fact is recalled when the PLACE is the topic even if its owner is absent):
 *   1. PLACE -> EVENTS:  any place fact (scope:place) or place SUBJECT among the candidates
 *      pulls EVENT facts whose `location` link points at that place subject/key (sub-places
 *      included via key prefix match).
 *   2. PERSON -> EVENTS: any character SUBJECT among the candidates pulls EVENT facts whose
 *      `involved` list includes that person.
 *   3. EVENT -> PLACE:   any retrieved EVENT pulls the place fact named by its `location`.
 *   4. EVENT -> PEOPLE:  any retrieved EVENT pulls the key character facts of each `involved`
 *      participant (their facts whose subject matches the participant).
 *
 * @param {Object<string, DatabaseSchema>} databases
 * @param {Array<{fact: Object, category: string, tier: string}>} results - mutated in place
 * @param {Set<string>} alreadyFound - `category:key` ids already in results (mutated)
 */
export function expandLinks(databases, results, alreadyFound) {
    // Thin wrapper: collect scope-graph candidates from the current seeds, then push them in
    // place (the finder candidate build at pipeline.js relies on this mutate-in-place form).
    // The deterministic retrieval path instead routes the collector through the UNIFIED cap
    // (gatherExpansionCandidates) so all expansions share one budget.
    const candidates = collectLinkCandidates(databases, results.slice(), alreadyFound);
    let pulled = 0;
    for (const c of candidates) {
        const id = `${c.category}:${c.fact.key}`;
        if (alreadyFound.has(id)) continue;
        results.push({ fact: c.fact, category: c.category, tier: c.tier, via: c.via });
        alreadyFound.add(id);
        pulled++;
    }
    if (pulled > 0) {
        addDebugLog('info', `Link expansion (Phase 4b): pulled ${pulled} linked fact(s) as secondary`);
    }
}

/**
 * SCOPE-GRAPH candidate collector (Phase 4b core, extracted). Traverses the scope graph ONE
 * hop from `seeds` and RETURNS candidate rows (does NOT push) so the unified expansion can apply
 * the shared per-seed + total caps. Each candidate carries a `seedId` = the place/person/event
 * node that pulled it, so a single hub seed (a busy place or a much-involved person) can be
 * capped to its share by the unified admitter (per-seed cap) and can't monopolize the tier.
 * Deterministic — no Math.random, no LLM. One hop (newly pulled facts are NOT re-expanded).
 *
 * Four link directions (each keyed off scope/subject, NOT the owning character, so a place
 * fact is recalled when the PLACE is the topic even if its owner is absent):
 *   1. PLACE -> EVENTS / 2. PERSON -> EVENTS / 3. EVENT -> PLACE / 4. EVENT -> PEOPLE.
 *
 * @param {Object<string, DatabaseSchema>} databases
 * @param {Array<{fact: Object, category: string, tier: string}>} seeds - snapshot of seed rows
 * @param {Set<string>} alreadyFound - `category:key` ids already in results (read-only here)
 * @returns {Array<{fact: Object, category: string, tier: string, via: string, seedId: string}>}
 */
function collectLinkCandidates(databases, seeds, alreadyFound) {
    // Build the relevance sets from the SEED candidates (deterministic, scope-aware). We remember
    // the seed token so each pulled fact can be attributed to the hub/node that pulled it.
    const relevantPlaces = new Set();   // place subjects/keys we should surface events for
    const relevantPeople = new Set();   // character subjects we should surface events for
    const seedEvents = [];              // event facts whose context (place+people) we pull
    for (const r of seeds) {
        const fact = r.fact;
        if (!fact) continue;
        const scope = deriveScope(fact);
        const subject = linkToken(deriveSubject(fact));
        const key = linkToken(fact.key);
        if (scope === 'place') {
            if (subject) relevantPlaces.add(subject);
            if (key) relevantPlaces.add(key);
        } else if (scope === 'event') {
            seedEvents.push(fact);
        } else {
            if (subject) relevantPeople.add(subject);
        }
    }

    // Track which event facts are pulled as event-seeds for direction 3/4, so a freshly pulled
    // event (from direction 1/2) ALSO gets its context expanded — one hop, no recursion.
    const eventQueue = seedEvents.slice();

    // Dedupe within THIS collection so the same fact isn't emitted twice (the unified admitter
    // also dedupes against alreadyFound). We only emit ids not already in results.
    const emitted = new Set();
    const candidates = [];
    const emit = (category, fact, seedId) => {
        if (!fact) return false;
        if (!isActiveFact(fact)) return false;          // never surface superseded history
        if (!isFactVisible(fact)) return false;          // respect knownBy
        const id = `${category}:${fact.key}`;
        if (alreadyFound.has(id) || emitted.has(id)) return false;
        emitted.add(id);
        candidates.push({ fact, category, tier: 'secondary', via: 'link', seedId });
        return true;
    };

    // DIRECTIONS 1 & 2 — PLACE/PERSON -> EVENTS.
    if (relevantPlaces.size > 0 || relevantPeople.size > 0) {
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (deriveScope(fact) !== 'event') continue;
                if (!isActiveFact(fact)) continue;
                const id = `${category}:${fact.key}`;
                if (alreadyFound.has(id) || emitted.has(id)) continue;
                let hitSeed = null;
                // Direction 1: event located at a relevant place (or a sub-place of it).
                const loc = linkToken(fact.location);
                if (loc && relevantPlaces.size > 0) {
                    for (const place of relevantPlaces) {
                        if (loc === place || loc.startsWith(place + '_') || place.startsWith(loc + '_')) {
                            hitSeed = `place:${place}`;
                            break;
                        }
                    }
                }
                // Direction 2: event whose participants include a relevant person.
                if (!hitSeed && relevantPeople.size > 0 && Array.isArray(fact.involved)) {
                    for (const p of fact.involved) {
                        const pt = linkToken(p);
                        if (relevantPeople.has(pt)) { hitSeed = `person:${pt}`; break; }
                    }
                }
                if (hitSeed && emit(category, fact, hitSeed)) {
                    eventQueue.push(fact); // expand this event's own context below
                }
            }
        }
    }

    // DIRECTIONS 3 & 4 — EVENT -> PLACE + PEOPLE.
    if (eventQueue.length > 0) {
        // Index active facts by scope+subject ONCE so the per-event lookups stay cheap.
        const placesBySubject = new Map();  // subject -> [{category, fact}]
        const peopleBySubject = new Map();  // subject -> [{category, fact}]
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact)) continue;
                const subj = linkToken(deriveSubject(fact));
                if (!subj) continue;
                const scope = deriveScope(fact);
                const map = scope === 'place' ? placesBySubject : (scope === 'character' ? peopleBySubject : null);
                if (!map) continue; // events aren't pulled as event-context targets
                if (!map.has(subj)) map.set(subj, []);
                map.get(subj).push({ category, fact });
            }
        }
        const seenEventIds = new Set();
        for (const ev of eventQueue) {
            const evKey = linkToken(ev.key);
            if (seenEventIds.has(evKey)) continue;
            seenEventIds.add(evKey);
            const evSeed = `event:${evKey}`;
            // Direction 3: the event's linked place.
            const loc = linkToken(ev.location);
            if (loc && placesBySubject.has(loc)) {
                for (const { category, fact } of placesBySubject.get(loc)) emit(category, fact, evSeed);
            }
            // Direction 4: the event's participants' character facts.
            if (Array.isArray(ev.involved)) {
                for (const p of ev.involved) {
                    const subj = linkToken(p);
                    if (subj && peopleBySubject.has(subj)) {
                        for (const { category, fact } of peopleBySubject.get(subj)) emit(category, fact, evSeed);
                    }
                }
            }
        }
    }

    return candidates;
}

/**
 * RELATIONSHIP-REF candidate collector. For each PRIMARY seed result, follow its
 * `relationships.primary` refs and RETURN the resolved facts as candidate rows (does NOT push),
 * attributed to the seed fact that owns the ref (its `seedId`). This replaces the old path that
 * folded relationship refs into the FALLBACK_MAPPINGS keyword search; routing them through the
 * unified admitter means a hub seed's many refs are capped to its per-seed share like every other
 * expansion. Deterministic, zero-API: refs are resolved via the same token index the push path
 * uses (searchFactsIndexed), then filtered to active + visible + not-already-found.
 * @param {{byCatAspect: Map, bySubject: Map, byToken: Map}} index - per-turn fact index
 * @param {Object<string, DatabaseSchema>} databases
 * @param {Array<{fact: Object, category: string, tier: string}>} seeds - snapshot of seed rows
 * @param {Set<string>} alreadyFound - `category:key` ids already in results (read-only here)
 * @returns {Array<{fact: Object, category: string, tier: string, via: string, seedId: string}>}
 */
/**
 * SAME-SCENE candidate collector (Spiderweb 2, the in-scene strand). For each seed that carries an
 * origin `sceneNo`, pull the OTHER facts stamped in that same scene from the per-turn `bySceneNo`
 * bucket and RETURN them as candidate rows (does NOT push). A scene can hold many facts, so it is a
 * potential HUB — every candidate is attributed to its scene seedId (`scene:<no>`) so the unified
 * admitter's per-seed cap applies and same-scene facts CANNOT flood the tier. This is a
 * high-precision, candidacy-only edge: scene membership decides ELIGIBILITY; salience (in the
 * admitter) decides ORDER — there is NO connectedness/degree term. One hop, deterministic, zero-API.
 * Active + visible only (a recap of cold/superseded facts is the job of getFactsByScene, not the
 * always-on push path). Same-scene auto-links are NOT marked primary (they enter as `secondary`).
 * @param {{bySceneNo: Map}} index - per-turn fact index (carries the in-scene bucket)
 * @param {Array<{fact: Object, category: string, tier: string}>} seeds - snapshot of seed rows
 * @param {Set<string>} alreadyFound - `category:key` ids already in results (read-only here)
 * @returns {Array<{fact: Object, category: string, tier: string, via: string, seedId: string}>}
 */
function collectSceneCandidates(index, seeds, alreadyFound) {
    const bySceneNo = index && index.bySceneNo;
    if (!bySceneNo || bySceneNo.size === 0) return [];
    // Distinct seed scenes (a seed contributes its scene once, no matter how many seeds share it).
    const seedScenes = new Set();
    for (const r of seeds) {
        const no = r && r.fact && Number.isInteger(r.fact.sceneNo) ? r.fact.sceneNo : null;
        if (no !== null) seedScenes.add(no);
    }
    if (seedScenes.size === 0) return [];

    const candidates = [];
    const emitted = new Set();
    for (const no of seedScenes) {
        const bucket = bySceneNo.get(no);
        if (!bucket) continue;
        const seedId = `scene:${no}`;
        for (const { fact, category } of bucket) {
            if (!fact) continue;
            if (!isActiveFact(fact)) continue;        // never surface superseded history on the push path
            if (!isFactVisible(fact)) continue;        // respect knownBy
            const id = `${category}:${fact.key}`;
            if (alreadyFound.has(id) || emitted.has(id)) continue;
            emitted.add(id);
            candidates.push({ fact, category, tier: 'secondary', via: 'scene', seedId });
        }
    }
    return candidates;
}

function collectRelationshipRefCandidates(index, databases, seeds, alreadyFound) {
    const candidates = [];
    const emitted = new Set();
    for (const seed of seeds) {
        if (seed.tier !== 'primary' || !seed.fact?.relationships) continue;
        const refs = seed.fact.relationships.primary || [];
        if (refs.length === 0) continue;
        const seedId = `ref:${seed.category}:${seed.fact.key}`;
        // Resolve this seed's refs through the same index matcher the push path uses.
        for (const r of searchFactsIndexed(index, databases, refs)) {
            const id = `${r.category}:${r.fact.key}`;
            if (alreadyFound.has(id) || emitted.has(id)) continue;
            if (!isActiveFact(r.fact)) continue;       // never surface superseded history
            if (!isFactVisible(r.fact)) continue;       // respect knownBy
            emitted.add(id);
            // Relationship refs were historically demoted to tertiary; keep that tier.
            candidates.push({ fact: r.fact, category: r.category, tier: 'tertiary', via: 'link', seedId });
        }
    }
    return candidates;
}

/**
 * UNIFIED EXPANSION (Spiderweb Phase 1 + 2). Gathers candidates from ALL expansions — scope-graph
 * links, same-scene facts (Spiderweb 2's in-scene strand), relationship-ref chasing, and
 * deterministic sequence-track continuity — then admits them through ONE shared budget. Mutates
 * `results` in place; mutates `alreadyFound`.
 *
 * THE ANTI-HUB CAP. Each candidate is attributed to the seed/hub that produced it (`seedId`). A
 * single seed may contribute at most MAX_EXPANSION_PER_SEED facts, so a popular subject / busy
 * place / much-involved person can't fill the whole tier with its own siblings — the budget is
 * spread across query-relevant seeds. Sequence-track continuity steps are EXEMPT from the per-seed
 * cap (continuity is mandatory once a track is in scope) but still count toward the total.
 *
 * RANKING IS UNCHANGED. Within the shared budget, candidates are admitted in DESCENDING
 * `retrievalSalience` (importance + recency + use). There is NO connectedness/degree term — links
 * decide what is ELIGIBLE (candidacy), salience decides the ORDER. The most-connected fact does
 * not get a ranking boost.
 *
 * @param {Object<string, DatabaseSchema>} databases
 * @param {{byCatAspect: Map, bySubject: Map, byToken: Map}} index - per-turn fact index
 * @param {Array<{fact: Object, category: string, tier: string}>} results - mutated in place
 * @param {Set<string>} alreadyFound - `category:key` ids already in results (mutated)
 */
function gatherExpansionCandidates(databases, index, results, alreadyFound) {
    // SNAPSHOT seeds up front so this is exactly one hop (added facts aren't re-expanded).
    const seeds = results.slice();
    const now = Date.now();

    // Gather from all expansions (each returns attributed candidates; none pushes).
    const linkCands = collectLinkCandidates(databases, seeds, alreadyFound);
    const refCands = collectRelationshipRefCandidates(index, databases, seeds, alreadyFound);
    const trackCands = expandSequenceTracks(databases, seeds, alreadyFound);
    // In-scene strand (Spiderweb 2): same-scene facts, attributed to their scene seedId so the
    // per-seed cap below prevents a big scene from flooding the tier.
    const sceneCands = collectSceneCandidates(index, seeds, alreadyFound);

    // Sequence-track continuity is admitted FIRST and EXEMPT from the per-seed cap (continuity is
    // mandatory) — but still counts against the shared total. Dedupe across sources by id.
    const claimed = new Set();      // ids already admitted this pass
    const perSeed = new Map();      // seedId -> count admitted under the per-seed cap
    let admittedTotal = 0;
    let cappedBySeed = 0;           // how many candidates a per-seed cap blocked (debug)
    const seedContrib = new Map();  // seedId -> count (debug: how much each hub contributed)

    const admit = (c, { perSeedCapped }) => {
        if (admittedTotal >= MAX_EXPANSION_TOTAL) return false;
        const id = `${c.category}:${c.fact.key}`;
        if (alreadyFound.has(id) || claimed.has(id)) return false;
        if (perSeedCapped) {
            const used = perSeed.get(c.seedId) || 0;
            if (used >= MAX_EXPANSION_PER_SEED) { cappedBySeed++; return false; }
            perSeed.set(c.seedId, used + 1);
        }
        claimed.add(id);
        alreadyFound.add(id);
        results.push({ fact: c.fact, category: c.category, tier: c.tier, via: c.via });
        admittedTotal++;
        seedContrib.set(c.seedId, (seedContrib.get(c.seedId) || 0) + 1);
        return true;
    };

    // 1) Track continuity (exempt from per-seed cap, counts toward total).
    for (const c of trackCands) admit(c, { perSeedCapped: false });

    // 2) Link + scene + relationship-ref candidates, ranked by salience, under the per-seed cap.
    //    Salience DESCENDING (importance + recency + use) — no connectedness term. Stable sort keeps
    //    source order on ties, so the pass is fully deterministic. Same-scene facts ride the SAME
    //    per-seed cap (scene seedId), so a big scene can't flood the tier.
    const ranked = [...linkCands, ...sceneCands, ...refCands].sort(
        (a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now));
    for (const c of ranked) {
        if (admittedTotal >= MAX_EXPANSION_TOTAL) break;
        admit(c, { perSeedCapped: true });
    }

    if (admittedTotal > 0 || cappedBySeed > 0) {
        // Find the biggest single-seed contribution to surface the anti-hub cap working.
        let topSeed = null, topN = 0;
        for (const [sid, n] of seedContrib) if (n > topN) { topN = n; topSeed = sid; }
        addDebugLog('info', `Unified expansion: admitted ${admittedTotal}/${MAX_EXPANSION_TOTAL} (per-seed cap ${MAX_EXPANSION_PER_SEED} blocked ${cappedBySeed}; top seed "${topSeed}" contributed ${topN})`, {
            subsystem: 'retrieval', event: 'retrieval.indexed',
            data: {
                admitted: admittedTotal, total_cap: MAX_EXPANSION_TOTAL,
                per_seed_cap: MAX_EXPANSION_PER_SEED, capped_by_seed: cappedBySeed,
                top_seed: topSeed, top_seed_contrib: topN,
                from: { link: linkCands.length, scene: sceneCands.length, ref: refCands.length, track: trackCands.length },
            },
        });
    }
}

/**
 * Format retrieved facts into a string for Agent 2 (Writer)
 * Format: [who_knows] fact_content
 * @param {Array} results - Filtered retrieval results
 * @returns {string}
 */
export function formatFactsForWriter(results) {
    if (results.length === 0) return '(No stored facts available)';

    // Build the per-fact line EXACTLY as before (format/tone/knownBy/dedup unchanged), then GROUP
    // the lines by SUBJECT so the Writer sees connected clusters (all of one character's/place's
    // facts together) instead of scattered rows. This is PRESENTATION-ONLY: same facts, same count,
    // same per-line text — only the ORDER changes (a stable group-by-subject re-sort), plus a
    // one-word `[Subject]` header per group. Subjects appear in FIRST-APPEARANCE order (so a primary
    // hit's subject still leads); facts with no/unknown subject collapse into a trailing "Misc"
    // group, so it degrades cleanly when subject is missing or mixed.
    // BI-TEMPORAL (feature, opt-in): when story-world validity is enabled, annotate a fact carrying
    // `validFrom`/`validUntil` with a compact `{from→until}` tail so the Writer sees WHEN the fact is
    // true in-story (keeps flashbacks/time-skips consistent). Read the flag ONCE per call (not per
    // line). When the feature is OFF — the default — these fields never get written, so output is
    // byte-for-byte unchanged. Best-effort: a settings read failure simply omits the annotation.
    let biTemporalOn = false;
    try { biTemporalOn = getSettings()?.biTemporal === true; } catch { /* default off */ }
    const temporalTail = (fact) => {
        if (!biTemporalOn) return '';
        const from = (typeof fact.validFrom === 'string' && fact.validFrom.trim()) ? fact.validFrom.trim() : '';
        const until = (typeof fact.validUntil === 'string' && fact.validUntil.trim()) ? fact.validUntil.trim() : '';
        if (!from && !until) return '';
        return ` {${from || '?'}→${until || 'now'}}`;
    };

    const formatLine = (fact, category) => {
        const knownBy = (fact.knownBy || []).join(', ');
        const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
        const hasValue = String(fact.value ?? '').trim() !== '';
        const note = (typeof fact.context === 'string' && fact.context.trim()) ? fact.context.trim() : '';
        // Episodic-memory feature: a `moment`-kind fact carries a short emotional `tone` we append
        // compactly so the beat reads WITH its feeling, e.g. `Events/key: <note> (tender)`.
        const tone = (typeof fact.tone === 'string' && fact.tone.trim()) ? fact.tone.trim() : '';
        const temporal = temporalTail(fact);
        // INJECTION DE-DUPLICATION: storage keeps BOTH value and note, but the Writer
        // only needs one. When a fact HAS a note, the note already carries the
        // value/summary, so we inject the NOTE IN PLACE OF the value (all tiers) —
        // showing both would be redundant. With no note, inject `Category/key = value`.
        // Keep the KEY (Feature #2b) so the Writer can tell similar facts apart.
        if (note) return `${prefix} ${category}/${fact.key}: ${note}${tone ? ` (${tone})` : ''}${temporal}`;
        if (hasValue) return `${prefix} ${category}/${fact.key} = ${fact.value}${temporal}`;
        // Degenerate: neither value nor note — keep the key so it's still visible.
        return `${prefix} ${category}/${fact.key}${temporal}`;
    };

    // Bucket lines by subject, preserving first-appearance order of both groups and lines.
    const MISC_KEY = ' misc'; // sentinel that can't collide with a real subject
    const order = [];                  // subject keys in first-appearance order
    const groups = new Map();          // subjectKey -> { label, lines: string[] }
    for (const { fact, category } of results) {
        const subjRaw = String(deriveSubject(fact) ?? '').trim();
        const key = subjRaw ? subjRaw.toLowerCase() : MISC_KEY;
        if (!groups.has(key)) {
            // One-word header: the subject as stored (or "Misc" for the no-subject bucket).
            groups.set(key, { label: subjRaw || 'Misc', lines: [] });
            order.push(key);
        }
        groups.get(key).lines.push(formatLine(fact, category));
    }

    // Emit "Misc" last (a trailing catch-all reads better than leading with un-grouped rows).
    order.sort((a, b) => (a === MISC_KEY ? 1 : 0) - (b === MISC_KEY ? 1 : 0));

    const out = [];
    for (const key of order) {
        const g = groups.get(key);
        out.push(`[${g.label}]`);
        for (const line of g.lines) out.push(line);
    }
    return out.join('\n');
}

/**
 * Extract keywords from recent chat messages for context-aware retrieval
 * @param {Array} messages - Recent chat messages
 * @returns {string[]}
 */
// Common English words that get capitalized at start of sentences but aren't proper nouns
const STOP_WORDS = new Set([
    'the', 'she', 'her', 'his', 'him', 'they', 'them', 'their', 'its',
    'was', 'were', 'has', 'had', 'have', 'are', 'been', 'being',
    'this', 'that', 'these', 'those', 'what', 'which', 'who', 'whom',
    'will', 'would', 'could', 'should', 'might', 'must', 'shall',
    'not', 'but', 'and', 'for', 'nor', 'yet', 'with', 'from',
    'you', 'your', 'yours', 'our', 'ours', 'mine',
    'here', 'there', 'where', 'when', 'then', 'than', 'how', 'why',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any',
    'just', 'very', 'too', 'also', 'still', 'even', 'only', 'now',
    'said', 'says', 'told', 'asked', 'looked', 'went', 'came', 'got',
    'like', 'just', 'know', 'think', 'make', 'made', 'take', 'took',
    'see', 'saw', 'come', 'want', 'give', 'gave', 'use', 'used',
    'did', 'does', 'done', 'get', 'gets', 'let', 'say', 'try',
    'one', 'two', 'first', 'last', 'new', 'old', 'good', 'bad',
    'long', 'little', 'big', 'small', 'much', 'well', 'back',
    'down', 'over', 'after', 'before', 'between', 'under', 'again',
    'into', 'through', 'about', 'around', 'against', 'along',
    'something', 'anything', 'nothing', 'everything', 'someone', 'anyone',
    'way', 'day', 'time', 'thing', 'man', 'woman', 'hand', 'head',
    'eye', 'eyes', 'face', 'voice', 'door', 'room', 'floor', 'side',
    'moment', 'mouth', 'words', 'word', 'thought', 'felt', 'found',
    'turned', 'pulled', 'pushed', 'stood', 'sat', 'held', 'left',
    'right', 'looked', 'nodded', 'closed', 'opened', 'moved', 'watched',
    'kept', 'heard', 'reached', 'stepped', 'stopped', 'started',
    'seemed', 'meant', 'tried', 'knew', 'felt', 'ran', 'set',
    'may', 'can', 'own', 'off', 'out', 'away', 'else', 'ever',
    // Contractions (apostrophes stripped upstream)
    'ive', 'ill', 'youre', 'whats', 'dont', 'isnt', 'wasnt', 'hes', 'shes',
    'weve', 'theyre', 'youve', 'theyve', 'cant', 'couldnt', 'wouldnt',
    'shouldnt', 'hasnt', 'havent', 'didnt', 'doesnt', 'arent', 'werent',
    'thats', 'whos', 'lets', 'im', 'youll', 'hell', 'shell', 'well',
    'theyll', 'thatll', 'heres', 'theres', 'wheres',
]);

export function extractContextKeywords(messages) {
    if (!messages || messages.length === 0) return [];

    // Keep original text for capitalization detection, lowercased for trigger matching
    const originalText = messages.map(m => m.mes || '').join(' ');
    const lowerText = originalText.toLowerCase();

    // Extract proper nouns: capitalized words that aren't common English
    const words = originalText.split(/\s+/);
    const keywords = new Set();

    for (const word of words) {
        const clean = word.replace(/[^a-zA-Z0-9]/g, '');
        if (clean.length < 3) continue;

        // Must be capitalized (proper noun candidate)
        if (clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
            const lower = clean.toLowerCase();
            // Filter out stop words (common sentence starters)
            if (!STOP_WORDS.has(lower)) {
                keywords.add(lower);
            }
        }
    }

    // Also check for fallback trigger words
    for (const trigger of Object.keys(FALLBACK_MAPPINGS)) {
        if (lowerText.includes(trigger)) {
            keywords.add(trigger);
        }
    }

    return [...keywords];
}

/**
 * ON-DEMAND "WHY NOT key X?" PROBE. Given a fact key (optionally `Category/key`), re-run the
 * relevant match/visibility logic for that single fact and return + log its fate this turn —
 * turning "it forgot X" into a one-click answer without flooding the per-turn log.
 *
 * @param {string} key - bare key or `Category/key`
 * @param {string[]} [keywords=[]] - current-turn keywords to test keyword/fuzzy matching against
 * @returns {Promise<{found:boolean, reason:string, detail:object}>}
 */
export async function explainFactRetrieval(key, keywords = []) {
    const databases = await getAllDatabases();
    const slashIdx = String(key || '').indexOf('/');
    const wantCat = slashIdx >= 0 ? String(key).slice(0, slashIdx).trim().toLowerCase() : null;
    const wantKey = (slashIdx >= 0 ? String(key).slice(slashIdx + 1) : String(key || '')).trim().toLowerCase();

    let match = null;
    for (const [category, db] of Object.entries(databases)) {
        if (wantCat && category.toLowerCase() !== wantCat) continue;
        for (const fact of (db.facts || [])) {
            if (String(fact.key).toLowerCase() === wantKey) { match = { category, fact }; break; }
        }
        if (match) break;
    }

    // USE-IT-OR-LOSE-IT: surface the use-driven ranking signals on every matched-fact result so
    // the probe shows WHY a fact ranks where it does (how often/recently it was injected).
    const useInfo = match ? {
        useCount: Math.max(0, Math.floor(Number(match.fact?.useCount) || 0)),
        lastUsedAt: Math.max(0, Math.floor(Number(match.fact?.lastUsedAt) || 0)),
    } : {};

    let reason, detail;
    if (!match) {
        reason = 'NEVER_MATCHED';
        detail = { searched: wantCat ? `${wantCat}/${wantKey}` : wantKey, note: 'no stored fact with that key' };
    } else if (!isActiveFact(match.fact)) {
        reason = 'SUPERSEDED_INACTIVE';
        detail = { key: match.fact.key, category: match.category, note: 'fact is a superseded/inactive history snapshot', ...useInfo };
    } else if (!isFactVisible(match.fact)) {
        reason = 'KNOWNBY_INVISIBLE';
        detail = { key: match.fact.key, category: match.category, knownBy: match.fact.knownBy || [], ...useInfo };
    } else {
        // Active + visible: would it have matched the given keywords?
        const kw = (keywords || []).filter(Boolean);
        const hit = kw.length ? searchFacts({ [match.category]: { category: match.category, facts: [match.fact] } }, kw).length > 0 : false;
        reason = hit ? 'WOULD_ADMIT' : (kw.length ? 'NO_KEYWORD_MATCH' : 'ACTIVE_VISIBLE');
        detail = { key: match.fact.key, category: match.category, tier: 'unknown', testedKeywords: kw, keywordHit: hit, ...useInfo };
    }

    addDebugLog('info', `Why-not probe "${key}": ${reason}`, {
        subsystem: 'retrieval', event: 'retrieval.explain', reason, data: detail,
    });
    return { found: !!match, reason, detail };
}

/**
 * Default / hard ceiling on how many facts a single Writer recall tool call may return.
 * The default keeps one pulled answer compact; the hard max bounds even an explicit big
 * `limit` so one tool call can never blow the main model's context.
 */
const RECALL_DEFAULT_LIMIT = 20;
const RECALL_MAX_LIMIT = 40;

/**
 * Detect a SCENE-RECAP intent in a free-text recall query (Spiderweb 2). Deterministic, no LLM.
 * Returns a scene NUMBER (e.g. 3 for "recap scene 3"), a scene NAME string (e.g. "the market"
 * for "recap the market scene"), or null when the query is an ordinary keyword search.
 *   - "scene 3" / "scene #3" / "recap scene 12"            -> the number
 *   - "recap the market scene" / "the <X> scene"           -> the name "<X>"
 *   - "what happened in the market scene" / "recap the market"   -> the name "market"
 * Conservative: a query without the word "scene" (or a "recap/recall/summarize ... scene" frame)
 * is NOT treated as a scene query, so normal keyword recall is unaffected.
 * @param {string} query
 * @returns {number|string|null}
 */
function detectSceneQuery(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const lower = q.toLowerCase();
    // Numeric scene reference: "scene 3", "scene #3", "scene no. 3".
    const numMatch = lower.match(/\bscene\s*#?\s*(?:no\.?\s*)?(\d+)\b/);
    if (numMatch) {
        const n = parseInt(numMatch[1], 10);
        if (n >= 1) return n;
    }
    // Named scene framed by "scene": "the market scene", "recap the market scene".
    // Capture the descriptor that PRECEDES the word "scene".
    const trailing = lower.match(/^(?:recap|recall|summari[sz]e|recount|what happened in|tell me about)?\s*(?:the\s+)?(.+?)\s+scene\b/);
    if (trailing && trailing[1]) {
        const name = trailing[1].replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (name && name !== 'the' && name.length >= 2) return name;
    }
    // Leading frame: "scene: the market" / "scene the market".
    const leading = lower.match(/\bscene\s*:?\s+(?:the\s+)?(.+)$/);
    if (leading && leading[1] && !numMatch) {
        const name = leading[1].replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (name && name.length >= 2) return name;
    }
    return null;
}

/**
 * RELATIONSHIP-THREAD intent detector (Phase 0): sniff a callback-style "history between two
 * people" query from free text and return the pair `[A, B]` of names, else null. Routes to
 * getRelationshipMomentThread. Conservative — it only fires on an EXPLICIT pair frame
 * ("history of A and B", "what happened between A and B", "A and B's history/relationship"), so
 * ordinary keyword recall and the scene-recap path are unaffected. A name is a short run of word
 * characters (with optional spaces/apostrophes for "first date"-style multi-word names is NOT
 * matched — names only); the two captured names are returned trimmed.
 *
 * @param {string} query
 * @returns {[string, string]|null}
 */
function detectRelationshipQuery(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const lower = q.toLowerCase();
    // A name token: letters/digits/apostrophe/hyphen, 2+ chars (kept tight so "and"/"the" don't
    // get captured as names). NO spaces — pair queries name single-token characters.
    const NAME = "([a-z0-9][a-z0-9'\\-]{1,})";
    const frames = [
        // "history of A and B", "the relationship between A and B", "what happened between A and B"
        new RegExp(`\\b(?:history|relationship|story|past)\\s+(?:of|between|with)\\s+${NAME}\\s+(?:and|&|\\+|with)\\s+${NAME}\\b`),
        new RegExp(`\\bbetween\\s+${NAME}\\s+(?:and|&|\\+|with)\\s+${NAME}\\b`),
        // "A and B's history/relationship/past/story"
        new RegExp(`\\b${NAME}\\s+(?:and|&|\\+|with)\\s+${NAME}(?:'s)?\\s+(?:history|relationship|romance|story|past)\\b`),
    ];
    for (const re of frames) {
        const m = lower.match(re);
        if (m && m[1] && m[2]) {
            const a = m[1].trim();
            const b = m[2].trim();
            // Guard against capturing filler words as a "name".
            const STOP = new Set(['the', 'and', 'a', 'an', 'their', 'his', 'her', 'our', 'of', 'to']);
            if (a && b && !STOP.has(a) && !STOP.has(b)) return [a, b];
        }
    }
    return null;
}

/**
 * PULL-DETAIL recall for the Writer's `search_memory` tool (Feature: infinite reach).
 * READ-ONLY, DETERMINISTIC, ZERO-API: reuses the SAME machinery as the normal push path —
 * `getAllDatabases` + `getMemoryIndex` + `searchFactsIndexed` for keyword hits, the exact
 * `Category/key` identity resolver for a handle the Writer copied back from the pushed gist,
 * `isFactVisible` for knownBy visibility, the cold-deprioritized `retrievalSalience` ranking,
 * and `formatFactsForWriter` so the returned lines MATCH the pushed gist style
 * (`Category/key: note` or `Category/key = value`). Never writes, never deletes, never calls
 * an LLM. Hard-capped so a single tool call can't flood the context.
 *
 * SCENE RECALL (Spiderweb 2): when `scene` is given (a number or name), OR the free-text query
 * reads like a scene recap ("recap the market scene", "what happened in scene 3"), this
 * resolves the scene via getFactsByScene and returns that scene's facts — DELIBERATELY INCLUDING
 * cold-tiered AND superseded facts, because a recap wants the WHOLE scene, not just the hot/current
 * set normal retrieval surfaces.
 *
 * RELATIONSHIP-THREAD RECALL (Phase 0): when `with` is given (two names, OR "A and B"/"A,B"), OR
 * the free-text query reads like a couple's history ("history of A and B", "what happened between
 * A and B"), this routes to getRelationshipMomentThread and returns that couple's emotional
 * moment-thread across all scenes — likewise INCLUDING cold + superseded facts so the arc reads
 * whole. A single name returns that character's own moment beats. Takes precedence over keyword
 * search; the explicit `scene` arg still wins over both.
 *
 * @param {Object} params
 * @param {string} params.query - free-text keyword query (required); MAY be a `Category/key`
 *   handle, in which case the exact record is resolved by identity in addition to keyword match.
 * @param {string} [params.category] - optional category filter (case-insensitive); only facts
 *   in this Layer-1 category are returned.
 * @param {number} [params.limit] - optional result cap (clamped 1..RECALL_MAX_LIMIT).
 * @param {(number|string)} [params.scene] - optional scene number or name to recap (full scene,
 *   incl. cold + superseded facts). When set, takes precedence over keyword search.
 * @param {string} [params.with] - optional relationship pair: two character names (e.g. "A and B",
 *   "A, B", or just one name for that character's own beats). Routes to the couple's moment-thread
 *   (incl. cold + superseded). Honored over keyword search; the explicit `scene` arg wins over it.
 * @returns {Promise<{text: string, count: number}>} a compact formatted string (or a clear
 *   "no matches" message) plus the admitted fact count.
 */
export async function searchMemoryForRecall({ query, category, limit, scene, with: withPair } = {}) {
    const q = String(query ?? '').trim();
    const catFilter = String(category ?? '').trim().toLowerCase();
    const cap = Math.min(RECALL_MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || RECALL_DEFAULT_LIMIT));

    // Resolve a scene target: an explicit `scene` arg wins; else sniff a recap intent from the query.
    let sceneTarget = null;
    if (scene !== undefined && scene !== null && String(scene).trim()) {
        sceneTarget = (typeof scene === 'number') ? scene : String(scene).trim();
    } else if (q) {
        sceneTarget = detectSceneQuery(q);
    }

    // Resolve a relationship pair (only when no explicit scene target): an explicit `with` arg
    // wins; else sniff a couple-history intent from the free-text query. `with` may be one name
    // (single-character moment thread) or two names separated by "and"/"&"/"+"/","/"with".
    let relPair = null; // [nameA, nameB|''] | null
    if (sceneTarget === null) {
        if (withPair !== undefined && withPair !== null && String(withPair).trim()) {
            const parts = String(withPair)
                .split(/\s*(?:,|&|\+|\band\b|\bwith\b)\s*/i)
                .map(s => s.trim())
                .filter(Boolean);
            if (parts.length >= 2) relPair = [parts[0], parts[1]];
            else if (parts.length === 1) relPair = [parts[0], ''];
        } else if (q) {
            const detected = detectRelationshipQuery(q);
            if (detected) relPair = detected;
        }
    }

    if (!q && sceneTarget === null && relPair === null) {
        return { text: 'No query provided. Pass a keyword query (or a Category/key handle) to search memory.', count: 0 };
    }

    const databases = await getAllDatabases();
    if (Object.keys(databases).length === 0) {
        return { text: 'No stored memory yet — nothing to search.', count: 0 };
    }

    // RELATIONSHIP-THREAD PATH (Phase 0): return the couple's chronological moment-thread (cold +
    // superseded included), formatted like the push gist. Honors the optional category filter +
    // the hard cap. Bypasses the keyword/index path. Logged for the Debug tab (standing rule).
    if (relPair !== null) {
        const [nameA, nameB] = relPair;
        let relRows = getRelationshipMomentThread(databases, nameA, nameB, { limit: cap });
        if (catFilter) relRows = relRows.filter(r => String(r.category).toLowerCase() === catFilter);
        const ctxR = host.getCtx();
        const namesR = ctxR ? { charName: ctxR.characters?.[ctxR.characterId]?.name || '', userName: ctxR.name1 || '' } : null;
        relRows = relRows.filter(r => isFactVisible(r.fact, namesR));
        const cappedRel = relRows.slice(0, cap);
        addDebugLog('debug', `Relationship recall: ${nameA}${nameB ? ` ↔ ${nameB}` : ' (solo)'} → ${cappedRel.length} moment-thread fact(s)`, {
            subsystem: 'retrieval', event: 'recall.relationship',
            data: {
                pair: [String(nameA || '').slice(0, 40), String(nameB || '').slice(0, 40)],
                returned: cappedRel.length, total: relRows.length,
                includesColdAndSuperseded: true,
            },
        });
        const relText = cappedRel.length
            ? formatFactsForWriter(cappedRel.map(r => ({ fact: r.fact, category: r.category, tier: 'primary' })))
            : `No relationship history found between ${nameA}${nameB ? ` and ${nameB}` : ''}.`;
        return { text: relText, count: cappedRel.length };
    }

    // SCENE-RECALL PATH (Spiderweb 2): return the whole scene (cold + superseded included), ranked
    // chronologically by getFactsByScene, then formatted like the push gist. Honors the optional
    // category filter + the hard cap. Bypasses the keyword/index path entirely.
    if (sceneTarget !== null) {
        let sceneRows = getFactsByScene(databases, sceneTarget);
        if (catFilter) sceneRows = sceneRows.filter(r => String(r.category).toLowerCase() === catFilter);
        const ctxS = host.getCtx();
        const namesS = ctxS ? { charName: ctxS.characters?.[ctxS.characterId]?.name || '', userName: ctxS.name1 || '' } : null;
        sceneRows = sceneRows.filter(r => isFactVisible(r.fact, namesS));
        const cappedScene = sceneRows.slice(0, cap);
        addDebugLog('debug', `Scene recall: "${String(sceneTarget).slice(0, 60)}" → ${cappedScene.length}/${sceneRows.length} fact(s)`, {
            subsystem: 'retrieval', event: 'retrieval.scene_recall',
            data: { scene: String(sceneTarget).slice(0, 60), returned: cappedScene.length, total: sceneRows.length, includesColdAndSuperseded: true },
        });
        const sceneText = cappedScene.length
            ? formatFactsForWriter(cappedScene.map(r => ({ fact: r.fact, category: r.category, tier: 'primary' })))
            : `No facts found for scene "${String(sceneTarget)}".`;
        return { text: sceneText, count: cappedScene.length };
    }

    const index = await getMemoryIndex();

    // FULL-CASCADE CANDIDATE COLLECTION (tool-first strengthening). The recall tool is now the
    // model's PRIMARY way to reach memory (hybrid/tool-only modes), so a weak or oblique query must
    // still hit. We route it through the SAME cascade the push path (retrieveFacts) uses instead of
    // keyword-only: exact handle → keyword index → fuzzy/alias trigram (typos/morphology) → bounded
    // one-hop graph expansion (place⇄event⇄people, relationship refs, sequence tracks). The graph
    // hop is what makes a query about a PLACE surface the people/events linked to it. All of these
    // are the existing deterministic, capped helpers — no new matching logic, no embeddings.
    const directResults = [];
    const seen = new Set();
    const push = (r, tier) => {
        if (!r || !r.fact) return;
        const id = `${r.category}:${r.fact.key}`;
        if (seen.has(id)) return;
        seen.add(id);
        directResults.push({ fact: r.fact, category: r.category, tier: tier || r.tier || 'primary', via: r.via });
    };

    // EXACT-HANDLE lookup: the pushed gist shows `Category/key` handles, so the Writer may pass
    // one back to pull the full record. resolveExactKeys validates against the real store (a
    // hallucinated handle matches nothing), is active-only, and is case/punctuation tolerant.
    if (q.indexOf('/') >= 0) {
        for (const r of resolveExactKeys(databases, [q])) push(r, 'primary');
    }
    // KEYWORD search over the prebuilt index (same matcher as the push path).
    for (const r of searchFactsIndexed(index, databases, [q])) push(r, 'primary');

    // FUZZY/ALIAS fallback (Layer B): trigram-match the query against active facts so typos and
    // morphology ("apartments"→"apartment") still resolve when the keyword path missed. Admits as
    // secondary; never duplicates an exact/keyword hit. Mutates directResults + seen in place.
    fuzzyFallback(databases, [q], directResults, seen);

    // BOUNDED GRAPH EXPANSION (Spiderweb): one-hop place⇄event⇄people / relationship-ref / sequence
    // continuity seeded from whatever the query already surfaced — so searching a place returns who
    // and what is linked to it. Rebuild the dedupe ledger first (fuzzy may have appended), matching
    // retrieveFacts' ordering. Shares the same per-seed + total cap, salience-ranked admitter.
    const alreadyFound = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));
    gatherExpansionCandidates(databases, index, directResults, alreadyFound);

    // Optional category filter (case-insensitive, on the stored category name).
    let candidates = directResults;
    if (catFilter) candidates = candidates.filter(c => String(c.category).toLowerCase() === catFilter);

    // Honor knownBy visibility exactly like normal retrieval (precompute names once).
    const ctx = host.getCtx();
    const names = ctx ? {
        charName: ctx.characters?.[ctx.characterId]?.name || '',
        userName: ctx.name1 || '',
    } : null;
    candidates = candidates.filter(c => isFactVisible(c.fact, names));

    // DETERMINISTIC salience ranking (cold facts deprioritized) — same scorer the push path
    // uses to fill scarce slots — then hard-cap.
    const now = Date.now();
    candidates.sort((a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now));
    const capped = candidates.slice(0, cap);

    addDebugLog('debug', `search_memory recall: "${q.slice(0, 60)}"${catFilter ? ` [cat=${catFilter}]` : ''} → ${capped.length}/${candidates.length} fact(s) (exact+keyword+fuzzy+graph)`, {
        subsystem: 'retrieval', event: 'recall.search',
        data: { query: q.slice(0, 60), category: catFilter || null, returned: capped.length, totalCandidates: candidates.length },
    });

    if (capped.length) {
        // Reuse the push formatter so the recalled lines look identical to the injected gist.
        const text = formatFactsForWriter(capped.map(c => ({ fact: c.fact, category: c.category, tier: 'primary' })));
        return { text, count: capped.length };
    }

    // NO MATCH — return an ACTIONABLE hint (not a dead end) so the model re-queries productively
    // instead of giving up or hallucinating. List the categories that actually exist (capped) so it
    // can narrow, and remind it of the broader angles (names, Category/key handles, scene:/with:).
    const presentCats = Object.keys(databases).filter(cat => (databases[cat]?.facts?.length > 0));
    const hint = presentCats.length
        ? ` Try a broader or different keyword, a character or place name, a "Category/key" handle, or one of the categories present in memory: ${presentCats.slice(0, 12).join(', ')}${presentCats.length > 12 ? ', …' : ''}. You can also recall a scene (scene:) or a relationship history (with:).`
        : ' Memory is nearly empty, so there may be nothing to recall yet.';
    return { text: `No stored facts match "${q}"${catFilter ? ` in category "${category}"` : ''}.${hint}`, count: 0 };
}

/**
 * @typedef {Object} RetrievalResult
 * @property {Array} facts - Retrieved fact objects with tier info
 * @property {string} formatted - Formatted string for Agent 2
 * @property {Object} stats - Count of facts per tier
 */
