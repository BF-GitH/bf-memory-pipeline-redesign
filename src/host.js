function rawCtx() {
    try {
        return (typeof SillyTavern !== 'undefined' && SillyTavern && typeof SillyTavern.getContext === 'function')
            ? SillyTavern.getContext()
            : null;
    } catch {
        return null;
    }
}

let warnedMissingHost = false;

export function getCtx() {
    const ctx = rawCtx();
    if (!ctx && !warnedMissingHost) {
        warnedMissingHost = true;
        try { console.warn('[BFMemory] SillyTavern host context unavailable — host adapter returning null.'); } catch {  }
    }
    return ctx;
}

export function getChat() {
    return rawCtx()?.chat ?? null;
}

export function getCurrentCharacterName() {
    const ctx = rawCtx();
    return ctx?.characters?.[ctx.characterId]?.name || '';
}

export function getUserPersonaName() {
    return rawCtx()?.name1 || '';
}

const EXTENSION_SETTINGS_KEY = (() => {
    try {
        const parts = new URL(import.meta.url).pathname.split('/');
        const srcIdx = parts.lastIndexOf('src');
        if (srcIdx > 0) return parts[srcIdx - 1];
    } catch {  }
    return 'bf-memory-pipeline';
})();

export function getExtensionSettings() {
    try {
        return rawCtx()?.extensionSettings?.[EXTENSION_SETTINGS_KEY] ?? null;
    } catch {
        return null;
    }
}

export function getSubstituteParams() {
    const ctx = rawCtx();
    return ctx?.substituteParams || ctx?.substituteParamsExtended || (s => s);
}

export async function getTokenCount(text) {
    const ctx = rawCtx();
    return await (ctx?.getTokenCountAsync?.(text) ?? 0);
}

export function getCMRS() {
    return rawCtx()?.ConnectionManagerRequestService || null;
}

export function getRequestHeaders() {
    const ctx = rawCtx();
    return ctx?.getRequestHeaders?.() ?? null;
}
