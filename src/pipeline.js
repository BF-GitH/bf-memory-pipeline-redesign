// BF Memory Pipeline - Main Orchestrator (v2 - Inline Blocking)
// Runs agents during prompt assembly. Never aborts, never re-triggers.
// ST's EventEmitter awaits async handlers, so generation waits for us.

import { runDraftAgent } from './agent-draft.js';
import { buildWriterInjection, injectMemoryContext, buildSceneBlock, buildBigPictureBlock, buildMomentEchoBlock } from './agent-writer.js';
import { runMemoryUpdater } from './agent-memory.js';
import { runReflection } from './agent-reflect.js';
import { retrieveFacts, extractContextKeywords, isFactVisible, retrievalSalience, estimateInjectionTokens } from './fact-retrieval.js';
import { getAllDatabases, getMemoryIndex, saveDatabase, createEmptyDatabase, upsertFact, summarizeKeys, summarizeMenuIndexed, collectBranchFactsIndexed, deriveAspect, invalidateDatabaseCache, markFactsUsed, applyBufferedFactUsage, getRelationshipMomentThread } from './database.js';
import { cancelInFlightLLM } from './llm-call.js';
import { getAgent1ProfileId, getAgent3ProfileId, detectProfileForToolFirst } from './profiler.js';
import { trackUpdate, tickMessageCounter, showReviewPopup } from './review-popup.js';
import { getSettings, addDebugLog, updateStatus, setLastGenerated, setLastInserted, appendLastInserted, setLastInjection, saveCurrentToActiveProfile, setRunTokens, setMainOutputTokens, addAgent3Tokens, addReflectionTokens, setScene, getScene, reloadEntitiesUI, beginRun, endRun, setPendingRun, getPendingRun, consumePendingRun, getSummaryPyramid, isTriviallyEmptyForExtraction } from './settings.js';
import { detectAndRecord, showEntityPopup, runEntityResolution } from './agent-entities.js';

// Pipeline state
// F-ORCH-2 (overlapping internal-call windows): this used to be a single boolean
// (`let isInternalCall = false`) set/cleared by THREE overlapping async flows —
// runPipelineInline's Agent-1 window, runMemoryExtraction (held across the whole Scribe
// call), and maybeRunReflection. Whichever flow finished FIRST cleared the flag out from
// under the others; worse, a flag held by a long background extraction made a GENUINE user
// turn hard-skip the pipeline and generate with ZERO memory injection, silently. Now a
// REFERENCE COUNT: every flow increments on entry and decrements in its own `finally`
// (clamped at 0 — CHAT_CHANGED force-resets to 0, so a straggling finally must not drive
// it negative), so overlapping windows compose correctly. Read ONLY via isInternalCall().
let internalCallDepth = 0;
// True while ANY of our own agent flows has an LLM-call window open. NOTE: the normal agent
// transports (CMRS / direct proxy fetch, see llm-call.js) never re-enter ST's generation
// events at all — this guard exists for the rare generateQuietPrompt FALLBACK leg
// (llm-call.js priority 3), which DOES run ST's full generation pipeline and would
// otherwise recurse into us.
const isInternalCall = () => internalCallDepth > 0;
let chatChangedAt = 0;
let lastTriggeredUserMsgIndex = -1;
let lastInjection = null; // cached injection text for the FIRST generation (scene + facts + Agent-1 draft)
// Phase 3b / FIX #8a: a SECOND cached injection with the SAME scene + facts but WITHOUT
// Agent 1's draft scene-direction. Agent 1's draft is "what should happen next" planned
// for the ORIGINAL roll; reusing it verbatim on a divergent swipe/regen mis-steers a very
// different re-roll. So swipes/regens re-inject the stable facts + scene from here and DROP
// the stale draft (facts are safe to reuse; the draft is not). Kept fast: no agent re-run.
let lastInjectionNoDraft = null;
let pipelineJustInjected = false; // guards against double-fire of CHAT_COMPLETION_PROMPT_READY
let profileDetectionLogged = false; // tool-first: log Claude-profile detection once per session
// A2/B5 — FROZEN INJECTION (opt-in, settings.injectionFreezeTurns; default 0 = off). Counts
// CONSECUTIVE genuine-new-turns that REUSED the cached injection instead of re-running the agents.
// 0 while disabled / right after a full run; incremented on each frozen turn; reset to 0 on a full
// run and on CHAT_CHANGED. See tryFrozenInjection() for the full rationale.
let turnsSinceFullInjection = 0;
let pipelineCancelled = false; // set true when user clicks Stop / disables mid-run; checked before DB writes
let groupSkipToastShown = false; // show-once toast when skipping group chats
let runRecordedInput = false; // true once setRunTokens fired this generation cycle; gates main-output attribution so swipes don't desync the counters
// Reflection / consolidation: count successful pipeline runs (Agent 3 committed facts).
// When this hits reflectionInterval we schedule ONE consolidation LLM call on the
// post-turn path (after MESSAGE_RECEIVED), off the latency-critical generation path.
let successfulRunsSinceReflection = 0;
let reflectionPending = null; // {runId, charAvatar} captured at the run that armed it; consumed on MESSAGE_RECEIVED
let reflectionInFlight = false; // guard so overlapping turns can't double-fire the pass
// IDLE-TIME CONSOLIDATION (Letta sleeptime pattern). In ADDITION to the every-N-turns cadence,
// an idle timer fires the SAME maybeRunReflection() pass once the user has gone quiet for
// idleConsolidationMs. Reset on every user activity (MESSAGE_RECEIVED), cleared on CHAT_CHANGED.
// Opt-in (settings.idleConsolidation, default OFF). Self-guarded so it can never double-fire with
// the turn-cadence pass (maybeRunReflection no-ops without an armed reflectionPending / when one is
// already in flight) and never runs while a generation is active.
let idleConsolidationTimer = null;
// Phase 3b: Agent 3 (memory extraction) now runs on MESSAGE_RECEIVED, off the blocking
// path. This guard prevents two MESSAGE_RECEIVED events (e.g. a fast follow-up turn) from
// launching overlapping extractions that race on the same DB save.
let memoryExtractionInFlight = false;
// F-ORCH-3 (silent memory loss): retry state for extraction attempts dropped by the busy /
// cancelled early-returns in runMemoryExtraction. The target scan only ever finds the LAST
// genuine AI message, so a dropped attempt was never re-tried — the exchange was permanently
// lost. Both flags are ONE-SHOT (bounded — never a retry loop):
//  - extractionRetryAfterBusy: armed when an attempt finds a prior extraction still committing;
//    consumed by that in-flight run's `finally`, which re-schedules ONE settle extraction
//    ('retry-busy'). Chained to a REAL run finishing — no timer polling, cannot spin.
//  - cancelledRetryArmed: armed when an attempt is dropped because pipelineCancelled was set by
//    a Stop on a LATER generation; schedules ONE timer retry ('retry-cancelled'). Reset when an
//    extraction actually proceeds (each new drop window may retry once) and on CHAT_CHANGED.
let extractionRetryAfterBusy = false;
let cancelledRetryArmed = false;
// Character registry: count successful memory-extraction runs and, every
// characterCheckInterval, run a deterministic scan for newly-seen NAMED entities off the
// critical path (after the post-reply extraction has committed its facts). Mirrors the
// reflection cadence but is far cheaper (no LLM call) and only opens a popup when there
// are unclassified candidates. Per-chat: reset on CHAT_CHANGED.
let runsSinceEntityCheck = 0;
let entityCheckInFlight = false;
// FIX #8b / FIX #12: single debounce timer for SETTLE extraction. BOTH paths feed it now:
//   - Generating a NEW swipe fires MESSAGE_RECEIVED (the AI reply landed), and
//   - Navigating LEFT/RIGHT onto an ALREADY-GENERATED swipe fires MESSAGE_SWIPED (no
//     MESSAGE_RECEIVED).
// Previously MESSAGE_RECEIVED extracted EAGERLY (one ~7k-token Agent-3 call per generated
// swipe), so spinning 4 swipes before settling cost up to 4× Agent 3. Now MESSAGE_RECEIVED
// also SCHEDULES the debounced extraction instead of running it inline: rapid regeneration /
// navigation keeps resetting the timer, so the expensive extraction runs ONCE on the SETTLED
// (kept) swipe rather than once per mid-swipe roll. A normal single-reply turn (no swiping)
// schedules once and, with nothing resetting it, extracts promptly after the short window —
// still exactly one extraction per turn. The reflection + entity-check passes are chained to
// run AFTER the (single) settled extraction completes. Cleared on chat change.
let swipeSettleTimer = null;
// Debounce window before a settled extraction fires. Short enough that a normal turn extracts
// promptly, long enough that back-to-back swipe regenerations / navigation coalesce into one.
const SETTLE_EXTRACTION_DELAY_MS = 1800;

/**
 * FIX #12: schedule the post-reply extraction on the shared settle-debounce instead of
 * running it eagerly. Resets any pending timer so only the FINAL settled message extracts
 * (a heavily-swiped turn extracts ~once, not once per swipe). After extraction completes we
 * chain the armed reflection pass and the entity-check, which previously ran right after the
 * eager MESSAGE_RECEIVED extraction — keeping their ordering relative to the kept content.
 * Fully try/catch'd: a scheduling/extraction failure must never break the turn.
 *
 * @param {string} reason - short tag for the debug log (e.g. 'message-received', 'swipe').
 * @param {boolean} [runPostPasses=false] - when true, chain maybeRunReflection +
 *   maybeRunEntityCheck after the extraction (the MESSAGE_RECEIVED path owns those passes).
 */
function scheduleSettleExtraction(reason, runPostPasses = false) {
    try {
        if (swipeSettleTimer) {
            clearTimeout(swipeSettleTimer);
            addDebugLog('info', `Agent 3 extraction coalesced (${reason}) — resetting settle timer, deferring until settled`);
        } else {
            addDebugLog('info', `Agent 3 extraction deferred (${reason}) — will run after ${SETTLE_EXTRACTION_DELAY_MS}ms settle window`);
        }
        swipeSettleTimer = setTimeout(async () => {
            swipeSettleTimer = null;
            try {
                await runMemoryExtraction();
                if (runPostPasses) {
                    // Reflection / consolidation + character-registry detection, off the
                    // critical path. Self-guarded + try/catch'd internally. Reflection carries
                    // its own runId via reflectionPending, so it stays grouped with the turn.
                    maybeRunReflection();
                    maybeRunEntityCheck();
                }
            } catch (err) {
                addDebugLog('fail', `Settle extraction failed (non-fatal): ${err.message || err}`);
            } finally {
                // The turn's post-reply work has now been dispatched — disarm the pendingRun so a
                // later swipe/turn mints/reuses its own id and can't inherit this run's id.
                if (runPostPasses) consumePendingRun();
            }
        }, SETTLE_EXTRACTION_DELAY_MS);
    } catch (err) {
        addDebugLog('fail', `Scheduling settle extraction failed (non-fatal): ${err.message || err}`);
    }
}

/**
 * IDLE-TIME CONSOLIDATION (Letta sleeptime pattern). Cancel any pending idle timer. Called on
 * every user activity (to debounce) and on CHAT_CHANGED (so the timer can't fire against a
 * different chat). Cheap + idempotent.
 */
function clearIdleConsolidation() {
    if (idleConsolidationTimer) {
        clearTimeout(idleConsolidationTimer);
        idleConsolidationTimer = null;
    }
}

/**
 * (Re)arm the idle-consolidation timer. Resets any previously-armed timer so the countdown only
 * elapses after genuine quiet (every MESSAGE_RECEIVED pushes it forward). When it fires we invoke
 * the SAME maybeRunReflection() pass used by the turn-cadence path — it carries every existing
 * guard (enabled / cancelled / group / character-changed / reflectionInFlight) and no-ops unless a
 * reflection is actually armed (reflectionPending), so this CANNOT double-fire with the turn pass.
 * We additionally skip if a generation/turn is still mid-flight (getPendingRun() non-null) so we
 * never run during active generation. Opt-in via settings.idleConsolidation (default OFF). Fully
 * try/catch'd at every layer — an idle-timer failure must never break the turn.
 */
function armIdleConsolidation() {
    try {
        const settings = getSettings();
        if (!settings || !settings.enabled || !settings.idleConsolidation) {
            clearIdleConsolidation(); // disabled mid-session — make sure nothing is left armed
            return;
        }
        clearIdleConsolidation();
        const delay = Math.max(30000, Number(settings.idleConsolidationMs) || 120000);
        idleConsolidationTimer = setTimeout(() => {
            idleConsolidationTimer = null;
            try {
                const s = getSettings();
                if (!s || !s.enabled || !s.idleConsolidation) return; // re-check at fire time
                // Never run while a generation/turn is still settling: getPendingRun() stays
                // non-null from generation start until the settle extraction consumes it (which
                // ALSO runs maybeRunReflection). Skipping here avoids racing that pass and avoids
                // firing during active generation. If still busy, re-arm to retry after quiet.
                if (getPendingRun()) { armIdleConsolidation(); return; }
                if (pipelineCancelled || reflectionInFlight) return; // also fully covered inside the call
                addDebugLog('info', `Idle consolidation: ${Math.round(delay / 1000)}s quiet — running reflection pass`);
                // maybeRunReflection() is self-guarded + try/catch'd: no-ops unless a reflection
                // is armed (reflectionPending) and no other guard trips.
                maybeRunReflection();
            } catch (err) {
                try { addDebugLog('fail', `Idle consolidation fire failed (non-fatal): ${err.message || err}`); } catch { /* noop */ }
            }
        }, delay);
    } catch (err) {
        try { addDebugLog('fail', `Arming idle consolidation failed (non-fatal): ${err.message || err}`); } catch { /* noop */ }
    }
}

// ANCHOR ASPECTS: the durable / current-state / relationship leaves that a Writer must always
// respect for a present character to stay in continuity (a name dropped breaks the scene).
// Keyword retrieval can miss these even though they're load-bearing — so we GUARANTEE a few per
// present character deterministically (from the bySubject index) alongside the retrieved facts.
// Matched against deriveAspect() leaves; kept small and identity/state/relationship.
const ANCHOR_ASPECTS = new Set([
    'identity', 'name', 'status', 'species', 'age', 'gender', 'pronouns', 'titles',
    'current_location', 'mood', 'goal', 'health',
    'trust', 'romance', 'relationship', 'rapport', 'tension',
]);

/**
 * Guarantee the in-focus characters' key anchors (identity / current-state / active relationship)
 * are injected even if retrieval misses them. Pulls from the per-turn bySubject index (already
 * active-only) for each focus character, ranks by anchor-aspect priority then importance, and
 * returns up to `perChar` `{fact, category, tier:'primary'}` entries per character, EXCLUDING any
 * already chosen (so we never double-inject). Deterministic, no LLM, cheap (indexed by subject).
 * @param {{bySubject: Map}} index - per-turn memory index
 * @param {string[]} focus - focus character names from Agent 1's #Focus
 * @param {number} perChar - max anchors to guarantee per present character (0 disables)
 * @param {Set<string>} alreadyChosen - ids (`category:key`, lowercased) already selected
 * @returns {Array<{fact: Object, category: string, tier: string}>}
 */
function collectAnchorFacts(index, focus, perChar, alreadyChosen) {
    if (!index || !index.bySubject || !perChar || perChar < 1) return [];
    const names = (focus || []).map(f => String(f || '').trim().toLowerCase()).filter(Boolean);
    if (names.length === 0) return [];
    const out = [];
    const seen = new Set(alreadyChosen || []);
    for (const name of new Set(names)) {
        const bucket = index.bySubject.get(name) || [];
        // Keep only visible anchor-aspect facts not already chosen.
        const anchors = [];
        for (const entry of bucket) {
            const { fact, category } = entry;
            if (!isFactVisible(fact)) continue;
            const aspect = deriveAspect(fact);
            if (!ANCHOR_ASPECTS.has(aspect)) continue;
            const id = `${String(category).toLowerCase()}:${String(fact.key).toLowerCase()}`;
            if (seen.has(id)) continue;
            anchors.push({ entry, aspect, id, importance: Number(fact.importance) || 0 });
        }
        // Identity/state first (anchor-aspect order in ANCHOR_ASPECTS ≈ priority), then importance.
        const order = [...ANCHOR_ASPECTS];
        anchors.sort((a, b) =>
            (order.indexOf(a.aspect) - order.indexOf(b.aspect)) || (b.importance - a.importance));
        let added = 0;
        for (const a of anchors) {
            if (added >= perChar) break;
            seen.add(a.id);
            out.push({ fact: a.entry.fact, category: a.entry.category, tier: 'primary' });
            added++;
        }
    }
    return out;
}

/**
 * Count tokens for a chat-completion message array (role wrappers included).
 * Uses ST's local tokenizer — approximate, but same tokenizer both sides so the delta holds.
 */
async function countChatTokens(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return 0;
    const ctx = SillyTavern.getContext();
    try {
        if (ctx.countTokensOpenAIAsync) return await ctx.countTokensOpenAIAsync(arr, true);
        // fallback: sum per-message
        let total = 0;
        for (const m of arr) total += await (ctx.getTokenCountAsync?.(m.content || m.mes || '') ?? 0);
        return total;
    } catch { return 0; }
}

/**
 * Format the chosen facts for the writer, IDENTICAL in shape to fact-retrieval's
 * formatFactsForWriter so the injection stays uniform: `[knownBy] Category/key = value`
 * with the optional context note appended. Re-applies the rename-tolerant visibility filter
 * defensively (never inject a hidden fact). Moved here from the retired agent-finder.js —
 * the deterministic retrieval + anchor paths are its only remaining consumers.
 * @param {Array<{fact: Object, category: string}>} results
 * @returns {string}
 */
function formatChosenFacts(results) {
    const visible = (results || []).filter(({ fact }) => isFactVisible(fact));
    if (visible.length === 0) return '(No stored facts available)';
    const lines = [];
    for (const { fact, category } of visible) {
        const knownBy = (fact.knownBy || []).join(', ');
        const prefix = knownBy ? `[${knownBy}]` : '[everyone]';
        const hasValue = String(fact.value ?? '').trim() !== '';
        const note = (typeof fact.context === 'string' && fact.context.trim()) ? fact.context.trim() : '';
        // Episodic-memory feature (mirror of formatFactsForWriter): append a `moment`'s short
        // emotional `tone` compactly so the beat reads with its feeling, e.g. `Events/key: <note> (tense)`.
        const tone = (typeof fact.tone === 'string' && fact.tone.trim()) ? fact.tone.trim() : '';
        // INJECTION DE-DUPLICATION (mirror of formatFactsForWriter): storage keeps
        // BOTH value and note, but when a note exists it already carries the fact, so
        // inject the NOTE IN PLACE OF the value. With no note, inject `key = value`.
        let line;
        if (note) {
            line = `${prefix} ${category}/${fact.key}: ${note}${tone ? ` (${tone})` : ''}`;
        } else if (hasValue) {
            line = `${prefix} ${category}/${fact.key} = ${fact.value}`;
        } else {
            line = `${prefix} ${category}/${fact.key}`;
        }
        lines.push(line);
    }
    return lines.join('\n');
}

/**
 * Record this run's token metrics for the Tokens tab. Wrapped in try/catch so a
 * tokenizer failure can never abort the pipeline run. Sets runRecordedInput so the
 * MESSAGE_RECEIVED handler only attributes main-model output to a run that actually
 * recorded input this generation cycle (prevents swipe-driven counter desync).
 */
function recordRunTokens({ baselineInput, actualInput, draftResult, memoryResult }) {
    try {
        setRunTokens({
            baselineInput: baselineInput || 0,
            actualInput: actualInput || 0,
            agent1Input: draftResult?.tokensIn || 0,
            agent1Output: draftResult?.tokensOut || 0,
            agent3Input: memoryResult?.tokensIn || 0,
            agent3Output: memoryResult?.tokensOut || 0,
            // Finder (Agent 4) slots retired with the finder — always 0; kept so the
            // Tokens-tab record shape stays stable for existing readers.
            finderInput: 0,
            finderOutput: 0,
            mainOutput: 0,
        });
        runRecordedInput = true;
    } catch (err) {
        addDebugLog('info', `Token recording failed (non-fatal): ${err.message || err}`);
    }
}

/**
 * FIX #10 + debug-log redesign §3: Emit ONE consolidated per-run summary debug entry,
 * grouping the run's outcome under a runId: duration, which agents ran/ok/failed, fact
 * NEW/UPDATED/SKIPPED/EVICTED counts, and the token breakdown.
 *
 * Structured: tagged subsystem:'pipeline', event:'run.summary', level info (pass/fail when
 * an agent errored / run cancelled), with a full `data` blob for the (later-phase) group
 * header UI. The legacy `[runId] SUMMARY …` message text is preserved for back-compat readers.
 *
 * Fact counts: derived from memoryResult.applied when present; callers may also pass an
 * explicit `facts` override ({ NEW, UPDATED, SKIPPED, EVICTED }) — e.g. the post-reply path,
 * which knows EVICTED counts the inline path can't see.
 *
 * @param {object} a
 * @param {string} a.runId
 * @param {number} a.startTime          epoch ms the run began (duration = now - startTime)
 * @param {number} a.baselineInput
 * @param {number} a.actualInput
 * @param {object} [a.draftResult]      Agent 1 result (ok/failed + tokens)
 * @param {object} [a.memoryResult]     Agent 3 result (updates/applied + tokens + mainOutput)
 * @param {boolean} [a.cancelled]
 * @param {{NEW?:number,UPDATED?:number,SKIPPED?:number,EVICTED?:number}} [a.facts] count override
 */
function logRunSummary({ runId, startTime, baselineInput, actualInput, draftResult, memoryResult, cancelled, facts, stages, reflectionTokens, agent1Skipped }) {
    try {
        const duration = Date.now() - startTime;
        // When Agent 1 was intentionally skipped (hybrid/tool-only), it is neither "ok" nor "failed"
        // — use null ("not applicable") so any consumer reading !agent1Ok alone can't misread a
        // deliberate skip as a degraded run. (agent1Ran already excludes the skip from the run tally.)
        const agent1Ok = agent1Skipped ? null : !!(draftResult && !draftResult.error && draftResult.draft);
        // Hybrid/tool-only mode intentionally skips the Drafter — treat that as "skipped", NOT a
        // failed run. Without this, an empty (but errorless) draft shape reads as agent1Ran && !ok
        // and would flag every hybrid turn as failed in the summary/log level.
        const agent1Ran = !!draftResult && !agent1Skipped;
        const agent3Ran = !!memoryResult;
        const agent3Ok = agent3Ran && !memoryResult?.error;
        const updates = Array.isArray(memoryResult?.updates) ? memoryResult.updates : [];
        const applied = Array.isArray(memoryResult?.applied)
            ? memoryResult.applied
            : updates.filter(u => u.changed ?? u.wasNew);
        let nNew = 0, nUpd = 0, nSkip = 0;
        for (const u of applied) {
            const st = (u.status || (u.wasNew ? 'NEW' : 'UPDATED')).toUpperCase();
            if (st === 'NEW') nNew++;
            else if (st === 'UPDATED') nUpd++;
            else if (st === 'SKIPPED') nSkip++;
        }
        // Explicit overrides win (caller knows better — e.g. EVICTED from the db path).
        if (facts && typeof facts === 'object') {
            if (Number.isFinite(facts.NEW)) nNew = facts.NEW;
            if (Number.isFinite(facts.UPDATED)) nUpd = facts.UPDATED;
            if (Number.isFinite(facts.SKIPPED)) nSkip = facts.SKIPPED;
        }
        const nEvict = Number.isFinite(facts?.EVICTED) ? facts.EVICTED : 0;
        const a1In = Number(draftResult?.tokensIn) || 0;
        const a1Out = Number(draftResult?.tokensOut) || 0;
        const a3In = Number(memoryResult?.tokensIn) || 0;
        const a3Out = Number(memoryResult?.tokensOut) || 0;
        const bIn = Number(baselineInput) || 0;
        const aIn = Number(actualInput) || 0;
        const mainOut = Number(memoryResult?.mainOutput) || 0; // usually 0 on the inline path
        // Reflection pass tokens — folded into the NET so the per-run summary reflects the
        // TRUE extension overhead.
        const rIn = Number(reflectionTokens?.input) || 0;
        const rOut = Number(reflectionTokens?.output) || 0;
        const netIn = (aIn + a1In + a3In + rIn) - bIn;
        const failed = !!cancelled || (agent1Ran && !agent1Ok) || (agent3Ran && !agent3Ok);
        // Observability: stamp the DB context this run executed against, so every per-turn
        // summary line says which profile/avatar it touched (read-only — no behavior change).
        // activeProfile from settings; avatar from the live host context (same inline pattern
        // used elsewhere in this file). dbFactsAtStart is intentionally omitted: this summary
        // path is synchronous and getAllDatabases() is async — counting facts here would force a
        // signature/timing change, which is out of scope for logging-only.
        let activeProfile = null;
        let avatar = null;
        try { activeProfile = getSettings()?.activeDbProfile || null; } catch { /* read-only */ }
        try { avatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || null; } catch { /* read-only */ }
        addDebugLog('info',
            `[${runId}] SUMMARY ${cancelled ? '(cancelled) ' : ''}` +
            `dur=${duration}ms | Agent1=${agent1Ran ? (agent1Ok ? 'ok' : 'failed') : 'skipped'} | ` +
            `Agent3 NEW=${nNew} UPDATED=${nUpd} SKIPPED=${nSkip} EVICTED=${nEvict} | ` +
            `tokens: baselineIn=${bIn} actualIn=${aIn} a1(in/out)=${a1In}/${a1Out} ` +
            `a3(in/out)=${a3In}/${a3Out}` +
            `${rIn || rOut ? ` refl(in/out)=${rIn}/${rOut}` : ''}${mainOut ? ` mainOut=${mainOut}` : ''} net=${netIn >= 0 ? '+' : ''}${netIn}`,
            {
                runId,
                subsystem: 'pipeline',
                event: 'run.summary',
                level: failed ? 'fail' : 'info',
                data: {
                    durationMs: duration,
                    cancelled: !!cancelled,
                    agents: {
                        agent1: agent1Ran ? (agent1Ok ? 'ok' : 'failed') : 'skipped',
                        agent3: agent3Ran ? (agent3Ok ? 'ok' : 'failed') : 'skipped',
                    },
                    facts: { NEW: nNew, UPDATED: nUpd, SKIPPED: nSkip, EVICTED: nEvict },
                    tokens: { baselineIn: bIn, actualIn: aIn, a1In, a1Out, a3In, a3Out, reflectionIn: rIn, reflectionOut: rOut, mainOut, netIn },
                    // PER-STAGE TIMING BREAKDOWN (observability only — slowness hunt). Whatever the
                    // caller measured this run (blocking-path stages and/or post-reply agent3 etc).
                    // Null/absent when a path didn't supply it. Keeps the legacy fields intact.
                    stages: stages || null,
                    // Agent-3 (Scribe) prompt cost, surfaced PROMINENTLY for the slowness hunt: a
                    // giant UNSTABLE system prompt (no server-side cache reuse) is a prime suspect.
                    // Read off memoryResult when Agent 3 ran on this summary path (post-reply).
                    agent3Prompt: agent3Ran ? {
                        systemPromptChars: Number.isFinite(memoryResult?.systemPromptChars) ? memoryResult.systemPromptChars : null,
                        systemPromptApproxTokens: Number.isFinite(memoryResult?.systemPromptApproxTokens) ? memoryResult.systemPromptApproxTokens : null,
                        systemPromptStable: typeof memoryResult?.systemPromptStable === 'boolean' ? memoryResult.systemPromptStable : null,
                    } : null,
                    // DB context this run ran against (observability stamp).
                    activeProfile,
                    avatar,
                },
            },
        );
    } catch (err) {
        addDebugLog('info', `Run summary failed (non-fatal): ${err.message || err}`);
    }
}

/**
 * Get recent chat messages
 */
function getRecentMessages(count) {
    const context = SillyTavern.getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return [];

    const messages = [];
    const startIndex = Math.max(0, chat.length - count);
    for (let i = startIndex; i < chat.length; i++) {
        if (chat[i] && chat[i].mes) {
            messages.push(chat[i]);
        }
    }
    return messages;
}

/**
 * Format messages for Agent 1 (Drafter)
 * Messages are passed in FULL — there is no per-message char cap. The old
 * draftMsgCharLimit truncated each message and hid the back half of longer turns,
 * costing the Drafter context. The message COUNT is still bounded by
 * agent1ContextMessages upstream.
 */
function formatMessagesForDraft(messages) {
    return messages.map((msg, idx) => {
        const role = msg.is_user ? 'USER' : 'AI';
        return `Message ${idx + 1}: ${role}: ${msg.mes}`;
    }).join('\n');
}

/**
 * Get character info for prompts
 */
function getCharacterInfo() {
    const context = SillyTavern.getContext();
    const char = context.characters?.[context.characterId];
    if (!char) return '';

    // Bumped from 500/300/300 to 2000/1000/1000 — serious roleplay cards have
    // critical lore in the back half of the description. The prior limits made
    // Agent 1 plan replies that contradicted established lore beyond 500 chars.
    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 2000)}`);
    if (char.personality) parts.push(`Personality: ${char.personality.substring(0, 1000)}`);
    if (char.scenario) parts.push(`Scenario: ${char.scenario.substring(0, 1000)}`);
    return parts.join('\n');
}

/**
 * B4 (token cut): a SHORT character brief for the agents that don't need the full card. The
 * Drafter (Agent 1) plans the reply and genuinely needs the full description/personality/scenario,
 * but the Scribe (Agent 3 — it extracts facts from the message text, not the card) barely uses
 * it. Sending the full ~4 KB card every turn was pure repeated input cost. This trims to the name + the FIRST ~400 chars
 * of the description (enough to anchor who {{char}} is) — typically ~10× smaller. Returns '' when no
 * character is selected, identical to getCharacterInfo().
 * @returns {string}
 */
function getCharacterInfoBrief() {
    const context = SillyTavern.getContext();
    const char = context?.characters?.[context?.characterId];
    if (!char) return '';
    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description.substring(0, 400)}`);
    return parts.join('\n');
}

/**
 * Get user persona info
 */
function getUserPersona() {
    const context = SillyTavern.getContext();
    return context.persona?.description || context.name1 || '';
}

// --- UI: Indicator ---

function showWorkingIndicator() {
    let indicator = document.getElementById('bf_mem_working_indicator');
    if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'bf_mem_working_indicator';
        indicator.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Memory Pipeline: preparing facts...';
        indicator.style.cssText = `
            display: flex; align-items: center; gap: 8px;
            padding: 10px 15px; margin: 5px 0;
            background: var(--SmartThemeBlurTintColor, #1a1a2e);
            border: 1px solid var(--SmartThemeBorderColor, #444);
            border-radius: 6px; color: #7bb3ff; font-size: 13px;
        `;
        const sendForm = document.getElementById('send_form');
        if (sendForm) {
            sendForm.parentNode.insertBefore(indicator, sendForm);
        }
    }
    indicator.style.display = 'flex';
}

function hideWorkingIndicator() {
    const indicator = document.getElementById('bf_mem_working_indicator');
    if (indicator) indicator.style.display = 'none';
}

/**
 * Cancel the in-flight pipeline run PROMPTLY (cancel fix). Sets pipelineCancelled (so the
 * pre-injection gate bails) AND aborts any in-flight agent LLM call via the llm-call cancel
 * hook, so a disabled/stopped run halts in moments instead of finishing ~75s later. Wired to:
 *   - the `enabled` toggle handler when toggled OFF (settings.js), and
 *   - the GENERATION_STOPPED event (Stop button).
 * Idempotent and safe to call when nothing is running.
 * @param {string} [reason='cancel'] - short reason tag for the debug log (e.g. 'disabled', 'stopped')
 */
export function cancelActiveRun(reason = 'cancel') {
    pipelineCancelled = true;
    pipelineJustInjected = false;
    runRecordedInput = false;
    // Truly abort in-flight agent calls — not just refuse to commit their results.
    try { cancelInFlightLLM(reason); } catch { /* best-effort */ }
    hideWorkingIndicator();
    updateStatus('idle');
    addDebugLog('info', `Active pipeline run cancelled (${reason}) — in-flight LLM calls aborted`, {
        subsystem: 'pipeline', event: 'pipeline.cancel', reason: reason.toUpperCase(),
    });
}

// --- Determine if this generation should trigger the pipeline ---

function shouldRunPipeline(data) {
    const settings = getSettings();
    if (!settings || !settings.enabled) {
        addDebugLog('debug', 'Skipping pipeline (disabled)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'DISABLED' });
        return false;
    }

    // Skip group chats: characterId in a group = active speaker, not addressee.
    // Writing facts to the speaker's attachments would cross-contaminate characters.
    // Group support is planned for a future release.
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) {
        addDebugLog('info', 'Skipping pipeline (group chat — not supported in this version)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'GROUP' });
        if (!groupSkipToastShown && typeof toastr !== 'undefined') {
            toastr.info('BF Memory: group chats not supported — memory pipeline disabled for this chat.', 'BF Memory', { timeOut: 6000 });
            groupSkipToastShown = true;
        }
        return false;
    }

    // Skip our own internal LLM calls (Agent 1, Agent 3, reflection). KEPT as a hard skip
    // (F-ORCH-2, deliberate choice): CHAT_COMPLETION_PROMPT_READY's payload is only
    // { chat, dryRun } — it carries NO quiet/type marker — so our own generateQuietPrompt
    // FALLBACK leg (llm-call.js priority 3) is indistinguishable from a genuine user turn
    // here, and the quiet/dryRun checks below can NOT catch it. Dropping this skip would let
    // the agents recurse off our own fallback call. The cost is softened instead: a genuine
    // user turn arriving during a background internal window now falls through to the cached
    // re-inject fallback in the event handlers (see initPipeline) rather than generating
    // with zero memory injection.
    if (isInternalCall()) {
        addDebugLog('debug', 'Skipping pipeline (internal agent call window open)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'INTERNAL' });
        return false;
    }

    // Skip dry runs, quiet generations (slash commands like /gen, /sys),
    // impersonations (when the user clicks the Impersonate button), and any
    // other non-genuine generation types. Without this, Quick Reply scripts
    // that call /gen would burn billable Agent 1 + Agent 3 LLM calls per fire.
    if (data?.dryRun) {
        addDebugLog('debug', 'Skipping pipeline (dry run)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'DRY' });
        return false;
    }
    if (data?.quiet) {
        addDebugLog('debug', 'Skipping pipeline (quiet generation)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'QUIET' });
        return false;
    }
    const generationType = data?.type || data?.generationType;
    if (generationType === 'quiet' || generationType === 'impersonate' || generationType === 'continue') {
        addDebugLog('info', `Skipping pipeline (generation type: ${generationType})`, { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'GEN_TYPE', data: { generationType } });
        return false;
    }

    // Compute lastUserMsgIndex first — needed to distinguish "real user send" from
    // "spurious chat-load event"
    const freshChat = SillyTavern.getContext().chat;
    if (!freshChat || freshChat.length === 0) return false;

    let lastUserMsgIndex = -1;
    for (let i = freshChat.length - 1; i >= 0; i--) {
        if (freshChat[i] && freshChat[i].is_user) {
            lastUserMsgIndex = i;
            break;
        }
    }

    if (lastUserMsgIndex < 0) return false;

    // Determine what Agent 3 *would* target this turn (last genuine AI message),
    // mirroring the loop in runPipelineInline. We gate on the per-message
    // bf_mem_processed flag rather than relying solely on the monotonic
    // lastTriggeredUserMsgIndex — that index only advances on a successful run and
    // never rewinds on swipe/regenerate, so once it raced ahead of reality every
    // later turn was silently skipped forever.
    const memoryTargetIndex = findMemoryTargetIndex(freshChat);

    // "Unprocessed work exists" = either the new user message or the AI target
    // still lacks bf_mem_processed. This is the source of truth for whether
    // Agent 3 has anything to do.
    const userUnprocessed = !freshChat[lastUserMsgIndex]?.extra?.bf_mem_processed;
    const targetUnprocessed = memoryTargetIndex >= 0 && !freshChat[memoryTargetIndex]?.extra?.bf_mem_processed;
    const hasUnprocessedWork = userUnprocessed || targetUnprocessed;

    // If a genuine NEW user message exists, fire regardless of cooldown.
    // The cooldown only protects against spurious chat-load events (no new user msg).
    const isNewUserMsg = lastUserMsgIndex > lastTriggeredUserMsgIndex;

    if (!isNewUserMsg && !hasUnprocessedWork) {
        if (Date.now() - chatChangedAt < 5000) {
            addDebugLog('info', 'Skipping pipeline (chat just loaded, cooldown, no new user msg)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'COOLDOWN', data: { msSinceChatChanged: Date.now() - chatChangedAt } });
        } else {
            addDebugLog('info', `Skipping pipeline (already processed for user msg index ${lastUserMsgIndex})`, { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'ALREADY_PROCESSED', data: { lastUserMsgIndex } });
        }
        return false;
    }

    // Cooldown only suppresses spurious chat-load events. If there's genuinely
    // unprocessed work but it's NOT a new user message (e.g. after a swipe reset
    // the index), still respect the load cooldown to avoid firing on chat open.
    if (!isNewUserMsg && hasUnprocessedWork && Date.now() - chatChangedAt < 5000) {
        addDebugLog('info', 'Skipping pipeline (chat just loaded, cooldown — deferring unprocessed work)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'COOLDOWN', data: { msSinceChatChanged: Date.now() - chatChangedAt } });
        return false;
    }

    // FIX #8a (swipe-only detection): a swipe/regenerate adds NO new user message — it only
    // re-rolls the existing last AI reply. MESSAGE_SWIPED clears that reply's bf_mem_processed
    // (so hasUnprocessedWork is true) AND rewinds lastTriggeredUserMsgIndex to the current last
    // user msg (so isNewUserMsg is false). Past the 5s chat-load cooldown this otherwise falls
    // through to a FULL run — re-running Agent 1 and building a NEW draft, which then steers the
    // re-roll with stale draft direction (violates the draft-less swipe re-inject intent). When
    // the unprocessed work is ONLY the AI target (no new user turn) and we have a cached injection
    // to serve, treat it as swipe-only and defer to the draft-less re-inject path (return false →
    // the CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_DATA swipe branch re-injects lastInjectionNoDraft).
    const haveCachedInjection = !!(lastInjectionNoDraft || lastInjection);
    if (!isNewUserMsg && hasUnprocessedWork && !userUnprocessed && targetUnprocessed && haveCachedInjection) {
        addDebugLog('info', 'Skipping pipeline (swipe/regen — deferring to draft-less re-inject of cached facts)', { subsystem: 'pipeline', event: 'pipeline.gate.skip', reason: 'SWIPE_REINJECT', data: { memoryTargetIndex, lastUserMsgIndex } });
        return false;
    }

    addDebugLog('debug', 'Pipeline gate passed', { subsystem: 'pipeline', event: 'pipeline.gate.pass', reason: 'OK', data: { isNewUserMsg, lastUserMsgIndex, memoryTargetIndex, hasUnprocessedWork } });
    return true;
}

/**
 * Find the index of the last genuine AI message Agent 3 would target.
 * Mirrors the scan in shouldRunPipeline so the gate and the run agree.
 * Returns -1 if none.
 *
 * @param {Array} chat
 * @param {boolean} [includeLast=false] - When false (PRE-generation, the historical
 *   behaviour) the scan starts at chat.length-2 because the last message is the
 *   just-sent USER message, not an AI reply. When true (POST-reply, the new Agent 3
 *   home on MESSAGE_RECEIVED) the scan starts at chat.length-1 so the just-received
 *   AI reply itself is the target — extracting the reply that just landed is exactly
 *   what we want now that Agent 3 runs after generation.
 */
function findMemoryTargetIndex(chat, includeLast = false) {
    if (!Array.isArray(chat)) return -1;
    for (let i = (includeLast ? chat.length - 1 : chat.length - 2); i >= 0; i--) {
        const msg = chat[i];
        if (!msg || msg.is_user || !msg.mes) continue;
        if (msg.is_system) continue;
        if (msg.extra?.type) continue;
        return i;
    }
    return -1;
}

// UNSORTED PRIMARY GUARANTEE (audit F-ARCH-2). Invariant: Unsorted competes under the budget;
// the newest/most salient few are guaranteed. This cap is how many of the top salience-ranked
// active Unsorted facts are guaranteed injection as `primary` each turn (recent pins stay
// visible); the REST are admitted as secondary only while the retrievalTokenBudget allows.
const UNSORTED_PRIMARY_CAP = 6;

// --- Core Pipeline Logic (runs inline, blocks generation) ---

async function runPipelineInline(data) {
    const settings = getSettings();
    // Capture-at-write: pin the active profile at pipeline start. Agent 3 (memory
    // extraction) now runs POST-reply on MESSAGE_RECEIVED, but the reflection arming
    // below still captures-at-write the profile this pipeline was reading from.
    const capturedDbProfile = settings?.activeDbProfile;
    // Also capture the character's avatar — used by the scene/next-hint writes and
    // the reflection arming so a mid-run character switch can't contaminate the wrong
    // character's attachments (database.js keys storage on the LIVE characterId/avatar).
    const capturedCharAvatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || '';
    pipelineCancelled = false; // fresh run, start uncancelled
    const context = SillyTavern.getContext();
    const chat = context.chat;
    const charName = context.characters?.[context.characterId]?.name || '(unknown)';
    const characterInfo = getCharacterInfo();
    const userPersona = getUserPersona();

    // Mark which user message triggered this
    let lastUserMsgIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) {
            lastUserMsgIndex = i;
            break;
        }
    }
    lastTriggeredUserMsgIndex = lastUserMsgIndex;

    const startTime = Date.now();
    // PER-STAGE TIMING (observability only — no behavior change). Wall-clock deltas measured
    // around each existing await on the blocking path, collected here and attached to the
    // run.summary `stages` blob + a single `pipeline.timing` debug line so the next exported
    // log pinpoints which stage regressed. Stages that don't run this turn stay null.
    const stageMs = {
        agent1Ms: null,                 // Agent 1 draft + speculative retrieval (parallel) wall-clock
        speculativeRetrievalMs: null,   // covered by the agent1 parallel block; recorded for clarity
        deterministicMs: null,          // deterministic-retrieval build
        sceneBuildMs: null,             // scene/big-picture block build
        injectMs: null,                 // buildWriterInjection + injectMemoryContext + token recount
    };
    // FIX #10: short per-run id to group this run's log entries + the SUMMARY line.
    const runId = `R${startTime.toString(36).slice(-5)}`;
    // Debug-log redesign §2: set the ambient run id so leaf logs (retrieval/db) auto-tag with
    // this turn's runId without signature churn. ARM a pendingRun so the post-reply
    // (MESSAGE_RECEIVED) extraction + reflection reuse THIS id instead of minting a fresh `M…`,
    // keeping a turn's pre-reply and post-reply events under ONE run. endRun() clears the
    // ambient id at every return path below.
    beginRun(runId);
    setPendingRun({ runId, startTime });
    const recentMessages = getRecentMessages(settings.agent1ContextMessages || 5);
    if (recentMessages.length === 0) {
        addDebugLog('info', 'No messages in chat, skipping pipeline');
        endRun();
        return;
    }

    addDebugLog('info', `--- Pipeline inline start (char: ${charName}, msgs: ${recentMessages.length}) ---`);
    for (let i = 0; i < recentMessages.length; i++) {
        const msg = recentMessages[i];
        const role = msg.is_user ? 'USER' : 'AI';
        addDebugLog('info', `  [${i + 1}/${recentMessages.length}] ${role}: ${String(msg.mes || '').substring(0, 120)}`);
    }

    showWorkingIndicator();
    updateStatus('running', 'Preparing facts...');

    // NOTE: memory-extraction target selection (findMemoryTargetIndex) now lives in
    // runMemoryExtraction() on the post-reply path — the blocking path no longer needs
    // it because Agent 3 doesn't run here anymore.

    const formattedChat = formatMessagesForDraft(recentMessages);

    // --- Run Agent 1 + Speculative Retrieval in PARALLEL (NOT Agent 3) ---
    // Phase 3b: Agent 3 (memory extraction about the PREVIOUS exchange) was MOVED OFF
    // this latency-critical pre-generation path. It now runs POST-reply on
    // MESSAGE_RECEIVED (runMemoryExtraction), so the user no longer waits for
    // fact-extraction-about-the-last-turn before THIS reply generates. Only the work
    // that feeds THIS reply stays here: Agent 1 (draft/menu) + speculative retrieval.
    // SAFETY: We use CMRS (ConnectionManagerRequestService) to call the agent profile
    // directly by ID, WITHOUT switching the active UI profile. This is safe during
    // mid-generation because it doesn't touch the DOM or active connection state.
    updateStatus('running', 'Drafting...');
    addDebugLog('info', 'Running Agent 1 (draft) + speculative retrieval in parallel (Agent 3 deferred to post-reply)...');

    const agent1ProfileId = getAgent1ProfileId(settings);
    if (agent1ProfileId) {
        addDebugLog('info', `Profiles: Agent 1 = "${agent1ProfileId || 'default'}"`);
    } else {
        addDebugLog('info', 'No Agent 1 profile configured, agent will use current connection');
    }

    let draftResult = null;
    let speculativeRetrieval = null;

    // Start speculative fact retrieval using context keywords (no LLM needed)
    const contextKeywords = extractContextKeywords(recentMessages);
    addDebugLog('info', `Speculative retrieval keywords: ${contextKeywords.join(', ')}`);

    // Load databases once up front — reused for Agent 1's fact inventory/menu and the
    // deterministic retrieval. (Agent 3's existing-DB context now loads separately on the
    // post-reply extraction path.)
    const databases = await getAllDatabases();
    // Per-turn in-memory fact index (memoized; built once, reused by the menu + Unsorted
    // collect below so neither walks the full fact set).
    const index = await getMemoryIndex();
    // The Finder (Agent 4 / Stage-2 LLM) was retired in v0.50.x: it was a per-turn LLM call that
    // only re-ranked facts the deterministic + semantic + anchor stack already retrieved, blew its
    // latency budget at any real store size, and added no recall. Retrieval is now always the
    // deterministic path (buildDeterministicRetrieval below) + guaranteed anchors.
    // MEMORY MODE (tool-first redesign): 'hybrid' (default) and 'tool-only' DROP the blocking Agent 1
    // (Draft) LLM call from the reply-critical path — the main model (e.g. Claude via the Claude Code
    // CLI connection profile) pulls deeper memory on demand through the search_memory tool, so the
    // reply only needs a cheap, no-LLM anchor (speculative facts + present-character anchors + the
    // scene block). 'push' preserves classic behavior: Agent 1 drafts the reply + picks branches.
    const memoryMode = (settings.memoryMode === 'push' || settings.memoryMode === 'tool-only')
        ? settings.memoryMode : 'hybrid';
    const runAgent1 = memoryMode === 'push';
    // PROFILE-AWARE detection (tool-first), once per session: log whether the active connection
    // profile is the tuned Claude/Anthropic tool-calling path — so if hybrid/tool-only recall isn't
    // firing, the Debug log explains why (the tools only activate on a tool-calling main model).
    if (!profileDetectionLogged) {
        profileDetectionLogged = true;
        try { detectProfileForToolFirst(settings); } catch { /* detection is best-effort */ }
    }
    // Agent 1's fact inventory + Stage-1 menu are consumed ONLY by the Draft prompt (and the
    // deterministic retrieval's delta keywords come from Agent 1's neededFacts). In hybrid/tool-only
    // mode Agent 1 never runs, so skip building them — that also avoids a full-store key walk
    // (summarizeKeys) and a menu aggregate every turn.
    const factInventory = runAgent1 ? summarizeKeys(databases) : '';
    // STAGE 1 menu: compact Category×aspect map (counts, NO values) Agent 1 picks branches from.
    // Counts come from the index aggregate, not a full-fact walk. Built only when Agent 1 runs.
    const factMenu = runAgent1 ? summarizeMenuIndexed(index) : '';
    addDebugLog('info', `Memory mode: ${memoryMode}${runAgent1 ? '' : ' — Agent 1 Draft skipped (tool-driven recall)'}`);
    addDebugLog('info', `Fact inventory for Agent 1: ${factInventory ? factInventory.split('\n').length + ' keys' : 'empty'}; menu: ${factMenu ? factMenu.split('\n').length + ' categories' : 'empty'}`);

    const agent1Start = Date.now();
    try {
        internalCallDepth++; // F-ORCH-2: ref-counted internal window (paired with the finally below)
        const promises = [];

        // Agent 1: Draft + STAGE 1 menu picker (returns #Branches) — PUSH mode only. In hybrid/
        // tool-only mode we SKIP this blocking Draft LLM call entirely (the latency win) and let
        // the main model drive recall on demand via search_memory; promise resolves to null so the
        // empty-draft path below seeds a no-LLM anchor.
        if (runAgent1) {
            promises.push(
                runDraftAgent(formattedChat, characterInfo, userPersona, agent1ProfileId, factInventory, factMenu)
                    .catch(err => ({ draft: '', branches: [], neededFacts: [], raw: '', error: err.message })),
            );
        } else {
            promises.push(Promise.resolve(null));
        }

        // Speculative retrieval: start fact lookup with context keywords NOW (no LLM wait)
        promises.push(
            retrieveFacts(contextKeywords, [])
                .catch(err => { addDebugLog('info', `Speculative retrieval failed: ${err.message}`); return null; }),
        );

        [draftResult, speculativeRetrieval] = await Promise.all(promises);
        // Agent 1 (when run) + speculative retrieval run in PARALLEL (single Promise.all), so the
        // reply waited the wall-clock of the slower of the two. Record that shared parallel
        // wall-clock for both. In hybrid/tool-only mode Agent 1 is skipped, so this measures just
        // the speculative-retrieval time — the dropped Draft LLM call is the latency win.
        stageMs.agent1Ms = Date.now() - agent1Start;
        stageMs.speculativeRetrievalMs = stageMs.agent1Ms;
    } catch (error) {
        addDebugLog('fail', `Pipeline exception: ${error.message}`);
        hideWorkingIndicator();
        updateStatus('error', 'Pipeline failed');
        endRun(); // clear ambient run id on the abnormal exit
        return;
    } finally {
        // F-ORCH-2: decrement (never assign false) — another flow may still hold the window.
        // Clamped at 0 because CHAT_CHANGED force-resets the count mid-flight.
        internalCallDepth = Math.max(0, internalCallDepth - 1);
    }

    // --- Agent 3 (memory extraction) is no longer processed here ---
    // It was moved to runMemoryExtraction() on the MESSAGE_RECEIVED path (Phase 3b),
    // so all of its commit logic (Last Generated/Inserted, bf_mem_processed marking,
    // capture-at-write profile save, review popup, character-changed guard) now lives
    // there. The blocking path only feeds THIS reply.

    // --- Process Agent 1 results + merge with speculative retrieval ---
    // GRACEFUL DEGRADATION: if Agent 1 errored (e.g. provider returned empty completion
    // even after retry), don't abort the whole pipeline — the writer can still inject
    // the retrieved facts with no draft. Memory > nothing.
    if (!runAgent1) {
        // HYBRID / TOOL-ONLY: Agent 1 was intentionally not run. Seed an empty draft shape (no
        // "what happens next" direction — the main model writes freely) and derive `focus` from the
        // current scene's present characters so the guaranteed present-character anchors below still
        // fire (cheap, no LLM). Everything deeper is pulled by the model via search_memory.
        let scenePresent = [];
        try {
            const s = getScene();
            scenePresent = Array.isArray(s?.present) ? s.present.map(x => String(x ?? '').trim()).filter(Boolean) : [];
        } catch { scenePresent = []; }
        // FOCUS FALLBACK (honest about the limit): without Agent 1 there is no fresh #SCENE parse, so
        // getScene().present is whatever a PRIOR push-mode turn (or none) left — it can be stale or
        // empty and will miss a newly-arrived character. This is a best-effort floor, NOT a guarantee:
        // when no present list is available we fall back to the active character (always "present" in
        // a 1:1 RP) so at least the lead's identity anchors still fire. The main model covers any gap
        // by pulling via search_memory. Full present-character tracking needs a scene extractor
        // (push mode, or a future cheap parser).
        const focusList = scenePresent.length
            ? scenePresent
            : (charName && charName !== '(unknown)' ? [charName] : []);
        draftResult = { draft: '', branches: [], focus: focusList, neededFacts: [], nextHint: [], scene: null, raw: '' };
        addDebugLog('info', `Hybrid mode: skipped Agent 1 Draft LLM call — anchoring on speculative facts${focusList.length ? ` + anchors for (${focusList.join(', ')})${scenePresent.length ? '' : ' [active-char fallback; scene not parsed in hybrid]'}` : ''}; main model recalls via search_memory`, {
            subsystem: 'agent1', event: 'agent1.run', reason: 'SKIPPED_HYBRID',
            data: { agent: 'agent1', mode: memoryMode, skipped: true, focus: focusList, sceneStale: !scenePresent.length },
        });
    } else if (!draftResult || draftResult.error) {
        addDebugLog('fail', `Agent 1 error: ${draftResult?.error || 'no result'} — continuing with facts only (no draft)`, {
            subsystem: 'agent1', event: 'agent1.run', reason: 'ERROR',
            data: { agent: 'agent1', profileId: agent1ProfileId || null, success: false, error: draftResult?.error || 'no result', durationMs: Date.now() - agent1Start },
        });
        draftResult = { draft: '', branches: [], focus: [], neededFacts: [], scene: null, raw: '' };
    } else {
        addDebugLog('debug', `Agent 1 run ok (${Date.now() - agent1Start}ms)`, {
            subsystem: 'agent1', event: 'agent1.run',
            data: {
                agent: 'agent1', profileId: agent1ProfileId || null, success: true,
                durationMs: Date.now() - agent1Start,
                tokensIn: draftResult.tokensIn ?? null, tokensOut: draftResult.tokensOut ?? null,
                branchCount: Array.isArray(draftResult.branches) ? draftResult.branches.length : 0,
            },
        });
    }
    // Older Agent 1 result shapes (or partial parses) may lack branches/focus/neededFacts/nextHint.
    if (!Array.isArray(draftResult.branches)) draftResult.branches = [];
    if (!Array.isArray(draftResult.focus)) draftResult.focus = [];
    if (!Array.isArray(draftResult.neededFacts)) draftResult.neededFacts = [];
    if (!Array.isArray(draftResult.nextHint)) draftResult.nextHint = [];

    addDebugLog('info', `Agent 1 done: "${draftResult.draft.substring(0, 80)}..."`);
    addDebugLog('info', `Branches picked: ${draftResult.branches.join('; ') || '(none)'}`);
    addDebugLog('info', `Focus character(s): ${draftResult.focus.join(', ') || '(none — general moment)'}`);
    addDebugLog('info', `Needed facts (fallback): ${draftResult.neededFacts.join('; ')}`);

    // --- Scene card: persist Agent 1's #SCENE parse (no extra LLM call) ---
    // Only when enabled, the run wasn't cancelled, and the character didn't change
    // mid-run (same guard class as Agent 3 writes — scene is per-chat/character state).
    if (settings.sceneCardEnabled && !pipelineCancelled && draftResult.scene) {
        const currentCharAvatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || '';
        if (currentCharAvatar === capturedCharAvatar) {
            setScene(draftResult.scene, runId);
            const sc = getScene();
            if (sc) {
                addDebugLog('info', `Scene updated: loc="${sc.location}" present=[${(sc.present || []).join(', ')}] goals=${(sc.goals || []).length} beats=${(sc.beats || []).length}`);
            }
        } else {
            addDebugLog('info', 'Scene update skipped (character changed mid-pipeline)');
        }
    }

    // --- Next-scene fact hint (refinement #11): backstage breadcrumb only ---
    // Agent 1 optionally emits #NextHint (topics likely relevant NEXT scene). We stash it
    // on the triggering USER message's extra (bf_mem_next_hint) — NOT in any visible reply
    // text, NOT injected into the writer. It's a future-use breadcrumb. Same guards as the
    // scene write: only when not cancelled and the character didn't change mid-run.
    if (!pipelineCancelled && draftResult.nextHint.length > 0 && lastUserMsgIndex >= 0 && chat[lastUserMsgIndex]) {
        const currentCharAvatar = SillyTavern.getContext().characters?.[SillyTavern.getContext().characterId]?.avatar || '';
        if (currentCharAvatar === capturedCharAvatar) {
            const hint = draftResult.nextHint.slice(0, 5);
            chat[lastUserMsgIndex].extra = { ...(chat[lastUserMsgIndex].extra || {}), bf_mem_next_hint: hint };
            SillyTavern.getContext().saveChatDebounced?.();
            addDebugLog('info', `Next-scene hint stored on msg ${lastUserMsgIndex} (backstage): ${hint.join('; ')}`);
        }
    }

    // --- Fact Retrieval: deterministic (no LLM) ---
    updateStatus('running', 'Selecting facts...');

    // DETERMINISTIC retrieval builder. Reuses the existing speculative + delta-keyword
    // merge, and folds in the active Unsorted facts under the token budget (top few
    // guaranteed) so the catch-all stays represented without growing the injection unbounded.
    const buildDeterministicRetrieval = async () => {
        const speculativeKeywordSet = new Set(contextKeywords.map(k => k.toLowerCase()));
        const deltaKeywords = draftResult.neededFacts.filter(k => !speculativeKeywordSet.has(k.toLowerCase()));
        const det = speculativeRetrieval || { facts: [], formatted: '', stats: { primary: 0, secondary: 0, tertiary: 0 } };
        if (deltaKeywords.length > 0) {
            addDebugLog('info', `Delta retrieval for Agent 1 keywords: ${deltaKeywords.join(', ')}`);
            const deltaRetrieval = await retrieveFacts(deltaKeywords, []);
            const existingKeys = new Set(det.facts.map(r => `${r.category}:${r.fact.key}`));
            for (const fact of deltaRetrieval.facts) {
                const id = `${fact.category}:${fact.fact.key}`;
                if (!existingKeys.has(id)) { det.facts.push(fact); existingKeys.add(id); }
            }
        } else {
            addDebugLog('info', 'No delta keywords needed — speculative retrieval covered everything');
        }
        // UNSORTED ADMISSION (audit F-ARCH-2). Invariant: Unsorted competes under the budget;
        // the newest/most salient few are guaranteed. The old path injected EVERY active
        // Unsorted fact as un-budgeted primary, so model-pinned facts (remember_fact defaults
        // to Unsorted) re-injected on every future turn and prompts grew monotonically. Now:
        // rank by the SAME deterministic retrievalSalience the overflow tiers use, guarantee
        // the top UNSORTED_PRIMARY_CAP as primary (recent pins stay visible), and admit the
        // REST as secondary only while the retrievalTokenBudget allows — mirroring
        // retrieveFacts' admitTier token accounting, re-applied here because this append runs
        // AFTER retrieveFacts returned (a bare tier label alone would bypass the budget).
        const existingKeys = new Set(det.facts.map(r => `${r.category}:${r.fact.key}`));
        const unsorted = [];
        for (const { fact, category } of collectBranchFactsIndexed(index, ['Unsorted'])) {
            const id = `${category}:${fact.key}`;
            if (!existingKeys.has(id) && isFactVisible(fact)) {
                unsorted.push({ fact, category, tier: 'secondary' });
                existingKeys.add(id);
            }
        }
        const now = Date.now();
        unsorted.sort((a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now));
        for (const r of unsorted.slice(0, UNSORTED_PRIMARY_CAP)) {
            r.tier = 'primary';
            det.facts.push(r);
        }
        // Overflow: charge everything already chosen (retrieved + guaranteed Unsorted) against
        // the shared budget first, then admit ranked Unsorted overflow while it fits.
        const unsortedBudget = Number(settings.retrievalTokenBudget) || 800;
        let unsortedUsedTokens = det.facts.reduce((sum, r) => sum + estimateInjectionTokens(r), 0);
        let unsortedAdmitted = 0, unsortedDropped = 0;
        for (const r of unsorted.slice(UNSORTED_PRIMARY_CAP)) {
            const cost = estimateInjectionTokens(r);
            if (unsortedUsedTokens + cost > unsortedBudget) { unsortedDropped++; continue; }
            det.facts.push(r);
            unsortedUsedTokens += cost;
            unsortedAdmitted++;
        }
        if (unsorted.length > 0) {
            addDebugLog('info', `Unsorted admission: ${Math.min(unsorted.length, UNSORTED_PRIMARY_CAP)} guaranteed primary, ${unsortedAdmitted} budget-admitted secondary, ${unsortedDropped} dropped over budget (${unsortedUsedTokens}/${unsortedBudget} tokens)`, {
                subsystem: 'retrieval', event: 'retrieval.unsorted',
                data: { total: unsorted.length, guaranteed: Math.min(unsorted.length, UNSORTED_PRIMARY_CAP), admitted: unsortedAdmitted, dropped: unsortedDropped, usedTokens: unsortedUsedTokens, budget: unsortedBudget },
            });
        }
        det.stats = {
            primary: det.facts.filter(r => r.tier === 'primary').length,
            secondary: det.facts.filter(r => r.tier === 'secondary').length,
            tertiary: det.facts.filter(r => r.tier === 'tertiary').length,
        };
        // Format via the SHARED formatter (formatChosenFacts) instead of a hand-rolled copy.
        // The old inline version drifted: it dropped a moment's `tone` (and any temporal tail)
        // that formatChosenFacts/formatFactsForWriter include. Reusing the shared formatter keeps
        // this path identical to the anchor path (which also uses formatChosenFacts) — single
        // source of truth, no drift.
        det.formatted = formatChosenFacts(det.facts);
        return det;
    };

    const detStart = Date.now();
    const retrieval = await buildDeterministicRetrieval();
    stageMs.deterministicMs = Date.now() - detStart; // observability: retrieval build wall-clock

    // GUARANTEED PRESENT-CHARACTER ANCHORS (injection composition fix). Ensure each in-focus
    // character's key anchors (identity / current-state / active relationship) are present even
    // if retrieval missed them — a Writer that forgets a present character's name or relationship
    // breaks continuity. Pulled deterministically from the bySubject index (no LLM, cheap) and
    // merged in WITHOUT removing any chosen fact; only NEW anchors are appended.
    if (settings.finderAnchorsPerCharacter > 0 && Array.isArray(draftResult.focus) && draftResult.focus.length) {
        const chosenIds = new Set(retrieval.facts.map(({ fact, category }) => `${String(category).toLowerCase()}:${String(fact.key).toLowerCase()}`));
        const anchors = collectAnchorFacts(index, draftResult.focus, settings.finderAnchorsPerCharacter, chosenIds);
        if (anchors.length) {
            retrieval.facts = retrieval.facts.concat(anchors);
            retrieval.stats = {
                ...retrieval.stats,
                primary: (retrieval.stats.primary || 0) + anchors.length,
            };
            // Re-render the formatted block from the merged set so the injected anchors actually
            // reach the Writer (the formatted string, not just the facts array, is what's injected).
            retrieval.formatted = formatChosenFacts(retrieval.facts);
            addDebugLog('info', `Injected ${anchors.length} guaranteed present-character anchor fact(s) (focus: ${draftResult.focus.join(', ')})`, {
                subsystem: 'finder', event: 'finder.anchors',
                data: { added: anchors.length, perCharacter: settings.finderAnchorsPerCharacter, focus: draftResult.focus, totalAfter: retrieval.facts.length },
            });
        }
    }

    addDebugLog('info', `Retrieved ${retrieval.stats.primary}P/${retrieval.stats.secondary}S/${retrieval.stats.tertiary}T facts`);

    // --- Build & Inject ---
    // We compute the baseline input (pre-injection) up front so token metrics can be
    // recorded even when the run is cancelled before injection — the agent LLM calls
    // already happened and incurred real cost, so they must still be attributed.
    const baselineArr = data.chat || data.messages;
    let baselineInput = 0;
    try { baselineInput = await countChatTokens(baselineArr); } catch { baselineInput = 0; }

    // CANCEL / DISABLE GATE (checked right BEFORE injecting). Bail if the run was cancelled
    // (Stop button → GENERATION_STOPPED, or a mid-run disable via cancelActiveRun set
    // pipelineCancelled) OR if the user toggled the extension OFF mid-run (re-read live settings
    // — the toggle only flips the boolean, so a disable that didn't route through cancelActiveRun
    // is still honored here). Either way we skip injection so a disabled/stopped run can't inject.
    const liveSettings = getSettings();
    const disabledMidRun = !liveSettings || !liveSettings.enabled;
    if (pipelineCancelled || disabledMidRun) {
        addDebugLog('info', `Pipeline ${pipelineCancelled ? 'cancelled' : 'disabled mid-run'} — skipping injection`, {
            subsystem: 'pipeline', event: 'pipeline.cancel', reason: pipelineCancelled ? 'CANCELLED' : 'DISABLED_MIDRUN', data: { runId },
        });
        // Still record the agent token cost (input == baseline since we didn't inject)
        // so the Tokens tab stays in sync and the per-cycle main-output gate is armed.
        // Agent 3 no longer runs here, so memoryResult is null on the blocking path —
        // its tokens are recorded separately via addAgent3Tokens on MESSAGE_RECEIVED.
        recordRunTokens({ baselineInput, actualInput: baselineInput, draftResult, memoryResult: null });
        logRunSummary({ runId, startTime, baselineInput, actualInput: baselineInput, draftResult, memoryResult: null, cancelled: true, stages: stageMs, agent1Skipped: !runAgent1 });
        hideWorkingIndicator();
        updateStatus('idle');
        // Cancelled inline: no post-reply work will run for this turn — disarm + clear ambient.
        setPendingRun(null);
        endRun();
        return;
    }
    // Always-on scene block: injected EVERY turn (above the facts) whenever enabled
    // and a scene exists — independent of whether any facts were retrieved.
    const sceneBuildStart = Date.now(); // observability: scene + big-picture block build wall-clock
    let sceneBlock = '';
    const scene = getScene();
    if (settings.sceneCardEnabled) {
        sceneBlock = buildSceneBlock(scene, settings.sceneCardMaxTokens || 150);
        if (sceneBlock) addDebugLog('info', `Scene block injected (${sceneBlock.length} chars): ${sceneBlock}`);
    }

    // NOTE: the reflection "story so far" summary is NOT injected on its own (refinement #1).
    // The ONLY way the story/shelf summaries reach the writer is the OPT-IN summary pyramid
    // "Big Picture" block below — DEFAULT OFF. When off, the writer receives only the scene
    // sheet + chosen facts + Agent 1's draft, byte-identical to before. reflectionInject stays
    // inert for back-compat (default false).

    // OPTIONAL "Big Picture" overview (summary pyramid). Default OFF (enableSummaryPyramid).
    // When ON, prepend a compact, token-capped block = story summary + scene-relevant shelf
    // summaries ABOVE the scene block (the cheapest zoom-out; the writer drills in via the
    // search_memory recall tool). Combined into the same `sceneBlock` slot of buildWriterInjection
    // (which already sits above the fact list). When OFF, sceneBlock is untouched.
    let bigPictureBlock = '';
    if (settings.enableSummaryPyramid === true) {
        try {
            const pyramid = getSummaryPyramid();
            const bp = buildBigPictureBlock(pyramid, scene, settings.summaryPyramidMaxTokens || 250);
            bigPictureBlock = bp.block || '';
            if (bigPictureBlock) {
                addDebugLog('debug', `[${runId}] Big Picture block injected (${bigPictureBlock.length} chars, ${bp.shelvesIncluded.length} shelf summaries)`, {
                    subsystem: 'writer', event: 'summary.injected',
                    data: { chars: bigPictureBlock.length, approxTokens: Math.ceil(bigPictureBlock.length / 4), shelves: bp.shelvesIncluded },
                });
            }
        } catch (err) {
            addDebugLog('fail', `[${runId}] Big Picture injection failed (non-fatal): ${err.message || err}`, { subsystem: 'writer', event: 'summary.injected', reason: 'ERROR' });
        }
    }
    // MOMENT ECHO (Resonance Part B). Default OFF (enableMomentEcho). When ON, on the rare turn a
    // couple's present moment echoes an earlier beat, surface ONE tiny `[Echo: …]` line — a single
    // resonant past moment for the PAIR present, cued by a reflection-authored callback that pays
    // off in the present context or the most-recent charged moment for that pair (NEVER shared
    // place). Capped at one, token-clamped; emits nothing on most turns. The full relationship
    // thread stays PULL-ONLY (Build 1). When OFF, momentEchoBlock is '' → overviewBlock unchanged
    // (byte-identical to before). Built from the SAME turn-stable scene + facts, so the draft-less
    // swipe cache below reuses the identical echo (no drift on re-roll).
    let momentEchoBlock = '';
    if (settings.enableMomentEcho === true) {
        try {
            // CUE = the present PAIR (exactly two distinct characters). Only fetch the thread when a
            // pair exists — most turns short-circuit here with zero work.
            const present = (scene && Array.isArray(scene.present))
                ? scene.present.map(x => String(x ?? '').trim()).filter(Boolean) : [];
            const distinct = Array.from(new Set(present.map(p => p.toLowerCase())));
            if (distinct.length === 2) {
                const thread = getRelationshipMomentThread(databases, present[0], present[1]);
                // Facts ALREADY injected this turn (category::key) so an echo never duplicates one.
                const injectedKeys = new Set((retrieval.facts || []).map(({ fact, category }) => `${category}::${fact.key}`));
                const echo = buildMomentEchoBlock(scene, thread, injectedKeys, settings.momentEchoMaxTokens || 40);
                momentEchoBlock = echo.block || '';
                if (echo.fired) {
                    addDebugLog('debug', `[${runId}] Moment echo fired (${echo.cue} cue): ${echo.block}`, {
                        subsystem: 'writer', event: 'echo.fired',
                        data: { cue: echo.cue, pair: echo.pair, key: echo.fact?.key, sceneNo: echo.fact?.sceneNo ?? null, chars: momentEchoBlock.length },
                    });
                }
            }
        } catch (err) {
            addDebugLog('fail', `[${runId}] Moment echo injection failed (non-fatal): ${err.message || err}`, { subsystem: 'writer', event: 'echo.fired', reason: 'ERROR' });
        }
    }

    // Stack the Big Picture + moment echo above the scene block (all live in the pre-facts slot).
    const overviewBlock = [bigPictureBlock, momentEchoBlock, sceneBlock].filter(Boolean).join('\n\n');
    stageMs.sceneBuildMs = Date.now() - sceneBuildStart;

    // injectMs spans the writer-injection build + the actual injectMemoryContext + the
    // post-inject token recount (the remaining synchronous-ish blocking work before generate).
    const injectStart = Date.now();
    const injection = buildWriterInjection(draftResult.draft, retrieval.formatted, overviewBlock);
    lastInjection = injection; // Used for THIS first generation only.
    // FIX #8a: cache a draft-less variant for swipes/regens. Same scene + facts (those are
    // turn-stable and safe to reuse), but pass an empty draft so the stale "what happens
    // next" direction can't mis-steer a divergent re-roll. buildWriterInjection renders an
    // empty draft as "(no direction)" inside the #Scene Direction slot — a neutral
    // placeholder that doesn't push the re-roll toward the original swipe's planned beat.
    lastInjectionNoDraft = buildWriterInjection('', retrieval.formatted, overviewBlock);

    // Optional: trim main-model chat history to last N messages — relies on facts to
    // replace older context. Default 0 = don't trim (main model sees full chat as usual).
    // Setting > 0 hides older messages so the model focuses on recent exchange + facts.
    const agent2Limit = Math.max(0, settings.agent2ContextMessages || 0);
    addDebugLog('info', `Injection ready (${injection.length} chars${agent2Limit ? `, trimming chat to last ${agent2Limit}` : ''}) in ${Date.now() - startTime}ms`);

    const success = injectMemoryContext(data, injection, { trimToLast: agent2Limit });

    // Token comparison: main-model input AFTER trim+inject.
    // PERF (fix): avoid tokenizing the WHOLE chat a SECOND time. On the common path
    // (agent2Limit == 0, no trim) the post-injection array differs from baseline by
    // exactly ONE inserted system message (the injection) — so actualInput is just
    // baselineInput + the injection's token cost. We tokenize only that single message
    // instead of the entire (potentially million-message) chat again. This keeps the
    // Tokens-tab "actualIn" meaning intact (still baseline + injected context), measured
    // with the same tokenizer; it's a hair approximate only in that it omits any
    // chat-completion array-framing delta from inserting one message, which is negligible.
    // When trimming IS active (agent2Limit > 0) the array changes structurally (messages
    // removed), so we fall back to a full recount to keep the number faithful.
    let actualInput = baselineInput;
    if (success && agent2Limit === 0) {
        try {
            const injTokens = await countChatTokens([{ role: 'system', content: injection }]);
            actualInput = baselineInput + injTokens;
        } catch { actualInput = baselineInput; }
    } else {
        const actualArr = data.chat || data.messages;
        try { actualInput = await countChatTokens(actualArr); } catch { actualInput = baselineInput; }
    }
    stageMs.injectMs = Date.now() - injectStart;

    // Record token metrics for the Tokens tab. Agent 3 no longer runs on this path
    // (memoryResult: null) — its tokens are folded in later via addAgent3Tokens on
    // the MESSAGE_RECEIVED path, which updates lastRunTokens.agent3* without bumping
    // the run count or re-counting input.
    recordRunTokens({ baselineInput, actualInput, draftResult, memoryResult: null });
    // FIX #10: consolidated per-run summary (after token recording — values in scope).
    // Thread the per-stage breakdown so ONE summary line carries the full timing picture.
    logRunSummary({ runId, startTime, baselineInput, actualInput, draftResult, memoryResult: null, cancelled: false, stages: stageMs, agent1Skipped: !runAgent1 });

    // OBSERVABILITY: one concise per-stage timing line (debug level) for the slowness hunt.
    // Pure log — emitting it changes no state and runs after the blocking work is recorded.
    const blockingTotalMs = Date.now() - startTime;
    addDebugLog('debug',
        `[${runId}] Stage timing: agent1=${stageMs.agent1Ms ?? '-'}ms ` +
        `det=${stageMs.deterministicMs ?? '-'}ms scene=${stageMs.sceneBuildMs ?? '-'}ms ` +
        `inject=${stageMs.injectMs ?? '-'}ms total=${blockingTotalMs}ms`,
        { runId, subsystem: 'pipeline', event: 'pipeline.timing', data: { phase: 'blocking', ...stageMs, totalMs: blockingTotalMs } },
    );

    if (success) {
        addDebugLog('pass', 'Memory context injected into prompt');
        pipelineJustInjected = true; // prevent double-injection on second event fire
        // A2/B5: a FULL run just refreshed the cached injection — reset the freeze window so the
        // next injectionFreezeTurns turns may reuse THIS fresh block before the agents run again.
        turnsSinceFullInjection = 0;
        // USE-IT-OR-LOSE-IT: this is the SINGLE commit point — these exact facts were injected
        // into the Writer's context, so they've earned strengthening. Stage them (by
        // identity-stable category:key) in the use buffer; the next post-reply extraction save
        // drains it onto the freshly-loaded fact objects, so the bumps ride that existing save
        // with NO extra per-turn write. (retrieval.facts are the chosen {fact, category} refs
        // for every path: deterministic + speculative + anchors.) Thread the run id so the
        // strengthening log groups under this turn.
        markFactsUsed(retrieval.facts);
        // A4 — Injection Viewer: surface WHAT the Writer was given this turn + a rough token cost
        // (chars/4 of the injection block). Best-effort, off the critical path (injection already
        // happened), fully swallowed so the viewer can never affect generation.
        try { setLastInjection(retrieval.facts, Math.ceil((injection?.length || 0) / 4)); } catch { /* viewer best-effort */ }
    } else {
        addDebugLog('fail', 'Failed to inject memory context');
    }

    // --- Reflection / consolidation trigger (cost-aware, off the latency-critical path) ---
    // Count this as a successful run and, on hitting the interval, ARM a reflection pass to
    // run AFTER the reply lands (MESSAGE_RECEIVED). We never run it inline here — it would
    // add a second LLM call to the pre-generation blocking path. Gated by enable; the
    // not-cancelled/not-group/not-internal checks already gate this whole function.
    if (settings.reflectionEnabled) {
        successfulRunsSinceReflection++;
        const interval = Math.max(4, settings.reflectionInterval || 12);
        if (successfulRunsSinceReflection >= interval && !reflectionPending && !reflectionInFlight) {
            reflectionPending = { runId, charAvatar: capturedCharAvatar, profileId: getAgent3ProfileId(settings), characterInfo, userPersona };
            addDebugLog('info', `[${runId}] Reflection armed (will run after reply; ${successfulRunsSinceReflection}/${interval} runs)`);
        }
    }

    hideWorkingIndicator();
    updateStatus('running', 'Generating with facts...');
    // Inline logging window is done. Clear the ambient run id so any unrelated logs that fire
    // before the reply lands don't mis-tag; the armed pendingRun (set at run start) bridges the
    // runId to the post-reply MESSAGE_RECEIVED path (Agent 3 extraction + reflection re-bind it).
    endRun();
}

/**
 * Agent 3 (memory extraction), Phase 3b — runs POST-reply on MESSAGE_RECEIVED, OFF the
 * latency-critical pre-generation path. The just-completed exchange (the user message +
 * the AI reply that just landed) is now FULLY present in chat, so we extract from the real
 * accepted text — including the ACCEPTED swipe (the active swipe IS the message's current
 * .mes, so chat[target].mes is exactly what the user settled on; FIX #8b).
 *
 * Every guard from the old blocking-path commit is preserved here, with capture-at-write
 * pinned at extraction start (the correct moment now that timing shifted post-reply):
 *  - enabled / group / dry / internal skips
 *  - pipelineCancelled (a Stop discards the extraction)
 *  - bf_mem_processed gating (no double-extract of an already-processed exchange)
 *  - capturedDbProfile / capturedCharAvatar capture-at-write (right slot / right character)
 *  - saveChatDebounced + saveCurrentToActiveProfile + review popup
 * Wrapped in try/catch: an extraction failure must NEVER break generation or the next turn.
 */
async function runMemoryExtraction() {
    if (memoryExtractionInFlight) {
        // F-ORCH-3 (silent memory loss): returning silently here permanently dropped this
        // exchange — the target scan only ever finds the LAST genuine AI message, so a later
        // attempt targets a later reply and this one is never re-tried. Arm a ONE-SHOT retry
        // chained to the in-flight run's completion: its `finally` re-schedules the settle
        // extraction ('retry-busy') once the store is free. Never re-armed while already armed,
        // and each arm is consumed by exactly one real run finishing — no retry loop possible.
        if (!extractionRetryAfterBusy) {
            extractionRetryAfterBusy = true;
            addDebugLog('info', 'Agent 3 (post-reply): prior extraction still committing — ONE retry chained to its completion');
        }
        return; // a prior extraction is still committing
    }
    const settings = getSettings();
    if (!settings || !settings.enabled) return;
    if (isInternalCall()) return; // never extract off our own agent calls
    if (pipelineCancelled) {
        // F-ORCH-3 (same permanent-drop property — verified): a pending settle timer nearly
        // always exists because the target reply fully LANDED (MESSAGE_RECEIVED reset
        // pipelineCancelled at that moment), so a true flag here means the user pressed Stop on
        // a LATER generation — yet the silent drop skipped the EARLIER, completed exchange
        // forever. Schedule ONE timer retry: if the cancel has cleared by fire time (any next
        // turn/MESSAGE_RECEIVED resets it) the exchange is recovered; if the user stayed
        // stopped+idle the retry drops again WITH a log and does NOT re-arm (one-shot; reset
        // when a run actually proceeds, and on CHAT_CHANGED).
        if (!cancelledRetryArmed) {
            cancelledRetryArmed = true;
            addDebugLog('info', 'Agent 3 (post-reply): skipped — generation was stopped/cancelled; scheduling ONE retry so the completed exchange isn\'t silently dropped');
            scheduleSettleExtraction('retry-cancelled', false);
        } else {
            addDebugLog('info', 'Agent 3 (post-reply): still cancelled on retry — exchange left unprocessed (no further retries)');
        }
        return;
    }
    const ctx0 = SillyTavern.getContext();
    if (ctx0.groupId || ctx0.selected_group) return; // group chats unsupported (same as gate)

    const chat = ctx0.chat;
    if (!Array.isArray(chat) || chat.length === 0) return;

    // Target the JUST-RECEIVED AI message (includeLast=true: the reply now exists at the
    // tail of chat). This also closes the swipe-settle gap — when the user swipes then
    // stops, chat[target].mes already holds the ACCEPTED swipe's content.
    const memoryTargetIndex = findMemoryTargetIndex(chat, true);
    if (memoryTargetIndex < 0) {
        addDebugLog('info', 'Agent 3 (post-reply): no genuine AI message to extract — skipping');
        return;
    }
    // bf_mem_processed gating (source of truth): don't re-extract an exchange already done.
    // On a swipe the MESSAGE_SWIPED handler clears this flag, so the accepted swipe re-runs.
    if (chat[memoryTargetIndex]?.extra?.bf_mem_processed) {
        addDebugLog('info', `Agent 3 (post-reply): target msg ${memoryTargetIndex} already processed — skipping (no double-extract)`);
        return;
    }

    // Find the latest USER message (for @src:user attribution / prior-context window).
    let lastUserMsgIndex = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].is_user) { lastUserMsgIndex = i; break; }
    }

    // CAPTURE-AT-WRITE at extraction start (correct moment now timing is post-reply):
    // pin the active DB profile + character avatar so a mid-extraction chat/character
    // switch can't land facts in the wrong slot or contaminate another character.
    const capturedDbProfile = settings.activeDbProfile;
    const capturedCharAvatar = ctx0.characters?.[ctx0.characterId]?.avatar || '';
    const startTime = Date.now();
    // Debug-log redesign §2: REUSE the inline run's id (armed as pendingRun at the start of
    // this turn) so a turn's pre-reply (Agent 1, retrieval) and post-reply (Agent 3 extract,
    // commit, evict) events all group under ONE id — the run the user saw start. Fall back to
    // minting `M…` only when there's no armed run (e.g. full-chat re-extraction). consumePendingRun
    // one-shot-clears it; we leave reflection's own runId carried via reflectionPending.
    const pending = getPendingRun();
    const runId = pending?.runId || `M${startTime.toString(36).slice(-5)}`;
    // Set the ambient id so leaf db/eviction logs auto-tag with this run; endRun() in finally.
    beginRun(runId);

    // PER-STAGE TIMING for the POST-REPLY path (observability only — no behavior change).
    // agent3Ms = wall-clock the Scribe LLM call (runMemoryUpdater) actually took; snapshotMs =
    // the durable profile snapshot (saveCurrentToActiveProfile). Emitted as a `pipeline.timing`
    // debug line at the end so the post-reply cost shows up alongside the blocking-path one.
    const postStageMs = { agent3Ms: null, snapshotMs: null };

    // WATERMARK AT SCOPE-TIME (atomic #12). Stamp the AI target + latest user message with an
    // 'in-flight' marker BEFORE the Scribe LLM call, not only after commit. A mid-run error or
    // character switch then never leaves the exchange un-watermarked and re-extracted next turn.
    // States: 'in-flight' while running → true on commit; reset to false on explicit discard
    // (cancel / character change / returned LLM error — none of which wrote to the DB) so the
    // next genuine turn reprocesses; left 'in-flight' on an unexpected throw (crashed run is
    // terminal — don't blindly re-extract a possibly half-written exchange).
    const BF_MEM_IN_FLIGHT = 'in-flight';
    const setWatermark = (val) => {
        let changed = false;
        if (chat[memoryTargetIndex] && chat[memoryTargetIndex].extra?.bf_mem_processed !== val) {
            chat[memoryTargetIndex].extra = { ...(chat[memoryTargetIndex].extra || {}), bf_mem_processed: val };
            changed = true;
        }
        if (lastUserMsgIndex >= 0 && lastUserMsgIndex !== memoryTargetIndex && chat[lastUserMsgIndex]
            && chat[lastUserMsgIndex].extra?.bf_mem_processed !== val) {
            chat[lastUserMsgIndex].extra = { ...(chat[lastUserMsgIndex].extra || {}), bf_mem_processed: val };
            changed = true;
        }
        if (changed) SillyTavern.getContext().saveChatDebounced?.();
    };
    setWatermark(BF_MEM_IN_FLIGHT);

    memoryExtractionInFlight = true;
    // F-ORCH-3: a run is genuinely proceeding — re-open the one-shot cancelled-retry window so a
    // FUTURE cancelled drop (a distinct event) may schedule its own single retry again.
    cancelledRetryArmed = false;
    internalCallDepth++; // F-ORCH-2: our extraction LLM call must not re-trigger the pipeline (paired with the finally)
    let memoryResult = null;
    // H7: track whether we got far enough that the Scribe may have written to the store. Until
    // runMemoryUpdater resolves successfully, NOTHING in this function has touched the DB, so an
    // unexpected throw before that point (e.g. getAllDatabases, prompt build, an internal error)
    // left the exchange wrongly stuck 'in-flight' forever — the gate then treated it as processed
    // and never re-extracted (only a swipe cleared it). We now reset the watermark to false in the
    // catch ONLY when the throw happened BEFORE any commit, so a later turn can retry. After the
    // Scribe's writes begin we keep the prior terminal behavior (don't re-extract a possibly
    // half-written exchange).
    let reachedCommit = false;
    try {
        // B4: the Scribe extracts facts from the MESSAGE TEXT, not the character card — a short
        // brief is enough to anchor {{char}}, and avoids resending the full ~4 KB card every
        // extraction. (The Drafter still gets the full card via getCharacterInfo() on its path.)
        const characterInfo = getCharacterInfoBrief();
        const userPersona = getUserPersona();
        const targetMessage = chat[memoryTargetIndex];
        const role = targetMessage.is_user ? 'USER' : 'AI';

        // Load databases (Agent 3's existing-DB context).
        const databases = await getAllDatabases();

        // USE-IT-OR-LOSE-IT: drain the use buffer staged by the inline pipeline's injection this
        // turn onto these freshly-loaded fact objects BEFORE the extraction's own writes. Mutates
        // in place; the bumps then persist via the saveDatabase/saveCurrentToActiveProfile this
        // function already performs at the end — NO standalone save is added. Safe even when the
        // run committed nothing extractable: if any category it touches isn't otherwise re-saved,
        // saveCurrentToActiveProfile (called whenever updates>0 OR usage was applied) snapshots
        // the whole live map, and a turn with zero buffered facts is a no-op. Threads the run id.
        const usageBumpCats = applyBufferedFactUsage(databases, runId);

        // Gather up to agent3ContextMessages prior messages for richer context. Default = 2
        // means the latest user + AI exchange (current behavior preserved). The target is
        // passed separately, so exclude it from the prior window.
        const agent3Count = Math.max(1, settings.agent3ContextMessages || 2);
        const agent3StartIdx = Math.max(0, chat.length - agent3Count - 1);
        // B3 (safe slice — input-token reduction, NO fact loss): when scribeTrimProcessedPriors is
        // ON, drop prior-context messages that were ALREADY extracted on an earlier turn
        // (bf_mem_processed === true). Rationale: those facts are already in the store, so re-sending
        // the raw text to the Scribe only burns input tokens for context the new target rarely needs.
        // SAFETY: we trim ONLY committed priors (=== true). The CURRENT exchange (the target + its
        // user message) is watermarked 'in-flight' (a string, set just above), so `=== true` is false
        // for them — they are NEVER trimmed. Any still-UNPROCESSED prior (new content not yet
        // extracted) is also kept. Default OFF → byte-identical to today.
        const trimProcessed = settings.scribeTrimProcessedPriors === true;
        const agent3PriorMessages = [];
        for (let i = agent3StartIdx; i < chat.length; i++) {
            if (i === memoryTargetIndex) continue;
            if (!chat[i] || !chat[i].mes) continue;
            // Skip already-committed priors when trimming is on (never the in-flight current pair).
            if (trimProcessed && chat[i].extra?.bf_mem_processed === true) continue;
            agent3PriorMessages.push({ role: chat[i].is_user ? 'USER' : 'CHAR', text: chat[i].mes });
        }
        addDebugLog('info', `[${runId}] Agent 3 (post-reply) target [${role}] msg ${memoryTargetIndex}${agent3PriorMessages.length ? ` + ${agent3PriorMessages.length} prior msg(s)` : ''}: ${targetMessage.mes?.substring(0, 100)}`);

        // EMPTY-SCOPE PRE-LLM SKIP (atomic #13). If EVERY message Agent 3 would see is trivially
        // empty (pure asterisk actions, OOC, very short), skip the Scribe call entirely — commit
        // the watermark so we don't retry, and return without spending a token. A single
        // non-trivial message in the window keeps the run alive.
        if (settings.agent3EmptyScopeSkip !== false) {
            const windowTexts = [targetMessage.mes, ...agent3PriorMessages.map(m => m.text)];
            if (windowTexts.every(t => isTriviallyEmptyForExtraction(t))) {
                addDebugLog('info', `[${runId}] Agent 3 (post-reply): scope trivially empty — skipping LLM call`);
                setWatermark(true);
                return;
            }
        }

        const agent3ProfileId = getAgent3ProfileId(settings);
        const agent3Start = Date.now();
        // HUB FIX (per-character namespacing): pass the target message's AUTHOR name so the Scribe's
        // generic `char`/`{{char}}` facts resolve to the REAL speaking character — correct for group
        // chats / NPC-vs-main-char where ST sets `targetMessage.name` to the speaking member.
        const sourceSpeakerName = String(targetMessage.name || '').trim();
        // TEMPORAL GROUNDING: derive the message's real-world observation timestamp (ISO) so the
        // Scribe can resolve relative time words ("yesterday","last week") to ABSOLUTE dates that
        // don't rot. ST messages carry send_date (usually a parseable string, sometimes a number);
        // fall back to now() if absent/unparseable. Never throws — degrades to current time.
        let observationDate;
        try {
            const sd = targetMessage.send_date;
            const ts = (sd != null) ? new Date(sd).getTime() : NaN;
            observationDate = (Number.isFinite(ts) ? new Date(ts) : new Date()).toISOString();
        } catch (_) {
            observationDate = new Date().toISOString();
        }
        memoryResult = await runMemoryUpdater(
            targetMessage.mes, memoryTargetIndex, characterInfo, databases, agent3ProfileId,
            !!targetMessage.is_user, userPersona, agent3PriorMessages, lastUserMsgIndex, sourceSpeakerName,
            observationDate,
        ).catch(err => ({ updates: [], summary: '', raw: '', error: err.message, tokensIn: 0, tokensOut: 0 }));
        postStageMs.agent3Ms = Date.now() - agent3Start; // observability: Scribe LLM call wall-clock

        // Fold Agent 3's tokens into the session totals WITHOUT bumping the run count
        // (the run was already counted on the blocking path) and update lastRunTokens.
        addAgent3Tokens({ agent3Input: memoryResult?.tokensIn || 0, agent3Output: memoryResult?.tokensOut || 0 });

        if (!memoryResult || memoryResult.error) {
            if (memoryResult?.error) addDebugLog('fail', `[${runId}] Agent 3 error: ${memoryResult.error}`, {
                subsystem: 'agent3', event: 'agent3.run', reason: 'ERROR',
                data: { agent: 'agent3', profileId: getAgent3ProfileId(settings) || null, success: false, error: memoryResult.error, durationMs: Date.now() - startTime },
            });
            setWatermark(false); // LLM error wrote nothing — clear so a later turn can retry
            return;
        }

        // H7: the Scribe resolved successfully — its internal applyUpdates may now have committed
        // facts to the store. From here on a throw is treated as terminal (don't blindly re-extract
        // a possibly half-written exchange); before here, the catch resets the watermark to false.
        reachedCommit = true;

        // Always record what Agent 3 proposed (for the Last Generated tab).
        setLastGenerated(memoryResult.updates || []);

        // pipelineCancelled may have flipped (user clicked Stop) while we awaited the LLM.
        if (pipelineCancelled) {
            addDebugLog('info', `[${runId}] Cancelled mid-extraction — discarding ${memoryResult.updates.length} updates`);
            setWatermark(false); // user stopped — let the next genuine turn reprocess
            setLastInserted((memoryResult.updates || []).map(u => ({ ...u, status: 'SKIPPED' })));
            return;
        }

        // Character-changed guard: don't write to another character's attachments.
        const liveCtx = SillyTavern.getContext();
        const currentCharAvatar = liveCtx.characters?.[liveCtx.characterId]?.avatar || '';
        if (currentCharAvatar !== capturedCharAvatar) {
            addDebugLog('fail', `[${runId}] Character changed mid-extraction (${capturedCharAvatar} -> ${currentCharAvatar}) — discarding ${memoryResult.updates.length} updates`);
            if (typeof toastr !== 'undefined') {
                toastr.warning('BF Memory: extraction discarded — you switched characters');
            }
            setWatermark(false); // wrong character now active — let this char's next turn reprocess
            setLastInserted((memoryResult.updates || []).map(u => ({ ...u, status: 'SKIPPED' })));
            return;
        }

        // Last Inserted = only facts that actually changed stored state (NEW/UPDATED).
        const committed = Array.isArray(memoryResult.applied)
            ? memoryResult.applied
            : (memoryResult.updates || []).filter(u => u.changed ?? u.wasNew).map(u => ({
                ...u,
                status: u.status || (u.wasNew ? 'NEW' : 'UPDATED'),
            }));
        const a3Counts = (memoryResult.updates || []).reduce((acc, u) => {
            const s = String(u.status || (u.changed === false ? 'SKIPPED' : (u.wasNew ? 'NEW' : 'UPDATED'))).toUpperCase();
            acc[s] = (acc[s] || 0) + 1; return acc;
        }, {});
        addDebugLog('info', `[${runId}] Agent 3: ${memoryResult.updates.length} proposed, ${committed.length} committed. ${memoryResult.summary}`, {
            subsystem: 'agent3', event: 'agent3.run',
            data: {
                agent: 'agent3', profileId: getAgent3ProfileId(settings) || null, success: true,
                durationMs: Date.now() - startTime, targetMsgIndex: memoryTargetIndex,
                tokensIn: memoryResult.tokensIn ?? null, tokensOut: memoryResult.tokensOut ?? null,
                proposed: memoryResult.updates.length, committed: committed.length,
                NEW: a3Counts.NEW || 0, UPDATED: a3Counts.UPDATED || 0, SKIPPED: a3Counts.SKIPPED || 0,
            },
        });
        setLastInserted(committed);
        // F-UX-6: reviewInterval 0 = never show the review popup. Skip queueing entirely while
        // disabled so pendingReviewItems can't grow unboundedly (facts are already saved above).
        const reviewEvery = Math.floor(settings.reviewInterval ?? 10);
        if (reviewEvery > 0) {
            for (const update of memoryResult.updates) trackUpdate(update);
        }

        // Mark the AI target + the user message (Agent 3 saw both) as processed so the
        // per-message icon / "skip already processed" / our own re-extract gate honor it.
        // PERF (fix): only FORCE a chat save when the flag actually CHANGED. The flag was
        // previously stamped + saveChatDebounced() called every turn, which re-serializes
        // the ENTIRE chat .jsonl each time — O(chat size) per reply on a long chat for a
        // boolean that's almost always already correct. We track whether either stamp was
        // a real transition and only then nudge ST to persist; when nothing changed we let
        // ST's own existing chat-save cadence handle it (the flag still lives on the
        // in-memory chat object, so persistence isn't lost — we just stop forcing a
        // redundant full-chat write for a no-op).
        // Promote the in-flight watermark to committed (true). setWatermark only saves when a
        // value actually changes, preserving the prior perf fix (no redundant full-chat write).
        setWatermark(true);

        // Review popup (deferred), capturing the chat id so it can't pop in the wrong chat.
        if (reviewEvery > 0 && tickMessageCounter(reviewEvery)) {
            addDebugLog('info', `[${runId}] Review interval reached, will show popup shortly`);
            const targetChatIdForPopup = SillyTavern.getContext().chatId;
            setTimeout(async () => {
                if (SillyTavern.getContext().chatId !== targetChatIdForPopup) {
                    addDebugLog('info', 'Skipping review popup: chat changed since extraction finished');
                    return;
                }
                await showReviewPopup(
                    () => addDebugLog('info', 'User confirmed reviewed facts (Looks good)'),
                    async (editedItems) => {
                        // Defensive: never upsert informational contradiction items (atomic #7).
                        const writable = editedItems.filter(i => i.action !== 'conflict');
                        addDebugLog('info', `User edited ${writable.length} items`);
                        appendLastInserted(writable.map(i => ({ ...i, status: 'UPDATED' })));
                        const dbs = await getAllDatabases();
                        for (const item of writable) {
                            if (!dbs[item.category]) dbs[item.category] = createEmptyDatabase(item.category);
                            upsertFact(dbs[item.category], item);
                            await saveDatabase(dbs[item.category]);
                        }
                    },
                );
            }, 2000);
        }

        // USE-IT-OR-LOSE-IT durability: make the bumps reach the WORKING store (IDB/attachment —
        // the load source), not just the profile. saveDatabase is a per-category RMW that reads
        // OTHER categories from disk, so a bump only persists if its category is re-saved. The
        // extraction (applyUpdates) already re-saved every category it CHANGED, and those carry
        // their bumps for free (same in-memory object). Here we persist only the bumped categories
        // the extraction did NOT change — typically 0, occasionally 1–2 — so a used-but-unedited
        // fact's strengthening isn't silently dropped on reload. Proportionate, never a full pass.
        if (usageBumpCats.length > 0) {
            const savedByExtraction = new Set((memoryResult.updates || [])
                .filter(u => u.changed)
                .map(u => u.category));
            for (const cat of usageBumpCats) {
                if (savedByExtraction.has(cat)) continue; // already rode the extraction's save
                if (!databases[cat]) continue;            // defensive: bumped cat must exist
                try {
                    await saveDatabase(databases[cat]);
                } catch (e) {
                    addDebugLog('fail', `[${runId}] Failed to persist use-bump for "${cat}": ${e.message || e}`, {
                        runId, subsystem: 'retrieval', event: 'fact.strengthened', reason: 'PERSIST_FAILED',
                    });
                }
            }
        }

        // Persist to the captured DB profile slot (capture-at-write). Also persist when the only
        // change this turn was use-it-or-lose-it strengthening so the profile snapshot stays in
        // sync with the working store even on a turn that produced no extraction updates.
        if (memoryResult.updates.length > 0 || usageBumpCats.length > 0) {
            const snapStart = Date.now();
            await saveCurrentToActiveProfile(capturedDbProfile);
            postStageMs.snapshotMs = Date.now() - snapStart; // observability: durable snapshot wall-clock
        }
    } catch (err) {
        // Graceful degradation: a memory-extraction failure must never break the next turn.
        addDebugLog('fail', `[${runId}] Agent 3 (post-reply) failed (non-fatal): ${err.message || err}`);
        // H7: if we threw BEFORE the Scribe committed anything (e.g. db load / prompt build /
        // pre-LLM error), the exchange is un-written — reset the 'in-flight' watermark to false so a
        // later genuine turn re-extracts it instead of skipping it forever. Only reached-commit
        // throws stay terminal (possible half-write). setWatermark only persists on a real change.
        if (!reachedCommit) {
            try {
                setWatermark(false);
                addDebugLog('info', `[${runId}] Agent 3: reset 'in-flight' watermark (throw before commit) — exchange will re-extract next turn`);
            } catch { /* watermark reset is best-effort — never rethrow from the catch */ }
        }
    } finally {
        memoryExtractionInFlight = false;
        // F-ORCH-2: decrement (never assign false) — clamped, see the counter's declaration.
        internalCallDepth = Math.max(0, internalCallDepth - 1);
        // F-ORCH-3: consume a busy-drop retry chained to THIS run — an extraction attempt arrived
        // while we were committing and would otherwise have been permanently lost. Re-schedule the
        // settle extraction ONCE now that the store is free; every guard (bf_mem_processed /
        // cancelled / target scan) re-evaluates at fire time, so an already-covered exchange is a
        // cheap no-op, and runPostPasses=false because the original MESSAGE_RECEIVED path already
        // dispatched the reflection/entity passes for its turn.
        if (extractionRetryAfterBusy) {
            extractionRetryAfterBusy = false;
            scheduleSettleExtraction('retry-busy', false);
        }
        // OBSERVABILITY: one concise post-reply timing line (debug level) for the slowness hunt.
        // Includes the Scribe prompt size + prefix-stability so a giant UNSTABLE system prompt is
        // obvious. Pure log in the finally — never alters control flow or the next turn.
        try {
            const postTotalMs = Date.now() - startTime;
            addDebugLog('debug',
                `[${runId}] Stage timing (post-reply): agent3=${postStageMs.agent3Ms ?? '-'}ms ` +
                `snapshot=${postStageMs.snapshotMs ?? '-'}ms total=${postTotalMs}ms` +
                (Number.isFinite(memoryResult?.systemPromptApproxTokens)
                    ? ` | a3 sys=${memoryResult.systemPromptChars}ch ~${memoryResult.systemPromptApproxTokens}tok stable=${memoryResult.systemPromptStable}`
                    : ''),
                {
                    runId, subsystem: 'pipeline', event: 'pipeline.timing',
                    data: {
                        phase: 'post-reply', ...postStageMs, totalMs: postTotalMs,
                        agent3SystemPromptChars: Number.isFinite(memoryResult?.systemPromptChars) ? memoryResult.systemPromptChars : null,
                        agent3SystemPromptApproxTokens: Number.isFinite(memoryResult?.systemPromptApproxTokens) ? memoryResult.systemPromptApproxTokens : null,
                        agent3SystemPromptStable: typeof memoryResult?.systemPromptStable === 'boolean' ? memoryResult.systemPromptStable : null,
                    },
                },
            );
        } catch { /* logging must never break the turn */ }
        endRun(); // clear the ambient run id once post-reply extraction's logging window closes
    }
}

/**
 * Run an armed reflection pass. Called from MESSAGE_RECEIVED so it never blocks the
 * latency-critical pre-generation path. Fully guarded: skips if disabled, cancelled,
 * in a group chat, the character changed since arming, or another pass is in flight.
 * Wrapped in try/catch — a reflection failure must never break the pipeline.
 */
async function maybeRunReflection() {
    const pending = reflectionPending;
    if (!pending || reflectionInFlight) return;
    const settings = getSettings();
    if (!settings || !settings.enabled || !settings.reflectionEnabled) { reflectionPending = null; return; }
    if (pipelineCancelled) { reflectionPending = null; return; }
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) { reflectionPending = null; return; }
    // Character-changed guard (same class as Agent 3 writes): don't synthesize observations
    // onto the wrong character's attachments if the user switched mid-session.
    const currentCharAvatar = ctx.characters?.[ctx.characterId]?.avatar || '';
    if (currentCharAvatar !== pending.charAvatar) {
        addDebugLog('info', `[${pending.runId}] Reflection skipped (character changed since arming)`);
        reflectionPending = null;
        return;
    }

    reflectionPending = null;
    reflectionInFlight = true;
    successfulRunsSinceReflection = 0; // reset the cadence regardless of outcome
    internalCallDepth++; // F-ORCH-2: the reflection LLM call can't re-trigger the pipeline (paired with the finally)
    const reflectStart = Date.now();
    try {
        updateStatus('running', 'Reflecting (consolidating memory)...');
        // FIX #12: no longer pass prevReflection — the rolling #STORY summary was dropped, so
        // re-feeding the prior summary into the reflection prompt was wasted input tokens.
        const reflResult = await runReflection({
            runId: pending.runId,
            scene: getScene(),
            characterInfo: pending.characterInfo || '',
            userPersona: pending.userPersona || '',
            profileId: pending.profileId || null,
        });
        // TOKEN TRACKING (Tokens tab): the reflection pass is an LLM call whose cost was
        // previously dropped entirely. Fold its in/out tokens into the current run's totals
        // (mirrors addAgent3Tokens — post-reply update, no run-count bump, no input re-count).
        try {
            const rIn = Number(reflResult?.tokensIn) || 0;
            const rOut = Number(reflResult?.tokensOut) || 0;
            if (rIn || rOut) {
                addReflectionTokens({ reflectionInput: rIn, reflectionOutput: rOut });
                addDebugLog('info', `[${pending.runId}] Reflection tokens: in=${rIn} out=${rOut}`, {
                    subsystem: 'reflection', event: 'reflection.run',
                    data: { agent: 'reflection', profileId: pending.profileId || null, tokensIn: rIn, tokensOut: rOut },
                });
            }
        } catch { /* token recording is best-effort — never break reflection */ }
        // Persist any observation facts the pass wrote to the active DB profile.
        try { await saveCurrentToActiveProfile(settings.activeDbProfile); } catch { /* best-effort */ }
        const reflectionMs = Date.now() - reflectStart;
        addDebugLog('info', `[${pending.runId}] Reflection pass complete (${reflectionMs}ms)`, {
            subsystem: 'reflection', event: 'reflection.run',
            data: { agent: 'reflection', profileId: pending.profileId || null, success: true, durationMs: reflectionMs },
        });
        // OBSERVABILITY: surface reflectionMs in the pipeline.timing event family (slowness hunt),
        // grouped under the turn's runId. Pure log — no behavior change.
        addDebugLog('debug', `[${pending.runId}] Stage timing (reflection): reflection=${reflectionMs}ms`, {
            runId: pending.runId, subsystem: 'pipeline', event: 'pipeline.timing',
            data: { phase: 'reflection', reflectionMs, totalMs: reflectionMs },
        });
    } catch (err) {
        addDebugLog('fail', `Reflection pass failed (non-fatal): ${err.message || err}`, {
            subsystem: 'reflection', event: 'reflection.run', reason: 'ERROR',
            data: { agent: 'reflection', profileId: pending.profileId || null, success: false, error: err.message || String(err), durationMs: Date.now() - reflectStart },
        });
    } finally {
        reflectionInFlight = false;
        // F-ORCH-2: decrement (never assign false) — clamped, see the counter's declaration.
        internalCallDepth = Math.max(0, internalCallDepth - 1);
        updateStatus('idle');
    }
}

/**
 * Character registry detection — runs on MESSAGE_RECEIVED, OFF the critical path, gated to
 * fire at most once every `characterCheckInterval` successful extraction runs. Performs a
 * DETERMINISTIC scan of the fact store (no LLM call) for newly-seen NAMED entities not yet
 * classified; when there are candidates, opens ONE batched popup (deferred, never blocking)
 * for the user to mark each Recurring / NPC / Later. Marking Recurring migrates that name's
 * facts out of the shared NPC drawer. Fully self-guarded + try/catch'd — a failure here can
 * never break generation or the next turn.
 */
async function maybeRunEntityCheck() {
    if (entityCheckInFlight) return;
    const settings = getSettings();
    // Run when EITHER the registry popup OR the semantic merge pass is enabled — both share this
    // OFF-critical-path cadence. The popup-specific work below is still gated on characterRegistryEnabled.
    const registryOn = settings && settings.characterRegistryEnabled !== false;
    const resolutionOn = settings && settings.entityResolution === true;
    if (!settings || !settings.enabled || (!registryOn && !resolutionOn)) return;
    if (pipelineCancelled) return;
    const ctx = SillyTavern.getContext();
    if (ctx.groupId || ctx.selected_group) return; // group chats unsupported (same as the gate)

    runsSinceEntityCheck++;
    const interval = Math.max(2, settings.characterCheckInterval || 10);
    if (runsSinceEntityCheck < interval) return;
    runsSinceEntityCheck = 0; // reset cadence regardless of outcome

    entityCheckInFlight = true;
    try {
        // Semantic entity resolution / merge (default OFF; self-guarded internally). Conservative,
        // deterministic, off the critical path. Run BEFORE detection so the registry/popup sees the
        // post-merge subject set. A failure here degrades to a no-op (it never throws out).
        if (resolutionOn) {
            try { await runEntityResolution(); } catch (err) {
                addDebugLog('fail', `Entity resolution (cadence) failed (non-fatal): ${err.message || err}`);
            }
            try { reloadEntitiesUI(); } catch { /* ignore */ }
        }
        // Registry detection + popup is gated on its own toggle.
        if (!registryOn) return;
        const { getAllDatabases } = await import('./database.js');
        const databases = await getAllDatabases();
        const candidates = detectAndRecord(databases);
        // Refresh the settings-panel list so newly-detected names show even before the popup.
        try { reloadEntitiesUI(); } catch { /* ignore */ }
        if (!candidates || candidates.length === 0) {
            addDebugLog('info', 'Character check: no new named candidates');
            return;
        }
        addDebugLog('info', `Character check: ${candidates.length} new named candidate(s) — opening popup`);
        // Defer the popup so it never lands mid-generation: capture the chat id and only
        // show if we're still in the same chat after a short settle window (mirrors the
        // review-popup deferral pattern).
        const targetChatId = ctx.chatId;
        setTimeout(async () => {
            try {
                if (SillyTavern.getContext().chatId !== targetChatId) {
                    addDebugLog('info', 'Character popup skipped: chat changed since detection');
                    return;
                }
                await showEntityPopup(candidates);
                try { reloadEntitiesUI(); } catch { /* ignore */ }
            } catch (err) {
                addDebugLog('fail', `Character popup failed (non-fatal): ${err.message || err}`);
            }
        }, 2200);
    } catch (err) {
        addDebugLog('fail', `Character check failed (non-fatal): ${err.message || err}`);
    } finally {
        entityCheckInFlight = false;
    }
}

/**
 * A2/B5 — FROZEN INJECTION. On a genuine new turn, OPTIONALLY reuse the cached draft-less injection
 * (the same scene + facts block the last full run produced) instead of re-running the Drafter.
 * This (a) skips that per-turn LLM call (token/latency win) and (b) keeps the
 * injected system block BYTE-STABLE across the frozen window, so a server-side prompt cache can
 * reuse the prefix (the cache-stability half — see the note in llm-call.js).
 *
 * IMPORTANT — this never weakens memory: the post-reply Scribe extraction still runs every turn
 * (MESSAGE_RECEIVED → scheduleSettleExtraction), so new facts are still written. Freezing only means
 * the facts we INJECT for the reply are the ones retrieved on the last full run (up to N turns old).
 *
 * Returns true if it injected the cached block (caller must then SKIP runPipelineInline). Returns
 * false to fall through to a full run when: the feature is off, there's no cached injection yet, the
 * freeze window has elapsed (time to refresh), or the inject call failed. On a successful freeze it
 * advances lastTriggeredUserMsgIndex EXACTLY as a full run does (so the gate state is identical to a
 * normal run — no new swipe/gate behavior) and sets the double-fire guard. It deliberately does NOT
 * arm a pendingRun (the post-reply extraction simply mints its own run id) and does NOT use-bump the
 * reused facts (they were bumped on the full run).
 *
 * @param {object} data - the CHAT_COMPLETION_PROMPT_READY payload (message-array shape)
 * @returns {boolean} true = injected cached block, skip the full run
 */
function tryFrozenInjection(data) {
    const settings = getSettings();
    if (!settings || !settings.enabled) return false;
    const freeze = Math.max(0, Math.floor(Number(settings.injectionFreezeTurns) || 0));
    if (freeze <= 0) return false;                                  // feature off (default)
    const cached = lastInjectionNoDraft || lastInjection;
    if (!cached) return false;                                      // nothing cached yet → full run
    if (turnsSinceFullInjection >= freeze) return false;           // window elapsed → refresh (full run)
    if (isInternalCall() || data?.dryRun) return false;            // never on our own / dry-run calls

    const success = injectMemoryContext(data, cached);
    if (!success) return false;                                    // inject failed → fall through to full run

    // Advance the trigger index exactly as runPipelineInline does, so the gate sees this turn as
    // handled (identical to a normal run; the swipe handler still resets it on a re-roll).
    try {
        const chat = SillyTavern.getContext().chat;
        if (Array.isArray(chat)) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i] && chat[i].is_user) { lastTriggeredUserMsgIndex = i; break; }
            }
        }
    } catch { /* index advance is best-effort */ }

    turnsSinceFullInjection++;
    pipelineJustInjected = true; // double-fire guard (mirrors the full-run + swipe paths)
    addDebugLog('info', `Frozen injection: reused cached facts (turn ${turnsSinceFullInjection}/${freeze}) — skipped Drafter (${cached.length} chars)`, {
        subsystem: 'pipeline', event: 'pipeline.frozen', reason: 'REUSED_CACHE',
        data: { turnsSinceFullInjection, freeze, chars: cached.length },
    });
    return true;
}

/**
 * A2/B5 — text-completion (GENERATE_AFTER_DATA) variant of tryFrozenInjection. Same gate + bookkeeping,
 * but prepends the cached block to data.prompt (the text-completion shape) instead of inserting a
 * system message. Returns true if it froze (caller skips the full run).
 * @param {object} data - the GENERATE_AFTER_DATA payload (has a string `prompt`)
 * @returns {boolean}
 */
function tryFrozenInjectionText(data) {
    const settings = getSettings();
    if (!settings || !settings.enabled) return false;
    const freeze = Math.max(0, Math.floor(Number(settings.injectionFreezeTurns) || 0));
    if (freeze <= 0) return false;
    const cached = lastInjectionNoDraft || lastInjection;
    if (!cached) return false;
    if (turnsSinceFullInjection >= freeze) return false;
    if (isInternalCall() || !data || typeof data.prompt !== 'string') return false;

    data.prompt = cached + '\n\n' + data.prompt;
    try {
        const chat = SillyTavern.getContext().chat;
        if (Array.isArray(chat)) {
            for (let i = chat.length - 1; i >= 0; i--) {
                if (chat[i] && chat[i].is_user) { lastTriggeredUserMsgIndex = i; break; }
            }
        }
    } catch { /* best-effort */ }

    turnsSinceFullInjection++;
    pipelineJustInjected = true;
    addDebugLog('info', `Frozen injection (text): reused cached facts (turn ${turnsSinceFullInjection}/${freeze}) — skipped Drafter (${cached.length} chars)`, {
        subsystem: 'pipeline', event: 'pipeline.frozen', reason: 'REUSED_CACHE_TEXT',
        data: { turnsSinceFullInjection, freeze, chars: cached.length },
    });
    return true;
}

// --- Main Pipeline Init ---

export function initPipeline() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // THE KEY HOOK: async handler on CHAT_COMPLETION_PROMPT_READY
    // ST's EventEmitter awaits each listener, so this blocks generation until we're done.
    // No abort. No re-trigger. Pipeline runs inline.
    eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, async (data) => {
        if (shouldRunPipeline(data)) {
            // A2/B5: on a genuine new turn, try reusing the cached injection (skip the agents) for
            // up to injectionFreezeTurns turns before refreshing. Default off → always a full run.
            if (tryFrozenInjection(data)) return;
            await runPipelineInline(data);
            return;
        }

        // Swipe/regen: re-inject cached facts (no agents, instant).
        // FIX #8a: use the DRAFT-LESS cached injection (lastInjectionNoDraft) — the same
        // scene + facts as the first roll, but WITHOUT Agent 1's stale draft scene-direction,
        // which was planned for the original roll and would mis-steer a divergent re-roll.
        // Skip if pipeline just injected in this same generation cycle (double-fire guard).
        const swipeInjection = lastInjectionNoDraft || lastInjection;
        // F-ORCH-2 (behavioral half): the `!isInternalCall` condition was REMOVED here. A genuine
        // user turn arriving while a background flow (post-reply extraction / reflection) holds
        // the internal window is hard-skipped by shouldRunPipeline (unavoidable — see the gate
        // comment there: this event's payload can't distinguish our own quiet-fallback call from
        // a real turn), and this fallback used to refuse too — so the turn generated with ZERO
        // memory injection, silently. Serving the CACHED block is safe for BOTH identities of
        // the event: a genuine turn gets last turn's scene+facts (degraded, not amnesiac); our
        // own rare generateQuietPrompt-fallback call just gains one inert context line.
        // pipelineJustInjected still prevents double-injection within one generation cycle.
        if (swipeInjection && !data?.dryRun && !pipelineJustInjected) {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;

            const success = injectMemoryContext(data, swipeInjection);
            if (success) {
                if (isInternalCall()) {
                    // 'info' (not debug) on purpose: a user turn served DEGRADED during background
                    // extraction is exactly what someone debugging memory quality must see.
                    addDebugLog('info', `Turn during internal agent window — served CACHED memory injection (degraded: no fresh retrieval/draft; ${swipeInjection.length} chars)`, { subsystem: 'pipeline', event: 'pipeline.inject.degraded', reason: 'INTERNAL_BUSY' });
                } else {
                    addDebugLog('info', `Swipe/regen: re-injected cached facts without stale draft (${swipeInjection.length} chars)`);
                }
            }
        }
    });

    // Handle text completion APIs (same inline blocking approach)
    eventSource.on(eventTypes.GENERATE_AFTER_DATA, async (data, dryRun) => {
        // F-ORCH-2 (behavioral half, text-completion parity): the hard `isInternalCall` early
        // return was removed — it made a genuine user turn during a background internal window
        // generate with ZERO memory on text-completion backends (the same silent loss as the
        // chat-completion path above). Our own agent calls still can't run the full pipeline
        // here (shouldRunPipeline skips INTERNAL), so an internal-window generation falls
        // through to the cached re-inject below — degraded but not amnesiac.
        if (dryRun) return;
        // DOUBLE-FIRE FIX: chat-completion backends (mainApi === 'openai' — OpenAI, OpenRouter,
        // Claude, etc.) emit BOTH `chat_completion_prompt_ready` AND `generate_after_data` for a
        // SINGLE generation. The chat-completion handler above already runs the full pipeline and
        // injects into the correct message-ARRAY shape; letting this text-shape handler also fire
        // ran the Drafter a SECOND time every turn (~2× tokens + ~2× latency) and injected
        // into the wrong (prompt-string) shape. So defer entirely to the chat-completion handler for
        // those backends. Text-completion backends do NOT emit `chat_completion_prompt_ready`, so
        // they still run here. (If the API can't be read, fall through and run — better than a
        // silent no-op that would drop memory entirely.)
        try {
            if (SillyTavern.getContext().mainApi === 'openai') return;
        } catch { /* unknown backend — fall through and run the full pipeline here */ }
        if (shouldRunPipeline({ dryRun: false })) {
            // A2/B5: frozen-injection fast path (text-completion shape). Default off.
            if (tryFrozenInjectionText(data)) return;
            await runPipelineInline(data);
            return;
        }

        // Swipe/regen: re-inject cached facts (FIX #8a: draft-less variant).
        // GUARD (parity with the CHAT_COMPLETION_PROMPT_READY swipe path): skip if the full run
        // already injected in THIS generation cycle (pipelineJustInjected). Without it, a text-
        // completion backend prepended the cached block a SECOND time into data.prompt (double
        // injection) whenever both events fired for one generation.
        const swipeInjection = lastInjectionNoDraft || lastInjection;
        if (swipeInjection && data && typeof data.prompt === 'string' && !pipelineJustInjected) {
            const settings = getSettings();
            if (!settings || !settings.enabled) return;

            data.prompt = swipeInjection + '\n\n' + data.prompt;
            if (isInternalCall()) {
                // F-ORCH-2: 'info' (not debug) on purpose — a user turn served DEGRADED during
                // background extraction must be visible when debugging memory quality.
                addDebugLog('info', `Turn during internal agent window (text) — served CACHED memory injection (degraded; ${swipeInjection.length} chars)`, { subsystem: 'pipeline', event: 'pipeline.inject.degraded', reason: 'INTERNAL_BUSY' });
            } else {
                addDebugLog('info', `Swipe/regen (text): re-injected cached facts without stale draft (${swipeInjection.length} chars)`);
            }
        }
    });

    // After generation complete: reset status and double-fire guard
    eventSource.on(eventTypes.MESSAGE_RECEIVED, async () => {
        pipelineJustInjected = false;
        // Clear the cancellation flag now that this generation cycle finished.
        // Without this, a Stop on one turn left pipelineCancelled=true and poisoned
        // every later turn whose pipeline run was skipped (so it never reset at the
        // top of runPipelineInline).
        pipelineCancelled = false;
        updateStatus('idle');

        // Count the main model's reply tokens for the Tokens tab — BUT only attribute
        // it to a run that actually recorded input this cycle. Swipes/regens fire
        // MESSAGE_RECEIVED without a fresh pipeline run, so unconditionally adding
        // output desynced input vs output counts over a long session.
        try {
            if (runRecordedInput) {
                const ctx = SillyTavern.getContext();
                const lastMsg = ctx.chat?.[ctx.chat.length - 1];
                if (lastMsg && !lastMsg.is_user && lastMsg.mes) {
                    const n = await (ctx.getTokenCountAsync?.(lastMsg.mes) ?? 0);
                    setMainOutputTokens(n);
                }
            }
        } catch { /* ignore */ }
        // One run = one input record = one output attribution. Disarm until the next run.
        runRecordedInput = false;

        // Phase 3b + FIX #12: Agent 3 (memory extraction about the just-completed exchange)
        // runs off the latency-critical pre-generation path. The AI reply has landed (and any
        // accepted swipe IS the message's current text). PER-SWIPE GATING: rather than
        // extract EAGERLY here — which on a heavily-swiped turn fired the ~7k-token Agent-3
        // call once per generated swipe — we SCHEDULE the extraction on the shared settle
        // debounce. Each new swipe (MESSAGE_RECEIVED) or navigation (MESSAGE_SWIPED) resets
        // the timer, so the expensive extraction runs ONCE on the settled/kept swipe. A normal
        // single-reply turn schedules once and, with nothing resetting it, still extracts
        // exactly once promptly. The reflection + entity-check passes are chained to run AFTER
        // the (single) settled extraction (runPostPasses=true), preserving their prior ordering
        // relative to the kept content. All guards (bf_mem_processed, pipelineCancelled, etc.)
        // remain inside runMemoryExtraction and are evaluated at fire time (settle), so a Stop
        // or a swipe that lands new content is still honored.
        scheduleSettleExtraction('message-received', true);

        // IDLE-TIME CONSOLIDATION: a reply just landed, so the activity clock restarts. (Re)arm
        // the idle timer — if the user then goes quiet for idleConsolidationMs it fires the same
        // reflection pass during dead time, in ADDITION to the turn-cadence pass. Opt-in + fully
        // self-guarded inside armIdleConsolidation (no-op when disabled or generation in flight).
        armIdleConsolidation();
    });

    // Also reset on generation stop/failure (user clicks Stop, or error).
    // cancelActiveRun sets pipelineCancelled (so in-flight writes are discarded) AND now
    // truly ABORTS the in-flight agent LLM calls via the llm-call cancel hook (AbortController),
    // so a Stop halts the run promptly instead of letting the cascade run to its timeout.
    eventSource.on(eventTypes.GENERATION_STOPPED, () => {
        cancelActiveRun('stopped');
        addDebugLog('info', 'Generation stopped — in-flight agent calls aborted, writes discarded', { subsystem: 'pipeline', event: 'pipeline.cancel', reason: 'STOPPED' });
    });

    // Recompute lastTriggeredUserMsgIndex when messages are deleted (e.g. /cut).
    // Otherwise the index becomes stale and the next genuine user message
    // (which may now land at the same numeric index as the deleted one) gets
    // silently skipped by the "already triggered" guard.
    eventSource.on(eventTypes.MESSAGE_DELETED, () => {
        const currentChat = SillyTavern.getContext().chat;
        lastTriggeredUserMsgIndex = -1;
        if (currentChat && currentChat.length > 0) {
            for (let i = currentChat.length - 1; i >= 0; i--) {
                if (currentChat[i] && currentChat[i].is_user) {
                    lastTriggeredUserMsgIndex = i;
                    break;
                }
            }
        }
        // Extraction dedup is handled by the per-message bf_mem_processed flag (stamped on
        // extracted messages, checked by runMemoryExtraction) — indices shifting after a
        // deletion can't skip new AI replies, so only the trigger index needs a reset here.
        addDebugLog('info', `Message deleted — reset lastUserMsg=${lastTriggeredUserMsgIndex}`);
    });

    // Reset on swipe/regenerate. The monotonic lastTriggeredUserMsgIndex never rewound
    // on swipe, so once it raced ahead of the chat's true state every later turn was
    // silently skipped forever (FIX #1). Rewind it to the current chat and clear the
    // swiped AI message's bf_mem_processed flag — its content just changed, so any prior
    // extraction is stale and the next genuine turn must be allowed to re-process it.
    eventSource.on(eventTypes.MESSAGE_SWIPED, (mesId) => {
        const currentChat = SillyTavern.getContext().chat;
        lastTriggeredUserMsgIndex = -1;
        if (currentChat && currentChat.length > 0) {
            for (let i = currentChat.length - 1; i >= 0; i--) {
                if (currentChat[i] && currentChat[i].is_user) {
                    lastTriggeredUserMsgIndex = i;
                    break;
                }
            }
        }
        // Invalidate extraction on the swiped message (content replaced).
        const swipedIdx = Number.isInteger(mesId) ? mesId : (currentChat ? currentChat.length - 1 : -1);
        if (currentChat && currentChat[swipedIdx]?.extra?.bf_mem_processed) {
            currentChat[swipedIdx].extra.bf_mem_processed = false;
            SillyTavern.getContext().saveChatDebounced?.();
        }
        addDebugLog('info', `Message swiped (idx ${swipedIdx}) — reset trigger indices, cleared bf_mem_processed`);

        // FIX #8b / FIX #12: (re)schedule the shared settle-extraction. Both a NEW-swipe
        // generation (via MESSAGE_RECEIVED) and a navigation onto an existing swipe (here)
        // feed the SAME debounce, so the expensive Agent-3 extraction runs ONCE on the final
        // settled swipe — never once per swipe. We do NOT run the reflection/entity-check
        // passes from the swipe path (runPostPasses=false): those are owned by the
        // MESSAGE_RECEIVED path so navigation alone can't re-arm a consolidation. Fully guarded
        // inside runMemoryExtraction (bf_mem_processed / cancelled / try/catch).
        scheduleSettleExtraction('swipe', false);
    });

    // Reset on chat change
    eventSource.on(eventTypes.CHAT_CHANGED, () => {
        // DATA-SAFETY FIX (coordinated CHAT_CHANGED): the durable IDB→attachment flush is NO LONGER
        // fired here. It used to run UN-AWAITED (`flushSnapshotNow()`) and raced the settings.js
        // handler's `await autoSaveDbProfile()` which clears/reloads the shared avatar working store
        // — the fire-and-forget flush could capture the wrong chat's facts or snapshot an already
        // emptied store, and its reconcile could DELETE durable backup files for transiently-empty
        // categories. The flush now lives inside the settings.js CHAT_CHANGED handler as a single
        // AWAITED sequence (pinned outgoing avatar, reconcileDeletes:false) that runs BEFORE the
        // autoload clear. Here we only drop the per-turn cache so this handler can't serve a stale
        // (pre-switch) map; the cache is partitioned by (avatar, chatId), so a same-character switch
        // is invalidated too.
        invalidateDatabaseCache();
        // F-ORCH-2: force-reset the internal-call ref-count — a stuck window must never outlive
        // the chat. In-flight flows' finally blocks decrement CLAMPED at 0, so this can't go
        // negative afterwards.
        internalCallDepth = 0;
        lastInjection = null;
        lastInjectionNoDraft = null;
        pipelineJustInjected = false;
        // A2/B5: a chat switch invalidates the cached injection above, so reset the freeze window —
        // the new chat's first turn must do a full run (the cache is null anyway, but keep state tidy).
        turnsSinceFullInjection = 0;
        // Drop any pending swipe-settle extraction so it can't fire against the new chat.
        if (swipeSettleTimer) { clearTimeout(swipeSettleTimer); swipeSettleTimer = null; }
        // F-ORCH-3: drop armed extraction retries too — they belong to the OLD chat's exchange
        // and must not schedule/consume a retry against the new chat.
        extractionRetryAfterBusy = false;
        cancelledRetryArmed = false;
        groupSkipToastShown = false;
        chatChangedAt = Date.now();
        // Reflection cadence is per-chat: reset the counter and drop any armed pass so a
        // chat switch can't fire a consolidation against the new chat using old context.
        successfulRunsSinceReflection = 0;
        reflectionPending = null;
        // IDLE-TIME CONSOLIDATION: drop any armed idle timer so it can't fire a consolidation
        // against the NEW chat using the prior chat's armed/context state.
        clearIdleConsolidation();
        // Debug-log redesign §2: drop any armed pendingRun + clear the ambient run id so a chat
        // switch can't leak the prior chat's runId onto the new chat's logs.
        setPendingRun(null);
        endRun();
        // Character-registry cadence is per-chat too: reset so a chat switch can't fire a
        // detection against the new chat using the old chat's accumulated run count.
        runsSinceEntityCheck = 0;
        hideWorkingIndicator();
        updateStatus('idle');

        // Initialize lastTriggeredUserMsgIndex to current last user message
        // so only NEW messages (sent after chat load) trigger the pipeline
        const currentChat = SillyTavern.getContext().chat;
        lastTriggeredUserMsgIndex = -1;
        if (currentChat && currentChat.length > 0) {
            for (let i = currentChat.length - 1; i >= 0; i--) {
                if (currentChat[i] && currentChat[i].is_user) {
                    lastTriggeredUserMsgIndex = i;
                    break;
                }
            }
        }

        addDebugLog('info', `Chat changed - state reset (lastUserMsg=${lastTriggeredUserMsgIndex})`);
    });

    console.log('[BFMemory] Pipeline initialized (inline blocking mode)');
}
