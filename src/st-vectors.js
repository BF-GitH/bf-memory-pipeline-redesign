// BF Memory Pipeline — SillyTavern Vector-Store bridge for SEMANTIC retrieval.
//
// WHY THIS EXISTS: the original semantic layer embedded fact text via a direct embeddings call
// (llm-call.callEmbeddingAPI) and did cosine in JS over a `fact.embedding` stored on each fact.
// On SillyTavern 1.18 that approach does not work: the routes it tried (/api/backends/.../embeddings)
// 404, and CMRS exposes no sendEmbeddingRequest. What ST 1.18 DOES expose is a server-side vector
// store at /api/vector/* that embeds with the chat provider (verified: source:'openrouter' +
// model 'openai/text-embedding-3-small' embeds + returns nearest-neighbour MATCHES). It never hands
// back raw vectors. So we DELEGATE: insert each fact's text into a per-character ST collection, and
// at retrieval time query that collection by the turn text to get matching fact hashes. This also
// removes the settings.json vector-bloat (vectors live in ST's own store, not on the fact objects).
//
// Everything here is gated by settings.semanticRetrieval (default OFF) and degrades to a no-op on
// any failure, so it can never break the keyword/graph retrieval that runs regardless.

import { addDebugLog, getSettings } from './settings.js';
import * as host from './host.js';

const DEFAULT_MODEL = 'openai/text-embedding-3-small';

function ctx() {
    try { return host.getCtx(); } catch { try { return SillyTavern.getContext(); } catch { return null; } }
}

/**
 * The embedding SOURCE ST should use. An explicit `embeddingSource` setting wins; otherwise we
 * derive it from the active chat-completion source (so an OpenRouter user gets 'openrouter', an
 * OpenAI user gets 'openai', etc. — exactly the values ST's vector backend understands).
 */
export function getEmbeddingSource(s = getSettings()) {
    const explicit = String(s?.embeddingSource || '').trim();
    if (explicit) return explicit;
    try {
        const c = ctx();
        return c?.chatCompletionSettings?.chat_completion_source || c?.mainApi || 'openrouter';
    } catch { return 'openrouter'; }
}

/**
 * The embedding MODEL for a source. Normalizes the provider prefix: OpenRouter needs a provider-
 * qualified id (e.g. `openai/text-embedding-3-small`), while the direct `openai` source wants the
 * bare id. Falls back to a sensible default.
 */
export function getEmbeddingModel(s = getSettings(), source = null) {
    const src = source || getEmbeddingSource(s);
    let m = String(s?.embeddingModel || '').trim() || DEFAULT_MODEL;
    if (src === 'openrouter' && !m.includes('/')) m = 'openai/' + m;
    if (src === 'openai' && m.startsWith('openai/')) m = m.slice('openai/'.length);
    return m;
}

function currentAvatar() {
    try { const c = ctx(); return c?.characters?.[c.characterId]?.avatar || c?.name2 || 'default'; } catch { return 'default'; }
}

/** Per-character ST vector collection id (mirrors the per-character DB partitioning). */
export function collectionId(avatar = currentAvatar()) {
    return 'bf_mem_' + String(avatar).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Deterministic positive 31-bit hash of `category:key` → the numeric hash ST stores a vector under.
 * Deterministic so we never need to persist a hash→fact map: at query time we recompute it for each
 * candidate fact and match. Collision probability across a few thousand facts is negligible.
 */
export function factHash(category, key) {
    const str = `${category}:${key}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 1);
}

function headers() { try { return host.getRequestHeaders(); } catch { return null; } }

async function vpost(route, body) {
    const h = headers();
    if (!h) return null;
    try {
        const r = await fetch(route, { method: 'POST', headers: h, body: JSON.stringify(body) });
        if (!r.ok) { addDebugLog('info', `ST vectors ${route} → HTTP ${r.status}`); return null; }
        const t = await r.text();
        try { return JSON.parse(t); } catch { return t; } // insert/purge return plain "OK"
    } catch (e) { addDebugLog('info', `ST vectors ${route} failed: ${e.message || e}`); return null; }
}

/** Text we embed for a fact: key + value + tags + context, length-bounded. */
function embedTextFor(fact) {
    return [fact.key, fact.value, (fact.tags || []).join(' '), fact.context || '']
        .filter(Boolean).join(' ').slice(0, 512);
}

/**
 * Insert/update fact vectors into this character's ST collection. Entries are `{category, fact}`.
 * Returns the count sent (0 on no-op/failure). Inserting the same hash again overwrites — so a
 * changed fact re-embeds cleanly. Stale vectors for deleted/superseded facts are harmless: at query
 * time their hash simply won't resolve to an active fact and is skipped.
 * @param {Array<{category: string, fact: Object}>} entries
 * @param {{avatar?: string}} [opts]
 * @returns {Promise<number>}
 */
export async function insertFactVectors(entries, opts = {}) {
    const s = getSettings();
    if (!s?.semanticRetrieval || !Array.isArray(entries) || entries.length === 0) return 0;
    const source = getEmbeddingSource(s);
    const model = getEmbeddingModel(s, source);
    const C = collectionId(opts.avatar || currentAvatar());
    const items = entries
        .filter(e => e && e.category && e.fact && e.fact.key)
        .map(e => { const hash = factHash(e.category, e.fact.key); return { hash, text: embedTextFor(e.fact), index: hash }; });
    if (items.length === 0) return 0;
    const r = await vpost('/api/vector/insert', { collectionId: C, items, source, model });
    return r === null ? 0 : items.length;
}

/**
 * Query the character's ST collection by free text and resolve the matched hashes back to
 * `category:key` ids present in `databases`. Returns a Set of ids (empty on no-op/failure).
 * @param {string} queryText
 * @param {number} topK
 * @param {Object} databases - the current {category: {facts:[]}} map (for hash→id resolution)
 * @returns {Promise<Set<string>>}
 */
export async function querySemanticIds(queryText, topK, databases) {
    const s = getSettings();
    if (!s?.semanticRetrieval) return new Set();
    const q = String(queryText || '').trim();
    if (!q) return new Set();
    const source = getEmbeddingSource(s);
    const model = getEmbeddingModel(s, source);
    const r = await vpost('/api/vector/query', { collectionId: collectionId(), searchText: q, topK: Math.max(1, topK || 8), source, model });
    if (!r || typeof r === 'string') return new Set();
    const hashes = new Set(r.hashes || (Array.isArray(r.metadata) ? r.metadata.map(m => m.hash) : []));
    if (hashes.size === 0) return new Set();
    const ids = new Set();
    for (const [category, db] of Object.entries(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!fact || !fact.key) continue;
            if (hashes.has(factHash(category, fact.key))) ids.add(`${category}:${fact.key}`);
        }
    }
    return ids;
}

/**
 * Connectivity test via the REAL mechanism: insert a probe into a scratch collection and query it
 * back. Returns a structured result with the source/model actually used and a specific reason.
 * Read-only-ish: it writes + purges its own throwaway collection only.
 * @returns {Promise<{ok: boolean, source: string, model: string, reason: string}>}
 */
export async function testVectorEmbedding() {
    const s = getSettings();
    const source = getEmbeddingSource(s);
    const model = getEmbeddingModel(s, source);
    const C = 'bf_mem_endpoint_test';
    await vpost('/api/vector/purge', { collectionId: C });
    const ins = await vpost('/api/vector/insert', { collectionId: C, items: [{ hash: 1, text: 'embedding connectivity probe', index: 1 }], source, model });
    let ok = false, reason;
    if (ins === null) {
        reason = `insert failed for source "${source}", model "${model}" — confirm this provider serves embeddings (e.g. OpenRouter: openai/text-embedding-3-small).`;
    } else {
        const q = await vpost('/api/vector/query', { collectionId: C, searchText: 'probe', topK: 1, source, model });
        ok = !!(q && typeof q !== 'string' && ((q.hashes && q.hashes.length) || (q.metadata && q.metadata.length)));
        reason = ok ? 'ok' : 'inserted but query returned no match';
    }
    await vpost('/api/vector/purge', { collectionId: C });
    return { ok, source, model, reason };
}
