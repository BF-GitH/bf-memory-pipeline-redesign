# Memory Upgrades — ported from mem0 / Letta / Graphiti / Zep

Eight memory techniques adapted from the leading agent-memory systems and wired into the
pipeline. Every change is **additive and gated** behind a setting; nothing removes or renames an
existing export, and each new behavior is `try/catch`-wrapped to degrade to prior behavior on error.

**Defaults:** strictly-better, low-risk wins are **ON**; heavier/architectural features are **OFF**
(opt-in) so they can be enabled and tested individually. All settings live in `DEFAULT_SETTINGS`
(`src/settings.js`) with matching coercion in `validateSettings`; the 3 ON features and the 5
opt-in features all have UI controls in `templates/settings.html`.

| Feature | Source system | Setting(s) | Default |
|---|---|---|---|
| Confidence-gated ranking | Zep `minRating` / mem0 confidence | `confidenceRanking`, `confidenceWeight` | **ON** |
| MMR diversity rerank | Graphiti / Zep MMR | `mmrEnabled`, `mmrLambda` | **ON** |
| Temporal grounding at extraction | mem0 observation-date | `temporalGrounding` | **ON** |
| Bi-temporal fact validity | Graphiti / Zep `valid_at`/`invalid_at` | `biTemporal` | OFF |
| Semantic entity resolution / merge | Graphiti node dedup / mem0 linking | `entityResolution`, `entityResolutionThreshold` | OFF |
| User-level shared memory | Zep / mem0 user scoping | `userLevelMemory` | OFF |
| Model-writable `remember_fact` tool | Letta `core_memory_append` | `enableWriterWriteTool` | OFF |
| Idle-time consolidation | Letta sleeptime agent | `idleConsolidation`, `idleConsolidationMs` | OFF |

---

## ON by default

### 1. Confidence-gated ranking — `confidenceRanking` (true), `confidenceWeight` (0.3)
**What it does (ELI5):** facts the Scribe marked shaky ("low"/"med" confidence) lose ground to
solid facts when competing for scarce injection slots — without ever dropping a direct/exact match.
**How:** `confidenceFactor(fact)` (high/absent→1.0, med→0.8, low→0.5, numeric clamped 0..1) folds
into `retrievalSalience` as a bounded multiplier `1 − confidenceWeight·(1 − factor)`, applied
**before** the cold penalty so cold/hot ordering is unchanged. Only the secondary/tertiary overflow
ranking uses `retrievalSalience`, so primaries are never gated. `src/fact-retrieval.js`.

### 2. MMR diversity rerank — `mmrEnabled` (true), `mmrLambda` (0.7)
**What it does (ELI5):** when picking which overflow facts to inject, don't stack five that say
nearly the same thing — pick a varied set so the same token budget covers more ground.
**How:** after the salience sort, `mmrRerank()` greedily reorders each list by
`score = λ·normSalience − (1−λ)·maxSim(c, chosen)`, where similarity reuses the existing
deterministic `trigramSimilarity` over each fact's "key value tags" text (embeddings are off by
default). Reordering only changes *which* candidates `admitTier` keeps under the same caps. Fully
deterministic → stable across swipes/regens. `src/fact-retrieval.js`.

### 3. Temporal grounding at extraction — `temporalGrounding` (true)
**What it does (ELI5):** turns "yesterday"/"last week" into an actual date at write time, so a fact
still makes sense 50 messages later.
**How:** the target message's `send_date` is threaded from `pipeline.runMemoryExtraction` →
`runMemoryUpdater` → `buildMemoryPrompt` as an `observationDate`, emitted as a
`## Observation date: <ISO>` line in the **user** block (never the cache-stable system prefix), plus
a `TEMPORAL_GROUNDING_RULE` suffix appended to the Scribe system prompt. `src/agent-memory.js`,
`src/pipeline.js`.

---

## Opt-in (OFF by default)

### 4. Bi-temporal fact validity — `biTemporal` (false)
**What it does (ELI5):** remember not just *that* something changed but *when it was true in the
story* ("lived in Paris from ch.2–ch.7"), so flashbacks/time-skips stay consistent.
**How:** new `validFrom`/`validUntil` fields (kept distinct from the existing `validAt` ordering
integer). The Scribe may tag `| from:<when>` / `| until:<when>`; on supersession the outgoing
snapshot's `validUntil` is stamped with the incoming fact's `validFrom` (or now). When on, a compact
`{from→until}` annotation appears in the formatted output. `src/agent-memory.js`, `src/database.js`,
`src/fact-retrieval.js`.

### 5. Semantic entity resolution / merge — `entityResolution` (false), `entityResolutionThreshold` (0.85)
**What it does (ELI5):** realize "Bobby"/"Robert"/"Rob" are the same person and merge their facts
under one identity instead of three half-empty profiles.
**How:** conservative, no-LLM `runEntityResolution()` merges variant subjects only on a strong
signal — exact alias match, OR `trigramSimilarity ≥ threshold` AND not both already classified as
distinct "named" entities. Merges reuse `promoteEntity` re-keying + collision-safety; the loser's
name is kept as a searchable alias; `{{user}}`/`{{char}}`/active character are never merged; every
merge is logged loudly. Runs on the off-critical-path entity-check cadence, plus a "Merge variants
now" button. `src/agent-entities.js`, `src/pipeline.js`.

### 6. User-level shared memory — `userLevelMemory` (false)
**What it does (ELI5):** facts about *you* (the player) are remembered by **every** character,
instead of each character re-learning them.
**How:** a fixed pseudo-avatar store (`bf_shared_user_memory`) reuses the existing IDB + attachment
persistence. On write, user-subject facts are mirrored into the shared store; on read,
`getAllDatabases` merges the shared store into the active character's map (deduped by `category:key`,
character store wins). Merged copies carry a transient `__sharedOrigin` tag that `saveDatabase` and
the profile snapshot strip, so the shared store stays the single source of truth. `src/database.js`.

### 7. Model-writable `remember_fact` tool — `enableWriterWriteTool` (false)
**What it does (ELI5):** gives the main model a tool to *pin* a fact directly, complementing the
read-only `search_memory` pull tool.
**How:** mirrors the `search_memory` registration pattern with an add-only write tool
(`{key, value, category?, subject?, importance?, aspect?}`) routing through the existing
`upsertFact`/`saveDatabase` path (never deletes; re-pinning a key updates in place). Idempotent
registration; synced from `index.js` alongside the recall tool. `src/agent-writer.js`.

### 8. Idle-time consolidation — `idleConsolidation` (false), `idleConsolidationMs` (120000)
**What it does (ELI5):** run the cleanup/reflection pass when you've been idle a while, not only on
a turn counter — so heavy maintenance happens during dead time.
**How:** an idle timer re-arms on each `MESSAGE_RECEIVED` and, on elapse with no activity, invokes
the existing `maybeRunReflection()` (which no-ops unless a reflection is armed and guards against
`reflectionInFlight`, so it can't double-fire). Skips while a turn is mid-flight; cleared on
`CHAT_CHANGED`. `src/pipeline.js`.

---

## Verification & caveats

- `node --check` passes on all changed `.js` files; no merge/conflict markers; no exports removed.
- **Not yet runtime-tested inside SillyTavern** — host deps (the `SillyTavern` global, IndexedDB,
  the function-tool API) can't be exercised outside the app. Smoke-test on this branch before relying
  on it, especially the opt-in `userLevelMemory` (shared-store read-merge) and `entityResolution`
  (false-merge risk is mitigated by the high threshold + heavy logging, but watch the logs).
- `userLevelMemory` has no "clear shared store" UI yet, and the shared store appears as an orphan
  `character_attachments[bf_shared_user_memory]` bucket (harmless, never selectable).

Reference implementations cloned at `../memory-research/{mem0,letta,graphiti,zep}`; see
`../memory-research/INDEX.md`.
