import {
    getAllDatabases,
    getMemoryIndex,
    saveDatabase,
    findFactMatch,
    mapLegacyCategory,
    isActiveFact,
    isBudgetCold,
    clampImportance,
    summarizeKeys,
    summarizeMenuIndexed,
    groupedTaxonomyMenu,
    deriveSubject,
    normalizeKind,
    effectiveRecencyTs,
    resolveCharacterToken,
    setSheetSupplyRefs,
    reconcileColdTier,
    coldTierCensus,
    PREMISE_FLOOR_SETTING_KEY,
    PREMISE_FLOOR_UNLIMITED,
    PREMISE_FLOOR_MIN,
    PREMISE_FLOOR_SLIDER_MAX,
    PREMISE_FLOOR_DEFAULT,
    resolvePremiseFloorCap,
} from './database.js';
import { tokenSet, cleanWord, isCapitalizedWord } from './tokenize.js';
import { isFactVisible, buildFactLine, randomWalkExtras } from './fact-retrieval.js';
import {
    getTurnNowContext, splitInjectionSections, buildPrecedencePreamble,
    STATE_SECTION_HEADER, RESOLVED_SECTION_HEADER, CHRONO_SECTION_HEADER,
    resolveSheetBudget,
} from './recency.js';
import { callAgentLLMWithTools, callAgentLLM } from './llm-call.js';
import { countSentenceEnds, extractSentenceLine, clipAtSentenceBoundary } from './sentence-util.js';
import { executeMemoryTool, stripThinkBlocks } from './memory-tools.js';
import { getStorySpine, getSummaryPyramid, getCurrentScene, getClosedScenes, startScene, appendSceneBeats, setScenePresent, getScenePresent, getSceneTimeline, setSceneTimeline, getLastNeedRefs, setLastNeedRefs, getRecoveredRefs, tickRecoveredRefs, markRecoveredRefs } from './turn-state.js';
import { addDebugLog, isTraceRecording, traceCapture, newTraceCallId } from './settings.js';
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
// ===========================================================================
// PREMISE FLOOR CAP — a user setting, not a constant.
//
// The constants and the resolver MOVED to database.js and are re-exported here
// unchanged, so settings.js and every other importer keeps its existing import.
// They had to move because database.js's coldTierOverflow() derives the hot-set
// budget from this cap and is synchronous on the save path — see the HOT_SET_MIN
// block there for why a second hand-copied constant was the bug.
//
// Why the default was moved 15 -> 50: measured against the 33 sheets and 65
// facts of the v0.81.0 export, a cap of 15 puts 46% of the store on the sheet
// on average and 29% by message 77; 50 reaches 95% / 83%. 15 was not a budget,
// it was the reason the sheet stopped tracking the store at message 21.
// Why it is now 30: that 50 was chosen for a 65-fact store. On the 469-fact
// 0.83.0 150-turn runs it rendered 47-51 CURRENT STATE rows of 304-317 chars
// (14-16 k chars) plus 20-22 CHRONOLOGY rows (6.8 k) every turn — coverage of
// a store that size is not something a row count can buy. The sheet is now
// bounded by a char budget per section (recency.js SHEET_BUDGET_*), supply
// rows render compact, and 30 rows is the pool the budget fills from.
// See estimatePremiseFloorCost() for what any given cap costs at THIS store.
export {
    PREMISE_FLOOR_SETTING_KEY,
    PREMISE_FLOOR_UNLIMITED,
    PREMISE_FLOOR_MIN,
    PREMISE_FLOOR_SLIDER_MAX,
    PREMISE_FLOOR_DEFAULT,
    resolvePremiseFloorCap,
};

// The other two per-sheet row sources, restated here because the injected-refs
// cap below is DERIVED from them and a stale copy would silently re-open the
// truncation hole: sticky recovered is RECOVERED_REFS_MAX in turn-state.js
// (RECOVERED_REF_TTL_TURNS 4 x RECOVERED_REFS_PER_TURN 3), extras is the
// graphExtrasCount slider's ceiling as clamped in composeSheet.
const STICKY_REFS_MAX = 12;
const GRAPH_EXTRAS_MAX = 8;

// A sheet carries premise floor + sticky recovered(<=12) + extras(<=8) + NEED
// rows, and the "## Injected last turn" list must be able to hold ALL of them.
// That matters because a TRUNCATED list is exactly where "a ref MISSING from it
// was never shown" stops being true: the model would be told, falsely, that
// already-injected facts were fair game, recover them into NEED, grow the sheet
// and truncate even more. When it still happens the section header says
// TRUNCATED and the prompt downgrades absence from proof-of-omission to
// "unknown".
//
// This used to be the constant 80, sized for a floor of 15. With the floor under
// user control that constant becomes a trap: a floor of 100 would overflow it
// every turn and turn omission recovery off without saying so. Derived instead,
// and UNBOUNDED under UNLIMITED — a list that cannot be truncated is the whole
// point, and the prompt cost of that choice is the user's, stated in the
// settings estimate rather than silently taken back here.
// Split so the cost readout can price a cap the user is DRAGGING TOWARDS rather
// than the one currently stored — same formula, one definition.
function injectedRefsCapFor(resolved) {
    if (resolved.unlimited) return Infinity;
    return resolved.cap + STICKY_REFS_MAX + GRAPH_EXTRAS_MAX + NEED_REFS_CAP;
}
function injectedRefsCap(settings) {
    return injectedRefsCapFor(resolvePremiseFloorCap(settings));
}

// NEED is the one UNBOUNDED axis of the sheet. The premise floor is a user
// setting, the sticky recovered set is hard-capped at 12 in code
// (turn-state.js), extras at 8 — NEED is capped only by the prompt's "ONLY refs
// the NEXT reply will draw on", and round 2 now dangles up to
// CANDIDATE_FACTS_CAP attractive `Category/key = value` rows in front of the
// agent every full turn.
//
// This is a RUNAWAY GUARD, not a token budget. It used to be derived FROM the
// injected-refs cap (80 - floor 15 - sticky 12 - extras 8 = 45); now that the
// floor is a slider the dependency runs the other way and 45 is the independent
// number, with injectedRefsCap() sized to fit it. The guard still marks the same
// point: where an oversized NEED stops being merely expensive and starts
// breaking a DIFFERENT feature — next turn extractPriorSheetRefs reads more refs
// out of the sheet than the cap admits, `## Injected last turn` renders
// [TRUNCATED], and the prompt has to downgrade "a ref MISSING from it was never
// shown" to "absence proves NOTHING" — i.e. a sweeping NEED line silently
// disables omission recovery. The failure shape that gets there is the
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

// FORCED STATE RECHECK — the caps.
//
// The defect this exists for: the agent MAY update a state, so when it is unsure
// it does nothing, and nothing forces a verdict. In the analysed run a character
// removed her chest binding in message #23, three passes noticed it in their own
// reasoning (one wrote verbatim "she removed her binding but hasn't decided to
// abandon it permanently, so I won't overwrite naoto_binds_chest") and none
// wrote — so "Chest binding beneath dress shirt, too tight across ribs" kept
// shipping under the header "CURRENT STATE — absolute truth" for 14 of 15 turns,
// beside a Right-now line describing her bare sternum.
//
// STATE_RECHECK_MAX = 8 rows per turn. Sheets in that run carried 11-26 fact
// rows, nearly all of them in the STATE section (kind collapsed to 'trait', so
// CHRONOLOGY held 1-2). Eight covers a third of the largest observed sheet for
// <=1.6 KB of USER prompt and eight output lines. It is deliberately NOT
// "every row": a long mandatory checklist is answered by rubber-stamping
// UNCHANGED, which is the same silence in a costlier format, and an uncapped
// list grows with the store — the exact axis the scale analysis flags.
//
// STATE_SUPERSEDE_MAX = 3 WRITES per turn, and this is the anti-reflex guard.
// Two newly-settled messages cannot legitimately overturn more than a handful of
// durable states; the measured true rate is ~1 stale row in 15 turns. Three is
// already 3x anything observed and mirrors the RECOVERED line's own "Max 3 per
// turn". It logs when it bites, so if the number is wrong the run log says so
// instead of the cap silently shaping behaviour.
const STATE_RECHECK_MAX = 8;
const STATE_SUPERSEDE_MAX = 3;
// RESOLVED — the third verdict, and the lifecycle SUPERSEDE cannot express. In
// the analysed run reflection-written trait rows (People/chloe_distrusts_kindness)
// shipped as "true RIGHT NOW" long after the narrative had worked the conflict
// through: SUPERSEDE was the wrong tool (there is no replacement value — the
// trait was not falsified, its tension was settled) so the run logged 0
// SUPERSEDEs and the model re-litigated the same conflict endlessly. RESOLVED
// keeps the fact stored and injected (the model still needs it as background)
// but moves it out of CURRENT STATE. Same anti-reflex cap as SUPERSEDE: mass-
// resolving the checklist would be silence in a new costume.
const STATE_RESOLVE_MAX = 3;
// The recheck ranking's tiebreak sorts rows WITHOUT validAt last ("unknown age
// is not evidence of staleness") — correct for dated rows, but reflection-
// written traits have no validAt at all, and in a solo scene scores cluster
// (the subject leaks into every row via the key, so many rows share exactly one
// token with the messages and tie). A validAt-less trait therefore lost every
// tie and could sit below the 8-row cap for the whole chat: never asked, never
// resolvable. This quota guarantees the best-scoring validAt-less rows up to
// this many of the STATE_RECHECK_MAX slots — only when they scored at all, so
// the "no shared token, no question" rule still holds.
const STATE_RECHECK_NOVALIDAT_MIN = 2;
// resolvedNote is evidence, not prose storage — clipped like the recheck feed
// lines are, so a rambling verdict cannot grow the sheet row unboundedly.
const RESOLVED_NOTE_CHARS = 160;
// Rows are fed VERBATIM as the sheet rendered them (knownBy prefix and recency
// tail included — how old a claim is, is evidence about it). The longest row in
// the analysed run was 280 chars; the clip only bounds the pathological case.
const STATE_RECHECK_LINE_CHARS = 200;

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

export const DEFAULT_MEMORY_AGENT_PROMPT = `You are the EXTRACTION AGENT for a roleplay between {{user}} (human) and {{char}} (AI character), running in the BACKGROUND after each reply. TWO jobs in one tool session: EXTRACT — store new LASTING facts from the SETTLED messages; SELECT — list the STORED memories the NEXT storyteller reply needs on a NEED line. Sheet, beats and timeline are separate passes. Only outputs: tool calls, a NEED line, STATE verdicts, #DONE.

# TOOL PROTOCOL (plain text — no function-call API)

Each tool call is ONE line of strict JSON, alone on its line:
{"tool":"list_categories"}
{"tool":"list_keys","args":{"category":"People"}}
{"tool":"read_facts","args":{"category":"People","keys":["monika_name","monika_mood"]}}
{"tool":"write_fact","args":{"category":"People","key":"monika_mood","value":"...","note":"...","known_by":["Monika"],"aspect":"mood","importance":3}}
{"tool":"search","args":{"query":"who owns the bakery"}}
{"tool":"add_alias","args":{"name":"Trish","alias":"Trish Mitchells"}}
{"tool":"link_facts","args":{"from":"Events:tom_affair_jessica","to":"Events:jessica_visit_awkward","reason":"explains why the visit was awkward"}}

The system replies with one "TOOL RESULTS:" message; then call more tools or finish. Several lines per reply are fine; no markdown fences, no multi-line JSON. Stop after your tool-call lines — never write TOOL RESULTS or a user turn yourself.
- add_alias: two names = SAME character. Before writing a seemingly NEW character, search their first name; if stored under an older name, add_alias and reuse the EXISTING key prefix.
- link_facts: link two STORED facts ("Category:key" refs VERIFIED via tools, never guessed) when a NEW fact retroactively explains an OLD one, as in the example above (new affair fact explains the old awkward visit). Max 5 links per fact; re-linking is a no-op.

HARD LIMITS: at most 8 rounds and 24 tool calls per session. LIGHT turn (small talk): one read round, then the final reply. DENSE turn (new character, backstory, secret, contradiction): spend extra rounds; check BEFORE writing — "Maria likes apples" → search "maria food" first; write into the existing preference key, don't duplicate.

# FINAL REPLY

Write calls first (bare JSON, one per line), then on a FULL run ONE NEED line, optionally a RECOVERED line, then one STATE verdict per listed ref (see STATE RECHECK):

NEED: Category/key, Category/key, ...
RECOVERED: Category/key, ...

End your LAST reply with a line that is exactly \`#DONE\` (nothing else on it).
- NEED: ONLY refs the NEXT reply will draw on (VERIFIED via tools, never invented) — people present and their state, active relationships, open threads THIS scene touches. Do NOT re-list stable premise/identity facts (auto-injected — but see OMISSION RECOVERY); older facts can be NEEDed later; omit NEED when nothing beyond that is needed. Read tools in the final reply are ignored.
- OMISSION RECOVERY (look BACKWARD too): the TENTATIVE reply tagged \`<- OMISSION CHECK\` is the ONLY one the lists below describe. If it hedged, forgot or contradicted something that IS in the store but was NOT injected, put that ref on the RECOVERED line — it is added to NEED for you and stays injected for a few turns, so do not repeat it on NEED. \`## Injected last turn\` = what the sheet above that reply carried; \`## Store candidates\` = VALUES of nearby stored facts it does NOT cover — read that block before concluding a fumble had no fact behind it, and \`search\` the subject when neither block shows it. That list, not your judgement, decides what counts as auto-injected: a ref ON it is already covered, do NOT re-list it — EXCEPT one tagged \`(recovered)\`, which you MAY re-list while the fumble persists; a ref MISSING from it was never shown, so it is fair game however "stable" it looks. But if its header says UNCERTAIN or TRUNCATED, absence proves NOTHING — then recover only what a candidate row or a \`search\` confirms. Max 3 per turn, and only for a fumble you can POINT AT in that reply — never pre-emptively, never a re-listing sweep.
- EXTRACT-ONLY runs (task block says so): no NEED line, no STATE verdicts — writes, then \`#DONE\`.

# STATE RECHECK

\`## State lines up for recheck\` in the task block lists CURRENT STATE rows the sheet is still injecting as present-tense truth. Give EVERY listed ref one verdict:

STATE: Category/key | UNCHANGED
STATE: Category/key | SUPERSEDE | <what is true NOW — self-contained, replaces the whole row>
STATE: Category/key | RESOLVED | <where the story settled it, in the SETTLED message's own words>

UNCHANGED is the default. SUPERSEDE needs a SETTLED message that makes the row false — pointable evidence, never inference; a TENTATIVE reply may inform the verdict but never justifies one, and this is CHECKED: write the replacement in the SETTLED message's own words, because a SUPERSEDE sharing no content word with the SETTLED text is refused and the stale row stands. Reversible ("she may put it back on") is still SUPERSEDE: the row claims the present, so it must describe the present. RESOLVED is for a row whose tension the story has WORKED THROUGH — the conflict was confronted, answered or laid to rest on-screen, so the row is true background but no longer the live situation; the fact is KEPT (not replaced — no new value needed, lower bar than SUPERSEDE) and stops being presented as present-tense truth. Still needs pointable SETTLED evidence: the third field quotes the settling moment. Max 3 SUPERSEDE and 3 RESOLVED per turn; a ref not on the list is ignored.

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
//
// HEAD CAPS. The "Right now:" line is fed back to the next run as "Prior head
// (update it)", and a capable model UPDATES by accreting: measured on the
// 0.83.0 long run the summary averaged 1 347 chars of scene prose (4-9
// sentences, gestures and quotes included) and TIMELINE grew from 121 to 405
// chars — every turn paid for the whole thing twice (head call in, sheet
// injection out) and the storyteller read a recap that retold the scene it was
// about to continue. The prompt now states the shape; runHeadCall enforces it
// with one condensing re-ask and, failing that, a clip at a sentence boundary.
// 450 chars is ~70 words of plain statements with room for a long name or two;
// 200 chars holds a date, a place and a relationship span with nothing else.
export const SUMMARY_MAX_SENTENCES = 3;
export const SUMMARY_MAX_CHARS = 450;
export const TIMELINE_MAX_CHARS = 200;
export const DEFAULT_HEAD_PROMPT = `You write the HEAD of a roleplay memory sheet from the given brief, messages, scene card and prior head. Output EXACTLY these lines and nothing else:

SUMMARY: <2-3 plain sentences (≤ 70 words): where they are, what is unresolved, what the next beat hinges on. No scenery, no quotes, no gestures, no prose.>
SCENE_MARKER: <startMsgIndex> | <2-5 word scene name>
TIMELINE: <ONE line: in-story date/time; place; how long the mains have known each other — nothing else>
PRESENT: <comma-separated names of everyone physically in the scene, e.g. "Maria, Tom">

SUMMARY is REQUIRED; TIMELINE almost always. SUMMARY is a FRESH recap for the UPCOMING beat — re-write it for where the story stands, never retell history, never let it grow: ${SUMMARY_MAX_SENTENCES} sentences is the ceiling. SCENE_MARKER only when a NEW scene BEGINS in the recent messages (place change, time-skip, major shift) — the "#N" index where it starts, then the name; OMIT while the scene continues. PRESENT: everyone there RIGHT NOW (mains AND named NPCs), nobody who left. No #SHEET header, no BEAT/NEED lines, no commentary.` + TEMPORAL_GROUNDING_RULE;

// Backup 1 for the caps above: ONE re-ask over the over-long field, same
// profile, no tools. A failed or still-too-long answer falls through to the
// deterministic clip (backup 2) — the call never decides alone.
const HEAD_CONDENSE_SUMMARY_PROMPT = `Condense the following situational recap to at most ${SUMMARY_MAX_SENTENCES} sentences and 70 words, plain statements, no scenery or quotes. Reply with the recap only.`;
const HEAD_CONDENSE_TIMELINE_PROMPT = `Condense the following timeline line to ONE line of at most ${TIMELINE_MAX_CHARS} characters: in-story date/time; place; how long the mains have known each other — nothing else. Reply with the line only.`;

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

    // One correlation id for Call A, covering its inputs (captured here), its
    // prompts/transcript/tool traffic (captured inside llm-call.js) and its
    // parsed NEED selection. runId alone cannot do this: one run makes three
    // calls. Minted ONLY while recording — newTraceCallId builds a string, and
    // the off path is not allowed to pay for one.
    const extractCallId = isTraceRecording() ? newTraceCallId('extract') : null;
    // Call A's tool context gets the same id. memory-tools.js stamps it onto every
    // memtool.* capture (traceOpts), so the tool layer's before/after record
    // images group into the SAME export bucket as the prompts, per-round replies
    // and tool-call lines llm-call.js records under this id. Without it they land
    // in a sibling "(no call id)" block that a reader has to interleave by seq
    // with the very tool call whose arguments produced them. Assigned rather than
    // declared in the literal above because ctx is built before the recording
    // gate is consulted; null when recording is off, which costs grouping only.
    ctx.traceCallId = extractCallId;

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

    // The FORCED STATE RECHECK's input. Built here beside injectedSection for the
    // same reason: both are derived from the prior sheet, both are skipped on
    // EXTRACT-ONLY runs (which emit no final reply to carry verdicts, and which
    // catch-up import fires hundreds of), and the branch each took has to be
    // loggable. Null whenever nothing is owed a verdict — no sheet yet, no
    // settled messages, no live rows, or no row the settled messages touch.
    const stateRecheck = extractOnly ? null : buildStateRecheckSection({
        priorSheetText, settledMessages, tentativeMessages, databases,
    });

    const extractPrompt = buildExtractionUserPrompt({
        settledMessages, tentativeMessages, characterInfo, userPersona,
        observationDate, extractOnly, databases, index, settings, injectedSection, stateRecheck,
        // Trace ids only — the builder's OUTPUT is unchanged by them. The store-
        // candidates block exists nowhere but inside that function, so the
        // capture has to happen there.
        runId, traceCallId: extractCallId,
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

    // The omission-recovery list AS THE AGENT RECEIVED IT. The log above carries
    // only counts, and only on a degraded status; what decides whether a memory
    // could be recovered at all is the CONTENT — which refs the list declares
    // already-injected (the prompt forbids re-listing those), which carry the
    // `(recovered)` tag that exempts them, and the header that states how much
    // authority the whole list has. Header and body are captured rather than the
    // parsed ref array because they are the bytes that shipped: the body is
    // capped at injectedRefsCap() lines and tagged, the array is neither.
    if (injectedSection) {
        traceCapture('agent3.recovery.injected', () => ({
            status: injectedSection.status,
            reason: injectedSection.reason,
            why: injectedSection.why,
            truncated: injectedSection.truncated,
            refsTotal: injectedSection.refs.length,
            bufferHoldBack: holdBack,
            sheetSourceMessageIndex: injectedSection.sheetSourceMessageIndex,
            newestJudgedMessageIndex: injectedSection.newestJudgedMessageIndex,
            sheetRunId: injectedSection.sheetRunId,
            header: injectedSection.header,
            body: injectedSection.body,
            // The set as it stood BEFORE this run's bookkeeping — the one that
            // produced the `(recovered)` tags in the body above.
            stickyBefore: stickyRecovered.map(r => `${r.category}/${r.key}`),
        }), { runId, callId: extractCallId, reason: injectedSection.reason });
    }

    addDebugLog('info', `[${runId}] Extraction agent start: ${settledMessages.length} settled, ${tentativeMessages.length} tentative msg(s), extractOnly=${extractOnly}, injected-last-turn=${injectedLastTurn} ref(s) [${injectedSection ? injectedSection.status : 'SKIPPED'}], ${stickyRecovered.length} sticky recovered ref(s), state-recheck ${stateRecheck ? `${stateRecheck.entries.length} of ${stateRecheck.stateRows} row(s)` : 'none'} (user prompt ${extractPrompt.length} chars)`, {
        subsystem: 'agent3', event: 'agent3.extract',
        data: {
            settled: settledMessages.length, tentative: tentativeMessages.length, extractOnly,
            userPromptChars: extractPrompt.length, injectedLastTurn,
            injectedStatus: injectedSection ? injectedSection.status : 'SKIPPED',
            injectedTruncated: injectedSection ? injectedSection.truncated : false,
            stickyRecovered: stickyRecovered.length,
            stateRecheckAsked: stateRecheck ? stateRecheck.entries.length : 0,
            stateRecheckRows: stateRecheck ? stateRecheck.stateRows : 0,
            profileId: profileId || null,
        },
    });

    // Hoisted out of the call argument so the trace below reports the prompt that
    // was ACTUALLY sent rather than a second copy of the same expression, which
    // could drift from it.
    const extractOverride = String(settings?.memoryAgentPrompt || '').trim();
    const extractSystemPrompt = extractOverride || DEFAULT_MEMORY_AGENT_PROMPT;

    // WHICH system prompt ran — deliberately NOT its text. The prompt BODY is the
    // call layer's to capture: every systemPrompt/userPrompt string ends up in
    // llm-call.js, so a second copy here would store the same multi-KB block
    // twice per recorded run. What that layer cannot recover is where the string
    // came from — an override and the built-in default arrive as one
    // indistinguishable `systemPrompt` argument. That is the half worth having:
    // a saved override is a full COPY of whatever the default said when the user
    // last edited it, so a stale one silently predates every rule added since,
    // and "the agent ignores an instruction that is right there in the prompt"
    // is otherwise undiagnosable. traceCallId is threaded into the call below so
    // the two halves land under one id.
    traceCapture('agent3.prompt.extract', () => ({
        call: 'extract',
        source: extractOverride ? 'settings-override' : 'built-in-default',
        overrideChars: extractOverride.length,
        defaultChars: DEFAULT_MEMORY_AGENT_PROMPT.length,
        // An override that matches the default byte-for-byte is inert; one that
        // differs is the case worth looking at.
        differsFromDefault: extractOverride ? extractOverride !== DEFAULT_MEMORY_AGENT_PROMPT : false,
        extraInstructionsChars: String(settings?.memoryPrompt || '').trim().length,
        userPromptChars: extractPrompt.length,
        extractOnly,
    }), { runId, callId: extractCallId, note: 'prompt TEXT belongs to the llm-call layer; traceCallId ties the two' });

    const extractStart = Date.now();
    const loop = await callAgentLLMWithTools({
        systemPrompt: extractSystemPrompt,
        userPrompt: extractPrompt,
        profileId,
        agent: 'memory-agent',
        agentTag: 'memory',
        // Correlation only — llm-call.js stamps these onto its own captures so
        // this call's prompt bodies, per-round replies, tool arguments and tool
        // results land under the same ids as the inputs traced above. Both are
        // plain strings, so there is no lifetime or mutation concern.
        runId,
        traceCallId: extractCallId,
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

    // FORCED STATE RECHECK — applied HERE, between the tool loop and the
    // saveDatabase pass below, so a superseded record is persisted by the same
    // pass that persists the extraction writes and is counted by result.calls
    // and ctx.applied like any other write. Doing it beside the NEED parse
    // further down would land after that save and silently lose the row.
    //
    // The transcript is scanned newest-first for the reply carrying STATE lines,
    // separately from the NEED/RECOVERED scan below: a grace round can split
    // them (verdicts in round N, a corrected NEED in round N+1), and each half
    // should come from the newest reply that actually asserts it. Think blocks
    // are stripped first for the same reason NEED strips them — a reasoning
    // model drafts verdicts it then argues itself out of, and a drafted
    // SUPERSEDE would otherwise become a real write.
    if (stateRecheck && !loop.error) {
        let verdicts = [];
        for (let i = (loop.transcript || []).length - 1; i >= 0; i--) {
            const r = stripThinkBlocks(String(loop.transcript[i]?.reply || ''));
            // Same tolerance as parseStateVerdicts, or a reply whose verdicts are
            // bulleted would be skipped over in favour of an older one.
            if (/^\s*[-*]?\s*STATE\s*:/im.test(r)) { verdicts = parseStateVerdicts(r); break; }
        }
        try {
            await applyStateVerdicts({ verdicts, stateRecheck, ctx, runId, callId: extractCallId });
        } catch (e) {
            addDebugLog('fail', `[${runId}] State recheck failed (non-fatal): ${e?.message || e}`, {
                subsystem: 'agent3', event: 'agent3.state_recheck', reason: 'ERROR',
            });
        }
    }

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

    // What Call A actually SELECTED. The RECOVERED line is the whole point of the
    // omission-recovery feature and nothing logs its content: the sticky log
    // further down fires only when the set changes, and reports the set rather
    // than this turn's picks. `need` is captured after the RECOVERED merge above,
    // i.e. exactly the list composeSheet is about to resolve — so a ref that is
    // here but absent from the composed sheet was dropped by a resolve rule
    // (cold-tiered, inactive, invisible, over the NEED cap), which is the shape
    // of "my memory went missing".
    traceCapture('agent3.need.selection', () => ({
        source: loop.error ? 'fallback:getLastNeedRefs (Call A failed)' : 'transcript',
        loopError: loop.error || null,
        need: need.map(r => `${r.category}/${r.key}`),
        recovered: recovered.map(r => `${r.category}/${r.key}`),
    }), { runId, callId: extractCallId });

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

    // THE COLD TIER IS RECONCILED AGAINST THE SETTING FIRST, and the order is the
    // point. saveDatabase() re-tiers only the category it writes, so moving the
    // premise-floor slider leaves every category this chat has not touched
    // holding a cold set sized for the OLD number — and a cold fact is skipped by
    // selectPremiseFloor, so those rows would stay off the sheet indefinitely
    // while the slider claimed they were paid for. Raising the cap has to take
    // effect on the next sheet, not on the next time that category happens to be
    // written. Runs once per turn, right before the sheet is composed, and it is
    // a no-op (one comparison per category) whenever the setting has not moved.
    // Never throws; a failure leaves the previous flags standing.
    try { await reconcileColdTier(); } catch {  }

    // composeSheet makes no LLM call: it is fed the head from Call C
    // (summary/timeline, falling back to the prior head / persisted timeline
    // when Call C failed), the NEED refs from Call A, and the beats via the
    // scene store. Its one outward write is setSheetSupplyRefs — see there.
    const summary = (head && head.summary) ? head.summary : extractPriorSummary(priorSheetText);
    // The relevance scorer's "now" anchor: the newest USER message this run can
    // see. Tentative messages are newer than settled ones, so they are scanned
    // first — on probe turns the probe question is tentative, and the floor
    // must rank against IT, not against the last settled exchange.
    let lastUserText = '';
    for (const list of [tentativeMessages, settledMessages]) {
        for (let i = (Array.isArray(list) ? list.length : 0) - 1; i >= 0; i--) {
            const m = list[i];
            if (m && m.role === 'USER' && String(m.text || '').trim()) { lastUserText = String(m.text); break; }
        }
        if (lastUserText) break;
    }
    result.sheetText = composeSheet({
        summary,
        timeline: (head && head.timeline) || getSceneTimeline(),
        need,
        recovered: stickyRecovered,
        settings,
        databases,
        runId,
        lastUserText,
    });

    // THE SHEET TEXT, per run. Only its char count was ever logged, and only the
    // CURRENT sheet is stored — it is overwritten every turn, so there has never
    // been any history of what was injected on the turn a memory went missing.
    // This is the capture that answers that question. `sourceMessageIndex` is the
    // newest SETTLED message this run judged (the same index its fact writes are
    // stamped with); the persisted sheet record carries its own index, stamped by
    // setMemorySheet at COMMIT time, which is later and can differ under lag.
    traceCapture('agent3.sheet.composed', () => ({
        sourceMessageIndex: sourceIndex,
        sourceUid: sourceUid || null,
        newestJudgedMessageIndex,
        chars: result.sheetText.length,
        needCount: need.length,
        stickyCount: stickyRecovered.length,
        sheetText: result.sheetText,
    }), { runId, note: 'text injected into the NEXT storyteller turn' });

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
    stateRecheck = null, runId = '', traceCallId = null,
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
        // The other half of the recovery evidence, and the half that carries
        // VALUES. Nothing logs it at any level — not even a count — so when the
        // agent concludes a fumble had no fact behind it there is currently no
        // way to tell whether the fact was offered and ignored or never offered.
        // An EMPTY block is captured too: "the candidate scan found nothing" and
        // "the agent overlooked a row" are different bugs and look identical from
        // the outside.
        traceCapture('agent3.recovery.candidates', () => ({
            count: candidates.length,
            cap: CANDIDATE_FACTS_CAP,
            valueChars: CANDIDATE_VALUE_CHARS,
            injectedExcluded: injectedSection.refs.length,
            candidates,
        }), { runId, callId: traceCallId });
        if (candidates.length > 0) {
            parts.push(`## Store candidates (stored facts the list above does NOT cover, about who/what the OMISSION CHECK reply names — then, with whatever room is left, who/what the tentative replies just before it name, since a hedge often withholds the subject the reply BEFORE it introduced. VALUES shown; this is evidence for spotting an omission, not a NEED list)\n${candidates.join('\n')}`);
        }
    }

    // The FORWARD-facing half of the same diff. `## Injected last turn` asks what
    // the sheet FAILED to carry; this asks whether what it DID carry is still
    // true. Placed last of the three evidence blocks, immediately before the
    // "Work now" line, so the rows to be judged are the freshest thing in the
    // prompt when the verdicts are written.
    if (stateRecheck) parts.push(`${stateRecheck.header}\n${stateRecheck.body}`);

    const extra = String(settings?.memoryPrompt || '').trim();
    if (extra) parts.push(`## Additional instructions from the user\n${extra}`);

    parts.push(extractOnly
        ? 'Work now: check the store with tools where needed, write the new lasting facts, then end with the #DONE line.'
        : `Work now: check the store with tools where needed, write the new lasting facts, emit the NEED line, ${stateRecheck ? 'give one STATE verdict per row listed above, ' : ''}then end with #DONE.`);

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
    // Read here rather than passed in: the cap now tracks the premise-floor
    // setting, and this function is the only consumer.
    const refsCap = injectedRefsCap(getSettingsSafe());
    const truncated = refs.length > refsCap;

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
        ? capLines(rendered.join('\n'), refsCap, 'sheet was longer — the rest is UNKNOWN, not omitted')
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

// ===================================================================
// FORCED STATE RECHECK
// ===================================================================
//
// WHERE THE ROWS COME FROM. `priorSheetText` — the same string the omission
// list is parsed out of, handed in by pipeline.js from getMemorySheet(), which
// reads chatMetadata.bf_mem_sheet. That record is written by setMemorySheet on
// EVERY committed run and is independent of the test-run recorder. The
// sheetHistory ring in turn-state.js is NOT usable here: recordSheetHistory
// returns immediately unless isTraceRecording(), so with recording off it is
// permanently empty, and it is dropped on chat switch and on reload. The
// persisted record is the only always-available source, and it is already an
// argument to runMemoryAgent — no other file has to be touched.
//
// WHICH sheet that is, stated honestly: it is the NEWEST committed sheet, not
// necessarily the one that stood above the settled messages being judged. With
// bufferHoldBack = 4 those differ by about two runs (the settled window trails
// the sheet). That is the RIGHT input anyway: the job is to stop the NEXT
// injection from carrying a false row, so the rows worth checking are the ones
// still live and still being injected. classifyPriorSheet's VERIFIED/MISMATCH
// distinction is therefore not consulted — it exists because omission recovery
// reasons from ABSENCE ("missing from the list, therefore never shown"), which
// needs the exact sheet. A recheck reasons from PRESENCE: every row below is a
// live store record that the sheet just rendered, whichever turn it rendered on.

// Parse the CURRENT STATE block out of a composed sheet. composeSheet emits the
// header line verbatim, then one buildFactLine row per fact, then the next
// section header — so the block ends at the first line that is not a fact row.
// Reuses SHEET_REF_RE, i.e. exactly the grammar extractPriorSheetRefs trusts.
function extractPriorStateLines(priorSheetText) {
    const out = [];
    const seen = new Set();
    let inState = false;
    for (const rawLine of String(priorSheetText || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line === STATE_SECTION_HEADER) { inState = true; continue; }
        if (!inState) continue;
        const m = SHEET_REF_RE.exec(line);
        // CHRONOLOGY / "Connected memories:" headers carry no `[knownBy]` prefix
        // and so cannot match — the first non-row line closes the block.
        if (!m) { inState = false; continue; }
        const category = m[1].trim();
        if (!category) { inState = false; continue; }
        const ref = `${category}/${m[2]}`;
        if (seen.has(ref)) continue;
        seen.add(ref);
        out.push({ ref, category, key: m[2], line });
    }
    return out;
}

// The vocabulary a SUPERSEDE is grounded against (see the gate in
// applyStateVerdicts). tokenSet already drops everything under 4 chars, so what
// survives is content words; this adds a crude suffix strip on top, because
// evidence and replacement almost never inflect the same way — "the binding came
// off" against "no longer binds her chest" shares nothing until `binding` and
// `binds` both reduce to `bind`. Applied to BOTH sides of every comparison, so
// it can only add matches between related words, never invent one between
// unrelated ones. It is a heuristic, not a stemmer: one pass, no irregulars
// ('bound' never meets 'bind'), which is why a refusal is logged with its tokens
// rather than treated as proof of anything about the model.
function groundingStems(text) {
    const out = new Set();
    for (const t of tokenSet(text)) {
        let s = t;
        if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
        else if (s.length > 4 && (s.endsWith('ed') || s.endsWith('es'))) s = s.slice(0, -2);
        else if (s.length > 4 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
        // Trailing -e last, so remove/removes/removed/removing all land on
        // `remov` instead of splitting two-and-two.
        if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
        out.add(s);
    }
    return out;
}

// How many negators a line carries. Deliberately NOT built on tokenSet: every
// negator in the language is shorter than its length floor, which is exactly why
// a supersede that inverts a row used to reach the store ungated. Counting rather
// than testing a boolean keeps "no marks" -> "no marks left" (1 -> 1, a
// restatement) apart from "marks" -> "no marks" (0 -> 1, an inversion).
// Matched on the raw text, so contractions survive.
const NEGATORS = /\b(?:not|no|never|none|nothing|nobody|nowhere|neither|nor|without|nicht|kein|keine|keinen|nie)\b|n't\b/gi;
function negationPolarity(text) {
    const m = String(text ?? '').match(NEGATORS);
    return m ? m.length : 0;
}

// RANKING — which rows get one of the STATE_RECHECK_MAX mandatory verdicts.
//
// Score = IDF-weighted token overlap between the ROW AS RENDERED and the
// SETTLED messages. Rationale, in order of strength:
//
//   1. A verdict is only ANSWERABLE from evidence. The prompt forbids
//      superseding on inference, so a row about something the new messages
//      never mention has exactly one honest verdict, and demanding it teaches
//      the agent to stamp UNCHANGED without reading — or, worse, to invent a
//      change to justify the slot. Rows sharing NO token with the messages are
//      therefore not asked about at all.
//   2. Lexical overlap is where a contradiction actually lives. #23's row read
//      "Chest binding … too tight across ribs" and the message read "The
//      binding came off … Red marks scored her ribs" — 'binding' and 'ribs' are
//      the contradiction, in plain shared words.
//
// IDF (1/document-frequency across the candidate rows) is what makes this work
// on a single-protagonist roleplay: the lead's name is in nearly every row —
// buildFactLine renders the ref, so the subject leaks in through the KEY even
// when the prose omits it — and in nearly every message, so raw overlap ranks
// by nothing at all. With df weighting 'naoto' at df 18 contributes 0.06 while
// 'ribs' at df 1 contributes 1.0: the score reduces to "how many words does
// this row share with the new messages that it does NOT share with its
// neighbours". That same leak is why rule 1 rarely excludes anything in a solo
// scene and the CAP is the real selector there — the score is the ranking, the
// zero test only spares whole absent subjects.
//
// Honest about what this is not: df is computed over the ~20 candidate rows,
// not over a corpus, so an ordinary English word that happens to be rare across
// THESE rows ('something', 'just') can score as high as a distinctive one. The
// noise is symmetric and does not systematically bury a contradiction — on the
// #23 data the binding row still ranks 2nd of 18, on 'binding'/'ribs'/'across'/
// 'beneath'. This is a cheap ordering heuristic, not retrieval.
//
// REJECTED alternatives: recency ranks the WRONG way (a row written this turn
// was just judged against these same messages by the extractor, and is the
// least likely to be stale); importance is uncorrelated with staleness and its
// top band is premise identity — a name, a birthplace — which by construction
// rarely changes; kind === 'state' is the taxonomy's own "durable but
// changeable" label and reads as ideal, but it is DERIVED from the aspect
// (deriveKind), so it says which aspects CAN change, never which one just did.
// It also does not discriminate: on the pre-derivation store measured here
// ({trait:61, state:2}) it selected almost nothing, and on a store whose aspects
// derive to `state` it selects almost everything. Either way the settled
// messages are the only evidence that a change actually happened, so overlap
// with them is the ranking. Staleness survives only as the TIEBREAK: among rows
// the messages talk about equally, prefer the one asserted longest ago and never
// revisited, because that is where drift accumulates.
function buildStateRecheckSection({ priorSheetText, settledMessages, tentativeMessages, databases }) {
    try {
        const msgs = (Array.isArray(settledMessages) ? settledMessages : [])
            .filter(m => String(m?.text || '').trim());
        // No settled messages = no admissible evidence, so no verdict can be
        // owed — and none could be checked either (see the settled-evidence gate
        // in applyStateVerdicts, which has nothing to check against here).
        if (msgs.length === 0) return null;

        const parsed = extractPriorStateLines(priorSheetText);
        if (parsed.length === 0) return null;

        // Resolve each rendered row back to the live record. A row whose fact is
        // gone, inactive, invisible or cold-tiered will not be injected again,
        // so no verdict is owed on it — and cold especially must not be offered,
        // since a write would uncold it (upsertFact) and undo the demotion.
        const entries = [];
        for (const p of parsed) {
            const category = mapLegacyCategory(String(p.category || '').trim() || 'Unsorted');
            const db = (databases || {})[category];
            if (!db) continue;
            const fact = findFactMatch(db, p.key);
            if (!fact || !isActiveFact(fact) || !isFactVisible(fact)) continue;
            if (fact.cold === true) continue;
            // Already-resolved facts owe no verdict: they render in the RESOLVED
            // subsection now, not as present-tense truth, so the only verdicts
            // left for them would be noise. (Also guards the one-turn window in
            // which the prior sheet predates the resolution.)
            if (fact.status === 'resolved') continue;
            // `db` rides along so a write can be re-resolved in the SAME store
            // object afterwards (restoreEveryoneKnownBy). It is a live record —
            // it must never reach addDebugLog or traceCapture, and the entry is
            // only ever projected field-by-field into those.
            entries.push({ ref: `${category}/${fact.key}`, category, db, fact, line: p.line, tokens: null, score: 0 });
        }
        if (entries.length === 0) return null;

        const settledText = msgs.map(m => String(m?.text || '')).join('\n');
        const msgTokens = tokenSet(settledText);
        if (msgTokens.size === 0) return null;

        const df = new Map();
        for (const e of entries) {
            e.tokens = tokenSet(e.line);
            for (const t of e.tokens) df.set(t, (df.get(t) || 0) + 1);
        }

        const scored = [];
        for (const e of entries) {
            let score = 0;
            for (const t of e.tokens) {
                if (!msgTokens.has(t)) continue;
                score += 1 / (df.get(t) || 1);
            }
            if (score <= 0) continue;
            e.score = score;
            scored.push(e);
        }
        if (scored.length === 0) return null;

        scored.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            // Older first. An absent validAt sorts last: unknown age is not
            // evidence of staleness.
            const av = Number.isInteger(a.fact.validAt) ? a.fact.validAt : Number.MAX_SAFE_INTEGER;
            const bv = Number.isInteger(b.fact.validAt) ? b.fact.validAt : Number.MAX_SAFE_INTEGER;
            if (av === bv && av === Number.MAX_SAFE_INTEGER) {
                // Both undated (typically reflection-written traits): lastUpdated
                // is the only age signal left — longest-untouched first, the same
                // "drift accumulates where nothing revisits" rationale as above.
                return (Number(a.fact.lastUpdated) || 0) - (Number(b.fact.lastUpdated) || 0);
            }
            return av - bv;
        });

        const picked = scored.slice(0, STATE_RECHECK_MAX);
        // THE validAt-LESS QUOTA (see STATE_RECHECK_NOVALIDAT_MIN). Undated rows
        // lose every score tie by construction, and in the analysed run they were
        // therefore NEVER asked — the exact rows (reflection traits) that kept
        // shipping as "true RIGHT NOW" after the story had moved on. When the cap
        // bites and the pick carries fewer undated rows than the quota, the
        // best-scoring undated rows below the cut replace dated rows from the
        // TAIL of the pick — the top-scored questions are untouched, and a row
        // only enters this way if it scored at all (the zero test above stands).
        if (scored.length > picked.length) {
            const undated = (e) => !Number.isInteger(e.fact?.validAt);
            let have = picked.filter(undated).length;
            const wanted = Math.min(STATE_RECHECK_NOVALIDAT_MIN, scored.filter(undated).length);
            if (have < wanted) {
                // Best-scoring first, truncated to what the quota still needs;
                // consumed from the END while walking the pick from its tail, so
                // the best promoted row lands in the earliest replaced slot —
                // fed order is also the supersede-cap priority, so it matters.
                const promotions = scored.slice(picked.length).filter(undated).slice(0, wanted - have);
                for (let i = picked.length - 1; i >= 0 && promotions.length > 0; i--) {
                    if (undated(picked[i])) continue;
                    picked[i] = promotions.pop();
                    have++;
                }
            }
        }
        // The two vocabularies the write gate compares a SUPERSEDE against.
        // Built here because both windows are already in hand, and deliberately
        // AFTER the scoring: the tentative text ranks nothing and picks nothing —
        // it can only ever cost a write, never buy one. That is the whole of its
        // role, and it is the reason the ranking above may stay settled-only
        // while the gate can still name WHY a refused claim was refused.
        return {
            settledStems: groundingStems(settledText),
            tentativeStems: groundingStems((Array.isArray(tentativeMessages) ? tentativeMessages : [])
                .map(m => String(m?.text || '')).join('\n')),
            header: '## State lines up for recheck (CURRENT STATE rows the sheet is still injecting as present-tense truth, ranked by how much the SETTLED messages above talk about them — ONE STATE verdict per ref, no exceptions)',
            body: picked.map(e => clipText(e.line, STATE_RECHECK_LINE_CHARS)).join('\n'),
            entries: picked,
            stateRows: parsed.length,
            resolved: entries.length,
            scoredAbove0: scored.length,
        };
    } catch {
        // Same doctrine as buildRecoveryCandidates: this block is an
        // improvement, never a precondition — a broken store shape must not cost
        // the run its extraction.
        return null;
    }
}

// STATE verdicts travel on the same final reply as NEED/RECOVERED, one line per
// ref, pipe-separated the way SCENE_MARKER and BEAT already are (the free-text
// third field can contain commas, so the comma grammar parseRefLine uses cannot
// carry it). Tolerant of bullet prefixes like the other ref parsers.
//   STATE: Category/key | UNCHANGED
//   STATE: Category/key | SUPERSEDE | <new text>
// A SUPERSEDE with an empty third field is DROPPED rather than treated as a
// verdict: it names a row as wrong without saying what is right, and the write
// path would have nothing to store.
//
// Repeats are NOT collapsed here. A ref repeated in one reply keeps its FIRST
// verdict — a trailing rubber-stamp must not quietly cancel a considered
// supersede written above it — but that decision belongs to applyStateVerdicts,
// which is the only place that can tell a repeat (`X UNCHANGED` twice) from a
// CONTRADICTION (`X SUPERSEDE` then `X UNCHANGED`) and count them separately.
// Collapsing them here made a self-contradicting reply indistinguishable from a
// clean one in every log and trace. It is also the only layer that can see that
// `World/x` and `Places/x` are the same row.
//
// The leading `[-*]?` is not decoration: eight verdicts in a row is exactly the
// shape a model renders as a markdown list, and a dropped SUPERSEDE is
// indistinguishable from the silence this whole feature exists to end. Bullets
// are stripped in BOTH positions (before the header and before the ref).
function parseStateVerdicts(text) {
    const out = [];
    for (const rawLine of String(text || '').split('\n')) {
        const m = /^\s*[-*]?\s*STATE\s*:\s*(.+)$/i.exec(rawLine.trim());
        if (!m) continue;
        const parts = m[1].split('|');
        const ref = parts[0].trim().replace(/^[-*]\s*/, '');
        const slash = ref.indexOf('/');
        if (slash <= 0) continue;
        const category = ref.slice(0, slash).trim();
        const key = ref.slice(slash + 1).trim();
        if (!category || !key) continue;
        const verdict = String(parts[1] || '').trim().toUpperCase();
        if (/^UNCHANGED/.test(verdict)) {
            out.push({ category, key, verdict: 'UNCHANGED', value: '' });
            continue;
        }
        if (!/^SUPERSEDE/.test(verdict) && !/^RESOLVED/.test(verdict)) continue;
        // Re-join: a new value may legitimately contain a pipe.
        const value = parts.slice(2).join('|').trim();
        // Same doctrine for both verdicts: SUPERSEDE without a replacement names
        // a row as wrong without saying what is right; RESOLVED without evidence
        // closes a row without saying what closed it. Both are DROPPED.
        if (!value) continue;
        out.push({ category, key, verdict: /^RESOLVED/.test(verdict) ? 'RESOLVED' : 'SUPERSEDE', value });
    }
    return out;
}

// An EMPTY or absent stored knownBy is a VALUE, not a missing field: it means
// "everyone knows this". isFactVisible returns true for it unconditionally and
// buildFactLine renders it `[everyone]` — it is how world lore, public events
// and premise rows are stored. And it cannot be SENT: execWriteFact treats
// `known_by: []` exactly like an omitted one and substitutes getScenePresent(),
// after which upsertFact REPLACES knownBy wholesale (it is not on the merge-
// preserved list). So a forced supersede of a public row silently gates it on
// whoever happened to be on stage this turn, and it stops being injected the
// moment that cast leaves. An omitted knownBy means UNCHANGED, never "nobody".
//
// The write itself must keep going through executeMemoryTool — every guard lives
// there — so the one field is repaired afterwards, in the same store object the
// saveDatabase pass persists (upsertFact already stamped db.updatedAt and the
// category is already in ctx.touchedCategories, so this rides along with no
// extra save).
//
// Re-resolved instead of reusing the pre-write object because upsertFact
// REPLACES db.facts[i] with a fresh object. The key equality test is not
// ceremony: write_fact resolves generic prefixes and aliases, so a write can
// land on a DIFFERENT record than the row we read, and that record's knownBy is
// not ours to blank. When it cannot be re-resolved the row is left narrowed and
// SAID SO at fail level — a silently gated lore fact is exactly the kind of
// disappearance this pass exists to stop.
function restoreEveryoneKnownBy(entry, runId = '') {
    const db = entry?.db;
    const key = entry?.fact?.key;
    if (!db || !key) return false;
    const after = findFactMatch(db, key);
    if (!after || after.key !== key) {
        addDebugLog('fail', `[${runId}] State recheck: ${entry?.ref || '?'} was stored as "known by: everyone" but could not be re-resolved after the write — it may now be gated on the scene cast`, {
            subsystem: 'agent3', event: 'agent3.state_recheck', reason: 'KNOWNBY_UNRESTORED',
            data: { ref: entry?.ref || '', key, resolvedKey: after ? after.key : null, runId },
        });
        return false;
    }
    if (!Array.isArray(after.knownBy) || after.knownBy.length === 0) return false;
    const narrowedTo = after.knownBy.length;
    // Assigned rather than deleted: [] and absent are identical to every reader
    // (isFactVisible reads `(fact && fact.knownBy) || []`), and [] is the shape
    // execWriteFact writes for every new fact.
    after.knownBy = [];
    addDebugLog('info', `[${runId}] State recheck: restored "known by: everyone" on ${entry.ref} — the write had narrowed it to ${narrowedTo} name(s)`, {
        subsystem: 'agent3', event: 'agent3.state_recheck', reason: 'KNOWNBY_RESTORED',
        data: { ref: entry.ref, narrowedTo, runId },
    });
    return true;
}

// A SUPERSEDE replacement is one self-contained line — that is what the prompt
// asks for and it is the right shape for a NOTE. It is the wrong shape for a
// VALUE: every other write in this codebase stores a short handle in `value` and
// puts the detail in the note, and the measured export shows the cost of
// ignoring that — the only two values longer than ten words in a 65-fact store
// were the only two rows this function had rewritten.
//
// So the line is split rather than copied. Prefer a real clause boundary that
// falls inside the budget (a full stop, then a semicolon, dash, or comma), which
// on both real superseded rows yields a clean standalone assertion and leaves
// the qualifications to the note. Only when no boundary fits does it cut on a
// word boundary and mark the cut with an ellipsis — a value that ends in "…" is
// a pointer to the note, never a claim in its own right.
//
// `note` is ALWAYS the full replacement text, on both sides of the length
// boundary, and that symmetry is the point. The stored note is the text the
// sheet prints (buildFactLine renders the note INSTEAD of the value whenever one
// is present), so a supersede that left the old note standing would be invisible
// on the very sheet it was written to correct — the note has to move.
//
// It used to move in two different ways: over 110 characters the note became the
// replacement, at 110 or under it became '' — which execWriteFact honours as
// "clear it" and mergeContext (database.js) then DELETES. One character decided
// between replacing a note and destroying one. A stored note reading "Naoto's
// apartment: 2nd floor, Inaba, shared with her grandfather" was erased outright
// by a 108-character supersede and preserved by a 112-character one. Returning
// the full text on both sides replaces in both cases and destroys in neither;
// nothing is lost on the short side either, because there value === note and
// buildFactLine prints one line regardless of which field it read.
const SUPERSEDE_VALUE_CHARS = 110;
function splitSupersedeText(text) {
    const full = String(text || '').replace(/\s+/g, ' ').trim();
    if (!full) return { value: '', note: '' };
    if (full.length <= SUPERSEDE_VALUE_CHARS) return { value: full, note: full };

    const head = full.slice(0, SUPERSEDE_VALUE_CHARS + 1);
    for (const re of [/[.!?](?=\s)/g, /;/g, /\s[—–-]\s/g, /,/g]) {
        let cut = -1;
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(head)) !== null) cut = m.index;
        // A boundary in the first few words is a false split ("No, she ...").
        if (cut >= 20) return { value: full.slice(0, cut).trim(), note: full };
    }
    const words = head.split(' ');
    words.pop();
    return { value: `${words.join(' ').trim()}…`, note: full };
}

// The second half of the same defect. mergeProvenance (database.js) keeps the
// GENESIS source and validAt on every merge — correct for an ordinary update,
// wrong for a supersede, which is not an elaboration of the old row but its
// replacement by a later message. Left alone, a row rewritten from message 73
// keeps validAt 47 and recencyTail renders the fresh text as "(~15 turns ago)",
// i.e. the sheet tells the model that this turn's correction is stale.
//
// Repaired after the write for the same reason restoreEveryoneKnownBy is: the
// write itself must keep going through executeMemoryTool, and this is the same
// live store object the saveDatabase pass persists (the category is already in
// ctx.touchedCategories). mergeProvenance has already pushed the previous source
// onto sourceHistory by the time this runs — it does that whenever the incoming
// source differs — so the chain msg_47 -> msg_73 stays readable rather than
// being overwritten.
//
// Re-resolved rather than reusing the pre-write object because upsertFact
// REPLACES db.facts[i], and the key equality test guards the same hazard: a
// write can land on a DIFFERENT record than the row we read, and that record's
// provenance is not ours to restamp.
function restampSupersedeProvenance(entry, ctx, runId = '') {
    const db = entry?.db;
    const key = entry?.fact?.key;
    if (!db || !key) return false;
    if (!Number.isInteger(ctx?.sourceIndex)) return false;
    const after = findFactMatch(db, key);
    if (!after || after.key !== key) return false;
    const wasValidAt = after.validAt;
    if (wasValidAt === ctx.sourceIndex && after.source === `msg_${ctx.sourceIndex}`) return false;
    after.validAt = ctx.sourceIndex;
    after.source = `msg_${ctx.sourceIndex}`;
    if (ctx.srcId) after.srcId = ctx.srcId;
    addDebugLog('debug', `[${runId}] State recheck: ${entry.ref} re-dated to message #${ctx.sourceIndex} (was ${wasValidAt ?? 'unset'}) — a supersede is dated by the message that triggered it`, {
        subsystem: 'agent3', event: 'agent3.state_recheck', reason: 'PROVENANCE_RESTAMPED',
        data: { ref: entry.ref, from: wasValidAt ?? null, to: ctx.sourceIndex, runId },
    });
    return true;
}

// Apply the verdicts. SUPERSEDE goes through executeMemoryTool('write_fact'),
// i.e. the SAME path the agent's own writes take, so every guard applies:
// key canonicalization, alias/generic prefix resolution, findFactMatch,
// isMaterialFactWrite, upsertFact's parallel-state merge, autoLinkFact,
// applyCrossKeySupersedeRules, the ctx.applied ledger and the trace captures.
//
// The payload deliberately restates four STORED fields instead of letting
// execWriteFact default them, because the defaults are authored for a NEW fact
// and would silently damage an existing one:
//   - known_by: omitted, it defaults to getScenePresent(), and upsertFact
//     REPLACES knownBy wholesale — a supersede of a secret would broadcast it to
//     everyone currently in the room. Restating it covers only the rows that
//     HAVE a list; the empty/absent case is the opposite failure and is repaired
//     after the write (restoreEveryoneKnownBy).
//   - aspect: normalizeAspect never returns empty, so an omitted aspect rewrites
//     a good stored one to the category default (the reflect path documents the
//     same hazard).
//   - kind / importance: kept so a forced write cannot re-classify or (via a
//     default) touch the record's standing. mergeSalience takes the max of the
//     two importances, so this is belt and braces, not a behaviour change.
//
// The replacement text is SPLIT across value and note (splitSupersedeText), not
// copied into both. Both fields must be written — buildFactLine renders the NOTE
// INSTEAD of the value whenever one exists, so updating only `value` would leave
// the sheet printing the stale note, and leaving the value alone would leave
// search and the fact list answering with the claim this verdict just retired.
// But writing the same long sentence into both is what produced the only two
// values over ten words in the whole measured store: `value` is a short handle
// everywhere else in this codebase and the detail belongs in the note.
async function applyStateVerdicts({ verdicts, stateRecheck, ctx, runId = '', callId = null }) {
    const stats = {
        asked: stateRecheck.entries.length,
        verdicts: verdicts.length,
        unchanged: 0, superseded: 0, resolved: 0, unanswered: 0,
        unlisted: 0, noop: 0, capped: 0, failed: 0,
        repeated: 0, contradicted: 0, ungrounded: 0, tentativeOnly: 0, knownByRestored: 0, reDated: 0,
        applied: [],
    };
    const order = new Map(stateRecheck.entries.map((e, i) => [e.ref.toLowerCase(), i]));
    const byRef = new Map(stateRecheck.entries.map(e => [e.ref.toLowerCase(), e]));

    const answered = new Set();
    const firstByRef = new Map();
    const supersedes = [];
    const resolves = [];
    for (const v of verdicts) {
        // `World/x` and `Places/x` are the same record, and legacy categories are
        // still all over this store — so every comparison below happens on the
        // MAPPED ref, not the ref as written.
        const ref = `${mapLegacyCategory(String(v.category || '').trim() || 'Unsorted')}/${v.key}`.toLowerCase();
        // FIRST verdict per ref wins, and the rest are counted rather than
        // dropped in silence. A repeat is a model restating itself; a
        // CONTRADICTION (a different verb, or a second SUPERSEDE with different
        // text) means the reply does not agree with itself, and a reply that
        // does not agree with itself is the rewrite reflex arguing out loud. The
        // considered verdict is the one written first, so that is the one kept,
        // but the disagreement is now visible in the run log instead of being
        // indistinguishable from a clean answer.
        const prev = firstByRef.get(ref);
        if (prev) {
            if (prev.verdict !== v.verdict || (v.verdict === 'SUPERSEDE' && prev.value !== v.value)) stats.contradicted++;
            else stats.repeated++;
            continue;
        }
        firstByRef.set(ref, v);
        const entry = byRef.get(ref);
        // A verdict for a row we did not ask about is the rewrite-everything
        // reflex in its first observable form. It is refused, not applied: the
        // fed list is the whole authority here, exactly as `## Injected last
        // turn` is the authority for recovery.
        if (!entry) { stats.unlisted++; continue; }
        answered.add(ref);
        if (v.verdict === 'UNCHANGED') { stats.unchanged++; continue; }
        if (v.verdict === 'RESOLVED') { resolves.push({ entry, value: v.value }); continue; }
        supersedes.push({ entry, value: v.value });
    }
    stats.unanswered = stats.asked - answered.size;

    // When more supersedes arrive than the cap allows, keep the ones the
    // EVIDENCE ranking put first rather than the ones the model listed first —
    // reply order is arbitrary, the fed order is scored.
    supersedes.sort((a, b) => (order.get(a.entry.ref.toLowerCase()) ?? 0) - (order.get(b.entry.ref.toLowerCase()) ?? 0));
    resolves.sort((a, b) => (order.get(a.entry.ref.toLowerCase()) ?? 0) - (order.get(b.entry.ref.toLowerCase()) ?? 0));

    for (const s of supersedes) {
        if (stats.superseded >= STATE_SUPERSEDE_MAX) { stats.capped++; continue; }
        const fact = s.entry.fact;
        const storedValue = String(fact.value ?? '').trim();
        const storedNote = (typeof fact.context === 'string') ? fact.context.trim() : '';
        // A SUPERSEDE that restates the row as it already reads is an UNCHANGED
        // with extra steps, and it is not free: upsertFact re-stamps lastUpdated
        // unconditionally, which feeds cold-tiering and every recency ranking in
        // the codebase. The test is against the RENDERED row (buildFactLine
        // shows the note INSTEAD of the value whenever one exists) because that
        // is what "did the injected line change" means — comparing against the
        // raw value alone let an echo of a stored one-word value through.
        if (s.value === (storedNote || storedValue)) { stats.noop++; continue; }

        // ---- THE SETTLED-EVIDENCE GATE ------------------------------------
        //
        // The one rule this feature cannot enforce in prose: a SUPERSEDE must be
        // answerable from the SETTLED window. The prompt says so; this function
        // used to take the model's word for it, and the live export shows what
        // that costs — two rows written from TENTATIVE replies, i.e. from text a
        // swipe can delete, leaving a store that remembers a message that never
        // happened. Choosing WHICH rows to ask about from settled text only (the
        // ranking above) does not close it: it decides the question, not the
        // answer.
        //
        // What is checkable is WORDS. Stem the replacement, subtract the stems
        // of the row it replaces, and what is left is the CLAIM — the part this
        // supersede asserts that the sheet did not already say. At least one of
        // those stems must occur in the settled messages. If none does but one
        // occurs in the tentative window, the claim's wording demonstrably came
        // from text that may still be swiped away: refused, TENTATIVE_ONLY. If
        // it occurs in neither, it came from the model alone: refused,
        // UNGROUNDED.
        //
        // THE HONEST LIMIT, stated once so no comment below overstates it: this
        // proves the claim's VOCABULARY is present in the settled text, never
        // that the settled text supports the claim. A model that re-words a
        // tentative observation using words that also happen to occur in the
        // settled window still passes, and no check on this side of a text-in/
        // text-out protocol can catch that — there is no channel on which the
        // model can be made to prove what it read. What the gate does buy is
        // exactly the sentence the prompt has been asserting alone: the tentative
        // window can no longer be the SOLE source of a written row.
        //
        // It cuts both ways on purpose. A supersede that restates settled
        // evidence entirely in synonyms is refused too. That costs a stale row
        // one more turn — it still scores against those same messages, so it is
        // asked again next turn — and every refusal is logged with the tokens
        // that failed, so the false-refusal rate is measurable rather than
        // assumed. An unjustified write is neither.
        //
        // An empty `novel` set USUALLY means the replacement introduces no content
        // word the row did not already carry, so there is no claim to ground (the
        // no-op test above already caught the exact restatement).
        //
        // With one exception that used to sail straight through: NEGATION. Every
        // negator is shorter than groundingStems' length floor, so
        // "binding wrapped tight" -> "binding NOT wrapped tight" yields an empty
        // `novel` set while inverting the row's meaning completely — the single
        // most consequential verdict this feature can produce, previously written
        // with zero settled evidence required. A polarity flip IS a claim, so when
        // one is detected the gate demands grounding for the whole line rather
        // than for the (empty) novel set.
        const rowStems = groundingStems(s.entry.line);
        const valueStems = groundingStems(s.value);
        const novel = [...valueStems].filter(t => !rowStems.has(t));
        const inverts = negationPolarity(s.value) !== negationPolarity(s.entry.line);
        const claimStems = novel.length > 0 ? novel : [...valueStems];
        if ((novel.length > 0 || inverts) && !claimStems.some(t => stateRecheck.settledStems.has(t))) {
            const fromTentative = novel.filter(t => stateRecheck.tentativeStems.has(t));
            stats.ungrounded++;
            if (fromTentative.length > 0) stats.tentativeOnly++;
            const why = fromTentative.length > 0
                ? 'its new wording traces to a TENTATIVE reply, not to any settled message'
                : (novel.length === 0 && inverts
                    ? 'it INVERTS the row (a negation was added or removed) and no word of the new line appears in the settled messages'
                    : 'nothing in its new wording appears in the settled messages');
            addDebugLog('info', `[${runId}] State recheck: SUPERSEDE ${s.entry.ref} refused — ${why} (unmatched: ${claimStems.slice(0, 8).join(', ')})`, {
                subsystem: 'agent3', event: 'agent3.state_recheck',
                reason: fromTentative.length > 0 ? 'TENTATIVE_ONLY' : (novel.length === 0 && inverts ? 'UNGROUNDED_INVERSION' : 'UNGROUNDED'),
                data: {
                    ref: s.entry.ref, novel: novel.slice(0, 8), inverts,
                    fromTentative: fromTentative.slice(0, 8), runId,
                },
                before: storedNote || storedValue, after: s.value,
            });
            continue;
        }

        const storedKnownBy = (Array.isArray(fact.knownBy) ? fact.knownBy : [])
            .map(n => String(n ?? '').trim()).filter(Boolean);
        const split = splitSupersedeText(s.value);
        const args = { category: s.entry.category, key: fact.key, value: split.value, note: split.note };
        if (storedKnownBy.length > 0) args.known_by = [...storedKnownBy];
        if (fact.aspect) args.aspect = fact.aspect;
        if (fact.kind) args.kind = fact.kind;
        if (fact.importance !== undefined && fact.importance !== null) args.importance = fact.importance;

        let res = '';
        try {
            res = String(await executeMemoryTool({ tool: 'write_fact', args }, ctx) ?? '');
        } catch (e) {
            res = `ERROR: ${e?.message || e}`;
        }
        // Non-fatal, like every other write outcome in this file: log and carry
        // on. A refused supersede leaves the stale row standing, which is the
        // status quo ante, not a new failure.
        if (/^ERROR/i.test(res)) {
            stats.failed++;
            addDebugLog('fail', `[${runId}] State recheck: SUPERSEDE ${s.entry.ref} refused by write_fact — ${res}`, {
                subsystem: 'agent3', event: 'agent3.state_recheck', reason: 'WRITE_REFUSED',
                data: { ref: s.entry.ref, result: res, runId },
            });
            continue;
        }
        stats.superseded++;
        // The other half of the known_by hazard: an omitted list is what
        // execWriteFact defaults, so a row stored as "everyone" comes back
        // narrowed to whoever is on stage. Repaired here, on the record the
        // write just produced, before the saveDatabase pass persists it.
        if (storedKnownBy.length === 0 && restoreEveryoneKnownBy(s.entry, runId)) stats.knownByRestored++;
        if (restampSupersedeProvenance(s.entry, ctx, runId)) stats.reDated++;
        stats.applied.push({ ref: s.entry.ref, before: storedNote || storedValue, after: s.value, result: res });
        addDebugLog('info', `[${runId}] State recheck: SUPERSEDED ${s.entry.ref} — "${clipText(storedNote || storedValue, 80)}" -> "${clipText(s.value, 80)}"`, {
            subsystem: 'agent3', event: 'agent3.state_recheck', reason: 'SUPERSEDE',
            data: { ref: s.entry.ref, result: res, runId },
            before: storedNote || storedValue, after: s.value,
        });
    }

    // RESOLVED — the lifecycle stamp, deliberately NOT a write_fact. The design
    // decision this encodes: a resolved fact STAYS in the store and STAYS on the
    // sheet (the model still needs the background — deleting or superseding it
    // is what re-opens old conflicts as "new" information), it just stops being
    // sold as the current situation. So value/note are untouched; only the
    // lifecycle fields are stamped, on the SAME live record composeSheet reads
    // (entry.fact IS db.facts[i] here — no upsert replaced it), and persistence
    // rides the same ctx.touchedCategories -> saveDatabase pass every supersede
    // and post-write repair above already relies on.
    //
    // The evidence gate is the SUPERSEDE gate's lower bar, by design: no
    // novel-claim subtraction and no replacement value (a resolution asserts
    // nothing new about the present), but the quoted settling moment must share
    // at least one content stem with the SETTLED window — otherwise its wording
    // came from tentative text or from the model alone, and a verdict that can
    // retire a row from CURRENT STATE must not be free.
    for (const s of resolves) {
        if (stats.resolved >= STATE_RESOLVE_MAX) { stats.capped++; continue; }
        const fact = s.entry.fact;
        if (fact.status === 'resolved') { stats.noop++; continue; }
        const evidenceStems = [...groundingStems(s.value)];
        if (evidenceStems.length > 0 && !evidenceStems.some(t => stateRecheck.settledStems.has(t))) {
            const fromTentative = evidenceStems.filter(t => stateRecheck.tentativeStems.has(t));
            stats.ungrounded++;
            if (fromTentative.length > 0) stats.tentativeOnly++;
            addDebugLog('info', `[${runId}] State recheck: RESOLVED ${s.entry.ref} refused — ${fromTentative.length > 0 ? 'its evidence traces to a TENTATIVE reply, not to any settled message' : 'nothing in its evidence appears in the settled messages'} (unmatched: ${evidenceStems.slice(0, 8).join(', ')})`, {
                subsystem: 'agent3', event: 'agent3.state_recheck',
                reason: fromTentative.length > 0 ? 'RESOLVED_TENTATIVE_ONLY' : 'RESOLVED_UNGROUNDED',
                data: { ref: s.entry.ref, evidence: evidenceStems.slice(0, 8), runId },
                before: String(fact.context || fact.value || ''), after: s.value,
            });
            continue;
        }
        const before = (typeof fact.context === 'string' && fact.context.trim()) || String(fact.value ?? '').trim();
        fact.status = 'resolved';
        if (Number.isInteger(ctx?.sourceIndex)) fact.resolvedAt = ctx.sourceIndex;
        fact.resolvedNote = clipText(s.value, RESOLVED_NOTE_CHARS);
        // lastUpdated moves — a resolution IS a revisit, and recency rankings
        // (cold tier, floor tiebreaks) should see the row as freshly judged.
        fact.lastUpdated = Date.now();
        if (s.entry.db) s.entry.db.updatedAt = Date.now();
        if (!(ctx.touchedCategories instanceof Set)) ctx.touchedCategories = new Set();
        ctx.touchedCategories.add(s.entry.category);
        stats.resolved++;
        stats.applied.push({ ref: s.entry.ref, before, after: `resolved (msg ${fact.resolvedAt ?? '?'}): ${s.value}`, result: 'RESOLVED' });
        addDebugLog('info', `[${runId}] State recheck: RESOLVED ${s.entry.ref} — kept as background, no longer presented as current state ("${clipText(s.value, 80)}")`, {
            subsystem: 'agent3', event: 'fact.resolved', reason: 'STATE_RECHECK',
            data: { ref: s.entry.ref, resolvedAt: Number.isInteger(fact.resolvedAt) ? fact.resolvedAt : null, runId },
            before, after: s.value,
        });
    }

    // `unanswered` is the compliance number the whole feature turns on: the
    // prompt calls the verdict mandatory, and this is the only place that can
    // say whether the agent actually treated it as mandatory. Logged at info on
    // every run (not only when non-zero) so the rate is readable straight off
    // the run log rather than reconstructable.
    addDebugLog(stats.unanswered > 0 ? 'info' : 'pass', `[${runId}] State recheck: ${stats.asked} row(s) asked, ${stats.unchanged} UNCHANGED, ${stats.superseded} superseded, ${stats.resolved} resolved, ${stats.unanswered} unanswered${stats.capped ? `, ${stats.capped} over cap` : ''}${stats.unlisted ? `, ${stats.unlisted} for unlisted refs (refused)` : ''}${stats.ungrounded ? `, ${stats.ungrounded} without settled evidence (refused${stats.tentativeOnly ? `, ${stats.tentativeOnly} tentative-only` : ''})` : ''}${stats.noop ? `, ${stats.noop} no-op` : ''}${stats.contradicted ? `, ${stats.contradicted} contradicted by a later verdict for the same ref (first kept)` : ''}${stats.repeated ? `, ${stats.repeated} repeated` : ''}${stats.knownByRestored ? `, ${stats.knownByRestored} known-by restored` : ''}${stats.reDated ? `, ${stats.reDated} re-dated to this message` : ''}${stats.failed ? `, ${stats.failed} refused by write_fact` : ''}`, {
        subsystem: 'agent3', event: 'agent3.state_recheck',
        data: { ...stats, applied: stats.applied.length, supersedeCap: STATE_SUPERSEDE_MAX, askCap: STATE_RECHECK_MAX, runId },
    });

    traceCapture('agent3.state.recheck', () => ({
        ...stats,
        header: stateRecheck.header,
        body: stateRecheck.body,
        // The ranking, so a missed supersede can be diagnosed as "never asked"
        // (row scored below the cap) versus "asked and stamped UNCHANGED".
        ranked: stateRecheck.entries.map(e => ({
            ref: e.ref, score: Math.round(e.score * 1000) / 1000,
            validAt: Number.isInteger(e.fact?.validAt) ? e.fact.validAt : null,
        })),
        stateRows: stateRecheck.stateRows,
        resolved: stateRecheck.resolved,
        scoredAbove0: stateRecheck.scoredAbove0,
        // Sizes only — the stem sets are the gate's vocabulary, not evidence in
        // themselves, and a refusal already logs the tokens that missed.
        settledStems: stateRecheck.settledStems.size,
        tentativeStems: stateRecheck.tentativeStems.size,
        // Every parsed line IN REPLY ORDER, repeats included, so a contradiction
        // can be read off the trace as the pair it was.
        verdictsParsed: verdicts.map(v => `${v.category}/${v.key} | ${v.verdict}${v.value ? ` | ${v.value}` : ''}`),
    }), { runId, callId });

    return stats;
}

// Prior summary fallback for a failed Call C: the previous sheet renders the
// agent's situational recap as a "Right now: <text>" line — recover it so the
// composed sheet keeps a summary instead of blanking it.
function extractPriorSummary(priorSheetText) {
    const m = /^\s*Right now:\s*(.+)$/im.exec(String(priorSheetText || ''));
    // Clipped on the way back in: a prior head over the cap (written by an
    // older build, or the rare clip that could not land on a boundary) must not
    // seed the next head with more than the next head is allowed to be.
    return m ? clipAtSentenceBoundary(m[1].trim(), SUMMARY_MAX_SENTENCES, SUMMARY_MAX_CHARS) : '';
}

// sentenceBoundaries / clipAtSentenceBoundary (backup 2 for the head caps)
// live in sentence-util.js now — the story-spine clamp in pipeline.js uses the
// same boundary logic so the two can never disagree about where a sentence ends.

// CALL B (BEATS): one batched single-shot call turning every newly-settled
// message into one terse past-tense beat, parsed back by its position number.
async function runBeatsCall({ settledMessages = [], profileId = null, runId = '', signal = null } = {}) {
    const out = { beats: [], tokensIn: 0, tokensOut: 0, error: null, durationMs: 0 };
    const msgs = (Array.isArray(settledMessages) ? settledMessages : []).filter(m => m && String(m?.text || '').trim());
    if (msgs.length === 0) return out;

    const start = Date.now();
    const numbered = msgs.map((m, i) => `${i + 1}. ${renderMessageLine(m)}`).join('\n');
    out.tokensIn = Math.ceil((DEFAULT_BEATS_PROMPT.length + numbered.length) / 4);

    // Call B's PROVENANCE, and only that. `numbered` is the user prompt, and the
    // call layer already captures every dispatched system/user body — so the text
    // is threaded to it via callAgentLLM's trailing `trace` argument below rather
    // than copied into a second entry here. Passing that argument is what makes
    // the deferral safe: without it the call layer's copy carries no runId and no
    // callId, so nothing ties it to the run that produced it.
    //
    // What is left is the half no call layer can see: systemPrompt here is
    // DEFAULT_BEATS_PROMPT unconditionally — the memoryAgentPrompt override
    // reaches Call A ONLY. "I edited the agent prompt and the beats did not
    // change" is expected behaviour, and should be readable rather than inferred.
    const beatsCallId = isTraceRecording() ? newTraceCallId('beats') : null;
    traceCapture('agent3.prompt.beats', () => ({
        call: 'beats',
        source: 'built-in-default (no settings override reaches this call)',
        systemChars: DEFAULT_BEATS_PROMPT.length,
        userPromptChars: numbered.length,
        messages: msgs.length,
    }), { runId, callId: beatsCallId, note: 'prompt TEXT rides the llm-call layer under this callId' });
    let reply = '';
    try {
        reply = String(await callAgentLLM(DEFAULT_BEATS_PROMPT, numbered, profileId, 'beats', signal, { runId, callId: beatsCallId }) || '');
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
    priorSheetText, reflection, observationDate, withheldNewestReply = false,
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
    // The caller (runHeadCall) has already withheld the newest storyteller
    // reply: that reply can still be swiped, and a swipe does NOT trigger a new
    // memory run, so a head written from swipe #1 would be injected as settled
    // truth into every later swipe. Only older tentative messages and the
    // newest user message reach Call C; the section is omitted when empty.
    // The note is stated only when a reply WAS withheld: telling the model a
    // reply is missing when none was dropped makes it hedge against a reply
    // that does not exist.
    const withheldNote = withheldNewestReply ? ' — the newest storyteller reply is withheld because it can still be swiped; frame the next beat without it' : '';
    if (Array.isArray(tentativeMessages) && tentativeMessages.length > 0) {
        parts.push(`## Tentative messages (may still change; use for framing the next beat${withheldNote})\n${tentativeMessages.map(renderMessageLine).join('\n\n')}`);
    } else if (withheldNewestReply) {
        parts.push('## Tentative messages\n(none shown — the newest storyteller reply is withheld because it can still be swiped; frame the next beat from the settled messages)');
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

    // Swipe re-injection guard: the tentative tail ends with the assistant reply
    // that was JUST generated (pipeline runs post-reply). If the user swipes it,
    // no new run fires (no newly settled messages), so whatever Call C wrote
    // from that reply ("Right now:", TIMELINE, PRESENT) would be injected as
    // established truth into every alternative swipe — invented details from
    // swipe #1 then get reproduced on every later swipe. Drop that one message
    // here (not in pipeline.js) so Call A / Call B keep their inputs unchanged.
    // `role` comes from toAgentMessage ('USER' | 'CHAR'); anything not USER is
    // the storyteller, matching renderMessageLine's own convention.
    const tentativeList = Array.isArray(tentativeMessages) ? tentativeMessages : [];
    const newestTentative = tentativeList[tentativeList.length - 1];
    const withheldNewestReply = Boolean(newestTentative) && newestTentative.role !== 'USER';
    const headTentative = withheldNewestReply ? tentativeList.slice(0, -1) : tentativeList;
    if (withheldNewestReply) {
        addDebugLog('debug', `[${runId}] Head call: withheld newest storyteller reply (msg #${newestTentative.index}) — it can still be swiped, so it must not shape the head`, {
            subsystem: 'agent3', event: 'agent3.head', data: { withheldIndex: newestTentative.index, tentativeSeen: headTentative.length },
        });
    }

    const userPrompt = buildHeadUserPrompt({
        settledMessages, tentativeMessages: headTentative, characterInfo, userPersona,
        priorSheetText, reflection, observationDate, withheldNewestReply,
    });
    out.tokensIn = Math.ceil((DEFAULT_HEAD_PROMPT.length + userPrompt.length) / 4);

    // Call C's provenance — same split as Call B: the assembled prompt travels to
    // the call layer through `trace`, this entry carries what that layer cannot
    // know. The composition matters more here than anywhere else in this file:
    // buildHeadUserPrompt assembles the prior head, the current scene card, the
    // spine tail and the rolling reflection summary, and every one of those is
    // read out of a store THIS SAME RUN is about to overwrite, so the captured
    // prompt is the only surviving copy of the state Call C actually saw.
    const headCallId = isTraceRecording() ? newTraceCallId('head') : null;
    traceCapture('agent3.prompt.head', () => ({
        call: 'head',
        source: 'built-in-default (no settings override reaches this call)',
        systemChars: DEFAULT_HEAD_PROMPT.length,
        userPromptChars: userPrompt.length,
        settled: (Array.isArray(settledMessages) ? settledMessages : []).length,
        tentative: headTentative.length,
        withheldNewestReply,
    }), { runId, callId: headCallId, note: 'prompt TEXT rides the llm-call layer under this callId' });
    let reply = '';
    try {
        reply = String(await callAgentLLM(DEFAULT_HEAD_PROMPT, userPrompt, profileId, 'sheet-head', signal, { runId, callId: headCallId }) || '');
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
    await enforceHeadCaps(parsed, { profileId, runId, signal, headCallId });
    out.durationMs = Date.now() - start;
    addDebugLog('info', `[${runId}] Head call: summary ${parsed.summary ? 'yes' : 'no'}, marker ${parsed.sceneMarker ? 'yes' : 'no'}, timeline ${parsed.timeline ? 'yes' : 'no'}, present ${parsed.present.length} (${out.durationMs}ms)`, {
        subsystem: 'agent3', event: 'agent3.head',
        data: { hasSummary: !!parsed.summary, hasMarker: !!parsed.sceneMarker, hasTimeline: !!parsed.timeline, present: parsed.present.length, durationMs: out.durationMs },
    });
    return out;
}

// The head caps (see SUMMARY_MAX_* / TIMELINE_MAX_CHARS at DEFAULT_HEAD_PROMPT),
// applied to the parsed head IN PLACE. Two backups per field, in order:
//   1. ONE condensing re-ask (same profile, purpose 'sheet-head-condense') — for
//      TIMELINE only when the summary did not already spend it, so an
//      over-long head costs at most one extra call per run;
//   2. a deterministic clip at the last sentence boundary inside the cap.
// A re-ask that fails, returns nothing, or is still over the cap falls through
// to the clip; the result is always within the caps. Mirrors the story-spine
// rewrite in pipeline.js, with the clip added because this field is re-fed to
// the next run and an accepted overrun would compound turn after turn.
async function enforceHeadCaps(parsed, { profileId = null, runId = '', signal = null, headCallId = null } = {}) {
    if (!parsed) return;
    const summaryOver = (s) => countSentenceEnds(s) > SUMMARY_MAX_SENTENCES || s.length > SUMMARY_MAX_CHARS;
    const timelineOver = (s) => s.length > TIMELINE_MAX_CHARS;
    let condenseUsed = false;

    const condense = async (field, text, systemPrompt) => {
        condenseUsed = true;
        let answer = '';
        try {
            // required:false — the condense prompts ask for "the recap only", not
            // a SENTENCE: line, so a label-less reply is the normal answer here.
            answer = extractSentenceLine(await callAgentLLM(systemPrompt, text, profileId, 'sheet-head-condense', signal, { runId, callId: headCallId }), { required: false });
        } catch (e) {
            addDebugLog('info', `[${runId}] Head ${field} condense call failed (${e?.message || e}) — falling through to the clip`, {
                subsystem: 'agent3', event: 'agent3.head', reason: 'HEAD_CONDENSE_FAILED', data: { field },
            });
            return '';
        }
        // Strip a label the model may have echoed ("SUMMARY: ...").
        answer = answer.replace(/^(SUMMARY|TIMELINE)\s*:\s*/i, '').trim();
        // A protocol token or a near-empty line is a refusal, not a recap; the
        // harness's dry transport answers every unknown call with "#DONE".
        if (/^#/.test(answer) || answer.split(/\s+/).length < 4) return '';
        return answer;
    };

    const apply = async ({ field, over, prompt, maxSentences, maxChars }) => {
        const before = String(parsed[field] || '').replace(/\s+/g, ' ').trim();
        if (!before || !over(before)) return;
        let current = before;
        if (!condenseUsed) {
            const condensed = await condense(field, before, prompt);
            if (condensed && condensed.length < before.length) {
                current = condensed;
                addDebugLog('info', `[${runId}] Head ${field} condensed by re-ask: ${before.length} -> ${current.length} chars (${countSentenceEnds(before)} -> ${countSentenceEnds(current)} sentence ends)${over(current) ? ' — still over the cap, clipping' : ''}`, {
                    subsystem: 'agent3', event: 'agent3.head', reason: 'HEAD_CONDENSED',
                    data: { field, beforeChars: before.length, afterChars: current.length, beforeSentences: countSentenceEnds(before), afterSentences: countSentenceEnds(current), stillOver: over(current) },
                });
            }
        }
        if (over(current)) {
            const clipped = clipAtSentenceBoundary(current, maxSentences, maxChars);
            addDebugLog('info', `[${runId}] Head ${field} clipped at a sentence boundary: ${current.length} -> ${clipped.length} chars (cap ${maxChars} chars / ${Number.isFinite(maxSentences) ? maxSentences : 'any'} sentences)`, {
                subsystem: 'agent3', event: 'agent3.head', reason: 'HEAD_CLIPPED',
                data: { field, beforeChars: current.length, afterChars: clipped.length, beforeSentences: countSentenceEnds(current), afterSentences: countSentenceEnds(clipped), hardClip: clipped.endsWith('…') },
            });
            current = clipped;
        }
        parsed[field] = current;
    };

    await apply({ field: 'summary', over: summaryOver, prompt: HEAD_CONDENSE_SUMMARY_PROMPT, maxSentences: SUMMARY_MAX_SENTENCES, maxChars: SUMMARY_MAX_CHARS });
    await apply({ field: 'timeline', over: timelineOver, prompt: HEAD_CONDENSE_TIMELINE_PROMPT, maxSentences: Infinity, maxChars: TIMELINE_MAX_CHARS });
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
                // Correlation only. Minted per call rather than per batch so the
                // export can tell six backfills apart; without a trace argument
                // the call layer's prompt/reply capture for these would carry no
                // run and no call id at all.
                isTraceRecording() ? { runId, callId: newTraceCallId('beat-backfill') } : null,
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
            // Correlation only — same reason as the backfill call above.
            isTraceRecording() ? { runId, callId: newTraceCallId('beat-brevity') } : null,
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

// ===========================================================================
// PREMISE FLOOR — WHICH facts, given a cap.
//
// NOTE (v0.85.2): the quota machinery below is now the FALLBACK ranking, used
// only when the turn carries no entity signal. See the RELEVANCE-SCORED FLOOR
// block after floorRank for the primary path and the measured failure it fixes.
//
// The defect this replaces: admit `importance >= 4 || kind === 'trait'`, sort
// `importance DESC, lastUpdated DESC`, take the top 15. Measured on the
// v0.81.0 export, that produced a floor of 11 Events out of 15, because at
// equal importance the freshest row always won — 14 of the 23 importance-4
// facts were evicted on their timestamp alone. The character's only home
// (Places/naoto_apartment), her only human friend (People/rise_name,
// Relationships/naoto_rise_bond), her height and her parents' photo appeared on
// none of the 33 sheets. `lastUpdated` as a GLOBAL sort key is a recency
// ranking wearing an importance ranking's clothes.
//
// Two changes, both measured (see the numbers in the settings-estimate comment
// below):
//
// 1. NO ADMISSION GATE. Every hot, active, visible fact is a candidate. The old
//    gate was a second, invisible cap: `imp >= 4 || trait` admitted 50 of 65
//    facts, so 8 of them — every importance-3 moment and mid-importance event —
//    could not reach the sheet at ANY cap, which would have made "unlimited"
//    a lie. Notably it also excluded 7 of the 8 `kind === 'state'` rows, the
//    exact rows that go stale and the only ones the state recheck can repair.
//    Ranking, not admission, is what keeps a cap-15 sheet load-bearing.
//
// 2. QUOTAS instead of a global sort. Each fact lands in exactly one bucket;
//    each bucket gets max(min, floor(cap * share)) slots, dealt ROUND-ROBIN by
//    rank so at a small cap every bucket is represented before any bucket gets
//    a second row. Whatever the quotas do not spend — a bucket with fewer facts
//    than slots — falls through to a final pass over everything still unpicked,
//    ranked by importance. The shares sum to 1.10 on purpose: over-subscribed
//    so buckets that run dry release their slots and the cap always fills.
//    `lastUpdated` survives only as the last tiebreak INSIDE a bucket.
//
// Bucket order is significant — the first matching test wins. `state` is tested
// first, so a state in Relationships counts as a state; that is deliberate,
// because staleness, not category, is what makes those rows urgent.
const PREMISE_FLOOR_QUOTAS = [
    // States are what ROTS. A stale state ships under a header that calls it
    // "true RIGHT NOW", and the recheck can only repair a row the sheet is
    // currently injecting — a state that falls out of the floor is unreparable
    // for the rest of the chat. Largest share for the smallest bucket.
    // status === 'resolved' rows are OUT of this bucket: its 40% share exists
    // because live states rot under the "true RIGHT NOW" header, and a resolved
    // row no longer ships under that header — letting it hold a state slot
    // would spend the urgency budget on rows that are already past tense. They
    // stay floor-ELIGIBLE (remainder pass, deprioritized in floorRank), because
    // the design is "keep the background in context", never "drop it".
    { id: 'state', min: 2, share: 0.40, test: (f) => f.kind === 'state' && f.status !== 'resolved' },
    // Who the characters ARE. The bucket the old sort starved.
    { id: 'identity', min: 2, share: 0.25, test: (f, cat) => f.kind === 'trait' && cat !== 'Places' && cat !== 'Relationships' && cat !== 'World' },
    // The premise beats (cube arrival, teleport, pregnancy). Capped, not
    // excluded: at cap 15 the old floor was 11 of these, at cap 15 the new one
    // is 3.
    { id: 'event', min: 2, share: 0.20, test: (f) => f.kind === 'event' || f.kind === 'moment' },
    { id: 'relationship', min: 1, share: 0.10, test: (f, cat) => cat === 'Relationships' },
    // min 2, above its 0.08 share, and the reason is a measured one: with min 1
    // the single slot goes to the higher-importance Places/cube_interior and
    // the apartment the character actually LIVES in never ships.
    { id: 'place', min: 2, share: 0.08, test: (f, cat) => cat === 'Places' },
    { id: 'world', min: 1, share: 0.07, test: (f, cat) => cat === 'World' },
];

function floorRank(a, b) {
    // Resolved rows rank below live rows of ANY importance: they are settled
    // background, and at a tight cap a live row is always the better spend. They
    // remain selectable (buckets they still match, and the remainder pass), so
    // the background never becomes unreachable — it just never evicts the present.
    const resolvedDiff = (a.fact?.status === 'resolved' ? 1 : 0) - (b.fact?.status === 'resolved' ? 1 : 0);
    if (resolvedDiff !== 0) return resolvedDiff;
    const impDiff = clampImportance(b.fact.importance) - clampImportance(a.fact.importance);
    if (impDiff !== 0) return impDiff;
    return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
}

// ===========================================================================
// RELEVANCE-SCORED FLOOR — WHICH rows, given who is actually on stage.
//
// The defect this replaces: floorRank is importance desc, lastUpdated desc, and
// on the 0.85.0 150-turn runs (400+ facts, Opus stamping most rows importance
// 4-5) that degenerated to "most recently touched wins" — on probe turns the
// asked fact was on a sheet row only 36-46% of the time and the answer used it
// 18-27%. Importance cannot rank 200 tied rows; PRESENCE can. So when the turn
// carries an entity signal (subjects named in the last user message, subjects
// on the scene's PRESENT line, subjects in the current scene's beats) the floor
// ranks by relevance-to-now instead. Without a signal (empty store, settings
// cost estimate, sceneless chat) the quota path below runs unchanged — the
// quotas are NOT a secondary constraint on the scored path, because they slice
// by KIND and the scorer already ranks every kind on one scale; the premise
// guarantee the quotas also carried moves into the safety net (below).
//
// Score per candidate row:
//   2.0  a participant is named in the last user message
//   1.5  a participant is on the scene's PRESENT line
//   1.0  hop1 — a participant shares a graph edge with a named/present entity,
//        or appears in the current scene's beats
//   0.5  hop2 — two edges away
//   0.5  sameScene — validAt inside the current scene's message range
//   0.35 x recency (same half-life shape as salienceScore, database.js)
//   0.3  x importance/5
//  -0.5  cold penalty (BUDGET-cold rows only, see below)
//
// "Participants" are every known subject token in the row: deriveSubject plus
// any other subject appearing in the key — a pair key like `wren_bernd_trust`
// belongs to BOTH names even though deriveSubject only takes the first token
// (deriveSubject and the stored data are deliberately untouched). Edges are the
// ones that exist in the data: co-participants of one row, relationships
// primary/secondary/tertiary refs, agentLinks refs, and small knownBy circles
// (a knownBy of ≤4 subjects is a who-shares-this-secret edge; longer lists are
// broadcast visibility, not a relationship, and would make hop1 universal).
//
// COLD: on the scored path BUDGET-cold rows are candidates with a 0.5 penalty —
// coldness becomes a tie-breaker, not an exclusion, because a budget demotion
// says only that the row ranked below a bookkeeping line, and a row the user
// just NAMED outranking that line is precisely the correction this scorer
// exists for. VERDICT-cold rows stay excluded on every path: they were judged
// wrong, and a resurfaced verdict is a wrong line sold as truth (see
// COLD_VIA_VERDICT, database.js).
const RELEVANCE_HALF_LIFE_DAYS = { trait: 90, state: 3, event: 7, moment: 30 };
const RELEVANCE_W_NAMED = 2;
const RELEVANCE_W_PRESENT = 1.5;
const RELEVANCE_W_HOP1 = 1;
const RELEVANCE_W_HOP2 = 0.5;
const RELEVANCE_W_SAME_SCENE = 0.5;
const RELEVANCE_W_RECENCY = 0.35;
const RELEVANCE_W_IMPORTANCE = 0.3;
const RELEVANCE_COLD_PENALTY = 0.5;
// The premise safety net: the top rows by pure importance (floorRank) ship
// regardless of score, because facts about the PREMISE must not vanish from
// the sheet on the turns when nobody happens to name their subject.
const RELEVANCE_SAFETY_NET_MIN = 8;

function safeCharToken(name) {
    try { return String(resolveCharacterToken(name) || '').trim(); } catch { return ''; }
}

// Every known subject token this row is ABOUT (subject + pair-key co-subjects).
function factParticipants(fact, knownSubjects) {
    const parts = new Set();
    const subj = String(deriveSubject(fact) || '').trim();
    if (subj) parts.add(subj);
    for (const tok of String(fact?.key || '').toLowerCase().split('_')) {
        if (tok && tok !== subj && knownSubjects.has(tok)) parts.add(tok);
    }
    return parts;
}

function refSubjectTokens(ref, knownSubjects) {
    const out = [];
    for (const tok of String(ref || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (tok && knownSubjects.has(tok)) out.push(tok);
    }
    return out;
}

// Subject-token adjacency over the edges that exist in the data. O(rows x
// edges) once per compose over a ~500-row store — measured ceiling well under
// the 6 ms selectPremiseFloor already spends at 4 000 facts; no persistent
// index is warranted.
function buildSubjectAdjacency(databases, knownSubjects) {
    const adj = new Map();
    const link = (a, b) => {
        if (!a || !b || a === b) return;
        let sa = adj.get(a); if (!sa) { sa = new Set(); adj.set(a, sa); }
        let sb = adj.get(b); if (!sb) { sb = new Set(); adj.set(b, sb); }
        sa.add(b); sb.add(a);
    };
    for (const db of Object.values(databases || {})) {
        if (!db || !Array.isArray(db.facts)) continue;
        for (const fact of db.facts) {
            if (!fact || !isActiveFact(fact)) continue;
            const parts = [...factParticipants(fact, knownSubjects)];
            for (let i = 0; i < parts.length; i++) {
                for (let j = i + 1; j < parts.length; j++) link(parts[i], parts[j]);
            }
            const rels = fact.relationships || {};
            for (const list of [rels.primary, rels.secondary, rels.tertiary]) {
                for (const ref of (Array.isArray(list) ? list : [])) {
                    for (const tok of refSubjectTokens(ref, knownSubjects)) {
                        for (const p of parts) link(p, tok);
                    }
                }
            }
            for (const l of (Array.isArray(fact.agentLinks) ? fact.agentLinks : [])) {
                for (const tok of refSubjectTokens(l?.ref, knownSubjects)) {
                    for (const p of parts) link(p, tok);
                }
            }
            const kb = Array.isArray(fact.knownBy) ? fact.knownBy : [];
            // ≤4: a small circle is a relationship edge; a broadcast list is not.
            if (kb.length > 0 && kb.length <= 4) {
                for (const name of kb) {
                    const tok = safeCharToken(name);
                    if (tok && knownSubjects.has(tok)) {
                        for (const p of parts) link(p, tok);
                    }
                }
            }
        }
    }
    return adj;
}

// The turn's entity signal. Built once per compose; `stats` is filled by
// selectPremiseFloor so composeSheet can log one sheet.relevance line.
export function buildRelevanceContext({ databases = {}, userText = '' } = {}) {
    const knownSubjects = new Set();
    for (const db of Object.values(databases || {})) {
        if (!db || !Array.isArray(db.facts)) continue;
        for (const fact of db.facts) {
            if (!fact || !isActiveFact(fact)) continue;
            const subj = String(deriveSubject(fact) || '').trim();
            if (subj) knownSubjects.add(subj);
        }
    }

    // Named in the LAST USER MESSAGE: known subject tokens verbatim, plus
    // capitalised words resolved through the alias registry ("Trish Mitchells"
    // -> trish). Unknown capitalised words ("The", "I") resolve to nothing.
    const named = new Set();
    for (const raw of (String(userText || '').match(/[\p{L}\p{N}'’_-]+/gu) || [])) {
        // Probe questions are possessive-heavy ("what is Mira's scar?") — the
        // 's would make the name unmatchable, so both spellings are tried.
        for (const w of [raw, raw.replace(/['’]s$/i, '')]) {
            const clean = cleanWord(w);
            if (!clean) continue;
            const lower = clean.toLowerCase();
            if (lower.length >= 3 && knownSubjects.has(lower)) { named.add(lower); break; }
            if (isCapitalizedWord(clean)) {
                const tok = safeCharToken(clean);
                if (tok && knownSubjects.has(tok)) { named.add(tok); break; }
            }
        }
    }

    const present = new Set();
    try {
        for (const name of getScenePresent()) {
            const tok = safeCharToken(name);
            if (tok && knownSubjects.has(tok)) present.add(tok);
        }
    } catch {  }

    const beats = new Set();
    let sceneStartMsg = -1;
    try {
        const scene = getCurrentScene();
        if (scene) {
            sceneStartMsg = Number.isInteger(scene.startMsg) ? scene.startMsg : -1;
            for (const b of (Array.isArray(scene.beats) ? scene.beats : [])) {
                for (const w of (String(b?.sentence || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])) {
                    if (w.length >= 3 && knownSubjects.has(w)) beats.add(w);
                }
            }
        }
    } catch {  }

    const base = new Set([...named, ...present, ...beats]);
    const hasSignal = base.size > 0;
    const dist1 = new Set();
    const dist2 = new Set();
    if (hasSignal) {
        const adj = buildSubjectAdjacency(databases, knownSubjects);
        for (const e of base) {
            for (const n of (adj.get(e) || [])) if (!base.has(n)) dist1.add(n);
        }
        for (const d of dist1) {
            for (const n of (adj.get(d) || [])) if (!base.has(n) && !dist1.has(n)) dist2.add(n);
        }
    }
    // Named before present before beats, so the log's head is the strongest signal.
    const topEntities = [...base].slice(0, 8);
    return { knownSubjects, named, present, beats, dist1, dist2, sceneStartMsg, hasSignal, topEntities, stats: null };
}

function scoreFloorRow(row, rel, now) {
    const fact = row.fact;
    const parts = factParticipants(fact, rel.knownSubjects);
    const hit = (set) => { for (const p of parts) if (set.has(p)) return true; return false; };

    const named = hit(rel.named);
    const present = hit(rel.present);
    // A subject the scene's beats mention is on stage even when nobody just
    // typed the name — credited at the hop1 weight. dist1/dist2 are disjoint
    // by construction, so a row can carry hop1 and hop2 only via two different
    // participants, which is a genuinely stronger position.
    const hop1 = hit(rel.dist1) || hit(rel.beats);
    const hop2 = hit(rel.dist2);
    const sameScene = rel.sceneStartMsg >= 0
        && Number.isInteger(Number(fact.validAt)) && fact.validAt != null
        && Number(fact.validAt) >= rel.sceneStartMsg;

    const last = effectiveRecencyTs(fact);
    const ageDays = last > 0 ? Math.max(0, (now - last) / 86400000) : 36500;
    const halfLife = RELEVANCE_HALF_LIFE_DAYS[normalizeKind(fact.kind)] || RELEVANCE_HALF_LIFE_DAYS.trait;
    const recency = Math.pow(0.5, ageDays / halfLife);

    const score = (named ? RELEVANCE_W_NAMED : 0)
        + (present ? RELEVANCE_W_PRESENT : 0)
        + (hop1 ? RELEVANCE_W_HOP1 : 0)
        + (hop2 ? RELEVANCE_W_HOP2 : 0)
        + (sameScene ? RELEVANCE_W_SAME_SCENE : 0)
        + RELEVANCE_W_RECENCY * recency
        + RELEVANCE_W_IMPORTANCE * (clampImportance(fact.importance) / 5)
        - (fact.cold === true ? RELEVANCE_COLD_PENALTY : 0);
    return { score, hop1, hop2, sameScene };
}

function selectFloorByRelevance(all, eff, relevance) {
    const now = Date.now();
    let hop1 = 0, hop2 = 0, sameScene = 0;
    for (const row of all) {
        const s = scoreFloorRow(row, relevance, now);
        row.relScore = s.score;
        if (s.hop1) hop1++;
        if (s.hop2) hop2++;
        if (s.sameScene) sameScene++;
    }
    const byScore = [...all].sort((a, b) => (b.relScore - a.relScore) || floorRank(a, b));
    // Safety net first (never cold rows — the net is the premise anchor, and a
    // demoted row anchoring the premise would undo the demotion every turn),
    // then the best-scored remainder up to the cap.
    const net = all.filter(r => r.fact.cold !== true).sort(floorRank).slice(0, Math.min(RELEVANCE_SAFETY_NET_MIN, eff));
    const netSet = new Set(net);
    const topSet = new Set(byScore.slice(0, eff));
    let safetyNet = 0;
    for (const r of net) if (!topSet.has(r)) safetyNet++;
    const picked = [...net];
    for (const r of byScore) {
        if (picked.length >= eff) break;
        if (netSet.has(r)) continue;
        picked.push(r);
    }
    relevance.stats = { scored: all.length, hop1, hop2, sameScene, safetyNet };
    return picked;
}

// Returns up to `cap` { fact, category } rows. `cap` may be Infinity.
// `exclude` is the `${category}:${key}` id set the caller has already spent
// rows on — the floor never pays twice for a row NEED already carries.
//
// Exported for the settings UI: this is the function estimatePremiseFloorCost
// runs to answer "at your current store, what does this slider position cost".
export function selectPremiseFloor({ databases = {}, cap = PREMISE_FLOOR_DEFAULT, exclude = null, relevance = null } = {}) {
    // With an entity signal the floor ranks by relevance-to-now (see the block
    // above); without one (settings estimate, sceneless chat, empty store) the
    // quota path below runs unchanged.
    const scoredMode = !!(relevance && relevance.hasSignal);
    const buckets = PREMISE_FLOOR_QUOTAS.map(q => ({ q, list: [], quota: 0 }));
    const all = [];
    for (const [rawCat, db] of Object.entries(databases || {})) {
        if (!db || !Array.isArray(db.facts)) continue;
        const category = mapLegacyCategory(String(rawCat || '').trim() || 'Unsorted');
        for (const fact of db.facts) {
            if (!fact || !isActiveFact(fact) || !isFactVisible(fact)) continue;
            // Cold-tiered facts stay out of the floor — otherwise a demoted-but-
            // important-looking fact rides back in every single turn. The scored
            // path admits BUDGET demotions only (a bookkeeping line, penalized
            // 0.5 in the score), never VERDICT ones — a judged-wrong row must
            // not resurface under "established truth".
            if (fact.cold === true && !(scoredMode && isBudgetCold(fact))) continue;
            if (exclude && exclude.has(`${category}:${fact.key}`)) continue;
            const row = { fact, category };
            all.push(row);
            if (scoredMode) continue;
            // An entry matching no bucket (an Unsorted non-trait, say) is still
            // in `all`, so it can only be reached by the remainder pass below.
            const b = buckets.find(x => x.q.test(fact, category));
            if (b) b.list.push(row);
        }
    }

    const eff = Number.isFinite(cap) ? Math.max(0, Math.trunc(cap)) : all.length;
    if (eff <= 0 || all.length === 0) return [];

    if (scoredMode) return selectFloorByRelevance(all, eff, relevance);

    for (const b of buckets) {
        b.list.sort(floorRank);
        b.quota = Math.max(b.q.min, Math.floor(eff * b.q.share));
    }

    const picked = [];
    const taken = new Set();
    let round = 0;
    let progress = true;
    while (picked.length < eff && progress) {
        progress = false;
        for (const b of buckets) {
            if (picked.length >= eff) break;
            if (round >= b.quota) continue;
            const row = b.list[round];
            if (!row) continue;
            picked.push(row);
            taken.add(row);
            progress = true;
        }
        round++;
    }

    if (picked.length < eff) {
        for (const row of [...all].sort(floorRank)) {
            if (picked.length >= eff) break;
            if (taken.has(row)) continue;
            picked.push(row);
            taken.add(row);
        }
    }
    return picked;
}

// ===========================================================================
// WHAT A CAP COSTS — the number the settings UI renders under the slider.
//
// Measured, not modelled: every row is rendered with the SAME buildFactLine the
// sheet uses, and the tokens are chars/4 (the convention already used by
// estimateInjectionTokens in fact-retrieval.js). On the v0.81.0 export a
// rendered fact line averages 208 characters — roughly 52 tokens, because the
// line carries the note, the known-by prefix and the recency tail, not just a
// value. Any estimate built on "~15 tokens a row" is out by 3.5x.
//
// The measured curve for that store (65 facts, 33 sheets, replayed):
//   cap 15  -> 47% of the store on the sheet on average (29% by message 77)
//   cap 22  -> 61% (40%)
//   cap 30  -> 74% (52%)
//   cap 50  -> 95% (83%)
//   cap 65+ -> 100% (100%) — 65 is the whole store; unlimited is identical
// (The curve predates the section budget and compact supply rows: this
// function still renders FULL rows, so it prices the sheet's ceiling, not the
// budget-capped sheet composeSheet actually emits.)
// Those numbers are for a 65-fact store, in which no category ever held more
// than 50 demotable rows and the cold tier therefore never bound. They are NOT
// a statement about large stores: what a cap buys at 4 000 facts is cap/4 000,
// and only UNLIMITED reaches the whole store. See the HOT_SET_MIN block in
// database.js for the ceiling that used to sit under all of this invisibly.
//
// UNLIMITED is not free and does not stop growing: the store grew 0.83 facts
// per message, so ~415 facts at 500 messages, ~21 500 tokens of sheet per turn,
// every turn, uncached. That is the trade this function exists to put in front
// of the user rather than decide for them.
//
// THE DENOMINATOR IS THE WHOLE STORE, and that is the fix this shape carries.
// storeFacts used to count HOT facts only, so every fact the cold tier had
// demoted vanished from the numerator AND the denominator together — the UI
// rendered "all 4 000 stored memories on the sheet (100%)" over a store holding
// 6 000. A denominator that shrinks with the numerator cannot produce a wrong
// percentage; it produces a meaningless one, which is worse. So: storeFacts is
// every ACTIVE fact, reachable or not, and every row that cannot reach the
// sheet is counted, by reason, in `excluded`. `excluded.cold + excluded.invisible`
// equals `excluded.total` exactly, and `total.rows + excluded.total <= storeFacts`
// always — the gap is what the CAP costs, which is the thing the slider is for.
//
// SHAPE (stable — the settings UI codes against these field names):
//   { cap, unlimited, setting,
//     storeFacts,      // ALL active facts. The denominator. Hot + cold.
//     eligible,        // active AND visible AND hot — what the floor may draw from
//     inactive,        // superseded history snapshots; context only, NOT in storeFacts
//     excluded: {
//        total,          // storeFacts - eligible; rows no cap can put on the sheet
//        cold,           // demoted by the cold tier or by a conflict/merge loss
//        invisible,      // knownBy excludes everyone currently in the scene
//        coldReleasable, // of `cold`, how many the CURRENT setting already frees
//     },
//     hotSetBudget,    // demotable rows per category the setting now allows; null = no limit
//     floor:   { rows, chars, tokens },
//     other:   { rows, chars, tokens },   // NEED + sticky recovered
//     total:   { rows, chars, tokens },   // what one turn's WRITER sheet costs
//     ceiling: { rows, chars, tokens },   // the same at UNLIMITED, for the warning
//     coverage:        { rows, of, pct },   // total.rows / storeFacts
//     ceilingCoverage: { rows, of, pct },   // ceiling.rows / storeFacts
//     perTurn: {  // see below — the sheet is billed three times, not once
//        sheet: {rows,tokens}, injectedRefs: {rows,tokens,capped},
//        lookupRefs: {rows,tokens,enabled}, tokens },
//     tokensPerRow }
export async function estimatePremiseFloorCost(capOverride = undefined) {
    const settings = getSettingsSafe() || {};
    const resolved = capOverride === undefined
        ? resolvePremiseFloorCap(settings)
        : resolvePremiseFloorCap({ [PREMISE_FLOOR_SETTING_KEY]: capOverride });

    let databases = {};
    try { databases = await getAllDatabases(); } catch { databases = {}; }
    let nowCtx = null;
    try { nowCtx = getTurnNowContext(); } catch { nowCtx = null; }

    const chars = (list) => list.reduce((n, r) => n + buildFactLine(r.fact, r.category, nowCtx).length + 1, 0);
    const cost = (list) => {
        const c = chars(list);
        return { rows: list.length, chars: c, tokens: Math.ceil(c / 4) };
    };

    // The other row sources as they stand RIGHT NOW, so the estimate is this
    // chat's sheet and not a generic one. They are resolved first and excluded
    // from the floor for the same reason composeSheet does it: the floor does
    // not pay twice for a row NEED already carries.
    const other = [];
    const exclude = new Set();
    const addRef = (ref) => {
        try {
            const category = mapLegacyCategory(String(ref?.category || '').trim() || 'Unsorted');
            const key = String(ref?.key || '').trim();
            if (!key) return;
            const db = databases[category];
            if (!db) return;
            const fact = findFactMatch(db, key);
            if (!fact || !isActiveFact(fact) || !isFactVisible(fact) || fact.cold === true) return;
            const id = `${category}:${fact.key}`;
            if (exclude.has(id)) return;
            exclude.add(id);
            other.push({ fact, category });
        } catch {  }
    };
    try { for (const r of getLastNeedRefs()) addRef(r); } catch {  }
    try { for (const r of getRecoveredRefs()) addRef(r); } catch {  }

    const floor = selectPremiseFloor({ databases, cap: resolved.cap, exclude });
    const ceilingFloor = resolved.unlimited ? floor : selectPremiseFloor({ databases, cap: Infinity, exclude });

    // THE CENSUS. Counted in one pass so the four numbers cannot disagree:
    // storeFacts is every active fact, and each active fact lands in exactly one
    // of eligible / excludedCold / excludedInvisible. Cold is tested FIRST so a
    // row that is both is counted once, as cold — cold is the condition the
    // slider governs, invisibility is a property of the current scene.
    let storeFacts = 0;
    let inactive = 0;
    let eligible = 0;
    let excludedCold = 0;
    let excludedInvisible = 0;
    for (const db of Object.values(databases || {})) {
        if (!db || !Array.isArray(db.facts)) continue;
        for (const f of db.facts) {
            if (!f) continue;
            if (!isActiveFact(f)) { inactive++; continue; }
            storeFacts++;
            if (f.cold === true) excludedCold++;
            else if (!isFactVisible(f)) excludedInvisible++;
            else eligible++;
        }
    }
    // coldReleasable answers the one question the raw cold count leaves open:
    // "is this number the setting talking, or is it just stale?" It is the rows
    // the CURRENT budget already frees and that reconcileColdTier() will hand
    // back on the next turn — normally 0, because the memory run reconciles
    // before it composes, and non-zero only in the window between a slider
    // change and the next turn.
    let census = { cold: excludedCold, coldReleasable: 0, budget: Infinity };
    try { census = coldTierCensus(databases); } catch {  }

    const f = cost(floor);
    const o = cost(other);
    const c = cost([...ceilingFloor, ...other]);
    const total = { rows: f.rows + o.rows, chars: f.chars + o.chars, tokens: Math.ceil((f.chars + o.chars) / 4) };
    const pctOf = (rows) => (storeFacts > 0 ? Math.min(100, Math.round((rows / storeFacts) * 100)) : 0);

    // ===================================================================
    // THE SAME REF SET IS BILLED THREE TIMES PER TURN, not once.
    //
    // `total` above is the WRITER sheet — full rendered fact lines, prepended to
    // the newest user message. But the same rows are echoed twice more as bare
    // `Category/key` refs: into the extraction prompt's "## Injected last turn"
    // block (capped at injectedRefsCap, which tracks this very slider), and into
    // the lookup prompt's "## Already on the sheet" block, which has NO cap at
    // all and sits on the latency path behind an 8 s deadline. A readout that
    // priced only the first understated a turn by the other two.
    //
    // Ref lines are measured, not assumed: `Category/key` off the same rows,
    // chars/4, the same convention as everything else here. The extras are not
    // in `total.rows` (they are a walk, not a selection) so both echoes are
    // understated by at most GRAPH_EXTRAS_MAX rows — stated here rather than
    // guessed at, and it can only be an underestimate.
    const refChars = [...floor, ...other].reduce((n, r) => n + `${r.category}/${r.fact.key}`.length + 1, 0);
    const refCap = injectedRefsCapFor(resolved);
    const injectedRefRows = Math.min(total.rows, refCap);
    const injectedRefChars = total.rows > 0 ? Math.round(refChars * (injectedRefRows / total.rows)) : 0;
    const lookupEnabled = settings?.lookupEnabled === true;
    const perTurn = {
        sheet: { rows: total.rows, tokens: total.tokens },
        injectedRefs: {
            rows: injectedRefRows,
            tokens: Math.ceil(injectedRefChars / 4),
            capped: total.rows > refCap,
        },
        lookupRefs: {
            rows: lookupEnabled ? total.rows : 0,
            tokens: lookupEnabled ? Math.ceil(refChars / 4) : 0,
            enabled: lookupEnabled,
            // agent-lookup.js writes this block with no cap and no [TRUNCATED]
            // marker, unlike every other list in that prompt.
            uncapped: true,
        },
        tokens: 0,
    };
    perTurn.tokens = perTurn.sheet.tokens + perTurn.injectedRefs.tokens + perTurn.lookupRefs.tokens;

    return {
        cap: resolved.unlimited ? null : resolved.cap,
        unlimited: resolved.unlimited,
        setting: resolved,
        storeFacts,
        eligible,
        inactive,
        excluded: {
            total: excludedCold + excludedInvisible,
            cold: excludedCold,
            invisible: excludedInvisible,
            coldReleasable: census.coldReleasable,
        },
        hotSetBudget: Number.isFinite(census.budget) ? census.budget : null,
        floor: f,
        other: o,
        total,
        ceiling: c,
        coverage: { rows: total.rows, of: storeFacts, pct: pctOf(total.rows) },
        ceilingCoverage: { rows: c.rows, of: storeFacts, pct: pctOf(c.rows) },
        perTurn,
        // Averaged over what the floor actually selected, so it reflects THIS
        // store's rows rather than a global constant. 0 when nothing is picked.
        tokensPerRow: total.rows > 0 ? Math.round(total.tokens / total.rows) : 0,
    };
}

// See the "Story so far:" block in composeSheet for why these exist.
export const STORY_SO_FAR_MAX_CHARS = 2000;
const STORY_SO_FAR_SPINE_TAIL = 3;
let storySourceLoggedForRun = '';

// `maxChars` lets composeSheet pass the sheet's story budget (sheetBudgetStory);
// other callers get the module default. `rawChars` is the length before the
// clip so the caller can tell a cut from a short story.
export function storySoFarText({ maxChars = STORY_SO_FAR_MAX_CHARS } = {}) {
    let spineBatches = 0;
    let spineTail = '';
    try {
        const spine = getStorySpine();
        if (Array.isArray(spine) && spine.length > 0) {
            spineBatches = spine.length;
            spineTail = spine.slice(-STORY_SO_FAR_SPINE_TAIL).map(b => String(b.sentence || '').trim()).filter(Boolean).join(' ');
        }
    } catch { spineTail = ''; }
    let pyramidStory = '';
    try {
        const pyramid = getSummaryPyramid();
        pyramidStory = (pyramid && typeof pyramid.story === 'string') ? pyramid.story.replace(/\s+/g, ' ').trim() : '';
    } catch { pyramidStory = ''; }
    const source = pyramidStory ? 'pyramid' : spineTail ? 'spine' : 'none';
    // Normalised the same way clipAtSentenceBoundary normalises its input, so
    // `rawChars > text.length` means a budget cut and not a collapsed
    // whitespace run in a hand-edited or pre-normalisation spine sentence.
    const raw = (pyramidStory || spineTail).replace(/\s+/g, ' ').trim();
    const text = clipAtSentenceBoundary(raw, Infinity, Math.max(1, Math.floor(Number(maxChars) || STORY_SO_FAR_MAX_CHARS)));
    return { text, source, spineBatches, rawChars: raw.length };
}

// SCENE TREE. Closed scenes ({name, startMsg, present, beats} from turn-state)
// never reached the model: the sheet showed only the open card, and a callback
// to an earlier scene ("the rain at the cottage") only worked when the lookup
// agent happened to recall that exact card — in the measured 150-turn runs it
// mostly did not, and the model invented the scene instead. One index line per
// closed scene (no beats — those stay in the archive / lookup) gives the model
// the arc cheaply: ~60 chars a scene, capped at the newest SCENE_TREE_CAP.
// The header says outright that these are OVER so the model cannot resume one.
// Lines start with "#k ", never "[", so SHEET_FACT_REF_RE (turn-state.js) and
// the popup parser (commands.js) cannot read one as a fact row.
export const SCENES_SECTION_HEADER = 'Scenes so far (all over — background only, do NOT replay as now):';
const SCENE_TREE_CAP = 12;
// Open card beats shown on the sheet. Was 14; the tree block above now carries
// the arc, so the card no longer has to double as the story's memory.
const MAX_SCENE_BEATS_SHOWN = 10;

// Returns the rendered "Scenes so far" lines, oldest first, or [] when there is
// no closed scene. `current` (the open card) only bounds the last closed scene's
// message range; end = next scene's startMsg−1, else the scene's last indexed
// beat, else no range at all (a card that never learned where it started).
function renderSceneTree(closed, current) {
    const scenes = (Array.isArray(closed) ? closed : []).filter(s => s && (s.name || (Array.isArray(s.beats) && s.beats.length > 0)));
    if (scenes.length === 0) return [];
    const lines = [SCENES_SECTION_HEADER];
    const skipped = Math.max(0, scenes.length - SCENE_TREE_CAP);
    if (skipped > 0) lines.push(`…(${skipped} earlier scene${skipped === 1 ? '' : 's'})`);
    const startOf = (sc) => (Number.isInteger(sc?.startMsg) && sc.startMsg >= 0) ? sc.startMsg : -1;
    for (let i = skipped; i < scenes.length; i++) {
        const sc = scenes[i];
        const name = String(sc.name || '').replace(/\s+/g, ' ').trim() || '(unnamed scene)';
        const start = startOf(sc);
        const next = i + 1 < scenes.length ? scenes[i + 1] : current;
        const nextStart = startOf(next);
        let end = -1;
        if (nextStart > start) end = nextStart - 1;
        else {
            const beats = Array.isArray(sc.beats) ? sc.beats : [];
            for (const b of beats) if (Number.isInteger(b?.msgIndex) && b.msgIndex > end) end = b.msgIndex;
        }
        const meta = [];
        if (start >= 0) meta.push(end > start ? `msgs ${start}–${end}` : (end === start ? `msg ${start}` : `from msg ${start}`));
        const present = Array.isArray(sc.present) ? sc.present.filter(Boolean) : [];
        if (present.length > 0) meta.push(`present: ${present.join(', ')}`);
        lines.push(`#${i + 1} ${name}${meta.length > 0 ? ` (${meta.join('; ')})` : ''}`);
    }
    return lines;
}

function composeSheet({ summary = '', sceneLine = '', timeline = '', need = [], recovered = [], settings = {}, databases = {}, runId = '', lastUserText = '' } = {}) {
    let nowCtx = null;
    try { nowCtx = getTurnNowContext(); } catch { nowCtx = null; }

    const rows = [];
    const seen = new Set();

    // NEED rows, then the STICKY RECOVERED rows. Recovered refs are re-added for
    // RECOVERED_REF_TTL_TURNS turns whether or not this turn's NEED picked them
    // up again: a ref recovered because a reply fumbled it used to survive
    // exactly one turn, after which the prompt's "already on the injected list,
    // do NOT re-list it" rule dropped it and the identical fumble could recur.
    //
    // These now resolve BEFORE the premise floor, which is a behaviour change:
    // the floor used to run first and claim `seen`, so every ref NEED and the
    // floor agreed on burned a floor slot and the cap bought fewer distinct rows
    // than it promised. Selecting the floor against what NEED already carries
    // makes the cap mean exactly what the slider says — N floor rows — and on
    // the measured export it is worth +2 points of store coverage at cap 15, +3
    // at 22, +4 at 30, +2 at 50 and nothing at all once the cap exceeds the
    // store. The FLOOR GUARANTEE is unchanged and is a union, not an order:
    // a top-ranked premise fact is on the sheet either because NEED asked for it
    // or because the floor added it.
    //
    // COLD is checked here alongside active/visible, and it is the check that
    // does the work: `active === false` is a tombstone almost nothing sets, while
    // cold-tiering is the one demotion this codebase actually performs (a
    // #CONFLICT loser, a merge loser, a salience-overflow demotion). Without it a
    // sticky recovered ref OUTLIVES the demotion by up to RECOVERED_REF_TTL_TURNS
    // turns: the sheet keeps rendering the losing value under a header that calls
    // it "established truth for this scene", directly beside the record that beat
    // it. Same rule the premise floor below and buildRecoveryCandidates already
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
    //
    // But only a VERDICT skips. The paragraph above argues from the #CONFLICT
    // loser — a row someone judged wrong — and that argument does not reach a
    // BUDGET demotion, which says nothing about the row except that its category
    // held more than the hot-set budget and it ranked below the line. Treating
    // the two alike made the sheet drop refs the extraction agent had just asked
    // for BY NAME: 8 occurrences and 15 refs on the Lightning export, including
    // Felix's suit and his position at the altar dropped in the middle of the
    // wedding scene, seconds after being written. NEED is demand and it is
    // explicit; the budget is bookkeeping over supply. Demand outranks
    // bookkeeping — that is the same split coldTierOverflow already draws when it
    // releases BUDGET rows and never releases VERDICT rows.
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
                if (fact.cold === true && !isBudgetCold(fact)) { coldSkipped++; continue; }
                const id = `${category}:${fact.key}`;
                // Claimed in `seen` at RESOLVE time so a duplicate ref cannot
                // consume a NEED cap slot, and so the premise floor below can
                // select against what these rows already cover.
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
        // A dropped row keeps its claim on `seen`, so neither the premise floor
        // nor the random-walk extras below can quietly re-admit a row the cap
        // just decided to shed.
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

    // `origin` is what the section budget below keys on: need/sticky are
    // DEMAND (never dropped, rendered in full), floor/extra are SUPPLY
    // (rendered compact, admitted while the section's budget lasts).
    for (const { fact, category } of needRows) rows.push({ fact, category, tier: 'primary', origin: 'need' });
    for (const { fact, category } of stickyRows) rows.push({ fact, category, tier: 'primary', origin: 'sticky' });

    // PREMISE FLOOR: always inject the load-bearing premise/identity facts, even
    // if this turn's fresh NEED pick omits them. This is a FLOOR (a guaranteed
    // minimum), not a ceiling — it never evicts or caps anything NEED added
    // above. Unshifted rather than pushed so the floor still renders first
    // within its section, which is the row order every prior sheet had.
    const floorCap = resolvePremiseFloorCap(settings);
    // The turn's entity signal, built once and consumed by the floor's
    // relevance scorer. `lastUserText` is the newest USER message this run saw
    // (passed down from runMemoryAgent); present/beats come from the scene
    // store. On failure the floor falls back to the quota path.
    let relevanceCtx = null;
    try { relevanceCtx = buildRelevanceContext({ databases, userText: lastUserText }); } catch { relevanceCtx = null; }
    let floorRowCount = 0;
    try {
        const floor = selectPremiseFloor({ databases, cap: floorCap.cap, exclude: seen, relevance: relevanceCtx });
        const floorRows = [];
        for (const { fact, category, relScore } of floor) {
            const id = `${category}:${fact.key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            // relScore rides along so the section budget below can admit the
            // rows the scorer ranked highest first — a budget that admits by
            // importance would silently undo the scorer whenever it bites.
            floorRows.push({ fact, category, tier: 'primary', origin: 'floor', ...(Number.isFinite(relScore) ? { relScore } : {}) });
        }
        rows.unshift(...floorRows);
        floorRowCount = floorRows.length;
    } catch {  }

    const logTag = runId ? `[${runId}] ` : '';
    // The floor is now user-controlled, so its size has to be readable off the
    // run log — a coverage complaint is otherwise indistinguishable from a
    // slider set to 3.
    addDebugLog('debug', `${logTag}Sheet: premise floor ${floorRowCount} row(s) at cap ${floorCap.unlimited ? 'UNLIMITED' : floorCap.cap}${floorCap.source === 'clamped' ? ` (clamped from ${floorCap.raw})` : ''}, ${needRows.length} NEED + ${stickyRows.length} sticky already carried`, {
        subsystem: 'agent3', event: 'sheet.premise_floor',
        data: {
            rows: floorRowCount, cap: floorCap.unlimited ? null : floorCap.cap,
            unlimited: floorCap.unlimited, source: floorCap.source,
            need: needRows.length, sticky: stickyRows.length,
        },
    });
    if (relevanceCtx) {
        const st = relevanceCtx.stats || { scored: 0, hop1: 0, hop2: 0, sameScene: 0, safetyNet: 0 };
        addDebugLog('debug', `${logTag}Sheet: relevance ${relevanceCtx.hasSignal ? `scored ${st.scored} row(s) — entities [${relevanceCtx.topEntities.join(', ')}], hop1 ${st.hop1}, hop2 ${st.hop2}, sameScene ${st.sameScene}, safety net ${st.safetyNet}` : 'no entity signal — quota fallback'}`, {
            subsystem: 'agent3', event: 'sheet.relevance',
            data: { entities: relevanceCtx.topEntities, mode: relevanceCtx.hasSignal ? 'scored' : 'quota-fallback', ...st },
        });
    }
    if (coldSkipped > 0) {
        addDebugLog('info', `${logTag}Sheet: ${coldSkipped} NEED/recovered ref(s) skipped — judged (conflict/merge/mark_cold) since they were selected; budget demotions no longer skip`, {
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
            extras = randomWalkExtras(databases, rows, seen, extrasMax).map(r => ({ ...r, origin: 'extra' }));
        } catch { extras = []; }
    }

    const { state, chrono } = splitInjectionSections(rows);

    const lines = [];
    lines.push('[MEMORY SHEET — persistent memory; established truth for this scene; overrides older chat history]');

    // SECTION BUDGETS (recency.js SHEET_BUDGET_*). Every section below is
    // capped in chars; what each cap drops is counted and logged once at the
    // end as `sheet.budget_capped`, so a memory that went missing can be traced
    // to a cut rather than guessed at.
    const budget = resolveSheetBudget(settings);
    const capped = {};   // section -> { dropped, kept, chars, budget, ... }

    // "Story so far:" used to be the WHOLE append-only spine joined — measured
    // at 35 k chars (59 % of the sheet) by turn 150 of two Opus runs. Now it
    // renders the summary pyramid's rolling story (the reflection pass's
    // ~1 k-char recap, chatMetadata bf_mem_pyramid) when there is one, else the
    // LAST 3 spine sentences; either way capped at budget.story (the
    // sheetBudgetStory setting, default STORY_SO_FAR_MAX_CHARS) on a sentence
    // boundary. The full spine is untouched — buildHeadUserPrompt and the store
    // still read it. While both sources are empty the line is simply OMITTED —
    // no fallback text stands in for it. The agent's own per-turn situational
    // recap always renders as its own "Right now:" line.
    const { text: storyText, source: storySource, spineBatches, rawChars: storyRawChars } = storySoFarText({ maxChars: budget.story });
    if (storyText) lines.push(`Story so far: ${storyText}`);
    if (storyRawChars > storyText.length) {
        capped.story = { dropped: storyRawChars - storyText.length, kept: storyText.length, chars: storyText.length, budget: budget.story, source: storySource };
    }
    if (runId && storySourceLoggedForRun !== runId) {
        storySourceLoggedForRun = runId;
        addDebugLog('debug', `[${runId}] Sheet: "Story so far" from ${storySource === 'pyramid' ? 'the summary pyramid story' : storySource === 'spine' ? `the last ${Math.min(STORY_SO_FAR_SPINE_TAIL, spineBatches)} of ${spineBatches} spine sentences` : 'nothing (omitted)'} — ${storyText.length} chars`, {
            subsystem: 'agent3', event: 'sheet.story_source',
            data: { source: storySource, chars: storyText.length, spineBatches, clipped: storyText.length < storyRawChars },
        });
    }
    let scene = null;
    try { scene = getCurrentScene(); } catch { scene = null; }
    // Scene tree: one index line per closed scene, between "Story so far" and the
    // "Right now" line / open card, so "earlier" reads as earlier. See renderSceneTree.
    let sceneTreeCount = 0;
    try {
        const treeLines = renderSceneTree(getClosedScenes(), scene);
        if (treeLines.length > 0) {
            sceneTreeCount = treeLines.filter(l => l.startsWith('#')).length;
            lines.push(...treeLines);
        }
    } catch { sceneTreeCount = 0; }
    // HEAD: the "Right now:" recap is already capped at the head call
    // (SUMMARY_MAX_CHARS, with a condensing re-ask); this is the deterministic
    // backstop for a prior-head fallback that never went through it.
    if (summary) {
        const headRoom = budget.head - String(timeline || '').length;
        const shown = summary.length > headRoom ? clipAtSentenceBoundary(summary, SUMMARY_MAX_SENTENCES, Math.max(120, headRoom)) : summary;
        if (shown !== summary) capped.head = { dropped: summary.length - shown.length, kept: shown.length, chars: shown.length, budget: budget.head };
        lines.push(`Right now: ${shown}`);
    }
    // Scene card: the agent-declared scene name as a header, followed by the stacked
    // one-line beats accumulated across every message since this scene opened. Falls
    // back to the legacy single sceneLine only if no scene has been accumulated yet.
    if (scene && (scene.name || (Array.isArray(scene.beats) && scene.beats.length > 0))) {
        lines.push(`Scene: ${scene.name || '(current scene)'}`);
        // Only inject the most recent beats so a long-running scene can't grow the
        // sheet without bound; earlier beats of this scene remain in the persisted
        // scene store (and the overall arc is covered by the story spine + tree).
        // The row cap (MAX_SCENE_BEATS_SHOWN, module-level) and the char budget
        // both apply: 10 beats at BEAT_MAX_CHARS is 3 k, over the default scene
        // budget, so newest beats win.
        const beatsArr = (Array.isArray(scene.beats) ? scene.beats : []).map(b => String(b?.sentence || '').trim()).filter(Boolean);
        const shownBeats = [];
        let beatChars = 0;
        for (let i = beatsArr.length - 1; i >= 0 && shownBeats.length < MAX_SCENE_BEATS_SHOWN; i--) {
            const cost = beatsArr[i].length + 1;
            if (shownBeats.length > 0 && beatChars + cost > budget.scene) break;
            shownBeats.unshift(beatsArr[i]);
            beatChars += cost;
        }
        const earlier = beatsArr.length - shownBeats.length;
        if (earlier > 0) lines.push(`…(${earlier} earlier beats)`);
        // Logged as a budget cut only when the CHAR budget bit — the row cap is
        // the old behaviour and not a budget event.
        if (earlier > Math.max(0, beatsArr.length - MAX_SCENE_BEATS_SHOWN)) {
            capped.scene = { dropped: earlier, kept: shownBeats.length, chars: beatChars, budget: budget.scene };
        }
        lines.push(...shownBeats);
    } else if (sceneLine) {
        lines.push(`Scene: ${sceneLine}`);
    }
    if (timeline) lines.push(`Timeline & place: ${timeline}`);
    try {
        const present = getScenePresent();
        if (present.length > 0) lines.push(`Present: ${present.join(', ')}`);
    } catch {  }
    lines.push(buildPrecedencePreamble(nowCtx));

    // RESOLVED lifecycle: rows the state recheck stamped `status: 'resolved'`
    // leave CURRENT STATE — that header sells them as "true RIGHT NOW", which is
    // what kept the measured run re-litigating settled conflicts every turn —
    // and render in their own subsection directly below. They are NOT dropped:
    // the model still needs the background, it just must not treat it as live.
    // Facts without a status field split exactly as before.
    const liveState = state.filter(r => r?.fact?.status !== 'resolved');
    const resolvedState = state.filter(r => r?.fact?.status === 'resolved');

    // KEY DEDUPE across sections: any ref already rendered under CURRENT STATE
    // (incl. the RESOLVED subsection) is suppressed in CHRONOLOGY / extras.
    // Exact category/key match only — no semantic guessing. Today `seen`
    // already makes cross-section duplicates of one record impossible, so this
    // is a guard on the rendering layer itself: whatever feeds a section later,
    // one sheet never asserts the same key twice.
    const renderedRefs = new Set();
    let dedupSuppressed = 0;

    // FACT BUDGET. Rendered text is what is measured — each row's line as the
    // sheet will carry it — and the row is rendered ONCE here and reused below.
    // Demand rows (NEED, sticky) are full-note and never dropped: if demand
    // alone exceeds the section, it is logged and allowed, because the agent
    // asked for those by ref and a budget is bookkeeping over supply. Supply
    // rows are compact; floor rows are admitted in floorRank order (CURRENT
    // STATE/RESOLVED) or newest first (CHRONOLOGY), extras only with leftover.
    // `demandExceeded` is on the log so an overrun is visible as the NEED cap's
    // problem rather than the budget's. Admission is first-fit, not a hard
    // cut: a row that does not fit is skipped and the next one is still tried,
    // so one 300-char row cannot leave 250 chars of budget unused.
    const isDemand = (r) => r.origin === 'need' || r.origin === 'sticky';
    const renderRow = (r) => buildFactLine(r.fact, r.category, nowCtx, { compact: !isDemand(r) });
    const admitBudget = (section, sectionRows, extraRows, limit, supplyOrder) => {
        const admitted = new Set();
        let used = 0;
        for (const r of sectionRows) {
            if (!isDemand(r)) continue;
            r.line = r.line ?? renderRow(r);
            admitted.add(r);
            used += r.line.length + 1;
        }
        const demandChars = used;
        let dropped = 0;
        const supply = sectionRows.filter(r => !isDemand(r)).sort(supplyOrder);
        for (const r of supply) {
            r.line = r.line ?? renderRow(r);
            const cost = r.line.length + 1;
            if (used + cost > limit) { dropped++; continue; }
            admitted.add(r);
            used += cost;
        }
        let extrasDropped = 0;
        for (const r of extraRows) {
            r.line = r.line ?? renderRow(r);
            const cost = r.line.length + 1;
            if (used + cost > limit) { extrasDropped++; continue; }
            admitted.add(r);
            used += cost;
        }
        if (dropped > 0 || extrasDropped > 0 || demandChars > limit) {
            capped[section] = {
                dropped: dropped + extrasDropped, droppedFloor: dropped, droppedExtras: extrasDropped,
                kept: admitted.size, chars: used, budget: limit,
                demandChars, demandExceeded: demandChars > limit,
            };
        }
        return admitted;
    };
    // Extras follow their own kind into a section so an event extra is charged
    // to CHRONOLOGY and a trait extra to the fact budget, same split as rows.
    const { state: extraState, chrono: extraChrono } = splitInjectionSections(extras);
    // Supply admission prefers the scorer's ranking when the floor was scored:
    // only floor rows carry relScore, so on quota-fallback turns (and for
    // extras) this is exactly the old floorRank / newest-first order.
    const relFirst = (fallback) => (a, b) => {
        const as = Number.isFinite(a?.relScore) ? a.relScore : -Infinity;
        const bs = Number.isFinite(b?.relScore) ? b.relScore : -Infinity;
        if (as !== bs) return bs - as;
        return fallback(a, b);
    };
    const factAdmitted = admitBudget('facts', state, extraState, budget.facts, relFirst(floorRank));
    const newestFirst = (a, b) => {
        const av = Number.isFinite(Number(a?.fact?.validAt)) && a?.fact?.validAt != null ? Number(a.fact.validAt) : -1;
        const bv = Number.isFinite(Number(b?.fact?.validAt)) && b?.fact?.validAt != null ? Number(b.fact.validAt) : -1;
        if (bv !== av) return bv - av;
        return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
    };
    const chronoAdmitted = admitBudget('chronology', chrono, extraChrono, budget.chronology, relFirst(newestFirst));
    const extrasAdmitted = new Set([...factAdmitted, ...chronoAdmitted]);

    // Every row the sheet actually carries, in render order — the supply/demand
    // publication below reads off this list, not off the pre-budget candidates.
    const renderedRows = [];
    const renderSection = (header, sectionRows, admittedSet, dedupe = false) => {
        const admitted = [];
        for (const r of sectionRows) {
            if (!admittedSet.has(r)) continue;
            const refId = `${r.category}/${r.fact.key}`;
            if (dedupe && renderedRefs.has(refId)) { dedupSuppressed++; continue; }
            renderedRefs.add(refId);
            renderedRows.push(r);
            admitted.push(r.line ?? renderRow(r));
        }
        if (admitted.length > 0) {
            lines.push(header);
            lines.push(...admitted);
        }
        return admitted.length;
    };

    renderSection(STATE_SECTION_HEADER, liveState, factAdmitted);
    renderSection(RESOLVED_SECTION_HEADER, resolvedState, factAdmitted);
    renderSection(CHRONO_SECTION_HEADER, chrono, chronoAdmitted, true);
    renderSection('Connected memories:', extras, extrasAdmitted, true);

    // SUPPLY vs DEMAND, published for recordFactUsage (database.js). This is the
    // last point at which the distinction still exists: downstream, the usage
    // flush parses refs back out of the rendered sheet text and every row looks
    // alike. The floor rows and the connected-memory extras are supply — nothing
    // about THIS turn asked for them, they are on the sheet because the slider
    // and the walk put them there — so crediting them as usage would stamp
    // lastUsedAt on the entire hot set every turn and flatten the recency term
    // out of salienceScore. NEED and the sticky recovered rows are demand and
    // are deliberately absent from this set. See the DEMAND vs SUPPLY block in
    // database.js for the full failure shape.
    //
    // Published from the RENDERED rows, after the section budgets ran: a floor
    // or extra row the budget dropped is not on the sheet, and if the lookup
    // pass later recalls it by ref (agent-lookup only refuses refs that are on
    // the sheet) that recall is demand and must be credited as used — had the
    // pre-budget candidate list been published, such a row would have been
    // stamped 'seen' forever and aged into a cold demotion.
    try {
        setSheetSupplyRefs(renderedRows
            .filter(r => r.origin === 'floor' || r.origin === 'extra')
            .map(r => ({ category: r.category, key: r.fact.key })));
    } catch {  }

    if (sceneTreeCount > 0) {
        addDebugLog('debug', `${logTag}Sheet: scene tree rendered ${sceneTreeCount} closed scene(s)`, {
            subsystem: 'agent3', event: 'sheet.scene_tree', data: { rendered: sceneTreeCount },
        });
    }

    if (dedupSuppressed > 0) {
        addDebugLog('debug', `${logTag}Sheet: ${dedupSuppressed} row(s) suppressed — same category/key already rendered in CURRENT STATE/RESOLVED`, {
            subsystem: 'agent3', event: 'sheet.dedupe', data: { suppressed: dedupSuppressed },
        });
    }

    const cappedSections = Object.keys(capped);
    if (cappedSections.length > 0) {
        const parts = cappedSections.map(sec => {
            const c = capped[sec];
            return `${sec} -${c.dropped} (kept ${c.kept}, ${c.chars}/${c.budget} chars${c.demandExceeded ? `, DEMAND ALONE ${c.demandChars} > budget, allowed` : ''})`;
        });
        addDebugLog('info', `${logTag}Sheet: budget capped — ${parts.join('; ')}`, {
            subsystem: 'agent3', event: 'sheet.budget_capped',
            data: { sections: capped, budget: { facts: budget.facts, chronology: budget.chronology, scene: budget.scene, story: budget.story, head: budget.head } },
        });
    }

    return lines.join('\n');
}
