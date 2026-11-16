// Janitor AI Script Bridge — entry point
//
// Wires the Janitor AI script system into SillyTavern:
//   - globalThis.JaiRunScripts is called by ST's generate interceptor mechanism
//     before every generation (manifest field: generate_interceptor)
//   - restore hooks keep temporary prompt injections single-generation
//   - settings panel, script editor, import, debug viewer
//   - /jai-* slash commands

import { JaiRunScripts, registerInterceptorHooks } from './src/interceptor.js';
import { renderSettingsUI } from './src/ui.js';
import { initScriptsPanel } from './src/panel.js';
import { registerSlashCommands } from './src/commands.js';
import { getSettings, getLastReport } from './src/storage.js';
import { showReportPopup } from './src/report.js';

// Must exist before the first generation — assigned at module load time.
globalThis.JaiRunScripts = JaiRunScripts;

getSettings(); // ensure schema before anything reads it
registerInterceptorHooks();
registerSlashCommands();

// `$` (jQuery) and `toastr` are page-level globals provided by SillyTavern.
jQuery(async () => {
    try {
        await renderSettingsUI();
        await initScriptsPanel();
        console.log('[JaiBridge] UI initialized (panel + options-menu Scripts + wand menu ready).');

        // Wand menu shortcut for the last generation report.
        if ($('#jai-wand-debug').length === 0) {
            const button = $(`
                <div id="jai-wand-debug" class="list-item" tabindex="0" title="Janitor AI Script Bridge — last generation report">
                    <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
                    <span data-i18n="">JAI debug</span>
                </div>
            `);
            button.on('click', () => {
                const report = getLastReport();
                if (!report) {
                    toastr.info('No generation has run yet with debug capture enabled.', 'Janitor AI Script Bridge');
                    return;
                }
                showReportPopup(report);
            });
            $('#extensionsMenu').append(button);
        }
    } catch (error) {
        console.error('[JaiBridge] Failed to initialize:', error);
        toastr?.error('Janitor AI Script Bridge failed to initialize. Check the console.', 'Janitor AI Script Bridge');
    }
});
