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
    deriveSubject,
} from './database.js';
import { tokenSet } from './tokenize.js';
import { isFactVisible, buildFactLine, randomWalkExtras } from './fact-retrieval.js';
import {
    getTurnNowContext, splitInjectionSections, buildPrecedencePreamble,
    STATE_SECTION_HEADER, CHRONO_SECTION_HEADER,
} from './recency.js';
import { callAgentLLMWithTools, callAgentLLM } from './llm-call.js';
import { countSentenceEnds } from './sentence-util.js';
import { executeMemoryTool, stripThinkBlocks } from './memory-tools.js';
import { getStorySpine, getCurrentScene, startScene, appendSceneBeats, setScenePresent, getScenePresent, getSceneTimeline, setSceneTimeline, getLastNeedRefs, setLastNeedRefs, getRecoveredRefs, tickRecoveredRefs, markRecoveredRefs } from './turn-state.js';
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
// A sheet carries PREMISE_FLOOR_MAX(15) + sticky recovered(<=12) + extras(<=8) +
// NEED rows, so the old cap of 40 truncated ordinary dense turns. That matters
// because a TRUNCATED list is exactly where "a ref MISSING from it was never
// shown" stops being true: the model would be told, falsely, that
// already-injected facts were fair game, recover them into NEED, grow the sheet
// and truncate even more. 80 makes truncation rare (worst case ~80 x 30 chars =
// 2.4 KB); when it still happens the section header says TRUNCATED and the
// prompt downgrades absence from proof-of-omission to "unknown".
//
// NEED_REFS_CAP below closes the feedback loop from the other end: 15 + 12 + 8 +
// NEED can no longer exceed this cap at all, so truncation now requires a store
// so large the FLOOR alone overflows it. Kept as two constants because they
// govern different things — this one bounds what the prompt can READ back out of
// a sheet, that one bounds what a single NEED line can PUT into one.
const INJECTED_REFS_CAP = 80;

// NEED is the one UNBOUNDED axis of the sheet. The premise floor is 15, the
// sticky recovered set is hard-capped at 12 in code (turn-state.js), extras at
// 8 — NEED is capped only by the prompt's "ONLY refs the NEXT reply will draw
// on", and round 2 now dangles up to CANDIDATE_FACTS_CAP attractive
// `Category/key = value` rows in front of the agent every full turn.
//
// This is a RUNAWAY GUARD, not a token budget, and the number is DERIVED rather
// than guessed: INJECTED_REFS_CAP(80) - floor(15) - sticky(12) - extras(8) = 45.
// That is the point where an oversized NEED stops being merely expensive and
// starts breaking a DIFFERENT feature: next turn extractPriorSheetRefs reads
// more refs out of the sheet than the cap admits, `## Injected last turn`
// renders [TRUNCATED], and the prompt has to downgrade "a ref MISSING from it
// was never shown" to "absence proves NOTHING" — i.e. a sweeping NEED line
// silently disables omission recovery. The failure shape that gets there is the
// re-listing sweep the prompt forbids: the task block shows up to
// KEY_INVENTORY_CAP(200) stored keys, and nothing in code stopped an agent from
// copying them onto the line.
//
// It is deliberately set far above ordinary use (a dense turn is reasoned to sit
// in the high teens / low twenties of NEED refs) so it does not shape normal
// behaviour, and it logs whenever it bites — the run log now carries needRefs so
// the real distribution becomes observable instead of assumed.
const NEED_REFS_CAP = 45;

// OMISSION-RECOVERY CANDIDATES — the values half of the backward-facing NEED job.
// The rest of Call A's prompt is ref-only: summarizeKeys emits `Category/key` and
// `## Injected last turn` emits refs, so a stored "always wants to go to
// Portugal" is invisible unless the word happens to sit inside the key. The
// agent was being asked to notice an omission it could not read. This block puts
// VALUES in front of it, scoped to the subjects the tentative reply actually
// names and excluding everything the sheet already carried — i.e. exactly the
// set an omission can come from.
//
// TOKEN MATH (this prompt runs every turn and is USER-message content, so it is
// NOT prefix-cached — only the system prompt is; see llm-call.js's cache.drift
// logging): 24 rows x (ref ~30 chars + separator + value <=70) = 2.4 KB worst
// case, ~1.3 KB typical, i.e. ~600 / ~330 tokens. Against a Call A prompt that
// already carries up to 200 key-inventory lines (~5 KB), the taxonomy menu
// (~1.5 KB) and the settled+tentative messages, that is roughly +8% typical.
// Rendering `## Injected last turn` with values instead would cost MORE (80 rows)
// and would still not show the omitted fact — by definition it is absent from
// that list. This is the cheaper and the only correct place to spend it.
const CANDIDATE_FACTS_CAP = 24;
const CANDIDATE_VALUE_CHARS = 70;

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

Write calls first (bare JSON, one per line), then on a FULL run ONE line, optionally followed by a RECOVERED line:

NEED: Category/key, Category/key, ...
RECOVERED: Category/key, ...

End your LAST reply with a line that is exactly \`#DONE\` (nothing else on it).
- NEED: ONLY refs the NEXT reply will draw on (VERIFIED via tools, never invented) — people present and their state, active relationships, open threads THIS scene touches. Do NOT re-list stable premise/identity facts (auto-injected — but see OMISSION RECOVERY); older facts can be NEEDed later; omit NEED when nothing beyond that is needed. Read tools in the final reply are ignored.
- OMISSION RECOVERY (look BACKWARD too): the TENTATIVE reply tagged \`<- OMISSION CHECK\` is the ONLY one the lists below describe. If it hedged, forgot or contradicted something that IS in the store but was NOT injected, put that ref on the RECOVERED line — it is added to NEED for you and stays injected for a few turns, so do not repeat it on NEED. \`## Injected last turn\` = what the sheet above that reply carried; \`## Store candidates\` = VALUES of nearby stored facts it does NOT cover — read that block before concluding a fumble had no fact behind it, and \`search\` the subject when neither block shows it. That list, not your judgement, decides what counts as auto-injected: a ref ON it is already covered, do NOT re-list it — EXCEPT one tagged \`(recovered)\`, which you MAY re-list while the fumble persists; a ref MISSING from it was never shown, so it is fair game however "stable" it looks. But if its header says UNCERTAIN or TRUNCATED, absence proves NOTHING — then recover only what a candidate row or a \`search\` confirms. Max 3 per turn, and only for a fumble you can POINT AT in that reply — never pre-emptively, never a re-listing sweep.
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
    // Identity of the record priorSheetText came from (snapshot copy, see
    // pipeline.js) plus the chat index of the newest message this run judges.
    // Together they let the omission-recovery list be VERIFIED rather than
    // assumed — see classifyPriorSheet.
    priorSheet = null,
    newestJudgedMessageIndex = -1,
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
    // The sticky recovered set as it stands BEFORE this run touches it — i.e. the
    // refs that were still being force-injected into the sheet the judged reply
    // saw. Used to tag them on the injected list (tagged refs are exempt from the
    // prompt's do-not-re-list rule) and re-added to the sheet at the bottom.
    let stickyRecovered = [];
    try { stickyRecovered = getRecoveredRefs(); } catch { stickyRecovered = []; }

    // Backward-facing NEED signal. Built ONCE here rather than inside the prompt
    // builder so the branch it took can be logged: whether the prior sheet is
    // provably the one that stood above the reply being judged decides whether
    // the prompt may speak about it in absolute terms at all.
    // Normalized the same way pipeline.js normalizes it before slicing the chat,
    // so classifyPriorSheet judges the value that actually produced the (empty)
    // tentative array rather than the raw stored one.
    const rawHoldBack = Number(settings?.bufferHoldBack);
    const holdBack = Number.isFinite(rawHoldBack) ? Math.min(10, Math.max(0, Math.floor(rawHoldBack))) : 4;

    const injectedSection = extractOnly ? null : buildInjectedRefsSection({
        priorSheetText, priorSheet, newestJudgedMessageIndex, tentativeMessages, stickyRecovered,
        bufferHoldBack: holdBack,
    });

    const extractPrompt = buildExtractionUserPrompt({
        settledMessages, tentativeMessages, characterInfo, userPersona,
        observationDate, extractOnly, databases, index, settings, injectedSection,
    });

    const injectedLastTurn = injectedSection ? injectedSection.refs.length : 0;

    if (injectedSection && injectedSection.status !== 'VERIFIED') {
        // Degraded honestly rather than silently: the list is still rendered (a
        // ref ON it is still evidence it was covered), but its header tells the
        // agent that ABSENCE from it proves nothing, and the prompt's absolutist
        // rule is suspended for this turn.
        addDebugLog('info', `[${runId}] Omission-recovery list degraded to ${injectedSection.status}: ${injectedSection.why}`, {
            subsystem: 'agent3', event: 'agent3.injected_refs', reason: injectedSection.reason,
            data: {
                status: injectedSection.status, why: injectedSection.why, bufferHoldBack: holdBack,
                refs: injectedSection.refs.length, truncated: injectedSection.truncated,
                sheetSourceMessageIndex: injectedSection.sheetSourceMessageIndex,
                newestJudgedMessageIndex: injectedSection.newestJudgedMessageIndex,
                sheetRunId: injectedSection.sheetRunId,
            },
        });
    }

    addDebugLog('info', `[${runId}] Extraction agent start: ${settledMessages.length} settled, ${tentativeMessages.length} tentative msg(s), extractOnly=${extractOnly}, injected-last-turn=${injectedLastTurn} ref(s) [${injectedSection ? injectedSection.status : 'SKIPPED'}], ${stickyRecovered.length} sticky recovered ref(s) (user prompt ${extractPrompt.length} chars)`, {
        subsystem: 'agent3', event: 'agent3.extract',
        data: {
            settled: settledMessages.length, tentative: tentativeMessages.length, extractOnly,
            userPromptChars: extractPrompt.length, injectedLastTurn,
            injectedStatus: injectedSection ? injectedSection.status : 'SKIPPED',
            injectedTruncated: injectedSection ? injectedSection.truncated : false,
            stickyRecovered: stickyRecovered.length,
            profileId: profileId || null,
        },
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
    // RECOVERED travels on the SAME reply as NEED — omission recoveries are a
    // separate line so the NEED grammar stays unchanged and so the two are
    // distinguishable: "not on last turn's sheet" describes almost every ordinary
    // NEED pick, so only an explicit marking can identify a backward-looking
    // recovery worth making sticky.
    let need = [];
    let recovered = [];
    if (!loop.error) {
        for (let i = (loop.transcript || []).length - 1; i >= 0; i--) {
            const r = stripThinkBlocks(String(loop.transcript[i]?.reply || ''));
            if (/^\s*(NEED|RECOVERED)\s*:/im.test(r)) {
                need = parseRefLine(r, 'NEED');
                recovered = parseRefLine(r, 'RECOVERED');
                break;
            }
        }
        // A recovered ref must be injected THIS turn too — the agent is told it
        // goes onto NEED automatically, so the sheet has to honour that.
        for (const r of recovered) {
            if (!need.some(n => n.category.toLowerCase() === r.category.toLowerCase() && n.key.toLowerCase() === r.key.toLowerCase())) need.push(r);
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
            // Sticky recovery bookkeeping, behind the same chat-switch guard so a
            // recovery can never be stamped into another chat's metadata. Tick
            // FIRST (age last turn's set), then mark (this turn's recoveries get
            // the full TTL, refreshing any that repeated). Skipped on a Call A
            // error: nothing was judged, so nothing should age.
            if (!loop.error) {
                try {
                    const expired = tickRecoveredRefs();
                    const marked = markRecoveredRefs(recovered);
                    stickyRecovered = getRecoveredRefs();
                    if (marked > 0 || expired > 0) {
                        addDebugLog('info', `[${runId}] Omission recovery: ${marked} ref(s) marked sticky, ${expired} expired, ${stickyRecovered.length} still held`, {
                            subsystem: 'agent3', event: 'agent3.recovered_refs',
                            data: { marked, expired, held: stickyRecovered.length, refs: stickyRecovered.map(r => `${r.category}/${r.key}`) },
                        });
                    }
                } catch (e) {
                    addDebugLog('fail', `[${runId}] Sticky recovered-ref bookkeeping failed (non-fatal): ${e?.message || e}`, {
                        subsystem: 'agent3', event: 'agent3.recovered_refs', reason: 'ERROR',
                    });
                }
            }
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
        recovered: stickyRecovered,
        settings,
        databases,
        runId,
    });

    addDebugLog('pass', `[${runId}] Memory Agent done: ${ctx.applied.length} write(s), ${loop.rounds} round(s), ${loop.toolCallCount} tool call(s), ${beats.length} beat(s), sheet ${result.sheetText.length} chars${result.extractionError ? ' (extraction FAILED — sheet refreshed, watermark held)' : ''}`, {
        subsystem: 'agent3', event: 'agent.run',
        data: {
            agent: 'memory-agent', profileId: profileId || null, success: true, extractOnly,
            applied: ctx.applied.length, rounds: loop.rounds, toolCallCount: loop.toolCallCount,
            beats: beats.length, sheetChars: result.sheetText.length,
            // Sheet SIZE was already recorded (here and on every injection), but
            // nothing recorded how many refs produced it — which is why
            // NEED_REFS_CAP had to be derived rather than fitted to data. These
            // two make the real distribution observable.
            needRefs: need.length, stickyRefs: stickyRecovered.length,
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

// Call A user prompt: store overview + tools context + the messages, plus the
// backward-facing pair — the flat ref list of what LAST turn's sheet actually
// injected, and the VALUES of the stored facts it did not cover. NO sheet PROSE
// and no SUMMARY/BEAT/TIMELINE framing — the extraction agent only writes facts
// and picks NEED; the sheet head/beats are separate fixed passes. Those two
// blocks are the backward half of the selection job: without the ref list the
// agent cannot tell an omission (fact in store, never injected, reply fumbled
// it) from a fact the reply simply chose not to use, and without the values it
// cannot tell what the fumble should have said.
function buildExtractionUserPrompt({
    settledMessages, tentativeMessages, characterInfo, userPersona,
    observationDate, extractOnly, databases, index, settings, injectedSection,
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

    // The injected-refs list describes ONE turn, but tentativeMessages carries
    // bufferHoldBack replies (default 4, up to 10) — only the NEWEST of them was
    // generated under the sheet that list came from. Tagging that one message is
    // what makes "the TENTATIVE reply" unambiguous; without it an omission
    // attributed to an older tentative reply is judged against the wrong list.
    if (Array.isArray(tentativeMessages) && tentativeMessages.length > 0) {
        const rendered = tentativeMessages.map(renderMessageLine);
        rendered[rendered.length - 1] += '\n<- OMISSION CHECK (only THIS reply ran under the sheet described below)';
        parts.push(`## TENTATIVE — do not store facts from these (NEED planning context only):\n${rendered.join('\n\n')}`);
    }

    // Backward-facing half of the NEED job — placed right after the TENTATIVE
    // reply the agent must diff it against; adjacency is what makes the check
    // happen. Skipped on EXTRACT-ONLY runs (no NEED line is produced, and
    // catch-up import fires hundreds of them), which is why the caller passes
    // null. The refs are parsed back out of the PRIOR sheet rather than read from
    // getLastNeedRefs() on purpose: the sheet is the only record that INCLUDES
    // the premise-floor rows and the random-walk extras, and that EXCLUDES NEEDed
    // refs composeSheet dropped as inactive/invisible — i.e. the only record of
    // what the storyteller actually saw. It also survives a prior-turn Call A
    // error, which getLastNeedRefs() does not (that write is skipped on error).
    // An empty list is stated explicitly; silence would read as "everything was
    // injected".
    if (injectedSection) {
        parts.push(`${injectedSection.header}\n${injectedSection.body}`);
        // The values block sits immediately after the ref list it complements:
        // the list says what WAS shown, this says what the same subjects have in
        // the store that was NOT. Omitted entirely when it would be empty.
        const candidates = buildRecoveryCandidates({
            tentativeMessages, databases, injectedRefs: injectedSection.refs,
        });
        if (candidates.length > 0) {
            parts.push(`## Store candidates (stored facts the list above does NOT cover, about who/what the OMISSION CHECK reply names — then, with whatever room is left, who/what the tentative replies just before it name, since a hedge often withholds the subject the reply BEFORE it introduced. VALUES shown; this is evidence for spotting an omission, not a NEED list)\n${candidates.join('\n')}`);
        }
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

// NEED refs travel on Call A's final reply as a "NEED: Category/key, ..." line,
// omission recoveries on an identical "RECOVERED: ..." line. Same ref grammar
// parseSheetBlock uses; tolerant of "none" and bullet prefixes.
function parseRefLine(text, header) {
    const re = new RegExp(`^\\s*${header}\\s*:\\s*(.*)$`, 'i');
    const need = [];
    for (const rawLine of String(text || '').split('\n')) {
        const m = re.exec(rawLine.trim());
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

// Every fact row a sheet renders comes from buildFactLine, whose three shapes all
// start `[knownBy] Category/key` and then diverge into `: note`, ` = value` or a
// bare recency tail — so one anchored regex recovers the exact ref set, floor and
// extras included, without composeSheet having to hand anything back.
//
// The grammar matches what the tokenizer and the category system ACTUALLY
// produce, which is wider than ASCII on both sides:
//   - keys come from keyToken (tokenize.js), `[^\p{L}\p{N}_]` stripped — so any
//     Unicode letter or digit is legal. `[A-Za-z0-9_]+` used to capture
//     'müller_job' as 'm', emitting the phantom ref People/m while the real ref
//     went missing and got re-NEEDed every turn. German/Japanese/Russian
//     roleplays hit this on essentially every fact.
//   - categories come from effectiveCategories() = L1_CATEGORIES + overlay
//     categories, and overlayCategories() applies NO character sanitization
//     beyond a trim — 'Ship Logs' and 'Faction2' are legal, so a single-word
//     ASCII class never matched a custom category at all.
// The category capture is therefore lazy and unrestricted, terminated by the
// FIRST `/` that is followed by a key and a real terminator (end, whitespace,
// `:`, `=` or the recency `(`). Categories never contain `/`, so the first such
// pair is always the ref; a slash later in a note or value cannot win. The
// sheet's other bracketed lines (header, precedence preamble) end at the `]`
// with nothing after it and so still never match. Deduped, order kept.
const SHEET_REF_RE = /^\[[^\]]*\]\s+(.+?)\/([\p{L}\p{N}_]+)(?=$|[\s:=(])/u;

function extractPriorSheetRefs(priorSheetText) {
    const out = [];
    const seen = new Set();
    for (const line of String(priorSheetText || '').split('\n')) {
        const m = SHEET_REF_RE.exec(line.trim());
        if (!m) continue;
        const category = m[1].trim();
        if (!category) continue;
        const ref = `${category}/${m[2]}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push(ref);
    }
    return out;
}

// Is the sheet priorSheetText came from PROVABLY the one that stood above the
// reply this run is judging? The pipeline reads the sheet before it writes the
// new one, so in the steady state it is — but the pipeline also runs BEHIND the
// chat (coalesced retries, a multi-minute tool loop, the whole computeCatchupLag
// machinery), and then a run can commit sheet S_k AFTER the user already
// generated the reply under S_(k-1). Asserting the identity instead of checking
// it inverts the whole feature: the prompt says "THAT LIST — not your judgement —
// decides", so a fact genuinely omitted from S_(k-1) that happens to appear in
// S_k becomes explicitly FORBIDDEN from being recovered, in exactly the lagging
// chats the feature was built for.
//
// The check: a sheet can only have stood above message J if it was composed when
// J did not yet exist, i.e. sourceMessageIndex < J. In the steady state the gap
// is 2 (one user message + one reply since the last run). The lag case collapses
// it to <= 0, because setMemorySheet stamps chat.length-1 AT COMMIT TIME, which
// by then already includes the reply being judged.
//
// Necessary, not sufficient: a run that commits INSIDE the generation window of
// reply J (after injection, before the reply lands) still stamps J-1 and passes.
// Distinguishing that would need the injection timestamp, which does not travel
// with the record. So VERIFIED means "not provably stale", and the prompt never
// claims more than the header says.
function classifyPriorSheet({ priorSheet, newestJudgedMessageIndex, hasTentative, bufferHoldBack = null }) {
    if (!priorSheet || priorSheet.seeded === true) {
        return { status: 'SEED', why: 'no composed sheet has ever existed in this chat' };
    }
    if (!hasTentative) {
        // bufferHoldBack = 0 makes this PERMANENT rather than a one-run gap:
        // pipeline.js starts its tentative scan at maxIdx + 1 = chat.length, so
        // the array is always empty, no reply is ever tagged `<- OMISSION CHECK`
        // and omission recovery never runs in any chat. The setting is reachable
        // from the slider (settings.js clamps to [0,10]), and the generic wording
        // — "this run" — reads as transient, which is how a permanently disabled
        // feature stayed invisible. Say which it is; the caller logs `why`.
        return bufferHoldBack === 0
            ? {
                status: 'NO_TARGET', reason: 'NO_TARGET_HOLDBACK_0',
                why: 'buffer hold-back is 0, so no reply is ever held tentative — OMISSION RECOVERY IS OFF for every run in every chat until the setting is raised (1+ holds the newest reply back for checking)',
            }
            : { status: 'NO_TARGET', why: 'no tentative reply this run — nothing was generated under this sheet to check' };
    }
    const src = Number.isInteger(priorSheet.sourceMessageIndex) ? priorSheet.sourceMessageIndex : -1;
    const judged = Number.isInteger(newestJudgedMessageIndex) ? newestJudgedMessageIndex : -1;
    if (src < 0 || judged < 0) {
        return { status: 'UNVERIFIABLE', why: `sheet source index ${src} / judged index ${judged} — origin unknown` };
    }
    if (src >= judged) {
        return { status: 'MISMATCH', why: `sheet was committed at message #${src}, which is not before the judged reply #${judged} — the reply ran under an OLDER sheet (pipeline lag)` };
    }
    return { status: 'VERIFIED', why: `sheet committed at message #${src}, judged reply #${judged}` };
}

// Renders the "## Injected last turn" section: header (which states exactly how
// much authority the list has), body, and the parsed refs for reuse by the
// candidates block. Degradation is in the HEADER rather than in omitting the
// section, because a ref that IS on the list remains useful evidence that it was
// covered even when the sheet's identity is uncertain — it is only the reverse
// direction ("missing, therefore never shown") that stops being sound.
function buildInjectedRefsSection({ priorSheetText, priorSheet, newestJudgedMessageIndex, tentativeMessages, stickyRecovered = [], bufferHoldBack = null }) {
    const refs = extractPriorSheetRefs(priorSheetText);
    const hasTentative = Array.isArray(tentativeMessages) && tentativeMessages.length > 0;
    const { status, reason, why } = classifyPriorSheet({ priorSheet, newestJudgedMessageIndex, hasTentative, bufferHoldBack });
    const truncated = refs.length > INJECTED_REFS_CAP;

    // Sticky recoveries are tagged in place: they ARE on the list (they were
    // force-injected), but the prompt exempts a tagged ref from the do-not-
    // re-list rule so a fumble that keeps recurring can keep its fact.
    const sticky = new Set((Array.isArray(stickyRecovered) ? stickyRecovered : [])
        .map(r => `${String(r?.category || '').toLowerCase()}/${String(r?.key || '').toLowerCase()}`));
    const rendered = refs.map(ref => sticky.has(ref.toLowerCase()) ? `${ref} (recovered)` : ref);

    let header;
    switch (status) {
        case 'SEED':
            header = '## Injected last turn — NONE YET (no sheet had been built in this chat, so omission recovery does not apply this turn)';
            break;
        case 'NO_TARGET':
            header = '## Injected last turn — NO OMISSION CHECK TARGET this run (no tentative reply ran under this sheet); listed for context only';
            break;
        case 'MISMATCH':
            header = '## Injected last turn — UNCERTAIN (this sheet was rebuilt at or after the OMISSION CHECK reply, so it is NOT the sheet that stood above it; a ref MISSING below proves NOTHING)';
            break;
        case 'UNVERIFIABLE':
            header = '## Injected last turn — UNCERTAIN (this sheet\'s origin could not be confirmed against the OMISSION CHECK reply; a ref MISSING below proves NOTHING)';
            break;
        default:
            // FINDING A: the old header pointed at "the sheet above the reply" as
            // if it were in this prompt. It is not — buildExtractionUserPrompt
            // deliberately carries no sheet prose. Say so.
            header = '## Injected last turn (every memory the sheet above the OMISSION CHECK reply carried — that sheet\'s prose is NOT in this prompt, only its fact refs)';
            break;
    }
    if (truncated) header += ' [TRUNCATED]';

    const body = rendered.length > 0
        ? capLines(rendered.join('\n'), INJECTED_REFS_CAP, 'sheet was longer — the rest is UNKNOWN, not omitted')
        : '(nothing)';

    return {
        // `reason` refines `status` for the log only — the header switch above and
        // the prompt both key off `status`, which stays a closed set.
        status, reason: reason || status, why, refs, truncated, header, body,
        sheetSourceMessageIndex: Number.isInteger(priorSheet?.sourceMessageIndex) ? priorSheet.sourceMessageIndex : -1,
        newestJudgedMessageIndex: Number.isInteger(newestJudgedMessageIndex) ? newestJudgedMessageIndex : -1,
        sheetRunId: String(priorSheet?.runId || ''),
    };
}

function clipText(s, max) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// The values block. Candidates are stored facts that (a) are about a subject the
// tentative window actually names and (b) were NOT on the injected list —
// which is precisely the set an omission can be drawn from. Anything the sheet
// already carried is excluded: showing it again would only spend tokens telling
// the agent what it can already read on the list above.
//
// SCOPE — two TIERS, not one haystack. The OMISSION CHECK reply (the newest
// tentative message, the only one the injected list describes) governs: its
// subjects fill the cap first. The older tentative replies are a FALLBACK tier
// that only spends slots the target reply left over, because a fumble's SUBJECT
// is frequently named a reply or two earlier — "she just shrugged when he asked
// where she'd go" names nobody, and the reply before it named Monika. Scoping
// strictly to the tagged reply (F10's fix, applied literally) would lose exactly
// that case, which is the common shape of a hedge.
//
// A flat haystack over all tentative messages is NOT equivalent to the fallback
// tier, which is why the previous scoping was wrong rather than merely loosely
// described: selection is round-robin ACROSS subjects, so at bufferHoldBack = 10
// the nine replies the injected list does not describe contribute nine replies'
// worth of subjects, and the target reply's own facts get pushed down to one row
// each. Tiering keeps the recall of the wide window with the ranking of the
// narrow one.
//
// Subject scoping is what keeps this affordable. deriveSubject() is the same
// grouping key the store itself uses, and tokenSet() is the same Unicode-aware
// tokenizer the retrieval path uses — so a German/Japanese subject matches as
// readily as an ASCII one. The speaker NAME is folded into the haystack because
// a character's own reply usually mentions everyone EXCEPT the speaker, and the
// speaker is the likeliest subject of a fumble about themselves.
//
// Selection is round-robin ACROSS subjects rather than a flat importance sort:
// with several characters on stage a flat sort lets the best-documented one eat
// the whole cap, and the omission is as likely to be about the quiet one. Within
// a subject, importance then recency — the load-bearing facts first.
function buildRecoveryCandidates({ tentativeMessages, databases, injectedRefs = [] }) {
    try {
        const msgs = Array.isArray(tentativeMessages) ? tentativeMessages : [];
        if (msgs.length === 0) return [];
        const textOf = (m) => `${String(m?.name || '')} ${String(m?.text || '')}`;
        // The LAST tentative message is the one buildExtractionUserPrompt tags
        // `<- OMISSION CHECK`; keep the two in step.
        const spokenTarget = tokenSet(textOf(msgs[msgs.length - 1]), { min: 2 });
        const spokenNearby = tokenSet(msgs.slice(0, -1).map(textOf).join(' '), { min: 2 });
        if (spokenTarget.size === 0 && spokenNearby.size === 0) return [];

        const injected = new Set((Array.isArray(injectedRefs) ? injectedRefs : []).map(r => String(r).toLowerCase()));
        const bySubject = new Map();

        for (const [rawCat, db] of Object.entries(databases || {})) {
            if (!db || !Array.isArray(db.facts)) continue;
            const category = mapLegacyCategory(String(rawCat || '').trim() || 'Unsorted');
            for (const fact of db.facts) {
                if (!fact || !isActiveFact(fact) || !isFactVisible(fact)) continue;
                // Cold-tiered facts are demoted on purpose — reflection or a
                // #CONFLICT verdict put them there. Offering them as recovery
                // candidates would hand the agent a route to re-promote them.
                if (fact.cold === true) continue;
                const value = String(fact.value ?? '').trim();
                const note = (typeof fact.context === 'string') ? fact.context.trim() : '';
                if (!value && !note) continue;
                if (injected.has(`${category}/${fact.key}`.toLowerCase())) continue;
                const subject = String(deriveSubject(fact) ?? '').trim();
                if (!subject) continue;
                // Tier 0 = named in the OMISSION CHECK reply, tier 1 = named only
                // in an earlier tentative reply. Scan every token before settling:
                // a target hit anywhere outranks a nearby hit.
                let tier = -1;
                for (const t of tokenSet(subject, { min: 2 })) {
                    if (spokenTarget.has(t)) { tier = 0; break; }
                    if (tier < 0 && spokenNearby.has(t)) tier = 1;
                }
                if (tier < 0) continue;
                const bucket = subject.toLowerCase();
                let entry = bySubject.get(bucket);
                if (!entry) { entry = { tier, list: [] }; bySubject.set(bucket, entry); }
                // deriveSubject can group two facts under one subject via
                // different tokens; the better tier wins for the whole bucket.
                else if (tier < entry.tier) entry.tier = tier;
                // Value wins over note here, deliberately diverging from
                // buildFactLine (which shows the note INSTEAD of the value): the
                // atomic value is the thing a hedging reply failed to say, and it
                // is what makes "Portugal" appear in this prompt at all.
                entry.list.push({
                    fact, category,
                    line: value
                        ? `${category}/${fact.key} = ${clipText(value, CANDIDATE_VALUE_CHARS)}`
                        : `${category}/${fact.key}: ${clipText(note, CANDIDATE_VALUE_CHARS)}`,
                });
            }
        }
        if (bySubject.size === 0) return [];

        for (const entry of bySubject.values()) {
            entry.list.sort((a, b) => {
                const impDiff = clampImportance(b.fact.importance) - clampImportance(a.fact.importance);
                if (impDiff !== 0) return impDiff;
                return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
            });
        }

        // Tier 0 exhausts its round-robin before tier 1 gets a slot, so the
        // fallback window can only ever use headroom the check reply left.
        const out = [];
        for (const tier of [0, 1]) {
            const buckets = [...bySubject.values()].filter(e => e.tier === tier).map(e => e.list);
            if (buckets.length === 0) continue;
            for (let depth = 0; out.length < CANDIDATE_FACTS_CAP; depth++) {
                let placedAny = false;
                for (const list of buckets) {
                    if (depth >= list.length) continue;
                    out.push(list[depth].line);
                    placedAny = true;
                    if (out.length >= CANDIDATE_FACTS_CAP) break;
                }
                if (!placedAny) break;
            }
            if (out.length >= CANDIDATE_FACTS_CAP) break;
        }
        return out;
    } catch {
        // Evidence is an optimisation, never a precondition — a broken store
        // shape must not cost the run its extraction.
        return [];
    }
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

function composeSheet({ summary = '', sceneLine = '', timeline = '', need = [], recovered = [], settings = {}, databases = {}, runId = '' } = {}) {
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

    // NEED rows, then the STICKY RECOVERED rows. Recovered refs are re-added for
    // RECOVERED_REF_TTL_TURNS turns whether or not this turn's NEED picked them
    // up again: a ref recovered because a reply fumbled it used to survive
    // exactly one turn, after which the prompt's "already on the injected list,
    // do NOT re-list it" rule dropped it and the identical fumble could recur.
    // Resolution and de-dup run through the same `seen` set as the floor, so a
    // ref that is both costs one row.
    //
    // COLD is checked here alongside active/visible, and it is the check that
    // does the work: `active === false` is a tombstone almost nothing sets, while
    // cold-tiering is the one demotion this codebase actually performs (a
    // #CONFLICT loser, a merge loser, a salience-overflow demotion). Without it a
    // sticky recovered ref OUTLIVES the demotion by up to RECOVERED_REF_TTL_TURNS
    // turns: the sheet keeps rendering the losing value under a header that calls
    // it "established truth for this scene", directly beside the record that beat
    // it. Same rule the premise floor above and buildRecoveryCandidates already
    // apply.
    //
    // Cold refs are SKIPPED each turn, not evicted from the sticky set, because
    // cold is reversible: uncoldFact fires when a fact is updated or re-mentioned
    // (database.js) and coldTierOverflow reactivates one that rises back into the
    // hot set. A ref that goes cold and hot again inside its TTL therefore
    // resumes being injected, which is the outcome the fumble wanted. Eviction
    // would make a transient demotion permanent, and would need a new mutator in
    // turn-state.js; a skipped entry is inert, holds one of the twelve sticky
    // slots and expires on its own tick.
    let coldSkipped = 0;
    const resolveRefs = (refs) => {
        const out = [];
        for (const ref of (Array.isArray(refs) ? refs : [])) {
            try {
                const category = mapLegacyCategory(String(ref?.category || '').trim() || 'Unsorted');
                const key = String(ref?.key || '').trim();
                if (!key) continue;
                const db = databases[category];
                if (!db) continue;
                const fact = findFactMatch(db, key);
                if (!fact || !isActiveFact(fact) || !isFactVisible(fact)) continue;
                if (fact.cold === true) { coldSkipped++; continue; }
                const id = `${category}:${fact.key}`;
                // Claimed in `seen` at RESOLVE time so a duplicate ref, or one the
                // premise floor already carries, cannot consume a NEED cap slot.
                if (seen.has(id)) continue;
                seen.add(id);
                out.push({ fact, category });
            } catch {  }
        }
        return out;
    };

    let needRows = resolveRefs(need);
    const stickyRows = resolveRefs(recovered);

    let needDropped = 0;
    if (needRows.length > NEED_REFS_CAP) {
        // Degrade by dropping the LEAST load-bearing rows, never by truncating
        // the line at an arbitrary point: rank a COPY by the comparator the
        // premise floor uses (importance, then last sighting), keep the top
        // NEED_REFS_CAP, and emit the survivors in the agent's ORIGINAL order so
        // row order is untouched in every case where the cap does not bite. The
        // sticky set is capped in turn-state.js and is never trimmed here — it is
        // the deliberately-chosen backward-looking pick, not the sweep.
        // A dropped row keeps its claim on `seen`, so the random-walk extras
        // below cannot quietly re-admit a row the cap just decided to shed.
        const keep = new Set([...needRows]
            .sort((a, b) => {
                const impDiff = clampImportance(b.fact.importance) - clampImportance(a.fact.importance);
                if (impDiff !== 0) return impDiff;
                return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
            })
            .slice(0, NEED_REFS_CAP));
        needDropped = needRows.length - keep.size;
        needRows = needRows.filter(r => keep.has(r));
    }

    for (const { fact, category } of [...needRows, ...stickyRows]) {
        rows.push({ fact, category, tier: 'primary' });
    }

    const logTag = runId ? `[${runId}] ` : '';
    if (coldSkipped > 0) {
        addDebugLog('info', `${logTag}Sheet: ${coldSkipped} NEED/recovered ref(s) skipped — cold-tiered since they were selected`, {
            subsystem: 'agent3', event: 'sheet.refs_skipped', reason: 'COLD_TIERED',
            data: { skipped: coldSkipped },
        });
    }
    if (needDropped > 0) {
        addDebugLog('info', `${logTag}Sheet: NEED cap hit — ${needRows.length + needDropped} resolvable ref(s), kept the ${needRows.length} most load-bearing, dropped ${needDropped}`, {
            subsystem: 'agent3', event: 'sheet.need_capped', reason: 'NEED_CAP',
            data: { resolved: needRows.length + needDropped, kept: needRows.length, dropped: needDropped, cap: NEED_REFS_CAP },
        });
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
