// BF Memory Pipeline - the MEMORY AGENT (redesign-v2, S3)
// =============================================================================
// The merged Drafter+Scribe: ONE background LLM tool-loop session per settled reply that
//   (a) anticipates where the scene is going and which stored memories the NEXT reply needs,
//   (b) extracts new LASTING facts from the SETTLED messages (never from TENTATIVE ones),
//   (c) emits the updated persistent MEMORY SHEET (#SHEET block).
// Transport is the TEXT tool protocol (G1): the agent replies with lines of strict one-line
// JSON tool calls (list_categories -> list_keys -> read_facts -> write_fact / search) executed
// by memory-tools.js via llm-call.js's callAgentLLMWithTools loop — works on ANY backend, no
// provider function-call API.
//
// F-SCRIBE-1 (generalized): a failed run — loop error, missing #SHEET, unparseable sheet —
// returns { error } and the caller commits nothing new, KEEPS the previous sheet, and does NOT
// watermark the messages, so no exchange is ever silently lost.
//
// PERSISTENCE CONTRACT: write_fact (memory-tools.js) mutates the live in-memory database map
// and records changes on ctx.applied / ctx.touchedCategories; THIS module saves each touched
// category ONCE after the loop (plus any use-it-or-lose-it bump categories). The durable
// profile snapshot (saveCurrentToActiveProfile) stays with the caller, as today.

import {
    getAllDatabases,
    getMemoryIndex,
    saveDatabase,
    applyBufferedFactUsage,
    findFactMatch,
    mapLegacyCategory,
    isActiveFact,
    summarizeKeys,
    summarizeMenuIndexed,
    groupedTaxonomyMenu,
} from './database.js';
import { isFactVisible, buildFactLine, expandLinks, retrievalSalience } from './fact-retrieval.js';
import {
    getTurnNowContext, splitInjectionSections, buildPrecedencePreamble,
    STATE_SECTION_HEADER, CHRONO_SECTION_HEADER,
} from './recency.js';
import { callAgentLLMWithTools } from './llm-call.js';
import { executeMemoryTool } from './memory-tools.js';
import { addDebugLog } from './settings.js';
import * as host from './host.js';

// Lazy settings read (avoids a static settings.js cycle at module-eval time).
function getSettingsSafe() {
    try { return host.getExtensionSettings(); } catch { return null; }
}

// ── Prompt-size guards (per-run user prompt) ─────────────────────────────────
const KEY_INVENTORY_CAP = 200;   // max Category/key inventory lines shown (list_keys covers the rest)
const NEED_REFS_CAP = 15;        // max NEED refs honored from the #SHEET block (G1)

// TEMPORAL GROUNDING rule (G4 hardcoded-ON; kept from the old Scribe prompt). Relative time
// words rot ("yesterday" is meaningless once stored), so the agent anchors them to the
// "## Observation date" supplied in the user data block. Static suffix — cache-stable.
export const TEMPORAL_GROUNDING_RULE = `

# OBSERVATION DATE (TIME GROUNDING)
The user data block gives a \`## Observation date\` (the real-world time the newest message was observed). Resolve RELATIVE time expressions to ABSOLUTE dates relative to it — e.g. "yesterday" → the day before that date, "last week" → "the week of <date>", "two years ago" → the year. Store the absolute form (in the value or note), not the relative word, so the fact doesn't rot. If no observation date is given, leave time expressions as-is.`;

// ── The static system rulebook ────────────────────────────────────────────────
// CACHE CONTRACT (llm-call.js): this string must stay BYTE-STABLE across chats/characters so
// the host's server-side prompt cache can reuse the prefix. The {{user}}/{{char}} macros stay
// LITERAL here; every per-run variable (character brief, persona, DB overview, taxonomy MENU —
// which is per-store variable via the user overlay — messages, prior sheet) lives in the USER
// prompt built by runMemoryAgent. Never interleave variable data into this block.
export const DEFAULT_MEMORY_AGENT_PROMPT = `You are the MEMORY AGENT for an ongoing roleplay between {{user}} (the human player) and {{char}} (the AI character). You run in the BACKGROUND after each reply — the storyteller model never sees you, only the MEMORY SHEET you produce. You do TWO jobs in one session:

1. EXTRACT — store new LASTING facts from the SETTLED messages into the memory database (write_fact).
2. ANTICIPATE — work out where the scene is going and which stored memories the NEXT reply will need, then emit the updated MEMORY SHEET.

# TOOL PROTOCOL (plain text — no function-call API)

To use a tool, reply with tool-call lines. Each tool call is ONE line of strict JSON, alone on its line:
{"tool":"list_categories"}
{"tool":"list_keys","args":{"category":"People"}}
{"tool":"read_facts","args":{"category":"People","keys":["monika_name","monika_mood"]}}
{"tool":"write_fact","args":{"category":"People","key":"monika_mood","value":"...","note":"...","known_by":["Monika"],"aspect":"mood","importance":3}}
{"tool":"search","args":{"query":"who owns the bakery"}}

After your reply, the system executes the calls and sends the results back as one user message starting with "TOOL RESULTS:". You may then call more tools or finish. You may emit several tool-call lines in one reply. Do NOT wrap calls in markdown fences; do NOT pretty-print the JSON across lines.

TOOLS:
- list_categories — every category with its active fact count. Start here when unsure what exists.
- list_keys {category} — one line per stored fact: key | aspect | value preview.
- read_facts {category, keys[]} — the full stored line for each requested key.
- search {query} — keyword search across the whole store.
- write_fact {category, key, value, note?, known_by?, aspect?, importance?, kind?} — store one fact (or update the key's current value).

HARD LIMITS: at most 6 rounds (replies by you) and 20 tool calls per session. Be economical: usually one read round (list/search what's relevant), then ONE final reply with your write_fact lines followed by the #SHEET block.

# FINAL BLOCK

End your LAST reply with the final block. It starts with a line that is exactly \`#SHEET\` and runs to the end of the reply:

#SHEET
SUMMARY: <1-4 sentence rolling story summary — carry the prior sheet's summary forward, updated with what just happened>
SCENE: <one line: location; who is present; current goal or tension>
NEED: Category/key, Category/key, ...
NOTES: <optional 1-2 lines anticipating the next scene>

- SUMMARY is REQUIRED. SCENE should almost always be present. NEED and NOTES may be omitted.
- NEED lists 0-15 stored facts (exact Category/key refs you VERIFIED with the tools — never invented) the NEXT reply needs: the people present and their current state, the pair's relationship status, open threads/promises, the history this scene is about to touch. The system renders those facts onto the sheet for you.
- write_fact lines MAY appear in the same reply, BEFORE the #SHEET block (they are executed, then the sheet is accepted). Read tools in that reply are ignored.
- EXTRACT-ONLY runs (the task block says so): do NOT emit #SHEET; end with a line that is exactly \`#DONE\` instead.

# WHAT TO STORE (write_fact)

Store LASTING facts only — what the STORY still tracks 50 messages from now. Many turns have ZERO new facts; a dense reveal turn (introductions, backstory, world lore, confessions) can have many. Read dialogue, not just narration — confessions, opinions, promises, and reveals live in quotes.

- ATOMIC values: 1-5 words per fact (a genuine backstory reveal may use up to 10). One property per fact; split multi-attribute statements into several write_fact calls. Encode the verb in the KEY (\`monika_eyes\` = \`green\`, not \`monika\` = "has green eyes").
- key: snake_case, prefixed by the subject's name (\`monika_fear_storms\`, \`bernd_job\`). Reuse an EXISTING key (verified via tools) when updating a changeable state — the system keeps the old value as history.
- category: one of the Layer-1 categories from the menu in the task block (People, Places, Things, Relationships, Events, World, Unsorted). Unsorted is the catch-all for genuinely unclear facts.
- aspect: the most specific LEAF label within the category (see the taxonomy menu in the task block), e.g. \`fears\`, \`career\`, \`tattoos\`. A near-miss is snapped to the canonical leaf; if nothing fits, use category Unsorted with aspect \`misc\`.
- importance: 1-5 (5 = core identity like a name/species, 4 = important, 3 = ordinary, 2 = minor, 1 = trivial).
- kind: \`trait\` (durable identity), \`state\` (current/transient — mood, location, goal), \`event\` (something that happened), \`moment\` (a significant emotional scene beat, remembered with feeling).
- note: optional short prose — a meaningful verbatim quote, a disambiguation, or a one-line summary of a complex beat. Keep the atomic value TOO.
- known_by: ONLY for secrets/restricted knowledge (list who knows). Omit for anything openly shared — it defaults to the present pair.
- RELATIONSHIPS: file pair dynamics under Relationships with a stable pair key (\`monika_bernd_status\`, \`monika_bernd_trust\`) and an abstract aspect (trust/romance/debt/status_of_relationship). Update the pair's single status record when the dynamic MATERIALLY changes.

DO NOT STORE: transient poses/moods, scene atmosphere, food eaten, items momentarily in hand, [OOC:] meta, reported/historical speech, negative facts ("no favorite revealed"). DELTA-ONLY: never re-write a fact whose stored value is unchanged (check with the tools first — an identical re-write is wasted work).

# TENTATIVE MESSAGES

Messages in the block marked "TENTATIVE" may still be swiped/edited. They may inform your SCENE/NEED/NOTES planning, but you MUST NOT write_fact anything from them — extract only from the SETTLED messages.` + TEMPORAL_GROUNDING_RULE;

// ── runMemoryAgent ────────────────────────────────────────────────────────────

/**
 * Run ONE Memory Agent session: tool loop → fact writes → (unless extractOnly) sheet.
 *
 * Message shape for settledMessages/tentativeMessages: { index:number, role:'USER'|'CHAR',
 * name:string, text:string } — index is the absolute chat index (used for source attribution
 * of writes), name the display author (group speaker / persona).
 *
 * @param {Object} opts
 * @param {Array}  [opts.settledMessages=[]]  - SAFE-to-extract messages (oldest first)
 * @param {Array}  [opts.tentativeMessages=[]] - hold-back window, planning context only
 * @param {string} [opts.characterInfo='']    - short character brief
 * @param {string} [opts.userPersona='']      - persona description
 * @param {string|null} [opts.profileId=null] - Memory Agent connection profile (CMRS)
 * @param {string} [opts.priorSheetText='']   - the sheet the writer currently sees
 * @param {Object|null} [opts.reflection=null] - turn-state getReflection() record
 * @param {Object|null} [opts.scene=null]     - turn-state getScene() card
 * @param {string} [opts.observationDate='']  - ISO real-world timestamp of the newest message
 * @param {string} [opts.runId='']            - correlation id for logs / write attribution
 * @param {boolean} [opts.extractOnly=false]  - catchup/backfill mode: writes only, #DONE final
 * @param {AbortSignal|null} [opts.signal=null] - caller-owned abort
 * @returns {Promise<{sheetText:string|null, applied:Array, error:string|null,
 *   tokensIn:number, tokensOut:number, rounds:number, toolCallCount:number}>}
 */
export async function runMemoryAgent({
    settledMessages = [],
    tentativeMessages = [],
    characterInfo = '',
    userPersona = '',
    profileId = null,
    priorSheetText = '',
    reflection = null,
    scene = null,
    observationDate = '',
    runId = '',
    extractOnly = false,
    signal = null,
} = {}) {
    const result = { sheetText: null, applied: [], error: null, tokensIn: 0, tokensOut: 0, rounds: 0, toolCallCount: 0 };
    const settings = getSettingsSafe() || {};

    let databases, index;
    try {
        databases = await getAllDatabases();
        index = await getMemoryIndex();
    } catch (e) {
        result.error = `memory store unavailable: ${e?.message || e}`;
        addDebugLog('fail', `[${runId}] Memory Agent aborted — ${result.error}`, {
            subsystem: 'agent3', event: 'agent.run', reason: 'STORE_UNAVAILABLE',
        });
        return result;
    }

    // USE-IT-OR-LOSE-IT: drain the use buffer staged by prior injections onto these freshly
    // loaded fact objects BEFORE this run's writes; the bumped categories ride this run's
    // per-category saves below (only persisted on a SUCCESSFUL run — same as before, where the
    // bumps rode the extraction's saves).
    let usageBumpCats = [];
    try { usageBumpCats = applyBufferedFactUsage(databases, runId) || []; } catch { /* best-effort */ }

    // Source attribution for write_fact: the NEWEST settled message index (facts come only from
    // settled messages). No settled messages (sheet-only run) → agent_<runId> fallback in S2.
    let sourceIndex = null;
    for (const m of (Array.isArray(settledMessages) ? settledMessages : [])) {
        if (Number.isInteger(m?.index) && (sourceIndex === null || m.index > sourceIndex)) sourceIndex = m.index;
    }

    const ctx = {
        runId,
        databases,
        index,
        settings,
        applied: [],
        touchedCategories: new Set(),
    };
    if (sourceIndex !== null) ctx.sourceIndex = sourceIndex;

    const userPrompt = buildAgentUserPrompt({
        settledMessages, tentativeMessages, characterInfo, userPersona,
        priorSheetText, reflection, scene, observationDate, extractOnly,
        databases, index, settings,
    });

    addDebugLog('info', `[${runId}] Memory Agent start: ${settledMessages.length} settled, ${tentativeMessages.length} tentative msg(s), extractOnly=${extractOnly} (user prompt ${userPrompt.length} chars)`, {
        subsystem: 'agent3', event: 'agent.start',
        data: { settled: settledMessages.length, tentative: tentativeMessages.length, extractOnly, userPromptChars: userPrompt.length, profileId: profileId || null },
    });

    const loop = await callAgentLLMWithTools({
        systemPrompt: DEFAULT_MEMORY_AGENT_PROMPT,
        userPrompt,
        profileId,
        agent: 'memory-agent',
        maxRounds: 6,
        maxToolCalls: 20,
        executeTool: (call) => executeMemoryTool(call, ctx),
        extractOnly,
        signal,
    });

    result.rounds = loop.rounds;
    result.toolCallCount = loop.toolCallCount;
    result.tokensIn = loop.tokensInApprox || 0;
    result.tokensOut = loop.tokensOutApprox || 0;
    result.applied = ctx.applied;

    // F-SCRIBE-1 (generalized): a loop error, or a missing sheet where one was required, is a
    // FAILED run — nothing is saved, the caller keeps the prior sheet and does NOT watermark.
    // (Tool writes may have mutated the in-memory map; they are NOT persisted here, and the
    // per-turn DB cache is reloaded from disk on the next invalidation.)
    if (loop.error) {
        result.error = loop.error;
        return result;
    }
    if (!extractOnly && (!loop.sheet || !String(loop.sheet).trim())) {
        result.error = 'memory agent finished without a #SHEET block';
        return result;
    }

    // Parse the sheet BEFORE persisting anything, so an unparseable sheet fails the whole run
    // atomically (no watermark, facts re-proposed next turn and deduped by the upsert reconcile).
    let parsedSheet = null;
    if (!extractOnly) {
        parsedSheet = parseSheetBlock(loop.sheet);
        if (parsedSheet.error) {
            result.error = `unusable #SHEET block: ${parsedSheet.error}`;
            return result;
        }
    }

    // Persist: ONE saveDatabase per touched category (write_fact + cross-key supersede side
    // effects), plus any use-bump-only categories. The durable profile snapshot stays with the
    // caller (saveCurrentToActiveProfile — the flushSnapshotNow debounce rides saveDatabase).
    const toSave = new Set(ctx.touchedCategories);
    for (const cat of usageBumpCats) toSave.add(cat);
    for (const cat of toSave) {
        if (!databases[cat]) continue;
        try {
            await saveDatabase(databases[cat]);
            addDebugLog('pass', `[${runId}] Saved database "${cat}" (${databases[cat].facts.length} facts)`);
        } catch (e) {
            addDebugLog('fail', `[${runId}] Failed to save database "${cat}": ${e?.message || e}`);
        }
    }

    if (!extractOnly) {
        result.sheetText = composeSheet({
            summary: parsedSheet.summary,
            sceneLine: parsedSheet.sceneLine,
            notes: parsedSheet.notes,
            need: parsedSheet.need,
            settings,
            databases,
        });
    }

    addDebugLog('pass', `[${runId}] Memory Agent done: ${ctx.applied.length} write(s), ${loop.rounds} round(s), ${loop.toolCallCount} tool call(s)${result.sheetText ? `, sheet ${result.sheetText.length} chars` : ''}`, {
        subsystem: 'agent3', event: 'agent.run',
        data: {
            agent: 'memory-agent', profileId: profileId || null, success: true, extractOnly,
            applied: ctx.applied.length, rounds: loop.rounds, toolCallCount: loop.toolCallCount,
            sheetChars: result.sheetText ? result.sheetText.length : 0,
            tokensIn: result.tokensIn, tokensOut: result.tokensOut,
        },
    });
    return result;
}

// ── User-prompt build (all per-run variable data lives HERE, never in the system prompt) ─────

/** Render one message line for the prompt: `#12 [USER: Bernd] text`. */
function renderMessageLine(m) {
    const idx = Number.isInteger(m?.index) ? `#${m.index} ` : '';
    const role = m?.role === 'USER' ? 'USER' : 'CHAR';
    const name = String(m?.name || '').trim();
    return `${idx}[${role}${name ? `: ${name}` : ''}] ${String(m?.text || '').trim()}`;
}

/** Render the scene card compactly for the prompt ('' when absent). */
function renderSceneCard(scene) {
    if (!scene || typeof scene !== 'object') return '';
    const bits = [];
    if (Number.isInteger(scene.sceneNo)) bits.push(`Scene #${scene.sceneNo}${scene.sceneName ? ` "${scene.sceneName}"` : ''}`);
    if (scene.location) bits.push(`Location: ${scene.location}`);
    if (Array.isArray(scene.present) && scene.present.length) bits.push(`Present: ${scene.present.join(', ')}`);
    if (Array.isArray(scene.goals) && scene.goals.length) bits.push(`Goals: ${scene.goals.join('; ')}`);
    if (Array.isArray(scene.beats) && scene.beats.length) bits.push(`Recently: ${scene.beats.join('; ')}`);
    return bits.join('\n');
}

/** Cap a multi-line block at `max` lines with a "+N more" footer. */
function capLines(text, max, footer) {
    const lines = String(text || '').split('\n').filter(Boolean);
    if (lines.length <= max) return lines.join('\n');
    return lines.slice(0, max).join('\n') + `\n... (+${lines.length - max} more — ${footer})`;
}

function buildAgentUserPrompt({
    settledMessages, tentativeMessages, characterInfo, userPersona,
    priorSheetText, reflection, scene, observationDate, extractOnly,
    databases, index, settings,
}) {
    const parts = [];

    // Run mode first — the rulebook's EXTRACT-ONLY / #SHEET branch keys off this.
    parts.push('## Task\n' + (extractOnly
        ? 'EXTRACT-ONLY RUN: store new lasting facts from the settled messages via write_fact, then end with the #DONE line. Do NOT emit a #SHEET block.'
        : 'FULL RUN: store new lasting facts from the settled messages, anticipate the next scene, then end with the #SHEET block.'));

    if (observationDate) parts.push(`## Observation date: ${observationDate}`);
    if (characterInfo) parts.push(`## Character Info ({{char}})\n${characterInfo}`);
    if (userPersona) parts.push(`## User Persona ({{user}})\n${userPersona}`);

    const sceneBlock = renderSceneCard(scene);
    if (sceneBlock) parts.push(`## Current scene\n${sceneBlock}`);

    const reflSummary = (reflection && typeof reflection.summary === 'string') ? reflection.summary.trim() : '';
    if (reflSummary) parts.push(`## Story so far (rolling reflection summary)\n${reflSummary}`);

    if (!extractOnly) {
        parts.push(`## Prior memory sheet (what the writer currently sees — update it)\n${String(priorSheetText || '').trim() || '(none yet)'}`);
    }

    // DB overview: populated aspect drawers with counts + a capped Category/key inventory.
    // Deliberately compact — the layered tools (list_keys/read_facts/search) are the real
    // navigation; this just orients the agent and powers DELTA-ONLY checks.
    try {
        const menu = summarizeMenuIndexed(index);
        const keys = capLines(summarizeKeys(databases), KEY_INVENTORY_CAP, 'use list_keys');
        const overview = [menu && `Populated drawers (aspect(count)):\n${menu}`, keys && `Stored keys:\n${keys}`]
            .filter(Boolean).join('\n\n');
        parts.push(`## Memory database overview\n${overview || '(store is empty)'}`);
    } catch { parts.push('## Memory database overview\n(unavailable)'); }

    try {
        parts.push(`## Taxonomy menu (Category ▸ SubArea: leaf aspects)\n${groupedTaxonomyMenu()}`);
    } catch { /* menu is best-effort */ }

    if (Array.isArray(settledMessages) && settledMessages.length > 0) {
        parts.push(`## SETTLED messages (safe — extract facts from these)\n${settledMessages.map(renderMessageLine).join('\n\n')}`);
    } else {
        parts.push('## SETTLED messages\n(none this run — do NOT call write_fact; just refresh the sheet from the store and the tentative context)');
    }

    if (Array.isArray(tentativeMessages) && tentativeMessages.length > 0) {
        parts.push(`## TENTATIVE — do not store facts from these (planning context only):\n${tentativeMessages.map(renderMessageLine).join('\n\n')}`);
    }

    // User's extra instructions (the memoryPrompt override — appended, never replacing the
    // static rulebook, so the cacheable system prefix stays byte-stable).
    const extra = String(settings?.memoryPrompt || '').trim();
    if (extra) parts.push(`## Additional instructions from the user\n${extra}`);

    parts.push(extractOnly
        ? 'Work now: check the store with tools where needed, write the new lasting facts, then end with the #DONE line.'
        : 'Work now: check the store with tools where needed, write the new lasting facts, then end with the #SHEET block.');

    // Resolve {{user}}/{{char}} macros in the data block via ST's canonical substituteParams.
    try {
        const substitute = host.getSubstituteParams();
        return substitute(parts.join('\n\n'));
    } catch {
        return parts.join('\n\n');
    }
}

// ── parseSheetBlock ───────────────────────────────────────────────────────────

/**
 * Parse the raw text after the `#SHEET` line into its fields (G1 final-block grammar).
 * Tolerant: missing NEED/NOTES (and even SCENE) are fine; continuation lines under a header
 * are folded into that field; markdown fences are skipped. Missing SUMMARY → error.
 * @param {string} text - raw sheet block (parseAgentReply's `sheet`)
 * @returns {{summary:string, sceneLine:string, need:Array<{category:string,key:string}>, notes:string, error:string|null}}
 */
export function parseSheetBlock(text) {
    const out = { summary: '', sceneLine: '', need: [], notes: '', error: null };
    const raw = String(text ?? '').trim();
    if (!raw) {
        out.error = 'empty sheet block';
        return out;
    }
    const buf = { SUMMARY: [], SCENE: [], NEED: [], NOTES: [] };
    let current = null;
    for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim();
        if (!line || /^```/.test(line)) continue;
        const m = /^(SUMMARY|SCENE|NEED|NOTES)\s*:\s*(.*)$/i.exec(line);
        if (m) {
            current = m[1].toUpperCase();
            if (m[2].trim()) buf[current].push(m[2].trim());
            continue;
        }
        // Continuation line of the current field (headerless preamble lines are ignored).
        if (current) buf[current].push(line);
    }
    out.summary = buf.SUMMARY.join(' ').trim();
    out.sceneLine = buf.SCENE.join(' ').trim();
    out.notes = buf.NOTES.join(' ').trim();

    // NEED: comma-separated `Category/key` refs (across all NEED lines), capped.
    for (const ref of buf.NEED.join(',').split(',')) {
        const r = ref.trim().replace(/^[-*]\s*/, '');
        if (!r || /^\(?none\)?$/i.test(r)) continue;
        const slash = r.indexOf('/');
        if (slash <= 0) continue;
        const category = r.slice(0, slash).trim();
        const key = r.slice(slash + 1).trim();
        if (!category || !key) continue;
        out.need.push({ category, key });
        if (out.need.length >= NEED_REFS_CAP) break;
    }

    if (!out.summary) out.error = 'missing SUMMARY line';
    return out;
}

// ── composeSheet ──────────────────────────────────────────────────────────────

/** Clamp helper for settings knobs (mirrors validateSettings semantics). */
function clampNum(v, min, max, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
}

/**
 * Render the persistent MEMORY SHEET from the agent's parsed final block (G3). PURE CODE —
 * no LLM: NEED refs resolve via findFactMatch (missing skipped, knownBy/POV enforced), split
 * into CURRENT STATE / CHRONOLOGY (recency.js truth hierarchy) with always-on recency tails,
 * then up to graphExtrasCount deterministically link-expanded bonus facts ("Connected
 * memories", anti-hub caps inside expandLinks, ordered by retrievalSalience which folds in
 * confidence). The fact lines are token-capped by retrievalTokenBudget (~4 chars/token,
 * matching estimateInjectionTokens' approximation).
 * @param {{summary?:string, sceneLine?:string, notes?:string,
 *          need?:Array<{category:string,key:string}>, settings?:Object, databases?:Object}} opts
 * @returns {string} the rendered sheet (never empty when summary is non-empty)
 */
export function composeSheet({ summary = '', sceneLine = '', notes = '', need = [], settings = {}, databases = {} } = {}) {
    let nowCtx = null;
    try { nowCtx = getTurnNowContext(); } catch { nowCtx = null; }

    // 1) Resolve the NEED refs to live, visible facts (dedup by category:key).
    const rows = [];
    const seen = new Set();
    for (const ref of (Array.isArray(need) ? need : []).slice(0, NEED_REFS_CAP)) {
        try {
            const category = mapLegacyCategory(String(ref?.category || '').trim() || 'Unsorted');
            const key = String(ref?.key || '').trim();
            if (!key) continue;
            const db = databases[category];
            if (!db) continue;
            const fact = findFactMatch(db, key);
            if (!fact || !isActiveFact(fact) || !isFactVisible(fact)) continue; // skip missing/invisible
            const id = `${category}:${fact.key}`;
            if (seen.has(id)) continue;
            seen.add(id);
            rows.push({ fact, category, tier: 'primary' });
        } catch { /* one bad ref must never break the sheet */ }
    }

    // 2) Graph extras: deterministic 1-hop link expansion off the chosen facts, ordered by
    //    retrievalSalience (importance + recency + use + confidence), first N admitted.
    const extrasMax = Math.floor(clampNum(settings?.graphExtrasCount ?? 3, 0, 8, 3));
    let extras = [];
    if (extrasMax > 0 && rows.length > 0) {
        try {
            const expanded = rows.slice();
            const already = new Set(seen);
            expandLinks(databases, expanded, already); // anti-hub caps live inside
            extras = expanded.slice(rows.length);
            const now = Date.now();
            extras.sort((a, b) => retrievalSalience(b.fact, now) - retrievalSalience(a.fact, now));
            extras = extras.slice(0, extrasMax);
        } catch { extras = []; }
    }

    // 3) Truth-hierarchy split + budget-capped rendering (~4 chars/token, the shared
    //    estimator approximation). Once the budget runs out no further fact lines are added.
    let budget = Math.floor(clampNum(settings?.retrievalTokenBudget ?? 800, 50, 8000, 800));
    const admit = (line) => {
        const cost = Math.ceil(line.length / 4);
        if (cost > budget) return false;
        budget -= cost;
        return true;
    };
    const { state, chrono } = splitInjectionSections(rows);

    const lines = [];
    lines.push('[MEMORY SHEET — persistent memory; established truth for this scene; overrides older chat history]');
    if (summary) lines.push(`Story so far: ${summary}`);
    if (sceneLine) lines.push(`Scene: ${sceneLine}`);
    lines.push(buildPrecedencePreamble(nowCtx));

    const renderSection = (header, sectionRows) => {
        const admitted = [];
        for (const r of sectionRows) {
            const line = buildFactLine(r.fact, r.category, false, nowCtx); // recency labels always on
            if (!admit(line)) break; // budget spent — later (lower-priority) sections get nothing
            admitted.push(line);
        }
        if (admitted.length > 0) {
            lines.push(header);
            lines.push(...admitted);
        }
        return admitted.length;
    };

    renderSection(STATE_SECTION_HEADER, state);
    renderSection(CHRONO_SECTION_HEADER, chrono);
    renderSection('Connected memories:', extras);

    if (notes) lines.push(`Notes: ${notes}`);
    return lines.join('\n');
}
