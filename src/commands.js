// Janitor AI Script Bridge — slash commands
//
//   /jai-list               — show library + current character's stack
//   /jai-toggle <id|title>  — enable/disable a library script
//   /jai-assign <id|title>  — append a script to the current character's stack
//   /jai-unassign <id|title>
//   /jai-test [id|title]    — dry-run script(s) against the current chat (no injection)
//   /jai-debug              — open the last generation report

import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '/scripts/slash-commands/SlashCommandArgument.js';
import { getContext } from '/scripts/st-context.js';
import { getScripts, getScript, getScriptByTitle, toggleScript, assignScript, unassignScript, getAssignedScripts } from './storage.js';
import { testRunScripts } from './interceptor.js';
import { showReportPopup } from './report.js';

function findScript(idOrTitle) {
    return getScript(String(idOrTitle)) ?? getScriptByTitle(String(idOrTitle));
}

function requireCharacter(context) {
    const character = context.characterId !== undefined ? context.characters[context.characterId] : null;
    if (!character) {
        throw new Error('No character is selected.');
    }
    return character;
}

export function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'jai-list',
        callback: () => {
            const context = getContext();
            const lines = ['Janitor AI Script Bridge'];
            lines.push('', 'Library:');
            const scripts = getScripts();
            if (scripts.length === 0) {
                lines.push('  (empty)');
            }
            for (const script of scripts) {
                lines.push(`  ${script.enabled ? '[x]' : '[ ]'} ${script.title}`);
            }
            if (context.characterId !== undefined) {
                const character = requireCharacter(context);
                const assigned = getAssignedScripts(character);
                lines.push('', `Stack for ${character.name}:`);
                if (assigned.length === 0) {
                    lines.push('  (none assigned)');
                }
                assigned.forEach((script, index) => {
                    lines.push(`  ${index + 1}. ${script.title} `);
                });
            }
            return lines.join('\n');
        },
        helpString: 'Lists Janitor bridge scripts (library and the current character\'s ordered stack).',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'jai-toggle',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'Script id or title',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        })],
        callback: (_, idOrTitle) => {
            const script = findScript(idOrTitle);
            if (!script) {
                return `No script found for "${idOrTitle}".`;
            }
            toggleScript(script.id);
            return `${script.title} is now ${script.enabled ? 'enabled' : 'disabled'}.`;
        },
        helpString: 'Toggles a Janitor bridge script on/off.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'jai-assign',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'Script id or title',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        })],
        callback: async (_, idOrTitle) => {
            const context = getContext();
            requireCharacter(context);
            const script = findScript(idOrTitle);
            if (!script) {
                return `No script found for "${idOrTitle}".`;
            }
            await assignScript(context.characterId, script.id);
            return `${script.title} assigned to ${context.characters[context.characterId].name}.`;
        },
        helpString: 'Appends a Janitor bridge script to the current character\'s stack.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'jai-unassign',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'Script id or title',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: true,
        })],
        callback: async (_, idOrTitle) => {
            const context = getContext();
            requireCharacter(context);
            const script = findScript(idOrTitle);
            if (!script) {
                return `No script found for "${idOrTitle}".`;
            }
            await unassignScript(context.characterId, script.id);
            return `${script.title} removed from ${context.characters[context.characterId].name}.`;
        },
        helpString: 'Removes a Janitor bridge script from the current character\'s stack.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'jai-test',
        unnamedArgumentList: [SlashCommandArgument.fromProps({
            description: 'Script id or title (omit to dry-run the whole stack)',
            typeList: [ARGUMENT_TYPE.STRING],
            isRequired: false,
        })],
        callback: async (_, idOrTitle) => {
            const context = getContext();
            const character = requireCharacter(context);
            let scriptId = null;
            if (idOrTitle) {
                const script = findScript(idOrTitle);
                if (!script) {
                    return `No script found for "${idOrTitle}".`;
                }
                scriptId = script.id;
            }
            const report = await testRunScripts(character, scriptId);
            await showReportPopup(report);
            const ok = report.runs.filter(run => run.ok).length;
            return `Test run: ${ok}/${report.runs.length} script(s) ok. Nothing was injected.`;
        },
        helpString: 'Dry-runs Janitor bridge script(s) against the current chat without injecting anything.',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'jai-debug',
        callback: async () => {
            const { getLastReport } = await import('./storage.js');
            const report = getLastReport();
            if (!report) {
                return 'No generation has run yet with debug capture enabled.';
            }
            await showReportPopup(report);
            return '';
        },
        helpString: 'Opens the last Janitor bridge generation report.',
    }));
}
