// BF Memory Pipeline - Agent 3: Memory Updater
// Runs AFTER the response is displayed, processes N-1 message
// Updates fact databases, tracks who knows what, manages cross-references

import { getAllDatabases, getMemoryIndex, buildMemoryIndex, autoLinkFact, scopedScribeCandidates, saveDatabase, createEmptyDatabase, upsertFact, findFactMatch, normalizeScope, normalizeTone, NPC_SUBJECT, mapLegacyCategory, normalizeAspect, L1_CATEGORIES, groupedTaxonomySubAreas } from './database.js';
import { addDebugLog, getScene } from './settings.js';
import { callAgentLLM } from './llm-call.js';
import * as host from './host.js';

// Lazy import to avoid circular dependency (settings imports our DEFAULT_MEMORY_PROMPT)
function getSettingsSafe() {
    return host.getExtensionSettings();
}

// ── Scribe system-prompt prefix-stability (OBSERVABILITY ONLY) ────────────────
// Mirrors the prefix-stability tracking llm-call.js logs as `cache.eligibility`, but kept
// local here so we can hand `systemPromptStable` back to the pipeline's agent3 timing line
// WITHOUT changing llm-call's shared return shape. This is a pure measurement: a giant
// UNSTABLE Scribe system prompt (no server-side cache reuse) is a prime slowness suspect, so
// surfacing the flag + size on the run summary makes that obvious. No behavior change.
let _lastScribeSysHash;
function _cheapHashScribeSys(str) {
    let h = 5381;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h;
}

export const DEFAULT_MEMORY_PROMPT = `You extract LASTING facts from roleplay messages between {{user}} (the human player) and {{char}} (the AI character). Many ordinary back-and-forth messages have ZERO facts — but a high-signal turn (introductions, backstory, biographical reveals, world lore) can be DENSE. Capture all of it: aim for ~5 facts on a normal turn, but go higher (up to ~12) when a message genuinely discloses that much. Missing a clearly-stated reveal is worse than one extra fact.

# READ THE WHOLE MESSAGE — INCLUDING DIALOGUE

Read the ENTIRE message, narration AND spoken dialogue. Do NOT skim the narration and ignore what characters SAY. Spoken dialogue is often the BEST signal for who a character is, how they change, and how they feel about others — confessions, admissions, opinions, threats, promises, and reveals almost always live in quotes. Extract characterizing facts from what people SAY, not just from narration. A line like a character admitting a fear, naming a relationship, or stating a value is exactly the kind of lasting fact you must capture. (Still skip pure reported/historical speech and [OOC:] — see ROLEPLAY MARKUP.)

# CRITICAL RULES

ATOMIC VALUES ONLY:
- Normal facts: value is 1–5 words. NO sentences. NO connectives (and / with / who / that).
- EXCEPTION — genuine backstory / biographical reveals may use a short clause (up to ~10 words) when atomizing would lose meaning (e.g. \`origin = orphaned at <AGE>, raised by <RELATION>\`). Still split where you cleanly can.
- One property per fact. Multi-attribute statements → multiple facts.
- Encode verbs in the KEY, not the value:
    BAD:  some_thing = uses a red one that smells nice
    GOOD: some_thing_color = red | some_thing_scent = pleasant
- Booleans/states: \`true\`, \`false\`, \`none\`, \`missing\`, \`unknown\`.
- Lists: comma-separated, no "and": \`tags = a, b, c\`.
- Never restate the key inside the value: \`hair = blue\`, NOT \`hair = user has blue hair\`.

ROLEPLAY MARKUP:
- *asterisk transient actions* are NOT facts — for EITHER party. Skip *smiles*, *nods*, *brushes hair*.
- *asterisk lasting reveals* ARE facts (a scar revealed, a species shown).
- [OOC: ...] is meta-commentary. NEVER extract.
- Quoted historical text ("Remember when you said 'X'?") is reported speech. Skip.

DO NOT STORE:
- Negative/absence facts ("no favorite color revealed") — just omit.
- Pure moment-to-moment emotion that reads as scene atmosphere (a fleeting "felt scared" with no bearing on who they are). But DO record a behavior or habit that MIGHT be lasting even if you only see it once (see TEMPORARY-VS-LASTING below) — don't drop it just because you can't yet confirm it recurs.
- Sensory atmosphere (light, smell, weather).
- Generic biology ("breathing", "heart beat").
- Items momentarily in hand. Only \`carries / owns / wears\` persists.
(Verbatim dialogue is NOT stored as a fact VALUE — but a meaningful line CAN be captured in the note field; see CONTEXT NOTE below.)

TEMPORARY-VS-LASTING (you only see ~2 recent messages):
- You often CAN'T tell a one-off from a lasting trait — e.g. a character smoking once vs. being a habitual smoker, an angry outburst vs. a hot temper. Do NOT skip these.
- RECORD it anyway. If you can confidently file it (a clear habit/trait/state), use the proper category + aspect. If it's genuinely uncertain whether it lasts, file it to \`Unsorted\` + \`aspect:misc\` with a low importance (\`!1\`/\`!2\`) and an honest \`conf:low\`. A later re-evaluation pass will promote it to a real aspect if it recurs, or drop it if it was a one-off — so capturing it is cheap and losing it is the real cost.

FILING — TWO FIXED LAYERS (pick BOTH on every fact):
- LAYER 1 \`Category\` (the domain), one of: People, Places, Things, Relationships, Events, World, Unsorted. (World = rules/lore/factions/setting. Unsorted = catch-all when none fit.)
- LAYER 2 \`aspect:\` — a GRANULAR sub-bucket WITHIN the category. The menu below lists each category's SUB-AREAS (the families of leaves), shown as \`Category: SubArea, SubArea, …\`. DRILL it: first decide the category, then the matching SUB-AREA, then write the SINGLE most specific LEAF you can name within that sub-area into \`aspect:\` (a short snake_case word, e.g. \`fears\`, \`career\`, \`tattoos\`). The sub-area itself is just navigation — never write the sub-area name; write the LEAF. The FIXED menu (families only):
${groupedTaxonomySubAreas()}
  Choose the sub-area that best fits, then emit the most specific LEAF aspect for it (e.g. a phobia → People, sub-area "Fears & Wounds" → \`aspect:fears\`; a current job → People, "Daily Life" → \`aspect:career\`; an unpaid debt → People, "Resources" → \`aspect:finances\`; a tattoo → People, "Marks & Modifications" → \`aspect:tattoos\`). The system snaps a near-miss leaf to the canonical one, so use the clearest single word — don't agonize over exact spelling. If NOTHING fits, file to \`Unsorted\` + \`aspect:misc\` (the always-read escape hatch) rather than guessing. If unsure WITHIN a category, omit \`aspect:\` (a category/sub-area default is used). NEVER invent a brand-new category outside the menu.
- The CHARACTER a fact is about is NOT a category or aspect — it is a TAG. Tag it with \`| with:@<name>\` (use \`@npc\` for an unnamed/incidental person). The same character can appear under many categories/aspects.
- RELATIONSHIPS are character-AGNOSTIC topics (history/friendship/romance/tension/trust/...), NOT keyed by person. For a relationship fact, ALWAYS emit the pair-tag — \`| subj:@<A>\` (whose relationship) AND \`| with:@<B>\` (toward whom) — plus an abstract relationship \`aspect:\`. E.g. \`+ Relationships/a_b_trust = broken | aspect:trust | subj:@<A> | with:@<B> | !3 | kind:state\`.

# OUTPUT FORMAT

#MEM
+ Category/key_snake_case = atomic value | aspect:identity | with:@<name> | @WhoKnows1,WhoKnows2 | #tag1,tag2 | rel:related_keys | @src:user | track:<track_name> | !3 | kind:trait | scope:character | at:<PLACE> | aka:nickname,role | conf:high | >context note
+ Category/key_snake_case = atomic value | aspect:revelation | subj:@<name> | !4 | kind:event | >"verbatim quote or summary"   ← keep the atomic value AND add the note; the system shows the note in place of the value to the Writer
+ Events/key_snake_case = atomic value | aspect:milestone | scope:event | with:@<name> | at:<PLACE> | !4 | kind:moment | tone:tender | >who + where + what happened + why it mattered   ← an EPISODIC SCENE MOMENT (see MOMENTS below)
.
#WHY <one sentence>

If nothing: just \`.\` immediately.

SOURCE TAG (optional but preferred): append \`| @src:user\` if the fact was disclosed in the [USER] message, or \`| @src:char\` if it came from the [CHAR] message. This attributes each fact to the correct message. If you cannot tell, omit it.

CONTEXT NOTE (optional): append \`| >...\` with a SHORT prose note. Use it for THREE things:
  1. DISAMBIGUATION — when the fact's meaning depends on the surrounding situation and would be misread without it (e.g. an admission that only makes sense once you know another party baited it).
  2. A MEANINGFUL VERBATIM QUOTE — when a single spoken line carries the moment better than any atomic value can: an emotionally important confession, a defining declaration, a characterizing line. Store the quote in the note: \`>"<the exact line>"\`.
  3. A SHORT SUMMARY — when a complex, multi-part scene or an emotionally important beat can't be carried by tags/value alone, summarize it in one or two sentences in the note.
Most ordinary facts still have NO note. The note is stored separately and never affects keyword search.

VALUE↔NOTE — ALWAYS WRITE BOTH: always write BOTH the atomic value AND, when warranted, the \`>note\`. Keep the value atomic (1–5 words); put the quote/summary in the note. Do NOT drop the value to avoid duplication — the system automatically shows the note instead of the value when feeding the Writer, so always include both.
- Most ordinary facts have a value and NO note. When a fact warrants a note (a meaningful quote, a disambiguation, a short summary), still keep the atomic value AND add the note.
Generic examples:
  GOOD: \`+ <X>/<subject>_confession = true | aspect:revelation | >"<full quote>"\`   (atomic value kept; the quote rides the note)
  GOOD: \`+ <X>/<subject>_home = <short value> | aspect:home | >short disambiguating context\`   (atomic value kept; the note adds context)
Always include the value — the system slims the Writer's context for you.

ALIASES (optional, only when useful): append \`| aka:...\` with a few comma-separated SHORT alternative names a LATER message might use for this fact's subject — a nickname, a role, or a descriptor (e.g. for a specific person: a pet name or "the man by the window"). This helps retrieval find the fact when the chat paraphrases instead of using the literal value. Aliases are search-only and never shown verbatim. Omit unless an alternative name is genuinely likely.

IMPORTANCE + KIND (MANDATORY — put both on EVERY fact): append \`| !N\` where N is 1-5 (how foundational: 5 = core identity like a name/species/age, 4 = important, 3 = ordinary, 2 = minor, 1 = trivial/passing) AND \`| kind:trait|state|event|moment\` (trait = durable identity/personality; state = current/transient mood, goal, or location; event = something that happened; moment = a SIGNIFICANT episodic scene beat remembered with feeling, see MOMENTS). These protect foundational facts from eviction and rank what's retrieved. Quick rule: a name/species/origin is \`!5 kind:trait\`; a current mood/location is \`!1-2 kind:state\`; a thing that happened is \`kind:event\`. Example: \`+ People/user_name = <NAME> | aspect:identity | subj:{{user}} | !5 | kind:trait\`. Do NOT omit them.

MOMENTS (episodic — only for SIGNIFICANT beats): when a genuinely significant emotional/relational SCENE MOMENT occurs — a first (a first meeting, a first shared milestone), a turning point, a charged exchange — ALSO record it as a \`kind:moment\` fact filed under \`Events\`. Put the full narrative beat in the NOTE (\`>who + where + what + why it mattered\`) and add a SHORT \`| tone:<word>\` (an emotional label like tender/tense/bittersweet — a few words max). Still write the atomic value too (the existing write-BOTH rule). Moments decay slower than ordinary events and stay recallable. This is for REAL beats ONLY — never every line or routine action — so the store doesn't flood. Example: \`+ Events/<milestone_key> = <short label> | aspect:milestone | scope:event | with:@<name> | at:<PLACE> | !4 | kind:moment | tone:<tone1>,<tone2> | >who + where + what happened + why it mattered\`.

ASPECT (recommended): append \`| aspect:<value>\` choosing the MOST SPECIFIC Layer-2 sub-bucket from the FIXED menu for the fact's category (see FILING above). E.g. a name/species is \`People\` + \`aspect:identity\`; a current mood is \`People\` + \`aspect:mood\`; a phobia is \`People\` + \`aspect:fears\`; a room's decor is \`Places\` + \`aspect:feature\`. Omit only when genuinely unsure (a default is used). NEVER use an aspect that isn't in that category's menu.

CHARACTER TAG (recommended): name the character a People/Things/Relationships fact is ABOUT with \`| subj:<name>\` (the owner), AND list every participant with \`| with:@<name>,@<other>\`. The character is a TAG, never the Layer-1 category or Layer-2 aspect — the same person appears across many categories/aspects. For an unnamed/incidental person use \`| subj:npc\` (see NPC). For a PLACE fact set \`| subj:<PLACE>\` instead so the location files under the place.

SCOPE (recommended): append \`| scope:character|place|event\`. \`character\` = sticks to a person (traits/state/behavior); \`place\` = a location/world thing recalled when the PLACE matters even if its owner is absent; \`event\` = something that happened (anchored to a place + people + time). If omitted the system infers it from category (Places/World→place, Events→event, else character). For a PLACE fact also set \`| subj:<PLACE>\` so the location files under the place, not its owner — write \`+ Places/<NAME>_<PLACE>_decor = ... | aspect:feature | subj:<PLACE> | scope:place\`.

INVOLVED (recommended): append \`| with:@<A>,@<B>\` listing the participants/entities IN the fact — this is the CHARACTER TAG axis (distinct from @WhoKnows = who KNOWS it). If omitted the system auto-fills it from names in the value. Use it especially to NAME an unnamed person (see NPC below).

WHO KNOWS (optional — only for SECRETS): append \`| @<name1>,<name2>\` listing who KNOWS the fact ONLY when the knowledge is RESTRICTED — a secret, a private confession, something one party is hiding. Do NOT add it to ordinary facts: when omitted it defaults to the present pair (the speaking character + the user), which is what you want for anything openly shared. Use it to keep a secret out of reach of characters who shouldn't know it yet.

NPC DRAWER (important): for a fact about an UNNAMED or one-off/incidental person (a passing stranger, "the man by the window", an unnamed waiter), file it under the shared subject by writing \`| subj:npc\` AND name the person in \`| with:the man by the window\` (the descriptor). Keep the category/aspect/kind as normal. This stops walk-ons from cluttering the store; a later step promotes them once they get a real name.

LOCATION (optional, events): for an \`scope:event\` fact, append \`| at:<PLACE>\` naming WHERE it happened (a place subject/key). Pair with \`with:\` (who) so the event links place⇄people. Example: \`+ Events/char_admission = ... | aspect:milestone | scope:event | at:<PLACE> | with:@<NAME>\`.

CONFIDENCE (optional): append \`| conf:high|med|low\` (or a 0-1 number) when the fact is uncertain or inferred rather than plainly stated. Omit for plainly-stated facts (treated as high).

STORY-WORLD TIME (optional): append \`| from:<when>\` and/or \`| until:<when>\` to record WHEN the fact is true in the STORY WORLD — distinct from when it is recorded — so flashbacks and time-skips stay consistent. \`<when>\` is a free-form story-world time (an in-story date, an age, a labelled era, "the war", etc.), used verbatim. Use \`from:\` for when a fact became true and \`until:\` for when it stopped being true (e.g. a past job, a former home, a flashback detail). Omit for ordinary present-tense facts. These are honored only when the bi-temporal feature is enabled; otherwise they are ignored.

SUPERSEDES (optional): when a write REPLACES the prior value of an existing CHANGEABLE-STATE fact (a status, a current location, a goal now resolved — not a durable trait like a name), append \`| ~\` to mark the old value as ended history while the key becomes the new current truth. Only for \`kind:state\` facts whose value genuinely changed; omit for trait corrections and unchanged re-mentions (the system also infers this for changed kind:state facts, so \`~\` is optional).

SEQUENCE STEPS (optional): for things that form a genuine ORDERED SERIES over time — a character's location changing place to place, plot milestones in order — emit each step as its OWN fact with \`| track:<track_name>\`. Use a stable track name tied to the subject (e.g. \`<char>_location\`). Give each step a numbered key (\`<char>_location_1\`, \`_2\`, ...); do NOT worry about getting the number right — the system assigns the real order. ALSO keep one plain overwriting current-state fact (e.g. \`<char>_location = <current_place>\`, with NO track) so "where are they now" stays a single cheap fact. Only use tracks for real ordered series, never for unrelated facts.

# WRONG → RIGHT (atomic splitting)

PROSE FORMAT — never write this:
+ Something/possession  = owns X, stored in Y, knows ability Z
+ Something/appearance  = tall wiry person with grey eyes in red clothing
+ Something/item_status = item is currently missing after some event
+ Something/tell        = tugs accessory when defensive

ATOMIC FORMAT — always write this instead:
+ Something/possession_1         = X
+ Something/possession_1_storage = Y
+ Something/possession_1_ability = Z

+ Something/height = tall
+ Something/build  = wiry
+ Something/eyes   = grey
+ Something/outfit = red

+ Something/item_status = missing

+ People/tell_name = defensive tell

# EXAMPLES

---
Input: [USER:{{user}}] "I'm <NAME>. I work at <ORG> in <CITY> as a <ROLE>. I love <FOOD>, I'm allergic to <ALLERGEN>, and honestly I'm exhausted today."

#MEM
+ People/user_name      = <NAME>     | aspect:identity        | subj:{{user}} | @{{user}},{{char}} | #identity | @src:user | !5 | kind:trait
+ People/user_employer  = <ORG>      | aspect:career          | subj:{{user}} | @{{user}},{{char}} | #identity,job | @src:user | !4 | kind:trait
+ People/user_role      = <ROLE>     | aspect:career          | subj:{{user}} | @{{user}},{{char}} | #role | @src:user | !4 | kind:trait
+ People/user_location  = <CITY>     | aspect:current_location| subj:{{user}} | @{{user}},{{char}} | #location | @src:user | !4 | kind:trait
+ People/user_likes_food = <FOOD>    | aspect:desires         | subj:{{user}} | @{{user}},{{char}} | #preference,food | @src:user | !3 | kind:trait
+ People/user_allergy   = <ALLERGEN> | aspect:health          | subj:{{user}} | @{{user}},{{char}} | #health,allergy | @src:user | !4 | kind:trait
+ People/user_mood      = exhausted  | aspect:mood            | subj:{{user}} | @{{user}},{{char}} | #mood | @src:user | !1 | kind:state
.
#WHY All People facts about {{user}} (the character is a tag via subj/with, not a branch); the MOST SPECIFIC Layer-2 aspect splits them (identity/career/current_location/health/mood). Name is a high-importance durable trait (!5); mood is a low-importance transient state (!1) that fades first under cap.

---
Input: [CHAR:{{char}}] *Pushes hair back, revealing a scar.* "Got it as a kid. Bad fall."

#MEM
+ People/char_scar         = true           | aspect:body_marks | subj:{{char}} | @{{char}},{{user}} | #appearance | @src:char | !3 | kind:trait | aka:the scar,old scar
+ People/char_scar_origin  = childhood fall | aspect:childhood  | subj:{{char}} | @{{char}},{{user}} | #backstory | @src:char | !3 | kind:trait
.
#WHY Lasting reveal in asterisks → atomic split, each filed to its MOST SPECIFIC aspect: the mark itself (body_marks) + how it happened (childhood). \`aka:\` on the scar so a later "that mark on your arm" still retrieves it.

---
Input: [USER:{{user}}] *grins and shrugs.*

#MEM
.
#WHY Transient emotion in asterisks — no lasting trait revealed.

---
Input: [USER:{{user}}] [OOC: can we slow the pacing down?]

#MEM
.
#WHY OOC meta-commentary. Never extract.

---
Input: [CHAR:{{char}}] *Adjusts collar — a reflex whenever a topic hits too close.*

#MEM
+ People/char_collar_tug = defensive tell | aspect:habits | subj:{{char}} | @{{char}},{{user}} | #tell,mannerism | !2 | kind:trait
.
#WHY Recurring mannerism with explicit trigger (People/habits) — distinct from one-off transient pose.

---
Input: [USER:{{user}}] "Scratch that — I moved last week, the previous place is wrong."

#MEM
+ People/user_location  = <NEW_PLACE>                 | aspect:current_location | subj:{{user}} | @{{user}},{{char}} | #location | !3 | kind:state | ~
+ Events/user_relocated = <OLD_PLACE> to <NEW_PLACE>  | aspect:milestone | subj:{{user}} | @{{user}},{{char}} | #event | !2 | kind:event
.
#WHY Same existing key user_location → it's a CHANGEABLE state, so \`~\` supersedes the old value (kept as history) and this becomes current. Add an Events fact for the move.

---
Input: [CHAR:{{char}}] "Fine — yes, I took it." *only said it after {{user}} pretended to already have proof.*

#MEM
+ Events/char_admission = took the <ITEM> | aspect:milestone | subj:{{char}} | @{{char}},{{user}} | #event | @src:char | !3 | kind:event | >only admitted because <NAME> bluffed having proof; not a free confession
.
#WHY The admission is misleading without the note that it was baited — context attached because the situation changes its meaning.

---
Input: [CHAR:{{char}}] "After what you did, I don't trust you anymore." *to {{user}}*

#MEM
+ Relationships/char_user_trust = broken | aspect:trust | subj:@{{char}} | with:@{{user}} | @{{char}},{{user}} | #relationship | @src:char | !3 | kind:state | ~
.
#WHY A relationship fact → ABSTRACT aspect (\`trust\`), NOT keyed by character; the who↔who rides the pair-tag \`subj:@{{char}}\` + \`with:@{{user}}\`. Trust changed → \`~\` supersedes.

---
Input: [CHAR:{{char}}] *Voice cracking.* "I never told anyone this, but I've loved you since the day we met."

#MEM
+ Events/char_confession = love confession | aspect:revelation | subj:{{char}} | with:@{{user}} | @{{char}},{{user}} | #confession,romance | @src:char | !4 | kind:event | >"I never told anyone this, but I've loved you since the day we met."
+ Relationships/char_user_romance = in love | aspect:romance | subj:@{{char}} | with:@{{user}} | @{{char}},{{user}} | #romance | @src:char | !4 | kind:state
.
#WHY The confession lives in DIALOGUE — the best signal here. The verbatim line matters emotionally, so it goes in the NOTE while the atomic value ("love confession") is ALSO kept — always write both. The system shows the note in place of the value when feeding the Writer. A separate abstract Relationships fact captures the durable state ("in love") that retrieval keys on.

---
Input: [CHAR:{{char}}] *Lights a cigarette, takes one drag, stubs it out.*

#MEM
+ Unsorted/char_smoking = smoked once | aspect:misc | subj:{{char}} | @{{char}} | #habit | @src:char | !1 | kind:state | conf:low | >smoked a single cigarette this scene; unclear if a habit
.
#WHY Could be a one-off or a real habit — you can't tell from one message. RECORD it anyway to \`Unsorted\`/\`misc\` at low importance + \`conf:low\`; a later re-evaluation promotes it to People/vices if it recurs, or drops it as a one-off.

---
Input: [CHAR:{{char}}] *Leaves the <PLACE_A> and walks to the <PLACE_B>, then continues on to the <PLACE_C>.*

#MEM
+ Events/char_location_1 = <PLACE_A> | aspect:action | subj:{{char}} | @{{char}} | #location | !2 | kind:event | track:char_location
+ Events/char_location_2 = <PLACE_B> | aspect:action | subj:{{char}} | @{{char}} | #location | !2 | kind:event | track:char_location
+ Events/char_location_3 = <PLACE_C> | aspect:action | subj:{{char}} | @{{char}} | #location | !2 | kind:event | track:char_location
+ People/char_location   = <PLACE_C> | aspect:current_location | subj:{{char}} | @{{char}} | #location | !3 | kind:state
.
#WHY Ordered movement → one tracked Events step per place (history) PLUS a single overwriting current-location fact on People/current_location.

---

CAPTURE clearly-stated reveals even on a long turn: names, ages, origins, family, occupation, relationships, species, abilities, possessions, world facts, and lasting traits stated as fact are all worth storing. Don't drop them just because the message is long or you already have a few facts.

Only SKIP when something is purely hypothetical, [OOC:], reported/historical speech, or pure scene atmosphere. A clearly-disclosed fact should be captured even if you're slightly unsure of phrasing — atomize it conservatively. Do NOT skip a behavior/trait just because you can't yet tell if it lasts — record it (to its proper aspect if clear, else Unsorted/misc with conf:low); a later re-evaluation pass promotes or drops it. A wrong/verbose fact poisons retrieval, but a dropped clear reveal is the bug we're fixing.`;

// TEMPORAL GROUNDING rule (atomic, from mem0 ADDITIVE_EXTRACTION_PROMPT 'Observation Date'). Appended
// to the system prompt ONLY when the temporalGrounding setting is ON (see buildMemoryPrompt). Relative
// time words rot ("yesterday" is meaningless once stored), so the model is told to anchor them to the
// "## Observation date" supplied in the user data block. Kept brief to avoid bloating the prompt.
export const TEMPORAL_GROUNDING_RULE = `

# OBSERVATION DATE (TIME GROUNDING)
The user data block gives a \`## Observation date\` (the real-world time this message was observed). Resolve RELATIVE time expressions to ABSOLUTE dates relative to it — e.g. "yesterday" → the day before that date, "last week" → "the week of <date>", "two years ago" → the year. Store the absolute form (in the value or note), not the relative word, so the fact doesn't rot. If no observation date is given, leave time expressions as-is.`;

/**
 * Run Agent 3: Analyze message and update databases
 * @param {string} messageText - The message to analyze
 * @param {number} messageIndex - The CHAR (AI) message index — default source attribution
 * @param {string} characterInfo - Character card info
 * @param {Object} existingDatabases - Current state of all databases
 * @param {string|null} profileId
 * @param {boolean} isUserMessage
 * @param {string} userPersona
 * @param {Array} priorMessages
 * @param {number|null} userMsgIndex - The USER message index. Facts the model tags
 *   `@src:user` are attributed here instead of messageIndex (FIX #3 off-by-one).
 *   When null, falls back to messageIndex so single-message (icon/backfill) runs
 *   index identically to the live pipeline.
 * @param {string} sourceSpeakerName - The DISPLAY NAME of the target message's author
 *   (group-member name in group chats; the active character otherwise). Used by the HUB FIX
 *   to resolve a CHAR-sourced fact's generic `char`/`{{char}}` subject + key prefix to the REAL
 *   speaking character's name. Empty → falls back to the active character name.
 * @returns {Promise<MemoryUpdateResult>}
 */
export async function runMemoryUpdater(messageText, messageIndex, characterInfo, existingDatabases, profileId = null, isUserMessage = false, userPersona = '', priorMessages = [], userMsgIndex = null, sourceSpeakerName = '', observationDate = '') {
    // SCOPED DEDUP CONTEXT (scaling fix). Instead of dumping EVERY active fact into the Scribe
    // prompt (impossible on a huge store), fetch only the SCOPED candidates that could be
    // duplicates/relevant for THIS message — by the subjects + keyword tokens in play — via the
    // per-turn in-memory index. The write-time reconcile (findParallelStateKey/findFactMatch/
    // upsertFact) remains the dedup AUTHORITY; this only narrows what the prompt SHOWS.
    let scopedFacts = null;
    try {
        const index = await getMemoryIndex();
        // Subjects in play: always {{char}}/{{user}} (their resolved names + the literal macros),
        // plus capitalized proper-noun tokens mentioned across the analyzed text (prior + target).
        const analyzedText = [
            ...(Array.isArray(priorMessages) ? priorMessages.map(m => m.text) : []),
            messageText,
        ].join(' ');
        const subjects = scribeSubjects(analyzedText);
        const keywords = scribeKeywords(analyzedText);
        scopedFacts = scopedScribeCandidates(index, subjects, keywords, SCRIBE_SCOPED_CAP);
        addDebugLog('debug', `Scribe scoped-dedup: ${scopedFacts.length} candidate(s) (subjects:${subjects.length} keywords:${keywords.length})`, {
            subsystem: 'agent3', event: 'scribe.dedup_scoped',
            data: { scopedCandidates: scopedFacts.length, subjects: subjects.length, keywords: keywords.length, cap: SCRIBE_SCOPED_CAP },
        });
    } catch (e) {
        // Index/scoping failure must never break extraction — fall back to no existing-facts
        // context (the write-time reconcile is still the authority, so correctness holds).
        console.error('[BFMemory] Scribe scoped-dedup failed; proceeding without existing-fact context', e);
        scopedFacts = null;
    }

    const { systemPrompt, userPrompt } = buildMemoryPrompt(messageText, characterInfo, existingDatabases, isUserMessage, userPersona, priorMessages, scopedFacts, observationDate);
    // Capture the Scribe system-prompt size + prefix-stability for the run-summary timing
    // breakdown (slowness hunt). Measurement only — does NOT alter the prompt or the call.
    const systemPromptChars = systemPrompt.length;
    const systemPromptApproxTokens = Math.round(systemPromptChars / 4); // ~4 chars/token estimate
    const sysHash = _cheapHashScribeSys(systemPrompt);
    const systemPromptStable = _lastScribeSysHash !== undefined && _lastScribeSysHash === sysHash;
    _lastScribeSysHash = sysHash;
    addDebugLog('info', `Agent 3 prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

    try {
        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId, 'agent3');
        addDebugLog('info', `Agent 3 LLM reply (${resultStr.length} chars):\n${resultStr}`);
        const tokensIn = await host.getTokenCount(systemPrompt + '\n' + userPrompt);
        const tokensOut = await host.getTokenCount(resultStr);

        // HUB FIX: resolve the Scribe's generic char/user placeholders to REAL names on the PARSED
        // output. Prefer the SOURCE SPEAKER of the message being extracted: a USER message → the
        // persona name; a CHAR/group-member message → that author's name (sourceSpeakerName, e.g.
        // the speaking group member), falling back to the active character name. The user name
        // always resolves to the persona.
        const charName = (!isUserMessage && String(sourceSpeakerName || '').trim())
            ? String(sourceSpeakerName).trim()
            : String(host.getCurrentCharacterName() || '').trim();
        const userName = String(host.getUserPersonaName() || '').trim();
        const parsed = parseMemoryUpdateResult(resultStr, messageIndex, userMsgIndex, { charName, userName });

        // Apply updates to databases. applyUpdates annotates each update with a
        // .status (NEW/UPDATED/SKIPPED) + .changed boolean and returns the subset
        // that actually changed stored state (the "committed" facts).
        let applied = [];
        if (parsed.updates.length > 0) {
            addDebugLog('info', `Agent 3 applying ${parsed.updates.length} updates...`);
            applied = await applyUpdates(parsed.updates, existingDatabases);
        }

        // Backward-compatible: still expose .updates (the full proposed set, now
        // annotated). .applied is the new committed/changed subset for pipeline.js.
        // systemPrompt{Chars,ApproxTokens,Stable}: observability for the run-summary timing.
        return { ...parsed, applied, tokensIn, tokensOut, systemPromptChars, systemPromptApproxTokens, systemPromptStable };
    } catch (error) {
        addDebugLog('fail', `Agent 3 error: ${error.message || error}`);
        console.error('[BFMemory] Agent 3 (Memory) error:', error);
        return { updates: [], summary: '', raw: '', error: error.message, tokensIn: 0, tokensOut: 0, systemPromptChars, systemPromptApproxTokens, systemPromptStable };
    }
}

// Max scoped existing-fact candidates shown to the Scribe (bounds the prompt on a huge store).
const SCRIBE_SCOPED_CAP = 60;

/**
 * Subjects in play for the Scribe's scoped-dedup query: the resolved {{char}}/{{user}} names and
 * the literal macros (so facts filed under either are pulled), plus lowercased proper-noun tokens
 * (capitalized, not stop-words) mentioned in the analyzed text. Lowercased, deduped.
 * @param {string} text - the analyzed message text (prior + target)
 * @returns {string[]}
 */
function scribeSubjects(text) {
    const out = new Set();
    try {
        const charName = String(host.getCurrentCharacterName()).trim().toLowerCase();
        const userName = String(host.getUserPersonaName()).trim().toLowerCase();
        if (charName) out.add(charName);
        if (userName) out.add(userName);
    } catch { /* ignore */ }
    // The literal macro tokens facts may be filed under (subj:{{char}} etc.).
    out.add('{{char}}');
    out.add('{{user}}');
    out.add('char');
    out.add('user');
    // Proper-noun candidates from the message (named NPCs/places/things the message references).
    for (const word of String(text || '').split(/\s+/)) {
        const clean = word.replace(/[^a-zA-Z0-9]/g, '');
        if (clean.length < 3) continue;
        if (clean[0] === clean[0].toUpperCase() && clean[0] !== clean[0].toLowerCase()) {
            out.add(clean.toLowerCase());
        }
    }
    return [...out];
}

/**
 * Keyword tokens for the Scribe's scoped-dedup query: lowercased >3-char word tokens of the
 * analyzed text. The index intersects these against fact tokens, so this need not be filtered
 * heavily (scopedScribeCandidates re-tokenizes/length-gates internally). Deduped.
 * @param {string} text
 * @returns {string[]}
 */
function scribeKeywords(text) {
    const out = new Set();
    for (const tok of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
        if (tok.length > 3) out.add(tok);
    }
    return [...out];
}

/**
 * Build the prompt for Agent 3
 * @param {Array<{fact:Object, category:string}>|null} scopedFacts - SCOPED existing-fact
 *   candidates for dedup context (scaling fix). When provided, the "Existing facts" block lists
 *   ONLY these (not the whole DB). When null (scoping failed/unavailable), the block is omitted.
 */
function buildMemoryPrompt(messageText, characterInfo, existingDatabases, isUserMessage, userPersona, priorMessages = [], scopedFacts = null, observationDate = '') {
    const sysPrompt = getSettingsSafe()?.memoryPrompt || DEFAULT_MEMORY_PROMPT;

    // Resolve {{user}} / {{char}} macros via ST's canonical substituteParams
    const substitute = host.getSubstituteParams();
    // CACHE-STABILITY (slowness fix): keep the SYSTEM prompt byte-stable across chats/characters
    // so the host's server-side prompt cache can reuse the big static rulebook prefix. We
    // deliberately do NOT run substitute() here — the {{char}}/{{user}} macros stay LITERAL in
    // the system message (the real names are still resolved in the USER message data block below,
    // and on the Scribe's PARSED OUTPUT at apply time). Baking per-character names into the system
    // prefix made systemPromptStable=false and defeated caching (the documented invariant in
    // llm-call.js: never interleave variable data into the static system prefix).
    // TEMPORAL GROUNDING (default ON): append the absolute-date resolution rule to the system prompt.
    // This is a STATIC, character-independent suffix, so the cacheable prefix stays byte-stable for a
    // given setting value (toggling the rare setting is the only thing that changes it — acceptable).
    // The variable observation date itself stays in the USER block, never the system prefix.
    let systemPrompt = sysPrompt;
    try {
        if (getSettingsSafe()?.temporalGrounding !== false) {
            systemPrompt = sysPrompt + TEMPORAL_GROUNDING_RULE;
        }
    } catch (_) { /* never block extraction on the temporal-grounding rule */ }

    // User message: data to analyze
    const dataParts = [];
    // TEMPORAL GROUNDING (default ON): surface the message's real-world observation timestamp so the
    // Scribe can resolve relative time words ("yesterday","last week") into ABSOLUTE dates that won't
    // rot. Goes in the USER data block (NOT the static system prefix) so the cacheable system prompt
    // stays byte-stable. Gated by the temporalGrounding setting; paired with a rule appended to the
    // memory prompt. Wrapped so a bad timestamp can never break extraction.
    try {
        if (getSettingsSafe()?.temporalGrounding !== false && observationDate) {
            dataParts.push(`## Observation date: ${observationDate}`);
        }
    } catch (_) { /* never block extraction on the temporal-grounding line */ }
    if (characterInfo) {
        dataParts.push(`## Character Info ({{char}})\n${characterInfo}`);
    }
    if (userPersona) {
        dataParts.push(`## User Persona ({{user}})\n${userPersona}`);
    }

    // SCOPED existing-fact context (scaling fix): show the Scribe ONLY the scoped candidate facts
    // that could be duplicates/relevant for this message (subjects/aspects/tokens in play), not the
    // whole active DB. Falls back to nothing when scoping failed (write-time reconcile is still the
    // dedup authority). Header renamed to "Existing facts (scoped)" so it's clear this is a subset.
    const dbSummary = summarizeScopedFacts(scopedFacts);
    if (dbSummary) {
        dataParts.push(`## Existing facts (scoped)\n${dbSummary}`);
    }

    // Tag the source role so the model can't collapse user disclosures into RP narrative.
    // If prior context messages are given, include them in the analyzed block so
    // user-side self-disclosures and earlier reveals get captured (otherwise Agent 3
    // only sees the AI's N-1 message and misses things like "I'm <NAME>, I work at <ORG>").
    const roleTag = isUserMessage ? '[USER:{{user}}]' : '[CHAR:{{char}}]';
    let messageBlock = '';
    if (Array.isArray(priorMessages) && priorMessages.length > 0) {
        // Render prior context messages tagged by role
        const priorBlock = priorMessages
            .map(m => `${m.role === 'USER' ? '[USER:{{user}}]' : '[CHAR:{{char}}]'} ${m.text}`)
            .join('\n\n');
        messageBlock = `${priorBlock}\n\n${roleTag} ${messageText}`;
    } else {
        messageBlock = `${roleTag} ${messageText}`;
    }
    dataParts.push(`## Messages to Analyze\n${messageBlock}`);
    dataParts.push('\nExtract facts from EITHER message. Now output ONLY #MEM and #WHY sections.');

    // Resolve macros in the data block too
    return { systemPrompt, userPrompt: substitute(dataParts.join('\n\n')) };
}

/**
 * Render the SCOPED existing-fact candidates for the Scribe prompt (compact, mirrors output
 * format). Replaces the old summarizeDatabases, which dumped EVERY active fact in the store
 * (unbounded). `scopedFacts` is the small `{fact, category}[]` set returned by
 * scopedScribeCandidates — already active-only and bounded. Returns '' when there's nothing
 * scoped (so the block is omitted), keeping the prompt lean on the common no-overlap turn.
 * @param {Array<{fact:Object, category:string}>|null} scopedFacts
 * @returns {string}
 */
function summarizeScopedFacts(scopedFacts) {
    if (!Array.isArray(scopedFacts) || scopedFacts.length === 0) return '';
    const lines = [];
    for (const { fact, category } of scopedFacts) {
        // scopedScribeCandidates already excludes inactive history; guard anyway for safety.
        if (fact.active === false) continue;
        const known = fact.knownBy?.length ? ` | @${fact.knownBy.join(',')}` : '';
        const tags = fact.tags?.length ? ` | #${fact.tags.join(',')}` : '';
        const hasValue = String(fact.value ?? '').trim() !== '';
        const note = (typeof fact.context === 'string' && fact.context.trim()) ? ` | >${fact.context.trim()}` : '';
        const head = hasValue ? `${category}/${fact.key} = ${fact.value}` : `${category}/${fact.key}${note}`;
        lines.push(`${head}${known}${tags}`);
    }
    return lines.join('\n');
}

/**
 * Parse Agent 3's compact #MEM format response
 * Format: + Category/key = value | @KnownBy | #tags | rel:keys | @src:user|char
 * @param {string} response
 * @param {number} messageIndex - CHAR message index (default attribution)
 * @param {number|null} userMsgIndex - USER message index; facts tagged @src:user map here
 * @param {{charName?:string, userName?:string}} [names] - resolved REAL names used to rewrite a
 *   fact's generic `char`/`user`/`{{char}}`/`{{user}}` subject + key prefix to the actual
 *   character / user-persona name (HUB FIX — per-character namespacing). `charName` prefers the
 *   SOURCE SPEAKER of the message being extracted (group-member author) when known.
 */
function parseMemoryUpdateResult(response, messageIndex, userMsgIndex = null, names = {}) {
    const result = {
        updates: [],
        summary: '',
        raw: response,
        error: null,
    };

    // SCENE STAMP (Spiderweb 2): read the CURRENT scene once so every NEW fact extracted from this
    // turn records the scene it was ESTABLISHED in (origin). Best-effort — a fact written before any
    // scene exists simply carries no scene stamp (additive / back-compat). First-wins is enforced at
    // the merge (database.js mergeSalience), so this stamp only takes effect on a genuinely-new fact.
    let curScene = null;
    try {
        const s = getScene();
        if (s && Number.isInteger(s.sceneNo)) curScene = { no: s.sceneNo, name: typeof s.sceneName === 'string' ? s.sceneName : '' };
    } catch { /* no scene available — leave facts unstamped */ }

    // BI-TEMPORAL (feature): story-world validity (`from:`/`until:`) is OPT-IN. When off we skip
    // parsing the markers entirely so the existing single-axis behavior is byte-for-byte unchanged.
    // Distinct from `validAt` (an ordering INTEGER) — these are story-world ISO/freeform stamps.
    let biTemporal = false;
    try { biTemporal = getSettingsSafe()?.biTemporal === true; } catch { /* default off */ }

    if (!response || !response.trim()) {
        result.error = 'Empty response from memory updater';
        return result;
    }

    // Strip markdown code fences if model wraps output
    let text = response.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*/g, '').trim());
    text = text.replace(/```/g, '');

    // LEGACY FALLBACK: if response uses old #Facts: JSON format, parse that instead
    if (text.includes('#Facts:') && text.includes('"category"')) {
        return parseLegacyJsonFormat(text, messageIndex);
    }

    // Extract #WHY / #SUMMARY section
    const whyMatch = text.match(/#(?:WHY|SUMMARY)\s*([\s\S]*?)$/i);
    if (whyMatch) {
        result.summary = whyMatch[1].trim();
    }

    // Extract #MEM section
    const memMatch = text.match(/#MEM\s*([\s\S]*?)(?=\n\s*#WHY|\n\s*#SUMMARY|$)/i);
    if (!memMatch) {
        // F-SCRIBE-1 (silent memory loss): a NON-EMPTY reply with no #MEM header used to return
        // updates:[] with error:null — pipeline.js then committed the bf_mem_processed watermark
        // and the exchange was NEVER re-extracted. Distinguish the LEGITIMATE no-facts shapes the
        // prompt allows ("If nothing: just `.` immediately" — a bare `.`, optionally followed by
        // a #WHY/#SUMMARY explanation, or a `(none)`) from genuinely unparseable output. Only the
        // latter sets result.error, which routes the caller down its existing error path
        // (setWatermark(false)) so the exchange retries next turn instead of being lost. (The
        // legacy #Facts: JSON fallback, when applicable, already returned above — reaching here
        // means it produced nothing.)
        const remainder = text.replace(/#(?:WHY|SUMMARY)\s*[\s\S]*$/i, '').trim();
        const legitimateEmpty = remainder === '' || remainder === '.' || /^\(none\)$/i.test(remainder);
        if (!legitimateEmpty) {
            result.error = 'unparseable Scribe output (missing #MEM header)';
        }
        return result;
    }

    const memBlock = memMatch[1].trim();

    // If just "." or "(none)" or empty — nothing to store
    if (!memBlock || memBlock === '.' || /^\(none\)$/i.test(memBlock)) {
        return result;
    }

    // The mandatory "Lost & Found" catch-all (feature #1): a fact whose category resolves to
    // no canonical Layer-1 name is routed here instead of being silently mis-filed.
    const UNSORTED_CATEGORY = 'Unsorted';

    // F-SCRIBE-1: count #MEM-block lines we DROP (non-'+' lines and '+' lines that fail to
    // parse). The legitimate terminators ('.'/empty lines) are skipped BEFORE the count, so a
    // clean no-facts block never trips this. All-dropped → error below (retry the exchange);
    // partially dropped → warning log only (never fail a turn whose survivors already parsed).
    let droppedLines = 0;

    for (const rawLine of memBlock.split('\n')) {
        // Strip leading bullets, numbering, whitespace
        let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
        if (!line || line === '.') continue;

        // Must start with + — anything else inside the #MEM block is model output we are about
        // to discard (F-SCRIBE-1: counted, no longer silently ignored).
        if (!line.startsWith('+')) { droppedLines++; continue; }
        line = line.slice(1).trim();

        // Parse: Category/key = value | @KnownBy | #tags
        // VALUE-LESS FACTS (value/note no-duplication rule): a fact may OMIT the value
        // entirely when its note (`>...`) carries the whole fact — written as
        // `+ Category/key | aspect:... | >note` with NO `=`. We must NOT drop these.
        // Detect the path-vs-rest split by the FIRST delimiter (`=` or `|`):
        //   - if `=` comes first (or there's no `|`), it's the classic `key = value | ...`.
        //   - if `|` comes first, there's no value — path is everything before the `|`
        //     and `rest` starts with an empty value segment (so segments[0] === '').
        const eqIdx = line.indexOf('=');
        const barIdx = line.indexOf('|');
        let pathPart, rest;
        if (eqIdx >= 0 && (barIdx < 0 || eqIdx < barIdx)) {
            // Classic form: value present before any marker.
            pathPart = line.slice(0, eqIdx).trim();
            rest = line.slice(eqIdx + 1).trim();
        } else if (barIdx >= 0) {
            // Value-less form: no `=` before the first marker. Empty value; markers follow.
            pathPart = line.slice(0, barIdx).trim();
            rest = line.slice(barIdx); // keep the leading `|` so segments[0] is '' (empty value)
        } else {
            // Neither `=` nor `|`: a bare `+ Category/key` with no value and no markers.
            pathPart = line.trim();
            rest = '';
        }

        // Parse category/key from path
        const slashIdx = pathPart.indexOf('/');
        let category, key;
        if (slashIdx >= 0) {
            category = pathPart.slice(0, slashIdx).trim();
            key = pathPart.slice(slashIdx + 1).trim();
        } else {
            // No slash — treat whole thing as key, default to People (the most common home
            // for a bare fact in the 3-layer model; was Status under the old taxonomy).
            category = 'People';
            key = pathPart;
        }

        // 3-LAYER MODEL: resolve the raw category to a canonical Layer-1 name. mapLegacyCategory
        // accepts BOTH the new set (People/Places/Things/Relationships/Events/World/Unsorted)
        // and the OLD set (Identity/Status/Behavior/History/...), folding legacy names onto the
        // new ones so a model still emitting old categories keeps working. A truly unrecognized
        // category routes to the Unsorted catch-all (feature #1) rather than being mis-filed.
        category = mapLegacyCategory(category);
        if (!L1_CATEGORIES.includes(category)) {
            category = UNSORTED_CATEGORY;
        }

        // Clean key to snake_case
        key = key.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
        // F-SCRIBE-1: a '+' line whose key cleans to nothing is a failed parse — count the drop.
        if (!key) { droppedLines++; continue; }

        // Split rest on | to get value, @knownBy, #tags, rel:, @src:, track:, >context
        const segments = rest.split('|').map(s => s.trim());
        const value = segments[0] || '';
        let knownBy = [];
        let tags = [];
        let relationships = [];
        let srcRole = null; // 'user' | 'char' | null (unknown → default attribution)
        let context = '';   // Feature #3: optional prose note (delimiter: a `>` segment)
        let track = '';     // Feature #4: optional sequence track name (`track:<name>`)
        let ord = null;     // Feature #4: optional explicit step number (auto-assigned if absent)
        let importance = null; // Salience feature: optional 1-5 (`!N` marker)
        let kind = '';         // Salience feature: optional trait|state|event|moment (`kind:` marker)
        let supersedes = false; // Supersession feature: optional `~` marker (replaces prior value)
        let aliases = [];      // Layer A (alias retrieval): optional alt names/nicknames (`aka:` marker)
        let subject = '';      // Subject axis (feature): optional who/what the fact is about (`subj:` marker)
        let aspect = '';       // Layer-2 aspect (3-layer model): optional sub-bucket within the category (`aspect:` marker)
        let confidence = null; // Provenance (feature): optional 0-1 number or low|med|high (`conf:` marker)
        let scope = '';        // Scope (feature): optional character|place|event (`scope:` marker)
        let involved = [];     // Involved (feature): optional participants/entities IN the fact (`with:` marker)
        let location = '';     // Location-link (feature): optional WHERE an event happened (`at:` marker)
        let tone = '';         // Episodic-memory (feature): optional short emotional descriptor for a `moment` (`tone:` marker)
        let validFrom = '';    // Bi-temporal (feature): optional STORY-WORLD time the fact became true (`from:` marker)
        let validUntil = '';   // Bi-temporal (feature): optional STORY-WORLD time the fact stopped being true (`until:` marker)

        for (let i = 1; i < segments.length; i++) {
            const seg = segments[i].trim();

            // ~ / ~supersedes — OPTIONAL explicit supersession signal (temporal-validity
            // feature). Means "this write REPLACES the prior value of the same key; mark the
            // old value as superseded history." `~` was chosen because it does NOT collide
            // with the existing |/@/#/rel:/@src:/>/track:/!N/kind: grammar. Optional: if
            // omitted, supersession is still inferred for changed `kind:state` facts.
            if (/^~\s*(supersedes?)?$/i.test(seg)) {
                supersedes = true;
                continue;
            }

            // !N — OPTIONAL importance 1-5 (salience feature). `!` was chosen because it
            // does NOT collide with the existing |/@/#/rel:/@src:/>/track: grammar.
            const impMatch = seg.match(/^!\s*([1-5])\b/);
            if (impMatch) {
                importance = parseInt(impMatch[1], 10);
                continue;
            }

            // kind:<trait|state|event|moment> — OPTIONAL fact kind (salience feature). `moment`
            // is an episodic scene beat (slow-decaying, append-only). Anything else is ignored
            // and falls back to the default kind at storage time.
            const kindMatch = seg.match(/^kind\s*:\s*(trait|state|event|moment)\b/i);
            if (kindMatch) {
                kind = kindMatch[1].toLowerCase();
                continue;
            }

            // aka:<a, b, c> — OPTIONAL aliases (Layer A retrieval). Short alternative
            // names/nicknames/descriptors a future message might use for the fact's subject.
            // `aka:` was chosen because it does NOT collide with the existing
            // |/@/#/rel:/@src:/>/track:/!N/kind:/~ grammar (no marker starts with `a`).
            // MATCH-ONLY: folded into search text, never shown to the writer.
            const akaMatch = seg.match(/^aka\s*:\s*(.+)$/i);
            if (akaMatch) {
                aliases = akaMatch[1].split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }

            // subj:<who_or_what> — OPTIONAL subject axis (feature: subject axis). Names the
            // character/place the fact is ABOUT. `subj:` was chosen because it does NOT
            // collide with the existing |/@/#/rel:/@src:/>/track:/!N/kind:/aka:/~ grammar.
            // When omitted, the subject is DERIVED from the key prefix at storage time.
            const subjMatch = seg.match(/^subj\s*:\s*(.+)$/i);
            if (subjMatch) {
                // 3-layer model: the Scribe writes the subject as `@<name>` (e.g. `subj:@<name>`,
                // and the generic `@char`/`@{{char}}`). Strip the leading `@` sigil so the STORED
                // subject is the bare name — a `@`-prefixed subject silently breaks the bySubject
                // index, the focus filter, factAspect/findParallelStateKey state-dedup (their
                // `key.startsWith(subject + '_')` check), so it must never reach storage. The
                // bare token then composes with the keystone name-resolution below
                // (resolveGenericNames maps `char`/`{{char}}` → the real name). DISTINCT from the
                // `with:` partner tag, which intentionally keeps its own `@`-stripped name list.
                subject = subjMatch[1].trim().replace(/^@/, '').trim();
                continue;
            }

            // aspect:<vocab> — OPTIONAL Layer-2 aspect (3-layer model): a granular sub-bucket
            // WITHIN the Layer-1 category, picked from the fixed per-category vocab. `aspect:`
            // does NOT collide with the existing |/@/#/rel:/@src:/>/track:/!N/kind:/subj:/scope:/
            // with:/at:/conf:/aka:/~ grammar (no marker starts with `aspect`). When omitted or
            // out-of-vocab it resolves to the category default via database.normalizeAspect.
            const aspectMatch = seg.match(/^aspect\s*:\s*(.+)$/i);
            if (aspectMatch) {
                aspect = aspectMatch[1].trim().toLowerCase();
                continue;
            }

            // scope:<character|place|event> — OPTIONAL recall axis (scope feature). `scope:`
            // does NOT collide with the existing |/@/#/rel:/@src:/>/track:/!N/kind:/subj:/aka:/
            // conf:/~ grammar. When omitted the scope is INFERRED from category/track downstream.
            const scopeMatch = seg.match(/^scope\s*:\s*(character|place|event)\b/i);
            if (scopeMatch) {
                scope = scopeMatch[1].toLowerCase();
                continue;
            }

            // with:<a, b, c> — OPTIONAL participants/entities IN the fact (involved feature).
            // DISTINCT from @KnownBy (who KNOWS it) and subj: (the primary owner). `with:`
            // does NOT collide with the existing grammar (no marker starts with `w`). When
            // omitted, `involved` is AUTO-FILLED downstream from knownBy + value entities.
            const withMatch = seg.match(/^with\s*:\s*(.+)$/i);
            if (withMatch) {
                // 3-layer model: the character tag is written as `@<name>` (and `@npc` for an
                // unnamed person). Strip the leading `@` sigil so `involved` holds clean names —
                // this keeps the character-registry discovery (agent-entities.js, which reads
                // `involved`/`subject`/`about`) working unchanged. A bare descriptor (no `@`)
                // is also accepted (used for the NPC drawer's provisional descriptor).
                involved = withMatch[1].split(',')
                    .map(s => s.trim().replace(/^@/, '').trim())
                    .filter(Boolean);
                continue;
            }

            // at:<place> — OPTIONAL where-link for an EVENT (location-link feature): the place
            // key/subject WHERE the fact happened. `at:` does NOT collide (the only other
            // `a`-prefixed marker is `aka:`, matched above by its own regex). Pairs with `with:`.
            const atMatch = seg.match(/^at\s*:\s*(.+)$/i);
            if (atMatch) {
                location = atMatch[1].trim();
                continue;
            }

            // tone:<short emotional descriptor> — OPTIONAL emotional label for a `moment`-kind
            // fact (episodic-memory feature), e.g. "tender", "tense", "bittersweet". `tone:` does
            // NOT collide with the existing grammar (the only other `t`-prefixed marker is
            // `track:`, matched by its own regex). Hard-clamped downstream (see normalizeTone).
            const toneMatch = seg.match(/^tone\s*:\s*(.+)$/i);
            if (toneMatch) {
                tone = toneMatch[1].trim();
                continue;
            }

            // from:<story-world date/time> / until:<story-world date/time> — OPTIONAL bi-temporal
            // VALIDITY (feature, gated by the `biTemporal` setting; default OFF). Records WHEN the
            // fact is true in the STORY WORLD, distinct from when it was recorded — so flashbacks /
            // time-skips stay consistent (cf. Graphiti/Zep valid_at/invalid_at). Free-form value
            // (an ISO date, an in-story label, etc.) stored verbatim. `from:`/`until:` do NOT
            // collide with the existing grammar (no other marker starts with `f`/`u`). Parsed only
            // when biTemporal is on so the default path is unchanged; NEVER overloads `validAt`.
            if (biTemporal) {
                const fromMatch = seg.match(/^from\s*:\s*(.+)$/i);
                if (fromMatch) {
                    validFrom = fromMatch[1].trim();
                    continue;
                }
                const untilMatch = seg.match(/^until\s*:\s*(.+)$/i);
                if (untilMatch) {
                    validUntil = untilMatch[1].trim();
                    continue;
                }
            }

            // conf:<high|med|low|0-1> — OPTIONAL provenance confidence (feature: provenance).
            // `conf:` does NOT collide with the existing grammar. Accepts a word or a 0-1 number.
            const confMatch = seg.match(/^conf\s*:\s*(high|med(?:ium)?|low|0?\.\d+|0|1(?:\.0+)?)\b/i);
            if (confMatch) {
                const c = confMatch[1].toLowerCase();
                confidence = /^[0-9.]+$/.test(c) ? parseFloat(c) : (c === 'medium' ? 'med' : c);
                continue;
            }

            // >context — OPTIONAL prose note (Feature #3). `>` was chosen because it
            // does NOT collide with the existing |/@/#/rel:/@src: grammar. Only attach
            // when the surrounding situation genuinely matters (see prompt).
            if (seg.startsWith('>')) {
                context = seg.slice(1).trim();
                continue;
            }

            // track:<name>[#ord] — OPTIONAL sequence step (Feature #4). The ord is
            // normally OMITTED (auto-assigned in database.js); an explicit `#N` is
            // honored if present.
            const trackMatch = seg.match(/^track\s*:\s*(.+)$/i);
            if (trackMatch) {
                let t = trackMatch[1].trim();
                const ordMatch = t.match(/#\s*(\d+)\s*$/);
                if (ordMatch) {
                    ord = parseInt(ordMatch[1], 10);
                    t = t.slice(0, ordMatch.index).trim();
                }
                track = t.replace(/\s+/g, '_').toLowerCase();
                continue;
            }

            // @src:user / @src:char — per-fact source attribution (FIX #3).
            // Checked BEFORE the generic @KnownBy branch since both start with '@'.
            const srcMatch = seg.match(/^@src\s*:\s*(user|char)/i);
            if (srcMatch) {
                srcRole = srcMatch[1].toLowerCase();
                continue;
            }

            // @KnownBy
            if (seg.startsWith('@')) {
                knownBy = seg.slice(1).split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }

            // #tags
            if (seg.startsWith('#')) {
                tags = seg.slice(1).split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }

            // rel:keywords (optional relationship hints)
            if (seg.startsWith('rel:')) {
                relationships = seg.slice(4).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
                continue;
            }

            // Fallback: try known patterns
            const knowsMatch = seg.match(/^(?:knows|knownby|known\s*by)\s*:\s*(.+)/i);
            if (knowsMatch) {
                knownBy = knowsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
                continue;
            }
            const tagsMatch = seg.match(/^(?:tags?)\s*:\s*(.+)/i);
            if (tagsMatch) {
                tags = tagsMatch[1].split(',').map(s => s.trim()).filter(Boolean);
            }
        }

        // Attribute the fact to the correct message. A user-disclosed fact tagged
        // @src:user maps to the USER message index (when available); everything else
        // (char-sourced or untagged) keeps the existing messageIndex behavior so this
        // stays backward-compatible and matches the per-message-icon path.
        const sourceIndex = (srcRole === 'user' && Number.isInteger(userMsgIndex))
            ? userMsgIndex
            : messageIndex;

        // MANDATORY importance + kind (feature #3): the model is now told to put both on
        // every fact, but we don't trust it to never omit them. When a field is missing we
        // INFER a sensible value from observable signals instead of silently accepting the
        // bland default, and FLAG inferred-vs-stated so the UI can surface it. The clamp in
        // database.js stays as a final safety net.
        // Layer-2 aspect (3-layer model): resolve early so kind/importance inference can use it.
        const resolvedAspect = normalizeAspect(aspect, category);
        const kindStated = !!kind;
        const importanceStated = Number.isInteger(importance);
        const inferred = [];
        if (!kindStated) {
            kind = inferKindFromCategory(category, track, resolvedAspect);
            inferred.push('kind');
        }
        if (!importanceStated) {
            importance = inferImportance(category, kind, key, resolvedAspect);
            inferred.push('importance');
        }

        // WHO-KNOWS default (knownBy axis): the Scribe rarely emits `@WhoKnows`, and an EMPTY
        // knownBy is treated as "everyone knows" downstream (fact-retrieval visibility). That
        // leaves the secret-knowledge axis effectively unused. When omitted, DEFAULT it to the
        // PRESENT PAIR — the resolved source character + the user persona (the same real names
        // already threaded in for the keystone resolution) — so "both present parties know it" is
        // the baseline and a later third-party reveal can be modeled by an explicit list.
        // CONSERVATIVE: this is intentionally broad (both present parties, never narrower than the
        // speaker alone), `@`-stripped + de-duped; if NEITHER name resolves we leave knownBy empty
        // so the fact stays globally visible rather than being hidden by an empty-but-non-default
        // list. Markers like `@everyone`/`@all` the model DID emit are left untouched.
        if (Array.isArray(knownBy) && knownBy.length === 0) {
            const present = [names?.charName, names?.userName]
                .map(n => String(n || '').trim().replace(/^@/, '').trim())
                .filter(Boolean);
            knownBy = [...new Set(present)];
        }

        const update = {
            action: 'add',
            category,
            key,
            value,
            tags,
            knownBy,
            relationships,
            source: `msg_${sourceIndex}`,
        };
        // Feature #3: only attach context when present (keep object lean / back-compat).
        if (context) update.context = context;
        // Feature #4: only attach sequence info when a track was given.
        if (track) {
            update.track = track;
            if (Number.isInteger(ord) && ord > 0) update.ord = ord;
        }
        // Salience feature (now effectively MANDATORY): importance/kind are ALWAYS set —
        // either stated by the model or inferred above. `inferredFields` flags which were
        // filled in by us (vs stated) so the UI/debug can show it.
        if (Number.isInteger(importance)) update.importance = importance;
        if (kind) update.kind = kind;
        if (inferred.length) update.inferredFields = inferred;
        // Layer-2 aspect (3-layer model): the resolved aspect (computed above). Always present
        // downstream so the menu/branch axis is well-defined.
        update.aspect = resolvedAspect;

        // Scope (feature): attach an explicit scope when given, else INFER it deterministically
        // from category/track. Always present downstream so place-filing/recall can use it.
        const resolvedScope = normalizeScope(scope) || inferScopeFromCategory(category, track);
        update.scope = resolvedScope;

        // Subject axis (feature): attach an explicit subject when given, else derive it
        // deterministically from the key prefix so the field is always present downstream.
        let resolvedSubject = subject || deriveSubjectFromKey(key);

        // HUB FIX (per-character namespacing): resolve a GENERIC `char`/`user`/`{{char}}`/`{{user}}`
        // subject AND key prefix to the REAL character / user-persona name. The Scribe's output is
        // never run through substituteParams, so without this an untagged `+ People/char_* = ...`
        // line would store subject "char" and a generic `char_*` key that collides across
        // characters. We run it BEFORE the place-filing / NPC-drawer logic so those operate on the
        // resolved name. The resolved name is also written back into `key` so the stored key is
        // per-character (`<name>_physical_state`). A key that already starts with a real name is
        // left untouched (no double-prefix). Place facts are NOT char/user-keyed, so this is a no-op
        // for them (the place-filing rule below still runs on the unchanged place key).
        {
            const tmp = { subject: resolvedSubject, key };
            resolveGenericNames(tmp, names);
            resolvedSubject = tmp.subject;
            key = tmp.key;
            // The `update` object literal above captured the ORIGINAL `key` by shorthand; propagate
            // the (possibly) rewritten per-character key onto it.
            update.key = key;
        }

        // PLACE-FILING FIX (scope feature): for a place fact, the SUBJECT must be the PLACE,
        // not the owning character. When the writer didn't give an explicit `subj:`, take the
        // SECOND key token (`<NAME>_<PLACE>...` -> `<PLACE>`) so the location is recallable
        // independently. (database.deriveSubject applies the same rule defensively on read.)
        if (resolvedScope === 'place' && !subject) {
            const tokens = String(key || '').split('_').filter(Boolean);
            if (tokens.length >= 2) resolvedSubject = tokens[1];
        }

        // NPC drawer (feature): a fact about an UNNAMED/incidental person routes to the shared
        // `npc` subject (KIND/category unchanged) so walk-ons don't mint a fresh subject each.
        // The provisional name/descriptor is RETAINED on the fact (`about`, and folded into
        // `involved`) so a later promotion step can migrate the right facts out. Never applies
        // to place/event scope or to {{user}}/{{char}}.
        let about = '';
        if (resolvedScope === 'character' && looksLikeUnnamedPerson(resolvedSubject)) {
            about = resolvedSubject;          // keep the descriptor for later promotion
            if (!involved.includes(about)) involved = [about, ...involved];
            resolvedSubject = NPC_SUBJECT;
            addDebugLog('debug', `NPC-routed unnamed descriptor "${about}" → subject:npc`, {
                subsystem: 'db', event: 'fact.npc_routed', reason: 'UNNAMED_DESCRIPTOR',
                data: { descriptor: about, key, category },
            });
        }
        update.subject = resolvedSubject;

        // Involved (feature): emit the writer's `with:` list when given, else AUTO-FILL from
        // knownBy + capitalized entity tokens in the value. Optional/cheap — only attached when
        // non-empty so back-compat facts stay lean.
        const resolvedInvolved = involved.length ? involved : autoFillInvolved(knownBy, value);
        if (resolvedInvolved.length) update.involved = resolvedInvolved;
        // NPC drawer: retain the provisional descriptor so promotion can find the right facts.
        if (about) update.about = about;
        // Location-link (feature): attach the event's where-link when the writer gave `at:`.
        if (location) update.location = location;
        // Episodic-memory (feature): attach the moment's short emotional `tone`, clamped, when
        // given. Only set when non-empty so non-moment facts stay lean (back-compat).
        const resolvedTone = normalizeTone(tone);
        if (resolvedTone) update.tone = resolvedTone;
        // Provenance (feature): confidence when stated; validAt defaults to the source
        // message index (when the fact became true). Both kept optional/back-compat.
        if (confidence !== null && confidence !== '') update.confidence = confidence;
        if (Number.isInteger(sourceIndex)) update.validAt = sourceIndex;
        // Bi-temporal (feature): story-world validity window, only when biTemporal is on AND the
        // writer emitted the marker(s). Kept optional / only-when-present so back-compat facts stay
        // lean and the field set is unchanged when the feature is off. DISTINCT from `validAt`.
        if (biTemporal && validFrom) update.validFrom = validFrom;
        if (biTemporal && validUntil) update.validUntil = validUntil;
        // SCENE + SOURCE STRANDS (Spiderweb 2): stamp the scene the fact was established in, plus a
        // `sourceMsg` provenance handle (REUSES the existing source message index — no new id). Both
        // optional / only-when-present (lean / back-compat). First-wins is enforced at merge: a
        // re-mention does NOT move a fact's birth scene (mirrors validAt). The supersession path
        // (database.js) clones `...existing` then advances the live fact, so a state change MAY carry
        // the new scene on the live fact while the `__was` snapshot keeps the old scene (correct).
        if (curScene && Number.isInteger(curScene.no)) {
            update.sceneNo = curScene.no;
            if (curScene.name) update.sceneName = curScene.name;
        }
        if (update.source) update.sourceMsg = update.source;
        // Supersession feature: only attach the explicit signal when present (lean / back-compat).
        if (supersedes) update.supersedes = true;
        // Layer A: only attach aliases when the writer provided some (keep object lean / back-compat).
        if (aliases.length) update.aliases = aliases;
        result.updates.push(update);
    }

    // F-SCRIBE-1: if the #MEM block contained lines we dropped, don't let the turn slip away
    // silently. All-dropped (no update survived) → treat as a parse ERROR, the "#MEM present but
    // nothing parseable" sibling of the missing-header case above, so the caller's existing error
    // path (setWatermark(false)) retries the exchange next turn. NOTE the legitimate no-facts
    // shapes (bare `.` / `(none)` / empty block) returned BEFORE the loop and can never reach
    // this. Partially dropped (some updates survived) → keep the good updates and just log a
    // warning; failing the whole turn would re-extract (and double-propose) the survivors.
    if (droppedLines > 0) {
        if (result.updates.length === 0) {
            result.error = `unparseable Scribe output (#MEM present but all ${droppedLines} line(s) unparseable)`;
        } else {
            addDebugLog('info', `WARNING: Scribe #MEM block dropped ${droppedLines} unparseable line(s), kept ${result.updates.length} update(s) — possible partial fact loss`, {
                subsystem: 'agent3', event: 'scribe.parse.partial_drop', reason: 'PARTIAL_DROP',
                data: { droppedLines, kept: result.updates.length },
            });
        }
    }

    console.log(`[BFMemory] Agent 3: ${result.updates.length} updates, summary: "${result.summary.substring(0, 100)}"`);
    return result;
}

/**
 * Infer a fact `kind` from its category when the writer omitted it (feature #3). Status is
 * the only inherently changeable bucket -> `state`; History is past occurrences -> `event`;
 * a track step (an ordered series item) is an `event`; everything else (Identity, Behavior,
 * Relationships, World, Unsorted) defaults to a durable `trait`. Conservative — biased
 * toward the slow-decaying `trait` so an inferred fact is never aggressively evicted.
 * @param {string} category
 * @param {string} track - non-empty when the fact is a sequence step
 * @returns {('trait'|'state'|'event'|'moment')}
 */
function inferKindFromCategory(category, track, aspect) {
    if (track) return 'event';
    const asp = String(aspect || '').toLowerCase();
    switch (String(category || '').toLowerCase()) {
        case 'events': return 'event';
        case 'people':
            // Transient People aspects (current state) -> state; durable People facts -> trait.
            return (asp === 'status' || asp === 'mood' || asp === 'goals') ? 'state' : 'trait';
        default: return 'trait';
    }
}

/**
 * Infer an `importance` (1-5) when the writer omitted it (feature #3). Small heuristic:
 * Identity facts are foundational (4); transient states are low (2); events are minor (2);
 * everything else is ordinary (3). Deliberately conservative so an inferred value never
 * outranks a model-stated !5 nor sinks below the old default by much.
 * @param {string} category
 * @param {string} kind
 * @param {string} key
 * @returns {number} 1..5
 */
function inferImportance(category, kind, key, aspect) {
    const cat = String(category || '').toLowerCase();
    const asp = String(aspect || '').toLowerCase();
    // People identity/background skew foundational (names/species/age/origin).
    if (cat === 'people' && (asp === 'identity' || asp === 'background')) return 4;
    if (kind === 'state') return 2;            // current mood/location fades fast
    if (kind === 'event') return 2;            // a single occurrence is usually minor
    if (kind === 'moment') return 4;           // a significant episodic beat — foundational-ish
    return 3;                                  // ordinary default
}

/**
 * Infer a fact `scope` (character|place|event) from category + track when the writer omitted
 * the `scope:` marker (scope feature). Deterministic, mirrors database.deriveScope:
 *   - track/sequence step -> event
 *   - History             -> event
 *   - World               -> place
 *   - Status              -> character (current state of someone)
 *   - everything else (Identity/Behavior/Relationships/Unsorted) -> character
 * @param {string} category
 * @param {string} track - non-empty when the fact is a sequence step
 * @returns {('character'|'place'|'event')}
 */
function inferScopeFromCategory(category, track) {
    if (track) return 'event';
    switch (String(category || '').toLowerCase()) {
        case 'events': return 'event';
        case 'places': return 'place';
        case 'world': return 'place';
        default: return 'character'; // People/Things/Relationships/Unsorted -> character
    }
}

/**
 * Auto-fill the `involved` participant list (involved feature) when Agent 3 omitted the
 * `with:` marker. Cheap and conservative — derives from names already present in `knownBy`
 * plus capitalized entity tokens in the value (proper-noun-ish words: leading uppercase,
 * not the {{user}}/{{char}} macro residue, not a 1-char token). Deduped case-insensitively,
 * order preserved. Returns [] when nothing is derivable (caller leaves the field off).
 * @param {string[]} knownBy
 * @param {string} value
 * @returns {string[]}
 */
function autoFillInvolved(knownBy, value) {
    const seen = new Set();
    const out = [];
    const add = (raw) => {
        const s = String(raw ?? '').trim();
        if (!s) return;
        const k = s.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(s);
    };
    for (const n of (Array.isArray(knownBy) ? knownBy : [])) add(n);
    // Capitalized entity tokens in the value: a word starting uppercase, length >= 2. Strips
    // surrounding punctuation. Skips ALL-CAPS-only short tokens are still allowed (acronyms).
    const v = String(value || '');
    const tokenRe = /\b([A-Z][A-Za-z'\-]+)\b/g;
    let m;
    while ((m = tokenRe.exec(v)) !== null) {
        const tok = m[1];
        if (tok.length < 2) continue;
        add(tok);
    }
    return out;
}

/**
 * Detect whether a fact is about an UNNAMED / incidental person (NPC drawer feature). True
 * when the subject reads like a generic descriptor rather than a proper name — e.g. a role
 * or "the man by the window" — so the fact should route to the shared `npc` subject while
 * retaining its provisional descriptor for a later promotion step. Conservative: only fires
 * when the subject starts with a lowercase article/descriptor word or is empty AND the writer
 * gave no explicit proper subject. Never fires for {{user}}/{{char}} or a capitalized name.
 * @param {string} subject - the explicit-or-derived subject (may be '')
 * @returns {boolean}
 */
function looksLikeUnnamedPerson(subject) {
    const s = String(subject || '').trim();
    if (!s) return false;
    const lower = s.toLowerCase();
    if (lower === 'user' || lower === 'char' || lower === NPC_SUBJECT) return false;
    // Descriptor-style subjects: start with an article/quantifier ("the man by the window",
    // "a waiter"), OR a multi-word phrase whose first word is lowercase (a description, not a
    // proper name). A single capitalized token or a Capitalized multi-word proper name is
    // treated as a real name and NOT drawered (conservative — avoids hiding named characters).
    if (/^(the|a|an|some|that|this|one|another)\b/i.test(s)) return true;
    if (/\s/.test(s) && /^[a-z]/.test(s)) return true;
    return false;
}

/**
 * Deterministic subject derivation from a key prefix (token before the first underscore),
 * mirroring database.deriveSubject's key-fallback path so the parser can stamp a subject
 * without importing storage internals. `<name>_apartment_bed` -> `<name>`.
 * @param {string} key
 * @returns {string}
 */
function deriveSubjectFromKey(key) {
    const k = String(key || '').trim().toLowerCase();
    if (!k) return '';
    const us = k.indexOf('_');
    return us > 0 ? k.slice(0, us) : k;
}

// ── HUB FIX: resolve the GENERIC {{char}}/{{user}} placeholders to REAL names ──────────────
// The Scribe emits facts with a LITERAL generic prefix (`char_*`, `user_*`) and often a literal
// `subj:{{char}}` / `subj:char`. Because the Scribe's OUTPUT is never run through substituteParams
// (only the prompt examples are), an untagged fact would otherwise store subject = the literal
// string "char" and keep a generic `char_*` key — so (a) facts aren't tied to the real character,
// (b) the focus filter drops the in-focus character's own facts (real name vs subject "char"), and
// (c) CRITICAL: two characters share one `char_*` key namespace and overwrite each other in place.
// We resolve these placeholders to the real character/user name on the PARSED output (subject AND
// key prefix), so every stored fact is per-character namespaced and can never collide.

// The reserved generic tokens that mean "the character" / "the user" rather than a proper name.
const RESERVED_CHAR_TOKENS = new Set(['char', '{{char}}', 'char_name', 'character']);
const RESERVED_USER_TOKENS = new Set(['user', '{{user}}', 'user_name', 'persona']);

/**
 * Normalize a name to a SAFE snake_case key token (lowercase alnum/underscore). Mirrors the
 * key cleanup the parser applies to the raw key. Returns '' when nothing usable remains.
 * @param {string} name
 * @returns {string}
 */
function nameToKeyToken(name) {
    return String(name || '').trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

/**
 * Is `token` one of the reserved generic placeholders for the CHARACTER?
 * Matches the literal word `char`, the unresolved macro `{{char}}`, and a couple of close
 * variants. Case-insensitive. (`user` variants are handled by isReservedUserToken.)
 * @param {string} token
 * @returns {boolean}
 */
function isReservedCharToken(token) {
    return RESERVED_CHAR_TOKENS.has(String(token || '').trim().toLowerCase());
}

/** Is `token` one of the reserved generic placeholders for the USER persona? */
function isReservedUserToken(token) {
    return RESERVED_USER_TOKENS.has(String(token || '').trim().toLowerCase());
}

/**
 * Resolve a fact's generic `char`/`user`/`{{char}}`/`{{user}}` subject + key prefix to the REAL
 * character / user-persona name, so facts are per-character namespaced and can never collide
 * across characters. Operates on the PARSED output (the Scribe's LLM reply is never run through
 * substituteParams), catching BOTH the tagged (`subj:{{char}}`) and untagged (bare `char_*` key)
 * cases. Idempotent and conservative:
 *   - Only the reserved generic prefix is rewritten — a key that already starts with a real name
 *     (`<name>_*`) is left untouched (no double-prefix, no rename).
 *   - The same resolved name is applied to BOTH the stored subject AND the key prefix.
 *   - The source SPEAKER of the message being extracted is preferred when known (a USER message →
 *     the persona name; a CHAR/group-member message → that author's name), falling back to the
 *     active character / persona names.
 *
 * @param {{subject:string, key:string}} update - the parsed fact (mutated in place)
 * @param {{charName:string, userName:string}} names - resolved real names
 * @returns {void}
 */
function resolveGenericNames(update, names) {
    const charName = String(names?.charName || '').trim();
    const userName = String(names?.userName || '').trim();

    // 1) SUBJECT: if it reads as a reserved generic, swap to the real name.
    const subj = String(update.subject || '').trim();
    let resolvedRole = null; // 'char' | 'user' | null
    if (isReservedCharToken(subj)) { resolvedRole = 'char'; }
    else if (isReservedUserToken(subj)) { resolvedRole = 'user'; }

    // 2) KEY PREFIX: the generic `char_*` / `user_*` namespace. Resolve EVEN when the subject was
    //    an explicit real name but the key kept the generic prefix (belt-and-suspenders), and infer
    //    the role from the key prefix when the subject was absent/generic.
    const key = String(update.key || '').trim().toLowerCase();
    const firstTok = key.indexOf('_') > 0 ? key.slice(0, key.indexOf('_')) : key;
    let keyRole = null;
    if (isReservedCharToken(firstTok)) keyRole = 'char';
    else if (isReservedUserToken(firstTok)) keyRole = 'user';
    if (!resolvedRole && keyRole) resolvedRole = keyRole;

    if (!resolvedRole) return; // nothing generic to resolve — leave real-name facts untouched

    const realName = resolvedRole === 'user' ? userName : charName;
    const realToken = nameToKeyToken(realName);
    // No usable real name (unnamed character / missing persona): leave the fact as-is rather than
    // mint an empty prefix. The defensive deriveSubject in database.js still avoids storing the
    // bare literal "char"/"user" as a subject downstream.
    if (!realName || !realToken) return;

    const beforeSubject = update.subject;
    const beforeKey = update.key;

    // Apply to subject.
    update.subject = realName;

    // Apply to the key prefix: rewrite ONLY the leading generic token, preserving the rest of the
    // key (`char_physical_state` → `<name>_physical_state`). A key with no generic prefix is left
    // alone (so an already-real-name key like `<name>_*` is never double-prefixed/renamed).
    if (keyRole) {
        const us = key.indexOf('_');
        const tail = us > 0 ? key.slice(us + 1) : '';
        update.key = tail ? `${realToken}_${tail}` : realToken;
    }

    if (beforeSubject !== update.subject || beforeKey !== update.key) {
        addDebugLog('debug', `Resolved generic ${resolvedRole} → "${realName}": ${beforeKey} (subj:${beforeSubject || '∅'}) → ${update.key} (subj:${update.subject})`, {
            subsystem: 'agent3', event: 'fact.subject_resolved', reason: resolvedRole === 'user' ? 'GENERIC_USER' : 'GENERIC_CHAR',
            data: { role: resolvedRole, name: realName, beforeKey, afterKey: update.key, beforeSubject, afterSubject: update.subject },
        });
    }
}

/**
 * Apply parsed updates to databases and save.
 *
 * For each update, determine whether it actually changed stored state (FIX #5):
 *   - NEW     : no existing fact matched this key — a brand-new fact was added.
 *   - UPDATED : an existing fact matched and its value or tags changed.
 *   - SKIPPED : an existing fact matched and value + tags are identical (no-op).
 * Each update is annotated with `.status` and `.changed`, and `.wasNew` is kept
 * for backward compatibility. Returns the subset that actually changed state
 * (status NEW or UPDATED) so the caller can feed "Last Inserted" the truly
 * committed facts rather than the full proposed set.
 *
 * @param {Array} updates - Parsed fact updates (mutated in place: annotated)
 * @param {Object} existingDatabases - Current databases
 * @returns {Promise<Array>} the changed (committed) subset of updates
 */
async function applyUpdates(updates, existingDatabases) {
    const modified = new Set();
    const applied = [];

    // AUTOMATIC ASSOCIATIVE LINKING (A-MEM style, lexical, deterministic, zero-API). Default ON;
    // gated by `enableAutoLinking` (a free + deterministic feature, so it defaults true). We build
    // the in-memory fact index ONCE here, BEFORE the write loop, capturing the PRE-BATCH state.
    //
    // ORDERING/CORRECTNESS ARGUMENT: each saveDatabase() below invalidates the shared per-turn
    // index (getMemoryIndex), so we deliberately do NOT call getMemoryIndex() inside the loop
    // (that would force an O(all-facts) rebuild per write). Instead we hold a single pre-batch
    // snapshot built from `existingDatabases` (the map being mutated). New facts added earlier in
    // THIS batch are simply not yet candidates — acceptable and provably non-looping: the next
    // turn's index includes them, and the earlier fact may already have linked forward. The index
    // references the same active fact objects, so links target real stored facts by identity.
    const autoLinkOn = getSettingsSafe()?.enableAutoLinking !== false; // absent => ON (default true)
    const linkIndex = autoLinkOn ? buildMemoryIndex(existingDatabases) : null;

    for (const update of updates) {
        const category = update.category;

        // Get or create database
        if (!existingDatabases[category]) {
            existingDatabases[category] = createEmptyDatabase(category);
            addDebugLog('info', `Created new database: "${category}"`);
        }

        const db = existingDatabases[category];

        // Classify BEFORE writing, using the same match rule upsertFact uses.
        // Sequence facts (Feature #4) are exempt from normalized collapse, so they
        // match ONLY by exact key — a fresh step is correctly classified NEW instead
        // of UPDATED against a sibling step that shares the normalized key.
        const matched = update.track
            ? (db.facts.find(f => f.key === update.key) || null)
            : findFactMatch(db, update.key);
        const newValue = update.value || '';
        const newTags = update.tags || [];
        let status;
        if (!matched) {
            status = 'NEW';
        } else if (sameValue(matched.value, newValue) && sameTags(matched.tags, newTags)) {
            status = 'SKIPPED'; // no-op: value + tags identical to stored fact
        } else {
            status = 'UPDATED';
        }

        // Surface status to pipeline.js so the Last Inserted tab can show it.
        update.status = status;
        update.changed = status !== 'SKIPPED';
        update.wasNew = status === 'NEW'; // kept for backward compatibility

        const factToWrite = {
            key: update.key,
            value: newValue,
            tags: newTags,
            knownBy: update.knownBy || [],
            relationships: {
                primary: Array.isArray(update.relationships) ? update.relationships : [],
                secondary: [],
                tertiary: [],
            },
            source: update.source,
        };
        // Feature #3 / #4: forward optional context + sequence info so upsertFact can
        // store the note and treat track facts as exempt-from-collapse ordered steps.
        if (update.context) factToWrite.context = update.context;
        if (update.track) {
            factToWrite.track = update.track;
            if (Number.isInteger(update.ord) && update.ord > 0) factToWrite.ord = update.ord;
        }
        // Salience feature: forward importance/kind so upsertFact can merge (keep higher
        // importance) and persist them for eviction + retrieval scoring. These are now
        // always present (stated or inferred in the parser).
        if (Number.isInteger(update.importance)) factToWrite.importance = update.importance;
        if (update.kind) factToWrite.kind = update.kind;
        // Layer-2 aspect (3-layer model): forward the resolved aspect so the menu/branch
        // axis is stored on the fact (always present after parse).
        if (update.aspect) factToWrite.aspect = update.aspect;
        // Subject axis (feature): forward the (explicit-or-derived) subject so it's stored
        // as a real index axis. Confidence/validAt are provenance stamps (back-compat optional).
        if (update.subject) factToWrite.subject = update.subject;
        // Scope (feature): forward the (explicit-or-inferred) recall axis so deriveSubject/
        // retrieval can file place facts under the place and traverse place⇄event⇄people.
        if (update.scope) factToWrite.scope = update.scope;
        // Involved (feature): forward participants (writer-given or auto-filled) when present.
        if (Array.isArray(update.involved) && update.involved.length) factToWrite.involved = update.involved;
        // NPC drawer (feature): forward the provisional descriptor for a later promotion step.
        if (update.about) factToWrite.about = update.about;
        // Location-link (feature): forward the event's where-link when present.
        if (update.location) factToWrite.location = update.location;
        // Episodic-memory (feature): forward the moment's short emotional `tone` when present
        // (clamped at parse time + defensively in upsertFact).
        if (update.tone) factToWrite.tone = update.tone;
        // Episodic-memory (feature): make episodic captures inspectable — log when a `moment`-kind
        // fact is written (debug level), with key + tone + location so the beat is auditable.
        if (update.kind === 'moment') {
            addDebugLog('debug', `Moment captured: [${category}] ${update.key}${update.tone ? ` (${update.tone})` : ''}`, {
                subsystem: 'agent3', event: 'fact.moment',
                data: { category, key: update.key, tone: update.tone || '', location: update.location || '' },
            });
        }
        if (update.confidence !== undefined && update.confidence !== null && update.confidence !== '') {
            factToWrite.confidence = update.confidence;
        }
        if (Number.isInteger(update.validAt)) factToWrite.validAt = update.validAt;
        // Bi-temporal (feature): forward story-world validity window (`from:`/`until:`) when present
        // so upsertFact can persist + supersession-stamp it. Only set when biTemporal parsed them,
        // so back-compat facts simply lack these fields. DISTINCT from `validAt` (ordering integer).
        if (update.validFrom) factToWrite.validFrom = update.validFrom;
        if (update.validUntil) factToWrite.validUntil = update.validUntil;
        // SCENE + SOURCE STRANDS (Spiderweb 2): forward the origin scene + source-message handle so
        // upsertFact stores them. First-wins is enforced in mergeSalience (the origin scene is kept
        // across re-mentions, mirroring validAt). Only attached when present (lean / back-compat).
        if (Number.isInteger(update.sceneNo)) factToWrite.sceneNo = update.sceneNo;
        if (update.sceneName) factToWrite.sceneName = update.sceneName;
        if (update.sourceMsg) factToWrite.sourceMsg = update.sourceMsg;
        // Supersession feature: forward the explicit signal so upsertFact marks the prior
        // value of a changeable-state fact as superseded history (transient flag, not persisted).
        if (update.supersedes) factToWrite.supersedes = true;
        // Layer A: forward aliases so upsertFact can UNION them (dedupe) across re-mentions.
        if (Array.isArray(update.aliases) && update.aliases.length) factToWrite.aliases = update.aliases;
        upsertFact(db, factToWrite);

        // AUTO-LINK (deterministic, zero-API): for a fact that actually changed state, connect it
        // to related EXISTING facts by recording links into its `relationships` (UNION, never
        // clobber). We re-find the stored fact (upsertFact may have re-keyed via parallel-state
        // dedup) and link against the PRE-BATCH index snapshot. The mutation rides the existing
        // saveDatabase() below (no extra write). SKIPPED no-ops are skipped — nothing changed.
        if (autoLinkOn && update.changed && linkIndex) {
            const stored = findFactMatch(db, factToWrite.key);
            if (stored) autoLinkFact(linkIndex, stored, category, update.source);
        }

        const relCount = update.relationships?.length || 0;
        // Spiderweb 2: surface the fact's origin scene stamp on the NEW/UPDATED line (debug aid).
        const sceneTag = Number.isInteger(update.sceneNo) ? ` (scene ${update.sceneNo}${update.sceneName ? ` "${update.sceneName}"` : ''})` : '';
        addDebugLog('info', `${status} fact: [${category}] ${update.key} = "${newValue.substring(0, 80)}"${relCount > 0 ? ` (rel: ${relCount})` : ''}${sceneTag}`);

        if (update.changed) applied.push(update);
        // Only re-save a category whose stored state actually changed — a run of
        // pure SKIPPED no-ops needn't trigger an attachment re-upload.
        if (update.changed) modified.add(category);
    }

    // Save all modified databases — IN PARALLEL. These are independent per-category IndexedDB
    // writes; awaiting them serially (the old `for ... await`) stacked their round-trips on the
    // post-reply path, contributing to the main-thread stall + ST's "Timeout waiting for chat to
    // save" at large stores. Promise.all overlaps the I/O. Each save is individually try/caught so
    // one failure can't reject the batch and lose the others.
    await Promise.all([...modified].map(async (category) => {
        try {
            await saveDatabase(existingDatabases[category]);
            const factCount = existingDatabases[category].facts.length;
            addDebugLog('pass', `Saved database "${category}" (${factCount} facts)`);
        } catch (error) {
            addDebugLog('fail', `Failed to save database "${category}": ${error.message}`);
        }
    }));

    return applied;
}

/** Loose value equality for no-op detection (trim + case-insensitive). */
function sameValue(a, b) {
    return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}

/** Order-insensitive tag-set equality for no-op detection. */
function sameTags(a, b) {
    const norm = arr => (Array.isArray(arr) ? arr : [])
        .map(t => String(t).trim().toLowerCase())
        .filter(Boolean)
        .sort();
    const x = norm(a), y = norm(b);
    if (x.length !== y.length) return false;
    return x.every((v, i) => v === y[i]);
}

/**
 * Legacy fallback: parse old #Facts: JSON format (for cached prompts that haven't been reset)
 */
function parseLegacyJsonFormat(response, messageIndex) {
    const result = { updates: [], summary: '', raw: response, error: null };

    const summaryMatch = response.match(/#Summary:?\s*([\s\S]*?)$/i);
    if (summaryMatch) result.summary = summaryMatch[1].trim();

    const factsMatch = response.match(/#Facts:?\s*([\s\S]*?)(?=#Summary|$)/i);
    if (!factsMatch || factsMatch[1].trim() === '(none)') return result;

    // Extract JSON objects via brace counting
    const text = factsMatch[1].trim();
    let i = 0;
    while (i < text.length) {
        if (text[i] === '{') {
            let depth = 0, start = i;
            while (i < text.length) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') { depth--; if (depth === 0) break; }
                i++;
            }
            try {
                const fact = JSON.parse(text.substring(start, i + 1));
                if (fact.category && fact.key) {
                    result.updates.push({
                        action: 'add',
                        category: fact.category,
                        key: fact.key,
                        value: fact.value || '',
                        tags: fact.tags || [],
                        knownBy: fact.knownBy || [],
                        source: `msg_${messageIndex}`,
                    });
                }
            } catch { /* skip malformed */ }
        }
        i++;
    }

    addDebugLog('info', `Parsed legacy JSON format (${result.updates.length} facts). Reset your Memory Updater prompt for the new compact format.`);
    return result;
}

/**
 * @typedef {Object} MemoryUpdateResult
 * @property {Array} updates - Parsed fact updates
 * @property {string} summary - Human-readable summary
 * @property {string} raw - Raw LLM response
 * @property {string|null} error
 */
