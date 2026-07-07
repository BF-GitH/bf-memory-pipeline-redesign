// BF Memory Pipeline - Agent 1: Draft Planner
// Receives recent chat + character cards + system prompt
// Outputs: draft reply idea + list of needed fact categories

import { addDebugLog } from './settings.js';
import { callAgentLLM } from './llm-call.js';
import * as host from './host.js';

// Lazy import to avoid circular dependency (settings imports our DEFAULT_DRAFT_PROMPT)
function getSettingsSafe() {
    return host.getExtensionSettings();
}

export const DEFAULT_DRAFT_PROMPT = `You are a roleplay draft planner. Your job is to:
1. Read the recent chat messages and character information
2. Plan what the character should do/say next
3. From the MEMORY MENU, pick the BRANCHES (topics) of stored memory worth opening in detail

OUTPUT FORMAT (follow exactly):
#Draft:
[Write 1-3 sentences describing what the character would do/say. Include the emotional tone and any actions.]

#Branches:
[One branch per line, chosen FROM THE MEMORY MENU below. The menu is organized in TWO layers: a \`Category\` (the domain, e.g. \`People\`, \`Places\`, \`Events\`) and, under it, an \`aspect\` (a SPECIFIC sub-bucket, e.g. \`childhood\`, \`fears\`, \`current_location\`) with its active-fact count, e.g. \`People: status(3), fears(1)\`. The menu lists ONLY topics that ACTUALLY hold facts right now — every aspect shown is populated, so a fresh chat may show little or nothing (that's fine: if the menu is empty there is nothing to open → output \`none\`). A branch is either a whole \`Category\` (e.g. \`People\`) or a precise \`Category/aspect\` (e.g. \`People/fears\`, \`Places/feature\`). A specific CHARACTER is NOT a branch — facts about a person live across many aspects, so pick the SPECIFIC aspects that matter for THIS beat (e.g. a fear being poked → \`People/fears\`; where they are now → \`People/current_location\`). To bound WHICH characters' facts get pulled, name them in #Focus below (not here). Pick only the branches whose contents bear on the CURRENT moment — the people/places present, active goals, and anything the chat refers to even by PARAPHRASE — not every populated topic. Prefer \`Category/aspect\` precision; fall back to the whole \`Category\` only when the right aspect is unclear. A second agent then reads the full facts under the branches you pick. If nothing in the menu is relevant, output a single line: none]

#Focus:
[OPTIONAL. Comma-separated names of the CHARACTER(S) (and/or {{user}}, {{char}}) currently in focus this moment — who the reply is really about. This does NOT change your #Branches (those stay Category/aspect); it lets the detail step keep facts about THESE people (plus general/world facts) and skip facts about OTHER, unrelated characters living in the same aspects — saving effort. Leave empty if it's a general/world moment with no particular person in focus.]

#Needed_Facts:
[Optional fallback keywords for the deterministic search, used only if the detail step is unavailable. Semicolon-separated. May include exact \`Category/key\` entries, or a few free-text keywords (e.g. <NAME> appearance) for things NOT yet stored. May be left empty.]

#NextHint:
[OPTIONAL. A tiny breadcrumb naming the few topics/branches likely to matter in the NEXT scene (where this exchange seems to be heading). Semicolon-separated; \`Category\` or \`Category/aspect\` tokens preferred, or short keywords. Keep it to at most ~5 items. This is backstage-only — it is NOT shown to anyone and NOT used to write this reply. Leave empty if unsure.]

#Scene:
Location: [where the scene is happening right now, a few words]
Name: [OPTIONAL. A short, evocative label for THIS scene, e.g. "the market scene" or "the rooftop". Omit if unsure — a name is derived automatically from the location.]
Present: [comma-separated characters/entities currently in the scene]
Goals: [comma-separated active goals or open threads, short]
Beat: [ONE short line describing the single most recent thing that just happened]

RULES:
- Keep the draft SHORT - just the idea, not the full response
- Pick branches from the MEMORY MENU that cover the people/places present and active threads — match paraphrases in the scene to the right Category/aspect. This is your most important job.
- Prefer \`Category/aspect\` precision; use a whole \`Category\` only when the relevant aspect is unclear.
- Use #Focus to name who the moment is about so unrelated characters' facts in the same aspects are skipped; leave it empty for a general/world moment.
- Include character facts, location details, relationship info, object properties
- Think about what the characters KNOW vs don't know
- Consider the emotional state and setting
- If the present moment is an emotional callback or turning point between two characters (a confession, a betrayal resurfacing, a reunion), open the \`Relationships\` branch for that pair so their shared history is on hand for the reply.
- The #Scene block describes the PRESENT MOMENT (current location, who is here, active goals, the latest beat). Keep each line terse. Omit a line only if truly unknown.`;

/**
 * Run Agent 1: Generate a draft and needed facts list
 * @param {string} recentChat - Formatted recent chat messages
 * @param {string} characterInfo - Character card/description
 * @param {string} userPersona - User's persona description
 * @param {string|null} profileId
 * @param {string} factInventory - Compact `Category/key` inventory of existing facts
 *   (keys only, no values). Lets Agent 1 request EXACT keys that exist instead of
 *   free-associating keyword strings. Optional — empty when no facts stored yet. Used
 *   for the #Needed_Facts fallback path.
 * @param {string} menu - STAGE 1 compact CATEGORY×ASPECT menu (from summarizeMenu) Agent 1
 *   picks #Branches from. Always populated (the Layer-1 skeleton is seeded even with 0 facts).
 * @returns {Promise<DraftResult>}
 */
export async function runDraftAgent(recentChat, characterInfo, userPersona, profileId = null, factInventory = '', menu = '') {
    const { systemPrompt, userPrompt } = buildDraftPrompt(recentChat, characterInfo, userPersona, factInventory, menu);
    addDebugLog('info', `Agent 1 prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

    try {
        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId, 'agent1');
        addDebugLog('info', `Agent 1 LLM reply (${resultStr.length} chars):\n${resultStr}`);
        const tokensIn = await host.getTokenCount(systemPrompt + '\n' + userPrompt);
        const tokensOut = await host.getTokenCount(resultStr);
        return { ...parseDraftResult(resultStr), tokensIn, tokensOut };
    } catch (error) {
        addDebugLog('fail', `Agent 1 error: ${error.message || error}`);
        console.error('[BFMemory] Agent 1 (Draft) error:', error);
        return { draft: '', branches: [], focus: [], neededFacts: [], nextHint: [], scene: null, raw: '', error: error.message, tokensIn: 0, tokensOut: 0 };
    }
}

/**
 * Build the prompt for Agent 1
 */
function buildDraftPrompt(recentChat, characterInfo, userPersona, factInventory = '', menu = '') {
    const sysPrompt = getSettingsSafe()?.draftPrompt || DEFAULT_DRAFT_PROMPT;

    // System message: pure instruction, no RP content
    const systemPrompt = sysPrompt;

    // User message: all the data the agent needs to analyze
    const dataParts = [];
    if (characterInfo) {
        dataParts.push(`## Character Info\n${characterInfo}`);
    }
    if (userPersona) {
        dataParts.push(`## User Persona\n${userPersona}`);
    }
    // STAGE 1 MENU (Category × aspect map, counts, no values). Agent 1 picks #Branches from
    // this; a second agent then reads the full facts under the picked branches.
    if (menu && menu.trim()) {
        dataParts.push(`## Memory Menu (pick #Branches from these — Category or Category/aspect)\n${menu.trim()}`);
    }
    // Existing-fact inventory (Category/key only). Kept for the #Needed_Facts fallback
    // path so deterministic retrieval can still resolve exact keys by identity.
    if (factInventory && factInventory.trim()) {
        dataParts.push(`## Existing Fact Keys (for #Needed_Facts fallback — exact Category/key)\n${factInventory.trim()}`);
    }
    dataParts.push(`## Recent Chat\n${recentChat}`);
    dataParts.push('\nNow output ONLY the #Draft:, #Branches:, #Focus:, #Needed_Facts:, #NextHint:, and #Scene: sections.');

    return { systemPrompt, userPrompt: dataParts.join('\n\n') };
}

/**
 * Parse Agent 1's response into structured data
 * @param {string} response
 * @returns {DraftResult}
 */
function parseDraftResult(response) {
    const result = {
        draft: '',
        branches: [], // STAGE 1 picks: `Category` or `Category/aspect` strings (character-agnostic)
        focus: [], // OPTIONAL focus character(s) for the tag-filter (3-layer model); never a branch
        neededFacts: [],
        nextHint: [], // refinement #11: backstage breadcrumb of topics likely relevant next scene
        scene: null, // optional #SCENE parse: { location, present[], goals[], newBeats[] }
        raw: response,
        error: null,
    };

    if (!response || !response.trim()) {
        result.error = 'Empty response from draft agent';
        return result;
    }

    // Extract draft section (bounded before any later section so it doesn't swallow them)
    const draftMatch = response.match(/#Draft:?\s*([\s\S]*?)(?=#Branches|#Focus|#Needed[_ ]Facts|#Next[_ ]?Hint|#Scene|$)/i);
    if (draftMatch) {
        result.draft = draftMatch[1].trim();
    }

    // Extract #Branches section (STAGE 1 menu picks). Bounded before #Focus/#Needed_Facts/#Scene.
    // One branch per line; tolerate bullets/commas/semicolons. Drop bracketed placeholders
    // and a lone "none". Keep the `Category` or `Category/aspect` token verbatim (the menu axis
    // is now Layer-1/Layer-2, character-agnostic) — collectBranchFacts normalizes punctuation/
    // case downstream. A focus CHARACTER is captured separately in #Focus, never as a branch.
    const branchesMatch = response.match(/#Branches:?\s*([\s\S]*?)(?=#Focus|#Needed[_ ]Facts|#Next[_ ]?Hint|#Scene|$)/i);
    if (branchesMatch) {
        result.branches = branchesMatch[1]
            .split(/[;\n,]+/)
            .map(b => b.replace(/^[\s\-*•\d.)\]]+/, '').trim())
            .filter(b => b.length > 0 && !/^\[.*\]$/.test(b) && !/^(none|n\/a|unknown|tbd)$/i.test(b));
    }

    // Extract OPTIONAL #Focus section (3-layer model): the character(s) currently in focus.
    // Used ONLY by the finder candidate gather as a CHARACTER-TAG filter (keep facts whose
    // `involved`/`subject` includes a focus character, plus untagged general/world facts) — it
    // is NOT a branch and never changes which categories/aspects are read. Bounded before
    // #Needed_Facts/#NextHint/#Scene. Same tolerant split as branches; drop placeholders/"none".
    const focusMatch = response.match(/#Focus:?\s*([\s\S]*?)(?=#Needed[_ ]Facts|#Next[_ ]?Hint|#Scene|$)/i);
    if (focusMatch) {
        result.focus = focusMatch[1]
            .split(/[;\n,]+/)
            .map(f => f.replace(/^[\s\-*•\d.)\]]+/, '').replace(/^@/, '').trim())
            .filter(f => f.length > 0 && !/^\[.*\]$/.test(f) && !/^(none|n\/a|unknown|tbd|general|world)$/i.test(f));
    }

    // Extract needed facts section (bounded before #NextHint/#Scene so it doesn't swallow them)
    const factsMatch = response.match(/#Needed[_ ]Facts:?\s*([\s\S]*?)(?=#Next[_ ]?Hint|#Scene|$)/i);
    if (factsMatch) {
        const factsRaw = factsMatch[1].trim();
        // Split by semicolons, newlines, or commas
        result.neededFacts = factsRaw
            .split(/[;\n,]+/)
            .map(f => f.trim())
            .filter(f => f.length > 0 && !/^\[.*\]$/.test(f) && !/^(none|n\/a|unknown|tbd)$/i.test(f));
    }

    // Extract optional #NextHint section (refinement #11): a tiny backstage breadcrumb of
    // topics likely relevant NEXT scene. Bounded before #Scene. Same tolerant split as
    // branches; drop bracketed placeholders / "none". Capped to 5 to keep it tiny. This is
    // stored in message.extra (NOT injected, NOT shown to the user) for future use.
    const hintMatch = response.match(/#Next[_ ]?Hint:?\s*([\s\S]*?)(?=#Scene|$)/i);
    if (hintMatch) {
        result.nextHint = hintMatch[1]
            .split(/[;\n,]+/)
            .map(h => h.replace(/^[\s\-*•\d.)\]]+/, '').trim())
            .filter(h => h.length > 0 && !/^\[.*\]$/.test(h) && !/^(none|n\/a|unknown|tbd)$/i.test(h))
            .slice(0, 5);
    }

    // Extract optional #Scene block (always-on scene card). Missing block → scene stays
    // null (back-compatible: pipeline simply doesn't update the scene this turn).
    result.scene = parseSceneBlock(response);

    // If the #Needed_Facts HEADER itself was missing (a true parse failure), try to extract
    // any useful keywords. The prompt allows an empty section — an obediently-empty list must
    // NOT trigger this, or sentence-starters pollute deterministic retrieval (audit F-DRAFT-1).
    if (!factsMatch && result.draft) {
        // Extract capitalized words as fallback keywords
        const words = result.draft.match(/[A-Z][a-z]+/g) || [];
        result.neededFacts = [...new Set(words)];
    }

    console.log(`[BFMemory] Agent 1 Draft: "${result.draft.substring(0, 100)}"`);
    console.log(`[BFMemory] Agent 1 Needed Facts: ${result.neededFacts.join('; ')}`);

    return result;
}

/**
 * Parse the optional #Scene block from Agent 1's output into a scene patch.
 * Tolerant: any field may be absent. Returns null if no usable scene fields found.
 * @param {string} response
 * @returns {{location:string, present:string[], goals:string[], newBeats:string[], name:string}|null}
 */
function parseSceneBlock(response) {
    // Grab everything from #Scene to the next #Section or end-of-text.
    const block = response.match(/#Scene:?\s*([\s\S]*?)(?=\n#[A-Za-z]|$)/i);
    if (!block) return null;
    const body = block[1];

    const line = (label) => {
        const m = body.match(new RegExp(`^\\s*${label}\\s*:?\\s*(.+)$`, 'im'));
        return m ? m[1].trim() : '';
    };
    const list = (s) => s
        .split(/[;,]+/)
        .map(x => x.trim())
        // Drop bracketed placeholders the model may have echoed verbatim.
        .filter(x => x.length > 0 && !/^\[.*\]$/.test(x) && !/^(none|n\/a|unknown|tbd)$/i.test(x));

    const location = line('Location');
    const present = list(line('Present'));
    const goals = list(line('Goals'));
    // Accept "Beat" (single) or "Beats" (plural list) — newest beat(s) for the rolling window.
    const beatLine = line('Beat') || line('Beats') || line('Recently');
    const newBeats = beatLine ? list(beatLine).filter(Boolean) : [];

    // OPTIONAL scene name (Spiderweb 2): a short evocative label the Drafter MAY emit. Lenient —
    // drop a bracketed placeholder / "none" echo so a model that doesn't fill it changes nothing
    // (the location-derived name then stands; setScene falls back). Never required.
    const nameLine = line('Name');
    const name = (/^\[.*\]$/.test(nameLine) || /^(none|n\/a|unknown|tbd)$/i.test(nameLine)) ? '' : nameLine;

    const cleanLoc = (/^\[.*\]$/.test(location) || /^(none|n\/a|unknown|tbd)$/i.test(location)) ? '' : location;

    if (!cleanLoc && present.length === 0 && goals.length === 0 && newBeats.length === 0 && !name) return null;
    return { location: cleanLoc, present, goals, newBeats, name };
}

/**
 * @typedef {Object} DraftResult
 * @property {string} draft - The draft reply idea
 * @property {string[]} branches - STAGE 1 menu picks (`Category` or `Category/aspect`, character-agnostic)
 * @property {string[]} focus - OPTIONAL focus character name(s) for the finder's character-tag filter (3-layer model). Empty for a general/world moment. Never a branch.
 * @property {string[]} neededFacts - List of fact categories/keywords to look up
 * @property {string[]} nextHint - Backstage breadcrumb: topics likely relevant next scene (refinement #11). Stored in message.extra, never injected/shown.
 * @property {{location:string, present:string[], goals:string[], newBeats:string[], name:string}|null} scene - Optional parsed #Scene block (null if absent)
 * @property {string} raw - Raw LLM response
 * @property {string|null} error - Error message if failed
 */
