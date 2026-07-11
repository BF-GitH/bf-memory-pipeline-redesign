# Memory Upgrades — status after redesign-v2

These are the memory techniques adapted from the leading agent-memory systems (mem0 / Letta /
Graphiti / Zep) and from community research. Before redesign-v2 each one was a **gated setting** you
could toggle. In **v0.70.0** the story changed: the strictly-better ones are now **hardcoded on**
(their settings deleted — the behavior is always active), and the heavier/experimental ones were
**removed** entirely to collapse the extension down to one architecture.

If you're upgrading from ≤ 0.61.x, `migrateLegacySettings` maps `memoryProfile → agent3Profile`,
drops every removed setting key, and bumps `schemaVersion` to 3. Old stored **facts** that still
carry removed fields (`validFrom` / `validUntil` / `edges` / `__sharedOrigin`) are tolerated on load
and carried through untouched — no data loss, they just no longer drive behavior.

---

## Hardcoded ON (setting deleted, behavior always active)

These proved themselves as low-risk wins and are now baked in. Where a module used to read the
setting, it now uses a local constant.

| Feature | Was | Now |
|---|---|---|
| **Temporal grounding at extraction** | `temporalGrounding` | Always on. The settled message's `send_date` is threaded to the agent as an `## Observation date` line; "yesterday" is written as a real date. `src/agent-memory.js`. |
| **Recency labels** | `injectRecencyLabels` | Always on. Injected fact lines carry a fail-soft recency tail (`~3 turns ago, scene 2`) computed by `src/recency.js`. |
| **Truth hierarchy (CURRENT STATE / CHRONOLOGY)** | `injectTruthHierarchy` | Always on. The sheet's facts split into CURRENT STATE (wins conflicts) vs CHRONOLOGY (context) with a precedence preamble. `src/recency.js`, `composeSheet`. |
| **MMR diversity rerank** | `mmrEnabled`, `mmrLambda` | Always on (λ = 0.7). Overflow facts are reordered so the budget covers varied ground, using deterministic `trigramSimilarity`. `src/fact-retrieval.js`. |
| **Confidence-gated ranking** | `confidenceRanking`, `confidenceWeight` | Always on (weight 0.3). Shaky facts lose scarce slots to solid ones, never dropping a direct match. `src/fact-retrieval.js`. |
| **Cross-key supersede rules** | `crossKeySupersede` | Always on. A deterministic death / departure / destroyed-or-lost rule table retires same-subject state facts to `__was` history on a triggering write. `src/database.js`. |
| **Auto-linking + 1-hop graph expansion** | `enableAutoLinking` | Always on. New facts are `autoLinkFact`-ed into the graph; retrieval expands one hop through the anti-hub-capped admitter. The sheet's "Connected memories" extras come from this. `src/database.js`, `src/fact-retrieval.js`. |
| **Reflection compression guard** | `reflectionCompressionGuard` | Always on. A shelf summary that comes back no shorter than its source facts is retried once, else the prior summary is kept. `src/agent-reflect.js`. |
| **Periodic reflection** | `reflectionEnabled`, interval | Always on (interval 12, ≤ 200 tok). Its `#STORY` summary now feeds the memory sheet instead of being injected on its own. `src/agent-reflect.js`. |
| **Character registry** | `characterRegistryEnabled`, interval | Always on (interval 10). `src/agent-entities.js`. |
| **Open-threads tracking** | `enableOpenThreads` | Always on (≤ 60 tok). |
| **knownBy / POV enforcement** | `enforceKnownBy` | **Still a setting** (default on) — the one visibility knob that stays user-facing. Applies everywhere memory is read. `src/fact-retrieval.js`. |

---

## REMOVED (feature + setting + UI + prompt + dead code all deleted)

These were architectural or experimental and were cut to collapse the extension to a single path.
Their settings keys are dropped by migration; their code is gone.

**Whole subsystems**
- **Tools on the main model** — `search_memory` + `remember_fact`, their schemas, registration,
  runaway softcap, and the "What Claude did" tool-activity panel. The Writer never sees a tool now;
  the background Memory Agent does all reading/writing over the text protocol.
- **Memory modes** — `memoryMode` (hybrid / tool-only / push). One architecture, no switch.
- **Cost presets** — `uiPreset` and the preset machinery (`presets.js`).
- **Drafter agent** (`agent-draft.js`) and **Selector agent** (`agent-selector.js`) — the old
  per-turn reply-planning / shelf-selection LLM passes, and `selectionSummary*`. No LLM call blocks a
  reply anymore.

**Opt-in experiments retired**
- **Bi-temporal fact validity** (`biTemporal`, `validFrom`/`validUntil` emission — old fields
  tolerated on load).
- **Semantic entity resolution / merge** (`entityResolution*`, `runEntityResolution`, the "Merge
  variants now" button).
- **User-level shared memory** (`userLevelMemory`, the shared store, the clear button).
- **Typed-edge graph memory** (`typedEdges`, `rel:@` parsing/render — the plain relationship link
  tiers and `autoLinkFact` stay).
- **Idle-time consolidation** (`idleConsolidation*`).
- **Moment echo** (`enableMomentEcho`, `momentEchoMaxTokens`) and **relationship re-entry**
  (`enableRelationshipReentry`, `reentry*`).
- **Summary-pyramid injection** (kept as storage feeding the sheet; no longer injected on its own).

**Dead settings swept**
`injectionFreezeTurns`, `useMemoryProfile`, `agent1*`, `draftPrompt`, `sceneCardEnabled` (the scene
card is now an always-on part of the sheet), `semanticRetrieval`, `secondaryChance`,
`tertiaryChance`, `depthDice1-4`, `reflectionInject`, `useFinderAgent` (+ Finder remnants),
`writerFormat`, `#NextHint`. `profiler.js` was inlined into `settings.js` and deleted.

---

## Final settings surface (v0.70.0)

Exactly these keys survive (everything else is deleted by migration):

`enabled`, `onboardingDone`, `agent3Profile`, `memoryPrompt`, `agent2ContextMessages`,
`bufferHoldBack`, `retrievalTokenBudget`, `reviewInterval`, `enforceKnownBy`, `graphExtrasCount`,
`catchupBatchSize`, `showToast`, `debugMode`, `debugVerbose` — plus data (not knobs): `dbProfiles`,
`activeDbProfile`, `unlinkedChats`, `taxonomyOverlay`.

---

## Verification & caveats

- `node --check` passes on all `.js` files; no merge markers; no dangling imports.
- **Not yet runtime-tested inside SillyTavern** — the host deps (`SillyTavern` global, IndexedDB,
  connection profiles) can't be exercised outside the app. Smoke-test on this branch before relying
  on it.
- **Multi-device deletes (tombstones)** are unchanged and still honored: deleting a category stamps a
  `deletedCategories` tombstone into the IDB record and the durable snapshot, so a deliberate delete
  isn't resurrected by another device. Tombstones only travel while at least one populated category
  file remains to carry them, and attachment-only mode has no snapshot machinery.
