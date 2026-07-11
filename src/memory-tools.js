// BF Memory Pipeline - Memory Agent tool transport (redesign-v2, S2)
// TEXT-PROTOCOL tool layer for the background Memory Agent. The agent replies with plain
// text lines of strict JSON (one call per line) instead of a provider function-call API,
// so the layered navigation (list_categories -> list_keys -> read_facts -> write_fact /
// search) works on ANY backend. This module owns BOTH halves of the protocol:
//   - parseAgentReply(text): split an agent reply into tool calls / final block / malformed
//   - executeMemoryTool(call, ctx): run ONE parsed call against database.js + fact-retrieval.js
//
// IMPORT DIRECTION (cycle guard): llm-call.js imports parseAgentReply from HERE; this module
// must therefore NEVER import llm-call.js. It talks only to database/fact-retrieval/recency/
// review-popup/settings/tokenize/host.
//
// PERSISTENCE CONTRACT: write_fact mutates the LIVE in-memory database map (ctx.databases)
// and records what changed on ctx.applied / ctx.touchedCategories — it deliberately does NOT
// call saveDatabase. The caller (agent-memory.js runMemoryAgent, S3) saves each touched
// category ONCE after the whole tool loop, so a 10-write session costs one save per category
// instead of ten attachment uploads.

import {
    effectiveCategories,
    mapLegacyCategory,
    isActiveFact,
    findFactMatch,
    upsertFact,
    createEmptyDatabase,
    applyCrossKeySupersedeRules,
    autoLinkFact,
    isMaterialFactWrite,
    normalizeKind,
    clampImportance,
    normalizeAspect,
    canonicalizeLeafSurface,
    deriveAspect,
} from './database.js';
import { isFactVisible, buildFactLine, retrieveFacts, formatFactsForWriter, extractContextKeywords } from './fact-retrieval.js';
import { getTurnNowContext } from './recency.js';
import { addDebugLog } from './settings.js';
import { wordTokens, keyToken } from './tokenize.js';
import * as host from './host.js';

// ── Protocol constants (G1 grammar) ──────────────────────────────────────────

/** The tools the Memory Agent may call. Anything else on a JSON line is a protocol error. */
export const KNOWN_TOOLS = ['list_categories', 'list_keys', 'read_facts', 'write_fact', 'search'];

/** Max `key | aspect | value` rows one list_keys result may return (prompt-size guard). */
const LIST_KEYS_CAP = 80;

/** Max facts one search result may return (prompt-size guard). */
const SEARCH_RESULT_CAP = 15;

// ── parseAgentReply ───────────────────────────────────────────────────────────

/**
 * Parse ONE Memory Agent reply into protocol parts (G1 grammar).
 *
 * A reply contains, in order: zero or more tool-call lines (each ONE line of strict JSON,
 * e.g. `{"tool":"list_keys","args":{"category":"People"}}`), then optionally a final block
 * starting with a line that is exactly `#SHEET` (or `#DONE` in extractOnly mode) and running
 * to the end of the reply.
 *
 * Classification rules:
 *   - A trimmed line starting with `{` is a tool-call ATTEMPT: it must be strict one-line
 *     JSON with a known `tool` name (and `args` an object when present) or it lands in
 *     `malformed` (the loop's one-grace ERROR path).
 *   - The FIRST line matching `#SHEET` / `#DONE` starts the final block; `sheet` is the raw
 *     text AFTER the `#SHEET` line; `done` is true whenever a final block was found.
 *   - Markdown code-fence lines (```/```json) are stripped; other prose lines are tolerated
 *     as chatter and ignored (a reply that is ONLY chatter yields calls:[], done:false,
 *     malformed:[] — the loop treats that as a protocol violation).
 *
 * @param {string} text - the raw agent reply
 * @returns {{ calls: Array<{tool:string, args:Object, line:string}>, sheet: string|null,
 *             done: boolean, malformed: Array<{line:string, error:string}> }}
 */
export function parseAgentReply(text) {
    const out = { calls: [], sheet: null, done: false, malformed: [] };
    const raw = String(text ?? '');
    if (!raw.trim()) return out;

    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (/^```/.test(line)) continue; // markdown fence wrapper — tolerate and skip

        // Final block start: exactly #SHEET or #DONE (trimmed; case-insensitive tolerated).
        const finalMatch = /^#(SHEET|DONE)\s*$/i.exec(line);
        if (finalMatch) {
            out.done = true;
            if (finalMatch[1].toUpperCase() === 'SHEET') {
                // Raw text after the #SHEET line to end of reply (fences stripped, per-line).
                out.sheet = lines.slice(i + 1)
                    .filter(l => !/^\s*```/.test(l))
                    .join('\n')
                    .trim();
            }
            break; // the final block consumes the rest of the reply by contract
        }

        // Tool-call attempt: strict ONE-LINE JSON.
        if (line.startsWith('{')) {
            let obj;
            try {
                obj = JSON.parse(line);
            } catch (e) {
                out.malformed.push({ line, error: `invalid JSON (${e.message || e}) — a tool call must be ONE line of strict JSON` });
                continue;
            }
            const tool = String(obj?.tool || '').trim();
            if (!KNOWN_TOOLS.includes(tool)) {
                out.malformed.push({ line, error: `unknown tool "${tool || '(missing)'}" — valid tools: ${KNOWN_TOOLS.join(', ')}` });
                continue;
            }
            if (obj.args !== undefined && (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args))) {
                out.malformed.push({ line, error: `"args" must be a JSON object` });
                continue;
            }
            out.calls.push({ tool, args: obj.args || {}, line });
            continue;
        }

        // Anything else is prose chatter — tolerated, ignored.
    }
    return out;
}

// ── executeMemoryTool ─────────────────────────────────────────────────────────

/**
 * Execute ONE parsed tool call against the live memory store and return the result as a
 * plain string (the loop packs results into the next `TOOL RESULTS:` user message). NEVER
 * throws — every failure comes back as an `ERROR: ...` string the agent can react to.
 *
 * @param {{tool:string, args:Object, line:string}} call - one parsed call from parseAgentReply
 * @param {Object} ctx - shared per-run tool context, built ONCE by the caller:
 *   @param {string}  ctx.runId      - correlation id for debug logs / autolink stamps
 *   @param {Object}  ctx.databases  - LIVE category -> DatabaseSchema map (getAllDatabases());
 *                                     mutated in place by write_fact
 *   @param {Object}  ctx.index      - per-turn in-memory fact index (getMemoryIndex())
 *   @param {Object}  ctx.settings   - resolved extension settings
 *   @param {Array}   ctx.applied    - MUTATED: write_fact pushes {category, key, fact, status}
 *                                     for every write that changed stored state
 *   @param {Set<string>} [ctx.touchedCategories] - MUTATED (lazily created): every category
 *                                     whose stored state changed (incl. cross-key supersede
 *                                     side effects) — the caller saves each of these ONCE
 *   @param {number}  [ctx.sourceIndex] - message index writes are attributed to (source/validAt)
 * @returns {Promise<string>}
 */
export async function executeMemoryTool(call, ctx) {
    const tool = call?.tool;
    const args = call?.args || {};
    try {
        switch (tool) {
            case 'list_categories': return execListCategories(ctx);
            case 'list_keys': return execListKeys(args, ctx);
            case 'read_facts': return execReadFacts(args, ctx);
            case 'search': return await execSearch(args, ctx);
            case 'write_fact': return execWriteFact(args, ctx);
            default: return `ERROR: unknown tool "${tool}"`;
        }
    } catch (e) {
        addDebugLog('fail', `Memory tool "${tool}" threw: ${e?.message || e}`, {
            subsystem: 'agent3', event: 'memtool.error', reason: 'TOOL_THREW',
            data: { tool, error: String(e?.message || e), runId: ctx?.runId || '' },
        });
        return `ERROR: ${tool} failed internally (${e?.message || e})`;
    }
}

/** Resolve the current character + user-persona names once per call (best-effort). */
function currentNames() {
    let charName = '';
    let userName = '';
    try { charName = String(host.getCurrentCharacterName() || '').trim(); } catch { /* best-effort */ }
    try { userName = String(host.getUserPersonaName() || '').trim(); } catch { /* best-effort */ }
    return { charName, userName };
}

/** Best-effort per-turn now-context for recency tails on read_facts lines. */
function safeNowContext() {
    try { return getTurnNowContext(); } catch { return null; }
}

// list_categories → every effective Layer-1 category with its ACTIVE fact count.
function execListCategories(ctx) {
    const databases = ctx?.databases || {};
    const cats = effectiveCategories();
    const lines = [];
    const countActive = (db) => (db?.facts || []).reduce((n, f) => n + (isActiveFact(f) ? 1 : 0), 0);
    for (const cat of cats) {
        lines.push(`${cat} — ${countActive(databases[cat])} active fact(s)`);
    }
    // Any stored category outside the effective set (legacy/custom leftovers) is still listed
    // so the agent can navigate into it rather than it being invisible.
    for (const [cat, db] of Object.entries(databases)) {
        if (!cats.includes(cat)) lines.push(`${cat} — ${countActive(db)} active fact(s) (legacy)`);
    }
    return lines.join('\n');
}

// list_keys → `key | aspect | first 60 chars of value` per ACTIVE, VISIBLE fact, capped.
function execListKeys(args, ctx) {
    const rawCategory = String(args?.category || '').trim();
    if (!rawCategory) return 'ERROR: list_keys requires args.category';
    const category = mapLegacyCategory(rawCategory);
    const db = (ctx?.databases || {})[category];
    if (!db || !Array.isArray(db.facts) || db.facts.length === 0) {
        return `(no facts stored in "${category}")`;
    }
    const names = currentNames();
    const lines = [];
    let total = 0;
    for (const fact of db.facts) {
        if (!isActiveFact(fact)) continue;
        if (!isFactVisible(fact, names)) continue; // knownBy/POV enforcement on ALL read tools
        total++;
        if (lines.length >= LIST_KEYS_CAP) continue; // keep counting for the footer
        const aspect = deriveAspect(fact);
        const val = String(fact.value ?? '').replace(/\s+/g, ' ').trim();
        const note = String(fact.context ?? '').replace(/\s+/g, ' ').trim();
        const shown = (val || note).slice(0, 60);
        lines.push(`${fact.key} | ${aspect} | ${shown}`);
    }
    if (lines.length === 0) return `(no visible active facts in "${category}")`;
    if (total > lines.length) lines.push(`... (+${total - lines.length} more — narrow with read_facts or search)`);
    return `${category} keys (${total} visible active fact(s)):\n${lines.join('\n')}`;
}

// read_facts → one full injected-format line per requested key; missing keys reported.
function execReadFacts(args, ctx) {
    const rawCategory = String(args?.category || '').trim();
    if (!rawCategory) return 'ERROR: read_facts requires args.category';
    const keys = Array.isArray(args?.keys) ? args.keys.map(k => String(k ?? '').trim()).filter(Boolean) : [];
    if (keys.length === 0) return 'ERROR: read_facts requires args.keys (a non-empty array of key names)';
    const category = mapLegacyCategory(rawCategory);
    const db = (ctx?.databases || {})[category];
    const names = currentNames();
    const nowCtx = safeNowContext();
    const lines = [];
    for (const rawKey of keys) {
        // Tolerate `Category/key` refs — take the part after the last slash.
        const key = rawKey.includes('/') ? rawKey.slice(rawKey.lastIndexOf('/') + 1).trim() : rawKey;
        const fact = db ? findFactMatch(db, key) : null;
        if (!fact || !isActiveFact(fact) || !isFactVisible(fact, names)) {
            lines.push(`${category}/${key}: (not found)`);
            continue;
        }
        lines.push(buildFactLine(fact, category, nowCtx));
    }
    return lines.join('\n');
}

// search → deterministic retrieval over the whole store, writer-formatted, capped.
async function execSearch(args, ctx) {
    const query = String(args?.query || '').trim();
    if (!query) return 'ERROR: search requires args.query';
    // Feed the same keyword machinery the deterministic retrieval path uses: the query's
    // word tokens as the needed-info list plus proper-noun context keywords extracted the
    // way recent-message keywords are (extractContextKeywords takes {mes} message shapes).
    const needed = wordTokens(query, { min: 3 });
    if (needed.length === 0) needed.push(query.toLowerCase());
    let contextKeywords = [];
    try { contextKeywords = extractContextKeywords([{ mes: query }]); } catch { /* best-effort */ }
    const result = await retrieveFacts(needed, contextKeywords);
    const names = currentNames();
    const visible = (result?.facts || [])
        .filter(r => r && r.fact && isActiveFact(r.fact) && isFactVisible(r.fact, names))
        .slice(0, SEARCH_RESULT_CAP);
    if (visible.length === 0) return `(no stored facts matched "${query.slice(0, 80)}")`;
    return formatFactsForWriter(visible);
}

// ── write_fact ────────────────────────────────────────────────────────────────

// Reserved generic prefix tokens meaning "the character" / "the user" (mirrors the Scribe's
// HUB FIX in agent-memory.js so tool writes get the same per-character key namespacing).
const GENERIC_CHAR_TOKENS = new Set(['char', 'character']);
const GENERIC_USER_TOKENS = new Set(['user', 'persona']);

/**
 * Rewrite a generic `char_*` / `user_*` key prefix to the real character / persona name so
 * tool-written facts land in the same per-character namespace as Scribe-written ones. A key
 * with no generic prefix (or when no real name resolves) is returned untouched.
 * @param {string} key - already keyToken()-cleaned
 * @param {{charName:string, userName:string}} names
 * @returns {string}
 */
function resolveGenericKeyPrefix(key, names) {
    const us = key.indexOf('_');
    const first = us > 0 ? key.slice(0, us) : key;
    let realName = '';
    if (GENERIC_CHAR_TOKENS.has(first)) realName = names.charName;
    else if (GENERIC_USER_TOKENS.has(first)) realName = names.userName;
    if (!realName) return key;
    const realToken = keyToken(realName);
    if (!realToken) return key;
    const tail = us > 0 ? key.slice(us + 1) : '';
    return tail ? `${realToken}_${tail}` : realToken;
}

/** Deterministic subject from the key prefix (token before the first underscore). */
function subjectFromKey(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return '';
    const us = k.indexOf('_');
    return us > 0 ? k.slice(0, us) : k;
}

/** Deterministic scope from category (mirrors agent-memory's inferScopeFromCategory). */
function scopeFromCategory(category) {
    switch (String(category || '').toLowerCase()) {
        case 'events': return 'event';
        case 'places':
        case 'world': return 'place';
        default: return 'character';
    }
}

/**
 * write_fact — validate + normalize the agent's arguments, then route the write through the
 * SAME upsert path the Scribe used: upsertFact (reconcile-on-write, salience merge, per-key
 * supersession) + applyCrossKeySupersedeRules + autoLinkFact.
 * Mutates ctx.databases in place and records the change on ctx.applied /
 * ctx.touchedCategories — the CALLER persists (one saveDatabase per touched category).
 *
 * Args (G1): { category, key, value, note, known_by:[], aspect, importance } with optional
 * extras tolerated: kind, tags, with (participants), conf/confidence.
 * @returns {string} 'OK stored Category/key ...' or 'ERROR: <why>'
 */
function execWriteFact(args, ctx) {
    if (!ctx || typeof ctx !== 'object' || !ctx.databases) return 'ERROR: write_fact has no database context';
    if (!Array.isArray(ctx.applied)) ctx.applied = [];
    if (!(ctx.touchedCategories instanceof Set)) ctx.touchedCategories = new Set();

    // 1) Category: legacy-map, then validate against the effective taxonomy — an unknown
    //    category files to the Unsorted catch-all (never silently mis-filed, never rejected).
    const rawCategory = String(args?.category || '').trim();
    let category = mapLegacyCategory(rawCategory || 'Unsorted');
    let categoryNote = '';
    if (!effectiveCategories().includes(category)) {
        categoryNote = ` (unknown category "${rawCategory}" — filed to Unsorted)`;
        category = 'Unsorted';
    }

    // 2) Key: snake_case-clean; empty after cleaning is a hard error.
    let key = keyToken(args?.key);
    if (!key) return 'ERROR: write_fact requires a usable snake_case "key"';

    // 3) Value / note: at least one must carry content (the value/note contract from the
    //    Scribe grammar — a note-only fact is legal, an empty write is not).
    const value = String(args?.value ?? '').trim();
    const note = String(args?.note ?? args?.context ?? '').trim();
    if (!value && !note) return 'ERROR: write_fact requires a non-empty "value" (or "note")';

    // 4) Per-character namespacing (HUB FIX parity): resolve a generic char_/user_ prefix.
    const names = currentNames();
    key = resolveGenericKeyPrefix(key, names);

    // 5) knownBy defaulting: `@`-stripped + deduped; when omitted/empty, default to the
    //    PRESENT PAIR (character + persona) exactly like the Scribe parser does, so "both
    //    present parties know it" is the baseline and secrets need an explicit list.
    let knownBy = (Array.isArray(args?.known_by) ? args.known_by : [])
        .map(n => String(n ?? '').trim().replace(/^@/, '').trim())
        .filter(Boolean);
    if (knownBy.length === 0) {
        knownBy = [...new Set([names.charName, names.userName].filter(Boolean))];
    } else {
        knownBy = [...new Set(knownBy)];
    }

    // 6) Vocab normalization: kind / importance / aspect (aspect canonicalized to the
    //    snake_case leaf convention first, then snapped to the category's fixed vocab).
    const kind = normalizeKind(args?.kind);
    const importance = clampImportance(args?.importance);
    const rawAspect = String(args?.aspect || '').trim();
    const aspect = normalizeAspect(canonicalizeLeafSurface(rawAspect) || rawAspect, category);

    // 7) Optional extras (tolerated, same shapes the Scribe path stores).
    const tags = (Array.isArray(args?.tags) ? args.tags : [])
        .map(t => String(t ?? '').trim()).filter(Boolean);
    const involved = (Array.isArray(args?.with) ? args.with : Array.isArray(args?.involved) ? args.involved : [])
        .map(n => String(n ?? '').trim().replace(/^@/, '').trim())
        .filter(Boolean);
    let confidence = args?.conf ?? args?.confidence ?? null;
    if (confidence !== null && confidence !== undefined && confidence !== '') {
        if (typeof confidence === 'number') confidence = Math.min(1, Math.max(0, confidence));
        else {
            const c = String(confidence).trim().toLowerCase();
            confidence = (c === 'medium') ? 'med' : (['high', 'med', 'low'].includes(c) ? c : null);
        }
    } else {
        confidence = null;
    }

    // 8) Build the fact in the SAME shape agent-memory's applyUpdates writes, then upsert.
    const sourceIndex = Number.isInteger(ctx.sourceIndex) ? ctx.sourceIndex : null;
    const fact = {
        key,
        value,
        tags,
        knownBy,
        relationships: { primary: [], secondary: [], tertiary: [] },
        source: sourceIndex !== null ? `msg_${sourceIndex}` : `agent_${ctx.runId || 'run'}`,
        importance,
        kind,
        aspect,
        subject: subjectFromKey(key),
        scope: scopeFromCategory(category),
    };
    if (note) fact.context = note;
    if (involved.length) fact.involved = involved;
    if (confidence !== null) fact.confidence = confidence;
    if (sourceIndex !== null) fact.validAt = sourceIndex;
    if (fact.source) fact.sourceMsg = fact.source;

    if (!ctx.databases[category]) {
        ctx.databases[category] = createEmptyDatabase(category);
        addDebugLog('info', `Created new database: "${category}"`, {
            subsystem: 'agent3', event: 'memtool.db_created', data: { category, runId: ctx.runId || '' },
        });
    }
    const db = ctx.databases[category];

    // Classify BEFORE writing with the same rules the Scribe commit used (NEW / UPDATED /
    // SKIPPED), so no-op re-writes never re-fire supersede rules or autolink.
    const matched = findFactMatch(db, key);
    const changed = isMaterialFactWrite(db, fact);
    const status = !matched ? 'NEW' : (changed ? 'UPDATED' : 'SKIPPED');

    upsertFact(db, fact);

    if (changed) {
        // AUTO-LINK against the per-run index snapshot (deterministic, anti-hub capped inside).
        const stored = findFactMatch(db, fact.key);
        if (stored && ctx.index) autoLinkFact(ctx.index, stored, category, ctx.runId);

        // CROSS-KEY SUPERSEDE: a genuinely-new death/departure/loss write retires stale
        // same-subject state facts across categories — those categories must be saved too.
        for (const cat of applyCrossKeySupersedeRules(ctx.databases, fact, category)) {
            ctx.touchedCategories.add(cat);
        }
        ctx.touchedCategories.add(category);

        ctx.applied.push({ category, key: fact.key, fact: stored || fact, status });
    }

    addDebugLog('info', `Memory Agent write_fact ${status}: [${category}] ${fact.key} = "${(value || note).slice(0, 80)}"`, {
        subsystem: 'agent3', event: 'memtool.write', reason: status,
        data: { category, key: fact.key, status, runId: ctx.runId || '' },
    });

    if (status === 'SKIPPED') {
        return `OK ${category}/${fact.key} already stored with an identical value (no change)${categoryNote}`;
    }
    return `OK stored ${category}/${fact.key} (${status})${categoryNote}`;
}
