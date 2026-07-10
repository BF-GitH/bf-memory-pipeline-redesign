// BF Memory Pipeline - Selector: semantic shelf selection (selection-summary, opt-in)
// ONE small LLM call per turn (default OFF — settings.selectionSummaryEnabled). Reads the
// Reflection pass's shelf summaries as a MENU and picks which shelves/facts matter for the
// CURRENT scene. Picks are expanded deterministically (fact-retrieval.expandSelectionPicks)
// into budget-charged SECONDARY rows — never unbudgeted primary (audit F-ARCH-2 class).
// EVERY failure mode (no shelves yet, timeout, abort, bad JSON, tokenizer throw) degrades to
// a silent `null` → the deterministic retrieval cascade runs byte-identical to OFF.

import { addDebugLog } from './settings.js';
import { callAgentLLM } from './llm-call.js';
import * as host from './host.js';

// Confidence gate: picks the model scored below this are dropped before expansion (a 0.2
// "maybe" shelf isn't worth scarce injection budget; 0.5 is the coercion default for a pick
// with a missing/garbage confidence, so defaulted picks pass).
const MIN_CONFIDENCE = 0.3;
// Caller-scoped wall-clock budget for the Selector call (the retired finder's pattern via
// callAgentLLM's externalSignal): a slow provider can never stall the reply beyond this.
// cancelInFlightLLM() (Stop / mid-run disable) still reaches the call independently.
const SELECTOR_BUDGET_MS = 10000;

// STATIC rulebook — the system message must never carry per-turn data (manifest + chat go in
// the USER message) or the cache-drift guard in llm-call.js fires and server-side prompt
// caching for the 'selector' agent breaks.
export const SELECTOR_SYSTEM_PROMPT = `You are a memory shelf selector for a roleplay memory system. You receive:
1. A MEMORY SHELF MANIFEST — one line per shelf: \`Category/aspect (N facts): <summary of what that shelf holds>\`.
2. The RECENT CHAT — the scene happening right now.

Your ONLY job: pick the shelves whose stored facts bear on the CURRENT moment — the people and places present, active goals, and anything the chat refers to even by PARAPHRASE. Ignore shelves that are merely interesting; a detail step reads the full facts under your picks, so precision beats coverage.

OUTPUT: STRICT JSON only. No prose, no explanations, no code fences.
{"picks":[{"shelf":"Category/aspect","confidence":0.9},{"shelf":"Category/aspect","confidence":0.5}]}

RULES:
- Each shelf pick copies the \`Category/aspect\` EXACTLY as written in the manifest (the part before the parenthesis). Never invent a shelf that is not listed.
- confidence is a number 0.0-1.0: how strongly the current scene needs that shelf (1.0 = directly referenced; below 0.3 = too weak, omit it).
- OPTIONAL: when a shelf summary names a specific stored fact you are certain exists, you may add {"fact":"Category/key","confidence":0.8} entries (exact Category/key). Never guess keys.
- Order picks by confidence, highest first.
- If nothing in the manifest matters for this moment, output {"picks":[]}.`;

/**
 * Build the per-turn shelf manifest the Selector picks from: one line per NON-EMPTY shelf
 * summary in the pyramid, `Category/aspect (N facts): <summary text>`. Fact counts prefer the
 * LIVE active-fact index (the stored factCount is a snapshot from the reflection pass that
 * wrote the shelf). Returns '' when no usable shelves exist — e.g. a fresh chat before the
 * first reflection pass — and the CALLER must then skip the LLM call entirely (sending an
 * empty manifest just makes the model hallucinate shelves).
 * @param {{shelves?: Object<string,{text:string,factCount:number}>}|null} pyramid - getSummaryPyramid()
 * @param {{byCatAspect: Map}|null} index - per-turn memory index (live counts)
 * @returns {string} newline-joined manifest, or '' when there is nothing to pick from
 */
export function buildShelfManifest(pyramid, index) {
    const shelves = pyramid?.shelves;
    if (!shelves || typeof shelves !== 'object') return '';
    const lines = [];
    for (const [bucketKey, entry] of Object.entries(shelves)) {
        const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
        if (!text) continue; // empty shelf summary carries no signal — skip
        const sep = String(bucketKey).indexOf('||');
        if (sep <= 0) continue; // malformed key — never emit a line the model can't echo back
        const category = bucketKey.slice(0, sep);
        const aspect = bucketKey.slice(sep + 2);
        if (!category || !aspect) continue;
        const live = index?.byCatAspect?.get(bucketKey);
        const factCount = Array.isArray(live) ? live.length : (Number(entry.factCount) || 0);
        lines.push(`${category}/${aspect} (${factCount} facts): ${text}`);
    }
    return lines.join('\n');
}

/**
 * Build the USER prompt: ALL per-turn data lives here (cache-drift guard — the system
 * message stays byte-stable across calls). The candidate cap is per-turn too (it follows a
 * user setting), so it rides the user message instead of destabilizing the system prefix.
 */
function buildSelectorUserPrompt(formattedChat, manifest, maxPicks) {
    const parts = [];
    parts.push(`## Memory Shelf Manifest\n${manifest}`);
    parts.push(`## Recent Chat\n${formattedChat}`);
    parts.push(`Now output the STRICT JSON picks object — up to ${maxPicks * 2} candidate picks, ordered by confidence.`);
    return parts.join('\n\n');
}

/**
 * Parse the Selector reply DEFENSIVELY: strip a wrapping code fence, slice to the outermost
 * {...}, JSON.parse in try/catch, coerce each confidence to a finite 0..1 number (default
 * 0.5), split shelf vs fact picks. Any throw / no-JSON → null (silent fallback).
 * @param {string} raw - LLM reply text
 * @returns {{shelfPicks:Array<{shelf:string,confidence:number}>, factPicks:Array<{fact:string,confidence:number}>}|null}
 */
function parseSelectorReply(raw) {
    try {
        let s = String(raw || '').trim();
        const fence = s.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
        if (fence) s = fence[1].trim();
        // Tolerate stray prose around the JSON: parse the outermost object only.
        const first = s.indexOf('{');
        const last = s.lastIndexOf('}');
        if (first < 0 || last <= first) return null;
        const obj = JSON.parse(s.slice(first, last + 1));
        const picks = Array.isArray(obj?.picks) ? obj.picks : [];
        const shelfPicks = [];
        const factPicks = [];
        for (const p of picks) {
            if (!p || typeof p !== 'object') continue;
            let conf = Number(p.confidence);
            if (!Number.isFinite(conf)) conf = 0.5; // missing/garbage confidence → neutral default
            conf = Math.min(1, Math.max(0, conf));
            const shelf = typeof p.shelf === 'string' ? p.shelf.trim() : '';
            const factRef = typeof p.fact === 'string' ? p.fact.trim() : '';
            if (shelf) shelfPicks.push({ shelf, confidence: conf });
            else if (factRef) factPicks.push({ fact: factRef, confidence: conf });
        }
        return { shelfPicks, factPicks };
    } catch {
        return null; // bad JSON → silent deterministic fallback
    }
}

/**
 * Run the semantic selection pass: ONE small LLM call that picks shelves (and optionally
 * exact facts) from the manifest for the current scene. Confidence-gated (MIN_CONFIDENCE),
 * sorted desc, trimmed to selectionSummaryMaxPicks ACROSS both pick kinds. Token accounting
 * mirrors agent-draft.js (host.getTokenCount over system+user / reply; a tokenizer throw
 * yields 0s, never kills the pass).
 *
 * Returns null on ANY failure (abort/timeout, empty reply, unparseable JSON) — the caller
 * treats null as "no selection" and the deterministic cascade runs unchanged.
 *
 * @param {string} formattedChat - recent chat formatted for agent prompts
 * @param {string} manifest - buildShelfManifest() output (caller must skip the call when '')
 * @param {string|null} profileId - connection profile (reuses Agent 1's — no new dropdown)
 * @returns {Promise<{shelfPicks:Array, factPicks:Array, tokensIn:number, tokensOut:number, raw:string}|null>}
 */
export async function runSelectionPass(formattedChat, manifest, profileId = null) {
    if (!manifest || !String(manifest).trim()) return null; // no shelves yet — never call with an empty menu
    const settings = host.getExtensionSettings() || {};
    const maxPicks = Math.min(20, Math.max(1, Math.floor(Number(settings.selectionSummaryMaxPicks) || 6)));
    const systemPrompt = SELECTOR_SYSTEM_PROMPT;
    const userPrompt = buildSelectorUserPrompt(formattedChat, manifest, maxPicks);
    addDebugLog('info', `Selector prompt: system=${systemPrompt.length}, user=${userPrompt.length} chars (${manifest.split('\n').length} shelves)`);

    // Caller-scoped abort on a hard timer (the retired finder's externalSignal pattern): a slow
    // selector aborts ONLY its own call — a concurrent Agent-1 call is untouched.
    const budgetCtrl = new AbortController();
    const budgetTimer = setTimeout(
        () => budgetCtrl.abort(new DOMException(`Selector budget ${SELECTOR_BUDGET_MS / 1000}s exceeded`, 'TimeoutError')),
        SELECTOR_BUDGET_MS,
    );
    let reply = '';
    try {
        reply = await callAgentLLM(systemPrompt, userPrompt, profileId, 'selector', budgetCtrl.signal);
    } catch (error) {
        // Abort/timeout/network — all silent: the deterministic cascade covers the turn.
        addDebugLog('info', `Selector pass failed (silent deterministic fallback): ${error.message || error}`, {
            subsystem: 'retrieval', event: 'retrieval.selector', reason: 'ERROR',
            data: { agent: 'selector', error: String(error.message || error) },
        });
        return null;
    } finally {
        clearTimeout(budgetTimer);
    }
    if (!reply || !reply.trim()) return null;

    const parsed = parseSelectorReply(reply);
    if (!parsed) {
        addDebugLog('info', 'Selector reply unparseable — silent deterministic fallback', {
            subsystem: 'retrieval', event: 'retrieval.selector', reason: 'PARSE_FAILED',
            data: { agent: 'selector', replyChars: reply.length },
        });
        return null;
    }

    // Confidence gate + global trim: drop weak picks, sort desc, keep the top maxPicks ACROSS
    // shelf+fact picks combined (the prompt asked for up to 2x candidates precisely so the gate
    // has slack to cut).
    const gated = [
        ...parsed.shelfPicks.map(p => ({ ...p, _kind: 'shelf' })),
        ...parsed.factPicks.map(p => ({ ...p, _kind: 'fact' })),
    ]
        .filter(p => p.confidence >= MIN_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, maxPicks);
    const shelfPicks = gated.filter(p => p._kind === 'shelf').map(({ shelf, confidence }) => ({ shelf, confidence }));
    const factPicks = gated.filter(p => p._kind === 'fact').map(({ fact, confidence }) => ({ fact, confidence }));

    // Token accounting like agent-draft.js — a tokenizer failure must never kill the pass.
    let tokensIn = 0, tokensOut = 0;
    try {
        tokensIn = await host.getTokenCount(systemPrompt + '\n' + userPrompt);
        tokensOut = await host.getTokenCount(reply);
    } catch { tokensIn = 0; tokensOut = 0; }

    addDebugLog('info', `Selector picked ${shelfPicks.length} shelf/${factPicks.length} fact pick(s): ${[...shelfPicks.map(p => p.shelf), ...factPicks.map(p => p.fact)].join('; ') || '(none)'}`);
    return { shelfPicks, factPicks, tokensIn, tokensOut, raw: reply };
}
