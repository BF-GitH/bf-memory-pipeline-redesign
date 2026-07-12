import { getAllDatabases, getMemoryIndex, searchFactsIndexed, getTrackSteps, getFactsByScene, getRelationshipMomentThread, isSequenceFact, isActiveFact, isColdFact, clampImportance, normalizeKind, deriveSubject, deriveScope, useBonus, effectiveRecencyTs, sinceIso } from './database.js';
import { addDebugLog, getSettings } from './settings.js';
import { recencyTail, getTurnNowContext } from './recency.js';
import { wordTokens, tokenSet, cleanWord, isCapitalizedWord, cjkTokens } from './tokenize.js';
import * as host from './host.js';

const FALLBACK_MAPPINGS = {

    'apartment': ['Furniture', 'Rooms', 'Decor'],
    'restaurant': ['Food', 'Menu', 'Food_Preferences'],
    'kitchen': ['Food', 'Cooking', 'Food_Preferences'],
    'bedroom': ['Furniture', 'Sleep', 'Intimacy'],
    'school': ['Classes', 'Teachers', 'Students'],
    'office': ['Work', 'Colleagues', 'Projects'],
    'park': ['Nature', 'Weather', 'Activities'],

    'eating': ['Food', 'Food_Preferences', 'Allergies', 'Restaurants'],
    'cooking': ['Food', 'Food_Preferences', 'Recipes', 'Kitchen'],
    'date': ['Relationship', 'Restaurants', 'Activities', 'Gifts'],
    'shopping': ['Money', 'Preferences', 'Clothing'],
    'working': ['Work', 'Skills', 'Projects'],
    'sleeping': ['Sleep', 'Dreams', 'Bedroom'],
    'fighting': ['Conflict', 'Relationship', 'Emotions'],

    'food': ['Allergies', 'Food_Preferences', 'Cooking'],
    'drink': ['Beverages', 'Allergies', 'Preferences'],
    'snack': ['Food', 'Food_Preferences'],

    'gift': ['Preferences', 'Relationship', 'Special_Dates'],
    'birthday': ['Special_Dates', 'Gifts', 'Preferences'],
    'anniversary': ['Special_Dates', 'Relationship', 'Memories'],
};

export function isFactVisible(fact, names = null) {
    const kb = (fact && fact.knownBy) || [];
    if (kb.length === 0) return true; 
    const s = getSettings();
    if (s && s.enforceKnownBy === false) return true; 
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

const MAX_EXPANSION_PER_SEED = 3;
const MAX_EXPANSION_TOTAL = 16;

const EXACT_KEY_PRIMARY_CAP = 12;

export function buildFactLine(fact, category, nowCtx = null) {
    const knownBy = (fact.knownBy || []).join(', ');
    const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
    const hasValue = String(fact.value ?? '').trim() !== '';
    const note = (typeof fact.context === 'string' && fact.context.trim()) ? fact.context.trim() : '';

    const tone = (typeof fact.tone === 'string' && fact.tone.trim()) ? fact.tone.trim() : '';

    const recency = nowCtx ? recencyTail(fact, nowCtx) : '';

    if (note) return `${prefix} ${category}/${fact.key}: ${note}${tone ? ` (${tone})` : ''}${recency}`;
    if (hasValue) return `${prefix} ${category}/${fact.key} = ${fact.value}${recency}`;

    return `${prefix} ${category}/${fact.key}${recency}`;
}

const SUBJECT_MISC_KEY = ' misc';
function subjectGroupKey(fact) {
    const subjRaw = String(deriveSubject(fact) ?? '').trim();
    return subjRaw ? subjRaw.toLowerCase() : SUBJECT_MISC_KEY;
}
function subjectGroupLabel(fact) {
    const subjRaw = String(deriveSubject(fact) ?? '').trim();
    return subjRaw || 'Misc';
}

function estimateInjectionTokens(r, seenSubjects = null) {
    const f = r.fact;

    let nowCtx = null;
    try { nowCtx = getTurnNowContext(); } catch {  }
    let chars = buildFactLine(f, r.category, nowCtx).length;
    if (seenSubjects && !seenSubjects.has(subjectGroupKey(f))) {

        chars += subjectGroupLabel(f).length + 3;
    }
    return Math.ceil(chars / 4);
}

export async function retrieveFacts(neededInfo, contextKeywords = []) {
    const databases = await getAllDatabases();

    const index = await getMemoryIndex();
    const dbCount = Object.keys(databases).length;
    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    addDebugLog('info', `Retrieval: ${dbCount} databases loaded (${totalFacts} total facts)`);

    if (dbCount === 0) {
        addDebugLog('info', 'No databases exist yet, skipping retrieval');
        return { facts: [], formatted: '', stats: { primary: 0, secondary: 0, tertiary: 0 } };
    }

    const allKeywords = [...new Set([...neededInfo, ...contextKeywords])];
    addDebugLog('info', `Retrieval keywords: ${allKeywords.join(', ')}`);

    const directResults = resolveExactKeys(databases, neededInfo);
    const exactIds = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));

    for (const r of searchFactsIndexed(index, databases, allKeywords)) {
        const id = `${r.category}:${r.fact.key}`;
        if (!exactIds.has(id)) {
            if (r.via == null) r.via = 'keyword';
            directResults.push(r);
            exactIds.add(id);
        }
    }

    fuzzyFallback(databases, neededInfo, directResults, exactIds);

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

    const fallbackResults = searchFactsIndexed(index, databases, [...fallbackKeywords]);
    const alreadyFound = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));

    for (const result of fallbackResults) {
        const id = `${result.category}:${result.fact.key}`;
        if (!alreadyFound.has(id)) {

            result.tier = result.tier === 'primary' ? 'secondary' : 'tertiary';
            if (result.via == null) result.via = 'link';
            directResults.push(result);
            alreadyFound.add(id);
        }
    }

    gatherExpansionCandidates(databases, index, directResults, alreadyFound);

    const MAX_SECONDARY = 12;
    const MAX_TERTIARY = 6;
    const now = Date.now();
    const cfg = (() => { try { return getSettings(); } catch { return null; } })() || {};

    const budget = 800;
    const cutoffDays = Number(cfg.recencyCutoffDays) || 0;
    const cutoffIso = cutoffDays > 0 ? sinceIso(cutoffDays) : null;
    const passesRecency = (r) => !cutoffIso || !r.fact.createdAt || r.fact.createdAt >= cutoffIso;

    const exactPrimaries = directResults.filter(r => r.tier === 'primary' && r.via === 'exact');
    if (exactPrimaries.length > EXACT_KEY_PRIMARY_CAP) {
        exactPrimaries.sort((a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now));
        const demoted = exactPrimaries.slice(EXACT_KEY_PRIMARY_CAP);
        for (const r of demoted) r.tier = 'secondary';
        addDebugLog('info', `Exact-key primary cap: ${exactPrimaries.length} exact-key primaries exceed cap ${EXACT_KEY_PRIMARY_CAP} — demoted ${demoted.length} (lowest salience) to secondary`, {
            subsystem: 'retrieval', event: 'retrieval.primary_cap',
            data: { exact: exactPrimaries.length, cap: EXACT_KEY_PRIMARY_CAP, demoted: demoted.length, demotedKeys: demoted.slice(0, 10).map(r => `${r.category}/${r.fact.key}`) },
        });
    }

    const primary = directResults.filter(r => r.tier === 'primary');
    let secondary = directResults.filter(r => r.tier === 'secondary');
    let tertiary = directResults.filter(r => r.tier === 'tertiary');

    const excludedByReason = {};
    const recordExclude = (r, reason, extra = {}) => {
        excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
        addDebugLog('debug', `Retrieval excluded ${r.category}/${r.fact.key} (${reason})`, {
            subsystem: 'retrieval', event: 'retrieval.exclude', reason,
            data: { key: r.fact.key, category: r.category, tier: r.tier, ...extra },
        });
    };

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

    if (cfg.mmrEnabled !== false) {
        try {
            const lambda = (typeof cfg.mmrLambda === 'number' && cfg.mmrLambda >= 0 && cfg.mmrLambda <= 1) ? cfg.mmrLambda : 0.7;
            secondary = mmrRerank(secondary, lambda, now);
            tertiary = mmrRerank(tertiary, lambda, now);
        } catch (e) {

            addDebugLog('debug', `MMR rerank skipped: ${e?.message || e}`, { subsystem: 'retrieval', event: 'retrieval.mmr.error' });
        }
    }

    const estSeenSubjects = new Set();
    const markSubjectSeen = (r) => estSeenSubjects.add(subjectGroupKey(r.fact));
    let usedTokens = primary.reduce((sum, r) => {
        const cost = estimateInjectionTokens(r, estSeenSubjects);
        markSubjectSeen(r);
        return sum + cost;
    }, 0);

    if (usedTokens > budget) {
        const trackSteps = primary.filter(r => isSequenceFact(r.fact)).length;
        addDebugLog('info', `WARNING: primary facts alone are ~${usedTokens} tokens — over the ${budget}-token retrieval budget before any secondary/tertiary admission (${primary.length} primaries, incl. ${trackSteps} track-continuity step(s))`, {
            subsystem: 'retrieval', event: 'retrieval.warn.primary_over_budget',
            data: { primaryTokens: usedTokens, budget, primaryCount: primary.length, trackContinuitySteps: trackSteps },
        });
    }
    const admitted = [];
    const admitTier = (list, maxCount, capReason) => {
        let n = 0;
        for (const r of list) {
            if (n >= maxCount) { recordExclude(r, capReason, { rank: n + 1, of: list.length, score: Number(retrievalSalience(r.fact, now).toFixed(3)) }); continue; }
            const cost = estimateInjectionTokens(r, estSeenSubjects);
            if (admitted.length > 0 && usedTokens + cost > budget) {
                recordExclude(r, 'CAP_TOKENS', { usedTokens, budget, score: Number(retrievalSalience(r.fact, now).toFixed(3)) });
                continue;
            }
            admitted.push(r); usedTokens += cost; markSubjectSeen(r); n++;
        }
    };
    admitTier(secondary, MAX_SECONDARY, 'CAP_SECONDARY');
    admitTier(tertiary, MAX_TERTIARY, 'CAP_TERTIARY');
    const filteredResults = [...primary, ...admitted];

    const visibleResults = filteredResults.filter((r) => {
        if (isFactVisible(r.fact)) return true;
        recordExclude(r, 'KNOWNBY_INVISIBLE', { knownBy: r.fact.knownBy || [] });
        return false;
    });

    for (const r of visibleResults) {
        addDebugLog('debug', `Retrieval admit ${r.category}/${r.fact.key} (${r.tier[0].toUpperCase()}, via ${r.via || 'keyword'})`, {
            subsystem: 'retrieval', event: 'retrieval.admit',
            data: { key: r.fact.key, category: r.category, tier: r.tier, via: r.via || 'keyword' },
        });
    }

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

const FUZZY_THRESHOLD = 0.4;

function trigramSimilarity(a, b) {
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

function mmrCandidateText(r) {
    const f = r.fact || {};
    const tags = Array.isArray(f.tags) ? f.tags.join(' ') : '';
    return `${f.key || ''} ${f.value || ''} ${tags}`.trim();
}

function mmrRerank(list, lambda, now) {
    if (!Array.isArray(list) || list.length <= 2) return list; 

    const hotPart = list.filter(r => !isColdFact(r.fact));
    const coldPart = list.filter(r => isColdFact(r.fact));
    if (hotPart.length > 0 && coldPart.length > 0) {
        return [...mmrRerank(hotPart, lambda, now), ...mmrRerank(coldPart, lambda, now)];
    }

    const sal = list.map(r => retrievalSalience(r.fact, now));
    let lo = Infinity, hi = -Infinity;
    for (const s of sal) { if (s < lo) lo = s; if (s > hi) hi = s; }
    const span = hi - lo;
    const norm = (i) => (span > 0 ? (sal[i] - lo) / span : 1); 
    const texts = list.map(mmrCandidateText);

    const remaining = list.map((_, i) => i); 
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

            if (score > bestScore) { bestScore = score; bestPos = p; }
        }
        chosenIdx.push(remaining[bestPos]);
        remaining.splice(bestPos, 1);
    }
    return chosenIdx.map(i => list[i]);
}

function fuzzyFallback(databases, neededInfo, results, seenIds) {

    const primaries = results.filter(r => r.tier === 'primary');
    const primaryTokenSets = primaries.map(r => {
        const text = `${r.fact.key} ${r.fact.value} ${(r.fact.tags || []).join(' ')} ${(r.fact.aliases || []).join(' ')}`;
        return tokenSet(text, { min: 1 }); 
    });

    let admitted = 0;
    for (const raw of (neededInfo || [])) {
        const entry = String(raw || '').trim();
        if (!entry) continue;
        if (entry.indexOf('/') >= 0) continue; 
        const entryLower = entry.toLowerCase();

        const words = wordTokens(entryLower);
        const entryTokens = words;

        const covered = entryTokens.length > 0 && primaryTokenSets.some(tokens => {
            let matched = 0;
            for (const w of entryTokens) if (tokens.has(w)) matched++;
            return matched * 2 > entryTokens.length;
        });
        if (covered) continue;

        const entryWords = words.length > 0 ? words : [entryLower];
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact)) continue; 
                const id = `${category}:${fact.key}`;
                if (seenIds.has(id)) continue; 
                const factText = `${fact.key} ${fact.value} ${(fact.tags || []).join(' ')} ${(fact.aliases || []).join(' ')}`.toLowerCase();
                const tokens = wordTokens(factText, { min: 3 }); 
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

function resolveExactKeys(databases, requests) {
    const results = [];
    const seen = new Set();

    const norm = (s) => String(s)
        .trim()
        .replace(/^[\s\-*•"'`(\[\{]+/, '')
        .replace(/[\s.,;:"'`)\]\}]+$/, '')
        .trim()
        .toLowerCase();
    for (const raw of (requests || [])) {
        const slashIdx = String(raw).indexOf('/');
        if (slashIdx < 0) continue; 
        const reqCat = norm(raw.slice(0, slashIdx));
        const reqKey = norm(raw.slice(slashIdx + 1));
        if (!reqCat || !reqKey) continue;
        for (const [category, db] of Object.entries(databases)) {
            if (category.toLowerCase() !== reqCat) continue;
            for (const fact of (db.facts || [])) {
                if (String(fact.key).toLowerCase() !== reqKey) continue;
                if (!isActiveFact(fact)) continue; 
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

const RETRIEVAL_IMPORTANCE_WEIGHT = 0.65;
const RETRIEVAL_RECENCY_WEIGHT = 0.35;

const RETRIEVAL_HALF_LIFE_DAYS = { trait: 90, state: 3, event: 7, moment: 30 };

const RETRIEVAL_COLD_PENALTY = 1000;

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

    const last = effectiveRecencyTs(fact);
    const ageDays = last > 0 ? Math.max(0, (now - last) / 86400000) : 36500;
    const halfLife = RETRIEVAL_HALF_LIFE_DAYS[kind] || RETRIEVAL_HALF_LIFE_DAYS.trait;
    const recency = Math.pow(0.5, ageDays / halfLife);
    let base = RETRIEVAL_IMPORTANCE_WEIGHT * (importance / 5) + RETRIEVAL_RECENCY_WEIGHT * recency + useBonus(fact?.useCount);

    try {
        const w = 0.3;
        const mult = 1 - w * (1 - confidenceFactor(fact));
        base *= mult;
    } catch {  }
    return isColdFact(fact) ? base - RETRIEVAL_COLD_PENALTY : base;
}

const TRACK_REACH_STEPS = 2;

function expandSequenceTracks(databases, seeds, alreadyFound) {

    const tracks = new Set();
    for (const r of seeds) {
        if (isSequenceFact(r.fact)) tracks.add(r.fact.track);
    }
    if (tracks.size === 0) return [];

    const candidates = [];

    for (const track of tracks) {
        const steps = getTrackSteps(databases, track); 
        if (steps.length === 0) continue;

        const reach = TRACK_REACH_STEPS;

        const includeCount = Math.min(reach + 1, steps.length);
        const slice = steps.slice(steps.length - includeCount); 

        for (const { fact, category } of slice) {
            const id = `${category}:${fact.key}`;
            if (alreadyFound.has(id)) continue;
            candidates.push({ fact, category, tier: 'primary', via: 'link', seedId: `track:${track}` });
        }
        addDebugLog('info', `Depth-dice track "${track}": deterministic reach ${reach} → ${includeCount}/${steps.length} step(s) eligible`);
    }
    return candidates;
}

function linkToken(s) {
    return String(s ?? '').trim().toLowerCase();
}

export function randomWalkExtras(databases, seedRows, alreadySeen, count) {
    const max = Math.max(0, Math.floor(Number(count) || 0));
    if (max <= 0) return [];
    const seeds = (Array.isArray(seedRows) ? seedRows : []).filter(r => r && r.fact);
    if (seeds.length === 0) return [];

    const seen = new Set(alreadySeen instanceof Set ? alreadySeen : []);
    for (const r of seeds) seen.add(`${r.category}:${r.fact.key}`);

    const extras = [];       
    const collected = [];     

    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    const neighborsOf = (row) => collectLinkCandidates(databases, [row], seen);

    let current = pick(seeds);
    let stalls = 0;

    const maxStalls = seeds.length + max + 4;
    while (extras.length < max) {
        const neighbors = neighborsOf(current);
        if (neighbors.length > 0) {
            const chosen = pick(neighbors);
            seen.add(`${chosen.category}:${chosen.fact.key}`);
            const row = { fact: chosen.fact, category: chosen.category, tier: chosen.tier || 'secondary' };
            extras.push(row);
            collected.push(row);
            current = row; 
            stalls = 0;
        } else {

            if (++stalls > maxStalls) break;
            current = pick(collected.length > 0 ? collected : seeds);
        }
    }
    return extras;
}

function collectLinkCandidates(databases, seeds, alreadyFound) {

    const relevantPlaces = new Set();   
    const relevantPeople = new Set();   
    const seedEvents = [];              
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

    const eventQueue = seedEvents.slice();

    const emitted = new Set();
    const candidates = [];
    const emit = (category, fact, seedId) => {
        if (!fact) return false;
        if (!isActiveFact(fact)) return false;          
        if (!isFactVisible(fact)) return false;          
        const id = `${category}:${fact.key}`;
        if (alreadyFound.has(id) || emitted.has(id)) return false;
        emitted.add(id);
        candidates.push({ fact, category, tier: 'secondary', via: 'link', seedId });
        return true;
    };

    if (relevantPlaces.size > 0 || relevantPeople.size > 0) {
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (deriveScope(fact) !== 'event') continue;
                if (!isActiveFact(fact)) continue;
                const id = `${category}:${fact.key}`;
                if (alreadyFound.has(id) || emitted.has(id)) continue;
                let hitSeed = null;

                const loc = linkToken(fact.location);
                if (loc && relevantPlaces.size > 0) {
                    for (const place of relevantPlaces) {
                        if (loc === place || loc.startsWith(place + '_') || place.startsWith(loc + '_')) {
                            hitSeed = `place:${place}`;
                            break;
                        }
                    }
                }

                if (!hitSeed && relevantPeople.size > 0 && Array.isArray(fact.involved)) {
                    for (const p of fact.involved) {
                        const pt = linkToken(p);
                        if (relevantPeople.has(pt)) { hitSeed = `person:${pt}`; break; }
                    }
                }
                if (hitSeed && emit(category, fact, hitSeed)) {
                    eventQueue.push(fact); 
                }
            }
        }
    }

    if (eventQueue.length > 0) {

        const placesBySubject = new Map();  
        const peopleBySubject = new Map();  
        for (const [category, db] of Object.entries(databases)) {
            for (const fact of (db.facts || [])) {
                if (!isActiveFact(fact)) continue;
                const subj = linkToken(deriveSubject(fact));
                if (!subj) continue;
                const scope = deriveScope(fact);
                const map = scope === 'place' ? placesBySubject : (scope === 'character' ? peopleBySubject : null);
                if (!map) continue; 
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

            const loc = linkToken(ev.location);
            if (loc && placesBySubject.has(loc)) {
                for (const { category, fact } of placesBySubject.get(loc)) emit(category, fact, evSeed);
            }

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

function collectSceneCandidates(index, seeds, alreadyFound) {
    const bySceneNo = index && index.bySceneNo;
    if (!bySceneNo || bySceneNo.size === 0) return [];

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
            if (!isActiveFact(fact)) continue;        
            if (!isFactVisible(fact)) continue;        
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

        const refs = [
            ...(seed.fact.relationships.primary || []),
            ...(seed.fact.relationships.secondary || []),
        ];
        if (refs.length === 0) continue;
        const seedId = `ref:${seed.category}:${seed.fact.key}`;

        for (const r of searchFactsIndexed(index, databases, refs)) {
            const id = `${r.category}:${r.fact.key}`;
            if (alreadyFound.has(id) || emitted.has(id)) continue;
            if (!isActiveFact(r.fact)) continue;       
            if (!isFactVisible(r.fact)) continue;       
            emitted.add(id);

            candidates.push({ fact: r.fact, category: r.category, tier: 'tertiary', via: 'link', seedId });
        }
    }
    return candidates;
}

function gatherExpansionCandidates(databases, index, results, alreadyFound, maxDepth = 1) {
    const now = Date.now();

    const claimed = new Set();      
    const perSeed = new Map();      
    let admittedTotal = 0;
    let cappedBySeed = 0;           
    const seedContrib = new Map();  
    const fromCounts = { link: 0, scene: 0, ref: 0, track: 0 };

    const admit = (c, { perSeedCapped, demote }) => {
        if (admittedTotal >= MAX_EXPANSION_TOTAL) return null;
        const id = `${c.category}:${c.fact.key}`;
        if (alreadyFound.has(id) || claimed.has(id)) return null;
        if (perSeedCapped) {
            const used = perSeed.get(c.seedId) || 0;
            if (used >= MAX_EXPANSION_PER_SEED) { cappedBySeed++; return null; }
            perSeed.set(c.seedId, used + 1);
        }
        claimed.add(id);
        alreadyFound.add(id);

        const row = { fact: c.fact, category: c.category, tier: demote ? 'tertiary' : c.tier, via: c.via };
        results.push(row);
        admittedTotal++;
        seedContrib.set(c.seedId, (seedContrib.get(c.seedId) || 0) + 1);
        return row;
    };

    const depth = Math.max(1, Math.min(3, Math.floor(Number(maxDepth)) || 1));
    let frontier = results.slice();
    for (let hop = 0; hop < depth && frontier.length && admittedTotal < MAX_EXPANSION_TOTAL; hop++) {
        const seeds = frontier;
        const demote = hop >= 1; 

        const linkCands = collectLinkCandidates(databases, seeds, alreadyFound);
        const refCands = collectRelationshipRefCandidates(index, databases, seeds, alreadyFound);
        const trackCands = expandSequenceTracks(databases, seeds, alreadyFound);

        const sceneCands = collectSceneCandidates(index, seeds, alreadyFound);
        fromCounts.link += linkCands.length; fromCounts.ref += refCands.length;
        fromCounts.track += trackCands.length; fromCounts.scene += sceneCands.length;

        const admittedThisHop = [];

        for (const c of trackCands) { const r = admit(c, { perSeedCapped: false, demote: false }); if (r) admittedThisHop.push(r); }

        const ranked = [...linkCands, ...sceneCands, ...refCands].sort(
            (a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now));
        for (const c of ranked) {
            if (admittedTotal >= MAX_EXPANSION_TOTAL) break;
            const r = admit(c, { perSeedCapped: true, demote }); if (r) admittedThisHop.push(r);
        }
        frontier = admittedThisHop; 
    }

    if (admittedTotal > 0 || cappedBySeed > 0) {

        let topSeed = null, topN = 0;
        for (const [sid, n] of seedContrib) if (n > topN) { topN = n; topSeed = sid; }
        addDebugLog('info', `Unified expansion: admitted ${admittedTotal}/${MAX_EXPANSION_TOTAL} across ${depth} hop(s) (per-seed cap ${MAX_EXPANSION_PER_SEED} blocked ${cappedBySeed}; top seed "${topSeed}" contributed ${topN})`, {
            subsystem: 'retrieval', event: 'retrieval.indexed',
            data: {
                admitted: admittedTotal, total_cap: MAX_EXPANSION_TOTAL,
                per_seed_cap: MAX_EXPANSION_PER_SEED, capped_by_seed: cappedBySeed,
                maxDepth: depth,
                top_seed: topSeed, top_seed_contrib: topN,
                from: fromCounts,
            },
        });
    }
}

export function formatFactsForWriter(results) {
    if (results.length === 0) return '(No stored facts available)';

    const order = [];                  
    const groups = new Map();          
    for (const { fact, category } of results) {
        const key = subjectGroupKey(fact);
        if (!groups.has(key)) {

            groups.set(key, { label: subjectGroupLabel(fact), lines: [] });
            order.push(key);
        }
        groups.get(key).lines.push(buildFactLine(fact, category));
    }

    order.sort((a, b) => (a === SUBJECT_MISC_KEY ? 1 : 0) - (b === SUBJECT_MISC_KEY ? 1 : 0));

    const out = [];
    for (const key of order) {
        const g = groups.get(key);
        out.push(`[${g.label}]`);
        for (const line of g.lines) out.push(line);
    }
    return out.join('\n');
}

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

    'ive', 'ill', 'youre', 'whats', 'dont', 'isnt', 'wasnt', 'hes', 'shes',
    'weve', 'theyre', 'youve', 'theyve', 'cant', 'couldnt', 'wouldnt',
    'shouldnt', 'hasnt', 'havent', 'didnt', 'doesnt', 'arent', 'werent',
    'thats', 'whos', 'lets', 'im', 'youll', 'hell', 'shell', 'well',
    'theyll', 'thatll', 'heres', 'theres', 'wheres',
]);

export function extractContextKeywords(messages) {
    if (!messages || messages.length === 0) return [];

    const originalText = messages.map(m => m.mes || '').join(' ');
    const lowerText = originalText.toLowerCase();

    const words = originalText.split(/\s+/);
    const keywords = new Set();

    for (const word of words) {

        const clean = cleanWord(word);
        const minLen = /^[\p{sc=Latin}0-9]+$/u.test(clean) ? 3 : 2;
        if (clean.length < minLen) continue;

        if (isCapitalizedWord(clean)) {
            const lower = clean.toLowerCase();

            if (!STOP_WORDS.has(lower)) {
                keywords.add(lower);
            }
        }
    }

    for (const tok of cjkTokens(originalText).slice(0, 15)) {
        keywords.add(tok);
    }

    for (const trigger of Object.keys(FALLBACK_MAPPINGS)) {
        if (lowerText.includes(trigger)) {
            keywords.add(trigger);
        }
    }

    return [...keywords];
}

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

        const kw = (keywords || []).filter(Boolean);
        const factText = `${match.fact.key} ${match.fact.value} ${(match.fact.tags || []).join(' ')} ${(match.fact.aliases || []).join(' ')}`.toLowerCase();
        const catLower = match.category.toLowerCase();
        const hit = kw.some(k => {
            const words = wordTokens(k); 
            if (words.length === 0) return false;
            const n = words.filter(w => factText.includes(w) || catLower.includes(w)).length;
            return words.length === 1 ? n >= 1 : n >= 2;
        });
        reason = hit ? 'WOULD_ADMIT' : (kw.length ? 'NO_KEYWORD_MATCH' : 'ACTIVE_VISIBLE');
        detail = { key: match.fact.key, category: match.category, tier: 'unknown', testedKeywords: kw, keywordHit: hit, ...useInfo };
    }

    addDebugLog('info', `Why-not probe "${key}": ${reason}`, {
        subsystem: 'retrieval', event: 'retrieval.explain', reason, data: detail,
    });
    return { found: !!match, reason, detail };
}

const RECALL_DEFAULT_LIMIT = 20;
const RECALL_MAX_LIMIT = 40;

function detectSceneQuery(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const lower = q.toLowerCase();

    const numMatch = lower.match(/\bscene\s*#?\s*(?:no\.?\s*)?(\d+)\b/);
    if (numMatch) {
        const n = parseInt(numMatch[1], 10);
        if (n >= 1) return n;
    }

    const trailing = lower.match(/^(?:recap|recall|summari[sz]e|recount|what happened in|tell me about)?\s*(?:the\s+)?(.+?)\s+scene\b/);
    if (trailing && trailing[1]) {
        const name = trailing[1].replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (name && name !== 'the' && name.length >= 2) return name;
    }

    const leading = lower.match(/\bscene\s*:?\s+(?:the\s+)?(.+)$/);
    if (leading && leading[1] && !numMatch) {
        const name = leading[1].replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (name && name.length >= 2) return name;
    }
    return null;
}

function detectRelationshipQuery(query) {
    const q = String(query || '').trim();
    if (!q) return null;
    const lower = q.toLowerCase();

    const NAME = "([a-z0-9][a-z0-9'\\-]{1,})";
    const frames = [

        new RegExp(`\\b(?:history|relationship|story|past)\\s+(?:of|between|with)\\s+${NAME}\\s+(?:and|&|\\+|with)\\s+${NAME}\\b`),
        new RegExp(`\\bbetween\\s+${NAME}\\s+(?:and|&|\\+|with)\\s+${NAME}\\b`),

        new RegExp(`\\b${NAME}\\s+(?:and|&|\\+|with)\\s+${NAME}(?:'s)?\\s+(?:history|relationship|romance|story|past)\\b`),

        new RegExp(`\\b${NAME}(?:'s)?\\s+(?:history|relationship|romance|story|past)\\s+(?:to|with)\\s+${NAME}\\b`),
    ];
    for (const re of frames) {
        const m = lower.match(re);
        if (m && m[1] && m[2]) {
            const a = m[1].trim();
            const b = m[2].trim();

            const STOP = new Set(['the', 'and', 'a', 'an', 'their', 'his', 'her', 'our', 'of', 'to']);
            if (a && b && !STOP.has(a) && !STOP.has(b)) return [a, b];
        }
    }
    return null;
}

export async function searchMemoryForRecall({ query, category, limit, scene, with: withPair } = {}) {
    const q = String(query ?? '').trim();
    const catFilter = String(category ?? '').trim().toLowerCase();
    const cap = Math.min(RECALL_MAX_LIMIT, Math.max(1, Math.floor(Number(limit)) || RECALL_DEFAULT_LIMIT));

    let sceneTarget = null;
    if (scene !== undefined && scene !== null && String(scene).trim()) {
        sceneTarget = (typeof scene === 'number') ? scene : String(scene).trim();
    } else if (q) {
        sceneTarget = detectSceneQuery(q);
    }

    let relPair = null; 
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

    const directResults = [];
    const seen = new Set();
    const push = (r, tier) => {
        if (!r || !r.fact) return;
        const id = `${r.category}:${r.fact.key}`;
        if (seen.has(id)) return;
        seen.add(id);
        directResults.push({ fact: r.fact, category: r.category, tier: tier || r.tier || 'primary', via: r.via });
    };

    const isHandleQuery = q.indexOf('/') >= 0;
    if (isHandleQuery) {
        for (const r of resolveExactKeys(databases, [q])) push(r, 'primary');
    }

    const handleResolved = isHandleQuery && directResults.length > 0;
    if (!handleResolved) {

        for (const r of searchFactsIndexed(index, databases, [q])) push(r);

        fuzzyFallback(databases, [q], directResults, seen);

        const alreadyFound = new Set(directResults.map(r => `${r.category}:${r.fact.key}`));
        gatherExpansionCandidates(databases, index, directResults, alreadyFound, 2);

        for (const r of directResults) seen.add(`${r.category}:${r.fact.key}`);
    }

    let candidates = directResults;
    if (catFilter) candidates = candidates.filter(c => String(c.category).toLowerCase() === catFilter);

    const ctx = host.getCtx();
    const names = ctx ? {
        charName: ctx.characters?.[ctx.characterId]?.name || '',
        userName: ctx.name1 || '',
    } : null;
    candidates = candidates.filter(c => isFactVisible(c.fact, names));

    const now = Date.now();
    const TIER_RANK = { primary: 0, secondary: 1, tertiary: 2 };
    candidates.sort((a, b) => {
        const tr = (TIER_RANK[a.tier] ?? 3) - (TIER_RANK[b.tier] ?? 3);
        if (tr !== 0) return tr;
        return retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now);
    });
    const capped = candidates.slice(0, cap);

    addDebugLog('debug', `search_memory recall: "${q.slice(0, 60)}"${catFilter ? ` [cat=${catFilter}]` : ''} → ${capped.length}/${candidates.length} fact(s) (exact+keyword+fuzzy+graph)`, {
        subsystem: 'retrieval', event: 'recall.search',
        data: { query: q.slice(0, 60), category: catFilter || null, returned: capped.length, totalCandidates: candidates.length },
    });

    if (capped.length) {

        let text = formatFactsForWriter(capped.map(c => ({ fact: c.fact, category: c.category, tier: 'primary' })));

        return { text, count: capped.length };
    }

    let hint;
    if (catFilter) {
        hint = ` No facts in category "${category}" matched. Try without the category filter, a different keyword, or a "Category/key" handle.`;
    } else {
        const presentCats = Object.keys(databases).filter(cat => (databases[cat]?.facts?.length > 0));
        hint = presentCats.length
            ? ` Try a broader or different keyword, a character or place name, a "Category/key" handle, or one of the categories present in memory: ${presentCats.slice(0, 12).join(', ')}${presentCats.length > 12 ? ', …' : ''}. You can also recall a scene (scene:) or a relationship history (with:).`
            : ' Memory is nearly empty, so there may be nothing to recall yet.';
    }
    return { text: `No stored facts match "${q}"${catFilter ? ` in category "${category}"` : ''}.${hint}`, count: 0 };
}
