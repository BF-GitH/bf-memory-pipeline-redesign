// BF Memory Pipeline - World Info interop (lorebook export/import, manual)
//
// Two MANUAL, on-demand Database-tab actions (buttons live in settings.html, flows in
// settings.js — this module mirrors taxonomy-suggest.js: it MINES, PROMPTS, PARSES and
// CONVERTS, but NEVER persists):
//   EXPORT — turn the fact store into a standard SillyTavern World Info book (lorebook):
//     one entry per active fact OR one entry per shelf (category+aspect bucket, the same
//     bucketing the reflection pyramid uses). Trigger keywords come from a bounded set of
//     LLM calls (STMB keyword doctrine: concrete scene nouns, no character names, no
//     abstract themes, no compound keys) with an unconditional post-parse sanitizer and a
//     deterministic no-LLM fallback, so a null/failed profile degrades instead of blocking.
//   IMPORT — parse a World Info book (entries-map book file, character-book v2, or array
//     export) and convert each enabled entry into a FactSchema fact (merge-only; the
//     persistence contract lives in settings.js importWorldInfoFromJson).
//
// COST: export makes AT MOST MAX_KEYWORD_CALLS LLM calls (UNITS_PER_KEYWORD_CALL units per
// call, semaphore 2, overflow batches go deterministic), and ONLY from the button click
// after an explicit confirm that spells the call count out. NO per-turn cost, NO event
// hookup, NO automatic firing. Import makes NO LLM calls at all.
//
// NOTE: importing addDebugLog/addAgent3Tokens from settings.js is the SAME intentional ESM
// cycle taxonomy-suggest.js uses (safe because this module is side-effect-free at top level
// and only called long after init).

import { isActiveFact, isColdFact, deriveAspect, mapLegacyCategory } from './database.js';
import { addDebugLog, addAgent3Tokens } from './settings.js';
import { callAgentLLM, createSemaphore } from './llm-call.js';
import * as host from './host.js';

// Hard cap on exported entries (most-important/newest first) so a huge DB can't produce an
// unusable thousand-entry lorebook or an unbounded keyword bill.
export const MAX_EXPORT_UNITS = 400;
// Units bundled into ONE keyword LLM call, and the hard cap on calls per export. Anything
// beyond UNITS_PER_KEYWORD_CALL * MAX_KEYWORD_CALLS falls back to deterministic keywords.
export const UNITS_PER_KEYWORD_CALL = 20;
export const MAX_KEYWORD_CALLS = 12;
// STMB keyword doctrine: 15-30 concrete keywords per entry (the model is asked for this
// range; the sanitizer caps at KEYWORDS_MAX; deterministic fallback may return fewer).
export const KEYWORDS_MIN = 15;
export const KEYWORDS_MAX = 30;
// Import-side caps: entry content becomes a fact VALUE (Unsorted is scanned every turn, so
// long prose must be clamped), and a pathological file can't flood the store.
export const MAX_WI_CONTENT_CHARS = 1000;
export const MAX_IMPORT_ENTRIES = 500;
export const MAX_TAGS_FROM_KEYS = 10;
// Per-unit content clamp inside the keyword prompt (one verbose fact can't eat the batch).
const MAX_UNIT_PROMPT_CHARS = 400;
// A parsed AI keyword list shorter than this is "insufficient" — deterministic fallback.
const MIN_PARSED_KEYWORDS = 3;
// How many banned names are spelled out in the user prompt (the sanitizer enforces ALL).
const MAX_BANNED_IN_PROMPT = 60;

// Abstract themes/emotions that make terrible trigger keywords (they fire constantly and
// match nothing specific). Enforced unconditionally by sanitizeKeywords, whatever the model says.
const ABSTRACT_THEMES = new Set([
    'sadness', 'trust', 'love', 'fear', 'anger', 'hope', 'betrayal', 'friendship', 'happiness',
    'loyalty', 'tension', 'conflict', 'emotion', 'emotions', 'relationship', 'relationships',
    'theme', 'mystery', 'drama', 'romance', 'jealousy', 'grief', 'joy', 'despair', 'hatred',
    'courage', 'guilt', 'shame', 'pride', 'sorrow', 'regret', 'desire', 'longing', 'doubt',
]);

// Stopwords for the deterministic (no-LLM) keyword fallback. Only words >= 4 chars are kept,
// so short function words never reach this list.
const FALLBACK_STOPWORDS = new Set([
    'that', 'this', 'with', 'from', 'have', 'were', 'they', 'their', 'there', 'which', 'would',
    'could', 'should', 'about', 'into', 'been', 'when', 'what', 'then', 'them', 'than', 'these',
    'those', 'will', 'your', 'because', 'while', 'where', 'after', 'before', 'over', 'under',
    'also', 'only', 'just', 'very', 'some', 'more', 'most', 'other', 'such', 'even', 'still',
    'both', 'each', 'between', 'during', 'through', 'against', 'being', 'having', 'does',
    'doing', 'said', 'says', 'upon', 'onto', 'like', 'many', 'much', 'well', 'here', 'once',
    'their', 'theirs', 'itself', 'himself', 'herself', 'themselves', 'without', 'within',
]);

export const DEFAULT_WI_KEYWORD_PROMPT = `You are a lorebook-keyword assistant for SillyTavern World Info entries. You are given a numbered list of entries (each one a stored memory fact, or a shelf of related facts). For EVERY entry, output ${KEYWORDS_MIN}-${KEYWORDS_MAX} CONCRETE, scene-specific trigger keywords — the literal nouns, objects, places and actions that would appear in a chat message at the moment this entry's content becomes relevant.

Hard rules:
- ${KEYWORDS_MIN}-${KEYWORDS_MAX} keywords per entry. Single words or short 2-3 word phrases only.
- BANNED: character and persona names (a banned-name list is provided with the entries — never emit any of them, alone or inside a phrase; the entry should fire on WHAT is discussed, not on WHO is speaking).
- BANNED: abstract themes and emotions ("sadness", "trust", "betrayal", "love") — they fire constantly and match nothing specific.
- BANNED: compound keys that glue two ideas together ("tavern meeting with the smith") — split them into their concrete parts instead.
- The test for EVERY keyword: "would this entry deserve to fire if this noun/action were mentioned alone in a message?" If not, drop it.
- Lowercase everything. Do not invent facts; derive keywords only from the entry text given.

# OUTPUT FORMAT (exactly this, nothing else)

#KEYWORDS
+ <entryId> | keyword1, keyword2, keyword3, ...
+ <entryId> | keyword1, keyword2, ...
.

One "+" line per entry, using the exact entryId shown in [brackets] for it. End the block with a single "." line.`;

/**
 * One export unit — a single fact OR one shelf (category+aspect bucket) about to become a
 * World Info entry. `keywords` is attached later by generateKeywords.
 * @typedef {Object} ExportUnit
 * @property {string} id - stable per-export id ('u1', 'u2', …) used in the keyword prompt
 * @property {string} title - lorebook comment ('Category/key' or 'Category / aspect')
 * @property {string[]} contentLines - entry body lines
 * @property {string} category
 * @property {string} aspect
 * @property {number} factCount
 * @property {number} importance - sort key (max importance for shelves)
 * @property {number} lastUpdated - sort key (newest for shelves)
 * @property {string[]} [keywords]
 */

/** deriveAspect that never throws (mirrors taxonomy-suggest's defensive wrapper). */
function safeAspect(fact) {
    try { return deriveAspect(fact) || 'misc'; } catch { return 'misc'; }
}

/**
 * MINING STEP — turn the fact store into export units. Pure read, never mutates.
 *   mode 'fact'  — one unit per ACTIVE fact; content = value (+ context note).
 *   mode 'shelf' — one unit per (canonical category, aspect) bucket — the same shelf
 *                  bucketing agent-reflect's pyramid uses; content = one '- key: value' line
 *                  per fact. Timeline (track) steps are skipped in shelf mode so a sequence
 *                  doesn't spam its shelf with near-duplicates.
 * Cold-tiered facts are skipped unless includeCold. Sorted importance-then-newest first and
 * capped at MAX_EXPORT_UNITS; ids are assigned AFTER the cap so they're dense and stable.
 *
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases
 * @param {{mode?: ('fact'|'shelf'), includeCold?: boolean}} [opts]
 * @returns {ExportUnit[]}
 */
export function collectWorldInfoUnits(databases, { mode = 'fact', includeCold = false } = {}) {
    const units = [];
    if (mode === 'shelf') {
        const buckets = new Map();
        for (const [category, db] of Object.entries(databases || {})) {
            for (const fact of (db?.facts || [])) {
                if (!fact || !isActiveFact(fact)) continue;
                if (!includeCold && isColdFact(fact)) continue;
                if (fact.track) continue; // shelf mode: skip timeline-step near-duplicates
                const canon = mapLegacyCategory(category, fact);
                const aspect = safeAspect(fact);
                const bucketKey = `${canon}␟${aspect}`;
                let bucket = buckets.get(bucketKey);
                if (!bucket) {
                    bucket = { category: canon, aspect, lines: [], factCount: 0, importance: 0, lastUpdated: 0 };
                    buckets.set(bucketKey, bucket);
                }
                const key = String(fact.key || '').trim();
                const value = String(fact.value ?? '').trim();
                if (!key && !value) continue;
                bucket.lines.push(`- ${key}: ${value}`);
                bucket.factCount++;
                bucket.importance = Math.max(bucket.importance, Number(fact.importance) || 0);
                bucket.lastUpdated = Math.max(bucket.lastUpdated, Number(fact.lastUpdated) || 0);
            }
        }
        for (const bucket of buckets.values()) {
            if (bucket.lines.length === 0) continue;
            units.push({
                id: '', title: `${bucket.category} / ${bucket.aspect}`, contentLines: bucket.lines,
                category: bucket.category, aspect: bucket.aspect, factCount: bucket.factCount,
                importance: bucket.importance, lastUpdated: bucket.lastUpdated,
            });
        }
    } else {
        for (const [category, db] of Object.entries(databases || {})) {
            for (const fact of (db?.facts || [])) {
                if (!fact || !isActiveFact(fact)) continue;
                if (!includeCold && isColdFact(fact)) continue;
                const canon = mapLegacyCategory(category, fact);
                const key = String(fact.key || '').trim();
                const value = String(fact.value ?? '').trim();
                if (!key && !value) continue;
                const note = (typeof fact.context === 'string' && fact.context.trim()) ? ` — ${fact.context.trim()}` : '';
                units.push({
                    id: '', title: `${canon}/${key}`, contentLines: [value + note],
                    category: canon, aspect: safeAspect(fact), factCount: 1,
                    importance: Number(fact.importance) || 0, lastUpdated: Number(fact.lastUpdated) || 0,
                });
            }
        }
    }
    units.sort((a, b) => (b.importance - a.importance) || (b.lastUpdated - a.lastUpdated));
    const capped = units.slice(0, MAX_EXPORT_UNITS);
    capped.forEach((u, i) => { u.id = `u${i + 1}`; });
    return capped;
}

/**
 * Build the lowercase banned-name set the keyword doctrine forbids: the current character,
 * the user persona, every character-card name, plus per-fact knownBy/subject tokens from the
 * store (a name mentioned only in facts is still a name). Multi-word names contribute both
 * the full name and each word token (>= 3 chars) so "Mira Valen" also bans "mira" and "valen".
 *
 * @param {Object<string, import('./database.js').DatabaseSchema>|null} [databases]
 * @returns {Set<string>}
 */
export function buildBannedNames(databases = null) {
    const banned = new Set();
    const add = (name) => {
        const s = String(name || '').trim().toLowerCase();
        if (!s) return;
        banned.add(s);
        for (const tok of s.split(/[^\p{L}\p{N}]+/u)) {
            if (tok.length >= 3) banned.add(tok);
        }
    };
    try { add(host.getCurrentCharacterName()); } catch { /* host not ready */ }
    try { add(host.getUserPersonaName()); } catch { /* host not ready */ }
    try { for (const c of (host.getCharacters() || [])) add(c?.name); } catch { /* host not ready */ }
    for (const db of Object.values(databases || {})) {
        for (const fact of (db?.facts || [])) {
            if (!fact) continue;
            if (Array.isArray(fact.knownBy)) for (const kb of fact.knownBy) add(kb);
            if (typeof fact.subject === 'string') add(fact.subject);
        }
    }
    return banned;
}

/**
 * Unconditional keyword sanitizer (the doctrine enforcer — applied to EVERY keyword list,
 * AI or deterministic, so a model that ignores the rules can't ship a name-firing lorebook):
 * lowercase+trim+dedupe, drop anything containing a banned name token, drop > 3-word compound
 * phrases, drop abstract themes, cap at KEYWORDS_MAX.
 *
 * @param {string[]} list
 * @param {Set<string>} banned
 * @returns {string[]}
 */
export function sanitizeKeywords(list, banned) {
    const out = [];
    const seen = new Set();
    for (const raw of (list || [])) {
        let kw = String(raw || '').trim().toLowerCase().replace(/^["'`]+|["'`]+$/g, '').trim();
        if (!kw) continue;
        const words = kw.split(/\s+/);
        if (words.length > 3) continue; // compound-key ban
        if (ABSTRACT_THEMES.has(kw)) continue;
        if (banned && (banned.has(kw) || words.some(w => banned.has(w)))) continue;
        if (seen.has(kw)) continue;
        seen.add(kw);
        out.push(kw);
        if (out.length >= KEYWORDS_MAX) break;
    }
    return out;
}

/**
 * Deterministic (no-LLM) keyword fallback: tokenize the unit's content + title on Unicode
 * word boundaries, keep words >= 4 chars that aren't stopwords, add a few adjacent-word
 * bigrams from the content, then run the SAME sanitizer. May return fewer than KEYWORDS_MIN —
 * an acceptable degraded lorebook beats a blocked export.
 *
 * @param {ExportUnit} unit
 * @param {Set<string>} banned
 * @returns {string[]}
 */
export function deterministicKeywords(unit, banned) {
    const text = [...(unit?.contentLines || []), unit?.title || ''].join(' ');
    const words = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const qualifies = (w) => w.length >= 4 && !FALLBACK_STOPWORDS.has(w) && !/^\d+$/.test(w);
    const singles = [];
    for (const w of words) {
        const lw = w.toLowerCase();
        if (qualifies(lw)) singles.push(lw);
    }
    // A few adjacent-word bigrams from the content (crude noun-phrase capture: both halves
    // must independently qualify, so stopword-glued pairs never form).
    const bigrams = [];
    for (let i = 0; i < words.length - 1 && bigrams.length < 8; i++) {
        const a = words[i].toLowerCase(), b = words[i + 1].toLowerCase();
        if (qualifies(a) && qualifies(b)) bigrams.push(`${a} ${b}`);
    }
    return sanitizeKeywords([...singles, ...bigrams], banned);
}

/**
 * Parse the keyword LLM output into a Map of unitId -> raw keyword strings. Tolerant
 * `#`-block grammar mirroring parseSuggestResult (taxonomy-suggest.js): strips code fences,
 * ignores junk/non-`+` lines, stops at the "." terminator naturally (a bare "." line is not
 * a `+` line). NEVER throws on garbage/empty input — missing units just fall back.
 *
 * @param {string} response
 * @returns {Map<string, string[]>}
 */
export function parseKeywordResult(response) {
    const out = new Map();
    if (!response || !String(response).trim()) return out;
    let text = String(response).replace(/```[\s\S]*?```/g, m => m.replace(/```\w*/g, '').trim()).replace(/```/g, '');
    const blockMatch = text.match(/#KEYWORDS\s*([\s\S]*?)$/i);
    const block = (blockMatch ? blockMatch[1] : text).trim();
    if (!block || block === '.' || /^\(none\)$/i.test(block)) return out;
    for (const rawLine of block.split('\n')) {
        let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
        if (!line || line === '.' || !line.startsWith('+')) continue;
        line = line.slice(1).trim();
        const pipeIdx = line.indexOf('|');
        if (pipeIdx < 0) continue;
        const id = line.slice(0, pipeIdx).trim().replace(/^\[|\]$/g, '').trim();
        if (!id) continue;
        const kws = line.slice(pipeIdx + 1).split(',').map(s => s.trim()).filter(Boolean);
        if (kws.length) out.set(id, kws);
    }
    return out;
}

/**
 * KEYWORD STEP — attach a `keywords` array to every unit. When useAI, units are chunked into
 * UNITS_PER_KEYWORD_CALL batches (at most MAX_KEYWORD_CALLS LLM calls, semaphore 2, overflow
 * batches deterministic); each call reuses callAgentLLM on the Scribe/Agent-3 profile with
 * the (customizable) doctrine prompt, tokens are folded into the Agent-3 totals, and every
 * parsed list runs through sanitizeKeywords. ANY per-batch failure — profile missing, call
 * throws, empty/garbled response — silently degrades that batch to deterministicKeywords, so
 * the export can never be blocked by the model. Mutates the passed units (sets .keywords).
 *
 * @param {object} args
 * @param {ExportUnit[]} args.units
 * @param {string|null} [args.profileId] - Scribe/Agent-3 connection profile
 * @param {boolean} [args.useAI]
 * @param {?function({done: number, total: number}): void} [args.onProgress]
 * @param {?Set<string>} [args.banned] - precomputed banned-name set (built from host only when omitted)
 * @returns {Promise<{units: ExportUnit[], llmCalls: number, aiUnits: number, fallbackUnits: number}>}
 */
export async function generateKeywords({ units, profileId = null, useAI = true, onProgress = null, banned = null } = {}) {
    const list = units || [];
    const bannedSet = banned || buildBannedNames(null);
    const runId = `wi_${Date.now().toString(36)}`;

    if (!useAI || list.length === 0) {
        for (const u of list) u.keywords = deterministicKeywords(u, bannedSet);
        addDebugLog('info', `[${runId}] WI keywords: deterministic only (${list.length} unit(s), AI ${useAI ? 'unavailable' : 'off'})`, {
            subsystem: 'import', event: 'wi.keywords', reason: 'NO_AI', data: { totalUnits: list.length },
        });
        return { units: list, llmCalls: 0, aiUnits: 0, fallbackUnits: list.length };
    }

    const batches = [];
    for (let i = 0; i < list.length; i += UNITS_PER_KEYWORD_CALL) batches.push(list.slice(i, i + UNITS_PER_KEYWORD_CALL));
    const aiBatches = batches.slice(0, MAX_KEYWORD_CALLS);
    const overflow = batches.slice(MAX_KEYWORD_CALLS).flat();

    const settings = host.getExtensionSettings();
    const substitute = host.getSubstituteParams();
    const systemPrompt = substitute(settings?.wiKeywordPrompt || DEFAULT_WI_KEYWORD_PROMPT);
    const bannedLine = [...bannedSet].slice(0, MAX_BANNED_IN_PROMPT).join(', ');

    const sem = createSemaphore(2);
    let done = 0, llmCalls = 0, aiUnits = 0, fallbackUnits = 0;

    await Promise.all(aiBatches.map(async (batch) => {
        const release = await sem.acquire();
        try {
            const lines = batch.map(u => `[${u.id}] ${u.title} = ${u.contentLines.join(' / ').slice(0, MAX_UNIT_PROMPT_CHARS)}`);
            const userPrompt = substitute([
                bannedLine ? `## Banned names (NEVER emit these, alone or inside a phrase)\n${bannedLine}` : '',
                `## Entries (${batch.length})\n${lines.join('\n')}`,
                'Now output ONLY the #KEYWORDS block with one "+" line per entry above.',
            ].filter(Boolean).join('\n\n'));

            const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId, 'wi-export');
            llmCalls++;

            // Token accounting (mirror taxonomy-suggest: count in/out, fold into Agent-3 totals).
            try {
                const tokensIn = await host.getTokenCount(systemPrompt + '\n' + userPrompt);
                const tokensOut = await host.getTokenCount(resultStr || '');
                addAgent3Tokens({ agent3Input: tokensIn, agent3Output: tokensOut });
            } catch { /* token accounting is best-effort */ }

            const parsedMap = parseKeywordResult(resultStr);
            for (const u of batch) {
                const kws = sanitizeKeywords(parsedMap.get(u.id) || [], bannedSet);
                if (kws.length >= MIN_PARSED_KEYWORDS) { u.keywords = kws; aiUnits++; }
                else { u.keywords = deterministicKeywords(u, bannedSet); fallbackUnits++; }
            }
        } catch (error) {
            // Whole-batch failure (profile/transport/model) — deterministic fallback, never block.
            for (const u of batch) { u.keywords = deterministicKeywords(u, bannedSet); fallbackUnits++; }
            addDebugLog('fail', `[${runId}] WI keyword batch failed (deterministic fallback): ${error.message || error}`, {
                subsystem: 'import', event: 'wi.keywords', reason: 'BATCH_ERROR', data: { batchSize: batch.length },
            });
        } finally {
            release();
            done++;
            if (typeof onProgress === 'function') {
                try { onProgress({ done, total: aiBatches.length }); } catch { /* UI only */ }
            }
        }
    }));

    for (const u of overflow) { u.keywords = deterministicKeywords(u, bannedSet); fallbackUnits++; }

    addDebugLog('info', `[${runId}] WI keywords: ${llmCalls} LLM call(s), ${aiUnits} AI unit(s), ${fallbackUnits} deterministic`, {
        subsystem: 'import', event: 'wi.keywords', reason: 'DONE',
        data: { llmCalls, aiUnits, fallbackUnits, totalUnits: list.length, overflowUnits: overflow.length },
    });
    return { units: list, llmCalls, aiUnits, fallbackUnits };
}

/**
 * Assemble the standard ST World Info book file shape ({ entries: { '0': {...}, ... } })
 * from keyword-annotated units. Field set matches what ST's own lorebook export writes so
 * the file imports cleanly via ST's World Info panel.
 *
 * @param {ExportUnit[]} units
 * @returns {{entries: Object<string, object>}}
 */
export function buildWorldInfoBook(units) {
    const entries = {};
    (units || []).forEach((unit, i) => {
        entries[String(i)] = {
            uid: i,
            key: [...(unit.keywords || [])],
            keysecondary: [],
            comment: unit.title || '',
            content: (unit.contentLines || []).join('\n'),
            constant: false,
            vectorized: false,
            selective: true,
            selectiveLogic: 0,
            addMemo: true,
            order: 100,
            position: 0,
            disable: false,
            excludeRecursion: false,
            preventRecursion: false,
            delayUntilRecursion: false,
            probability: 100,
            useProbability: true,
            depth: 4,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            scanDepth: null,
            caseSensitive: null,
            matchWholeWords: null,
            useGroupScoring: null,
            automationId: '',
            role: null,
            sticky: 0,
            cooldown: 0,
            delay: 0,
            displayIndex: i,
        };
    });
    return { entries };
}

/**
 * A World Info entry normalized out of any of the known lorebook dialects.
 * @typedef {Object} NormalizedWiEntry
 * @property {string|number} uid
 * @property {string} title
 * @property {string[]} keys
 * @property {string[]} secondary
 * @property {string} content
 * @property {boolean} disabled
 */

/**
 * Tolerant World Info book parser. Accepts the three known dialects: a book file with an
 * `entries` object-map, a character-book v2 with an `entries` array (`keys`/`secondary_keys`
 * field names, possibly nested under `character_book` / `data.character_book`), and a plain
 * array export. Keys accept arrays OR comma-split strings; title comes from `comment`||`title`.
 * THROWS a clear Error on anything else — including a bf-memory DB export picked by mistake
 * (it has no `entries`, so the error points the user at the plain Import button). Capped at
 * MAX_IMPORT_ENTRIES.
 *
 * @param {string} text - raw JSON file contents
 * @returns {NormalizedWiEntry[]}
 */
export function parseWorldInfoBook(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('not valid JSON'); }

    let raw = null;
    if (Array.isArray(parsed)) {
        raw = parsed;
    } else if (parsed && typeof parsed === 'object') {
        const entries = parsed.entries ?? parsed.character_book?.entries ?? parsed.data?.character_book?.entries;
        if (Array.isArray(entries)) raw = entries;
        else if (entries && typeof entries === 'object') raw = Object.values(entries);
    }
    if (!raw || raw.length === 0) {
        throw new Error('not a World Info book (no entries found) — for a BF Memory database export, use the plain "Import" button instead');
    }

    const normalizeKeys = (v) => Array.isArray(v)
        ? v.map(k => String(k ?? '').trim()).filter(Boolean)
        : (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : []);

    const out = [];
    for (let i = 0; i < raw.length && out.length < MAX_IMPORT_ENTRIES; i++) {
        const e = raw[i];
        if (!e || typeof e !== 'object') continue;
        const keys = normalizeKeys(e.key ?? e.keys);
        const content = String(e.content ?? '').trim();
        const title = String(e.comment ?? e.title ?? '').trim();
        if (!keys.length && !content && !title) continue; // structureless junk row
        out.push({
            uid: e.uid ?? e.id ?? i,
            title,
            keys,
            secondary: normalizeKeys(e.keysecondary ?? e.secondary_keys),
            content,
            disabled: e.disable === true || e.disabled === true || e.enabled === false,
        });
    }
    if (out.length === 0) {
        throw new Error('not a World Info book (entries present but none were usable — unrecognized lorebook dialect?)');
    }
    return out;
}

// Heuristic title/keys -> category rules (opt-in). Deliberately NEVER maps to People: a WI
// entry about a character still lands in Unsorted so a prose blob can't corrupt the People
// retrieval index — users can refile from the Database tab.
const HEURISTIC_RULES = [
    [/\b(city|town|village|castle|tavern|forest|room|house|inn|shop|region|kingdom)\b/i, 'Places'],
    [/\b(sword|ring|amulet|potion|artifact|weapon|item)\b/i, 'Things'],
    [/\b(war|battle|festival|ceremony|incident)\b/i, 'Events'],
    [/\b(guild|faction|clan|house of|order of)\b/i, 'World'],
];

/** Slug a title into a stable fact-key token (lowercase, underscores, bounded). */
function slugify(s) {
    return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
}

/**
 * CONVERSION STEP — turn normalized WI entries into FactSchema facts grouped by category.
 * Disabled entries are skipped (counted). Fact keys are stable slugs of the entry title
 * ('wi_<slug>', deterministic _2/_3 suffixes for duplicate titles in encounter order), so
 * RE-importing the same book upserts idempotently instead of duplicating. Content is capped
 * at MAX_WI_CONTENT_CHARS (truncations counted) and imported at importance 2 so long lore
 * prose can't dominate every-turn retrieval. Pure conversion — never persists.
 *
 * @param {NormalizedWiEntry[]} entries
 * @param {{target?: ('Unsorted'|'heuristic'), bookName?: string}} [opts]
 * @returns {{factsByCategory: Object<string, object[]>, factCount: number, skippedDisabled: number, truncated: number}}
 */
export function worldInfoEntriesToFacts(entries, { target = 'Unsorted', bookName = 'import' } = {}) {
    const factsByCategory = {};
    const seenKeys = new Set();
    let skippedDisabled = 0, truncated = 0, factCount = 0;
    const now = Date.now();

    for (const entry of (entries || [])) {
        if (!entry) continue;
        if (entry.disabled) { skippedDisabled++; continue; }

        let value = String(entry.content || '').trim();
        if (!value) value = entry.keys.join(', '); // content-less entry: keys are all we have
        if (!value) continue;
        if (value.length > MAX_WI_CONTENT_CHARS) { value = value.slice(0, MAX_WI_CONTENT_CHARS); truncated++; }

        const base = slugify(entry.title || `entry_${entry.uid}`) || `entry_${slugify(String(entry.uid)) || '0'}`;
        let key = `wi_${base}`;
        for (let n = 2; seenKeys.has(key); n++) key = `wi_${base}_${n}`;
        seenKeys.add(key);

        let category = 'Unsorted';
        if (target === 'heuristic') {
            const probe = `${entry.title} ${entry.keys.join(' ')}`;
            for (const [rx, cat] of HEURISTIC_RULES) {
                if (rx.test(probe)) { category = cat; break; }
            }
        }

        if (!factsByCategory[category]) factsByCategory[category] = [];
        factsByCategory[category].push({
            key,
            value,
            tags: entry.keys.slice(0, MAX_TAGS_FROM_KEYS),
            knownBy: [],
            relationships: { primary: [], secondary: [], tertiary: [] },
            source: `worldinfo:${bookName}`,
            context: `Imported from World Info "${bookName}" (${entry.title || `entry ${entry.uid}`})`,
            importance: 2,
            kind: 'trait',
            lastUpdated: now,
        });
        factCount++;
    }
    return { factsByCategory, factCount, skippedDisabled, truncated };
}
