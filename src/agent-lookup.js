import {
    getAllDatabases,
    mapLegacyCategory,
    findFactMatch,
    isActiveFact,
    summarizeKeys,
} from './database.js';
import { isFactVisible, buildFactLine } from './fact-retrieval.js';
import { getTurnNowContext } from './recency.js';
import { callAgentLLMWithTools } from './llm-call.js';
// ONLY the read-only executor is imported here. executeMemoryTool — the dispatch
// switch that owns write_fact / add_alias / link_facts / merge_facts / mark_cold —
// is deliberately NOT in this module's import list, so no expression in this file
// can reach a write path at all. See memory-tools.js's executeLookupTool for the
// other two barriers (the roster check and a switch with no write cases).
import { executeLookupTool, stripThinkBlocks } from './memory-tools.js';
import { extractSheetFactRefs } from './turn-state.js';
import { addDebugLog, isTraceRecording, traceCapture, newTraceCallId, getSettings } from './settings.js';
import * as host from './host.js';

// =============================================================================
// THE LOOKUP AGENT — the only pass in the pipeline that reads the USER'S message.
//
// WHY IT EXISTS. Every other selection in this system runs BEFORE the user has
// typed: the extraction agent picks the NEED line for "the next reply" while the
// next reply's prompt does not exist yet, so its forward-looking half is a guess
// about a message nobody has written. Measured on the analysed session that guess
// costs 17% of stored facts NEVER injected on any turn and 41% per-turn recall,
// with the concrete miss being Events/naoto_village_tour ("Naoto walked naked
// through the village; no animal cared") — stored, never selected, and the one
// row that would have resolved the binding contradiction.
//
// This pass closes that loop from the other end: the user's message exists, the
// store is searchable, and a small model reads the one and searches the other.
//
// NO EMBEDDINGS, deliberately and by the author's instruction. The unit here is a
// 1-5 word roleplay fragment ("did you ever find the bike?"), where a cosine
// score over a sentence embedding is noise; what resolves it is understanding
// that "the bike" is a callback and issuing search("bike"). That is a tool call,
// not a distance metric.
//
// WHAT IT IS NOT. It is not a second extraction pass and it is not allowed to
// become one: it cannot write, it cannot age, tier, link or repair anything, and
// nothing it produces is persisted. Its entire output is a handful of refs that
// live for exactly one prompt.
// =============================================================================

// --- The budget -------------------------------------------------------------
//
// This pass is ON THE LATENCY PATH — the user is staring at a stopped send
// button while it runs. That single fact sets every number below, and it is why
// they are far tighter than the extraction agent's 8 rounds / 24 tool calls.
//
// 2 rounds is the minimum that can do the job at all: round 1 searches, round 2
// answers with what the results showed. The third round exists for exactly one
// caller: the idle-verdict correction (requireToolCallBeforeDone below). When
// round 1 delivers a verdict with zero searches, the correction consumes a
// round — and a 2-round budget would leave the demanded search to run BLIND on
// the final round, its results never fed back. A ceiling, not a target: a pass
// that searches in round 1 still closes in round 2, so the third round costs
// latency only on turns that were previously answering with nothing.
// 4 tool calls fit "search the two or three things this message names" with one
// call to spare for a read_facts confirmation.
export const LOOKUP_MAX_ROUNDS = 3;
export const LOOKUP_MAX_TOOL_CALLS = 4;

// WALL-CLOCK DEADLINE for the WHOLE pass. Non-negotiable: when it bites the
// prompt goes out WITHOUT the lookup block. A missing line is always better than
// a hung generation.
//
// WHAT IT COVERS, and why that word is the point. Not just the LLM leg — every
// await this pass performs, the memory store load included. The deadline is an
// ABSOLUTE timestamp that the CALLER computes before ITS first await and threads
// into runLookupAgent and renderLookupBlock, and both race every await they make
// against it. Arming a timer after the store load instead would leave the common
// case unbounded: getAllDatabases on a cold cache reaches
// loadAllDatabasesFromAttachments, which issues one plain `fetch` per category,
// sequentially, with no signal and no timeout of its own — and a chat switch
// invalidates that cache, so the FIRST generation after every chat switch pays it
// on the latency path while ST is awaiting the injection handler.
//
// It is enforced by RACING rather than by aborting, because an abort cannot be
// relied on to unblock us: callViaCMRS checks the signal only BEFORE dispatch and
// hands no signal to CMRS.sendRequest, so an in-flight profile call ignores an
// abort until its own 300s per-attempt cap; the attachment fetch takes no signal
// at all. The abort is still fired on timeout — it stops the loop from opening
// ANOTHER round behind our back — but the race is what returns control. The
// losing leg is left to finish into a result nobody reads.
//
// THE NUMBER. Measured on the analysed session, the user's memory profile takes
// 5.7-14.0s for the single-shot beats call (comparable prompt size, no tools) and
// 22-75s for the extraction loop. A lookup pointed at THAT profile will time out
// on every turn, log LOOKUP_TIMEOUT every turn, and (see the strike counter
// below) switch itself off. That is the intended signal, not a bug: this pass is
// only viable on a fast small model, which is exactly why it has its own
// connection-profile setting. 8s is roughly two rounds of a fast hosted model
// plus the tool work between them.
export const LOOKUP_TIMEOUT_DEFAULT_MS = 8000;

// The floor and ceiling the settings slider is clamped to, and why they are where
// they are. Below ~3s no hosted model completes a round, so the pass could only
// ever time out. Above ~30s the wait stops reading as latency and starts reading
// as a broken client — and this is the ONE pass the user sits and waits for, so
// the ceiling is a UX judgement, not a technical one. Everything between is the
// user's call: a slow proxy or a local model can genuinely need 15-20s, and that
// number cannot be guessed from here.
export const LOOKUP_TIMEOUT_MIN_MS = 3000;
export const LOOKUP_TIMEOUT_MAX_MS = 30000;

// Read ONCE per pass by the caller and threaded down as an absolute deadline —
// never twice inside one pass, or the budget would move under it if the user
// dragged the slider mid-generation.
export function lookupTimeoutMs() {
    const raw = Number(getSettings()?.lookupTimeoutMs);
    if (!Number.isFinite(raw)) return LOOKUP_TIMEOUT_DEFAULT_MS;
    return Math.min(LOOKUP_TIMEOUT_MAX_MS, Math.max(LOOKUP_TIMEOUT_MIN_MS, Math.floor(raw)));
}

// Backstop margin. The caller races its ENTIRE lookup body — including awaits
// that are not inside runLookupAgent/renderLookupBlock, such as the dynamic
// import of catchup-import.js, and including any await added there later and
// forgotten in the per-stage races — against LOOKUP_TIMEOUT_MS + this. The margin
// exists so the per-stage deadline always fires FIRST in normal operation and can
// report WHICH stage was slow; the backstop firing at all means something inside
// was not raced, which is a distinct and separately logged condition.
export const LOOKUP_DEADLINE_GRACE_MS = 250;

// Consecutive timeouts after which the pass stops arming itself for the rest of
// the session (a chat switch or toggling the setting re-arms it). Without this a
// misconfigured profile costs LOOKUP_TIMEOUT_MS of dead latency on EVERY message
// forever, which is precisely the failure mode the deadline exists to prevent —
// bounded per turn is not the same as bounded overall.
export const LOOKUP_TIMEOUT_STRIKES = 3;

// The SECOND strike counter, on hard errors rather than deadline misses, sharing
// the same session latch. A deadline miss is not the only way this pass can cost
// latency forever: measured on the analysed session, EIGHT consecutive
// `API request failed` results (a dead profile — wrong URL, expired key, bridge
// down) never touched the timeout counter, because they came back fast and with
// `timedOut: false`. The pass kept re-arming itself for 26 runs. An error is
// weaker evidence than a timeout — a single transport blip is not a broken
// setup — so the threshold is higher, but the outcome has to be the same: stop
// paying for a pass that cannot work.
//
// 'aborted' is excluded at the call site (pipeline.js): a chat switch or a user
// cancel says nothing about the profile.
export const LOOKUP_ERROR_STRIKES = 5;

// The THIRD counter, and the reason the second one had to get narrower. Since a
// read arriving next to #DONE buys another round instead of being dropped
// (readsForceAnotherRound in llm-call.js), this pass has a failure mode it did
// not have before: round 1 searches and says #DONE, the block is deferred, and
// round 2 fails to restate it — chatter, a grace round, loop end, `no #DONE block
// produced`. Before the deferral that same reply ENDED the pass successfully, with
// zero refs; now it ends it with an error.
//
// That error is not a connection failure and must not be counted as one. The
// endpoint answered, twice, inside the deadline — a run that reaches this class is
// positive evidence the profile works, which is why it CLEARS the other two
// counters instead of feeding them. Attributing it to the profile is how a
// reasoning model that writes #DONE inside <think> got the user a toast telling
// them to check a URL that was never wrong.
//
// It still needs a latch of its own: a model that cannot hold this contract will
// fail it on every message, and dead latency forever is the exact thing the other
// two latches exist to stop. The threshold is the highest of the three because the
// evidence is the weakest — one badly formatted reply is ordinary, which is why
// the grace round exists at all — and the ADVICE is different from both: not the
// profile's plumbing, not the deadline, but the model behind it.
export const LOOKUP_PROTOCOL_STRIKES = 8;

// Refs the agent may deliver. This block is stapled onto a sheet that already
// carries 11-26 fact rows; its value is precision, not volume. Six is generous
// for "what this one message needs that the sheet is missing" — the honest
// answer on most turns is none.
//
// The number is also written into DEFAULT_LOOKUP_PROMPT's "Max 6" line, which is
// the half the model obeys; this constant is the half that is enforced. Change
// both or the prompt lies.
const LOOKUP_REFS_CAP = 6;

// Store overview shown to the agent. Smaller than the extraction agent's
// KEY_INVENTORY_CAP (200) because this prompt is paid for in latency, not in
// background time; when it truncates the header says so and points at list_keys,
// which is one of the three tools this pass has.
const LOOKUP_KEY_INVENTORY_CAP = 120;

// `## Already on the sheet` cap. This list used to be written out in full, which
// was safe only while the sheet itself was small: the premise floor was a fixed 15
// rows, so the sheet could not exceed 15 + 45 NEED + 12 sticky + 8 connected = 80
// refs. The floor is now a user slider up to 100 and past that UNLIMITED, so "in
// full" means an unbounded list — thousands of lines, hundreds of KB — inside a
// prompt this pass has LOOKUP_TIMEOUT_DEFAULT_MS to complete while the user waits.
// The pass would then miss its deadline every turn, take three strikes, switch
// itself off, and blame the connection profile for a slider two settings above it.
// Nothing else in this file is allowed to scale with a setting, and neither is
// this.
//
// THE NUMBER. 120 is not a guess: the DEFAULT floor of 50 tops the sheet out at
// 50 + 45 + 12 + 8 = 115 refs, so at stock settings this cap never bites at all
// and the list stays exactly as complete as it was. It only truncates for a user
// who has raised the slider — and it matches LOOKUP_KEY_INVENTORY_CAP, which
// bounds the other list in this same prompt, so the two together are a few KB.
//
// THE TENSION, and how it is resolved. The list exists so the pass does not spend
// one of its six slots re-finding a row the storyteller is already getting.
// Truncating it means the pass MIGHT re-find something; omitting it means it
// always might. Three things make the truncated list the right trade:
//
//   1. Truncation is not a correctness failure. renderLookupBlock re-derives the
//      sheet ref set from the FULL sheetText and drops any ref it already carries
//      (ALREADY_ON_SHEET). A re-find therefore costs one wasted slot, never a
//      duplicated row in the prompt. The absent-list case has the same ceiling but
//      pays it on every turn instead of only above the default.
//   2. The truncation is announced. The header says the list is partial, so
//      absence from it stops meaning absence from the sheet — the same contract
//      `## Stored keys` already states when its inventory truncates.
//   3. WHICH refs are dropped is chosen, not incidental. composeSheet unshifts the
//      premise floor ahead of NEED and sticky, so within each sheet section the
//      standing background rows come FIRST and the rows selected against THIS
//      turn's message come last, with the connected-memories extras last of all.
//      A head-only cut would drop precisely the rows a targeted search is most
//      likely to land on. So both ends are kept and the middle is dropped: the
//      middle is premise-floor background, which a search aimed at the new message
//      collides with least.
//
// The tail reserve is sized from the caps composeSheet applies to its non-floor
// rows — NEED 45 + sticky 12 + connected 8 = 65 — so the tail slice can never be
// too small to cover them. It is hardcoded rather than imported because this
// module must not pull agent-memory.js into its graph (see parseRefsLine below for
// the same rule); if those caps move, this becomes conservative, never wrong.
const LOOKUP_SHEET_REFS_CAP = 120;
const LOOKUP_SHEET_REFS_TAIL = 65;

// Input clips. The user message is the whole point and is clipped only against
// the pathological paste; the preceding character reply is context for resolving
// pronouns and "yes, do it" (which name nothing on their own) and is worth only
// a few hundred characters.
const LOOKUP_MESSAGE_CHARS = 2000;
const LOOKUP_PRIOR_MESSAGE_CHARS = 600;

// The block's own header. It is deliberately NOT one of composeSheet's section
// headers: the storyteller must be able to tell looked-up context from the
// standing sheet, because these rows were selected by a different pass, against
// a different question, with a different failure mode. Rows below it are rendered
// by the same buildFactLine the sheet uses, so extractSheetFactRefs sees them and
// the usage counters credit them like any other injected row.
export const LOOKUP_BLOCK_HEADER = 'Looked up for the message below (a memory search against what {{user}} just wrote; not part of the standing sheet above):';

// FIXED prompt, like DEFAULT_BEATS_PROMPT and DEFAULT_HEAD_PROMPT and unlike the
// extraction/reflection prompts: it is not exposed as a settings override. The
// override machinery stores a full COPY of a prompt and prefers it forever
// (see PROMPT_OVERRIDES in settings.js), which is a real trap for a pass whose
// entire contract is four lines long — and the two knobs this feature genuinely
// needs (on/off, which model) are settings already.
export const DEFAULT_LOOKUP_PROMPT = `You are the LOOKUP AGENT for a roleplay between {{user}} (human) and {{char}} (AI character). {{user}} has just sent a message and the storyteller is about to answer it. ONE job: find STORED memories that message needs which the memory sheet is NOT already carrying. You are READ-ONLY — nothing you can call changes anything.

# TOOL PROTOCOL (plain text — no function-call API)

Each tool call is ONE line of strict JSON, alone on its line:
{"tool":"search","args":{"query":"stolen bike case"}}
{"tool":"read_facts","args":{"category":"People","keys":["monika_promise_lake"]}}
{"tool":"list_keys","args":{"category":"Places"}}

The system replies with one "TOOL RESULTS:" message; then you finish. Several call lines in one reply are fine; no markdown fences, no multi-line JSON.

HARD LIMITS: 3 rounds, 4 tool calls. THE USER IS WAITING — this runs while the reply is held. Round 1: every search you want, all at once. Round 2: the final reply. A slow answer is a wasted one.

SEARCH BEFORE YOU JUDGE: you MUST execute at least one tool call (search / read_facts / list_keys) before delivering your verdict. The store holds things the sheet does not carry — "the sheet looks complete" is a guess until a search says so. A verdict with zero tool calls will be sent back to you with a demand to search first.

# HOW TO SEARCH

Search for the THING, not the sentence: "did you ever find the bike?" → \`search\` "bike". A name, an object, a place, a promise, an old event, a callback ("like you said before", "that night at the lab") — those are what you are for, because the recent chat window may no longer reach back that far. \`list_keys\` when you need to see what a category even holds. \`read_facts\` to confirm a key you saw named somewhere.

# FINAL REPLY

Nothing but ONE line, then \`#DONE\` on its own line:

REFS: Category/key, Category/key
REFS: none

- VERIFIED refs only — a ref you saw in a tool result this session. Never invented, never reconstructed from a key that merely looks likely.
- ONLY what THIS message needs: what it asks about, names, calls back to, doubts or contradicts. Not "related", not "good to have".
- \`## Already on the sheet\` is going to the storyteller anyway. Listing one of those changes nothing and wastes a slot.
- Max 6. Fewer is better. \`REFS: none\` is a correct and COMMON answer — small talk, an emote or a reply that only continues the current beat often needs nothing — but only AFTER at least one search came back empty or already-covered. Never as a round-1 guess.
- No prose, no reasons, no other lines.`;

// --- Ref parsing ------------------------------------------------------------
//
// Same grammar and tolerance as agent-memory.js's parseRefLine (NEED/RECOVERED),
// duplicated rather than shared because that helper is module-private there and
// this module is not allowed to import agent-memory.js — that file pulls in the
// whole extraction stack, including the write path, and this pass must not have
// it in its graph. Stated so the duplication is a decision rather than a
// discovery; if parseRefLine is ever exported, this goes.
function parseRefsLine(text) {
    const out = [];
    for (const rawLine of String(text || '').split('\n')) {
        const m = /^\s*[-*]?\s*REFS\s*:\s*(.*)$/i.exec(rawLine.trim());
        if (!m) continue;
        for (const ref of m[1].split(',')) {
            const r = ref.trim().replace(/^[-*]\s*/, '');
            if (!r || /^\(?none\)?$/i.test(r)) continue;
            const slash = r.indexOf('/');
            if (slash <= 0) continue;
            const category = r.slice(0, slash).trim();
            const key = r.slice(slash + 1).trim();
            if (category && key) out.push({ category, key });
        }
    }
    return out;
}

// Race sentinels. Distinct objects rather than null/undefined so "the loop
// returned nothing" (which callAgentLLMWithTools never does, but a future
// refactor might) can never be mistaken for "the deadline fired".
const DEADLINE = { __lookup: 'deadline' };
const ABORTED = { __lookup: 'aborted' };

function clip(s, max) {
    const t = String(s ?? '').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function capLines(text, max, footer) {
    const lines = String(text || '').split('\n').filter(Boolean);
    if (lines.length <= max) return { text: lines.join('\n'), truncated: false };
    return { text: lines.slice(0, max).join('\n') + `\n... (+${lines.length - max} more — ${footer})`, truncated: true };
}

// Both ends of the sheet ref list, with the dropped middle named on its own line.
// Returns the refs to print plus how many were left out; the CALLER still counts
// the full set in the header, so the number the model is told is the real one.
function capSheetRefs(refs) {
    const all = Array.isArray(refs) ? refs : [];
    if (all.length <= LOOKUP_SHEET_REFS_CAP) return { lines: all, omitted: 0 };
    const tail = Math.min(LOOKUP_SHEET_REFS_TAIL, LOOKUP_SHEET_REFS_CAP);
    const head = LOOKUP_SHEET_REFS_CAP - tail;
    const omitted = all.length - LOOKUP_SHEET_REFS_CAP;
    return {
        lines: [
            ...all.slice(0, head),
            `... (+${omitted} more sheet memories not listed — mostly standing background rows)`,
            ...all.slice(all.length - tail),
        ],
        omitted,
    };
}

function buildLookupUserPrompt({ userMessage, priorMessage, sheetRefs, databases }) {
    const parts = [];

    parts.push(`## The NEW message from {{user}} — the storyteller is about to answer THIS\n${clip(userMessage, LOOKUP_MESSAGE_CHARS)}`);

    if (priorMessage) {
        parts.push(`## The reply it answers (context only — do NOT look things up for this one)\n${clip(priorMessage, LOOKUP_PRIOR_MESSAGE_CHARS)}`);
    }

    // What the storyteller is getting regardless. Refs only, not the sheet prose:
    // the job is a set difference, and the prose cannot participate in one.
    //
    // Capped — see LOOKUP_SHEET_REFS_CAP for the size, the choice of which refs go,
    // and why a truncated list beats an unbounded one here. The count in the header
    // is the FULL sheet size even when the body is cut, and the truncation note
    // withdraws the inference the untruncated header invites: absence from a partial
    // list proves nothing, so "do NOT list these" softens to "listing one is a
    // wasted slot". It cannot become a duplicate row — renderLookupBlock re-checks
    // every returned ref against the whole sheet.
    const sheetList = capSheetRefs(sheetRefs);
    const sheetTrunc = sheetList.omitted > 0
        ? ` — PARTIAL LIST: ${sheetList.omitted} of them are not shown, so a memory MISSING from this list may still be on the sheet; if you are unsure, prefer a ref you know it lacks (listing one it already has is not an error, just a wasted slot)`
        : ' — do NOT list these';
    parts.push(`## Already on the sheet (${sheetRefs.length} memor${sheetRefs.length === 1 ? 'y' : 'ies'} the storyteller receives anyway${sheetTrunc})\n${sheetRefs.length ? sheetList.lines.join('\n') : '(nothing — the sheet is carrying no stored memories at all this turn)'}`);

    try {
        const inv = capLines(summarizeKeys(databases), LOOKUP_KEY_INVENTORY_CAP, 'list_keys shows a category in full');
        parts.push(`## Stored keys${inv.truncated ? ' [TRUNCATED — the store is larger than this list; use list_keys before concluding something is not stored]' : ''}\n${inv.text || '(store is empty)'}`);
    } catch { parts.push('## Stored keys\n(unavailable)'); }

    parts.push('Work now: search for what the NEW message needs, then reply with ONE REFS line and #DONE.');

    try {
        return host.getSubstituteParams()(parts.join('\n\n'));
    } catch {
        return parts.join('\n\n');
    }
}

/**
 * Run one lookup pass. NEVER throws and never rejects — every failure comes back
 * as a result object with `error` set, because the only caller is the injection
 * handler and a throw there would take a user's generation down.
 *
 * `deadlineAt` is an ABSOLUTE timestamp (Date.now() ms) and is the budget for the
 * WHOLE pass, store load included. The caller computes it before ITS first await,
 * so the number bounds the injection handler's wait rather than this function's
 * runtime. Omitted, it defaults to lookupTimeoutMs() from entry — correct only for
 * a caller that has awaited nothing yet.
 *
 * Returns { refs, error, errorKind, timedOut, stage, rounds, toolCalls, tokensIn,
 * tokensOut, ms }.
 * `stage` names what the deadline or the abort caught ('store' | 'model'), null
 * otherwise. `errorKind` classifies `error` so the caller's breaker can tell a
 * broken connection from a model that will not follow the protocol — those need
 * different thresholds and opposite advice.
 * `refs` is what the agent SAID (parsed, deduped); resolving it against the store
 * and against the sheet is renderLookupBlock's job, so a cached ref set can be
 * re-resolved later against a sheet that has since changed.
 */
export async function runLookupAgent({
    userMessage = '',
    priorMessage = '',
    sheetText = '',
    profileId = null,
    signal = null,
    runId = '',
    deadlineAt = 0,
} = {}) {
    // `errorKind` classifies `error` for the caller's breaker, which must not have
    // to read prose to tell a dead endpoint from a model that will not emit #DONE.
    // Values are llm-call.js's ('transport' | 'protocol' | 'budget' | 'aborted' |
    // 'internal') plus 'store' for a failure that never reached the model at all.
    // Null whenever `error` is null.
    const result = { refs: [], error: null, errorKind: null, timedOut: false, stage: null, rounds: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0, ms: 0 };
    const started = Date.now();
    // The configured budget, read once. Only used when the caller passed no
    // absolute deadline; when it did, that deadline already encodes the setting
    // as it stood at the top of the generation.
    const budgetMs = lookupTimeoutMs();
    const deadline = deadlineAt > 0 ? deadlineAt : started + budgetMs;

    // Deadline plumbing, armed BEFORE the first await. That ordering is the whole
    // fix: the store load below used to sit in front of it, outside the race,
    // outside the signal and outside every cancellation check. `ctrl` chains off
    // the caller's signal (chat switch, user cancel) and is also what the timeout
    // aborts; the RACE is what actually returns control — see the LOOKUP_TIMEOUT_MS
    // comment for why an abort alone is not enough.
    const ctrl = new AbortController();
    const onParentAbort = () => { try { ctrl.abort(signal.reason); } catch {  } };
    if (signal) {
        if (signal.aborted) onParentAbort();
        else signal.addEventListener('abort', onParentAbort, { once: true });
    }

    // ONE timer and ONE pair of race arms, reused across BOTH stages. Per-stage
    // timers would restart the budget after the store load and make the worst case
    // the SUM of the stages; a single absolute deadline makes it the deadline.
    let timer = null;
    const deadlineP = new Promise((resolve) => {
        timer = setTimeout(() => resolve(DEADLINE), Math.max(0, deadline - Date.now()));
    });
    // The abort is raced too, for the same reason the deadline is: an aborted
    // signal does NOT make the loop return (the transport can ignore it — see
    // above), so without this arm a chat switch two seconds in would still cost
    // the user the full deadline for a result that is already worthless.
    // Measured: 8015ms before this arm existed, ~300ms after.
    const abortedP = new Promise((resolve) => {
        if (ctrl.signal.aborted) resolve(ABORTED);
        else ctrl.signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
    });
    // Must run on EVERY exit path, including the two early ones below — a live
    // setTimeout would otherwise keep this closure (and `databases`) alive for the
    // rest of the budget on a pass that finished in 3ms.
    const releaseDeadline = () => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (signal) signal.removeEventListener?.('abort', onParentAbort);
    };

    // The two outcomes the deadline machinery can produce at EITHER stage,
    // factored out so the store load and the tool loop report them identically.
    // `stage` is the only thing that differs, and it is the only thing that lets a
    // reader tell "the model was slow" from "storage was slow".
    const finishAborted = (stage) => {
        // Cancelled from outside (chat switch, GENERATION_STOPPED, pipeline
        // disable). Not a timeout: it must not count towards the strike latch,
        // because nothing about it says anything was too slow.
        releaseDeadline();
        result.error = 'aborted';
        result.errorKind = 'aborted';
        result.stage = stage;
        result.ms = Date.now() - started;
        addDebugLog('info', `Lookup agent aborted after ${result.ms}ms (${stage} stage) — the prompt goes out without the looked-up block`, {
            runId, subsystem: 'agent3', event: 'lookup.run', reason: 'ABORTED',
            data: { ms: result.ms, stage },
        });
        return result;
    };

    const finishDeadline = (stage, callId) => {
        releaseDeadline();
        result.timedOut = true;
        result.stage = stage;
        result.ms = Date.now() - started;
        // Hang up on whatever leg is still running. The word "cancelled" is
        // load-bearing: llm-call.js classifies an abort whose message matches
        // /cancel/i as OUR hang-up rather than a transport fault, and keeps it off
        // the Health tab's agent connection row. That is the honest reading — the
        // endpoint did not fail, we stopped waiting for it.
        try { ctrl.abort(new DOMException(`BF Memory lookup cancelled — wall-clock deadline ${budgetMs}ms exceeded in the ${stage} stage`, 'AbortError')); } catch {  }
        const advice = stage === 'store'
            ? 'the memory store did not finish loading inside the budget — that is storage (attachment fetch / IndexedDB), not the lookup model'
            : 'point the Lookup Agent at a faster connection profile, or turn it off';
        addDebugLog('fail', `Lookup agent hit the ${budgetMs}ms wall-clock deadline in the ${stage} stage — the prompt goes out WITHOUT the looked-up block (${advice})`, {
            runId, subsystem: 'agent3', event: 'lookup.run', reason: 'LOOKUP_TIMEOUT',
            data: { timeoutMs: budgetMs, stage, profileId: profileId || null, ms: result.ms },
        });
        traceCapture('lookup.verdict', () => ({
            outcome: 'TIMEOUT', stage, timeoutMs: budgetMs, ms: result.ms, refs: [],
        }), { runId, callId: callId || null, reason: 'LOOKUP_TIMEOUT' });
        return result;
    };

    // --- STAGE 1: the store ---------------------------------------------------
    // Warm cache: resolves in a microtask, so the race costs one tick. Cold cache
    // (first generation after a chat switch, and after every save that invalidates
    // it): an IndexedDB read and, failing that, one un-signalled `fetch` per
    // category. This race is the only thing between a stalled file endpoint and a
    // generation that never starts. `.then` with both handlers rather than a
    // try/catch, because the rejection has to lose the race like any other slow
    // outcome instead of unwinding past it.
    const loaded = await Promise.race([
        getAllDatabases().then(db => ({ ok: true, db }), err => ({ ok: false, err })),
        deadlineP,
        abortedP,
    ]);
    if (loaded === ABORTED) return finishAborted('store');
    if (loaded === DEADLINE) return finishDeadline('store', null);
    if (!loaded.ok) {
        releaseDeadline();
        result.error = `memory store unavailable: ${loaded.err?.message || loaded.err}`;
        // Storage, not the connection profile — the model was never called. The
        // caller must not offer "check the connection profile" for this one.
        result.errorKind = 'store';
        result.stage = 'store';
        result.ms = Date.now() - started;
        addDebugLog('fail', `Lookup agent aborted — ${result.error}`, {
            // Passed explicitly on every entry in this file: the lookup runs
            // OUTSIDE beginRun/endRun and often while a background extraction run
            // is still open, so the ambient run id would file these under a run
            // that has nothing to do with them.
            runId, subsystem: 'agent3', event: 'lookup.run', reason: 'STORE_UNAVAILABLE',
        });
        return result;
    }
    const databases = loaded.db || {};

    // EMPTY STORE. A brand-new chat, or one whose every row has been cold-tiered,
    // cannot produce a single renderable ref: renderLookupBlock drops inactive and
    // cold rows outright, so the only reachable answer is `REFS: none` — bought
    // with a full prompt build and an LLM round-trip on the latency path. Counted
    // rather than trusted from a flag because `databases` is already in hand and
    // the walk stops at the first hit.
    let hasLookupable = false;
    for (const db of Object.values(databases)) {
        for (const fact of (db?.facts || [])) {
            if (isActiveFact(fact) && fact.cold !== true) { hasLookupable = true; break; }
        }
        if (hasLookupable) break;
    }
    if (!hasLookupable) {
        releaseDeadline();
        result.ms = Date.now() - started;
        addDebugLog('debug', `Lookup skipped — the store holds no row this pass could return (no LLM call, ${result.ms}ms)`, {
            runId, subsystem: 'agent3', event: 'lookup.skip', reason: 'STORE_EMPTY',
            data: { categories: Object.keys(databases).length, ms: result.ms },
        });
        return result;
    }

    const sheetRefs = extractSheetFactRefs(sheetText);
    const userPrompt = buildLookupUserPrompt({ userMessage, priorMessage, sheetRefs, databases });
    // Say it out loud when the sheet has outgrown the list. Without this line a
    // user who raised the premise-floor slider has no way to connect "the lookup
    // started repeating rows I already had" to the setting that caused it.
    if (sheetRefs.length > LOOKUP_SHEET_REFS_CAP) {
        addDebugLog('info', `Lookup prompt: sheet carries ${sheetRefs.length} memories, listing ${LOOKUP_SHEET_REFS_CAP} of them (both ends kept, ${sheetRefs.length - LOOKUP_SHEET_REFS_CAP} middle rows omitted) — the pass may re-find one of the omitted rows, which renderLookupBlock then drops as ALREADY_ON_SHEET`, {
            runId, subsystem: 'agent3', event: 'lookup.prompt', reason: 'SHEET_REFS_TRUNCATED',
            data: { sheetRefs: sheetRefs.length, shown: LOOKUP_SHEET_REFS_CAP, omitted: sheetRefs.length - LOOKUP_SHEET_REFS_CAP, tailReserved: LOOKUP_SHEET_REFS_TAIL },
        });
    }
    const callId = isTraceRecording() ? newTraceCallId('lookup') : null;

    // The prompt as this pass built it. llm-call.js captures prompt BODIES for
    // every agent, but it files them under traceNs(agent), and 'lookup-agent' is
    // not in that file's map — so those land under `llm.*` rather than `lookup.*`.
    // Capturing the inputs here is what makes the pass readable as one unit in an
    // export: the message it was answering, the set difference it was asked to
    // compute, and the size of the haystack.
    traceCapture('lookup.prompt', () => ({
        userMessageChars: String(userMessage || '').length,
        userMessage: clip(userMessage, LOOKUP_MESSAGE_CHARS),
        priorMessageChars: String(priorMessage || '').length,
        // The FULL set, which is what renderLookupBlock will exclude against — the
        // prompt shows at most LOOKUP_SHEET_REFS_CAP of them, so both numbers are
        // carried and a trace reader can see the gap rather than infer it.
        sheetRefs,
        sheetRefsShown: Math.min(sheetRefs.length, LOOKUP_SHEET_REFS_CAP),
        sheetRefsCap: LOOKUP_SHEET_REFS_CAP,
        userPromptChars: userPrompt.length,
        systemPromptChars: DEFAULT_LOOKUP_PROMPT.length,
        maxRounds: LOOKUP_MAX_ROUNDS,
        maxToolCalls: LOOKUP_MAX_TOOL_CALLS,
        timeoutMs: budgetMs,
        profileId: profileId || null,
        note: 'system prompt is fixed (no settings override); its body is llm-call.js\'s to capture',
    }), { runId, callId });

    // Read-only tool context. `mode: 'lookup'` is the flag executeMemoryTool
    // itself refuses every non-read tool on, so even a future caller that routes
    // this object through the general dispatcher cannot write with it.
    const ctx = { mode: 'lookup', databases, runId, traceCallId: callId };

    // --- STAGE 2: the model ---------------------------------------------------
    // Raced against the SAME deadlineP/abortedP the store load used, so whatever
    // the store spent is already gone from this stage's share.
    let loop = null;
    try {
        const loopPromise = callAgentLLMWithTools({
            systemPrompt: DEFAULT_LOOKUP_PROMPT,
            userPrompt,
            profileId,
            agent: 'lookup-agent',
            // Health-tab tool telemetry tag. It used to be null, on the theory
            // that recording under an unknown tag would file these reads under
            // another agent's row — which recordToolUse does not do: it keys a
            // plain map on the tag and has no roster check at all. The only
            // effect of null was that this pass recorded NOTHING, so the Health
            // tab showed no lookup section and no failures while the pass had
            // been failing every turn for 26 minutes. health.js now carries a
            // 'lookup' section over LOOKUP_TOOLS.
            agentTag: 'lookup',
            maxRounds: LOOKUP_MAX_ROUNDS,
            maxToolCalls: LOOKUP_MAX_TOOL_CALLS,
            executeTool: (call) => executeLookupTool(call, ctx),
            // THE fix that lets this pass search at all. Extraction and reflection
            // drop tool calls that ride alongside the closing block; for a
            // READ-ONLY agent that drops every call it can ever make, and its own
            // prompt invites the batching ("Several call lines in one reply are
            // fine", DEFAULT_LOOKUP_PROMPT above). With this set, a read next to
            // #DONE invalidates the block and buys round 2 instead of vanishing.
            // Scoped to this caller: extraction's final-block writes are untouched.
            // Guarded by `round < maxRounds` inside the loop; on the last round
            // the block stands and the reads drop as before, since there is no
            // round left to restate the verdict in.
            readsForceAnotherRound: true,
            // The other half of the "search before you judge" contract the
            // prompt now states: a verdict with zero executed tool calls gets
            // one correction round demanding a search. LOOKUP_MAX_ROUNDS is 3
            // precisely so this correction never pushes the demanded search
            // into a blind final round (see the budget comment at the top).
            requireToolCallBeforeDone: true,
            // The loop's "carried no sheet content" guard is for the sheet-emitting
            // agent only; this pass closes with #DONE like extraction does.
            extractOnly: true,
            // A grace-round correction shows the model an example tool line. The
            // default example is write_fact, which this executor refuses by
            // construction — steering a confused model straight into a refusal
            // would burn the one round it has left.
            protocolExample: '{"tool":"search","args":{"query":"stolen bike case"}}',
            signal: ctrl.signal,
            runId,
            traceCallId: callId,
        }).catch((e) => ({
            // A throw out of the loop itself is plumbing, not protocol — the model
            // never got as far as answering badly. 'transport' is the honest class.
            error: String(e?.message || e), errorKind: 'transport', rounds: 0, toolCallCount: 0, transcript: [],
        }));

        loop = await Promise.race([loopPromise, deadlineP, abortedP]);
    } catch (e) {
        // callAgentLLMWithTools resolves rather than rejects, and the .catch above
        // covers it anyway — this is the belt for anything the plumbing itself
        // throws, so the injection handler can never see an exception from here.
        result.error = String(e?.message || e);
        result.errorKind = 'internal';
    }

    if (loop === ABORTED && !result.error) return finishAborted('model');
    if (loop === DEADLINE && !result.error) return finishDeadline('model', callId);
    releaseDeadline();

    if (loop && loop !== DEADLINE && loop !== ABORTED) {
        result.rounds = loop.rounds || 0;
        result.toolCalls = loop.toolCallCount || 0;
        result.tokensIn = loop.tokensInApprox || 0;
        result.tokensOut = loop.tokensOutApprox || 0;
        if (loop.error) {
            result.error = loop.error;
            // The loop classifies its own failures; 'transport' only as the
            // fallback for a shape that predates the field.
            result.errorKind = loop.errorKind || 'transport';
        }

        // Newest-first for the reply that actually carries a REFS line: a grace
        // round can split the answer, and a reasoning model drafts ref lists
        // inside <think> that it then argues itself out of — the same hazard
        // agent-memory.js strips think blocks for before parsing NEED.
        for (let i = (loop.transcript || []).length - 1; i >= 0; i--) {
            const r = stripThinkBlocks(String(loop.transcript[i]?.reply || ''));
            if (/^\s*[-*]?\s*REFS\s*:/im.test(r)) { result.refs = parseRefsLine(r); break; }
        }
    }

    // Dedupe on the ref as written; resolution-level dedupe (two spellings of one
    // record) happens in renderLookupBlock, which is where the records exist.
    const seen = new Set();
    result.refs = result.refs.filter(r => {
        const id = `${r.category.toLowerCase()}/${r.key.toLowerCase()}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });

    result.ms = Date.now() - started;

    const level = result.error ? 'fail' : 'info';
    addDebugLog(level, `Lookup agent: ${result.refs.length} ref(s) in ${result.ms}ms, ${result.rounds} round(s), ${result.toolCalls} tool call(s)${result.error ? ` — ERROR: ${result.error}` : ''}`, {
        runId, subsystem: 'agent3', event: 'lookup.run', reason: result.error ? 'ERROR' : 'OK',
        data: {
            agent: 'lookup-agent', profileId: profileId || null, success: !result.error,
            refs: result.refs.map(r => `${r.category}/${r.key}`),
            rounds: result.rounds, toolCallCount: result.toolCalls, durationMs: result.ms,
            tokensIn: result.tokensIn, tokensOut: result.tokensOut, error: result.error || null,
            errorKind: result.errorKind || null,
        },
    });

    // The verdict, with the per-round tool traffic beside it. This is the capture
    // that answers "did this pass earn its latency": what it was asked, what it
    // called, what it came back with, and how long the user waited for it.
    traceCapture('lookup.verdict', () => ({
        outcome: result.error ? 'ERROR' : (result.refs.length ? 'REFS' : 'NONE'),
        error: result.error || null,
        errorKind: result.errorKind || null,
        ms: result.ms,
        refs: result.refs.map(r => `${r.category}/${r.key}`),
        rounds: (loop?.transcript || []).map(t => ({
            round: t.round,
            toolCalls: t.toolCalls,
            malformed: t.malformed,
            note: t.note || '',
            reply: t.reply,
        })),
        toolCallCount: result.toolCalls,
        tokensIn: result.tokensIn, tokensOut: result.tokensOut,
    }), { runId, callId });

    return result;
}

/**
 * Resolve a ref set into the injectable block. Split from runLookupAgent on
 * purpose: a swipe or a regenerate re-uses the refs the last lookup produced for
 * the SAME user message (no second call, no second wait), and by then the sheet
 * may have been recomposed — so the exclusion and the resolution have to be
 * redone against the sheet that is actually going out.
 *
 * `deadlineAt` is the same ABSOLUTE timestamp the pass was given, and it bounds
 * the store load below for exactly the reason it bounds runLookupAgent's: this is
 * the SECOND place the lookup can block on a cold cache, and on the swipe path it
 * is the FIRST — runLookupAgent never runs there (the refs are reused), and any
 * save since has invalidated the cache, so the cold load lands here instead.
 *
 * Never throws. Returns { block, rendered, dropped } with block === '' when
 * nothing survives, which is the common case.
 */
export async function renderLookupBlock({ refs = [], sheetText = '', runId = '', deadlineAt = 0 } = {}) {
    const out = { block: '', rendered: [], dropped: [] };
    if (!Array.isArray(refs) || refs.length === 0) return out;
    let timer = null;
    try {
        const deadline = deadlineAt > 0 ? deadlineAt : Date.now() + lookupTimeoutMs();
        const deadlineP = new Promise((resolve) => {
            timer = setTimeout(() => resolve(DEADLINE), Math.max(0, deadline - Date.now()));
        });
        // No rejection handler on the load: a genuine store error should unwind to
        // the catch below and be reported as ERROR, which is a different thing
        // from the store being slow.
        const loaded = await Promise.race([getAllDatabases().then(db => ({ db })), deadlineP]);
        if (loaded === DEADLINE) {
            addDebugLog('fail', `Lookup block skipped — the memory store did not load inside the pass deadline; the prompt goes out without the looked-up rows`, {
                runId, subsystem: 'agent3', event: 'lookup.block', reason: 'STORE_TIMEOUT',
                data: { asked: refs.length },
            });
            return out;
        }
        const databases = loaded.db || {};
        let nowCtx = null;
        try { nowCtx = getTurnNowContext(); } catch { nowCtx = null; }

        // The sheet's own rows, as REFS — the same parse the usage accounting and
        // the omission-recovery list use, so "already carried" means the same
        // thing in all three places.
        const onSheet = new Set(extractSheetFactRefs(sheetText).map(r => r.toLowerCase()));

        const lines = [];
        const seen = new Set();
        for (const ref of refs) {
            const category = mapLegacyCategory(String(ref?.category || '').trim() || 'Unsorted');
            const key = String(ref?.key || '').trim();
            const asked = `${ref?.category || ''}/${ref?.key || ''}`;
            if (!key) { out.dropped.push({ ref: asked, why: 'NO_KEY' }); continue; }
            const db = databases[category];
            const fact = db ? findFactMatch(db, key) : null;
            // Every drop reason is recorded rather than collapsed into silence: a
            // ref the agent verified through a tool and that then fails to resolve
            // here is a retrieval bug, and it is indistinguishable from an
            // invented ref unless the reason is named.
            if (!fact) { out.dropped.push({ ref: asked, why: 'NOT_FOUND' }); continue; }
            if (!isActiveFact(fact)) { out.dropped.push({ ref: asked, why: 'INACTIVE' }); continue; }
            if (!isFactVisible(fact)) { out.dropped.push({ ref: asked, why: 'NOT_VISIBLE' }); continue; }
            // Cold is a deliberate demotion (a conflict loser, a merge loser, a
            // salience overflow). composeSheet skips cold rows for NEED and for
            // sticky recoveries; a lookup must not be the one path that walks a
            // demoted record back into the prompt.
            if (fact.cold === true) { out.dropped.push({ ref: asked, why: 'COLD' }); continue; }
            const id = `${category}/${fact.key}`;
            if (seen.has(id.toLowerCase())) { out.dropped.push({ ref: asked, why: 'DUPLICATE' }); continue; }
            if (onSheet.has(id.toLowerCase())) { out.dropped.push({ ref: asked, why: 'ALREADY_ON_SHEET' }); continue; }
            seen.add(id.toLowerCase());
            if (lines.length >= LOOKUP_REFS_CAP) { out.dropped.push({ ref: asked, why: 'OVER_CAP' }); continue; }
            lines.push(buildFactLine(fact, category, nowCtx));
            out.rendered.push(id);
        }

        if (lines.length > 0) {
            let header = LOOKUP_BLOCK_HEADER;
            try { header = host.getSubstituteParams()(header); } catch {  }
            out.block = [header, ...lines].join('\n');
        }

        traceCapture('lookup.block', () => ({
            asked: refs.map(r => `${r.category}/${r.key}`),
            rendered: out.rendered,
            dropped: out.dropped,
            cap: LOOKUP_REFS_CAP,
            chars: out.block.length,
            block: out.block,
        }), { runId });

        if (out.dropped.length > 0) {
            addDebugLog('debug', `Lookup block: ${out.rendered.length} row(s) rendered, ${out.dropped.length} ref(s) dropped (${out.dropped.map(d => `${d.ref}:${d.why}`).slice(0, 8).join(', ')})`, {
                runId, subsystem: 'agent3', event: 'lookup.block', reason: 'REFS_DROPPED',
                data: { rendered: out.rendered, dropped: out.dropped, cap: LOOKUP_REFS_CAP },
            });
        }
    } catch (e) {
        // Non-fatal, same as everything else on this path: no block, generation
        // continues.
        addDebugLog('fail', `Lookup block rendering failed (non-fatal): ${e?.message || e}`, {
            runId, subsystem: 'agent3', event: 'lookup.block', reason: 'ERROR',
        });
        out.block = '';
    } finally {
        if (timer) clearTimeout(timer);
    }
    return out;
}
