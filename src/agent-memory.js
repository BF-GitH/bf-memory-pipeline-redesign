import {
    getAllDatabases,
    getMemoryIndex,
    saveDatabase,
    findFactMatch,
    mapLegacyCategory,
    isActiveFact,
    clampImportance,
    summarizeKeys,
    summarizeMenuIndexed,
    groupedTaxonomyMenu,
} from './database.js';
import { isFactVisible, buildFactLine, randomWalkExtras } from './fact-retrieval.js';
import {
    getTurnNowContext, splitInjectionSections, buildPrecedencePreamble,
    STATE_SECTION_HEADER, CHRONO_SECTION_HEADER,
} from './recency.js';
import { callAgentLLMWithTools, callAgentLLM } from './llm-call.js';
import { executeMemoryTool } from './memory-tools.js';
import { getStorySpine, getCurrentScene, startScene, appendSceneBeats, setScenePresent, getScenePresent, getSceneTimeline, setSceneTimeline } from './turn-state.js';
import { addDebugLog } from './settings.js';
import * as host from './host.js';

function getSettingsSafe() {
    try { return host.getExtensionSettings(); } catch { return null; }
}

function currentChatIdSafe() {
    try {
        const c = host.getCtx();
        return String(c?.getCurrentChatId?.() || c?.chatId || '');
    } catch { return ''; }
}

const KEY_INVENTORY_CAP = 200;

const TEMPORAL_GROUNDING_RULE = `

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
{"tool":"add_alias","args":{"name":"Trish","alias":"Trish Mitchells"}}

After your reply, the system executes the calls and sends the results back as one user message starting with "TOOL RESULTS:". You may then call more tools or finish. You may emit several tool-call lines in one reply. Do NOT wrap calls in markdown fences; do NOT pretty-print the JSON across lines.

TOOLS:
- list_categories — every category with its active fact count. Start here when unsure what exists.
- list_keys {category} — one line per stored fact: key | aspect | value preview.
- read_facts {category, keys[]} — the full stored line for each requested key.
- search {query} — keyword search across the whole store.
- write_fact {category, key, value, note?, known_by?, aspect?, importance?, kind?} — store one fact (or update the key's current value).
- add_alias {name, alias} — record that two names are the SAME character (e.g. "Trish" is later introduced in full as "Trish Mitchells"). From then on both names resolve to one character everywhere: her existing memories surface when either name comes up, and who-knows lists match under either name. BEFORE writing facts for a seemingly NEW character, search their first name — if they already exist under a shorter/older name, call add_alias and keep using the EXISTING key prefix instead of starting a duplicate.

HARD LIMITS: at most 6 rounds (replies by you) and 20 tool calls per session. Be economical: usually one read round (list/search what's relevant), then ONE final reply with your write_fact lines followed by the #SHEET block.

# FINAL BLOCK

End your LAST reply with the final block. It starts with a line that is exactly \`#SHEET\` and runs to the end of the reply:

#SHEET
SUMMARY: <a FRESH, situational high-level recap written for THIS upcoming beat — the premise plus whatever the coming scene actually leans on. Re-write it each turn for where the story now stands; do NOT retell the entire history here. The full canonical whole-story recap already lives in the periodic reflection STORY and in the memories rendered below, so stay high-level and situational rather than exhaustive.>
SCENE_MARKER: <startMsgIndex> | <short scene name>
BEAT: <msgIndex> | <one past-tense sentence for that message>
TIMELINE: <the current in-story date and time; WHERE the characters physically are right now; and HOW LONG the main characters have known each other (the age of their relationship)>
PRESENT: <comma-separated names of every character physically in the current scene, e.g. "Maria, Tom">
NEED: Category/key, Category/key, ...

- SUMMARY is REQUIRED. TIMELINE should almost always be present. NEED may be omitted.
- PRESENT: keep it CURRENT every turn — everyone physically in the scene right now (main pair AND named NPCs), nobody who has left. It drives two things: it is the DEFAULT known_by for facts you store without an explicit list, and stored memories known to a listed character become visible to the storyteller while that character is in the scene.
- SCENE_MARKER: include ONLY when a NEW scene BEGINS this run (a change of place, a time-skip, or a major shift). Give the chat index where it starts and a 2-5 word name. Omit it entirely while the current scene continues — a new marker closes the previous scene card and opens a fresh one.
- BEAT: emit ONE line per NEWLY-settled message this run (use its \`#\` index), each a single terse past-tense sentence capturing what happened in that message. These stack into the current scene's card. Do NOT re-emit BEAT lines for messages you already logged on an earlier run — only the new ones.
- NEED lists ONLY the Category/key refs THIS reply actually draws on (exact refs you VERIFIED with the tools — never invented): the people present and their current state, the active relationships, and the open threads and history THIS scene touches. Produce a UNIQUE, focused set each turn — do NOT re-list the stable premise/identity facts, because the system ALWAYS injects those for you (the premise floor). The store keeps everything forever; if a later scene needs an older fact, NEED it that turn (or find it with list_keys/search). The system renders the facts you list onto the sheet for you.
- write_fact lines MAY appear in the same reply, BEFORE the #SHEET block (they are executed, then the sheet is accepted). Read tools in that reply are ignored.
- EXTRACT-ONLY runs (the task block says so): do NOT emit #SHEET; end with a line that is exactly \`#DONE\` instead.

# WHAT TO STORE (write_fact)

Store LASTING facts — anything the STORY still tracks 50 messages from now. Be THOROUGH: most turns carry 1-5 minable lasting facts, and a dense reveal turn (introductions, backstory, world lore, confessions) can have many more. Under-storing is the common failure — if a detail would matter to a future scene, store it. Read dialogue, not just narration — confessions, opinions, preferences, promises, decisions, and reveals live in quotes.

- ATOMIC values: 1-5 words per fact (a genuine backstory reveal may use up to 10). One property per fact; split multi-attribute statements into several write_fact calls. Encode the verb in the KEY (\`monika_eyes\` = \`green\`, not \`monika\` = "has green eyes").
- key: snake_case, prefixed by the subject's name (\`monika_fear_storms\`, \`bernd_job\`). Reuse an EXISTING key (verified via tools) when updating a changeable state — the update OVERWRITES the stored value in place, so carry any history that still matters into the note (see UPDATING A CHANGED FACT below).
- category: one of the Layer-1 categories from the menu in the task block (People, Places, Things, Relationships, Events, World, Unsorted). Unsorted is the catch-all for genuinely unclear facts.
- aspect: the most specific LEAF label within the category (see the taxonomy menu in the task block), e.g. \`fears\`, \`career\`, \`tattoos\`. A near-miss is snapped to the canonical leaf; if nothing fits, use category Unsorted with aspect \`misc\`.
- importance: 1-5 (5 = core identity like a name/species, 4 = important, 3 = ordinary, 2 = minor, 1 = trivial).
- kind: \`trait\` (durable identity), \`state\` (a durable-but-changeable condition — a job, an injury, who holds a key object, an ongoing goal), \`event\` (something that happened), \`moment\` (a significant emotional scene beat, remembered with feeling). (Do NOT use \`state\` for transient mood or the room-of-the-moment — those are excluded; see below.)
- note: optional short prose — a meaningful verbatim quote, a disambiguation, or a one-line summary of a complex beat. Keep the atomic value TOO.
- known_by: list EVERYONE who knows this fact — the characters present in the scene when it came up PLUS anyone the statement itself implies knows it: the source of the information, and the participants who lived it. Example: at the police station Maria tells Tom that Martha told her that James had an affair with Trish → known_by:["Maria","Tom","Martha","James","Trish"] — Martha (the source) and James and Trish (they lived it) count as knowers even if they have never appeared in the chat before. Omitting known_by defaults to the characters currently PRESENT in the scene, so an explicit list is only needed when the knowers differ from the room (secrets, second-hand reveals, absent participants).
- RELATIONSHIPS: file pair dynamics under Relationships with a stable pair key (\`monika_bernd_status\`, \`monika_bernd_trust\`) and an abstract aspect (trust/romance/debt/status_of_relationship). Update the pair's single status record when the dynamic MATERIALLY changes.

DO NOT STORE: transient poses/moods, current emotional weather, scene atmosphere, the room they happen to be in this moment, food eaten, items momentarily in hand, [OOC:] meta, reported/historical speech, negative facts ("no favorite revealed"). Those ambient here-and-now details belong on the SCENE and TIMELINE lines of the sheet, NOT in the store.

# UPDATING A CHANGED FACT

When a stored fact's value changes, reuse the SAME key (never invent a variant) — the update overwrites the record in place; there is no separate history copy. Before finishing, for every character, relationship, and open thread active this scene, check whether its stored state changed and update it. Write:
- value: the NEW current state, atomic (e.g. \`Tokyo\`) — this is what the system compares to detect the change.
- note: a SELF-CONTAINED sentence giving the CURRENT state AND the meaningful past, because the system shows the note INSTEAD of the value to the storyteller. ALWAYS restate the current state — a note that only said "moved from Berlin" would hide that she now lives in Tokyo. Example: value \`Tokyo\`, note \`Now lives in Tokyo; previously lived in Berlin, revealed this scene\`.
- The note is OVERWRITTEN on each update (not merged), so always write the COMPLETE note — the current state plus any earlier state that still matters. Don't hoard every prior value; keep only the history the story still cares about.

DELTA-ONLY: never re-write a fact whose stored value is UNCHANGED (check with the tools first — an identical re-write is wasted work). But when the value genuinely CHANGED, you MUST write the new value — that IS the update, not waste.

# TENTATIVE MESSAGES

Messages in the block marked "TENTATIVE" may still be swiped/edited. They may inform your SCENE/NEED planning, but you MUST NOT write_fact anything from them — extract only from the SETTLED messages.` + TEMPORAL_GROUNDING_RULE;

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
    // Captured at run start: scene/sheet state may only be written back into THIS
    // chat — if the user switches chats mid-run, the results are dropped instead
    // of contaminating the other chat's metadata.
    const runChatId = currentChatIdSafe();

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

    let sourceIndex = null;
    let sourceUid = '';
    for (const m of (Array.isArray(settledMessages) ? settledMessages : [])) {
        if (Number.isInteger(m?.index) && (sourceIndex === null || m.index > sourceIndex)) {
            sourceIndex = m.index;
            sourceUid = String(m?.uid || '');
        }
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
    if (sourceUid) ctx.srcId = sourceUid;

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
        systemPrompt: (String(settings?.memoryAgentPrompt || '').trim() || DEFAULT_MEMORY_AGENT_PROMPT),
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
        // Write-salvage: persist writes that already executed into ctx.databases
        // even though the loop errored, so extracted facts aren't discarded.
        for (const cat of ctx.touchedCategories) {
            if (!databases[cat]) continue;
            try { await saveDatabase(databases[cat]); }
            catch (e) { addDebugLog('fail', `[${runId}] Failed to save "${cat}" after loop error: ${e?.message || e}`); }
        }
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
    for (const cat of toSave) {
        if (!databases[cat]) continue;
        try {
            await saveDatabase(databases[cat]);
            addDebugLog('pass', `[${runId}] Saved database "${cat}" (${databases[cat].facts.length} facts)`);
        } catch (e) {
            addDebugLog('fail', `[${runId}] Failed to save database "${cat}": ${e?.message || e}`);
        }
    }

    if (!extractOnly && parsedSheet) {
        // BEAT coverage enforcement: repair index-less beats and, for settled
        // messages the agent skipped entirely, fetch the missing sentence via a
        // tiny dedicated call (no full system prompt).
        try {
            await backfillMissingBeats({ parsedSheet, settledMessages, profileId, runId, signal });
        } catch (e) {
            addDebugLog('info', `[${runId}] Beat backfill failed (non-fatal): ${e?.message || e}`);
        }
        // Attach each beat's stable message uid (extra.bf_uid, carried on the
        // settled batch) so the scene store can de-dup by uid — raw chat indices
        // shift when older messages are deleted, uids don't.
        try {
            const uidByIndex = new Map((Array.isArray(settledMessages) ? settledMessages : [])
                .filter(m => Number.isInteger(m?.index) && m?.uid)
                .map(m => [m.index, String(m.uid)]));
            for (const b of parsedSheet.beats) {
                if (!b.uid && b.msgIndex >= 0 && uidByIndex.has(b.msgIndex)) b.uid = uidByIndex.get(b.msgIndex);
            }
        } catch {  }
        // Scene accumulator: a fired marker closes the previous card and opens a new
        // one; then this run's newly-settled beats stack onto the current card
        // (de-duped by msgIndex inside appendSceneBeats). Persisted in chatMetadata.
        const liveChatId = currentChatIdSafe();
        if (runChatId && liveChatId && liveChatId !== runChatId) {
            addDebugLog('fail', `[${runId}] Scene accumulator skipped — chat changed mid-run (${runChatId} -> ${liveChatId}); nothing was written into the other chat`, {
                subsystem: 'agent3', event: 'scene.skipped', reason: 'CHAT_CHANGED',
            });
        } else {
            try {
                const marker = parsedSheet.sceneMarker;
                const markerStart = (marker && Number.isInteger(marker.startMsg)) ? marker.startMsg : -1;
                if (marker && markerStart >= 0) {
                    // Partition around the marker: beats for messages BEFORE the
                    // marker's start index belong to the scene that is about to
                    // close — stack them first, then open the new card, then add
                    // the new scene's beats.
                    const before = parsedSheet.beats.filter(b => b.msgIndex >= 0 && b.msgIndex < markerStart);
                    const after = parsedSheet.beats.filter(b => !(b.msgIndex >= 0 && b.msgIndex < markerStart));
                    if (before.length > 0) appendSceneBeats(before);
                    startScene(marker);
                    if (after.length > 0) appendSceneBeats(after);
                } else {
                    if (marker) startScene(marker);
                    if (parsedSheet.beats.length > 0) appendSceneBeats(parsedSheet.beats);
                }
                // PRESENT is a snapshot of who is in the scene right now; replace,
                // don't accumulate. Applied after startScene so a new scene gets a
                // fresh list instead of inheriting the previous room's people. An
                // explicit (even empty) PRESENT line may CLEAR the room; an
                // omitted line leaves the previous snapshot untouched.
                if (parsedSheet.presentProvided) setScenePresent(parsedSheet.present);
                // Persist the freshest TIMELINE so a later run that omits the
                // line falls back to it instead of blanking "Timeline & place".
                if (parsedSheet.timeline) setSceneTimeline(parsedSheet.timeline);
            } catch (e) {
                addDebugLog('fail', `[${runId}] Scene accumulator failed: ${e?.message || e}`);
            }
        }
    }

    if (!extractOnly) {
        result.sheetText = composeSheet({
            summary: parsedSheet.summary,
            // Fall back to the persisted last-known timeline when this run's
            // sheet omitted the TIMELINE line, so time/place never blanks out.
            timeline: parsedSheet.timeline || getSceneTimeline(),
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

// BEAT coverage enforcement: the prompt asks for exactly one BEAT per settled
// message, but that is only prompt compliance. Repair pass:
//   1. Index-less beats (agent dropped the "| <index>") are adopted onto the
//      still-uncovered settled indices in emission order — BEAT lines are
//      emitted in message order, so this recovers the mapping.
//   2. Any settled message STILL without a beat gets ONE tiny dedicated LLM
//      call ("summarize this one message in one sentence") — deliberately not
//      the full memory-agent system prompt.
const BEAT_BACKFILL_MAX = 6;

async function backfillMissingBeats({ parsedSheet, settledMessages = [], profileId = null, runId = '', signal = null } = {}) {
    const beats = Array.isArray(parsedSheet?.beats) ? parsedSheet.beats : [];
    const covered = new Set(beats.filter(b => Number.isInteger(b.msgIndex) && b.msgIndex >= 0).map(b => b.msgIndex));
    const missing = (Array.isArray(settledMessages) ? settledMessages : [])
        .map(m => m?.index)
        .filter(i => Number.isInteger(i) && i >= 0 && !covered.has(i))
        .sort((a, b) => a - b);
    if (missing.length === 0) return;

    for (const b of beats) {
        if (missing.length === 0) break;
        if (!(Number.isInteger(b.msgIndex) && b.msgIndex >= 0)) b.msgIndex = missing.shift();
    }
    if (missing.length === 0) {
        addDebugLog('info', `[${runId}] Beat repair: adopted index-less beat(s) onto the uncovered settled message(s) — no LLM call needed`, {
            subsystem: 'agent3', event: 'beat.repair',
        });
        return;
    }

    const todo = missing.slice(0, BEAT_BACKFILL_MAX);
    if (missing.length > todo.length) {
        addDebugLog('info', `[${runId}] Beat backfill: ${missing.length} beat(s) missing, capping dedicated calls at ${BEAT_BACKFILL_MAX} this run (rest stays missing)`);
    }
    const byIndex = new Map((Array.isArray(settledMessages) ? settledMessages : []).map(m => [m.index, m]));
    for (const idx of todo) {
        const m = byIndex.get(idx);
        if (!m || !String(m.text || '').trim()) continue;
        let sentence = '';
        try {
            sentence = String(await callAgentLLM(
                'You summarize ONE roleplay message as ONE terse past-tense sentence (third person, max 25 words). Reply with the sentence only — no preamble, no quotes.',
                renderMessageLine(m), profileId, 'beat-backfill', signal,
            ) || '').replace(/\s+/g, ' ').trim();
        } catch { sentence = ''; }
        if (sentence) {
            beats.push({ msgIndex: idx, sentence });
            addDebugLog('info', `[${runId}] Beat backfill: msg #${idx} got its sentence via a dedicated call`, {
                subsystem: 'agent3', event: 'beat.backfill', data: { msgIndex: idx },
            });
        } else {
            addDebugLog('info', `[${runId}] Beat backfill: dedicated call for msg #${idx} returned nothing — beat stays missing`);
        }
    }
}

function parseSheetBlock(text) {
    const out = { summary: '', sceneMarker: null, beats: [], timeline: '', present: [], presentProvided: false, need: [], error: null };
    const raw = String(text ?? '').trim();
    if (!raw) {
        out.error = 'empty sheet block';
        return out;
    }
    const buf = { SUMMARY: [], TIMELINE: [], PRESENT: [], NEED: [] };
    let current = null;
    for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim();
        if (!line || /^```/.test(line)) continue;

        // SCENE_MARKER: <startMsgIndex> | <short name> — an agent-declared new scene.
        let sm = /^SCENE_MARKER\s*:\s*(.*)$/i.exec(line);
        if (sm) {
            current = null;
            const body = sm[1].trim();
            const bar = body.indexOf('|');
            const idxPart = (bar >= 0 ? body.slice(0, bar) : body).trim().replace(/^#/, '');
            const namePart = bar >= 0 ? body.slice(bar + 1).trim() : '';
            const startMsg = parseInt(idxPart, 10);
            const name = namePart || (Number.isFinite(startMsg) ? '' : body);
            if (name || Number.isInteger(startMsg)) {
                out.sceneMarker = { startMsg: Number.isInteger(startMsg) ? startMsg : -1, name };
            }
            continue;
        }

        // BEAT: <msgIndex> | <one sentence> — one stacked beat per settled message.
        let bt = /^BEAT\s*:\s*(.*)$/i.exec(line);
        if (bt) {
            current = null;
            const body = bt[1].trim();
            const bar = body.indexOf('|');
            const idxPart = (bar >= 0 ? body.slice(0, bar) : '').trim().replace(/^#/, '');
            const sentence = (bar >= 0 ? body.slice(bar + 1) : body).trim();
            const msgIndex = parseInt(idxPart, 10);
            if (sentence) out.beats.push({ msgIndex: Number.isInteger(msgIndex) ? msgIndex : -1, sentence });
            continue;
        }

        const m = /^(SUMMARY|TIMELINE|PRESENT|NEED)\s*:\s*(.*)$/i.exec(line);
        if (m) {
            current = m[1].toUpperCase();
            // A PRESENT header that appeared at all (even with an empty/"none"
            // list) is an explicit snapshot — lets the agent CLEAR the room.
            if (current === 'PRESENT') out.presentProvided = true;
            if (m[2].trim()) buf[current].push(m[2].trim());
            continue;
        }

        if (current) buf[current].push(line);
    }
    out.summary = buf.SUMMARY.join(' ').trim();
    out.timeline = buf.TIMELINE.join(' ').trim();

    for (const name of buf.PRESENT.join(',').split(',')) {
        const n = name.trim().replace(/^[-*]\s*/, '');
        if (!n || /^\(?none\)?$/i.test(n)) continue;
        out.present.push(n);
    }

    for (const ref of buf.NEED.join(',').split(',')) {
        const r = ref.trim().replace(/^[-*]\s*/, '');
        if (!r || /^\(?none\)?$/i.test(r)) continue;
        const slash = r.indexOf('/');
        if (slash <= 0) continue;
        const category = r.slice(0, slash).trim();
        const key = r.slice(slash + 1).trim();
        if (!category || !key) continue;
        out.need.push({ category, key });
    }

    // Only hard-fail when the sheet is effectively empty (no SUMMARY and no other
    // usable section); a missing SUMMARY alongside a scene marker/beats/TIMELINE/NEED
    // still composes.
    if (!out.summary && !out.sceneMarker && out.beats.length === 0 && !out.timeline && out.need.length === 0) {
        out.error = 'missing SUMMARY line';
    }
    return out;
}

function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

function composeSheet({ summary = '', sceneLine = '', timeline = '', need = [], settings = {}, databases = {} } = {}) {
    let nowCtx = null;
    try { nowCtx = getTurnNowContext(); } catch { nowCtx = null; }

    const rows = [];
    const seen = new Set();

    // PREMISE FLOOR: always inject the load-bearing premise/identity facts, even if
    // this turn's fresh NEED pick omits them. This is a FLOOR (a guaranteed minimum),
    // not a ceiling — it never evicts or caps anything the NEED loop adds below.
    const PREMISE_FLOOR_MAX = 15;
    try {
        const floorCandidates = [];
        for (const [rawCat, db] of Object.entries(databases || {})) {
            if (!db || !Array.isArray(db.facts)) continue;
            const category = mapLegacyCategory(String(rawCat || '').trim() || 'Unsorted');
            for (const fact of db.facts) {
                if (!fact || !isActiveFact(fact) || !isFactVisible(fact)) continue;
                const loadBearing = clampImportance(fact.importance) >= 4 || fact.kind === 'trait';
                if (!loadBearing) continue;
                floorCandidates.push({ fact, category });
            }
        }
        floorCandidates.sort((a, b) => {
            const impDiff = clampImportance(b.fact.importance) - clampImportance(a.fact.importance);
            if (impDiff !== 0) return impDiff;
            return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
        });
        for (const { fact, category } of floorCandidates.slice(0, PREMISE_FLOOR_MAX)) {
            const id = `${category}:${fact.key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            rows.push({ fact, category, tier: 'primary' });
        }
    } catch {  }

    for (const ref of (Array.isArray(need) ? need : [])) {
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

    // "Story so far:" is the deterministic append-only spine (one sentence per
    // completed batch of spineBatchSize settled messages), joined — it grows
    // monotonically and is never rewritten. The agent's own per-turn situational
    // recap always renders as its own "Right now:" line. While the spine is
    // still empty (before the first complete batch) the "Story so far:" line is
    // simply OMITTED — no fallback text stands in for it.
    let spineText = '';
    try {
        const spine = getStorySpine();
        if (Array.isArray(spine) && spine.length > 0) {
            spineText = spine.map(b => String(b.sentence || '').trim()).filter(Boolean).join(' ');
        }
    } catch { spineText = ''; }

    if (spineText) lines.push(`Story so far: ${spineText}`);
    if (summary) lines.push(`Right now: ${summary}`);
    // Scene card: the agent-declared scene name as a header, followed by the stacked
    // one-line beats accumulated across every message since this scene opened. Falls
    // back to the legacy single sceneLine only if no scene has been accumulated yet.
    let scene = null;
    try { scene = getCurrentScene(); } catch { scene = null; }
    if (scene && (scene.name || (Array.isArray(scene.beats) && scene.beats.length > 0))) {
        lines.push(`Scene: ${scene.name || '(current scene)'}`);
        // Only inject the most recent beats so a long-running scene can't grow the
        // sheet without bound; earlier beats of this scene remain in the persisted
        // scene store (and the overall arc is covered by the story spine).
        const MAX_SCENE_BEATS_SHOWN = 14;
        const beatsArr = Array.isArray(scene.beats) ? scene.beats : [];
        if (beatsArr.length > MAX_SCENE_BEATS_SHOWN) lines.push(`…(${beatsArr.length - MAX_SCENE_BEATS_SHOWN} earlier beats)`);
        for (const b of beatsArr.slice(-MAX_SCENE_BEATS_SHOWN)) {
            const s = String(b?.sentence || '').trim();
            if (s) lines.push(s);
        }
    } else if (sceneLine) {
        lines.push(`Scene: ${sceneLine}`);
    }
    if (timeline) lines.push(`Timeline & place: ${timeline}`);
    try {
        const present = getScenePresent();
        if (present.length > 0) lines.push(`Present: ${present.join(', ')}`);
    } catch {  }
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

    return lines.join('\n');
}
