# BF's Memory Pipeline

A 3-agent memory system for SillyTavern. Extracts lasting facts from your roleplay, stores them per-character, and injects only the relevant ones into each new generation — so your AI character can actually remember things across long sessions without bloating the context window.

## Install

Drop into `SillyTavern/public/scripts/extensions/third-party/bf-memory-pipeline/` (or clone there). Enable in the Extensions panel. The drawer header shows the installed version (e.g. `v0.7.3`) — handy for confirming you're testing the latest after a `git pull`.

---

## How the 3 agents work — walkthrough

### Setup
- AI character: **<CHAR>**
- You (the user): **<NAME>**
- Settings:
  - Agent 1 (Draft) ctx = **5**
  - Agent 3 (Memory) ctx = **2**
  - Agent 2 (Writer) limit = **5**

### The chat so far (10 messages)

```
1.  <NAME>:    "Hi"
2.  <CHAR>: "Hello! How can I help?"
3.  <NAME>:    "I'm <NAME>"
4.  <CHAR>: "Nice to meet you <NAME>!"
5.  <NAME>:    "I work at a coffee shop"
6.  <CHAR>: "That sounds fun!"
7.  <NAME>:    "I'm allergic to peanuts"
8.  <CHAR>: "Good to know, I'll remember that."
9.  <NAME>:    "My dog is named <PET>"
10. <CHAR>: "<PET> is a great name!"
```

**Database after these 10 messages (built up over previous turns by Agent 3):**
```
user_name      = <NAME>
user_job       = coffee shop
user_allergy   = peanuts
user_pet_dog   = <PET>
```

### <NAME> types message 11 and hits Send

```
11. <NAME>: "What should I have for lunch?"
```

**Behind the scenes, three things fire in parallel:**

#### 🥖 Agent 1 (Draft) — "the planner"
- **Sees:** the last **5** messages (msgs 7–11) + character card
- **Goes to LLM** (e.g. Deepseek profile you set)
- **Thinks:** "<NAME> asks about lunch. He's allergic to peanuts. <CHAR> should suggest something safe."
- **Outputs:**
  - Draft: *"<CHAR> suggests a safe lunch option, mentions allergy, asks if quick"*
  - Needed facts: *user_allergy, user_food_preferences, user_lunch_options*

#### 🗂️ Agent 3 (Memory) — "the librarian"
- **Sees:** only **2** messages (msg 10 + msg 11)
- **Goes to LLM** (can be a cheaper model)
- **Thinks:** "Nothing new to remember. Msg 10 is just praise. Msg 11 is a question, not a disclosure."
- **Outputs:** `.` (no new facts to store)

#### 🔍 Fact retrieval (no LLM, pure code)
- Takes Agent 1's needed-facts list
- Keyword-matches against the database
- Finds: `user_allergy = peanuts`, `user_job = coffee shop`
- Formats them as a text block

#### 🍞 Agent 2 (Writer) — your main model writing the reply

This is where the **Agent 2 limit** setting kicks in. With limit = 5, we **trim** the chat before the main model sees it:

- **Hidden** from main model: msgs 1–6
- **Visible** to main model: msgs 7–11

Then we **inject** a system message before msg 11 containing the facts + draft.

**What the main model actually receives:**
```
[System prompt + <CHAR>'s character card]

msg 7:  <NAME>:    "I'm allergic to peanuts"
msg 8:  <CHAR>: "Good to know, I'll remember that."
msg 9:  <NAME>:    "My dog is named <PET>"
msg 10: <CHAR>: "<PET> is a great name!"

[OUR INJECTED SYSTEM MESSAGE:
 Facts: user_allergy=peanuts, user_job=coffee shop
 Draft: <CHAR> suggests safe lunch, mentions allergy, asks if quick]

msg 11: <NAME>: "What should I have for lunch?"
```

**Main model writes:**

> *"Hey <NAME>! Since you're allergic to peanuts, maybe avoid anything Thai or with pesto. A turkey wrap or salad would work. Want something quick from your coffee shop, or are you out and about?"*

---

## Agent reference

| Agent | Role | LLM call? | Sees | Output |
|---|---|---|---|---|
| **Agent 1** | Plans reply direction | YES (memory profile) | Last N msgs + char card | Draft + needed facts |
| **Agent 3** | Stores new facts | YES (can be cheaper) | Last N msgs + DB | New facts (or `.`) |
| **Retrieval** | Pulls relevant facts | NO (keyword match) | DB + Agent 1's needs | Text block of facts |
| **Agent 2** | Writes the actual reply | YES (your MAIN model) | Trimmed chat + injected facts | The reply you see |

---

## Settings reference

### Connection Profile
- **Agent 1 Profile** — which connection profile Agent 1 uses (leave blank = default)
- **Agent 3 Profile** — which profile Agent 3 uses (leave blank = default)
- Agent 2 always uses your default/active profile

### Context & Timing
- **Agent 1 Context Messages** (1–50, default 5) — how much chat the planner sees
- **Agent 3 Context Messages** (1–20, default 2) — how much the librarian sees
- **Agent 2 Context Limit (trim chat)** (0–50, default 0) — how much of the chat the main model sees. **0 = off (full history).** Set > 0 to hide older messages, letting facts replace them.
- **Review Interval** (3–100, default 10) — show fact-review popup every N messages

### Fact Retrieval
- **Secondary Fact Chance** (0–100%, default 50%) — probability of including related-but-not-requested facts
- **Tertiary Fact Chance** (0–100%, default 15%) — probability of including distant thematic facts

---

## Tradeoffs at a glance

| Setting | Increases → | Decreases → |
|---|---|---|
| Agent 1 ctx | Better drafts, more tokens | Cheaper, possibly stale plans |
| Agent 3 ctx | Better extraction, more tokens | Cheaper, may miss context |
| Agent 2 limit | Focused replies, lower tokens, **but facts must compensate** | (0) Full history, higher tokens, less control |
| Secondary % | More related context | Less noise |
| Tertiary % | More thematic depth | Less noise |

A starter setup for the "facts replace history" mode:
- Agent 1 ctx: 10
- Agent 3 ctx: 4
- Agent 2 limit: 10 (matches Agent 1 — they see the same window)

---

See [CHANGELOG.md](CHANGELOG.md) for version history.
