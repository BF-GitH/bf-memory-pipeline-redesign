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
 * Heuristic: is the given connection profile (or the active one) a Claude/Anthropic profile?
 * The tool-first defaults (hybrid recall + the search_memory/remember_fact tools) are tuned for a
 * tool-calling model like Claude via the Claude Code CLI profile. ST stores the chat-completion
 * source / model under different keys across versions, so we scan the profile's own string fields
 * case-insensitively for "claude" / "anthropic" rather than depend on one schema key.
 * @param {object} [profile] - a connection profile object; defaults to the active profile
 * @returns {boolean}
 */
export function isClaudeProfile(profile) {
    try {
        let p = profile;
        if (!p) {
            const id = getCurrentProfileId();
            p = getConnectionProfiles().find(x => x && x.id === id) || null;
        }
        if (!p || typeof p !== 'object') return false;
        const marker = /claude|anthropic/i;
        // Scan top-level string values AND one level of nested objects (ST stores the model/source
        // under different keys across versions, sometimes nested e.g. profile.settings.model). Depth
        // is capped at 1 to avoid cycles/cost; that covers every known profile shape.
        for (const v of Object.values(p)) {
            if (typeof v === 'string') { if (marker.test(v)) return true; }
            else if (v && typeof v === 'object' && !Array.isArray(v)) {
                for (const nv of Object.values(v)) {
                    if (typeof nv === 'string' && marker.test(nv)) return true;
                }
            }
        }
        return false;
    } catch { return false; }
}

/**
 * Profile-aware defaults (tool-first redesign), log-only. We DON'T override the user's explicit
 * choices — auto-rewriting settings on profile detection would be surprising. Instead we surface a
 * one-line Debug confirmation of whether the ACTIVE profile is the tuned (Claude/Anthropic) path,
 * so a user on a non-tool-calling profile can see WHY hybrid recall isn't firing (the tools only
 * activate on a tool-calling main model). Returns the detection result for callers that want it.
 * @param {object} settings
 * @returns {{isClaude: boolean, profileId: string|null}}
 */
export function detectProfileForToolFirst(settings) {
    const profileId = getCurrentProfileId();
    const isClaude = isClaudeProfile();
    const mode = settings?.memoryMode || 'hybrid';
    if (isClaude) {
        addDebugLog('info', `Active connection profile looks like Claude/Anthropic — tool-first memory (mode="${mode}", search_memory/remember_fact) is the tuned path here`, {
            subsystem: 'settings', event: 'profile.detected', data: { profileId, isClaude: true, memoryMode: mode },
        });
    } else if (mode !== 'push') {
        addDebugLog('info', `Memory mode "${mode}" relies on the main model calling tools; the active profile isn't recognized as a known tool-calling (Claude) profile — if recall isn't firing, the model may not support tools (switch Recall strategy to "Push").`, {
            subsystem: 'settings', event: 'profile.detected', data: { profileId, isClaude: false, memoryMode: mode },
        });
    }
    return { isClaude, profileId };
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
