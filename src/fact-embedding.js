// BF Memory Pipeline - Fact embedding (atomic #1 + #16)
// Embeds fact text into vectors for SEMANTIC retrieval (match by meaning, not keyword/graph).
// All OPT-IN (settings.semanticRetrieval) and GRACEFULLY DEGRADING: if no embedding endpoint
// responds, callEmbeddingAPI returns null and every function here no-ops, leaving the existing
// keyword/trigram/spiderweb retrieval untouched. Vectors are stored as plain number[] on
// `fact.embedding` so they survive JSON serialization in the existing persistence layer.

import { addDebugLog, getSettings } from './settings.js';
import { callEmbeddingAPI } from './llm-call.js';
import { getEmbeddingProfileId } from './profiler.js';
import { getAllDatabases, saveDatabase, isActiveFact, isSequenceFact } from './database.js';

const EMBED_BATCH_SIZE = 30;
const BACKOFF_DELAYS_MS = [1000, 2000, 4000];

/** Text we embed for a fact: key + value + tags + context, lowercased, length-bounded. */
export function factEmbedText(fact) {
    return [fact.key, fact.value, (fact.tags || []).join(' '), fact.context || '']
        .filter(Boolean).join(' ').slice(0, 512);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Embed one batch with exponential backoff, then ADAPTIVE HALVING on failure (#16): a failing
 * batch is split in two and each half retried, so one bad/oversized item can't fail the group.
 * Returns number[][] aligned to `texts` (nulls for items that never embedded).
 */
async function embedBatchAdaptive(texts, profileId, model, depth = 0) {
    for (let attempt = 0; attempt <= BACKOFF_DELAYS_MS.length; attempt++) {
        if (attempt > 0) await sleep(BACKOFF_DELAYS_MS[attempt - 1]);
        const vecs = await callEmbeddingAPI(texts, profileId, model);
        if (vecs && vecs.length === texts.length) return vecs;
        if (vecs && vecs.length) return texts.map((_, i) => vecs[i] || null);
    }
    if (texts.length > 1 && depth < 6) {
        const mid = Math.floor(texts.length / 2);
        const [l, r] = await Promise.all([
            embedBatchAdaptive(texts.slice(0, mid), profileId, model, depth + 1),
            embedBatchAdaptive(texts.slice(mid), profileId, model, depth + 1),
        ]);
        return [...l, ...r];
    }
    return texts.map(() => null);
}

/**
 * Embed an array of fact objects IN PLACE (sets `fact.embedding`). Skips facts that already
 * have an embedding unless `force`. No-ops (returns 0) when semantic retrieval is off or no
 * endpoint responds. Does NOT save — caller persists. (#1 write-path + #16 bulk share this.)
 * @returns {Promise<number>} count newly embedded
 */
export async function embedFacts(facts, { profileId = null, model, force = false } = {}) {
    const s = getSettings();
    if (!s?.semanticRetrieval) return 0;
    const targets = facts.filter(f => f && f.key && (force || !Array.isArray(f.embedding)));
    if (targets.length === 0) return 0;
    const pid = profileId ?? getEmbeddingProfileId(s);
    const mdl = model || s.embeddingModel || 'text-embedding-3-small';

    let embedded = 0;
    for (let i = 0; i < targets.length; i += EMBED_BATCH_SIZE) {
        const chunk = targets.slice(i, i + EMBED_BATCH_SIZE);
        const vecs = await embedBatchAdaptive(chunk.map(factEmbedText), pid, mdl);
        chunk.forEach((f, j) => {
            if (Array.isArray(vecs[j]) && vecs[j].length) { f.embedding = Array.from(vecs[j]); embedded++; }
        });
    }
    return embedded;
}

/**
 * One-shot: embed every active non-sequence fact lacking a vector, then re-save touched
 * categories (#16). For the settings "Embed all facts" button. Safe no-op when off / no endpoint.
 * @returns {Promise<{succeeded:number, total:number}>}
 */
export async function bulkEmbedAllFacts(onProgress = () => {}) {
    const s = getSettings();
    if (!s?.semanticRetrieval) { addDebugLog('info', 'Bulk embed skipped — semantic retrieval is off'); return { succeeded: 0, total: 0 }; }
    // Delegate to SillyTavern's server-side vector store (works on ST 1.18 with the chat provider,
    // e.g. OpenRouter). Vectors live in ST's store — NOT on fact.embedding / settings.json — so this
    // no longer bloats the saved settings. Inserts are idempotent per fact hash (re-embed overwrites).
    const databases = await getAllDatabases();
    const entries = [];
    for (const [category, db] of Object.entries(databases)) {
        for (const fact of (db.facts || [])) {
            if (!isActiveFact(fact) || isSequenceFact(fact)) continue;
            entries.push({ category, fact });
        }
    }
    const total = entries.length;
    if (total === 0) return { succeeded: 0, total: 0 };
    addDebugLog('info', `Bulk embed (ST vectors): inserting ${total} fact vector(s)`);

    const { insertFactVectors } = await import('./st-vectors.js');
    const BATCH = 64;
    let succeeded = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
        succeeded += await insertFactVectors(entries.slice(i, i + BATCH));
        onProgress({ done: Math.min(i + BATCH, total), total });
    }
    addDebugLog('pass', `Bulk embed done (ST vectors): ${succeeded}/${total} inserted`);
    return { succeeded, total };
}
