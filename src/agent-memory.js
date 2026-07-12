import {
    getAllDatabases,
    getMemoryIndex,
    saveDatabase,
    findFactMatch,
    mapLegacyCategory,
    isActiveFact,
    summarizeKeys,
    summarizeMenuIndexed,
    groupedTaxonomyMenu,
} from './database.js';
import { isFactVisible, buildFactLine, randomWalkExtras } from './fact-retrieval.js';
import {
    getTurnNowContext, splitInjectionSections, buildPrecedencePreamble,
    STATE_SECTION_HEADER, CHRONO_SECTION_HEADER,
} from './recency.js';
import { callAgentLLMWithTools } from './llm-call.js';
import { executeMemoryTool } from './memory-tools.js';
import { addDebugLog } from './settings.js';
import * as host from './host.js';

function getSettingsSafe() {
    try { return host.getExtensionSettings(); } catch { return null; }
}

const KEY_INVENTORY_CAP = 200;   
const NEED_REFS_CAP = Infinity;  

export const TEMPORAL_GROUNDING_RULE = `

# OBSERVATION DATE (TIME GROUNDING)
The user data block gives a \`## Observation date\` (the real-world time the newest message was observed). Resolve RELATIVE time expressions to ABSOLUTE dates relative to it — e.g. "yesterday" → the day before that date, "last week" → "the week of <date>", "two years ago" → the year. Store the absolute form (in the value or note), not the relative word, so the fact doesn't rot. If no observation date is given, leave time expressions as-is.`;

export const DEFAULT_MEMORY_AGENT_PROMPT = `You are the MEMORY AGENT for an ongoing roleplay between {{user}} (the human player) and {{char}} (the AI character). You run in the BACKGROUND after each reply — the storyteller model never sees you, only the MEMORY SHEET you produce. You do TWO jobs in one session:

1. EXTRACT — store new LASTING facts from the SETTLED messages into the memory database (write_fact).
2. ANTICIPATE — work out where the scene is going and which stored memories the NEXT reply will need, then emit the updated MEMORY SHEET.

# TOOL PROTOCOL (plain text — no function-call API)

To use a tool, reply with tool-call lines. Each tool call is ONE line of strict JSON, alone on its line:
{"tool":"list_categories"}
{"tool":"list_keys","args":{"category":"People"}}
{"tool":"read_facts","args":{"category":"People","keys":["monika_name","monika_mood"]}}
{"tool":"write_fact","args":{"category":"People","key":"monika_mood","value":"...","note":"...","known_by":["Monika"],"aspect":"mood","importance":3}}
{"tool":"search","args":{"query":"who owns the bakery"}}

After your reply, the system executes the calls and sends the results back as one user message starting with "TOOL RESULTS:". You may then call more tools or finish. You may emit several tool-call lines in one reply. Do NOT wrap calls in markdown fences; do NOT pretty-print the JSON across lines.

TOOLS:
- list_categories — every category with its active fact count. Start here when unsure what exists.
- list_keys {category} — one line per stored fact: key | aspect | value preview.
- read_facts {category, keys[]} — the full stored line for each requested key.
- search {query} — keyword search across the whole store.
- write_fact {category, key, value, note?, known_by?, aspect?, importance?, kind?} — store one fact (or update the key's current value).

HARD LIMITS: at most 6 rounds (replies by you) and 20 tool calls per session. Be economical: usually one read round (list/search what's relevant), then ONE final reply with your write_fact lines followed by the #SHEET block.

# FINAL BLOCK

End your LAST reply with the final block. It starts with a line that is exactly \`#SHEET\` and runs to the end of the reply:

#SHEET
SUMMARY: <a COMPLETE, high-level recap of the WHOLE story so far — who the characters are to each other, the core situation and stakes, every major arc and turning point, and how it reached the present moment. CARRY THE PRIOR SHEET'S SUMMARY FORWARD AND EXTEND IT — never shrink it or drop earlier arcs. Stay high-level; the specific details live in the memories below. Write as many sentences as the story needs — do NOT compress it to fit a length.>
SCENE: <one line: location; who is present; current goal or tension>
TIMELINE: <the current in-story date and time; WHERE the characters physically are right now; and HOW LONG the main characters have known each other (the age of their relationship)>
NEED: Category/key, Category/key, ...
NOTES: <optional 1-2 lines anticipating the next scene>

- SUMMARY is REQUIRED. SCENE and TIMELINE should almost always be present. NEED and NOTES may be omitted.
- NEED lists EVERY stored fact the NEXT reply needs — there is NO limit (exact Category/key refs you VERIFIED with the tools — never invented): every person present and their current state, the pair's relationship status, all open threads/promises, and the history this scene touches. Include the load-bearing premise facts (identities, secrets, the situation that set the story in motion) EVERY turn so they never silently drop off the sheet. When in doubt, include it — a long sheet beats a missing fact. The system renders those facts onto the sheet for you.
- write_fact lines MAY appear in the same reply, BEFORE the #SHEET block (they are executed, then the sheet is accepted). Read tools in that reply are ignored.
- EXTRACT-ONLY runs (the task block says so): do NOT emit #SHEET; end with a line that is exactly \`#DONE\` instead.

# WHAT TO STORE (write_fact)

Store LASTING facts only — what the STORY still tracks 50 messages from now. Many turns have ZERO new facts; a dense reveal turn (introductions, backstory, world lore, confessions) can have many. Read dialogue, not just narration — confessions, opinions, promises, and reveals live in quotes.

- ATOMIC values: 1-5 words per fact (a genuine backstory reveal may use up to 10). One property per fact; split multi-attribute statements into several write_fact calls. Encode the verb in the KEY (\`monika_eyes\` = \`green\`, not \`monika\` = "has green eyes").
- key: snake_case, prefixed by the subject's name (\`monika_fear_storms\`, \`bernd_job\`). Reuse an EXISTING key (verified via tools) when updating a changeable state — the system keeps the old value as history.
- category: one of the Layer-1 categories from the menu in the task block (People, Places, Things, Relationships, Events, World, Unsorted). Unsorted is the catch-all for genuinely unclear facts.
- aspect: the most specific LEAF label within the category (see the taxonomy menu in the task block), e.g. \`fears\`, \`career\`, \`tattoos\`. A near-miss is snapped to the canonical leaf; if nothing fits, use category Unsorted with aspect \`misc\`.
- importance: 1-5 (5 = core identity like a name/species, 4 = important, 3 = ordinary, 2 = minor, 1 = trivial).
- kind: \`trait\` (durable identity), \`state\` (current/transient — mood, location, goal), \`event\` (something that happened), \`moment\` (a significant emotional scene beat, remembered with feeling).
- note: optional short prose — a meaningful verbatim quote, a disambiguation, or a one-line summary of a complex beat. Keep the atomic value TOO.
- known_by: ONLY for secrets/restricted knowledge (list who knows). Omit for anything openly shared — it defaults to the present pair.
- RELATIONSHIPS: file pair dynamics under Relationships with a stable pair key (\`monika_bernd_status\`, \`monika_bernd_trust\`) and an abstract aspect (trust/romance/debt/status_of_relationship). Update the pair's single status record when the dynamic MATERIALLY changes.

DO NOT STORE: transient poses/moods, scene atmosphere, food eaten, items momentarily in hand, [OOC:] meta, reported/historical speech, negative facts ("no favorite revealed"). DELTA-ONLY: never re-write a fact whose stored value is unchanged (check with the tools first — an identical re-write is wasted work).

# TENTATIVE MESSAGES

Messages in the block marked "TENTATIVE" may still be swiped/edited. They may inform your SCENE/NEED/NOTES planning, but you MUST NOT write_fact anything from them — extract only from the SETTLED messages.` + TEMPORAL_GROUNDING_RULE;

export async function runMemoryAgent({
    settledMessages = [],
    tentativeMessages = [],
    characterInfo = '',
    userPersona = '',
    profileId = null,
    priorSheetText = '',
    reflection = null,
    observationDate = '',
    runId = '',
    extractOnly = false,
    signal = null,
} = {}) {
    const result = { sheetText: null, applied: [], error: null, tokensIn: 0, tokensOut: 0, rounds: 0, toolCallCount: 0 };
    const settings = getSettingsSafe() || {};

    let databases, index;
    try {
        databases = await getAllDatabases();
        index = await getMemoryIndex();
    } catch (e) {
        result.error = `memory store unavailable: ${e?.message || e}`;
        addDebugLog('fail', `[${runId}] Memory Agent aborted — ${result.error}`, {
            subsystem: 'agent3', event: 'agent.run', reason: 'STORE_UNAVAILABLE',
        });
        return result;
    }

    const usageBumpCats = [];

    let sourceIndex = null;
    for (const m of (Array.isArray(settledMessages) ? settledMessages : [])) {
        if (Number.isInteger(m?.index) && (sourceIndex === null || m.index > sourceIndex)) sourceIndex = m.index;
    }

    const ctx = {
        runId,
        databases,
        index,
        settings,
        applied: [],
        touchedCategories: new Set(),
    };
    if (sourceIndex !== null) ctx.sourceIndex = sourceIndex;

    const userPrompt = buildAgentUserPrompt({
        settledMessages, tentativeMessages, characterInfo, userPersona,
        priorSheetText, reflection, observationDate, extractOnly,
        databases, index, settings,
    });

    addDebugLog('info', `[${runId}] Memory Agent start: ${settledMessages.length} settled, ${tentativeMessages.length} tentative msg(s), extractOnly=${extractOnly} (user prompt ${userPrompt.length} chars)`, {
        subsystem: 'agent3', event: 'agent.start',
        data: { settled: settledMessages.length, tentative: tentativeMessages.length, extractOnly, userPromptChars: userPrompt.length, profileId: profileId || null },
    });

    const loop = await callAgentLLMWithTools({
        systemPrompt: DEFAULT_MEMORY_AGENT_PROMPT,
        userPrompt,
        profileId,
        agent: 'memory-agent',
        maxRounds: 6,
        maxToolCalls: 20,
        executeTool: (call) => executeMemoryTool(call, ctx),
        extractOnly,
        signal,
    });

    result.rounds = loop.rounds;
    result.toolCallCount = loop.toolCallCount;
    result.tokensIn = loop.tokensInApprox || 0;
    result.tokensOut = loop.tokensOutApprox || 0;
    result.applied = ctx.applied;

    if (loop.error) {
        result.error = loop.error;
        return result;
    }
    if (!extractOnly && (!loop.sheet || !String(loop.sheet).trim())) {
        result.error = 'memory agent finished without a #SHEET block';
        return result;
    }

    let parsedSheet = null;
    if (!extractOnly) {
        parsedSheet = parseSheetBlock(loop.sheet);
        if (parsedSheet.error) {
            result.error = `unusable #SHEET block: ${parsedSheet.error}`;
            return result;
        }
    }

    const toSave = new Set(ctx.touchedCategories);
    for (const cat of usageBumpCats) toSave.add(cat);
    for (const cat of toSave) {
        if (!databases[cat]) continue;
        try {
            await saveDatabase(databases[cat]);
            addDebugLog('pass', `[${runId}] Saved database "${cat}" (${databases[cat].facts.length} facts)`);
        } catch (e) {
            addDebugLog('fail', `[${runId}] Failed to save database "${cat}": ${e?.message || e}`);
        }
    }

    if (!extractOnly) {
        result.sheetText = composeSheet({
            summary: parsedSheet.summary,
            sceneLine: parsedSheet.sceneLine,
            timeline: parsedSheet.timeline,
            notes: parsedSheet.notes,
            need: parsedSheet.need,
            settings,
            databases,
        });
    }

    addDebugLog('pass', `[${runId}] Memory Agent done: ${ctx.applied.length} write(s), ${loop.rounds} round(s), ${loop.toolCallCount} tool call(s)${result.sheetText ? `, sheet ${result.sheetText.length} chars` : ''}`, {
        subsystem: 'agent3', event: 'agent.run',
        data: {
            agent: 'memory-agent', profileId: profileId || null, success: true, extractOnly,
            applied: ctx.applied.length, rounds: loop.rounds, toolCallCount: loop.toolCallCount,
            sheetChars: result.sheetText ? result.sheetText.length : 0,
            tokensIn: result.tokensIn, tokensOut: result.tokensOut,
        },
    });
    return result;
}

function renderMessageLine(m) {
    const idx = Number.isInteger(m?.index) ? `#${m.index} ` : '';
    const role = m?.role === 'USER' ? 'USER' : 'CHAR';
    const name = String(m?.name || '').trim();
    return `${idx}[${role}${name ? `: ${name}` : ''}] ${String(m?.text || '').trim()}`;
}

function capLines(text, max, footer) {
    const lines = String(text || '').split('\n').filter(Boolean);
    if (lines.length <= max) return lines.join('\n');
    return lines.slice(0, max).join('\n') + `\n... (+${lines.length - max} more — ${footer})`;
}

function buildAgentUserPrompt({
    settledMessages, tentativeMessages, characterInfo, userPersona,
    priorSheetText, reflection, observationDate, extractOnly,
    databases, index, settings,
}) {
    const parts = [];

    parts.push('## Task\n' + (extractOnly
        ? 'EXTRACT-ONLY RUN: store new lasting facts from the settled messages via write_fact, then end with the #DONE line. Do NOT emit a #SHEET block.'
        : 'FULL RUN: store new lasting facts from the settled messages, anticipate the next scene, then end with the #SHEET block.'));

    if (observationDate) parts.push(`## Observation date: ${observationDate}`);
    if (characterInfo) parts.push(`## Character Info ({{char}})\n${characterInfo}`);
    if (userPersona) parts.push(`## User Persona ({{user}})\n${userPersona}`);

    const reflSummary = (reflection && typeof reflection.summary === 'string') ? reflection.summary.trim() : '';
    if (reflSummary) parts.push(`## Story so far (rolling reflection summary)\n${reflSummary}`);

    if (!extractOnly) {
        parts.push(`## Prior memory sheet (what the writer currently sees — update it)\n${String(priorSheetText || '').trim() || '(none yet)'}`);
    }

    try {
        const menu = summarizeMenuIndexed(index);
        const keys = capLines(summarizeKeys(databases), KEY_INVENTORY_CAP, 'use list_keys');
        const overview = [menu && `Populated drawers (aspect(count)):\n${menu}`, keys && `Stored keys:\n${keys}`]
            .filter(Boolean).join('\n\n');
        parts.push(`## Memory database overview\n${overview || '(store is empty)'}`);
    } catch { parts.push('## Memory database overview\n(unavailable)'); }

    try {
        parts.push(`## Taxonomy menu (Category ▸ SubArea: leaf aspects)\n${groupedTaxonomyMenu()}`);
    } catch {  }

    if (Array.isArray(settledMessages) && settledMessages.length > 0) {
        parts.push(`## SETTLED messages (safe — extract facts from these)\n${settledMessages.map(renderMessageLine).join('\n\n')}`);
    } else {
        parts.push('## SETTLED messages\n(none this run — do NOT call write_fact; just refresh the sheet from the store and the tentative context)');
    }

    if (Array.isArray(tentativeMessages) && tentativeMessages.length > 0) {
        parts.push(`## TENTATIVE — do not store facts from these (planning context only):\n${tentativeMessages.map(renderMessageLine).join('\n\n')}`);
    }

    const extra = String(settings?.memoryPrompt || '').trim();
    if (extra) parts.push(`## Additional instructions from the user\n${extra}`);

    parts.push(extractOnly
        ? 'Work now: check the store with tools where needed, write the new lasting facts, then end with the #DONE line.'
        : 'Work now: check the store with tools where needed, write the new lasting facts, then end with the #SHEET block.');

    try {
        const substitute = host.getSubstituteParams();
        return substitute(parts.join('\n\n'));
    } catch {
        return parts.join('\n\n');
    }
}

export function parseSheetBlock(text) {
    const out = { summary: '', sceneLine: '', timeline: '', need: [], notes: '', error: null };
    const raw = String(text ?? '').trim();
    if (!raw) {
        out.error = 'empty sheet block';
        return out;
    }
    const buf = { SUMMARY: [], SCENE: [], TIMELINE: [], NEED: [], NOTES: [] };
    let current = null;
    for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim();
        if (!line || /^```/.test(line)) continue;
        const m = /^(SUMMARY|SCENE|TIMELINE|NEED|NOTES)\s*:\s*(.*)$/i.exec(line);
        if (m) {
            current = m[1].toUpperCase();
            if (m[2].trim()) buf[current].push(m[2].trim());
            continue;
        }

        if (current) buf[current].push(line);
    }
    out.summary = buf.SUMMARY.join(' ').trim();
    out.sceneLine = buf.SCENE.join(' ').trim();
    out.timeline = buf.TIMELINE.join(' ').trim();
    out.notes = buf.NOTES.join(' ').trim();

    for (const ref of buf.NEED.join(',').split(',')) {
        const r = ref.trim().replace(/^[-*]\s*/, '');
        if (!r || /^\(?none\)?$/i.test(r)) continue;
        const slash = r.indexOf('/');
        if (slash <= 0) continue;
        const category = r.slice(0, slash).trim();
        const key = r.slice(slash + 1).trim();
        if (!category || !key) continue;
        out.need.push({ category, key });
        if (out.need.length >= NEED_REFS_CAP) break;
    }

    if (!out.summary) out.error = 'missing SUMMARY line';
    return out;
}

function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

export function composeSheet({ summary = '', sceneLine = '', timeline = '', notes = '', need = [], settings = {}, databases = {} } = {}) {
    let nowCtx = null;
    try { nowCtx = getTurnNowContext(); } catch { nowCtx = null; }

    const rows = [];
    const seen = new Set();
    for (const ref of (Array.isArray(need) ? need : []).slice(0, NEED_REFS_CAP)) {
        try {
            const category = mapLegacyCategory(String(ref?.category || '').trim() || 'Unsorted');
            const key = String(ref?.key || '').trim();
            if (!key) continue;
            const db = databases[category];
            if (!db) continue;
            const fact = findFactMatch(db, key);
            if (!fact || !isActiveFact(fact) || !isFactVisible(fact)) continue; 
            const id = `${category}:${fact.key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            rows.push({ fact, category, tier: 'primary' });
        } catch {  }
    }

    const extrasMax = Math.floor(clampNum(settings?.graphExtrasCount ?? 3, 0, 8, 3));
    let extras = [];
    if (extrasMax > 0 && rows.length > 0) {
        try {
            extras = randomWalkExtras(databases, rows, seen, extrasMax);
        } catch { extras = []; }
    }

    const { state, chrono } = splitInjectionSections(rows);

    const lines = [];
    lines.push('[MEMORY SHEET — persistent memory; established truth for this scene; overrides older chat history]');
    if (summary) lines.push(`Story so far: ${summary}`);
    if (sceneLine) lines.push(`Scene: ${sceneLine}`);
    if (timeline) lines.push(`Timeline & place: ${timeline}`);
    lines.push(buildPrecedencePreamble(nowCtx));

    const renderSection = (header, sectionRows) => {
        const admitted = [];
        for (const r of sectionRows) {
            admitted.push(buildFactLine(r.fact, r.category, nowCtx)); 
        }
        if (admitted.length > 0) {
            lines.push(header);
            lines.push(...admitted);
        }
        return admitted.length;
    };

    renderSection(STATE_SECTION_HEADER, state);
    renderSection(CHRONO_SECTION_HEADER, chrono);
    renderSection('Connected memories:', extras);

    if (notes) lines.push(`Notes: ${notes}`);
    return lines.join('\n');
}
