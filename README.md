# BF's Memory Pipeline

A memory system for SillyTavern. A background note-taker extracts lasting facts from your roleplay and stores them per character; each turn, the relevant ones reach your AI two ways — a small, budgeted block is **pushed** into the prompt for free (no extra AI call), and the AI can **pull** anything deeper itself, mid-reply, through memory tools. So your character actually remembers things across long sessions without the context window ballooning.

Works best with a **tool-calling-capable main model** (e.g. Claude) — the pull tools need one. If your model can't call tools, switch to Push mode (below) and everything still works the classic way.

## Install

Drop into `SillyTavern/public/scripts/extensions/third-party/bf-memory-pipeline-redesign/` (or clone there). Enable in the Extensions panel. The drawer header shows the installed version, read live from `manifest.json` (e.g. `v0.61.0`) — handy for confirming you're testing the latest after a `git pull`.

---

## The mental model — 3 agents + 2 tools

| Piece | Role | LLM call? | When it runs |
|---|---|---|---|
| **Drafter** (Agent 1) | Plans the reply + picks which fact branches to inject | YES | **Push mode only** |
| **Writer** (Agent 2) | Your main model writing the actual reply | YES (your main model) | Every turn |
| **Scribe** (Agent 3) | The note-taker — reads the exchange, stores new facts | YES (a cheap model works great) | **After** each reply lands |
| `search_memory` | Tool the Writer can call mid-reply to look up stored facts — like checking a notebook. Read-only. | — | On demand (default **ON**) |
| `remember_fact` | Tool the Writer can call mid-reply to pin an important new fact. Add-only, never deletes. | — | On demand (default **ON**) |

## Memory modes

The dropdown at the top of the settings panel picks **how** memory reaches your main model:

- **Hybrid (default)** — no Drafter call at all. Each turn a cheap, **deterministic, no-LLM anchor** is injected: a one-line scene block, a few guaranteed anchor facts per present character, and speculative keyword-matched facts — all under a token budget. The main model pulls everything deeper on demand via `search_memory` and pins new facts via `remember_fact`. Skipping the Drafter removes a full blocking LLM round-trip from every reply — the main latency win.
- **Tool-only** — *intended* as "barely any anchor, the model drives all recall itself." Honest note: as of v0.50.x the pipeline treats it **identically to Hybrid** — same anchor injection, the only thing the mode switch actually changes is whether the Drafter runs. Treat it as a forward-looking option.
- **Push (classic)** — the Drafter plans the reply and picks fact branches every turn (an extra blocking LLM call before your reply starts). Choose this if your main model can't call tools.

In **every** mode the Scribe extracts facts *after* the reply arrives (on `MESSAGE_RECEIVED`), on a short settle debounce (~1.8 s) that is **swipe-aware**: spinning four swipes doesn't bill four extractions — only the swipe you settle on gets extracted, and re-extraction resets if you edit a message.

## What happens on a turn (Hybrid, the default)

1. You hit Send. Nothing plans your reply — no waiting on a draft call.
2. **Injection (pure code, no LLM):** scene line + up to 3 anchor facts per present character + keyword-matched facts, deduped, diversity-reranked so five near-identical facts don't hog the space, confidence-weighted so shaky facts lose to solid ones, and hard-capped by the retrieval token budget. Deterministic: same chat state → same injection, **stable across swipes and regens** (no dice).
3. **The Writer writes.** Mid-reply it can call `search_memory` (exact `Category/key` handle → keyword → fuzzy/typo match → a bounded two-hop graph walk; on a miss it gets a hint listing the categories that actually exist, so it re-queries instead of giving up) and `remember_fact` (pins a fact, which is auto-linked into the fact graph so recall can find it later).
4. **The reply lands.** The Scribe reads the last few messages (default 5), stores new facts, and converts "yesterday"/"last week" into real dates so facts don't rot. Every so often a reflection pass merges duplicate notes and writes bigger-picture observations.

## Token economics, honestly

- **The push side is budgeted.** Injected facts can't exceed `retrievalTokenBudget` (default ~800 tokens), plus small capped extras (scene block ≤ 150, "Big Picture" overview ≤ 250).
- **The pull side is conditional spend, not free.** Each tool call costs an extra prompt round-trip (your context gets re-sent). Cheap on turns where the model doesn't need it; real money on turns where it digs. The **Tokens** tab shows exactly what was injected, what it roughly cost, and how that compares to just sending the whole chat.

## Settings reference

| Setting | Default | What it does |
|---|---|---|
| **Memory mode** (`memoryMode`) | `hybrid` | How memory reaches the main model — see above. |
| **Cost preset** (`uiPreset`) | `balanced` | One dropdown that sets the spend knobs together: **Cheap** (300-token budget, sparser anchors), **Balanced** (800), **Max Recall** (1600, full history, more anchors). Hand-editing any governed knob honestly flips it to **Custom**. |
| **Retrieval token budget** (`retrievalTokenBudget`) | 800 | Hard cap (50–8000) on the injected fact block. |
| **Writer context limit** (`agent2ContextMessages`) | 10 | How many recent messages the main model sees. **0 = full history.** Trimming lets stored facts replace old turns — the core token win. |
| **Scribe context** (`agent3ContextMessages`) | 5 | How many recent messages the note-taker reads per extraction. |
| **Review interval** (`reviewInterval`) | 10 | Fact-review popup every N messages (0 = never show it). Higher = fewer interruptions. |
| **Memory lookups** (`enableWriterRecallTool`) | ON | Registers the `search_memory` pull tool. Read-only; no-ops on non-tool models. |
| **Memory notes** (`enableWriterWriteTool`) | ON | Registers the `remember_fact` pin tool. Add-only; no-ops on non-tool models. |
| **POV scoping** (`enforceKnownBy`) | ON | Facts tagged with a who-knows list are hidden from characters not on it (empty list = visible to all). Applies to injection, `search_memory`, and `/recall`. OFF = every character sees every fact. |

**Opt-in extras** (details in [UPGRADES.md](UPGRADES.md)) — each behind its own toggle, OFF unless noted:

| Feature | Default | One line |
|---|---|---|
| Temporal grounding | ON | "yesterday" is saved as an actual date. |
| Recency labels | ON | Injected facts say how long ago they happened — `(~3 turns ago, scene 2)`. |
| Truth hierarchy | ON | Injected memory splits into CURRENT STATE (wins conflicts) vs CHRONOLOGY (context only), so old events aren't replayed as now. |
| MMR diversity rerank | ON | Injected facts cover more ground instead of repeating. |
| Confidence ranking | ON | Shaky facts lose scarce slots to solid ones. |
| Bi-temporal validity | OFF | Track *when in the story* a fact was true (flashbacks/time-skips). |
| Entity merge | OFF | "Bobby"/"Robert"/"Rob" become one character (conservative, logged). |
| Shared user memory | OFF | Facts about *you* are known to every character. |
| Idle consolidation | OFF | The tidy-up pass also runs while you're away. |

## Catching up an existing chat

Installed mid-story? **Database tab → Process Existing Chat → Catch-up import** reads your backlog in chunks of N messages (default 8, `catchupBatchSize`) with **one** Scribe call per chunk — far cheaper than the per-message "Run the Scribe on full chat" button on a long thread. It shows a call estimate before starting, a progress bar while running, and the fact-review popup at the end. Cancel anytime: processed chunks are watermarked, so re-running resumes where it stopped (a failed chunk is retried automatically on the next run). Also available as `/bfmem catchup [N|cancel]`. Two honest caveats: don't keep chatting while it runs, and imported facts get pinned to each chunk's *last* message, so the per-message brain icon is approximate for imported history.

## Removed features

The Finder/Librarian agent (Agent 4) and the embeddings/semantic-retrieval stack were **removed** in v0.50.x — retrieval is now the deterministic keyword + graph path, and `search_memory` is the semantic layer. The old random Secondary/Tertiary "fact chance" dice are gone too: retrieval rolls no dice, which is a feature — the same situation injects the same facts, stable across swipes.

## Troubleshooting

- **Debug tab** — live event log, plus the **"What Claude did"** panel showing each turn's `search_memory` queries and `remember_fact` pins. The **Copy Diagnostics** button bundles settings, the full log, the entire fact database (including the link graph), and token usage into one JSON file/clipboard copy for support sharing — no API keys included.
- **Brain icon** on each message: **click** = free viewer of what the Scribe stored from that line (delete anything wrong); **Shift+click** = (re-)run extraction on it (makes an AI call).
- **Tokens tab** — what was actually injected last turn and roughly what it cost.

See [CHANGELOG.md](CHANGELOG.md) for version history.
