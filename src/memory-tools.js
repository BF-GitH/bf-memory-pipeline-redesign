import {
    effectiveCategories,
    mapLegacyCategory,
    isActiveFact,
    isColdFact,
    isSequenceFact,
    markFactCold,
    findFactMatch,
    upsertFact,
    createEmptyDatabase,
    applyCrossKeySupersedeRules,
    autoLinkFact,
    linkFactsExplicit,
    AGENT_LINK_MAX,
    isMaterialFactWrite,
    normalizeKind,
    clampImportance,
    normalizeAspect,
    canonicalizeLeafSurface,
    deriveAspect,
    lookupCharacterAlias,
    registerCharacterAlias,
} from './database.js';
import { isFactVisible, buildFactLine, retrieveFacts, formatFactsForWriter, extractContextKeywords } from './fact-retrieval.js';
import { getScenePresent } from './turn-state.js';
import { getTurnNowContext, recencyTail } from './recency.js';
import { addDebugLog } from './settings.js';
import { wordTokens, keyToken } from './tokenize.js';
import * as host from './host.js';

// Exported so the Health tab can list the memory agent's tool roster without
// hardcoding it — this constant is the single source of truth for valid tools.
export const KNOWN_TOOLS = ['list_categories', 'list_keys', 'read_facts', 'write_fact', 'search', 'add_alias', 'link_facts'];

// Read subset of the reflection roster. Kept as its own export only because
// REFLECTION_TOOLS is composed from it below; the read-key bookkeeping does NOT
// consult it (recordReadKey is called directly from execReadFacts/execSearch,
// because "unlocks a repair" is a property of what a tool RENDERS, not of it
// being read-only — list_keys is read-only and deliberately does not unlock).
export const REFLECTION_READ_TOOLS = ['list_categories', 'list_keys', 'read_facts', 'search'];

// Reflection's REPAIR tools. They exist only to fix records that are already
// stored — creation stays with the extractor (and, for patterns, with the
// declarative #OBS channel), so there is deliberately no create tool here.
// Every one of them refuses unless ctx.mode === 'reflect', so adding them to
// the dispatch switch leaves the extraction agent's behavior unchanged.
export const REFLECTION_WRITE_TOOLS = ['write_fact', 'merge_facts', 'mark_cold'];

// Full roster the reflection executor accepts.
export const REFLECTION_TOOLS = [...REFLECTION_READ_TOOLS, ...REFLECTION_WRITE_TOOLS];

// Union of every tool name any agent may legally emit. The PARSER validates
// against this, not against KNOWN_TOOLS: a name missing here is reported as
// MALFORMED (which burns the grace round and aborts the loop on the second
// offense) instead of coming back as an ordinary refusal the model can read
// and correct.
const ALL_TOOLS = [...new Set([...KNOWN_TOOLS, ...REFLECTION_TOOLS])];

const LIST_KEYS_CAP = 80;

const SEARCH_RESULT_CAP = 15;

// Pull every balanced {...} object out of a line, honoring quoted strings/escapes.
function extractJsonObjects(line) {
    const found = [];
    for (let i = 0; i < line.length; i++) {
        if (line[i] !== '{') continue;
        let depth = 0, inStr = false, esc = false;
        for (let j = i; j < line.length; j++) {
            const ch = line[j];
            if (esc) { esc = false; continue; }
            if (ch === '\\') { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { found.push(line.slice(i, j + 1)); i = j; break; } }
        }
    }
    return found;
}

// Best-effort repair for the most common model JSON mistake: unescaped double
// quotes INSIDE a string value, e.g. {"tool":"write_fact","args":{"value":"she said "back" firmly"}}.
// Walks the line tracking string state; a '"' inside a string only counts as the
// closing quote when the next non-space char is a JSON delimiter (, } ] :) or the
// end of the line — any other '"' is content and gets escaped. Heuristic by
// design: the caller re-parses the result and discards it if still invalid, so a
// wrong guess can never produce a worse outcome than the original parse failure.
function repairJsonLine(line) {
    let out = '';
    let inStr = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (!inStr) {
            if (ch === '"') inStr = true;
            out += ch;
            continue;
        }
        if (ch === '\\') { out += ch + (line[i + 1] ?? ''); i++; continue; }
        if (ch === '"') {
            let j = i + 1;
            while (j < line.length && /\s/.test(line[j])) j++;
            const next = line[j];
            if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') {
                inStr = false;
                out += ch;
            } else {
                out += '\\"';
            }
            continue;
        }
        out += ch;
    }
    return out;
}

// Strip reasoning-model chain-of-thought so it never reaches a strict line
// parser. Reasoning models emit <think>...</think> (or <thinking>...</thinking>)
// whose free-form prose can contain stray '{', "#SHEET", or "NEED:" lookalikes
// that would be mis-parsed as malformed tool calls, a premature final token, or
// a fact selection the model actually decided against. Kept conservative so
// normal replies (which have no think tags) are byte-for-byte unaffected:
//   1. Remove all well-formed matched pairs.
//   2. If an UNMATCHED leading <think> remains (model was cut off mid-thought, or the
//      close tag was dropped), discard from that tag up to the first protocol-looking
//      line — one that starts with '{' or is the tolerant #SHEET/#DONE final token — so
//      no real protocol tokens are lost.
export function stripThinkBlocks(text) {
    const raw = String(text ?? '');
    let cleaned = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
    const dangling = /<think(?:ing)?>/i.exec(cleaned);
    if (dangling) {
        const after = cleaned.slice(dangling.index);
        const afterLines = after.split('\n');
        let cut = -1;
        for (let i = 0; i < afterLines.length; i++) {
            const l = afterLines[i].trim();
            if (l.startsWith('{') || /^[>*_`~\s#-]*#\s*(SHEET|DONE)\b/i.test(l)) { cut = i; break; }
        }
        cleaned = cleaned.slice(0, dangling.index) +
            (cut >= 0 ? afterLines.slice(cut).join('\n') : '');
    }
    return cleaned;
}

export function parseAgentReply(text) {
    const out = { calls: [], sheet: null, done: false, malformed: [] };
    const raw = String(text ?? '');
    if (!raw.trim()) return out;

    const cleaned = stripThinkBlocks(raw);

    const lines = cleaned.split('\n');

    const tryTool = (jsonStr, strict) => {
        let obj;
        try { obj = JSON.parse(jsonStr); }
        catch (e) {
            // Second chance: escape unescaped quotes inside string values and
            // re-parse, so one sloppy write_fact value doesn't burn the grace
            // round (or abort the whole run on a second offense).
            try { obj = JSON.parse(repairJsonLine(jsonStr)); }
            catch {
                if (strict) out.malformed.push({ line: jsonStr, error: `invalid JSON (${e.message || e}) — a tool call must be ONE line of strict JSON` });
                return;
            }
            addDebugLog('info', 'Repaired malformed JSON tool-call line (unescaped inner quotes)', {
                subsystem: 'agent3', event: 'toolloop.json_repaired', reason: 'JSON_REPAIRED',
                data: { line: jsonStr.slice(0, 200) },
            });
        }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        const tool = String(obj.tool || '').trim();
        if (!ALL_TOOLS.includes(tool)) { if (strict) out.malformed.push({ line: jsonStr, error: `unknown tool "${tool || '(missing)'}" — valid tools: ${ALL_TOOLS.join(', ')}` }); return; }
        if (obj.args !== undefined && (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args))) { if (strict) out.malformed.push({ line: jsonStr, error: `"args" must be a JSON object` }); return; }
        out.calls.push({ tool, args: obj.args || {}, line: jsonStr });
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (/^```/.test(line)) continue;

        // Tolerant final-token: optional leading fence/quote/bullet/bold/hash decoration,
        // "# SHEET", trailing ":" or trailing content all accepted.
        const finalMatch = /^[>*_`~\s#-]*#\s*(SHEET|DONE)\b\s*:?\s*(.*)$/i.exec(line);
        if (finalMatch) {
            out.done = true;
            if (finalMatch[1].toUpperCase() === 'SHEET') {
                const inline = finalMatch[2].replace(/[*_`~]+$/, '').trim();
                const body = lines.slice(i + 1).filter(l => !/^\s*```/.test(l));
                out.sheet = (inline ? inline + '\n' : '') + body.join('\n');
                out.sheet = out.sheet.trim();
                // Model wrote the sheet ABOVE the token (wrong order) and nothing
                // below it: salvage the preceding section instead of failing the
                // round with "carried no sheet content". Only lines from the first
                // sheet-like header up to the token are taken, so tool-call lines
                // and prose above the sheet are never swallowed.
                if (!out.sheet) {
                    let start = -1;
                    for (let k = 0; k < i; k++) {
                        if (/^\s*(SUMMARY|SCENE|TIMELINE|PRESENT|NEED|NOTES)\s*:/i.test(lines[k])) { start = k; break; }
                    }
                    if (start >= 0) {
                        out.sheet = lines.slice(start, i)
                            .filter(l => !/^\s*```/.test(l) && !l.trim().startsWith('{'))
                            .join('\n').trim();
                    }
                }
            }
            break;
        }

        // Fast path: whole line is a JSON tool call (unchanged behavior, incl. malformed reporting).
        if (line.startsWith('{')) { tryTool(line, true); continue; }

        // Tolerant path: a tool-call object wrapped in prose / after a prefix.
        if (line.includes('{') && /["']tool["']\s*:/.test(line)) {
            for (const cand of extractJsonObjects(line)) tryTool(cand, false);
        }
    }

    // Last-ditch: model wrote the sheet with no #SHEET token at all. Only when the
    // reply is otherwise pure chatter, so well-formed replies are never affected.
    if (!out.done && out.calls.length === 0 && out.malformed.length === 0) {
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*(SUMMARY|SCENE|TIMELINE|PRESENT|NEED|NOTES)\s*:/i.test(lines[i])) { start = i; break; }
        }
        if (start >= 0) {
            const body = lines.slice(start).filter(l => !/^\s*```/.test(l)).join('\n').trim();
            if (/^\s*SUMMARY\s*:/im.test(body) || /\bSUMMARY\s*:/i.test(body)) { out.done = true; out.sheet = body; }
        }
    }

    return out;
}

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
            case 'add_alias': return execAddAlias(args, ctx);
            case 'link_facts': return execLinkFacts(args, ctx);
            case 'merge_facts': return execMergeFacts(args, ctx);
            case 'mark_cold': return execMarkCold(args, ctx);
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

function currentNames() {
    let charName = '';
    let userName = '';
    try { charName = String(host.getCurrentCharacterName() || '').trim(); } catch {  }
    try { userName = String(host.getUserPersonaName() || '').trim(); } catch {  }
    return { charName, userName };
}

function safeNowContext() {
    try { return getTurnNowContext(); } catch { return null; }
}

function execListCategories(ctx) {
    const databases = ctx?.databases || {};
    const cats = effectiveCategories();
    const lines = [];
    const countActive = (db) => (db?.facts || []).reduce((n, f) => n + (isActiveFact(f) ? 1 : 0), 0);
    for (const cat of cats) {
        lines.push(`${cat} — ${countActive(databases[cat])} active fact(s)`);
    }

    for (const [cat, db] of Object.entries(databases)) {
        if (!cats.includes(cat)) lines.push(`${cat} — ${countActive(db)} active fact(s) (legacy)`);
    }
    return lines.join('\n');
}

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
        if (!ctx?.bypassVisibility && !isFactVisible(fact, names)) continue;
        total++;
        if (lines.length >= LIST_KEYS_CAP) continue; 
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

// Surface the fact's link refs (buildFactLine deliberately omits them from
// injected sheets) — both agent prompts promise them and tell the model to
// follow linked-fact leads. agentLinks reasons ride along as "(why)" on their
// matching ref. Returns '' when the fact has no links.
function linkedRefsTail(fact) {
    const rels = fact.relationships || {};
    const linked = [...new Set([
        ...(Array.isArray(rels.primary) ? rels.primary : []),
        ...(Array.isArray(rels.secondary) ? rels.secondary : []),
    ])].filter(Boolean);
    if (!linked.length) return '';
    const reasons = new Map();
    for (const l of (Array.isArray(fact.agentLinks) ? fact.agentLinks : [])) {
        const why = String(l?.reason || '').trim();
        if (l?.ref && why) reasons.set(String(l.ref).trim().toLowerCase(), why);
    }
    const shown = linked.map(ref => {
        const why = reasons.get(String(ref).trim().toLowerCase());
        return why ? `${ref} (${why})` : ref;
    });
    return `\n    linked: ${shown.join(', ')}`;
}

// FULL record view, used by read_facts/search in reflection mode ONLY.
//
// buildFactLine is a three-way branch: a fact that HAS a note renders the note
// INSTEAD of the value. That is right for an injected sheet (the note is the
// self-contained prose the storyteller reads) and catastrophic here, because
// the same call unlocks the repair gate: the model could be granted permission
// to overwrite a `value` it was never shown. Whatever unlocks a write must show
// every field that write can replace, so this renders value AND note AND the
// three metadata fields write_fact accepts (aspect, kind, importance) — plus
// knownBy, which write_fact's known_by can rewrite. Roughly 2-3x the characters
// of buildFactLine; that cost buys the gate its stated meaning.
function buildReflectRecordLine(fact, category, nowCtx) {
    const knownBy = (Array.isArray(fact.knownBy) ? fact.knownBy : []).filter(Boolean);
    const value = String(fact.value ?? '').trim();
    const note = (typeof fact.context === 'string' && fact.context.trim()) ? fact.context.trim() : '';
    const tone = (typeof fact.tone === 'string' && fact.tone.trim()) ? fact.tone.trim() : '';
    const recency = nowCtx ? recencyTail(fact, nowCtx) : '';

    const head = `${category}/${fact.key} = ${value || '(no value)'}${recency}`;
    const lines = [head];
    if (note) lines.push(`    note: ${note}`);
    const meta = [
        `aspect: ${String(deriveAspect(fact) || '-')}`,
        `kind: ${String(fact.kind || '-')}`,
        `importance: ${Number(fact.importance) || 0}`,
        `known by: ${knownBy.length ? knownBy.join(', ') : 'everyone'}`,
    ];
    if (tone) meta.push(`tone: ${tone}`);
    lines.push(`    ${meta.join(' | ')}`);
    return lines.join('\n') + linkedRefsTail(fact);
}

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

        const key = rawKey.includes('/') ? rawKey.slice(rawKey.lastIndexOf('/') + 1).trim() : rawKey;
        const fact = db ? findFactMatch(db, key) : null;
        if (!fact || !isActiveFact(fact) || (!ctx?.bypassVisibility && !isFactVisible(fact, names))) {
            lines.push(`${category}/${key}: (not found)`);
            continue;
        }
        recordReadKey(ctx, category, fact.key);
        // Reflection sees the FULL record (value AND note AND the metadata its
        // write tools can rewrite) — this call is what unlocks the repair gate.
        // Extraction keeps the compact sheet-shaped line it always got.
        lines.push(ctx?.mode === 'reflect'
            ? buildReflectRecordLine(fact, category, nowCtx)
            : buildFactLine(fact, category, nowCtx) + linkedRefsTail(fact));
    }
    return lines.join('\n');
}

async function execSearch(args, ctx) {
    const query = String(args?.query || '').trim();
    if (!query) return 'ERROR: search requires args.query';

    const needed = wordTokens(query, { min: 3 });
    if (needed.length === 0) needed.push(query.toLowerCase());
    let contextKeywords = [];
    try { contextKeywords = extractContextKeywords([{ mes: query }]); } catch {  }
    const result = await retrieveFacts(needed, contextKeywords);
    const names = currentNames();
    const visible = (result?.facts || [])
        .filter(r => r && r.fact && isActiveFact(r.fact) && (ctx?.bypassVisibility || isFactVisible(r.fact, names)))
        .slice(0, SEARCH_RESULT_CAP);
    if (visible.length === 0) return `(no stored facts matched "${query.slice(0, 80)}")`;
    // Search unlocks the repair gate exactly like an explicit read — so in
    // reflection mode it must render the SAME full record read_facts renders.
    // formatFactsForWriter is built on buildFactLine, which hides the value of
    // any note-bearing fact; unlocking a write from that view would license a
    // repair of a field the model never saw. Extraction is untouched.
    for (const r of visible) recordReadKey(ctx, r.category, r.fact?.key);
    if (ctx?.mode === 'reflect') {
        const nowCtx = safeNowContext();
        return visible.map(r => buildReflectRecordLine(r.fact, r.category, nowCtx)).join('\n');
    }
    return formatFactsForWriter(visible);
}

// --- Reflection repair-mode guardrails -------------------------------------
//
// Reflection's write tools are surgical: they may only touch a record the SAME
// pass pulled back in full, and only a handful of times. Both gates live here
// rather than in the tool loop because the loop counts tool calls and knows
// nothing about read vs write, or about which calls even got past validation.

// Record a key the model has genuinely SEEN. Guarded on the Set so the
// extraction agent's ctx (which has no readKeys) is byte-for-byte unaffected.
// Deliberately NOT called from list_keys: that emits "key | aspect | first 60
// chars" — a directory listing, not a record. Orientation must not license a
// repair. The RESOLVED stored key is recorded (not the requested one) so the
// gate canonicalizes identically to the write side, which resolves the same way
// through findFactMatch.
function recordReadKey(ctx, category, storedKey) {
    if (!(ctx?.readKeys instanceof Set)) return;
    const k = String(storedKey ?? '').trim().toLowerCase();
    if (!k) return;
    ctx.readKeys.add(`${category}::${k}`);
}

// Refusal text names the unlock verbatim: the model gets exactly ONE feedback
// round per refusal, so "you may not" without "here is how" wastes it.
function assertReadThisSession(ctx, category, storedKey, tool) {
    if (!(ctx.readKeys instanceof Set)) ctx.readKeys = new Set(); // fail closed
    if (ctx.readKeys.has(`${category}::${String(storedKey).toLowerCase()}`)) return '';
    return `ERROR: ${tool} refused — this session has not read ${category}/${storedKey}. Call {"tool":"read_facts","args":{"category":"${category}","keys":["${storedKey}"]}} first, then repair it in a LATER reply.`;
}

// Checked AFTER validation and the read gate, so a refused or malformed call
// never consumes budget; the caller increments only when it is about to mutate.
function assertWriteBudget(ctx, tool) {
    const max = Math.max(0, Math.floor(Number(ctx?.maxWrites) || 0));
    const used = Math.max(0, Math.floor(Number(ctx?.writeCount) || 0));
    if (used < max) return '';
    return `ERROR: ${tool} refused — reflection write budget exhausted (${max} per pass). Deliver anything further through the final #OBS/#REEVAL sections.`;
}

// A reflection write is BOOKKEEPING, not a sighting.
//
// upsertFact stamps `lastUpdated: Date.now()` unconditionally on every one of
// its branches (database.js), so `delete payload.lastUpdated` before the call is
// dead code — the field is re-created after the merge. Left alone, a repair
// reads downstream as "this fact was just mentioned again": it resets
// collectReevalCandidates' 24h stale-state window (a repaired stale state stops
// being a re-eval candidate), hands the record a free salienceScore decay reset,
// and pushes it to the front of both the premise-floor and conflict-ranking
// lastUpdated tiebreaks. So the stored stamp is captured before the write and
// restored in place after it. database.js owns upsertFact and offers no opt-out
// parameter; when it grows one, this helper is the single call site to replace.
export function restoreSightingStamp(fact, priorLastUpdated) {
    if (!fact) return;
    const prior = Number(priorLastUpdated);
    if (!Number.isFinite(prior) || prior <= 0) return;
    fact.lastUpdated = prior;
}

function reflectOnly(ctx, tool) {
    if (ctx?.mode === 'reflect') return '';
    return `ERROR: ${tool} is a reflection-only repair tool — this pass cannot call it. Use write_fact to store the fact directly.`;
}

const GENERIC_CHAR_TOKENS = new Set(['char', 'character']);
const GENERIC_USER_TOKENS = new Set(['user', 'persona']);

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

function subjectFromKey(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return '';
    const us = k.indexOf('_');
    return us > 0 ? k.slice(0, us) : k;
}

// If the key's leading token(s) are a REGISTERED alias of an existing character
// ("trish_mitchells_affair" or "patricia_job" where Patricia ≡ Trish), rewrite
// the prefix to the canonical subject token so all facts about one character
// share one subject. Only fires on explicit registry knowledge — unknown names
// pass through untouched.
function resolveAliasKeyPrefix(key) {
    const us = key.indexOf('_');
    const first = us > 0 ? key.slice(0, us) : key;
    const tail = us > 0 ? key.slice(us + 1) : '';
    if (tail) {
        // Two leading tokens may be a full name ("trish_mitchells_affair").
        const us2 = tail.indexOf('_');
        const second = us2 > 0 ? tail.slice(0, us2) : '';
        const rest = us2 > 0 ? tail.slice(us2 + 1) : '';
        if (second && rest) {
            const canonTwo = lookupCharacterAlias(`${first} ${second}`);
            if (canonTwo) return `${canonTwo}_${rest}`;
        }
    }
    const canon = lookupCharacterAlias(first);
    if (canon && canon !== first) return tail ? `${canon}_${tail}` : canon;
    return key;
}

// add_alias {name, alias} — record that two names are the SAME character.
// Persists as a People fact "<subject>_aliases" (so it survives, exports and
// snapshots like any other fact) and feeds the in-memory name registry that
// knownBy checks, retrieval and key resolution consult.
function execAddAlias(args, ctx) {
    if (!ctx || typeof ctx !== 'object' || !ctx.databases) return 'ERROR: add_alias has no database context';
    if (!(ctx.touchedCategories instanceof Set)) ctx.touchedCategories = new Set();
    const name = String(args?.name || '').trim().replace(/^@/, '');
    const alias = String(args?.alias || '').trim().replace(/^@/, '');
    if (!name || !alias) return 'ERROR: add_alias requires args.name and args.alias';
    if (name.toLowerCase() === alias.toLowerCase()) return 'ERROR: name and alias are identical';

    // Canonical subject: whichever side the store already knows, else the
    // first-name token of "name".
    const token = lookupCharacterAlias(name)
        || lookupCharacterAlias(alias)
        || keyToken(name.split(/\s+/)[0]);
    if (!token) return 'ERROR: add_alias could not derive a subject token';

    const category = 'People';
    if (!ctx.databases[category]) ctx.databases[category] = createEmptyDatabase(category);
    const db = ctx.databases[category];
    const key = `${token}_aliases`;

    const existing = findFactMatch(db, key);
    const merged = new Set();
    const addName = (n) => { const t = String(n || '').trim(); if (t) merged.add(t); };
    if (existing) {
        String(existing.value || '').split(/[,;]/).forEach(addName);
        (Array.isArray(existing.aliases) ? existing.aliases : []).forEach(addName);
    }
    addName(name);
    addName(alias);

    const list = [...merged];
    const sourceIndex = Number.isInteger(ctx.sourceIndex) ? ctx.sourceIndex : null;
    const fact = {
        key,
        value: list.join(', '),
        tags: [],
        aliases: list,
        knownBy: [],
        relationships: { primary: [], secondary: [], tertiary: [] },
        source: sourceIndex !== null ? `msg_${sourceIndex}` : `agent_${ctx.runId || 'run'}`,
        importance: 4,
        kind: 'trait',
        aspect: 'aliases',
        subject: token,
        scope: 'character',
        context: `Names used for the same character: ${list.join(', ')}`,
    };
    if (sourceIndex !== null) fact.validAt = sourceIndex;
    if (ctx.srcId) fact.srcId = ctx.srcId;

    upsertFact(db, fact);
    ctx.touchedCategories.add(category);

    // Make the link resolvable immediately (same run), before the memory index
    // is next rebuilt.
    for (const n of list) registerCharacterAlias(n, token);

    addDebugLog('info', `Memory Agent add_alias: "${alias}" ≡ "${name}" (subject "${token}")`, {
        subsystem: 'agent3', event: 'memtool.add_alias', data: { token, names: list, runId: ctx.runId || '' },
    });
    return `OK "${alias}" and "${name}" now resolve to the same character (People/${key}: ${list.join(', ')})`;
}

// link_facts {from, to, reason} — agent-declared semantic link between two
// STORED facts ("Category:key" on both sides). Persists through the SAME graph
// storage autoLinkFact uses (relationships.primary refs, both directions) so
// the existing expansion/walk machinery surfaces one fact when the other is on
// the sheet; the reason rides along in fact.agentLinks for the DB panel.
function parseFactRef(raw) {
    const s = String(raw || '').trim();
    const sep = s.search(/[:/]/);
    if (sep <= 0 || sep >= s.length - 1) return null;
    const category = mapLegacyCategory(s.slice(0, sep).trim());
    const key = s.slice(sep + 1).trim();
    if (!category || !key) return null;
    return { category, key };
}

// Resolve a "Category:key" ref to a live ACTIVE fact, applying the same key
// canonicalization write_fact applies on store (generic char/user prefix,
// registered alias prefix) — so a ref emitted in the same reply as the
// write_fact that rewrote the key ("char_secret" stored as "monika_secret")
// still resolves. Shared by link_facts and merge_facts: a ref that works in one
// ref-taking tool must work in all of them, or the model burns rounds learning
// which surface is which.
function resolveRefFact(ctx, ref) {
    const db = ctx.databases[ref.category];
    if (!db) return null;
    let fact = findFactMatch(db, ref.key);
    if (!fact) {
        let key = keyToken(ref.key);
        if (key) {
            key = resolveGenericKeyPrefix(key, currentNames());
            key = resolveAliasKeyPrefix(key);
            if (key !== ref.key) fact = findFactMatch(db, key);
        }
    }
    return (fact && isActiveFact(fact)) ? fact : null;
}

function execLinkFacts(args, ctx) {
    if (!ctx || typeof ctx !== 'object' || !ctx.databases) return 'ERROR: link_facts has no database context';
    if (!(ctx.touchedCategories instanceof Set)) ctx.touchedCategories = new Set();

    const fromRef = parseFactRef(args?.from);
    const toRef = parseFactRef(args?.to);
    if (!fromRef || !toRef) return 'ERROR: link_facts requires args.from and args.to as "Category:key" refs';

    const resolve = (ref) => resolveRefFact(ctx, ref);
    const fromFact = resolve(fromRef);
    if (!fromFact) return `ERROR: link_facts found no active fact ${fromRef.category}/${fromRef.key} — verify the ref with list_keys/read_facts`;
    const toFact = resolve(toRef);
    if (!toFact) return `ERROR: link_facts found no active fact ${toRef.category}/${toRef.key} — verify the ref with list_keys/read_facts`;

    const status = linkFactsExplicit(fromFact, fromRef.category, toFact, toRef.category, args?.reason, ctx.runId || '');
    if (status === 'invalid') return 'ERROR: link_facts cannot link a fact to itself';
    if (status === 'ambiguous') return `ERROR: link_facts cannot represent this link — ${fromRef.category}/${fromFact.key} and ${toRef.category}/${toFact.key} are different facts sharing the same key, and link refs are keyed by fact key alone; rewrite one fact under a distinct key first`;
    if (status === 'capped') return `ERROR: agent-link cap reached (${AGENT_LINK_MAX} per fact) — link not added`;
    // 'duplicate' is a no-op success: the connection is already declared.
    if (status === 'duplicate') return `OK ${fromRef.category}/${fromFact.key} and ${toRef.category}/${toFact.key} are already linked (no change)`;

    // Stamp both categories like a fact write would — the rehydrate recency
    // guards read db.updatedAt, and a link-only session must not look stale.
    const linkStamp = Date.now();
    if (ctx.databases[fromRef.category]) ctx.databases[fromRef.category].updatedAt = linkStamp;
    if (ctx.databases[toRef.category]) ctx.databases[toRef.category].updatedAt = linkStamp;
    ctx.touchedCategories.add(fromRef.category);
    ctx.touchedCategories.add(toRef.category);
    addDebugLog('info', `Memory Agent link_facts: ${fromRef.category}/${fromFact.key} <-> ${toRef.category}/${toFact.key}`, {
        subsystem: 'agent3', event: 'memtool.link_facts',
        data: { from: `${fromRef.category}:${fromFact.key}`, to: `${toRef.category}:${toFact.key}`, reason: String(args?.reason || '').trim(), runId: ctx.runId || '' },
    });
    return `OK linked ${fromRef.category}/${fromFact.key} <-> ${toRef.category}/${toFact.key}`;
}

function scopeFromCategory(category) {
    switch (String(category || '').toLowerCase()) {
        case 'events': return 'event';
        case 'places':
        case 'world': return 'place';
        default: return 'character';
    }
}

function execWriteFact(args, ctx) {
    if (!ctx || typeof ctx !== 'object' || !ctx.databases) return 'ERROR: write_fact has no database context';
    if (!Array.isArray(ctx.applied)) ctx.applied = [];
    if (!(ctx.touchedCategories instanceof Set)) ctx.touchedCategories = new Set();

    // Reflection calls the SAME validation prologue but a different persistence
    // path: it repairs stored records instead of authoring them. Four of the
    // defaults below are actively wrong out of band (see the repair path), so
    // they are neutralized under this flag rather than re-implemented elsewhere.
    const reflectMode = ctx.mode === 'reflect';

    const rawCategory = String(args?.category || '').trim();
    let category = mapLegacyCategory(rawCategory || 'Unsorted');
    let categoryNote = '';
    if (!effectiveCategories().includes(category)) {
        // A repair filed to Unsorted is not a repair: the key it names lives
        // somewhere else, so the correct answer is a refusal, not a relocation.
        if (reflectMode) return `ERROR: write_fact refused — unknown category "${rawCategory}". Name the category the record is actually stored in (${effectiveCategories().join(', ')}); reflection cannot re-file a record it cannot find.`;
        categoryNote = ` (unknown category "${rawCategory}" — filed to Unsorted)`;
        category = 'Unsorted';
    }

    let key = keyToken(args?.key);
    if (!key) return 'ERROR: write_fact requires a usable snake_case "key"';

    const value = String(args?.value ?? '').trim();
    const note = String(args?.note ?? args?.context ?? '').trim();
    // Distinguish "note omitted" (keep the stored note) from "note explicitly
    // empty" (clear it) — without this a note could never be deleted.
    const noteProvided = !!args && (Object.hasOwn(args, 'note') || Object.hasOwn(args, 'context'));
    // Which repair fields the model actually NAMED. Omission must mean "keep
    // what is stored" for every one of them, so the payload built below is the
    // sparsest object that expresses the requested change.
    const valueProvided = !!args && Object.hasOwn(args, 'value');
    const rawAspectArg = String(args?.aspect || '').trim();
    const aspectProvided = !!rawAspectArg;
    const kindProvided = !!args && args.kind !== undefined && args.kind !== null && !!String(args.kind).trim();
    const importanceProvided = !!args && args.importance !== undefined && args.importance !== null && args.importance !== '';
    const knownByProvided = Array.isArray(args?.known_by) && args.known_by.length > 0;
    if (reflectMode) {
        // An explicitly empty value would blank a stored one. mark_cold is the
        // tool for "this record is worthless"; write_fact never erases content.
        if (valueProvided && !value) return 'ERROR: write_fact refused — an empty "value" would blank the stored one. Omit the field to keep it, or use mark_cold if the record is noise.';
        if (!value && !noteProvided && !aspectProvided && !kindProvided && !importanceProvided && !knownByProvided) {
            return 'ERROR: write_fact needs at least one field to repair ("value", "note", "aspect", "kind", "importance" or "known_by").';
        }
    } else if (!value && !note) {
        return 'ERROR: write_fact requires a non-empty "value" (or "note")';
    }

    const names = currentNames();
    key = resolveGenericKeyPrefix(key, names);
    key = resolveAliasKeyPrefix(key);

    if (reflectMode) return reflectRepairFact({ args, ctx, category, key, value, note, noteProvided, rawAspectArg, aspectProvided, kindProvided, importanceProvided, knownByProvided });

    let knownBy = (Array.isArray(args?.known_by) ? args.known_by : [])
        .map(n => String(n ?? '').trim().replace(/^@/, '').trim())
        .filter(Boolean);
    if (knownBy.length === 0) {
        // No explicit witness list: default to everyone physically in the scene
        // (agent-reported PRESENT line), not just the main char/user pair —
        // NPCs in the room heard it too. The pair is the last resort only.
        let present = [];
        try { present = getScenePresent(); } catch { present = []; }
        knownBy = present.length > 0
            ? [...new Set(present)]
            : [...new Set([names.charName, names.userName].filter(Boolean))];
    } else {
        knownBy = [...new Set(knownBy)];
    }

    const kind = normalizeKind(args?.kind);
    const importance = clampImportance(args?.importance);
    const rawAspect = String(args?.aspect || '').trim();
    const aspect = normalizeAspect(canonicalizeLeafSurface(rawAspect) || rawAspect, category);

    const tags = (Array.isArray(args?.tags) ? args.tags : [])
        .map(t => String(t ?? '').trim()).filter(Boolean);
    const involved = (Array.isArray(args?.with) ? args.with : Array.isArray(args?.involved) ? args.involved : [])
        .map(n => String(n ?? '').trim().replace(/^@/, '').trim())
        .filter(Boolean);

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
    else if (noteProvided) fact.context = ''; // explicit empty note = clear it (mergeContext honors '')
    if (involved.length) fact.involved = involved;
    if (sourceIndex !== null) fact.validAt = sourceIndex;
    // Stable, position-independent origin id for this fact's source message
    // (survives deletes/branches; see pipeline.js ensureMsgUid). `source`
    // above stays as the legacy positional pointer for provenance history.
    if (ctx.srcId) fact.srcId = ctx.srcId;

    if (!ctx.databases[category]) {
        ctx.databases[category] = createEmptyDatabase(category);
        addDebugLog('info', `Created new database: "${category}"`, {
            subsystem: 'agent3', event: 'memtool.db_created', data: { category, runId: ctx.runId || '' },
        });
    }
    const db = ctx.databases[category];

    const matched = findFactMatch(db, key);
    const changed = isMaterialFactWrite(db, fact);
    // A note-only edit is a REAL change and must be reported as one — the old
    // 'SKIPPED' status persisted the new note while telling the agent (and the
    // frontend fact lists) that nothing happened.
    const storedNote = String(matched?.context ?? '').trim();
    const noteChanged = !!matched && noteProvided && note !== storedNote;
    const status = !matched ? 'NEW' : (changed ? 'UPDATED' : (noteChanged ? 'NOTE_UPDATED' : 'SKIPPED'));

    upsertFact(db, fact);
    // Always mark the category dirty when upsertFact ran, so an in-place edit is
    // persisted to IDB regardless of status. Set.add is idempotent.
    ctx.touchedCategories.add(category);

    if (changed || noteChanged) {

        const stored = findFactMatch(db, fact.key);
        if (stored && ctx.index) autoLinkFact(ctx.index, stored, category, ctx.runId);

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

// write_fact in REPAIR mode (ctx.mode === 'reflect'). Shares execWriteFact's
// validation prologue and diverges here, because reflection needs the opposite
// defaults: it patches a record that must already exist, and every field the
// model did not name must survive untouched.
//
// Deliberately NOT carried over from the extraction path:
//   - knownBy is never defaulted to getScenePresent(). Reflection runs detached
//     from a turn, so "whoever is in the room now" would clobber a curated
//     witness list with an unrelated cast.
//   - aspect/kind/importance are never normalized into existence. normalizeAspect
//     NEVER returns empty, so passing an omitted aspect through it would silently
//     rewrite a good stored aspect to the category default.
//   - subject/scope/source/validAt/srcId are never sent. mergeProvenance keeps
//     genesis provenance anyway, and reflection has no sourceIndex — a repair
//     must not look like a new sighting. lastUpdated is the one field upsertFact
//     re-stamps regardless of the payload, so restoreSightingStamp puts it back
//     after the write (see that helper for what the re-stamp would break).
//   - applyCrossKeySupersedeRules is not run: a surgical repair must not cascade
//     deactivations onto keys the model never read.
function reflectRepairFact({ args, ctx, category, key, value, note, noteProvided, rawAspectArg, aspectProvided, kindProvided, importanceProvided, knownByProvided }) {
    const db = ctx.databases[category];
    const stored = db ? findFactMatch(db, key) : null;
    if (!stored || !isActiveFact(stored)) {
        return `ERROR: write_fact (reflection) found no stored fact ${category}/${key} — reflection repairs existing records only; new subjects are the extractor's job. Verify with read_facts/list_keys.`;
    }
    // upsertFact un-colds every fact it touches (uncoldFact), so ANY repair would
    // silently resurrect a demoted record. Refusing keeps the cold tier a one-way
    // door owned by mark_cold and #REEVAL drop.
    if (isColdFact(stored)) {
        return `ERROR: write_fact refused — ${category}/${stored.key} is cold-tiered (kept, deprioritized). Cold records are out of scope for repair.`;
    }
    // Sequence facts live on a different upsertFact branch keyed by track/ord;
    // patching one through the normal path would corrupt its timeline position.
    if (isSequenceFact(stored)) {
        return `ERROR: write_fact refused — ${category}/${stored.key} is a sequence step (track "${stored.track}"); its ord position defines a timeline and must not be patched.`;
    }

    const gate = assertReadThisSession(ctx, category, stored.key, 'write_fact');
    if (gate) return gate;
    const budget = assertWriteBudget(ctx, 'write_fact');
    if (budget) return budget;

    const tags = (Array.isArray(args?.tags) ? args.tags : [])
        .map(t => String(t ?? '').trim()).filter(Boolean);
    const involved = (Array.isArray(args?.with) ? args.with : Array.isArray(args?.involved) ? args.involved : [])
        .map(n => String(n ?? '').trim().replace(/^@/, '').trim())
        .filter(Boolean);

    // Sparsest payload that expresses the repair. Keying it on stored.key (not
    // the requested key) pins upsertFact's match to the record we validated.
    const patch = { key: stored.key };
    if (value) patch.value = value;
    if (note) patch.context = note;
    else if (noteProvided) patch.context = ''; // explicit empty note = clear it (mergeContext honors '')
    if (aspectProvided) patch.aspect = normalizeAspect(canonicalizeLeafSurface(rawAspectArg) || rawAspectArg, category);
    if (kindProvided) patch.kind = normalizeKind(args.kind);
    if (importanceProvided) patch.importance = clampImportance(args.importance);
    if (knownByProvided) {
        patch.knownBy = [...new Set(args.known_by
            .map(n => String(n ?? '').trim().replace(/^@/, '').trim())
            .filter(Boolean))];
    }
    if (tags.length) patch.tags = tags;
    if (involved.length) patch.involved = involved;

    const before = {
        value: String(stored.value ?? ''),
        note: String(stored.context ?? ''),
        aspect: String(stored.aspect ?? ''),
        kind: String(stored.kind ?? ''),
        importance: Number(stored.importance),
        knownBy: Array.isArray(stored.knownBy) ? [...stored.knownBy] : [],
    };

    const priorLastUpdated = Number(stored.lastUpdated) || 0;

    ctx.writeCount = (Number(ctx.writeCount) || 0) + 1;
    upsertFact(db, patch);
    ctx.touchedCategories.add(category);

    const after = findFactMatch(db, stored.key) || stored;
    restoreSightingStamp(after, priorLastUpdated);

    // mergeSalience takes Math.max(incoming, existing) for importance, so a
    // repair can only ever RAISE it — a downgrade silently becomes a no-op.
    // The max rule is correct for extraction (re-mentions accumulate weight)
    // and wrong for a repair that judged the stored weight inflated, so the
    // downgrade is re-applied in place instead of changing mergeSalience.
    let loweredImportance = false;
    if (importanceProvided && Number.isFinite(before.importance) && patch.importance < before.importance) {
        after.importance = patch.importance;
        loweredImportance = true;
    }

    // A repaired record can belong to a different neighborhood than it did —
    // re-link it exactly as an extraction write would.
    if (ctx.index) { try { autoLinkFact(ctx.index, after, category, ctx.runId); } catch { /* linking is best-effort; the repair itself already landed */ } }

    const fields = [];
    if (value && value !== before.value) fields.push('value');
    if (noteProvided && String(after.context ?? '') !== before.note) fields.push('note');
    if (aspectProvided && String(after.aspect ?? '') !== before.aspect) fields.push('aspect');
    if (kindProvided && String(after.kind ?? '') !== before.kind) fields.push('kind');
    if (importanceProvided && Number(after.importance) !== before.importance) fields.push('importance');
    if (knownByProvided) fields.push('known_by');
    if (tags.length) fields.push('tags');
    if (involved.length) fields.push('with');

    ctx.applied.push({ category, key: stored.key, fact: after, status: 'REPAIRED' });

    addDebugLog('info', `[${ctx.runId || ''}] Reflection repaired [${category}] ${stored.key}: "${before.value.slice(0, 80)}" → "${String(after.value ?? '').slice(0, 80)}"${fields.length ? ` (${fields.join(', ')})` : ' (no material change)'}`, {
        subsystem: 'reflection', event: 'fact.repaired', reason: loweredImportance ? 'IMPORTANCE_LOWERED' : 'REFLECT_WRITE',
        data: {
            category, key: stored.key, fields,
            oldValue: before.value, newValue: String(after.value ?? ''),
            oldNote: before.note, newNote: String(after.context ?? ''),
            oldAspect: before.aspect, newAspect: String(after.aspect ?? ''),
            oldImportance: before.importance, newImportance: Number(after.importance),
            oldKnownBy: before.knownBy, newKnownBy: Array.isArray(after.knownBy) ? [...after.knownBy] : [],
            writeCount: ctx.writeCount, maxWrites: ctx.maxWrites, runId: ctx.runId || '',
        },
        before: before.value, after: String(after.value ?? ''),
    });

    if (fields.length === 0) return `OK ${category}/${stored.key} already matched what you sent (no change) — ${ctx.writeCount}/${ctx.maxWrites} writes used`;
    return `OK repaired ${category}/${stored.key} (${fields.join(', ')})${loweredImportance ? ' — importance lowered' : ''} — ${ctx.writeCount}/${ctx.maxWrites} writes used`;
}

// merge_facts {from, into, value?} — fold a duplicate record INTO a survivor and
// COLD-TIER the loser. Reflection-only: the extraction pass has dedupeDatabase
// and upsertFact's key-normalization for this, and no read gate to make it safe.
//
// The loser used to be hard-deleted through removeFact. It is not any more, and
// that is a deliberate invariant, not an oversight: every other demotion in this
// codebase — #REEVAL drop, mark_cold, CONFLICT_A/B/LOSER — is cold-tiering, the
// reflection prompt promises "kept, deprioritized, never erased" three times
// over, and a delete guarded only by "the model read both first" is the one
// irreversible act in the whole write path. Cold-tiering keeps the loser's
// value/context/aspect/importance/provenance recoverable from the DB panel while
// dropping it out of the premise floor and injection, which is the entire
// user-visible point of a merge.
//
// Two sub-hazards die with the delete IN THIS TOOL: removeFact filtered on EXACT
// key equality and so removed EVERY fact under that key (one category can
// legitimately hold two), and the delete-before-upsert ordering that existed to
// stop the payload landing on the about-to-be-deleted loser is no longer
// load-bearing. Note the first hazard was never a property of merge_facts alone —
// it belonged to removeFact, and it outlived this change in the one other place
// reflection removed a record, the #REEVAL promote's cross-category move. That
// call site now splices the single moved fact by identity, so removeFact is
// unreachable from the reflection path and the claim above holds for the path,
// not just for this function.
function execMergeFacts(args, ctx) {
    if (!ctx || typeof ctx !== 'object' || !ctx.databases) return 'ERROR: merge_facts has no database context';
    const modeErr = reflectOnly(ctx, 'merge_facts');
    if (modeErr) return modeErr;
    if (!Array.isArray(ctx.applied)) ctx.applied = [];
    if (!(ctx.touchedCategories instanceof Set)) ctx.touchedCategories = new Set();

    const fromRef = parseFactRef(args?.from);
    const intoRef = parseFactRef(args?.into);
    if (!fromRef || !intoRef) return 'ERROR: merge_facts requires args.from and args.into as "Category:key" refs';

    // Same resolver link_facts uses — a "People:char_secret" ref that write_fact
    // and link_facts both canonicalize must not dead-end here.
    const resolve = (ref) => resolveRefFact(ctx, ref);
    const loser = resolve(fromRef);
    if (!loser) return `ERROR: merge_facts found no active fact ${fromRef.category}/${fromRef.key} — verify the ref with list_keys/read_facts`;
    const survivor = resolve(intoRef);
    if (!survivor) return `ERROR: merge_facts found no active fact ${intoRef.category}/${intoRef.key} — verify the ref with list_keys/read_facts`;
    if (loser === survivor) return 'ERROR: merge_facts cannot merge a fact into itself — the two refs resolve to the same stored record';
    // upsertFact routes sequence facts down a track/ord branch, and cold-tiering
    // one would leave a hole in its timeline: either side being a step makes the
    // merge unsafe.
    if (isSequenceFact(loser) || isSequenceFact(survivor)) return 'ERROR: merge_facts cannot touch a sequence step (a fact with a "track") — its ord position defines a timeline; leave it alone';
    // Importance 5 is the core-identity tier the premise floor is built on, and
    // a merge demotes the loser out of that floor. Same refusal mark_cold gives:
    // if such a record is wrong it gets repaired, never folded away.
    if ((Number(loser.importance) || 0) >= 5) {
        return `ERROR: merge_facts refused — ${fromRef.category}/${loser.key} is importance 5 (core identity; the premise floor is built on those). Repair it with write_fact, or merge in the other direction if it is the survivor.`;
    }
    // Already cold: idempotent no-op success, reported before the budget check so
    // a redundant call costs the pass nothing.
    if (isColdFact(loser)) return `OK ${fromRef.category}/${loser.key} is already cold-tiered — nothing left to fold (no change)`;
    // upsertFact un-colds whatever it touches (uncoldFact), so merging INTO a
    // cold record would resurrect it — the same one-way-door argument write_fact
    // makes. The cold tier is owned by mark_cold and #REEVAL drop.
    if (isColdFact(survivor)) {
        return `ERROR: merge_facts refused — the survivor ${intoRef.category}/${survivor.key} is cold-tiered (kept, deprioritized). Merging into it would resurrect it; pick the hot record as "into".`;
    }

    const gateFrom = assertReadThisSession(ctx, fromRef.category, loser.key, 'merge_facts');
    if (gateFrom) return gateFrom;
    const gateInto = assertReadThisSession(ctx, intoRef.category, survivor.key, 'merge_facts');
    if (gateInto) return gateInto;
    const budget = assertWriteBudget(ctx, 'merge_facts');
    if (budget) return budget;

    const newValue = String(args?.value ?? '').trim();
    const beforeValue = String(survivor.value ?? '');
    // Only the loser's ACCUMULATED material travels: tags, involved, aliases,
    // relationships and agentLinks are all unions inside upsertFact, so handing
    // them over costs nothing. Its value/aspect/kind/subject/source/validAt
    // deliberately do NOT — the survivor is the record that stands.
    const payload = { key: survivor.key };
    if (Array.isArray(loser.tags) && loser.tags.length) payload.tags = loser.tags;
    if (Array.isArray(loser.involved) && loser.involved.length) payload.involved = loser.involved;
    if (Array.isArray(loser.aliases) && loser.aliases.length) payload.aliases = loser.aliases;
    if (loser.relationships) payload.relationships = loser.relationships;
    if (Array.isArray(loser.agentLinks) && loser.agentLinks.length) payload.agentLinks = loser.agentLinks;
    if (newValue) payload.value = newValue;
    // knownBy is a PLAIN OVERWRITE in upsertFact's spread, not a union — without
    // this the loser's witnesses are dropped on the floor by the merge.
    const knownBy = [...new Set([
        ...(Array.isArray(survivor.knownBy) ? survivor.knownBy : []),
        ...(Array.isArray(loser.knownBy) ? loser.knownBy : []),
    ].map(n => String(n ?? '').trim()).filter(Boolean))];
    if (knownBy.length) payload.knownBy = knownBy;

    const loserKey = loser.key;
    const loserValue = String(loser.value ?? '');
    const loserCallbacks = Array.isArray(loser.callbacks) ? [...loser.callbacks] : [];
    const priorLastUpdated = Number(survivor.lastUpdated) || 0;

    ctx.writeCount = (Number(ctx.writeCount) || 0) + 1;

    // Upsert FIRST, cold-tier the loser second. The old order (delete, then
    // upsert) existed so the payload could not land on a record about to be
    // deleted; nothing is deleted now, and doing the upsert first means the
    // cold flag is set on whatever object survives the merge pass — if the
    // payload somehow resolved onto the loser, the identity guard below catches
    // it and the merge degrades to "survivor updated, nothing demoted" rather
    // than to a cold-tiered survivor.
    upsertFact(ctx.databases[intoRef.category], payload);
    const stored = findFactMatch(ctx.databases[intoRef.category], survivor.key) || survivor;
    // A merge is bookkeeping, not a re-sighting of the subject — see
    // restoreSightingStamp. The loser keeps its own stamp untouched (markFactCold
    // writes only fact.cold), so no sighting time is invented anywhere.
    restoreSightingStamp(stored, priorLastUpdated);
    if (stored !== loser) {
        markFactCold(loser, fromRef.category, 'MERGE_LOSER', `folded into ${intoRef.category}/${stored.key}`);
    }

    // callbacks are not merged by upsertFact either (the extraction payload never
    // mentions them, so they survive by accident rather than by rule). Dedupe on
    // toCategory+toKey exactly as the #CALLBACK writer does.
    if (loserCallbacks.length) {
        if (!Array.isArray(stored.callbacks)) stored.callbacks = [];
        for (const cb of loserCallbacks) {
            if (!cb) continue;
            if (stored.callbacks.some(c => c && c.toKey === cb.toKey && c.toCategory === cb.toCategory)) continue;
            stored.callbacks.push(cb);
        }
    }

    // Link refs on OTHER facts still name the loser's key. That is now harmless
    // rather than merely tolerated: the record still exists, it is only cold, so
    // the refs resolve to a real (deprioritized) fact instead of dangling.
    const stamp = Date.now();
    if (ctx.databases[fromRef.category]) ctx.databases[fromRef.category].updatedAt = stamp;
    if (ctx.databases[intoRef.category]) ctx.databases[intoRef.category].updatedAt = stamp;
    ctx.touchedCategories.add(fromRef.category);
    ctx.touchedCategories.add(intoRef.category);
    ctx.applied.push({ category: intoRef.category, key: stored.key, fact: stored, status: 'MERGED' });

    addDebugLog('info', `[${ctx.runId || ''}] Reflection merged [${fromRef.category}] ${loserKey} ("${loserValue.slice(0, 60)}") into [${intoRef.category}] ${stored.key} ("${String(stored.value ?? '').slice(0, 60)}"); the duplicate is cold-tiered, not erased`, {
        subsystem: 'reflection', event: 'fact.merged', reason: 'DUPLICATE_FOLDED',
        data: {
            fromCategory: fromRef.category, fromKey: loserKey, fromValue: loserValue,
            category: intoRef.category, key: stored.key,
            oldValue: beforeValue, newValue: String(stored.value ?? ''),
            loserColdTiered: stored !== loser,
            writeCount: ctx.writeCount, maxWrites: ctx.maxWrites, runId: ctx.runId || '',
        },
        before: beforeValue, after: String(stored.value ?? ''),
    });

    return `OK merged ${fromRef.category}/${loserKey} into ${intoRef.category}/${stored.key} (= "${String(stored.value ?? '').slice(0, 60)}"); the duplicate is cold-tiered (kept, deprioritized, not erased) — ${ctx.writeCount}/${ctx.maxWrites} writes used`;
}

// mark_cold {category, key, reason} — demote stored noise the declarative
// #REEVAL channel cannot reach. collectReevalCandidates only ever offers
// Unsorted/misc facts and doubly-stale states (max 15), so anything else the
// pass reads and judges worthless is otherwise unreachable. Distinct reason code
// (REFLECT_MARK_COLD vs REEVAL_DROP) keeps the two paths separable in the log.
function execMarkCold(args, ctx) {
    if (!ctx || typeof ctx !== 'object' || !ctx.databases) return 'ERROR: mark_cold has no database context';
    const modeErr = reflectOnly(ctx, 'mark_cold');
    if (modeErr) return modeErr;
    if (!(ctx.touchedCategories instanceof Set)) ctx.touchedCategories = new Set();

    const rawCategory = String(args?.category || '').trim();
    if (!rawCategory) return 'ERROR: mark_cold requires args.category';
    const category = mapLegacyCategory(rawCategory);
    const rawKey = String(args?.key || '').trim();
    if (!rawKey) return 'ERROR: mark_cold requires args.key';
    const key = rawKey.includes('/') ? rawKey.slice(rawKey.lastIndexOf('/') + 1).trim() : rawKey;

    const db = ctx.databases[category];
    const fact = db ? findFactMatch(db, key) : null;
    if (!fact || !isActiveFact(fact)) return `ERROR: mark_cold found no active fact ${category}/${key} — verify the ref with list_keys/read_facts`;
    if (isSequenceFact(fact)) return `ERROR: mark_cold cannot demote a sequence step (track "${fact.track}") — removing it from the hot tier would leave a hole in the timeline`;
    // Importance 5 is the core-identity tier the premise floor is built on. If
    // such a fact is wrong it gets repaired, never demoted out of sight.
    if ((Number(fact.importance) || 0) >= 5) {
        return `ERROR: mark_cold refused — ${category}/${fact.key} is importance 5 (core identity; the premise floor is built on those). Repair it with write_fact if it is wrong.`;
    }
    // Already cold: an idempotent no-op success, reported before the budget check
    // so a redundant call costs the pass nothing.
    if (isColdFact(fact)) return `OK ${category}/${fact.key} was already cold (no change)`;

    const gate = assertReadThisSession(ctx, category, fact.key, 'mark_cold');
    if (gate) return gate;
    const budget = assertWriteBudget(ctx, 'mark_cold');
    if (budget) return budget;

    const reason = String(args?.reason || '').trim().slice(0, 160);
    ctx.writeCount = (Number(ctx.writeCount) || 0) + 1;
    markFactCold(fact, category, 'REFLECT_MARK_COLD', reason || 'reflection judged it stored noise');
    // markFactCold touches fact.cold and nothing else — stamp the db like a fact
    // write would, so the rehydrate recency guards do not read this as stale.
    if (db) db.updatedAt = Date.now();
    ctx.touchedCategories.add(category);

    addDebugLog('info', `[${ctx.runId || ''}] Reflection cold-tiered [${category}] ${fact.key} = "${String(fact.value ?? '').slice(0, 60)}"${reason ? ` — ${reason}` : ''}`, {
        subsystem: 'reflection', event: 'fact.repaired', reason: 'REFLECT_MARK_COLD',
        data: {
            category, key: fact.key, oldValue: String(fact.value ?? ''), newValue: String(fact.value ?? ''),
            cold: true, detail: reason, writeCount: ctx.writeCount, maxWrites: ctx.maxWrites, runId: ctx.runId || '',
        },
    });

    return `OK ${category}/${fact.key} cold-tiered (kept, deprioritized, not erased) — ${ctx.writeCount}/${ctx.maxWrites} writes used`;
}
