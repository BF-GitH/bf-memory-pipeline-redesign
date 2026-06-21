// BF Memory Pipeline - Profile Module
// Provides memory profile ID for Agent 1 (Drafter) and Agent 3 (Memory Updater).
//
// SAFETY NOTE (v0.2.0): This module NO LONGER switches the active UI profile.
// Previously, runWithMemoryProfile() would swap the DOM profile dropdown during
// CHAT_COMPLETION_PROMPT_READY, which was unsafe because ST was mid-generation.
// Now we pass the profile ID to callAgentLLM(), which uses
// ConnectionManagerRequestService (CMRS) to send requests directly via the
// specified profile without touching the DOM or active connection state.

import { addDebugLog } from './settings.js';

function getContext() {
    return SillyTavern.getContext();
}

function getExtensionSettings() {
    return getContext().extensionSettings;
}

export function getConnectionProfiles() {
    try {
        const profiles = getExtensionSettings()?.connectionManager?.profiles;
        return Array.isArray(profiles) ? profiles : [];
    } catch {
        return [];
    }
}

export function getCurrentProfileId() {
    try {
        return getExtensionSettings()?.connectionManager?.selectedProfile || null;
    } catch {
        return null;
    }
}

/**
 * Get the Agent 1 (Draft Planner) profile ID from settings, or null if not configured.
 * This does NOT switch any profile - just returns the ID for use with CMRS.
 * @param {object} settings - Extension settings
 * @returns {string|null} Profile ID to pass to callAgentLLM, or null to use current
 */
export function getAgent1ProfileId(settings) {
    // Per-agent profiles are ALWAYS active (the useMemoryProfile gate was removed in the
    // v0.21.x menu cleanup). A blank agent1Profile still falls back to the current connection.
    if (!settings?.agent1Profile) return null;

    // Verify the profile still exists
    const profiles = getConnectionProfiles();
    const exists = profiles.some(p => p.id === settings.agent1Profile);
    if (!exists) {
        addDebugLog('fail', `Agent 1 profile "${settings.agent1Profile}" not found in connection manager`);
        return null;
    }

    return settings.agent1Profile;
}

/**
 * Get the embedding profile ID (atomic #1), or null. Prefers a dedicated `embeddingProfile`;
 * otherwise reuses Agent 1's profile so one configured profile suffices. Verifies it still
 * exists. Null → callEmbeddingAPI falls back to the ST proxy routes (or no-ops).
 * @param {object} settings
 * @returns {string|null}
 */
export function getEmbeddingProfileId(settings) {
    const id = settings?.embeddingProfile;
    if (id) {
        const profiles = getConnectionProfiles();
        if (profiles.some(p => p.id === id)) return id;
        addDebugLog('fail', `Embedding profile "${id}" not found in connection manager`);
    }
    return getAgent1ProfileId(settings);
}

/**
 * Get the Agent 3 (Memory Updater) profile ID from settings, or null if not configured.
 * This does NOT switch any profile - just returns the ID for use with CMRS.
 * @param {object} settings - Extension settings
 * @returns {string|null} Profile ID to pass to callAgentLLM, or null to use current
 */
export function getAgent3ProfileId(settings) {
    // Per-agent profiles are ALWAYS active (useMemoryProfile gate removed). Blank => current.
    if (!settings?.agent3Profile) return null;

    // Verify the profile still exists
    const profiles = getConnectionProfiles();
    const exists = profiles.some(p => p.id === settings.agent3Profile);
    if (!exists) {
        addDebugLog('fail', `Agent 3 profile "${settings.agent3Profile}" not found in connection manager`);
        return null;
    }

    return settings.agent3Profile;
}

/**
 * Get the Agent 4 (Fact Finder) profile ID from settings. The finder REUSES Agent 1's
 * connection profile by default (the two-stage-retrieval design); a dedicated
 * `agent4Profile` overrides that when configured. Returns null to use the current
 * connection. Like the others, this does NOT switch any profile.
 * @param {object} settings - Extension settings
 * @returns {string|null} Profile ID to pass to callAgentLLM, or null to use current
 */
export function getAgent4ProfileId(settings) {
    // Per-agent profiles are ALWAYS active (useMemoryProfile gate removed).
    // Dedicated finder profile wins when set and still present.
    const dedicated = settings?.agent4Profile || settings?.finderProfile || '';
    if (dedicated) {
        const exists = getConnectionProfiles().some(p => p.id === dedicated);
        if (exists) return dedicated;
        addDebugLog('fail', `Agent 4 profile "${dedicated}" not found in connection manager — reusing Agent 1's`);
    }
    // Default: reuse Agent 1's profile.
    return getAgent1ProfileId(settings);
}

/**
 * @deprecated Use getAgent1ProfileId() or getAgent3ProfileId() instead.
 * Kept for backward compat. Returns the Agent 1 profile.
 * @param {object} settings - Extension settings
 * @returns {string|null}
 */
export function getMemoryProfileId(settings) {
    return getAgent1ProfileId(settings);
}

/**
 * @deprecated Use getMemoryProfileId() + pass profileId to callAgentLLM() instead.
 * Kept for backward compatibility but now just runs the function directly.
 * No profile switching occurs.
 */
export async function runWithMemoryProfile(fn, settings) {
    addDebugLog('info', '[DEPRECATED] runWithMemoryProfile called - no profile switching performed');
    return await fn();
}
