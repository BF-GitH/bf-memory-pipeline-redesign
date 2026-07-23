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
import { countSentenceEnds } from './sentence-util.js';
import { executeMemoryTool, stripThinkBlocks } from './memory-tools.js';
import { getStorySpine, getCurrentScene, startScene, appendSceneBeats, setScenePresent, getScenePresent, getSceneTimeline, setSceneTimeline, getLastNeedRefs, setLastNeedRefs } from './turn-state.js';
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

// Connection-class failure classifier, shared with pipeline.js's timeout
// auto-retry: transport-level errors (timeout, abort, wall-clock/run budget,
// network/fetch) that a later retry against the same endpoint can plausibly
// recover from. Protocol/cap errors (the endpoint demonstrably responds and
// simply misbehaved) never match — retrying those would just repeat the run.
export function isConnectionFailure(msg) {
    const s = String(msg || '');
    // Protocol errors embed MODEL-authored text after a fixed prefix (e.g. an
    // invented tool name like "fetch_memory" inside 'malformed protocol reply
    // (second offense): unknown tool ...'), so they must be excluded BEFORE the
    // substring test — a hallucinated name containing "fetch"/"network" must
    // not reclassify a deterministic protocol failure as a retryable one.
    if (/^malformed protocol reply/i.test(s)) return false;
    return /timed out|abort|wall-clock|budget|network|fetch/i.test(s);
}

const TEMPORAL_GROUNDING_RULE = `

# OBSERVATION DATE
The task block's \`## Observation date\` = real-world time the newest message was observed. Resolve RELATIVE time ("yesterday", "two years ago") to ABSOLUTE dates against it so facts don't rot; none given → leave as-is.`;

export const DEFAULT_MEMORY_AGENT_PROMPT = `You are the EXTRACTION AGENT for a roleplay between {{user}} (human) and {{char}} (AI character), running in the BACKGROUND after each reply. TWO jobs in one tool session: EXTRACT — store new LASTING facts from the SETTLED messages; SELECT — list the STORED memories the NEXT storyteller reply needs on a NEED line. Sheet, beats and timeline are separate passes. Only outputs: tool calls, a NEED line, #DONE.

# TOOL PROTOCOL (plain text — no function-call API)

Each tool call is ONE line of strict JSON, alone on its line:
{"tool":"list_categories"}
{"tool":"list_keys","args":{"category":"People"}}
{"tool":"read_facts","args":{"category":"People","keys":["monika_name","monika_mood"]}}
{"tool":"write_fact","args":{"category":"People","key":"monika_mood","value":"...","note":"...","known_by":["Monika"],"aspect":"mood","importance":3}}
{"tool":"search","args":{"query":"who owns the bakery"}}
{"tool":"add_alias","args":{"name":"Trish","alias":"Trish Mitchells"}}
{"tool":"link_facts","args":{"from":"Events:tom_affair_jessica","to":"Events:jessica_visit_awkward","reason":"explains why the visit was awkward"}}

The system replies with one "TOOL RESULTS:" message; then call more tools or finish. Several lines per reply are fine; no markdown fences, no multi-line JSON.
- add_alias: two names = SAME character. Before writing a seemingly NEW character, search their first name; if stored under an older name, add_alias and reuse the EXISTING key prefix.
- link_facts: link two STORED facts ("Category:key" refs VERIFIED via tools, never guessed) when a NEW fact retroactively explains an OLD one, as in the example above (new affair fact explains the old awkward visit). Max 5 links per fact; re-linking is a no-op.

HARD LIMITS: at most 8 rounds and 24 tool calls per session. LIGHT turn (small talk): one read round, then the final reply. DENSE turn (new character, backstory, secret, contradiction): spend extra rounds; check BEFORE writing — "Maria likes apples" → search "maria food" first; write into the existing preference key, don't duplicate.

# FINAL REPLY

Write calls first (bare JSON, one per line), then on a FULL run ONE line:

NEED: Category/key, Category/key, ...

End your LAST reply with a line that is exactly \`#DONE\` (nothing else on it).
- NEED: ONLY refs the NEXT reply will draw on (VERIFIED via tools, never invented) — people present and their state, active relationships, open threads THIS scene touches. Do NOT re-list stable premise/identity facts (auto-injected); older facts can be NEEDed later; omit NEED when nothing beyond that is needed. Read tools in the final reply are ignored.
- EXTRACT-ONLY runs (task block says so): no NEED line — writes, then \`#DONE\`.

# WHAT TO STORE

LASTING facts — anything the story still tracks 50 messages on. Under-storing is the common failure; reveal turns hold many facts. Mine DIALOGUE too — confessions, preferences, promises, decisions live in quotes.
- ATOMIC value, 1-5 words (up to 10 for a real backstory reveal); one property per fact — split multi-attribute statements; verb goes in the KEY (\`monika_eyes\` = \`green\`).
- key: snake_case, subject-prefixed (\`monika_fear_storms\`); reuse the EXISTING key (verified) when updating a changeable state.
- category / aspect: from the task-block taxonomy menu — category one of People, Places, Things, Relationships, Events, World, Unsorted (catch-all); aspect the most specific LEAF (near-misses snap; nothing fits → Unsorted / \`misc\`).
- importance: 1-5 (5 = core identity, 3 = ordinary, 1 = trivial).
- kind: \`trait\` (durable identity), \`state\` (durable-but-changeable — job, injury, goal; NOT transient mood/room), \`event\`, \`moment\` (emotional beat).
- note: optional short prose (quote, disambiguation, summary); keep the atomic value too.
- known_by: EVERYONE who knows it — those present PLUS the source and implied participants: Maria tells Tom that Martha said James had an affair with Trish → ["Maria","Tom","Martha","James","Trish"]. Omitted = those PRESENT; list only when knowers differ (secrets, second-hand, absentees).
- Relationships: pair dynamics under a stable pair key (\`monika_bernd_trust\`) with abstract aspect (trust/romance/debt/status_of_relationship); update its status record when the dynamic MATERIALLY changes.

DO NOT STORE: transient poses/moods, atmosphere, the current room, food eaten, items in hand, [OOC:] meta, reported/historical speech, negative facts ("no favorite revealed") — the scene/timeline passes cover those.

# UPDATING A CHANGED FACT

Reuse the SAME key — updates OVERWRITE in place, no history copy. Before finishing, check every character, relationship, and open thread active this scene for changed state.
- value: the NEW state, atomic (\`Tokyo\`).
- note: SELF-CONTAINED, shown INSTEAD of the value — restate the current state plus the past that still matters: value \`Tokyo\`, note \`Now lives in Tokyo; previously lived in Berlin, revealed this scene\`. Notes overwrite, never merge — write the complete note.
DELTA-ONLY: never re-write an UNCHANGED value (check first); a genuinely CHANGED value MUST be written.

# TENTATIVE MESSAGES

"TENTATIVE" messages may still be swiped/edited: use for NEED planning only — NEVER write_fact from them; extract only from SETTLED messages.` + TEMPORAL_GROUNDING_RULE;

// Call B (BEATS) — single-shot, no tools. Turns the newly-settled messages into
// one terse past-tense beat each, parsed back by number. Fixed prompt: NOT
// affected by the settings override (that covers only the extraction agent).
export const DEFAULT_BEATS_PROMPT = `You convert roleplay messages into terse scene beats for a memory log. You are given a NUMBERED list of roleplay messages. For EACH numbered message write ONE past-tense sentence (third person, max 25 words) capturing what happened in that message. Reply STRICTLY as the same numbered lines — "1. <sentence>", "2. <sentence>", ... — one line per input number, in the same order, and NOTHING else: no preamble, no blank lines, no commentary, no quotes.`;

// Call C (SHEET HEAD) — single-shot, no tools. Writes the situational recap and
// scene framing lines in the exact format parseSheetBlock understands. Fixed
// prompt: NOT affected by the settings override.
export const DEFAULT_HEAD_PROMPT = `You write the HEAD of a roleplay memory sheet from the given brief, messages, scene card and prior head. Output EXACTLY these lines and nothing else:

SUMMARY: <FRESH situational recap for the UPCOMING beat — premise plus what the coming scene leans on; re-write for where the story stands, don't retell history>
SCENE_MARKER: <startMsgIndex> | <2-5 word scene name>
TIMELINE: <in-story date/time; WHERE the characters are; how long the mains have known each other>
PRESENT: <comma-separated names of everyone physically in the scene, e.g. "Maria, Tom">

SUMMARY is REQUIRED; TIMELINE almost always. SCENE_MARKER only when a NEW scene BEGINS in the recent messages (place change, time-skip, major shift) — the "#N" index where it starts, then the name; OMIT while the scene continues. PRESENT: everyone there RIGHT NOW (mains AND named NPCs), nobody who left. No #SHEET header, no BEAT/NEED lines, no commentary.` + TEMPORAL_GROUNDING_RULE;

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
    // `error` is fatal (aborts the pipeline commit). `extractionError` is the
    // isolated Call A failure on a full run — the sheet still refreshes, but the
    // pipeline holds the watermark FALSE so extraction retries next run.
    // `calls` carries the per-call outcomes (extract/beats/head) for the Health
    // tab's composite row; `stageMs` the per-call durations for stage timing.
    const result = { sheetText: null, applied: [], error: null, extractionError: null, tokensIn: 0, tokensOut: 0, rounds: 0, toolCallCount: 0, calls: null, stageMs: null };
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

    // ===================================================================
    // CALL A — EXTRACTION (the only tool-loop): write_fact / link_facts /
    // add_alias + NEED selection. Always ends with #DONE (never a #SHEET);
    // the sheet head and beats are produced by the fixed Call C / Call B
    // passes below. The settings override + extra instructions apply HERE.
    // ===================================================================
    const extractPrompt = buildExtractionUserPrompt({
        settledMessages, tentativeMessages, characterInfo, userPersona,
        observationDate, extractOnly, databases, index, settings,
    });

    addDebugLog('info', `[${runId}] Extraction agent start: ${settledMessages.length} settled, ${tentativeMessages.length} tentative msg(s), extractOnly=${extractOnly} (user prompt ${extractPrompt.length} chars)`, {
        subsystem: 'agent3', event: 'agent3.extract',
        data: { settled: settledMessages.length, tentative: tentativeMessages.length, extractOnly, userPromptChars: extractPrompt.length, profileId: profileId || null },
    });

    const extractStart = Date.now();
    const loop = await callAgentLLMWithTools({
        systemPrompt: (String(settings?.memoryAgentPrompt || '').trim() || DEFAULT_MEMORY_AGENT_PROMPT),
        userPrompt: extractPrompt,
        profileId,
        agent: 'memory-agent',
        agentTag: 'memory',
        // Keep in sync with the HARD LIMITS line in DEFAULT_MEMORY_AGENT_PROMPT.
        maxRounds: 8,
        maxToolCalls: 24,
        executeTool: (call) => executeMemoryTool(call, ctx),
        // Call A always finishes with #DONE — it never emits a #SHEET, so the
        // "carried no sheet content" guard must stay off regardless of the outer
        // full/extract-only distinction.
        extractOnly: true,
        signal,
    });

    const extractMs = Date.now() - extractStart;
    result.rounds = loop.rounds;
    result.toolCallCount = loop.toolCallCount;
    result.tokensIn += loop.tokensInApprox || 0;
    result.tokensOut += loop.tokensOutApprox || 0;
    result.applied = ctx.applied;
    result.stageMs = { extractMs, beatsMs: null, headMs: null };
    result.calls = {
        extract: loop.error
            ? { status: 'fail', error: loop.error, rounds: loop.rounds, toolCalls: loop.toolCallCount }
            : { status: 'ok', writes: ctx.applied.length, rounds: loop.rounds, toolCalls: loop.toolCallCount },
    };

    // Persist every write Call A executed — this also salvages writes made before
    // an error round, so extracted facts are never discarded on a loop failure.
    for (const cat of ctx.touchedCategories) {
        if (!databases[cat]) continue;
        try {
            await saveDatabase(databases[cat]);
            addDebugLog('pass', `[${runId}] Saved database "${cat}" (${databases[cat].facts.length} facts)`);
        } catch (e) {
            addDebugLog('fail', `[${runId}] Failed to save database "${cat}": ${e?.message || e}`);
        }
    }

    addDebugLog(loop.error ? 'fail' : 'pass', `[${runId}] Extraction agent done: ${ctx.applied.length} write(s), ${loop.rounds} round(s), ${loop.toolCallCount} tool call(s)${loop.error ? ` — ERROR: ${loop.error}` : ''}`, {
        subsystem: 'agent3', event: 'agent3.extract',
        data: {
            agent: 'memory-agent', profileId: profileId || null, success: !loop.error, extractOnly,
            applied: ctx.applied.length, rounds: loop.rounds, toolCallCount: loop.toolCallCount,
            durationMs: extractMs, error: loop.error || null,
        },
    });

    // EXTRACT-ONLY runs (catch-up import, per-message force) stop after Call A —
    // no beats, no head, no sheet. A loop error is fatal for them.
    if (extractOnly) {
        if (loop.error) result.error = loop.error;
        return result;
    }

    // FULL run: a CONNECTION-level Call A failure (user cancel via
    // cancelInFlightLLM, wall-clock timeout, dead profile) is fatal for the
    // whole run — Calls B/C, backfill and brevity would each dispatch fresh
    // post-cancel calls against the same broken connection and persist scene
    // state for a run the pipeline is about to discard. Only non-connection
    // failures (protocol/cap errors: the endpoint demonstrably responds) keep
    // the per-call isolation below.
    if (loop.error && isConnectionFailure(loop.error)) {
        result.error = loop.error;
        return result;
    }

    // Remaining Call A failures are isolated — no writes/NEED this run, but the
    // sheet still refreshes below. Surface it as extractionError (not the fatal
    // `error`) so the pipeline keeps the bf_mem_processed watermark FALSE and
    // re-extracts next run, while still committing the refreshed sheet.
    if (loop.error) result.extractionError = loop.error;

    // NEED refs travel on the reply that carried #DONE — usually the last
    // non-empty reply, but a grace-round correction can split them (NEED line
    // in round N, bare #DONE in round N+1), so scan newest-first and take the
    // newest reply that carries an explicit NEED header (an explicit "NEED:
    // none" wins over older drafts). Think blocks are stripped first: a
    // reasoning model's chain-of-thought can draft "NEED:" lines it decided
    // against — the same hazard parseAgentReply strips them for.
    let need = [];
    if (!loop.error) {
        for (let i = (loop.transcript || []).length - 1; i >= 0; i--) {
            const r = stripThinkBlocks(String(loop.transcript[i]?.reply || ''));
            if (/^\s*NEED\s*:/im.test(r)) { need = parseNeedRefs(r); break; }
        }
    } else {
        // Isolated Call A failure: fall back to the last successful selection —
        // the refreshed sheet must not silently lose the fact rows the prior
        // sheet carried.
        try { need = getLastNeedRefs(); } catch { need = []; }
    }

    // ===================================================================
    // CALL B (BEATS) + CALL C (SHEET HEAD) — both single-shot, no tools, and
    // independent, so run them concurrently. Neither reads the other's output;
    // Call C reads the scene store as it stands BEFORE Call B's beats are
    // partitioned in (that happens after both settle).
    // ===================================================================
    const [beatsRes, headRes] = await Promise.all([
        runBeatsCall({ settledMessages, profileId, runId, signal }),
        runHeadCall({
            settledMessages, tentativeMessages, characterInfo, userPersona,
            priorSheetText, reflection, observationDate, profileId, runId, signal,
        }),
    ]);
    result.tokensIn += (beatsRes.tokensIn || 0) + (headRes.tokensIn || 0);
    result.tokensOut += (beatsRes.tokensOut || 0) + (headRes.tokensOut || 0);
    result.stageMs.beatsMs = Number.isFinite(beatsRes.durationMs) ? beatsRes.durationMs : null;
    result.stageMs.headMs = Number.isFinite(headRes.durationMs) ? headRes.durationMs : null;

    const beats = Array.isArray(beatsRes.beats) ? beatsRes.beats : [];
    // Backfill (per-message repair net) covers settled messages Call B missed or
    // returned unparseably; capped as before.
    try {
        await backfillMissingBeats({ beats, settledMessages, profileId, runId, signal });
    } catch (e) {
        addDebugLog('info', `[${runId}] Beat backfill failed (non-fatal): ${e?.message || e}`);
    }
    // Attach each beat's stable message uid so the scene store de-dups by uid
    // (raw chat indices shift when older messages are deleted, uids don't).
    try {
        const uidByIndex = new Map((Array.isArray(settledMessages) ? settledMessages : [])
            .filter(m => Number.isInteger(m?.index) && m?.uid)
            .map(m => [m.index, String(m.uid)]));
        for (const b of beats) {
            if (!b.uid && b.msgIndex >= 0 && uidByIndex.has(b.msgIndex)) b.uid = uidByIndex.get(b.msgIndex);
        }
    } catch {  }
    // Brevity enforcement runs HERE — the single choke point where the final beat
    // list (Call B + backfill) exists, before it is handed to the scene store.
    try {
        await enforceBeatBrevity(beats, profileId, runId, signal);
    } catch (e) {
        addDebugLog('info', `[${runId}] Beat brevity enforcement failed (non-fatal): ${e?.message || e}`);
    }

    // Per-call outcomes for the Health tab. Beat coverage is judged AFTER the
    // backfill net: a failed batched call whose gaps the backfill fully covered
    // still counts as ok — what matters is settled messages that got a beat.
    const beatWant = (Array.isArray(settledMessages) ? settledMessages : [])
        .filter(m => Number.isInteger(m?.index) && String(m?.text || '').trim()).length;
    const beatGot = new Set(beats.filter(b => Number.isInteger(b?.msgIndex) && b.msgIndex >= 0).map(b => b.msgIndex)).size;
    result.calls.beats = (beatsRes.error && beatGot < beatWant)
        ? { status: 'fail', got: beatGot, want: beatWant, error: beatsRes.error }
        : { status: beatGot < beatWant ? 'partial' : 'ok', got: beatGot, want: beatWant };
    // A non-empty head reply that parses to nothing is a semantic failure too:
    // headRes.error only covers throws/empty replies, so consult parsed.error
    // as well — otherwise the Health composite renders "head ok" while every
    // head field silently fell back to the prior run's state.
    const headParseError = (headRes.parsed && headRes.parsed.error) ? headRes.parsed.error : null;
    result.calls.head = (headRes.error || headParseError)
        ? { status: 'fail', error: headRes.error || headParseError }
        : { status: 'ok' };

    // Call C head (may be null when Call C failed — the sheet then falls back to
    // the prior head / persisted scene state).
    const head = headRes.parsed || null;
    const marker = head ? head.sceneMarker : null;

    // Scene accumulator: mirror the pre-split partition logic exactly — a fired
    // marker closes the previous card and opens a new one; this run's beats stack
    // onto the current card (de-duped inside appendSceneBeats). Persisted in
    // chatMetadata, and skipped entirely if the chat switched mid-run.
    const liveChatId = currentChatIdSafe();
    if (runChatId && liveChatId && liveChatId !== runChatId) {
        addDebugLog('fail', `[${runId}] Scene accumulator skipped — chat changed mid-run (${runChatId} -> ${liveChatId}); nothing was written into the other chat`, {
            subsystem: 'agent3', event: 'scene.skipped', reason: 'CHAT_CHANGED',
        });
    } else {
        try {
            const markerStart = (marker && Number.isInteger(marker.startMsg)) ? marker.startMsg : -1;
            if (marker && markerStart >= 0) {
                // Partition around the marker: beats for messages BEFORE the
                // marker's start index belong to the scene about to close — stack
                // them first, open the new card, then add the new scene's beats.
                const before = beats.filter(b => b.msgIndex >= 0 && b.msgIndex < markerStart);
                const after = beats.filter(b => !(b.msgIndex >= 0 && b.msgIndex < markerStart));
                if (before.length > 0) appendSceneBeats(before);
                startScene(marker);
                if (after.length > 0) appendSceneBeats(after);
            } else {
                if (marker) startScene(marker);
                if (beats.length > 0) appendSceneBeats(beats);
            }
            // PRESENT is a snapshot; replace, don't accumulate. Applied after
            // startScene so a new scene gets a fresh list. An explicit (even empty)
            // PRESENT line may CLEAR the room; an omitted line leaves it untouched.
            if (head && head.presentProvided) setScenePresent(head.present);
            // Persist the freshest TIMELINE so a later run that omits the line
            // falls back to it instead of blanking "Timeline & place".
            if (head && head.timeline) setSceneTimeline(head.timeline);
            // Persist this run's successful NEED selection (even an explicit
            // empty one) so an isolated Call A failure next run re-renders these
            // rows — behind the same chat-switch guard as the scene writes.
            if (!loop.error) { try { setLastNeedRefs(need); } catch {  } }
        } catch (e) {
            addDebugLog('fail', `[${runId}] Scene accumulator failed: ${e?.message || e}`);
        }
    }

    // composeSheet stays pure code: fed the head from Call C (summary/timeline,
    // falling back to the prior head / persisted timeline when Call C failed),
    // the NEED refs from Call A, and the beats via the scene store.
    const summary = (head && head.summary) ? head.summary : extractPriorSummary(priorSheetText);
    result.sheetText = composeSheet({
        summary,
        timeline: (head && head.timeline) || getSceneTimeline(),
        need,
        settings,
        databases,
    });

    addDebugLog('pass', `[${runId}] Memory Agent done: ${ctx.applied.length} write(s), ${loop.rounds} round(s), ${loop.toolCallCount} tool call(s), ${beats.length} beat(s), sheet ${result.sheetText.length} chars${result.extractionError ? ' (extraction FAILED — sheet refreshed, watermark held)' : ''}`, {
        subsystem: 'agent3', event: 'agent.run',
        data: {
            agent: 'memory-agent', profileId: profileId || null, success: true, extractOnly,
            applied: ctx.applied.length, rounds: loop.rounds, toolCallCount: loop.toolCallCount,
            beats: beats.length, sheetChars: result.sheetText.length,
            extractionError: result.extractionError || null, headError: headRes.error || null, beatsError: beatsRes.error || null,
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

// Call A user prompt: store overview + tools context + the messages. NO prior
// memory sheet, NO SUMMARY/BEAT/TIMELINE framing — the extraction agent only
// writes facts and picks NEED; the sheet head/beats are separate fixed passes.
function buildExtractionUserPrompt({
    settledMessages, tentativeMessages, characterInfo, userPersona,
    observationDate, extractOnly, databases, index, settings,
}) {
    const parts = [];

    parts.push('## Task\n' + (extractOnly
        ? 'EXTRACT-ONLY RUN: store new lasting facts from the settled messages via write_fact, then end with the #DONE line. Do NOT emit a NEED line.'
        : 'FULL RUN: store new lasting facts from the settled messages, then emit the NEED line and end with #DONE.'));

    if (observationDate) parts.push(`## Observation date: ${observationDate}`);
    if (characterInfo) parts.push(`## Character Info ({{char}})\n${characterInfo}`);
    if (userPersona) parts.push(`## User Persona ({{user}})\n${userPersona}`);

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
        parts.push('## SETTLED messages\n(none this run — do NOT call write_fact; just pick NEED from the store and the tentative context)');
    }

    if (Array.isArray(tentativeMessages) && tentativeMessages.length > 0) {
        parts.push(`## TENTATIVE — do not store facts from these (NEED planning context only):\n${tentativeMessages.map(renderMessageLine).join('\n\n')}`);
    }

    const extra = String(settings?.memoryPrompt || '').trim();
    if (extra) parts.push(`## Additional instructions from the user\n${extra}`);

    parts.push(extractOnly
        ? 'Work now: check the store with tools where needed, write the new lasting facts, then end with the #DONE line.'
        : 'Work now: check the store with tools where needed, write the new lasting facts, emit the NEED line, then end with #DONE.');

    try {
        const substitute = host.getSubstituteParams();
        return substitute(parts.join('\n\n'));
    } catch {
        return parts.join('\n\n');
    }
}

// NEED refs travel on Call A's final reply as a "NEED: Category/key, ..." line.
// Same ref grammar parseSheetBlock uses; tolerant of "none" and bullet prefixes.
function parseNeedRefs(text) {
    const need = [];
    for (const rawLine of String(text || '').split('\n')) {
        const m = /^\s*NEED\s*:\s*(.*)$/i.exec(rawLine.trim());
        if (!m) continue;
        for (const ref of m[1].split(',')) {
            const r = ref.trim().replace(/^[-*]\s*/, '');
            if (!r || /^\(?none\)?$/i.test(r)) continue;
            const slash = r.indexOf('/');
            if (slash <= 0) continue;
            const category = r.slice(0, slash).trim();
            const key = r.slice(slash + 1).trim();
            if (category && key) need.push({ category, key });
        }
    }
    return need;
}

// Prior summary fallback for a failed Call C: the previous sheet renders the
// agent's situational recap as a "Right now: <text>" line — recover it so the
// composed sheet keeps a summary instead of blanking it.
function extractPriorSummary(priorSheetText) {
    const m = /^\s*Right now:\s*(.+)$/im.exec(String(priorSheetText || ''));
    return m ? m[1].trim() : '';
}

// CALL B (BEATS): one batched single-shot call turning every newly-settled
// message into one terse past-tense beat, parsed back by its position number.
async function runBeatsCall({ settledMessages = [], profileId = null, runId = '', signal = null } = {}) {
    const out = { beats: [], tokensIn: 0, tokensOut: 0, error: null, durationMs: 0 };
    const msgs = (Array.isArray(settledMessages) ? settledMessages : []).filter(m => m && String(m?.text || '').trim());
    if (msgs.length === 0) return out;

    const start = Date.now();
    const numbered = msgs.map((m, i) => `${i + 1}. ${renderMessageLine(m)}`).join('\n');
    out.tokensIn = Math.ceil((DEFAULT_BEATS_PROMPT.length + numbered.length) / 4);
    let reply = '';
    try {
        reply = String(await callAgentLLM(DEFAULT_BEATS_PROMPT, numbered, profileId, 'beats', signal) || '');
    } catch (e) { reply = ''; out.error = String(e?.message || e); }
    out.tokensOut = Math.ceil(reply.length / 4);
    out.durationMs = Date.now() - start;
    if (!reply.trim()) {
        out.error = out.error || 'empty beats reply';
        addDebugLog('info', `[${runId}] Beats call returned nothing${out.error ? ` (${out.error})` : ''} — backfill will cover the ${msgs.length} settled message(s)`, {
            subsystem: 'agent3', event: 'agent3.beats', data: { settled: msgs.length, parsed: 0, error: out.error, durationMs: out.durationMs },
        });
        return out;
    }

    const byNumber = new Map();
    for (const line of reply.split('\n')) {
        const lm = /^\s*(\d+)\s*[.):]\s*(.+)$/.exec(line);
        if (lm) byNumber.set(parseInt(lm[1], 10), lm[2].replace(/\s+/g, ' ').trim());
    }
    msgs.forEach((m, i) => {
        const sentence = byNumber.get(i + 1);
        if (sentence && Number.isInteger(m.index)) {
            const beat = { msgIndex: m.index, sentence };
            if (m.uid) beat.uid = String(m.uid);
            out.beats.push(beat);
        }
    });
    addDebugLog('info', `[${runId}] Beats call: ${out.beats.length}/${msgs.length} settled message(s) got a beat (${out.durationMs}ms)`, {
        subsystem: 'agent3', event: 'agent3.beats', data: { settled: msgs.length, parsed: out.beats.length, durationMs: out.durationMs },
    });
    return out;
}

// CALL C (SHEET HEAD): one single-shot call producing SUMMARY / SCENE_MARKER /
// TIMELINE / PRESENT in the exact grammar parseSheetBlock reads. Input is small:
// character brief, the recent messages, the current scene card, and the prior
// head — never the whole store.
function buildHeadUserPrompt({
    settledMessages, tentativeMessages, characterInfo, userPersona,
    priorSheetText, reflection, observationDate,
}) {
    const parts = [];
    parts.push('## Task\nWrite the memory-sheet head (SUMMARY, optional SCENE_MARKER, TIMELINE, PRESENT) for the upcoming storyteller reply. Output only those lines.');
    if (observationDate) parts.push(`## Observation date: ${observationDate}`);
    if (characterInfo) parts.push(`## Character Info ({{char}})\n${characterInfo}`);
    if (userPersona) parts.push(`## User Persona ({{user}})\n${userPersona}`);

    const reflSummary = (reflection && typeof reflection.summary === 'string') ? reflection.summary.trim() : '';
    if (reflSummary) parts.push(`## Story so far (rolling reflection summary)\n${reflSummary}`);

    // Last few spine sentences: the deterministic arc, for continuity.
    try {
        const spine = getStorySpine();
        if (Array.isArray(spine) && spine.length > 0) {
            const tail = spine.slice(-4).map(b => String(b.sentence || '').trim()).filter(Boolean).join(' ');
            if (tail) parts.push(`## Recent story spine\n${tail}`);
        }
    } catch {  }

    // Current scene card (name + recent beats) — pre-Call-B state is fine.
    try {
        const scene = getCurrentScene();
        if (scene && (scene.name || (Array.isArray(scene.beats) && scene.beats.length > 0))) {
            const beatsArr = Array.isArray(scene.beats) ? scene.beats : [];
            const recent = beatsArr.slice(-8).map(b => String(b?.sentence || '').trim()).filter(Boolean);
            const body = [scene.name ? `Scene: ${scene.name}` : '', ...recent].filter(Boolean).join('\n');
            if (body) parts.push(`## Current scene card\n${body}`);
        }
    } catch {  }

    // Prior head fields, recovered from the previously rendered sheet / scene store.
    const priorSummary = extractPriorSummary(priorSheetText);
    let priorTimeline = '';
    try { priorTimeline = getSceneTimeline(); } catch { priorTimeline = ''; }
    let priorPresent = [];
    try { priorPresent = getScenePresent(); } catch { priorPresent = []; }
    const priorLines = [
        priorSummary && `SUMMARY: ${priorSummary}`,
        priorTimeline && `TIMELINE: ${priorTimeline}`,
        priorPresent.length > 0 && `PRESENT: ${priorPresent.join(', ')}`,
    ].filter(Boolean).join('\n');
    parts.push(`## Prior head (update it)\n${priorLines || '(none yet)'}`);

    if (Array.isArray(settledMessages) && settledMessages.length > 0) {
        // The recent settled tail carries the scene's current state (last ~8).
        parts.push(`## Recent settled messages\n${settledMessages.slice(-8).map(renderMessageLine).join('\n\n')}`);
    }
    if (Array.isArray(tentativeMessages) && tentativeMessages.length > 0) {
        parts.push(`## Tentative messages (may still change; use for framing the next beat)\n${tentativeMessages.map(renderMessageLine).join('\n\n')}`);
    }

    parts.push('Write the head now: SUMMARY, then SCENE_MARKER only if a new scene begins, then TIMELINE and PRESENT. Nothing else.');

    try {
        const substitute = host.getSubstituteParams();
        return substitute(parts.join('\n\n'));
    } catch {
        return parts.join('\n\n');
    }
}

async function runHeadCall({
    settledMessages = [], tentativeMessages = [], characterInfo = '', userPersona = '',
    priorSheetText = '', reflection = null, observationDate = '', profileId = null, runId = '', signal = null,
} = {}) {
    const out = { parsed: null, tokensIn: 0, tokensOut: 0, error: null, durationMs: 0 };
    const start = Date.now();
    const userPrompt = buildHeadUserPrompt({
        settledMessages, tentativeMessages, characterInfo, userPersona,
        priorSheetText, reflection, observationDate,
    });
    out.tokensIn = Math.ceil((DEFAULT_HEAD_PROMPT.length + userPrompt.length) / 4);
    let reply = '';
    try {
        reply = String(await callAgentLLM(DEFAULT_HEAD_PROMPT, userPrompt, profileId, 'sheet-head', signal) || '');
    } catch (e) { reply = ''; out.error = String(e?.message || e); }
    out.tokensOut = Math.ceil(reply.length / 4);
    out.durationMs = Date.now() - start;
    if (!reply.trim()) {
        out.error = out.error || 'empty head reply';
        addDebugLog('info', `[${runId}] Head call returned nothing${out.error ? ` (${out.error})` : ''} — keeping prior summary/timeline/present`, {
            subsystem: 'agent3', event: 'agent3.head', data: { error: out.error, durationMs: out.durationMs },
        });
        return out;
    }
    // parseSheetBlock understands SUMMARY/SCENE_MARKER/TIMELINE/PRESENT (and would
    // also accept BEAT/NEED — Call C emits neither). A parse "error" on a NON-empty
    // reply means the model returned prose with no usable header lines (refusal,
    // commentary): semantically a failed head call. Log it at fail level — Health
    // counts only fail entries — while the caller still falls back field-by-field.
    const parsed = parseSheetBlock(reply);
    out.parsed = parsed;
    if (parsed.error) {
        addDebugLog('fail', `[${runId}] Head call reply unparseable (${parsed.error}) — keeping prior summary/timeline/present. First 300 chars: ${reply.slice(0, 300)}`, {
            subsystem: 'agent3', event: 'agent3.head', reason: 'HEAD_UNPARSEABLE',
            data: { error: parsed.error, replyChars: reply.length, durationMs: out.durationMs },
        });
    }
    addDebugLog('info', `[${runId}] Head call: summary ${parsed.summary ? 'yes' : 'no'}, marker ${parsed.sceneMarker ? 'yes' : 'no'}, timeline ${parsed.timeline ? 'yes' : 'no'}, present ${parsed.present.length} (${out.durationMs}ms)`, {
        subsystem: 'agent3', event: 'agent3.head',
        data: { hasSummary: !!parsed.summary, hasMarker: !!parsed.sceneMarker, hasTimeline: !!parsed.timeline, present: parsed.present.length, durationMs: out.durationMs },
    });
    return out;
}

// BEAT coverage enforcement: Call B should emit one beat per settled message,
// but that is only prompt compliance. Repair net (unchanged from the pre-split
// design, now fed the Call B beats array directly):
//   1. Index-less beats are adopted onto the still-uncovered settled indices in
//      emission order — beats are emitted in message order, recovering the map.
//   2. Any settled message STILL without a beat gets ONE tiny dedicated LLM call
//      ("summarize this one message in one sentence"), capped per run.
const BEAT_BACKFILL_MAX = 6;

async function backfillMissingBeats({ beats: beatsArg, settledMessages = [], profileId = null, runId = '', signal = null } = {}) {
    const beats = Array.isArray(beatsArg) ? beatsArg : [];
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

// Scene-beat brevity: the sheet contract is ONE terse sentence per beat, but a
// misbehaving agent sometimes emits a whole paragraph as one BEAT line and it
// would pollute every future sheet via the scene card. Same pattern as the
// story spine: detect violators, make ONE batched rewrite call, and anything
// still over the cap afterwards is accepted as-is (never chopped) — truncating
// a sentence mid-thought would corrupt the scene card.
const BEAT_MAX_WORDS = 30;
const BEAT_MAX_CHARS = 300;
const BEAT_CAP_WORDS = 25;

function beatViolates(sentence) {
    const s = String(sentence || '').trim();
    if (!s) return false;
    return countSentenceEnds(s) > 1 || s.split(/\s+/).length > BEAT_MAX_WORDS || s.length > BEAT_MAX_CHARS;
}

async function enforceBeatBrevity(beats, profileId = null, runId = '', signal = null) {
    const violators = (Array.isArray(beats) ? beats : []).filter(b => beatViolates(b?.sentence));
    if (violators.length === 0) return;

    let rewrittenCount = 0;
    let reply = '';
    let callError = null;
    try {
        const numbered = violators
            .map((b, i) => `${i + 1}. ${String(b.sentence).replace(/\s+/g, ' ').trim()}`)
            .join('\n');
        reply = String(await callAgentLLM(
            `Each numbered line below is an over-long roleplay scene beat. Rewrite EACH line as EXACTLY ONE terse past-tense sentence (max ${BEAT_CAP_WORDS} words) keeping its meaning. Reply STRICTLY as the same numbered lines ("1. <sentence>") and nothing else.`,
            numbered, profileId, 'beat-brevity', signal,
        ) || '');
    } catch (err) { reply = ''; callError = err; }

    // callAgentLLM swallows transport/auth errors and returns '' — an empty reply
    // means the rewrite call itself produced nothing. That must surface at fail
    // level: the info summary below is identical whether the call died or the
    // rewrite output was merely rejected, and Health counts only 'fail' entries.
    if (!reply) {
        addDebugLog('fail', `[${runId}] Beat brevity rewrite call returned nothing${callError ? ` (${callError.message || callError})` : ''} — ${violators.length} over-long beat(s) kept as-is`, {
            subsystem: 'agent3', event: 'beat.brevity.call_failed',
            data: { violators: violators.length },
        });
    }

    if (reply) {
        const byNumber = new Map();
        for (const line of reply.split('\n')) {
            const lm = /^\s*(\d+)\s*[.):]\s*(.+)$/.exec(line);
            if (lm) byNumber.set(parseInt(lm[1], 10), lm[2].trim());
        }
        violators.forEach((b, i) => {
            const candidate = byNumber.get(i + 1);
            // The rewrite replaces the beat ONLY when it now passes the check.
            if (candidate && !beatViolates(candidate)) {
                b.sentence = candidate;
                rewrittenCount++;
            }
        });
    }

    // Beats still over the cap (or when the rewrite call failed) stay unchopped.
    const acceptedAsIsCount = violators.length - rewrittenCount;

    addDebugLog('info', `[${runId}] Beat brevity: ${violators.length} over-long beat(s) — ${rewrittenCount} rewritten, ${acceptedAsIsCount} accepted as-is (never chopped)`, {
        subsystem: 'agent3', event: 'beat.brevity',
        data: { violators: violators.length, rewritten: rewrittenCount, acceptedAsIs: acceptedAsIsCount },
    });
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
                // Reflection cold-tiered facts stay out of the floor — otherwise a
                // demoted-but-important-looking fact rides back in every single turn.
                if (fact.cold === true) continue;
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
