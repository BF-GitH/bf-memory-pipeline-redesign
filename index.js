
jQuery(async () => {
    try {
        const { initSettings } = await import('./src/settings.js');
        await initSettings();

        const { initPipeline } = await import('./src/pipeline.js');
        initPipeline();

        const { initMessageIcons } = await import('./src/message-icon.js');
        initMessageIcons();

        const { initCommands } = await import('./src/commands.js');
        initCommands();

        console.log('[BFMemory] Extension loaded successfully');
    } catch (error) {
        console.error('[BFMemory] Failed to load extension:', error);
    }
});
