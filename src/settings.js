import { explainFactRetrieval } from './fact-retrieval.js';

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
    reloadReflectionFromChat,
    reloadPyramidFromChat,
    reloadSheetFromChat,
    reloadStorySpineFromChat,
    reloadSceneFromChat,
} from './turn-state.js';
import {
    refreshDatabaseView, showSpiderwebPopup,
} from './db-panel.js';
import { DEFAULT_MEMORY_AGENT_PROMPT } from './agent-memory.js';
import { DEFAULT_REFLECT_PROMPT } from './agent-reflect.js';

export {
    beginRun, endRun, setPendingRun, getPendingRun, consumePendingRun,
    addDebugLog,
} from './debug-log.js';
export {
    setLastGenerated, setLastInserted,
    setRunTokens, addAgent3Tokens, addReflectionTokens, setMainOutputTokens,
    getReflection, setReflection,
    getSummaryPyramid, setSummaryPyramid,
    getMemorySheet, setMemorySheet,
    getStorySpine, appendStorySpineBatch, setStorySpine,
    getCurrentScene, getClosedScenes, startScene, appendSceneBeats, setSceneStore,
} from './turn-state.js';

const EXTENSION_NAME = (() => {
    try {
        const url = new URL(import.meta.url);
        const parts = url.pathname.split('/');
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx > 0) return parts[srcIdx - 1];
    } catch {  }
    return 'bf-memory-pipeline';
})();

let extensionSettings = null;

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

const DEFAULT_SETTINGS = {
    enabled: false,

    agent3Profile: '',

    memoryPrompt: '',

    memoryAgentPrompt: '',
    reflectionPrompt: '',

    agent2ContextMessages: 10,

    bufferHoldBack: 4,

    spineBatchSize: 10,

    enforceKnownBy: true,

    graphExtrasCount: 3,

    catchupBatchSize: 8,
    showToast: true,
    debugMode: false,

    debugVerbose: false,

    dbProfiles: {},
    activeDbProfile: '',

    unlinkedChats: [],

    taxonomyOverlay: { categories: [], aspects: {}, subAreas: {} },

};

export function getSettings() {
    return extensionSettings;
}

export function setPipelineEnabled(next) {
    next = !!next;
    if (!extensionSettings) return next;
    if (next !== extensionSettings.enabled) {
        addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} via slash command`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled', via: 'slash' }, before: !!extensionSettings.enabled, after: next });
    }
    extensionSettings.enabled = next;
    saveSettings();
    try { $('#bf_mem_enabled').prop('checked', next); } catch {  }
    try { updateStatus('idle'); } catch {  }
    if (!next) {
        import('./pipeline.js').then(({ cancelActiveRun }) => cancelActiveRun?.('disabled')).catch(() => {});
    }
    return next;
}

function saveSettings() {
    const context = getContext();
    context.extensionSettings[EXTENSION_NAME] = extensionSettings;
    context.saveSettingsDebounced();
}

function clamp(value, lo, hi, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

function validateSettings(s) {
    s.agent2ContextMessages = Math.floor(clamp(s.agent2ContextMessages, 0, 50, 10));
    s.bufferHoldBack = Math.floor(clamp(s.bufferHoldBack, 0, 10, 4));

    if (s.agent2ContextMessages !== 0 && s.bufferHoldBack >= s.agent2ContextMessages) {
        const clamped = Math.max(0, s.agent2ContextMessages - 1);
        addDebugLog('fail', 'bufferHoldBack (' + s.bufferHoldBack + ') >= agent2ContextMessages (' + s.agent2ContextMessages + '); clamped to ' + clamped + ' to prevent a memory gap');
        s.bufferHoldBack = clamped;
    }
    s.spineBatchSize = Math.floor(clamp(s.spineBatchSize, 4, 30, 10));
    s.graphExtrasCount = Math.floor(clamp(s.graphExtrasCount, 0, 8, 3));
    s.catchupBatchSize = Math.floor(clamp(s.catchupBatchSize, 2, 30, 8));
    if (typeof s.enabled !== 'boolean') {

        if (s.enabled) {
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
    if (typeof s.memoryAgentPrompt !== 'string') s.memoryAgentPrompt = '';
    if (typeof s.reflectionPrompt !== 'string')  s.reflectionPrompt = '';
    if (typeof s.activeDbProfile !== 'string')   s.activeDbProfile = '';
    if (!s.dbProfiles || typeof s.dbProfiles !== 'object' || Array.isArray(s.dbProfiles)) {
        s.dbProfiles = {};
    }

    if (!Array.isArray(s.unlinkedChats)) {
        s.unlinkedChats = [];
    } else {
        s.unlinkedChats = s.unlinkedChats.filter(id => typeof id === 'string' && id);
    }

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

    if ((s.schemaVersion ?? 0) >= 3) return;

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

    if (typeof s.memoryProfile === 'string' && s.memoryProfile && !s.agent3Profile) {
        s.agent3Profile = s.memoryProfile;
    }

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

    const existing = await getAllDatabases();
    for (const category of Object.keys(existing)) {
        await deleteDatabase(category);
    }

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

    const currentChatId = getCurrentChatId();
    if (currentChatId) {
        linkChatToProfile(profileName, currentChatId);

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

    let alsoWipe = false;
    if (wasActive && currentChatId && linkedChats.includes(currentChatId)) {
        alsoWipe = confirm(`"${profileName}" is the active profile for THIS chat. Also clear its facts from this chat's working store?\n\nOK = delete profile AND wipe this chat's facts.\nCancel = delete profile only (facts stay in the live store).`);
    }

    delete extensionSettings.dbProfiles[profileName];
    if (wasActive) {
        extensionSettings.activeDbProfile = '';
        lastAutoLoadedChat = '';
    }

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

let lastAutoLoadedChat = '';

let _lastChatId = '';

function getCurrentChatLabel() {
    const context = getContext();
    const charName = context.characters?.[context.characterId]?.name || '';
    const chatId = getCurrentChatId();

    return charName || chatId || '';
}

function findProfileForChat(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    for (const [name, profile] of Object.entries(extensionSettings.dbProfiles)) {
        if ((profile.linkedChats || []).includes(chatId)) return name;
    }
    return null;
}

function parentChatIdOfBranch(chatId) {
    if (typeof chatId !== 'string') return chatId;

    let id = chatId;
    let prev;
    do {
        prev = id;
        id = id.replace(/\s*-\s*Branch\s*#\s*\d+\s*$/i, '');
    } while (id !== prev);
    return id;
}

function resolveBranchParentProfile(chatId) {
    if (!chatId || !extensionSettings?.dbProfiles) return null;
    const parentId = parentChatIdOfBranch(chatId);
    if (parentId && parentId !== chatId) {
        const byParent = findProfileForChat(parentId);
        if (byParent) return byParent;
    }

    const charName = getContext()?.characters?.[getContext()?.characterId]?.name || '';
    if (charName && extensionSettings.dbProfiles[charName]) return charName;
    return null;
}

function linkChatToProfile(profileName, chatId) {
    if (!profileName || !chatId) return;
    const profile = extensionSettings?.dbProfiles?.[profileName];
    if (!profile) return;

    if (!profile.linkedChats) profile.linkedChats = [];

    for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
        if (name !== profileName && p.linkedChats) {
            p.linkedChats = p.linkedChats.filter(id => id !== chatId);
        }
    }

    if (!profile.linkedChats.includes(chatId)) {
        profile.linkedChats.push(chatId);
    }

    clearChatUnlinked(chatId);
    saveSettings();
}

async function ensureActiveProfileForCurrentChat() {
    try {
        const chatId = getCurrentChatId();
        if (!chatId) return null;

        const active = extensionSettings?.activeDbProfile;
        if (active && extensionSettings?.dbProfiles?.[active]) {

            if (!(extensionSettings.dbProfiles[active].linkedChats || []).includes(chatId) && !isChatUnlinked(chatId)) {
                linkChatToProfile(active, chatId);
            }
            return active;
        }

        if (isChatUnlinked(chatId)) return null;

        if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
        const isBranch = isBranchChat(chatId);
        let resolved = null;
        let how = 'none';

        resolved = findProfileForChat(chatId);
        if (resolved) how = 'linked';

        if (!resolved && isBranch) {
            const parentProfile = resolveBranchParentProfile(chatId);
            if (parentProfile) { resolved = parentProfile; how = 'inherited-branch'; }
        }

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

        linkChatToProfile(resolved, chatId);
        extensionSettings.activeDbProfile = resolved;

        lastAutoLoadedChat = chatId;
        saveSettings();
        try { refreshDbProfileDropdown(); refreshLinkedChatsField(); } catch {  }
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

    if (!profileName && !profileKey) {
        profileName = await ensureActiveProfileForCurrentChat();
    }
    if (!profileName) return;

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

        const databases = {};
        for (const [cat, sdb] of Object.entries(databasesRaw || {})) {
            const facts = Array.isArray(sdb?.facts) ? sdb.facts.filter(f => !(f && f.__sharedOrigin)) : [];
            databases[cat] = sdb ? { ...sdb, facts } : { category: cat, facts };
        }
        const totalFacts = Object.values(databases).reduce((sum, db) => sum + db.facts.length, 0);

        if (totalFacts === 0 && !allowEmpty) return;

        // Feature 4: the story spine + scene card travel WITH the DB profile, so a
        // new chat later pointed at this DB shows the story-so-far and current scene
        // instead of starting blank. Snapshot them from the current chat's metadata.
        const { getStorySpine, getCurrentScene, getClosedScenes, getSceneTimeline } = await import('./turn-state.js');
        const storySpine = JSON.parse(JSON.stringify(getStorySpine() || []));
        const sceneStore = JSON.parse(JSON.stringify({ current: getCurrentScene() || null, closed: getClosedScenes() || [], timeline: getSceneTimeline() || '' }));

        extensionSettings.dbProfiles[profileName] = {
            ...extensionSettings.dbProfiles[profileName],
            databases: JSON.parse(JSON.stringify(databases)),
            storySpine,
            sceneStore,
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

function pruneActiveProfile(category = null) {
    const profiles = extensionSettings?.dbProfiles;
    if (!profiles || typeof profiles !== 'object') return { profilesPruned: [], factsPruned: 0 };

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

function markChatUnlinked(chatId) {
    if (!chatId) return;
    if (!Array.isArray(extensionSettings.unlinkedChats)) extensionSettings.unlinkedChats = [];
    if (!extensionSettings.unlinkedChats.includes(chatId)) {
        extensionSettings.unlinkedChats.push(chatId);
        saveSettings();
    }
}

function clearChatUnlinked(chatId) {
    if (!chatId || !Array.isArray(extensionSettings.unlinkedChats)) return;
    const before = extensionSettings.unlinkedChats.length;
    extensionSettings.unlinkedChats = extensionSettings.unlinkedChats.filter(id => id !== chatId);
    if (extensionSettings.unlinkedChats.length !== before) saveSettings();
}

function isChatUnlinked(chatId) {
    return !!chatId && Array.isArray(extensionSettings?.unlinkedChats) && extensionSettings.unlinkedChats.includes(chatId);
}

function detachCurrentChatIfNeeded(unlinkedChatId, profileName) {
    const currentChatId = getCurrentChatId();
    if (!unlinkedChatId || unlinkedChatId !== currentChatId) return;

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

export function isTriviallyEmptyForExtraction(mes) {
    const raw = String(mes ?? '');

    const visible = raw.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (visible.length === 0) return true;
    if (visible.length < 15) return true;

    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
        const allOoc = lines.every(l =>
            /^\(\(.*\)\)$/.test(l) || /^ooc\b/i.test(l) || /^\[ooc/i.test(l));
        if (allOoc) return true;
    }
    return false;
}

async function autoSaveDbProfile() {
    try {
        const chatId = getCurrentChatId();
        const chatLabel = getCurrentChatLabel();

        if (!chatId) return;
        if (chatId === lastAutoLoadedChat) return; 

        const isBranch = isBranchChat(chatId);
        let linkState = 'none';

        let profileToLoad = findProfileForChat(chatId);
        if (profileToLoad) linkState = 'linked';

        if (!profileToLoad && isChatUnlinked(chatId)) {

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
            } catch {  }
            lastAutoLoadedChat = chatId;
            return;
        }

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

        if (!profileToLoad && chatLabel) {

            if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
            if (!extensionSettings.dbProfiles[chatLabel]) {

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

                linkChatToProfile(chatLabel, chatId);

                linkState = 'linked';
            }
            profileToLoad = chatLabel;
        }

        if (profileToLoad && extensionSettings.dbProfiles?.[profileToLoad]) {
            const profile = extensionSettings.dbProfiles[profileToLoad];
            const { getAllDatabases, deleteDatabase, saveDatabase } = await import('./database.js');

            const profileFactCount = Object.values(profile.databases || {})
                .reduce((n, db) => n + ((db && Array.isArray(db.facts)) ? db.facts.length : 0), 0);

            if (profileFactCount === 0) {

                const live = await getAllDatabases();
                const liveFacts = Object.values(live || {})
                    .reduce((n, db) => n + ((db?.facts || []).length), 0);
                addDebugLog('info', `Auto-load SKIPPED clear: profile "${profileToLoad}" has 0 facts — kept live store (${liveFacts} facts)`, {
                    subsystem: 'db', event: 'db.connect', actor: 'SYSTEM', reason: 'NON_DESTRUCTIVE_EMPTY_PROFILE',
                    data: { chatId, resolvedProfile: profileToLoad, decision: 'KEEP_LIVE_STORE', profileFactCount, liveFacts, isBranch },
                });
            } else {

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

            // Feature 4: restore the profile's saved story spine + scene card onto this
            // chat so composeSheet renders "Story so far:" / "Scene:" immediately instead
            // of blank. Sync the in-memory caches from THIS chat's metadata first, then
            // only restore when the chat hasn't advanced its own spine/scene yet (never
            // clobber a chat that already has one). A branch inherits the parent profile,
            // so this seamlessly carries the parent's spine/scene without double-applying.
            try {
                reloadStorySpineFromChat();
                reloadSceneFromChat();
                const { getStorySpine, setStorySpine, getCurrentScene, getClosedScenes, setSceneStore } = await import('./turn-state.js');

                const savedSpine = Array.isArray(profile.storySpine) ? profile.storySpine : null;
                if (savedSpine && savedSpine.length > 0 && getStorySpine().length === 0) {
                    setStorySpine(savedSpine);
                }

                const savedScene = (profile.sceneStore && typeof profile.sceneStore === 'object') ? profile.sceneStore : null;
                const chatHasScene = !!getCurrentScene() || getClosedScenes().length > 0;
                if (savedScene && !chatHasScene) {
                    setSceneStore(savedScene);
                }

                reloadSheetFromChat();
            } catch (e) {
                addDebugLog('fail', `Feature 4 spine/scene restore failed (non-fatal): ${e?.message || e}`);
            }

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
            } catch {  }
        } else {

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

const NEW_EMPTY_DB_CHOICE = '__bf_new_empty_db__';

function uniqueEmptyDbName() {
    const base = getCurrentChatLabel() || 'New DB';
    const profiles = extensionSettings?.dbProfiles || {};
    if (!profiles[base]) return base;
    let i = 2;
    while (profiles[`${base} ${i}`]) i++;
    return `${base} ${i}`;
}

async function createEmptyDbForNewChat(chatId) {
    const { buildSkeletonDatabases, getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
    const name = uniqueEmptyDbName();
    // wipe the live working store so the new DB genuinely starts empty (same shape as the New-empty path)
    cancelPendingSnapshot();
    const existing = await getAllDatabases();
    for (const category of Object.keys(existing)) await deleteDatabase(category);
    await flushSnapshotNow();
    if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
    extensionSettings.dbProfiles[name] = {
        databases: buildSkeletonDatabases(),
        savedAt: Date.now(),
        linkedChats: [],
    };
    addDebugLog('info', `New empty DB profile created for new chat: "${name}" (chat ${chatId})`, {
        subsystem: 'db', event: 'profile.saved', actor: 'USER', reason: 'NEW_EMPTY',
        data: { profileName: name, linkedChat: chatId || null },
    });
    return name;
}

// Feature 3: on a genuinely new chat, let the user pick which DB profile it uses.
// Returns true if a selection was applied (caller must then SKIP autoSaveDbProfile so it
// does not auto-create/clobber), false if dismissed (caller falls back to auto behavior).
async function promptNewChatDbChoice(toChatId) {
    await ensurePopup();
    if (!Popup) return false;

    const profiles = extensionSettings?.dbProfiles || {};

    const container = document.createElement('div');
    container.className = 'bf-mem-newchat-db-popup';
    const heading = document.createElement('h4');
    heading.textContent = 'Choose a memory database for this new chat';
    const desc = document.createElement('p');
    desc.textContent = 'Pick an existing database to load, or start a fresh empty one. Cancel to keep the default automatic behavior.';
    const select = document.createElement('select');
    select.className = 'text_pole';
    // populate exactly like refreshDbProfileDropdown, plus a New-empty option
    for (const [name, profile] of Object.entries(profiles)) {
        const option = document.createElement('option');
        option.value = name;
        const factCount = Object.values(profile.databases || {}).reduce((sum, db) => sum + (db.facts?.length || 0), 0);
        const dbCount = Object.keys(profile.databases || {}).length;
        const linkCount = (profile.linkedChats || []).length;
        option.textContent = `${name} (${dbCount} dbs, ${factCount} facts${linkCount ? `, ${linkCount} chats` : ''})`;
        select.appendChild(option);
    }
    const newOption = document.createElement('option');
    newOption.value = NEW_EMPTY_DB_CHOICE;
    newOption.textContent = '+ New empty DB';
    select.appendChild(newOption);

    container.appendChild(heading);
    container.appendChild(desc);
    container.appendChild(select);

    const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', { allowVerticalScrolling: true, okButton: 'Use selected DB' });
    const result = await popup.show();
    if (!result) return false;

    const choice = select.value;
    try {
        let profileName;
        if (choice === NEW_EMPTY_DB_CHOICE) {
            profileName = await createEmptyDbForNewChat(toChatId);
        } else {
            profileName = choice;
            await loadDbProfile(profileName);
        }
        if (!profileName) return false;

        linkChatToProfile(profileName, toChatId);
        extensionSettings.activeDbProfile = profileName;
        lastAutoLoadedChat = toChatId;
        saveSettings();
        refreshDbProfileDropdown();
        refreshLinkedChatsField();
        refreshDatabaseView();
        addDebugLog('info', `New chat ${toChatId} bound to DB profile "${profileName}" via picker`, {
            subsystem: 'db', event: 'db.connect', actor: 'USER', reason: 'NEW_CHAT_PICKER',
            data: { chatId: toChatId, resolvedProfile: profileName, newEmpty: choice === NEW_EMPTY_DB_CHOICE },
        });

        // Feature 4: the picker path skips autoSaveDbProfile, so restore the chosen
        // profile's saved story spine + scene card onto this new (empty) chat here,
        // matching autoSaveDbProfile's restore, so they render immediately not blank.
        try {
            reloadStorySpineFromChat();
            reloadSceneFromChat();
            const prof = extensionSettings.dbProfiles?.[profileName] || {};
            const { getStorySpine, setStorySpine, getCurrentScene, getClosedScenes, setSceneStore } = await import('./turn-state.js');
            const savedSpine = Array.isArray(prof.storySpine) ? prof.storySpine : null;
            if (savedSpine && savedSpine.length > 0 && getStorySpine().length === 0) setStorySpine(savedSpine);
            const savedScene = (prof.sceneStore && typeof prof.sceneStore === 'object') ? prof.sceneStore : null;
            if (savedScene && !(getCurrentScene() || getClosedScenes().length > 0)) setSceneStore(savedScene);
            reloadSheetFromChat();
        } catch (e) {
            addDebugLog('fail', `New-chat picker spine/scene restore failed (non-fatal): ${e?.message || e}`);
        }

        return true;
    } catch (err) {
        addDebugLog('fail', `New-chat DB picker failed: ${err?.message || err}`, {
            subsystem: 'db', event: 'db.connect', actor: 'USER', reason: 'NEW_CHAT_PICKER',
        });
        return false;
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

        for (const [name, p] of Object.entries(extensionSettings.dbProfiles)) {
            if (name !== profileName && p.linkedChats) {
                p.linkedChats = p.linkedChats.filter(id => id !== chatId);
            }
        }
        profile.linkedChats.push(chatId);

        clearChatUnlinked(chatId);
        extensionSettings.activeDbProfile = profileName;
        lastAutoLoadedChat = '';
        saveSettings();
        refreshLinkedChatsField();
        refreshDbProfileDropdown();
        toastr.success(`Linked current chat to "${profileName}"`, 'BF Memory');

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

export async function initSettings() {
    const context = getContext();

    if (!context.extensionSettings) context.extensionSettings = {};
    let resetClobberedEnabled = false; 
    let freshInstall = false; 
    try {
        const current = context.extensionSettings[EXTENSION_NAME];
        if (!current || typeof current !== 'object' || Array.isArray(current)) {

            if (current == null) freshInstall = true;
            if (current && typeof current === 'object' && current.enabled === true) resetClobberedEnabled = true;
            context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        }
    } catch (err) {
        console.error('[BFMemory] corrupt settings, resetting:', err);
        try { if (context.extensionSettings?.[EXTENSION_NAME]?.enabled === true) resetClobberedEnabled = true; } catch {  }
        context.extensionSettings[EXTENSION_NAME] = structuredClone(DEFAULT_SETTINGS);
        if (typeof toastr !== 'undefined') {
            toastr.warning('BF Memory settings were corrupt and have been reset.');
        }
    }
    extensionSettings = context.extensionSettings[EXTENSION_NAME];

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings, key)) {
            extensionSettings[key] = value;
        }
    }

    migrateLegacySettings(extensionSettings);

    validateSettings(extensionSettings);

    if (resetClobberedEnabled && !extensionSettings.enabled) {
        addDebugLog('fail', 'Pipeline DISABLED by corrupt-settings reset (was enabled before reset)');
    }

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

    try {
        const manifest = await $.getJSON(`${path}/manifest.json`);
        if (manifest?.version) {
            $('#bf_mem_version').text(`v${manifest.version}`);
        }
    } catch (err) {
        console.warn('[BFMemory] Could not load manifest for version label:', err?.message);
    }

    setupTabs();

    if (freshInstall && typeof toastr !== 'undefined') {
        try {
            toastr.info(
                'Tick Enable, then pick a memory model for the background Memory Agent (a cheap one is fine).',
                'BF Memory — quick start',
                { timeOut: 12000, extendedTimeOut: 6000 },
            );
        } catch {  }
        addDebugLog('info', 'First-run install detected (disabled until user enables)', {
            subsystem: 'settings', event: 'settings.first_run', actor: 'SYSTEM',
        });
    }

    $('#bf_mem_enabled').prop('checked', extensionSettings.enabled).on('change', function () {
        const next = $(this).prop('checked');

        if (next !== extensionSettings.enabled) {
            addDebugLog('info', `Pipeline ${next ? 'ENABLED' : 'DISABLED'} by user`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enabled' }, before: !!extensionSettings.enabled, after: !!next });
        }
        extensionSettings.enabled = next;
        updateStatus('idle');
        saveSettings();

        if (!next) {
            import('./pipeline.js')
                .then(({ cancelActiveRun }) => cancelActiveRun?.('disabled'))
                .catch(() => {  });
        }
    });

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

    $('#bf_mem_agent2_context').val(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context_val').text(extensionSettings.agent2ContextMessages);
    $('#bf_mem_agent2_context').on('input', function () {
        const val = parseInt($(this).val());
        extensionSettings.agent2ContextMessages = val;
        $('#bf_mem_agent2_context_val').text(val);
        saveSettings();
    });

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

    $('#bf_mem_spine_batch').val(extensionSettings.spineBatchSize);
    $('#bf_mem_spine_batch_val').text(extensionSettings.spineBatchSize);
    $('#bf_mem_spine_batch').on('input', function () {
        const val = parseInt($(this).val(), 10);
        const before = extensionSettings.spineBatchSize;
        extensionSettings.spineBatchSize = val;
        $('#bf_mem_spine_batch_val').text(val);
        if (before !== val) addDebugLog('debug', `Story spine batch size: ${before} → ${val}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'spineBatchSize' }, before, after: val });
        saveSettings();
    });

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

    $('#bf_mem_knownby_enforced').prop('checked', extensionSettings.enforceKnownBy !== false).on('change', function () {
        const before = extensionSettings.enforceKnownBy !== false;
        const next = $(this).prop('checked');
        extensionSettings.enforceKnownBy = next;
        addDebugLog('info', `knownBy enforcement ${next ? 'enabled' : 'disabled'}`, { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'enforceKnownBy' }, before, after: !!next });
        saveSettings();
    });

    $('#bf_mem_toast').prop('checked', extensionSettings.showToast).on('change', function () {
        extensionSettings.showToast = $(this).prop('checked');
        saveSettings();
    });

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

    $('#bf_mem_memory_agent_prompt').val(extensionSettings.memoryAgentPrompt || DEFAULT_MEMORY_AGENT_PROMPT).off('input').on('input', function () {
        const v = String($(this).val() || '');
        extensionSettings.memoryAgentPrompt = (!v.trim() || v === DEFAULT_MEMORY_AGENT_PROMPT) ? '' : v;
        saveSettings();
    });

    $('#bf_mem_reset_memory_agent_prompt').on('click', () => {
        $('#bf_mem_memory_agent_prompt').val(DEFAULT_MEMORY_AGENT_PROMPT);
        extensionSettings.memoryAgentPrompt = '';
        addDebugLog('info', 'Memory Agent prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'memoryAgentPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Memory Agent prompt reset to default', 'BF Memory');
    });

    $('#bf_mem_reflect_agent_prompt').val(extensionSettings.reflectionPrompt || DEFAULT_REFLECT_PROMPT).off('input').on('input', function () {
        const v = String($(this).val() || '');
        extensionSettings.reflectionPrompt = (!v.trim() || v === DEFAULT_REFLECT_PROMPT) ? '' : v;
        saveSettings();
    });

    $('#bf_mem_reset_reflect_agent_prompt').on('click', () => {
        $('#bf_mem_reflect_agent_prompt').val(DEFAULT_REFLECT_PROMPT);
        extensionSettings.reflectionPrompt = '';
        addDebugLog('info', 'Reflect Agent prompt reset to default', { subsystem: 'settings', event: 'settings.changed', actor: 'USER', data: { key: 'reflectionPrompt', isDefault: true } });
        saveSettings();
        toastr.info('Reflect Agent prompt reset to default', 'BF Memory');
    });

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

    $('#bf_mem_db_profile_new').on('click', async () => {
        const name = prompt('Name for the new (empty) memory database:');
        if (!name || !name.trim()) return;
        const cleanName = name.trim();
        if (extensionSettings.dbProfiles?.[cleanName]) {
            toastr.warning(`Profile "${cleanName}" already exists — pick another name`, 'BF Memory');
            return;
        }
        if (!confirm(`Create empty database "${cleanName}" and switch this chat to it?\n\nThis clears the current live facts from the working store (use "Save" / "Save As New" first if you want to keep them).`)) return;
        try {
            const { buildSkeletonDatabases, getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
            // wipe the live working store so the new DB genuinely starts empty
            cancelPendingSnapshot();
            const existing = await getAllDatabases();
            for (const category of Object.keys(existing)) await deleteDatabase(category);
            await flushSnapshotNow();
            // create the empty profile (same shape as the auto-create path)
            if (!extensionSettings.dbProfiles) extensionSettings.dbProfiles = {};
            extensionSettings.dbProfiles[cleanName] = {
                databases: buildSkeletonDatabases(),
                savedAt: Date.now(),
                linkedChats: [],
            };
            extensionSettings.activeDbProfile = cleanName;
            // link the current chat so it auto-loads this DB next time
            const currentChatId = getCurrentChatId();
            if (currentChatId) {
                linkChatToProfile(cleanName, currentChatId);
                lastAutoLoadedChat = currentChatId;
            }
            saveSettings();
            refreshDbProfileDropdown();
            refreshLinkedChatsField();
            refreshDatabaseView();
            toastr.success(`Created empty database "${cleanName}"`, 'BF Memory');
            addDebugLog('info', `New empty DB profile created: "${cleanName}"${currentChatId ? ` + linked to chat ${currentChatId}` : ''}`, {
                subsystem: 'db', event: 'profile.saved', actor: 'USER', reason: 'NEW_EMPTY',
                data: { profileName: cleanName, linkedChat: currentChatId || null },
            });
        } catch (err) {
            addDebugLog('fail', `New DB profile failed: ${err?.message || err}`, { subsystem: 'settings', event: 'profile.save', actor: 'USER' });
            toastr.error('Failed to create database', 'BF Memory');
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

    refreshLinkedChatsField();
    $('#bf_mem_db_profile_select').on('change', () => refreshLinkedChatsField());
    $('#bf_mem_db_linked_manage').on('click', () => showLinkedChatsPopup());

    $('#bf_mem_refresh_db').on('click', () => refreshDatabaseView());
    $('#bf_mem_view_web').on('click', () => showSpiderwebPopup());

    $('#bf_mem_db_unlink_current').on('click', () => unlinkCurrentChat());

    $('#bf_mem_clear_db').on('click', async () => {
        if (!confirm('Reset memory to EMPTY for this character? This wipes every stored fact across all storage layers. This cannot be undone.')) return;
        const { getAllDatabases, deleteDatabase, flushSnapshotNow, cancelPendingSnapshot } = await import('./database.js');
        const dbs = await getAllDatabases();
        const clearedCats = Object.keys(dbs);
        const clearedFacts = Object.values(dbs).reduce((s, db) => s + (db.facts?.length || 0), 0);

        cancelPendingSnapshot();

        for (const category of clearedCats) {
            await deleteDatabase(category);
        }

        const { profilesPruned, factsPruned } = pruneActiveProfile(null);

        await saveCurrentToActiveProfile(null, { allowEmpty: true });

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

            $('#bf_mem_catchup_cancel').prop('disabled', true).text('Cancelling (finishing current chunk)…');
        }
    });

    $('#bf_mem_tokens_reset').on('click', () => {

        resetSessionTokens();
    });

    $('#bf_mem_debug').prop('checked', extensionSettings.debugMode).on('change', function () {
        extensionSettings.debugMode = $(this).prop('checked');
        saveSettings();
    });

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

    $(document).on('change', '.bf-mem-log-level', () => renderDebugLog());
    $('#bf_mem_log_subsystem').on('change', () => renderDebugLog());
    $('#bf_mem_log_search').on('input', () => renderDebugLog());

    $('#bf_mem_clear_log').on('click', () => clearDebugLog());

    $('#bf_mem_copy_all').on('click', () => copyDiagnostics());

    $('#bf_mem_export_json').on('click', async () => {
        const json = exportLogsJSON();
        let chatId = 'log';
        try { chatId = String(getContext().chatId ?? 'log'); } catch {  }
        const fname = `bf-mem-log-${chatId}-${Date.now()}.json`;

        try {
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch {  }

        try {
            await navigator.clipboard.writeText(json);
            toastr.success(`Log JSON downloaded + copied (${getDebugLogEntries().length} entries)`, 'BF Memory');
        } catch {
            toastr.success(`Log JSON downloaded (${getDebugLogEntries().length} entries)`, 'BF Memory');
        }
    });

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

            setTimeout(() => { textarea.focus(); textarea.select(); }, 0);
        }
    });

    context.eventSource?.on(context.eventTypes?.CONNECTION_PROFILE_LOADED, () => reloadProfiles());

    context.eventSource?.on(context.eventTypes?.CHAT_CHANGED, async () => {

        const fromChatId = _lastChatId;
        const toChatId = getCurrentChatId();

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

        addDebugLog('info', `Chat switch: ${fromChatId || '(none)'} -> ${toChatId || '(none)'}`, {
            subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM',
            data: { from: fromChatId || null, to: toChatId || null, isBranch: isBranchChat(toChatId) },
        });

        await flushOutgoingChatLog();

        try {
            const { flushSnapshotNow, invalidateDatabaseCache } = await import('./database.js');
            const outgoingAvatar = getContext()?.characters?.[getContext()?.characterId]?.avatar || null;
            await flushSnapshotNow({ avatar: outgoingAvatar, reconcileDeletes: false });

            invalidateDatabaseCache();
            addDebugLog('debug', `Coordinated flush before autoload (outgoing avatar pinned)`, {
                subsystem: 'db', event: 'chat.switch', actor: 'SYSTEM', reason: 'COORDINATED_FLUSH',
                data: { from: fromChatId || null, to: toChatId || null, avatar: outgoingAvatar || null },
            });
        } catch (e) {
            console.error('[BFMemory] coordinated chat-switch flush failed', e);
        }

        // Feature 3: on a genuinely NEW chat (not a branch, not already linked, not explicitly
        // unlinked) let the user choose the DB profile BEFORE autoSaveDbProfile could
        // auto-create/clobber. Branches keep the current auto-inherit behavior.
        let handledByPicker = false;
        if (
            toChatId &&
            fromChatId !== toChatId &&
            toChatId !== lastAutoLoadedChat &&
            !isBranchChat(toChatId) &&
            !isChatUnlinked(toChatId) &&
            findProfileForChat(toChatId) === null
        ) {
            handledByPicker = await promptNewChatDbChoice(toChatId);
        }

        if (!handledByPicker) {
            await autoSaveDbProfile();
        }

        reloadDebugLogFromChat();
        reloadFactsFromChat();
        reloadTokensFromChat();
        reloadReflectionFromChat();
        reloadPyramidFromChat();
        reloadSheetFromChat();
        reloadStorySpineFromChat();
        reloadSceneFromChat();

        refreshDatabaseView();

        _lastChatId = toChatId;
    });

    _lastChatId = getCurrentChatId();

    reloadDebugLogFromChat();
    reloadFactsFromChat();
    reloadTokensFromChat();
    reloadReflectionFromChat();
    reloadPyramidFromChat();
    reloadSheetFromChat();
    reloadStorySpineFromChat();
    reloadSceneFromChat();

    refreshDatabaseView();

    window.addEventListener('beforeunload', () => {

        const profileName = extensionSettings?.activeDbProfile;
        if (profileName && extensionSettings?.dbProfiles?.[profileName]) {

            saveSettings();
        }

        flushDebugLogNow();

        import('./database.js').then(m => m.flushSnapshotNow?.({ reconcileDeletes: false })).catch(() => {});
    });

    updateStatus('idle');

    console.log('[BFMemory] Settings initialized');
}
