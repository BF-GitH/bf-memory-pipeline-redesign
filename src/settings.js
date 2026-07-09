// BF Memory Pipeline - Settings Module
// Handles UI wiring, settings persistence, and the DB-profile (Layer C) machinery.
// F-UX-8 split: the debug-log engine (debug-log.js), per-chat turn state (turn-state.js),
// Database-tab UI (db-panel.js), usability presets (presets.js), and shared UI helpers
// (ui-util.js) were extracted MECHANICALLY from this module. settings.js remains the public
// facade: every symbol it exported before the split is still exported here (see the
// re-export block below), so no importer had to change.

import { getConnectionProfiles, getCurrentProfileId } from './profiler.js';
import { DEFAULT_DRAFT_PROMPT } from './agent-draft.js';
import { DEFAULT_MEMORY_PROMPT } from './agent-memory.js';
import { DEFAULT_WRITER_FORMAT } from './agent-writer.js';
import { DEFAULT_REFLECT_PROMPT } from './agent-reflect.js';
import {
    getEntities, setEntityStatus, reloadEntitiesFromChat,
    scanForNamedCandidates, showEntityPopup, promoteEntity, runEntityResolution,
} from './agent-entities.js';
import { explainFactRetrieval } from './fact-retrieval.js';
// F-UX-8 split modules (see the header note above).
import {
    ensurePopup, Popup, POPUP_TYPE, escapeHtml, getContext, getCurrentChatId, isBranchChat,
    safeStringify,
} from './ui-util.js';
import {
    addDebugLog, reloadDebugLogFromChat, flushDebugLogNow, flushOutgoingChatLog,
    renderDebugLog, renderToolActivity, clearDebugLog, getDebugLogEntries,
    exportLogs, exportLogsJSON, copyDiagnostics,
} from './debug-log.js';
import {
    setLastGenerated, setLastInserted, reloadFactsFromChat,
    reloadTokensFromChat, resetSessionTokens,
    reloadSceneFromChat, renderScene,
    reloadReflectionFromChat, renderReflection,
    reloadPyramidFromChat,
} from './turn-state.js';
import { PRESET_IDS, detectPreset, applyPreset, isApplyingPreset } from './presets.js';
import {
    refreshDatabaseView, showAllDatabases, showSpiderwebPopup, runDatabaseSearch,
    addUserLeaf, addUserCategory, onSuggestLabelsClick, renderGraphView, renderEntityPanel,
} from './db-panel.js';

// --- F-UX-8 re-exports ----------------------------------------------------------------------
// Everything settings.js exported BEFORE the split is re-exported here so every existing
// importer (pipeline.js, commands.js, agent-*.js, database.js, message-icon.js, …) keeps
// importing from './settings.js' unchanged. Do not remove entries without checking importers.
export {
    beginRun, endRun, getCurrentRunId, setPendingRun, getPendingRun, consumePendingRun,
    reloadDebugLogFromChat, addDebugLog, exportLogsJSON,
} from './debug-log.js';
export {
    setLastGenerated, setLastInserted, setLastInjection, appendLastInserted, reloadFactsFromChat,
    setRunTokens, addAgent3Tokens, addReflectionTokens, setMainOutputTokens, reloadTokensFromChat,
    getScene, setScene, reloadSceneFromChat,
    getReflection, setReflection, reloadReflectionFromChat,
    getSummaryPyramid, setSummaryPyramid, reloadPyramidFromChat,
} from './turn-state.js';

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

const DEFAULT_SETTINGS = {
    enabled: false,
    // C1 — USABILITY PRESET. A single dropdown (Cheap · Balanced · Max Recall · Custom) that maps
    // one choice onto the many underlying token/retrieval knobs (see PRESETS in presets.js). 'custom' means
    // "the knobs don't match any preset" (the honest default for existing installs: detectPreset()
    // recomputes it on init from the live values, so a config that happens to match a preset shows
    // that preset). Applying a preset is the ONLY thing that bulk-writes those knobs; editing any
    // governed control by hand flips this back to 'custom' so the dropdown never lies.
    // C4: fresh installs default to the "Balanced" preset (the governed-key defaults below match
    // the 'balanced' signature, so detectPreset() resolves to 'balanced' on a clean install).
    // EXISTING users are unaffected — merge-missing-defaults only fills ABSENT keys, so anyone who
    // already has these keys keeps their values and detectPreset() shows whatever they match.
    uiPreset: 'balanced',
    // First-run onboarding wizard (src/onboarding.js): true once the user has FINISHED or
    // SKIPPED it — either way it never auto-shows again. The "Re-run setup guide" button in
    // the General tab reopens it on demand.
    onboardingDone: false,
    useMemoryProfile: true,
    // Per-agent connection profiles (replacing single memoryProfile).
    // Old `memoryProfile` is kept on the stored object for rollback safety
    // and migrated forward in migrateLegacySettings().
    agent1Profile: '',
    agent3Profile: '',
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
    // TYPED-EDGE GRAPH MEMORY (Graphiti typed edges; audit F-ARCH-7). Default OFF. When ON, the
    // Scribe may tag a fact with up to 3 typed relationship edges `| rel:<predicate>@<Category/key>`
    // (e.g. `rel:employs@People/bob_name`), parsed in agent-memory.js into `fact.edges = [{p, t}]`
    // — a (subject, predicate, object) triple where the fact's SUBJECT is the head, `p` the
    // lowercase verb-ish predicate, and `t` a `Category/key` ref to an existing fact about the
    // object. Edges merge additively in upsert (database.js), expand through the anti-hub
    // admitter (fact-retrieval.js collectLinkCandidates), and render + answer simple
    // relation-intent queries ("who employs X") in search_memory. Distinguishes "who employs X"
    // from "who loves X" — the untyped `relationships` overlay cannot. Purely additive +
    // back-compat: when OFF the marker falls through to the legacy `rel:` keyword-hint branch,
    // no fields are written, and behavior is byte-identical. Absent (older settings) → false.
    typedEdges: false,
    // Agent 2 (Writer) context limit: default 0 = off (main model sees full chat as ST
    // sends it). When > 0, we trim data.chat IN-PLACE to the last N user/AI messages
    // before sending — the main model sees only those + our injected facts. Lets you
    // shrink the prompt and rely on facts to replace older history. Reversible: just
    // change the slider back to 0.
    // C4/A1 default flip: fresh installs trim the main-model history to the last 10 user/AI
    // messages so stored facts REPLACE old turns instead of stacking on top (the core token win).
    // Existing users keep their stored value (often 0). 0 still means "no trim / full history".
    agent2ContextMessages: 10,
    // A2/B5 — FROZEN INJECTION. 0 = off (default; every turn runs the Drafter fresh). When
    // > 0, a genuine new turn REUSES the previous run's cached fact/scene injection (skipping that
    // LLM call) for up to this many turns before a full refresh. Saves tokens/latency AND keeps
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
    // RETIRED (v0.50.x): the vector/embedding stack was removed; kept inert for stored-settings
    // back-compat only — nothing reads it anymore.
    semanticRetrieval: false,
    // DEPRECATED (Feature #2a): retrieval tier inclusion is now DETERMINISTIC (capped,
    // no random dice). These keys are kept for settings persistence/back-compat and the
    // existing sliders, but no longer gate which facts get injected. Safe to remove the
    // UI later; the values are inert.
    secondaryChance: 50,
    tertiaryChance: 15,
    // Feature #4 / audit F-RETR-5 — sequence-track "History reach". ONE integer (0-4): how many
    // OLDER steps of a relevant track are always shown alongside the current step (contiguous,
    // no gaps). Replaces the four depthDice percent sliders: deterministicTrackReach had reduced
    // those to a binary >=50% include-threshold, so 1-49% were all identical and 50-100% were all
    // identical — the percent UI was a lie. Default 2 = exactly what the legacy defaults
    // (70/50/25/10) derived through that threshold, so behavior is unchanged out of the box.
    trackReachSteps: 2,
    // DEPRECATED (F-RETR-5): legacy depth-dice weights, kept INERT for stored-settings
    // back-compat only. No UI binds them anymore; fact-retrieval.js reads trackReachSteps and
    // only falls back to deriving a reach from these for stored settings that predate the key.
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
    // GUARANTEED ANCHORS: how many key anchor facts (identity / current-state / active relationship)
    // per present character to always inject alongside the retrieved facts, so the in-focus
    // character's anchors surface even if retrieval misses them. 0 disables.
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

// Exported for the F-UX-8 split modules (db-panel.js / presets.js persist settings through
// the same debounced path a local write uses).
export function saveSettings() {
    const context = getContext();
    context.extensionSettings[EXTENSION_NAME] = extensionSettings;
    context.saveSettingsDebounced();
}

function clamp(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

// Exported for presets.js (applyPreset() validates through the exact same path a manual edit uses).
export function validateSettings(s) {
    s.contextMessages = Math.floor(clamp(s.contextMessages, 1, 50, 5));
    s.agent1ContextMessages = Math.floor(clamp(s.agent1ContextMessages, 1, 50, 5));
    s.agent3ContextMessages = Math.floor(clamp(s.agent3ContextMessages, 1, 20, 5));
    s.agent2ContextMessages = Math.floor(clamp(s.agent2ContextMessages, 0, 50, 10)); // garbage-fallback matches DEFAULT_SETTINGS (10), like its neighbors
    // A2/B5 frozen injection: 0 = off; clamp to a sane window so it can't freeze forever.
    s.injectionFreezeTurns = Math.floor(clamp(s.injectionFreezeTurns, 0, 20, 0));
    s.reviewInterval  = Math.floor(clamp(s.reviewInterval,  0, 100, 10)); // 0 = never show the review popup (F-UX-6)
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
    // RETIRED vector stack (v0.50.x): coerced inert for stored-settings back-compat; nothing reads it.
    if (typeof s.semanticRetrieval !== 'boolean') s.semanticRetrieval = false;
    s.secondaryChance = Math.floor(clamp(s.secondaryChance, 0, 100, 50));
    s.tertiaryChance  = Math.floor(clamp(s.tertiaryChance,  0, 100, 15));
    // F-RETR-5 history reach: whole steps 0..4. Default 2 = the reach the legacy depth-dice
    // defaults (70/50/25/10) derived through the >=50% include-threshold.
    s.trackReachSteps = Math.floor(clamp(s.trackReachSteps, 0, 4, 2));
    // DEPRECATED depth-dice probabilities (0..1 floats): coerced for stored-settings back-compat
    // only — no UI binds them and retrieval only reads them as a pre-trackReachSteps fallback.
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
    // Guaranteed present-character anchors (live; the retired Finder's other knobs are gone).
    s.finderAnchorsPerCharacter = Math.floor(clamp(s.finderAnchorsPerCharacter, 0, 8, 3));
    if (typeof s.enableWriterRecallTool !== 'boolean') s.enableWriterRecallTool = true;
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
    if (typeof s.enableSummaryPyramid !== 'boolean') s.enableSummaryPyramid = true; // matches DEFAULT_SETTINGS (tool-first flip)
    // Temporal grounding defaults ON (free, deterministic): absent/invalid => true (back-compat).
    if (typeof s.temporalGrounding !== 'boolean') s.temporalGrounding = true;
    // B3 safe slice — default OFF (absent/garbage => false = unchanged behavior).
    if (typeof s.scribeTrimProcessedPriors !== 'boolean') s.scribeTrimProcessedPriors = false;
    // Bi-temporal fact validity (opt-in) — default OFF; absent (older settings) => false (back-compat).
    if (typeof s.biTemporal !== 'boolean') s.biTemporal = false;
    // Typed-edge graph memory (opt-in, F-ARCH-7) — default OFF; absent (older settings) => false (back-compat).
    if (typeof s.typedEdges !== 'boolean') s.typedEdges = false;
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
    // First-run onboarding: absent/garbage => false, so existing installs see the wizard exactly
    // once (finish or skip flips it true; it never auto-shows again).
    if (typeof s.onboardingDone !== 'boolean') s.onboardingDone = false;
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

// --- Profile Dropdown ---

function reloadProfiles() {
    const agent1Select = document.getElementById('bf_mem_agent1_profile');
    const agent3Select = document.getElementById('bf_mem_agent3_profile');
    if (!agent1Select && !agent3Select) return;

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
export function pruneActiveProfile(category = null) {
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
export function pruneFactFromProfiles(category, key) {
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
export function updateFactInProfiles(category, key, updatedFact) {
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
        // applyPreset() is doing its own programmatic writes (isApplyingPreset() guard).
        // Only the governed settings that HAVE an on-screen control are listed
        // (finderAnchorsPerCharacter has no slider, so it can't be manually edited anyway).
        const governedSelector = [
            '#bf_mem_pyramid_enabled',
            '#bf_mem_recall_tool_enabled', '#bf_mem_agent2_context', '#bf_mem_reflection_interval',
            '#bf_mem_retrieval_budget',
        ].join(',');
        $('#bf_memory_settings').on('change input', governedSelector, function () {
            if (isApplyingPreset()) return;
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

    // Retrieval token budget slider (F-UX-4). PRESET-GOVERNED: this key is written by the
    // Cheap/Balanced/Max Recall presets, so the control is also listed in the delegated
    // governed-control listener (initSettings) that flips the preset dropdown to "Custom" on a
    // manual edit, and re-synced by presets.js syncPresetControls() when a preset is applied.
    $('#bf_mem_retrieval_budget').val(extensionSettings.retrievalTokenBudget);
    $('#bf_mem_retrieval_budget_val').text(extensionSettings.retrievalTokenBudget);
    $('#bf_mem_retrieval_budget').on('input', function () {
        const val = parseInt($(this).val(), 10) || 800;
        const before = extensionSettings.retrievalTokenBudget;
        extensionSettings.retrievalTokenBudget = val;
        $('#bf_mem_retrieval_budget_val').text(val);
        if (before !== val) addDebugLog('debug', `Retrieval token budget: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'retrievalTokenBudget' }, before, after: val });
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

    // Typed-edge graph memory toggle (Graphiti typed edges; audit F-ARCH-7). DEFAULT OFF, so the
    // checkbox reflects `=== true`. Gates the Scribe's `rel:<predicate>@<Category/key>` marker
    // grammar + parsing (agent-memory), edge-target graph expansion (fact-retrieval
    // collectLinkCandidates), and the search_memory edge rendering / relation-intent path.
    $('#bf_mem_typed_edges').prop('checked', extensionSettings.typedEdges === true).on('change', function () {
        const before = extensionSettings.typedEdges === true;
        const next = $(this).prop('checked');
        extensionSettings.typedEdges = next;
        addDebugLog('info', `Typed-edge graph memory ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'typedEdges' }, before, after: !!next });
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

    // History reach stepper (F-RETR-5) — replaces the four depth-dice percent sliders, which
    // deterministicTrackReach had reduced to a binary >=50% threshold (1-49% identical,
    // 50-100% identical). One honest 0-4 integer control; the legacy depthDice keys stay
    // stored-inert for back-compat and nothing binds them anymore.
    $('#bf_mem_track_reach').val(extensionSettings.trackReachSteps);
    $('#bf_mem_track_reach_val').text(extensionSettings.trackReachSteps);
    $('#bf_mem_track_reach').on('input', function () {
        const val = parseInt($(this).val(), 10) || 0;
        const before = extensionSettings.trackReachSteps;
        extensionSettings.trackReachSteps = val;
        $('#bf_mem_track_reach_val').text(val);
        if (before !== val) addDebugLog('debug', `History reach: ${before} → ${val} step(s)`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'trackReachSteps' }, before, after: val });
        saveSettings();
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

    // --- Tokens Tab ---
    $('#bf_mem_tokens_reset').on('click', () => {
        // Session-token state moved to turn-state.js (F-UX-8 split); resetSessionTokens()
        // performs the exact same zero + persist + re-render sequence this handler inlined.
        resetSessionTokens();
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

    // Ring-buffer state moved to debug-log.js (F-UX-8 split); clearDebugLog() performs the exact
    // same buffer + metadata-slice + attachment-file + re-render sequence this handler inlined.
    $('#bf_mem_clear_log').on('click', () => clearDebugLog());

    // Export the full RAM ring buffer as machine-readable JSON. Mirrors the Copy button's
    // clipboard-with-mobile-fallback pattern, plus a file download.
    // Copy Diagnostics: bundle settings + logs + database (facts+links) + scene + entities to clipboard/file.
    $('#bf_mem_copy_all').on('click', () => copyDiagnostics());

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
            toastr.success(`Log JSON downloaded + copied (${getDebugLogEntries().length} entries)`, 'BF Memory');
        } catch {
            toastr.success(`Log JSON downloaded (${getDebugLogEntries().length} entries)`, 'BF Memory');
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

    // --- First-run onboarding wizard ---
    // Shown ONCE, only after the whole UI above is bound: every wizard write routes through
    // the live controls (.val().trigger('change')) so the existing handlers persist it.
    // Dynamic import + guards mean a wizard failure can never break extension load.
    try {
        $('#bf_mem_rerun_onboarding').on('click', () => {
            import('./onboarding.js').then(m => m.showOnboarding(true)).catch(() => { /* wizard is best-effort */ });
        });
        if (extensionSettings.onboardingDone !== true) {
            import('./onboarding.js').then(m => m.maybeShowOnboarding()).catch(() => { /* wizard is best-effort */ });
        }
    } catch { /* onboarding must never block init */ }

    // --- Initial state ---
    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
