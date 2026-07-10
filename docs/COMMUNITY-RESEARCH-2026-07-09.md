# Community Feature Research — 2026-07-09

Sources: 10 r/SillyTavernAI threads (full posts + comments) and every repo/tool they link:
DeepLore, Summaryception (+2 forks), VectFox + MVU Game Maker, SillyTavern-MemoryBooks v8,
Qvink MessageSummarize, OpenVault, NarrativeEngine-P/M, Kallamo, RePoG, TunnelVision,
GuidedGenerations, Casus Chatfill II, recast-post-processing, Horae, The Story Nexus,
Karpathy's llm-wiki gist, plus builder commentary (PSTEngineer, Marinara users, StageWhisper).

Compared against BF Memory Pipeline **v0.60.0** (`repo/`, post-audit).

---

## 0. What the community validates about our current design

Before the gaps — several of our architectural bets are independently confirmed:

- **No naive vector RAG.** Unanimous across threads: raw-chunk vector retrieval fails for
  stateful RP by ~turn 100–150 ("handing you 20 snippets of a book and asking you to
  reconstruct the world state"). RePoG is explicitly anti-vector for relationships.
  Our v0.50 removal of embeddings is corroborated — *with one caveat, see §3.6*.
- **Guaranteed deterministic injection every turn.** The entire "Janitor felt better than ST"
  thread reduced to injection *guarantee and placement*, not summary quality. Our anchor
  block + scene block is the right shape.
- **Token budgeting as a pillar.** DeepLore warns at 20% context share; NarrativeEngine uses
  percent-of-context tier budgets. Our `retrievalTokenBudget` + Tokens tab matches.
- **Human-in-the-loop memory writes.** Kallamo's staged "Update Entities", the Summaryception
  lorebook fork's review queue, STMB's needs-review job state — all converge on our Review popup.
- **Structured extraction over blob summaries.** VectFox EventBase, OpenVault events, our #MEM
  DSL — same family. "AI summarizers keep the wrong things" is the pain; typed extraction is the fix.
- **Cache-stable prompts.** PSTEngineer's stable-prefix assembly and FF Micro's cache-friendly
  layout confirm our byte-stable system prompts + prefix-hash canary.
- **Editable memory is a hard requirement.** TunnelVision lost users specifically because notes
  couldn't be edited. Our DB tab / per-fact edit / brain icon are load-bearing, keep investing.

**Consensus meta-lesson (4-layer model, KritBlade):** a complete system needs
(1) far memory — retrieval; (2) near memory — guaranteed recent-state injection;
(3) state tracking — structured storage outside the model; (4) deterministic logic.
We cover 1–3 in one pipeline; 4 (game mechanics) is out of scope (community also warns
against RP≠RPG conflation).

---

## 1. Tier 1 — adopt now (high impact, fits our architecture, targets confirmed pain)

### 1.1 Enforce `knownBy` as a retrieval filter (witness/POV scoping)
- **Pain:** #1 immersion bug named across threads — omniscient NPCs, secret leakage.
- **Prior art:** OpenVault witness lists (flagship feature), NarrativeEngine `knownBy:
  player|npc:<id>|faction:<name>`, STMB v8 `characterFilter` on lorebook entries,
  RePoG's 6-layer knowledge boundary ledger.
- **Us:** we already *capture* `@WhoKnows` in the #MEM DSL. The gap is enforcement: filter the
  retrieval cascade (and `search_memory`) by the generating character's knowledge set.
- **Key lesson:** both OpenVault and NarrativeEngine still leak because enforcement was
  prompt-only. **Enforce at the retrieval-filter level in `fact-retrieval.js`, not in the prompt.**
- Extend later with RePoG's reveal-trigger idea: per-secret status + "naming events" that
  promote a fact from GM-only → character-known.

### 1.2 Relationship re-entry pack (relationship state deltas)
- **Pain:** the single most-repeated complaint — emotional/relationship continuity resets.
  "The king met again after 200 messages has to be re-engaged from scratch." Lorebooks keep
  facts but not *how a relationship changed*.
- **Prior art:** RePoG relationship edge lists (`A -> B: relation / status / player-known? /
  last change`, ~15 tokens/edge, plain text, exact recall); Kallamo one-way labeled
  relationships; StageWhisper per-NPC subjective memories.
- **Us:** we have typed edges (off/unproven) and `getRelationshipMomentThread`. Build the
  trigger: **on character re-entry to a scene, guarantee-inject a compact relationship record**
  — current attitude, last meaningful interaction, promises/debts, 2–3 shared moments, last
  change. Store it as a maintained per-pair state fact (superseded on change), not recomputed prose.

### 1.3 Recency labels + hierarchy-of-truth injection header
- **Pain:** "memories without timestamps get treated as 'just happened'" — wrong-sequence recall.
- **Prior art:** VectFox tags every injected event "(3 turns ago)…(latest turn)"; Horae computes
  relative phrases ("2 months ago") at injection time; Summaryception's injection wrapper:
  `[CURRENT STATE]` = absolute truth, overrides everything; `[CHRONOLOGY]` = background only,
  with `[msgs X-Y; current T]` anchors and explicit precedence rules.
- **Us:** we ground to ISO dates but don't render relative time at injection, and our block has
  no precedence header. Both are cheap prompt/formatter changes in the injection builder:
  label every fact with in-story + turn recency, and split the block into CURRENT STATE vs
  CHRONOLOGY with the precedence preamble (steal Summaryception's wrapper nearly verbatim).

### 1.4 Scribe/Reflection prompt upgrades (delta-only + ephemera stop-list + repair loop)
Three prompt-level techniques with outsized returns:
- **Delta-only summarization** (Summaryception core): pass existing layer content into the
  consolidation prompt with "record only what's new; do NOT restate anything already
  documented." Snippets shrink ~100 → ~30 tokens over time. Apply to our Reflection
  pyramid (story summary + shelf summaries).
- **Ephemera stop-list** in the Scribe prompt: enumerate categories to never persist —
  consumed food/drink, momentary pose/arousal/mood, physiological counters, disposed
  temporary items; "obligation counters only when unresolved/owed." Directly attacks fact bloat.
- **Compression guard + repair prompt:** validate consolidation output size; if not smaller,
  re-run with "rewrite the same source memories more abstractly instead of adding detail."
- **Prompt hygiene** (top-voted critique in the summarization thread): kill hedges
  ("if any", "anything else of import", "you feel worth adding") — they cause hallucination
  and drift; make length limits absolute; use concrete YES/NO inclusion rubrics with examples
  ("flowers being fresh = NO; evolving relationship dynamics = YES").

### 1.5 Open-threads / hanging-plot-thread tracking
- **Pain:** models drop plot threads; Chekhov's guns never fire.
- **Prior art:** VectFox event schema carries `cause`, `result`, `open_threads[]`; RePoG
  `threads.md` with carry-forward classification (`active/resolved/dormant/transformed/
  must_return/hold_for_later`); FR-1-Plan's model-maintained plot-point tracker
  ("Paramour still traveling — unresolved (BIG NARRATIVE BOMB)").
- **Us:** we have `kind:event` and `track:` sequences but no thread lifecycle. Add
  `thread:` (or reuse track) with open/resolved status; Reflection closes resolved threads;
  a compact "Open threads" line joins the Big Picture block.

### 1.6 Cross-key supersede rules
- **Prior art:** NarrativeEngine's timeline: death auto-supersedes location and alliance
  entries. Auto-resolves contradictions without bookkeeping.
- **Us:** our supersession is per-key. Add a small deterministic rule table for cross-key
  invalidation (death → stale location/state facts; departure → presence; destroyed →
  ownership). Pure code, fits our engine philosophy.

---

## 2. Tier 2 — adopt next (adoption wedges + roadmap accelerants)

### 2.1 Backlog onboarding / catch-up import
Every long-term ST user has a stuck 100k+ token thread — the community's biggest migration
blocker and Kallamo's top feature request. Prior art: Summaryception's Process All /
One Batch / Skip flow (resumable, cancelable); STMB `/stmb-catchup interval=30 start=0
end=300`; Kallamo's "smart import" (index transcript → AI proposes entities → review queue).
Us: build a chunked catch-up mode that runs the Scribe over an existing chat's history with
progress + cancel, feeding the existing Review popup. **This is the single best adoption feature.**

### 2.2 Selection-summary retrieval pass (optional semantic layer without embeddings)
DeepLore's key trick: each entry carries a ~600-char "when to select me" summary read ONLY by
a cheap retrieval model, never injected; model gets a manifest (title + summary), returns JSON
picks with confidence; confidence-gated budget (request 2×, sort, trim); graceful fallback to
keyword results on AI failure. A user with 150+ entries: "cut my triggers in half despite
barely any keywords." Us: we already maintain per-shelf summaries in the Reflection pyramid —
they can be the manifest. This restores semantic firing (the thing we lost with vectors) with
one cheap call, opt-in, and consistent with our no-embeddings stance.

### 2.3 Unicode tokenization (already roadmap item #4 — community confirms urgency)
VectFox ships `Intl.Segmenter` with dedicated CJK stop-word lists; OpenVault does script-aware
multilingual stemming. Large non-English ST userbase. Our ASCII-only `[^a-zA-Z0-9]` tokenizer
zeroes retrieval for them. `Intl.Segmenter` is built into every modern browser — no dependency.

### 2.4 World Info interop (export/import)
DeepLore explicitly declined a lorebook shim and users complained; STMB stores memories AS
lorebook entries and benefits from the whole ST ecosystem. Us: add (a) export facts →
World Info JSON (keyword doctrine below), (b) import World Info entries as facts. Cheap
goodwill + data portability. Keyword doctrine worth copying into any export (STMB, verbatim
rule): 15–30 concrete scene-specific keywords; ban character names, abstract themes
("sadness", "trust"), and compound keys; test = "would fire if the noun/action is mentioned alone."

### 2.5 NPC agency line in the scene block
"Every NPC in an elevator should already have a reason to be there." StageWhisper injects
per-turn "what this NPC wants from this situation"; NarrativeEngine runs a goal engine.
Us: one line per present character in the existing scene block — `wants:` sourced from a
`People/<char>_current_goal` state fact the Scribe already could maintain. Fixes passive NPCs
for ~10 tokens per character.

### 2.6 Reflection "internal truths" (subconscious drives)
OpenVault's reflection synthesis distills accumulated events into psychological internal
truths injected as a hidden "subconscious drives" bucket — memory ≠ just facts, and this is
the mechanism behind believable character *development*. Us: our Reflection already
synthesizes observation facts; add a per-character drives output with its own injection
line (marked as influence, never to be spoken aloud).

---

## 3. Tier 3 — worth considering / verify first

1. **Prompt isolation for internal calls.** Summaryception disables ALL preset toggles during
   summarizer calls ("routing via Connection Profiles can cause the model to roleplay instead
   of summarize") and restores after, success or fail. **Verify** our Scribe/Reflection calls
   are clean of the user's RP preset; if not, isolate.
2. **Ghosting.** Once memory covers old turns, hide them from the outgoing prompt (never from
   the chat file) → flat token cost on infinite chats. We have `agent2ContextMessages`; ghosting
   is the reversible, user-visible version (Summaryception/VectFox both ship it).
3. **Chapter-funnel deep recall.** NarrativeEngine: coarse pass over LLM-written chapter
   overviews → fine search within matching chapters → inject *verbatim* archived scene
   ("recalling summaries of old scenes reads wrong; verbatim beats summaries"). Pairs with a
   lossless scene archive. Larger build; consider if users ask for exact-scene recall.
4. **Objective/subjective memory pairs + recontextualization** (StageWhisper): store objective
   fact and subjective interpretation separately; never edit old memories — append a
   superseding memory linked so both retrieve together. Our supersession covers the mechanics;
   the subjective channel is the new idea.
5. **Model-emitted XML-comment fact stream** (Kahvana): have the Writer emit new-NPC/state
   facts as hidden XML comments — a zero-extra-call extraction channel the Scribe could parse.
   Cuts Scribe cost, but couples extraction quality to the RP model. Experiment-grade.
6. **Reconsider embeddings — narrowly.** The community failure is raw-chunk RAG; what *worked*
   (VectFox A3, Kallamo, OpenVault) is local, free embeddings (`multilingual-e5-small`,
   384-dim, transformers.js, in-browser) as **one signal over structured events** in a hybrid
   score (`w_cos×RRF + w_importance + w_persist + w_recency×decay`), with a hard cosine floor
   (Kallamo: discard below `0.70 + strictness×0.18`, don't just rank). If `search_memory`
   proves insufficient as the semantic layer, this — not the old fact-embedding chain — is the
   shape to bring back. Zero API cost, and it fixes i18n retrieval as a side effect.
7. **Latency budgeting rule** (RePoG author's own warning): every-turn multi-pass pipelines hit
   user tolerance at +20–30s. Keep all new passes event-driven (re-entry, threshold, arc close)
   or idle-scheduled — which matches our existing idle consolidation design.

---

## 4. Anti-patterns confirmed by the community (do NOT build)

- Vector store as source of truth for relationships (RePoG, explicit).
- Unsupervised auto-summarization writes (wrong salience; always review-queue).
- Negative style prompts ("don't write purple prose" → writes purple prose); phrase positively.
- Prompt-only knowledge boundaries (leak; enforce in retrieval).
- Threat prompts ("or you will be punished") — measurably do nothing.
- LLM-adjudicated dice/mechanics (bias toward player success; if ever needed, engine-owned).
- Fixed-interval batch jobs (OpenVault's every-50-msgs clustering) — make cadence adaptive.
- Mandatory extra API passes — every added call must be optional/toggleable (cost complaints
  are constant); genre-loaded default fields (Kallamo "Race" complaint) — keep taxonomy neutral.
- Silent config failures — DeepLore's misspelled-frontmatter footgun; we should lint settings.
- Onboarding complexity kills adoption even among power users (DeepLore's #1 complaint;
  our 0.60 wizard is the right direction — keep tutorial-grade defaults).

---

## 5. Verbatim prompt material worth keeping (for the prompt library)

- **Summaryception injection wrapper** (hierarchy of truth, CURRENT STATE vs CHRONOLOGY) — §1.3.
- **Summaryception L0 rules:** "Omission means the previous value is preserved… To delete a
  resolved variable, write: key: none… Do NOT extract static character background… Those
  belong in character cards or lorebooks." Plus mandatory `current_date_time: YYYY-MM-DD HH ddd`.
- **STMB v8 per-character POV prompt:** "This is NOT a general scene summary… Do not include
  information {{char}} could not know unless it directly affects future continuity and is
  clearly marked as external scene knowledge."
- **STMB v8 group prompt:** "Do not create a merged personality for the group. Keep attribution
  clear: Alice did X, Bob thought Y, both agreed Z. If only one member knows something, say so."
- **STMB consolidation schema:** `summaries[{…, member_ids[]}]` + `unassigned_items[{id, reason}]`
  — provenance plus a structured outlier escape hatch.
- **scantydesu's YES/NO rubric** (summarization thread): "CONCRETE INFORMATION, CHARACTER
  DEVELOPMENT, SPECIFIC ACCOMPLISHMENTS, EVOLVING RELATIONSHIP DYNAMICS = YES; flavor details
  (flowers being fresh, voice catching), repeated emotional states, exact dialogue unless new
  info = NO."
- **NarrativeEngine GM ruleset lines:** "PRIORITY: Rules > Lore > Context > Narrative_Convenience";
  NPC FIREWALL "NPCs act only on directly perceived info"; "Absent info → uncertain phrasing
  only ('You recall hearing something about…'). Never invent specifics."
- **Purachina Friction Mode** (anti-sycophancy done right): "Enforce an immediate, baseline
  shift to heavy defensive skepticism and social friction… force all agreements to be
  begrudging, transactional, and hard-won."

---

## 6. Suggested sequencing

| Order | Feature | Size | Why first |
|---|---|---|---|
| 1 | knownBy retrieval enforcement (§1.1) | S–M | Data already captured; #1 immersion bug |
| 2 | Recency labels + truth-hierarchy header (§1.3) | S | Formatter-only; fixes sequence confusion |
| 3 | Scribe/Reflection prompt upgrades (§1.4) | S | Prompt-only; attacks bloat + drift |
| 4 | Relationship re-entry pack (§1.2) | M | #1 user-named pain; builds on moment threads |
| 5 | Cross-key supersede rules (§1.6) | S | Pure code; kills contradiction class |
| 6 | Open-threads tracking (§1.5) | M | New DSL field + Reflection lifecycle |
| 7 | Backlog catch-up import (§2.1) | M | Biggest adoption wedge |
| 8 | Unicode tokenization (§2.3) | S–M | Existing roadmap #4; unblocks non-EN users |
| 9 | Selection-summary retrieval pass (§2.2) | M | Semantic layer without embeddings |
| 10 | World Info interop (§2.4) | M | Ecosystem goodwill |
