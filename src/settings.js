// BF Memory Pipeline - Settings Module
// Handles UI wiring, settings persistence, and the DB-profile (Layer C) machinery.
// F-UX-8 split: the debug-log engine (debug-log.js), per-chat turn state (turn-state.js),
// Database-tab UI (db-panel.js), and shared UI helpers (ui-util.js) were extracted
// MECHANICALLY from this module. settings.js remains the public facade: every symbol it
// exported before the split is still exported here (see the re-export block below).

import { explainFactRetrieval } from './fact-retrieval.js';
// F-UX-8 split modules (see the header note above).
import {
    ensurePopup, Popup, POPUP_TYPE, escapeHtml, getContext, getCurrentChatId, isBranchChat,
    safeStringify,
} from './ui-util.js';
import {
    addDebugLog, reloadDebugLogFromChat, flushDebugLogNow, flushOutgoingChatLog,
    renderDebugLog, clearDebugLog, getDebugLogEntries,
    exportLogs, exportLogsJSON, copyDiagnostics,
} from './debug-log.js';
import {
    setLastGenerated, setLastInserted, reloadFactsFromChat,
    reloadTokensFromChat, resetSessionTokens,
    reloadSceneFromChat,
    reloadReflectionFromChat, renderReflection,
    reloadPyramidFromChat,
    reloadSheetFromChat,
} from './turn-state.js';
import {
    refreshDatabaseView, showSpiderwebPopup,
} from './db-panel.js';

// --- F-UX-8 re-exports ----------------------------------------------------------------------
// Everything settings.js exported BEFORE the split is re-exported here so every existing
// importer (pipeline.js, commands.js, agent-*.js, database.js, message-icon.js, …) keeps
// importing from './settings.js' unchanged. Do not remove entries without checking importers.
export {
    beginRun, endRun, getCurrentRunId, setPendingRun, getPendingRun, consumePendingRun,
    reloadDebugLogFromChat, addDebugLog, exportLogsJSON,
} from './debug-log.js';
export {
    setLastGenerated, setLastInserted, appendLastInserted, reloadFactsFromChat,
    setRunTokens, addAgent3Tokens, addReflectionTokens, setMainOutputTokens, reloadTokensFromChat,
    getScene, setScene, getSceneReentries, reloadSceneFromChat,
    getReflection, setReflection, reloadReflectionFromChat,
    getSummaryPyramid, setSummaryPyramid, reloadPyramidFromChat,
    SHEET_SEED_TEXT, getMemorySheet, setMemorySheet, reloadSheetFromChat, renderMemorySheet,
} from './turn-state.js';

const EXTENSION_NAME = (() => {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/');
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx > 0) return parts[srcIdx - 1];
    } catch { /* fallback */ }
    return 'bf-memory-pipeline';
})();

let extensionSettings = null;

// redesign-v2 (S1): profiler.js was deleted - the connection-profile readers are inlined
// here (module-local; the Scribe profile dropdown is their only remaining consumer).
function getConnectionProfiles() {
    try {
        const profiles = getContext().extensionSettings?.connectionManager?.profiles;
        return Array.isArray(profiles) ? profiles : [];
    } catch {
        return [];
    }
}

function getCurrentProfileId() {
    try {
        return getContext().extensionSettings?.connectionManager?.selectedProfile || null;
    } catch {
        return null;
    }
}

// redesign-v2 (S5): the FINAL settings surface. Every other historical key was either
// REMOVED with its feature (S1) or its behavior is now HARDCODED ON (G4 — MMR, confidence
// ranking, temporal grounding, cross-key supersede, recency labels, truth hierarchy,
// auto-linking, reflection/contradiction cadence, character registry, open threads); those
// modules carry local consts instead of settings reads. migrateLegacySettings() deletes any
// stored key not listed here.
const DEFAULT_SETTINGS = {
    enabled: false,
    // The background Memory Agent's connection profile (blank = current connection).
    agent3Profile: '',
    // Extra instructions APPENDED to the Memory Agent's user prompt ('' = none).
    memoryPrompt: '',
    // Writer history limit: 0 = off; N = trim the main model's visible chat to the last N
    // user/AI messages (the memory sheet replaces older history).
    agent2ContextMessages: 10,
    // SETTLED BUFFER hold-back (§7): the newest N messages are never fact-extracted (they may
    // still be swiped/edited) — they reach the Memory Agent only as TENTATIVE planning context.
    bufferHoldBack: 4,
    // WHO-KNOWS-WHAT (POV) ENFORCEMENT: when ON (default), facts carrying a knownBy list are
    // hidden from characters not on that list at every retrieval surface.
    enforceKnownBy: true,
    // Bonus graph-connected facts appended to the memory sheet ("Connected memories").
    graphExtrasCount: 3,
    // Catch-up import: messages per Memory Agent call (src/catchup-import.js). Clamp 2..30.
    catchupBatchSize: 8,
    showToast: true,
    debugMode: false,
    // Verbose logging tier (opt-in firehose). RAM-only even when on.
    debugVerbose: false,
    // --- data, not knobs ---
    dbProfiles: {},
    activeDbProfile: '',
    // Chats the user EXPLICITLY unlinked from every profile (see markChatUnlinked).
    unlinkedChats: [],
    // USER TAXONOMY OVERLAY (persisted, GLOBAL across chats). DATA-ONLY + ADDITIVE.
    taxonomyOverlay: { categories: [], aspects: {}, subAreas: {} },
    // schemaVersion intentionally NOT in defaults: the merge-missing-defaults loop
    // would otherwise pre-fill it for existing users and short-circuit the migration.
    // migrateLegacySettings() sets it after running.
};

export function getSettings() {
    return extensionSettings;
}

/**
 * A8: programmatically enable/disable the pipeline (used by the `/bfmem` slash command), mirroring
 * the Enable checkbox handler exactly: log the transition, persist, sync the checkbox + status, and
 * on disable cancel any in-flight run. Safe before the UI exists (the jQuery calls just no-op).
 * @param {boolean} next
 * @returns {boolean} the applied state
 */
export function setPipelineEnabled(next) {
    next = !!next;
    if (!extensionSettings) return next;
    if (next !== extensionSettings.enabled) {
        addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} via slash command`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled', via: 'slash' }, before: !!extensionSettings.enabled, after: next });
    }
    extensionSettings.enabled = next;
    saveSettings();
    try { $('#bf_mem_enabled').prop('checked', next); } catch { /* UI not ready */ }
    try { updateStatus('idle'); } catch { /* UI not ready */ }
    if (!next) {
        import('./pipeline.js').then(({ cancelActiveRun }) => cancelActiveRun?.('disabled')).catch(() => {});
    }
    return next;
}

// Exported for the F-UX-8 split modules (db-panel.js / presets.js persist settings through
// the same debounced path a local write uses).
export function saveSettings() {
    const context = getContext();
    context.extensionSettings[EXTENSION_NAME] = extensionSettings;
    context.saveSettingsDebounced();
}

function clamp(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

// Exported for db-panel.js and the (S5) migration path — validates through the same path a manual edit uses.
export function validateSettings(s) {
    s.agent2ContextMessages = Math.floor(clamp(s.agent2ContextMessages, 0, 50, 10));
    s.bufferHoldBack = Math.floor(clamp(s.bufferHoldBack, 0, 10, 4));
    // Overlap guard: the writer window must exceed the holdback, else a settled message can leave
    // the writer's view before it's eligible for extraction (memory gap). 0 = full history = always safe.
    if (s.agent2ContextMessages !== 0 && s.bufferHoldBack >= s.agent2ContextMessages) {
        const clamped = Math.max(0, s.agent2ContextMessages - 1);
        addDebugLog('fail', 'bufferHoldBack (' + s.bufferHoldBack + ') >= agent2ContextMessages (' + s.agent2ContextMessages + '); clamped to ' + clamped + ' to prevent a memory gap');
        s.bufferHoldBack = clamped;
    }
    s.graphExtrasCount = Math.floor(clamp(s.graphExtrasCount, 0, 8, 3));
    s.catchupBatchSize = Math.floor(clamp(s.catchupBatchSize, 2, 30, 8));
    if (typeof s.enabled !== 'boolean') {
        // FIX #10: log when a coercion silently flips a previously-true enable off.
        if (s.enabled === true || (s.enabled && s.enabled !== false)) {
            addDebugLog('fail', 'enabled coerced to false (was non-boolean: ' + JSON.stringify(s.enabled) + ')');
        }
        s.enabled = false;
    }
    if (typeof s.showToast !== 'boolean')        s.showToast = true;
    if (typeof s.debugMode !== 'boolean')        s.debugMode = false;
    if (typeof s.debugVerbose !== 'boolean')     s.debugVerbose = false;
    if (typeof s.agent3Profile !== 'string')     s.agent3Profile = '';
    if (typeof s.enforceKnownBy !== 'boolean') s.enforceKnownBy = true;
    if (typeof s.memoryPrompt !== 'string')      s.memoryPrompt = '';
    if (typeof s.activeDbProfile !== 'string')   s.activeDbProfile = '';
    if (!s.dbProfiles || typeof s.dbProfiles !== 'object' || Array.isArray(s.dbProfiles)) {
        s.dbProfiles = {};
    }
    // Explicitly-unlinked chats (detach set): coerce to a string array.
    if (!Array.isArray(s.unlinkedChats)) {
        s.unlinkedChats = [];
    } else {
        s.unlinkedChats = s.unlinkedChats.filter(id => typeof id === 'string' && id);
    }
    // User taxonomy overlay: coerce to the well-formed shape.
    if (!s.taxonomyOverlay || typeof s.taxonomyOverlay !== 'object' || Array.isArray(s.taxonomyOverlay)) {
        s.taxonomyOverlay = { categories: [], aspects: {}, subAreas: {} };
    } else {
        const ov = s.taxonomyOverlay;
        if (!Array.isArray(ov.categories)) ov.categories = [];
        if (!ov.aspects || typeof ov.aspects !== 'object' || Array.isArray(ov.aspects)) ov.aspects = {};
        if (!ov.subAreas || typeof ov.subAreas !== 'object' || Array.isArray(ov.subAreas)) ov.subAreas = {};
    }
    return s;
}

function migrateLegacySettings(s) {
    // Skip if already migrated to the redesign-v2 schema.
    if ((s.schemaVersion ?? 0) >= 3) return;

    // Pre-v2 (bf_memory) legacy: copy renamed fields ONLY if current is empty (don't
    // clobber user's newer values).
    const context = getContext();
    const legacy = context.extensionSettings?.bf_memory;
    if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
        if (typeof legacy.customExtractorPrompt === 'string' && !s.memoryPrompt) {
            s.memoryPrompt = legacy.customExtractorPrompt;
        }
        if (typeof legacy.extractorProfileId === 'string' && legacy.extractorProfileId && !s.agent3Profile && !s.memoryProfile) {
            s.agent3Profile = legacy.extractorProfileId;
        }
        console.log('[BFMemory] Migrated legacy bf_memory settings (old key preserved for rollback)');
    }

    // v0.7 legacy: a single memoryProfile predates the per-agent profiles. Migrate it
    // forward onto the (sole surviving) background-agent profile when that is unset.
    if (typeof s.memoryProfile === 'string' && s.memoryProfile && !s.agent3Profile) {
        s.agent3Profile = s.memoryProfile;
    }

    // redesign-v2 SWEEP: every key that survives carries the same name as before, so the
    // carried-over knobs (agent2ContextMessages, graphExtrasCount,
    // enforceKnownBy, catchupBatchSize, memoryPrompt, agent3Profile, dbProfiles /
    // activeDbProfile / unlinkedChats / taxonomyOverlay, ...) are simply KEPT — and every
    // stored key NOT in the final DEFAULT_SETTINGS list is DELETED (removed features and
    // G4 hardcoded-ON knobs alike). schemaVersion is the only extra key allowed through.
    let dropped = 0;
    for (const key of Object.keys(s)) {
        if (key === 'schemaVersion') continue;
        if (!Object.hasOwn(DEFAULT_SETTINGS, key)) {
            delete s[key];
            dropped++;
        }
    }
    if (dropped > 0) {
        console.log(`[BFMemory] Settings migration dropped ${dropped} obsolete key(s) (schema v3)`);
    }

    s.schemaVersion = 3;
}

// --- Status ---

export function updateStatus(status, message = '') {
    const dot = document.getElementById('bf_mem_status_dot');
    const text = document.getElementById('bf_mem_status_text');

    if (dot) {
        dot.className = 'bf-mem-status-dot';
        if (status === 'running') dot.classList.add('running');
        else if (status === 'error') dot.classList.add('error');
        else if (extensionSettings?.enabled) dot.classList.add('active');
    }

    if (text && message) {
        text.textContent = message;
    } else if (text) {
        text.textContent = extensionSettings?.enabled ? 'Active' : 'Disabled';
    }
}

// --- Profile Dropdown ---

function reloadProfiles() {
    const agent3Select = document.getElementById('bf_mem_agent3_profile');
    if (!agent3Select) return;

    const profiles = getConnectionProfiles();
    const activeProfile = getCurrentProfileId();

    const currentValue = agent3Select.value;
    agent3Select.innerHTML = '<option value="">-- Use default profile --</option>';
    profiles.forEach(profile => {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name + (profile.id === activeProfile ? ' (current)' : '');
        agent3Select.appendChild(option);
    });
    if (currentValue && profiles.find(p => p.id === currentValue)) {
        agent3Select.value = currentValue;
    } else if (extensionSettings?.agent3Profile) {
        agent3Select.value = extensionSettings.agent3Profile;
    }
}

// --- Tabs ---

function setupTabs() {
    const tablist = document.querySelector('.bf-mem-tabs[role="tablist"]');
    if (!tablist) return;

    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));

    function activateTab(tab) {
        tabs.forEach(t => {
            t.setAttribute('aria-selected', 'false');
            t.setAttribute('tabindex', '-1');
            t.classList.remove('active');
            const panel = document.getElementById(t.getAttribute('aria-controls'));
            if (panel) panel.style.display = 'none';
        });

        tab.setAttribute('aria-selected', 'true');
        tab.setAttribute('tabindex', '0');
        tab.classList.add('active');

        const panel = document.getElementById(tab.getAttribute('aria-controls'));
        if (panel) panel.style.display = '';

        // Refresh DB view when switching to database tab
        if (tab.getAttribute('aria-controls') === 'bf_mem_tab_database') {
            refreshDatabaseView();
        }
    }

    tabs.forEach(tab => {
        tab.addEventListener('click', () => activateTab(tab));
        tab.addEventListener('keydown', (e) => {
            const idx = tabs.indexOf(tab);
            let target = null;
            if (e.key === 'ArrowRight') target = tabs[(idx + 1) % tabs.length];
            else if (e.key === 'ArrowLeft') target = tabs[(idx - 1 + tabs.length) % tabs.length];
            if (target) { e.preventDefault(); activateTab(target); }
        });
    });
}

/**
 * One-click "Unlink current chat" (main Database tab). Removes the current chat from EVERY profile
 * it is linked to and detaches it (so autoSaveDbProfile won't auto-relink on the next CHAT_CHANGED)
 * — the same effective unlink as the Manage popup, surfaced as a single button. Facts in the live
 * working store are left untouched (unlink != wipe); they just stop being driven by a profile.
 */
function unlinkCurrentChat() {
    const chatId = getCurrentChatId();
    if (!chatId) { toastr.warning('No chat currently open', 'BF Memory'); return; }
    const profiles = extensionSettings?.dbProfiles || {};
    const linkedTo = Object.entries(profiles).filter(([, p]) => (p?.linkedChats || []).includes(chatId)).map(([n]) => n);
    if (linkedTo.length === 0 && isChatUnlinked(chatId)) {
        toastr.info('Current chat is already unlinked', 'BF Memory');
        return;
    }
    if (!confirm('Unlink the current chat from its DB profile? It will stop auto-loading/auto-relinking. Your facts stay in the live store.')) return;
    for (const name of linkedTo) {
        const p = profiles[name];
        if (p?.linkedChats) p.linkedChats = p.linkedChats.filter(id => id !== chatId);
    }
    // Detach + drop active-profile pointer so the live session honors the unlink immediately.
    markChatUnlinked(chatId);
    if (extensionSettings.activeDbProfile && linkedTo.includes(extensionSettings.activeDbProfile)) {
        extensionSettings.activeDbProfile = '';
    }
    lastAutoLoadedChat = '';
    saveSettings();
    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    addDebugLog('info', `Unlinked current chat ${chatId} from ${linkedTo.length} profile(s) (detached)`, {
        subsystem: 'settings', event: 'profile.unlinked', actor: 'USER', reason: 'USER_UNLINK_CURRENT',
        data: { chatId, profiles: linkedTo },
    });
    toastr.success('Current chat unlinked', 'BF Memory');
}

// --- DB Profiles ---

function refreshDbProfileDropdown() {
    const select = document.getElementById('bf_mem_db_profile_select');
    if (!select) return;

    const profiles = extensionSettings?.dbProfiles || {};
    const active = extensionSettings?.activeDbProfile || '';

    select.innerHTML = '<option value="">-- No profile loaded --</option>';
    for (const [name, profile] of Object.entries(profiles)) {
        const option = document.createElement('option');
        option.value = name;
        const factCount = Object.values(profile.databases || {}).reduce((sum, db) => sum + (db.facts?.length || 0), 0);
        const dbCount = Object.keys(profile.databases || {}).length;
        const linkCount = (profile.linkedChats || []).length;
        option.textContent = `${name} (${dbCount} dbs, ${factCount} facts${linkCount ? `, ${linkCount} chats` : ''})`;
        select.appendChild(option);
    }

    if (active && profiles[active]) {
        select.value = active;
    }
}

async function loadDbProfile(profileName) {
    if (!profileName) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) {
        toastr.error(`Profile "${profileName}" not found`, 'BF Memory');
        return;
    }

    const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

    // Clear existing databases
    const existing = await getAllDatabases();
    for (const category of Object.keys(existing)) {
        await deleteDatabase(category);
    }

    // Load profile databases. Skip EMPTY (factless) categories — the Layer-1 skeleton is
    // shown in-memory (withSkeleton); empty categories aren't persisted as attachment files
    // (write-on-first-fact), avoiding empty-upload spam.
    for (const [category, db] of Object.entries(profile.databases || {})) {
        if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
        await saveDatabase({ ...db, category });
    }

    extensionSettings.activeDbProfile = profileName;
    saveSettings();
    refreshDbProfileDropdown();
    refreshDatabaseView();
    toastr.success(`Loaded profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile loaded: "${profileName}"`, {
        subsystem: 'import', event: 'profile.switched', actor: 'USER', data: { profileName },
    });
}

async function saveDbProfile(profileName) {
    if (!profileName) return;

    const { getAllDatabases } = await import('./database.js');
    const databases = await getAllDatabases();

    if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
    const existing = (extensionSettings.dbProfiles[profileName] && typeof extensionSettings.dbProfiles[profileName] === 'object')
        ? extensionSettings.dbProfiles[profileName]
        : {};
    extensionSettings.dbProfiles[profileName] = {
        ...existing,
        databases: JSON.parse(JSON.stringify(databases)),
        savedAt: Date.now(),
    };
    extensionSettings.activeDbProfile = profileName;
    // LINK the current chat to this manually-created profile so it actually attaches (empty
    // linkedChats meant it would NOT auto-load on the next CHAT_CHANGED). linkChatToProfile is
    // idempotent + calls saveSettings; clears any prior unlink so auto-link re-enables for this chat.
    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        linkChatToProfile(profileName, currentChatId);
        // We just established this profile for the current chat — keep autoSaveDbProfile from
        // re-loading/clobbering it on a later CHAT_CHANGED for the SAME chat.
        lastAutoLoadedChat = currentChatId;
    }
    saveSettings();
    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    toastr.success(`Saved profile "${profileName}"`, 'BF Memory');
    addDebugLog('info', `DB profile saved: "${profileName}" (${Object.keys(databases).length} dbs)${currentChatId ? ` + linked to chat ${currentChatId}` : ''}`, {
        subsystem: 'db', event: 'profile.saved', actor: 'USER', reason: 'SAVE_AS_NEW',
        data: { profileName, dbCount: Object.keys(databases).length, linkedChat: currentChatId || null },
    });
}

async function deleteDbProfile(profileName) {
    if (!profileName) return;
    if (!confirm(`Delete saved profile "${profileName}"? This cannot be undone.`)) return;

    const wasActive = extensionSettings.activeDbProfile === profileName;
    const profile = extensionSettings.dbProfiles?.[profileName];
    const linkedChats = [...(profile?.linkedChats || [])];
    const currentChatId = getCurrentChatId();

    // PROFILE-DELETE CLEANUP: if this profile was driving the CURRENT chat, optionally wipe the
    // working store too — otherwise its facts are orphaned in IDB+attachments and the next
    // extraction silently writes them into a freshly auto-created profile (data resurrection by a
    // different name). Offer the choice; deleting the profile alone keeps the live facts.
    let alsoWipe = false;
    if (wasActive && currentChatId && linkedChats.includes(currentChatId)) {
        alsoWipe = confirm(`"${profileName}" is the active profile for THIS chat. Also clear its facts from this chat's working store?\n\nOK = delete profile AND wipe this chat's facts.\nCancel = delete profile only (facts stay in the live store).`);
    }

    delete extensionSettings.dbProfiles[profileName];
    if (wasActive) {
        extensionSettings.activeDbProfile = '';
        lastAutoLoadedChat = '';
    }
    // Drop any detach markers for chats that were linked ONLY to this (now-gone) profile so they
    // are not stranded as permanently un-auto-linkable.
    if (Array.isArray(extensionSettings.unlinkedChats)) {
        extensionSettings.unlinkedChats = extensionSettings.unlinkedChats.filter(id => !!findProfileForChat(id));
    }
    saveSettings();

    if (alsoWipe) {
        try {
            const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
            cancelPendingSnapshot();
            const dbs = await getAllDatabases();
            for (const category of Object.keys(dbs)) await deleteDatabase(category);
            await flushSnapshotNow();
            // The chat now has no profile and an empty store — treat as explicitly detached so it
            // doesn't immediately auto-create a fresh profile and re-seed.
            markChatUnlinked(currentChatId);
            saveSettings();
            refreshDatabaseView();
        } catch (err) {
            addDebugLog('fail', `Profile-delete working-store wipe failed: ${err.message || err}`);
        }
    }

    refreshDbProfileDropdown();
    refreshLinkedChatsField();
    addDebugLog('info', `DB profile deleted: "${profileName}"${alsoWipe ? ' (+ working store wiped)' : ''}`, {
        subsystem: 'settings', event: 'profile.deleted', actor: 'USER', reason: 'USER_DELETE',
        data: { profileName, wasActive, linkedChatCount: linkedChats.length, wipedWorkingStore: alsoWipe },
    });
    toastr.success(`Deleted profile "${profileName}"`, 'BF Memory');
}

// --- Auto-save DB as chat-named profile ---

// Was named lastAutoSavedChat — kept the variable but the save logic is gone;
// it now only tracks the last chat we LOADED to skip redundant loads.
let lastAutoLoadedChat = '';

// Observability: the chatId we were on BEFORE the current CHAT_CHANGED, so the chat.switch /
// chat.disconnect logs can report a "from -> to" transition. Updated at the END of the
// CHAT_CHANGED handler. Not used for any storage/profile decision — logging only.
let _lastChatId = '';

function getCurrentChatLabel() {
    const context = getContext();
    const charName = context.characters?.[context.characterId]?.name || '';
    const chatId = getCurrentChatId();
    // Use character name as the default profile name
    return charName || chatId || '';
}

/** Find which profile is linked to a given chat ID */
function findProfileForChat(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    for (const [name, profile] of Object.entries(extensionSettings.dbProfiles)) {
        if ((profile.linkedChats || []).includes(chatId)) return name;
    }
    return null;
}

/**
 * Strip ST's " - Branch #N" suffix from a branched chat's id to recover the PARENT chat id.
 * ST names a branch "<parent chat id> - Branch #N" (see isBranchChat). Returns the parent id, or
 * the original id when no branch suffix is present. Used only by the branch-inherit resolution.
 * @param {string} chatId
 * @returns {string}
 */
function parentChatIdOfBranch(chatId) {
    if (typeof chatId !== 'string') return chatId;
    // Remove a trailing " - Branch #N" (and any nested " - Branch #M - Branch #N" chain).
    let id = chatId;
    let prev;
    do {
        prev = id;
        id = id.replace(/\s*-\s*Branch\s*#\s*\d+\s*$/i, '');
    } while (id !== prev);
    return id;
}

/**
 * BRANCH INHERIT (data-safety): resolve the profile a BRANCH chat should inherit from its parent.
 * A branch gets a brand-new chatId that is in no profile's linkedChats, so findProfileForChat()
 * returns null and the auto-create path would mint an EMPTY skeleton profile — diverging the branch
 * from the parent's accumulated memory. Default behavior is INHERIT: resolve the branch to the SAME
 * profile the parent uses (the avatar-keyed working store already holds the parent's facts; we just
 * must not mis-resolve to an empty profile). We try, in order: the parent chatId's linked profile,
 * then the character-named profile (the conventional auto-create name). Returns the profile name or
 * null when no parent profile exists yet.
 * @param {string} chatId - the branch chat id
 * @returns {string|null}
 */
function resolveBranchParentProfile(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    const parentId = parentChatIdOfBranch(chatId);
    if (parentId && parentId !== chatId) {
        const byParent = findProfileForChat(parentId);
        if (byParent) return byParent;
    }
    // Fall back to the conventional character-named profile (getCurrentChatLabel defaults to the
    // character name, which is what the parent's first chat auto-created).
    const charName = getContext()?.characters?.[getContext()?.characterId]?.name || '';
    if (charName && extensionSettings.dbProfiles[charName]) return charName;
    return null;
}

/** Link a chat to a profile */
function linkChatToProfile(profileName, chatId) {
    if (!profileName || !chatId) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) return;

    if (!profile.linkedChats) profile.linkedChats = [];

    // Remove this chat from any other profile first
    for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
        if (name !== profileName && p.linkedChats) {
            p.linkedChats = p.linkedChats.filter(id => id !== chatId);
        }
    }

    if (!profile.linkedChats.includes(chatId)) {
        profile.linkedChats.push(chatId);
    }
    // An explicit link clears any prior user-detach so auto-link is re-enabled for this chat.
    clearChatUnlinked(chatId);
    saveSettings();
}

/**
 * Save current databases to the active profile (call after DB changes).
 *
 * @param {string|null} profileKey - target profile (defaults to the active profile)
 * @param {{ allowEmpty?: boolean }} [options]
 * @param {boolean} [options.allowEmpty=false] - when false (the default for the every-turn
 *   extraction call sites) a totally-empty working store is NOT written through — this guards
 *   against a transient/failed getAllDatabases() load clobbering a populated profile with `{}`.
 *   USER-initiated destructive ops (Clear All / per-category delete) pass `allowEmpty:true` so an
 *   INTENTIONAL clear-to-empty actually persists to the profile (Layer C) and can no longer be
 *   resurrected by autoSaveDbProfile on the next CHAT_CHANGED.
 */
/**
 * EAGER PROFILE ENSURE (fact-write-time). Guarantee an active DB profile exists, is linked to the
 * CURRENT chat, and is set active — so facts always land in a profile, not only after CHAT_CHANGED.
 *
 * Problem this fixes: activeDbProfile was set ONLY inside autoSaveDbProfile (CHAT_CHANGED/init). When a
 * run raced ahead of that, or a branch chat's resolveBranchParentProfile returned null (parent never
 * linked → facts only in the avatar store), activeDbProfile was empty at write time, so the
 * saveCurrentToActiveProfile call no-op'd and the Database tab showed no profile.
 *
 * Resolution order (reuses the SAME helpers autoSaveDbProfile uses — no duplicated logic):
 *   1. already-active profile that still exists → keep it
 *   2. profile linked to this chat (findProfileForChat)
 *   3. branch-inherit the parent's profile (resolveBranchParentProfile) and link this branch to it
 *   4. auto-create a chat/character-named profile (seeded Layer-1 skeleton) and link it
 * Then LINK the current chat + SET it active. Respects an explicit user unlink (does NOT re-link).
 *
 * NON-DESTRUCTIVE: this only ensures the profile RECORD + active pointer; it never loads/clears the
 * working store (that is autoSaveDbProfile's job on CHAT_CHANGED), so it can't resurrect deleted data
 * or clobber the avatar store. It never double-creates: an existing named profile is linked, not replaced.
 *
 * @returns {Promise<string|null>} the ensured active profile name, or null when none could be ensured
 *   (no chatId, or the chat was explicitly unlinked by the user).
 */
async function ensureActiveProfileForCurrentChat() {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) return null;

        // (1) Active profile already set AND still exists → reuse (most common case after CHAT_CHANGED).
        const active = extensionSettings?.activeDbProfile;
        if (active && extensionSettings?.dbProfiles?.[active]) {
            // Make sure the active profile is actually linked to THIS chat (a race could have set it
            // active before linking, e.g. via saveDbProfile pre-fix). Link defensively (idempotent).
            if (!(extensionSettings.dbProfiles[active].linkedChats || []).includes(chatId) && !isChatUnlinked(chatId)) {
                linkChatToProfile(active, chatId);
            }
            return active;
        }

        // RESPECT EXPLICIT UNLINK: if the user detached this chat from every profile, do NOT auto-link
        // or auto-create one (mirrors autoSaveDbProfile's suppression). Facts stay in the working store.
        if (isChatUnlinked(chatId)) return null;

        if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
        const isBranch = isBranchChat(chatId);
        let resolved = null;
        let how = 'none';

        // (2) Profile already linked to this chat.
        resolved = findProfileForChat(chatId);
        if (resolved) how = 'linked';

        // (3) Branch-inherit the parent's profile.
        if (!resolved && isBranch) {
            const parentProfile = resolveBranchParentProfile(chatId);
            if (parentProfile) { resolved = parentProfile; how = 'inherited-branch'; }
        }

        // (4) Auto-create (or link an existing same-named) chat/character-named profile.
        if (!resolved) {
            const chatLabel = getCurrentChatLabel();
            if (chatLabel) {
                if (!extensionSettings.dbProfiles[chatLabel]) {
                    const { buildSkeletonDatabases } = await import('./database.js');
                    extensionSettings.dbProfiles[chatLabel] = {
                        databases: buildSkeletonDatabases(),
                        savedAt: Date.now(),
                        linkedChats: [],
                    };
                    how = 'auto-created';
                } else {
                    how = 'linked';
                }
                resolved = chatLabel;
            }
        }

        if (!resolved) return null;

        // LINK + ACTIVATE so the imminent fact write lands in this profile and the Database tab shows it.
        linkChatToProfile(resolved, chatId);
        extensionSettings.activeDbProfile = resolved;
        // Keep autoSaveDbProfile from re-loading (and potentially clobbering) on a later CHAT_CHANGED
        // for the SAME chat — we just established the profile for it.
        lastAutoLoadedChat = chatId;
        saveSettings();
        try { refreshDbProfileDropdown(); refreshLinkedChatsField(); } catch { /* UI optional */ }
        addDebugLog('info', `Ensured active DB profile "${resolved}" for chat ${chatId} at fact-write (${how})`, {
            subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'EAGER_ENSURE',
            data: { chatId, resolvedProfile: resolved, linkState: how, isBranch, eager: true },
        });
        return resolved;
    } catch (err) {
        addDebugLog('fail', `Eager profile ensure failed (non-fatal): ${err.message || err}`);
        return null;
    }
}

export async function saveCurrentToActiveProfile(profileKey = null, { allowEmpty = false } = {}) {
    let profileName = profileKey || extensionSettings?.activeDbProfile;
    // EAGER ENSURE: when this is an every-turn extraction save (no explicit profileKey) and there is
    // no active profile, ensure+link+activate one for the current chat NOW so the very first
    // extraction lands in a profile instead of no-op'ing. Skipped when the caller named an explicit
    // profileKey (those paths target a specific profile and shouldn't trigger auto-create).
    if (!profileName && !profileKey) {
        profileName = await ensureActiveProfileForCurrentChat();
    }
    if (!profileName) return;
    // Integrity guard: refuse to write to a profile that no longer exists
    // (prevents resurrecting a deleted profile or clobbering wrong slot after rename)
    if (!extensionSettings.dbProfiles?.[profileName]) {
        addDebugLog('fail', `Skipped save: profile "${profileName}" no longer exists (was current profile deleted?)`);
        if (typeof toastr !== 'undefined') {
            toastr.warning(`BF Memory: skipped saving facts — profile "${profileName}" was deleted.`);
        }
        return;
    }
    try {
        const { getAllDatabases } = await import('./database.js');
        const databasesRaw = await getAllDatabases();
        // USER-LEVEL SHARED MEMORY: getAllDatabases() may merge shared-store user facts (tagged with
        // a transient `__sharedOrigin`) into the character map when the feature is ON. A DB PROFILE
        // is the CHARACTER's own snapshot — it must NOT bake in shared-store copies (they'd be
        // written back per-character on profile load, defeating the dedup + risking divergence). So
        // strip `__sharedOrigin` facts here. No-op when the feature is off (nothing is ever tagged).
        const databases = {};
        for (const [cat, sdb] of Object.entries(databasesRaw || {})) {
            const facts = Array.isArray(sdb?.facts) ? sdb.facts.filter(f => !(f && f.__sharedOrigin)) : [];
            databases[cat] = sdb ? { ...sdb, facts } : { category: cat, facts };
        }
        const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);
        // Empty-store guard: by default an empty map is treated as "nothing to save" so a transient
        // load failure can't wipe a populated profile. An explicit clear/delete passes allowEmpty so
        // the genuinely-cleared state is persisted (the populated copy must NOT survive a wipe).
        if (totalFacts === 0 && !allowEmpty) return;

        extensionSettings.dbProfiles[profileName] = {
            ...extensionSettings.dbProfiles[profileName],
            databases: JSON.parse(JSON.stringify(databases)),
            savedAt: Date.now(),
        };
        saveSettings();
        addDebugLog('info', `Saved to active profile "${profileName}" (${totalFacts} facts)`, {
            subsystem: 'db', event: 'profile.saved', data: { profileName, totalFacts, allowEmpty },
        });
    } catch (err) {
        addDebugLog('fail', `Failed to save active profile: ${err.message}`);
    }
}

/**
 * Prune Layer C (the dbProfiles snapshot) so a USER-initiated delete/clear actually STICKS and
 * cannot be resurrected by autoSaveDbProfile on the next CHAT_CHANGED. Without this, deleting from
 * IDB + attachments leaves the full fact copy in extensionSettings.dbProfiles[active].databases,
 * which autoSaveDbProfile reloads on chat switch.
 *
 * Prunes EVERY profile linked to the current chat (not just the active one) plus the active profile
 * itself, so a re-link to a linked-but-not-active profile can't bring the data back.
 *
 * @param {string|null} category - a single category to remove, or null to empty ALL categories
 * @returns {{ profilesPruned: string[], factsPruned: number }}
 */
export function pruneActiveProfile(category = null) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return { profilesPruned: [], factsPruned: 0 };

    // Build the target set: the active profile + every profile linked to the current chat.
    const targets = new Set();
    const active = extensionSettings?.activeDbProfile;
    if (active && profiles[active]) targets.add(active);
    const chatId = getCurrentChatId();
    if (chatId) {
        for (const [name, profile] of Object.entries(profiles)) {
            if ((profile?.linkedChats || []).includes(chatId)) targets.add(name);
        }
    }

    const profilesPruned = [];
    let factsPruned = 0;
    for (const name of targets) {
        const profile = profiles[name];
        if (!profile || typeof profile !== 'object' || !profile.databases) continue;
        let changed = false;
        if (category == null) {
            // Empty ALL categories. Replace the snapshot with a fresh empty skeleton so the full
            // taxonomy still "exists" (zero facts) but no stored fact survives.
            for (const db of Object.values(profile.databases)) {
                factsPruned += (db?.facts?.length || 0);
            }
            profile.databases = {};
            changed = true;
        } else if (Object.prototype.hasOwnProperty.call(profile.databases, category)) {
            factsPruned += (profile.databases[category]?.facts?.length || 0);
            delete profile.databases[category];
            changed = true;
        }
        if (changed) {
            profile.savedAt = Date.now();
            profilesPruned.push(name);
        }
    }
    if (profilesPruned.length > 0) saveSettings();
    return { profilesPruned, factsPruned };
}

/**
 * Build the same target profile set pruneActiveProfile uses (the active profile + every profile
 * linked to the current chat). Factored out so the single-fact prune/edit write-through below can
 * touch EXACTLY the profiles that autoSaveDbProfile could reload from, guaranteeing a per-fact
 * delete/edit can never be resurrected (same 3-layer guarantee as commit 4e281b7's category delete).
 * @returns {string[]} profile names to touch
 */
function profilesLinkedToCurrentChat() {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return [];
    const targets = new Set();
    const active = extensionSettings?.activeDbProfile;
    if (active && profiles[active]) targets.add(active);
    const chatId = getCurrentChatId();
    if (chatId) {
        for (const [name, profile] of Object.entries(profiles)) {
            if ((profile?.linkedChats || []).includes(chatId)) targets.add(name);
        }
    }
    return [...targets];
}

/**
 * Prune a SINGLE fact (by category + key) from Layer C (the dbProfiles snapshot) so a per-fact
 * delete STICKS and cannot be resurrected by autoSaveDbProfile on the next CHAT_CHANGED. This is
 * the single-fact counterpart to pruneActiveProfile(category) — it removes only the one fact from
 * every profile the current chat could reload from (active + chat-linked), leaving every other fact
 * in those categories intact. Mirrors the working-store removeFact() so the two layers stay in sync.
 *
 * @param {string} category - the fact's owning category
 * @param {string} key - the fact key to remove
 * @returns {{ profilesPruned: string[], factsPruned: number }}
 */
export function pruneFactFromProfiles(category, key) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || !category || !key) return { profilesPruned: [], factsPruned: 0 };
    const profilesPruned = [];
    let factsPruned = 0;
    for (const name of profilesLinkedToCurrentChat()) {
        const profile = profiles[name];
        const db = profile?.databases?.[category];
        if (!db || !Array.isArray(db.facts)) continue;
        const before = db.facts.length;
        db.facts = db.facts.filter(f => f && f.key !== key);
        const removed = before - db.facts.length;
        if (removed > 0) {
            factsPruned += removed;
            db.updatedAt = Date.now();
            profile.savedAt = Date.now();
            profilesPruned.push(name);
        }
    }
    if (profilesPruned.length > 0) saveSettings();
    return { profilesPruned, factsPruned };
}

/**
 * Write an EDITED fact through to Layer C (the dbProfiles snapshot) so an edit STICKS and the next
 * CHAT_CHANGED reloads the NEW value, not the pre-edit one. Replaces the matching fact (by key) in
 * every active+chat-linked profile's copy of the category. Mirrors the working-store edit so the
 * two layers stay in sync (same anti-resurrection guarantee as the delete paths).
 *
 * @param {string} category - the fact's owning category
 * @param {string} key - the fact key to update
 * @param {import('./database.js').FactSchema} updatedFact - the new fact object (already mutated)
 * @returns {{ profilesUpdated: string[] }}
 */
export function updateFactInProfiles(category, key, updatedFact) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || !category || !key || !updatedFact) return { profilesUpdated: [] };
    const profilesUpdated = [];
    for (const name of profilesLinkedToCurrentChat()) {
        const profile = profiles[name];
        const db = profile?.databases?.[category];
        if (!db || !Array.isArray(db.facts)) continue;
        const idx = db.facts.findIndex(f => f && f.key === key);
        if (idx < 0) continue;
        // Deep-clone so the profile snapshot is independent of the live working-store object.
        db.facts[idx] = JSON.parse(JSON.stringify(updatedFact));
        db.updatedAt = Date.now();
        profile.savedAt = Date.now();
        profilesUpdated.push(name);
    }
    if (profilesUpdated.length > 0) saveSettings();
    return { profilesUpdated };
}

/**
 * Record that the user EXPLICITLY unlinked a chat from every profile, so autoSaveDbProfile will NOT
 * auto-create/re-link a profile for it on the next CHAT_CHANGED. Without this, re-entering the chat
 * silently re-links (autoSaveDbProfile's auto-create path) and the unlink appears to "do nothing".
 * Persisted in extensionSettings.unlinkedChats so the detach survives a reload.
 * @param {string} chatId
 */
function markChatUnlinked(chatId) {
    if (!chatId) return;
    if (!Array.isArray(extensionSettings.unlinkedChats)) extensionSettings.unlinkedChats = [];
    if (!extensionSettings.unlinkedChats.includes(chatId)) {
        extensionSettings.unlinkedChats.push(chatId);
        saveSettings();
    }
}

/** Re-allow auto-linking for a chat (called whenever the user explicitly links it). */
function clearChatUnlinked(chatId) {
    if (!chatId || !Array.isArray(extensionSettings.unlinkedChats)) return;
    const before = extensionSettings.unlinkedChats.length;
    extensionSettings.unlinkedChats = extensionSettings.unlinkedChats.filter(id => id !== chatId);
    if (extensionSettings.unlinkedChats.length !== before) saveSettings();
}

/** True when the user explicitly detached this chat and we must NOT auto-link it. */
function isChatUnlinked(chatId) {
    return !!chatId && Array.isArray(extensionSettings?.unlinkedChats) && extensionSettings.unlinkedChats.includes(chatId);
}

/**
 * Make an unlink actually TAKE EFFECT for the live session. When the chat just unlinked is the
 * CURRENT chat, this: (1) records the detach (so autoSaveDbProfile won't auto-relink on re-entry),
 * (2) clears activeDbProfile if it pointed at the now-unlinked profile, and (3) resets
 * lastAutoLoadedChat so a subsequent explicit re-link can reload. Without this, unlinking only
 * edited the linkedChats array while the active profile + working store stayed put and the chat
 * auto-relinked on the next CHAT_CHANGED — i.e. unlink "did nothing". No-op for a non-current chat
 * (that chat will simply not auto-load this profile next time it is opened).
 * @param {string} unlinkedChatId - the chat id just removed from the profile
 * @param {string} profileName - the profile it was removed from
 */
function detachCurrentChatIfNeeded(unlinkedChatId, profileName) {
    const currentChatId = getCurrentChatId();
    if (!unlinkedChatId || unlinkedChatId !== currentChatId) return;
    // The current chat no longer belongs to ANY profile -> stop auto-relinking it.
    if (!findProfileForChat(currentChatId)) {
        markChatUnlinked(currentChatId);
    }
    if (extensionSettings.activeDbProfile === profileName) {
        extensionSettings.activeDbProfile = '';
    }
    lastAutoLoadedChat = '';
    addDebugLog('info', `Unlinked current chat ${currentChatId} from profile "${profileName}" (detached: no auto-relink)`, {
        subsystem: 'settings', event: 'profile.unlinked', actor: 'USER', reason: 'USER_UNLINK',
        data: { chatId: currentChatId, profileName, stillLinkedElsewhere: !!findProfileForChat(currentChatId) },
    });
}

/**
 * FIX #9: Cheap client-side filter — returns true for messages that almost
 * certainly carry zero extractable facts, so the backfill can skip them WITHOUT
 * spending an LLM call. Conservative on purpose (only obvious no-ops):
 *   - empty / whitespace-only
 *   - very short (< 15 visible chars after stripping markup) — greetings,
 *     "ok", "*nods*", emoji, etc.
 *   - pure OOC lines: every non-empty line wrapped in (( )) or prefixed OOC:
 */
export function isTriviallyEmptyForExtraction(mes) {
    const raw = String(mes ?? '');
    // Strip simple action-asterisks and collapse whitespace for the length test.
    const visible = raw.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (visible.length === 0) return true;
    if (visible.length < 15) return true;

    // Pure OOC: all non-blank lines are out-of-character chatter.
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
        const allOoc = lines.every(l =>
            /^\(\(.*\)\)$/.test(l) || /^ooc\b/i.test(l) || /^\[ooc/i.test(l));
        if (allOoc) return true;
    }
    return false;
}

/**
 * FIX #9: Estimate how many LLM calls a backfill will make, so the confirm
 * dialog can warn the user about cost up front. Mirrors the skip logic in
 * runAgent3OnFullChat WITHOUT making any calls.
 */
export function estimateFullChatCalls({ skipAlreadyProcessed = true } = {}) {
    const ctx = getContext();
    const chat = ctx.chat || [];
    let calls = 0;
    for (const msg of chat) {
        if (!msg || !msg.mes) continue;
        if (msg.is_system) continue;
        if (msg.extra?.type) continue;
        if (skipAlreadyProcessed && msg.extra?.bf_mem_processed) continue;
        if (isTriviallyEmptyForExtraction(msg.mes)) continue;
        calls++;
    }
    return { calls, total: chat.length };
}

/**
 * Process the current chat's unprocessed backlog through the Memory Agent.
 *
 * redesign-v2 (S3): the old per-message Scribe fan-out was DELETED with runMemoryUpdater —
 * this is now a thin delegate over the chunked catch-up importer (src/catchup-import.js),
 * which runs one extract-only Memory Agent session per chunk, keeps the per-chunk resume
 * watermark, and rebuilds the memory sheet at the end. Kept as an export so the existing
 * "Run on full chat" button keeps working until S5 unifies the UI.
 *
 * @param {object} options
 * @param {boolean} options.skipAlreadyProcessed - accepted for signature compatibility; the
 *   importer ALWAYS skips already-processed messages (strict bf_mem_processed === true test).
 * @param {(progress: {current: number, total: number, factsAdded: number}) => void} options.onProgress
 * @param {() => boolean} options.shouldCancel - return true to abort at the next chunk boundary
 */
export async function runAgent3OnFullChat({ skipAlreadyProcessed = true, onProgress, shouldCancel } = {}) {
    void skipAlreadyProcessed; // the importer's strict watermark test supersedes this flag
    const { runCatchupImport } = await import('./catchup-import.js');
    const result = await runCatchupImport({
        onProgress: ({ msgsDone, msgsTotal, factsAdded }) => {
            onProgress?.({ current: msgsDone, total: msgsTotal, factsAdded });
        },
        shouldCancel,
    });
    return {
        processed: result.msgsDone || 0,
        skipped: 0,
        factsAdded: result.factsAdded || 0,
        refused: result.refused,
        cancelled: result.cancelled,
        aborted: result.aborted,
    };
}

async function autoSaveDbProfile() {
    try {
        const context = getContext();
        const chatId = getCurrentChatId();
        const chatLabel = getCurrentChatLabel();

        if (!chatId) return;
        if (chatId === lastAutoLoadedChat) return; // same chat, already loaded

        // NOTE: CHAT_CHANGED only LOADS, never SAVES. Saving here is unsafe because
        // ST may have already mutated state by flush time, causing the in-memory DB
        // (belonging to the previous chat) to be written into the wrong profile slot.
        // Persistence is handled at extraction time via saveCurrentToActiveProfile()
        // called from pipeline.js after every Agent 3 write (capture-at-write).

        // Observability: track HOW this chat resolved its DB so a single consolidated db.connect
        // event can tell the whole connect story (linked / auto-created / suppressed / none). This
        // only records what the existing branches already decided — it changes no behavior.
        const isBranch = isBranchChat(chatId);
        let linkState = 'none';

        // Check if this chat has a linked profile
        let profileToLoad = findProfileForChat(chatId);
        if (profileToLoad) linkState = 'linked';

        // RESPECT EXPLICIT UNLINK: if the user detached THIS chat from every profile (via the
        // Manage popup / "Unlink current chat" button), do NOT auto-create or re-link a profile
        // for it. Without this the auto-create path below silently re-links on re-entry and the
        // unlink appears to "do nothing". The chat runs with whatever is in the working store and
        // no profile is reloaded over it. (Explicitly linking the chat again clears this flag.)
        if (!profileToLoad && isChatUnlinked(chatId)) {
            // Make sure we are not still pointing at a now-detached active profile.
            if (extensionSettings.activeDbProfile && !findProfileForChat(chatId)) {
                extensionSettings.activeDbProfile = '';
                saveSettings();
                refreshDbProfileDropdown();
                refreshLinkedChatsField();
            }
            addDebugLog('info', `Auto-link suppressed: chat ${chatId} was explicitly unlinked by user`, {
                subsystem: 'settings', event: 'profile.autolinkSuppressed', actor: 'USER', reason: 'EXPLICIT_UNLINK',
                data: { chatId },
            });
            // Consolidated connect summary for the suppressed case: no profile reloaded over the
            // working store. factsLoaded/categories reflect whatever is already live in the store.
            try {
                const { getAllDatabases } = await import('./database.js');
                const live = await getAllDatabases();
                const cats = Object.keys(live || {});
                const factsLoaded = cats.reduce((n, c) => n + ((live[c]?.facts || []).length), 0);
                addDebugLog('info', `DB connect: chat ${chatId} -> (unlinked, suppressed) ${factsLoaded} facts`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                    data: {
                        chatId, resolvedProfile: null, linkState: 'unlinked-suppressed',
                        factsLoaded, categories: cats.length,
                        source: factsLoaded > 0 ? 'idb' : 'empty', isBranch,
                    },
                });
            } catch { /* logging-only: best-effort */ }
            lastAutoLoadedChat = chatId;
            return;
        }

        // BRANCH INHERIT (data-safety, default = INHERIT): a branched chat has a brand-new chatId
        // that is in no profile's linkedChats, so findProfileForChat() above returned null. Rather
        // than auto-creating an EMPTY skeleton profile (which would diverge the branch from the
        // parent's accumulated memory and, via the old destructive load, blank the shared
        // avatar-keyed working store), resolve the branch to the PARENT's existing profile and link
        // this branch id to it. The avatar store already holds the parent's facts; inheriting the
        // parent profile means the load block re-applies the parent's facts (not an empty skeleton).
        if (!profileToLoad && isBranch) {
            const parentProfile = resolveBranchParentProfile(chatId);
            if (parentProfile) {
                linkChatToProfile(parentProfile, chatId);
                profileToLoad = parentProfile;
                linkState = 'inherited-branch';
                addDebugLog('info', `Branch inherited parent DB profile "${parentProfile}" for chat ${chatId}`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'BRANCH_INHERIT',
                    data: { chatId, resolvedProfile: parentProfile, parentChatId: parentChatIdOfBranch(chatId), isBranch: true },
                });
            }
        }

        // If no linked profile exists, create one named after the chat/character
        if (!profileToLoad && chatLabel) {
            // Only auto-create if we're entering a chat for the first time
            if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
            if (!extensionSettings.dbProfiles[chatLabel]) {
                // 3-layer model: seed the new profile's in-memory databases with the empty
                // Layer-1 skeleton so the full taxonomy "exists" from turn 1 (visible in the
                // menu / Database tab, pickable by Agent 1). These are EMPTY (zero facts) and
                // are NOT written as attachment files here — a category file is persisted only
                // when a real fact lands (write-on-first-fact via Agent 3 / saveDatabase), so
                // we never spam the backend with empty uploads.
                const { buildSkeletonDatabases } = await import('./database.js');
                const seeded = buildSkeletonDatabases();
                extensionSettings.dbProfiles[chatLabel] = {
                    databases: seeded,
                    savedAt: Date.now(),
                    linkedChats: [chatId],
                };
                addDebugLog('info', `Auto-created DB profile "${chatLabel}" (seeded Layer-1 skeleton) for chat ${chatId}`, {
                    subsystem: 'import', event: 'db.seeded', actor: 'SYSTEM',
                    data: { profileName: chatLabel, chatId, categoriesSeeded: Object.keys(seeded) },
                });
                linkState = 'auto-created';
            } else {
                // Profile with that name exists, link this chat to it
                linkChatToProfile(chatLabel, chatId);
                // A pre-existing same-named profile we just linked to is, for connect-story
                // purposes, a linked load (not a fresh auto-create).
                linkState = 'linked';
            }
            profileToLoad = chatLabel;
        }

        // Load the linked profile
        if (profileToLoad && extensionSettings.dbProfiles?.[profileToLoad]) {
            const profile = extensionSettings.dbProfiles[profileToLoad];
            const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

            // DATA-SAFETY FIX (non-destructive empty-profile load): count the facts the resolved
            // profile would actually install. A freshly auto-created / skeleton profile carries ZERO
            // facts — and the OLD code unconditionally delete-all'd every live category (wiping the
            // shared avatar-keyed IDB record AND its durable attachment files) and then re-wrote only
            // the profile's NON-empty categories. For an empty profile that BLANKED the working store
            // → retrieval saw 0 facts → extraction minted fresh DBs → the stamp race rehydrated stale
            // data back. Opening a chat must NEVER blank existing memory.
            const profileFactCount = Object.values(profile.databases || {})
                .reduce((n, db) => n + ((db && Array.isArray(db.facts)) ? db.facts.length : 0), 0);

            if (profileFactCount === 0) {
                // EMPTY PROFILE → do NOT clear. Leave the avatar-keyed working store INTACT; the
                // empty Layer-1 skeleton is layered UNDER it via withSkeleton at the menu/Database
                // tab. This makes a fresh branch / empty-profile chat inherit whatever the shared
                // avatar store already holds instead of being wiped to empty.
                const live = await getAllDatabases();
                const liveFacts = Object.values(live || {})
                    .reduce((n, db) => n + ((db?.facts || []).length), 0);
                addDebugLog('info', `Auto-load SKIPPED clear: profile "${profileToLoad}" has 0 facts — kept live store (${liveFacts} facts)`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'NON_DESTRUCTIVE_EMPTY_PROFILE',
                    data: { chatId, resolvedProfile: profileToLoad, decision: 'KEEP_LIVE_STORE', profileFactCount, liveFacts, isBranch },
                });
            } else {
                // POPULATED PROFILE → install its facts. Clear existing first (the profile is the
                // authoritative copy for this chat), then re-write its NON-empty categories. Skip
                // EMPTY (factless) categories: the Layer-1 skeleton is seeded in memory and shown via
                // withSkeleton — persisting empty categories as attachments would spam the backend.
                const existing = await getAllDatabases();
                for (const category of Object.keys(existing)) {
                    await deleteDatabase(category);
                }
                for (const [category, db] of Object.entries(profile.databases || {})) {
                    if (!db || !Array.isArray(db.facts) || db.facts.length === 0) continue;
                    await saveDatabase({ ...db, category });
                }
            }

            extensionSettings.activeDbProfile = profileToLoad;
            saveSettings();
            refreshDbProfileDropdown();
            refreshLinkedChatsField();
            addDebugLog('info', `Auto-loaded DB profile "${profileToLoad}" (linked to chat ${chatId})`, {
                subsystem: 'import', event: 'profile.switched', actor: 'SYSTEM', reason: 'AUTO_LOADED', data: { profileName: profileToLoad, chatId },
            });

            // Consolidated connect summary (one line tells the whole connect story). Census the
            // working store right after the load so factsLoaded/categories reflect what actually
            // landed. source: 'profile' when facts came in from the dbProfile, 'empty' when the
            // resolved profile carried zero facts (e.g. fresh skeleton). Read-only.
            try {
                const live = await getAllDatabases();
                const cats = Object.keys(live || {});
                const factsLoaded = cats.reduce((n, c) => n + ((live[c]?.facts || []).length), 0);
                addDebugLog('info', `DB connect: chat ${chatId} -> profile "${profileToLoad}" (${linkState}) ${factsLoaded} facts`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                    data: {
                        chatId, resolvedProfile: profileToLoad, linkState,
                        factsLoaded, categories: cats.length,
                        source: factsLoaded > 0 ? 'profile' : 'empty', isBranch,
                    },
                });
            } catch { /* logging-only: best-effort */ }
        } else {
            // No profile resolved AND not the suppressed path (e.g. no chatLabel to name one).
            // Emit a connect summary so the absence of a DB context is still visible in the log.
            addDebugLog('info', `DB connect: chat ${chatId} -> (no profile resolved)`, {
                subsystem: 'db', event: 'db.connect', actor: 'SYSTEM',
                data: {
                    chatId, resolvedProfile: null, linkState: 'none',
                    factsLoaded: null, categories: null, source: 'empty', isBranch,
                },
            });
        }

        lastAutoLoadedChat = chatId;
    } catch (err) {
        addDebugLog('fail', `Auto-save DB profile failed: ${err.message}`);
    }
}

function refreshLinkedChatsField() {
    const display = document.getElementById('bf_mem_db_linked_chats');
    if (!display) return;
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        display.textContent = '(none)';
        return;
    }
    const profile = extensionSettings.dbProfiles[profileName];
    const chats = profile.linkedChats || [];
    display.textContent = chats.length > 0 ? chats.join(', ') : '(none)';
}

async function showLinkedChatsPopup() {
    const selected = document.getElementById('bf_mem_db_profile_select')?.value;
    const profileName = selected || extensionSettings?.activeDbProfile;
    if (!profileName || !extensionSettings?.dbProfiles?.[profileName]) {
        toastr.warning('No profile selected', 'BF Memory');
        return;
    }

    const profile = extensionSettings.dbProfiles[profileName];
    const linkedChats = [...(profile.linkedChats || [])];
    const currentChatId = getCurrentChatId();

    let html = `<div class="bf-mem-linked-popup">
        <h4>Linked Chats for "${escapeHtml(profileName)}"</h4>
        <p>These chats will auto-load this DB profile when opened.</p>
        <div class="bf-mem-linked-list" id="bf_mem_linked_list">`;

    if (linkedChats.length === 0) {
        html += '<div class="bf-mem-empty">No chats linked yet.</div>';
    } else {
        for (const chatId of linkedChats) {
            const isCurrent = chatId === currentChatId;
            html += `<div class="bf-mem-linked-item">
                <span class="bf-mem-linked-name">${escapeHtml(chatId)}${isCurrent ? ' (current)' : ''}</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>`;
        }
    }

    html += `</div>
        <div class="bf-mem-linked-add-row" style="margin-top: 10px;">
            <button id="bf_mem_link_current" class="menu_button">
                <i class="fa-solid fa-plus"></i> Link Current Chat
            </button>
        </div>
    </div>`;

    await ensurePopup();
    if (!Popup) {
        toastr.error('Popup not available', 'BF Memory');
        return;
    }

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { allowVerticalScrolling: true });
    await popup.show();

    // Bind remove buttons
    document.querySelectorAll('.bf-mem-linked-remove').forEach(btn => {
        btn.addEventListener('click', () => {
            const chatId = btn.dataset.chat;
            const idx = profile.linkedChats.indexOf(chatId);
            if (idx >= 0) {
                profile.linkedChats.splice(idx, 1);
                detachCurrentChatIfNeeded(chatId, profileName);
                saveSettings();
                refreshLinkedChatsField();
                refreshDbProfileDropdown();
                btn.closest('.bf-mem-linked-item').remove();
                toastr.success(`Unlinked "${chatId}"`, 'BF Memory');
            }
        });
    });

    // Bind "Link Current Chat" button
    document.getElementById('bf_mem_link_current')?.addEventListener('click', () => {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('No chat currently open', 'BF Memory');
            return;
        }
        if (!profile.linkedChats) profile.linkedChats = [];
        if (profile.linkedChats.includes(chatId)) {
            toastr.info('Current chat is already linked', 'BF Memory');
            return;
        }
        // Remove from other profiles first
        for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
            if (name !== profileName && p.linkedChats) {
                p.linkedChats = p.linkedChats.filter(id => id !== chatId);
            }
        }
        profile.linkedChats.push(chatId);
        // An explicit (re-)link re-enables auto-link for this chat and makes it the active profile.
        clearChatUnlinked(chatId);
        extensionSettings.activeDbProfile = profileName;
        lastAutoLoadedChat = '';
        saveSettings();
        refreshLinkedChatsField();
        refreshDbProfileDropdown();
        toastr.success(`Linked current chat to "${profileName}"`, 'BF Memory');
        // Refresh the popup list
        const listEl = document.getElementById('bf_mem_linked_list');
        if (listEl) {
            const item = document.createElement('div');
            item.className = 'bf-mem-linked-item';
            item.innerHTML = `<span class="bf-mem-linked-name">${escapeHtml(chatId)} (current)</span>
                <button class="bf-mem-linked-remove menu_button" data-chat="${escapeHtml(chatId)}" title="Remove">
                    <i class="fa-solid fa-xmark"></i>
                </button>`;
            listEl.querySelector('.bf-mem-empty')?.remove();
            listEl.appendChild(item);
        }
    });
}

// --- Init ---

export async function initSettings() {
    const context = getContext();

    // Load saved settings (guard against null, arrays, primitives, or corrupted blobs)
    if (!context.extensionSettings) context.extensionSettings = {};
    let resetClobberedEnabled = false; // FIX #10: track if a reset flipped enabled true->false
    let freshInstall = false; // C4: genuine first run (no prior settings object) → show a nudge
    try {
        const current = context.extensionSettings[EXTENSION_NAME];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            // A genuine first install has NO prior object at all (nullish). A corrupt non-null blob
            // is a reset, not a first run — don't nudge in that case.
            if (current == null) freshInstall = true;
            if (current && typeof current === 'object' && current.enabled === true) resetClobberedEnabled = true;
            context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
    } catch (err) {
        console.error('[BFMemory] corrupt settings, resetting:', err);
        try { if (context.extensionSettings?.[EXTENSION_NAME]?.enabled === true) resetClobberedEnabled = true; } catch { /* ignore */ }
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        if (typeof toastr !== 'undefined') {
            toastr.warning('BF Memory settings were corrupt and have been reset.');
        }
    }
    extensionSettings = context.extensionSettings[EXTENSION_NAME];

    // Merge missing defaults
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings, key)) {
            extensionSettings[key] = value;
        }
    }

    // Migrate legacy settings keys (soft migration — leaves old key for rollback)
    migrateLegacySettings(extensionSettings);

    // Type-coerce and clamp values (defends against persisted garbage)
    validateSettings(extensionSettings);

    // FIX #10: log if a corrupt-settings reset silently turned the pipeline off.
    if (resetClobberedEnabled && !extensionSettings.enabled) {
        addDebugLog('fail', 'Pipeline DISABLED by corrupt-settings reset (was enabled before reset)');
    }

    // Load HTML template
    let path = `scripts/extensions/third-party/${EXTENSION_NAME}`;
    let html = null;

    try {
        html = await $.get(`${path}/templates/settings.html`);
    } catch {
        path = `scripts/extensions/${EXTENSION_NAME}`;
        try {
            html = await $.get(`${path}/templates/settings.html`);
        } catch {
            console.error('[BFMemory] Failed to load UI template');
            return;
        }
    }

    $('#extensions_settings').append(html);

    // Populate version label from manifest (single source of truth — no risk of drift).
    // If the fetch fails, the placeholder "v?.?.?" remains so testers can see it didn't load.
    try {
        const manifest = await $.getJSON(`${path}/manifest.json`);
        if (manifest?.version) {
            $('#bf_mem_version').text(`v${manifest.version}`);
        }
    } catch (err) {
        console.warn('[BFMemory] Could not load manifest for version label:', err?.message);
    }

    // --- Setup Tabs ---
    setupTabs();

    // C4: first-run nudge. On a genuine first install the pipeline ships with the "Balanced" preset
    // but stays DISABLED (auto-running an LLM pipeline unprompted would be too aggressive). Point the
    // user at the two clicks that matter: tick Enable, and pick a (cheap) memory model. Fires once.
    if (freshInstall && typeof toastr !== 'undefined') {
        try {
            toastr.info(
                'Tick Enable, then pick a memory model for the background Memory Agent (a cheap one is fine).',
                'BF Memory — quick start',
                { timeOut: 12000, extendedTimeOut: 6000 },
            );
        } catch { /* nudge is best-effort */ }
        addDebugLog('info', 'First-run install detected (disabled until user enables)', {
            subsystem: 'settings', event: 'settings.first_run', actor: 'SYSTEM',
        });
    }

    // --- Pipeline Tab ---
    $('#bf_mem_enabled').prop('checked', extensionSettings.enabled).on('change', function () {
        const next = $(this).prop('checked');
        // FIX #10: log enable/disable state changes.
        if (next !== extensionSettings.enabled) {
            addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} by user`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled' }, before: !!extensionSettings.enabled, after: !!next });
        }
        extensionSettings.enabled = next;
        updateStatus('idle');
        saveSettings();
        // CANCEL ON DISABLE: toggling OFF must HALT an in-flight run promptly, not let it finish
        // ~75s later and inject. cancelActiveRun() sets the cancel flag AND aborts in-flight agent
        // LLM calls. Dynamic import avoids a static circular dep (pipeline.js imports settings.js).
        if (!next) {
            import('./pipeline.js')
                .then(({ cancelActiveRun }) => cancelActiveRun?.('disabled'))
                .catch(() => { /* pipeline not ready yet — nothing in flight to cancel */ });
        }
    });

    // redesign-v2 (S1): the usability-preset dropdown (uiPreset) was removed.

    reloadProfiles();
    $('#bf_mem_agent3_profile').val(extensionSettings.agent3Profile || '').on('change', function () {
        extensionSettings.agent3Profile = $(this).val() || '';
        addDebugLog('info', `Agent 3 profile changed`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'agent3Profile', value: extensionSettings.agent3Profile } });
        saveSettings();
    });

    $('#bf_mem_refresh_profiles').on('click', () => {
        reloadProfiles();
        toastr.info('Profiles refreshed', 'BF Memory');
    });

    // Writer history limit slider (agent2ContextMessages): trims the main model's visible chat.

    $('#bf_mem_agent2_context').val(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context_val').text(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.agent2ContextMessages = val;
        $('#bf_mem_agent2_context_val').text(val);
        saveSettings();
    });

    // Settled buffer hold-back slider (§7): the newest N messages are never mined for facts.
    $('#bf_mem_buffer_holdback').val(extensionSettings.bufferHoldBack);
    $('#bf_mem_buffer_holdback_val').text(extensionSettings.bufferHoldBack);
    $('#bf_mem_buffer_holdback').on('input', function () {
        const val = parseInt($(this).val(), 10);
        const before = extensionSettings.bufferHoldBack;
        extensionSettings.bufferHoldBack = val;
        $('#bf_mem_buffer_holdback_val').text(val);
        if (before !== val) addDebugLog('debug', `Buffer hold-back: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'bufferHoldBack' }, before, after: val });
        saveSettings();
    });

    // Bonus connected facts slider (graphExtrasCount): "Connected memories" on the sheet.
    $('#bf_mem_graph_extras').val(extensionSettings.graphExtrasCount);
    $('#bf_mem_graph_extras_val').text(extensionSettings.graphExtrasCount);
    $('#bf_mem_graph_extras').on('input', function () {
        const val = parseInt($(this).val(), 10);
        const before = extensionSettings.graphExtrasCount;
        extensionSettings.graphExtrasCount = val;
        $('#bf_mem_graph_extras_val').text(val);
        if (before !== val) addDebugLog('debug', `Graph extras count: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'graphExtrasCount' }, before, after: val });
        saveSettings();
    });

    // redesign-v2 (S1): the writer-side search_memory / remember_fact tool toggles were removed.

    // knownBy (POV) enforcement toggle. Default ON. Read lazily per call inside
    // isFactVisible() (fact-retrieval.js), so no re-wiring is needed on change.
    $('#bf_mem_knownby_enforced').prop('checked', extensionSettings.enforceKnownBy !== false).on('change', function () {
        const before = extensionSettings.enforceKnownBy !== false;
        const next = $(this).prop('checked');
        extensionSettings.enforceKnownBy = next;
        addDebugLog('info', `knownBy enforcement ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enforceKnownBy' }, before, after: !!next });
        saveSettings();
    });

    // redesign-v2 (S1): the summary-pyramid / open-threads-line / moment-echo / re-entry
    // injection toggles were removed (the memory sheet replaces the old injection stack).

    // redesign-v2 (S5): the auto-linking, scribe-trim, cross-key-supersede, recency-labels,
    // truth-hierarchy, MMR, confidence-ranking, temporal-grounding and reflection-compression
    // toggles/sliders were removed — every one of those behaviors is now HARDCODED ON (G4) and
    // its setting key deleted from DEFAULT_SETTINGS. The modules that used them read a local const.

    // Toast
    $('#bf_mem_toast').prop('checked', extensionSettings.showToast).on('change', function () {
        extensionSettings.showToast = $(this).prop('checked');
        saveSettings();
    });

    // redesign-v2 (S5): reflection is HARDCODED ON (G4 — interval 12, maxTokens 200); its
    // enable/interval/prompt controls were removed. agent-reflect.js falls back to
    // DEFAULT_REFLECT_PROMPT when no override is stored. The live summary panel remains.
    // Render the current live reflection summary (read-only)
    renderReflection();

    // --- Prompts ---
    // redesign-v2 (S3): memoryPrompt is now an OVERRIDE — extra instructions APPENDED to the
    // Memory Agent's user prompt (agent-memory.js buildAgentUserPrompt), never a replacement
    // of the static rulebook (which must stay byte-stable for prompt caching). Blank = none.
    $('#bf_mem_memory_prompt').val(extensionSettings.memoryPrompt || '').off('input').on('input', function () {
        extensionSettings.memoryPrompt = String($(this).val() || '').trim() ? String($(this).val()) : '';
        saveSettings();
    });

    $('#bf_mem_reset_memory_prompt').on('click', () => {
        extensionSettings.memoryPrompt = '';
        $('#bf_mem_memory_prompt').val('');
        addDebugLog('info', 'Memory Agent extra instructions cleared', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'memoryPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Memory Agent extra instructions cleared', 'BF Memory');
    });

    // --- Database Tab: Profiles ---
    refreshDbProfileDropdown();

    $('#bf_mem_db_profile_load').on('click', async () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to load', 'BF Memory');
            return;
        }
        try {
            await loadDbProfile(selected);
        } catch (err) {
            addDebugLog('fail', `Load profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.load', actor: 'USER' });
            toastr.error('Failed to load profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_save').on('click', async () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select an existing profile to overwrite, or use "Save As New"', 'BF Memory');
            return;
        }
        try {
            await saveDbProfile(selected);
        } catch (err) {
            addDebugLog('fail', `Save profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to save profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_save_new').on('click', async () => {
        const name = prompt('Enter a name for this database profile:');
        if (!name || !name.trim()) return;
        const cleanName = name.trim();
        if (extensionSettings.dbProfiles?.[cleanName]) {
            if (!confirm(`Profile "${cleanName}" already exists. Overwrite?`)) return;
        }
        try {
            await saveDbProfile(cleanName);
        } catch (err) {
            addDebugLog('fail', `Save-as-new profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to save profile', 'BF Memory');
        }
    });

    $('#bf_mem_db_profile_delete').on('click', () => {
        const selected = $('#bf_mem_db_profile_select').val();
        if (!selected) {
            toastr.warning('Select a profile to delete', 'BF Memory');
            return;
        }
        deleteDbProfile(selected);
    });

    // Linked chats display + manage button
    refreshLinkedChatsField();
    $('#bf_mem_db_profile_select').on('change', () => refreshLinkedChatsField());
    $('#bf_mem_db_linked_manage').on('click', () => showLinkedChatsPopup());

    // --- Database Tab ---
    $('#bf_mem_refresh_db').on('click', () => refreshDatabaseView());
    $('#bf_mem_view_web').on('click', () => showSpiderwebPopup());

    // Unlink the CURRENT chat from its profile (one-click, on the main tab). Detaches so it won't
    // auto-relink on the next CHAT_CHANGED — makes unlink actually stick.
    $('#bf_mem_db_unlink_current').on('click', () => unlinkCurrentChat());

    $('#bf_mem_clear_db').on('click', async () => {
        if (!confirm('Reset memory to EMPTY for this character? This wipes every stored fact across all storage layers. This cannot be undone.')) return;
        const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
        const dbs = await getAllDatabases();
        const clearedCats = Object.keys(dbs);
        const clearedFacts = Object.values(dbs).reduce((s, db) => s + (db.facts?.length || 0), 0);
        // Cancel any armed snapshot up-front so it can't fire mid-loop and re-write a deleted file.
        cancelPendingSnapshot();
        // Layer A (IDB) + Layer B (attachment files): deleteDatabase wipes both per category.
        for (const category of clearedCats) {
            await deleteDatabase(category);
        }
        // Layer C (dbProfiles snapshot): empty the active + every chat-linked profile so
        // autoSaveDbProfile reloads an EMPTY profile on the next CHAT_CHANGED instead of resurrecting.
        const { profilesPruned, factsPruned } = pruneActiveProfile(null);
        // Belt-and-suspenders: persist the genuinely-empty working store into the active profile too
        // (allowEmpty bypasses the empty-store guard that normally blocks an empty save).
        await saveCurrentToActiveProfile(null, { allowEmpty: true });
        // Force a reconciling durable snapshot NOW: reconcileDeletedAttachments deletes attachment
        // files for every category no longer live in IDB, so no leftover file can rehydrate.
        await flushSnapshotNow();
        addDebugLog('pass', `Reset to empty: cleared ${clearedFacts} facts across ${clearedCats.length} categories + profile pruned`, {
            subsystem: 'db', event: 'db.cleared', actor: 'USER', reason: 'USER_CLEAR_ALL',
            data: {
                dbCount: clearedCats.length, totalFacts: clearedFacts, categories: clearedCats,
                profilesPruned, factsPrunedFromProfile: factsPruned,
            },
        });
        toastr.success('Memory reset to empty (all layers)', 'BF Memory');
        refreshDatabaseView();
    });

    // redesign-v2 (S5): the per-message "Run the Scribe on full chat" button was removed — the
    // chunked catch-up importer below is the single retroactive-extraction path now.

    // --- Catch-up import (chunked backlog onboarding, src/catchup-import.js) ---
    // One Scribe call per CHUNK of messages instead of per message — the cheap way to onboard a
    // long pre-existing chat. Not preset-governed; the run/cancel pair shares one flag with the
    // /bfmem catchup slash command via the module's exported cancel/inFlight state.
    $('#bf_mem_catchup_batch').val(extensionSettings.catchupBatchSize);
    $('#bf_mem_catchup_batch_val').text(extensionSettings.catchupBatchSize);
    $('#bf_mem_catchup_batch').on('input', function () {
        const val = parseInt($(this).val(), 10) || 8;
        const before = extensionSettings.catchupBatchSize;
        extensionSettings.catchupBatchSize = val;
        $('#bf_mem_catchup_batch_val').text(val);
        if (before !== val) addDebugLog('debug', `Catch-up batch size: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'catchupBatchSize' }, before, after: val });
        saveSettings();
    });

    $('#bf_mem_catchup_run').on('click', async () => {
        const btn = $('#bf_mem_catchup_run');
        const cancelBtn = $('#bf_mem_catchup_cancel');
        const progress = $('#bf_mem_catchup_progress');
        const progressText = $('#bf_mem_catchup_progress_text');
        const progressFill = $('#bf_mem_catchup_progress_fill');
        try {
            const { planCatchupChunks, runCatchupImport, isCatchupRunning } = await import('./catchup-import.js');
            if (isCatchupRunning()) {
                toastr.warning('A catch-up import is already running.', 'BF Memory');
                return;
            }
            // Cost estimate up front (FIX #9 pattern): calls = chunks. planCatchupChunks reads the
            // live chat without spending anything.
            const chat = getContext().chat || [];
            const { chunks, eligibleCount, totalMsgs } = planCatchupChunks(chat, extensionSettings.catchupBatchSize);
            if (chunks.length === 0) {
                toastr.info(`Nothing to catch up: all ${totalMsgs} message(s) are already done or trivially empty.`, 'BF Memory');
                return;
            }
            if (!confirm(`Catch-up import this chat in chunks?\n\nThis will make ~${chunks.length} LLM call(s) (one per chunk of ≤${extensionSettings.catchupBatchSize} messages; ${eligibleCount} unprocessed message(s) out of ${totalMsgs} total). Per-chunk prompts are bigger than per-message ones.\n\nDon't chat in this conversation while it runs. Proceed?`)) return;

            btn.prop('disabled', true).text('Importing...');
            cancelBtn.show().prop('disabled', false);
            progress.show();
            progressText.text('Starting…');
            progressFill.css('width', '0%');

            const result = await runCatchupImport({
                batchSize: extensionSettings.catchupBatchSize,
                onProgress: ({ chunk, chunks, msgsDone, msgsTotal, factsAdded }) => {
                    progressText.text(`Chunk ${chunk}/${chunks} · ${msgsDone}/${msgsTotal} messages · ${factsAdded} facts`);
                    progressFill.css('width', `${Math.round((chunk / Math.max(1, chunks)) * 100)}%`);
                },
            });
            if (result.refused) {
                progressText.text('Not started (see toast).');
                return;
            }
            const verb = result.cancelled ? 'cancelled' : result.aborted ? 'stopped' : 'finished';
            toastr.success(`Catch-up ${verb}: ${result.processedChunks}/${result.chunks} chunk(s), ${result.msgsDone} message(s), ${result.factsAdded} facts${result.failedChunks ? `, ${result.failedChunks} failed (re-run to retry)` : ''}`, 'BF Memory');
            progressText.text(`${verb}: ${result.processedChunks}/${result.chunks} chunks · ${result.msgsDone} msgs · ${result.factsAdded} facts`);
            refreshDatabaseView();
        } catch (err) {
            toastr.error(`Catch-up import failed: ${err.message || err}`, 'BF Memory');
            progressText.text(`Failed: ${err.message || err}`);
        } finally {
            btn.prop('disabled', false).html('<i class="fa-solid fa-forward-fast"></i> Catch-up import');
            cancelBtn.hide().prop('disabled', false).html('<i class="fa-solid fa-stop"></i> Cancel');
        }
    });

    $('#bf_mem_catchup_cancel').on('click', async () => {
        const { cancelCatchupImport } = await import('./catchup-import.js');
        if (cancelCatchupImport()) {
            // Cancel lands at the NEXT chunk boundary — the in-flight chunk still finishes.
            $('#bf_mem_catchup_cancel').prop('disabled', true).text('Cancelling (finishing current chunk)…');
        }
    });

    // --- Tokens Tab ---
    $('#bf_mem_tokens_reset').on('click', () => {
        // Session-token state moved to turn-state.js (F-UX-8 split); resetSessionTokens()
        // performs the exact same zero + persist + re-render sequence this handler inlined.
        resetSessionTokens();
    });

    // --- Debug Tab ---
    $('#bf_mem_debug').prop('checked', extensionSettings.debugMode).on('change', function () {
        extensionSettings.debugMode = $(this).prop('checked');
        saveSettings();
    });

    // Verbose tier toggle (opt-in firehose). When OFF, addDebugLog drops level:'verbose'
    // at INGESTION (see addDebugLog) — this is the capture-side volume control, not just a
    // display filter. Greys out the verbose display checkbox to match (nothing to show).
    const syncVerboseLevelControl = () => {
        const on = !!extensionSettings.debugVerbose;
        const vbox = document.querySelector('.bf-mem-log-level[value="verbose"]');
        const wrap = document.getElementById('bf_mem_log_level_verbose_wrap');
        if (vbox) { vbox.disabled = !on; if (!on) vbox.checked = false; }
        if (wrap) wrap.classList.toggle('bf-mem-disabled', !on);
    };
    $('#bf_mem_debug_verbose').prop('checked', extensionSettings.debugVerbose).on('change', function () {
        extensionSettings.debugVerbose = $(this).prop('checked');
        saveSettings();
        syncVerboseLevelControl();
        renderDebugLog();
    });
    syncVerboseLevelControl();

    // Filter toolbar: pure client-side re-render over the in-memory buffer on any change.
    $(document).on('change', '.bf-mem-log-level', () => renderDebugLog());
    $('#bf_mem_log_subsystem').on('change', () => renderDebugLog());
    $('#bf_mem_log_search').on('input', () => renderDebugLog());

    // Ring-buffer state moved to debug-log.js (F-UX-8 split); clearDebugLog() performs the exact
    // same buffer + metadata-slice + attachment-file + re-render sequence this handler inlined.
    $('#bf_mem_clear_log').on('click', () => clearDebugLog());

    // Export the full RAM ring buffer as machine-readable JSON. Mirrors the Copy button's
    // clipboard-with-mobile-fallback pattern, plus a file download.
    // Copy Diagnostics: bundle settings + logs + database (facts+links) + scene + entities to clipboard/file.
    $('#bf_mem_copy_all').on('click', () => copyDiagnostics());

    $('#bf_mem_export_json').on('click', async () => {
        const json = exportLogsJSON();
        let chatId = 'log';
        try { chatId = String(getContext().chatId ?? 'log'); } catch { /* no chat */ }
        const fname = `bf-mem-log-${chatId}-${Date.now()}.json`;
        // Download as a file.
        try {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch { /* download best-effort */ }
        // Also copy to clipboard for convenience.
        try {
            await navigator.clipboard.writeText(json);
            toastr.success(`Log JSON downloaded + copied (${getDebugLogEntries().length} entries)`, 'BF Memory');
        } catch {
            toastr.success(`Log JSON downloaded (${getDebugLogEntries().length} entries)`, 'BF Memory');
        }
    });

    // "Why not fact X?" retrieval probe — explains a single fact's fate this turn.
    const runProbe = async () => {
        const input = document.getElementById('bf_mem_probe_key');
        const out = document.getElementById('bf_mem_probe_result');
        if (!out) return;
        const key = (input?.value || '').trim();
        if (!key) { out.textContent = 'Enter a fact key (e.g. Status/location) to probe.'; return; }
        out.textContent = 'Checking…';
        try {
            const res = await explainFactRetrieval(key);
            const detail = res.detail ? safeStringify(res.detail) : '';
            out.innerHTML =
                `<span class="bf-mem-probe-reason ${res.found ? 'found' : 'missing'}">${escapeHtml(res.reason || 'unknown')}</span> ` +
                `<span class="bf-mem-probe-detail">${escapeHtml(detail)}</span>`;
        } catch (err) {
            out.textContent = `Probe failed: ${err?.message || err}`;
        }
    };
    $('#bf_mem_probe_btn').on('click', runProbe);
    $('#bf_mem_probe_key').on('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runProbe(); } });

    $('#bf_mem_copy_log').on('click', async () => {
        const logText = exportLogs();
        try {
            await navigator.clipboard.writeText(logText);
            toastr.success('Logs copied to clipboard', 'BF Memory');
        } catch {
            // Mobile-friendly fallback: prompt() truncates and lacks select-all.
            // Build a textarea overlay that the user can long-press to select-all.
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';
            const card = document.createElement('div');
            card.style.cssText = 'background:var(--SmartThemeBlurTintColor,#1a1a2e);padding:16px;border-radius:8px;max-width:600px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:8px;';
            const title = document.createElement('div');
            title.textContent = 'Copy debug log';
            title.style.cssText = 'font-weight:bold;color:#7bb3ff;';
            const hint = document.createElement('div');
            hint.textContent = 'Long-press the text area to Select All, then Copy.';
            hint.style.cssText = 'font-size:12px;opacity:0.7;';
            const textarea = document.createElement('textarea');
            textarea.value = logText;
            textarea.readOnly = true;
            textarea.style.cssText = 'width:100%;min-height:200px;flex:1;font-family:monospace;font-size:11px;background:#000;color:#eee;padding:8px;';
            const buttonRow = document.createElement('div');
            buttonRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
            const selectAllBtn = document.createElement('button');
            selectAllBtn.textContent = 'Select All';
            selectAllBtn.className = 'menu_button';
            selectAllBtn.onclick = () => { textarea.select(); textarea.setSelectionRange(0, textarea.value.length); };
            const closeBtn = document.createElement('button');
            closeBtn.textContent = 'Close';
            closeBtn.className = 'menu_button';
            closeBtn.onclick = () => overlay.remove();
            buttonRow.appendChild(selectAllBtn);
            buttonRow.appendChild(closeBtn);
            card.appendChild(title);
            card.appendChild(hint);
            card.appendChild(textarea);
            card.appendChild(buttonRow);
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            // Auto-select on open for desktop convenience
            setTimeout(() => { textarea.focus(); textarea.select(); }, 0);
        }
    });

    // --- Auto-refresh profiles on change ---
    context.eventSource?.on(context.eventTypes?.CONNECTION_PROFILE_LOADED, () => reloadProfiles());

    // --- Auto-save DB profile on chat change (named after current chat) ---
    context.eventSource?.on(context.eventTypes?.CHAT_CHANGED, async () => {
        // Observability: capture the transition BEFORE any reload runs. `_lastChatId` is the chat
        // we are leaving; getCurrentChatId() is the one we just entered. Logging only — these reads
        // never influence profile resolution / rehydrate / snapshot.
        const fromChatId = _lastChatId;
        const toChatId = getCurrentChatId();

        // chat.disconnect: what was active on the chat we are LEAVING (active profile at the moment
        // of exit). Skipped on the very first switch (no prior chat) to avoid a noise line.
        if (fromChatId && fromChatId !== toChatId) {
            addDebugLog('info', `Leaving chat ${fromChatId} (active profile "${extensionSettings?.activeDbProfile || ''}")`, {
                subsystem: 'db', event: 'db.disconnect', actor: 'SYSTEM',
                data: {
                    chatId: fromChatId,
                    activeProfile: extensionSettings?.activeDbProfile || null,
                    isBranch: isBranchChat(fromChatId),
                },
            });
        }

        // chat.switch: explicit "left -> entered" transition (info so it shows by default).
        addDebugLog('info', `Chat switch: ${fromChatId || '(none)'} -> ${toChatId || '(none)'}`, {
            subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM',
            data: { from: fromChatId || null, to: toChatId || null, isBranch: isBranchChat(toChatId) },
        });

        // FIX #59: flush the OUTGOING chat's debug-log tail to its own file BEFORE we swap the
        // buffer to the new chat — otherwise the last few (esp. verbose) lines of the chat you're
        // leaving are lost. Targets the tracked old chatId (the live one has already advanced).
        await flushOutgoingChatLog();

        // DATA-SAFETY FIX (coordinated CHAT_CHANGED): flush the durable IDB→attachment snapshot for
        // the OUTGOING character's working store BEFORE autoSaveDbProfile clears/reloads it. This is
        // a SINGLE awaited sequence so the outgoing chat's tail facts are persisted before any clear
        // runs (the prior un-awaited flushSnapshotNow() in pipeline.js raced the clear and could
        // snapshot an already-emptied store / capture the wrong chat's facts). For a same-character
        // chat-switch/branch the live avatar == the outgoing avatar, so flushing the live avatar
        // pins the correct store. reconcileDeletes:FALSE so a transiently-empty working store cannot
        // delete durable backup files — only a USER-destructive op may prune attachments.
        try {
            const { flushSnapshotNow, invalidateDatabaseCache } = await import('./database.js');
            const outgoingAvatar = getContext()?.characters?.[getContext()?.characterId]?.avatar || null;
            await flushSnapshotNow({ avatar: outgoingAvatar, reconcileDeletes: false });
            // Drop the per-turn cache (now partitioned by avatar+chatId) so the autoload + the new
            // chat's first read re-fetch fresh and cannot serve the outgoing chat's cached map.
            invalidateDatabaseCache();
            addDebugLog('debug', `Coordinated flush before autoload (outgoing avatar pinned)`, {
                subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM', reason: 'COORDINATED_FLUSH',
                data: { from: fromChatId || null, to: toChatId || null, avatar: outgoingAvatar || null },
            });
        } catch (e) {
            console.error('[BFMemory] coordinated chat-switch flush failed', e);
        }

        await autoSaveDbProfile();
        // Reload the persistent debug log AND fact panels from the new chat's metadata
        // so each chat shows its own history (not a stale cross-chat snapshot).
        reloadDebugLogFromChat();
        reloadFactsFromChat();
        reloadTokensFromChat();
        reloadSceneFromChat();
        reloadReflectionFromChat();
        reloadPyramidFromChat();
        reloadSheetFromChat();

        // Remember which chat we're now on so the NEXT switch can report an accurate
        // "from -> to". Logging-only state; never read by storage/profile logic.
        _lastChatId = toChatId;
    });

    // Seed the switch tracker with the chat present at init, so the first real switch reports a
    // correct "from". Logging-only.
    _lastChatId = getCurrentChatId();

    // Initial load: pull any previously-persisted log entries + facts for the current chat
    reloadDebugLogFromChat();
    reloadFactsFromChat();
    reloadTokensFromChat();
    reloadSceneFromChat();
    reloadReflectionFromChat();
    reloadPyramidFromChat();
    reloadSheetFromChat();

    // Save to active profile on page close/refresh
    window.addEventListener('beforeunload', () => {
        // Synchronous best-effort save to settings (no async file ops)
        const profileName = extensionSettings?.activeDbProfile;
        if (profileName && extensionSettings?.dbProfiles?.[profileName]) {
            // Can't do async here, but saveSettings is synchronous (debounced flush)
            saveSettings();
        }
        // FIX #8: guarantee the debug log reaches disk before reload. saveMetadata()
        // is debounced, so a synchronous immediate chat save here is the primary fix —
        // reload is exactly when the buffered entries would otherwise be lost.
        flushDebugLogNow();
        // HYBRID PERSISTENCE: best-effort flush of the durable IDB→attachment snapshot so the
        // newest facts reach the backend before reload. beforeunload can't reliably AWAIT the
        // async upload, so the throttled cadence (every ~15s) remains the real guarantee; this
        // is a final nudge. Fire-and-forget + self-guarded (never throws). Imported lazily to
        // avoid a static settings.js→database.js cycle. reconcileDeletes:FALSE — a non-user
        // teardown flush must never DELETE durable backup files (only a USER clear/delete prunes).
        import('./database.js').then(m => m.flushSnapshotNow?.({ reconcileDeletes: false })).catch(() => {});
    });

    // Note: removed MESSAGE_RECEIVED → saveCurrentToActiveProfile() handler.
    // pipeline.js now persists via saveCurrentToActiveProfile(capturedDbProfile)
    // after every Agent 3 write, with capture-at-write semantics. The old
    // unprotected handler here was a residual leak path (same class as Issue #2).

    // --- Initial state ---
    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
