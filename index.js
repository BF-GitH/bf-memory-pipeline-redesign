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

        // Register the optional Writer recall tool (search_memory) when its setting is on.
        // Default-OFF; idempotent; no-ops if ST's function-tool API is unavailable.
        // Also sync the optional Writer WRITE tool (remember_fact) the same way. Default-OFF;
        // idempotent; no-ops if ST's function-tool API is unavailable.
        const { syncWriterRecallTool, syncWriterWriteTool } = await import('./src/agent-writer.js');
        syncWriterRecallTool();
        syncWriterWriteTool();

        console.log('[BFMemory] Extension loaded successfully');
    } catch (error) {
        console.error('[BFMemory] Failed to load extension:', error);
    }
});
