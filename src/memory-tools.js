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

const KNOWN_TOOLS = ['list_categories', 'list_keys', 'read_facts', 'write_fact', 'search'];

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

export function parseAgentReply(text) {
    const out = { calls: [], sheet: null, done: false, malformed: [] };
    const raw = String(text ?? '');
    if (!raw.trim()) return out;

    // Strip reasoning-model chain-of-thought so it never reaches the strict protocol
    // parser below. Reasoning models emit <think>...</think> (or <thinking>...</thinking>)
    // whose free-form prose can contain stray '{' or "#SHEET" lookalikes that would be
    // mis-parsed as malformed tool calls or a premature final token. Kept conservative so
    // normal replies (which have no think tags) are byte-for-byte unaffected:
    //   1. Remove all well-formed matched pairs.
    //   2. If an UNMATCHED leading <think> remains (model was cut off mid-thought, or the
    //      close tag was dropped), discard from that tag up to the first protocol-looking
    //      line — one that starts with '{' or is the tolerant #SHEET/#DONE final token — so
    //      no real protocol tokens are lost.
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

    const lines = cleaned.split('\n');

    const tryTool = (jsonStr, strict) => {
        let obj;
        try { obj = JSON.parse(jsonStr); }
        catch (e) { if (strict) out.malformed.push({ line: jsonStr, error: `invalid JSON (${e.message || e}) — a tool call must be ONE line of strict JSON` }); return; }
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        const tool = String(obj.tool || '').trim();
        if (!KNOWN_TOOLS.includes(tool)) { if (strict) out.malformed.push({ line: jsonStr, error: `unknown tool "${tool || '(missing)'}" — valid tools: ${KNOWN_TOOLS.join(', ')}` }); return; }
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
            if (/^\s*(SUMMARY|SCENE|TIMELINE|NEED|NOTES)\s*:/i.test(lines[i])) { start = i; break; }
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
        if (!isFactVisible(fact, names)) continue; 
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
        if (!fact || !isActiveFact(fact) || !isFactVisible(fact, names)) {
            lines.push(`${category}/${key}: (not found)`);
            continue;
        }
        lines.push(buildFactLine(fact, category, nowCtx));
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
        .filter(r => r && r.fact && isActiveFact(r.fact) && isFactVisible(r.fact, names))
        .slice(0, SEARCH_RESULT_CAP);
    if (visible.length === 0) return `(no stored facts matched "${query.slice(0, 80)}")`;
    return formatFactsForWriter(visible);
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

    const rawCategory = String(args?.category || '').trim();
    let category = mapLegacyCategory(rawCategory || 'Unsorted');
    let categoryNote = '';
    if (!effectiveCategories().includes(category)) {
        categoryNote = ` (unknown category "${rawCategory}" — filed to Unsorted)`;
        category = 'Unsorted';
    }

    let key = keyToken(args?.key);
    if (!key) return 'ERROR: write_fact requires a usable snake_case "key"';

    const value = String(args?.value ?? '').trim();
    const note = String(args?.note ?? args?.context ?? '').trim();
    if (!value && !note) return 'ERROR: write_fact requires a non-empty "value" (or "note")';

    const names = currentNames();
    key = resolveGenericKeyPrefix(key, names);

    let knownBy = (Array.isArray(args?.known_by) ? args.known_by : [])
        .map(n => String(n ?? '').trim().replace(/^@/, '').trim())
        .filter(Boolean);
    if (knownBy.length === 0) {
        knownBy = [...new Set([names.charName, names.userName].filter(Boolean))];
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
    const status = !matched ? 'NEW' : (changed ? 'UPDATED' : 'SKIPPED');

    upsertFact(db, fact);
    // Always mark the category dirty when upsertFact ran, so a note-only in-place
    // edit (status SKIPPED) is still persisted to IDB. Set.add is idempotent.
    ctx.touchedCategories.add(category);

    if (changed) {

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
