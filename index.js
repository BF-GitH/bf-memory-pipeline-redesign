// BF's Memory Pipeline - Main Entry Point
// redesign-v2: pure-code memory-sheet injection + background Memory Agent

export const extension_name = 'bf-memory-pipeline';

jQuery(async () => {
    try {
        const { initSettings } = await import('./src/settings.js');
        await initSettings();

        const { initPipeline } = await import('./src/pipeline.js');
        initPipeline();

        const { initMessageIcons } = await import('./src/message-icon.js');
        initMessageIcons();

        // Slash commands (/bfmem …) + the {{bf_facts}} macro. Was never wired before
        // v0.50.2 — the whole module was dead code (audit F-ORCH-1).
        const { initCommands } = await import('./src/commands.js');
        initCommands();

        // redesign-v2 (S1): the writer-side function tools (search_memory / remember_fact)
        // were REMOVED — the main writer model never uses tools anymore. Memory reaches it
        // exclusively through the pure-code memory-sheet injection (pipeline.js).

        console.log('[BFMemory] Extension loaded successfully');
    } catch (error) {
        console.error('[BFMemory] Failed to load extension:', error);
    }
});
