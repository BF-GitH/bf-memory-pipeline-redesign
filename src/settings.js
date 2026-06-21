// BF Memory Pipeline - Settings Module
// Handles UI, settings persistence, and debug logging

import { getConnectionProfiles, getCurrentProfileId } from './profiler.js';
import { DEFAULT_DRAFT_PROMPT } from './agent-draft.js';
import { DEFAULT_FINDER_PROMPT } from './agent-finder.js';
import { DEFAULT_MEMORY_PROMPT } from './agent-memory.js';
import { DEFAULT_WRITER_FORMAT } from './agent-writer.js';
import { DEFAULT_REFLECT_PROMPT } from './agent-reflect.js';
import {
    getEntities, setEntityStatus, reloadEntitiesFromChat,
    scanForNamedCandidates, showEntityPopup, promoteEntity, runEntityResolution,
} from './agent-entities.js';
import { explainFactRetrieval } from './fact-retrieval.js';

let Popup, POPUP_TYPE;
async function ensurePopup() {
    if (Popup) return true;
    const paths = ['../../../../popup.js', '../../../../../popup.js', '../../../../scripts/popup.js'];
    for (const p of paths) {
        try {
            const mod = await import(p);
            Popup = mod.Popup;
            POPUP_TYPE = mod.POPUP_TYPE;
            return true;
        } catch { /* try next */ }
    }
    return false;
}

const EXTENSION_NAME = (() => {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/');
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx > 0) return parts[srcIdx - 1];
    } catch { /* fallback */ }
    return 'bf-memory-pipeline';
})();

let extensionSettings = null;
// debugLog is the RAM RING BUFFER: holds ALL kept entries (incl. debug/verbose when
// enabled), newest-first, capped at MAX_DEBUG_ENTRIES_MEM. The chat_metadata copy is a
// verbose-stripped, byte-budgeted SLICE (MAX_DEBUG_ENTRIES_PERSIST). See addDebugLog /
// saveDebugLogToMeta below. Kept named `debugLog` so existing readers are unaffected.
let debugLog = [];
// Persisted slice cap — unchanged contract for the chat_metadata.bf_mem_log copy.
const MAX_DEBUG_ENTRIES = 500; // FIX #10: raised from 200 so a long session isn't truncated (still bounded)
// Two-cap scheme (debug-log redesign): the RAM ring buffer holds far more (the firehose,
// incl. debug/verbose) while only a non-verbose slice of MAX_DEBUG_ENTRIES_PERSIST reaches
// chat_metadata so the chat .jsonl stays small.
const MAX_DEBUG_ENTRIES_MEM = 2000;       // RAM ring buffer (drop-oldest)
const MAX_DEBUG_ENTRIES_PERSIST = MAX_DEBUG_ENTRIES; // persisted, verbose-stripped slice
// Byte budget for the JSON-serialized persisted slice (protects the chat .jsonl round-trip).
const LOG_PERSIST_BYTE_BUDGET = 256 * 1024; // ~256 KB
// Monotonic per-entry sequence — stable ordering within an identical timestamp.
let logSeq = 0;
// Ambient run id (set by beginRun/endRun). addDebugLog calls with no explicit opts.runId
// inherit this so leaf logs (db/retrieval) auto-tag without signature churn.
let currentRunId = null;
// Valid level/subsystem vocabularies (anything else falls back to a safe default).
const LOG_LEVELS = new Set(['fail', 'pass', 'info', 'debug', 'verbose']);
const LOG_SUBSYSTEMS = new Set([
    'pipeline', 'agent1', 'agent3', 'finder', 'retrieval', 'db',
    'entity', 'reflection', 'settings', 'import', 'cache', 'writer',
]);
// DISPLAY-only aliases for subsystem machine keys (the keys themselves are stable,
// for back-compat with persisted log entries + the filter dropdown values).
const SUBSYSTEM_DISPLAY = {
    agent1: 'Drafter',
    agent2: 'Writer',
    writer: 'Writer',
    agent3: 'Scribe',
    agent4: 'Librarian',
    finder: 'Librarian',
};
function subsystemLabel(key) {
    return SUBSYSTEM_DISPLAY[key] || key;
}
let lastGenerated = { runId: null, timestamp: null, updates: [] };
let lastInserted = { runId: null, timestamp: null, updates: [] };
// A4 — Injection Viewer state: the facts ACTUALLY injected into the Writer this turn (distinct from
// lastInserted, which is what the Scribe EXTRACTED to the DB). Populated by setLastInjection() from
// pipeline.js right after a successful injection; rendered on the Tokens tab so a user can SEE, at a
// glance, what memory the reply was given and roughly what it cost.
let lastInjection = { runId: null, timestamp: null, facts: [], approxTokens: 0 };
let lastRunTokens = null; // {baselineInput, actualInput, agent1Input, agent1Output, agent3Input, agent3Output, finderInput, finderOutput, reflectionInput, reflectionOutput, mainOutput, ts, approx}
let sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
// Scene card — the always-injected "what is true right now" core working-memory block.
// Persisted per-chat in chat_metadata.bf_mem_scene, reloaded on CHAT_CHANGED.
// null = no scene yet (back-compatible: absent scene behaves as no scene card).
let sceneCard = null; // { location, present[], goals[], beats[], sceneNo, sceneName, ownerChatId, updatedAt, runId }
// Reflection / consolidation summary — the rolling "story so far" + last synthesized
// observations. Persisted per-chat in chat_metadata.bf_mem_reflection, reloaded on
// CHAT_CHANGED. null = none yet (back-compatible: absent reflection = no injection).
let reflection = null; // { summary, observations[], updatedAt, runId }
// Summary pyramid — hierarchical zoom-out state. TOP level reuses the reflection #STORY
// summary (NOT duplicated — copied in at generation time); MIDDLE level holds one SHORT
// summary per populated (category, aspect) "shelf/bucket". Persisted per-chat in
// chat_metadata.bf_mem_pyramid, reloaded on CHAT_CHANGED. null = none yet (back-compatible:
// absent pyramid = no Big Picture injection). Derived/regenerable — never deletes facts.
let summaryPyramid = null; // { story, shelves: { 'cat||aspect': { text, factCount, updatedAt } }, updatedAt, runId }

const DEFAULT_SETTINGS = {
    enabled: false,
    // C1 — USABILITY PRESET. A single dropdown (Cheap · Balanced · Max Recall · Custom) that maps
    // one choice onto the many underlying token/retrieval knobs (see PRESETS below). 'custom' means
    // "the knobs don't match any preset" (the honest default for existing installs: detectPreset()
    // recomputes it on init from the live values, so a config that happens to match a preset shows
    // that preset). Applying a preset is the ONLY thing that bulk-writes those knobs; editing any
    // governed control by hand flips this back to 'custom' so the dropdown never lies.
    // C4: fresh installs default to the "Balanced" preset (the governed-key defaults below match
    // the 'balanced' signature, so detectPreset() resolves to 'balanced' on a clean install).
    // EXISTING users are unaffected — merge-missing-defaults only fills ABSENT keys, so anyone who
    // already has these keys keeps their values and detectPreset() shows whatever they match.
    uiPreset: 'balanced',
    useMemoryProfile: true,
    // Per-agent connection profiles (replacing single memoryProfile).
    // Old `memoryProfile` is kept on the stored object for rollback safety
    // and migrated forward in migrateLegacySettings().
    agent1Profile: '',
    agent3Profile: '',
    // Agent 4 (Fact Finder, STAGE 2 of two-stage retrieval) connection profile.
    // Empty => reuse Agent 1's profile (the design default). `agent4Profile` is the
    // canonical key; `finderProfile` is accepted as an alias (validated/migrated below).
    agent4Profile: '',
    finderProfile: '',
    // Per-agent context message counts (replacing single contextMessages).
    // Agent 3 default raised from 2 -> 5 (FIX #2a): a 2-message window truncated
    // long single-message backstory disclosures and the surrounding exchange that
    // gave them context, so rich reveals were missed. The full target message is
    // always sent untruncated regardless of this window (see buildMemoryPrompt /
    // pipeline.js — only the debug-log preview is substring'd, never the prompt).
    agent1ContextMessages: 5,
    agent3ContextMessages: 5,
    // Empty-scope pre-LLM skip (atomic #13): skip the Agent 3 (Scribe) LLM call when EVERY
    // message in the extraction window is trivially empty (pure asterisk actions, OOC, or very
    // short) per isTriviallyEmptyForExtraction. Saves a wasted call + tokens on no-content turns.
    agent3EmptyScopeSkip: true,
    // B3 (safe slice): trim ALREADY-EXTRACTED prior-context messages out of the Scribe's input.
    // When ON, prior messages already marked bf_mem_processed are not re-sent to the Scribe (their
    // facts are already stored) — a pure input-token saving with NO fact loss (new/unprocessed
    // content and the current exchange are always kept). Default OFF = unchanged behavior. The
    // larger "fire the Scribe only every N turns" batch is intentionally NOT implemented here: it
    // would require reworking the extraction commit/target state machine and risks silently dropping
    // or mis-attributing facts, so it is deferred to a test-driven change.
    scribeTrimProcessedPriors: false,
    // Temporal grounding at extraction (atomic, from mem0 'Observation Date'): pass the message's
    // real-world observation timestamp into the Scribe and instruct it to convert relative time
    // words ("yesterday","last week") into ABSOLUTE dates anchored to that timestamp, so stored
    // facts don't rot. Default ON. The date goes in the USER prompt block (system prefix stays
    // cache-stable); the resolution rule is appended to the system prompt only while this is on.
    temporalGrounding: true,
    // BI-TEMPORAL FACT VALIDITY (Graphiti/Zep valid_at/invalid_at). Default OFF. When ON, the
    // Scribe may tag a fact with story-world validity markers `| from:<when>` / `| until:<when>`
    // (free-form in-story time), parsed in agent-memory.js into the DISTINCT `validFrom`/`validUntil`
    // fields (NOT the existing `validAt` ordering integer). On supersession the OUTGOING fact's
    // `validUntil` is stamped, and the recall/push formatter annotates facts that carry a window —
    // so flashbacks/time-skips stay consistent. Purely additive + back-compat: when OFF the markers
    // are ignored, no fields are written, and output is byte-for-byte unchanged. Absent (older
    // settings) → default false.
    biTemporal: false,
    // Agent 2 (Writer) context limit: default 0 = off (main model sees full chat as ST
    // sends it). When > 0, we trim data.chat IN-PLACE to the last N user/AI messages
    // before sending — the main model sees only those + our injected facts. Lets you
    // shrink the prompt and rely on facts to replace older history. Reversible: just
    // change the slider back to 0.
    // C4/A1 default flip: fresh installs trim the main-model history to the last 10 user/AI
    // messages so stored facts REPLACE old turns instead of stacking on top (the core token win).
    // Existing users keep their stored value (often 0). 0 still means "no trim / full history".
    agent2ContextMessages: 10,
    // A2/B5 — FROZEN INJECTION. 0 = off (default; every turn runs the Drafter + Finder fresh). When
    // > 0, a genuine new turn REUSES the previous run's cached fact/scene injection (skipping those
    // two LLM calls) for up to this many turns before a full refresh. Saves tokens/latency AND keeps
    // the injected block byte-stable so a server-side prompt cache can reuse the prefix. Memory is
    // unaffected — the post-reply Scribe still extracts every turn; only the INJECTED facts may be up
    // to N turns stale. Clamp 0..20.
    injectionFreezeTurns: 0,
    // Writer recall tool (pull-detail / "infinite reach"). When ON, registers an optional
    // `search_memory` function-tool the MAIN model can call mid-generation to fetch a stored
    // fact that WASN'T pushed into its context. Default OFF so existing users and non-tool-
    // calling models are completely unaffected. Requires a tool-calling-capable main model;
    // only active on the main generation path (ST's tool loop never runs on the quiet/agent
    // paths). READ-ONLY: the tool never writes or deletes.
    // C4/A7 default flip: pull-on-demand recall is ON for fresh installs (Balanced/Cheap both use
    // it) so the Writer can fetch a fact that wasn't pushed, instead of pushing everything. Safe:
    // it only activates with a tool-calling main model; no-ops otherwise. Existing users keep theirs.
    enableWriterRecallTool: true,
    // Optional WRITE tool (`remember_fact`, Letta core_memory_append analogue): lets the MAIN model
    // PIN one fact directly into the active store mid-reply via an ST function-tool, complementing
    // the read-only search_memory pull tool above. ADD-ONLY (never deletes); routes through the same
    // upsertFact/saveDatabase path as extraction. Tool-first default flip: ON for fresh installs so
    // the main model (e.g. Claude) can PIN durable facts on demand, complementing the read-only
    // recall tool and the background Scribe extraction. Requires a tool-calling main model (ST's tool
    // loop never runs on the quiet/agent paths); no-ops otherwise. Existing users keep their saved
    // value. Synced alongside the recall tool wherever syncWriterRecallTool is synced (index.js + toggle).
    enableWriterWriteTool: true,
    // Tool-first redesign — MEMORY MODE: how stored memory reaches the main (reply) model.
    //   'hybrid'    (DEFAULT) each turn injects a cheap, no-LLM anchor (speculative facts +
    //               present-character anchors + scene block); the main model pulls everything
    //               deeper on demand via the search_memory tool. The blocking Agent 1 (Draft) LLM
    //               call is SKIPPED — this is the primary latency win.
    //   'tool-only' minimal anchor; recall is driven almost entirely by the model's tool calls.
    //   'push'      classic behavior — Agent 1 drafts the reply + picks fact branches every turn
    //               (an extra blocking LLM call). Choose this if your main model can't call tools.
    // Default 'hybrid' is tuned for tool-calling models (e.g. Claude via the Claude Code CLI
    // connection profile). Existing users keep whatever value is saved in their settings.
    memoryMode: 'hybrid',
    // Summary pyramid — optional "Big Picture" injection (hierarchical zoom-out). When ON, the
    // Writer gets a compact block = the rolling reflection story summary + the SHORT shelf
    // (category/aspect-bucket) summaries relevant to the current scene focus, hard token-capped.
    // Default OFF so behavior is byte-identical to today (respects the earlier decision to NOT
    // bloat every turn). Shelf summaries themselves are GENERATED regardless during the existing
    // reflection pass (cost-bounded: only changed buckets, capped per pass) and stored in
    // chat_metadata — this toggle only gates whether they're INJECTED. Absent (older settings)
    // → default false (back-compatible).
    // C4/A7 default flip: the compact "Big Picture" overview is ON for fresh installs (paired with
    // the recall tool: a tiny zoom-out the Writer anchors on, then drills via search_memory).
    // Hard token-capped (summaryPyramidMaxTokens). Existing users keep their stored value.
    enableSummaryPyramid: true,
    // Moment echo (Resonance Part B) — narrow, default-OFF proactive recall. When ON, each turn
    // MAY surface ONE tiny `[Echo: …]` line: a single resonant PAST moment for the PAIR of
    // characters present, cued either by a reflection-authored callback link that pays off in the
    // present context, or by the most-recent charged moment for that pair (never by shared place).
    // Capped at one echo, token-clamped, and emits NOTHING on most turns. Default OFF so the
    // injection is byte-identical to today until opted in (the agents warned auto-injection is the
    // bloat/attention-dilution risk; this keeps it high-precision + off by default). Build 1's full
    // relationship thread stays PULL-ONLY (search_memory) — this is just the one-line echo.
    enableMomentEcho: false,
    // Hard cap on the injected moment-echo line, in approx tokens (reuses the buildSceneBlock
    // char-budget truncation style). Deliberately tiny — ONE short beat, never a recap.
    momentEchoMaxTokens: 40,
    // Automatic associative linking (A-MEM style, lexical, DETERMINISTIC, zero-API). When ON, a
    // freshly-written fact is auto-connected to related EXISTING facts (same subject / shared
    // location / shared participants / lexical token overlap) by recording links into its
    // `relationships` — so asking about any one surfaces the others. Free + deterministic (no LLM),
    // so it DEFAULTS ON; the toggle lets a user disable it. Absent (older settings) => true.
    enableAutoLinking: true,
    // Hard cap on the injected Big Picture block, in approx tokens (reuses the buildSceneBlock
    // char-budget truncation style). Bounds prompt growth even with a huge store.
    summaryPyramidMaxTokens: 250,
    reviewInterval: 10,
    // Contradiction scan (atomic #7): every N reflection passes, flag facts that appear to
    // contradict (same/near key, different value) into the review popup. Heuristic, no LLM call.
    contradictionScanEnabled: true,
    contradictionInterval: 3,
    // Retrieval token budget (atomic #10): approx-token budget for injected secondary+tertiary
    // facts. Primary picks always kept + charged first; then secondary/tertiary admitted by
    // salience until the budget OR the MAX_SECONDARY/MAX_TERTIARY count caps are hit (smaller
    // wins). Replaces relying on count caps alone. Clamp 50..8000.
    retrievalTokenBudget: 800,
    // Recency cutoff (atomic #14): 0 = off. When > 0, secondary/tertiary facts created more
    // than N days ago are dropped from retrieval. Primary picks + legacy un-stamped facts are
    // never cut. Clamp 0..3650.
    recencyCutoffDays: 0,
    // MMR DIVERSITY RERANK (Graphiti/Zep maximal_marginal_relevance). Default ON. When admitting
    // secondary+tertiary overflow under the count/token caps, pure-salience ordering can let
    // several NEAR-DUPLICATE facts all get injected, wasting scarce slots. MMR reorders the
    // overflow candidates so each pick balances salience against being DIFFERENT from the
    // already-chosen set: score = lambda*normSalience - (1-lambda)*maxTrigramSim(c, chosen).
    // Uses the existing deterministic trigramSimilarity (no embeddings, no PRNG → swipe/regen
    // stable). Primary facts are untouched/always kept. mmrLambda: 1.0 = pure salience (no
    // diversity), 0.0 = pure diversity; 0.7 leans on salience while breaking up duplicates.
    mmrEnabled: true,
    mmrLambda: 0.7,
    // CONFIDENCE-GATED RETRIEVAL (Zep minRating + mem0 confidence). Facts may carry a
    // `confidence` field ('high'|'med'|'low' or a 0..1 number; parsed in agent-memory.js from the
    // `conf:` marker). When ON, that confidence folds into the OVERFLOW ranking (retrievalSalience)
    // as a bounded multiplier so low-confidence guesses lose scarce secondary/tertiary slots to
    // solid facts. Primary/exact/keyword matches are NEVER gated — they're always kept. Default ON.
    confidenceRanking: true,
    // How strongly confidence bends the overflow score. The multiplier is blended toward 1.0 by
    // (1 - confidenceWeight), so a small weight nudges ordering without ever zeroing a fact out:
    // effectiveMult = 1 - confidenceWeight * (1 - confidenceFactor). Clamp 0..1; small default.
    confidenceWeight: 0.3,
    // Full-chat rebuild concurrency (atomic #17): max parallel Scribe calls during a
    // "Run on current chat" backfill (shared DB object → no lost writes). Clamp 1..6.
    rebuildConcurrency: 3,
    // Semantic retrieval (atomic #1/#16). Default OFF. When on, facts are embedded (vector) on
    // write and the query is embedded at retrieval so facts match by MEANING, not just keyword/
    // trigram/graph. callEmbeddingAPI probes CMRS + known ST routes and GRACEFULLY NO-OPS if
    // none respond — safe to enable on any backend (retrieval just stays keyword-only).
    // C4/A3 default flip: semantic (vector) retrieval ON for fresh installs. GRACEFULLY no-ops when
    // no embedding endpoint responds (callEmbeddingAPI → null → keyword/trigram retrieval), so it is
    // safe to default-on: it only adds recall when an embedding model is actually configured.
    semanticRetrieval: true,
    embeddingProfile: '',                       // CMRS profile for embeddings (blank = reuse Agent 1's)
    embeddingSource: '',                        // ST vector source for embeddings (blank = derive from the active chat source, e.g. 'openrouter')
    embeddingModel: 'text-embedding-3-small',   // embedding model (auto-prefixed per source; openrouter → openai/text-embedding-3-small)
    semanticThreshold: 0.75,                    // min cosine similarity for a semantic hit
    // DEPRECATED (Feature #2a): retrieval tier inclusion is now DETERMINISTIC (capped,
    // no random dice). These keys are kept for settings persistence/back-compat and the
    // existing sliders, but no longer gate which facts get injected. Safe to remove the
    // UI later; the values are inert.
    secondaryChance: 50,
    tertiaryChance: 15,
    // Feature #4 — depth-dice sequence retrieval. For a relevant track we always include
    // the current step, then roll each depth tier (steps back) at these probabilities;
    // the furthest successful roll sets how far back we reach (contiguously). Stored as
    // 0..1 floats. Absent on older settings → defaults below apply (back-compatible).
    depthDice1: 0.70,
    depthDice2: 0.50,
    depthDice3: 0.25,
    depthDice4: 0.10,
    showToast: true,
    debugMode: false,
    // Verbose logging tier (opt-in firehose). When false, level:'verbose' entries are
    // DROPPED at ingestion (never enter the ring buffer or storage). RAM-only even when on.
    debugVerbose: false,
    // Scene card (always-on core working-memory block). When enabled, Agent 1 emits an
    // optional #SCENE block each turn (location / present / goals / last beat); we inject
    // a compact one-line [Scene] block ABOVE the fact list every turn a scene exists.
    // Absent (older settings) → default true; back-compatible (no scene = no injection).
    sceneCardEnabled: true,
    // Hard cap on the injected scene block, in approx tokens. Truncated defensively.
    sceneCardMaxTokens: 150,
    // Reflection / consolidation pass (memory-research Phase 3). Periodically (every
    // reflectionInterval successful pipeline runs) makes ONE extra LLM call — reusing
    // Agent 3's connection profile — to compress accumulated detail into (a) a rolling
    // "story so far" summary and (b) higher-order observation facts. INFREQUENT + cost-
    // aware by design (the owner has been burned by expensive full-chat passes). Default
    // ON but with a conservative interval. Absent (older settings) → defaults apply.
    reflectionEnabled: true,
    reflectionInterval: 12,
    // IDLE-TIME CONSOLIDATION (Letta sleeptime-agent pattern). In ADDITION to the every-N-turns
    // cadence above, arm an idle timer that runs the SAME maybeRunReflection() pass once the user
    // has been quiet for idleConsolidationMs. Lets heavy maintenance happen during dead time
    // instead of always on the turn boundary. OFF by default (opt-in); shares every reflection
    // guard (enabled, in-flight, group, character-changed) and never fires during generation.
    idleConsolidation: false,
    idleConsolidationMs: 120000,
    // DEPRECATED (refinement #1): the reflection "story so far" summary is NO LONGER
    // injected into the writer prompt under any circumstance. This key is retained inert
    // for back-compat (default now FALSE) so old saved settings don't error. Reflection
    // still runs as a silent dedupe-janitor / observation writer (refinement #4).
    reflectionInject: false,
    reflectionMaxTokens: 200,
    reflectionPrompt: '',
    // Character registry + NPC-promotion flow. Periodically (every characterCheckInterval
    // successful pipeline runs) scans the fact store for NEWLY-SEEN NAMED entities (proper
    // names in facts' involved/subject and the NPC drawer's `about`) that aren't yet
    // classified, and offers ONE batched popup to mark each Recurring / NPC / Later.
    // Deterministic scan (NO LLM call). Runs OFF the critical path on MESSAGE_RECEIVED, like
    // reflection. Absent (older settings) → defaults apply (back-compatible).
    characterRegistryEnabled: true,
    characterCheckInterval: 10,
    // SEMANTIC ENTITY RESOLUTION / MERGE (Graphiti node-dedup + mem0 entity-linking). When ON,
    // a CONSERVATIVE pass (run from the same OFF-critical-path entity-check cadence) merges
    // facts recorded under variant names for the SAME entity ("Bobby"/"Robert"/"Rob") into one
    // canonical subject, re-keying the loser's facts (reusing the promoteEntity re-key/collision
    // machinery) and recording an alias. Merge requires a STRONG signal only — exact alias/aka
    // match OR trigram name-similarity >= entityResolutionThreshold (default 0.85) AND the two
    // are NOT both already classified as distinct 'named' entities. Never merges {{user}}/{{char}}
    // /the active character. False merges are the main risk, so this is DEFAULT OFF and logs every
    // merge loudly. Deterministic (NO LLM call). Absent (older settings) → defaults apply.
    entityResolution: false,
    entityResolutionThreshold: 0.85,
    // Two-stage retrieval: STAGE 2 detail finder (Agent 4). When true (default), after
    // Agent 1 picks #Branches from the menu, Agent 4 reads the full facts under those
    // branches (+ all Unsorted) and chooses the relevant subset for injection. When false
    // (or on any finder error/empty), the pipeline falls back to deterministic retrieveFacts.
    // DEFAULT FLIPPED TO false (2026-05-31): the Finder is also HARD-DISABLED in pipeline.js
    // (see the long note at `const wantFinder = false`). It was redundant once semantic + graph +
    // anchors landed, and was timing out at scale anyway. Kept as a setting only for a future revert.
    useFinderAgent: false,
    // FINDER LATENCY BUDGET (ms). Max wall-clock the reply-blocking path may wait on the Stage-2
    // finder before falling back to the (already-computed) deterministic retrieval. On expiry the
    // in-flight finder LLM call is ABORTED (stops burning tokens). Lowered from the original 6000
    // to 3500 so a slow model adds at most ~3.5s, not ~6s, per turn. See the adaptive circuit
    // breaker in pipeline.js: after the finder blows the budget repeatedly it stops blocking at all.
    finderBudgetMs: 3500,
    // FINDER TARGET (soft floor): the finder aims for ~this many facts (a floor, not the hard cap)
    // so it returns a useful set instead of a tight 5–7. The hard ceiling stays the finder maxFacts.
    finderTargetFacts: 12,
    // GUARANTEED ANCHORS: how many key anchor facts (identity / current-state / active relationship)
    // per present character to always inject alongside the finder's picks, so the in-focus
    // character's anchors surface even if the finder misses them. 0 disables.
    finderAnchorsPerCharacter: 3,
    // USER-LEVEL SHARED MEMORY (Zep/mem0 user-scoping). Default OFF. When ON, facts whose SUBJECT
    // resolves to the user persona ({{user}}) are ALSO routed into a single shared, durable
    // "global user" store (a fixed pseudo-avatar record reusing the same IDB+attachment layer), and
    // on read that shared store is MERGED into the active character's fact map (dedupe by
    // category:key, the active character's own fact WINS on conflict). So the player's facts are
    // remembered by EVERY character instead of being re-learned per character. Purely additive +
    // back-compat: when OFF, storage AND retrieval are byte-identical to today (no shared store is
    // ever read or written). Absent (older settings) => default false.
    userLevelMemory: false,
    // Optional system-prompt override for Agent 4. Empty => DEFAULT_FINDER_PROMPT.
    finderPrompt: '',
    draftPrompt: '',
    memoryPrompt: '',
    writerFormat: '',
    dbProfiles: {},
    activeDbProfile: '',
    // Chats the user EXPLICITLY unlinked from every profile. autoSaveDbProfile must NOT
    // auto-create/re-link a profile for a chat in this set, so an unlink actually STICKS
    // across CHAT_CHANGED + reload (without it, re-entering the chat silently re-links and
    // the unlink "does nothing"). Re-linking a chat (Link Current Chat / link to a profile)
    // removes it from this set. Array of chat IDs; default empty => no detached chats.
    unlinkedChats: [],
    // USER TAXONOMY OVERLAY (persisted, GLOBAL across chats). Extra Layer-1 categories and
    // Layer-2 leaves the user added from the Database tab, merged ON TOP of the built-in
    // TAXONOMY by database.js (flatVocab/effectiveCategories/groupedTaxonomyMenu). DATA-ONLY +
    // ADDITIVE — never removes/shadows a built-in. Default empty => behaves byte-identically to
    // the built-in-only taxonomy. Shape:
    //   categories: string[]                         — extra L1 names
    //   aspects:    { [category]: string[] }         — extra leaves per category (snake_case)
    //   subAreas:   { [category]: { [subArea]: string[] } } — OPTIONAL grouping for the menu
    // The AI-expansion flow (a later task) writes to this SAME overlay.
    taxonomyOverlay: { categories: [], aspects: {}, subAreas: {} },
    // schemaVersion intentionally NOT in defaults: the merge-missing-defaults loop
    // would otherwise pre-fill it for existing users and short-circuit the migration.
    // migrateLegacySettings() sets it after running.
};

function getContext() {
    return SillyTavern.getContext();
}

export function getSettings() {
    return extensionSettings;
}

/**
 * A8: programmatically enable/disable the pipeline (used by the `/bfmem` slash command), mirroring
 * the Enable checkbox handler exactly: log the transition, persist, sync the checkbox + status, and
 * on disable cancel any in-flight run. Safe before the UI exists (the jQuery calls just no-op).
 * @param {boolean} next
 * @returns {boolean} the applied state
 */
export function setPipelineEnabled(next) {
    next = !!next;
    if (!extensionSettings) return next;
    if (next !== extensionSettings.enabled) {
        addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} via slash command`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled', via: 'slash' }, before: !!extensionSettings.enabled, after: next });
    }
    extensionSettings.enabled = next;
    saveSettings();
    try { $('#bf_mem_enabled').prop('checked', next); } catch { /* UI not ready */ }
    try { updateStatus('idle'); } catch { /* UI not ready */ }
    if (!next) {
        import('./pipeline.js').then(({ cancelActiveRun }) => cancelActiveRun?.('disabled')).catch(() => {});
    }
    return next;
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[EXTENSION_NAME] = extensionSettings;
    context.saveSettingsDebounced();
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clamp(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

function validateSettings(s) {
    s.contextMessages = Math.floor(clamp(s.contextMessages, 1, 50, 5));
    s.agent1ContextMessages = Math.floor(clamp(s.agent1ContextMessages, 1, 50, 5));
    s.agent3ContextMessages = Math.floor(clamp(s.agent3ContextMessages, 1, 20, 5));
    s.agent2ContextMessages = Math.floor(clamp(s.agent2ContextMessages, 0, 50, 0));
    // A2/B5 frozen injection: 0 = off; clamp to a sane window so it can't freeze forever.
    s.injectionFreezeTurns = Math.floor(clamp(s.injectionFreezeTurns, 0, 20, 0));
    s.reviewInterval  = Math.floor(clamp(s.reviewInterval,  3, 100, 10));
    s.contradictionInterval = Math.floor(clamp(s.contradictionInterval, 1, 50, 3));
    s.retrievalTokenBudget = Math.floor(clamp(s.retrievalTokenBudget, 50, 8000, 800));
    s.recencyCutoffDays = Math.floor(clamp(s.recencyCutoffDays, 0, 3650, 0));
    // MMR diversity rerank (default ON): boolean toggle + 0..1 lambda (salience vs diversity tradeoff).
    if (typeof s.mmrEnabled !== 'boolean') s.mmrEnabled = true;
    s.mmrLambda = clamp(s.mmrLambda, 0, 1, 0.7);
    // Confidence-gated retrieval (default ON): boolean toggle + small 0..1 blend weight.
    if (typeof s.confidenceRanking !== 'boolean') s.confidenceRanking = true;
    s.confidenceWeight = clamp(s.confidenceWeight, 0, 1, 0.3);
    s.rebuildConcurrency = Math.floor(clamp(s.rebuildConcurrency, 1, 6, 3));
    s.semanticThreshold = clamp(s.semanticThreshold, 0.1, 0.99, 0.75);
    s.secondaryChance = Math.floor(clamp(s.secondaryChance, 0, 100, 50));
    s.tertiaryChance  = Math.floor(clamp(s.tertiaryChance,  0, 100, 15));
    // Feature #4 depth-dice probabilities are 0..1 floats (not clamped to ints).
    s.depthDice1 = clamp(s.depthDice1, 0, 1, 0.70);
    s.depthDice2 = clamp(s.depthDice2, 0, 1, 0.50);
    s.depthDice3 = clamp(s.depthDice3, 0, 1, 0.25);
    s.depthDice4 = clamp(s.depthDice4, 0, 1, 0.10);
    if (typeof s.enabled !== 'boolean') {
        // FIX #10: log when a coercion silently flips a previously-true enable off.
        if (s.enabled === true || (s.enabled && s.enabled !== false)) {
            addDebugLog('fail', `enabled coerced to false (was non-boolean: ${JSON.stringify(s.enabled)})`);
        }
        s.enabled = false;
    }
    s.sceneCardMaxTokens = Math.floor(clamp(s.sceneCardMaxTokens, 30, 400, 150));
    // Reflection: interval clamped to a sane range (min 4 so it can't fire every turn);
    // token cap for the injected summary clamped small (it's continuity glue, not a dump).
    s.reflectionInterval = Math.floor(clamp(s.reflectionInterval, 4, 100, 12));
    s.reflectionMaxTokens = Math.floor(clamp(s.reflectionMaxTokens, 50, 500, 200));
    if (typeof s.reflectionEnabled !== 'boolean') s.reflectionEnabled = true;
    // Idle-time consolidation: opt-in toggle + idle delay. Delay clamped to a sane floor (30s,
    // so it can't thrash) and ceiling (30min) with the 2-minute default as fallback.
    if (typeof s.idleConsolidation !== 'boolean') s.idleConsolidation = false;
    s.idleConsolidationMs = Math.floor(clamp(s.idleConsolidationMs, 30000, 1800000, 120000));
    if (typeof s.reflectionInject !== 'boolean')  s.reflectionInject = false; // inert (refinement #1)
    if (typeof s.reflectionPrompt !== 'string')   s.reflectionPrompt = '';
    // Character registry: enable toggle + check interval (clamped 2..50 so it can't fire every
    // turn nor be set absurdly high). Defaults: enabled true, interval 10.
    if (typeof s.characterRegistryEnabled !== 'boolean') s.characterRegistryEnabled = true;
    s.characterCheckInterval = Math.floor(clamp(s.characterCheckInterval, 2, 50, 10));
    // Semantic entity resolution/merge: DEFAULT OFF (false-merge risk). Threshold clamped to a
    // high, conservative band [0.80..0.99] so it can't be loosened into noise; default 0.85.
    if (typeof s.entityResolution !== 'boolean') s.entityResolution = false;
    s.entityResolutionThreshold = clamp(s.entityResolutionThreshold, 0.80, 0.99, 0.85);
    // User-level shared memory: DEFAULT OFF (largest behavior change; opt-in only). When false,
    // the shared store is never touched, so storage+retrieval are byte-identical to today.
    if (typeof s.userLevelMemory !== 'boolean') s.userLevelMemory = false;
    if (typeof s.useMemoryProfile !== 'boolean') s.useMemoryProfile = true;
    if (typeof s.showToast !== 'boolean')        s.showToast = true;
    if (typeof s.debugMode !== 'boolean')        s.debugMode = false;
    if (typeof s.debugVerbose !== 'boolean')     s.debugVerbose = false;
    if (typeof s.sceneCardEnabled !== 'boolean') s.sceneCardEnabled = true;
    if (typeof s.memoryProfile !== 'string')     s.memoryProfile = '';
    if (typeof s.agent1Profile !== 'string')     s.agent1Profile = '';
    if (typeof s.agent3Profile !== 'string')     s.agent3Profile = '';
    if (typeof s.agent4Profile !== 'string')     s.agent4Profile = '';
    if (typeof s.finderProfile !== 'string')     s.finderProfile = '';
    // Accept `finderProfile` as an alias for `agent4Profile`: if only the alias is set,
    // fold it onto the canonical key so downstream code only reads agent4Profile.
    if (!s.agent4Profile && s.finderProfile) s.agent4Profile = s.finderProfile;
    if (typeof s.useFinderAgent !== 'boolean')   s.useFinderAgent = false; // Finder hard-disabled; default off to match DEFAULT_SETTINGS
    // Finder latency/target/anchor knobs (clamped to sane bounds; defaults match DEFAULT_SETTINGS).
    s.finderBudgetMs = Math.floor(clamp(s.finderBudgetMs, 1000, 15000, 3500));
    s.finderTargetFacts = Math.floor(clamp(s.finderTargetFacts, 0, 30, 12));
    s.finderAnchorsPerCharacter = Math.floor(clamp(s.finderAnchorsPerCharacter, 0, 8, 3));
    if (typeof s.enableWriterRecallTool !== 'boolean') s.enableWriterRecallTool = false;
    // Coercion matches the tool-first DEFAULT (true): an absent key (older saved settings) resolves
    // to ON, consistent with DEFAULT_SETTINGS, instead of contradicting it. Users who explicitly
    // saved `false` keep it (an explicit boolean passes this guard untouched).
    if (typeof s.enableWriterWriteTool !== 'boolean') s.enableWriterWriteTool = true;
    // Tool-first redesign — memory mode (how memory reaches the main model):
    //   'hybrid'    (default) light no-LLM anchor each turn + the model pulls deeper via search_memory
    //   'tool-only' minimal anchor; the model drives ALL recall through the tool
    //   'push'      classic behavior — Agent 1 (Draft) runs to plan + pick branches each turn
    // Anything absent/garbage coerces to 'hybrid'. 'hybrid'/'tool-only' DROP the blocking Agent 1
    // LLM call from the reply-critical path (the latency win); 'push' restores it.
    if (s.memoryMode !== 'push' && s.memoryMode !== 'tool-only' && s.memoryMode !== 'hybrid') s.memoryMode = 'hybrid';
    if (typeof s.enableSummaryPyramid !== 'boolean') s.enableSummaryPyramid = false;
    // Temporal grounding defaults ON (free, deterministic): absent/invalid => true (back-compat).
    if (typeof s.temporalGrounding !== 'boolean') s.temporalGrounding = true;
    // B3 safe slice — default OFF (absent/garbage => false = unchanged behavior).
    if (typeof s.scribeTrimProcessedPriors !== 'boolean') s.scribeTrimProcessedPriors = false;
    // Bi-temporal fact validity (opt-in) — default OFF; absent (older settings) => false (back-compat).
    if (typeof s.biTemporal !== 'boolean') s.biTemporal = false;
    // Moment echo (Resonance Part B) — default OFF; absent (older settings) => false (back-compat).
    if (typeof s.enableMomentEcho !== 'boolean') s.enableMomentEcho = false;
    s.momentEchoMaxTokens = Math.floor(clamp(s.momentEchoMaxTokens, 12, 120, 40));
    // Auto-linking defaults ON (free + deterministic): absent/invalid => true (back-compat).
    if (typeof s.enableAutoLinking !== 'boolean') s.enableAutoLinking = true;
    s.summaryPyramidMaxTokens = Math.floor(clamp(s.summaryPyramidMaxTokens, 50, 1000, 250));
    // C1 — usability preset id. One of the known ids or 'custom'; anything else (absent / garbage /
    // a renamed preset) coerces to 'custom' so the dropdown falls back safely. The actual knob
    // values are NOT touched here — detectPreset()/applyPreset() own that; this only guards the id.
    if (!PRESET_IDS.has(s.uiPreset)) s.uiPreset = 'custom';
    if (typeof s.finderPrompt !== 'string')      s.finderPrompt = '';
    if (typeof s.draftPrompt !== 'string')       s.draftPrompt = '';
    if (typeof s.memoryPrompt !== 'string')      s.memoryPrompt = '';
    if (typeof s.writerFormat !== 'string')      s.writerFormat = '';
    if (typeof s.activeDbProfile !== 'string')   s.activeDbProfile = '';
    if (!s.dbProfiles || typeof s.dbProfiles !== 'object' || Array.isArray(s.dbProfiles)) {
        s.dbProfiles = {};
    }
    // Explicitly-unlinked chats (detach set): coerce to a string array so the unlink-stick logic
    // can read it without defensive branching. Absent/malformed => empty (auto-link unchanged).
    if (!Array.isArray(s.unlinkedChats)) {
        s.unlinkedChats = [];
    } else {
        s.unlinkedChats = s.unlinkedChats.filter(id => typeof id === 'string' && id);
    }
    // User taxonomy overlay: coerce to the well-formed { categories[], aspects{}, subAreas{} }
    // shape so database.js can read it without defensive branching. Absent/malformed => empty.
    if (!s.taxonomyOverlay || typeof s.taxonomyOverlay !== 'object' || Array.isArray(s.taxonomyOverlay)) {
        s.taxonomyOverlay = { categories: [], aspects: {}, subAreas: {} };
    } else {
        const ov = s.taxonomyOverlay;
        if (!Array.isArray(ov.categories)) ov.categories = [];
        if (!ov.aspects || typeof ov.aspects !== 'object' || Array.isArray(ov.aspects)) ov.aspects = {};
        if (!ov.subAreas || typeof ov.subAreas !== 'object' || Array.isArray(ov.subAreas)) ov.subAreas = {};
    }
    return s;
}

function migrateLegacySettings(s) {
    // Skip if already migrated
    if ((s.schemaVersion ?? 0) >= 2) return;

    const context = getContext();
    const legacy = context.extensionSettings?.bf_memory;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        // Copy renamed fields ONLY if current is empty (don't clobber user's newer values)
        if (legacy.recentMessageCount !== undefined && (s.contextMessages === undefined || s.contextMessages === 5)) {
            const n = Number(legacy.recentMessageCount);
            if (Number.isFinite(n)) s.contextMessages = n;
        }
        if (typeof legacy.customExtractorPrompt === 'string' && !s.memoryPrompt) {
            s.memoryPrompt = legacy.customExtractorPrompt;
        }
        if (typeof legacy.customWriterRule === 'string' && !s.writerFormat) {
            s.writerFormat = legacy.customWriterRule;
        }
        if (typeof legacy.extractorProfileId === 'string' && !s.memoryProfile) {
            s.memoryProfile = legacy.extractorProfileId;
        }
        if (typeof legacy.useExtractorProfile === 'boolean' && s.useMemoryProfile === undefined) {
            s.useMemoryProfile = legacy.useExtractorProfile;
        }
        console.log('[BFMemory] Migrated legacy bf_memory settings (old key preserved for rollback)');
    }

    // v0.7: split single memoryProfile/contextMessages into per-agent settings.
    // Old fields are intentionally KEPT on the stored object for rollback safety.
    if (typeof s.memoryProfile === 'string' && s.memoryProfile && !s.agent1Profile && !s.agent3Profile) {
        s.agent1Profile = s.memoryProfile;
        s.agent3Profile = s.memoryProfile;
    }
    if (typeof s.contextMessages === 'number' && s.contextMessages !== 5 && !s.agent1ContextMessages) {
        s.agent1ContextMessages = s.contextMessages;
    }

    s.schemaVersion = 2;
}

// --- Status ---

export function updateStatus(status, message = '') {
    const dot = document.getElementById('bf_mem_status_dot');
    const text = document.getElementById('bf_mem_status_text');

    if (dot) {
        dot.className = 'bf-mem-status-dot';
        if (status === 'running') dot.classList.add('running');
        else if (status === 'error') dot.classList.add('error');
        else if (extensionSettings?.enabled) dot.classList.add('active');
    }

    if (text && message) {
        text.textContent = message;
    } else if (text) {
        text.textContent = extensionSettings?.enabled ? 'Active' : 'Disabled';
    }
}

// --- Debug Log (persistent — stored in chat_metadata.bf_mem_log so it survives page reload) ---

const LOG_META_KEY = 'bf_mem_log';

// FIX #8: ctx.saveMetadata() is DEBOUNCED — rapid addDebugLog bursts each schedule
// a save the next call supersedes, so only entries that happen to coincide with
// ST's own chat-save reach disk. We add a throttled IMMEDIATE chat save (at most
// once per LOG_FLUSH_THROTTLE_MS) plus a guaranteed synchronous flush on
// beforeunload (the primary fix, since reload is exactly when data is lost).
const LOG_FLUSH_THROTTLE_MS = 5000;
let lastLogFlushAt = 0;

// --- Persistent debug-log FILE (full firehose, incl. verbose) ---
// The chat_metadata slice above stays small & verbose-STRIPPED for instant load; the FULL
// RAM ring buffer (incl. verbose) is ALSO mirrored to a dedicated per-chat attachment file
// (bf_mem_debuglog_<chatId>.json) via database.js, reusing the fact-DB attachment infra.
// That re-uploads the whole file each write (ST has no append), so we THROTTLE it on the
// same cadence as the metadata flush and only force it on beforeunload.
const LOG_FILE_FLUSH_THROTTLE_MS = 15000; // file write is heavier than metadata — throttle harder
let lastLogFileFlushAt = 0;               // last successful/attempted file write
let logFileDirty = false;                 // entries changed since the last file write
let logFileWriteInFlight = false;         // guard against overlapping async uploads
// The chatId the in-RAM `debugLog` buffer currently belongs to. Tracked so a CHAT_CHANGED can
// flush the OUTGOING chat's tail to the OUTGOING chat's file BEFORE the buffer is swapped — by
// the time CHAT_CHANGED fires, getContext().chatId is already the NEW chat, so flushing to the
// live chatId would mis-file the old tail. Set whenever reloadDebugLogFromChat resolves a chatId.
let _logBufferChatId = '';
// FILE CAP: how many newest entries (incl. verbose) the file retains. Bounds the re-upload
// size — at ~0.5 KB/entry this is roughly a 1.5–2 MB JSON ceiling. Oldest entries beyond
// this are dropped (the RAM ring buffer is the smaller MAX_DEBUG_ENTRIES_MEM cap).
const MAX_DEBUG_ENTRIES_FILE = 4000;

// --- runId threading (debug-log redesign §2) ---
// Ambient current run id. Any addDebugLog with no explicit opts.runId inherits this, so
// leaf logs (db/retrieval/eviction) auto-group without taking a runId parameter. An explicit
// opts.runId always wins. pendingRun generalizes the old reflectionPending pattern: it carries
// the inline run's id across the MESSAGE_RECEIVED boundary so a turn's pre-reply and post-reply
// events (extraction, reflection) share ONE id. Stored here (not in pipeline.js) so endRun/the
// summary can read it; pipeline owns arming/consuming it via the helpers below.
let pendingRun = null;

/** Set the ambient run id for the current turn. Explicit opts.runId on a log still overrides. */
export function beginRun(runId) {
    currentRunId = runId || null;
    return currentRunId;
}

/** Clear the ambient run id. Call at the end of a turn's logging window. */
export function endRun() {
    currentRunId = null;
}

/** Current ambient run id (null when no run active). */
export function getCurrentRunId() {
    return currentRunId;
}

/**
 * Arm post-reply work to share the inline run's id across the MESSAGE_RECEIVED boundary.
 * Generalizes reflectionPending — the post-reply extraction path calls consumePendingRun()
 * (or beginRun(getPendingRun().runId)) so Agent 3 extraction + reflection tag the SAME run
 * the user saw start, instead of minting a fresh `M…` id.
 * @param {{runId:string, startTime?:number}} info
 */
export function setPendingRun(info) {
    pendingRun = info && info.runId ? { ...info } : null;
}

/** Peek the armed pendingRun without clearing it. */
export function getPendingRun() {
    return pendingRun;
}

/** Read AND clear the armed pendingRun (one-shot consume across the reply boundary). */
export function consumePendingRun() {
    const p = pendingRun;
    pendingRun = null;
    return p;
}

/** Best-effort immediate (non-debounced) persist of the debug log to chat .jsonl. */
function flushDebugLogNow() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();
        // Immediate, non-debounced chat write so the metadata reaches disk.
        if (typeof ctx.saveChat === 'function') ctx.saveChat();
        else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
        lastLogFlushAt = Date.now();
    } catch { /* best-effort */ }
    // Also force the FULL (incl-verbose) file to flush. This is async/fire-and-forget;
    // on beforeunload the browser may not await it, but the throttled writes during the
    // session mean at most the last <throttle-window of verbose entries are at risk —
    // the metadata slice (above) and earlier file writes already reached disk.
    try { void flushDebugLogFile(true); } catch { /* best-effort */ }
}

/**
 * Build the FULL file payload: the whole RAM ring buffer (incl. verbose) capped at
 * MAX_DEBUG_ENTRIES_FILE newest entries. Kept newest-first to match the buffer; the loader
 * preserves order. This is what lands in the dedicated attachment file (NOT chat_metadata).
 */
function buildFileEntries() {
    return debugLog.slice(0, MAX_DEBUG_ENTRIES_FILE);
}

/**
 * Throttled, best-effort write of the FULL debug log to its dedicated attachment file.
 * Re-uploading the whole file is expensive, so this respects LOG_FILE_FLUSH_THROTTLE_MS
 * and never overlaps an in-flight upload. `force` (beforeunload / explicit flush) bypasses
 * the throttle. Async + fire-and-forget from addDebugLog; all errors are swallowed inside
 * database.js so the RAM buffer is never at risk.
 * @param {boolean} [force]
 * @param {string|null} [chatIdOverride] - target this chatId instead of the live one. Used on
 *   CHAT_CHANGED to file the OUTGOING chat's tail against the OUTGOING chatId (the live chatId
 *   has already advanced to the new chat by the time the event fires).
 */
async function flushDebugLogFile(force = false, chatIdOverride = null) {
    if (!logFileDirty && !force) return;
    if (logFileWriteInFlight) return; // a write is already running; dirty flag stays set
    if (!force && (Date.now() - lastLogFileFlushAt < LOG_FILE_FLUSH_THROTTLE_MS)) return;
    let chatId = chatIdOverride || '';
    if (!chatId) {
        try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
    }
    if (!chatId) return; // no chat open — keep entries in RAM until one is
    logFileWriteInFlight = true;
    lastLogFileFlushAt = Date.now();
    const snapshot = buildFileEntries(); // capture before the await so concurrent appends aren't lost-tracked
    logFileDirty = false;                // optimistic; re-set on failure below
    try {
        const { saveDebugLogFile } = await import('./database.js');
        const ok = await saveDebugLogFile(chatId, snapshot);
        if (!ok) logFileDirty = true; // upload failed/skipped — retry on the next tick
    } catch {
        logFileDirty = true;          // never throws into callers; just mark for retry
    } finally {
        logFileWriteInFlight = false;
    }
}

/**
 * Build the persisted slice: verbose-STRIPPED (the firehose stays RAM-only) and capped at
 * MAX_DEBUG_ENTRIES_PERSIST, then byte-budgeted so the chat .jsonl round-trip can't bloat.
 */
function buildPersistSlice() {
    // Drop verbose entries entirely — they never reach disk. Old entries (no `level`) are kept.
    let slice = debugLog.filter(e => e.level !== 'verbose').slice(0, MAX_DEBUG_ENTRIES_PERSIST);
    // Byte guard: if the serialized slice exceeds the budget, trim oldest (tail) until under.
    try {
        while (slice.length > 1 && JSON.stringify(slice).length > LOG_PERSIST_BYTE_BUDGET) {
            slice = slice.slice(0, slice.length - 1);
        }
    } catch { /* serialization guard is best-effort */ }
    return slice;
}

function loadDebugLogFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return [];
        const stored = md[LOG_META_KEY];
        // Shape-check: must be array of {type, message, timestamp}
        if (!Array.isArray(stored)) return [];
        return stored
            .filter(e => e && typeof e === 'object' && typeof e.message === 'string')
            .map(backfillEntry);
    } catch { return []; }
}

/**
 * Back-fill a persisted entry that may pre-date the structured schema (just {type,message,
 * timestamp}). Additive: derives level/subsystem/ts/seq if absent and parses a leading
 * [Rxxxx]/[Mxxxx] runId prefix from the message so OLD logs still group. Never overwrites
 * fields that are already present.
 */
function backfillEntry(e) {
    if (e.v == null) e.v = 1;
    if (typeof e.type !== 'string') e.type = 'info';
    if (typeof e.level !== 'string') e.level = e.type; // legacy type is a valid 3-value level
    if (typeof e.subsystem !== 'string') e.subsystem = 'settings';
    if (e.runId == null) {
        const m = /^\[([RM][0-9a-z]+)\]/.exec(e.message || '');
        e.runId = m ? m[1] : null;
    }
    if (typeof e.seq !== 'number') e.seq = ++logSeq;
    if (typeof e.ts !== 'number') {
        const parsed = e.iso ? Date.parse(e.iso) : NaN;
        e.ts = Number.isFinite(parsed) ? parsed : Date.now();
    }
    return e;
}

function saveDebugLogToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return; // no chat loaded — log lives in-memory only until a chat opens
        md[LOG_META_KEY] = buildPersistSlice();
        ctx.saveMetadata?.();
        // FIX #8: throttled immediate flush so a burst of entries doesn't all get
        // lost to the debounce on reload. Bounded to once per LOG_FLUSH_THROTTLE_MS
        // to avoid thrashing disk; the beforeunload handler guarantees the tail.
        if (Date.now() - lastLogFlushAt >= LOG_FLUSH_THROTTLE_MS) {
            if (typeof ctx.saveChat === 'function') ctx.saveChat();
            else if (typeof ctx.saveChatConditional === 'function') ctx.saveChatConditional();
            lastLogFlushAt = Date.now();
        }
    } catch { /* best-effort */ }
}

/**
 * Re-load the debug log on chat open / CHAT_CHANGED. Two-stage:
 *   1) SYNC: load the small verbose-stripped chat_metadata slice for an INSTANT render.
 *   2) ASYNC: fetch the dedicated per-chat attachment FILE (the full firehose, incl.
 *      verbose) and, if it has more entries than the metadata slice, swap it in. The file
 *      is the superset/preferred source; the slice is just the fast first paint. A new chat
 *      with no file keeps the (possibly empty) metadata slice — graceful missing-file path.
 * A token guards against an out-of-order resolve when the user switches chats mid-fetch.
 */
let debugLogLoadToken = 0;

/**
 * Flush the OUTGOING chat's debug-log tail to ITS OWN file before the buffer is swapped to a new
 * chat. Must run on CHAT_CHANGED *before* reloadDebugLogFromChat(): at that point `debugLog` still
 * holds the old chat's entries and `_logBufferChatId` still names the old chat, but the live
 * getContext().chatId has already advanced — so we force-flush the full buffer against the tracked
 * old chatId. Best-effort + never throws. Without this, the last <throttle-window of (esp. verbose)
 * entries for the chat you're leaving would be lost.
 */
async function flushOutgoingChatLog() {
    const outgoing = _logBufferChatId;
    if (!outgoing) return;
    try { await flushDebugLogFile(true, outgoing); } catch { /* best-effort */ }
}

export function reloadDebugLogFromChat() {
    debugLog = loadDebugLogFromMeta();
    renderDebugLog();
    // Reset file-flush bookkeeping so the freshly-loaded chat starts clean.
    logFileDirty = false;
    const myToken = ++debugLogLoadToken;
    let chatId = '';
    try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
    // Remember which chat the RAM buffer now belongs to, so a later CHAT_CHANGED can flush this
    // chat's tail to this chat's file (see flushOutgoingChatLog).
    _logBufferChatId = chatId;
    if (!chatId) return;
    (async () => {
        try {
            const { loadDebugLogFile } = await import('./database.js');
            const fileEntries = await loadDebugLogFile(chatId);
            // Bail if the user switched chats (or this chat reloaded) while we were fetching.
            if (myToken !== debugLogLoadToken) return;
            if (Array.isArray(fileEntries) && fileEntries.length) {
                // The file is the superset (it carries verbose + more history). Prefer it
                // whenever it has at least as many entries as the metadata slice.
                const merged = fileEntries.map(backfillEntry).slice(0, MAX_DEBUG_ENTRIES_MEM);
                if (merged.length >= debugLog.length) {
                    debugLog = merged;
                    renderDebugLog();
                }
            }
        } catch { /* best-effort — keep the metadata slice already loaded */ }
    })();
}

/** Map a legacy `type` to a 5-value level (for existing 2-arg call sites). */
function typeToLevel(type) {
    return LOG_LEVELS.has(type) ? type : 'info';
}

/** Derive the 3-value legacy `type` from a 5-value level (so old readers never break). */
function levelToType(level) {
    return (level === 'fail' || level === 'pass') ? level : 'info';
}

/**
 * Append a debug-log entry. BACKWARD-COMPATIBLE:
 *   addDebugLog('info', 'message')                       // legacy 2-arg — unchanged behavior
 *   addDebugLog('info', 'message', { runId, subsystem,   // new structured form
 *     event, level, data, reason, actor, before, after })
 *
 * The stored entry ALWAYS keeps the legacy keys {type, message, timestamp} verbatim, so old
 * readers (renderDebugLog, exportLogs, the shape-check on load) keep working. New optional
 * fields are additive. `level` (5-value) is the superset of `type` (3-value); whichever is
 * supplied derives the other. Verbose entries are gated by the debugVerbose setting and are
 * NEVER persisted (RAM-only).
 *
 * @param {string} type  legacy type OR (when opts.level absent) the level shorthand
 * @param {string} message human-readable string (unchanged contract)
 * @param {object} [opts] { runId, level, subsystem, event, data, reason, actor, before, after }
 */
export function addDebugLog(type, message, opts = {}) {
    if (!opts || typeof opts !== 'object') opts = {};

    // Level/type derivation: opts.level (5-value) wins; else derive from the legacy `type`.
    const level = LOG_LEVELS.has(opts.level) ? opts.level : typeToLevel(type);
    const legacyType = levelToType(level);

    // Verbose gating: drop at INGESTION when the firehose toggle is off, so verbose never
    // costs ring-buffer space, render time, or storage.
    if (level === 'verbose' && !extensionSettings?.debugVerbose) return;

    const subsystem = LOG_SUBSYSTEMS.has(opts.subsystem) ? opts.subsystem : 'settings';
    // runId: explicit opts.runId overrides the ambient currentRunId set by beginRun().
    const runId = (opts.runId != null && opts.runId !== '') ? opts.runId : currentRunId;

    const now = new Date();
    const entry = {
        // --- legacy keys (kept EXACTLY for back-compat readers / text export) ---
        type: legacyType,
        message,
        timestamp: now.toLocaleTimeString(),
        // --- structured fields (additive, all optional to downstream readers) ---
        v: 1,
        ts: now.getTime(),
        iso: now.toISOString(),
        seq: ++logSeq,
        level,
        subsystem,
        runId: runId ?? null,
    };
    // Only attach optional structured fields when provided (keeps small entries small).
    if (opts.event != null) entry.event = opts.event;
    if (opts.data != null) entry.data = opts.data;
    if (opts.reason != null) entry.reason = opts.reason;
    if (opts.actor != null) entry.actor = opts.actor;
    if (opts.before !== undefined) entry.before = opts.before;
    if (opts.after !== undefined) entry.after = opts.after;

    // RAM ring buffer: newest-first, drop-oldest beyond MAX_DEBUG_ENTRIES_MEM.
    debugLog.unshift(entry);
    if (debugLog.length > MAX_DEBUG_ENTRIES_MEM) debugLog.length = MAX_DEBUG_ENTRIES_MEM;

    // Persist a verbose-stripped, byte-budgeted slice to chat_metadata (survives reload,
    // instant load). The FULL buffer (incl. verbose) goes to the dedicated attachment file.
    saveDebugLogToMeta();
    logFileDirty = true;
    void flushDebugLogFile(false); // throttled; async fire-and-forget (errors swallowed)
    renderDebugLog();
    // Tool-first redesign: refresh the "What Claude did" panel on tool-call events so memory
    // recalls/writes appear live. Cheap (scans the small ring buffer); guarded inside.
    if (entry.event === 'tool.search_memory' || entry.event === 'tool.remember_fact') renderToolActivity();

    if (extensionSettings?.debugMode) {
        const tag = level.toUpperCase();
        const sub = subsystem !== 'settings' ? ` ${subsystem}` : '';
        const rid = runId ? ` [${runId}]` : '';
        console.log(`[BFMemory] [${tag}]${rid}${sub} ${message}`);
    }
}

// Per-turn tool-call count beyond which a turn is flagged as a possible runaway tool loop (Phase 2
// observability). Soft — purely visual; nothing is blocked.
const TOOL_ACTIVITY_SOFTCAP = 8;

// Monotonic token guarding the async graph-view render against a race: a rapid second click starts
// a new render; only the LATEST may paint, so an earlier slow resolve can't overwrite a newer node.
let graphViewToken = 0;

/**
 * "What Claude did" panel (tool-first redesign). Scans the in-memory debug ring buffer for the
 * main model's memory tool calls (`search_memory` recall + `remember_fact` pin), groups them by
 * runId (one turn), and renders the most recent turns so the user can SEE the tool-driven memory
 * working. A high per-turn call count is flagged. Pure read of `debugLog`; safe to call anytime.
 */
function renderToolActivity() {
    const el = document.getElementById('bf_mem_tool_activity');
    if (!el) return; // panel not in DOM (older template / tab not built) — no-op
    const summaryEl = document.getElementById('bf_mem_tool_activity_summary');
    const calls = debugLog.filter(e => e.event === 'tool.search_memory' || e.event === 'tool.remember_fact');
    if (calls.length === 0) {
        el.innerHTML = '<div class="bf-mem-hint" style="opacity:.7;">No memory tool calls recorded yet. When the main model calls <code>search_memory</code> / <code>remember_fact</code>, they appear here.</div>';
        if (summaryEl) summaryEl.textContent = '';
        return;
    }
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // Group by runId (a turn), preserving the newest-first order of the buffer.
    const groups = new Map(); // runId -> { rid, search: [], write: [] }
    for (const e of calls) {
        const rid = e.runId || '(no turn id)';
        if (!groups.has(rid)) groups.set(rid, { rid, search: [], write: [] });
        const g = groups.get(rid);
        (e.event === 'tool.search_memory' ? g.search : g.write).push(e);
    }
    const turns = [...groups.values()].slice(0, 12); // most recent 12 turns
    let totalSearch = 0, totalWrite = 0;
    const html = turns.map(g => {
        const n = g.search.length + g.write.length;
        totalSearch += g.search.length; totalWrite += g.write.length;
        const hot = n > TOOL_ACTIVITY_SOFTCAP;
        const rows = [];
        for (const e of g.search) {
            const d = e.data || {};
            const cnt = d.resultCount != null ? d.resultCount : '?';
            rows.push(`<div class="bf-mem-tool-row"><span class="bf-mem-tool-badge bf-mem-tool-search">recall</span> <code>${esc(d.query || '')}</code>${d.category ? ` <span class="bf-mem-dim">[${esc(d.category)}]</span>` : ''}${d.with ? ` <span class="bf-mem-dim">with ${esc(d.with)}</span>` : ''} → <b>${esc(cnt)}</b> fact(s)</div>`);
        }
        for (const e of g.write) {
            const d = e.data || {};
            rows.push(`<div class="bf-mem-tool-row"><span class="bf-mem-tool-badge bf-mem-tool-write">pin</span> <code>${esc(d.category)}/${esc(d.key)}</code> = ${esc(String(d.value || '').slice(0, 80))}</div>`);
        }
        return `<details class="bf-mem-tool-turn" open>`
            + `<summary>Turn <code>${esc(g.rid)}</code> — ${g.search.length} recall, ${g.write.length} pin`
            + (hot ? ` <span class="bf-mem-tool-warn" title="High tool-call count this turn — possible runaway loop">⚠ ${n} calls</span>` : '')
            + `</summary>${rows.join('')}</details>`;
    }).join('');
    el.innerHTML = html;
    if (summaryEl) summaryEl.textContent = `${turns.length} turn(s) · ${totalSearch} recall, ${totalWrite} pin`;
}

/**
 * Graph view (Phase 4 — "true graphline memory" visibility). Resolves a fact by Category/key (or
 * bare key) and shows its linked neighbors: relationship-ref links (primary/secondary, the same
 * refs recall traversal follows) + one-hop scope-graph neighbors (place⇄event⇄people via expandLinks).
 * Neighbors are clickable to walk the graph. Read-only; lazy-imports the heavy db modules.
 * @param {string} keyQuery
 */
async function renderGraphView(keyQuery) {
    const el = document.getElementById('bf_mem_graph_result');
    if (!el) return;
    const myToken = ++graphViewToken; // this render's claim; a newer render supersedes it
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const q = String(keyQuery ?? '').trim();
    if (!q) { el.innerHTML = '<div class="bf-mem-hint">Enter a Category/key or key.</div>'; return; }
    el.innerHTML = '<div class="bf-mem-hint">Loading…</div>';
    try {
        const db = await import('./database.js');
        const fr = await import('./fact-retrieval.js');
        const databases = await db.getAllDatabases();
        const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        const slash = q.indexOf('/');
        const wantCat = slash >= 0 ? norm(q.slice(0, slash)) : null;
        const wantKey = norm(slash >= 0 ? q.slice(slash + 1) : q);
        let target = null, targetCat = null;
        for (const [cat, cdb] of Object.entries(databases)) {
            if (wantCat && norm(cat) !== wantCat) continue;
            for (const f of (cdb.facts || [])) { if (norm(f.key) === wantKey) { target = f; targetCat = cat; break; } }
            if (target) break;
        }
        if (!target) { el.innerHTML = `<div class="bf-mem-hint">No fact found for "<code>${esc(q)}</code>".</div>`; return; }
        const resolveRef = (ref) => {
            const rk = norm(ref);
            for (const [cat, cdb] of Object.entries(databases)) for (const f of (cdb.facts || [])) if (norm(f.key) === rk) return { cat, fact: f };
            return null;
        };
        const rels = target.relationships || {};
        const primary = (rels.primary || []).map(resolveRef).filter(Boolean);
        const secondary = (rels.secondary || []).map(resolveRef).filter(Boolean);
        // One-hop scope graph via the same exported helper recall uses (mutates the array in place).
        const seedRow = [{ fact: target, category: targetCat, tier: 'primary' }];
        const seen = new Set([`${targetCat}:${target.key}`]);
        try { fr.expandLinks(databases, seedRow, seen); } catch { /* best-effort */ }
        const scopeNeighbors = seedRow.slice(1).map(r => ({ cat: r.category, fact: r.fact }));
        const factLine = (cat, f) => `<a href="#" class="bf-mem-graph-link" data-key="${esc(cat)}/${esc(f.key)}"><code>${esc(cat)}/${esc(f.key)}</code></a> ${esc(String(f.value || f.note || '').slice(0, 80))}`;
        const section = (title, list) => list.length
            ? `<div class="bf-mem-graph-section"><div class="bf-mem-graph-title">${title} (${list.length})</div>${list.map(n => `<div class="bf-mem-graph-row">↳ ${factLine(n.cat, n.fact)}</div>`).join('')}</div>`
            : '';
        let html = `<div class="bf-mem-graph-node"><b>${esc(targetCat)}/${esc(target.key)}</b>: ${esc(String(target.value || '').slice(0, 160))}</div>`;
        html += section('Primary links', primary);
        html += section('Secondary links', secondary);
        html += section('Scope-graph neighbors (1 hop)', scopeNeighbors);
        if (!primary.length && !secondary.length && !scopeNeighbors.length) {
            html += '<div class="bf-mem-hint">No links yet — this fact is an island. Auto-linking connects facts that share a subject, location, or participants.</div>';
        }
        if (myToken !== graphViewToken) return; // a newer render started while we awaited — let it win
        el.innerHTML = html;
        el.querySelectorAll('.bf-mem-graph-link').forEach(a => a.addEventListener('click', (ev) => {
            ev.preventDefault();
            const k = a.getAttribute('data-key');
            const inp = document.getElementById('bf_mem_graph_key');
            if (inp) inp.value = k;
            renderGraphView(k);
        }));
    } catch (e) {
        el.innerHTML = `<div class="bf-mem-hint">Graph view error: ${esc(String(e).slice(0, 140))}</div>`;
    }
}

/**
 * "Recurring characters" entity panel (Phase 4). Lists the entity registry for this chat (named /
 * NPC / deferred) and lets the user PROMOTE an NPC/deferred entity to a first-class recurring
 * subject (re-keys its facts under its own name via promoteEntity). Lazy-imports agent-entities.js.
 */
async function renderEntityPanel() {
    const el = document.getElementById('bf_mem_entities_list');
    if (!el) return;
    const sumEl = document.getElementById('bf_mem_entities_summary');
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    try {
        const ent = await import('./agent-entities.js');
        const entities = ent.getEntities() || {};
        const names = Object.keys(entities);
        if (!names.length) {
            el.innerHTML = '<div class="bf-mem-hint" style="opacity:.7;">No entities tracked yet this chat. As characters recur, they appear here.</div>';
            if (sumEl) sumEl.textContent = '';
            return;
        }
        const badge = st => `<span class="bf-mem-ent-badge bf-mem-ent-${esc(st)}">${esc(st)}</span>`;
        el.innerHTML = names.sort().map(name => {
            const e = entities[name] || {};
            const st = e.status || 'deferred';
            const canPromote = st !== 'named';
            return `<div class="bf-mem-ent-row"><span class="bf-mem-ent-name">${esc(name)}</span> ${badge(st)}`
                + (Array.isArray(e.aliases) && e.aliases.length ? ` <span class="bf-mem-dim">aka ${esc(e.aliases.join(', '))}</span>` : '')
                + (canPromote ? ` <button class="menu_button bf-mem-ent-promote" data-name="${esc(name)}" title="Promote to a first-class recurring subject (re-keys its facts)">Mark recurring</button>` : '')
                + `</div>`;
        }).join('');
        if (sumEl) sumEl.textContent = `${names.length} entit${names.length === 1 ? 'y' : 'ies'}`;
        el.querySelectorAll('.bf-mem-ent-promote').forEach(b => b.addEventListener('click', async () => {
            const nm = b.getAttribute('data-name');
            b.disabled = true; b.textContent = 'Promoting…';
            try { const r = await ent.promoteEntity(nm); b.textContent = `Promoted (${r?.moved || 0} facts)`; }
            catch { b.textContent = 'Failed'; }
            setTimeout(() => renderEntityPanel(), 900);
        }));
    } catch (e) {
        el.innerHTML = `<div class="bf-mem-hint">Entity panel error: ${esc(String(e).slice(0, 140))}</div>`;
    }
}

// --- Debug-log filter state (client-side over the in-memory ring buffer) ---
// Level checkboxes default to fail+pass+info; debug/verbose opt-in. The verbose level is
// further gated by the debugVerbose SETTING (capture-side) — when off, verbose entries
// never enter the buffer regardless of this display filter.
const DEFAULT_LOG_LEVEL_FILTER = new Set(['fail', 'pass', 'info']);
let logLevelFilter = new Set(DEFAULT_LOG_LEVEL_FILTER);
let logSubsystemFilter = '';
let logSearchFilter = '';

/** Read the current filter UI into module state (no-op when the controls aren't mounted). */
function syncLogFilterFromUI() {
    const boxes = document.querySelectorAll('.bf-mem-log-level');
    if (boxes.length) {
        logLevelFilter = new Set();
        boxes.forEach(b => { if (b.checked) logLevelFilter.add(b.value); });
    }
    const sub = document.getElementById('bf_mem_log_subsystem');
    if (sub) logSubsystemFilter = sub.value || '';
    const search = document.getElementById('bf_mem_log_search');
    if (search) logSearchFilter = (search.value || '').trim().toLowerCase();
}

/** True if an entry passes the active level/subsystem/text filters. */
function entryMatchesFilter(entry) {
    const level = entry.level || entry.type || 'info';
    if (logLevelFilter.size && !logLevelFilter.has(level)) return false;
    if (logSubsystemFilter && (entry.subsystem || 'settings') !== logSubsystemFilter) return false;
    if (logSearchFilter) {
        const hay = (
            (entry.message || '') + ' ' +
            (entry.runId || '') + ' ' +
            (entry.event || '') + ' ' +
            (entry.subsystem || '') + ' ' +
            (entry.data != null ? safeStringify(entry.data) : '')
        ).toLowerCase();
        if (!hay.includes(logSearchFilter)) return false;
    }
    return true;
}

function safeStringify(v) {
    try { return JSON.stringify(v); } catch { return String(v); }
}

/** Compact human header for a run, derived from its run.summary entry's `data` blob. */
function formatRunSummary(runId, summaryEntry) {
    const shortId = runId || '(run)';
    if (!summaryEntry || !summaryEntry.data) {
        return `Run ${shortId}`;
    }
    const d = summaryEntry.data;
    const parts = [`Run ${shortId}`];
    if (Number.isFinite(d.durationMs)) parts.push(`${d.durationMs}ms`);
    if (d.agents) {
        const mark = (s) => s === 'ok' ? '✓' : s === 'failed' ? '✗' : s === 'skipped' ? '–' : '?';
        const ag = [];
        if (d.agents.agent1) ag.push(`Drafter${mark(d.agents.agent1)}`);
        if (d.agents.agent3) ag.push(`Scribe${mark(d.agents.agent3)}`);
        if (ag.length) parts.push(ag.join(' '));
    }
    if (d.facts) {
        const f = d.facts;
        const fstr = `facts ${f.NEW ?? 0}N/${f.UPDATED ?? 0}U/${f.SKIPPED ?? 0}S` +
            (f.EVICTED ? `/${f.EVICTED}E` : '');
        parts.push(fstr);
    }
    if (d.tokens && Number.isFinite(d.tokens.netIn)) {
        const n = d.tokens.netIn;
        const tok = Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
        parts.push(`${n >= 0 ? '+' : ''}${tok} tok`);
    }
    if (d.cancelled) parts.push('CANCELLED');
    return parts.join(' · ');
}

/** Render one entry as an HTML string (shared by flat + grouped paths). */
function renderEntryHtml(entry) {
    const level = entry.level || entry.type || 'info';
    const meta = [];
    if (entry.subsystem && entry.subsystem !== 'settings') meta.push(escapeHtml(subsystemLabel(entry.subsystem)));
    const metaHtml = meta.length ? `<span class="bf-mem-log-sub">${meta.join(' ')}</span> ` : '';
    return `
        <div class="bf-mem-debug-entry ${escapeHtml(level)}" data-event="${escapeHtml(entry.event || '')}" data-run="${escapeHtml(entry.runId || '')}">
            <span class="bf-mem-log-time">[${escapeHtml(entry.timestamp)}]</span> ${metaHtml}${escapeHtml(entry.message).replace(/\n/g, '<br>')}
        </div>`;
}

function renderDebugLog() {
    const container = document.getElementById('bf_mem_debug_log');
    if (!container) return;

    syncLogFilterFromUI();

    const total = debugLog.length;
    const visible = debugLog.filter(entryMatchesFilter);

    // Group visible entries by runId, newest run first. The ring buffer is already
    // newest-first, so the first time we see a runId fixes its display order. Entries with
    // no runId collect under a synthetic "Ungrouped / manual" block at the end.
    const order = [];
    const groups = new Map(); // runId -> entries[]
    const ungrouped = [];
    for (const e of visible) {
        const rid = e.runId;
        if (!rid) { ungrouped.push(e); continue; }
        if (!groups.has(rid)) { groups.set(rid, []); order.push(rid); }
        groups.get(rid).push(e);
    }

    // Map each runId to its summary entry (search the FULL buffer, not just the visible
    // slice, so a filtered-out summary still drives the header). Within a run, summary is
    // typically present once; fall back to a generic header when absent.
    const summaryByRun = new Map();
    for (const e of debugLog) {
        if (e.runId && e.event === 'run.summary' && !summaryByRun.has(e.runId)) {
            summaryByRun.set(e.runId, e);
        }
    }

    const blocks = [];
    for (const rid of order) {
        const entries = groups.get(rid);
        const summary = summaryByRun.get(rid);
        const headerLevel = (summary && (summary.level || summary.type)) || 'info';
        const header = escapeHtml(formatRunSummary(rid, summary));
        const body = entries.map(renderEntryHtml).join('');
        blocks.push(
            `<details class="bf-mem-run-group ${escapeHtml(headerLevel)}">` +
            `<summary>${header} <span class="bf-mem-run-count">(${entries.length})</span></summary>` +
            `<div class="bf-mem-run-body">${body}</div>` +
            `</details>`,
        );
    }
    if (ungrouped.length) {
        const body = ungrouped.map(renderEntryHtml).join('');
        blocks.push(
            `<details class="bf-mem-run-group ungrouped" open>` +
            `<summary>Ungrouped / manual <span class="bf-mem-run-count">(${ungrouped.length})</span></summary>` +
            `<div class="bf-mem-run-body">${body}</div>` +
            `</details>`,
        );
    }

    container.innerHTML = blocks.join('') ||
        '<div class="bf-mem-summary-empty">No log entries match the current filter.</div>';

    const countEl = document.getElementById('bf_mem_log_count');
    if (countEl) countEl.textContent = `showing ${visible.length} / ${total}`;
}

// --- Last Generated / Last Inserted Facts (replaces old Summary tab) ---

const GENERATED_META_KEY = 'bf_mem_generated';
const INSERTED_META_KEY = 'bf_mem_inserted';

function loadFactsFromMeta(key) {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        const stored = md[key];
        if (!stored || typeof stored !== 'object' || !Array.isArray(stored.updates)) return null;
        return stored;
    } catch { return null; }
}

function saveFactsToMeta(key, data) {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[key] = data;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

export function setLastGenerated(updates) {
    lastGenerated = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(GENERATED_META_KEY, lastGenerated);
    renderGenerated();
}

export function setLastInserted(updates) {
    lastInserted = {
        runId: Date.now(),
        timestamp: new Date().toLocaleTimeString(),
        updates: Array.isArray(updates) ? updates : [],
    };
    saveFactsToMeta(INSERTED_META_KEY, lastInserted);
    renderInserted();
}

/**
 * A4 — record what was INJECTED into the Writer this turn (the facts the reply was actually given,
 * plus an approximate token cost) and refresh the Injection Viewer. Called from pipeline.js right
 * after a successful injection. `facts` is the chosen `{fact, category, tier?}[]` (finder /
 * deterministic / speculative all share this shape). Best-effort + never throws.
 * @param {Array<{fact:Object, category:string, tier?:string}>} facts
 * @param {number} approxTokens - rough injected token cost (chars/4 of the injection block)
 */
export function setLastInjection(facts, approxTokens) {
    try {
        lastInjection = {
            runId: currentRunId || null,
            timestamp: Date.now(),
            facts: Array.isArray(facts) ? facts : [],
            approxTokens: Number(approxTokens) || 0,
        };
        renderInjectionViewer();
    } catch { /* viewer is best-effort — never break the turn */ }
}

// Cap rows rendered in the viewer so a huge injection can't bloat the DOM.
const INJECTION_VIEWER_MAX_ROWS = 60;

/**
 * A4 — render the Injection Viewer panel: a glanceable list of the facts injected last turn with a
 * one-line headline (count + approx tokens). Pure DOM render; no-ops if the panel isn't present.
 */
function renderInjectionViewer() {
    const el = document.getElementById('bf_mem_injection_view');
    if (!el) return;
    const facts = Array.isArray(lastInjection.facts) ? lastInjection.facts : [];
    if (facts.length === 0) {
        el.innerHTML = '<div class="bf-mem-summary-empty">Nothing injected yet. After a reply, the facts the Writer was given appear here.</div>';
        return;
    }
    const head = `<div class="bf-mem-hint" style="margin-bottom:6px;"><b>${facts.length}</b> fact(s) injected last turn · ≈<b>${lastInjection.approxTokens.toLocaleString()}</b> tokens</div>`;
    const rows = facts.slice(0, INJECTION_VIEWER_MAX_ROWS).map(({ fact, category, tier }) => {
        const t = (tier && typeof tier === 'string') ? tier[0].toUpperCase() : '';
        const badge = t ? `<span class="bf-mem-action-badge" title="${escapeHtml(tier)}">${t}</span> ` : '';
        const val = String(fact?.value ?? '').trim();
        const valHtml = val ? ` = ${escapeHtml(val.slice(0, 120))}` : '';
        return `<div class="bf-mem-fact-item">${badge}<span class="bf-mem-category">${escapeHtml(category)}</span> <strong>${escapeHtml(String(fact?.key ?? ''))}</strong>${valHtml}</div>`;
    }).join('');
    const more = facts.length > INJECTION_VIEWER_MAX_ROWS
        ? `<div class="bf-mem-hint">(+${facts.length - INJECTION_VIEWER_MAX_ROWS} more)</div>` : '';
    el.innerHTML = head + rows + more;
}

export function appendLastInserted(updates) {
    if (!Array.isArray(updates) || updates.length === 0) return;
    lastInserted.updates = [...(lastInserted.updates || []), ...updates];
    lastInserted.timestamp = new Date().toLocaleTimeString();
    saveFactsToMeta(INSERTED_META_KEY, lastInserted);
    renderInserted();
}

export function reloadFactsFromChat() {
    lastGenerated = loadFactsFromMeta(GENERATED_META_KEY) || { runId: null, timestamp: null, updates: [] };
    lastInserted = loadFactsFromMeta(INSERTED_META_KEY) || { runId: null, timestamp: null, updates: [] };
    renderGenerated();
    renderInserted();
}

function renderFactList(containerId, data, opts = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (data.runId === null) {
        container.innerHTML = `<div class="bf-mem-summary-empty">${escapeHtml(opts.emptyMsg || 'No pipeline runs yet.')}</div>`;
        return;
    }
    if (!data.updates || data.updates.length === 0) {
        container.innerHTML = `<div class="bf-mem-summary-empty">${escapeHtml(opts.zeroMsg || 'Last run extracted 0 facts.')}</div>`;
        return;
    }

    const header = `<div class="bf-mem-fact-header"><b>${escapeHtml(data.timestamp || '')}</b> · ${data.updates.length} fact${data.updates.length === 1 ? '' : 's'}</div>`;
    const items = data.updates.map(u => {
        const cat = escapeHtml(u.category || '?');
        const key = escapeHtml(u.key || '');
        const value = escapeHtml(String(u.value ?? ''));
        const knownBy = (u.knownBy || []).map(k => `<span class="bf-mem-chip">@${escapeHtml(k)}</span>`).join(' ');
        const tags = (u.tags || []).map(t => `<span class="bf-mem-chip bf-mem-chip-tag">#${escapeHtml(t)}</span>`).join(' ');
        const source = u.source ? `<span class="bf-mem-fact-source">from ${escapeHtml(u.source)}</span>` : '';
        const status = u.status
            ? `<span class="bf-mem-fact-status bf-mem-fact-status-${u.status.toLowerCase()}">${escapeHtml(u.status)}</span>`
            : '';
        return `
            <div class="bf-mem-fact-row">
                <div class="bf-mem-fact-line"><span class="bf-mem-fact-cat">${cat}</span> <code class="bf-mem-fact-key">${key}</code> = <span class="bf-mem-fact-val">${value}</span></div>
                <div class="bf-mem-fact-meta">${knownBy} ${tags} ${source} ${status}</div>
            </div>`;
    }).join('');
    container.innerHTML = header + items;
}

function renderGenerated() {
    renderFactList('bf_mem_generated_list', lastGenerated, {
        emptyMsg: 'No pipeline runs yet. Send a message to see what the Scribe extracts.',
        zeroMsg: 'Last run extracted 0 facts (the Scribe found nothing worth storing).',
    });
}

function renderInserted() {
    renderFactList('bf_mem_inserted_list', lastInserted, {
        emptyMsg: 'No pipeline runs yet.',
        zeroMsg: 'Nothing to insert (the Scribe returned no facts, or run was cancelled).',
    });
}

// --- Token Comparison (persistent — stored in chat_metadata.bf_mem_tokens) ---

const TOKENS_META_KEY = 'bf_mem_tokens';

function loadTokensFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return;
        const stored = md[TOKENS_META_KEY];
        if (stored && typeof stored === 'object') {
            // BRANCH TOKEN-RESET (Fix #3a): ST creates a branch by COPYING the parent chat's
            // chat_metadata, so a freshly-branched chat inherits the parent's bf_mem_tokens and the
            // Tokens tab shows the parent's stale counters until the branch's first run. We stamp
            // each saved record with the chatId it belongs to (ownerChatId); when the stored record's
            // owner does NOT match the current chat, it was inherited (branch copy or any metadata
            // clone) — so we DROP it and start this chat's own tally at zero rather than show
            // inherited numbers. A run on this chat re-stamps the record via saveTokensToMeta.
            const currentChatId = getCurrentChatId();
            const owner = typeof stored.ownerChatId === 'string' ? stored.ownerChatId : null;
            const inherited = !!currentChatId && owner !== null && owner !== currentChatId;
            if (inherited) {
                lastRunTokens = null;
                sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
                addDebugLog('info', `Tokens reset for inherited/branch chat ${currentChatId} (record owned by ${owner})`, {
                    subsystem: 'settings', event: 'tokens.reset', actor: 'SYSTEM', reason: 'BRANCH_INHERITED',
                    data: { chatId: currentChatId, ownerChatId: owner, isBranch: isBranchChat(currentChatId) },
                });
                // Re-stamp the metadata to this chat so it doesn't keep re-detecting as inherited.
                saveTokensToMeta();
                return;
            }
            lastRunTokens = (stored.lastRun && typeof stored.lastRun === 'object') ? stored.lastRun : null;
            sessionTokens = (stored.session && typeof stored.session === 'object')
                ? stored.session
                : { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
        }
    } catch { /* ignore */ }
}

function saveTokensToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        // Stamp the owning chatId so a later branch (which copies this metadata) can detect the
        // record as inherited and reset it instead of showing this chat's counters (see loadTokensFromMeta).
        md[TOKENS_META_KEY] = { lastRun: lastRunTokens, session: sessionTokens, ownerChatId: getCurrentChatId() || '' };
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

// Called by pipeline.js after a run's input metrics are known.
export function setRunTokens(run) {
    // Coerce every field to a finite number so a tokenizer returning undefined/NaN
    // can't poison the running session totals (they'd become NaN and stop adding up).
    const baselineInput = Number(run?.baselineInput) || 0;
    const actualInput   = Number(run?.actualInput) || 0;
    // Agent overhead now includes the Stage-2 finder (Agent 4). Scribe (agent3) is still folded
    // in later via addAgent3Tokens, and reflection via addReflectionTokens (both post-reply).
    const agentInput    = (Number(run?.agent1Input) || 0) + (Number(run?.agent3Input) || 0) + (Number(run?.finderInput) || 0);
    const agentOutput   = (Number(run?.agent1Output) || 0) + (Number(run?.agent3Output) || 0) + (Number(run?.finderOutput) || 0);

    lastRunTokens = { ...run, ts: Date.now(), approx: true };
    // accumulate session
    sessionTokens.baselineInput += baselineInput;
    sessionTokens.actualInput   += actualInput;
    sessionTokens.agentInput    += agentInput;
    sessionTokens.agentOutput   += agentOutput;
    // Only count this as a run if it produced at least one usable token figure.
    // A no-op run (all zero — e.g. tokenizer unavailable) would otherwise inflate
    // the run count and skew per-run averages.
    if (baselineInput || actualInput || agentInput || agentOutput) {
        sessionTokens.runs += 1;
    }
    saveTokensToMeta();
    renderTokens();
}

// Called by pipeline.js MESSAGE_RECEIVED handler once Agent 3 (memory extraction)
// runs off the blocking path. Agent 3 no longer participates in the pre-generation
// setRunTokens call, so its input/output tokens are folded into the session totals
// here WITHOUT bumping the run count (the run was already counted on the blocking
// path) and WITHOUT touching baseline/actual input. Also stamps the figures onto
// lastRunTokens so the per-run breakdown still shows the Agent 3 line.
export function addAgent3Tokens({ agent3Input = 0, agent3Output = 0 } = {}) {
    const inN = Number(agent3Input) || 0;
    const outN = Number(agent3Output) || 0;
    if (!inN && !outN) return;
    sessionTokens.agentInput += inN;
    sessionTokens.agentOutput += outN;
    if (lastRunTokens) {
        lastRunTokens.agent3Input = (Number(lastRunTokens.agent3Input) || 0) + inN;
        lastRunTokens.agent3Output = (Number(lastRunTokens.agent3Output) || 0) + outN;
    }
    saveTokensToMeta();
    renderTokens();
}

// Called by pipeline.js maybeRunReflection() once the (post-reply, off-blocking-path)
// reflection/consolidation pass completes. Mirrors addAgent3Tokens: folds the reflection
// LLM call's input/output into the session AGENT overhead totals WITHOUT bumping the run
// count (the run was already counted on the blocking path) and WITHOUT touching
// baseline/actual input. Stamps the figures onto lastRunTokens so the per-run breakdown
// shows the Reflection line. Reflection runs every N turns, so most runs add 0 here.
export function addReflectionTokens({ reflectionInput = 0, reflectionOutput = 0 } = {}) {
    const inN = Number(reflectionInput) || 0;
    const outN = Number(reflectionOutput) || 0;
    if (!inN && !outN) return;
    sessionTokens.agentInput += inN;
    sessionTokens.agentOutput += outN;
    if (lastRunTokens) {
        lastRunTokens.reflectionInput = (Number(lastRunTokens.reflectionInput) || 0) + inN;
        lastRunTokens.reflectionOutput = (Number(lastRunTokens.reflectionOutput) || 0) + outN;
    }
    saveTokensToMeta();
    renderTokens();
}

// Called by pipeline.js MESSAGE_RECEIVED handler when the main reply lands.
export function setMainOutputTokens(n) {
    const out = Number(n) || 0;
    if (lastRunTokens) lastRunTokens.mainOutput = out;
    sessionTokens.mainOutput += out;
    saveTokensToMeta();
    renderTokens();
}

export function reloadTokensFromChat() {
    lastRunTokens = null;
    sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
    loadTokensFromMeta();
    renderTokens();
}

// --- Scene Card (persistent — stored in chat_metadata.bf_mem_scene) ---
// Always-on "what is true right now" core block. Updated by Agent 1 each turn,
// injected above the fact list every turn (when enabled and a scene exists).

const SCENE_META_KEY = 'bf_mem_scene';
const SCENE_BEATS_MAX = 3; // rolling window: keep the last N one-line beats

// Scene-boundary detector (deterministic, NOT LLM-named). A new scene number is minted only when
// the location MATERIALLY changes. We compare the normalized (lowercased/trim/token-set) locations
// by Jaccard token overlap: when overlap is HIGH the locations are "the same place" (synonym drift
// like "the bar" -> "the dim bar", or room-flapping A->B->A back to a recently-seen place) and the
// scene number is held. Sticky on omission (a turn with no location keeps the current scene).
const SCENE_SIM_THRESHOLD = 0.5; // Jaccard token-overlap >= this => "same place" (hold the counter)
const SCENE_NAME_MAX = 60;       // hard clamp on a derived/refined scene name (lean storage)

/** Normalize a location string into a lowercased token set for similarity comparison. */
function sceneLocTokens(loc) {
    return new Set(
        String(loc || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, ' ')
            .split(/\s+/)
            // Drop tiny stop-ish tokens so "the bar" vs "bar" reads as identical.
            .filter(t => t.length >= 3 && !/^(the|and|for|with|near|into|onto)$/.test(t)),
    );
}

/**
 * Decide whether `nextLoc` is MATERIALLY different from `prevLoc` (a scene boundary). Returns false
 * (NOT a boundary) when either is empty (sticky on omission), when they normalize identically, or
 * when their token sets overlap at/above SCENE_SIM_THRESHOLD (synonym drift / minor rewording).
 * Pure + deterministic — no LLM, no randomness.
 * @param {string} prevLoc
 * @param {string} nextLoc
 * @returns {boolean}
 */
function isMaterialLocationChange(prevLoc, nextLoc) {
    const a = String(prevLoc || '').trim();
    const b = String(nextLoc || '').trim();
    if (!a || !b) return false;                 // sticky on omission (no location => keep scene)
    if (a.toLowerCase() === b.toLowerCase()) return false;
    const sa = sceneLocTokens(a);
    const sb = sceneLocTokens(b);
    if (sa.size === 0 || sb.size === 0) return false;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const union = sa.size + sb.size - inter;
    const jaccard = union > 0 ? inter / union : 0;
    return jaccard < SCENE_SIM_THRESHOLD;       // low overlap => a genuinely different place
}

/** Derive a default scene name from a location string (trimmed + clamped). */
function deriveSceneName(loc) {
    const s = String(loc || '').trim().replace(/\s+/g, ' ');
    return s.length > SCENE_NAME_MAX ? s.slice(0, SCENE_NAME_MAX).trim() : s;
}

/** Coerce a stored value into the scene shape, or return null if unusable. */
function normalizeScene(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const arr = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];
    const loc = typeof raw.location === 'string' ? raw.location.trim() : '';
    const present = arr(raw.present);
    const goals = arr(raw.goals);
    const beats = arr(raw.beats).slice(-SCENE_BEATS_MAX);
    // A scene is meaningful only if it carries at least one field.
    if (!loc && present.length === 0 && goals.length === 0 && beats.length === 0) return null;
    // Scene counter (Spiderweb 2): monotonic int starting at 1; name auto-derived from the
    // location by default (the Drafter MAY refine it but it is never required).
    const rawNo = Math.floor(Number(raw.sceneNo));
    const sceneNo = Number.isInteger(rawNo) && rawNo >= 1 ? rawNo : 1;
    let sceneName = typeof raw.sceneName === 'string' ? raw.sceneName.trim() : '';
    if (sceneName.length > SCENE_NAME_MAX) sceneName = sceneName.slice(0, SCENE_NAME_MAX).trim();
    if (!sceneName) sceneName = deriveSceneName(loc);
    return {
        location: loc,
        present,
        goals,
        beats,
        sceneNo,
        sceneName,
        // Branch-safe ownership stamp (mirrors the token-tab fix): the chatId that owns this record.
        ownerChatId: typeof raw.ownerChatId === 'string' ? raw.ownerChatId : '',
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadSceneFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        const scene = normalizeScene(md[SCENE_META_KEY]);
        if (!scene) return null;
        // BRANCH-SAFE SCENE OWNERSHIP (Spiderweb 2; mirrors the token-tab ownerChatId fix). ST
        // creates a branch by COPYING the parent chat's chat_metadata, so a freshly-branched chat
        // inherits the parent's bf_mem_scene record. We must not let the branch and parent
        // double-write the SAME record (corrupting the parent's scene state). When the stored
        // record's owner ≠ the current chat, it was inherited: we CONTINUE numbering from the
        // inherited sceneNo (the safer option per web-C — monotonic per chat, no jump back to a
        // beat the branch never produced) and RE-STAMP ownership to this chat so subsequent writes
        // target the branch's own record, leaving the parent's untouched.
        const currentChatId = getCurrentChatId();
        const owner = scene.ownerChatId || '';
        if (currentChatId && (!owner || owner !== currentChatId)) {
            scene.ownerChatId = currentChatId;
            sceneCard = scene;
            saveSceneToMeta(); // re-stamp so it stops re-detecting as inherited (or claim ownership of an unowned/legacy record)
            if (owner) {
                addDebugLog('info', `Scene inherited by branch chat ${currentChatId} (was owned by ${owner}); continuing at scene ${scene.sceneNo}`, {
                    subsystem: 'settings', event: 'scene.inherited', actor: 'SYSTEM', reason: 'BRANCH_INHERITED',
                    data: { chatId: currentChatId, ownerChatId: owner, sceneNo: scene.sceneNo, isBranch: isBranchChat(currentChatId) },
                });
            }
            return scene;
        }
        return scene;
    } catch { return null; }
}

function saveSceneToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[SCENE_META_KEY] = sceneCard;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/** Current scene card (or null). Read by pipeline.js to build the injection. */
export function getScene() {
    return sceneCard;
}

/**
 * Update the scene card from an Agent 1 #SCENE parse. Merges defensively:
 *   - location / present / goals: replaced when the new value is non-empty,
 *     otherwise the prior value is kept (Agent 1 may omit a field on a given turn).
 *   - beats: rolling window — append the newest beat(s), drop the oldest, cap at 3.
 * @param {{location?:string, present?:string[], goals?:string[], newBeats?:string[], name?:string}} patch
 * @param {string} runId
 */
export function setScene(patch, runId = '') {
    if (!patch || typeof patch !== 'object') return;
    const prev = sceneCard || { location: '', present: [], goals: [], beats: [], sceneNo: 1, sceneName: '' };
    const cleanArr = (v) => Array.isArray(v) ? v.map(x => String(x ?? '').trim()).filter(Boolean) : [];

    const location = (typeof patch.location === 'string' && patch.location.trim())
        ? patch.location.trim() : prev.location;
    const present = (Array.isArray(patch.present) && patch.present.length)
        ? cleanArr(patch.present) : prev.present;
    const goals = (Array.isArray(patch.goals) && patch.goals.length)
        ? cleanArr(patch.goals) : prev.goals;

    // Rolling beats window: append new beats, keep last SCENE_BEATS_MAX, de-dupe
    // a newest beat that exactly repeats the prior tail (Agent 1 echoing itself).
    let beats = [...(prev.beats || [])];
    for (const b of cleanArr(patch.newBeats)) {
        if (beats.length && beats[beats.length - 1] === b) continue;
        beats.push(b);
    }
    beats = beats.slice(-SCENE_BEATS_MAX);

    // SCENE COUNTER (Spiderweb 2). The number is a DETERMINISTIC, debounced boundary detector —
    // it advances only when the location MATERIALLY changes (isMaterialLocationChange: low token
    // overlap with the prior location). Synonym drift / room-flapping back to a recently-seen place
    // and turns with no location are sticky (the number holds). The advance is driven by the
    // (deterministic) location, NOT a per-run counter, so re-rolling/swiping the same message —
    // which yields the same location — does NOT bump the scene.
    const prevNo = Number.isInteger(prev.sceneNo) && prev.sceneNo >= 1 ? prev.sceneNo : 1;
    const boundary = isMaterialLocationChange(prev.location, location);
    const sceneNo = boundary ? prevNo + 1 : prevNo;

    // Scene NAME: the Drafter MAY refine it (patch.name, parsed leniently); otherwise the
    // location-derived name stands. On a boundary we always re-derive from the new location so the
    // name tracks the new scene unless the Drafter overrides; within a scene we keep the prior name
    // (or adopt a Drafter refinement / fill from the location if it was empty).
    const refined = (typeof patch.name === 'string' && patch.name.trim()) ? patch.name.trim() : '';
    let sceneName;
    if (refined) sceneName = refined;
    else if (boundary) sceneName = deriveSceneName(location);
    else sceneName = prev.sceneName || deriveSceneName(location);

    const next = normalizeScene({
        location, present, goals, beats, sceneNo, sceneName,
        ownerChatId: getCurrentChatId() || '',
        updatedAt: Date.now(), runId,
    });
    if (!next) return; // nothing meaningful to store

    if (boundary) {
        addDebugLog('info', `Scene advanced: ${prevNo} "${prev.sceneName || ''}" → ${next.sceneNo} "${next.sceneName}"`, {
            subsystem: 'settings', event: 'scene.advanced', actor: 'SYSTEM', reason: 'LOCATION_CHANGE',
            data: { fromNo: prevNo, toNo: next.sceneNo, fromName: prev.sceneName || '', toName: next.sceneName, fromLoc: prev.location || '', toLoc: location },
        });
    } else {
        addDebugLog('debug', `Scene continued: ${next.sceneNo} "${next.sceneName}"`, {
            subsystem: 'settings', event: 'scene.continued',
            data: { sceneNo: next.sceneNo, sceneName: next.sceneName, location },
        });
    }

    sceneCard = next;
    saveSceneToMeta();
    renderScene();
}

/** Re-load the scene card from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadSceneFromChat() {
    sceneCard = loadSceneFromMeta();
    renderScene();
}

/** Render the read-only live scene card in the Agent 1 tab (if present). */
function renderScene() {
    const el = document.getElementById('bf_mem_scene_view');
    if (!el) return;
    if (!sceneCard) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No scene yet. It updates each turn once the pipeline runs.</div>';
        return;
    }
    const s = sceneCard;
    const row = (label, val) => val ? `<div class="bf-mem-fact-line"><span class="bf-mem-fact-cat">${escapeHtml(label)}</span> ${escapeHtml(val)}</div>` : '';
    // Scene No + name (Spiderweb 2): the monotonic scene number + its (location-derived or
    // Drafter-refined) name, so the boundary detector is visible in the Agent 1 tab.
    const sceneLabel = Number.isInteger(s.sceneNo) ? `#${s.sceneNo}${s.sceneName ? ` · ${s.sceneName}` : ''}` : '';
    el.innerHTML =
        row('Scene', sceneLabel) +
        row('Location', s.location) +
        row('Present', (s.present || []).join(', ')) +
        row('Goals', (s.goals || []).join('; ')) +
        row('Recently', (s.beats || []).join('; '));
}

// --- Reflection / Consolidation (persistent — stored in chat_metadata.bf_mem_reflection) ---
// Rolling "story so far" summary + last synthesized observations. Mirrors the scene-card
// persistence pattern: per-chat, shape-checked reload, best-effort save.

const REFLECTION_META_KEY = 'bf_mem_reflection';

/** Coerce a stored value into the reflection shape, or null if unusable. */
function normalizeReflection(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
    const observations = Array.isArray(raw.observations)
        ? raw.observations.map(x => String(x ?? '').trim()).filter(Boolean)
        : [];
    if (!summary && observations.length === 0) return null;
    return {
        summary,
        observations,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadReflectionFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizeReflection(md[REFLECTION_META_KEY]);
    } catch { return null; }
}

function saveReflectionToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[REFLECTION_META_KEY] = reflection;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/** Current reflection summary object (or null). Read by pipeline.js for injection. */
export function getReflection() {
    return reflection;
}

/**
 * Store a fresh reflection (replaces the prior one — it's a rolling summary, not a log).
 * @param {{summary?:string, observations?:string[]}} patch
 * @param {string} runId
 */
export function setReflection(patch, runId = '') {
    const next = normalizeReflection({ ...(patch || {}), updatedAt: Date.now(), runId });
    if (!next) return; // nothing meaningful to store
    reflection = next;
    saveReflectionToMeta();
    renderReflection();
}

/** Re-load the reflection from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadReflectionFromChat() {
    reflection = loadReflectionFromMeta();
    renderReflection();
}

/** Render the read-only live reflection summary in the Agent 3 tab (if present). */
function renderReflection() {
    const el = document.getElementById('bf_mem_reflection_view');
    if (!el) return;
    if (!reflection) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No reflection yet. It is generated periodically once the pipeline has run several turns.</div>';
        return;
    }
    const r = reflection;
    let html = '';
    if (r.summary) html += `<div class="bf-mem-fact-line">${escapeHtml(r.summary)}</div>`;
    if ((r.observations || []).length) {
        html += '<div class="bf-mem-fact-meta" style="margin-top:6px;">' +
            r.observations.map(o => `<span class="bf-mem-chip bf-mem-chip-tag">${escapeHtml(o)}</span>`).join(' ') +
            '</div>';
    }
    el.innerHTML = html || '<div class="bf-mem-summary-empty">No reflection yet.</div>';
}

// --- Summary Pyramid (persistent — stored in chat_metadata.bf_mem_pyramid) ---
// Hierarchical zoom-out: a SHORT summary per (category, aspect) "shelf/bucket" rolling up
// into the whole-story summary (reused from reflection's #STORY). Mirrors the reflection
// persistence pattern: per-chat, shape-checked reload, best-effort save. Read by the writer
// injection builder (agent-writer.js) and written by the reflection pass (agent-reflect.js).

const PYRAMID_META_KEY = 'bf_mem_pyramid';

/** Coerce a stored value into the pyramid shape, or null if unusable. */
function normalizePyramid(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const story = typeof raw.story === 'string' ? raw.story.trim() : '';
    const shelves = {};
    if (raw.shelves && typeof raw.shelves === 'object' && !Array.isArray(raw.shelves)) {
        for (const [bucketKey, entry] of Object.entries(raw.shelves)) {
            if (!bucketKey || !entry || typeof entry !== 'object') continue;
            const text = typeof entry.text === 'string' ? entry.text.trim() : '';
            if (!text) continue; // an empty shelf summary carries no value — drop it
            shelves[String(bucketKey)] = {
                text,
                factCount: Number(entry.factCount) || 0,
                updatedAt: Number(entry.updatedAt) || Date.now(),
            };
        }
    }
    if (!story && Object.keys(shelves).length === 0) return null;
    return {
        story,
        shelves,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        runId: typeof raw.runId === 'string' ? raw.runId : '',
    };
}

function loadPyramidFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return null;
        return normalizePyramid(md[PYRAMID_META_KEY]);
    } catch { return null; }
}

function savePyramidToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[PYRAMID_META_KEY] = summaryPyramid;
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/**
 * Current summary pyramid object (or null). Read by agent-writer.js (Big Picture injection)
 * and agent-reflect.js (changed-bucket detection — compares stored shelf factCount/updatedAt
 * against the live index).
 * @returns {{story:string, shelves:Object<string,{text:string,factCount:number,updatedAt:number}>, updatedAt:number, runId:string}|null}
 */
export function getSummaryPyramid() {
    return summaryPyramid;
}

/**
 * Store a fresh summary pyramid (replaces the prior one — it's rolling derived state, not a
 * log). Mirrors setReflection. Best-effort persist to chat_metadata.
 * @param {{story?:string, shelves?:Object}} pyramid
 * @param {string} runId
 */
export function setSummaryPyramid(pyramid, runId = '') {
    const next = normalizePyramid({ ...(pyramid || {}), updatedAt: Date.now(), runId });
    if (!next) return; // nothing meaningful to store
    summaryPyramid = next;
    savePyramidToMeta();
}

/** Re-load the pyramid from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadPyramidFromChat() {
    summaryPyramid = loadPyramidFromMeta();
}

// --- Character Registry (live list in the Agent 3 tab) ---
// Read-only-ish list of known entities + their status, with a way to re-decide each
// (toggle status / re-scan). Storage + detection live in agent-entities.js; this is
// just the settings-panel surface. Persistence is per-chat (bf_mem_entities), reloaded
// on CHAT_CHANGED via reloadEntitiesFromChat() (wired in initSettings).

const ENTITY_STATUS_LABEL = { named: 'Recurring', npc: 'NPC', later: 'Later', pending: 'Pending' };

/** Render the Characters list (if the panel is present). */
function renderEntities() {
    const el = document.getElementById('bf_mem_charreg_list');
    if (!el) return;
    let reg = {};
    try { reg = getEntities() || {}; } catch { reg = {}; }
    const items = Object.values(reg)
        .filter(e => e && e.name)
        .sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.name).localeCompare(String(b.name)));

    if (items.length === 0) {
        el.innerHTML = '<div class="bf-mem-summary-empty">No characters tracked yet. They are discovered automatically as facts accumulate.</div>';
        return;
    }

    el.innerHTML = items.map(e => {
        const nm = escapeHtml(e.name);
        const status = ENTITY_STATUS_LABEL[e.status] || e.status || 'Pending';
        const sclass = `bf-mem-fact-status bf-mem-fact-status-${escapeHtml(String(e.status || 'pending').toLowerCase())}`;
        const count = Number(e.count) || 0;
        return `
            <div class="bf-mem-charreg-item bf-mem-fact-row" data-name="${nm}">
                <div class="bf-mem-fact-line">
                    <span class="bf-mem-fact-key">${nm}</span>
                    <span class="${sclass}" style="margin-left:6px;">${escapeHtml(status)}</span>
                    <span class="bf-mem-fact-source" style="margin-left:6px;">${count}×</span>
                </div>
                <div class="bf-mem-fact-meta">
                    <button class="bf-mem-charreg-set menu_button" data-name="${nm}" data-status="named" title="Mark recurring (promotes facts out of the NPC drawer)">Recurring</button>
                    <button class="bf-mem-charreg-set menu_button" data-name="${nm}" data-status="npc" title="Mark as one-off NPC">NPC</button>
                    <button class="bf-mem-charreg-set menu_button" data-name="${nm}" data-status="later" title="Defer">Later</button>
                </div>
            </div>`;
    }).join('');

    // Bind re-decide buttons (delegated rebind each render — list is small).
    el.querySelectorAll('.bf-mem-charreg-set').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.name;
            const status = btn.dataset.status;
            if (!name || !status) return;
            try {
                setEntityStatus(name, status);
                if (status === 'named') {
                    const res = await promoteEntity(name);
                    if (typeof toastr !== 'undefined') {
                        toastr.success(`"${name}" promoted (${res.moved} fact(s) moved)`, 'BF Memory');
                    }
                }
            } catch (err) {
                addDebugLog('fail', `Character re-decide for "${name}" failed: ${err.message || err}`);
            }
            renderEntities();
        });
    });
}

/** Re-load registry from chat + re-render. Called on CHAT_CHANGED. */
export function reloadEntitiesUI() {
    try { reloadEntitiesFromChat(); } catch { /* ignore */ }
    renderEntities();
}

function fmt(n) { return (typeof n === 'number' && Number.isFinite(n)) ? n.toLocaleString() : '—'; }

function renderTokens() {
    const lastEl = document.getElementById('bf_mem_tokens_lastrun');
    const sessEl = document.getElementById('bf_mem_tokens_session');
    const banner = document.getElementById('bf_mem_tokens_banner');
    if (!lastEl) return;

    if (!lastRunTokens) {
        lastEl.innerHTML = '<div class="bf-mem-summary-empty">No generations yet. Send a message — token comparison appears after the first pipeline run.</div>';
        if (sessEl) sessEl.innerHTML = '<div class="bf-mem-summary-empty">No generations yet this session.</div>';
        if (banner) banner.style.display = 'none';
        return;
    }

    const L = lastRunTokens;
    // Extension total now includes ALL four pipeline agents that make LLM calls:
    // Drafter (agent1), Scribe (agent3), Librarian/finder (Agent 4) and the Reflection pass.
    const fIn = L.finderInput || 0, fOut = L.finderOutput || 0;
    const rIn = L.reflectionInput || 0, rOut = L.reflectionOutput || 0;
    const extIn = (L.actualInput || 0) + (L.agent1Input || 0) + (L.agent3Input || 0) + fIn + rIn;
    const extOut = (L.mainOutput || 0) + (L.agent1Output || 0) + (L.agent3Output || 0) + fOut + rOut;
    const netIn = extIn - (L.baselineInput || 0);   // negative = saved
    const netOut = extOut - (L.mainOutput || 0);     // agent output overhead (always >= 0)

    // Trim-off detection: actual main input ~= baseline (within 3%)
    const trimOff = (L.baselineInput > 0) && (L.actualInput >= L.baselineInput * 0.97);
    if (banner) {
        banner.style.display = trimOff ? 'block' : 'none';
        banner.textContent = trimOff
            ? 'Writer trim is OFF — the main model sees the full chat, so there are no input savings. The agent calls below are pure overhead (the tradeoff for memory recall). Turn on "Context Limit" in the Writer tab to save input tokens.'
            : '';
    }

    const netInClass = netIn < 0 ? 'bf-mem-tok-save' : 'bf-mem-tok-bad';
    const netInStr = (netIn < 0 ? '' : '+') + fmt(netIn);

    lastEl.innerHTML = `
        <table class="bf-mem-db-table">
            <thead><tr><th></th><th>Input</th><th>Output</th></tr></thead>
            <tbody>
                <tr><td>Baseline (full chat)</td><td>${fmt(L.baselineInput)}</td><td>${fmt(L.mainOutput)}</td></tr>
                <tr><td>— Main model</td><td>${fmt(L.actualInput)}</td><td>${fmt(L.mainOutput)}</td></tr>
                <tr><td>— Drafter</td><td>${fmt(L.agent1Input)}</td><td>${fmt(L.agent1Output)}</td></tr>
                ${(fIn || fOut) ? `<tr><td>— Librarian (finder)</td><td>${fmt(fIn)}</td><td>${fmt(fOut)}</td></tr>` : ''}
                <tr><td>— Scribe</td><td>${fmt(L.agent3Input)}</td><td>${fmt(L.agent3Output)}</td></tr>
                <tr><td>— Reflection</td><td>${fmt(rIn)}</td><td>${fmt(rOut)}</td></tr>
                <tr><td><b>Extension total</b></td><td><b>${fmt(extIn)}</b></td><td><b>${fmt(extOut)}</b></td></tr>
                <tr><td><b>NET vs baseline</b></td><td class="${netInClass}">${netInStr}</td><td class="bf-mem-tok-cost">+${fmt(netOut)}</td></tr>
            </tbody>
        </table>
        <small class="bf-mem-hint">Approx. token counts (local tokenizer). Negative input = saved; output overhead is the agent calls.</small>`;

    if (sessEl) {
        const s = sessionTokens;
        const sExtIn = (s.actualInput || 0) + (s.agentInput || 0);
        const sExtOut = (s.mainOutput || 0) + (s.agentOutput || 0);
        const sNetIn = sExtIn - (s.baselineInput || 0);
        const sNetClass = sNetIn < 0 ? 'bf-mem-tok-save' : 'bf-mem-tok-bad';
        sessEl.innerHTML = `
            <table class="bf-mem-db-table">
                <thead><tr><th>${s.runs} run(s)</th><th>Input</th><th>Output</th></tr></thead>
                <tbody>
                    <tr><td>Baseline total</td><td>${fmt(s.baselineInput)}</td><td>${fmt(s.mainOutput)}</td></tr>
                    <tr><td>Extension total</td><td>${fmt(sExtIn)}</td><td>${fmt(sExtOut)}</td></tr>
                    <tr><td><b>NET</b></td><td class="${sNetClass}">${(sNetIn < 0 ? '' : '+') + fmt(sNetIn)}</td><td class="bf-mem-tok-cost">+${fmt(sExtOut - (s.mainOutput || 0))}</td></tr>
                </tbody>
            </table>`;
    }
}

function exportLogs() {
    // Export what the user is actually looking at: respect the active level/subsystem/search
    // filters so "Copy log" matches the on-screen view rather than dumping the whole buffer.
    try { syncLogFilterFromUI(); } catch { /* filter UI may not be mounted */ }
    const total = debugLog.length;
    const visible = debugLog.filter(entryMatchesFilter);
    const header = `=== BF Memory Pipeline Debug Logs ===\nExported: ${new Date().toISOString()}\nEntries: ${visible.length} of ${total} (filtered)\n${'='.repeat(40)}\n\n`;
    const logText = visible.map(entry => `[${entry.timestamp}] [${(entry.type || entry.level || 'info').toUpperCase().padEnd(5)}] ${entry.message}`).join('\n');
    const out = header + logText;
    addDebugLog('info', `Logs exported (${visible.length} of ${total} entries)`, {
        subsystem: 'settings', event: 'log.exported', actor: 'USER', data: { entryCount: visible.length, totalCount: total },
    });
    return out;
}

/**
 * Machine-readable export of the FULL RAM ring buffer (incl. debug/verbose when present) as
 * pretty JSON — the artifact for "investigate what changed why". Full `data` blobs included.
 * Returns the JSON string; callers handle download/clipboard.
 */
export function exportLogsJSON() {
    let chatId = null;
    try { chatId = getContext().chatId ?? null; } catch { /* no chat */ }
    return JSON.stringify({
        exportedAt: new Date().toISOString(),
        schemaVersion: 1,
        chatId,
        entries: debugLog,
    }, null, 2);
}

// --- Profile Dropdown ---

function reloadProfiles() {
    const agent1Select = document.getElementById('bf_mem_agent1_profile');
    const agent3Select = document.getElementById('bf_mem_agent3_profile');
    const agent4Select = document.getElementById('bf_mem_agent4_profile');
    if (!agent1Select && !agent3Select && !agent4Select) return;

    const profiles = getConnectionProfiles();
    const activeProfile = getCurrentProfileId();

    const populate = (select, savedValue) => {
        if (!select) return;
        const currentValue = select.value;
        select.innerHTML = '<option value="">-- Use default profile --</option>';
        profiles.forEach(profile => {
            const option = document.createElement('option');
            option.value = profile.id;
            option.textContent = profile.name + (profile.id === activeProfile ? ' (current)' : '');
            select.appendChild(option);
        });
        if (currentValue && profiles.find(p => p.id === currentValue)) {
            select.value = currentValue;
        } else if (savedValue) {
            select.value = savedValue;
        }
    };

    populate(agent1Select, extensionSettings?.agent1Profile);
    populate(agent3Select, extensionSettings?.agent3Profile);
    populate(agent4Select, extensionSettings?.agent4Profile);
}

/**
 * Enable/disable the embedding profile selector + "Test embedding endpoint" button to mirror the
 * Semantic-retrieval toggle: they're only meaningful when semantic is on. Idempotent + null-safe so
 * it can be called from the toggle handler and at init. Pure DOM, no behavior change to retrieval.
 */
function syncEmbeddingControls() {
    const on = extensionSettings?.semanticRetrieval === true;
    for (const id of ['bf_mem_embedding_source', 'bf_mem_embedding_model', 'bf_mem_test_embedding']) {
        const el = document.getElementById(id);
        if (el) el.disabled = !on;
    }
}

// --- Tabs ---

function setupTabs() {
    const tablist = document.querySelector('.bf-mem-tabs[role="tablist"]');
    if (!tablist) return;

    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));

    function activateTab(tab) {
        tabs.forEach(t => {
            t.setAttribute('aria-selected', 'false');
            t.setAttribute('tabindex', '-1');
            t.classList.remove('active');
            const panel = document.getElementById(t.getAttribute('aria-controls'));
            if (panel) panel.style.display = 'none';
        });

        tab.setAttribute('aria-selected', 'true');
        tab.setAttribute('tabindex', '0');
        tab.classList.add('active');

        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        if (panel) panel.style.display = '';

        // Refresh DB view when switching to database tab
        if (tab.getAttribute('aria-controls') === 'bf_mem_tab_database') {
            refreshDatabaseView();
        }
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => activateTab(tab));
        tab.addEventListener('keydown', (e) => {
            const idx = tabs.indexOf(tab);
            let target = null;
            if (e.key === 'ArrowRight') target = tabs[(idx + 1) % tabs.length];
            else if (e.key === 'ArrowLeft') target = tabs[(idx - 1 + tabs.length) % tabs.length];
            if (target) { e.preventDefault(); activateTab(target); }
        });
    });
}

// --- Database View ---

/**
 * Populate the "Add aspect" category dropdown with the built-in L1 order followed by any
 * user-added (custom) categories, preserving the current selection when possible. Custom
 * categories are suffixed " (custom)" so they're distinguishable.
 * @param {string[]} builtinOrder - MENU_CATEGORY_ORDER (built-in L1)
 * @param {Set<string>} customCats - user-added overlay category names
 * @returns {void}
 */
function populateAddLabelCategoryDropdown(builtinOrder, customCats) {
    const select = document.getElementById('bf_mem_addleaf_category');
    if (!select) return;
    const prev = select.value;
    const names = [...builtinOrder, ...[...customCats].filter(c => !builtinOrder.includes(c))];
    select.innerHTML = names.map(c =>
        `<option value="${escapeHtml(c)}">${escapeHtml(c)}${customCats.has(c) ? ' (custom)' : ''}</option>`
    ).join('');
    if (prev && names.includes(prev)) select.value = prev;
}

/**
 * Add a user Layer-2 leaf to the persisted taxonomy overlay (with dedup). Normalizes the surface
 * form, checks it against the EXISTING effective vocab + synonyms for the category; if already
 * covered, it logs a dedup redirect and does NOT add a duplicate. Otherwise it appends the leaf
 * (and its optional sub-area) to settings.taxonomyOverlay, persists, invalidates the taxonomy
 * memo, and refreshes the Database view.
 * @param {string} category - target Layer-1 category (built-in or custom)
 * @param {string} rawLeaf - raw user leaf input
 * @param {string} [rawSubArea] - optional sub-area grouping for the menu
 * @returns {Promise<void>}
 */
async function addUserLeaf(category, rawLeaf, rawSubArea) {
    const {
        canonicalizeLeafSurface, findExistingLeaf, invalidateTaxonomyOverlayCache, mapLegacyCategory,
    } = await import('./database.js');
    const cat = mapLegacyCategory(category); // canonical spelling (built-in or overlay)
    const leaf = canonicalizeLeafSurface(rawLeaf);
    if (!leaf) {
        toastr.warning('Enter a valid aspect name.', 'BF Memory');
        return;
    }
    // Dedup: already a leaf or a known synonym of an existing leaf for this category.
    const existing = findExistingLeaf(leaf, cat);
    if (existing) {
        addDebugLog('info', `Label not added — "${leaf}" already covered by "${existing}" (${cat})`, {
            subsystem: 'settings', event: 'label.merged', reason: 'SYNONYM_DEDUP', actor: 'USER',
            data: { tier: 'aspect', category: cat, label: leaf, existing },
        });
        toastr.info(`"${leaf}" is already covered by "${existing}".`, 'BF Memory');
        return;
    }

    // Persist into the overlay (well-formed shape guaranteed by validateSettings).
    const ov = extensionSettings.taxonomyOverlay = extensionSettings.taxonomyOverlay || { categories: [], aspects: {}, subAreas: {} };
    if (!Array.isArray(ov.aspects[cat])) ov.aspects[cat] = [];
    ov.aspects[cat].push(leaf);
    const subArea = String(rawSubArea || '').trim();
    if (subArea) {
        if (!ov.subAreas[cat] || typeof ov.subAreas[cat] !== 'object') ov.subAreas[cat] = {};
        if (!Array.isArray(ov.subAreas[cat][subArea])) ov.subAreas[cat][subArea] = [];
        ov.subAreas[cat][subArea].push(leaf);
    }
    saveSettings();
    invalidateTaxonomyOverlayCache();
    addDebugLog('pass', `Custom aspect added: "${leaf}" → ${cat}${subArea ? ` (${subArea})` : ''}`, {
        subsystem: 'settings', event: 'label.added', actor: 'USER',
        data: { tier: 'aspect', category: cat, label: leaf, subArea: subArea || undefined },
    });
    toastr.success(`Added aspect "${leaf}" to ${cat}.`, 'BF Memory');
    const nameEl = document.getElementById('bf_mem_addleaf_name');
    const subEl = document.getElementById('bf_mem_addleaf_subarea');
    if (nameEl) nameEl.value = '';
    if (subEl) subEl.value = '';
    refreshDatabaseView();
}

/**
 * Add a user Layer-1 category to the persisted taxonomy overlay (with dedup against built-ins +
 * existing overlay categories). Persists, invalidates the taxonomy memo, and refreshes the view.
 * @param {string} rawName - raw user category name
 * @returns {Promise<void>}
 */
async function addUserCategory(rawName) {
    const { MENU_CATEGORY_ORDER, effectiveCategories, invalidateTaxonomyOverlayCache } = await import('./database.js');
    // Keep the user's casing but trim; reject empty.
    const name = String(rawName || '').trim().replace(/\s+/g, ' ');
    if (!name) {
        toastr.warning('Enter a category name.', 'BF Memory');
        return;
    }
    const lc = name.toLowerCase();
    const existing = effectiveCategories().find(c => c.toLowerCase() === lc);
    if (existing) {
        const isBuiltin = MENU_CATEGORY_ORDER.some(c => c.toLowerCase() === lc);
        addDebugLog('info', `Category not added — "${name}" already exists as "${existing}"`, {
            subsystem: 'settings', event: 'label.merged', reason: 'SYNONYM_DEDUP', actor: 'USER',
            data: { tier: 'category', category: name, label: name, existing },
        });
        toastr.info(`Category "${existing}" already exists${isBuiltin ? ' (built-in)' : ''}.`, 'BF Memory');
        return;
    }
    if (!confirm(`Add a new top-level category "${name}"?`)) return;

    const ov = extensionSettings.taxonomyOverlay = extensionSettings.taxonomyOverlay || { categories: [], aspects: {}, subAreas: {} };
    if (!Array.isArray(ov.categories)) ov.categories = [];
    ov.categories.push(name);
    saveSettings();
    invalidateTaxonomyOverlayCache();
    addDebugLog('pass', `Custom category added: "${name}"`, {
        subsystem: 'settings', event: 'label.added', actor: 'USER',
        data: { tier: 'category', category: name, label: name },
    });
    toastr.success(`Added category "${name}".`, 'BF Memory');
    const nameEl = document.getElementById('bf_mem_addcat_name');
    if (nameEl) nameEl.value = '';
    refreshDatabaseView();
}

/**
 * AI "Suggest new labels" handler (Database tab button). MANUAL, on-demand: mines the fact DB
 * for homeless facts, makes ONE LLM call (taxonomy-suggest.js, Scribe/Agent-3 profile), then
 * shows the parsed proposals in a MANDATORY human-approval popup. Approved leaves are written
 * through the SAME overlay path the manual "Add your own label" controls use (addUserLeaf /
 * addUserCategory) so dedup/canonicalization/cache-invalidation/refresh are identical — re-running
 * dedup here is correct (a proposal that collides with an existing/just-added leaf is absorbed as
 * a synonym, not duplicated). NOTHING is added without explicit approval. Never throws into the UI.
 * @returns {Promise<void>}
 */
async function onSuggestLabelsClick() {
    const btn = document.getElementById('bf_mem_suggest_labels_btn');
    if (btn && btn.dataset.busy === '1') return; // guard against double-click while the call is in flight
    if (btn) { btn.dataset.busy = '1'; btn.disabled = true; }
    try {
        const { getAgent3ProfileId } = await import('./profiler.js');
        const { runLabelSuggestion } = await import('./taxonomy-suggest.js');
        const profileId = getAgent3ProfileId(extensionSettings);

        toastr.info('Scanning facts and asking the model for label ideas…', 'BF Memory');
        const result = await runLabelSuggestion({ profileId });

        if (result.noCandidates) {
            toastr.info('No homeless facts to analyze — everything already has a specific home.', 'BF Memory');
            return;
        }
        if (result.error) {
            toastr.error(`Suggest labels failed: ${result.error}`, 'BF Memory');
            return;
        }
        if (result.proposals.length === 0 && result.synonyms.length === 0) {
            toastr.info(`Analyzed ${result.candidateCount} fact(s); the model proposed no new labels.`, 'BF Memory');
            return;
        }
        await showLabelSuggestionsPopup(result);
    } catch (err) {
        addDebugLog('fail', `Suggest labels handler failed (non-fatal): ${err.message || err}`);
        toastr.error('Suggest labels failed. See the Debug tab for details.', 'BF Memory');
    } finally {
        if (btn) { btn.dataset.busy = '0'; btn.disabled = false; }
    }
}

/**
 * MANDATORY human-approval popup for AI-suggested labels. Reuses ST's Popup API (same
 * Popup + POPUP_TYPE.TEXT + custom OK/Cancel pattern showEntityPopup uses). Each NEW-leaf
 * proposal gets an Approve/Reject radio (default Reject — dismiss-safe); map-to-existing
 * synonym suggestions are shown read-only (informational; v1 doesn't auto-refile). On Save,
 * each Approved proposal is written via addUserCategory (new category) + addUserLeaf (leaf) —
 * the same dedup+persist+invalidate+refresh the manual controls use. NOTHING is added unless
 * the user explicitly Approves it and clicks Save.
 *
 * NOTE (v1): approved labels are ADDED to the taxonomy only — existing homeless facts are NOT
 * auto-refiled onto the new leaf. The late-bound aspect resolver + future Scribe turns pick the
 * new label up. (TODO: optional opt-in refile via a safe upsertFact of just the clustered facts.)
 *
 * @param {{proposals: Array, synonyms: Array, candidateCount: number}} result
 * @returns {Promise<void>}
 */
async function showLabelSuggestionsPopup(result) {
    const proposals = result.proposals || [];
    const synonyms = result.synonyms || [];

    const ok = await ensurePopup();
    if (!ok || !Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    const proposalRows = proposals.map((p, idx) => {
        const grp = `bf_mem_suggest_choice_${idx}`;
        const examples = (p.examples || []).length
            ? `<div class="bf-mem-suggest-examples" style="font-size:0.85em;opacity:0.8;margin-top:2px;">e.g. ${p.examples.map(e => escapeHtml(e)).join('; ')}</div>`
            : '';
        const catBadge = p.newCategory ? ` <span class="bf-mem-action-badge" title="A brand-new top-level category">NEW CAT</span>` : '';
        return `
            <div class="bf-mem-suggest-row" data-idx="${idx}" style="display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                <div><b>${escapeHtml(p.category)}</b> ▸ ${escapeHtml(p.subArea || 'Custom')} ▸ <b>${escapeHtml(p.label)}</b>${catBadge}</div>
                ${p.definition ? `<div style="font-size:0.9em;">${escapeHtml(p.definition)}</div>` : ''}
                ${examples}
                <div class="bf-mem-suggest-choices" style="display:flex;gap:14px;flex-wrap:wrap;">
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="approve" /> <span>Approve</span></label>
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="reject" checked /> <span>Reject</span></label>
                </div>
            </div>`;
    }).join('');

    const synonymRows = synonyms.length
        ? `<div class="bf-mem-suggest-synonyms" style="margin-top:10px;">
                <h4 style="margin:0 0 4px 0;">Already covered (the model suggests these clusters fit an existing leaf — informational, not added)</h4>
                ${synonyms.map(s => `<div style="font-size:0.9em;padding:2px 0;">${escapeHtml(s.category)}/<b>${escapeHtml(s.leaf)}</b>${s.reason ? ` — ${escapeHtml(s.reason)}` : ''}</div>`).join('')}
            </div>`
        : '';

    const html = `
        <div class="bf-mem-suggest-popup" data-count="${proposals.length}">
            <h3>AI label suggestions (${proposals.length})</h3>
            <p>Reviewed ${result.candidateCount} homeless fact(s). Approve the labels you want added to your taxonomy. Approved labels are de-duplicated against the existing vocab before they're added. Nothing is added unless you Approve it and click Save.</p>
            ${proposals.length ? `<div class="bf-mem-suggest-list" style="max-height:50vh;overflow-y:auto;">${proposalRows}</div>` : '<p><i>No new-label proposals.</i></p>'}
            ${synonymRows}
        </div>`;

    let decisions = [];
    try {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
            okButton: 'Save approved',
            cancelButton: 'Cancel (add nothing)',
            wide: true,
            allowVerticalScrolling: true,
        });
        const popupResult = await popup.show();
        const root = popup.dlg || popup.content || document;
        const cancelled = !popupResult;
        if (!cancelled) {
            root.querySelectorAll('.bf-mem-suggest-row')?.forEach((row) => {
                const idx = parseInt(row.getAttribute('data-idx'), 10);
                const p = proposals[idx];
                if (!p) return;
                const sel = row.querySelector('input[type="radio"]:checked');
                if (sel && sel.value === 'approve') decisions.push(p);
            });
        }
    } catch (err) {
        addDebugLog('fail', `Suggest labels popup failed (non-fatal): ${err.message || err}`);
        return;
    }

    if (decisions.length === 0) {
        addDebugLog('info', `Suggest labels: user approved 0 of ${proposals.length} proposal(s)`, {
            subsystem: 'settings', event: 'taxonomy.suggest', reason: 'NONE_APPROVED', actor: 'USER',
            data: { proposed: proposals.length },
        });
        toastr.info('No labels added.', 'BF Memory');
        return;
    }

    // Apply approved proposals through the SAME overlay path the manual add controls use. A new
    // category is added first (so its leaf can attach to it), then the leaf — both re-run their
    // own dedup (a collision is absorbed as a synonym, never duplicated). They each persist,
    // invalidate the taxonomy memo, and refresh the Database view, and emit label.added /
    // label.merged logs, so no extra wiring is needed here.
    for (const p of decisions) {
        try {
            if (p.newCategory) {
                await addUserCategory(p.category);
            }
            await addUserLeaf(p.category, p.label, p.subArea);
        } catch (err) {
            addDebugLog('fail', `Suggest labels: failed to add "${p.category}/${p.label}" (non-fatal): ${err.message || err}`);
        }
    }
    addDebugLog('pass', `Suggest labels: user approved ${decisions.length} of ${proposals.length} proposal(s)`, {
        subsystem: 'settings', event: 'taxonomy.suggest', reason: 'APPROVED', actor: 'USER',
        data: { approved: decisions.length, proposed: proposals.length, labels: decisions.map(d => `${d.category}/${d.label}`) },
    });
}

async function refreshDatabaseView() {
    const {
        getAllDatabases, withSkeleton, MENU_CATEGORY_ORDER, aspectVocabFor, deriveAspect,
        isActiveFact, isColdFact, effectiveCategories, flatVocab,
    } = await import('./database.js');
    const real = await getAllDatabases();
    // 3-layer model: overlay the empty Layer-1 skeleton so the FULL taxonomy (every category,
    // count 0 when empty) is always shown — never "No databases yet". The skeleton is purely
    // in-memory here (no empty files are written; categories persist only when a fact lands).
    // The skeleton already includes user-added overlay categories (effectiveCategories).
    const databases = withSkeleton(real);
    // Stable Layer-1 order first, then any custom extras.
    const ordered = [];
    for (const c of MENU_CATEGORY_ORDER) if (databases[c]) ordered.push(c);
    for (const c of Object.keys(databases)) if (!ordered.includes(c)) ordered.push(c);
    const categories = ordered;

    // Custom (user-added) markers so the UI can distinguish overlay labels from built-ins.
    const customCats = new Set(effectiveCategories().filter(c => !MENU_CATEGORY_ORDER.includes(c)));
    const overlay = extensionSettings?.taxonomyOverlay || { aspects: {} };

    // Keep the "Add aspect" category dropdown in sync with the effective category set.
    populateAddLabelCategoryDropdown(MENU_CATEGORY_ORDER, customCats);

    const statsEl = document.getElementById('bf_mem_db_stats');
    const listEl = document.getElementById('bf_mem_db_list');

    if (!statsEl || !listEl) return;

    const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
    statsEl.innerHTML = `<b>${categories.length}</b> databases | <b>${totalFacts}</b> total facts`;

    listEl.innerHTML = categories.map(cat => {
        const db = databases[cat];
        const factCount = db.facts.length;
        // Never-delete / cold-tier: the old 50-cap is gone, so show the real count plus how many
        // are cold-tiered (deprioritized but kept), not a fake "/50".
        const coldCount = db.facts.filter(f => { try { return isColdFact(f); } catch { return false; } }).length;
        const countLabel = coldCount ? `${factCount} (${coldCount} cold)` : `${factCount}`;
        const isCustomCat = customCats.has(cat);
        // Overlay (user-added) leaves for this category, so we can chip them in the breakdown.
        const overlayLeaves = new Set((Array.isArray(overlay.aspects?.[cat]) ? overlay.aspects[cat] : [])
            .map(l => String(l || '').trim().toLowerCase()));
        const knowers = [...new Set(db.facts.flatMap(f => f.knownBy || []))];
        // Layer-2 aspect breakdown: show the full effective vocab for this category (built-in +
        // overlay) with active counts (0 when empty) so the skeleton is visible from turn 1.
        const aspectCounts = new Map();
        for (const f of db.facts) {
            if (!isActiveFact(f)) continue;
            const a = deriveAspect(f);
            aspectCounts.set(a, (aspectCounts.get(a) || 0) + 1);
        }
        // DECLUTTER (user request): the Database tab used to dump the ENTIRE built-in vocab for
        // every category — ~940 leaves, nearly all `:0`. The planner (Drafter) already only sees
        // NON-EMPTY labels, so showing hundreds of empty slots here was pure noise ("1000 categories").
        // Show ONLY aspects that actually carry facts (count > 0) plus the user's own custom (overlay)
        // leaves, and report how many empty built-in slots were hidden. The full vocab is untouched —
        // the Scribe still files into it and the "Add label" dropdown still lists it.
        const fullVocab = flatVocab(cat);
        const shownAspectNames = fullVocab.filter(a => (aspectCounts.get(a) || 0) > 0 || overlayLeaves.has(a));
        // Surface any populated aspect that isn't in the built-in vocab (legacy/unknown) so no real fact hides.
        for (const a of aspectCounts.keys()) {
            if ((aspectCounts.get(a) || 0) > 0 && !shownAspectNames.includes(a)) shownAspectNames.push(a);
        }
        const hiddenEmptyCount = fullVocab.length - fullVocab.filter(a => (aspectCounts.get(a) || 0) > 0 || overlayLeaves.has(a)).length;
        const aspectStr = shownAspectNames.length
            ? shownAspectNames.map(a => {
                const label = `${a}:${aspectCounts.get(a) || 0}`;
                return overlayLeaves.has(a) ? `${label}*` : label;
            }).join(', ')
            : '— no facts filed yet —';
        return `
            <div class="bf-mem-db-card" data-category="${escapeHtml(cat)}">
                <div class="bf-mem-db-card-header">
                    <span class="bf-mem-db-card-name">${escapeHtml(cat)}${isCustomCat ? ' <span class="bf-mem-custom-chip" title="User-added category">custom</span>' : ''}</span>
                    <span class="bf-mem-db-card-count">${escapeHtml(countLabel)}</span>
                </div>
                <div class="bf-mem-db-card-meta">
                    <div class="bf-mem-db-card-aspects">${escapeHtml(aspectStr)}</div>
                    ${hiddenEmptyCount ? `<small class="bf-mem-hint">+${hiddenEmptyCount} empty aspect slot(s) hidden</small>` : ''}
                    ${overlayLeaves.size ? '<small class="bf-mem-hint">* = your custom aspect</small>' : ''}
                    ${knowers.length ? `Known by: ${escapeHtml(knowers.join(', '))}` : ''}
                </div>
                <div class="bf-mem-db-card-actions">
                    <button class="bf-mem-db-view menu_button" data-category="${escapeHtml(cat)}">
                        <i class="fa-solid fa-eye"></i> View
                    </button>
                    <button class="bf-mem-db-delete menu_button" data-category="${escapeHtml(cat)}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>`;
    }).join('');

    // Bind view buttons
    listEl.querySelectorAll('.bf-mem-db-view').forEach(btn => {
        btn.addEventListener('click', () => viewSingleDatabase(btn.dataset.category, databases));
    });

    // Bind delete buttons
    listEl.querySelectorAll('.bf-mem-db-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const category = btn.dataset.category;
            if (!confirm(`Delete database "${category}"?`)) return;
            const { deleteDatabase, flushSnapshotNow } = await import('./database.js');
            // Layer A (IDB) + Layer B (attachment file) — also cancels the armed snapshot timer.
            await deleteDatabase(category);
            // Layer C (dbProfiles snapshot): prune the category so autoSaveDbProfile can't resurrect
            // it on the next CHAT_CHANGED. Without this, deleting from IDB+attachments leaves the
            // full copy in the linked profile and it reloads on chat switch.
            const { profilesPruned, factsPruned } = pruneActiveProfile(category);
            // Force a reconciling snapshot now so the durable attachment layer reflects the deletion
            // immediately (deletes the emptied category's file) rather than on the throttled cadence.
            await flushSnapshotNow();
            addDebugLog('pass', `Deleted category "${category}" (Layer A+B+C)`, {
                subsystem: 'db', event: 'db.deleteCategory', actor: 'USER', reason: 'USER_DELETE',
                data: { category, profilesPruned, factsPrunedFromProfile: factsPruned },
            });
            toastr.success(`Database "${category}" deleted`, 'BF Memory');
            refreshDatabaseView();
        });
    });
}

// Cap the number of fact rows rendered into the (innerHTML-built) view at once so a 10k-fact
// category can't freeze the UI with a multi-MB DOM write. The user filters or pages past it.
const FACT_VIEW_PAGE_SIZE = 200;

/**
 * Build the HTML for the per-fact rows of the single-category viewer. Re-run on every
 * filter/page change. Each row carries a checkbox (bulk-select), a cold badge when cold,
 * and per-row Edit/Delete buttons. Only the facts in [0, limit) of the FILTERED set render.
 * @param {import('./database.js').FactSchema[]} facts - already filtered + ordered
 * @param {number} limit - max rows to render now (pagination cap)
 * @param {(f) => boolean} isColdFact
 * @param {(f) => string} deriveAspect
 * @returns {string}
 */
function renderFactRows(facts, limit, isColdFact, deriveAspect) {
    const shown = facts.slice(0, limit);
    return shown.map((fact) => {
        const cold = (() => { try { return isColdFact(fact); } catch { return false; } })();
        const aspect = (() => { try { return deriveAspect(fact); } catch { return ''; } })();
        const importance = Number.isFinite(Number(fact.importance)) ? Number(fact.importance) : 3;
        const note = fact.context || '';
        const coldBadge = cold ? ' <span class="bf-mem-custom-chip" title="Cold-tiered: kept but deprioritized by retrieval">cold</span>' : '';
        const superseded = fact.active === false ? ' <span class="bf-mem-custom-chip" title="Superseded (historical)">old</span>' : '';
        // Spiderweb 2: the fact's origin scene (No + name) + source-message provenance.
        const sceneLine = Number.isInteger(fact.sceneNo)
            ? `<div class="bf-mem-fact-source">scene: #${fact.sceneNo}${fact.sceneName ? ` · ${escapeHtml(fact.sceneName)}` : ''}${fact.sourceMsg ? ` · from ${escapeHtml(fact.sourceMsg)}` : ''}</div>`
            : (fact.sourceMsg ? `<div class="bf-mem-fact-source">from ${escapeHtml(fact.sourceMsg)}</div>` : '');
        return `
            <div class="bf-mem-fact-row" data-key="${escapeHtml(fact.key)}" style="border-bottom:1px solid var(--SmartThemeBorderColor,#444);padding:6px 0;">
                <div style="display:flex;gap:8px;align-items:flex-start;">
                    <input type="checkbox" class="bf-mem-fact-check" data-key="${escapeHtml(fact.key)}" style="margin-top:4px;" />
                    <div style="flex:1 1 auto;min-width:0;">
                        <div><b>${escapeHtml(fact.key)}</b>${coldBadge}${superseded}
                            <span class="bf-mem-fact-source"> [${escapeHtml(aspect)} · imp ${importance}]</span></div>
                        <div class="bf-mem-fact-value">${escapeHtml(fact.value)}</div>
                        ${note ? `<div class="bf-mem-fact-source">note: ${escapeHtml(note)}</div>` : ''}
                        ${sceneLine}
                        ${(fact.knownBy || []).length ? `<div class="bf-mem-fact-source">known by: ${escapeHtml((fact.knownBy || []).join(', '))}</div>` : ''}
                        ${(fact.involved || []).length ? `<div class="bf-mem-fact-source">involved: ${escapeHtml((fact.involved || []).join(', '))}</div>` : ''}
                        ${fact.location ? `<div class="bf-mem-fact-source">location: ${escapeHtml(String(fact.location))}</div>` : ''}
                        ${fact.kind ? `<div class="bf-mem-fact-source">kind: ${escapeHtml(String(fact.kind))}</div>` : ''}
                        ${(() => {
                            // SPIDERWEB: surface the fact's connections (primary/secondary/tertiary links to
                            // other facts). These were stored + used for retrieval but never shown — this is
                            // why the viewer looked like "only simple facts".
                            const r = fact.relationships || {};
                            const parts = [];
                            if ((r.primary || []).length) parts.push(`◆ ${escapeHtml((r.primary || []).join(', '))}`);
                            if ((r.secondary || []).length) parts.push(`◇ ${escapeHtml((r.secondary || []).join(', '))}`);
                            if ((r.tertiary || []).length) parts.push(`· ${escapeHtml((r.tertiary || []).join(', '))}`);
                            return parts.length ? `<div class="bf-mem-fact-links">🕸 linked: ${parts.join(' &nbsp; ')}</div>` : '';
                        })()}
                        ${(fact.tags || []).length ? `<div class="bf-mem-fact-source">tags: ${escapeHtml((fact.tags || []).join(', '))}</div>` : ''}
                    </div>
                    <div style="flex:0 0 auto;display:flex;gap:4px;">
                        <button class="bf-mem-fact-edit menu_button" data-key="${escapeHtml(fact.key)}" title="Edit"><i class="fa-solid fa-pen"></i></button>
                        <button class="bf-mem-fact-del menu_button redWarningBG" data-key="${escapeHtml(fact.key)}" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>`;
    }).join('');
}

/**
 * Interactive per-category fact manager: VIEW + FILTER + per-fact EDIT/DELETE + BULK DELETE, with
 * cold-tier badges and a rendered-row cap for huge categories. Every destructive/edit op goes
 * through the 3-layer-safe path (working store via removeFact/saveDatabase, PLUS the dbProfiles
 * snapshot via pruneFactFromProfiles/updateFactInProfiles) so changes can't be resurrected by
 * autoSaveDbProfile on the next CHAT_CHANGED — the same guarantee as the category-delete in
 * commit 4e281b7.
 * @param {string} category
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases - the withSkeleton map
 */
async function viewSingleDatabase(category, databases) {
    const { isColdFact, deriveAspect } = await import('./database.js');
    const db = databases[category];
    if (!db) return;
    await ensurePopup();
    if (!Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    // Working copy of the facts we render (re-read from the live store on every mutation so the
    // list reflects deletes/edits without reopening). filter + page are popup-local UI state.
    let allFacts = [...db.facts];
    let renderLimit = FACT_VIEW_PAGE_SIZE;

    const html = `<div class="bf-mem-db-browser" data-category="${escapeHtml(category)}">
        <h4>${escapeHtml(category)} — <span id="bf_mem_fact_count">${allFacts.length}</span> facts</h4>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;">
            <input type="text" id="bf_mem_fact_filter" class="text_pole" placeholder="Filter by key / value / note…" style="flex:1 1 180px;min-width:140px;" />
            <label class="checkbox_label" style="flex:0 0 auto;"><input type="checkbox" id="bf_mem_fact_selall" /> <span>Select all (filtered)</span></label>
            <button id="bf_mem_fact_bulkdel" class="menu_button redWarningBG" style="flex:0 0 auto;"><i class="fa-solid fa-trash"></i> Delete selected</button>
        </div>
        <div id="bf_mem_fact_list"></div>
        <div id="bf_mem_fact_more" style="margin-top:8px;text-align:center;"></div>
    </div>`;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
    // Show without awaiting so we can wire the live DOM while the popup is open.
    const shownPromise = popup.show();
    const root = popup.dlg || popup.content || document;
    const listEl = root.querySelector('#bf_mem_fact_list');
    const moreEl = root.querySelector('#bf_mem_fact_more');
    const filterEl = root.querySelector('#bf_mem_fact_filter');
    const countEl = root.querySelector('#bf_mem_fact_count');
    const selAllEl = root.querySelector('#bf_mem_fact_selall');

    // Current filtered set (recomputed by applyFilter), used by render + bulk select.
    let filtered = allFacts;

    const applyFilter = () => {
        const q = (filterEl?.value || '').trim().toLowerCase();
        filtered = !q ? allFacts : allFacts.filter(f => {
            const hay = `${f.key || ''} ${f.value || ''} ${f.context || ''} ${(f.tags || []).join(' ')} ${(f.knownBy || []).join(' ')}`.toLowerCase();
            return hay.includes(q);
        });
    };

    const render = () => {
        applyFilter();
        if (countEl) countEl.textContent = `${filtered.length}${filtered.length !== allFacts.length ? ` / ${allFacts.length}` : ''}`;
        if (listEl) listEl.innerHTML = filtered.length
            ? renderFactRows(filtered, renderLimit, isColdFact, deriveAspect)
            : '<div class="bf-mem-empty">No matching facts.</div>';
        if (moreEl) {
            const remaining = Math.max(0, filtered.length - renderLimit);
            moreEl.innerHTML = remaining > 0
                ? `<button id="bf_mem_fact_showmore" class="menu_button">Show more (${remaining} hidden)</button>`
                : '';
        }
        if (selAllEl) selAllEl.checked = false;
        bindRowHandlers();
    };

    // Re-read the live store and refresh, after a mutation. Keeps the popup authoritative.
    const reloadFromStore = async () => {
        const { getAllDatabases } = await import('./database.js');
        const fresh = await getAllDatabases();
        allFacts = [...((fresh[category] && fresh[category].facts) || [])];
        renderLimit = Math.max(FACT_VIEW_PAGE_SIZE, renderLimit); // keep what was paged
        render();
        refreshDatabaseView();
    };

    // Single-fact DELETE through ALL THREE layers (working store + every profile the chat reloads
    // from) so it can't resurrect. Mirrors the category-delete anti-resurrection contract.
    const deleteOne = async (key) => {
        if (!confirm(`Delete fact "${key}" from "${category}"?`)) return;
        const { getAllDatabases, removeFact, saveDatabase, flushSnapshotNow } = await import('./database.js');
        const fresh = await getAllDatabases();
        const liveDb = fresh[category];
        if (!liveDb) return;
        removeFact(liveDb, key);                       // Layer A (IDB) + arms Layer B (attachment)
        await saveDatabase({ ...liveDb, category });
        const { profilesPruned, factsPruned } = pruneFactFromProfiles(category, key); // Layer C
        await flushSnapshotNow();                       // reconcile durable attachment now
        addDebugLog('pass', `Deleted single fact "${key}" from "${category}" (Layer A+B+C)`, {
            subsystem: 'db', event: 'fact.deleted', actor: 'USER', reason: 'USER_DELETE',
            data: { category, key, profilesPruned, factsPrunedFromProfile: factsPruned },
        });
        await reloadFromStore();
    };

    // BULK delete the currently-checked rows (or all filtered when "select all" was used) — one
    // saveDatabase per category, one profile prune per key, one durable flush at the end.
    const deleteSelected = async () => {
        // When "Select all (filtered)" is on, operate on the ENTIRE filtered set — not just the
        // rendered (paginated) rows. The DOM only contains up to `renderLimit` checkboxes, so
        // reading checked DOM rows would silently miss the overflow on large categories.
        const keys = (selAllEl && selAllEl.checked)
            ? filtered.map(f => f.key)
            : [...root.querySelectorAll('.bf-mem-fact-check:checked')].map(c => c.dataset.key);
        if (keys.length === 0) { toastr.info('No facts selected', 'BF Memory'); return; }
        if (!confirm(`Delete ${keys.length} selected fact(s) from "${category}"? This cannot be undone.`)) return;
        const { getAllDatabases, saveDatabase, flushSnapshotNow } = await import('./database.js');
        const fresh = await getAllDatabases();
        const liveDb = fresh[category];
        if (!liveDb) return;
        const keySet = new Set(keys);
        const before = liveDb.facts.length;
        liveDb.facts = liveDb.facts.filter(f => !keySet.has(f.key));   // Layer A
        liveDb.updatedAt = Date.now();
        await saveDatabase({ ...liveDb, category });                   // persist Layer A + arm B
        let profilesTouched = new Set();
        for (const key of keys) {                                      // Layer C, per key
            const { profilesPruned } = pruneFactFromProfiles(category, key);
            profilesPruned.forEach(p => profilesTouched.add(p));
        }
        await flushSnapshotNow();
        addDebugLog('pass', `Bulk-deleted ${before - liveDb.facts.length} fact(s) from "${category}" (Layer A+B+C)`, {
            subsystem: 'db', event: 'fact.bulkDeleted', actor: 'USER', reason: 'USER_BULK_DELETE',
            data: { category, requested: keys.length, removed: before - liveDb.facts.length, profilesPruned: [...profilesTouched] },
        });
        toastr.success(`Deleted ${before - liveDb.facts.length} fact(s)`, 'BF Memory');
        await reloadFromStore();
    };

    // Per-fact EDIT modal: value + note (always) + aspect + importance. Writes through Layer A+B+C.
    const editOne = async (key) => {
        const { getAllDatabases, saveDatabase, deriveAspect: da, flatVocab, flushSnapshotNow } = await import('./database.js');
        const fresh = await getAllDatabases();
        const liveDb = fresh[category];
        const fact = liveDb?.facts.find(f => f.key === key);
        if (!fact) { toastr.warning('Fact no longer exists', 'BF Memory'); await reloadFromStore(); return; }
        const vocab = (() => { try { return flatVocab(category); } catch { return []; } })();
        const curAspect = (() => { try { return da(fact); } catch { return ''; } })();
        const curImp = Number.isFinite(Number(fact.importance)) ? Number(fact.importance) : 3;
        const aspectOptions = vocab.map(a => `<option value="${escapeHtml(a)}"${a === curAspect ? ' selected' : ''}>${escapeHtml(a)}</option>`).join('');
        const impOptions = [1, 2, 3, 4, 5].map(n => `<option value="${n}"${n === curImp ? ' selected' : ''}>${n}</option>`).join('');
        const editHtml = `<div class="bf-mem-db-browser">
            <h4>Edit fact: ${escapeHtml(key)}</h4>
            <div class="bf-mem-field"><label>Value</label>
                <textarea id="bf_mem_edit_value" class="text_pole" rows="3" style="width:100%;">${escapeHtml(fact.value || '')}</textarea></div>
            <div class="bf-mem-field" style="margin-top:6px;"><label>Note (context)</label>
                <textarea id="bf_mem_edit_note" class="text_pole" rows="2" style="width:100%;">${escapeHtml(fact.context || '')}</textarea></div>
            <div class="bf-mem-field" style="margin-top:6px;display:flex;gap:10px;flex-wrap:wrap;">
                <div style="flex:1 1 140px;"><label>Aspect</label>
                    <select id="bf_mem_edit_aspect" class="text_pole" style="width:100%;">${aspectOptions || `<option value="${escapeHtml(curAspect)}" selected>${escapeHtml(curAspect)}</option>`}</select></div>
                <div style="flex:0 0 90px;"><label>Importance</label>
                    <select id="bf_mem_edit_imp" class="text_pole" style="width:100%;">${impOptions}</select></div>
            </div>
        </div>`;
        const editPopup = new Popup(editHtml, POPUP_TYPE.TEXT, '', { okButton: 'Save', cancelButton: 'Cancel', wide: true, allowVerticalScrolling: true });
        const result = await editPopup.show();
        if (!result) return; // cancelled
        const eroot = editPopup.dlg || editPopup.content || document;
        const newValue = eroot.querySelector('#bf_mem_edit_value')?.value ?? fact.value;
        const newNote = eroot.querySelector('#bf_mem_edit_note')?.value ?? fact.context;
        const newAspect = eroot.querySelector('#bf_mem_edit_aspect')?.value ?? fact.aspect;
        const newImp = Number(eroot.querySelector('#bf_mem_edit_imp')?.value) || curImp;
        const before = { value: fact.value, context: fact.context || '', aspect: fact.aspect || curAspect, importance: curImp };

        // Mutate the live fact in place + persist Layer A/B.
        fact.value = String(newValue);
        fact.context = String(newNote || '');
        if (newAspect) fact.aspect = newAspect;
        fact.importance = Math.min(5, Math.max(1, Math.round(newImp)));
        fact.lastUpdated = Date.now();
        liveDb.updatedAt = Date.now();
        await saveDatabase({ ...liveDb, category });
        // Layer C write-through so the edit survives a CHAT_CHANGED reload.
        const { profilesUpdated } = updateFactInProfiles(category, key, fact);
        await flushSnapshotNow();
        addDebugLog('pass', `Edited fact "${key}" in "${category}" (Layer A+B+C)`, {
            subsystem: 'db', event: 'fact.edited', actor: 'USER', reason: 'USER_EDIT',
            data: { category, key, profilesUpdated },
            before, after: { value: fact.value, context: fact.context, aspect: fact.aspect, importance: fact.importance },
        });
        toastr.success(`Fact "${key}" updated`, 'BF Memory');
        await reloadFromStore();
    };

    function bindRowHandlers() {
        root.querySelectorAll('.bf-mem-fact-del').forEach(btn =>
            btn.addEventListener('click', () => deleteOne(btn.dataset.key)));
        root.querySelectorAll('.bf-mem-fact-edit').forEach(btn =>
            btn.addEventListener('click', () => editOne(btn.dataset.key)));
        const showMore = root.querySelector('#bf_mem_fact_showmore');
        if (showMore) showMore.addEventListener('click', () => { renderLimit += FACT_VIEW_PAGE_SIZE; render(); });
    }

    filterEl?.addEventListener('input', () => { renderLimit = FACT_VIEW_PAGE_SIZE; render(); });
    selAllEl?.addEventListener('change', () => {
        const on = selAllEl.checked;
        root.querySelectorAll('.bf-mem-fact-check').forEach(c => { c.checked = on; });
    });
    root.querySelector('#bf_mem_fact_bulkdel')?.addEventListener('click', () => deleteSelected());

    render();
    await shownPromise;
}

async function showAllDatabases() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();
    const categories = Object.keys(databases);

    if (categories.length === 0) {
        toastr.info('No databases yet.', 'BF Memory');
        return;
    }

    let html = '<div class="bf-mem-db-browser">';
    for (const [category, db] of Object.entries(databases)) {
        html += `<div class="bf-mem-db-section">
            <h4>${escapeHtml(category)} (${db.facts.length} facts)</h4>
            <table class="bf-mem-db-table">
                <tr><th>Key</th><th>Value</th><th>Known By</th><th>Tags</th></tr>`;
        for (const fact of db.facts) {
            html += `<tr>
                <td><b>${escapeHtml(fact.key)}</b></td>
                <td>${escapeHtml(fact.value)}</td>
                <td>${escapeHtml((fact.knownBy || []).join(', '))}</td>
                <td>${escapeHtml((fact.tags || []).join(', '))}</td>
            </tr>`;
        }
        html += '</table></div>';
    }
    html += '</div>';

    await ensurePopup();
    if (Popup) {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, allowVerticalScrolling: true });
        await popup.show();
    }
}

// Stable per-category node colours for the spiderweb (the 7 built-in L1 categories + a fallback).
const SPIDERWEB_COLORS = {
    People: '#7bb3ff', World: '#5fd38d', Events: '#f5a35c', Relationships: '#e879c9',
    Objects: '#d4c25f', Knowledge: '#9b8cff', Unsorted: '#9aa0a6',
};
function spiderwebColor(cat) { return SPIDERWEB_COLORS[cat] || '#c08aff'; }

/**
 * SPIDERWEB VIEW (user request: "the web is visually represented via a new button").
 * Renders the fact graph — each fact is a node, each primary/secondary/tertiary link is an edge —
 * as a dependency-free force-directed SVG (no D3). Shows ONLY the connected sub-graph by default
 * (the actual web), reports how many isolated facts are hidden, and colours nodes by category.
 * Read-only; purely a visualization of `fact.relationships`, which were always stored but never drawn.
 */
async function showSpiderwebPopup() {
    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();

    // --- Collect nodes (unique by fact key) + edges (links to OTHER existing facts) ---
    const nodes = [];
    const idByKey = new Map();
    const addNode = (key, cat, value, imp) => {
        if (idByKey.has(key)) return idByKey.get(key);
        const id = nodes.length;
        idByKey.set(key, id);
        nodes.push({ key, cat, value: value || '', imp: Number(imp) || 3, deg: 0 });
        return id;
    };
    for (const [cat, db] of Object.entries(databases)) {
        for (const f of (db.facts || [])) { if (f && f.key) addNode(f.key, cat, f.value, f.importance); }
    }
    const edges = [];
    const seenEdge = new Set();
    for (const [, db] of Object.entries(databases)) {
        for (const f of (db.facts || [])) {
            if (!f || !f.key || !idByKey.has(f.key)) continue;
            const r = f.relationships || {};
            for (const tier of ['primary', 'secondary', 'tertiary']) {
                for (const tgt of (r[tier] || [])) {
                    if (tgt === f.key || !idByKey.has(tgt)) continue;
                    const a = idByKey.get(f.key), b = idByKey.get(tgt);
                    const ek = a < b ? `${a}-${b}` : `${b}-${a}`;
                    if (seenEdge.has(ek)) continue;
                    seenEdge.add(ek);
                    edges.push({ s: a, t: b, tier });
                    nodes[a].deg++; nodes[b].deg++;
                }
            }
        }
    }

    const totalFacts = nodes.length;
    // Keep only connected nodes — the web — and remap to a compact index set.
    const connectedIdx = nodes.map((n, i) => i).filter(i => nodes[i].deg > 0);
    const isolated = totalFacts - connectedIdx.length;

    await ensurePopup();
    if (!Popup) { toastr.error('Popup not available', 'BF Memory'); return; }

    if (connectedIdx.length === 0) {
        const msg = `<div class="bf-mem-db-browser"><h4>🕸 Memory Web</h4>
            <p>No connections to draw yet. You have <b>${totalFacts}</b> fact(s), but none are linked to each other.</p>
            <p class="bf-mem-hint">Links form automatically as the Scribe records related facts (auto-linking) and during reflection. Keep chatting and they'll appear here.</p></div>`;
        await new Popup(msg, POPUP_TYPE.TEXT, '', { wide: true }).show();
        return;
    }

    // Cap for layout cost (O(n^2) force sim). Keep the highest-degree nodes if huge.
    const CAP = 280;
    let pick = connectedIdx;
    let capped = 0;
    if (pick.length > CAP) {
        pick = [...connectedIdx].sort((a, b) => nodes[b].deg - nodes[a].deg).slice(0, CAP);
        capped = connectedIdx.length - CAP;
    }
    const pickSet = new Set(pick);
    const local = pick.map((gi, li) => ({ gi, li }));
    const liByGi = new Map(local.map(o => [o.gi, o.li]));
    const N = local.length;

    // CATEGORY-CLUSTERED seed (no Math.random — reproducible). Big virtual canvas; each category
    // gets its own region on a ring so the graph reads as separated clusters you can pan between,
    // not one central blob. Nodes start near their category centre.
    const W = 2000, H = 1400, cx = W / 2, cy = H / 2;
    const catList = [...new Set(local.map(o => nodes[o.gi].cat))];
    const ringR = catList.length > 1 ? 540 : 0;
    const catCenter = {};
    catList.forEach((c, k) => { const a = (2 * Math.PI * k) / catList.length; catCenter[c] = { x: cx + ringR * Math.cos(a), y: cy + ringR * Math.sin(a) }; });
    const P = local.map((o, i) => {
        const c = catCenter[nodes[o.gi].cat]; const a = (2 * Math.PI * i) / N; const rad = 50 + (i % 8) * 20;
        return { x: c.x + rad * Math.cos(a), y: c.y + rad * Math.sin(a), vx: 0, vy: 0 };
    });
    const E = edges.filter(e => pickSet.has(e.s) && pickSet.has(e.t))
        .map(e => ({ s: liByGi.get(e.s), t: liByGi.get(e.t), tier: e.tier }));

    // --- Force-directed layout: stronger repulsion (spread, not a blob) + edge springs +
    //     per-node gravity toward its CATEGORY centre (keeps clusters together) + mild global pull. ---
    const ITER = 420, kRep = 26000, kSpring = 0.015, springLen = 90, catGrav = 0.03, grav = 0.004, damp = 0.85;
    for (let it = 0; it < ITER; it++) {
        for (let i = 0; i < N; i++) {
            let fx = 0, fy = 0;
            for (let j = 0; j < N; j++) {
                if (i === j) continue;
                let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
                let d2 = dx * dx + dy * dy; if (d2 < 1) d2 = 1;
                const f = kRep / d2;
                const d = Math.sqrt(d2);
                fx += (dx / d) * f; fy += (dy / d) * f;
            }
            const cc = catCenter[nodes[local[i].gi].cat];
            fx += (cc.x - P[i].x) * catGrav + (cx - P[i].x) * grav;
            fy += (cc.y - P[i].y) * catGrav + (cy - P[i].y) * grav;
            P[i].vx = (P[i].vx + fx) * damp; P[i].vy = (P[i].vy + fy) * damp;
        }
        for (const e of E) {
            const a = P[e.s], b = P[e.t];
            let dx = b.x - a.x, dy = b.y - a.y;
            let d = Math.sqrt(dx * dx + dy * dy) || 1;
            const f = kSpring * (d - springLen);
            const ux = dx / d, uy = dy / d;
            a.vx += ux * f; a.vy += uy * f;
            b.vx -= ux * f; b.vy -= uy * f;
        }
        for (let i = 0; i < N; i++) {
            P[i].x += Math.max(-45, Math.min(45, P[i].vx));
            P[i].y += Math.max(-45, Math.min(45, P[i].vy));
        }
    }
    // Normalize into the padded viewBox. X()/Y() map a node index to its on-canvas position.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of P) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const pad = 80, sw = (maxX - minX) || 1, sh = (maxY - minY) || 1;
    const layoutScale = Math.min((W - 2 * pad) / sw, (H - 2 * pad) / sh);
    const X = i => pad + (P[i].x - minX) * layoutScale;
    const Y = i => pad + (P[i].y - minY) * layoutScale;

    // --- Build SVG (edges + nodes carry data-attrs so the interactivity below can highlight) ---
    const tierStroke = { primary: 'rgba(150,180,255,0.85)', secondary: 'rgba(140,160,190,0.45)', tertiary: 'rgba(130,140,160,0.25)' };
    const tierW = { primary: 2, secondary: 1.2, tertiary: 0.7 };
    let svgEdges = '';
    E.forEach((e, ei) => {
        svgEdges += `<line class="bf-web-edge" data-ei="${ei}" data-s="${e.s}" data-t="${e.t}" data-tier="${e.tier}" x1="${X(e.s).toFixed(1)}" y1="${Y(e.s).toFixed(1)}" x2="${X(e.t).toFixed(1)}" y2="${Y(e.t).toFixed(1)}" stroke="${tierStroke[e.tier]}" stroke-width="${tierW[e.tier]}" />`;
    });
    // Hub labels (top-degree) show always; the rest reveal on hover/focus to keep the map readable.
    const degOrder = [...Array(N).keys()].sort((a, b) => nodes[local[b].gi].deg - nodes[local[a].gi].deg);
    const hubSet = new Set(degOrder.slice(0, Math.min(24, N)));
    let svgNodes = '';
    for (let i = 0; i < N; i++) {
        const n = nodes[local[i].gi];
        const r = 4 + Math.min(9, n.deg) + (Number(n.imp) || 3) * 0.5;
        const x = X(i), y = Y(i);
        const label = escapeHtml(n.key.length > 26 ? n.key.slice(0, 25) + '…' : n.key);
        const title = escapeHtml(`${n.key} — ${n.cat}\n${n.value}\n${n.deg} link(s)`);
        svgNodes += `<g class="bf-web-node" data-i="${i}"><title>${title}</title>`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${spiderwebColor(n.cat)}" stroke="rgba(0,0,0,0.45)" stroke-width="1"/>`
            + `<text class="bf-web-label${hubSet.has(i) ? ' hub' : ''}" x="${(x + r + 3).toFixed(1)}" y="${(y + 3).toFixed(1)}" font-size="11">${label}</text>`
            + `</g>`;
    }

    const catCounts = {};
    for (const o of local) { const c = nodes[o.gi].cat; catCounts[c] = (catCounts[c] || 0) + 1; }
    const legend = Object.entries(catCounts).sort((a, b) => b[1] - a[1])
        .map(([c, n]) => `<span class="bf-mem-web-legend-item"><span class="bf-mem-web-dot" style="background:${spiderwebColor(c)}"></span>${escapeHtml(c)} (${n})</span>`).join('');

    const html = `<div class="bf-mem-web-wrap">
        <h4>🕸 Memory Web — ${N} fact(s), ${E.length} link(s)</h4>
        <div class="bf-mem-web-toolbar">
            <input id="bf_web_search" class="text_pole" placeholder="Find a fact by key…" style="flex:1 1 160px;min-width:120px;" />
            <label class="checkbox_label" style="flex:0 0 auto;"><input type="checkbox" id="bf_web_faint" /> <span>show faint links</span></label>
            <button id="bf_web_reset" class="menu_button" style="flex:0 0 auto;">Reset view</button>
        </div>
        <div class="bf-mem-web-legend">${legend}</div>
        <small class="bf-mem-hint"><b>Drag</b> to pan · <b>scroll</b> to zoom · <b>click a dot</b> to see what it's attached to · click empty space to clear.${isolated ? ` &nbsp;${isolated} unlinked fact(s) hidden.` : ''}${capped ? ` &nbsp;${capped} extra node(s) capped.` : ''}</small>
        <div class="bf-mem-web-stage">
            <svg id="bf_web_svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="bf-mem-web-svg">
                <rect id="bf_web_bg" x="0" y="0" width="${W}" height="${H}" fill="transparent"></rect>
                <g id="bf_web_vp"><g id="bf_web_edges">${svgEdges}</g><g id="bf_web_nodes">${svgNodes}</g></g>
            </svg>
        </div>
    </div>`;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: false });
    const shown = popup.show();
    const root = popup.dlg || popup.content || document;
    try {
        const svg = root.querySelector('#bf_web_svg');
        const vp = root.querySelector('#bf_web_vp');
        const bg = root.querySelector('#bf_web_bg');
        if (svg && vp) {
            const nodeEls = [...root.querySelectorAll('.bf-web-node')];
            const edgeEls = [...root.querySelectorAll('.bf-web-edge')];
            // adjacency for click-to-focus ("what is this attached to")
            const adj = Array.from({ length: N }, () => new Set());
            for (const e of E) { adj[e.s].add(e.t); adj[e.t].add(e.s); }

            // pan + zoom via a transform on the viewport group (accurate via screen CTM)
            let sc = 1, px = 0, py = 0;
            const apply = () => vp.setAttribute('transform', `translate(${px} ${py}) scale(${sc})`);
            const toSvg = (evt) => { const pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY; const m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : { x: 0, y: 0 }; };
            svg.addEventListener('wheel', (e) => {
                e.preventDefault();
                const p = toSvg(e); const wx = (p.x - px) / sc, wy = (p.y - py) / sc;
                sc = Math.max(0.2, Math.min(8, sc * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
                px = p.x - wx * sc; py = p.y - wy * sc; apply();
            }, { passive: false });
            let dragging = false, last = null, moved = false;
            svg.addEventListener('pointerdown', (e) => { dragging = true; moved = false; last = toSvg(e); svg.style.cursor = 'grabbing'; try { svg.setPointerCapture(e.pointerId); } catch { /* ok */ } });
            svg.addEventListener('pointermove', (e) => { if (!dragging) return; const p = toSvg(e); px += p.x - last.x; py += p.y - last.y; last = p; moved = true; apply(); });
            const endDrag = () => { dragging = false; svg.style.cursor = 'grab'; };
            svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
            svg.style.cursor = 'grab';

            // focus / clear: dim everything except a node + its direct neighbours
            const clearFocus = () => { nodeEls.forEach(el => el.classList.remove('dim', 'focus')); edgeEls.forEach(el => el.classList.remove('dim', 'focus')); };
            const focusNode = (i) => {
                const keep = new Set([i, ...adj[i]]);
                nodeEls.forEach(el => { const ni = +el.dataset.i; el.classList.toggle('dim', !keep.has(ni)); el.classList.toggle('focus', ni === i); });
                edgeEls.forEach(el => { const on = (+el.dataset.s === i) || (+el.dataset.t === i); el.classList.toggle('focus', on); el.classList.toggle('dim', !on); });
            };
            nodeEls.forEach(el => el.addEventListener('click', (ev) => { ev.stopPropagation(); if (!moved) focusNode(+el.dataset.i); }));
            svg.addEventListener('click', (ev) => { if ((ev.target === bg || ev.target === svg) && !moved) clearFocus(); });

            // faint links (secondary/tertiary) hidden by default to cut clutter
            const setFaint = (show) => edgeEls.forEach(el => { if (el.dataset.tier !== 'primary') el.style.display = show ? '' : 'none'; });
            setFaint(false);
            const faintCb = root.querySelector('#bf_web_faint');
            if (faintCb) faintCb.addEventListener('change', () => setFaint(faintCb.checked));

            const resetBtn = root.querySelector('#bf_web_reset');
            if (resetBtn) resetBtn.addEventListener('click', () => { sc = 1; px = 0; py = 0; apply(); clearFocus(); });

            const search = root.querySelector('#bf_web_search');
            if (search) search.addEventListener('input', () => {
                const q = search.value.trim().toLowerCase();
                if (!q) { clearFocus(); return; }
                const hit = local.findIndex(o => nodes[o.gi].key.toLowerCase().includes(q));
                if (hit >= 0) { focusNode(hit); const vb = svg.viewBox.baseVal; px = vb.width / 2 - X(hit) * sc; py = vb.height / 2 - Y(hit) * sc; apply(); }
            });
            apply();
        }
    } catch (err) { addDebugLog('info', `Memory Web interactivity failed (non-fatal): ${err.message || err}`); }
    await shown;
}

/**
 * Cross-category live search wired to #bf_mem_db_search. On a non-empty query it hides the
 * per-category cards and lists matching facts (key/value/note/tags/knownBy substring) grouped by
 * category, each with an "Open" button into that category's manager (where it can be edited/deleted).
 * On an empty query it restores the normal card view. Cap the rendered matches so a broad query on
 * a 10k store can't jank the UI.
 */
async function runDatabaseSearch() {
    const input = document.getElementById('bf_mem_db_search');
    const resultsEl = document.getElementById('bf_mem_db_search_results');
    const listEl = document.getElementById('bf_mem_db_list');
    if (!input || !resultsEl || !listEl) return;
    const q = (input.value || '').trim().toLowerCase();
    if (!q) {
        resultsEl.style.display = 'none';
        resultsEl.innerHTML = '';
        listEl.style.display = '';
        return;
    }
    const { getAllDatabases, withSkeleton, isColdFact } = await import('./database.js');
    const databases = withSkeleton(await getAllDatabases());
    const MAX_RESULTS = 300;
    const matches = [];
    for (const [category, db] of Object.entries(databases)) {
        for (const fact of (db.facts || [])) {
            const hay = `${fact.key || ''} ${fact.value || ''} ${fact.context || ''} ${(fact.tags || []).join(' ')} ${(fact.knownBy || []).join(' ')}`.toLowerCase();
            if (hay.includes(q)) matches.push({ category, fact });
            if (matches.length >= MAX_RESULTS) break;
        }
        if (matches.length >= MAX_RESULTS) break;
    }
    listEl.style.display = 'none';
    resultsEl.style.display = '';
    if (matches.length === 0) {
        resultsEl.innerHTML = '<div class="bf-mem-empty">No facts match.</div>';
        return;
    }
    resultsEl.innerHTML = `<div class="bf-mem-hint" style="margin-bottom:6px;">${matches.length}${matches.length >= MAX_RESULTS ? '+' : ''} match(es)${matches.length >= MAX_RESULTS ? ' (showing first ' + MAX_RESULTS + ')' : ''}. Click Open to edit/delete.</div>`
        + matches.map(({ category, fact }) => {
            const cold = (() => { try { return isColdFact(fact); } catch { return false; } })();
            return `<div class="bf-mem-fact-row" style="border-bottom:1px solid var(--SmartThemeBorderColor,#444);padding:6px 0;display:flex;gap:8px;align-items:flex-start;">
                <div style="flex:1 1 auto;min-width:0;">
                    <div><span class="bf-mem-fact-source">[${escapeHtml(category)}]</span> <b>${escapeHtml(fact.key)}</b>${cold ? ' <span class="bf-mem-custom-chip" title="Cold-tiered">cold</span>' : ''}</div>
                    <div class="bf-mem-fact-value">${escapeHtml(fact.value)}</div>
                </div>
                <button class="bf-mem-search-open menu_button" data-category="${escapeHtml(category)}" style="flex:0 0 auto;"><i class="fa-solid fa-up-right-from-square"></i> Open</button>
            </div>`;
        }).join('');
    resultsEl.querySelectorAll('.bf-mem-search-open').forEach(btn => {
        btn.addEventListener('click', () => viewSingleDatabase(btn.dataset.category, databases));
    });
}

/**
 * One-click "Unlink current chat" (main Database tab). Removes the current chat from EVERY profile
 * it is linked to and detaches it (so autoSaveDbProfile won't auto-relink on the next CHAT_CHANGED)
 * — the same effective unlink as the Manage popup, surfaced as a single button. Facts in the live
 * working store are left untouched (unlink != wipe); they just stop being driven by a profile.
 */
function unlinkCurrentChat() {
    const chatId = getCurrentChatId();
    if (!chatId) { toastr.warning('No chat currently open', 'BF Memory'); return; }
    const profiles = extensionSettings?.dbProfiles || {};
    const linkedTo = Object.entries(profiles).filter(([, p]) => (p?.linkedChats || []).includes(chatId)).map(([n]) => n);
    if (linkedTo.length === 0 && isChatUnlinked(chatId)) {
        toastr.info('Current chat is already unlinked', 'BF Memory');
        return;
    }
    if (!confirm('Unlink the current chat from its DB profile? It will stop auto-loading/auto-relinking. Your facts stay in the live store.')) return;
    for (const name of linkedTo) {
        const p = profiles[name];
        if (p?.linkedChats) p.linkedChats = p.linkedChats.filter(id => id !== chatId);
    }
    // Detach + drop active-profile pointer so the live session honors the unlink immediately.
    markChatUnlinked(chatId);
    if (extensionSettings.activeDbProfile && linkedTo.includes(extensionSettings.activeDbProfile)) {
        extensionSettings.activeDbProfile = '';
    }
    lastAutoLoadedChat = '';
    saveSettings();
    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    addDebugLog('info', `Unlinked current chat ${chatId} from ${linkedTo.length} profile(s) (detached)`, {
        subsystem: 'settings', event: 'profile.unlinked', actor: 'USER', reason: 'USER_UNLINK_CURRENT',
        data: { chatId, profiles: linkedTo },
    });
    toastr.success('Current chat unlinked', 'BF Memory');
}

/**
 * Import databases from an exported JSON blob. Accepts the export shape ({ category: DatabaseSchema })
 * — i.e. exactly what the Export button produces. Validates the shape, then on user choice either
 * REPLACES the store (clear-all first) or MERGES (upsert each fact into the live categories). Either
 * way the result is persisted through Layer A+B (saveDatabase) and Layer C (saveCurrentToActiveProfile)
 * so it survives a CHAT_CHANGED reload, mirroring the delete/edit anti-resurrection contract.
 * @param {string} text - raw JSON file contents
 */
async function importDatabasesFromJson(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { throw new Error('not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('expected an object of { category: { facts: [...] } }');
    }
    // Shape-validate: every value must look like a DatabaseSchema with a facts array.
    const incoming = {};
    let incomingFacts = 0;
    for (const [category, db] of Object.entries(parsed)) {
        if (!db || typeof db !== 'object' || !Array.isArray(db.facts)) continue;
        // Keep only well-formed facts (must have a string key + value).
        const facts = db.facts.filter(f => f && typeof f === 'object' && typeof f.key === 'string' && f.key);
        incoming[category] = { ...db, category, facts };
        incomingFacts += facts.length;
    }
    const incomingCats = Object.keys(incoming);
    if (incomingCats.length === 0 || incomingFacts === 0) {
        throw new Error('no valid databases/facts found in file');
    }

    // REPLACE (OK) vs MERGE (Cancel) — explicit confirm with the irreversibility called out.
    const replace = confirm(`Import ${incomingFacts} fact(s) across ${incomingCats.length} categor(ies).\n\nOK = REPLACE the current store with the file (wipes existing facts first).\nCancel = MERGE the file into the current store (keeps existing, adds/updates).`);

    const {
        getAllDatabases, saveDatabase, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot,
        upsertFact, createEmptyDatabase,
    } = await import('./database.js');

    cancelPendingSnapshot();

    if (replace) {
        // Wipe Layer A+B (every existing category) and Layer C (profile snapshot) first.
        const existing = await getAllDatabases();
        for (const category of Object.keys(existing)) await deleteDatabase(category);
        pruneActiveProfile(null);
    }

    // Apply the incoming categories.
    let merged = 0;
    if (replace) {
        for (const [category, db] of Object.entries(incoming)) {
            if (db.facts.length === 0) continue;
            await saveDatabase({ ...db, category });
            merged += db.facts.length;
        }
    } else {
        // MERGE: upsert each incoming fact into the live category (dedup/reconcile via upsertFact).
        const live = await getAllDatabases();
        for (const [category, db] of Object.entries(incoming)) {
            if (db.facts.length === 0) continue;
            const target = live[category] ? { ...live[category], category } : createEmptyDatabase(category);
            for (const fact of db.facts) { upsertFact(target, fact); merged++; }
            await saveDatabase(target);
        }
    }

    // Persist Layer C from the now-current working store (allowEmpty not needed: store is populated).
    await saveCurrentToActiveProfile(null, { allowEmpty: true });
    await flushSnapshotNow();

    addDebugLog('pass', `Imported ${merged} fact(s) across ${incomingCats.length} categor(ies) (${replace ? 'REPLACE' : 'MERGE'})`, {
        subsystem: 'import', event: 'db.imported', actor: 'USER', reason: replace ? 'REPLACE' : 'MERGE',
        data: { categories: incomingCats, incomingFacts, applied: merged, mode: replace ? 'replace' : 'merge' },
    });
    toastr.success(`Imported ${merged} fact(s) (${replace ? 'replaced' : 'merged'})`, 'BF Memory');
    refreshDatabaseView();
}

// --- DB Profiles ---

function refreshDbProfileDropdown() {
    const select = document.getElementById('bf_mem_db_profile_select');
    if (!select) return;

    const profiles = extensionSettings?.dbProfiles || {};
    const active = extensionSettings?.activeDbProfile || '';

    select.innerHTML = '<option value="">-- No profile loaded --</option>';
    for (const [name, profile] of Object.entries(profiles)) {
        const option = document.createElement('option');
        option.value = name;
        const factCount = Object.values(profile.databases || {}).reduce((sum, db) => sum + (db.facts?.length || 0), 0);
        const dbCount = Object.keys(profile.databases || {}).length;
        const linkCount = (profile.linkedChats || []).length;
        option.textContent = `${name} (${dbCount} dbs, ${factCount} facts${linkCount ? `, ${linkCount} chats` : ''})`;
        select.appendChild(option);
    }

    if (active && profiles[active]) {
        select.value = active;
    }
}

async function loadDbProfile(profileName) {
    if (!profileName) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) {
        toastr.error(`Profile "${profileName}" not found`, 'BF Memory');
        return;
    }

    const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

    // Clear existing databases
    const existing = await getAllDatabases();
    for (const category of Object.keys(existing)) {
        await deleteDatabase(category);
    }

    // Load profile databases. Skip EMPTY (factless) categories — the Layer-1 skeleton is
    // shown in-memory (withSkeleton); empty categories aren't persisted as attachment files
    // (write-on-first-fact), avoiding empty-upload spam.
    for (const [category, db] of Object.entries(profile.databases || {})) {
        if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
        await saveDatabase({ ...db, category });
    }

    extensionSettings.activeDbProfile = profileName;
    saveSettings();
    refreshDbProfileDropdown();
    refreshDatabaseView();
    toastr.success(`Loaded profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile loaded: "${profileName}"`, {
        subsystem: 'import', event: 'profile.switched', actor: 'USER', data: { profileName },
    });
}

async function saveDbProfile(profileName) {
    if (!profileName) return;

    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();

    if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
    const existing = (extensionSettings.dbProfiles[profileName] && typeof extensionSettings.dbProfiles[profileName] === 'object')
        ? extensionSettings.dbProfiles[profileName]
        : {};
    extensionSettings.dbProfiles[profileName] = {
        ...existing,
        databases: JSON.parse(JSON.stringify(databases)),
        savedAt: Date.now(),
    };
    extensionSettings.activeDbProfile = profileName;
    // LINK the current chat to this manually-created profile so it actually attaches (empty
    // linkedChats meant it would NOT auto-load on the next CHAT_CHANGED). linkChatToProfile is
    // idempotent + calls saveSettings; clears any prior unlink so auto-link re-enables for this chat.
    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        linkChatToProfile(profileName, currentChatId);
        // We just established this profile for the current chat — keep autoSaveDbProfile from
        // re-loading/clobbering it on a later CHAT_CHANGED for the SAME chat.
        lastAutoLoadedChat = currentChatId;
    }
    saveSettings();
    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    toastr.success(`Saved profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile saved: "${profileName}" (${Object.keys(databases).length} dbs)${currentChatId ? ` + linked to chat ${currentChatId}` : ''}`, {
        subsystem: 'db', event: 'profile.saved', actor: 'USER', reason: 'SAVE_AS_NEW',
        data: { profileName, dbCount: Object.keys(databases).length, linkedChat: currentChatId || null },
    });
}

async function deleteDbProfile(profileName) {
    if (!profileName) return;
    if (!confirm(`Delete saved profile "${profileName}"? This cannot be undone.`)) return;

    const wasActive = extensionSettings.activeDbProfile === profileName;
    const profile = extensionSettings.dbProfiles?.[profileName];
    const linkedChats = [...(profile?.linkedChats || [])];
    const currentChatId = getCurrentChatId();

    // PROFILE-DELETE CLEANUP: if this profile was driving the CURRENT chat, optionally wipe the
    // working store too — otherwise its facts are orphaned in IDB+attachments and the next
    // extraction silently writes them into a freshly auto-created profile (data resurrection by a
    // different name). Offer the choice; deleting the profile alone keeps the live facts.
    let alsoWipe = false;
    if (wasActive && currentChatId && linkedChats.includes(currentChatId)) {
        alsoWipe = confirm(`"${profileName}" is the active profile for THIS chat. Also clear its facts from this chat's working store?\n\nOK = delete profile AND wipe this chat's facts.\nCancel = delete profile only (facts stay in the live store).`);
    }

    delete extensionSettings.dbProfiles[profileName];
    if (wasActive) {
        extensionSettings.activeDbProfile = '';
        lastAutoLoadedChat = '';
    }
    // Drop any detach markers for chats that were linked ONLY to this (now-gone) profile so they
    // are not stranded as permanently un-auto-linkable.
    if (Array.isArray(extensionSettings.unlinkedChats)) {
        extensionSettings.unlinkedChats = extensionSettings.unlinkedChats.filter(id => !!findProfileForChat(id));
    }
    saveSettings();

    if (alsoWipe) {
        try {
            const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
            cancelPendingSnapshot();
            const dbs = await getAllDatabases();
            for (const category of Object.keys(dbs)) await deleteDatabase(category);
            await flushSnapshotNow();
            // The chat now has no profile and an empty store — treat as explicitly detached so it
            // doesn't immediately auto-create a fresh profile and re-seed.
            markChatUnlinked(currentChatId);
            saveSettings();
            refreshDatabaseView();
        } catch (err) {
            addDebugLog('fail', `Profile-delete working-store wipe failed: ${err.message || err}`);
        }
    }

    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    addDebugLog('info', `DB profile deleted: "${profileName}"${alsoWipe ? ' (+ working store wiped)' : ''}`, {
        subsystem: 'settings', event: 'profile.deleted', actor: 'USER', reason: 'USER_DELETE',
        data: { profileName, wasActive, linkedChatCount: linkedChats.length, wipedWorkingStore: alsoWipe },
    });
    toastr.success(`Deleted profile "${profileName}"`, 'BF Memory');
}

// --- Auto-save DB as chat-named profile ---

// Was named lastAutoSavedChat — kept the variable but the save logic is gone;
// it now only tracks the last chat we LOADED to skip redundant loads.
let lastAutoLoadedChat = '';

// Observability: the chatId we were on BEFORE the current CHAT_CHANGED, so the chat.switch /
// chat.disconnect logs can report a "from -> to" transition. Updated at the END of the
// CHAT_CHANGED handler. Not used for any storage/profile decision — logging only.
let _lastChatId = '';

/**
 * Heuristic branch detector for observability logs. ST names branched chats with a
 * "Branch #N" segment (e.g. "<name> - <date> - Branch #1"). Read-only — used only to tag
 * log entries, never to drive storage/profile behavior.
 * @param {string} chatId
 * @returns {boolean}
 */
function isBranchChat(chatId) {
    return typeof chatId === 'string' && /Branch\s*#/i.test(chatId);
}

function getCurrentChatId() {
    const context = getContext();
    // ST stores the current chat filename (unique per chat)
    return context.getCurrentChatId?.() || context.chatId || '';
}

function getCurrentChatLabel() {
    const context = getContext();
    const charName = context.characters?.[context.characterId]?.name || '';
    const chatId = getCurrentChatId();
    // Use character name as the default profile name
    return charName || chatId || '';
}

/** Find which profile is linked to a given chat ID */
function findProfileForChat(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    for (const [name, profile] of Object.entries(extensionSettings.dbProfiles)) {
        if ((profile.linkedChats || []).includes(chatId)) return name;
    }
    return null;
}

/**
 * Strip ST's " - Branch #N" suffix from a branched chat's id to recover the PARENT chat id.
 * ST names a branch "<parent chat id> - Branch #N" (see isBranchChat). Returns the parent id, or
 * the original id when no branch suffix is present. Used only by the branch-inherit resolution.
 * @param {string} chatId
 * @returns {string}
 */
function parentChatIdOfBranch(chatId) {
    if (typeof chatId !== 'string') return chatId;
    // Remove a trailing " - Branch #N" (and any nested " - Branch #M - Branch #N" chain).
    let id = chatId;
    let prev;
    do {
        prev = id;
        id = id.replace(/\s*-\s*Branch\s*#\s*\d+\s*$/i, '');
    } while (id !== prev);
    return id;
}

/**
 * BRANCH INHERIT (data-safety): resolve the profile a BRANCH chat should inherit from its parent.
 * A branch gets a brand-new chatId that is in no profile's linkedChats, so findProfileForChat()
 * returns null and the auto-create path would mint an EMPTY skeleton profile — diverging the branch
 * from the parent's accumulated memory. Default behavior is INHERIT: resolve the branch to the SAME
 * profile the parent uses (the avatar-keyed working store already holds the parent's facts; we just
 * must not mis-resolve to an empty profile). We try, in order: the parent chatId's linked profile,
 * then the character-named profile (the conventional auto-create name). Returns the profile name or
 * null when no parent profile exists yet.
 * @param {string} chatId - the branch chat id
 * @returns {string|null}
 */
function resolveBranchParentProfile(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    const parentId = parentChatIdOfBranch(chatId);
    if (parentId && parentId !== chatId) {
        const byParent = findProfileForChat(parentId);
        if (byParent) return byParent;
    }
    // Fall back to the conventional character-named profile (getCurrentChatLabel defaults to the
    // character name, which is what the parent's first chat auto-created).
    const charName = getContext()?.characters?.[getContext()?.characterId]?.name || '';
    if (charName && extensionSettings.dbProfiles[charName]) return charName;
    return null;
}

/** Link a chat to a profile */
function linkChatToProfile(profileName, chatId) {
    if (!profileName || !chatId) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) return;

    if (!profile.linkedChats) profile.linkedChats = [];

    // Remove this chat from any other profile first
    for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
        if (name !== profileName && p.linkedChats) {
            p.linkedChats = p.linkedChats.filter(id => id !== chatId);
        }
    }

    if (!profile.linkedChats.includes(chatId)) {
        profile.linkedChats.push(chatId);
    }
    // An explicit link clears any prior user-detach so auto-link is re-enabled for this chat.
    clearChatUnlinked(chatId);
    saveSettings();
}

/**
 * Save current databases to the active profile (call after DB changes).
 *
 * @param {string|null} profileKey - target profile (defaults to the active profile)
 * @param {{ allowEmpty?: boolean }} [options]
 * @param {boolean} [options.allowEmpty=false] - when false (the default for the every-turn
 *   extraction call sites) a totally-empty working store is NOT written through — this guards
 *   against a transient/failed getAllDatabases() load clobbering a populated profile with `{}`.
 *   USER-initiated destructive ops (Clear All / per-category delete) pass `allowEmpty:true` so an
 *   INTENTIONAL clear-to-empty actually persists to the profile (Layer C) and can no longer be
 *   resurrected by autoSaveDbProfile on the next CHAT_CHANGED.
 */
/**
 * EAGER PROFILE ENSURE (fact-write-time). Guarantee an active DB profile exists, is linked to the
 * CURRENT chat, and is set active — so facts always land in a profile, not only after CHAT_CHANGED.
 *
 * Problem this fixes: activeDbProfile was set ONLY inside autoSaveDbProfile (CHAT_CHANGED/init). When a
 * run raced ahead of that, or a branch chat's resolveBranchParentProfile returned null (parent never
 * linked → facts only in the avatar store), activeDbProfile was empty at write time, so the
 * saveCurrentToActiveProfile call no-op'd and the Database tab showed no profile.
 *
 * Resolution order (reuses the SAME helpers autoSaveDbProfile uses — no duplicated logic):
 *   1. already-active profile that still exists → keep it
 *   2. profile linked to this chat (findProfileForChat)
 *   3. branch-inherit the parent's profile (resolveBranchParentProfile) and link this branch to it
 *   4. auto-create a chat/character-named profile (seeded Layer-1 skeleton) and link it
 * Then LINK the current chat + SET it active. Respects an explicit user unlink (does NOT re-link).
 *
 * NON-DESTRUCTIVE: this only ensures the profile RECORD + active pointer; it never loads/clears the
 * working store (that is autoSaveDbProfile's job on CHAT_CHANGED), so it can't resurrect deleted data
 * or clobber the avatar store. It never double-creates: an existing named profile is linked, not replaced.
 *
 * @returns {Promise<string|null>} the ensured active profile name, or null when none could be ensured
 *   (no chatId, or the chat was explicitly unlinked by the user).
 */
async function ensureActiveProfileForCurrentChat() {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) return null;

        // (1) Active profile already set AND still exists → reuse (most common case after CHAT_CHANGED).
        const active = extensionSettings?.activeDbProfile;
        if (active && extensionSettings?.dbProfiles?.[active]) {
            // Make sure the active profile is actually linked to THIS chat (a race could have set it
            // active before linking, e.g. via saveDbProfile pre-fix). Link defensively (idempotent).
            if (!(extensionSettings.dbProfiles[active].linkedChats || []).includes(chatId) && !isChatUnlinked(chatId)) {
                linkChatToProfile(active, chatId);
            }
            return active;
        }

        // RESPECT EXPLICIT UNLINK: if the user detached this chat from every profile, do NOT auto-link
        // or auto-create one (mirrors autoSaveDbProfile's suppression). Facts stay in the working store.
        if (isChatUnlinked(chatId)) return null;

        if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
        const isBranch = isBranchChat(chatId);
        let resolved = null;
        let how = 'none';

        // (2) Profile already linked to this chat.
        resolved = findProfileForChat(chatId);
        if (resolved) how = 'linked';

        // (3) Branch-inherit the parent's profile.
        if (!resolved && isBranch) {
            const parentProfile = resolveBranchParentProfile(chatId);
            if (parentProfile) { resolved = parentProfile; how = 'inherited-branch'; }
        }

        // (4) Auto-create (or link an existing same-named) chat/character-named profile.
        if (!resolved) {
            const chatLabel = getCurrentChatLabel();
            if (chatLabel) {
                if (!extensionSettings.dbProfiles[chatLabel]) {
                    const { buildSkeletonDatabases } = await import('./database.js');
                    extensionSettings.dbProfiles[chatLabel] = {
                        databases: buildSkeletonDatabases(),
                        savedAt: Date.now(),
                        linkedChats: [],
                    };
                    how = 'auto-created';
                } else {
                    how = 'linked';
                }
                resolved = chatLabel;
            }
        }

        if (!resolved) return null;

        // LINK + ACTIVATE so the imminent fact write lands in this profile and the Database tab shows it.
        linkChatToProfile(resolved, chatId);
        extensionSettings.activeDbProfile = resolved;
        // Keep autoSaveDbProfile from re-loading (and potentially clobbering) on a later CHAT_CHANGED
        // for the SAME chat — we just established the profile for it.
        lastAutoLoadedChat = chatId;
        saveSettings();
        try { refreshDbProfileDropdown(); refreshLinkedChatsField(); } catch { /* UI optional */ }
        addDebugLog('info', `Ensured active DB profile "${resolved}" for chat ${chatId} at fact-write (${how})`, {
            subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'EAGER_ENSURE',
            data: { chatId, resolvedProfile: resolved, linkState: how, isBranch, eager: true },
        });
        return resolved;
    } catch (err) {
        addDebugLog('fail', `Eager profile ensure failed (non-fatal): ${err.message || err}`);
        return null;
    }
}

export async function saveCurrentToActiveProfile(profileKey = null, { allowEmpty = false } = {}) {
    let profileName = profileKey || extensionSettings?.activeDbProfile;
    // EAGER ENSURE: when this is an every-turn extraction save (no explicit profileKey) and there is
    // no active profile, ensure+link+activate one for the current chat NOW so the very first
    // extraction lands in a profile instead of no-op'ing. Skipped when the caller named an explicit
    // profileKey (those paths target a specific profile and shouldn't trigger auto-create).
    if (!profileName && !profileKey) {
        profileName = await ensureActiveProfileForCurrentChat();
    }
    if (!profileName) return;
    // Integrity guard: refuse to write to a profile that no longer exists
    // (prevents resurrecting a deleted profile or clobbering wrong slot after rename)
    if (!extensionSettings.dbProfiles?.[profileName]) {
        addDebugLog('fail', `Skipped save: profile "${profileName}" no longer exists (was current profile deleted?)`);
        if (typeof toastr !== 'undefined') {
            toastr.warning(`BF Memory: skipped saving facts — profile "${profileName}" was deleted.`);
        }
        return;
    }
    try {
        const { getAllDatabases } = await import('./database.js');
        const databasesRaw = await getAllDatabases();
        // USER-LEVEL SHARED MEMORY: getAllDatabases() may merge shared-store user facts (tagged with
        // a transient `__sharedOrigin`) into the character map when the feature is ON. A DB PROFILE
        // is the CHARACTER's own snapshot — it must NOT bake in shared-store copies (they'd be
        // written back per-character on profile load, defeating the dedup + risking divergence). So
        // strip `__sharedOrigin` facts here. No-op when the feature is off (nothing is ever tagged).
        const databases = {};
        for (const [cat, sdb] of Object.entries(databasesRaw || {})) {
            const facts = Array.isArray(sdb?.facts) ? sdb.facts.filter(f => !(f && f.__sharedOrigin)) : [];
            databases[cat] = sdb ? { ...sdb, facts } : { category: cat, facts };
        }
        const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
        // Empty-store guard: by default an empty map is treated as "nothing to save" so a transient
        // load failure can't wipe a populated profile. An explicit clear/delete passes allowEmpty so
        // the genuinely-cleared state is persisted (the populated copy must NOT survive a wipe).
        if (totalFacts === 0 && !allowEmpty) return;

        extensionSettings.dbProfiles[profileName] = {
            ...extensionSettings.dbProfiles[profileName],
            databases: JSON.parse(JSON.stringify(databases)),
            savedAt: Date.now(),
        };
        saveSettings();
        addDebugLog('info', `Saved to active profile "${profileName}" (${totalFacts} facts)`, {
            subsystem: 'db', event: 'profile.saved', data: { profileName, totalFacts, allowEmpty },
        });
    } catch (err) {
        addDebugLog('fail', `Failed to save active profile: ${err.message}`);
    }
}

/**
 * Prune Layer C (the dbProfiles snapshot) so a USER-initiated delete/clear actually STICKS and
 * cannot be resurrected by autoSaveDbProfile on the next CHAT_CHANGED. Without this, deleting from
 * IDB + attachments leaves the full fact copy in extensionSettings.dbProfiles[active].databases,
 * which autoSaveDbProfile reloads on chat switch.
 *
 * Prunes EVERY profile linked to the current chat (not just the active one) plus the active profile
 * itself, so a re-link to a linked-but-not-active profile can't bring the data back.
 *
 * @param {string|null} category - a single category to remove, or null to empty ALL categories
 * @returns {{ profilesPruned: string[], factsPruned: number }}
 */
function pruneActiveProfile(category = null) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return { profilesPruned: [], factsPruned: 0 };

    // Build the target set: the active profile + every profile linked to the current chat.
    const targets = new Set();
    const active = extensionSettings?.activeDbProfile;
    if (active && profiles[active]) targets.add(active);
    const chatId = getCurrentChatId();
    if (chatId) {
        for (const [name, profile] of Object.entries(profiles)) {
            if ((profile?.linkedChats || []).includes(chatId)) targets.add(name);
        }
    }

    const profilesPruned = [];
    let factsPruned = 0;
    for (const name of targets) {
        const profile = profiles[name];
        if (!profile || typeof profile !== 'object' || !profile.databases) continue;
        let changed = false;
        if (category == null) {
            // Empty ALL categories. Replace the snapshot with a fresh empty skeleton so the full
            // taxonomy still "exists" (zero facts) but no stored fact survives.
            for (const db of Object.values(profile.databases)) {
                factsPruned += (db?.facts?.length || 0);
            }
            profile.databases = {};
            changed = true;
        } else if (Object.prototype.hasOwnProperty.call(profile.databases, category)) {
            factsPruned += (profile.databases[category]?.facts?.length || 0);
            delete profile.databases[category];
            changed = true;
        }
        if (changed) {
            profile.savedAt = Date.now();
            profilesPruned.push(name);
        }
    }
    if (profilesPruned.length > 0) saveSettings();
    return { profilesPruned, factsPruned };
}

/**
 * Build the same target profile set pruneActiveProfile uses (the active profile + every profile
 * linked to the current chat). Factored out so the single-fact prune/edit write-through below can
 * touch EXACTLY the profiles that autoSaveDbProfile could reload from, guaranteeing a per-fact
 * delete/edit can never be resurrected (same 3-layer guarantee as commit 4e281b7's category delete).
 * @returns {string[]} profile names to touch
 */
function profilesLinkedToCurrentChat() {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return [];
    const targets = new Set();
    const active = extensionSettings?.activeDbProfile;
    if (active && profiles[active]) targets.add(active);
    const chatId = getCurrentChatId();
    if (chatId) {
        for (const [name, profile] of Object.entries(profiles)) {
            if ((profile?.linkedChats || []).includes(chatId)) targets.add(name);
        }
    }
    return [...targets];
}

/**
 * Prune a SINGLE fact (by category + key) from Layer C (the dbProfiles snapshot) so a per-fact
 * delete STICKS and cannot be resurrected by autoSaveDbProfile on the next CHAT_CHANGED. This is
 * the single-fact counterpart to pruneActiveProfile(category) — it removes only the one fact from
 * every profile the current chat could reload from (active + chat-linked), leaving every other fact
 * in those categories intact. Mirrors the working-store removeFact() so the two layers stay in sync.
 *
 * @param {string} category - the fact's owning category
 * @param {string} key - the fact key to remove
 * @returns {{ profilesPruned: string[], factsPruned: number }}
 */
function pruneFactFromProfiles(category, key) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || !category || !key) return { profilesPruned: [], factsPruned: 0 };
    const profilesPruned = [];
    let factsPruned = 0;
    for (const name of profilesLinkedToCurrentChat()) {
        const profile = profiles[name];
        const db = profile?.databases?.[category];
        if (!db || !Array.isArray(db.facts)) continue;
        const before = db.facts.length;
        db.facts = db.facts.filter(f => f && f.key !== key);
        const removed = before - db.facts.length;
        if (removed > 0) {
            factsPruned += removed;
            db.updatedAt = Date.now();
            profile.savedAt = Date.now();
            profilesPruned.push(name);
        }
    }
    if (profilesPruned.length > 0) saveSettings();
    return { profilesPruned, factsPruned };
}

/**
 * Write an EDITED fact through to Layer C (the dbProfiles snapshot) so an edit STICKS and the next
 * CHAT_CHANGED reloads the NEW value, not the pre-edit one. Replaces the matching fact (by key) in
 * every active+chat-linked profile's copy of the category. Mirrors the working-store edit so the
 * two layers stay in sync (same anti-resurrection guarantee as the delete paths).
 *
 * @param {string} category - the fact's owning category
 * @param {string} key - the fact key to update
 * @param {import('./database.js').FactSchema} updatedFact - the new fact object (already mutated)
 * @returns {{ profilesUpdated: string[] }}
 */
function updateFactInProfiles(category, key, updatedFact) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || !category || !key || !updatedFact) return { profilesUpdated: [] };
    const profilesUpdated = [];
    for (const name of profilesLinkedToCurrentChat()) {
        const profile = profiles[name];
        const db = profile?.databases?.[category];
        if (!db || !Array.isArray(db.facts)) continue;
        const idx = db.facts.findIndex(f => f && f.key === key);
        if (idx < 0) continue;
        // Deep-clone so the profile snapshot is independent of the live working-store object.
        db.facts[idx] = JSON.parse(JSON.stringify(updatedFact));
        db.updatedAt = Date.now();
        profile.savedAt = Date.now();
        profilesUpdated.push(name);
    }
    if (profilesUpdated.length > 0) saveSettings();
    return { profilesUpdated };
}

/**
 * Record that the user EXPLICITLY unlinked a chat from every profile, so autoSaveDbProfile will NOT
 * auto-create/re-link a profile for it on the next CHAT_CHANGED. Without this, re-entering the chat
 * silently re-links (autoSaveDbProfile's auto-create path) and the unlink appears to "do nothing".
 * Persisted in extensionSettings.unlinkedChats so the detach survives a reload.
 * @param {string} chatId
 */
function markChatUnlinked(chatId) {
    if (!chatId) return;
    if (!Array.isArray(extensionSettings.unlinkedChats)) extensionSettings.unlinkedChats = [];
    if (!extensionSettings.unlinkedChats.includes(chatId)) {
        extensionSettings.unlinkedChats.push(chatId);
        saveSettings();
    }
}

/** Re-allow auto-linking for a chat (called whenever the user explicitly links it). */
function clearChatUnlinked(chatId) {
    if (!chatId || !Array.isArray(extensionSettings.unlinkedChats)) return;
    const before = extensionSettings.unlinkedChats.length;
    extensionSettings.unlinkedChats = extensionSettings.unlinkedChats.filter(id => id !== chatId);
    if (extensionSettings.unlinkedChats.length !== before) saveSettings();
}

/** True when the user explicitly detached this chat and we must NOT auto-link it. */
function isChatUnlinked(chatId) {
    return !!chatId && Array.isArray(extensionSettings?.unlinkedChats) && extensionSettings.unlinkedChats.includes(chatId);
}

/**
 * Make an unlink actually TAKE EFFECT for the live session. When the chat just unlinked is the
 * CURRENT chat, this: (1) records the detach (so autoSaveDbProfile won't auto-relink on re-entry),
 * (2) clears activeDbProfile if it pointed at the now-unlinked profile, and (3) resets
 * lastAutoLoadedChat so a subsequent explicit re-link can reload. Without this, unlinking only
 * edited the linkedChats array while the active profile + working store stayed put and the chat
 * auto-relinked on the next CHAT_CHANGED — i.e. unlink "did nothing". No-op for a non-current chat
 * (that chat will simply not auto-load this profile next time it is opened).
 * @param {string} unlinkedChatId - the chat id just removed from the profile
 * @param {string} profileName - the profile it was removed from
 */
function detachCurrentChatIfNeeded(unlinkedChatId, profileName) {
    const currentChatId = getCurrentChatId();
    if (!unlinkedChatId || unlinkedChatId !== currentChatId) return;
    // The current chat no longer belongs to ANY profile -> stop auto-relinking it.
    if (!findProfileForChat(currentChatId)) {
        markChatUnlinked(currentChatId);
    }
    if (extensionSettings.activeDbProfile === profileName) {
        extensionSettings.activeDbProfile = '';
    }
    lastAutoLoadedChat = '';
    addDebugLog('info', `Unlinked current chat ${currentChatId} from profile "${profileName}" (detached: no auto-relink)`, {
        subsystem: 'settings', event: 'profile.unlinked', actor: 'USER', reason: 'USER_UNLINK',
        data: { chatId: currentChatId, profileName, stillLinkedElsewhere: !!findProfileForChat(currentChatId) },
    });
}

/**
 * FIX #9: Cheap client-side filter — returns true for messages that almost
 * certainly carry zero extractable facts, so the backfill can skip them WITHOUT
 * spending an LLM call. Conservative on purpose (only obvious no-ops):
 *   - empty / whitespace-only
 *   - very short (< 15 visible chars after stripping markup) — greetings,
 *     "ok", "*nods*", emoji, etc.
 *   - pure OOC lines: every non-empty line wrapped in (( )) or prefixed OOC:
 */
export function isTriviallyEmptyForExtraction(mes) {
    const raw = String(mes ?? '');
    // Strip simple action-asterisks and collapse whitespace for the length test.
    const visible = raw.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (visible.length === 0) return true;
    if (visible.length < 15) return true;

    // Pure OOC: all non-blank lines are out-of-character chatter.
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
        const allOoc = lines.every(l =>
            /^\(\(.*\)\)$/.test(l) || /^ooc\b/i.test(l) || /^\[ooc/i.test(l));
        if (allOoc) return true;
    }
    return false;
}

/**
 * FIX #9: Estimate how many LLM calls a backfill will make, so the confirm
 * dialog can warn the user about cost up front. Mirrors the skip logic in
 * runAgent3OnFullChat WITHOUT making any calls.
 */
export function estimateFullChatCalls({ skipAlreadyProcessed = true } = {}) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let calls = 0;
    for (const msg of chat) {
        if (!msg || !msg.mes) continue;
        if (msg.is_system) continue;
        if (msg.extra?.type) continue;
        if (skipAlreadyProcessed && msg.extra?.bf_mem_processed) continue;
        if (isTriviallyEmptyForExtraction(msg.mes)) continue;
        calls++;
    }
    return { calls, total: chat.length };
}

/**
 * Process every message in the current chat through Agent 3 sequentially.
 * Used by the "Run on current chat" button — for users who installed the
 * extension after their chat was already going.
 *
 * @param {object} options
 * @param {boolean} options.skipAlreadyProcessed - if true, skip messages whose
 *   extra.bf_mem_processed is already true (default true)
 * @param {(progress: {current: number, total: number, factsAdded: number}) => void} options.onProgress
 * @param {() => boolean} options.shouldCancel - return true to abort
 */
export async function runAgent3OnFullChat({ skipAlreadyProcessed = true, onProgress, shouldCancel } = {}) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    if (chat.length === 0) {
        toastr.warning('No messages in current chat', 'BF Memory');
        return { processed: 0, skipped: 0, factsAdded: 0 };
    }

    const { runMemoryUpdater } = await import('./agent-memory.js');
    const { getAgent3ProfileId } = await import('./profiler.js');
    const { getAllDatabases } = await import('./database.js');
    const { createSemaphore } = await import('./llm-call.js');

    const profileId = getAgent3ProfileId(extensionSettings);
    const charInfo = (function() {
        const char = ctx.characters?.[ctx.characterId];
        if (!char) return '';
        const parts = [];
        if (char.name) parts.push(`Name: ${char.name}`);
        if (char.description) parts.push(`Description: ${char.description.substring(0, 2000)}`);
        if (char.personality) parts.push(`Personality: ${char.personality.substring(0, 1000)}`);
        if (char.scenario) parts.push(`Scenario: ${char.scenario.substring(0, 1000)}`);
        return parts.join('\n');
    })();
    const userPersona = ctx.persona?.description || ctx.name1 || '';

    // PERF (fix): load the databases ONCE before the loop instead of re-fetching every
    // iteration. applyUpdates() mutates this map IN PLACE (via upsertFact) and persists
    // each touched category through saveDatabase(), so the same reference stays current
    // across iterations — passing it forward is both correct and avoids a fresh round of
    // fetch()+JSON.parse per message (which on a long chat was a huge serial cost and,
    // combined with the per-message LLM call below, could hang the UI). saveDatabase()
    // also invalidates the per-turn getAllDatabases() cache, so any later reader (the
    // Database tab, the next turn's pipeline) still re-reads fresh from disk.
    const databases = await getAllDatabases();

    let processed = 0, skipped = 0, factsAdded = 0;
    const total = chat.length;
    const backfillStart = Date.now();
    addDebugLog('info', `Full-chat backfill start (${total} messages)`, {
        subsystem: 'import', event: 'backfill.start', actor: 'USER',
        data: { total, profileId: profileId || null, skipAlreadyProcessed },
    });
    // FIX #7: accumulate proposed + committed facts so the Last Generated /
    // Last Inserted tabs reflect what THIS backfill produced (mirrors pipeline.js).
    const allUpdates = [];
    const allApplied = [];

    // Build the work list up front (apply skip rules) so trivial/processed messages never
    // spend an LLM call and the progress total is accurate.
    const workItems = [];
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        const skip = (reason) => addDebugLog('debug', `Full-chat: msg ${i + 1} skipped (${reason})`, {
            subsystem: 'import', event: 'backfill.skipped', reason, data: { msgIndex: i },
        });
        if (!msg || !msg.mes) { skipped++; skip('EMPTY'); continue; }
        if (msg.is_system) { skipped++; skip('SYSTEM'); continue; }
        if (msg.extra?.type) { skipped++; skip('EXTRA_TYPE'); continue; }
        if (skipAlreadyProcessed && msg.extra?.bf_mem_processed) { skipped++; skip('ALREADY_PROCESSED'); continue; }
        if (isTriviallyEmptyForExtraction(msg.mes)) {
            skipped++;
            skip('TRIVIALLY_EMPTY');
            msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
            continue;
        }
        workItems.push({ msg, idx: i });
    }

    // CONCURRENT FAN-OUT (atomic #17). The `databases` map is loaded ONCE above and shared by
    // all workers; upsertFact is synchronous between awaits, so concurrent workers can't lose
    // each other's writes. A semaphore caps parallel Scribe calls at rebuildConcurrency.
    const concurrency = Math.max(1, Math.min(6, extensionSettings.rebuildConcurrency || 3));
    const sem = createSemaphore(concurrency);
    const workTotal = workItems.length;
    const counter = { done: 0 };
    await Promise.all(workItems.map(async ({ msg, idx }) => {
        if (shouldCancel?.()) return;
        const release = await sem.acquire();
        if (shouldCancel?.()) { release(); return; }
        try {
            const result = await runMemoryUpdater(
                msg.mes, idx, charInfo, databases, profileId,
                !!msg.is_user, userPersona,
                [],   // no prior context — process each message in isolation for retro extraction
                null,
                String(msg.name || '').trim(), // source speaker (HUB FIX per-character namespacing)
            );
            const n = result?.updates?.length || 0;
            factsAdded += n;
            if (Array.isArray(result?.updates)) allUpdates.push(...result.updates);
            if (Array.isArray(result?.applied)) allApplied.push(...result.applied);
            msg.extra = { ...(msg.extra || {}), bf_mem_processed: true };
            processed++;
            addDebugLog('info', `Full-chat: msg ${idx + 1} → +${n} facts`, {
                subsystem: 'import', event: 'backfill.perMsg', data: { msgIndex: idx, total: workTotal, factsAdded: n },
            });
        } catch (err) {
            addDebugLog('fail', `Full-chat: msg ${idx + 1} failed: ${err.message || err}`, {
                subsystem: 'import', event: 'backfill.msgFailed', reason: 'ERROR', data: { msgIndex: idx, error: err.message || String(err) },
            });
        } finally {
            counter.done++;
            onProgress?.({ current: counter.done, total: workTotal, factsAdded });
            release();
        }
    }));

    // FIX #7: surface this backfill's results in the Generated / Inserted panels.
    // Replace (not append) so the tabs show what this backfill produced.
    setLastGenerated(allUpdates);
    setLastInserted(allApplied);

    // Persist chat (the extra.bf_mem_processed flags) + active DB profile
    ctx.saveChatDebounced?.();
    await saveCurrentToActiveProfile();

    addDebugLog('pass', `Full-chat backfill complete: ${processed} processed, ${skipped} skipped, +${factsAdded} facts`, {
        subsystem: 'import', event: 'backfill.complete', actor: 'USER',
        data: { processed, skipped, factsAdded, durationMs: Date.now() - backfillStart },
    });
    return { processed, skipped, factsAdded };
}

async function autoSaveDbProfile() {
    try {
        const context = getContext();
        const chatId = getCurrentChatId();
        const chatLabel = getCurrentChatLabel();

        if (!chatId) return;
        if (chatId === lastAutoLoadedChat) return; // same chat, already loaded

        // NOTE: CHAT_CHANGED only LOADS, never SAVES. Saving here is unsafe because
        // ST may have already mutated state by flush time, causing the in-memory DB
        // (belonging to the previous chat) to be written into the wrong profile slot.
        // Persistence is handled at extraction time via saveCurrentToActiveProfile()
        // called from pipeline.js after every Agent 3 write (capture-at-write).

        // Observability: track HOW this chat resolved its DB so a single consolidated db.connect
        // event can tell the whole connect story (linked / auto-created / suppressed / none). This
        // only records what the existing branches already decided — it changes no behavior.
        const isBranch = isBranchChat(chatId);
        let linkState = 'none';

        // Check if this chat has a linked profile
        let profileToLoad = findProfileForChat(chatId);
        if (profileToLoad) linkState = 'linked';

        // RESPECT EXPLICIT UNLINK: if the user detached THIS chat from every profile (via the
        // Manage popup / "Unlink current chat" button), do NOT auto-create or re-link a profile
        // for it. Without this the auto-create path below silently re-links on re-entry and the
        // unlink appears to "do nothing". The chat runs with whatever is in the working store and
        // no profile is reloaded over it. (Explicitly linking the chat again clears this flag.)
        if (!profileToLoad && isChatUnlinked(chatId)) {
            // Make sure we are not still pointing at a now-detached active profile.
            if (extensionSettings.activeDbProfile && !findProfileForChat(chatId)) {
                extensionSettings.activeDbProfile = '';
                saveSettings();
                refreshDbProfileDropdown();
                refreshLinkedChatsField();
            }
            addDebugLog('info', `Auto-link suppressed: chat ${chatId} was explicitly unlinked by user`, {
                subsystem: 'settings', event: 'profile.autolinkSuppressed', actor: 'USER', reason: 'EXPLICIT_UNLINK',
                data: { chatId },
            });
            // Consolidated connect summary for the suppressed case: no profile reloaded over the
            // working store. factsLoaded/categories reflect whatever is already live in the store.
            try {
                const { getAllDatabases } = await import('./database.js');
                const live = await getAllDatabases();
                const cats = Object.keys(live || {});
                const factsLoaded = cats.reduce((n, c) => n + ((live[c]?.facts || []).length), 0);
                addDebugLog('info', `DB connect: chat ${chatId} -> (unlinked, suppressed) ${factsLoaded} facts`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                    data: {
                        chatId, resolvedProfile: null, linkState: 'unlinked-suppressed',
                        factsLoaded, categories: cats.length,
                        source: factsLoaded > 0 ? 'idb' : 'empty', isBranch,
                    },
                });
            } catch { /* logging-only: best-effort */ }
            lastAutoLoadedChat = chatId;
            return;
        }

        // BRANCH INHERIT (data-safety, default = INHERIT): a branched chat has a brand-new chatId
        // that is in no profile's linkedChats, so findProfileForChat() above returned null. Rather
        // than auto-creating an EMPTY skeleton profile (which would diverge the branch from the
        // parent's accumulated memory and, via the old destructive load, blank the shared
        // avatar-keyed working store), resolve the branch to the PARENT's existing profile and link
        // this branch id to it. The avatar store already holds the parent's facts; inheriting the
        // parent profile means the load block re-applies the parent's facts (not an empty skeleton).
        if (!profileToLoad && isBranch) {
            const parentProfile = resolveBranchParentProfile(chatId);
            if (parentProfile) {
                linkChatToProfile(parentProfile, chatId);
                profileToLoad = parentProfile;
                linkState = 'inherited-branch';
                addDebugLog('info', `Branch inherited parent DB profile "${parentProfile}" for chat ${chatId}`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'BRANCH_INHERIT',
                    data: { chatId, resolvedProfile: parentProfile, parentChatId: parentChatIdOfBranch(chatId), isBranch: true },
                });
            }
        }

        // If no linked profile exists, create one named after the chat/character
        if (!profileToLoad && chatLabel) {
            // Only auto-create if we're entering a chat for the first time
            if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
            if (!extensionSettings.dbProfiles[chatLabel]) {
                // 3-layer model: seed the new profile's in-memory databases with the empty
                // Layer-1 skeleton so the full taxonomy "exists" from turn 1 (visible in the
                // menu / Database tab, pickable by Agent 1). These are EMPTY (zero facts) and
                // are NOT written as attachment files here — a category file is persisted only
                // when a real fact lands (write-on-first-fact via Agent 3 / saveDatabase), so
                // we never spam the backend with empty uploads.
                const { buildSkeletonDatabases } = await import('./database.js');
                const seeded = buildSkeletonDatabases();
                extensionSettings.dbProfiles[chatLabel] = {
                    databases: seeded,
                    savedAt: Date.now(),
                    linkedChats: [chatId],
                };
                addDebugLog('info', `Auto-created DB profile "${chatLabel}" (seeded Layer-1 skeleton) for chat ${chatId}`, {
                    subsystem: 'import', event: 'db.seeded', actor: 'SYSTEM',
                    data: { profileName: chatLabel, chatId, categoriesSeeded: Object.keys(seeded) },
                });
                linkState = 'auto-created';
            } else {
                // Profile with that name exists, link this chat to it
                linkChatToProfile(chatLabel, chatId);
                // A pre-existing same-named profile we just linked to is, for connect-story
                // purposes, a linked load (not a fresh auto-create).
                linkState = 'linked';
            }
            profileToLoad = chatLabel;
        }

        // Load the linked profile
        if (profileToLoad && extensionSettings.dbProfiles?.[profileToLoad]) {
            const profile = extensionSettings.dbProfiles[profileToLoad];
            const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

            // DATA-SAFETY FIX (non-destructive empty-profile load): count the facts the resolved
            // profile would actually install. A freshly auto-created / skeleton profile carries ZERO
            // facts — and the OLD code unconditionally delete-all'd every live category (wiping the
            // shared avatar-keyed IDB record AND its durable attachment files) and then re-wrote only
            // the profile's NON-empty categories. For an empty profile that BLANKED the working store
            // → retrieval saw 0 facts → extraction minted fresh DBs → the stamp race rehydrated stale
            // data back. Opening a chat must NEVER blank existing memory.
            const profileFactCount = Object.values(profile.databases || {})
                .reduce((n, db) => n + ((db && Array.isArray(db.facts)) ? db.facts.length : 0), 0);

            if (profileFactCount === 0) {
                // EMPTY PROFILE → do NOT clear. Leave the avatar-keyed working store INTACT; the
                // empty Layer-1 skeleton is layered UNDER it via withSkeleton at the menu/Database
                // tab. This makes a fresh branch / empty-profile chat inherit whatever the shared
                // avatar store already holds instead of being wiped to empty.
                const live = await getAllDatabases();
                const liveFacts = Object.values(live || {})
                    .reduce((n, db) => n + ((db?.facts || []).length), 0);
                addDebugLog('info', `Auto-load SKIPPED clear: profile "${profileToLoad}" has 0 facts — kept live store (${liveFacts} facts)`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'NON_DESTRUCTIVE_EMPTY_PROFILE',
                    data: { chatId, resolvedProfile: profileToLoad, decision: 'KEEP_LIVE_STORE', profileFactCount, liveFacts, isBranch },
                });
            } else {
                // POPULATED PROFILE → install its facts. Clear existing first (the profile is the
                // authoritative copy for this chat), then re-write its NON-empty categories. Skip
                // EMPTY (factless) categories: the Layer-1 skeleton is seeded in memory and shown via
                // withSkeleton — persisting empty categories as attachments would spam the backend.
                const existing = await getAllDatabases();
                for (const category of Object.keys(existing)) {
                    await deleteDatabase(category);
                }
                for (const [category, db] of Object.entries(profile.databases || {})) {
                    if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
                    await saveDatabase({ ...db, category });
                }
            }

            extensionSettings.activeDbProfile = profileToLoad;
            saveSettings();
            refreshDbProfileDropdown();
            refreshLinkedChatsField();
            addDebugLog('info', `Auto-loaded DB profile "${profileToLoad}" (linked to chat ${chatId})`, {
                subsystem: 'import', event: 'profile.switched', actor: 'SYSTEM', reason: 'AUTO_LOADED', data: { profileName: profileToLoad, chatId },
            });

            // Consolidated connect summary (one line tells the whole connect story). Census the
            // working store right after the load so factsLoaded/categories reflect what actually
            // landed. source: 'profile' when facts came in from the dbProfile, 'empty' when the
            // resolved profile carried zero facts (e.g. fresh skeleton). Read-only.
            try {
                const live = await getAllDatabases();
                const cats = Object.keys(live || {});
                const factsLoaded = cats.reduce((n, c) => n + ((live[c]?.facts || []).length), 0);
                addDebugLog('info', `DB connect: chat ${chatId} -> profile "${profileToLoad}" (${linkState}) ${factsLoaded} facts`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                    data: {
                        chatId, resolvedProfile: profileToLoad, linkState,
                        factsLoaded, categories: cats.length,
                        source: factsLoaded > 0 ? 'profile' : 'empty', isBranch,
                    },
                });
            } catch { /* logging-only: best-effort */ }
        } else {
            // No profile resolved AND not the suppressed path (e.g. no chatLabel to name one).
            // Emit a connect summary so the absence of a DB context is still visible in the log.
            addDebugLog('info', `DB connect: chat ${chatId} -> (no profile resolved)`, {
                subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                data: {
                    chatId, resolvedProfile: null, linkState: 'none',
                    factsLoaded: null, categories: null, source: 'empty', isBranch,
                },
            });
        }

        lastAutoLoadedChat = chatId;
    } catch (err) {
        addDebugLog('fail', `Auto-save DB profile failed: ${err.message}`);
    }
}

function refreshLinkedChatsField() {
    const display = document.getElementById('bf_mem_db_linked_chats');
    if (!display) return;
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        display.textContent = '(none)';
        return;
    }
    const profile = extensionSettings.dbProfiles[profileName];
    const chats = profile.linkedChats || [];
    display.textContent = chats.length > 0 ? chats.join(', ') : '(none)';
}

async function showLinkedChatsPopup() {
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        toastr.warning('No profile selected', 'BF Memory');
        return;
    }

    const profile = extensionSettings.dbProfiles[profileName];
    const linkedChats = [...(profile.linkedChats || [])];
    const currentChatId = getCurrentChatId();

    let html = `<div class="bf-mem-linked-popup">
        <h4>Linked Chats for "${escapeHtml(profileName)}"</h4>
        <p>These chats will auto-load this DB profile when opened.</p>
        <div class="bf-mem-linked-list" id="bf_mem_linked_list">`;

    if (linkedChats.length === 0) {
        html += '<div class="bf-mem-empty">No chats linked yet.</div>';
    } else {
        for (const chatId of linkedChats) {
            const isCurrent = chatId === currentChatId;
            html += `<div class="bf-mem-linked-item">
                <span class="bf-mem-linked-name">${escapeHtml(chatId)}${isCurrent ? ' (current)' : ''}</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
        }
    }

    html += `</div>
        <div class="bf-mem-linked-add-row" style="margin-top: 10px;">
            <button id="bf_mem_link_current" class="menu_button">
                <i class="fa-solid fa-plus"></i> Link Current Chat
            </button>
        </div>
    </div>`;

    await ensurePopup();
    if (!Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
    await popup.show();

    // Bind remove buttons
    document.querySelectorAll('.bf-mem-linked-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const chatId = btn.dataset.chat;
            const idx = profile.linkedChats.indexOf(chatId);
            if (idx >= 0) {
                profile.linkedChats.splice(idx, 1);
                detachCurrentChatIfNeeded(chatId, profileName);
                saveSettings();
                refreshLinkedChatsField();
                refreshDbProfileDropdown();
                btn.closest('.bf-mem-linked-item').remove();
                toastr.success(`Unlinked "${chatId}"`, 'BF Memory');
            }
        });
    });

    // Bind "Link Current Chat" button
    document.getElementById('bf_mem_link_current')?.addEventListener('click', () => {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('No chat currently open', 'BF Memory');
            return;
        }
        if (!profile.linkedChats) profile.linkedChats = [];
        if (profile.linkedChats.includes(chatId)) {
            toastr.info('Current chat is already linked', 'BF Memory');
            return;
        }
        // Remove from other profiles first
        for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
            if (name !== profileName && p.linkedChats) {
                p.linkedChats = p.linkedChats.filter(id => id !== chatId);
            }
        }
        profile.linkedChats.push(chatId);
        // An explicit (re-)link re-enables auto-link for this chat and makes it the active profile.
        clearChatUnlinked(chatId);
        extensionSettings.activeDbProfile = profileName;
        lastAutoLoadedChat = '';
        saveSettings();
        refreshLinkedChatsField();
        refreshDbProfileDropdown();
        toastr.success(`Linked current chat to "${profileName}"`, 'BF Memory');
        // Refresh the popup list
        const listEl = document.getElementById('bf_mem_linked_list');
        if (listEl) {
            const item = document.createElement('div');
            item.className = 'bf-mem-linked-item';
            item.innerHTML = `<span class="bf-mem-linked-name">${escapeHtml(chatId)} (current)</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>`;
            listEl.querySelector('.bf-mem-empty')?.remove();
            listEl.appendChild(item);
        }
    });
}

// --- Init ---

// =============================================================================
// C1 — USABILITY PRESETS (Cheap · Balanced · Max Recall)
// -----------------------------------------------------------------------------
// One dropdown that maps a single choice onto the many token/retrieval knobs, so a new user
// doesn't have to understand ~40 settings. This is ALSO the delivery vehicle for the token
// cuts (Parts A/B): "Cheap" flips on history-trimming, drops the Finder LLM, turns on the
// pull-on-demand recall tool, and tightens the injection caps. Everything else stays under the
// existing per-tab controls ("Advanced").
//
// DESIGN: a preset only writes the keys listed in GOVERNED_KEYS — never `enabled`, never the
// connection profiles, never prompts. Detection compares ONLY those keys, so a user's unrelated
// tweaks never force the dropdown to "Custom". Applying validates+saves through the SAME paths a
// manual edit uses, re-syncs the on-screen controls, and re-syncs the optional Writer tools.
// =============================================================================

const PRESET_IDS = new Set(['cheap', 'balanced', 'maxrecall', 'custom']);

// The exact knobs a preset governs. Detection + apply both operate on ONLY these keys.
const GOVERNED_KEYS = [
    // useFinderAgent intentionally NOT governed: the Finder (Agent 4) is hard-disabled in the
    // pipeline (wantFinder=false), so writing/comparing it via presets is a no-op that only made
    // preset switching look like it changed retrieval. Presets now leave it untouched.
    'semanticRetrieval', 'agent2ContextMessages',
    'enableSummaryPyramid', 'enableWriterRecallTool',
    'retrievalTokenBudget', 'finderTargetFacts', 'finderAnchorsPerCharacter',
    'reflectionInterval',
];

// Preset signatures. NOTE on semanticRetrieval:true everywhere — it GRACEFULLY no-ops when no
// embedding endpoint responds (callEmbeddingAPI returns null → keyword/trigram retrieval), so it
// is safe to enable blind; it only helps when an embedding model is configured.
const PRESETS = {
    // CHEAP — fewest tokens: no Finder LLM (vectors/keyword retrieve), trim history so facts
    // replace old turns, lean on the pull-on-demand recall tool + a small overview, tight caps,
    // consolidate less often.
    cheap: {
        useFinderAgent: false,
        semanticRetrieval: true,
        agent2ContextMessages: 10,
        enableSummaryPyramid: true,
        enableWriterRecallTool: true,
        retrievalTokenBudget: 300,
        finderTargetFacts: 6,
        finderAnchorsPerCharacter: 2,
        reflectionInterval: 20,
    },
    // BALANCED — the recommended default: Finder on for precise picks, semantic on, modest history
    // trim, overview + recall tool on, default caps.
    balanced: {
        useFinderAgent: true,
        semanticRetrieval: true,
        agent2ContextMessages: 10,
        enableSummaryPyramid: true,
        enableWriterRecallTool: true,
        retrievalTokenBudget: 800,
        finderTargetFacts: 12,
        finderAnchorsPerCharacter: 3,
        reflectionInterval: 12,
    },
    // MAX RECALL — quality over cost: full history (no trim), wide caps, more anchors, frequent
    // consolidation. The most expensive option.
    maxrecall: {
        useFinderAgent: true,
        semanticRetrieval: true,
        agent2ContextMessages: 0,
        enableSummaryPyramid: true,
        enableWriterRecallTool: true,
        retrievalTokenBudget: 1600,
        finderTargetFacts: 16,
        finderAnchorsPerCharacter: 4,
        reflectionInterval: 10,
    },
};

/** Human label for a preset id (dropdown + toasts). */
function presetLabel(id) {
    return ({ cheap: 'Cheap', balanced: 'Balanced', maxrecall: 'Max Recall', custom: 'Custom' })[id] || 'Custom';
}

/**
 * Which preset (if any) the CURRENT settings match — compares ONLY GOVERNED_KEYS so unrelated
 * tweaks never force 'custom'. Returns a preset id or 'custom'. Pure read; never mutates.
 * @returns {string}
 */
function detectPreset() {
    for (const [id, sig] of Object.entries(PRESETS)) {
        let match = true;
        for (const k of GOVERNED_KEYS) {
            // Compare loosely against the signature; booleans use the same "!== false"/"=== true"
            // truth the rest of the code uses so legacy/undefined values still match cleanly.
            const want = sig[k];
            const have = extensionSettings[k];
            const eq = (typeof want === 'boolean')
                ? (!!have === want)
                : (Number(have) === Number(want));
            if (!eq) { match = false; break; }
        }
        if (match) return id;
    }
    return 'custom';
}

// Set true WHILE applyPreset() is writing, so the "manual edit → Custom" delegated listener
// (wired in initSettings) doesn't fire on our own programmatic control updates.
let _applyingPreset = false;

/**
 * Push the governed settings values onto their on-screen controls (range/checkbox + value labels).
 * jQuery no-ops on a missing selector, so this is safe even if a control isn't in the DOM yet.
 */
function syncPresetControls() {
    $('#bf_mem_finder_enabled').prop('checked', extensionSettings.useFinderAgent !== false);
    $('#bf_mem_semantic_enabled').prop('checked', extensionSettings.semanticRetrieval === true);
    $('#bf_mem_pyramid_enabled').prop('checked', extensionSettings.enableSummaryPyramid === true);
    $('#bf_mem_recall_tool_enabled').prop('checked', extensionSettings.enableWriterRecallTool === true);
    $('#bf_mem_agent2_context').val(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context_val').text(extensionSettings.agent2ContextMessages);
    $('#bf_mem_reflection_interval').val(extensionSettings.reflectionInterval);
    $('#bf_mem_reflection_interval_val').text(extensionSettings.reflectionInterval);
    // NOTE: retrievalTokenBudget / finderTargetFacts / finderAnchorsPerCharacter are governed by
    // presets but have NO on-screen control (no slider in settings.html) — nothing to sync here.
    // They're still written by applyPreset() and consumed by the pipeline; they simply can't be
    // hand-edited from the UI, so they can never drift a preset to "Custom".
}

/**
 * Apply a preset by id: write ONLY the governed keys, validate+save through the normal path,
 * re-sync the on-screen controls, re-sync the optional Writer recall tool (its registration is a
 * side-effect of enableWriterRecallTool), update the dropdown, and toast. 'custom' is a no-op
 * write (just records the id). Fully guarded — never throws into the caller.
 * @param {string} id
 */
function applyPreset(id) {
    if (!PRESET_IDS.has(id)) id = 'custom';
    const sig = PRESETS[id];
    _applyingPreset = true;
    try {
        const before = {};
        if (sig) {
            for (const k of GOVERNED_KEYS) { before[k] = extensionSettings[k]; extensionSettings[k] = sig[k]; }
        }
        extensionSettings.uiPreset = id;
        validateSettings(extensionSettings);
        saveSettings();
        syncPresetControls();
        $('#bf_mem_preset').val(id);
        addDebugLog('info', `Applied "${presetLabel(id)}" preset`, {
            subsystem: 'settings', event: 'settings.preset', actor: 'USER',
            data: { preset: id, governed: sig ? GOVERNED_KEYS.reduce((o, k) => (o[k] = extensionSettings[k], o), {}) : null, before: sig ? before : null },
        });
        // The recall tool registers/unregisters as a side-effect of enableWriterRecallTool — sync it
        // the same way the manual toggle handler does (dynamic import avoids a static cycle).
        if (sig) {
            import('./agent-writer.js')
                .then(({ syncWriterRecallTool }) => syncWriterRecallTool?.())
                .catch(() => { /* tool API not ready — will sync on next init */ });
        }
        if (sig && typeof toastr !== 'undefined') {
            toastr.success(`Memory preset: ${presetLabel(id)}`, 'BF Memory', { timeOut: 2500 });
        }
    } catch (err) {
        addDebugLog('fail', `Applying preset "${id}" failed (non-fatal): ${err?.message || err}`);
    } finally {
        _applyingPreset = false;
    }
}

export async function initSettings() {
    const context = getContext();

    // Load saved settings (guard against null, arrays, primitives, or corrupted blobs)
    if (!context.extensionSettings) context.extensionSettings = {};
    let resetClobberedEnabled = false; // FIX #10: track if a reset flipped enabled true->false
    let freshInstall = false; // C4: genuine first run (no prior settings object) → show a nudge
    try {
        const current = context.extensionSettings[EXTENSION_NAME];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            // A genuine first install has NO prior object at all (nullish). A corrupt non-null blob
            // is a reset, not a first run — don't nudge in that case.
            if (current == null) freshInstall = true;
            if (current && typeof current === 'object' && current.enabled === true) resetClobberedEnabled = true;
            context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
    } catch (err) {
        console.error('[BFMemory] corrupt settings, resetting:', err);
        try { if (context.extensionSettings?.[EXTENSION_NAME]?.enabled === true) resetClobberedEnabled = true; } catch { /* ignore */ }
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        if (typeof toastr !== 'undefined') {
            toastr.warning('BF Memory settings were corrupt and have been reset.');
        }
    }
    extensionSettings = context.extensionSettings[EXTENSION_NAME];

    // Merge missing defaults
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings, key)) {
            extensionSettings[key] = value;
        }
    }

    // Migrate legacy settings keys (soft migration — leaves old key for rollback)
    migrateLegacySettings(extensionSettings);

    // Type-coerce and clamp values (defends against persisted garbage)
    validateSettings(extensionSettings);

    // FIX #10: log if a corrupt-settings reset silently turned the pipeline off.
    if (resetClobberedEnabled && !extensionSettings.enabled) {
        addDebugLog('fail', 'Pipeline DISABLED by corrupt-settings reset (was enabled before reset)');
    }

    // Load HTML template
    let path = `scripts/extensions/third-party/${EXTENSION_NAME}`;
    let html = null;

    try {
        html = await $.get(`${path}/templates/settings.html`);
    } catch {
        path = `scripts/extensions/${EXTENSION_NAME}`;
        try {
            html = await $.get(`${path}/templates/settings.html`);
        } catch {
            console.error('[BFMemory] Failed to load UI template');
            return;
        }
    }

    $('#extensions_settings').append(html);

    // Populate version label from manifest (single source of truth — no risk of drift).
    // If the fetch fails, the placeholder "v?.?.?" remains so testers can see it didn't load.
    try {
        const manifest = await $.getJSON(`${path}/manifest.json`);
        if (manifest?.version) {
            $('#bf_mem_version').text(`v${manifest.version}`);
        }
    } catch (err) {
        console.warn('[BFMemory] Could not load manifest for version label:', err?.message);
    }

    // --- Setup Tabs ---
    setupTabs();

    // C4: first-run nudge. On a genuine first install the pipeline ships with the "Balanced" preset
    // but stays DISABLED (auto-running an LLM pipeline unprompted would be too aggressive). Point the
    // user at the two clicks that matter: tick Enable, and pick a (cheap) memory model. Fires once.
    if (freshInstall && typeof toastr !== 'undefined') {
        try {
            toastr.info(
                'Ready on the "Balanced" preset. Tick Enable, then pick a memory model in the Drafter/Scribe tabs (a cheap one is fine). Switch to "Cheap" mode to save tokens.',
                'BF Memory — quick start',
                { timeOut: 12000, extendedTimeOut: 6000 },
            );
        } catch { /* nudge is best-effort */ }
        addDebugLog('info', 'First-run install detected — shipped with Balanced preset (disabled until user enables)', {
            subsystem: 'settings', event: 'settings.first_run', actor: 'SYSTEM', data: { preset: extensionSettings.uiPreset },
        });
    }

    // --- Pipeline Tab ---
    $('#bf_mem_enabled').prop('checked', extensionSettings.enabled).on('change', function () {
        const next = $(this).prop('checked');
        // FIX #10: log enable/disable state changes.
        if (next !== extensionSettings.enabled) {
            addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} by user`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled' }, before: !!extensionSettings.enabled, after: !!next });
        }
        extensionSettings.enabled = next;
        updateStatus('idle');
        saveSettings();
        // CANCEL ON DISABLE: toggling OFF must HALT an in-flight run promptly, not let it finish
        // ~75s later and inject. cancelActiveRun() sets the cancel flag AND aborts in-flight agent
        // LLM calls. Dynamic import avoids a static circular dep (pipeline.js imports settings.js).
        if (!next) {
            import('./pipeline.js')
                .then(({ cancelActiveRun }) => cancelActiveRun?.('disabled'))
                .catch(() => { /* pipeline not ready yet — nothing in flight to cancel */ });
        }
    });

    // --- C1: Usability preset dropdown (Cheap · Balanced · Max Recall · Custom) ---
    // Reconcile the stored id against the LIVE values first: if the user (or a future default flip)
    // left the knobs matching a preset, show that preset; otherwise 'custom'. This keeps the
    // dropdown honest without ever rewriting the user's knobs on load.
    {
        const detected = detectPreset();
        if (detected !== extensionSettings.uiPreset) {
            extensionSettings.uiPreset = detected;
            saveSettings();
        }
        $('#bf_mem_preset').val(extensionSettings.uiPreset);
        $('#bf_mem_preset').on('change', function () {
            applyPreset($(this).val());
        });
        // Manual edit of ANY governed control flips the dropdown back to "Custom" so it never lies.
        // Delegated so it covers every governed input regardless of bind order; skipped while
        // applyPreset() is doing its own programmatic writes (_applyingPreset guard).
        // Only the governed settings that HAVE an on-screen control are listed (the three
        // budget/target/anchor keys have no slider, so they can't be manually edited anyway).
        const governedSelector = [
            // #bf_mem_finder_enabled removed: useFinderAgent is no longer in GOVERNED_KEYS (Finder
            // hard-disabled), so toggling it must NOT flip the preset to Custom.
            '#bf_mem_semantic_enabled', '#bf_mem_pyramid_enabled',
            '#bf_mem_recall_tool_enabled', '#bf_mem_agent2_context', '#bf_mem_reflection_interval',
        ].join(',');
        $('#bf_memory_settings').on('change input', governedSelector, function () {
            if (_applyingPreset) return;
            if (extensionSettings.uiPreset !== 'custom') {
                extensionSettings.uiPreset = 'custom';
                $('#bf_mem_preset').val('custom');
                saveSettings();
            }
        });
    }

    // "Use separate profiles" toggle REMOVED (v0.21.x menu cleanup): per-agent profiles are
    // now ALWAYS active. The useMemoryProfile key is kept (default true) for back-compat;
    // profiler.js no longer gates on it (getAgent1/3/4ProfileId always honor configured profiles).

    reloadProfiles();
    $('#bf_mem_agent1_profile').val(extensionSettings.agent1Profile || '').on('change', function () {
        extensionSettings.agent1Profile = $(this).val() || '';
        addDebugLog('info', `Agent 1 profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent1Profile', value: extensionSettings.agent1Profile } });
        saveSettings();
    });
    $('#bf_mem_agent3_profile').val(extensionSettings.agent3Profile || '').on('change', function () {
        extensionSettings.agent3Profile = $(this).val() || '';
        addDebugLog('info', `Agent 3 profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent3Profile', value: extensionSettings.agent3Profile } });
        saveSettings();
    });

    $('#bf_mem_refresh_profiles').on('click', () => {
        reloadProfiles();
        toastr.info('Profiles refreshed', 'BF Memory');
    });

    // Agent 4 (Fact Finder) — toggle + profile selector (Agent 2 tab / Fact Finder section).
    // reloadProfiles() above already populated the dropdown; just bind value + change.
    $('#bf_mem_finder_enabled').prop('checked', extensionSettings.useFinderAgent !== false).on('change', function () {
        const before = extensionSettings.useFinderAgent !== false;
        extensionSettings.useFinderAgent = $(this).prop('checked');
        addDebugLog('info', `Finder agent ${extensionSettings.useFinderAgent ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'useFinderAgent' }, before, after: !!extensionSettings.useFinderAgent });
        saveSettings();
    });
    $('#bf_mem_agent4_profile').val(extensionSettings.agent4Profile || '').on('change', function () {
        extensionSettings.agent4Profile = $(this).val() || '';
        addDebugLog('info', `Finder profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent4Profile', value: extensionSettings.agent4Profile } });
        saveSettings();
    });

    // Agent 1 context slider
    $('#bf_mem_agent1_context').val(extensionSettings.agent1ContextMessages);
    $('#bf_mem_agent1_context_val').text(extensionSettings.agent1ContextMessages);
    $('#bf_mem_agent1_context').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.agent1ContextMessages;
        extensionSettings.agent1ContextMessages = val;
        $('#bf_mem_agent1_context_val').text(val);
        if (before !== val) addDebugLog('debug', `Agent 1 context messages: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent1ContextMessages' }, before, after: val });
        saveSettings();
    });

    // Agent 3 context slider
    $('#bf_mem_agent3_context').val(extensionSettings.agent3ContextMessages);
    $('#bf_mem_agent3_context_val').text(extensionSettings.agent3ContextMessages);
    $('#bf_mem_agent3_context').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.agent3ContextMessages;
        extensionSettings.agent3ContextMessages = val;
        $('#bf_mem_agent3_context_val').text(val);
        if (before !== val) addDebugLog('debug', `Agent 3 context messages: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent3ContextMessages' }, before, after: val });
        saveSettings();
    });

    // Agent 2 context slider (force-attention duplication)
    $('#bf_mem_agent2_context').val(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context_val').text(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.agent2ContextMessages = val;
        $('#bf_mem_agent2_context_val').text(val);
        saveSettings();
    });

    // A2/B5 frozen injection slider (0 = off; reuse cached facts for N turns before a fresh pull).
    $('#bf_mem_freeze_turns').val(extensionSettings.injectionFreezeTurns || 0);
    $('#bf_mem_freeze_turns_val').text(extensionSettings.injectionFreezeTurns || 0);
    $('#bf_mem_freeze_turns').on('input', function () {
        const val = parseInt($(this).val(), 10) || 0;
        extensionSettings.injectionFreezeTurns = val;
        $('#bf_mem_freeze_turns_val').text(val);
        saveSettings();
    });

    // Writer recall tool toggle (pull-detail / "infinite reach"). Default OFF. Toggling it
    // register/unregisters the optional search_memory function-tool via syncWriterRecallTool().
    $('#bf_mem_recall_tool_enabled').prop('checked', extensionSettings.enableWriterRecallTool === true).on('change', function () {
        const before = extensionSettings.enableWriterRecallTool === true;
        const next = $(this).prop('checked');
        extensionSettings.enableWriterRecallTool = next;
        addDebugLog('info', `Writer recall tool ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableWriterRecallTool' }, before, after: !!next });
        saveSettings();
        // Re-sync registration to the new state (cycle-safe lazy import).
        import('./agent-writer.js').then(m => m.syncWriterRecallTool?.()).catch(() => {});
    });

    // Writer WRITE tool toggle (remember_fact / model-writable pin). Default OFF. Toggling it
    // register/unregisters the optional remember_fact function-tool via syncWriterWriteTool().
    $('#bf_mem_write_tool_enabled').prop('checked', extensionSettings.enableWriterWriteTool === true).on('change', function () {
        const before = extensionSettings.enableWriterWriteTool === true;
        const next = $(this).prop('checked');
        extensionSettings.enableWriterWriteTool = next;
        addDebugLog('info', `Writer write tool ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableWriterWriteTool' }, before, after: !!next });
        saveSettings();
        // Re-sync registration to the new state (cycle-safe lazy import).
        import('./agent-writer.js').then(m => m.syncWriterWriteTool?.()).catch(() => {});
    });

    // Tool-first redesign — RECALL STRATEGY (memoryMode). Chooses how stored memory reaches the
    // main model: 'hybrid' (default) and 'tool-only' skip the blocking Drafter LLM call and let the
    // model pull facts via search_memory; 'push' restores the classic always-plan Drafter. Pure
    // setting (no registration side-effect) — the pipeline reads it per turn.
    $('#bf_mem_memory_mode').val(extensionSettings.memoryMode || 'hybrid').on('change', function () {
        const before = extensionSettings.memoryMode || 'hybrid';
        const next = $(this).val();
        extensionSettings.memoryMode = next;
        addDebugLog('info', `Recall strategy (memory mode) → ${next}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'memoryMode' }, before, after: next });
        saveSettings();
    });

    // Summary pyramid "Big Picture" injection toggle. Default OFF. Gates ONLY whether the
    // story+shelf summaries are injected into the Writer's context — shelf summaries are
    // still generated on the reflection cadence regardless. No registration side-effect.
    $('#bf_mem_pyramid_enabled').prop('checked', extensionSettings.enableSummaryPyramid === true).on('change', function () {
        const before = extensionSettings.enableSummaryPyramid === true;
        const next = $(this).prop('checked');
        extensionSettings.enableSummaryPyramid = next;
        addDebugLog('info', `Summary pyramid Big Picture injection ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableSummaryPyramid' }, before, after: !!next });
        saveSettings();
    });

    // Moment echo (Resonance Part B) injection toggle. Default OFF. Gates ONLY whether a single
    // narrow `[Echo: …]` line (one resonant past moment for the present pair) is injected; emits
    // nothing on most turns even when on. No registration side-effect.
    $('#bf_mem_moment_echo_enabled').prop('checked', extensionSettings.enableMomentEcho === true).on('change', function () {
        const before = extensionSettings.enableMomentEcho === true;
        const next = $(this).prop('checked');
        extensionSettings.enableMomentEcho = next;
        addDebugLog('info', `Moment echo injection ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableMomentEcho' }, before, after: !!next });
        saveSettings();
    });

    // Auto-linking toggle (A-MEM style associative linking). DEFAULT ON (free + deterministic),
    // so the checkbox reflects `!== false`. Gates whether applyUpdates auto-connects a fresh fact
    // to related existing facts via `relationships`. No registration side-effect.
    $('#bf_mem_autolink_enabled').prop('checked', extensionSettings.enableAutoLinking !== false).on('change', function () {
        const before = extensionSettings.enableAutoLinking !== false;
        const next = $(this).prop('checked');
        extensionSettings.enableAutoLinking = next;
        addDebugLog('info', `Automatic associative linking ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enableAutoLinking' }, before, after: !!next });
        saveSettings();
    });

    // B3 safe slice: trim already-extracted prior context out of the Scribe's input. Default OFF.
    $('#bf_mem_scribe_trim_priors').prop('checked', extensionSettings.scribeTrimProcessedPriors === true).on('change', function () {
        const before = extensionSettings.scribeTrimProcessedPriors === true;
        const next = $(this).prop('checked');
        extensionSettings.scribeTrimProcessedPriors = next;
        addDebugLog('info', `Scribe trim already-extracted priors ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'scribeTrimProcessedPriors' }, before, after: !!next });
        saveSettings();
    });

    // Bi-temporal fact validity toggle (Graphiti/Zep valid_at/invalid_at). DEFAULT OFF, so the
    // checkbox reflects `=== true`. Gates story-world `from:`/`until:` marker parsing (agent-memory),
    // the supersession `validUntil` stamp (database), and the formatter annotation (fact-retrieval).
    $('#bf_mem_bitemporal_enabled').prop('checked', extensionSettings.biTemporal === true).on('change', function () {
        const before = extensionSettings.biTemporal === true;
        const next = $(this).prop('checked');
        extensionSettings.biTemporal = next;
        addDebugLog('info', `Bi-temporal fact validity ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'biTemporal' }, before, after: !!next });
        saveSettings();
    });

    // User-level shared memory (opt-in, default OFF). Gates routing user-subject facts into the
    // shared global store on write (database.saveDatabase) and merging that store into every
    // character's map on read (database.getAllDatabases). When off, storage+retrieval are unchanged.
    $('#bf_mem_user_level_memory').prop('checked', extensionSettings.userLevelMemory === true).on('change', function () {
        const before = extensionSettings.userLevelMemory === true;
        const next = $(this).prop('checked');
        extensionSettings.userLevelMemory = next;
        addDebugLog('info', `User-level shared memory ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'userLevelMemory' }, before, after: !!next });
        saveSettings();
    });

    // RETRIEVAL/EXTRACTION ENHANCEMENTS (all DEFAULT ON — checkbox reflects `!== false` so a
    // legacy settings blob without the key still shows enabled, matching the registered default).

    // MMR diversity rerank (fact-retrieval). Off = pure salience order for overflow facts.
    $('#bf_mem_mmr_enabled').prop('checked', extensionSettings.mmrEnabled !== false).on('change', function () {
        const before = extensionSettings.mmrEnabled !== false;
        const next = $(this).prop('checked');
        extensionSettings.mmrEnabled = next;
        addDebugLog('info', `MMR diversity rerank ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'mmrEnabled' }, before, after: !!next });
        saveSettings();
    });
    // MMR lambda slider (stored 0..1; UI shows 0..100). Higher favors relevance; lower favors diversity.
    {
        const lam = (typeof extensionSettings.mmrLambda === 'number') ? extensionSettings.mmrLambda : 0.7;
        $('#bf_mem_mmr_lambda').val(Math.round(lam * 100));
        $('#bf_mem_mmr_lambda_val').text(lam.toFixed(2));
        $('#bf_mem_mmr_lambda').on('input', function () {
            const v = Math.min(1, Math.max(0, parseInt($(this).val(), 10) / 100));
            extensionSettings.mmrLambda = v;
            $('#bf_mem_mmr_lambda_val').text(v.toFixed(2));
            saveSettings();
        });
    }

    // Confidence-gated ranking (fact-retrieval). Off = ignore stored confidence in overflow ranking.
    $('#bf_mem_confidence_ranking').prop('checked', extensionSettings.confidenceRanking !== false).on('change', function () {
        const before = extensionSettings.confidenceRanking !== false;
        const next = $(this).prop('checked');
        extensionSettings.confidenceRanking = next;
        addDebugLog('info', `Confidence ranking ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'confidenceRanking' }, before, after: !!next });
        saveSettings();
    });
    // Confidence weight slider (stored 0..1; UI shows 0..100). How hard low-confidence facts are nudged down.
    {
        const cw = (typeof extensionSettings.confidenceWeight === 'number') ? extensionSettings.confidenceWeight : 0.3;
        $('#bf_mem_confidence_weight').val(Math.round(cw * 100));
        $('#bf_mem_confidence_weight_val').text(cw.toFixed(2));
        $('#bf_mem_confidence_weight').on('input', function () {
            const v = Math.min(1, Math.max(0, parseInt($(this).val(), 10) / 100));
            extensionSettings.confidenceWeight = v;
            $('#bf_mem_confidence_weight_val').text(v.toFixed(2));
            saveSettings();
        });
    }

    // Temporal grounding at extraction (agent-memory + pipeline). Off = store relative dates verbatim.
    $('#bf_mem_temporal_grounding').prop('checked', extensionSettings.temporalGrounding !== false).on('change', function () {
        const before = extensionSettings.temporalGrounding !== false;
        const next = $(this).prop('checked');
        extensionSettings.temporalGrounding = next;
        addDebugLog('info', `Temporal grounding ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'temporalGrounding' }, before, after: !!next });
        saveSettings();
    });

    // Clear shared user memory (user-level shared memory). DESTRUCTIVE: wipes ONLY the shared
    // pseudo-avatar store (IDB working copy + backup files); each character's own memory is
    // untouched. Confirm first (mirrors the deleteDatabase confirm pattern), then call the
    // database-layer clearSharedUserMemory() via the same dynamic import used elsewhere here.
    $('#bf_mem_clear_shared_user').on('click', async function () {
        if (!confirm('Clear the shared "facts about you" memory used across ALL characters? Each character\'s own memory is left untouched. This cannot be undone.')) return;
        const $btn = $(this);
        $btn.prop('disabled', true);
        try {
            const { clearSharedUserMemory } = await import('./database.js');
            const { categories, files } = await clearSharedUserMemory();
            if (typeof toastr !== 'undefined') {
                toastr.success(`Cleared shared user memory (${categories} categor${categories === 1 ? 'y' : 'ies'}, ${files} file${files === 1 ? '' : 's'}).`, 'BF Memory');
            }
        } catch (e) {
            addDebugLog('fail', `Clear shared user memory failed: ${e?.message || e}`);
            if (typeof toastr !== 'undefined') toastr.error('Failed to clear shared user memory — see Debug log.', 'BF Memory');
        } finally {
            $btn.prop('disabled', false);
        }
    });

    // Review interval slider
    $('#bf_mem_review_interval').val(extensionSettings.reviewInterval);
    $('#bf_mem_review_val').text(extensionSettings.reviewInterval);
    $('#bf_mem_review_interval').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.reviewInterval;
        extensionSettings.reviewInterval = val;
        $('#bf_mem_review_val').text(val);
        if (before !== val) addDebugLog('debug', `Review interval: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'reviewInterval' }, before, after: val });
        saveSettings();
    });

    // Secondary/Tertiary fact-chance sliders REMOVED (v0.21.x menu cleanup): retrieval became
    // deterministic, so these gated nothing. The settings keys (secondaryChance/tertiaryChance)
    // are retained inert in DEFAULT_SETTINGS/validateSettings for back-compat only.

    // Depth-dice sliders (Feature #4). Stored as 0..1 floats; UI shows percent.
    [1, 2, 3, 4].forEach(n => {
        const slider = `#bf_mem_depth${n}`;
        const label = `#bf_mem_depth${n}_val`;
        const key = `depthDice${n}`;
        const pct = Math.round((Number(extensionSettings[key]) || 0) * 100);
        $(slider).val(pct);
        $(label).text(`${pct}%`);
        $(slider).on('input', function () {
            const v = parseInt($(this).val());
            extensionSettings[key] = v / 100;
            $(label).text(`${v}%`);
            saveSettings();
        });
    });

    // Toast
    $('#bf_mem_toast').prop('checked', extensionSettings.showToast).on('change', function () {
        extensionSettings.showToast = $(this).prop('checked');
        saveSettings();
    });

    // Scene card enable toggle (Agent 1 tab)
    $('#bf_mem_scene_enabled').prop('checked', extensionSettings.sceneCardEnabled).on('change', function () {
        extensionSettings.sceneCardEnabled = $(this).prop('checked');
        saveSettings();
    });
    // Render the current live scene card (read-only)
    renderScene();

    // Reflection / consolidation (Agent 3 tab)
    $('#bf_mem_reflection_enabled').prop('checked', extensionSettings.reflectionEnabled).on('change', function () {
        extensionSettings.reflectionEnabled = $(this).prop('checked');
        saveSettings();
    });
    // "Inject story so far" checkbox REMOVED (v0.21.x menu cleanup): the summary is no longer
    // injected into the writer under any setting. reflectionInject key is kept (default false)
    // in DEFAULT_SETTINGS/validateSettings for back-compat only.
    $('#bf_mem_reflection_interval').val(extensionSettings.reflectionInterval);
    $('#bf_mem_reflection_interval_val').text(extensionSettings.reflectionInterval);
    $('#bf_mem_reflection_interval').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.reflectionInterval;
        extensionSettings.reflectionInterval = val;
        $('#bf_mem_reflection_interval_val').text(val);
        if (before !== val) addDebugLog('debug', `Reflection interval changed: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'reflectionInterval' }, before, after: val });
        saveSettings();
    });
    // Idle-time consolidation: opt-in toggle + idle delay (shown in seconds, stored as ms).
    $('#bf_mem_idle_consolidation').prop('checked', extensionSettings.idleConsolidation).on('change', function () {
        extensionSettings.idleConsolidation = $(this).prop('checked');
        saveSettings();
    });
    $('#bf_mem_idle_consolidation_ms').val(Math.round((extensionSettings.idleConsolidationMs || 120000) / 1000));
    $('#bf_mem_idle_consolidation_ms_val').text(Math.round((extensionSettings.idleConsolidationMs || 120000) / 1000));
    $('#bf_mem_idle_consolidation_ms').on('input', function () {
        const secs = parseInt($(this).val());
        extensionSettings.idleConsolidationMs = secs * 1000;
        $('#bf_mem_idle_consolidation_ms_val').text(secs);
        saveSettings();
    });
    $('#bf_mem_reflection_prompt').val(extensionSettings.reflectionPrompt || DEFAULT_REFLECT_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.reflectionPrompt = (val === DEFAULT_REFLECT_PROMPT) ? '' : val;
        saveSettings();
    });
    $('#bf_mem_reset_reflection_prompt').on('click', () => {
        extensionSettings.reflectionPrompt = '';
        $('#bf_mem_reflection_prompt').val(DEFAULT_REFLECT_PROMPT);
        addDebugLog('info', 'Reflection prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'reflectionPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Reflection prompt reset', 'BF Memory');
    });
    // Render the current live reflection summary (read-only)
    renderReflection();

    // --- Character Registry (Agent 3 tab) ---
    $('#bf_mem_charreg_enabled').prop('checked', extensionSettings.characterRegistryEnabled !== false).on('change', function () {
        extensionSettings.characterRegistryEnabled = $(this).prop('checked');
        saveSettings();
    });
    $('#bf_mem_charcheck_interval').val(extensionSettings.characterCheckInterval);
    $('#bf_mem_charcheck_interval_val').text(extensionSettings.characterCheckInterval);
    $('#bf_mem_charcheck_interval').on('input', function () {
        const val = parseInt($(this).val());
        const before = extensionSettings.characterCheckInterval;
        extensionSettings.characterCheckInterval = val;
        $('#bf_mem_charcheck_interval_val').text(val);
        if (before !== val) addDebugLog('debug', `Character-check interval changed: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'characterCheckInterval' }, before, after: val });
        saveSettings();
    });
    // Semantic entity resolution / merge toggle (default OFF). Conservative, off-critical-path.
    $('#bf_mem_entity_resolution').prop('checked', extensionSettings.entityResolution === true).on('change', function () {
        extensionSettings.entityResolution = $(this).prop('checked');
        addDebugLog('debug', `Entity resolution ${extensionSettings.entityResolution ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'entityResolution' }, after: extensionSettings.entityResolution });
        saveSettings();
    });
    // Manual "merge now": run the conservative entity-merge pass immediately (off the interval
    // gate). Self-guarded; reports the result via toast. Requires the toggle above to be ON.
    $('#bf_mem_entity_merge_now').on('click', async () => {
        try {
            if (extensionSettings.entityResolution !== true) {
                toastr.info('Enable "Merge entity name variants" first.', 'BF Memory');
                return;
            }
            const res = await runEntityResolution();
            if (res && res.merges > 0) {
                toastr.success(`Merged ${res.merges} variant(s), re-keyed ${res.factsMoved} fact(s).`, 'BF Memory');
            } else {
                toastr.info('No strong-signal name variants to merge.', 'BF Memory');
            }
            renderEntities();
        } catch (err) {
            addDebugLog('fail', `Manual entity merge failed: ${err.message || err}`);
            toastr.error('Entity merge failed (see debug log).', 'BF Memory');
        }
    });
    // Manual "scan now": run the deterministic scan and, if there are unclassified named
    // candidates, open the batched popup immediately (off the normal interval gate).
    $('#bf_mem_charreg_scan').on('click', async () => {
        try {
            const { getAllDatabases } = await import('./database.js');
            const databases = await getAllDatabases();
            const candidates = scanForNamedCandidates(databases);
            if (candidates.length === 0) {
                toastr.info('No new named characters found.', 'BF Memory');
                renderEntities();
                return;
            }
            await showEntityPopup(candidates);
            renderEntities();
        } catch (err) {
            addDebugLog('fail', `Manual character scan failed: ${err.message || err}`);
        }
    });
    // Render the current live registry list.
    renderEntities();

    // --- Prompts Tab ---
    $('#bf_mem_draft_prompt').val(extensionSettings.draftPrompt || DEFAULT_DRAFT_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.draftPrompt = (val === DEFAULT_DRAFT_PROMPT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_memory_prompt').val(extensionSettings.memoryPrompt || DEFAULT_MEMORY_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.memoryPrompt = (val === DEFAULT_MEMORY_PROMPT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_writer_format').val(extensionSettings.writerFormat || DEFAULT_WRITER_FORMAT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.writerFormat = (val === DEFAULT_WRITER_FORMAT) ? '' : val;
        saveSettings();
    });

    $('#bf_mem_reset_draft_prompt').on('click', () => {
        extensionSettings.draftPrompt = '';
        $('#bf_mem_draft_prompt').val(DEFAULT_DRAFT_PROMPT);
        addDebugLog('info', 'Agent 1 (draft) prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'draftPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Draft prompt reset', 'BF Memory');
    });

    $('#bf_mem_reset_memory_prompt').on('click', () => {
        extensionSettings.memoryPrompt = '';
        $('#bf_mem_memory_prompt').val(DEFAULT_MEMORY_PROMPT);
        addDebugLog('info', 'Agent 3 (memory) prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'memoryPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Memory prompt reset', 'BF Memory');
    });

    $('#bf_mem_reset_writer_format').on('click', () => {
        extensionSettings.writerFormat = '';
        $('#bf_mem_writer_format').val(DEFAULT_WRITER_FORMAT);
        saveSettings();
        toastr.info('Writer format reset', 'BF Memory');
    });

    // Fact Finder (Agent 4) prompt editor + reset (Agent 2 tab).
    $('#bf_mem_finder_prompt').val(extensionSettings.finderPrompt || DEFAULT_FINDER_PROMPT).off('input').on('input', function () {
        const val = $(this).val();
        extensionSettings.finderPrompt = (val === DEFAULT_FINDER_PROMPT) ? '' : val;
        saveSettings();
    });
    $('#bf_mem_reset_finder_prompt').on('click', () => {
        extensionSettings.finderPrompt = '';
        $('#bf_mem_finder_prompt').val(DEFAULT_FINDER_PROMPT);
        addDebugLog('info', 'Finder prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'finderPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Librarian prompt reset', 'BF Memory');
    });

    // --- Database Tab: Profiles ---
    refreshDbProfileDropdown();

    $('#bf_mem_db_profile_load').on('click', async () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to load', 'BF Memory');
            return;
        }
        try {
            await loadDbProfile(selected);
        } catch (err) {
            addDebugLog('fail', `Load profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.load', actor: 'USER' });
            toastr.error('Failed to load profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_save').on('click', async () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select an existing profile to overwrite, or use "Save As New"', 'BF Memory');
            return;
        }
        try {
            await saveDbProfile(selected);
        } catch (err) {
            addDebugLog('fail', `Save profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to save profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_save_new').on('click', async () => {
        const name = prompt('Enter a name for this database profile:');
        if (!name || !name.trim()) return;
        const cleanName = name.trim();
        if (extensionSettings.dbProfiles?.[cleanName]) {
            if (!confirm(`Profile "${cleanName}" already exists. Overwrite?`)) return;
        }
        try {
            await saveDbProfile(cleanName);
        } catch (err) {
            addDebugLog('fail', `Save-as-new profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to save profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_delete').on('click', () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to delete', 'BF Memory');
            return;
        }
        deleteDbProfile(selected);
    });

    // Linked chats display + manage button
    refreshLinkedChatsField();
    $('#bf_mem_db_profile_select').on('change', () => refreshLinkedChatsField());
    $('#bf_mem_db_linked_manage').on('click', () => showLinkedChatsPopup());

    // --- Database Tab ---
    $('#bf_mem_refresh_db').on('click', () => refreshDatabaseView());
    $('#bf_mem_browse_db').on('click', () => showAllDatabases());
    $('#bf_mem_view_web').on('click', () => showSpiderwebPopup());

    // Cross-category live search: filters the whole store by key/value/note substring. Hides the
    // per-category cards while a query is active and shows matching facts grouped by category, each
    // with an "Open" link into that category's manager (where it can be edited/deleted).
    $('#bf_mem_db_search').on('input', () => runDatabaseSearch());

    // Unlink the CURRENT chat from its profile (one-click, on the main tab). Detaches so it won't
    // auto-relink on the next CHAT_CHANGED — makes unlink actually stick.
    $('#bf_mem_db_unlink_current').on('click', () => unlinkCurrentChat());

    // Add-label (user taxonomy overlay) controls.
    $('#bf_mem_addleaf_btn').on('click', () => {
        addUserLeaf(
            $('#bf_mem_addleaf_category').val(),
            $('#bf_mem_addleaf_name').val(),
            $('#bf_mem_addleaf_subarea').val(),
        );
    });
    $('#bf_mem_addleaf_name').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bf_mem_addleaf_btn').trigger('click'); } });
    $('#bf_mem_addcat_btn').on('click', () => addUserCategory($('#bf_mem_addcat_name').val()));
    $('#bf_mem_addcat_name').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bf_mem_addcat_btn').trigger('click'); } });
    // AI suggest-new-labels (manual, on-demand — mines homeless facts, one LLM call, approval gate).
    $('#bf_mem_suggest_labels_btn').on('click', () => onSuggestLabelsClick());
    $('#bf_mem_export_db').on('click', async () => {
        const { getAllDatabases } = await import('./database.js');
        const databases = await getAllDatabases();
        const json = JSON.stringify(databases, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `bf-memory-export-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        const dbCount = Object.keys(databases).length;
        const totalFacts = Object.values(databases).reduce((s, db) => s + (db.facts?.length || 0), 0);
        addDebugLog('info', `Databases exported (${dbCount} dbs, ${totalFacts} facts)`, {
            subsystem: 'import', event: 'db.exported', actor: 'USER', data: { dbCount, totalFacts },
        });
        toastr.success('Databases exported', 'BF Memory');
    });

    // IMPORT: file-picker -> validate JSON shape -> merge or replace -> persist Layer A+B+C.
    $('#bf_mem_import_db').on('click', () => $('#bf_mem_import_file').trigger('click'));
    $('#bf_mem_import_file').on('change', async function () {
        const file = this.files && this.files[0];
        this.value = ''; // reset so re-picking the same file fires change again
        if (!file) return;
        try {
            const text = await file.text();
            await importDatabasesFromJson(text);
        } catch (err) {
            addDebugLog('fail', `DB import failed: ${err.message || err}`, {
                subsystem: 'import', event: 'db.importFailed', actor: 'USER', reason: 'ERROR', data: { error: String(err.message || err) },
            });
            toastr.error(`Import failed: ${err.message || err}`, 'BF Memory');
        }
    });

    $('#bf_mem_clear_db').on('click', async () => {
        if (!confirm('Reset memory to EMPTY for this character? This wipes every stored fact across all storage layers. This cannot be undone.')) return;
        const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
        const dbs = await getAllDatabases();
        const clearedCats = Object.keys(dbs);
        const clearedFacts = Object.values(dbs).reduce((s, db) => s + (db.facts?.length || 0), 0);
        // Cancel any armed snapshot up-front so it can't fire mid-loop and re-write a deleted file.
        cancelPendingSnapshot();
        // Layer A (IDB) + Layer B (attachment files): deleteDatabase wipes both per category.
        for (const category of clearedCats) {
            await deleteDatabase(category);
        }
        // Layer C (dbProfiles snapshot): empty the active + every chat-linked profile so
        // autoSaveDbProfile reloads an EMPTY profile on the next CHAT_CHANGED instead of resurrecting.
        const { profilesPruned, factsPruned } = pruneActiveProfile(null);
        // Belt-and-suspenders: persist the genuinely-empty working store into the active profile too
        // (allowEmpty bypasses the empty-store guard that normally blocks an empty save).
        await saveCurrentToActiveProfile(null, { allowEmpty: true });
        // Force a reconciling durable snapshot NOW: reconcileDeletedAttachments deletes attachment
        // files for every category no longer live in IDB, so no leftover file can rehydrate.
        await flushSnapshotNow();
        addDebugLog('pass', `Reset to empty: cleared ${clearedFacts} facts across ${clearedCats.length} categories + profile pruned`, {
            subsystem: 'db', event: 'db.cleared', actor: 'USER', reason: 'USER_CLEAR_ALL',
            data: {
                dbCount: clearedCats.length, totalFacts: clearedFacts, categories: clearedCats,
                profilesPruned, factsPrunedFromProfile: factsPruned,
            },
        });
        toastr.success('Memory reset to empty (all layers)', 'BF Memory');
        refreshDatabaseView();
    });

    // --- Run Agent 3 on full chat (retroactive extraction) ---
    let fullChatCancel = false;
    $('#bf_mem_run_full_chat').on('click', async () => {
        const skipDone = $('#bf_mem_skip_processed').is(':checked');
        // FIX #9: estimate LLM calls (post-skip, post-prefilter) so the user sees cost.
        const { calls, total } = estimateFullChatCalls({ skipAlreadyProcessed: skipDone });
        if (calls === 0) {
            toastr.info(`Nothing to process: all ${total} message(s) are already done or trivially empty.`, 'BF Memory');
            return;
        }
        if (!confirm(`Run the Scribe on this chat?\n\nThis will make ~${calls} LLM call(s) (one per eligible message, out of ${total} total). Each call costs tokens. Already-processed and trivially-empty messages are skipped.\n\nProceed?`)) return;
        const btn = $('#bf_mem_run_full_chat');
        const progress = $('#bf_mem_full_chat_progress');
        const cancelBtn = $('#bf_mem_run_full_chat_cancel');

        fullChatCancel = false;
        btn.prop('disabled', true).text('Running...');
        cancelBtn.show();
        progress.show().text('Starting…');

        try {
            const result = await runAgent3OnFullChat({
                skipAlreadyProcessed: skipDone,
                onProgress: ({ current, total, factsAdded }) => {
                    progress.text(`Message ${current}/${total} · ${factsAdded} facts added`);
                },
                shouldCancel: () => fullChatCancel,
            });
            const verb = fullChatCancel ? 'cancelled' : 'finished';
            toastr.success(`Full-chat ${verb}: ${result.processed} processed, ${result.skipped} skipped, ${result.factsAdded} facts added`, 'BF Memory');
            progress.text(`${verb}: ${result.processed} processed, ${result.skipped} skipped, ${result.factsAdded} facts`);
        } catch (err) {
            toastr.error(`Full-chat failed: ${err.message}`, 'BF Memory');
            progress.text(`Failed: ${err.message}`);
        } finally {
            btn.prop('disabled', false).text('Run the Scribe on full chat');
            cancelBtn.hide();
        }
    });

    $('#bf_mem_run_full_chat_cancel').on('click', () => {
        fullChatCancel = true;
        $('#bf_mem_run_full_chat_cancel').prop('disabled', true).text('Cancelling…');
    });

    // Semantic retrieval toggle (atomic #1).
    $('#bf_mem_semantic_enabled').prop('checked', extensionSettings.semanticRetrieval === true).on('change', function () {
        extensionSettings.semanticRetrieval = $(this).prop('checked');
        saveSettings();
        if (extensionSettings.semanticRetrieval) {
            toastr.info('Semantic retrieval on. Click "Embed all facts" to vectorize existing facts; new facts embed automatically.', 'BF Memory');
        }
        syncEmbeddingControls();
    });

    // Embedding source + model (ST 1.18 vector store uses these, NOT a connection profile).
    $('#bf_mem_embedding_source').val(extensionSettings.embeddingSource || '').on('change', function () {
        extensionSettings.embeddingSource = ($(this).val() || '').trim();
        saveSettings();
    });
    $('#bf_mem_embedding_model').val(extensionSettings.embeddingModel || '').on('change', function () {
        extensionSettings.embeddingModel = ($(this).val() || '').trim() || 'text-embedding-3-small';
        saveSettings();
    });

    // Test embedding endpoint: structured probe with a specific success/failure reason. Read-only.
    $('#bf_mem_test_embedding').on('click', async () => {
        const btn = $('#bf_mem_test_embedding');
        const out = $('#bf_mem_test_embedding_result');
        btn.prop('disabled', true);
        out.show().text('Testing…');
        try {
            // Test via the REAL mechanism on ST 1.18+: insert+query a throwaway collection through
            // ST's server-side vector store (the /api/backends/.../embeddings routes don't exist here).
            const { testVectorEmbedding } = await import('./st-vectors.js');
            const r = await testVectorEmbedding();
            if (r.ok) {
                out.html(`<span style="color:#4caf50;">✓ Working</span> — embeddings via source <b>${escapeHtml(r.source)}</b>, model <code>${escapeHtml(r.model)}</code>.`);
            } else {
                out.html(`<span style="color:#f44336;">✗ Failed</span> — ${escapeHtml(r.reason)}`);
            }
        } catch (err) {
            out.html(`<span style="color:#f44336;">✗ Error</span> — ${escapeHtml(err.message || String(err))}`);
        } finally {
            btn.prop('disabled', false);
        }
    });

    // Enable/disable the embedding selector + test button with the semantic toggle.
    syncEmbeddingControls();

    // --- Embed all facts (atomic #16): one-shot semantic backfill of the current character's DB ---
    $('#bf_mem_embed_all').on('click', async () => {
        if (!extensionSettings.semanticRetrieval) {
            toastr.info('Enable "Semantic retrieval" first, then embed.', 'BF Memory');
            return;
        }
        // C6: confirm before a potentially large embedding backfill — one embedding API call per
        // batch of facts, so a big store can mean many calls / real cost. Mirrors the rebuild confirm.
        const okEmbed = await showConfirm('Embed all stored facts for this character now? This sends every not-yet-embedded fact to your embedding endpoint and may make many API calls.');
        if (!okEmbed) return;
        const btn = $('#bf_mem_embed_all');
        const progress = $('#bf_mem_embed_all_progress');
        btn.prop('disabled', true).text('Embedding…');
        progress.show().text('Starting…');
        try {
            const { bulkEmbedAllFacts } = await import('./fact-embedding.js');
            const result = await bulkEmbedAllFacts(({ done, total }) => {
                progress.text(`Embedding ${done}/${total} fact(s)…`);
            });
            if (result.total === 0) {
                progress.text('All facts already embedded (or none to embed).');
                toastr.info('Nothing to embed — facts are already vectorized or the store is empty.', 'BF Memory');
            } else {
                progress.text(`Done: ${result.succeeded}/${result.total} embedded.`);
                toastr.success(`Embedded ${result.succeeded}/${result.total} fact(s)`, 'BF Memory');
            }
        } catch (err) {
            toastr.error(`Embed failed: ${err.message}`, 'BF Memory');
            progress.text(`Failed: ${err.message}`);
        } finally {
            btn.prop('disabled', false).html('<i class="fa-solid fa-vector-square"></i> Embed all facts (semantic)');
        }
    });

    // --- Tokens Tab ---
    $('#bf_mem_tokens_reset').on('click', () => {
        sessionTokens = { baselineInput: 0, actualInput: 0, agentInput: 0, agentOutput: 0, mainOutput: 0, runs: 0 };
        saveTokensToMeta();
        renderTokens();
    });

    // --- Debug Tab ---
    $('#bf_mem_debug').prop('checked', extensionSettings.debugMode).on('change', function () {
        extensionSettings.debugMode = $(this).prop('checked');
        saveSettings();
    });

    // Verbose tier toggle (opt-in firehose). When OFF, addDebugLog drops level:'verbose'
    // at INGESTION (see addDebugLog) — this is the capture-side volume control, not just a
    // display filter. Greys out the verbose display checkbox to match (nothing to show).
    const syncVerboseLevelControl = () => {
        const on = !!extensionSettings.debugVerbose;
        const vbox = document.querySelector('.bf-mem-log-level[value="verbose"]');
        const wrap = document.getElementById('bf_mem_log_level_verbose_wrap');
        if (vbox) { vbox.disabled = !on; if (!on) vbox.checked = false; }
        if (wrap) wrap.classList.toggle('bf-mem-disabled', !on);
    };
    $('#bf_mem_debug_verbose').prop('checked', extensionSettings.debugVerbose).on('change', function () {
        extensionSettings.debugVerbose = $(this).prop('checked');
        saveSettings();
        syncVerboseLevelControl();
        renderDebugLog();
    });
    syncVerboseLevelControl();

    // Filter toolbar: pure client-side re-render over the in-memory buffer on any change.
    $(document).on('change', '.bf-mem-log-level', () => renderDebugLog());
    $('#bf_mem_log_subsystem').on('change', () => renderDebugLog());
    $('#bf_mem_log_search').on('input', () => renderDebugLog());

    // "What Claude did" tool-activity panel (tool-first redesign): manual refresh + initial paint.
    // It also auto-refreshes from addDebugLog on each tool-call event.
    $('#bf_mem_tool_activity_refresh').on('click', () => renderToolActivity());
    renderToolActivity();

    // Graph view (Database tab): show a fact's linked neighbors; Enter or button triggers it.
    $('#bf_mem_graph_btn').on('click', () => renderGraphView($('#bf_mem_graph_key').val()));
    $('#bf_mem_graph_key').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); renderGraphView($('#bf_mem_graph_key').val()); } });

    // Recurring-characters entity panel (Database tab): manual refresh + initial paint.
    $('#bf_mem_entities_refresh').on('click', () => renderEntityPanel());
    renderEntityPanel();

    $('#bf_mem_clear_log').on('click', () => {
        debugLog = [];
        saveDebugLogToMeta(); // also clear the persistent metadata slice
        // Also delete the dedicated debug-log FILE for this chat (best-effort, async).
        logFileDirty = false;
        let chatId = '';
        try { chatId = getContext().chatId ?? getContext().getCurrentChatId?.() ?? ''; } catch { /* no chat */ }
        if (chatId) {
            (async () => {
                try { const { deleteDebugLogFile } = await import('./database.js'); await deleteDebugLogFile(chatId); }
                catch { /* best-effort */ }
            })();
        }
        renderDebugLog();
    });

    // Export the full RAM ring buffer as machine-readable JSON. Mirrors the Copy button's
    // clipboard-with-mobile-fallback pattern, plus a file download.
    $('#bf_mem_export_json').on('click', async () => {
        const json = exportLogsJSON();
        let chatId = 'log';
        try { chatId = String(getContext().chatId ?? 'log'); } catch { /* no chat */ }
        const fname = `bf-mem-log-${chatId}-${Date.now()}.json`;
        // Download as a file.
        try {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch { /* download best-effort */ }
        // Also copy to clipboard for convenience.
        try {
            await navigator.clipboard.writeText(json);
            toastr.success(`Log JSON downloaded + copied (${debugLog.length} entries)`, 'BF Memory');
        } catch {
            toastr.success(`Log JSON downloaded (${debugLog.length} entries)`, 'BF Memory');
        }
    });

    // "Why not fact X?" retrieval probe — explains a single fact's fate this turn.
    const runProbe = async () => {
        const input = document.getElementById('bf_mem_probe_key');
        const out = document.getElementById('bf_mem_probe_result');
        if (!out) return;
        const key = (input?.value || '').trim();
        if (!key) { out.textContent = 'Enter a fact key (e.g. Status/location) to probe.'; return; }
        out.textContent = 'Checking…';
        try {
            const res = await explainFactRetrieval(key);
            const detail = res.detail ? safeStringify(res.detail) : '';
            out.innerHTML =
                `<span class="bf-mem-probe-reason ${res.found ? 'found' : 'missing'}">${escapeHtml(res.reason || 'unknown')}</span> ` +
                `<span class="bf-mem-probe-detail">${escapeHtml(detail)}</span>`;
        } catch (err) {
            out.textContent = `Probe failed: ${err?.message || err}`;
        }
    };
    $('#bf_mem_probe_btn').on('click', runProbe);
    $('#bf_mem_probe_key').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runProbe(); } });

    $('#bf_mem_copy_log').on('click', async () => {
        const logText = exportLogs();
        try {
            await navigator.clipboard.writeText(logText);
            toastr.success('Logs copied to clipboard', 'BF Memory');
        } catch {
            // Mobile-friendly fallback: prompt() truncates and lacks select-all.
            // Build a textarea overlay that the user can long-press to select-all.
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1a1a2e);padding:16px;border-radius:8px;max-width:600px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:8px;';
            const title = document.createElement('div');
            title.textContent = 'Copy debug log';
            title.style.cssText = 'font-weight:bold;color:#7bb3ff;';
            const hint = document.createElement('div');
            hint.textContent = 'Long-press the text area to Select All, then Copy.';
            hint.style.cssText = 'font-size:12px;opacity:0.7;';
            const textarea = document.createElement('textarea');
            textarea.value = logText;
            textarea.readOnly = true;
            textarea.style.cssText = 'width:100%;min-height:200px;flex:1;font-family:monospace;font-size:11px;background:#000;color:#eee;padding:8px;';
            const buttonRow = document.createElement('div');
            buttonRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            const selectAllBtn = document.createElement('button');
            selectAllBtn.textContent = 'Select All';
            selectAllBtn.className = 'menu_button';
            selectAllBtn.onclick = () => { textarea.select(); textarea.setSelectionRange(0, textarea.value.length); };
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.className = 'menu_button';
            closeBtn.onclick = () => overlay.remove();
            buttonRow.appendChild(selectAllBtn);
            buttonRow.appendChild(closeBtn);
            card.appendChild(title);
            card.appendChild(hint);
            card.appendChild(textarea);
            card.appendChild(buttonRow);
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            // Auto-select on open for desktop convenience
            setTimeout(() => { textarea.focus(); textarea.select(); }, 0);
        }
    });

    // --- Auto-refresh profiles on change ---
    context.eventSource?.on(context.eventTypes?.CONNECTION_PROFILE_LOADED, () => reloadProfiles());

    // --- Auto-save DB profile on chat change (named after current chat) ---
    context.eventSource?.on(context.eventTypes?.CHAT_CHANGED, async () => {
        // Observability: capture the transition BEFORE any reload runs. `_lastChatId` is the chat
        // we are leaving; getCurrentChatId() is the one we just entered. Logging only — these reads
        // never influence profile resolution / rehydrate / snapshot.
        const fromChatId = _lastChatId;
        const toChatId = getCurrentChatId();

        // chat.disconnect: what was active on the chat we are LEAVING (active profile at the moment
        // of exit). Skipped on the very first switch (no prior chat) to avoid a noise line.
        if (fromChatId && fromChatId !== toChatId) {
            addDebugLog('info', `Leaving chat ${fromChatId} (active profile "${extensionSettings?.activeDbProfile || ''}")`, {
                subsystem: 'db', event: 'db.disconnect', actor: 'SYSTEM',
                data: {
                    chatId: fromChatId,
                    activeProfile: extensionSettings?.activeDbProfile || null,
                    isBranch: isBranchChat(fromChatId),
                },
            });
        }

        // chat.switch: explicit "left -> entered" transition (info so it shows by default).
        addDebugLog('info', `Chat switch: ${fromChatId || '(none)'} -> ${toChatId || '(none)'}`, {
            subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM',
            data: { from: fromChatId || null, to: toChatId || null, isBranch: isBranchChat(toChatId) },
        });

        // FIX #59: flush the OUTGOING chat's debug-log tail to its own file BEFORE we swap the
        // buffer to the new chat — otherwise the last few (esp. verbose) lines of the chat you're
        // leaving are lost. Targets the tracked old chatId (the live one has already advanced).
        await flushOutgoingChatLog();

        // DATA-SAFETY FIX (coordinated CHAT_CHANGED): flush the durable IDB→attachment snapshot for
        // the OUTGOING character's working store BEFORE autoSaveDbProfile clears/reloads it. This is
        // a SINGLE awaited sequence so the outgoing chat's tail facts are persisted before any clear
        // runs (the prior un-awaited flushSnapshotNow() in pipeline.js raced the clear and could
        // snapshot an already-emptied store / capture the wrong chat's facts). For a same-character
        // chat-switch/branch the live avatar == the outgoing avatar, so flushing the live avatar
        // pins the correct store. reconcileDeletes:FALSE so a transiently-empty working store cannot
        // delete durable backup files — only a USER-destructive op may prune attachments.
        try {
            const { flushSnapshotNow, invalidateDatabaseCache } = await import('./database.js');
            const outgoingAvatar = getContext()?.characters?.[getContext()?.characterId]?.avatar || null;
            await flushSnapshotNow({ avatar: outgoingAvatar, reconcileDeletes: false });
            // Drop the per-turn cache (now partitioned by avatar+chatId) so the autoload + the new
            // chat's first read re-fetch fresh and cannot serve the outgoing chat's cached map.
            invalidateDatabaseCache();
            addDebugLog('debug', `Coordinated flush before autoload (outgoing avatar pinned)`, {
                subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM', reason: 'COORDINATED_FLUSH',
                data: { from: fromChatId || null, to: toChatId || null, avatar: outgoingAvatar || null },
            });
        } catch (e) {
            console.error('[BFMemory] coordinated chat-switch flush failed', e);
        }

        await autoSaveDbProfile();
        // Reload the persistent debug log AND fact panels from the new chat's metadata
        // so each chat shows its own history (not a stale cross-chat snapshot).
        reloadDebugLogFromChat();
        reloadFactsFromChat();
        reloadTokensFromChat();
        reloadSceneFromChat();
        reloadReflectionFromChat();
        reloadPyramidFromChat();
        reloadEntitiesUI();

        // Remember which chat we're now on so the NEXT switch can report an accurate
        // "from -> to". Logging-only state; never read by storage/profile logic.
        _lastChatId = toChatId;
    });

    // Seed the switch tracker with the chat present at init, so the first real switch reports a
    // correct "from". Logging-only.
    _lastChatId = getCurrentChatId();

    // Initial load: pull any previously-persisted log entries + facts for the current chat
    reloadDebugLogFromChat();
    reloadFactsFromChat();
    reloadTokensFromChat();
    reloadSceneFromChat();
    reloadReflectionFromChat();
    reloadPyramidFromChat();
    reloadEntitiesUI();

    // Save to active profile on page close/refresh
    window.addEventListener('beforeunload', () => {
        // Synchronous best-effort save to settings (no async file ops)
        const profileName = extensionSettings?.activeDbProfile;
        if (profileName && extensionSettings?.dbProfiles?.[profileName]) {
            // Can't do async here, but saveSettings is synchronous (debounced flush)
            saveSettings();
        }
        // FIX #8: guarantee the debug log reaches disk before reload. saveMetadata()
        // is debounced, so a synchronous immediate chat save here is the primary fix —
        // reload is exactly when the buffered entries would otherwise be lost.
        flushDebugLogNow();
        // HYBRID PERSISTENCE: best-effort flush of the durable IDB→attachment snapshot so the
        // newest facts reach the backend before reload. beforeunload can't reliably AWAIT the
        // async upload, so the throttled cadence (every ~15s) remains the real guarantee; this
        // is a final nudge. Fire-and-forget + self-guarded (never throws). Imported lazily to
        // avoid a static settings.js→database.js cycle. reconcileDeletes:FALSE — a non-user
        // teardown flush must never DELETE durable backup files (only a USER clear/delete prunes).
        import('./database.js').then(m => m.flushSnapshotNow?.({ reconcileDeletes: false })).catch(() => {});
    });

    // Note: removed MESSAGE_RECEIVED → saveCurrentToActiveProfile() handler.
    // pipeline.js now persists via saveCurrentToActiveProfile(capturedDbProfile)
    // after every Agent 3 write, with capture-at-write semantics. The old
    // unprotected handler here was a residual leak path (same class as Issue #2).

    // --- Initial state ---
    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
