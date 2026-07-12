# BF's Memory Pipeline

A memory system for SillyTavern. A background note-taker reads your roleplay, extracts the lasting
facts, and keeps a compact **memory sheet** up to date per chat. Every turn that sheet is spliced
into the prompt by **pure code — no extra AI call blocks your reply**. So your character remembers
things across long sessions without the context window ballooning, and generation never waits on a
second model.

Works with **any backend**. The background agent talks to its tools over a plain text protocol, so
it does not need a function-calling API — a cheap local or hosted model works fine.

> **Status:** redesign-v2 (v0.71.0). This is a large architectural rewrite. `node --check` passes on
> every module, but it is **not yet runtime-tested inside SillyTavern** — the host globals
> (`SillyTavern`, IndexedDB, connection profiles) can only be exercised in the app. Smoke-test on
> this branch before relying on it.

## Install

Drop into `SillyTavern/public/scripts/extensions/third-party/bf-memory-pipeline-redesign/` (or clone
there). Enable in the Extensions panel. The drawer header shows the installed version, read live from
`manifest.json` (e.g. `v0.70.0`) — handy for confirming you're testing the latest after a `git pull`.

---

## The mental model

There is **one** architecture now — no modes, no presets, no tools on your main model.

| Piece | Role | LLM call? | When it runs |
|---|---|---|---|
| **Writer** | Your main model, writing the reply | YES (your model) | Every turn |
| **Memory Sheet** | A persistent per-chat note, always present, injected as one system message | NO — pure code | Every turn, spliced before your last message |
| **Memory Agent** | The background note-taker: reads the settled exchange, updates the store, rebuilds the sheet | YES (a cheap model works great) | **After** each reply settles, off the reply path |

Your Writer **never sees a tool**. It just receives the memory sheet as context and writes. Nothing
plans your reply; nothing blocks it.

### The memory sheet

Stored in `chat_metadata` (`bf_mem_sheet`), one per chat, and it **always** has content — new chats
seed with `Story just beginning — no memories yet.` It contains:

- a rolling **story summary**,
- the **facts the current scene needs**, rendered with recency labels and split into
  **CURRENT STATE** (established truth, wins conflicts) vs **CHRONOLOGY** (older context),
- a one-line **scene card** (location; who's present; current goal/tension),
- a few **graph-connected bonus facts** gathered by a random walk over the memory graph
  (restaurant → Luigi's → first date) — a different connected chain each turn.

Injecting the sheet is pure code reading stored text — deterministic, cache-friendly, stable across
swipes and regens. The sheet is *rebuilt in the background* by the Memory Agent after each settled
reply.

### The Memory Agent (background, one tool-loop per settled reply)

On `MESSAGE_RECEIVED`, behind a ~1.8 s **swipe-aware settle debounce** (spinning four swipes doesn't
bill four runs — only the swipe you settle on is processed; editing a message re-arms extraction),
the agent runs **one tool-loop session** on the Scribe connection profile. In that one session it:

1. anticipates where the scene is going and which memories the next reply will need,
2. extracts new lasting facts from the settled messages,
3. emits the updated memory sheet.

**Text tool protocol (works on any backend).** The agent replies with lines of strict JSON, one tool
call per line, and the extension executes them and feeds results back:

```
{"tool":"list_categories"}
{"tool":"list_keys","args":{"category":"People"}}
{"tool":"read_facts","args":{"category":"People","keys":["monika_name","monika_mood"]}}
{"tool":"write_fact","args":{"category":"People","key":"monika_mood","value":"…","note":"…","known_by":["Monika"],"aspect":"mood","importance":3}}
{"tool":"search","args":{"query":"who owns the bakery"}}
```

This layered navigation — **list categories → list keys → read facts → write / search** — is the
point of the redesign: the agent explores the store on demand instead of being handed a giant dump.
It finishes with a `#SHEET` block (the new memory sheet), optionally preceded by `write_fact` lines.

Hard caps keep it bounded: **max 6 tool rounds, max 20 tool calls** total. Malformed JSON gets one
error message back to re-emit; a second failure degrades safely — it **commits nothing new but keeps
the previous sheet**, and does **not** mark messages processed, so there is no silent memory loss.

### The settled buffer

Facts are only extracted from messages that have **settled** — index ≤ `chat.length − 1 − holdback`
(hold-back **4** by default, `bufferHoldBack`). The most recent few messages are shown to the agent
only as clearly-labeled **TENTATIVE — do not store facts from these** context for planning the sheet;
they can shape the scene card and what the next reply needs, but nothing is committed from them until
they settle. A per-message `bf_mem_processed` watermark (invalidated on swipe/edit) makes sure each
settled message is extracted at most once.

## What happens on a turn

1. You hit Send. **Injection (pure code, no LLM):** trim chat history to the last N user/AI messages
   (`agent2ContextMessages`, default 10; system / World Info / author's-note messages preserved),
   then splice **one** system message — the memory sheet — immediately before your last message.
   Same position every time, cache-friendly. (Trimming only kicks in once the sheet is past its
   seed.)
2. **The Writer writes.** It sees the sheet as established truth for the scene and nothing else new —
   no tools, no waiting.
3. **The reply settles** (~1.8 s debounce, swipe-aware). The Memory Agent runs in the background:
   navigates the store with the text protocol, writes new settled facts, and emits a fresh sheet
   that's stored for next turn. Temporal phrases ("yesterday", "last week") are grounded to real
   dates at write time. Periodic reflection compresses duplicate notes and updates the story summary
   that feeds the sheet.

## Token economics, honestly

- **The sheet stays compact.** It renders the facts the scene needs plus a few bonus connected
  memories, capped by `graphExtrasCount` (default 3).
- **The win is trimming.** Because a compact sheet carries the memory, `agent2ContextMessages` can
  trim old turns out of the Writer's context — stored facts replace raw history. The **Tokens** tab
  shows what was injected, roughly what it cost, and how that compares to sending the whole chat.
- **The agent's cost is off the reply path.** One background tool-loop per settled reply, on a cheap
  profile. It never delays your generation.

## Settings reference

The settings panel has five tabs: **Memory** (the knobs), **Sheet** (the live memory sheet),
**Database**, **Tokens**, **Debug**.

| Setting | Default | Range | What it does |
|---|---|---|---|
| **Enabled** (`enabled`) | off | — | Master switch. |
| **Memory Agent profile** (`agent3Profile`) | — | connection profile | Which connection profile the background agent uses (pick a cheap model). |
| **Extra instructions** (`memoryPrompt`) | — | text | Optional text appended to the agent's prompt. Blank = stock behavior. |
| **Writer history limit** (`agent2ContextMessages`) | 10 | 0–50 | How many recent messages the main model sees. **0 = full history** (no trim). |
| **Buffer hold-back** (`bufferHoldBack`) | 4 | 0–10 | How many newest messages are held back as TENTATIVE (not yet extracted). |
| **Bonus connected memories** (`graphExtrasCount`) | 3 | 0–8 | Extra memories added to the sheet by a random walk over the memory graph — a different connected chain each turn (0 = off). |
| **POV scoping** (`enforceKnownBy`) | on | — | Facts tagged with a who-knows list are hidden from characters not on it (empty list = visible to all). Off = every character sees every fact. |
| **Catch-up batch size** (`catchupBatchSize`) | 8 | 2–30 | Messages per chunk when back-filling an existing chat. |
| **Show toasts** (`showToast`) | on | — | Status toasts. |
| **Debug** (`debugMode`, `debugVerbose`) | off | — | Debug logging in the Debug tab. |

*(Plus data, not knobs: `dbProfiles`, `activeDbProfile`, `unlinkedChats`, `taxonomyOverlay`.)*

**Hardcoded on** (no longer settings — they're always active): temporal grounding, recency labels,
truth hierarchy (CURRENT STATE / CHRONOLOGY split), MMR diversity rerank, confidence ranking,
cross-key supersede, auto-linking + random-walk graph expansion, periodic reflection, the character
registry, and the reflection compression guard. See [UPGRADES.md](UPGRADES.md).

## Catching up an existing chat

Installed mid-story? **Database tab → Process Existing Chat → Catch-up import** reads your backlog in
chunks of N messages (default 8, `catchupBatchSize`) with **one** Memory Agent session per chunk. It
shows a call estimate before starting, a progress bar while running, and rebuilds the sheet from the
tail once the backlog is done. Cancel anytime: processed chunks are watermarked, so re-running
resumes where it stopped (a failed chunk is retried automatically on the next run). Also available as
`/bfmem catchup [N|cancel]`. Two honest caveats: don't keep chatting while it runs, and imported
facts get pinned to each chunk's *last* message, so the per-message brain icon is approximate for
imported history.

## Removed in redesign-v2

The whole tool-on-the-writer path (`search_memory` / `remember_fact`), the memory **modes**
(hybrid / tool-only / push), the **Drafter** and **Selector** agents, and the **cost presets** are
gone. So are a batch of opt-in experiments that never earned their keep: moment echo, relationship
re-entry, typed edges, entity merge, shared user memory, bi-temporal validity, idle consolidation,
and the selection-summary pass. One architecture, no switches. See the [CHANGELOG](CHANGELOG.md) for
the full list.

### Dead-code sweep (post-v0.71.0)

A final pass removed code that was defined but never reached by the live loop: the never-wired
fact **usage-tracking** buffer (`markFactsUsed` / `applyBufferedFactUsage`), the orphaned
**relationship-re-entry scene writer** (`setScene` and its detection block, which nothing called),
the phantom **Drafter / Librarian / Selector** rows on the Tokens tab, and a set of unused helper
exports (`getOpenThreads`, `findExistingLeaf`, `collectBranchFactsIndexed`, singular `getDatabase`,
`groupedTaxonomySubAreas`, `createSemaphore`, `estimateFullChatCalls`, `showAllDatabases`, and seven
unused `host.js` wrappers). ~630 lines of dead code, `node --check` still green on every module, and
the live paths (sheet injection, Memory Agent, reflection, catch-up import) are untouched.

**Source comments were stripped** from every module in the same pass — the rationale lives in git
history and this doc, not inline. The code is the source of truth.

## Troubleshooting

- **Debug tab** — live event log. The **Copy Diagnostics** button bundles settings, the full log,
  the entire fact database (including the link graph), and token usage into one JSON file/clipboard
  copy for support sharing — no API keys included.
- **Brain icon** on each message: **click** = free viewer of what the agent stored from that line
  (delete anything wrong); **Shift+click** = (re-)run extraction on it (makes an AI call).
- **Tokens tab** — what was actually injected last turn and roughly what it cost.

See [CHANGELOG.md](CHANGELOG.md) for version history and [UPGRADES.md](UPGRADES.md) for what's
hardcoded on vs removed.
