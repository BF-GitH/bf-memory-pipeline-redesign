import { getAllDatabases, upsertFact, saveDatabase, createEmptyDatabase, dedupeDatabase, removeFact, markFactCold, normalizeAspect, L1_CATEGORIES, buildMemoryIndex } from './database.js';
import { tokenSet, keyToken } from './tokenize.js';

const MAX_CONFLICT_PAIRS = 30;
const NEAR_KEY_THRESHOLD = 0.72;

function keyJaccard(a, b) {
    const tok = (s) => tokenSet(s, { min: 1 });
    const A = tok(a), B = tok(b);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
}

function findKeyConflicts(databases) {
    const byKey = new Map();
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (fact.active === false || !fact.key) continue;
            const nk = String(fact.key).toLowerCase().replace(/[^\p{L}\p{N}_]/gu, '_');
            if (!byKey.has(nk)) byKey.set(nk, []);
            byKey.get(nk).push({ category, fact });
        }
    }
    const pairs = [];
    for (const entries of byKey.values()) {
        if (entries.length < 2) continue;
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const va = String(entries[i].fact.value || '').toLowerCase().trim();
                const vb = String(entries[j].fact.value || '').toLowerCase().trim();
                if (va && vb && va !== vb) pairs.push({ a: entries[i], b: entries[j] });
                if (pairs.length >= MAX_CONFLICT_PAIRS) return pairs;
            }
        }
    }
    return pairs;
}

function findNearKeyConflicts(databases, threshold = NEAR_KEY_THRESHOLD) {
    const all = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (fact.active === false || !fact.key) continue;
            all.push({ category, fact });
        }
    }
    const pairs = [];
    for (let i = 0; i < all.length && pairs.length < MAX_CONFLICT_PAIRS; i++) {
        for (let j = i + 1; j < all.length && pairs.length < MAX_CONFLICT_PAIRS; j++) {
            const sim = keyJaccard(all[i].fact.key, all[j].fact.key);
            if (sim < threshold || sim >= 1.0) continue;
            const va = String(all[i].fact.value || '').toLowerCase().trim();
            const vb = String(all[j].fact.value || '').toLowerCase().trim();
            if (!va || !vb || va === vb) continue;
            pairs.push({ a: all[i], b: all[j] });
        }
    }
    return pairs;
}
import { addDebugLog, setReflection, getSummaryPyramid, setSummaryPyramid } from './settings.js';
import { callAgentLLM, callAgentLLMWithTools } from './llm-call.js';
import { executeMemoryTool, REFLECTION_READ_TOOLS } from './memory-tools.js';
import * as host from './host.js';

// Agentic-reflection budget — deliberately tighter than the memory agent's
// 6 rounds / 20 calls: reflection verifies and follows leads, it does not extract.
const REFLECT_MAX_ROUNDS = 5;
const REFLECT_MAX_TOOL_CALLS = 15;

const MAX_FACT_SUMMARY_CHARS = 4000;

const MAX_SUMMARY_CHARS = 4000;

const MAX_OBSERVATIONS = 8;

const MAX_REEVAL_CANDIDATES = 15;

const REEVAL_STALE_STATE_MS = 24 * 60 * 60 * 1000; 

const REEVAL_STALE_STATE_MSGS = 80; 

const MAX_SHELVES_PER_PASS = 6;

const MAX_SHELF_SUMMARY_CHARS = 220;

const MAX_SHELF_SAMPLE_FACTS = 8;

const MAX_MOMENTS_FOR_CALLBACK = 14;
const MAX_CALLBACKS_PER_PASS = 2;

const MAX_CALLBACK_REASON_CHARS = 120;

export const DEFAULT_REFLECT_PROMPT = `You are a periodic memory-maintenance pass for a long roleplay between {{user}} and {{char}}: given a COMPACT digest of stored facts plus READ-ONLY tools (duplicates already merged), surface DURABLE higher-order memory the per-fact extractor misses and maintain short zoom-out summaries.

# TOOL PROTOCOL (plain text — no function-call API)

Each tool call is ONE line of strict JSON, alone on its line:
{"tool":"list_categories"}
{"tool":"list_keys","args":{"category":"People"}}
{"tool":"read_facts","args":{"category":"People","keys":["monika_job"]}}
{"tool":"search","args":{"query":"bakery owner"}}

The system replies with "TOOL RESULTS:"; then call more tools or finish. Several lines per reply are fine; no markdown fences, no multi-line JSON. READ-ONLY — no write tools; conclusions travel only through the final sections; the system applies them.

HARD LIMITS: 5 rounds, 15 tool calls. Be economical, but never assert a verdict you could have verified and didn't.

The digest is truncated STARTING material. VERIFY candidates via the tools (read_facts the FULL record behind keys you build on; list_keys thin categories; search unseen subjects); FOLLOW LEADS that could change a verdict; stop when reads stop changing conclusions; drop unsupported candidates. Final sections ONLY in your LAST reply:

#OBS — 0-5 durable behavioral/relational PATTERNS inferred ACROSS the material, not already stored as one fact (e.g. "<SUBJECT> distrusts authority"); one atomic clause each; none is fine. Also: if a real pair's \`<a>_<b>_status\` record is MISSING or CONTRADICTED, ONE observation under that exact lowercased key, value = current attitude in 1-4 words; counts against the cap.

#STORY — whole-story recap, 2-4 short sentences, max 1200 chars, factual. Given "## Prior story summary": UPDATE it — fold in only the NEW, drop nothing still true, never regenerate or lengthen — output the COMPLETE replacement.

#SHELVES — given "## Shelves to summarize": ONE line per listed shelf (a Category/aspect bucket), max 25 words, SHORTER than its raw facts, abstract, never enumerate. "prev:" = its prior summary — update, don't regenerate.

#CALLBACK — from "## Recent moments" (beats with ids): 0-2 links, a NEW beat unmistakably ECHOING an EARLIER one (earlier id <- later id, one-clause reason); only listed ids; most passes name none.

#REEVAL — ONE verdict per bracketed id in "## Re-evaluate"; read the subject's other facts first: promote = real lasting fact, give Layer-1 category (People/Places/Things/Relationships/Events/World) + most-specific aspect; drop = one-off/untrue/noise (deprioritized, not erased); keep = still uncertain (default).

# OUTPUT FORMAT (end your LAST reply with this)

#STORY
<recap, or ".">
.
#SHELVES
+ <Category>/<aspect> = <short bucket summary>
.
#OBS
+ <subject>_<short_pattern_key> = <atomic pattern clause>
.
#CALLBACK
+ <earlier_id> <- <later_id> | <short reason>
.
#REEVAL
+ <id> = promote | <Category> | <aspect>
+ <id> = drop
+ <id> = keep
.
#DONE

Put a single "." under any empty section. Observation keys snake_case, values max 10 words. Echo the shelves list's EXACT Category/aspect labels. Never invent facts unsupported by digest or tool results.`;

function collectReevalCandidates(databases) {
    const now = Date.now();

    let chatLen = null;
    try {
        const chat = host.getChat();
        if (Array.isArray(chat)) chatLen = chat.length;
    } catch {  }
    const out = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || fact.active === false || fact.track) continue; 
            const aspect = String(fact.aspect || '').toLowerCase();
            const kind = String(fact.kind || '').toLowerCase();
            const isMisc = category === 'Unsorted' || aspect === 'misc';
            const lastUpdated = Number(fact.lastUpdated) || 0;

            const wallClockStale = kind === 'state' && lastUpdated > 0 && (now - lastUpdated) >= REEVAL_STALE_STATE_MS;
            const validAt = Number.isInteger(fact.validAt) ? fact.validAt : null;
            const inStoryStale = chatLen !== null && validAt !== null && (chatLen - validAt) >= REEVAL_STALE_STATE_MSGS;
            const isStaleState = wallClockStale && inStoryStale;
            if (isMisc || isStaleState) {
                out.push({ id: `${category}::${fact.key}`, category, key: fact.key, fact });
            }
        }
    }

    out.sort((a, b) => (Number(a.fact.lastUpdated) || 0) - (Number(b.fact.lastUpdated) || 0));
    return out.slice(0, MAX_REEVAL_CANDIDATES);
}

function collectRecentMoments(databases) {
    const out = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || fact.active === false || fact.track) continue; 
            if (String(fact.kind || '').toLowerCase() !== 'moment') continue;
            out.push({ id: `${category}::${fact.key}`, category, key: fact.key, fact });
        }
    }

    out.sort((a, b) => {
        const av = Number.isInteger(a.fact.validAt) ? a.fact.validAt : -1;
        const bv = Number.isInteger(b.fact.validAt) ? b.fact.validAt : -1;
        if (av !== bv) return bv - av;
        return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
    });
    return out.slice(0, MAX_MOMENTS_FOR_CALLBACK);
}

function pickChangedShelves(index, priorPyramid) {
    const priorShelves = (priorPyramid && priorPyramid.shelves) || {};
    const candidates = [];

    for (const [category, aspectMap] of (index.aspectCounts || new Map())) {
        for (const [aspect, count] of aspectMap) {
            if (!count) continue; 
            const catLower = String(category).toLowerCase();
            const bucketKey = `${catLower}||${aspect}`;
            const prev = priorShelves[bucketKey];
            const prevCount = prev ? (Number(prev.factCount) || 0) : 0;

            if (prev && prevCount === count) continue; 

            const entries = (index.byCatAspect.get(bucketKey) || []);
            const samples = entries
                .map(e => e.fact)
                .filter(f => f && f.value != null)
                .sort((a, b) => (Number(b.lastUpdated) || 0) - (Number(a.lastUpdated) || 0))
                .slice(0, MAX_SHELF_SAMPLE_FACTS)
                .map(f => `${f.key} = ${String(f.value).slice(0, 120)}`);

            candidates.push({ bucketKey, category, aspect, factCount: count, prevCount, prevText: (prev && typeof prev.text === 'string') ? prev.text : '', samples });
        }
    }

    candidates.sort((a, b) => Math.abs(b.factCount - b.prevCount) - Math.abs(a.factCount - a.prevCount));
    return candidates.slice(0, MAX_SHELVES_PER_PASS);
}

function buildReflectInput({ databases, reevalCandidates = [], changedShelves = [], recentMoments = [], priorStory = '' }) {
    const parts = [];

    if (typeof priorStory === 'string' && priorStory.trim()) {
        parts.push(`## Prior story summary (update this; do not restate unchanged parts at greater length)\n${priorStory.trim()}`);
    }

    const factLines = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (fact.active === false) continue; 
            factLines.push(`${category}/${fact.key} = ${fact.value}`);
        }
    }
    let factSummary = factLines.join('\n');
    if (factSummary.length > MAX_FACT_SUMMARY_CHARS) {
        factSummary = factSummary.slice(0, MAX_FACT_SUMMARY_CHARS) + '\n…(truncated)';
    }
    if (factSummary) parts.push(`## Stored facts (current)\n${factSummary}`);

    if (Array.isArray(changedShelves) && changedShelves.length) {
        const shelfLines = changedShelves.map(s => {
            const sample = s.samples && s.samples.length ? `\n    ${s.samples.join('\n    ')}` : '';

            const prev = (typeof s.prevText === 'string' && s.prevText.trim()) ? `\n    prev: ${s.prevText.trim()}` : '';
            return `+ ${s.category}/${s.aspect} (${s.factCount} fact${s.factCount === 1 ? '' : 's'})${sample}${prev}`;
        });
        parts.push(`## Shelves to summarize (one short summary per shelf, echo the exact Category/aspect label)\n${shelfLines.join('\n')}`);
    }

    if (Array.isArray(recentMoments) && recentMoments.length) {
        const mLines = recentMoments.map(c => {
            const f = c.fact;
            const note = (typeof f.context === 'string' && f.context.trim()) ? f.context.trim() : String(f.value ?? '').trim();
            const tone = (typeof f.tone === 'string' && f.tone.trim()) ? ` (${f.tone.trim()})` : '';
            return `[${c.id}] ${note.slice(0, 140)}${tone}`;
        });
        parts.push(`## Recent moments (name 0-2 #CALLBACK echo-links between these by exact id; newest first)\n${mLines.join('\n')}`);
    }

    if (Array.isArray(reevalCandidates) && reevalCandidates.length) {
        const reLines = reevalCandidates.map(c => {
            const f = c.fact;
            const val = String(f.value ?? '').trim();
            const note = (typeof f.context === 'string' && f.context.trim()) ? ` >${f.context.trim()}` : '';
            const body = val ? ` = ${val}` : '';
            return `[${c.id}] ${c.category}/${c.key}${body}${note}`;
        });
        parts.push(`## Re-evaluate (give a verdict per id)\n${reLines.join('\n')}`);
    }

    // Terse reminder only — the rules live in the system prompt (one place).
    parts.push('\nVerify against the real store with the read tools, then END your LAST reply with the #STORY/#SHELVES/#OBS/#CALLBACK/#REEVAL sections and a line that is exactly #DONE.');
    return parts.join('\n\n');
}

function parseReflectResult(response) {
    const out = { summary: '', shelves: [], observations: [], callbacks: [], reevals: [] };
    if (!response || !response.trim()) return out;

    let text = response.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*/g, '').trim()).replace(/```/g, '');

    const storyMatch = text.match(/#STORY\s*([\s\S]*?)(?=\n\s*#(?:SHELVES|OBS|CALLBACK|THREADS|REEVAL)\b|$)/i);
    if (storyMatch) {
        let s = storyMatch[1].trim();

        s = s.replace(/\n?\s*\.\s*$/, '').trim();
        if (s === '.' || /^\(none\)$/i.test(s)) s = '';
        if (s.length > MAX_SUMMARY_CHARS) s = s.slice(0, MAX_SUMMARY_CHARS).trimEnd() + '…';
        out.summary = s;
    }

    const shelvesMatch = text.match(/#SHELVES\s*([\s\S]*?)(?=\n\s*#(?:OBS|CALLBACK|THREADS|REEVAL)\b|$)/i);
    if (shelvesMatch) {
        const block = shelvesMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const eqIdx = line.indexOf('=');
                if (eqIdx < 0) continue;
                let label = line.slice(0, eqIdx).trim();

                label = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
                const slashIdx = label.indexOf('/');
                if (slashIdx < 0) continue; 
                const category = label.slice(0, slashIdx).trim();
                const aspect = label.slice(slashIdx + 1).trim().toLowerCase();
                let value = line.slice(eqIdx + 1).trim();
                if (!category || !aspect || !value) continue;
                if (value.length > MAX_SHELF_SUMMARY_CHARS) value = value.slice(0, MAX_SHELF_SUMMARY_CHARS).trimEnd() + '…';
                out.shelves.push({ category, aspect, text: value });
                if (out.shelves.length >= MAX_SHELVES_PER_PASS) break;
            }
        }
    }

    const obsMatch = text.match(/#OBS\s*([\s\S]*?)(?=\n\s*#CALLBACK|\n\s*#REEVAL|$)/i);
    if (obsMatch) {
        const block = obsMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const eqIdx = line.indexOf('=');
                if (eqIdx < 0) continue;
                let key = line.slice(0, eqIdx).trim();

                const slashIdx = key.indexOf('/');
                if (slashIdx >= 0) key = key.slice(slashIdx + 1).trim();
                key = keyToken(key); 
                const value = line.slice(eqIdx + 1).trim();
                if (!key || !value) continue;
                out.observations.push({ key, value });
                if (out.observations.length >= MAX_OBSERVATIONS) break;
            }
        }
    }

    const cbMatch = text.match(/#CALLBACK\s*([\s\S]*?)(?=\n\s*#REEVAL|$)/i);
    if (cbMatch) {
        const block = cbMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();

                let reason = '';
                const barIdx = line.indexOf('|');
                if (barIdx >= 0) { reason = line.slice(barIdx + 1).trim(); line = line.slice(0, barIdx).trim(); }

                const m = line.split(/\s*(?:<\-{1,2}|<=|⟵|\becho(?:e?s)?\b|\bfrom\b)\s*/i);
                if (!m || m.length < 2) continue;
                const earlierId = (m[0] || '').trim().replace(/^\[|\]$/g, '').trim();
                const laterId = (m[1] || '').trim().replace(/^\[|\]$/g, '').trim();
                if (!earlierId || !laterId || earlierId === laterId) continue;
                if (reason.length > MAX_CALLBACK_REASON_CHARS) reason = reason.slice(0, MAX_CALLBACK_REASON_CHARS).trimEnd() + '…';
                out.callbacks.push({ earlierId, laterId, reason });
                if (out.callbacks.length >= MAX_CALLBACKS_PER_PASS) break;
            }
        }
    }

    const reMatch = text.match(/#REEVAL\s*([\s\S]*?)$/i);
    if (reMatch) {
        const block = reMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const eqIdx = line.indexOf('=');
                if (eqIdx < 0) continue;

                let id = line.slice(0, eqIdx).trim().replace(/^\[|\]$/g, '').trim();
                const verdictPart = line.slice(eqIdx + 1).trim();
                const segs = verdictPart.split('|').map(s => s.trim()).filter(Boolean);
                const verdict = (segs[0] || '').toLowerCase();
                if (!id || !verdict) continue;
                if (verdict.startsWith('promote')) {
                    out.reevals.push({ id, verdict: 'promote', category: segs[1] || '', aspect: (segs[2] || '').toLowerCase() });
                } else if (verdict.startsWith('drop')) {
                    out.reevals.push({ id, verdict: 'drop' });
                } else {
                    out.reevals.push({ id, verdict: 'keep' });
                }
            }
        }
    }
    return out;
}

function deriveSubjectFromObsKey(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return '';
    const us = k.indexOf('_');
    return us > 0 ? k.slice(0, us) : k;
}

export async function runReflection({ runId = '', prevReflection = null, characterInfo = '', userPersona = '', profileId = null } = {}) {
    try {
        const databases = await getAllDatabases();

        const totalFacts = Object.values(databases).reduce((n, db) => n + (db.facts?.length || 0), 0);
        if (totalFacts === 0) {
            addDebugLog('info', `[${runId}] Reflection skipped (nothing to consolidate)`);
            return { summary: '', observations: [], merged: 0, rounds: 0, toolCallCount: 0, tokensIn: 0, tokensOut: 0 };
        }

        let totalMerged = 0;
        for (const [category, db] of Object.entries(databases)) {
            try {
                const { db: cleaned, merged } = dedupeDatabase(db);
                if (merged > 0) {
                    databases[category] = cleaned;
                    await saveDatabase(cleaned);
                    totalMerged += merged;
                    addDebugLog('info', `[${runId}] Dedupe-janitor: merged ${merged} duplicate fact(s) in ${category}`);
                }
            } catch (err) {
                addDebugLog('fail', `[${runId}] Dedupe-janitor failed for ${category} (non-fatal): ${err.message || err}`);
            }
        }
        if (totalMerged > 0) addDebugLog('pass', `[${runId}] Dedupe-janitor merged ${totalMerged} duplicate fact(s) total`);

        try {
            const cfgScan = host.getExtensionSettings();
            if (cfgScan?.contradictionScanEnabled !== false) {
                const interval = Math.max(1, Number(cfgScan?.contradictionInterval) || 3);
                const chatMeta = SillyTavern.getContext().chatMetadata;
                let reflectRuns = 1;
                if (chatMeta) {
                    chatMeta.bf_mem_reflect_runs = (chatMeta.bf_mem_reflect_runs || 0) + 1;
                    reflectRuns = chatMeta.bf_mem_reflect_runs;
                }
                if (reflectRuns % interval === 0) {
                    const seen = new Set();
                    const pairs = [...findKeyConflicts(databases), ...findNearKeyConflicts(databases)]
                        .filter(p => {
                            const id = [`${p.a.category}:${p.a.fact.key}`, `${p.b.category}:${p.b.fact.key}`].sort().join('|');
                            if (seen.has(id)) return false;
                            seen.add(id);
                            return true;
                        })
                        .slice(0, MAX_CONFLICT_PAIRS);

                    if (pairs.length > 0) addDebugLog('info', `[${runId}] Contradiction scan detected ${pairs.length} conflict(s) (logged only — review popup removed)`);
                }
            }
        } catch (err) {
            addDebugLog('fail', `[${runId}] Contradiction scan failed (non-fatal): ${err.message || err}`);
        }

        const settings = host.getExtensionSettings();
        const substitute = host.getSubstituteParams();

        const systemPrompt = substitute(settings?.reflectionPrompt || DEFAULT_REFLECT_PROMPT);

        const reevalCandidates = collectReevalCandidates(databases);
        const reevalById = new Map(reevalCandidates.map(c => [c.id, c]));

        const recentMoments = collectRecentMoments(databases);
        const momentById = new Map(recentMoments.map(c => [c.id, c]));

        const priorPyramid = (() => { try { return getSummaryPyramid(); } catch { return null; } })();
        let index = null;
        try { index = buildMemoryIndex(databases); } catch { index = null; }
        const changedShelves = index ? pickChangedShelves(index, priorPyramid) : [];
        if (changedShelves.length) {
            addDebugLog('info', `[${runId}] Summary pyramid: ${changedShelves.length} changed shelf(s) queued for summary (cap ${MAX_SHELVES_PER_PASS}): ${changedShelves.map(s => `${s.category}/${s.aspect}`).join(', ')}`, {
                subsystem: 'reflection', event: 'summary.shelves',
                data: { queued: changedShelves.length, cap: MAX_SHELVES_PER_PASS, buckets: changedShelves.map(s => s.bucketKey) },
            });
        }

        const dataParts = [];
        if (characterInfo) dataParts.push(`## Character Info ({{char}})\n${characterInfo}`);
        if (userPersona) dataParts.push(`## User Persona ({{user}})\n${userPersona}`);
        dataParts.push(buildReflectInput({ databases, reevalCandidates, changedShelves, recentMoments, priorStory: (priorPyramid && priorPyramid.story) || '' }));
        const userPrompt = substitute(dataParts.join('\n\n'));

        addDebugLog('info', `[${runId}] Reflection pass: system=${systemPrompt.length}, user=${userPrompt.length} chars (tool loop, max ${REFLECT_MAX_ROUNDS} rounds / ${REFLECT_MAX_TOOL_CALLS} tool calls)`);

        // Read-only tool context over the same in-memory store the writes below
        // mutate. The executor REJECTS every non-read tool — reflection's writes
        // go exclusively through the parsed #OBS/#CALLBACK/#REEVAL/#SHELVES
        // pipeline further down, never through the tool channel.
        const toolCtx = {
            runId,
            databases,
            index,
            settings,
            applied: [],
            touchedCategories: new Set(),
            // The digest above lists ALL active facts with no knownBy filter, so
            // the read tools must not apply current-scene visibility gating —
            // otherwise a fact known only to an absent NPC shows in the digest
            // but reads back "(not found)", corrupting PROMOTE/DROP verdicts.
            bypassVisibility: true,
        };
        const executeReadOnlyTool = (call) => {
            const tool = String(call?.tool || '');
            if (!REFLECTION_READ_TOOLS.includes(tool)) {
                return `ERROR: tool "${tool}" is not available to reflection — this pass is READ-ONLY (allowed: ${REFLECTION_READ_TOOLS.join(', ')}). Deliver conclusions through the final #OBS/#REEVAL sections instead.`;
            }
            return executeMemoryTool(call, toolCtx);
        };

        // extractOnly makes the loop's final token #DONE — the #STORY..#REEVAL
        // sections ride in the same (last) reply, above that token.
        const loop = await callAgentLLMWithTools({
            systemPrompt,
            userPrompt,
            profileId,
            agent: 'reflection',
            agentTag: 'reflection',
            maxRounds: REFLECT_MAX_ROUNDS,
            maxToolCalls: REFLECT_MAX_TOOL_CALLS,
            executeTool: executeReadOnlyTool,
            extractOnly: true,
            // Grace-round example must be a tool this READ-ONLY pass accepts —
            // the default write_fact example would steer a confused model into
            // a guaranteed rejection.
            protocolExample: '{"tool":"read_facts","args":{"category":"People","keys":["x_name"]}}',
        });
        let tokensIn = loop.tokensInApprox || 0;
        let tokensOut = loop.tokensOutApprox || 0;
        const rounds = loop.rounds || 0;
        const toolCallCount = loop.toolCallCount || 0;

        // The final sections travel in the reply that carried the #DONE token —
        // take the last non-empty reply from the loop transcript.
        let resultStr = '';
        for (let i = (loop.transcript || []).length - 1; i >= 0; i--) {
            const r = String(loop.transcript[i]?.reply || '');
            if (r.trim()) { resultStr = r; break; }
        }

        if (loop.error) {
            addDebugLog('fail', `[${runId}] Reflection tool loop failed: ${loop.error} (${rounds} round(s), ${toolCallCount} tool call(s))`, {
                subsystem: 'reflection', event: 'reflection.toolloop', reason: 'LOOP_ERROR',
                data: { rounds, toolCallCount, error: loop.error },
            });
            return { summary: '', observations: [], merged: totalMerged, rounds, toolCallCount, tokensIn, tokensOut, error: loop.error };
        }

        addDebugLog('info', `[${runId}] Reflection tool loop done: ${rounds} round(s), ${toolCallCount} tool call(s); final reply (${resultStr.length} chars):\n${resultStr}`, {
            subsystem: 'reflection', event: 'reflection.toolloop',
            data: { rounds, toolCallCount, tools: (loop.transcript || []).flatMap(t => t.toolCalls || []) },
        });

        const parsed = parseReflectResult(resultStr);

        try {
            if (settings?.reflectionCompressionGuard !== false && changedShelves.length && (parsed.shelves || []).length) {
                const queuedByKey = new Map(changedShelves.map(s => [s.bucketKey, s]));
                const shelfInputLen = (queued) => (queued.samples || []).join('\n').length;
                const failing = [];
                for (const sh of parsed.shelves) {
                    const bucketKey = `${String(sh.category).toLowerCase()}||${String(sh.aspect).toLowerCase()}`;
                    const queued = queuedByKey.get(bucketKey);
                    if (!queued) continue; 
                    const inputLen = shelfInputLen(queued);
                    if (inputLen > 0 && String(sh.text || '').length >= inputLen) failing.push(bucketKey);
                }
                if (failing.length) {
                    addDebugLog('info', `[${runId}] Compression guard tripped: ${failing.length} shelf summary(ies) not shorter than their source facts — retrying once`, {
                        subsystem: 'reflection', event: 'summary.compression_guard', reason: 'NOT_SMALLER',
                        data: { failing, queued: changedShelves.length },
                    });
                    // Repair stays SINGLE-SHOT even though the main pass is a tool
                    // loop: the investigation already happened, so the loop's final
                    // text rides along as context and tools are explicitly off.
                    const repairUserPrompt = userPrompt
                        + `\n\n## Your previous final sections (rework these)\n${resultStr}`
                        + '\n\nYour #SHELVES summaries were not shorter than the source facts. Do NOT call any tools now — re-emit the COMPLETE final sections (#STORY/#SHELVES/#OBS/#CALLBACK/#REEVAL), rewriting the SAME source memories more abstractly instead of adding detail; do not introduce new facts. End with a line that is exactly #DONE.';
                    const retryStr = await callAgentLLM(systemPrompt, repairUserPrompt, profileId, 'reflection');
                    tokensIn += await host.getTokenCount(systemPrompt + '\n' + repairUserPrompt);
                    tokensOut += await host.getTokenCount(retryStr);
                    const reparsed = parseReflectResult(retryStr);
                    const retryByKey = new Map((reparsed.shelves || []).map(sh => [`${String(sh.category).toLowerCase()}||${String(sh.aspect).toLowerCase()}`, sh]));
                    const failingSet = new Set(failing);

                    const accepted = [];
                    let stillFailing = 0;
                    for (const bucketKey of failing) {
                        const retrySh = retryByKey.get(bucketKey);
                        const queued = queuedByKey.get(bucketKey);
                        if (retrySh && queued && String(retrySh.text || '').length < shelfInputLen(queued)) {
                            accepted.push(retrySh);
                        } else {
                            stillFailing++;
                        }
                    }
                    parsed.shelves = parsed.shelves
                        .filter(sh => !failingSet.has(`${String(sh.category).toLowerCase()}||${String(sh.aspect).toLowerCase()}`))
                        .concat(accepted);
                    addDebugLog(stillFailing ? 'info' : 'pass', `[${runId}] Compression guard retry: ${accepted.length} shelf(s) repaired, ${stillFailing} still too long (prior summary kept)`, {
                        subsystem: 'reflection', event: 'summary.compression_guard', reason: stillFailing ? 'RETRY_PARTIAL' : 'RETRY_OK',
                        data: { repaired: accepted.length, stillFailing },
                    });
                }
            }
        } catch (err) {
            addDebugLog('fail', `[${runId}] Compression guard failed (non-fatal): ${err.message || err}`, {
                subsystem: 'reflection', event: 'summary.compression_guard', reason: 'ERROR',
            });
        }

        if (parsed.summary || parsed.observations.length > 0) {
            setReflection({ summary: parsed.summary, observations: parsed.observations.map(o => o.value) }, runId);
        }

        try {
            const changedByKey = new Map(changedShelves.map(s => [`${s.category.toLowerCase()}||${s.aspect}`, s]));
            const mergedShelves = { ...((priorPyramid && priorPyramid.shelves) || {}) };
            let refreshed = 0;
            for (const sh of (parsed.shelves || [])) {
                const bucketKey = `${String(sh.category).toLowerCase()}||${String(sh.aspect).toLowerCase()}`;

                const queued = changedByKey.get(bucketKey);
                if (!queued) continue; 
                mergedShelves[bucketKey] = { text: sh.text, factCount: queued.factCount, updatedAt: Date.now() };
                refreshed++;
            }
            const storyForPyramid = parsed.summary || (priorPyramid && priorPyramid.story) || '';
            if (storyForPyramid || Object.keys(mergedShelves).length > 0) {
                setSummaryPyramid({ story: storyForPyramid, shelves: mergedShelves }, runId);
            }
            if (refreshed > 0) {
                addDebugLog('info', `[${runId}] Summary pyramid: refreshed ${refreshed} shelf summary(ies); ${Object.keys(mergedShelves).length} shelf(s) stored total`, {
                    subsystem: 'reflection', event: 'summary.shelves',
                    data: { refreshed, totalStored: Object.keys(mergedShelves).length, buckets: parsed.shelves.map(s => `${s.category}/${s.aspect}`) },
                });
            }
        } catch (err) {
            addDebugLog('fail', `[${runId}] Summary pyramid update failed (non-fatal): ${err.message || err}`, {
                subsystem: 'reflection', event: 'summary.shelves', reason: 'ERROR',
            });
        }

        let written = 0;
        if (parsed.observations.length > 0) {

            const charName = host.getCurrentCharacterName();
            const savedCategories = new Set();
            for (const obs of parsed.observations) {
                const pairMatch = /^([a-z0-9]+)_([a-z0-9]+)_status$/.exec(String(obs.key || '').trim().toLowerCase());
                const isPairStatus = !!(pairMatch && pairMatch[1] !== pairMatch[2]);
                const category = isPairStatus ? 'Relationships' : 'People';
                const aspect = normalizeAspect(isPairStatus ? 'status_of_relationship' : 'habits', category);
                if (!databases[category]) databases[category] = createEmptyDatabase(category);
                upsertFact(databases[category], {
                    key: obs.key,
                    value: obs.value,
                    aspect,
                    subject: isPairStatus ? pairMatch[1] : deriveSubjectFromObsKey(obs.key),
                    ...(isPairStatus ? { involved: [pairMatch[2]] } : {}),
                    tags: ['observation', 'reflection'],
                    knownBy: charName ? [charName] : [],
                    relationships: { primary: [], secondary: [], tertiary: [] },
                    source: `reflection_${runId}`,
                    importance: 4,
                    kind: isPairStatus ? 'state' : 'trait',
                });
                savedCategories.add(category);
                written++;
            }
            for (const category of savedCategories) {
                try {
                    await saveDatabase(databases[category]);
                } catch (err) {
                    addDebugLog('fail', `[${runId}] Reflection failed to save observations to "${category}": ${err.message || err}`);
                }
            }
            addDebugLog('pass', `[${runId}] Reflection wrote ${written} observation(s) (${[...savedCategories].join(', ')})`);
        }

        let callbacksWritten = 0;
        const callbackModified = new Set();
        for (const cb of (parsed.callbacks || [])) {
            const earlier = momentById.get(cb.earlierId);
            const later = momentById.get(cb.laterId);
            if (!earlier || !later) continue; 
            if (earlier.fact === later.fact) continue; 
            const fact = earlier.fact;
            if (!Array.isArray(fact.callbacks)) fact.callbacks = [];

            if (fact.callbacks.some(c => c && c.toKey === later.key && c.toCategory === later.category)) continue;
            fact.callbacks.push({ toCategory: later.category, toKey: later.key, reason: cb.reason || '', at: Date.now() });
            callbackModified.add(earlier.category);
            callbacksWritten++;
            addDebugLog('info', `[${runId}] Reflection callback-link: [${earlier.category}] ${earlier.key} <- [${later.category}] ${later.key}${cb.reason ? ` | ${cb.reason}` : ''}`, {
                subsystem: 'reflection', event: 'callback.linked', reason: 'ECHO',
                data: { fromCategory: earlier.category, fromKey: earlier.key, toCategory: later.category, toKey: later.key, reason: cb.reason || '' },
            });
        }
        for (const category of callbackModified) {
            try { await saveDatabase(databases[category]); }
            catch (err) { addDebugLog('fail', `[${runId}] Callback-link failed to save "${category}": ${err.message || err}`); }
        }
        if (callbacksWritten > 0) {
            addDebugLog('pass', `[${runId}] Reflection authored ${callbacksWritten} callback-link(s) (cap ${MAX_CALLBACKS_PER_PASS}, from ${recentMoments.length} recent moment(s))`);
        }

        let promoted = 0, dropped = 0;
        const reevalModified = new Set();
        for (const v of (parsed.reevals || [])) {
            const cand = reevalById.get(v.id);
            if (!cand) continue; 
            const fromDb = databases[cand.category];
            if (!fromDb) continue;
            const fact = (fromDb.facts || []).find(f => f.key === cand.key && f.active !== false);
            if (!fact) continue; 

            if (v.verdict === 'drop') {

                const newlyCold = markFactCold(fact, cand.category, 'REEVAL_DROP', 'reflection judged one-off');
                reevalModified.add(cand.category);
                dropped++;
                addDebugLog('info', `[${runId}] Re-eval DROP→cold-tier: [${cand.category}] ${cand.key} = "${String(fact.value ?? '').slice(0, 60)}"`, {
                    subsystem: 'reflection', event: 'fact.demoted', reason: 'REEVAL_DROP',
                    data: { category: cand.category, key: cand.key, newlyCold },
                });
                continue;
            }

            if (v.verdict === 'promote') {
                const newCat = L1_CATEGORIES.includes(v.category) ? v.category : cand.category;
                const newAspect = normalizeAspect(v.aspect, newCat);

                const moved = {
                    ...fact,
                    category: newCat,
                    aspect: newAspect,
                    kind: 'trait',
                    importance: Math.max(3, Number(fact.importance) || 0),
                    source: `reflection_reeval_${runId}`,
                };
                delete moved.lastUpdated; 
                if (newCat !== cand.category) {
                    if (!databases[newCat]) databases[newCat] = createEmptyDatabase(newCat);
                    upsertFact(databases[newCat], moved);
                    removeFact(fromDb, cand.key);
                    reevalModified.add(cand.category);
                    reevalModified.add(newCat);
                } else {
                    upsertFact(fromDb, moved);
                    reevalModified.add(cand.category);
                }
                promoted++;
                addDebugLog('info', `[${runId}] Re-eval PROMOTE: [${cand.category}] ${cand.key} → ${newCat}/${newAspect}`, {
                    subsystem: 'db', event: 'fact.reeval_promoted', reason: 'CONFIRMED_LASTING',
                    data: { fromCategory: cand.category, toCategory: newCat, key: cand.key, aspect: newAspect },
                });
            }
        }
        for (const category of reevalModified) {
            try { await saveDatabase(databases[category]); }
            catch (err) { addDebugLog('fail', `[${runId}] Re-eval failed to save "${category}": ${err.message || err}`); }
        }
        if (promoted || dropped) {
            addDebugLog('pass', `[${runId}] Re-evaluation: promoted ${promoted}, dropped ${dropped} (from ${reevalCandidates.length} candidate(s))`);
        }

        addDebugLog('info', `[${runId}] Reflection done: merged=${totalMerged}, summary=${parsed.summary ? parsed.summary.length + ' chars' : 'none'}, observations=${written}, callbacks=${callbacksWritten}, reeval(+${promoted}/-${dropped}), rounds=${rounds}, toolCalls=${toolCallCount}`, {
            subsystem: 'reflection', event: 'reflection.done',
            data: { merged: totalMerged, observations: written, callbacks: callbacksWritten, promoted, dropped, rounds, toolCallCount },
        });
        return { summary: parsed.summary, observations: parsed.observations, written, merged: totalMerged, callbacks: callbacksWritten, promoted, dropped, rounds, toolCallCount, tokensIn, tokensOut };
    } catch (error) {
        addDebugLog('fail', `Reflection error (non-fatal): ${error.message || error}`);
        return { summary: '', observations: [], rounds: 0, toolCallCount: 0, tokensIn: 0, tokensOut: 0, error: error.message || String(error) };
    }
}
