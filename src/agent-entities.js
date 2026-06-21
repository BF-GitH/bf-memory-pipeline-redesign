// BF Memory Pipeline - Character Registry + NPC-Promotion Flow
//
// A per-chat registry of named entities that surface in the fact store, plus the
// detection / popup / migration flow that lets the user classify each newly-seen
// NAMED entity as a recurring character, a one-off NPC, or "decide later".
//
// Storage mirrors the existing bf_mem_* per-chat pattern (chat_metadata): the registry
// lives under `bf_mem_entities` and is reloaded on CHAT_CHANGED with a shape-checked
// loader (see getEntities/setEntities/reloadEntitiesFromChat below). Everything here is
// OFF the latency-critical path — detection runs on MESSAGE_RECEIVED behind an interval
// gate, the popup is shown deferred (setTimeout), and migration uses the existing DB
// write path. All three are wrapped in try/catch by the caller so nothing breaks the
// reply or the next turn.
//
// CRITICAL: this module never hard-codes any specific character name — it discovers names
// at runtime from the fact store (involved/subject/about) using deterministic heuristics.

import { addDebugLog, getSettings } from './settings.js';
import {
    getAllDatabases, saveDatabase, upsertFact, deriveSubject,
    isActiveFact, isSequenceFact, NPC_SUBJECT,
} from './database.js';
import { trigramSimilarity } from './fact-retrieval.js';

// --- Storage (chat_metadata.bf_mem_entities) ---------------------------------

const ENTITIES_META_KEY = 'bf_mem_entities';

// Valid registry statuses.
//   named   = a recurring character with its own subject (promoted / pre-known)
//   npc     = a one-off; stays in the shared NPC drawer, never re-asked
//   later   = user deferred the decision; re-offered on the next detection check
//   pending = detected but not yet shown to the user (transient — set by detection,
//             cleared when the popup is shown and the user decides)
const VALID_STATUS = new Set(['named', 'npc', 'later', 'pending']);

// In-memory mirror of the registry for the current chat. Map of
// entityName(lowercased) -> { name, status, firstSeen, lastSeen, count }.
// null until first load. Reloaded on CHAT_CHANGED via reloadEntitiesFromChat().
let entities = null;

function getContext() {
    return SillyTavern.getContext();
}

/** Coerce a stored blob into the registry shape, dropping unusable entries. */
function normalizeEntities(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [k, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        const name = typeof v.name === 'string' && v.name.trim() ? v.name.trim() : String(k);
        const key = name.toLowerCase();
        const status = VALID_STATUS.has(v.status) ? v.status : 'pending';
        out[key] = {
            name,
            status,
            firstSeen: Number(v.firstSeen) || Date.now(),
            lastSeen: Number(v.lastSeen) || Number(v.firstSeen) || Date.now(),
            count: Number.isFinite(Number(v.count)) ? Math.max(0, Math.floor(Number(v.count))) : 1,
        };
    }
    return out;
}

function loadEntitiesFromMeta() {
    try {
        const md = getContext().chatMetadata || getContext().chat_metadata;
        if (!md) return {};
        return normalizeEntities(md[ENTITIES_META_KEY]);
    } catch { return {}; }
}

function saveEntitiesToMeta() {
    try {
        const ctx = getContext();
        const md = ctx.chatMetadata || ctx.chat_metadata;
        if (!md) return;
        md[ENTITIES_META_KEY] = entities || {};
        ctx.saveMetadata?.();
    } catch { /* best-effort */ }
}

/** Current registry map (lazily loaded). Read by the UI + detection. */
export function getEntities() {
    if (entities === null) entities = loadEntitiesFromMeta();
    return entities;
}

/** Replace the whole registry (shape-checked) and persist. */
export function setEntities(map) {
    entities = normalizeEntities(map);
    saveEntitiesToMeta();
}

/** Re-load the registry from the current chat's metadata. Called on CHAT_CHANGED. */
export function reloadEntitiesFromChat() {
    entities = loadEntitiesFromMeta();
}

/**
 * Set/merge a single entity's status (and bump bookkeeping). Used by the popup decisions
 * and the UI's re-decide controls. Persists immediately.
 * @param {string} name - the entity's display name
 * @param {('named'|'npc'|'later'|'pending')} status
 */
export function setEntityStatus(name, status) {
    const display = String(name || '').trim();
    if (!display) return;
    if (!VALID_STATUS.has(status)) return;
    const reg = getEntities();
    const key = display.toLowerCase();
    const now = Date.now();
    const prev = reg[key];
    reg[key] = {
        name: prev?.name || display,
        status,
        firstSeen: prev?.firstSeen || now,
        lastSeen: now,
        count: prev?.count || 1,
    };
    saveEntitiesToMeta();
}

/** True when a name is already CLASSIFIED (named or npc) — it won't be re-offered. */
function isClassified(reg, key) {
    const e = reg[key];
    return !!e && (e.status === 'named' || e.status === 'npc');
}

// --- Named-entity detection ---------------------------------------------------

// Tokens we never treat as a discovered character even if capitalized — pronoun-ish,
// roles already known, sentence-leading words, and the reserved drawer subject.
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'so', 'because', 'while', 'when',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'them', 'us',
    'my', 'your', 'his', 'their', 'our', 'this', 'that', 'these', 'those',
    'mr', 'mrs', 'ms', 'dr', 'sir', 'lady', 'lord', 'miss',
    'user', 'char', NPC_SUBJECT,
]);

/**
 * Heuristic: does a token read like a NAMED proper noun (a real character name) rather than
 * a common noun / descriptor? Conservative — a name is a single capitalized word (or a
 * Capitalized multi-word phrase) made of letters, not in the stopword list, and not a
 * descriptor phrase starting with an article (those stay in the NPC drawer). This MIRRORS
 * the inverse of agent-memory's looksLikeUnnamedPerson so detection and drawering agree.
 * @param {string} token
 * @returns {boolean}
 */
function looksLikeNamedEntity(token) {
    const s = String(token || '').trim();
    if (!s) return false;
    // Descriptor phrases ("the man by the window", "a waiter") are NOT names.
    if (/^(the|a|an|some|that|this|one|another)\b/i.test(s)) return false;
    // Multi-word phrase whose first word is lowercase = a description, not a proper name.
    if (/\s/.test(s) && /^[a-z]/.test(s)) return false;
    // Each word must be Capitalized + alphabetic (allow apostrophes/hyphens inside names).
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 3) return false; // a 4+ word "name" is prose
    for (const w of words) {
        if (STOPWORDS.has(w.toLowerCase())) return false;
        if (!/^[A-Z][A-Za-z'’-]*$/.test(w)) return false; // must start uppercase, letters only
    }
    return true;
}

/**
 * Collect candidate NAMED entities from the fact store that are NOT yet classified in the
 * registry. Deterministic — NO LLM call. Sources, per active fact:
 *   - subject (when it's a proper name and not the NPC drawer / user / char),
 *   - involved[] participants,
 *   - about (the provisional descriptor on an NPC-drawered fact — promotes a walk-on once
 *     it has acquired a real name there),
 * Each candidate is bucketed case-insensitively (first-seen casing kept) with an occurrence
 * count. Names already marked `named`/`npc` are skipped (asked once). Names previously marked
 * `later` ARE re-surfaced (the user chose to defer). Returns an array sorted by count desc.
 *
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases
 * @returns {Array<{name: string, count: number, seenAs: string[]}>}
 */
export function scanForNamedCandidates(databases) {
    const reg = getEntities();
    // Build the set of currently-known character/user names so we don't offer {{char}}/{{user}}.
    const ctx = getContext();
    const knownNames = new Set();
    try {
        const cn = ctx.characters?.[ctx.characterId]?.name || '';
        const un = ctx.name1 || '';
        for (const n of [cn, un]) {
            const t = String(n || '').trim().toLowerCase();
            if (t) knownNames.add(t);
        }
    } catch { /* ignore */ }

    // candidateKey -> { name, count, seenAs:Set }
    const found = new Map();
    const consider = (rawName, where) => {
        const name = String(rawName || '').trim();
        if (!name) return;
        if (!looksLikeNamedEntity(name)) return;
        const key = name.toLowerCase();
        if (knownNames.has(key)) return;          // the active character / user, not a discovery
        if (isClassified(reg, key)) return;       // already decided (named/npc) — ask once only
        const cur = found.get(key) || { name, count: 0, seenAs: new Set() };
        cur.count += 1;
        if (where) cur.seenAs.add(where);
        // Prefer a casing that looks like a clean proper name if we saw multiple.
        found.set(key, cur);
    };

    for (const db of Object.values(databases || {})) {
        for (const fact of (db.facts || [])) {
            if (!isActiveFact(fact)) continue;
            // subject (proper-name subjects only — npc/place/event subjects are skipped by the heuristic)
            const subj = deriveSubject(fact);
            if (subj && subj !== NPC_SUBJECT) consider(subj, 'subject');
            // involved participants
            for (const p of (fact.involved || [])) consider(p, 'involved');
            // about: the provisional descriptor/name on an NPC-drawered fact
            if (fact.about) consider(fact.about, 'about');
        }
    }

    return [...found.values()]
        .map(c => ({ name: c.name, count: c.count, seenAs: [...c.seenAs] }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Detection entry point. Records each newly-seen candidate into the registry as `pending`
 * (preserving any prior `later`), bumps counts/lastSeen, and returns the candidates that
 * still need a user decision (status pending or later). The CALLER decides whether to show
 * the popup. Pure bookkeeping + a deterministic scan — never calls an LLM.
 *
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases
 * @returns {Array<{name: string, count: number, seenAs: string[]}>} candidates to ask about
 */
export function detectAndRecord(databases) {
    const reg = getEntities();
    const candidates = scanForNamedCandidates(databases);
    const now = Date.now();
    const toAsk = [];
    for (const c of candidates) {
        const key = c.name.toLowerCase();
        const prev = reg[key];
        // Keep an explicit `later` as `later` (don't reset to pending); otherwise mark pending.
        const status = prev?.status === 'later' ? 'later' : 'pending';
        reg[key] = {
            name: prev?.name || c.name,
            status,
            firstSeen: prev?.firstSeen || now,
            lastSeen: now,
            count: c.count,
        };
        toAsk.push({ name: reg[key].name, count: c.count, seenAs: c.seenAs });
    }
    saveEntitiesToMeta();
    if (toAsk.length > 0) {
        addDebugLog('info', `Entity detection: ${toAsk.length} candidate(s) need a decision`, {
            subsystem: 'entity', event: 'entity.detected', actor: 'SYSTEM',
            data: { count: toAsk.length, candidates: toAsk.map(c => ({ name: c.name, count: c.count, seenAs: c.seenAs })) },
        });
    }
    return toAsk;
}

// --- Popup (ST Popup API) -----------------------------------------------------

// Lazy-loaded ST Popup module (same resilient multi-path import the settings module uses).
let Popup, POPUP_TYPE;
async function ensurePopup() {
    if (Popup) return true;
    const paths = ['../../../../popup.js', '../../../../../popup.js', '../../../../scripts/popup.js'];
    for (const p of paths) {
        try {
            const mod = await import(p);
            Popup = mod.Popup;
            POPUP_TYPE = mod.POPUP_TYPE;
            return true;
        } catch { /* try next */ }
    }
    return false;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

let popupOpen = false; // guard: only one registry popup at a time (never spam)

/**
 * Show ONE batched popup listing every newly-detected named candidate, each with a
 * Recurring / NPC / Later choice (radio group, defaulting to Later so dismissing defers).
 * Uses ST's Popup API (Popup + POPUP_TYPE.TEXT, with custom OK/Cancel buttons) — the same
 * API the DB browser popups use. Off the critical path; the CALLER invokes this via a
 * deferred setTimeout so it never blocks generation. Cancelling / closing defers ALL
 * choices to `later` (re-offered next check). Decisions are written to the registry, and
 * any name marked Recurring is migrated out of the NPC drawer.
 *
 * @param {Array<{name:string, count:number, seenAs:string[]}>} candidates
 * @returns {Promise<void>}
 */
export async function showEntityPopup(candidates) {
    if (popupOpen) return;                       // never stack popups
    const list = (candidates || []).filter(c => c && c.name);
    if (list.length === 0) return;
    const ok = await ensurePopup();
    if (!ok || !Popup) {
        addDebugLog('info', 'Character registry: Popup API unavailable — deferring candidates');
        return;
    }

    const rows = list.map((c, idx) => {
        const nm = escapeHtml(c.name);
        const seen = c.seenAs && c.seenAs.length ? ` <span class="bf-mem-fact-source">(seen in ${escapeHtml(c.seenAs.join(', '))}, ${c.count}x)</span>` : '';
        const grp = `bf_mem_charreg_choice_${idx}`;
        // Default selection = Later (dismiss-safe).
        return `
            <div class="bf-mem-charreg-row" data-name="${nm}" style="display:flex;flex-direction:column;gap:4px;padding:8px 0;border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
                <div><b>${nm}</b>${seen}</div>
                <div class="bf-mem-charreg-choices" style="display:flex;gap:14px;flex-wrap:wrap;">
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="named" /> <span>Recurring</span></label>
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="npc" /> <span>NPC (one-off)</span></label>
                    <label class="checkbox_label"><input type="radio" name="${grp}" value="later" checked /> <span>Later</span></label>
                </div>
            </div>`;
    }).join('');

    const html = `
        <div class="bf-mem-charreg-popup" data-count="${list.length}">
            <h3>New characters detected (${list.length})</h3>
            <p>Mark each newly-seen name. <b>Recurring</b> gives it its own memory subject and moves its facts out of the shared one-off drawer. <b>NPC</b> keeps it as an incidental walk-on. <b>Later</b> defers (asked again next check).</p>
            <div class="bf-mem-charreg-list" style="max-height:50vh;overflow-y:auto;">${rows}</div>
        </div>`;

    popupOpen = true;
    addDebugLog('info', `Entity popup shown for ${list.length} candidate(s)`, {
        subsystem: 'entity', event: 'entity.popup', actor: 'SYSTEM',
        data: { count: list.length, names: list.map(c => c.name) },
    });
    let decisions = {};
    try {
        const popup = new Popup(html, POPUP_TYPE.TEXT, '', {
            okButton: 'Save',
            cancelButton: 'Later (defer all)',
            wide: true,
            allowVerticalScrolling: true,
        });
        const result = await popup.show();
        const root = popup.dlg || popup.content || document;
        // Collect each row's chosen value (default later). When the user cancelled/closed
        // (result falsy), force EVERYTHING to `later` so nothing is silently lost.
        const cancelled = !result;
        root.querySelectorAll?.('.bf-mem-charreg-row').forEach((row) => {
            const name = row.getAttribute('data-name');
            if (!name) return;
            let choice = 'later';
            const sel = row.querySelector('input[type="radio"]:checked');
            if (sel && sel.value) choice = sel.value;
            decisions[name] = cancelled ? 'later' : choice;
        });
    } catch (err) {
        addDebugLog('fail', `Character registry popup failed (non-fatal): ${err.message || err}`);
        return;
    } finally {
        popupOpen = false;
    }

    // Apply decisions: write status, and migrate any Recurring out of the NPC drawer.
    let promoted = 0, markedNpc = 0, deferred = 0;
    for (const [name, choice] of Object.entries(decisions)) {
        try {
            const reason = choice === 'named' ? 'USER_MARKED_RECURRING'
                : choice === 'npc' ? 'USER_MARKED_NPC' : 'USER_MARKED_LATER';
            addDebugLog('info', `Entity decision: "${name}" → ${choice}`, {
                subsystem: 'entity', event: 'entity.decided', reason, actor: 'USER',
                data: { name, choice },
            });
            if (choice === 'named') {
                setEntityStatus(name, 'named');
                await promoteEntity(name);
                promoted++;
            } else if (choice === 'npc') {
                setEntityStatus(name, 'npc');
                markedNpc++;
            } else {
                setEntityStatus(name, 'later');
                deferred++;
            }
        } catch (err) {
            addDebugLog('fail', `Character registry: decision for "${name}" failed (non-fatal): ${err.message || err}`);
        }
    }
    addDebugLog('info', `Character registry: ${promoted} promoted, ${markedNpc} NPC, ${deferred} deferred`);
}

// --- Migration (promote a name out of the NPC drawer) -------------------------

/**
 * Build the new key for a fact being re-keyed from the NPC drawer to a named subject.
 * Replaces a leading `npc_`/`npc` subject prefix with the new subject token; if the key
 * doesn't begin with the npc prefix, prepends `<subject>_` so the fact still derives the
 * right subject from its key. Lowercased subject token (matches existing key conventions).
 * @param {string} oldKey
 * @param {string} subjectToken - lowercased, sanitized new subject
 * @returns {string}
 */
function rekeyForSubject(oldKey, subjectToken) {
    const key = String(oldKey || '').trim();
    if (!key) return `${subjectToken}_fact`;
    const lower = key.toLowerCase();
    if (lower === NPC_SUBJECT) return subjectToken;            // bare "npc" -> the name
    if (lower.startsWith(NPC_SUBJECT + '_')) {
        return subjectToken + key.slice(NPC_SUBJECT.length);   // npc_xxx -> <subj>_xxx
    }
    // Key doesn't carry the npc prefix (subject came from explicit field). Prefix it so the
    // key-derived subject matches the new subject, unless it already starts with it.
    if (lower.startsWith(subjectToken + '_') || lower === subjectToken) return key;
    return `${subjectToken}_${key}`;
}

/** Sanitize a display name into a subject token (lowercase, alnum + underscore). */
function subjectTokenFor(name) {
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'npc';
}

/** Case-insensitive membership test against an involved/about value. */
function matchesName(value, lowerName) {
    return String(value || '').trim().toLowerCase() === lowerName;
}

/**
 * MIGRATION: promote a name to its own subject and move its facts OUT of the shared NPC
 * drawer. Scans every database for ACTIVE, NON-sequence facts whose subject is the NPC
 * drawer AND whose `about` matches the name (or, failing an `about`, whose `involved`
 * contains the name). Each match is re-keyed (`npc_*` -> `<name>_*`), has its `subject`
 * set to the name token and its `about` cleared, and all other fields preserved. The
 * re-keyed fact is written via upsertFact into the SAME category.
 *
 * COLLISION SAFETY: if the target key already exists in that DB AND belongs to a DISTINCT
 * fact (different value), the new key is suffixed (`_2`, `_3`, ...) so a genuinely different
 * fact is never overwritten. The original NPC-drawer fact is removed only after the re-keyed
 * copy is in place. Sequence/track facts and superseded history snapshots are left untouched
 * (they are append-only / historical). Persists each touched DB via saveDatabase.
 *
 * @param {string} name - the display name to promote
 * @returns {Promise<{moved:number, dbs:number}>}
 */
export async function promoteEntity(name) {
    const display = String(name || '').trim();
    if (!display) return { moved: 0, dbs: 0 };
    const lowerName = display.toLowerCase();
    const subjectToken = subjectTokenFor(display);

    const databases = await getAllDatabases();
    let moved = 0;
    const touched = new Set();
    const movedKeys = []; // {category, from, to} for the migration trace

    for (const [category, db] of Object.entries(databases)) {
        if (!db || !Array.isArray(db.facts)) continue;
        // Identify NPC-drawer facts about this name. Match on `about` first (the provisional
        // descriptor the drawer kept); fall back to an `involved` membership match.
        const toMigrate = db.facts.filter(f =>
            f && isActiveFact(f) && !isSequenceFact(f) &&
            deriveSubject(f) === NPC_SUBJECT &&
            (matchesName(f.about, lowerName) ||
                (!f.about && Array.isArray(f.involved) && f.involved.some(p => matchesName(p, lowerName)))));

        if (toMigrate.length === 0) continue;

        for (const oldFact of toMigrate) {
            // Compute a collision-safe new key.
            let newKey = rekeyForSubject(oldFact.key, subjectToken);
            const existing = db.facts.find(f => f.key === newKey && f !== oldFact);
            if (existing) {
                const sameValue = String(existing.value ?? '').trim().toLowerCase()
                    === String(oldFact.value ?? '').trim().toLowerCase();
                if (!sameValue) {
                    // Distinct fact already owns this key — suffix to avoid clobbering it.
                    let n = 2;
                    let candidate = `${newKey}_${n}`;
                    const taken = new Set(db.facts.map(f => f.key));
                    while (taken.has(candidate)) { n++; candidate = `${newKey}_${n}`; }
                    newKey = candidate;
                }
                // If sameValue, upsertFact will merge in place onto the existing fact — fine.
            }

            // Re-key + re-subject the fact, preserving every other field; drop `about`
            // (it has graduated to a real subject). Strip transient fields handled by upsert.
            const migrated = { ...oldFact, key: newKey, subject: subjectToken };
            delete migrated.about;
            delete migrated.__evictScore;

            // Remove the original drawer fact BEFORE upserting so the new copy can't be
            // mistaken for it (and a same-value collision merges cleanly).
            db.facts = db.facts.filter(f => f !== oldFact);
            upsertFact(db, migrated);
            movedKeys.push({ category, from: oldFact.key, to: newKey });
            moved++;
        }
        touched.add(category);
    }

    // Persist every touched database via the existing write path.
    for (const category of touched) {
        try {
            await saveDatabase(databases[category]);
        } catch (err) {
            addDebugLog('fail', `Character registry: saving "${category}" after promoting "${display}" failed: ${err.message || err}`);
        }
    }

    addDebugLog('pass', `Character registry: promoted "${display}" → subject "${subjectToken}" (${moved} fact(s) across ${touched.size} db(s))`, {
        subsystem: 'entity', event: 'entity.promoted', reason: 'USER_MARKED_RECURRING', actor: 'USER',
        data: { name: display, subject: subjectToken, factsMigrated: moved, dbsTouched: touched.size, movedKeys },
    });
    return { moved, dbs: touched.size };
}

// --- Semantic entity resolution / merge --------------------------------------
//
// GOAL (Graphiti node-dedup + mem0 entity-linking, CONSERVATIVE flavor): the same person can
// get recorded under variant names — "Bobby" / "Robert" / "Rob" — each spawning its OWN subject
// and a separate cluster of facts. This pass merges such variants into ONE canonical subject so
// recall doesn't fragment. It REUSES the promoteEntity re-key + collision-safety machinery
// (rekeyForSubject / subjectTokenFor) rather than re-implementing it.
//
// FALSE MERGES ARE THE PRIMARY RISK, so the gate is deliberately strict and every merge is
// logged loudly with both names + the moved-fact count. Two subjects are considered the SAME
// entity ONLY on a STRONG signal:
//   (1) exact alias/aka match — one subject's name appears in the other's stored `aliases`
//       (case-insensitive); OR
//   (2) trigramSimilarity(nameA, nameB) >= threshold (default 0.85) AND the two are NOT BOTH
//       already classified as distinct 'named' entities in the registry (the user explicitly
//       told us they're separate recurring characters — never override that).
// We NEVER merge {{user}} / {{char}} / the active character with anything. Default OFF.

/**
 * Reconstruct a Titlecased display name from a lowercased subject token. deriveSubject lowercases
 * subjects, so a key-derived token ("bobby", "mary_jane") must be re-capitalized before the
 * proper-noun heuristic accepts it. Underscores become spaces so a two-word name passes
 * looksLikeNamedEntity's whitespace split (and the trigram comparison sees the natural form).
 * @param {string} token - lowercased subject token
 * @returns {string}
 */
function titleCaseToken(token) {
    return String(token || '')
        .split('_').filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Collect, per database, the distinct PROPER-NAME subjects that are eligible to participate in a
 * merge: active, non-sequence facts whose derived subject is a real name (passes the same
 * looksLikeNamedEntity heuristic the detector uses), excluding the NPC drawer, {{user}}/{{char}}
 * and the active character. Returns a Map subjectToken -> {token, display, count, aliases:Set}.
 * `aliases` aggregates every stored alias seen on that subject's facts (lowercased), used for the
 * exact-alias merge signal. `display` keeps the best-looking proper-name casing seen.
 *
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases
 * @param {Set<string>} protectedNames - lowercased names that must never merge (user/char/active)
 * @returns {Map<string,{token:string, display:string, count:number, aliases:Set<string>, displayLc:string}>}
 */
function collectMergeableSubjects(databases, protectedNames) {
    const out = new Map();
    for (const db of Object.values(databases || {})) {
        if (!db || !Array.isArray(db.facts)) continue;
        for (const fact of db.facts) {
            if (!isActiveFact(fact) || isSequenceFact(fact)) continue;
            const subj = deriveSubject(fact); // lowercased token
            if (!subj || subj === NPC_SUBJECT) continue;
            // Prefer an explicit display name (the fact's `subject` field, which carries casing) for
            // logs + similarity; otherwise reconstruct a Titlecased display from the lowercased token
            // (deriveSubject lowercases, so a bare token like "bobby" must be re-capitalized before
            // the proper-noun heuristic — otherwise key-derived subjects would never qualify).
            const rawSubject = String(fact.subject || '').trim();
            const display = looksLikeNamedEntity(rawSubject) ? rawSubject : titleCaseToken(subj);
            // The subject must read like a NAMED proper noun — not a generic/descriptor token.
            if (!looksLikeNamedEntity(display)) continue;
            if (protectedNames.has(subj) || protectedNames.has(display.toLowerCase())) continue;
            const cur = out.get(subj) || { token: subj, display, displayLc: display.toLowerCase(), count: 0, aliases: new Set() };
            cur.count += 1;
            // Prefer an explicit proper-name `subject` casing over the reconstructed token casing.
            if (looksLikeNamedEntity(rawSubject) && cur.display !== rawSubject) { cur.display = rawSubject; cur.displayLc = rawSubject.toLowerCase(); }
            for (const a of (fact.aliases || [])) {
                const s = String(a || '').trim().toLowerCase();
                if (s) cur.aliases.add(s);
            }
            out.set(subj, cur);
        }
    }
    return out;
}

/**
 * Re-key + merge ALL of a loser subject's active, non-sequence facts onto a canonical subject
 * token across every database. REUSES rekeyForSubject (collision-safe) + upsertFact (which unions
 * aliases/involved/relationships/salience). Records the loser's display name as an alias on each
 * migrated fact so the variant name stays searchable. Sequence/track facts and superseded history
 * snapshots are left untouched (append-only / historical), matching promoteEntity. Persists each
 * touched DB. Returns the count of facts moved + DBs touched.
 *
 * @param {Object<string, import('./database.js').DatabaseSchema>} databases - the live map (mutated)
 * @param {string} loserToken - lowercased subject token to retire
 * @param {string} canonToken - lowercased canonical subject token to merge onto
 * @param {string} loserDisplay - the loser's display name (recorded as an alias)
 * @returns {{moved:number, touched:Set<string>}}
 */
function mergeSubjectInto(databases, loserToken, canonToken, loserDisplay) {
    let moved = 0;
    const touched = new Set();
    for (const [category, db] of Object.entries(databases)) {
        if (!db || !Array.isArray(db.facts)) continue;
        const toMigrate = db.facts.filter(f =>
            f && isActiveFact(f) && !isSequenceFact(f) && deriveSubject(f) === loserToken);
        if (toMigrate.length === 0) continue;

        for (const oldFact of toMigrate) {
            // Collision-safe new key (same logic promoteEntity uses).
            let newKey = rekeyForSubject(oldFact.key, canonToken);
            const existing = db.facts.find(f => f.key === newKey && f !== oldFact);
            if (existing) {
                const sameValue = String(existing.value ?? '').trim().toLowerCase()
                    === String(oldFact.value ?? '').trim().toLowerCase();
                if (!sameValue) {
                    let n = 2;
                    let candidate = `${newKey}_${n}`;
                    const taken = new Set(db.facts.map(f => f.key));
                    while (taken.has(candidate)) { n++; candidate = `${newKey}_${n}`; }
                    newKey = candidate;
                }
                // sameValue → upsertFact merges in place (unions aliases etc.) — fine.
            }
            // Re-key + re-subject; record the loser's variant name as an alias so the old name
            // still resolves. upsertFact unions aliases, so we don't need to dedup here.
            const mergedAliases = [...(oldFact.aliases || []), loserDisplay].filter(Boolean);
            const migrated = { ...oldFact, key: newKey, subject: canonToken, aliases: mergedAliases };
            delete migrated.__evictScore;
            // Remove the original before upserting so a same-value collision merges cleanly.
            db.facts = db.facts.filter(f => f !== oldFact);
            upsertFact(db, migrated);
            moved++;
        }
        touched.add(category);
    }
    return { moved, touched };
}

/**
 * CONSERVATIVE semantic entity-merge pass. Scans distinct proper-name subjects across all
 * databases and merges variant names of the SAME entity onto one canonical subject. Strong-signal
 * only (exact alias match OR high trigram similarity AND not both already distinctly 'named').
 * Never touches {{user}} / {{char}} / the active character. Deterministic — NO LLM call. Fully
 * self-guarded; on any error it degrades to a no-op and logs. Off the critical path (called from
 * the entity-check cadence / a manual UI trigger).
 *
 * @returns {Promise<{merges:number, factsMoved:number}>}
 */
export async function runEntityResolution() {
    const result = { merges: 0, factsMoved: 0 };
    try {
        const settings = getSettings();
        if (!settings || settings.entityResolution !== true) return result;
        const threshold = Number.isFinite(Number(settings.entityResolutionThreshold))
            ? Number(settings.entityResolutionThreshold) : 0.85;

        // Protected names that must NEVER be merged: {{char}}, {{user}}, the active character.
        const ctx = getContext();
        const protectedNames = new Set();
        try {
            const cn = ctx.characters?.[ctx.characterId]?.name || '';
            const un = ctx.name1 || '';
            for (const n of [cn, un]) {
                const t = String(n || '').trim().toLowerCase();
                if (t) { protectedNames.add(t); protectedNames.add(subjectTokenFor(t)); }
            }
        } catch { /* ignore */ }

        const databases = await getAllDatabases();
        const subjects = collectMergeableSubjects(databases, protectedNames);
        if (subjects.size < 2) {
            addDebugLog('info', 'Entity resolution: fewer than 2 mergeable subjects — nothing to do');
            return result;
        }

        const reg = getEntities();
        const list = [...subjects.values()];
        // Track which tokens have already been absorbed this pass so we don't chain-merge a
        // loser further (it no longer exists after a merge).
        const absorbed = new Set();
        const touchedDbs = new Set();

        // Pairwise scan. Order by fact count desc so the better-attested subject becomes canonical.
        list.sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));

        for (let i = 0; i < list.length; i++) {
            const canon = list[i];
            if (absorbed.has(canon.token)) continue;
            for (let j = i + 1; j < list.length; j++) {
                const other = list[j];
                if (absorbed.has(other.token)) continue;
                if (canon.token === other.token) continue;

                // STRONG SIGNAL (1): exact alias/aka match in either direction.
                const aliasMatch =
                    canon.aliases.has(other.displayLc) || canon.aliases.has(other.token) ||
                    other.aliases.has(canon.displayLc) || other.aliases.has(canon.token);

                // STRONG SIGNAL (2): high trigram similarity on the display names AND not both
                // already explicitly classified as DISTINCT 'named' entities (user said so).
                const sim = trigramSimilarity(canon.display, other.display);
                const bothNamed = reg[canon.displayLc]?.status === 'named'
                    && reg[other.displayLc]?.status === 'named';
                const simMatch = sim >= threshold && !bothNamed;

                if (!aliasMatch && !simMatch) continue;

                // Merge the lower-attested `other` INTO `canon`.
                const reason = aliasMatch ? 'ALIAS_EXACT' : 'TRIGRAM_SIMILARITY';
                const { moved, touched } = mergeSubjectInto(
                    databases, other.token, canon.token, other.display);
                for (const c of touched) touchedDbs.add(c);
                absorbed.add(other.token);
                // Fold the absorbed subject's aliases into the canonical record so a later pair in
                // this same pass can still alias-match against them.
                canon.aliases.add(other.displayLc);
                canon.aliases.add(other.token);
                for (const a of other.aliases) canon.aliases.add(a);
                result.merges++;
                result.factsMoved += moved;

                // LOG LOUDLY — both names, the signal, the moved count (false merges are the risk).
                addDebugLog('pass',
                    `Entity resolution: MERGED "${other.display}" → "${canon.display}" (${reason}` +
                    `${reason === 'TRIGRAM_SIMILARITY' ? `, sim=${sim.toFixed(3)}` : ''}; ${moved} fact(s) across ${touched.size} db(s))`, {
                    subsystem: 'entity', event: 'entity.merged', reason, actor: 'SYSTEM',
                    data: {
                        loser: other.display, loserToken: other.token,
                        canonical: canon.display, canonicalToken: canon.token,
                        signal: reason, similarity: sim, threshold,
                        factsMoved: moved, dbsTouched: touched.size,
                    },
                });
                // Retire the absorbed variant in the registry so the detector won't re-offer it as a
                // "new" character on the next check (its facts now live under the canonical subject;
                // the variant name survives as a searchable alias on those facts). Best-effort.
                try { setEntityStatus(other.display, 'npc'); } catch { /* best-effort */ }
            }
        }

        // Persist every touched DB via the existing write path.
        for (const category of touchedDbs) {
            try {
                await saveDatabase(databases[category]);
            } catch (err) {
                addDebugLog('fail', `Entity resolution: saving "${category}" after merges failed (non-fatal): ${err.message || err}`);
            }
        }

        if (result.merges > 0) {
            addDebugLog('pass', `Entity resolution: ${result.merges} merge(s), ${result.factsMoved} fact(s) re-keyed across ${touchedDbs.size} db(s)`, {
                subsystem: 'entity', event: 'entity.resolution', actor: 'SYSTEM',
                data: { merges: result.merges, factsMoved: result.factsMoved, dbsTouched: touchedDbs.size, threshold },
            });
        } else {
            addDebugLog('info', `Entity resolution: scanned ${subjects.size} subject(s), no strong-signal merges`);
        }
    } catch (err) {
        // Degrade to a no-op on any error — this pass must never break the turn.
        addDebugLog('fail', `Entity resolution failed (non-fatal): ${err.message || err}`);
    }
    return result;
}
