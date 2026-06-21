// BF Memory Pipeline - SillyTavern Host Adapter (the "seam")
// =============================================================================
// PURPOSE. This module is the SINGLE chokepoint through which the portable core
// of the extension (database / LLM-call / fact-retrieval / the agent modules)
// reaches into SillyTavern. The engine is only "loosely clipped" to ST: if the
// extension ever moves to a different host, this is the one file that needs a
// new backing implementation — every accessor below maps a host-neutral name
// onto whatever the host's `getContext()`-style surface exposes today.
//
// CONTRACT.
//   * host.js imports NOTHING from the extension. It depends only on the global
//     `SillyTavern` object (and `globalThis`). This keeps it free of import
//     cycles, so any module may STATICALLY `import` it without the lazy
//     dynamic-import dance the core modules use to dodge cycles elsewhere.
//   * Every accessor is null-safe + try/catch, mirroring EXACTLY how the call
//     sites defended before this seam existed (`try { SillyTavern.getContext() }
//     catch {}` and `?.` chains throughout). Each wrapper returns/does precisely
//     what the inline expression it replaced did — same fallbacks, same `??`/`?.`.
//   * Methods that ST exposes on the context object (saveChat, generateQuietPrompt,
//     registerFunctionTool, …) are always invoked AS METHODS of the context
//     (`ctx.foo()`), never detached, to preserve `this`-binding.
//
// This is plumbing, not a feature: it adds NO behavior and NO user-facing logging
// (a single defensive console.warn fires only if the ST global is entirely absent).
// =============================================================================

/** Internal: resolve the raw ST context, null-safe. NEVER throws. */
function rawCtx() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function')
            ? SillyTavern.getContext()
            : null;
    } catch {
        return null;
    }
}

// One-time defensive notice if the host global is missing entirely (never spammy).
let warnedMissingHost = false;
/**
 * The SillyTavern context object, or null if unavailable.
 * Equivalent to the inline `SillyTavern.getContext()` (callers that wrapped it in
 * try/catch get the same null on failure; callers that did NOT wrap it should keep
 * using `getCtx()` and tolerate null exactly as `?.` did before).
 * @returns {object|null}
 */
export function getCtx() {
    const ctx = rawCtx();
    if (!ctx && !warnedMissingHost) {
        warnedMissingHost = true;
        try { console.warn('[BFMemory] SillyTavern host context unavailable — host adapter returning null.'); } catch { /* ignore */ }
    }
    return ctx;
}

// =============================================================================
// STATE / CONTEXT GETTERS
// =============================================================================

/** Current chat message array (`ctx.chat`), or null. */
export function getChat() {
    return rawCtx()?.chat ?? null;
}

/** Current chat id (`ctx.chatId`), or undefined. */
export function getChatId() {
    return rawCtx()?.chatId;
}

/** Per-chat metadata object (`ctx.chatMetadata` / `ctx.chat_metadata`), or null. */
export function getChatMetadata() {
    const ctx = rawCtx();
    return ctx?.chatMetadata ?? ctx?.chat_metadata ?? null;
}

/** The full character list (`ctx.characters`), or null. */
export function getCharacters() {
    return rawCtx()?.characters ?? null;
}

/** The active character index (`ctx.characterId`), or undefined. */
export function getCharacterId() {
    return rawCtx()?.characterId;
}

/**
 * The currently-active character object (`ctx.characters[ctx.characterId]`), or null.
 * @returns {object|null}
 */
export function getCurrentCharacter() {
    const ctx = rawCtx();
    if (!ctx) return null;
    return ctx.characters?.[ctx.characterId] ?? null;
}

/**
 * The active character's name, or '' (mirrors `ctx.characters?.[ctx.characterId]?.name || ''`).
 * @returns {string}
 */
export function getCurrentCharacterName() {
    const ctx = rawCtx();
    return ctx?.characters?.[ctx.characterId]?.name || '';
}

/**
 * The active character's avatar identifier, or null
 * (mirrors `ctx.characters?.[ctx.characterId]?.avatar || null`).
 * @returns {string|null}
 */
export function getCharacterAvatar() {
    const ctx = rawCtx();
    return ctx?.characters?.[ctx.characterId]?.avatar || null;
}

/** The user persona name (`ctx.name1`), or '' (mirrors `ctx.name1 || ''`). */
export function getUserPersonaName() {
    return rawCtx()?.name1 || '';
}

/**
 * This extension's settings bag (`ctx.extensionSettings['bf-memory-pipeline']`), or null.
 * Mirrors the cycle-safe `getSettingsSafe()` pattern duplicated across the agent modules.
 * @returns {object|null}
 */
export function getExtensionSettings() {
    try {
        return rawCtx()?.extensionSettings?.['bf-memory-pipeline'] ?? null;
    } catch {
        return null;
    }
}

/**
 * The raw `ctx.extensionSettings` bag (all extensions), or null. Used by the
 * Data-Bank / attachment persistence which reads & mutates `character_attachments`.
 * @returns {object|null}
 */
export function getExtensionSettingsRoot() {
    return rawCtx()?.extensionSettings ?? null;
}

// =============================================================================
// PROMPT / TOKEN HELPERS
// =============================================================================

/**
 * Resolve ST's macro substituter (`substituteParams` / `substituteParamsExtended`),
 * falling back to identity. Mirrors `ctx.substituteParams || ctx.substituteParamsExtended || (s => s)`.
 * @returns {(s: string) => string}
 */
export function getSubstituteParams() {
    const ctx = rawCtx();
    return ctx?.substituteParams || ctx?.substituteParamsExtended || (s => s);
}

/**
 * Token count for a string via ST's async tokenizer, or 0 when unavailable.
 * Mirrors `await (ctx.getTokenCountAsync?.(text) ?? 0)`.
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function getTokenCount(text) {
    const ctx = rawCtx();
    return await (ctx?.getTokenCountAsync?.(text) ?? 0);
}

// =============================================================================
// LLM TRANSPORT SURFACE (used by llm-call.js)
// =============================================================================

/**
 * ST's ConnectionManagerRequestService, or null. Mirrors the inline
 * `SillyTavern.getContext().ConnectionManagerRequestService || null` (try/catch → null).
 * @returns {object|null}
 */
export function getCMRS() {
    return rawCtx()?.ConnectionManagerRequestService || null;
}

/**
 * ST's request headers for direct proxy fetches, or null.
 * Mirrors `context.getRequestHeaders?.()`.
 * @returns {object|null}
 */
export function getRequestHeaders() {
    const ctx = rawCtx();
    return ctx?.getRequestHeaders?.() ?? null;
}

/**
 * ST's `generateQuietPrompt` fallback generation. Invoked as a method of the
 * context to preserve `this`-binding. Returns the promise ST returns (caller
 * awaits + string-coerces exactly as before). Throws if ST/the method is absent —
 * the single call site is already inside the same try/fallback chain it always was.
 * @param {object} opts
 * @returns {Promise<*>}
 */
export function generateQuietPrompt(opts) {
    const ctx = rawCtx();
    return ctx.generateQuietPrompt(opts);
}

// =============================================================================
// PERSISTENCE
// =============================================================================

/**
 * Persist the current chat NOW. Prefers `saveChat()` and falls back to
 * `saveChatConditional()` when ST only exposes the conditional variant. Both are
 * invoked as methods of the context (preserves `this`). No-op (returns false) when
 * neither exists. Returns the awaited result's truthiness is NOT relied upon by
 * callers — this is fire-and-await.
 * @returns {Promise<boolean>} true if a save method was invoked
 */
export async function saveChatNow() {
    const ctx = rawCtx();
    if (!ctx) return false;
    if (typeof ctx.saveChat === 'function') {
        await ctx.saveChat();
        return true;
    }
    if (typeof ctx.saveChatConditional === 'function') {
        await ctx.saveChatConditional();
        return true;
    }
    return false;
}

/** Debounced chat save (`ctx.saveChatDebounced?.()`). No-op when absent. */
export function saveChatDebounced() {
    rawCtx()?.saveChatDebounced?.();
}

/**
 * Persist per-chat metadata (`ctx.saveMetadata?.()`), invoked as a method.
 * No-op when absent. Returns the awaited result (callers ignore it).
 * @returns {Promise<*>|undefined}
 */
export function saveMetadata() {
    const ctx = rawCtx();
    return ctx?.saveMetadata?.();
}

/**
 * Persist extension settings (debounced), flushing if a `.flush()` is exposed.
 * Mirrors the exact guarded pattern used by the attachment persistence:
 *   if (saveSettingsDebounced) { saveSettingsDebounced(); if (typeof flush==='fn') flush(); }
 * Pass { flush:false } to skip the flush (the lighter `saveSettingsDebounced?.()` call sites).
 * @param {{flush?: boolean}} [opts]
 */
export function saveSettingsDebounced(opts = {}) {
    const ctx = rawCtx();
    const fn = ctx?.saveSettingsDebounced;
    if (typeof fn !== 'function') return;
    fn();
    if (opts.flush !== false && typeof fn.flush === 'function') {
        fn.flush();
    }
}

// =============================================================================
// EVENTS
// =============================================================================

/**
 * The eventType constants the extension actually listens for. Resolved lazily from
 * `ctx.eventTypes` so the values always match the host's own enum; an empty object
 * is returned when the host is unavailable (callers should register inside ST's
 * ready lifecycle, where the context exists).
 * @returns {object} map of EVENT_NAME -> host event-type value
 */
export function getEvents() {
    const et = rawCtx()?.eventTypes ?? {};
    return {
        CHAT_CHANGED: et.CHAT_CHANGED,
        MESSAGE_RECEIVED: et.MESSAGE_RECEIVED,
        MESSAGE_SWIPED: et.MESSAGE_SWIPED,
        MESSAGE_DELETED: et.MESSAGE_DELETED,
        GENERATION_STOPPED: et.GENERATION_STOPPED,
        GENERATE_AFTER_DATA: et.GENERATE_AFTER_DATA,
        CHAT_COMPLETION_PROMPT_READY: et.CHAT_COMPLETION_PROMPT_READY,
    };
}

/**
 * Subscribe to a host event. `type` is a value from getEvents()/ctx.eventTypes.
 * Mirrors `eventSource.on(type, fn)`. Returns true if the listener was attached.
 * @param {string} type
 * @param {Function} fn
 * @returns {boolean}
 */
export function onEvent(type, fn) {
    const es = rawCtx()?.eventSource;
    if (es && typeof es.on === 'function') {
        es.on(type, fn);
        return true;
    }
    return false;
}

// =============================================================================
// MISC HOST SURFACE
// =============================================================================

/**
 * toastr-safe notification. Uses the global `toastr` when present; no-ops otherwise.
 * @param {'info'|'success'|'warning'|'error'} level
 * @param {string} message
 * @param {string} [title]
 * @param {object} [options]
 */
export function toast(level, message, title, options) {
    try {
        const t = (typeof toastr !== 'undefined') ? toastr
            : (typeof globalThis !== 'undefined' ? globalThis.toastr : undefined);
        if (t && typeof t[level] === 'function') {
            t[level](message, title, options);
        }
    } catch { /* notifications must never break the pipeline */ }
}

/**
 * Feature-detect SillyTavern's function-tool registration API. The register/unregister
 * pair lives either directly on the context or under `context.ToolManager` (ST has
 * exposed both shapes across versions). Returns the resolved { register, unregister }
 * (both bound to their owner to preserve `this`), or null when neither exists.
 * @returns {{register: Function, unregister: Function|null}|null}
 */
export function getToolApi() {
    const ctx = rawCtx();
    if (!ctx) return null;
    if (typeof ctx.registerFunctionTool === 'function') {
        return {
            register: ctx.registerFunctionTool.bind(ctx),
            unregister: typeof ctx.unregisterFunctionTool === 'function' ? ctx.unregisterFunctionTool.bind(ctx) : null,
        };
    }
    const tm = ctx.ToolManager;
    if (tm && typeof tm.registerFunctionTool === 'function') {
        return {
            register: tm.registerFunctionTool.bind(tm),
            unregister: typeof tm.unregisterFunctionTool === 'function' ? tm.unregisterFunctionTool.bind(tm) : null,
        };
    }
    return null;
}
