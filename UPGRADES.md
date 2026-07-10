# Memory Upgrades — ported from mem0 / Letta / Graphiti / Zep

Eleven memory techniques adapted from the leading agent-memory systems and wired into the
pipeline. Every change is **additive and gated** behind a setting; nothing removes or renames an
existing export, and each new behavior is `try/catch`-wrapped to degrade to prior behavior on error.

**Defaults:** strictly-better, low-risk wins are **ON**; heavier/architectural features are **OFF**
(opt-in) so they can be enabled and tested individually. All settings live in `DEFAULT_SETTINGS`
(`src/settings.js`) with matching coercion in `validateSettings`; all eleven features have UI
controls in `templates/settings.html`. (Since the 0.43.0 tool-first flip, `remember_fact` is
also ON by default — 6 ON / 5 opt-in.)

| Feature | Source system | Setting(s) | Default |
|---|---|---|---|
| Confidence-gated ranking | Zep `minRating` / mem0 confidence | `confidenceRanking`, `confidenceWeight` | **ON** |
| MMR diversity rerank | Graphiti / Zep MMR | `mmrEnabled`, `mmrLambda` | **ON** |
| Temporal grounding at extraction | mem0 observation-date | `temporalGrounding` | **ON** |
| Bi-temporal fact validity | Graphiti / Zep `valid_at`/`invalid_at` | `biTemporal` | OFF |
| Semantic entity resolution / merge | Graphiti node dedup / mem0 linking | `entityResolution`, `entityResolutionThreshold` | OFF |
| User-level shared memory | Zep / mem0 user scoping | `userLevelMemory` | OFF |
| Model-writable `remember_fact` tool | Letta `core_memory_append` | `enableWriterWriteTool` | **ON** (flipped in 0.43.0) |
| Idle-time consolidation | Letta sleeptime agent | `idleConsolidation`, `idleConsolidationMs` | OFF |
| Typed-edge graph memory | Graphiti typed edges | `typedEdges` | OFF |
| Reflection compression guard | prompt hygiene (community research) | `reflectionCompressionGuard` | **ON** |
| Cross-key supersede rules | NarrativeEngine timeline | `crossKeySupersede` | **ON** |

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

### 7. Model-writable `remember_fact` tool — `enableWriterWriteTool` (true since 0.43.0)
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

### 9. Typed-edge graph memory — `typedEdges` (false)
**What it does (ELI5):** teaches memory *what kind* of link connects two facts — who `employs`,
`loves`, `fears`, or `owns` whom — instead of just "these are related", so "who employs Bob?"
follows the exact `employs` link and never confuses Bob's boss with Bob's lover (audit F-ARCH-7).
**How:** the Scribe may tag a fact with up to 3 `| rel:<predicate>@<Category/key>` markers
(predicate = one lowercase verb-ish token; target = an existing fact's handle), appended to its
system prompt as a STATIC suffix (cache-stable, like the temporal rule). Parsed into
`fact.edges = [{p, t}]` — the fact's SUBJECT is the triple's head. Edges union additively at
upsert (`mergeEdges`: dedupe by p+t, incoming wins ties, cap 6; supersession snapshots keep
theirs). At retrieval, edge targets become expansion CANDIDATES through the unified admitter's
anti-hub per-seed cap (candidacy only — ranking stays pure `retrievalSalience`, no degree term).
`search_memory` renders matched facts' edges compactly (` [rel: employs->People/bob_name]`) and
answers simple relation-intent queries ("who employs X" / "who does X employ") by deterministic
predicate matching — no LLM. When OFF, the marker falls through to the legacy `rel:` keyword-hint
branch and behavior is byte-identical. `src/agent-memory.js`, `src/database.js`,
`src/fact-retrieval.js`.

### 10. Reflection compression guard — `reflectionCompressionGuard` (true) — **ON by default**
**What it does (ELI5):** a shelf "summary" from the periodic reflection pass is supposed to be
*shorter* than the facts it stands for. When the model hands back one that isn't (it enumerated or
added detail instead of abstracting), the pass re-runs the consolidation once with a repair
instruction; if the retry still won't shrink, the previous stored summary is kept.
**How:** after `parseReflectResult` and **before** any apply/persist step, each answered queued
shelf's `text.length` is compared to the joined length of the sample facts it was asked to
summarize. On failure the reflection call is retried **once** with a byte-identical system prompt
(the repair paragraph is appended to the *user* prompt only, so the per-agent prefix-stability
check in `llm-call.js` never flags drift for agent `reflection`); only the failing buckets take the
retry's shelves, and first-pass `#STORY`/`#OBS`/`#CALLBACK`/`#REEVAL` are kept to avoid
re-adjudication drift. `MAX_SHELF_SUMMARY_CHARS` remains the final defensive cap. Trips are logged
as `summary.compression_guard` (subsystem `reflection`). Ships alongside the delta-only prompt
upgrades: the reflection prompt now feeds back the prior story summary and each queued shelf's
prior summary (`prev:` lines) so both are **updated by integration**, never regenerated from
scratch. `src/agent-reflect.js`.

### 11. Cross-key supersede rules — `crossKeySupersede` (true) — **ON by default**
**What it does (ELI5):** when a character dies or leaves, or an item is destroyed or lost, the
facts that stopped being true along with it (their current location, what they're doing, who owns
the item) are automatically retired to history — instead of being injected as present truth until
someone happens to rewrite each one individually (NarrativeEngine timeline prior art; community
research report §1.6).
**How:** a small deterministic rule table (no LLM) in `database.js applyCrossKeySupersedeRules`,
applied only at the genuine-new-write callers (Scribe `applyUpdates`, Writer `remember_fact`,
review-popup edits — never migration/rebuild/merge replays). Three rules:
- **death** — trigger: aspect `death`/`death_event`, OR a kind:`state` `status`/`health` write whose
  value matches a death regex (with a "almost/nearly/not" negation lookbehind). Retires same-subject
  `current_location`, `current_activity`, `current_goal`, `companions_present`, `status`, `health`.
- **departure** — trigger: aspect `departure`/`departure_event`/`relocation` only (no value regex —
  "left"/"gone" prose is too ambiguous). Retires `current_location`, `current_activity`,
  `companions_present` (presence only).
- **destroyed_lost** — trigger: aspect `lost_status`, OR a kind:`state`
  `condition_of_item`/`lost_status`/`damage` write matching a destroyed/lost regex. Retires
  `ownership`, `previous_owner`, `location_of_item`, `hidden_location`.

Targets must be ACTIVE, non-sequence, explicit kind:`state` facts (legacy kind-less facts default
to `trait` and are never swept) with the SAME derived subject; retirement reuses the standard
supersession provenance — renamed to a `__was` snapshot, `active:false`, `supersededAt`, and
`supersededBy` set to the trigger's `Category/key` cross-ref (logged as
`fact.superseded` / `CROSS_KEY_RULE:<id>`) — **kept as history, never deleted**. Capped at 8
invalidations per trigger. Caveat: append-only TRACK steps are exempt by design, so a
`<char>_location` track still ends at its pre-death step — the track's last step can surface
pre-death locations via track-reach injection; the retired *state* fact no longer does. OFF
restores per-key-only supersession byte-for-byte. `src/database.js`, `src/agent-memory.js`,
`src/agent-writer.js`, `src/pipeline.js`.

---

## Verification & caveats

- `node --check` passes on all changed `.js` files; no merge/conflict markers; no exports removed.
- **Not yet runtime-tested inside SillyTavern** — host deps (the `SillyTavern` global, IndexedDB,
  the function-tool API) can't be exercised outside the app. Smoke-test on this branch before relying
  on it, especially the opt-in `userLevelMemory` (shared-store read-merge) and `entityResolution`
  (false-merge risk is mitigated by the high threshold + heavy logging, but watch the logs).
- `userLevelMemory` now has a "Clear shared user memory" button (Writer tab), and the shared store appears as an orphan
  `character_attachments[bf_shared_user_memory]` bucket (harmless, never selectable).
- **Multi-device deletes (tombstones):** deleting a category (or clearing the shared user store) now
  stamps a `deletedCategories: { [category]: deletedAtMs }` tombstone into the IDB record, and the
  durable snapshot carries it in every surviving category file. Another device's rehydrate guard
  adopts a newer-but-smaller snapshot for a category whose tombstone is **newer** than that
  category's local activity (a deliberate delete); a shrink with **no** tombstone is still refused
  per-category (stale-snapshot protection). Caveats: tombstones only travel while at least one
  populated category file remains to carry them — wiping **every** category leaves no snapshot
  carrier, so a fully-emptied store can still be resurrected by another device's next flush; and
  attachment-only mode (no IndexedDB) has no snapshot machinery, so tombstones don't apply there.

Reference implementations cloned at `../memory-research/{mem0,letta,graphiti,zep}`; see
`../memory-research/INDEX.md`.
