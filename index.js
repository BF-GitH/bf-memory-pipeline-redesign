// BF's Memory Pipeline - Main Entry Point
// 3-agent memory system: Draft -> Retrieve -> Write -> Update

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

        // Register the Writer recall tool (search_memory) when its setting is on.
        // Default-ON since the tool-first flip; idempotent; no-ops if ST's function-tool
        // API is unavailable. Also sync the Writer WRITE tool (remember_fact) the same way.
        const { syncWriterRecallTool, syncWriterWriteTool } = await import('./src/agent-writer.js');
        syncWriterRecallTool();
        syncWriterWriteTool();

        console.log('[BFMemory] Extension loaded successfully');
    } catch (error) {
        console.error('[BFMemory] Failed to load extension:', error);
    }
});
