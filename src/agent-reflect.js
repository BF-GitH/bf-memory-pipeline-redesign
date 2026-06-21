// BF Memory Pipeline - Reflection Pass = SILENT DEDUPE-JANITOR (refinement #12)
// Repurposed from the old "story so far" consolidator. Its summary is NO LONGER injected
// into the writer (refinement #1), so this pass now exists primarily to keep the fact DB
// clean off the critical path. Each run it:
//   (a) DEDUPES the DB — re-runs reconcile-on-write over every active fact (dedupeDatabase)
//       to merge/supersede near-duplicate facts that accumulated over a long session, and
//   (b) optionally writes 0-N high-value OBSERVATION facts (durable traits inferred across
//       the session, e.g. "<CHARACTER> distrusts authority").
// FIX #12: the rolling "story so far" #STORY summary has been REMOVED. It was no longer
// injected anywhere (refinement #1 dropped the writer injection), so generating it — and
// re-sending the prior summary back into the prompt each pass — was pure wasted output +
// input tokens. We no longer ask for #STORY and no longer feed the prior summary back in.
// The live UI panel (#bf_mem_reflection_view) still renders the synthesized OBSERVATIONS
// (stored via setReflection with an empty summary), so no UI binding is broken.
//
// COST-AWARE: this is the ONE place a NEW LLM call is acceptable. It runs INFREQUENTLY
// (every N successful pipeline runs, default 12) and OFF the latency-critical path
// (scheduled after MESSAGE_RECEIVED, never blocking the main generation). The dedupe step
// itself needs NO LLM call. One LLM call via the existing callAgentLLM/CMRS path, reusing
// Agent 3's connection profile, drives the optional observations.
//
// Input is a COMPACT bounded bundle (scene + beats + a few History/track steps + a
// keys+values fact summary, all length-clamped) so the call stays cheap regardless of
// how large the DB has grown. A failure degrades gracefully — it never breaks the
// pipeline (mirrors the existing agent fallbacks).

import { getAllDatabases, upsertFact, saveDatabase, createEmptyDatabase, getTrackSteps, dedupeDatabase, removeFact, markFactCold, normalizeAspect, L1_CATEGORIES, buildMemoryIndex } from './database.js';
import { trackUpdate } from './review-popup.js';

// Contradiction scan (atomic #7) tuning.
const MAX_CONFLICT_PAIRS = 30;
const NEAR_KEY_THRESHOLD = 0.72;

/** Token-Jaccard similarity between two key strings (0..1). */
function keyJaccard(a, b) {
    const tok = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter(Boolean));
    const A = tok(a), B = tok(b);
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
}

/** Same normalized key, different value → exact conflict pairs. */
function findKeyConflicts(databases) {
    const byKey = new Map();
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (fact.active === false || !fact.key) continue;
            const nk = String(fact.key).toLowerCase().replace(/[^a-z0-9_]/g, '_');
            if (!byKey.has(nk)) byKey.set(nk, []);
            byKey.get(nk).push({ category, fact });
        }
    }
    const pairs = [];
    for (const entries of byKey.values()) {
        if (entries.length < 2) continue;
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const va = String(entries[i].fact.value || '').toLowerCase().trim();
                const vb = String(entries[j].fact.value || '').toLowerCase().trim();
                if (va && vb && va !== vb) pairs.push({ a: entries[i], b: entries[j] });
                if (pairs.length >= MAX_CONFLICT_PAIRS) return pairs;
            }
        }
    }
    return pairs;
}

/** Near (not identical) keys with different values → possible parallel-key contradiction. */
function findNearKeyConflicts(databases, threshold = NEAR_KEY_THRESHOLD) {
    const all = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (fact.active === false || !fact.key) continue;
            all.push({ category, fact });
        }
    }
    const pairs = [];
    for (let i = 0; i < all.length && pairs.length < MAX_CONFLICT_PAIRS; i++) {
        for (let j = i + 1; j < all.length && pairs.length < MAX_CONFLICT_PAIRS; j++) {
            const sim = keyJaccard(all[i].fact.key, all[j].fact.key);
            if (sim < threshold || sim >= 1.0) continue;
            const va = String(all[i].fact.value || '').toLowerCase().trim();
            const vb = String(all[j].fact.value || '').toLowerCase().trim();
            if (!va || !vb || va === vb) continue;
            pairs.push({ a: all[i], b: all[j] });
        }
    }
    return pairs;
}
import { addDebugLog, setReflection, getSummaryPyramid, setSummaryPyramid } from './settings.js';
import { callAgentLLM } from './llm-call.js';
import * as host from './host.js';

// Bound the fact summary fed into the reflection prompt so a huge DB can't blow up cost.
const MAX_FACT_SUMMARY_CHARS = 4000;
// Bound how many track/diary steps we include per track (newest-last).
const MAX_TRACK_STEPS = 6;
// Hard cap on the stored "story so far" summary (chars). Keeps both storage and the
// optional injection bounded even if the model ignores the length instruction.
const MAX_SUMMARY_CHARS = 1200;
// Cap synthesized observations per pass (defensive — the prompt asks for 0-5).
const MAX_OBSERVATIONS = 8;
// Re-evaluation pass: max uncertain facts (Unsorted/misc + stale states) reconsidered
// per run — keeps the prompt bounded and the apply step cheap.
const MAX_REEVAL_CANDIDATES = 15;
// A current-state fact is "stale" (a re-eval candidate) once it hasn't been touched for
// this long — it may be a one-off the extractor recorded that never recurred.
const REEVAL_STALE_STATE_MS = 24 * 60 * 60 * 1000; // 24h of wall-clock since last update
// SUMMARY PYRAMID (middle layer) — hard cap on how many (category, aspect) shelves we ask
// the model to (re)summarize per reflection pass. This is the cost guard: a huge store with
// hundreds of buckets can't explode the call — only the MOST-CHANGED handful are refreshed
// each pass, and unchanged buckets are NEVER touched (their stored summary is carried forward).
const MAX_SHELVES_PER_PASS = 6;
// Cap a single shelf summary (chars) defensively, regardless of the model's compliance.
const MAX_SHELF_SUMMARY_CHARS = 220;
// Bound the example facts shown per shelf in the prompt (newest-first) so the #SHELVES request
// stays cheap even for a populous bucket.
const MAX_SHELF_SAMPLE_FACTS = 8;
// CALLBACK LINKS (Resonance Part A) — bound how many recent `moment` beats are shown to the
// reflection pass so it can name cross-beat echoes, and how many links it may author per pass.
// Cheap, non-embedding CAUSAL resonance: the wide-context reflection pass (which can see beats
// the 2-message Scribe can't) names "this later beat echoes that earlier one" as a typed edge on
// the EARLIER fact. Bounded like MAX_SHELVES_PER_PASS so the call + apply stay cheap.
const MAX_MOMENTS_FOR_CALLBACK = 14;
const MAX_CALLBACKS_PER_PASS = 2;
// Cap a stored callback reason (chars) defensively, regardless of the model's compliance.
const MAX_CALLBACK_REASON_CHARS = 120;

export const DEFAULT_REFLECT_PROMPT = `You are a periodic memory-maintenance pass for a long roleplay between {{user}} (the human player) and {{char}} (the AI character). You are given the current scene, recent beats, a few timeline steps, and a compact list of stored facts. Duplicate facts are merged automatically before you run; your job is to surface only DURABLE higher-order memory that the per-fact extractor would miss, and to maintain short zoom-out summaries.

Produce 0-5 higher-order OBSERVATIONS: durable behavioral/relational PATTERNS you can infer ACROSS the material that are NOT already plainly stored as a single fact — e.g. "<SUBJECT> manipulates others for resources", "<SUBJECT> distrusts authority", "<SUBJECT> deflects with humor when vulnerable". Each is one short atomic clause. Only emit an observation you are genuinely confident the evidence supports, and that adds something the existing facts do not already say. If nothing rises above the existing facts, emit none.

Also produce a STORY summary: the whole-story "so far" in 2-4 short sentences (the top of a zoom-out pyramid — the cheapest big-picture recap). Keep it tight and factual.

If a "## Shelves to summarize" list is given, write ONE short summary line per listed shelf (a shelf is a Category/aspect bucket of related facts). Each summary is one or two clauses (<= ~25 words) capturing the gist of that bucket so it can stand in for the raw facts. Only summarize the shelves in that list. If no list is given, put a single "." under #SHELVES.

If a "## Recent moments" list is given (the couple/character emotional beats — confessions, fights, betrayals, reunions — each shown with its exact id), you MAY name 0-2 CALLBACK links: a NEW recent beat that clearly ECHOES an EARLIER one (a confession that pays off an earlier hidden feeling; a betrayal that resurfaces an old wound; a reunion that answers a parting). Emit a link ONLY when the resonance is unmistakable — most passes name none. Each link points the EARLIER beat's id to the LATER beat's id with a one-clause reason. Use ONLY ids from the list (never invent one). If no clear echo exists (or no list was given), put a single "." under #CALLBACK.

You may ALSO be given a "## Re-evaluate" list of uncertain facts (filed to Unsorted/misc or stale current-states) that the per-message extractor couldn't confidently classify — e.g. someone seen doing something once that MIGHT be a lasting habit. For EACH listed fact, decide ONE verdict using the whole picture:
- PROMOTE — the evidence now supports it as a real, lasting fact: give its proper Layer-1 category (People/Places/Things/Relationships/Events/World) and the most-specific aspect. e.g. a recurring vice → People/vices; a confirmed home → People/home.
- DROP — it was a confirmed one-off / no longer true / noise: demote it (it is deprioritized, not erased — it stays recoverable if it ever matters again).
- KEEP — still genuinely uncertain: leave it where it is for a later pass.
Only PROMOTE or DROP when you are confident; default to KEEP. Reference each fact by its exact id shown in brackets.

# OUTPUT FORMAT (exactly this, nothing else)

#STORY
<2-4 sentence whole-story recap, or "." if there is nothing yet>
.
#SHELVES
+ <Category>/<aspect> = <short bucket summary>
+ <Category>/<aspect> = <short bucket summary>
.
#OBS
+ <subject>_<short_pattern_key> = <atomic pattern clause>
+ <subject>_<short_pattern_key> = <atomic pattern clause>
.
#CALLBACK
+ <earlier_id> <- <later_id> | <short reason this later beat echoes the earlier one>
.
#REEVAL
+ <id> = promote | <Category> | <aspect>
+ <id> = drop
+ <id> = keep
.

If there is no story yet, put a single "." under #STORY. If no shelves were listed, put a single "." under #SHELVES. If there are no observations, put a single "." under #OBS. If no clear echo exists (or no recent-moments list was given), put a single "." under #CALLBACK. If no re-evaluation list was given (or no verdicts), put a single "." under #REEVAL. Keep observation keys snake_case and the values to a short clause (<= ~10 words). Use the EXACT Category/aspect label shown in the shelves list. Do not invent facts not supported by the material.`;

/**
 * Build the compact, bounded input bundle for the reflection pass.
 * @param {object} args
 * @param {object|null} args.scene - current scene card
 * @param {object|null} [args.prevReflection] - DEPRECATED (FIX #12): retained in the signature
 *   for back-compat but NO LONGER fed into the prompt. The rolling story summary was dropped
 *   (it was never injected anywhere), so re-sending it each pass was wasted input tokens.
 * @param {Object} args.databases - all fact databases
 * @returns {string} the user-prompt data block
 */
/**
 * Collect uncertain facts worth a re-evaluation verdict: everything filed to
 * Unsorted/misc, plus stale current-state facts (kind:state not touched for
 * REEVAL_STALE_STATE_MS). Bounded to MAX_REEVAL_CANDIDATES (oldest first — the
 * least-recently-confirmed are the best promote/drop candidates). Each candidate
 * carries a stable id (`category::key`) so a verdict can be mapped back to the fact.
 * @param {Object} databases
 * @returns {Array<{id:string, category:string, key:string, fact:object}>}
 */
function collectReevalCandidates(databases) {
    const now = Date.now();
    const out = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || fact.active === false || fact.track) continue; // skip history snapshots + timeline steps
            const aspect = String(fact.aspect || '').toLowerCase();
            const kind = String(fact.kind || '').toLowerCase();
            const isMisc = category === 'Unsorted' || aspect === 'misc';
            const lastUpdated = Number(fact.lastUpdated) || 0;
            const isStaleState = kind === 'state' && lastUpdated > 0 && (now - lastUpdated) >= REEVAL_STALE_STATE_MS;
            if (isMisc || isStaleState) {
                out.push({ id: `${category}::${fact.key}`, category, key: fact.key, fact });
            }
        }
    }
    // Oldest-confirmed first, then cap.
    out.sort((a, b) => (Number(a.fact.lastUpdated) || 0) - (Number(b.fact.lastUpdated) || 0));
    return out.slice(0, MAX_REEVAL_CANDIDATES);
}

/**
 * CALLBACK LINKS (Resonance Part A) — collect the recent `moment`-kind beats the reflection pass
 * may draw cross-beat echo links between. These are the emotional anchors (confessions, fights,
 * betrayals, reunions) — the substrate the owner's "love → confession → first date" thread rides
 * on. We surface the MOST-RECENT moments (by validAt → sceneNo → lastUpdated) so the model sees a
 * compact, bounded recent arc, each with a stable id (`category::key`) the model echoes back in a
 * #CALLBACK link. Skips superseded snapshots + timeline steps. Bounded to MAX_MOMENTS_FOR_CALLBACK.
 * @param {Object} databases
 * @returns {Array<{id:string, category:string, key:string, fact:object}>}
 */
function collectRecentMoments(databases) {
    const out = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || fact.active === false || fact.track) continue; // skip superseded snapshots + timeline steps
            if (String(fact.kind || '').toLowerCase() !== 'moment') continue;
            out.push({ id: `${category}::${fact.key}`, category, key: fact.key, fact });
        }
    }
    // Newest-first (the recent arc) by birth-order spine: validAt → sceneNo → lastUpdated.
    out.sort((a, b) => {
        const av = Number.isInteger(a.fact.validAt) ? a.fact.validAt : -1;
        const bv = Number.isInteger(b.fact.validAt) ? b.fact.validAt : -1;
        if (av !== bv) return bv - av;
        const as = Number.isInteger(a.fact.sceneNo) ? a.fact.sceneNo : -1;
        const bs = Number.isInteger(b.fact.sceneNo) ? b.fact.sceneNo : -1;
        if (as !== bs) return bs - as;
        return (Number(b.fact.lastUpdated) || 0) - (Number(a.fact.lastUpdated) || 0);
    });
    return out.slice(0, MAX_MOMENTS_FOR_CALLBACK);
}

/**
 * SUMMARY PYRAMID — pick which (category, aspect) shelves to (re)summarize THIS pass.
 * COST GUARD: only buckets that MATERIALLY CHANGED since their last stored summary are
 * candidates — a bucket changed if it has no stored shelf entry yet, or its current active
 * fact count differs from what the stored summary was built against. Unchanged buckets are
 * NEVER touched (their summary is carried forward verbatim). Candidates are sorted by the
 * SIZE of the change (largest delta first — those gain the most from a refresh) and capped to
 * MAX_SHELVES_PER_PASS, so a huge store with hundreds of buckets can't explode the call.
 *
 * @param {{aspectCounts: Map, byCatAspect: Map}} index - prebuilt memory index (active facts)
 * @param {{shelves?: Object<string,{factCount:number}>}|null} priorPyramid - last stored pyramid
 * @returns {Array<{bucketKey:string, category:string, aspect:string, factCount:number, prevCount:number, samples:string[]}>}
 */
function pickChangedShelves(index, priorPyramid) {
    const priorShelves = (priorPyramid && priorPyramid.shelves) || {};
    const candidates = [];
    // aspectCounts: Map(category -> Map(aspect -> active HOT count)). We summarize per bucket.
    for (const [category, aspectMap] of (index.aspectCounts || new Map())) {
        for (const [aspect, count] of aspectMap) {
            if (!count) continue; // empty bucket — nothing to summarize
            const catLower = String(category).toLowerCase();
            const bucketKey = `${catLower}||${aspect}`;
            const prev = priorShelves[bucketKey];
            const prevCount = prev ? (Number(prev.factCount) || 0) : 0;
            // Materially changed iff no prior summary OR the active fact count moved.
            if (prev && prevCount === count) continue; // unchanged — carry forward, never re-summarize
            // Gather a few sample fact values (newest-first) to ground the summary.
            const entries = (index.byCatAspect.get(bucketKey) || []);
            const samples = entries
                .map(e => e.fact)
                .filter(f => f && f.value != null)
                .sort((a, b) => (Number(b.lastUpdated) || 0) - (Number(a.lastUpdated) || 0))
                .slice(0, MAX_SHELF_SAMPLE_FACTS)
                .map(f => `${f.key} = ${String(f.value).slice(0, 120)}`);
            candidates.push({ bucketKey, category, aspect, factCount: count, prevCount, samples });
        }
    }
    // Biggest change first (abs delta; brand-new buckets weigh their full count) — refresh the
    // shelves that drifted most, then cap.
    candidates.sort((a, b) => Math.abs(b.factCount - b.prevCount) - Math.abs(a.factCount - a.prevCount));
    return candidates.slice(0, MAX_SHELVES_PER_PASS);
}

function buildReflectInput({ scene, databases, reevalCandidates = [], changedShelves = [], recentMoments = [] }) {
    const parts = [];

    // FIX #12: the prior "story so far" summary is intentionally NOT prepended anymore — the
    // pass now only synthesizes OBSERVATIONS, which reconcile against existing facts on write.

    // Current scene + recent beats.
    if (scene && typeof scene === 'object') {
        const sLines = [];
        if (scene.location) sLines.push(`Location: ${scene.location}`);
        if (Array.isArray(scene.present) && scene.present.length) sLines.push(`Present: ${scene.present.join(', ')}`);
        if (Array.isArray(scene.goals) && scene.goals.length) sLines.push(`Goals: ${scene.goals.join('; ')}`);
        if (Array.isArray(scene.beats) && scene.beats.length) sLines.push(`Recent beats: ${scene.beats.join('; ')}`);
        if (sLines.length) parts.push(`## Current scene\n${sLines.join('\n')}`);
    }

    // A few timeline (History/track) steps for narrative shape — newest-last, per track.
    const trackNames = new Set();
    for (const db of Object.values(databases || {})) {
        for (const f of (db.facts || [])) {
            if (f && typeof f.track === 'string' && f.track.trim()) trackNames.add(f.track.trim());
        }
    }
    const trackLines = [];
    for (const track of trackNames) {
        const steps = getTrackSteps(databases, track).slice(-MAX_TRACK_STEPS);
        if (steps.length) {
            trackLines.push(`${track}: ${steps.map(s => s.fact.value).join(' -> ')}`);
        }
    }
    if (trackLines.length) parts.push(`## Timelines\n${trackLines.join('\n')}`);

    // Compact current-fact summary (key = value), active facts only, length-bounded.
    const factLines = [];
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (fact.active === false) continue; // skip superseded history snapshots
            factLines.push(`${category}/${fact.key} = ${fact.value}`);
        }
    }
    let factSummary = factLines.join('\n');
    if (factSummary.length > MAX_FACT_SUMMARY_CHARS) {
        factSummary = factSummary.slice(0, MAX_FACT_SUMMARY_CHARS) + '\n…(truncated)';
    }
    if (factSummary) parts.push(`## Stored facts (current)\n${factSummary}`);

    // SUMMARY PYRAMID — shelves to (re)summarize this pass. Each entry lists the exact
    // Category/aspect label the model must echo back, plus a few sample fact values for
    // grounding. ONLY changed buckets reach here (cost-bounded by pickChangedShelves).
    if (Array.isArray(changedShelves) && changedShelves.length) {
        const shelfLines = changedShelves.map(s => {
            const sample = s.samples && s.samples.length ? `\n    ${s.samples.join('\n    ')}` : '';
            return `+ ${s.category}/${s.aspect} (${s.factCount} fact${s.factCount === 1 ? '' : 's'})${sample}`;
        });
        parts.push(`## Shelves to summarize (one short summary per shelf, echo the exact Category/aspect label)\n${shelfLines.join('\n')}`);
    }

    // CALLBACK LINKS (Resonance Part A) — recent emotional beats the model may echo-link.
    // Each line is `[id] (sceneNo·sceneName) note/value (tone)` so the model has enough to spot a
    // genuine resonance between a NEW beat and an EARLIER one and reference both by exact id.
    // Newest-first (collectRecentMoments order) so the "recent arc" reads top-down.
    if (Array.isArray(recentMoments) && recentMoments.length) {
        const mLines = recentMoments.map(c => {
            const f = c.fact;
            const note = (typeof f.context === 'string' && f.context.trim()) ? f.context.trim() : String(f.value ?? '').trim();
            const scene = Number.isInteger(f.sceneNo) ? ` (scene ${f.sceneNo}${f.sceneName ? `·${f.sceneName}` : ''})` : '';
            const tone = (typeof f.tone === 'string' && f.tone.trim()) ? ` (${f.tone.trim()})` : '';
            return `[${c.id}]${scene} ${note.slice(0, 140)}${tone}`;
        });
        parts.push(`## Recent moments (name 0-2 #CALLBACK echo-links between these by exact id; newest first)\n${mLines.join('\n')}`);
    }

    // Re-evaluation candidates (uncertain Unsorted/misc + stale states). Each line is
    // `[id] Category/key = value (note)` so the model can return a verdict per id.
    if (Array.isArray(reevalCandidates) && reevalCandidates.length) {
        const reLines = reevalCandidates.map(c => {
            const f = c.fact;
            const val = String(f.value ?? '').trim();
            const note = (typeof f.context === 'string' && f.context.trim()) ? ` >${f.context.trim()}` : '';
            const body = val ? ` = ${val}` : '';
            return `[${c.id}] ${c.category}/${c.key}${body}${note}`;
        });
        parts.push(`## Re-evaluate (give a verdict per id)\n${reLines.join('\n')}`);
    }

    parts.push('\nNow output ONLY the #STORY, #SHELVES, #OBS, #CALLBACK and #REEVAL sections.');
    return parts.join('\n\n');
}

/**
 * Parse the reflection LLM output into { summary, observations[] }.
 * Mirrors the tolerant `#`-block grammar used by Agent 1 / Agent 3.
 * @param {string} response
 * @returns {{summary: string, observations: Array<{key:string,value:string}>}}
 */
export function parseReflectResult(response) {
    const out = { summary: '', shelves: [], observations: [], callbacks: [], reevals: [] };
    if (!response || !response.trim()) return out;

    let text = response.replace(/```[\s\S]*?```/g, m => m.replace(/```\w*/g, '').trim()).replace(/```/g, '');

    // #STORY ... (bounded before #SHELVES/#OBS — whichever comes first).
    const storyMatch = text.match(/#STORY\s*([\s\S]*?)(?=\n\s*#SHELVES|\n\s*#OBS|$)/i);
    if (storyMatch) {
        let s = storyMatch[1].trim();
        // The grammar tells the model to terminate the section with a lone ".". Strip a
        // trailing terminator line, then treat a bare "." / "(none)" as empty.
        s = s.replace(/\n?\s*\.\s*$/, '').trim();
        if (s === '.' || /^\(none\)$/i.test(s)) s = '';
        if (s.length > MAX_SUMMARY_CHARS) s = s.slice(0, MAX_SUMMARY_CHARS).trimEnd() + '…';
        out.summary = s;
    }

    // #SHELVES lines: `+ Category/aspect = short summary`. Bounded before #OBS.
    const shelvesMatch = text.match(/#SHELVES\s*([\s\S]*?)(?=\n\s*#OBS|\n\s*#REEVAL|$)/i);
    if (shelvesMatch) {
        const block = shelvesMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const eqIdx = line.indexOf('=');
                if (eqIdx < 0) continue;
                let label = line.slice(0, eqIdx).trim();
                // Strip an optional trailing "(N facts)" the model may echo from the prompt.
                label = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
                const slashIdx = label.indexOf('/');
                if (slashIdx < 0) continue; // need Category/aspect
                const category = label.slice(0, slashIdx).trim();
                const aspect = label.slice(slashIdx + 1).trim().toLowerCase();
                let value = line.slice(eqIdx + 1).trim();
                if (!category || !aspect || !value) continue;
                if (value.length > MAX_SHELF_SUMMARY_CHARS) value = value.slice(0, MAX_SHELF_SUMMARY_CHARS).trimEnd() + '…';
                out.shelves.push({ category, aspect, text: value });
                if (out.shelves.length >= MAX_SHELVES_PER_PASS) break;
            }
        }
    }

    // #OBS lines: `+ key = value`. Bounded BEFORE #CALLBACK/#REEVAL so it can't swallow them.
    const obsMatch = text.match(/#OBS\s*([\s\S]*?)(?=\n\s*#CALLBACK|\n\s*#REEVAL|$)/i);
    if (obsMatch) {
        const block = obsMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const eqIdx = line.indexOf('=');
                if (eqIdx < 0) continue;
                let key = line.slice(0, eqIdx).trim();
                // Strip an optional Category/ prefix if the model added one.
                const slashIdx = key.indexOf('/');
                if (slashIdx >= 0) key = key.slice(slashIdx + 1).trim();
                key = key.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
                const value = line.slice(eqIdx + 1).trim();
                if (!key || !value) continue;
                out.observations.push({ key, value });
                if (out.observations.length >= MAX_OBSERVATIONS) break;
            }
        }
    }

    // #CALLBACK lines (Resonance Part A): `+ <earlier_id> <- <later_id> | <reason>`. A typed,
    // cross-beat ECHO edge — the EARLIER beat pays off in the LATER one. Parsed leniently and
    // bounded BEFORE #REEVAL. Graceful when absent (a lone "."): out.callbacks stays empty.
    // We accept `<-` (the documented arrow) and tolerate a few near-forms the model may emit.
    const cbMatch = text.match(/#CALLBACK\s*([\s\S]*?)(?=\n\s*#REEVAL|$)/i);
    if (cbMatch) {
        const block = cbMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                // Split off an optional `| reason` tail FIRST so an arrow inside a reason can't fool us.
                let reason = '';
                const barIdx = line.indexOf('|');
                if (barIdx >= 0) { reason = line.slice(barIdx + 1).trim(); line = line.slice(0, barIdx).trim(); }
                // The link grammar is `earlier <- later`. Tolerate `<-`, `<=`, `<--`, or the words
                // "echoes"/"from" as the separator; the EARLIER id is always on the LEFT.
                const m = line.split(/\s*(?:<\-{1,2}|<=|⟵|\becho(?:e?s)?\b|\bfrom\b)\s*/i);
                if (!m || m.length < 2) continue;
                const earlierId = (m[0] || '').trim().replace(/^\[|\]$/g, '').trim();
                const laterId = (m[1] || '').trim().replace(/^\[|\]$/g, '').trim();
                if (!earlierId || !laterId || earlierId === laterId) continue;
                if (reason.length > MAX_CALLBACK_REASON_CHARS) reason = reason.slice(0, MAX_CALLBACK_REASON_CHARS).trimEnd() + '…';
                out.callbacks.push({ earlierId, laterId, reason });
                if (out.callbacks.length >= MAX_CALLBACKS_PER_PASS) break;
            }
        }
    }

    // #REEVAL lines: `+ <id> = promote | <Category> | <aspect>` / `= drop` / `= keep`.
    // The id is the candidate's `category::key` token emitted in the prompt.
    const reMatch = text.match(/#REEVAL\s*([\s\S]*?)$/i);
    if (reMatch) {
        const block = reMatch[1].trim();
        if (block && block !== '.' && !/^\(none\)$/i.test(block)) {
            for (const rawLine of block.split('\n')) {
                let line = rawLine.replace(/^[\s\-\*\d.)\]]+/, '').trim();
                if (!line || line === '.' || !line.startsWith('+')) continue;
                line = line.slice(1).trim();
                const eqIdx = line.indexOf('=');
                if (eqIdx < 0) continue;
                // The id may be wrapped in [brackets] as printed in the prompt — strip them.
                let id = line.slice(0, eqIdx).trim().replace(/^\[|\]$/g, '').trim();
                const verdictPart = line.slice(eqIdx + 1).trim();
                const segs = verdictPart.split('|').map(s => s.trim()).filter(Boolean);
                const verdict = (segs[0] || '').toLowerCase();
                if (!id || !verdict) continue;
                if (verdict.startsWith('promote')) {
                    out.reevals.push({ id, verdict: 'promote', category: segs[1] || '', aspect: (segs[2] || '').toLowerCase() });
                } else if (verdict.startsWith('drop')) {
                    out.reevals.push({ id, verdict: 'drop' });
                } else {
                    out.reevals.push({ id, verdict: 'keep' });
                }
            }
        }
    }
    return out;
}

/**
 * Run the reflection / consolidation pass. ONE LLM call. Writes the rolling summary to
 * chat_metadata via setReflection() and synthesized observations as normal facts via
 * upsertFact (category Behavior, kind:trait, importance 4, tagged observation/reflection)
 * so they ride the existing retrieval/eviction/supersession machinery and reconcile on
 * write (no duplicate spam).
 *
 * @param {object} args
 * @param {string} args.runId - the originating pipeline run id (for traceability)
 * @param {object|null} args.scene - current scene card
 * @param {object|null} args.prevReflection - prior reflection
 * @param {string} args.characterInfo - character card info (for {{char}} grounding)
 * @param {string} args.userPersona
 * @param {string|null} args.profileId - connection profile (reuse Agent 3's)
 * @returns {Promise<{summary:string, observations:Array, tokensIn:number, tokensOut:number, error?:string}>}
 */
export async function runReflection({ runId = '', scene = null, prevReflection = null, characterInfo = '', userPersona = '', profileId = null } = {}) {
    try {
        const databases = await getAllDatabases();

        // Skip when there's genuinely nothing to consolidate (no facts, no scene).
        const totalFacts = Object.values(databases).reduce((n, db) => n + (db.facts?.length || 0), 0);
        if (totalFacts === 0 && !scene) {
            addDebugLog('info', `[${runId}] Reflection skipped (nothing to consolidate)`);
            return { summary: '', observations: [], merged: 0, tokensIn: 0, tokensOut: 0 };
        }

        // (a) SILENT DEDUPE-JANITOR (refinement #12): merge near-duplicate facts that piled
        // up over the session by re-running reconcile-on-write over each DB. NO LLM call.
        // Best-effort + isolated per category so one bad DB can't abort the whole pass.
        let totalMerged = 0;
        for (const [category, db] of Object.entries(databases)) {
            try {
                const { db: cleaned, merged } = dedupeDatabase(db);
                if (merged > 0) {
                    databases[category] = cleaned;
                    await saveDatabase(cleaned);
                    totalMerged += merged;
                    addDebugLog('info', `[${runId}] Dedupe-janitor: merged ${merged} duplicate fact(s) in ${category}`);
                }
            } catch (err) {
                addDebugLog('fail', `[${runId}] Dedupe-janitor failed for ${category} (non-fatal): ${err.message || err}`);
            }
        }
        if (totalMerged > 0) addDebugLog('pass', `[${runId}] Dedupe-janitor merged ${totalMerged} duplicate fact(s) total`);

        // CONTRADICTION SCAN (atomic #7). Heuristic, no LLM call. Every N reflection passes,
        // flag same-key / near-key facts with differing values into the review popup as
        // read-only CONFLICT items. Runs AFTER dedupe, so what it surfaces is a genuine semantic
        // conflict the normalized-key merge didn't catch.
        try {
            const cfgScan = host.getExtensionSettings();
            if (cfgScan?.contradictionScanEnabled !== false) {
                const interval = Math.max(1, Number(cfgScan?.contradictionInterval) || 3);
                const chatMeta = SillyTavern.getContext().chatMetadata;
                let reflectRuns = 1;
                if (chatMeta) {
                    chatMeta.bf_mem_reflect_runs = (chatMeta.bf_mem_reflect_runs || 0) + 1;
                    reflectRuns = chatMeta.bf_mem_reflect_runs;
                }
                if (reflectRuns % interval === 0) {
                    const seen = new Set();
                    const pairs = [...findKeyConflicts(databases), ...findNearKeyConflicts(databases)]
                        .filter(p => {
                            const id = [`${p.a.category}:${p.a.fact.key}`, `${p.b.category}:${p.b.fact.key}`].sort().join('|');
                            if (seen.has(id)) return false;
                            seen.add(id);
                            return true;
                        })
                        .slice(0, MAX_CONFLICT_PAIRS);
                    for (const p of pairs) {
                        trackUpdate({
                            action: 'conflict',
                            category: p.a.category,
                            key: p.a.fact.key,
                            value: `"${p.a.fact.value}"  vs  ${p.b.category}/${p.b.fact.key} = "${p.b.fact.value}"`,
                            knownBy: p.a.fact.knownBy || [],
                        });
                    }
                    if (pairs.length > 0) addDebugLog('info', `[${runId}] Contradiction scan queued ${pairs.length} conflict(s) for review`);
                }
            }
        } catch (err) {
            addDebugLog('fail', `[${runId}] Contradiction scan failed (non-fatal): ${err.message || err}`);
        }

        const settings = host.getExtensionSettings();
        const substitute = host.getSubstituteParams();

        const systemPrompt = substitute(settings?.reflectionPrompt || DEFAULT_REFLECT_PROMPT);

        // Re-evaluation: gather uncertain facts (Unsorted/misc + stale states) so the SAME
        // reflection LLM call can also issue promote/drop/keep verdicts on them. Bounded.
        const reevalCandidates = collectReevalCandidates(databases);
        const reevalById = new Map(reevalCandidates.map(c => [c.id, c]));

        // CALLBACK LINKS (Resonance Part A): gather the recent `moment` beats so the SAME reflection
        // LLM call can ALSO name cross-beat echo edges. Bounded (MAX_MOMENTS_FOR_CALLBACK). The
        // id→candidate map lets us validate the model's referenced ids against real facts (drop
        // dangling/hallucinated refs, mirroring the #REEVAL id check + the anti-drift shelf snap).
        const recentMoments = collectRecentMoments(databases);
        const momentById = new Map(recentMoments.map(c => [c.id, c]));

        // SUMMARY PYRAMID (middle layer): pick which (category, aspect) shelves changed since
        // their last summary and fold a bounded #SHELVES request into THIS same LLM call (no
        // extra call). Index is built from the post-dedupe databases. Cost-guarded: only
        // changed buckets, capped at MAX_SHELVES_PER_PASS — unchanged buckets are never touched.
        const priorPyramid = (() => { try { return getSummaryPyramid(); } catch { return null; } })();
        let index = null;
        try { index = buildMemoryIndex(databases); } catch { index = null; }
        const changedShelves = index ? pickChangedShelves(index, priorPyramid) : [];
        if (changedShelves.length) {
            addDebugLog('info', `[${runId}] Summary pyramid: ${changedShelves.length} changed shelf(s) queued for summary (cap ${MAX_SHELVES_PER_PASS}): ${changedShelves.map(s => `${s.category}/${s.aspect}`).join(', ')}`, {
                subsystem: 'reflection', event: 'summary.shelves',
                data: { queued: changedShelves.length, cap: MAX_SHELVES_PER_PASS, buckets: changedShelves.map(s => s.bucketKey) },
            });
        }

        const dataParts = [];
        if (characterInfo) dataParts.push(`## Character Info ({{char}})\n${characterInfo}`);
        if (userPersona) dataParts.push(`## User Persona ({{user}})\n${userPersona}`);
        dataParts.push(buildReflectInput({ scene, databases, reevalCandidates, changedShelves, recentMoments }));
        const userPrompt = substitute(dataParts.join('\n\n'));

        addDebugLog('info', `[${runId}] Reflection pass: system=${systemPrompt.length}, user=${userPrompt.length} chars`);

        const resultStr = await callAgentLLM(systemPrompt, userPrompt, profileId, 'reflection');
        const tokensIn = await host.getTokenCount(systemPrompt + '\n' + userPrompt);
        const tokensOut = await host.getTokenCount(resultStr);
        addDebugLog('info', `[${runId}] Reflection LLM reply (${resultStr.length} chars):\n${resultStr}`);

        const parsed = parseReflectResult(resultStr);

        // Persist reflection state (per-chat) for the live UI panel. FIX #12: the rolling
        // #STORY summary is no longer requested, so parsed.summary is normally empty — we now
        // store whenever there is EITHER a (legacy/custom-prompt) summary OR observations, so
        // the panel keeps rendering the synthesized observation chips. normalizeReflection
        // accepts an observations-only reflection (returns null only when BOTH are empty).
        if (parsed.summary || parsed.observations.length > 0) {
            setReflection({ summary: parsed.summary, observations: parsed.observations.map(o => o.value) }, runId);
        }

        // SUMMARY PYRAMID — merge this pass's refreshed shelf summaries into the stored pyramid
        // and refresh the TOP (story) level from the SAME reflection #STORY (NOT duplicated — we
        // reuse parsed.summary, the top of the pyramid). Unchanged shelves are carried forward
        // verbatim from priorPyramid (never re-summarized). Each refreshed shelf records the
        // factCount it was summarized against so the NEXT pass's changed-bucket detection works.
        // Stored in chat_metadata (out of keyword retrieval — no pollution). NEVER deletes facts.
        try {
            const changedByKey = new Map(changedShelves.map(s => [`${s.category.toLowerCase()}||${s.aspect}`, s]));
            const mergedShelves = { ...((priorPyramid && priorPyramid.shelves) || {}) };
            let refreshed = 0;
            for (const sh of (parsed.shelves || [])) {
                const bucketKey = `${String(sh.category).toLowerCase()}||${String(sh.aspect).toLowerCase()}`;
                // Pair the model's summary with the live factCount we computed for that bucket.
                const queued = changedByKey.get(bucketKey);
                if (!queued) continue; // model returned a shelf we didn't ask for — ignore (anti-drift)
                mergedShelves[bucketKey] = { text: sh.text, factCount: queued.factCount, updatedAt: Date.now() };
                refreshed++;
            }
            const storyForPyramid = parsed.summary || (priorPyramid && priorPyramid.story) || '';
            if (storyForPyramid || Object.keys(mergedShelves).length > 0) {
                setSummaryPyramid({ story: storyForPyramid, shelves: mergedShelves }, runId);
            }
            if (refreshed > 0) {
                addDebugLog('info', `[${runId}] Summary pyramid: refreshed ${refreshed} shelf summary(ies); ${Object.keys(mergedShelves).length} shelf(s) stored total`, {
                    subsystem: 'reflection', event: 'summary.shelves',
                    data: { refreshed, totalStored: Object.keys(mergedShelves).length, buckets: parsed.shelves.map(s => `${s.category}/${s.aspect}`) },
                });
            }
        } catch (err) {
            addDebugLog('fail', `[${runId}] Summary pyramid update failed (non-fatal): ${err.message || err}`, {
                subsystem: 'reflection', event: 'summary.shelves', reason: 'ERROR',
            });
        }

        // Write observations as normal facts. reconcile-on-write in upsertFact prevents
        // duplicate spam against existing facts/observations with the same key.
        let written = 0;
        if (parsed.observations.length > 0) {
            const category = 'Behavior';
            if (!databases[category]) databases[category] = createEmptyDatabase(category);
            const db = databases[category];
            const charName = host.getCurrentCharacterName();
            for (const obs of parsed.observations) {
                upsertFact(db, {
                    key: obs.key,
                    value: obs.value,
                    tags: ['observation', 'reflection'],
                    knownBy: charName ? [charName] : [],
                    relationships: { primary: [], secondary: [], tertiary: [] },
                    source: `reflection_${runId}`,
                    importance: 4,
                    kind: 'trait',
                });
                written++;
            }
            try {
                await saveDatabase(db);
                addDebugLog('pass', `[${runId}] Reflection wrote ${written} observation(s) to Behavior`);
            } catch (err) {
                addDebugLog('fail', `[${runId}] Reflection failed to save observations: ${err.message || err}`);
            }
        }

        // CALLBACK LINKS (Resonance Part A): store the model's cross-beat echo edges as a typed,
        // additive `callbacks[]` ref on the EARLIER fact — pointing FORWARD to the later beat that
        // pays it off (matching the autoLinkFact "store on the source, resolve at retrieval" shape).
        // VALIDATION: both ids MUST resolve to real facts in this pass's moment set (momentById) —
        // dangling/hallucinated refs are dropped (mirrors the #REEVAL id check + the anti-drift
        // shelf snap). Idempotent: a re-authored identical edge is de-duped by laterId. Bounded by
        // the parser's MAX_CALLBACKS_PER_PASS. Backward-compatible: the field is only ever ADDED,
        // never required; older facts simply have no `callbacks`. NEVER deletes/supersedes facts.
        let callbacksWritten = 0;
        const callbackModified = new Set();
        for (const cb of (parsed.callbacks || [])) {
            const earlier = momentById.get(cb.earlierId);
            const later = momentById.get(cb.laterId);
            if (!earlier || !later) continue; // dangling/hallucinated ref — drop it
            if (earlier.fact === later.fact) continue; // self-link — skip
            const fact = earlier.fact;
            if (!Array.isArray(fact.callbacks)) fact.callbacks = [];
            // De-dupe by the target (later) fact key — one edge per earlier→later pair.
            if (fact.callbacks.some(c => c && c.toKey === later.key && c.toCategory === later.category)) continue;
            fact.callbacks.push({ toCategory: later.category, toKey: later.key, reason: cb.reason || '', at: Date.now() });
            callbackModified.add(earlier.category);
            callbacksWritten++;
            addDebugLog('info', `[${runId}] Reflection callback-link: [${earlier.category}] ${earlier.key} <- [${later.category}] ${later.key}${cb.reason ? ` | ${cb.reason}` : ''}`, {
                subsystem: 'reflection', event: 'callback.linked', reason: 'ECHO',
                data: { fromCategory: earlier.category, fromKey: earlier.key, toCategory: later.category, toKey: later.key, reason: cb.reason || '' },
            });
        }
        for (const category of callbackModified) {
            try { await saveDatabase(databases[category]); }
            catch (err) { addDebugLog('fail', `[${runId}] Callback-link failed to save "${category}": ${err.message || err}`); }
        }
        if (callbacksWritten > 0) {
            addDebugLog('pass', `[${runId}] Reflection authored ${callbacksWritten} callback-link(s) (cap ${MAX_CALLBACKS_PER_PASS}, from ${recentMoments.length} recent moment(s))`);
        }

        // RE-EVALUATION: apply promote/drop verdicts on the uncertain candidates. PROMOTE
        // moves the fact to its proper Layer-1 category + aspect (and bumps importance so it
        // stops looking transient); DROP DEMOTES a confirmed one-off TO COLD-TIER (never-delete:
        // the fact stays on disk + resurrectable, just deprioritized — NOT removed); KEEP/unknown
        // is a no-op. Cheap, bounded by MAX_REEVAL_CANDIDATES, and logged with reasons. Best-effort.
        let promoted = 0, dropped = 0;
        const reevalModified = new Set();
        for (const v of (parsed.reevals || [])) {
            const cand = reevalById.get(v.id);
            if (!cand) continue; // hallucinated id — skip
            const fromDb = databases[cand.category];
            if (!fromDb) continue;
            const fact = (fromDb.facts || []).find(f => f.key === cand.key && f.active !== false);
            if (!fact) continue; // already gone (deduped/superseded since collection)

            if (v.verdict === 'drop') {
                // NEVER-DELETE: a "drop" verdict DEMOTES the fact to cold-tier instead of removing
                // it. The fact remains in db.facts (cold:true) — durable on disk + resurrectable
                // exactly like any cold-tiered overflow fact (a later re-mention/update/direct
                // match un-colds it). markFactCold also logs `fact.demoted` (subsystem:'db'); we
                // additionally log the reflection-level demotion so a #REEVAL "drop" is visible as
                // a cold-tiering, not a deletion. Idempotent: already-cold facts still count.
                const newlyCold = markFactCold(fact, cand.category, 'REEVAL_DROP', 'reflection judged one-off');
                reevalModified.add(cand.category);
                dropped++;
                addDebugLog('info', `[${runId}] Re-eval DROP→cold-tier: [${cand.category}] ${cand.key} = "${String(fact.value ?? '').slice(0, 60)}"`, {
                    subsystem: 'reflection', event: 'fact.demoted', reason: 'REEVAL_DROP',
                    data: { category: cand.category, key: cand.key, newlyCold },
                });
                continue;
            }

            if (v.verdict === 'promote') {
                const newCat = L1_CATEGORIES.includes(v.category) ? v.category : cand.category;
                const newAspect = normalizeAspect(v.aspect, newCat);
                // Re-typed from an uncertain misc/state into a confirmed lasting fact: lift to a
                // durable trait and a non-trivial importance so it survives eviction. Carry the
                // fact's content + tags forward unchanged.
                const moved = {
                    ...fact,
                    category: newCat,
                    aspect: newAspect,
                    kind: 'trait',
                    importance: Math.max(3, Number(fact.importance) || 0),
                    source: `reflection_reeval_${runId}`,
                };
                delete moved.lastUpdated; // upsertFact stamps a fresh one
                if (newCat !== cand.category) {
                    if (!databases[newCat]) databases[newCat] = createEmptyDatabase(newCat);
                    upsertFact(databases[newCat], moved);
                    removeFact(fromDb, cand.key);
                    reevalModified.add(cand.category);
                    reevalModified.add(newCat);
                } else {
                    upsertFact(fromDb, moved);
                    reevalModified.add(cand.category);
                }
                promoted++;
                addDebugLog('info', `[${runId}] Re-eval PROMOTE: [${cand.category}] ${cand.key} → ${newCat}/${newAspect}`, {
                    subsystem: 'db', event: 'fact.reeval_promoted', reason: 'CONFIRMED_LASTING',
                    data: { fromCategory: cand.category, toCategory: newCat, key: cand.key, aspect: newAspect },
                });
            }
        }
        for (const category of reevalModified) {
            try { await saveDatabase(databases[category]); }
            catch (err) { addDebugLog('fail', `[${runId}] Re-eval failed to save "${category}": ${err.message || err}`); }
        }
        if (promoted || dropped) {
            addDebugLog('pass', `[${runId}] Re-evaluation: promoted ${promoted}, dropped ${dropped} (from ${reevalCandidates.length} candidate(s))`);
        }

        addDebugLog('info', `[${runId}] Reflection done: merged=${totalMerged}, summary=${parsed.summary ? parsed.summary.length + ' chars' : 'none'}, observations=${written}, callbacks=${callbacksWritten}, reeval(+${promoted}/-${dropped})`);
        return { summary: parsed.summary, observations: parsed.observations, written, merged: totalMerged, callbacks: callbacksWritten, promoted, dropped, tokensIn, tokensOut };
    } catch (error) {
        addDebugLog('fail', `Reflection error (non-fatal): ${error.message || error}`);
        return { summary: '', observations: [], tokensIn: 0, tokensOut: 0, error: error.message || String(error) };
    }
}
