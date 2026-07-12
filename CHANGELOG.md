# Changelog

## [Unreleased] — dead-code sweep + comment strip

> Removes code that was defined but never reached by the live loop, and strips all source comments.
> No behavior change to the working paths; `node --check` passes on every module.

### Removed (dead / orphaned code)

- **Fact usage-tracking** — `markFactsUsed` (never called; the only writer of the usage buffer) and
  its drain `applyBufferedFactUsage`, plus the buffer plumbing. The feature never functioned.
- **Relationship-re-entry scene writer** — `setScene` and its RELATIONSHIP RE-ENTRY DETECTION block,
  `getSceneReentries`, and `lastReentries` (nothing called `setScene`). `getScene` /
  `reloadSceneFromChat` stay — the scene card still displays from persisted metadata.
- **Phantom Tokens-tab rows** — the always-zero "Drafter", "Librarian (finder)", and "Selector
  (semantic pass)" rows and their unwritten `agent1*` / `finder*` / `selector*` token fields.
- **Unused exports** — `getOpenThreads`, `findExistingLeaf`, `collectBranchFactsIndexed`, singular
  `getDatabase`, `groupedTaxonomySubAreas`, `NPC_SUBJECT`, `createSemaphore`, `estimateFullChatCalls`,
  `appendLastInserted`, the `renderScene` no-op, `showAllDatabases`, and seven unused `host.js`
  wrappers (`getChatId`, `getChatMetadata`, `getCharacters`, `getCharacterId`, `getCurrentCharacter`,
  `getExtensionSettingsRoot`, `saveChatNow`).

### Changed

- **All source comments stripped** from every JS module. Rationale now lives in git history and the
  README, not inline.

## [0.71.0] - 2026-07-11 — settings cleanup + random-walk memories

> Trims the extension toward its core: removes several stale settings/UI and the features behind
> them, gives the memory sheet its own tab, and reworks "connected memories" from a ranked top-N into
> a random graph walk. `node --check` passes on every module; **still not runtime-tested inside
> SillyTavern**.

### Removed (settings + their code)

- **Retrieval token budget** — the slider, the `retrievalTokenBudget` setting, and the per-line token
  cap in `composeSheet` are gone. The sheet now renders all NEED facts + walk extras (the count caps
  remain the backstop).
- **Review interval** — the slider, the `reviewInterval` setting, **and the entire review-popup
  feature**: `review-popup.js` is deleted; the `trackUpdate` import + contradiction-scan queueing is
  removed from `agent-reflect.js`; popup blocks removed from `pipeline.js`, `memory-tools.js`, and
  `catchup-import.js`. Facts are still stored — only the review UI is gone.
- **Setup walkthrough / onboarding** — `onboarding.js` deleted, its init removed, and the "Re-run
  setup guide" button + handler + `onboardingDone` setting removed.
- **"How this works" ELI5 box** and the **"What actually gets sent (assembly order)"** box removed
  from the settings panel.
- **Scene card** — the stale live scene-card widget (it was never populated; `setScene()` is never
  called) is removed, along with the always-empty `## Current scene` block in the Memory Agent prompt
  and `renderScene()`'s DOM code. Scene *state* is retained as a stub because `recency.js` reads
  `sceneNo`.

### Changed

- **Memory sheet has its own tab.** Tabs are now Memory / **Sheet** / Database / Tokens / Debug; the
  live memory sheet moved out of the Memory tab into the new Sheet tab.
- **"Bonus connected memories" is now a random graph walk.** Instead of ranking a fact's neighbors by
  salience and taking the top N, `randomWalkExtras` (in `fact-retrieval.js`) starts from the scene's
  needed facts and wanders the memory graph at random, hop by hop (e.g. restaurant → Luigi's → first
  date), chaining through unseen/active/visible neighbors and restarting on dead ends. The
  `graphExtrasCount` slider (0–8, default 3) now sets how many random connected memories to collect.
  The walk is bounded (no infinite loop) and never surfaces superseded, invisible, or already-shown
  facts.

## [0.70.0] - 2026-07-11 — redesign-v2

> A large architectural rewrite that collapses the extension to **one** memory architecture: the
> main model never uses tools, no LLM call blocks reply generation, and a persistent memory sheet —
> rebuilt in the background — carries the memory. `node --check` passes on every module; **not yet
> runtime-tested inside SillyTavern**.

### Architecture

- **No tools on the Writer.** `search_memory` and `remember_fact` — their schemas, registration,
  runaway softcap, and the "What Claude did" tool-activity panel — are removed. Your main model just
  receives context and writes.
- **Nothing blocks the reply.** On `CHAT_COMPLETION_PROMPT_READY` (and the text-completion twin) only
  pure code runs: trim chat history to the last N user/AI messages (`agent2ContextMessages`,
  preserving system / World Info / author's-note messages), then splice **one** system message — the
  memory sheet — immediately before the last user message.
- **Persistent memory sheet** (`bf_mem_sheet` in `chat_metadata`, per chat, always populated — new
  chats seed with a placeholder). Holds a rolling story summary, the facts the scene needs (recency
  labels + CURRENT STATE / CHRONOLOGY split), a one-line scene card, and a few graph-connected bonus
  facts. Injection is pure code reading stored text.
- **Memory Agent** (merged Drafter + Scribe into one background tool-loop per settled reply, on the
  Scribe connection profile). Behind the existing ~1.8 s swipe-aware settle debounce it anticipates
  the next scene, extracts new lasting facts, and emits the updated sheet.
- **Text tool protocol** (works on any backend, no function-call API): the agent emits one-line JSON
  tool calls — `list_categories` → `list_keys` → `read_facts` → `write_fact` / `search` — the
  extension executes them against `database.js` + `fact-retrieval.js` and feeds results back, then
  the agent finishes with a `#SHEET` block. Hard caps: max 6 rounds, max 20 tool calls; malformed
  JSON gets one grace, then degrades to **keeping the previous sheet and committing nothing** (no
  silent memory loss, no watermark on a failed run). New `src/memory-tools.js`;
  `callAgentLLMWithTools` / `callAgentLLMMessages` in `src/llm-call.js`.
- **Settled buffer** (`bufferHoldBack`, default 4, clamp 0–10): facts are only extracted from
  messages at index ≤ `chat.length − 1 − holdback`; the newest few are shown to the agent as
  **TENTATIVE — do not store** context for sheet planning only. Per-message `bf_mem_processed`
  watermark + swipe/edit invalidation kept.

### Fixed

- **F-SCRIBE-1:** a run missing its final `#SHEET` block sets `result.error` and never watermarks —
  the prior sheet is kept and the exchange retries.
- **F-ORCH-2 / F-ORCH-3:** extraction-in-flight now **reschedules** instead of dropping the exchange;
  the shared `isInternalCall` boolean is replaced everywhere by the `internalCallDepth` refcount.
- **`initCommands()` is now called** from `index.js` (it was a dead, never-wired module).

### Removed

- **Files:** `agent-draft.js`, `agent-selector.js`, `presets.js`, `profiler.js` (inlined into
  `settings.js`).
- **Modes & presets:** `memoryMode` (hybrid / tool-only / push), `uiPreset` + all preset machinery.
- **Opt-in experiments:** bi-temporal validity (`biTemporal`), entity merge (`entityResolution*` +
  "Merge variants now"), user-level shared memory (`userLevelMemory` + clear button), typed edges
  (`typedEdges` — plain relationship link tiers and `autoLinkFact` stay), idle consolidation
  (`idleConsolidation*`), moment echo (`enableMomentEcho`, `momentEchoMaxTokens`), relationship
  re-entry (`enableRelationshipReentry`, `reentry*`), summary-pyramid **injection** (storage stays,
  feeding the sheet).
- **Dead settings:** `injectionFreezeTurns`, `selectionSummary*`, `useMemoryProfile`, `agent1*`,
  `draftPrompt`, `sceneCardEnabled` (scene card is now always-on in the sheet), `semanticRetrieval`,
  `secondaryChance`, `tertiaryChance`, `depthDice1-4`, `reflectionInject`, `useFinderAgent` (+ Finder
  remnants), `writerFormat`, `enableWriterRecallTool`, `enableWriterWriteTool`, `summaryPyramid*`,
  `#NextHint`, and the `agent3ContextMessages` window (replaced by the settled buffer).

### Hardcoded ON (settings deleted, behavior always active)

Temporal grounding, recency labels, truth hierarchy, MMR diversity rerank, confidence ranking,
cross-key supersede, auto-linking + 1-hop graph expansion, periodic reflection (its `#STORY` summary
feeds the sheet), reflection compression guard, character registry, open-threads tracking. See
[UPGRADES.md](UPGRADES.md).

### Settings

Final surface: `enabled`, `onboardingDone`, `agent3Profile`, `memoryPrompt`, `agent2ContextMessages`
(0–50), `bufferHoldBack` (0–10), `retrievalTokenBudget` (50–8000), `reviewInterval` (0–100),
`enforceKnownBy`, `graphExtrasCount` (0–8), `catchupBatchSize` (2–30), `showToast`, `debugMode`,
`debugVerbose`, plus data keys (`dbProfiles`, `activeDbProfile`, `unlinkedChats`, `taxonomyOverlay`).
Settings UI shrinks to four tabs — **Memory / Database / Tokens / Debug**. `migrateLegacySettings`
maps `memoryProfile → agent3Profile`, drops removed keys, bumps `schemaVersion` to 3. Onboarding
simplified to 3 steps (welcome → Scribe profile → where to look).

### Kept

Swipe-aware settle debounce; per-character IndexedDB + attachment persistence, DB profiles,
tombstones; knownBy / POV enforcement; auto-link + graph expansion + anti-hub caps; catch-up import
(adapted to the Memory Agent); World Info interop; the DB panel (browser / search / graph /
spiderweb); message brain icons; review popup (`reviewInterval`); `/bfmem` commands.

## [0.61.0] - 2026-07-09

### Added — community-features batch (adoption plan: `docs/COMMUNITY-RESEARCH-2026-07-09.md`)

> Ten features adopted from community research (10 SillyTavern Reddit threads + competing memory extensions),
> implemented against v0.60.0. All shipped complete; every changed file passes `node --input-type=module --check`.

**Tier 1 — high impact, targets confirmed community pain**
- **`knownBy` enforcement toggle** (`enforceKnownBy`, default **on**): the pre-existing knownBy/POV witness filter now has an escape hatch. The gate lives inside `isFactVisible()` (`src/fact-retrieval.js`), so every retrieval surface — push cascade, `search_memory`, scene/relationship rows, pipeline anchors, `/recall` — follows the toggle. Turning it off restores full visibility (secrets can leak); upgrades from older saves resolve to on (zero behavior change).
- **Recency labels + hierarchy-of-truth header** (`injectRecencyLabels` + `injectTruthHierarchy`, both default **on**): new `src/recency.js` computes a per-turn now-context (message index / scene number / story time) and renders fail-soft recency tails on injected fact lines, plus a CURRENT STATE / CHRONOLOGY sectioned block with a precedence preamble. Push injection now formats through the same `buildFactLine` as everything else — also fixing a drifted-away `{from→until}` bi-temporal tail on the injected path — and the token estimator charges the identical tails.
- **Relationship re-entry pack** (`enableRelationshipReentry`, default **off**, push mode): the scene card tracks per-character `lastSeen`; when a character returns after a configurable number of scene boundaries, the pipeline guarantees the pair's newest relationship-status record plus their last shared moment beats into the injection (deduped, charged against the retrieval budget). The Scribe and Reflection now maintain a single stable `Relationships/<a>_<b>_status` record per pair, and `upsertFact` canonicalizes reversed `<b>_<a>_status` keys so no duplicate pair records can be minted from any write path.
- **Scribe/Reflection prompt upgrades**: enumerated ephemera stop-list with a YES/NO rubric, a delta-only rule against restating unchanged facts, and absolute limits replacing hedge phrasing in the Scribe prompt; the Reflection pass now *updates* its prior story/shelf summaries instead of regenerating from scratch; plus a compression guard (`reflectionCompressionGuard`, default **on**) that retries a shelf summary once when it comes back no shorter than its source facts.
- **Open-threads tracking** (`enableOpenThreads`, default **on**): the Scribe marks unresolved plot hooks (`thread:open` on event facts), the Reflection pass resolves up to 5 per pass via a new `#THREADS` section, the Big Picture block gains a token-clamped "Open threads:" line, and the DB panel shows a thread-state chip. Replies without `#THREADS` (custom prompts) degrade to a silent no-op.
- **Cross-key supersede rules** (`crossKeySupersede`, default **on**): a deterministic 3-rule table (death / departure / destroyed-or-lost) retires same-subject active state facts (e.g. `current_location`) to `__was` history when a triggering event is written — capped at 8 invalidations per trigger, with full debug-log audit trail. Fires only on genuine NEW/UPDATED writes at the three new-write callers (Scribe apply, `remember_fact`, review-popup edit commit); migrations, rebuilds, merges, and unchanged review-queue items never re-trigger it.

**Tier 2 — adoption wedges + roadmap accelerants**
- **Catch-up import** (`src/catchup-import.js`): chunked Scribe backfill over an existing chat's unprocessed backlog (Database-tab sub-block + `/bfmem catchup [N|cancel]`), with call-count confirm, progress bar, boundary-only cancel, per-chunk watermarks (cancel/fail is resumable), and abort-plus-snapshot guards on chat/character/profile switch. Configurable chunk size (`catchupBatchSize`, default 8, max 30).
- **Selection-summary retrieval pass** (`selectionSummaryEnabled`, default **off**): an opt-in per-turn Selector LLM pass reads a shelf manifest built from the reflection summary pyramid and picks up to `selectionSummaryMaxPicks` (default 6) shelves/facts to admit as secondaries — a semantic layer without embeddings. Any failure leaves the deterministic cascade byte-identical; Selector tokens get their own Tokens-tab row.
- **Unicode tokenization** (`src/tokenize.js`): a shared zero-dependency Unicode tokenizer (Intl.Segmenter with regex fallback, script-aware length gates) now feeds both the fact index and every query side, so index and query tokens can never diverge. Cyrillic/Greek/CJK chats now get working keyword extraction, fact keys, scene-location tokens, Big Picture shelf matching, entity promotion, and capitalized-entity detection; ASCII behavior is byte-identical to the legacy per-site splits. No settings, no migration.
- **World Info interop** (`src/worldinfo-interop.js`): export the fact store as a standard ST World Info book (LLM-generated trigger keywords with a deterministic no-LLM fallback, explicit cost confirm) and import lorebooks from the three known dialects as idempotent `wi_` facts (1000-char value cap, merge-only, never resurrects deletions). Two new buttons beside the existing Export/Import.

**Not adopted from the plan (this batch)**: Tier 2 items 2.5 (NPC agency line) and 2.6 (Reflection "internal truths") were not implemented; Tier 3 remains under evaluation.

## [0.60.0] - 2026-07-09

### Added / Changed / Removed — full audit implemented (PRs #3 + #4)

> The 93-finding multi-agent audit (`docs/AUDIT-2026-07-07.md`) is now fully implemented.
> Runtime smoke-tested in a real SillyTavern (release branch): loads with zero console errors.

**Added**
- **First-run onboarding wizard** (`src/onboarding.js`): 5-step guided setup (how memory works → memory mode → cost preset → Scribe profile → where to look while it runs). Skippable, shows once; "Re-run setup guide" button in the General tab.
- **Opt-in typed-edge graph memory** (`typedEdges`, default **off** — UPGRADES feature #9): the Scribe can tag facts with `rel:<predicate>@<Category/key>` edges (employs/fears/loves/…); edges merge additively, expand through the anti-hub admitter, and render in `search_memory` output with simple relation-intent matching. Byte-identical behavior when off.
- **Honest tool-cost accounting**: Tokens tab shows estimated tool round-trips + per-request tool-schema cost; tool-activity panel shows token estimates next to call counts. Slimmed tool descriptions save ~230 tokens per request.
- **"Retrieval token budget" slider** (Writer tab) and a single honest **"History reach: 0–4 steps"** control replacing the four depth-dice percent sliders (which had silently become a binary ≥50% threshold).

**Fixed (highlights)**
- **Review popup is honest**: facts are saved *before* review, and the popup now says so; the ✕ actually deletes (same path as the per-message viewer); blank-value edit works; `reviewInterval 0` = never show; Dismiss clears the queue.
- **Silent memory loss closed**: a Scribe reply missing `#MEM` flags an error and retries next turn; busy/cancelled extractions reschedule instead of dropping an exchange forever; a fast next message during background extraction gets the cached injection instead of none (`internalCallDepth` refcount).
- **Unsorted-injection loop** (audit F-ARCH-2): Unsorted facts compete under the token budget — top 6 by salience guaranteed, the rest budget-ranked; `remember_fact` steers pins toward real categories.
- **Data safety**: attachment saves upload-before-delete; IDB read-modify-write is now single-transaction (`idbUpdateRecord`); per-category clobber guard with deletion tombstones so cross-device deletes are honored, not resurrected; token estimator matches the actual injected format; exact-key primaries capped (12).
- **Settings-key bug**: `host.getExtensionSettings()` hardcoded `bf-memory-pipeline` — every agent module silently read `null` settings in a `-redesign`-named install folder. Now folder-derived.
- **`{{bf_facts}}` / `/bfmem` live**: `initCommands()` was never wired (dead module); macro registration migrated to the new `macros.register` API (which returns `null` on bad definitions instead of throwing — return value now checked), with legacy fallbacks.
- Plus: capitalized-word keyword fallback gated to true parse failures; brain-icon plain click is always the free viewer; MMR cold-penalty normalization fix; trimChatHistory preserves depth-injected system messages; full-context `generateQuietPrompt` fallback leg removed; `#NextHint` (generated every turn, never read) removed; entity merges get an auditable `merged` status and the "both explicitly named" veto now covers alias signals; temporal grounding wired into backfill/per-message paths; README rewritten around the shipped hybrid/tool-first architecture.

**Removed (−1,679 lines of retired code)**
- The dormant vector/embedding stack (`st-vectors.js`, `fact-embedding.js`, dead API chain, hidden settings UI), the hard-disabled Finder/Agent 4 (`agent-finder.js`, dead pipeline block, Librarian tab), zero-caller database exports, deprecated profiler shims, and legacy `fact.embedding` float arrays (stripped on load).

**Refactored**
- `settings.js` (~6k lines) split into `debug-log.js`, `turn-state.js`, `db-panel.js`, `presets.js`, `ui-util.js` — mechanical, zero behavior change; `settings.js` re-exports everything so no importer changed.

## [0.50.1] - 2026-06-21

### Added / Changed — diagnostics + embeddings retired from the UI

- **"Copy Diagnostics" button** (Debug tab): one click bundles the complete extension state — settings, the full debug log (inputs/outputs/events), the entire fact database **including each fact's relationships (the graph/web)**, token usage (per-run + session), the last injected memory context, last generated/inserted, scene, entities, and pending review — into one JSON, downloaded as a file **and** copied to the clipboard (with a select-all fallback). For easy support sharing. No API keys included.
- **Embeddings/semantic recall retired from the default path:** `semanticRetrieval` now defaults **off** (in defaults and all presets), and every embedding control is **hidden from the settings UI** (semantic toggle, "Embed all facts", embedding source/model, test button). Claude's `search_memory` is the semantic layer now. The vector code remains in-repo but dormant and not user-selectable.

## [0.50.0] - 2026-06-21

### Added — Phases 2–4: observability, Claude tuning, graph + entity UI

> Version jumped to 0.50.0 to clearly mark the tool-first redesign (Phases 1–4) as the
> current main release — distinct from the pre-redesign 0.42.x line.

Built on the tool-first core (alpha.1), all verified end-to-end in a real SillyTavern 1.18 instance driven through a browser.

**Phase 4 — usability & observability**
- **"What Claude did" panel** (Debug tab): a per-turn list of the main model's `search_memory` recalls (query → result count) and `remember_fact` pins, grouped by turn. Auto-refreshes on each tool call. The trust panel — you can *see* the tool-driven memory working.
- **Graph view** (Database tab): enter a `Category/key` and see the fact's linked neighbors — relationship-ref links (primary/secondary) and one-hop scope-graph neighbors (place⇄event⇄people). Neighbors are clickable to walk the graph. The "true graphline memory" made visible.
- **Recurring-characters panel** (Database tab): lists the entity registry (named / NPC / deferred) with status badges and a "Mark recurring" button that promotes an NPC to a first-class subject.
- **Grouped review popup**: extraction review now groups changes into counted New / Updated / Deletions / Conflicts sections instead of a flat list (original indices preserved so edit/remove still work).

**Phase 2 — Claude tuning + speed**
- **Per-turn tool-call soft cap (8)**: a turn exceeding it is flagged in the panel so a runaway tool loop is visible.
- **Claude-profile detection**: recognizes a Claude/Anthropic active connection profile and logs (once/session) that tool-first is the tuned path — or, on a non-tool profile in hybrid/tool-only mode, hints that recall may not fire (switch to Push).
- **Cache-drift guard**: when an agent's static system prompt changes between calls without a persona change, it's logged (variable per-turn data likely leaked into the system block, hurting prompt-cache hits).

**Phase 3 — graph integration**
- **`remember_fact` auto-links** pinned facts into the spiderweb (mirroring Scribe) so model-pinned facts join the graph instead of being islands — combined with the alpha.1 fix that made traversal follow `secondary` refs, pinned facts are now reachable by recall.

_Files:_ [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html), [style.css](style.css), [src/profiler.js](src/profiler.js), [src/pipeline.js](src/pipeline.js), [src/llm-call.js](src/llm-call.js), [src/agent-writer.js](src/agent-writer.js), [src/review-popup.js](src/review-popup.js)

## [0.43.0-alpha.1] - 2026-06-21

### Added — Tool-first redesign: Claude drives memory (faster replies + on-demand recall)

The headline of the tool-first redesign. Memory recall is moving from a deterministic, always-on push to a **tool-driven** model where the main reply model (e.g. Claude via the Claude Code CLI connection profile) recalls and pins facts itself through `search_memory` / `remember_fact`. This alpha lands the core path:

- **New "Recall strategy" setting (`memoryMode`), default `hybrid`.** Three modes:
  - **Hybrid** (default) — each turn injects a cheap, no-LLM anchor (speculative keyword facts + present-character anchors + the scene block); the model pulls everything deeper on demand via `search_memory`. **The blocking Agent 1 (Drafter) LLM call is skipped** — the primary latency win.
  - **Tool-only** — minimal anchor; recall is driven almost entirely by the model's tool calls.
  - **Push** — classic behavior restored: the Drafter plans the reply + picks fact branches every turn (an extra blocking LLM call). For main models that can't call tools.
- **Faster replies in Hybrid/Tool-only:** dropping the Drafter removes a full per-turn LLM round-trip from the reply-critical path; the per-turn `summarizeKeys`/menu store walks (only consumed by the Drafter) are skipped too.
- **Anchors still fire without the Drafter:** in hybrid/tool-only, `focus` is derived from the scene card's present characters, so the guaranteed present-character anchor facts are still injected (no LLM).
- **`remember_fact` now defaults ON** and both tool descriptions were rewritten to prompt Claude to search proactively before replying and pin lasting facts as they're established (shipped in alpha groundwork).
- **UI:** a "Recall strategy" selector at the top of the settings panel (separate from the existing cost/recall "Memory mode" preset), with a hint explaining the tool-calling requirement.

**Known tradeoff (alpha):** in hybrid/tool-only the Drafter no longer parses the scene each turn, so the scene card only updates on turns that run in Push mode (or via future cheap scene-tracking). The injected scene persists from the last parse. The background Scribe (Agent 3) still extracts post-reply as a safety net. Requires a tool-calling main model; with a non-tool model, use **Push**.

_Files:_ [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html), [src/agent-writer.js](src/agent-writer.js)

### Added — stronger `search_memory` recall + bounded multi-hop graph

Because the recall tool is now the model's primary path to memory, `searchMemoryForRecall` was upgraded from keyword-only to the **same cascade the push path uses**: exact handle → keyword → fuzzy/alias trigram (typos/morphology) → bounded graph expansion. On no match it returns an **actionable hint** listing the categories actually present so the model re-queries productively instead of giving up.

The graph expansion (`gatherExpansionCandidates`) was generalized from one hop to a **bounded breadth-first walk** (`maxDepth`, clamped 1–3). The always-on push path stays at depth 1 (byte-identical); the explicit recall path walks **depth 2**, so a query can reach two links out (place → guard → faction). All hops share the same `MAX_EXPANSION_TOTAL` / per-seed caps, and deeper hops demote to tertiary so closer facts always win scarce slots.

Verified end-to-end in a real SillyTavern 1.18 instance: keyword, fuzzy-typo, one-hop graph (a place query surfacing a linked person with no shared text), the no-match hint, **and the two-hop walk** (a query reaching place → event → person → that person's other event → a second place at depth 2, while the depth-1 push path correctly stops at one hop) all pass.

_Files:_ [src/fact-retrieval.js](src/fact-retrieval.js)

### Fixed — hardening pass from an adversarial review + edge-case testing

A full adversarial audit of the branch plus E2E edge-case testing surfaced eight issues; the real ones are fixed (each re-verified live in ST 1.18):

- **Graph traversal now follows `secondary` relationship refs**, not just `primary`. `autoLinkFact` writes most character-centric (same-subject / token-overlap) links into `secondary`, which the BFS recall path silently ignored — orphaning the dominant link set from the now-primary recall path.
- **Sequence-track continuity is never demoted** on deeper hops, so the per-seed-cap exemption isn't undone by the downstream tertiary cap evicting mandatory continuity.
- **Exact `Category/key` handle pulls stay exact** — a resolved handle returns just that record instead of ballooning into its whole 2-hop neighborhood.
- **Recall ranks tier-first** (direct hits → 1-hop → 2-hop), then salience — so a tight `limit` can't drop the actual match for a distant linked fact.
- **The no-match hint respects the category filter** — it no longer lists (and potentially spoils) other categories when the model scoped the search.
- **Hybrid focus has an honest active-character fallback** when the scene wasn't parsed this turn (no Agent 1), and the "guarantee" wording was softened to match reality.
- **`logRunSummary` reports a skipped Drafter as N/A**, not failed; **settings coercion for `enableWriterWriteTool` matches its new `true` default**.

_Files:_ [src/fact-retrieval.js](src/fact-retrieval.js), [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js)

## [0.42.1] - 2026-05-31

### Changed — replaced the dead "Embedding profile" dropdown with working source + model inputs (H16)

The Database-tab **"Embedding profile" dropdown did nothing** — on ST 1.18 embeddings go through the vector store (`/api/vector/*`) keyed by a *source* + *model*, not a connection profile (`testVectorEmbedding`/`st-vectors.js` never read it; the test handler even computed an unused `profileId`). Replaced it with two real, persisted inputs: **Embedding source** (blank = auto-detect from the active chat provider, e.g. `openrouter`) and **Embedding model** (default `text-embedding-3-small`, `openai/` prefix auto-added for OpenRouter). Removed the now-dead dropdown population, change handler, and unused locals. ([templates/settings.html](templates/settings.html), [src/settings.js](src/settings.js))

> Audit cleanup verification: the other remaining audit items were re-checked and found **not** to be defects — `successfulRunsSinceReflection` is an intentional per-turn reflection cadence; `logRunSummary`'s reflection-token field is 0 by design (reflection runs after the run summary, tracked separately); `parseMemoryUpdateResult`'s legacy-JSON guard can't misfire on the current `#MEM` format; and the finder circuit-breaker cadence is dead code (Finder hard-disabled). No changes made to those.

## [0.42.0] - 2026-05-31

### Fixed — batch 2 from the full QA audit (one-agent-per-file fix pass, all verified)

Each fix was re-verified against the code (false positives rejected) and syntax-checked before commit.

**Edge cases / pipeline ([src/pipeline.js](src/pipeline.js)):**
- **Stuck `'in-flight'` watermark (H7):** if extraction threw *before* the Scribe committed, the exchange was wrongly marked processed forever (only a swipe cleared it). Now the watermark resets to `false` on a pre-commit throw so a later turn re-extracts; post-commit throws stay terminal.
- **Swipe after the 5s cooldown ran a full pipeline + new draft (H13):** `shouldRunPipeline` now detects swipe-only re-rolls (no new user msg, only the AI target unprocessed, cached injection present) and defers to the draft-less re-inject path.
- Removed a dead/misleading "skipped (finder on)" log branch (unreachable since the Finder is hard-disabled).

**Brain icon ([src/message-icon.js](src/message-icon.js)):**
- Added a **`MESSAGE_SWIPED`** listener (icon now repaints to grey after a swipe instead of staying green and opening a stale fact view) and a **`MESSAGE_DELETED`** listener (strips + rebuilds icons so they can't linger or mis-target after re-indexing).

**Retrieval / DB ([src/database.js](src/database.js)):**
- **Cold facts now actually sort last (H11):** `salienceScore` gained an opt-in `penalizeCold` (used only by the candidate-bounding callers `scopedScribeCandidates`/`capFinderCandidates`) that sinks cold facts below every hot fact — making the long-standing "cold sorts last" comment true without breaking cold-fact resurrection.
- `deleteDebugLogFile` now flushes the debounced save (H8).

**Menus / persistence ([src/settings.js](src/settings.js)):**
- Preset governance no longer includes the inert `useFinderAgent` (toggling the dead Finder control no longer flips the preset to "Custom") (H21); the Tokens "Librarian (finder)" row is hidden when its tokens are 0 (always, now); DB-profile Load/Save/Save-As-New are awaited + error-handled (H15); `setLastInjection` runId fixed (`_ambientRunId`→`currentRunId`, H4); "Copy log" respects active filters (H19); "Select all (filtered)" + bulk-delete act on the whole filtered set, not just rendered rows (H24); `markChatUnlinked`/`clearChatUnlinked` now persist (H9); branch token/scene ownership re-stamp handles empty/legacy `ownerChatId` (H17, H18); label-suggestion approval optional-chaining fixed (H1).

**Other:** `{{bf_facts}}` macro no longer returns empty on first use (placeholder seed) ([src/commands.js](src/commands.js)); review-popup `getMeta` persists its repair/drain (H5, [src/review-popup.js](src/review-popup.js)); Drafter section parsing stops at `#NextHint` ([src/agent-draft.js](src/agent-draft.js)); the inert **Librarian tab is hidden** ([templates/settings.html](templates/settings.html)); Last Generated/Inserted now have real styles (H22, [style.css](style.css)).

**Rejected as false positives** (verified against code, no change): H6 (`entityCheckInFlight` — a `finally` resets it), H23 (`sceneName` is already escaped once at the `row()` boundary), the main-output `?? 0` precedence (works as designed).

**Deferred** (design changes, not bugs): removing the dead `embeddingProfile` dropdown vs. adding explicit source/model inputs (H16); profile-delete default-wipe + auto-reselect.

## [0.41.0] - 2026-05-31

### Fixed — first batch of verified bugs from the full QA audit (audit/FULL-AUDIT.md)

- **Tone/temporal dropped from injection every turn.** `buildDeterministicRetrieval` hand-rolled its fact formatting and had drifted from the shared formatter — omitting a moment's `tone` (and temporal tail). Since the Finder is now hard-disabled this fallback runs every turn, so episodic tone was silently stripped from every injected block. Now formats via the shared `formatChosenFacts` (same as the anchor path) — single source of truth, no drift. ([src/pipeline.js](src/pipeline.js))
- **`clampImportance(null)` returned 1, not the default 3.** `Number(null)`/`Number('')` are `0` (finite), slipping past the guard and silently downgrading every value-less fact to importance-1 — skewing salience, cold-tiering, and retrieval ranking. Null/undefined/'' now correctly fall back to the default. ([src/database.js](src/database.js))
- **Double-injection on text-completion backends.** The `GENERATE_AFTER_DATA` swipe/regen re-inject path lacked the `!pipelineJustInjected` guard the chat-completion path has, so the cached block could be prepended twice into `data.prompt`. Guard added. ([src/pipeline.js](src/pipeline.js))
- **`getCharacterInfoBrief` null-deref** when `getContext()` returns null — optional-chained the context. ([src/pipeline.js](src/pipeline.js))

> Audit verification note: not every audit finding was a real bug — e.g. the claimed `entityCheckInFlight` permanent-lock (H6) is a false positive (a `finally` resets the flag even on early `return`). Each fix here was re-checked against the code first; remaining high/medium findings are being worked through the same way.

## [0.40.0] - 2026-05-31

### Changed — Memory Web is now a navigable map (pan / zoom / focus), not a static blob

The "View Web" graph was an unnavigable hairball at real store sizes (e.g. 265 nodes / 2271 links). Rebuilt as an interactive map:

- **Pan** (drag) + **zoom** (scroll wheel, zoom-to-cursor) via an SVG viewport transform.
- **Click a node to focus** — dims everything except that fact and its direct links/neighbours, so you can actually see *what it's attached to*. Click empty space to clear.
- **Search** a fact by key → focuses + centres it.
- **Category-clustered layout** — each category (People/Events/Places/…) gets its own region on a ring with per-cluster gravity, so the graph reads as separated clusters instead of one central mass (verified: ~2000×1600 spread across 6 clusters).
- **Faint links hidden by default** (secondary/tertiary) with a toggle, and **hub labels** shown always while other labels reveal on hover/focus — both cut visual clutter.

([src/settings.js](src/settings.js) `showSpiderwebPopup`, [style.css](style.css))

## [0.39.0] - 2026-05-31

### Removed (disabled) — the Finder (Agent 4) is now hard-disabled + off by default

The per-turn Stage-2 Finder LLM call is **intentionally disabled in code** (`const wantFinder = false` in [src/pipeline.js](src/pipeline.js), with a full rationale comment) and `useFinderAgent` now **defaults to `false`** ([src/settings.js](src/settings.js)).

**Why** (validated live on a ~270-fact store):
- The Finder only *re-ranked* facts already filtered by the Drafter's branches, salience, MMR, the graph spiderweb, semantic (ST-vector) retrieval, and the guaranteed present-character anchors — it added no recall the rest of the stack lacks.
- At real store sizes it consistently **blew its 3.5s budget and aborted**, falling back to deterministic retrieval anyway (the circuit-breaker tripped) — so it was already mostly off, while still costing a ~3.5s/turn wait.
- A 5-turn paraphrase-recall check with it **off** still correctly recalled name (anchor), job, allergy, and pet via deterministic + semantic + anchors.

**Effect:** one fewer LLM call per turn → cheaper, faster, and latency-predictable (no budget race / breaker churn), with recall intact. The `if (wantFinder)` block is kept as dead code (not deleted) so re-enabling is a one-line revert; the `#bf_mem_finder_enabled` UI toggle is inert until then. Injection now always uses deterministic retrieval + semantic + guaranteed anchors.

## [0.38.0] - 2026-05-31

### Fixed — semantic hits now actually reach the Writer (they were being capped/excluded before injection)

v0.37.0 made semantic *retrieval* work, but an A/B on the live store showed enabling it barely changed the injected facts. Two reasons, both fixed:

- **Finder path (default):** the Finder injects its pick from a candidate pool built only from Agent-1's branches + link-following — so embedding-matched facts that no branch/keyword surfaced were never *pickable*. Now the semantic hits the speculative retrieval already produced this turn are folded into the Finder's candidate pool (no extra embedding call), so the Finder can actually choose them. ([src/pipeline.js](src/pipeline.js))
- **Deterministic/fallback path:** semantic hits entered the secondary tier but were ranked by `retrievalSalience` (importance/recency) — which doesn't capture *meaning* — so a low-importance but on-topic semantic hit got `CAP_SECONDARY`'d out. Now up to `SEMANTIC_RESERVED_SECONDARY` (4) front-of-line secondary slots are reserved for semantic admits so they survive the cap, while salience/MMR still own the rest. ([src/fact-retrieval.js](src/fact-retrieval.js))

Both are gated by `semanticRetrieval` and bounded, so the default (semantic-off) path is unchanged. With semantic on + facts embedded, paraphrase recall (e.g. "what do they do for work" → the pilot fact) now reaches the Writer instead of being silently dropped.

## [0.37.0] - 2026-05-31

### Changed — semantic retrieval now works (delegated to SillyTavern's vector store; OpenRouter-compatible)

The semantic layer was built around a direct embeddings call + client-side cosine over a `fact.embedding` stored on each fact. On **SillyTavern 1.18 that never worked**: the `/api/backends/.../embeddings` routes 404 and CMRS has no `sendEmbeddingRequest`. What ST 1.18 *does* expose is a server-side vector store (`/api/vector/*`) that embeds with the active chat provider. **Verified live: `source:'openrouter'` + `openai/text-embedding-3-small` embeds and returns true semantic matches** (e.g. "what should I avoid eating" → the cinnamon-allergy fact; "what do they do for work" → the pilot fact — both with zero keyword overlap, exactly the cases the keyword/graph retriever missed).

- **New `src/st-vectors.js`**: a bridge to ST's vector store — `insertFactVectors` (per-character collection, idempotent per `factHash(category:key)`), `querySemanticIds` (query by turn text → resolve matched hashes back to in-scope facts), `testVectorEmbedding`, plus source/model normalization (auto-prefixes `openai/` for OpenRouter). Vectors now live in ST's store, **not** on `fact.embedding`/`settings.json` (fixes the prior scaling leak). ([src/st-vectors.js](src/st-vectors.js))
- **`semanticLayer`** (retrieval) now queries ST's vector store instead of embedding + cosine. Still gated by `semanticRetrieval`, still degrades to a no-op on any failure, so keyword/graph retrieval is untouched. ([src/fact-retrieval.js](src/fact-retrieval.js))
- **Embed-on-write + "Embed all facts"** now push fact vectors into the ST collection (no `fact.embedding`, no per-fact re-save). ([src/agent-memory.js](src/agent-memory.js), [src/fact-embedding.js](src/fact-embedding.js))
- **"Test embedding endpoint"** now tests the *real* mechanism (insert+query a throwaway ST collection) and reports the source/model used. New `embeddingSource` setting (blank = derive from the active chat source). ([src/settings.js](src/settings.js), [src/llm-call.js](src/llm-call.js))

**To use:** enable *Semantic retrieval* → click *Embed all facts* (one-time backfill via your chat provider's embeddings) → new facts embed automatically. On OpenRouter, leave model as `text-embedding-3-small` (auto-prefixed). Default behavior without embedding stays keyword/graph.

## [0.36.0] - 2026-05-31

### Added — embedding endpoint test + embedding-profile selector (groundwork for verified semantic retrieval)

Semantic retrieval has always shipped OFF + "unverified" because there was **no way to point it at an embedding provider or confirm one works**. A live probe confirmed the common case: a chat-only backend (e.g. OpenRouter) returns **no embedding endpoint at all**, so `semanticRetrieval` silently no-ops. This release makes the embedding side configurable + testable:

- **Embedding-profile selector** (Database tab → semantic section, `#bf_mem_embedding_profile`): choose which connection profile serves embeddings (blank = reuse the Drafter/default). The `embeddingProfile` setting existed but had no UI. Populated alongside the agent profiles in `reloadProfiles()`. ([src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))
- **"Test embedding endpoint" button** (`#bf_mem_test_embedding`): sends a tiny probe and reports either ✓ working (with the vector dimension + which route answered) or ✗ with the specific failure reason, within a 10s timeout. Backed by a new, isolated `testEmbeddingEndpoint()` in [src/llm-call.js](src/llm-call.js) — kept SEPARATE from the embed hot-path `callEmbeddingAPI` so existing embed callers are byte-for-byte unchanged. Both controls disable when semantic retrieval is off.

> Why this and not "drop the Finder yet": a read-only benchmark on a ~270-fact live store showed the no-embedding deterministic retriever recalls keyword-matchable anchors well (allergy, job, trust) but **misses pure paraphrases** ("what do they do for work" → did not surface the pilot fact) and mis-ranks the bare "name" query. That gap is exactly what semantic embeddings close — so the validated sequence is: enable + verify an embedding provider (this release) → confirm semantic closes the gap → only then consider replacing the per-turn Finder LLM. Full plan + benchmark in `audit/SEMANTIC-PLAN.md` and `audit/AB-BENCHMARK.md`.

## [0.35.2] - 2026-05-31

### Fixed — cold-tiered facts were invisible to the Writer (cross-chat recall) + slow per-turn saves

- **Cold facts now reach the Finder.** Once a category overflows the hot set (~50 facts) the oldest/lowest-salience facts are cold-tiered (kept on disk, never deleted). But `capFinderCandidates` hard-excluded every cold fact from the Finder's candidate list, and the "they can still surface via direct match" escape only exists on the deterministic retrieval path — which never runs when the Finder (the default) succeeds. So a durable, stored fact that had overflowed became impossible to recall, and the model would deny it. Cold facts are now kept as candidates and bounded purely by the salience cap (`FINDER_CANDIDATE_CAP = 50`, well above the Finder's 24-fact output); cold facts already sort last via `RETRIEVAL_COLD_PENALTY`, so they only take a slot when no hot fact contends. ([src/database.js](src/database.js) `capFinderCandidates`)
- **Per-category Scribe saves now run in parallel.** The post-reply save loop awaited each category's IndexedDB write serially, stacking round-trips on the main thread at large stores (a contributor to the multi-minute stall + ST's "Timeout waiting for chat to save"). They now overlap via `Promise.all`, each still individually try/caught. ([src/agent-memory.js](src/agent-memory.js))

> Note: the biggest per-turn cost was the v0.35.1 double-fire (now fixed). Further at-scale work (incremental in-memory index instead of full rebuild on each write; optionally replacing the per-turn Finder LLM call with a verified semantic+graph hybrid) is documented in `audit/DESIGN-REVIEW.md` and intentionally deferred pending validation.

## [0.35.1] - 2026-05-31

### Fixed — double-fire: the pre-generation pipeline ran TWICE per turn on chat-completion backends

Chat-completion backends (OpenAI / OpenRouter / Claude / etc., `mainApi === 'openai'`) emit **both** `chat_completion_prompt_ready` **and** `generate_after_data` for a single generation. Both events called `runPipelineInline`, so **Agent 1 (Drafter) + Agent 4 (Finder) ran twice every turn** — roughly doubling their token cost and latency (~6k extra input tokens + ~15–18s of agent work per turn, observed live) — and the second run injected into the wrong (prompt-string) shape, which a chat backend ignores. The `generate_after_data` handler now **defers to the chat-completion handler for chat backends** and only runs the full pipeline for true text-completion backends (which don't emit `chat_completion_prompt_ready`). This also relieves the main-thread stall that appeared on large fact stores. ([src/pipeline.js](src/pipeline.js))

## [0.35.0] - 2026-05-31

### Added — Memory Web visualization + Database-tab decluttering + visible fact connections

- **🕸 "View Web" button (Database tab).** A new button next to *View All Facts* opens a dependency-free, force-directed SVG graph of the fact spiderweb: every fact is a dot (sized by importance + connectivity, coloured by category), every `relationships` link is a line (solid = primary, faint = secondary/tertiary). Shows the connected sub-graph, hover a dot for its full text, with a legend + counts. The relationship data was always stored and used for retrieval but had **no visualization** until now. ([src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html), [style.css](style.css))
- **Connections now shown in the fact viewer.** `renderFactRows` previously displayed only key/value/note/scene/knownBy/tags — it now also surfaces each fact's **links** (`relationships` primary/secondary/tertiary), **involved** participants, **location**, and **kind**, so the per-fact view no longer looks like "just simple facts." ([src/settings.js](src/settings.js))

### Changed — Database tab no longer dumps ~940 empty aspect slots

- The category cards used to render the **entire** built-in aspect vocabulary (~940 leaves, nearly all `:0`), which read like "1000 categories." Since the Drafter already only sees non-empty labels, the tab now shows **only aspects that actually carry facts** (plus your custom overlay leaves) and a muted `+N empty aspect slot(s) hidden` note. The underlying vocabulary is unchanged — the Scribe still files into the full taxonomy and the *Add label* dropdown still lists it; this is display-only. ([src/settings.js](src/settings.js))

## [0.34.0] - 2026-05-29

### Added — atomic-derived Tier C: semantic retrieval (#1) + batch embedding (#16). Opt-in, default off.
Match facts by **meaning**, not just keyword/trigram/graph — the one recall mode the current pipeline (spiderweb + relationship resonance) still lacks. Entirely opt-in behind `semanticRetrieval` (default **off**) and built defensively so it's safe to enable on any backend.

- **Defensive embedding endpoint (#1).** New `callEmbeddingAPI` probes `CMRS.sendEmbeddingRequest`, then proxy routes `/api/backends/chat-completions/embeddings` and `/api/backends/embeddings/compute`; returns `null` (semantic features no-op, retrieval stays keyword/graph-only) if none respond. Never throws. Handles OpenAI / raw-array / `{embeddings}` / single-`{embedding}` shapes. New `getEmbeddingProfileId` (reuses Agent 1's profile if no dedicated one). ([src/llm-call.js](src/llm-call.js), [src/profiler.js](src/profiler.js))
- **Embed-on-write + semantic layer (#1).** When enabled, new facts are vectorized after each Scribe write (fire-and-forget, stored as `fact.embedding` number[]); at retrieval `semanticLayer` embeds the query and admits the top cosine-closest facts (≥ `semanticThreshold`, default 0.75) as secondary (`via: 'semantic'`), feeding the existing token-budget/cap pipeline. ([src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-memory.js](src/agent-memory.js))
- **Batch embedding + bulk backfill (#16).** New `src/fact-embedding.js`: `embedFacts` (batches of 30 with backoff + adaptive halving) and `bulkEmbedAllFacts`. A **"Semantic retrieval"** toggle + **"Embed all facts"** button (with live progress) in the settings Database section. ([src/fact-embedding.js](src/fact-embedding.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

New settings: `semanticRetrieval` (default false), `embeddingProfile`, `embeddingModel` (default `text-embedding-3-small`), `semanticThreshold` (0.1–0.99, default 0.75).

**Note:** the embedding endpoint paths are best-effort — the exact ST embedding API isn't guaranteed across versions. Enable the toggle, click "Embed all facts", and check the debug log: "No embedding endpoint responded" means the feature no-ops and a different route must be wired for your ST build.

## [0.33.0] - 2026-05-29

### Added — atomic-derived Tier B (re-implemented against current code). Backward-compatible.

- **#14 Recency cutoff.** Facts now carry an ISO `createdAt` stamp (preserved across updates, back-filled if absent); new `recencyCutoffDays` setting (0 = off) drops secondary/tertiary facts older than N days via lexicographic string compare. Primary picks and legacy un-stamped facts are never cut. Drops are logged in the retrieval exclusion ledger (`RECENCY_CUTOFF`). New exported `sinceIso(days)`. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/settings.js](src/settings.js))
- **#10 Token budget.** The fixed `MAX_SECONDARY=12`/`MAX_TERTIARY=6` count caps are now backstops behind a `retrievalTokenBudget` (default 800, clamp 50–8000): primary tokens are charged first, then secondary/tertiary admitted by salience until the budget OR the count cap is hit (smaller wins), with an always-keep-one guard. Budget drops logged as `CAP_TOKENS`. ([src/fact-retrieval.js](src/fact-retrieval.js), [src/settings.js](src/settings.js))
- **#17 Concurrent full-chat rebuild.** `runAgent3OnFullChat` (already loading the DB map once) now fans out extraction with a new `createSemaphore` capping parallel Scribe calls at `rebuildConcurrency` (default 3, clamp 1–6) instead of a strict sequential loop; progress fires per completion. Write-safe because the shared DB object is mutated by synchronous upserts between awaits. ([src/llm-call.js](src/llm-call.js), [src/settings.js](src/settings.js))

## [0.32.0] - 2026-05-29

### Added — atomic-derived Tier A (re-implemented against current code). Backward-compatible.
First batch of improvements inferred from the *atomic* engine, ported onto the current pipeline (the originals were built on a stale v0.18.0 fork). These four had no equivalent on master.

- **#13 Empty-scope pre-LLM skip.** `runMemoryExtraction` now skips the Scribe (Agent 3) LLM call when every message in the extraction window is trivially empty (pure asterisk actions / OOC / very short). `isTriviallyEmptyForExtraction` is now exported and wired into the LIVE path (previously only the backfill used it). New `agent3EmptyScopeSkip` setting (default on). Saves a wasted call + tokens on no-content turns. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))
- **#12 Watermark at scope-time.** `bf_mem_processed` is now stamped `'in-flight'` BEFORE the Scribe call and promoted to `true` on commit, reset to `false` on explicit discard (cancel / character-change / returned LLM error), and left `'in-flight'` on an unexpected throw — closing the crash/swipe window that previously caused re-extraction. Preserves the existing no-redundant-save optimization. ([src/pipeline.js](src/pipeline.js))
- **#8 Fact provenance.** `upsertFact` now preserves the GENESIS `source`/`validAt` across updates (previously clobbered by each re-mention), stamps a `learnedAt` timestamp, and keeps a capped (≤10) `sourceHistory` trail. New `getProvenanceSummary(fact)` export. Applied across all write paths (new / in-place / supersession / sequence). ([src/database.js](src/database.js))
- **#7 Contradiction scan.** A heuristic pass (no LLM) inside reflection, every `contradictionInterval` passes (default 3, after the dedupe-janitor): flags same-key and near-key (token-Jaccard ≥ 0.72) facts with differing values into the review popup as read-only `CONFLICT` items. Excluded from the upsert path in both the popup and pipeline handlers, so it can never corrupt data. New `contradictionScanEnabled`/`contradictionInterval` settings. ([src/agent-reflect.js](src/agent-reflect.js), [src/review-popup.js](src/review-popup.js), [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js), [style.css](style.css))

## [0.31.0] - 2026-05-24

### Added — relationship "resonance": a couple's emotional thread, pulled when it matters
Follow-up to the spiderweb. Three design agents (+ a survey of Generative Agents / EM-LLM / GraphRAG) established that what connects a fight → a confession → the first date is the **couple's emotional thread**, not the place — and that proactively dumping summaries every turn is the bloat trap. So this surfaces the thread on demand, with one narrow opt-in proactive nudge.

- **Couple moment-thread recall (pull).** `getRelationshipMomentThread(A, B)` returns the chronological chain of a pair's significant moments (the `moment` facts tagged to both names) plus their key relationship facts — **including cold-tiered and superseded ones**, because an arc wants its whole history. The Writer's `search_memory` tool gained a `with:` parameter (two names) and recognizes "history of A and B" style queries, and the Drafter is nudged to reach for a couple's history on an emotional callback/turning point. Pure pull — nothing is auto-injected. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-writer.js](src/agent-writer.js), [src/agent-draft.js](src/agent-draft.js))
- **Reflection-authored callback links.** The periodic reflection pass can now name a causal/thematic **callback** ("this confession pays off that earlier hidden feeling") and store it as a lightweight link on the earlier fact — the cheap, no-extra-LLM-call way to capture *causal* resonance that plain word/place matching can't. ([src/agent-reflect.js](src/agent-reflect.js))
- **Narrow moment "echo" — default OFF.** Optional (`enableMomentEcho`, Writer tab): when the two characters present in the scene have a recent charged moment (or a reflection-authored callback into the current moment), a single token-clamped `[Echo: …]` line surfaces it above the facts. High-precision (same **pair**, not "same place" — which would fire on every revisit), capped at one, swipe-safe; off by default so it never bloats unless you opt in. ([src/agent-writer.js](src/agent-writer.js), [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

*(Deferred: a tiny moments-only meaning-search index — the one place embeddings would be justified — only if testing shows the surface cues miss real callbacks.)*

## [0.30.0] - 2026-05-24

### Added — the "spiderweb": connected, scene-aware recall (MVP)
Three independent design agents (+ a survey of GraphRAG / Zep / A-MEM) shaped this. The memory was already ~85% a connected web — facts already store who/where/when/source/related and retrieval already follows those links one hop. This finishes the web **without** turning it into an unbounded graph dump, and adds the scene/source strands.

**Retrieval hygiene (part 1).**
- **Anti-hub:** a "popular" subject's facts no longer monopolize the injected set — pure same-subject auto-links are demoted to the capped tier, and each seed/hub can contribute at most a few facts to the expansion (per-seed + total caps). Crucially, **connectedness only decides what's *eligible* — ranking stays importance/recency/use** (no "most-connected wins," which would bury the decisive sparse fact).
- **Coherent grouping:** injected facts are grouped by subject so the Writer sees connected clusters instead of a flat list (same facts, better order).
- **Deterministic expansion:** removed a `Math.random` reach in the event-sequence follow that could make swipes/regens unstable; unified the link / sequence / relationship expansions under one shared, salience-ranked cap. ([src/fact-retrieval.js](src/fact-retrieval.js), [src/database.js](src/database.js))

**Scene + source strands (part 2).**
- Each fact is now stamped with the **scene** it was established in (a deterministic, debounced scene number + name) and its **source message**. Scene boundaries advance on a *material location change* (with a similarity guard so "the bar"→"the club" or room-flapping doesn't spuriously bump); the scene name is auto-derived from the location and optionally refined by the Drafter (never required). Scene numbering is **branch-safe** (a branch continues its own numbering, like the token tab) and **swipe-safe** (re-rolling doesn't bump). Facts keep their **origin** scene (first-wins); a superseded snapshot keeps the old scene while the live fact advances.
- Same-scene is wired as a **high-precision, capped** connection (it can't form a noisy hub).
- **Recap-by-scene:** the Writer's `search_memory` tool (and a `scene` query) can now pull a whole scene — **including cold-tiered and superseded facts** (a recap wants the full scene, not just the current set). Each fact shows its scene + source in the Database tab. ([src/settings.js](src/settings.js), [src/agent-draft.js](src/agent-draft.js), [src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-writer.js](src/agent-writer.js))

*(Deferred follow-up: promoting the summary pyramid to a per-scene "arc" tier the Writer drills into.)*

## [0.29.0] - 2026-05-24

### Fixed — follow-ups from 0.28 testing
- **Subject `@`-leak (broke indexing/dedup/focus).** The Scribe emits `subj:@Name`; the parser wasn't stripping the `@`, so facts were stored with subject `@name`. That broke the per-subject index, the state-dedup, and the focus filter (and was the real reason some facts didn't surface). Now stripped at parse time and defensively on read. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **`Failed to inject memory context`.** `injectMemoryContext` could silently fail when SillyTavern's prompt-event data wasn't the exact expected shape — meaning memory might not reach the Writer. It now tries multiple container shapes, pushes on an empty array, and on true failure logs a `inject.failed` diagnostic dumping the actual data shape so it's debuggable. ([src/agent-writer.js](src/agent-writer.js))
- **Truthful aspect in the Debug log.** `fact.created`/`fact.updated` now log the real resolved aspect (e.g. `current_location`) instead of an internal key-derived string (`<name>location`). ([src/database.js](src/database.js))
- **`knownBy` default.** When the Scribe omits it, facts now default to the present character + user (instead of always "everyone"); a prompt line nudges the model to set it for secrets. ([src/agent-memory.js](src/agent-memory.js))
- **Tokens tab.** Now tracks **all** agents — Drafter, Librarian (finder), Writer, Scribe, **and Reflection** (finder + reflection token counts were being computed then discarded) — and a branch chat starts its own token tally instead of showing the parent's stale counts. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))
- **Active DB profile.** A profile is now reliably ensured + linked + activated at fact-write time (not only on chat-change), so the Database tab shows the active profile and per-turn saves no longer silently no-op (this also covers branch chats whose parent wasn't linked). "Save As New" now binds the new profile to the current chat. ([src/settings.js](src/settings.js))

## [0.28.0] - 2026-05-24

### Fixed — facts now belong to the right character (was a data-loss bug) + a faster loop
A 3-agent diagnosis traced several symptoms to one hub bug and a self-inflicted latency tax.

**The hub bug: facts were stored under a generic `"char"` label, not the actual character.** The character name (`{{char}}`) was filled into the note-taker's *instructions* but **never into its saved output**, so facts were stored as `char_*` / subject `"char"`. Consequences, all now fixed:
- Retrieval filters by the real character name, found nothing stored under it, and **dropped the character's own facts** before they could be injected → that was the real "too few facts injected" (not a cap).
- The merge logic, seeing everything under `"char"` with similar keys, **collapsed distinct facts** (a location overwrote a physical state; "soaked jeans" overwrote "soaked hoodie").
- **Worst — group chats / NPCs:** every character became `"char"`, so one character's facts **overwrote another's in place** (silent data loss).
Now every fact resolves to the real character/speaker name (per-character key namespacing), so two characters can never collide; the focus filter matches; and `dedupeDatabase` can't cross-collapse characters. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js), [src/pipeline.js](src/pipeline.js))

**Merge matcher no longer collapses distinct facts.** Numbered items (`_1`/`_2`) stay separate, and `physical_location` ≠ `physical_state` (the matcher only drops known version-qualifier tokens, not the distinguishing one). Legitimate same-key state changes (e.g. standing→sitting) still supersede. ([src/database.js](src/database.js))

**Better injection (right facts, not just more).** The finder now gets a ~12 *target* instead of only a ceiling, and each present character's key anchors (identity / current state / relationships) are guaranteed into the injected set via the subject index.

**Faster loop.** The finder no longer blocks the reply ~6s every turn on a slow model: budget cut to 3.5s, the in-flight call is **cancelled on timeout** (no wasted tokens), and an adaptive breaker stops waiting on it after repeated slowness (re-probing periodically). The note-taker's taxonomy menu shrank **~93% (~3,100 → ~230 tokens per extraction)** by showing families instead of all ~940 leaves (write-time snapping still files to a real leaf), and its system prompt is byte-stable/cacheable again. New (default-safe) settings: `finderBudgetMs`, `finderTargetFacts`, `finderAnchorsPerCharacter`. ([src/pipeline.js](src/pipeline.js), [src/agent-finder.js](src/agent-finder.js), [src/agent-memory.js](src/agent-memory.js), [src/llm-call.js](src/llm-call.js), [src/database.js](src/database.js), [src/settings.js](src/settings.js))

### Added — per-stage timing observability
The run summary now carries a per-stage `stages` breakdown and a `pipeline.timing` event (Agent 1 / finder / inject / Agent 3 / snapshot durations + the Scribe prompt size), so a slow turn pinpoints its own bottleneck. ([src/pipeline.js](src/pipeline.js), [src/agent-memory.js](src/agent-memory.js))

## [0.27.0] - 2026-05-24

### Fixed — CRITICAL: memory could be silently overwritten on chat-switch / branch
A 3-agent diagnosis found a data-loss bug: switching chats (especially opening a **branch**) could blank the working memory and then **rehydrate stale data over your fresh facts**.

Root cause was a **version-stamp bug**: the durable backup file was stamped with the time its *upload finished* — and because saves are throttled (~15s), an *old* backup looked "newer" than current data, so on load the extension adopted the stale backup and overwrote newer facts. (The tell: the failing log showed an attachment-vs-IDB stamp gap of ~15.5s — exactly the save-throttle.) On top of that, opening a chat destructively wiped the working store before reloading from a per-chat profile (empty for a fresh branch), and an un-awaited snapshot on chat-switch could even delete backup files.

Fixes ([src/database.js](src/database.js), [src/settings.js](src/settings.js), [src/pipeline.js](src/pipeline.js)):
- **Version by data, not upload time** — snapshots compare the logical `updatedAt` baked into the data, so a clean flush yields equal stamps and never triggers a spurious rehydrate.
- **Clobber guard** — a rehydrate may only add/replace-with-more; it will *never* shrink a populated live store. On any doubt, the live data is kept.
- **Non-destructive chat load** — opening a chat no longer wipes existing memory when the profile is empty.
- **Coordinated chat-switch** — the outgoing chat is flushed (identity pinned) before the new one loads, and a chat-switch can no longer delete durable backup files.
- **Per-turn cache keyed by (character, chat)** so a same-character chat-switch can't serve a stale map.
- **Branches inherit the parent chat's memory** by default (instead of resolving to an empty profile).
- User-initiated delete/clear still fully wipes all layers (no regression).

### Added — DB connection-lifecycle logging
The Debug log now records the connection story explicitly: `chat.switch` (left→entered, branch flag), `db.connect` (which profile, link state, facts loaded, source), and an enriched `db.rehydrated` with before/after fact counts so a clobber is visible at a glance — plus the active profile/avatar on each run summary. ([src/settings.js](src/settings.js), [src/database.js](src/database.js), [src/pipeline.js](src/pipeline.js))

## [0.26.0] - 2026-05-24

### Fixed — "delete doesn't stick" + 75-second hangs + a real management UI
A 3-agent diagnosis (detailed / contrarian / edge-case) traced three serious problems to their root causes. All fixed.

**Deleting facts now actually sticks (data-integrity).** Facts lived in THREE places — the IndexedDB working store, the attachment snapshot, AND a full copy inside the DB *profile* (`dbProfiles`). "Clear All" / category-delete wiped the first two but never the profile, so on the next chat-switch the profile re-poured every fact back (and an empty-store guard made a cleared DB literally unable to persist). Now every user delete/clear prunes all three layers, cancels any pending snapshot, and deletes emptied attachment files — a clear stays cleared across chat-switch and reload. (No baked-in/seed facts exist; those were always your own.) ([src/database.js](src/database.js), [src/settings.js](src/settings.js))

**Bounded latency — no more 75-second stalls.** The Librarian (finder) ran on the reply-critical path and a failing API could retry a 60s timeout across three transports (~6 minutes worst case) without ever aborting the stuck request. Now: real `AbortController` cancellation, a 28s per-leg / **45s total** wall-clock budget per agent, no retry on deterministic 4xx errors, and the finder is raced against a **6-second budget** — if it's slow the reply falls back to the instant deterministic retrieval for that turn. The finder's candidate set is also capped (hot-only, top-N by salience) so it can't grow unbounded as the store grows. ([src/llm-call.js](src/llm-call.js), [src/pipeline.js](src/pipeline.js), [src/database.js](src/database.js))

**Disable / Stop now actually stops.** Toggling the extension off (or hitting Stop) mid-run cancels the active run and aborts any in-flight LLM call, and injection is skipped — instead of finishing ~75s later. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))

### Added — memory-management UI (parity with other memory extensions)
The Database tab's fact viewer is no longer read-only:
- **Per-fact edit & delete**, **search/filter** within a category and **across all categories**, **bulk select + delete** — all persisting across all three storage layers (no resurrection).
- **Real unlink** — unlinking a chat now sticks (it won't silently auto-relink); plus a one-click "unlink current chat".
- **Cold-tier badges** so you can see (and manually remove) deprioritized facts.
- **Import** a DB from JSON (replace or merge); large categories render capped + paginated so the UI doesn't freeze.
([src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

## [0.25.0] - 2026-05-24

### Added — housekeeping + taxonomy growth (350 → ~1000 labels, and a growth engine)
Closes the rebuild roadmap: the small portability/log fixes, plus the shelf-label expansion with both a manual and an AI-assisted way to keep growing it. The fact schema is unchanged and existing facts keep resolving — taxonomy growth never rewrites the store.

**Portability seam.** Core data/LLM/logic modules (`database`, `llm-call`, `fact-retrieval`, and the agent-* modules) now reach SillyTavern only through a single thin adapter (`src/host.js`) instead of touching the `SillyTavern` global directly — so the engine stays "loosely clipped" and could move to another host later without a rebuild. Behavior is unchanged (pure indirection). ([src/host.js](src/host.js) + migrated core modules)

**Log fix.** Switching chats no longer loses the last few (especially verbose) debug-log lines: the outgoing chat's log tail is flushed to its own file before the buffer swaps to the new chat. ([src/settings.js](src/settings.js))

**Taxonomy expanded to a ~1000-label 3-level tree.** Layer 2 grew from ~90 flat aspects to **~940 leaf aspects** organized under **~77 sub-areas** within the 7 fixed categories (People holds ~⅓; the old `Time` idea folds under World). The fact still stores only `category` + `aspect`; a flattener preserves the exact storage/menu/retrieval contract, so nothing downstream changed. The Scribe now navigates a grouped (drill) menu instead of a flat list, and a synonym layer canonicalizes near-duplicates (`phobias→fears`, `occupation→career`, …) so the same concept always files to one leaf. Every prior label is preserved and every old fact still resolves. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js))

**User-added labels.** From the Database tab you can add your own Layer-1 categories and Layer-2 leaves; they persist in a global overlay merged on top of the built-ins, are deduped/canonicalized on add (a near-duplicate is absorbed as a synonym, not a second label), and show with a "custom" marker. ([src/database.js](src/database.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html), [style.css](style.css))

**AI "Suggest new labels" button.** A manual, on-demand action (no per-turn cost): it scans homeless facts (the `Unsorted/misc` pile + facts stuck on a category default), asks the model once to cluster them and propose new leaves (reusing existing labels where possible), and shows them in an **approve/reject** popup. Approved labels are written through the same deduped overlay path. ([src/taxonomy-suggest.js](src/taxonomy-suggest.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Also:** the Database tab no longer shows the obsolete `/50` per-category cap (removed by the never-delete work) — it shows the real fact count and how many are cold-tiered.

## [0.24.0] - 2026-05-24

### Added — scale work, part 2: infinite facts, recall, summaries, episodic memory, auto-linking
The rest of the rebuild toward unbounded memory (the "1–9" batch), built on the 0.23.0 storage foundation. All additive; the two new injection/tool features are **default-OFF** so existing behavior is unchanged until you opt in. Needs in-browser testing for the IndexedDB- and tool-calling-dependent paths.

**1 · Never throw memories away (uncap + cold tier).** The ~50-per-category hot cap no longer **deletes** overflow — the lowest-salience facts are marked `cold` (kept on disk, still queryable, just deprioritized) and **resurface** the moment they're re-mentioned or directly matched. Nothing is ever evicted. ([src/database.js](src/database.js))

**2 · Indexed retrieval + scoped Scribe dedup.** A per-turn in-memory index (`byCatAspect` / `bySubject` / `byToken` / `aspectCounts`) replaces the several O(all-facts) scans the hot paths each did, so retrieval stays fast at tens of thousands of facts. The Scribe's duplicate check now looks at a **scoped candidate set** instead of dumping the whole DB into its prompt. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-memory.js](src/agent-memory.js), [src/pipeline.js](src/pipeline.js))

**4 · Use-it-or-lose-it.** Facts that actually get injected into the Writer's context are **strengthened** (a `useCount` + `lastUsedAt` refresh feeds salience), so frequently-used facts stay hot and win scarce slots; untouched facts decay and drift cold (never deleted). Bumps persist via the existing post-reply save. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/pipeline.js](src/pipeline.js))

**5 · Writer recall tool (pull-detail) — default OFF.** Optional `search_memory` function-tool exposed on the main Writer path: when the Writer needs a fact that wasn't pushed, it can fetch it on demand (deterministic, zero-API, read-only, hard-capped). Enable in the Writer tab; requires a tool-calling-capable main model. ([src/agent-writer.js](src/agent-writer.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html), [index.js](index.js))

**6 · Summary pyramid + multi-pass — injection default OFF.** The reflection pass now also maintains a short **per-shelf** (category/aspect) summary rolling up into the existing whole-story summary, folded into the one reflection LLM call and cost-bounded (only changed buckets, capped per pass). An optional **"Big Picture"** block injects the story + scene-relevant shelf summaries above the facts (token-capped); the Writer drills into specifics via the recall tool. ([src/agent-reflect.js](src/agent-reflect.js), [src/agent-writer.js](src/agent-writer.js), [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**8 · Episodic scene memory.** New `moment` fact kind for significant emotional/relational beats (slower decay than ordinary events — 30-day half-life), with an optional short `tone` field surfaced compactly to the Writer. The Scribe records genuine turning points as a narrative beat in the note (who + where + why it mattered), not just dry `key = value`. ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-finder.js](src/agent-finder.js), [src/agent-memory.js](src/agent-memory.js))

**9 · Automatic associative linking.** A freshly-written fact deterministically auto-links (zero-API) to related existing facts by shared subject / location / `involved` members / lexical token overlap, recorded into `relationships` (unioned, never clobbered, hard-capped). Retrieval's existing link-following then surfaces the connections. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Never-delete compliance.** The reflection janitor's re-evaluation **DROP** verdict now **cold-tiers** the fact instead of deleting it (the only remaining automated `removeFact` is a category *relocation* during PROMOTE, which preserves the fact). ([src/agent-reflect.js](src/agent-reflect.js), [src/database.js](src/database.js))

*(Items 3 and 7 — scoped dedup and the speed fixes — shipped in this batch and 0.23.0 respectively.)*

## [0.23.0] - 2026-05-24

### Changed — scale work, part 1: speed fixes + hybrid storage foundation
First two steps of the rebuild toward unbounded memory. Backward-compatible; falls back to prior behavior if the new storage can't initialize.

**Performance fixes (safe, immediate).** ([src/database.js](src/database.js), [src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))
- `getAllDatabases()` is now memoized per turn (keyed by character avatar) and invalidated on every write/chat-change — it was being re-fetched + re-parsed ~4-5× per turn.
- The whole chat is no longer re-serialized every turn just to stamp `bf_mem_processed` — a chat save is triggered only when the flag actually changed.
- The full chat is no longer tokenized twice per turn for the token stat (the no-trim path reuses the baseline + injection count).
- The "run on current chat" backfill loads the DB once before the loop (not per message) and yields periodically so it can't freeze the UI.

**Hybrid persistence foundation (durable + fast).** ([src/database.js](src/database.js))
- Facts now live in a fast **IndexedDB** working store, with the existing SillyTavern character-attachment kept as a **durable, device-independent snapshot/backup** (throttled write + flush on chat-change/unload). On a new device or cleared cache it **rehydrates** IndexedDB from the snapshot; existing attachment DBs are **migrated** into IndexedDB once on first run.
- **Graceful fallback:** if IndexedDB is unavailable, blocked (private mode), or errors at any point, the extension transparently reverts to attachment-only behavior (zero regression). Every fallback is logged once (`storage.fallback`) so it's visible in the Debug tab.
- The public storage API and the per-turn cache contract are unchanged — no caller behavior changed this phase. (The fact cap is **not** removed yet; that and indexed-query retrieval come in the next phases on top of this foundation.)
- **Note:** IndexedDB can't be exercised outside a browser, so this needs real in-browser testing; the fallback keeps it safe if anything misbehaves.

## [0.22.0] - 2026-05-24

### Changed — agents renamed, menus reorganized, Scribe prompt reworked
A clarity + usability pass across the whole UI and the memory-extraction prompt.

**Agents renamed (UI labels only; internal keys unchanged).** Agent 1 → **Drafter**, Agent 2 → **Writer**, Agent 3 → **Scribe** (writes facts to memory), Agent 4 → **Librarian** (fetches facts for the Writer). Settings tabs reordered chronologically — **Drafter → Librarian → Writer → Scribe** → General → Database → Last Generated → Last Inserted → Tokens → Debug — and the Librarian got its **own tab** (the finder toggle / connection profile / prompt moved there from the Writer tab). ([templates/settings.html](templates/settings.html), [src/settings.js](src/settings.js))

**Scribe (memory) prompt reworked.** Now explicitly instructed to **read the whole message including dialogue** (dialogue is the best signal for character growth + relationships); the `>note` field is used for a **verbatim quote OR a short summary** when atomic tags can't carry the moment; uncertain one-offs are **recorded to `Unsorted`/misc** (with `conf:low`) instead of skipped, and the reflection pass gained a **re-evaluation step** that later promotes recurring misc facts to a proper aspect or drops confirmed one-offs. The per-message character limit on the Drafter's view was **removed** (it reads full messages now). ([src/agent-memory.js](src/agent-memory.js), [src/agent-reflect.js](src/agent-reflect.js), [src/pipeline.js](src/pipeline.js))

**Value↔note: store both, slim at injection.** The Scribe always writes BOTH the atomic value and (when warranted) the note — full fidelity in the DB. The **Writer injection now shows the note in place of the value** when a fact has one (the note already contains the gist), avoiding value+note duplication in the Writer's context. Applies across all three injection formatters. ([src/agent-memory.js](src/agent-memory.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-finder.js](src/agent-finder.js), [src/pipeline.js](src/pipeline.js))

**Menu cleanup.** Removed the inert secondary/tertiary chance sliders (dead since deterministic retrieval), the "story so far" checkbox, and the "use separate profiles" toggle (per-agent connection profiles are now always active via [src/profiler.js](src/profiler.js)). The Librarian context slider was replaced with an explanation (it always reads the last 2 messages). The Scribe tab was reordered (prompt up top, re-evaluation fields at the bottom). ([templates/settings.html](templates/settings.html), [src/settings.js](src/settings.js), [src/profiler.js](src/profiler.js))

**Prompt transparency.** Each agent's prompt editor now has a read-only **"What actually gets sent (assembly order)"** box showing how the final prompt is built (system prompt + the auto-injected character card / persona / Memory Menu / recent chat / facts / scene card / draft), accurate to the actual `build*Prompt` / `buildWriterInjection` code. ([templates/settings.html](templates/settings.html), [style.css](style.css))

**Verbose log persisted to its own file.** The full debug log (including verbose) is now written to a dedicated per-chat attachment file (`bf_mem_debuglog_<chat>.json`, capped ~4000 entries, throttled 15s + on unload, reloaded on chat open) — so verbose history survives reload **without** bloating the chat `.jsonl` (a small non-verbose slice still lives in chat metadata for instant paint). ([src/settings.js](src/settings.js), [src/database.js](src/database.js))

## [0.21.0] - 2026-05-24

### Added — comprehensive debug logging + queryable Debug tab (Phase 8)
The flat, lossy text log became a structured, run-grouped, before→after audit trail that answers "what ran when, what changed, why" — without bloating `chat_metadata` or breaking the existing readers. Entirely additive: every entry still carries the legacy `{type, message, timestamp}` keys, so the old Copy export and persisted-log shape-check keep working.

**Structured entry schema (Phase 8a — logging core).** Each log entry gains `level` (5-value superset of the 3-value `type`), `subsystem`, `runId`, `event` (dotted machine key), `data` blob, `reason` code, `before`/`after`, plus `seq`/`ts`/`iso` for stable, machine-parseable ordering. `addDebugLog` stays backward-compatible (2-arg legacy form still valid; new `opts` object is optional), with a RAM ring buffer (`MAX_DEBUG_ENTRIES_MEM = 2000`, drop-oldest) and a separate verbose-stripped, byte-budgeted persisted slice (`MAX_DEBUG_ENTRIES_PERSIST`). Old persisted logs back-fill `level`/`subsystem`/`ts` and parse a leading `[Rxxxx]` prefix so they still group. ([src/settings.js](src/settings.js))

**Instrumented ~135 events across subsystems (Phase 8b).** Pipeline, agents 1/3, finder, retrieval, db, entity, and reflection now emit structured events. Previously **silent fact mutations** (new/updated/superseded/skipped/evicted/deleted) are logged with compact `before → after` diffs and `reason` codes. Retrieval emits an **admission + exclusion ledger** answering why each fact was or wasn't used, with an on-demand `explainFactRetrieval(key)` "why not?" probe. Each turn shares ONE `runId` across the pre-reply and post-reply boundary, ending in a single `run.summary` event (duration, per-agent status, fact counts, token accounting). Cache-eligibility is logged honestly (client `cache_control` is stripped server-side). ([src/pipeline.js](src/pipeline.js), [src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-memory.js](src/agent-memory.js), [src/agent-reflect.js](src/agent-reflect.js), [src/agent-entities.js](src/agent-entities.js))

**Debug tab UI (Phase 8c).** ([templates/settings.html](templates/settings.html), [src/settings.js](src/settings.js), [style.css](style.css))
- **Per-run grouping.** Entries collapse into one `<details>` block per `runId` (newest first, collapsed by default), with the `run.summary` rendered as a compact header (e.g. `Run R3f2 · 320ms · A1✓ A3✓ · facts 3N/1U/0S · +4.1k tok`). Run-less entries collect under an "Ungrouped / manual" section.
- **Filter toolbar.** Level checkboxes (fail/pass/info default-on, debug/verbose opt-in), a subsystem dropdown, and a runId/text search — all pure client-side passes over the in-memory buffer, re-rendering on change, with a live `showing N / total` count. Entries are color-coded by level.
- **Verbose toggle.** A clearly-labeled checkbox bound to the `debugVerbose` setting — when off, verbose entries are dropped at ingestion (RAM-only firehose, never persisted) and the verbose display checkbox greys out.
- **JSON export.** A new "Export JSON" button downloads + copies the full ring buffer via `exportLogsJSON()`; the existing text Copy/Clear buttons are unchanged.
- **"Why not?" probe.** A small input + button calls `explainFactRetrieval(key)` and shows the fact's fate inline.

## [0.20.0] - 2026-05-23

### Changed — token-cost savings (after a 3-agent overspend audit)
An audit found ~3 LLM calls every turn re-sending overlapping context, with Agent 3 (the note-taker: a ~4.2k-token prompt + the full fact DB) the dominant cost, re-running on every generated swipe. This release lands the safe code-side savings; the biggest win (caching Agent 3's static prompt) is a server-side SillyTavern setting (see note).

- **Per-swipe extraction gated.** Agent 3 extraction was firing on every generated swipe (4 swipes ≈ 4× the ~7k-token call). Both `MESSAGE_RECEIVED` and `MESSAGE_SWIPED` now feed a single ~1.8s settle-debounce (`scheduleSettleExtraction`), so a heavily-swiped turn extracts **once** — on the kept/settled reply. A normal single-reply turn still extracts exactly once, promptly. All guards intact (`bf_mem_processed`, Stop/`pipelineCancelled`, capture-at-write, character-changed, `memoryExtractionInFlight`). Reflection + entity-check now also tick once per settled turn rather than per swipe. ([src/pipeline.js](src/pipeline.js))
- **Dead payloads dropped.** (a) The fact-key inventory (`summarizeKeys`) is no longer built or sent to Agent 1 when the finder is on (default) — it was only used by the deterministic fallback; the menu still goes to Agent 1 as before. (b) Reflection's rolling `#STORY` summary (no longer injected since 0.18) is no longer generated or fed back each pass — only the `#OBS` observation-writeback remains; the settings panel still renders observation chips. ([src/pipeline.js](src/pipeline.js), [src/agent-reflect.js](src/agent-reflect.js))

### Note — prompt caching is a server-side setting, not an extension feature
The biggest potential saving (caching Agent 3's large static system prompt) **cannot be set from an extension** — SillyTavern's connection layer strips client `cache_control`, and caching is driven by server config. The extension's prompts are already structured cache-optimally (static system prompt first, all variable data after). To enable it, set in SillyTavern's `config.yaml`: `claude.enableSystemPromptCache: true` (and optionally `claude.extendedTTL: true`). A doc-comment recording this invariant was added to [src/llm-call.js](src/llm-call.js). ([src/llm-call.js](src/llm-call.js))

## [0.19.0] - 2026-05-23

### Changed — granular ~82-label Layer-2 taxonomy + two-tier menu
The broad Layer-2 labels (identity/appearance/body/status/…) were too coarse — a planner LLM picked almost all of them every turn, so the menu didn't filter. Replaced with a granular, scene-trigger vocabulary so opening a label is a real signal. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js), [src/agent-draft.js](src/agent-draft.js))
- **~82 granular Layer-2 labels** across the 7 categories. People gets the big set (childhood, finances, fears, wardrobe, injuries, secrets, vices, daily_routine, current_location, …) — specific drawers that stay shut in an ordinary scene.
- **Two-tier menu:** the planner (Agent 1) now sees ONLY non-empty labels with counts (small + discriminating even with 82 defined); the note-taker (Agent 3) and the Database tab see the FULL fixed vocab for consistent filing.
- **Relationships stay character-AGNOSTIC** (history/friendship/romance/tension/trust/…), discriminated by the existing `subj:@<A>` + `with:@<B>` pair-tag rather than a per-character label (avoids menu-cardinality blowup). 
- Back-compat: legacy aspects (body→appearance, background→childhood, role→career, goals→current_goal, behavior→habits, …) remap on read; unknowns snap to the category default.

### Fixed — ESM-breaking unescaped backtick (extension-load bug)
`DEFAULT_MEMORY_PROMPT` had one bare `` `~` `` (line 168) instead of an escaped `` \`~\` ``, which closed the prompt's template literal early. `node --check` (script mode) tolerated it, but SillyTavern loads extensions as ES modules, where it threw `SyntaxError: Unexpected token '~'` and broke `agent-memory.js` from loading. Now escaped; verified by a module-mode parse of every source file. (Latent since the supersession example was added.) ([src/agent-memory.js](src/agent-memory.js))

## [0.18.0] - 2026-05-23

### Changed — 3-layer fact model (rough → aspect → character-tag) + default skeleton
Restructures how facts are organized and retrieved, fixing two problems: (1) nothing seeded the structure, so a fresh chat had zero layers until a fact landed; (2) the character was the Layer-2 menu branch, so every character surfaced in the menu and the detail finder pulled ALL of a character's facts (token cost). Backward-compatible — legacy facts/categories are remapped on read.

**New 3-layer model.** ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js))
- **Layer 1 — `category`** (rough, genre-agnostic): `People · Places · Things · Relationships · Events · World · Unsorted`. A legacy-category map (`mapLegacyCategory`, scope-sensitive) re-buckets the old Identity/World/Status/Behavior/History categories on read, so existing databases keep working.
- **Layer 2 — `aspect`** (new field, fixed vocab per category, character-agnostic): e.g. People→ identity/appearance/body/background/role/status/mood/goals/behavior/skills; Places→ residence/public/region/feature; Events→ milestone/scene/action; etc. (`TAXONOMY` constant.) Agent 3 emits it via `aspect:`; falls back to a per-category default when omitted.
- **Layer 3 — character tag.** The character is now a TAG carried in `involved` (`with:@<NAME>` / `@npc`), NOT the menu branch. A person's facts live across many category/aspect branches and are pulled by tag-filter, not by a per-character branch.

**Default skeleton from turn 1.** The full Layer-1 + Layer-2 taxonomy is a code constant; `buildSkeletonDatabases`/`withSkeleton` present the complete empty skeleton (categories + aspects, counts 0) in the menu and the Database tab from the very first turn — no more "No databases yet." Empty-file spam is avoided: category files are written on first fact (write-on-first-fact), not seeded as empty uploads. ([src/database.js](src/database.js), [src/settings.js](src/settings.js))

**Menu + finder rewired to category/aspect with a character tag-filter.** ([src/agent-draft.js](src/agent-draft.js), [src/pipeline.js](src/pipeline.js), [src/agent-finder.js](src/agent-finder.js))
- `summarizeMenu` + `collectBranchFacts` now key off `category/aspect` (character-agnostic), so the menu Agent 1 sees stays small no matter how many characters exist.
- Agent 1 picks `Category` / `Category/aspect` `#Branches`, and optionally names the focus character(s) in a new `#Focus:` line (which never becomes a branch).
- New `filterCandidatesByFocus` keeps, for the detail finder, the focus character's facts + all non-character (place/event/world) facts + untagged facts + the always-included `Unsorted` catch-all, and drops other characters' character-scoped facts in the same aspects — so the finder is never handed every character's stuff. Applied before `expandLinks`, so place⇄event⇄people link-following and place-recall still function. Empty/over-narrow candidate sets fall back to deterministic retrieval.

## [0.17.0] - 2026-05-23

### Added — entity scope + link-following retrieval + character registry (Phase 4)
The full arc since 0.16.0, landed across four sub-phases. All backward-compatible (absent fields/state/settings behave as before).

**Phase 4a — scope + participants + place filing.** Facts gain an explicit `scope` axis (`character | place | event`) so the store knows whether a row describes a person, a location, or something that happened; derived deterministically from category/track when the model omits it. Event facts carry an `involved` participant list (the who) and a `location` link (the where), so a single event can tie people⇄place together. Unnamed/one-off people file under a shared `npc` drawer (`subj:npc | with:<the descriptor>`) instead of cluttering the store, and a place-filing fix routes World/location facts to the correct `place` scope so they stop being mis-derived as characters. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))

**Phase 4b — link-following retrieval.** A new graph-walk pass expands the candidate set along the scope links AFTER the lexical/fuzzy layers: place→events, person→events, event→place, and event→people. Any retrieved event pulls in the place it happened at and the key facts of each `involved` participant, so recalling one node surfaces the connected ones without extra API calls. Bounded by the existing tier caps; deterministic. ([src/fact-retrieval.js](src/fact-retrieval.js))

**Phase 4c — character registry + recurring-cast detection.** A per-chat character registry tracks every named entity seen (name, status, first/last-seen, mention count). An every-N-message detector flags recurring people, freshly-named NPCs, and walk-ons worth promoting, batched into a single Recurring/NPC/Later review popup instead of interrupting per message. Promoting an NPC auto-migrates its `npc_*` facts onto the real name (re-keyed, subject restamped). New registry UI surfaces the tracked cast and pending promotions. ([src/agent-entities.js](src/agent-entities.js), [src/review-popup.js](src/review-popup.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Phase 4d — anonymization + secrets pass (release prep).** Final sweep before going public: every illustrative person/place/org/object name in code comments, prompt examples, and CHANGELOG/README prose was replaced with generic placeholders (`<NAME>`, `<CHAR>`, `<PLACE>`, `<CITY>`, `<ORG>`, `<PET>`, `<OBJECT>`), and the README walkthrough rewritten to use placeholders throughout. No functional code, element IDs, function names, settings keys, or grammar markers were changed — illustrative content only. A credential scan (API keys, tokens, bearer strings, hex/base64 blobs) found nothing to redact. ([README.md](README.md), [src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js))

## [0.16.0] - 2026-05-23

### Added — extraction-quality + two-stage retrieval + latency arc (Phases 1–3b)
The full arc since 0.15.0, landed across four phases. All backward-compatible (absent fields/state/settings behave as before).

**Phase 1 — extraction quality + a catch-all.** Closes the "facts get mis-filed or silently dropped" class.
- **Unsorted catch-all.** A new `Unsorted` category is a first-class home: a fact whose category matches none of the six topical buckets is routed there instead of being silently mis-filed as `Status`. Active Unsorted facts are ALWAYS folded into retrieval candidates (`collectBranchFacts`) so the catch-all can never be blanked. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Subject axis.** Facts gain an explicit `subject` (who/what the fact is ABOUT) via an `aka`-grammar-compatible `subj:` segment, deterministically derived from the key prefix when omitted, so the field is always present downstream as a real index axis. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Mandatory importance + kind.** `!N` (1–5) and `kind:trait|state|event` are now required on every fact; when the model omits them they are INFERRED from observable signals (category/track/key) and FLAGGED `inferredFields` (inferred-vs-stated) rather than silently defaulted. These protect foundational facts from eviction and rank retrieval. ([src/agent-memory.js](src/agent-memory.js))
- **Provenance.** Optional `conf:high|med|low|0-1` confidence and a `validAt` stamp (the source message index where the fact became true) ride along, both optional/back-compat. ([src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Parallel-key dedup.** `upsertFact` reconciles on write — on an exact-key miss it conservatively matches a normalized-key variant and updates in place instead of minting a parallel contradictory key. ([src/database.js](src/database.js))

**Phase 2 — two-stage menu→detail retrieval.** Replaces the single blind keyword pass with a cheap menu pick + a focused detail finder, all without embeddings.
- **Stage 1 — menu.** New `summarizeMenu()` builds a compact KIND×SUBJECT map (counts, NO values); Agent 1 picks relevant `#Branches` from it. ([src/database.js](src/database.js), [src/agent-draft.js](src/agent-draft.js))
- **Stage 2 — finder.** New module [src/agent-finder.js](src/agent-finder.js) (`runFinderAgent`, Agent 4) reads the FULL active facts under Agent 1's picked branches (plus Unsorted), and chooses the precise set to inject. New Agent 4 connection profile id (`getAgent4ProfileId`). ([src/profiler.js](src/profiler.js))
- **Rename-tolerant `knownBy` + deterministic fallback.** Visibility filtering is rename-tolerant; when the finder is disabled, errors, times out, or returns nothing, retrieval falls back to the deterministic speculative+delta-keyword pass which ALWAYS still folds in active Unsorted facts — a failed detail pass can never blank memory. ([src/pipeline.js](src/pipeline.js), [src/fact-retrieval.js](src/fact-retrieval.js))

**Phase 3a — injection slimming + reflection-as-janitor + finder UI.** Dropped the "story so far" injection from the writer (the writer now receives only the scene sheet + chosen facts + Agent 1's draft); raised the Agent-1 draft per-message char limit (and character-card limits) so long turns aren't truncated; next-scene hints (`#NextHint`) are stashed as a backstage breadcrumb on the user message's `extra` (never injected); the reflection pass became a silent dedupe-janitor / observation writer (no longer injects); finder settings/UI surfaced. ([src/pipeline.js](src/pipeline.js), [src/agent-draft.js](src/agent-draft.js), [src/agent-writer.js](src/agent-writer.js), [src/settings.js](src/settings.js))

**Phase 3b — Agent 3 OFF the blocking path + swipe fixes.** The latency + swipe-quality cleanup.
- **Agent 3 moved off the pre-generation blocking path.** Previously the user waited for Agent 3 to extract facts about the PREVIOUS exchange before THEIR reply generated. Agent 3 (`runMemoryUpdater`) now runs POST-reply on `MESSAGE_RECEIVED` (new `runMemoryExtraction()`), the same off-critical-path place reflection already uses. The blocking path now runs ONLY Agent 1 (draft/menu) + speculative retrieval + the Stage-2 finder (the agents that feed THIS reply). The reply is fully present by extraction time, so we extract the real accepted text — and the AI message itself is the target (`findMemoryTargetIndex(chat, true)`). Every guard is preserved: `bf_mem_processed` gating (no double-extract), `pipelineCancelled`/Stop discards the write, capture-at-write of the DB profile + character avatar (pinned at extraction start, the correct moment now timing shifted), group/dry/internal skips, and the review-popup/`saveChatDebounced`/`saveCurrentToActiveProfile` commit. Wrapped in try/catch — an extraction failure can never break generation or the next turn. A `memoryExtractionInFlight` guard prevents overlapping extractions. ([src/pipeline.js](src/pipeline.js))
- **Token accounting kept consistent.** The blocking path records the run once with Agent 3 = 0 (`recordRunTokens({…, memoryResult: null})`); a new `addAgent3Tokens()` folds Agent 3's input/output into the session totals on `MESSAGE_RECEIVED` WITHOUT bumping the run count or re-counting baseline/actual input, and updates `lastRunTokens.agent3*` so the per-run breakdown still shows the Agent 3 line. ([src/settings.js](src/settings.js), [src/pipeline.js](src/pipeline.js))
- **Swipe fix (a) — no stale draft on a divergent re-roll.** Swipes/regens previously re-injected the cached injection verbatim, including Agent 1's draft scene-direction planned for the ORIGINAL roll, which mis-steered a divergent re-roll. A second cached injection (`lastInjectionNoDraft`) carries the SAME scene + facts (turn-stable, safe to reuse) but DROPS the stale draft; both swipe re-inject paths now use it. Still fast — no agent re-run. ([src/pipeline.js](src/pipeline.js))
- **Swipe fix (b) — extract the ACCEPTED swipe.** With Agent 3 on `MESSAGE_RECEIVED` targeting the just-received message, generating any swipe extracts the accepted content (the active swipe IS the message's current text) — closing the gap where a swiped-then-stopped reply never got extracted. Navigating onto an ALREADY-generated swipe (which fires `MESSAGE_SWIPED` but not `MESSAGE_RECEIVED`) is handled by a debounced settle-extraction scheduled in `MESSAGE_SWIPED`; rapid navigation only extracts the final settled swipe, and the `bf_mem_processed` gate prevents double-extracting the same accepted content. The timer is cleared on chat change. ([src/pipeline.js](src/pipeline.js))

## [0.15.0] - 2026-05-23

### Added — reflection/consolidation + middle-ground retrieval (no vectors)
Two upgrades closing out the memory-research blueprint. Backward-compatible (absent fields/state behave as before).

**Reflection / consolidation pass (Phase 3).** A periodic pass that compresses accumulated detail into higher-level memory so long sessions keep narrative continuity without unbounded growth. New module [src/agent-reflect.js](src/agent-reflect.js): `runReflection()` makes ONE LLM call (reusing Agent 3's connection profile) over a bounded bundle (prior summary + scene/beats + a few timeline steps + a compact active-fact summary), parsing a `#STORY` summary + `#OBS` observations. Cost-aware and infrequent: armed at the end of a successful pipeline run and executed on `MESSAGE_RECEIVED` (off the latency-critical path), wrapped in graceful-degradation so a failure never breaks the pipeline. Write-back: the rolling summary is stored per-chat in `chat_metadata.bf_mem_reflection` (`getReflection`/`setReflection`/`reloadReflectionFromChat`, reloaded on CHAT_CHANGED), and observations (e.g. "<CHARACTER> manipulates others for resources") are written as `Behavior` facts with `kind:trait`, importance 4, tags `observation`/`reflection`, so they ride the existing retrieval/eviction/supersession machinery (reconcile-on-write prevents duplicate spam). Optional "[Story so far]" injection below the scene card, hard-capped. New settings: `reflectionEnabled` (default on), `reflectionInterval` (default 12, clamped 4–100), `reflectionInject`, `reflectionMaxTokens` (default 200), `reflectionPrompt` — toggle + interval slider + inject toggle + live read-only view + prompt editor in the Agent 3 tab. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

**Middle-ground retrieval — a 3-layer cascade, no embeddings, no extra API calls.** Replaces the rejected vector approach (browser-only / mobile cost / storage bloat / loss of bounded predictability; and Agent 1 already provides the semantic step). Solves the synonym/paraphrase brittleness of pure keyword matching (e.g. a fact stored under one label not matching a later paraphrase or descriptor for the same subject):
- **Layer A — aliases-at-write.** New optional `aliases: string[]` on the fact schema. Agent 3 optionally emits nicknames/descriptors via an `aka:` segment; `searchFacts` folds them into the match text (MATCH-ONLY — never shown to the writer, mirroring `context`); `upsertFact` unions+dedupes aliases across re-mentions. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js))
- **Layer B — local fuzzy fallback.** New `trigramSimilarity()` (char-trigram Jaccard, zero deps); when a needed-info entry yields no primary hit, token-level fuzzy match against each active fact's `key value tags aliases` admits matches ≥ `FUZZY_THRESHOLD` (0.4) as secondary (bounded by the existing cap). Catches typos/morphology (apartments→apartment, <NAME>s→<NAME>). Deterministic. ([src/fact-retrieval.js](src/fact-retrieval.js))
- **Layer C — caged Agent-1 rerank.** `DEFAULT_DRAFT_PROMPT` tightened to "pick from the menu first" — Agent 1 prefers exact `Category/key` from the inventory for current-moment subjects INCLUDING paraphrases the lexical layers can't bridge; `resolveExactKeys` hardened (whitespace/punctuation-tolerant, validated against the inventory so hallucinated keys are silently dropped). ([src/agent-draft.js](src/agent-draft.js), [src/fact-retrieval.js](src/fact-retrieval.js))

Integration order in `retrieveFacts`: exact-key picks → primary; keyword+alias → primary/secondary; fuzzy fallback → secondary (uncovered needed-info only). Existing tier caps, salience ranking, sequence/track expansion, supersession + knownBy filtering all run unchanged afterward.

## [0.14.0] - 2026-05-23

### Added — temporal validity / supersession (memory-research Phase 3)
When a CHANGEABLE-STATE fact's value genuinely changes, the OLD value is now marked SUPERSEDED (retained as history) rather than silently overwritten — so retrieval surfaces only what's currently true while the timeline stays truthful. Backward-compatible: facts without the new fields behave exactly as before (treated as currently valid).

**Validity representation.** Facts gain optional `active` (absent/`true` => currently valid), plus `supersededAt` (ms, doubles as validTo) and `supersededBy` (history breadcrumb) on the inactive snapshot. `isActiveFact()` is the single filter ([src/database.js](src/database.js)). Chosen for simplicity: retrieval just checks `active !== false`.

**Write path — lightweight, capped.** `upsertFact` now snapshots the OLD value as a retained-but-inactive copy (under a distinct `__was` key so reconcile-on-write never collapses onto it) and advances the canonical fact in place to the new ACTIVE value. Gated by `shouldSupersede`: triggers only for a CHANGEABLE-STATE existing fact (`kind:state`) whose value MATERIALLY changed, or on an explicit Agent-3 signal — durable traits (name/age) keep today's silent in-place correction (a typo fix is not a supersession). Only the SINGLE most-recent snapshot per logical key is retained (older ones pruned) so it never blows the 50-fact cap; track/sequence facts remain append-only and are untouched. ([src/database.js](src/database.js))

**Extraction — optional `~` marker.** Agent 3 may append `| ~` to mark a write as replacing the prior value of a changeable-state fact. Optional: if omitted, supersession is inferred from changed `kind:state`. New grammar marker doesn't collide with `|/@/#/rel:/@src:/>/track:/!N/kind:`. Prompt + the relocation example updated minimally. ([src/agent-memory.js](src/agent-memory.js))

**Retrieval — current-only by default.** `searchFacts`, the relationship-expansion pass, `resolveExactKeys`, the Agent 1 key inventory (`summarizeKeys`), and Agent 3's existing-DB summary all skip superseded facts, so only currently-valid facts are injected/listed. History is retained on disk (and dovetails with the track/diary feature). ([src/database.js](src/database.js), [src/fact-retrieval.js](src/fact-retrieval.js), [src/agent-memory.js](src/agent-memory.js))

**Eviction — history compresses first.** Superseded facts get the lowest salience score (≈ -1, with a tiny recency tiebreak) in `saveDatabase`, so they are the FIRST evicted under the cap — track-step protection unchanged. ([src/database.js](src/database.js))

## [0.13.0] - 2026-05-23

### Added — always-on scene card (live core working memory)
A tiny, always-injected block telling the writer WHAT IS TRUE RIGHT NOW (MemGPT core-context idea) — so Agent 2 always has the present moment, not just a bag of facts. Backward-compatible: absent scene state behaves as no scene card.

**State model.** A single small per-chat object in `chat_metadata.bf_mem_scene`: `{ location, present[], goals[], beats[], updatedAt, runId }`. Shape-checked reload helpers `getScene` / `setScene` / `reloadSceneFromChat` ([src/settings.js](src/settings.js)) mirror the existing `bf_mem_*` pattern (tokens/log/facts) and reload on CHAT_CHANGED so it survives reload and is per-chat scoped. Beats are a rolling window of the last 3 (append newest, drop oldest, de-dupe immediate repeat).

**Update path — NO new LLM call.** Folded into Agent 1 (the draft planner, which already runs every pipeline turn and reasons about the current scene). Agent 1's output grammar gains an optional `#Scene` block (Location / Present / Goals / Beat); `parseSceneBlock` extracts it without breaking the existing `#Draft` / `#Needed_Facts` outputs (the Needed_Facts capture is now bounded before `#Scene`). pipeline.js persists it via `setScene` each run, guarded by the same not-cancelled + character-didn't-change checks as Agent 3 writes. ([src/agent-draft.js](src/agent-draft.js), [src/pipeline.js](src/pipeline.js))

**Injection — always, hard-capped.** `buildSceneBlock` ([src/agent-writer.js](src/agent-writer.js)) renders one compact line `[Scene] Location: … | Present: … | Goal: … | Recently: …`, hard-capped (~150 tokens, defensive char-budget truncation with ellipsis). `buildWriterInjection` prepends it ABOVE the fact list in the single combined injected system message. Injected EVERY turn the pipeline runs (and re-injected on swipe/regen via the cached injection) whenever enabled and a scene exists — regardless of whether facts were retrieved. Not injected when the pipeline is disabled/skipped/cancelled.

**Settings + UI.** New `sceneCardEnabled` (default true) + `sceneCardMaxTokens` (default 150, clamped 30–400) in DEFAULT_SETTINGS + `validateSettings`. Toggle `bf_mem_scene_enabled` and a read-only live scene view (`bf_mem_scene_view`) added to the Agent 1 tab. ([src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

## [0.12.0] - 2026-05-23

### Added — smarter retrieval, fact context, and an ordered "diary"
Four workflow upgrades, each independently shippable and backward-compatible (older facts/settings load unchanged; absent new fields behave as before).

**Agent 1 stops guessing — fact key inventory.** Agent 1 previously got only the chat + character cards and free-associated keywords, so retrieval was blind to what facts actually existed. New `summarizeKeys()` ([src/database.js](src/database.js)) builds a compact `Category/key` inventory (keys only, no values) that is injected into Agent 1's prompt; Agent 1 now requests EXACT existing keys, and retrieval resolves `Category/key` requests by identity (`resolveExactKeys` in [src/fact-retrieval.js](src/fact-retrieval.js)) in addition to the existing fuzzy/keyword path. ([src/agent-draft.js](src/agent-draft.js), [src/pipeline.js](src/pipeline.js))

**Deterministic retrieval — no more random fact-dropping.** Removed the `Math.random()` gate that probabilistically dropped correctly-retrieved secondary/tertiary facts before injection (the real cause of "the writer skips facts"). Inclusion is now deterministic: all primary, then secondary up to `MAX_SECONDARY` (12), then tertiary up to `MAX_TERTIARY` (6) — token budget still bounded, behavior predictable. The legacy `secondaryChance`/`tertiaryChance` settings are retained for compatibility but no longer gate anything (sliders inert, marked deprecated; UI removal later). ([src/fact-retrieval.js](src/fact-retrieval.js))

**Writer sees the key + a stronger instruction.** `formatFactsForWriter` now emits `[knownBy] Category/key = value` (the key was previously dropped, so the writer couldn't tell similar facts apart). `DEFAULT_WRITER_FORMAT` rewritten to instruct the writer to actively USE facts as established truth and weave them in, not merely "don't contradict." ([src/agent-writer.js](src/agent-writer.js), [src/pipeline.js](src/pipeline.js))

**Optional CONTEXT note on facts.** New optional `context` field stores the prose around a fact (e.g. a strategic admission: the bare value plus the note that another character baited it). Agent 3 emits it via a `>`-prefixed segment and attaches it only when the surrounding situation changes the fact's meaning. Context is EXCLUDED from keyword matching and injected for PRIMARY-tier facts only (`Category/key = value — <context>`) to bound tokens. ([src/database.js](src/database.js), [src/agent-memory.js](src/agent-memory.js), [src/fact-retrieval.js](src/fact-retrieval.js))

**Linked "diary" (ordered event log) + depth-dice retrieval.** Sequences (e.g. a character's location over time) are now first-class instead of being overwritten:
- Facts gain optional `track` (timeline name) + `ord` (monotonic step). Each step is its OWN fact, **exempt from the reconcile-on-write collapse** that previously overwrote the chain. `ord` is auto-assigned at write time (`nextOrdForTrack`), so the model doesn't have to count. A separate single overwriting current-state fact keeps "where are they now" atomic. ([src/database.js](src/database.js): `isSequenceFact`, `getTrackSteps`, `nextOrdForTrack`)
- Eviction keeps the latest N steps PER track (round-robin trim of lowest `ord`, never below 1/track) so the 50-fact cap can't punch holes mid-chain or wipe a track. Non-sequence facts evict first.
- Retrieval (`expandSequenceTracks` in [src/fact-retrieval.js](src/fact-retrieval.js)): when a track is relevant, ALWAYS include the current step, then roll each depth tier; the reach = furthest successful roll; include every step from current back to that reach CONTIGUOUSLY (continuity guaranteed by a contiguous slice — no gaps). Default probabilities depth1–4 = 70/50/25/10%, exposed as **sliders** in the Agent 2 retrieval tab (`bf_mem_depth1..4`). ([src/settings.js](src/settings.js), [templates/settings.html](templates/settings.html))

## [0.11.0] - 2026-05-23

### Fixed — 10 issues surfaced by a long real-session bug report
Each issue was diagnosed by an independent investigation pass, then fixed.

**Reliability**
- **Agent 3 silently stopped mid-session.** The trigger gate relied on a monotonic `lastTriggeredUserMsgIndex` that never rewound on swipe/Stop, so once it got ahead it permanently skipped every later turn. Now gated on the per-message `bf_mem_processed` flag (source of truth), with a shared `findMemoryTargetIndex()` and a new `MESSAGE_SWIPED` handler that rewinds indices and clears the stale flag. ([src/pipeline.js](src/pipeline.js))
- **Sticky cancel flag.** `pipelineCancelled` is now reset on `MESSAGE_RECEIVED`, so a Stop on one turn can't poison later turns.
- **Token counter desync.** `setRunTokens` (input) only ran on the happy path while `setMainOutputTokens` (output) fired on every reply incl. swipes. Token recording now runs even on the cancelled/early-return path (wrapped in try/catch via `recordRunTokens`), and output is gated on a per-cycle `runRecordedInput` flag. `setRunTokens`/`setMainOutputTokens` are hardened against NaN and skip empty runs. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))

**Memory quality**
- **Source attribution off-by-one.** Facts were stamped with the AI message index even when disclosed in the user turn. Added an optional `@src:user|char` tag to the Agent 3 grammar; user-sourced facts now attribute to the user message index, char/untagged to the AI target. Live and backfill/icon paths now index identically (backward-compatible when the tag is absent). ([src/agent-memory.js](src/agent-memory.js), [src/pipeline.js](src/pipeline.js))
- **Missed / contradictory facts.** (a) Agent 3 context window default raised 2 → 5 so long single-message backstory reveals fit. (b) Memory prompt's omission bias relaxed — higher cap on dense turns, short clauses allowed for genuine backstory, "skip when uncertain" softened to capture clearly-stated reveals. (c) `upsertFact` now reconciles on write: on exact-key miss it conservatively matches a normalized-key variant and updates in place instead of minting a parallel contradictory key. ([src/settings.js](src/settings.js), [src/agent-memory.js](src/agent-memory.js), [src/database.js](src/database.js))
- **Silent fact eviction.** `MAX_FACTS_PER_DB` (50) eviction was dropping facts with only a `console.warn`, so late-session facts vanished from exports with no trace. Eviction now logs to the debug panel (count + category + keys). Cap value unchanged — raising it is a deliberate token-cost decision. ([src/database.js](src/database.js))

**UI / reporting**
- **"Last Generated" == "Last Inserted".** Both panels were fed the same proposed array. `applyUpdates` now classifies each write NEW/UPDATED/SKIPPED and returns the committed subset (`.applied`); Last Generated keeps the full proposed set, Last Inserted shows only what actually changed. ([src/agent-memory.js](src/agent-memory.js), [src/pipeline.js](src/pipeline.js))
- **Backfill didn't populate "Last Generated."** `runAgent3OnFullChat` now accumulates per-message results and calls `setLastGenerated`/`setLastInserted` at the end. ([src/settings.js](src/settings.js))
- **Debug log didn't survive reload.** `chat_metadata.bf_mem_log` was saved via the debounced `saveMetadata`, so rapid entries superseded each other and only ~2 reached disk. Added a guaranteed synchronous flush on `beforeunload` (`flushDebugLogNow`) plus a throttled immediate chat save (≤ once / 5s). ([src/settings.js](src/settings.js))
- **Incomplete debug log.** Added a consolidated per-run SUMMARY entry (runId, duration, Agent 1 ok/failed, Agent 3 NEW/UPDATED/SKIPPED, full token breakdown). Enable/disable state changes are now logged (incl. the corrupt-settings reset and validation coercion that could silently flip `enabled` off). `MAX_DEBUG_ENTRIES` raised 200 → 500. ([src/pipeline.js](src/pipeline.js), [src/settings.js](src/settings.js))

**Cost**
- **Full-chat backfill API cost.** Confirmed `skipAlreadyProcessed` defaults ON and short-circuits *before* the LLM call; added a trivially-empty-message pre-filter (empty/whitespace, < 15 visible chars, pure-OOC) so no call is spent on zero-fact messages; the confirm dialog now shows an estimate of how many LLM calls the run will make. (True multi-message batching deferred — it would change the Agent 3 output contract.) ([src/settings.js](src/settings.js))

## [0.10.0] - 2026-05-17

### Changed — settings reorganized into per-agent tabs
The old type-grouped tabs ("Pipeline" + "Prompts") split a single agent's settings across multiple places. Now each agent has ONE tab with everything for it:

- **Agent 1** tab: its connection profile · its context-messages slider · its draft-planner prompt (+ reset)
- **Agent 2** tab: a note that it's the main model (no separate profile) · its context-limit/trim slider · fact-retrieval %s (they feed the writer's injection) · the Writer Injection Format template (+ reset)
- **Agent 3** tab: its connection profile · its context-messages slider · review-interval slider · its memory-updater prompt (+ reset)
- **General** tab: "use separate profiles" master toggle · show-toast toggle
- Data tabs unchanged: Database · Last Generated · Last Inserted · Tokens · Debug
- Enable toggle stays in the always-visible status bar

Every element id was preserved, so all existing handlers/persistence keep working — purely a layout move. The generic `setupTabs()` auto-wires the new tabs.

### Removed
- Dead `#bf_mem_profile_section` toggle calls in settings.js (the wrapper no longer exists; the `useMemoryProfile` flag still gates whether agents use their profiles, via `getAgent1ProfileId` / `getAgent3ProfileId`).

## [0.9.0] - 2026-05-17

### Added — token comparison
- **New "Tokens" tab** showing a side-by-side comparison of token cost, split INPUT vs OUTPUT:
  - **Baseline** — what the full chat would have cost the main model (no extension)
  - **With extension** — main model (trimmed chat + facts) + Agent 1 (Draft) + Agent 3 (Memory), each broken out
  - **NET vs baseline** — input saved (green) or spent (red), output overhead from agents (amber)
  - **Last Run** + **This Session** (running totals) views, with a session-reset button
- **Honesty banner:** if Agent 2 trim is OFF (actual main input ≈ baseline within 3%), the panel says plainly that there are no input savings and the agent calls are pure overhead — pointing you to the Agent 2 Context Limit slider. The NET-input figure turns red (not green) when the extension costs more than it saves, so it can't be misread as a win.

### How tokens are measured
- Uses ST's local tokenizer (`getTokenCountAsync` / `countTokensOpenAIAsync`). Provider usage isn't exposed to extensions, so counts are **approximate** (exact for OpenAI/Llama, estimated for Claude). The DELTA is what matters and both sides use the same tokenizer, so the comparison is meaningful. UI labels it "approx."
- Captured in [src/pipeline.js](src/pipeline.js): baseline counted before trim, actual counted after trim+inject. Agent counts threaded out via new `tokensIn`/`tokensOut` fields on the Draft/Memory result objects. Main reply counted on `MESSAGE_RECEIVED`.
- Persisted in `chat_metadata.bf_mem_tokens` (`{lastRun, session}`) — survives reload, per-chat scoped, auto-reloads on chat change.

### Internal
- [src/agent-draft.js](src/agent-draft.js) + [src/agent-memory.js](src/agent-memory.js): return `tokensIn`/`tokensOut` (0 on error path)
- [src/settings.js](src/settings.js): `setRunTokens()`, `setMainOutputTokens()`, `reloadTokensFromChat()`, `renderTokens()`, session-reset handler
- [src/pipeline.js](src/pipeline.js): `countChatTokens()` helper, baseline/actual capture around injection, MESSAGE_RECEIVED main-output capture
- New tab auto-wired by the generic `setupTabs()` (no hardcoded tab list)

## [0.8.0] - 2026-05-17

### Added — backfill + per-message tracking
- **"Run Agent 3 on full chat" button** in the Database tab. For when you installed the extension after a chat was already going — extracts facts from every existing message sequentially.
  - Skip-already-processed checkbox (default on) so re-running only hits new messages
  - Live progress: "Message X/N · Y facts added"
  - Cancel button to abort mid-run
  - Per-message LLM token cost — warning confirm before starting
- **Per-message brain icon** next to each message's edit button (inspired by MemoryBooks extension).
  - 🧠 **Grey** = Agent 3 has NOT processed this message yet
  - 🧠 **Green** = already processed
  - 🧠 **Blue (pulsing)** = currently running
  - **Click** = force Agent 3 to extract from this specific message (useful if you edited a message and want to re-extract, or if a specific message has facts the normal pipeline missed)
  - **Editing a message** automatically resets its flag to grey (prior extraction invalidated)

### Shared state convention
- New per-message flag `message.extra.bf_mem_processed = true` (persisted natively by ST in chat .jsonl)
- Set automatically:
  - In the normal pipeline after Agent 3 happy path (both AI target and the user message Agent 3 also saw)
  - By the full-chat backfill worker
  - By the per-message icon click handler
- Cleared automatically:
  - When a message is edited (the existing extraction is invalidated)
- Hidden from system/comment/narrator messages — only real chat messages get the icon

### Internal
- New module: [src/message-icon.js](src/message-icon.js) — self-contained, listens to `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED` / `MESSAGE_UPDATED` / `CHAT_CHANGED`, idempotent re-inject
- New export: `runAgent3OnFullChat({skipAlreadyProcessed, onProgress, shouldCancel})` in [src/settings.js](src/settings.js)
- [src/pipeline.js](src/pipeline.js) now stamps `extra.bf_mem_processed = true` on both the AI target message and the user message after each successful Agent 3 run
- [index.js](index.js) wires `initMessageIcons()` alongside `initSettings()` and `initPipeline()`
- [style.css](style.css) — grey → green → blue (pulse) state transitions for the icon

## [0.7.3] - 2026-05-17

### Docs
- **Added [README.md](README.md)** with a full walkthrough of how the 3 agents work — uses a fake 10-message chat (<NAME> + <CHAR>) and shows exactly what each agent sees, what it outputs, and where the Agent 2 trim kicks in. Includes:
  - Step-by-step trace of one generation cycle
  - Agent reference table (LLM call? what it sees? output?)
  - Full settings reference
  - Tradeoff table for tuning sliders
  - Starter config for "facts replace history" mode

No code changes — docs only. Manifest version bumped so the in-UI version label confirms the new docs are pulled.

## [0.7.2] - 2026-05-17

### Changed — Agent 2 slider now actually does what was wanted
v0.7.1's "Agent 2 Context Messages" slider was implemented in the WRONG direction — it duplicated the last N messages INTO the injection (force-attention), which was mostly wasteful since the main model already sees full chat history via ST.

The user wanted the OPPOSITE: **hide old messages from the main model** so it focuses only on the recent exchange + the facts we inject. This makes the facts actually *replace* the hidden chat history (the intended architecture for a memory pipeline).

- **Label changed:** "Agent 2 Context Limit (trim chat)"
- **Range:** 0–50 (was 0–20)
- **Behavior when > 0:** before injection, the chat history sent to the main model gets trimmed in-place to the last N user/AI messages. System prefix (character card, system prompt) preserved. Reversible — change slider back to 0 to restore full history.
- **Tradeoff:** cleaner focus, lower token cost — but the stored facts have to be good enough to replace the hidden history. If your facts are sparse, the model will feel amnesiac.

### Removed
- `{context}` placeholder support in Writer Format (added speculatively in v0.7.1, no longer needed since we don't duplicate chat into the injection).
- `contextBlock` parameter in `buildWriterInjection()`.

### Internal
- New `trimChatHistory(messages, keepLast)` helper in [src/agent-writer.js](src/agent-writer.js) — preserves system prefix, splices oldest user/AI messages.
- [src/agent-writer.js](src/agent-writer.js) `injectMemoryContext()` now accepts `options.trimToLast`.
- [src/pipeline.js](src/pipeline.js) reads `settings.agent2ContextMessages`, passes as `{trimToLast: N}` to `injectMemoryContext()`.

## [0.7.1] - 2026-05-17

### Added
- **Agent 2 (Writer) context-messages slider** for symmetry with Agent 1 / Agent 3 controls. Default 0 = off (current behavior).
  - **What it does when > 0:** duplicates the last N chat messages into the injection block (as `[USER]` / `[CHAR]` tagged lines).
  - **Why it's usually unnecessary:** the main model (Agent 2) already sees full chat history via ST's normal prompt assembly. This setting is for FORCING the model's attention onto recent exchanges when the chat is long.
  - Costs extra tokens (duplicates messages already in the prompt).
- New `{context}` placeholder support in the Writer Format template. If your custom template includes `{context}`, the chat block is substituted there. Otherwise it's auto-prepended.

### Internal
- [src/agent-writer.js](src/agent-writer.js) `buildWriterInjection()` gained an optional `contextBlock` parameter (3rd arg, default `''`). Backward-compatible: existing callers without the arg behave exactly as before.
- [src/pipeline.js](src/pipeline.js) gathers up to `agent2ContextMessages` last messages from chat and passes as the new param.

## [0.7.0] - 2026-05-17

### Added — per-agent configuration
- **Separate connection profile per agent.** Agent 1 (Draft) and Agent 3 (Memory Updater) can now run on DIFFERENT connection profiles instead of sharing one. Use cases:
  - A cheap fast model for Agent 3 extraction (Deepseek), a stronger reasoning model for Agent 1 drafting (Sonnet).
  - Each agent tunable independently for cost/quality trade-offs.
  - Writer (Agent 2) still always uses your default/active profile.
  - Leave either dropdown blank → uses default profile for that agent.
- **Separate context-message count per agent.** Agent 1 and Agent 3 can each have their own window:
  - **Agent 1 (Draft):** slider 1–50, default 5 (how many recent messages to plan the reply from)
  - **Agent 3 (Memory):** slider 1–20, default 2 (default 2 = current behavior: just the latest user msg + AI msg. Higher = more context for better extraction at higher token cost.)

### Migration
- Existing `memoryProfile` (single shared profile) → copied to BOTH `agent1Profile` AND `agent3Profile` on first load. Old key preserved for rollback safety.
- Existing `contextMessages` (single shared count) → copied to `agent1ContextMessages` if the user had changed it from default. Old key preserved.
- Schema version unchanged — additive migration only.

### Internal
- New exports in [src/profiler.js](src/profiler.js): `getAgent1ProfileId()`, `getAgent3ProfileId()`. Old `getMemoryProfileId()` kept as alias returning the Agent 1 profile.
- [src/agent-memory.js](src/agent-memory.js) `runMemoryUpdater()` last param renamed `prevUserMessage → priorMessages` (now an array of `{role, text}` for richer Agent 3 context). Backward-compatible: default empty array = no extra context, same as before.
- [src/pipeline.js](src/pipeline.js) now gathers up to `agent3ContextMessages` prior messages from chat (excluding the target itself), tags them USER/CHAR, passes as array.

## [0.6.0] - 2026-05-17

### Fixed (HIGH — mobile UX)
- **Review popup no longer hides above the screen on mobile.** Root cause: the overlay flex-centered vertically against `100%` of the layout viewport (full screen height, unchanged when Android soft keyboard opens). The 80vh popup was pushed off-screen with no scroll recovery.
- New behavior:
  - Overlay anchors to TOP (`align-items: flex-start`) on mobile, with `padding: env(safe-area-inset-top)`. Vertical centering restored ONLY on desktop via `@media (hover: hover) and (min-height: 700px)`.
  - JS-set `--bf-mem-vv-h` CSS var tracks `window.visualViewport.height` so the popup never grows taller than the keyboard-free area. Listens to `visualViewport` resize/scroll + `orientationchange`.
  - Popup max-height now `var(--bf-mem-vv-h, min(80dvh, 80vh))` — uses dynamic viewport units that shrink with iOS keyboards as fallback.
  - On open: first editable field gets `.focus()` + `scrollIntoView({block:'center'})` so mobile users see it immediately.
  - Backdrop click now dismisses the popup (previously only Accept/Save/Dismiss buttons could close it — useless if they scrolled off-screen on a tall popup).
  - Centralized `cleanup()` removes all listeners on every dismiss path (no leak).

### Changed (UI restructure)
- **Replaced the "Summary" tab with TWO new tabs: "Last Generated" and "Last Inserted".**
  - **Last Generated** shows every fact Agent 3 PROPOSED in the most recent pipeline run (raw output, before any guard).
  - **Last Inserted** shows the subset that ACTUALLY landed in the database, with status badge: `NEW` / `UPDATED` / `SKIPPED` (skipped = pipeline cancelled or char switched mid-run).
  - Both tabs persist in `chat_metadata` (per-chat) so they survive page reload — same pattern as the debug log + review counter.
  - Auto-refresh on `CHAT_CHANGED` so each chat shows its own facts (not stale cross-chat data).
  - Review popup edits append to the "Last Inserted" view in real time.
- Deleted: `lastPipelineSummary`, `updatePipelineSummary()`, `renderSummary()`, `formatInline()` (all summary-tab plumbing).
- Added: `setLastGenerated()`, `setLastInserted()`, `appendLastInserted()`, `reloadFactsFromChat()`, `renderFactList()` (exports + helpers in settings.js).
- Added: `update.wasNew = isNew` in `agent-memory.js applyUpdates()` so pipeline.js can surface NEW vs UPDATED badges per fact.

### Internal
- Designed by 2 parallel research agents (mobile-popup-fix + tab-redesign-spec). Applied by 2 sequential patch agents (popup + tabs).

## [0.5.1] - 2026-05-17

### Changed (HIGH impact — Agent 3 extraction quality)
- **DEFAULT_MEMORY_PROMPT rewritten for atomic facts.** The previous prompt produced prose values like `"<character> owns <item>, stored in <container>, knows <ability>"` — a single bloated fact mashing 3 properties together. A real transcript test showed only 8 facts stored from a rich 14-message scene when ~25–30 atomic facts should have been captured.
- The new prompt locks the model into **1–5 word values, one property per fact**. Adds a STRICT format block, a WRONG→RIGHT splitting demo, a DO NOT STORE list (negative facts, transient emotions, atmosphere, generic biology, items-momentarily-in-hand), and 6 generic placeholder-based few-shot examples (no real names/locations to bias extraction).
- Expected outcome: ~3× more retrievable facts per scene at roughly the SAME token cost (atomic values are shorter than prose).

### Added
- **Persistent debug logs.** The debug log is now stored in `chat_metadata.bf_mem_log` (same pattern as the review counter). Logs survive page reload. On chat-change → log view reloads from the new chat's metadata. Cap remains 200 entries per chat. "Clear Log" button clears the persistent copy too.
  - New helpers: `loadDebugLogFromMeta()`, `saveDebugLogToMeta()`, `reloadDebugLogFromChat()` (exported)
  - Shape-checked on load — malformed entries silently dropped
  - `addDebugLog()` writes to chat_metadata on every entry

### Internal
- Synthesized from 3 parallel research agents: atomic-format-rules / few-shot-examples-designer / anti-patterns-and-negative-examples.

## [0.5.0] - 2026-05-17

### Fixed (10 issues surfaced by persona-based research — Test Suite v3.3)

#### Pipeline / state (HIGH)
- **`/cut` now also resets `lastProcessedMessageIndex`** (not just `lastTriggeredUserMsgIndex` as in v0.4.0). Previously, after a `/cut`, Agent 3 thought it had already processed indices that no longer existed and silently skipped new AI replies. ([src/pipeline.js](src/pipeline.js) MESSAGE_DELETED handler.)
- **Pipeline now skips quiet/impersonate/continue generations.** Quick Reply scripts that call `/gen`, the Impersonate button, and `/continue` previously burned billable Agent 1 + Agent 3 LLM calls per invocation. Added filters for `data.quiet`, `data.type === 'quiet'`, `'impersonate'`, `'continue'`. ([src/pipeline.js](src/pipeline.js) `shouldRunPipeline`.)
- **Character card truncation bumped from 500/300/300 → 2000/1000/1000 chars** (description / personality / scenario). Serious roleplay cards have critical lore in the back half. Prior limits caused Agent 1 to plan replies that contradicted established lore. ([src/pipeline.js](src/pipeline.js) `getCharacterInfo`.)

#### Network resilience (HIGH)
- **LLM_TIMEOUT_MS bumped from 30s → 60s** for mobile network tolerance. Mobile users on 4G/5G or edge-of-WiFi routinely hit cold-OpenRouter routes that take 20–40s. ([src/llm-call.js](src/llm-call.js))
- **`callAgentLLM` now retries on network errors**, not just empty responses. Mobile users hit `ERR_NETWORK_CHANGED` mid-call on WiFi↔cellular switches. Each attempt wrapped in try/catch; both empty and thrown errors trigger one retry. ([src/llm-call.js](src/llm-call.js))

#### Agent 3 prompt quality (HIGH)
- **Transient asterisk actions no longer extracted as facts.** `*she smiled*`, `*nods*`, `*brushes hair*` etc. are now explicitly negative-listed in the Agent 3 prompt for BOTH `{{user}}` AND `{{char}}`. Only lasting reveals like `*revealing a scar from childhood*` get extracted.
- **OOC brackets `[OOC: ...]` no longer extracted.** `[OOC: my real name is X]` is meta-commentary, not in-character disclosure. Three new few-shot examples added to demonstrate.
- **Quoted historical text not re-extracted.** When user types `Remember when you said "X"?`, the quoted X isn't extracted as a fresh disclosure.

#### Mobile UX (MED→HIGH)
- **5-tab strip now wraps + scrolls horizontally on narrow viewports** (360px phones with accessibility zoom). Added `flex-wrap: wrap` + `overflow-x: auto` + 36px min touch target to `.bf-mem-tab`. ([style.css](style.css))
- **Pull-to-refresh disabled inside drawer scroll containers.** Mobile users could accidentally reload the page when scrolling up inside the DB list / debug log / review popup at the top of their scroll range, losing unsaved edits. `overscroll-behavior: contain` applied to all known scroll containers. ([style.css](style.css))
- **Copy Log fallback now uses a textarea overlay** instead of `prompt()`. The native `prompt()` truncates long text and lacks select-all on mobile. New overlay has Select All / Close buttons and is long-press friendly. ([src/settings.js](src/settings.js))

### Test Suite v3.3 (139 checks, tiered)
Bumped from v3.2 (94 checks) after deep research by 3 persona agents: Heavy Roleplayer (15 UX gaps), ST Power User (14 integration gaps), Mobile-Termux User (15 mobile gaps). Total 44 new test cases distributed across Tier 1 (smoke +10 = 23), Tier 2 (integration +22 = 58), Tier 3 (behavioral +12 = 57).

### Known limitations / future work
- No native mobile-themed dialog for `prompt()`/`confirm()` (DB profile save, delete, etc.). Native Chrome dialogs work but look out-of-place.
- Author's Note / Vector Storage / built-in Summarize co-injection still order-dependent at depth=1. Future: expose `injectionDepth` setting + use `setExtensionPrompt`.
- Plot-twist updates still create duplicate keys instead of overwriting (e.g., `char_species = human` + new `char_vampire_reveal`). Future: prompt-side instruction to prefer overwrites.
- The 5-message context window for Agent 1 is too short for long-arc narrative awareness. Future: per-character override.

## [0.4.1] - 2026-05-17

### Fixed (caught by Tier 1 v3.2)
- **`getMeta()` now shape-checks `chatMetadata.bf_mem_review` before use**: previously the guard was `if (!md[META_KEY])`, which treats a corrupted string value as truthy and skips reinitialization. The subsequent `.push()` on a non-array would throw `TypeError: Cannot read properties of undefined (reading 'push')`. Now validates: object, not array, with `pendingReviewItems: Array` and `messagesSinceLastReview: number`. Otherwise reinitializes to the empty shape.

## [0.4.0] - 2026-05-17

### Fixed (8 critical issues surfaced by Test Suite v3.2 research)

#### HIGH — write integrity / no-data-loss
- **Stop button now actually stops Agent 3 writes**: previously, when the user clicked Stop, in-flight Agent 1/Agent 3 CMRS calls finished and wrote to the DB anyway. Now a `pipelineCancelled` flag is set on `GENERATION_STOPPED`; checked before Agent 3's `trackUpdate`/`saveCurrentToActiveProfile` and before the injection step. CMRS calls themselves can't be aborted (no AbortSignal exposed by ST), but their results are discarded.
- **Character-switch mid-pipeline no longer contaminates the new character**: the v0.3.0 capture-at-write fix protected the profile-snapshot layer; v0.4.0 adds the deeper-layer guard. `capturedCharAvatar` is captured at pipeline start; if the live avatar differs when Agent 3 returns, the writes are discarded with a toast warning.
- **`/cut` no longer breaks the pipeline**: previously, deleting a message left `lastTriggeredUserMsgIndex` stale, so the next genuine user message (re-using the deleted index) got silently skipped by the "already triggered" guard. Added a `MESSAGE_DELETED` listener that recomputes the index.
- **Group chats now skip the pipeline cleanly**: previously, the pipeline ran with `characterId` = active speaker (not addressee), causing fact cross-contamination between group members. Now detects `ctx.groupId || ctx.selected_group` and short-circuits with a show-once toast: "BF Memory: group chats not supported — memory pipeline disabled for this chat."
- **`is_system` / extension-injected messages excluded from Agent 3**: previously, the memoryTargetIndex walkback grabbed any non-user message, including synthetic system messages injected by other extensions (Auto-Summarize, Tracker, etc.), polluting our DB with second-order data. Now skips `msg.is_system` and `msg.extra?.type`.
- **MAX_FACTS_PER_DB now uses LRU eviction** instead of FIFO: when a database exceeds 50 facts, the **least-recently-updated** facts are evicted (not the oldest-by-insertion-order). Foundational identity facts that get reinforced by `upsertFact` survive; throwaway tertiary facts get pruned. Prevents losing `user_name` after long campaigns.

#### MED→HIGH — UX correctness
- **Review popup no longer fires for the wrong chat**: previously, the `setTimeout(..., 2000)` for the deferred popup could fire after the user switched chats, popping in chat B while the user was in chat C. Now captures `chatId` at schedule time and aborts the popup if it changed.
- **First message after chat-open is no longer silently dropped**: the 5-second cooldown previously blocked ALL pipeline runs in that window, including legitimate first sends. Now the cooldown only blocks when there's NO new user message (spurious chat-load events); genuine new user messages always fire.

### Test Suite v3.2 (94 checks, tiered)
Bumped from v3.1 (58 checks) after deep research by 3 agents (Detailed code analysis + Contrarian breakage modes + Edge case enumeration). New coverage includes group chat behavior, Stop-button cancellation, /cut handling, char-switch races, MAX_FACTS eviction, /sendas filtering, /preset switching, parser injection, knownBy filter, internationalization, cache invalidation, profile-delete races, etc.

### Internal
- New module-scope flags: `pipelineCancelled`, `groupSkipToastShown` (resets on CHAT_CHANGED).
- New listener: `MESSAGE_DELETED`.
- Nesting depth in Agent 3 result handler is now 5 levels deep — readable but a future refactor candidate.

### Known limitations
- Cancellation flag is module-scope; theoretical race if two pipelines could overlap. In practice prevented by `isInternalCall` and index guards.
- Group chat support is a future enhancement (v0.5+). Today the pipeline skips groups with a toast.
- Facts without a `lastUpdated` field (legacy pre-v0.2.0 data) get sorted as `lastUpdated=0` by the LRU comparator and are evicted first.

## [0.3.2] - 2026-05-17

### Fixed (HIGH — caught by Tier 1 smoke test)
- **Pipeline no longer aborts when Agent 1 (Draft) returns empty**: previously, if Deepseek returned an empty completion for the draft agent, `pipeline.js` did an early `return` and the writer never injected facts into the prompt. The user got a plain AI response with no memory context. Now: Agent 1 failure logs a warning but the pipeline continues with `draft = ''`, so the retrieved facts still reach the writer (memory > nothing). The user-facing impact: even when the draft LLM hiccups, your character still sees the established facts.
- **One-shot retry on empty LLM completion in `callAgentLLM`**: providers (especially Deepseek) intermittently return empty bodies. We now retry once before giving up. Empty responses from Agent 1 / Agent 3 should be substantially rarer.

## [0.3.1] - 2026-05-17

### Added
- **Version label in extension header**: the drawer title "BF's Memory Pipeline" now displays the installed version (`v0.3.1`) next to the name, fetched live from `manifest.json` (single source of truth). Lets testers/users instantly verify which version is loaded — critical for catching stale browser caches where a patched file on disk hasn't replaced the in-memory copy.

## [0.3.0] - 2026-05-17

### Fixed (HIGH — behavior bugs surfaced by test suite v2)
- **Cross-profile data leak on character switch**: `autoSaveDbProfile()` previously snapshotted in-memory databases into the active profile slot on `CHAT_CHANGED`. By flush time, ST had already advanced state, so e.g. one character's facts could end up in another character's profile. Fix: removed the unsafe save-on-switch entirely; persistence now happens via capture-at-write in `saveCurrentToActiveProfile(profileKey)`, with the profile key captured at pipeline start (`src/pipeline.js`). Also added an integrity guard that refuses writes to deleted profiles and surfaces a toast. Removed a second residual `MESSAGE_RECEIVED → saveCurrentToActiveProfile()` handler that had the same leak class.
- **Agent 3 ignored USER facts**: messages like "I am <NAME>, I work at <ORG> in <CITY>" produced 0 stored facts because Agent 3 ran only on the N-1 AI message. Fix: Agent 3 now also sees the latest user message in the same call (combined `[USER:...] ... [CHAR:...]` block). The prompt has been rewritten to anchor on `{{user}}` / `{{char}}` macros (resolved via ST's `substituteParams`), with a CRITICAL clause for first-person disclosures and a new few-shot example for user-fact extraction. User persona description is also injected.

### Added (MED)
- **Relationships schema is no longer dead**: extended the Agent 3 output format with an optional `| rel:key1,key2` segment. The parser writes these into `fact.relationships.primary`, which the existing retrieval logic uses to expand fallback keywords. `upsertFact()` now MERGES (unions) relationships instead of replacing them, so prior tier links survive subsequent updates.
- **Review counter persists across page reload**: `messagesSinceLastReview` and `pendingReviewItems` now live in `chat_metadata.bf_mem_review` instead of module-scope JS, with an in-memory fallback that drains into chat metadata once a chat is opened. Counters are per-chat (correct behavior — reviewing facts about chat A shouldn't reset when you switch to chat B).
- **`knownBy` filtering enforced at code level**: `retrieveFacts()` now filters facts by current `{{char}}` / `{{user}}` name before formatting them into the injection. A fact tagged `knownBy: [<NAME>]` is no longer included when you chat with a different character.
- **Speculative retrieval stopword list extended**: added ~35 missing contractions (`ive, ill, youre, dont, isnt, hes, shes, theyre, cant, didnt, doesnt, thats, lets, im, ...`) so speculative keywords contain less noise (test G2 found ~40-50% noise rate pre-fix).

### Internal
- `runMemoryUpdater()` signature gained `isUserMessage`, `userPersona`, `prevUserMessage` parameters (all backward-compatible defaults).
- Renamed `lastAutoSavedChat` → `lastAutoLoadedChat` to match new semantics (the save logic is gone, it only deduplicates loads).
- `mergeRelationships()` helper added to `database.js` (set-union per tier).
- Code-reviewed by an independent reviewer agent after patch agents; 7 follow-up improvements applied including the two HIGH-severity items (residual MESSAGE_RECEIVED save + Agent 3 user-message targeting).

### Known limitations
- `relationships.secondary` and `tertiary` arrays are still always empty when written by Agent 3 (only `primary` is parsed). The retrieval tier expansion for secondary/tertiary will only work if these are populated by future schema work (e.g. structured outputs via `generateRaw({jsonSchema})`).
- In group chats, `knownBy` filtering uses only the current single `characterId`. Multi-character group filtering not yet implemented.
- The `{{user}}` macro in `knownBy` only matches if the model outputs the literal unresolved macro — defensive guard only.

## [0.2.1] - 2026-05-17

### Security
- **XSS fix**: `escapeHtml()` now escapes quote characters (`"` and `'`) in addition to `<`, `>`, `&`. The previous `textContent → innerHTML` trick failed to escape quotes, allowing attribute-context injection in the linked-chats popup (e.g. a crafted `chatId` could register event handlers via `data-chat="..."`). Affected: `src/settings.js`, `src/review-popup.js`.

### Fixed
- **No more brick on corrupt settings**: `initSettings()` now guards against the persisted settings blob being a non-object (null, array, string, primitive). On corruption, resets to defaults via `structuredClone(DEFAULT_SETTINGS)` and surfaces a toast warning instead of leaving the UI un-rendered.
- **`Save Current` preserves linked-chats array**: `saveDbProfile()` now spreads the existing profile before overwriting, matching the canonical pattern already used in `autoSaveDbProfile`. Previously, manually saving a profile dropped its `linkedChats` field.
- **Writer Format placeholders**: switched `.replace()` → single-pass regex `/\{(facts|draft)\}/g` so multiple `{facts}` / `{draft}` in the template all get substituted, and there's no order-dependent re-substitution if `factsText` contains the literal string `{draft}`.
- **Writer Format safety guard**: if `{facts}` or `{draft}` is missing from the template, the corresponding section is now appended at the end instead of silently dropped from the prompt.
- **Settings validation/clamping**: added `clamp()` + `validateSettings()`. Persisted garbage values (e.g. `contextMessages: -1`, `secondaryChance: 250`) are now coerced to valid ranges on load instead of showing labels like `-100%` and feeding bad slice counts to Agent 1.
- **Textareas save on every keystroke**: prompt textareas (`#bf_mem_draft_prompt`, `#bf_mem_memory_prompt`, `#bf_mem_writer_format`) now persist on `input` instead of `change` (blur). Long edits no longer lost on navigation. Also removed `.trim()` from input handler so trailing whitespace survives.

### Migrations
- Added `migrateLegacySettings()` for soft migration of the deprecated `extension_settings.bf_memory` key. Copies legacy fields (`recentMessageCount`, `customExtractorPrompt`, `customWriterRule`, `extractorProfileId`, `useExtractorProfile`) into the current schema if the current value is unset. The old key is left in place for rollback safety, per ST core convention. `schemaVersion` marker prevents repeated migrations.

### Internal
- `Object.hasOwn` (modern idiom) used in defaults-merge loop instead of `=== undefined`.
- All five fixes validated via three independent research agents (community / ST core source / extension repos) and a final code-review pass.

## [0.2.0] - 2026-05-16

### Added
- **Database Profiles**: save/load/delete database snapshots from the Database tab
  - Share fact sets across characters or restore previous states
  - Dropdown shows profile name, DB count, and fact count
  - Save Current (overwrite), Save As New (prompt for name), Load, Delete
- Profiles stored globally in extension settings (persist across all chats)

### Fixed
- Generation trigger no longer posts "weird" system messages to chat
  - Now uses `context.Generate('normal')` directly instead of `/trigger` slash command
  - Falls back to `/trigger` only if Generate isn't available

## [0.1.0] - 2026-05-16

### Added
- Initial release
- 3-agent pipeline: Draft Agent -> Fact Retrieval -> Writer -> Memory Updater
- Draft Agent (Agent 1): plans reply direction and lists needed facts
- Writer (Agent 2): injects memory context into main model's prompt
- Memory Updater (Agent 3): extracts facts from confirmed messages, updates databases
- Fact Retrieval: pure DB lookup with tiered relevance (no LLM cost)
  - Primary facts: always included
  - Secondary facts: configurable chance (default 50%)
  - Tertiary facts: configurable chance (default 15%)
- Smart fallback mappings (location->furniture, food->allergies, etc.)
- Database system: many small DBs (max 50 facts each) via ST Data Bank
- Fact ownership tracking (who knows what)
- Cross-reference relationships between databases
- Swipe safety: only processes N-1 message, never current
- Review popup: user reviews new/changed facts every N messages
- Separate connection profile for cheap/fast agents (Draft + Memory Updater)
- Writer uses default SillyTavern profile (main model)
- Settings UI with all configurable parameters
- Database browser
- Debug logging panel
