// Janitor AI Script Bridge — import pipeline
//
// Routes incoming script content to the right handler:
//   - plain JS code / .js file            → Advanced script (library)
//   - lorebook JSON (array / {entries} / {script}) → converted ST World Info book
//   - Janitor script export {title, script, settings} → routed by content
//   - bundle {scripts: [{title, script, settings}, ...]} → every item routed
//
// The user's decided flow (v1): paste text, import .js or .json files. Janitor
// stores scripts server-side and has no official export API, so content always
// comes from the user's copy.

import { getContext } from '/scripts/st-context.js';
import { convertJanitorLorebook, looksLikeLorebook, extractLorebookEntries } from './lorebook.js';
import { addScript } from './storage.js';

const MAX_PASTE_LENGTH = 1024 * 1024;

/**
 * Detects and imports pasted text or file contents.
 *
 * @param {string} text      Raw content
 * @param {string} [title]   Suggested title (filename or user input)
 * @param {object} [log]     {warnings: string[], books: string[], scripts: number} sink
 * @returns {Promise<{books: string[], scripts: number, warnings: string[]}>}
 */
export async function detectAndImport(text, title = '', log = null) {
    const warnings = log?.warnings ?? [];
    const books = log?.books ?? [];
    let scriptCount = log?.scripts ?? 0;

    if (typeof text !== 'string' || text.trim().length === 0) {
        warnings.push('Nothing to import.');
        return { books, scripts: scriptCount, warnings };
    }
    if (text.length > MAX_PASTE_LENGTH) {
        warnings.push('Content exceeds 1 MB and was rejected.');
        return { books, scripts: scriptCount, warnings };
    }

    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }

    if (parsed !== null) {
        await importJson(parsed, text, title, warnings, books, count => (scriptCount += count));
    } else {
        // Not JSON → plain JavaScript (the Janitor "Advanced" dialect).
        importAdvanced(text, title || 'Pasted script', null, null);
        scriptCount++;
    }

    if (log) {
        log.books = books;
        log.scripts = scriptCount;
        log.warnings = warnings;
    }
    return { books, scripts: scriptCount, warnings };
}

async function importJson(parsed, originalText, title, warnings, books, addScriptCount) {
    // Case 1: pure lorebook JSON (array of entries, optionally wrapped).
    if (looksLikeLorebook(parsed)) {
        const entries = extractLorebookEntries(parsed);
        const bookName = await importLorebook(entries, title || 'Imported lorebook', null, warnings);
        if (bookName) {
            books.push(bookName);
        }
        return;
    }

    // Case 2: Janitor script export {title, script, settings}.
    if (typeof parsed?.script === 'string' && (parsed.title || parsed.settings)) {
        await importScriptExport(parsed, title, warnings, books, addScriptCount);
        return;
    }

    // Case 3: bundle {scripts: [...]} — e.g. collected via community exporters.
    if (Array.isArray(parsed?.scripts) && parsed.scripts.every(item => typeof item === 'object' && item !== null)) {
        for (const [index, item] of parsed.scripts.entries()) {
            const itemTitle = String(item.title || item.name || `${title || 'Bundle'} #${index + 1}`);
            if (typeof item.script === 'string') {
                await importScriptExport({ title: itemTitle, script: item.script, settings: item.settings }, itemTitle, warnings, books, addScriptCount);
            } else if (Array.isArray(item.entries) || Array.isArray(item.script)) {
                const entries = Array.isArray(item.script) ? item.script : item.entries;
                const bookName = await importLorebook(entries, itemTitle, item.settings, warnings);
                if (bookName) {
                    books.push(bookName);
                }
            } else {
                warnings.push(`Bundle item "${itemTitle}" has no importable script content and was skipped.`);
            }
        }
        return;
    }

    // Case 4: some other JSON — treat the raw text as an Advanced script.
    warnings.push('JSON did not match a known Janitor format; imported as an Advanced script instead.');
    importAdvanced(originalText, title || 'Imported script', null, null);
    addScriptCount(1);
}

async function importScriptExport(exportShape, fallbackTitle, warnings, books, addScriptCount) {
    const itemTitle = String(exportShape.title || fallbackTitle || 'Janitor script');
    const content = String(exportShape.script ?? '');

    let parsedContent = null;
    try {
        parsedContent = JSON.parse(content);
    } catch {
        parsedContent = null;
    }

    if (parsedContent !== null && looksLikeLorebook(parsedContent)) {
        const bookName = await importLorebook(extractLorebookEntries(parsedContent), itemTitle, exportShape.settings, warnings);
        if (bookName) {
            books.push(bookName);
        }
        return;
    }

    if (typeof exportShape.script === 'string') {
        importAdvanced(exportShape.script, itemTitle, exportShape.settings?.depth, null);
        addScriptCount(1);
        return;
    }

    warnings.push(`Script "${itemTitle}" has no importable content and was skipped.`);
}

async function importLorebook(entries, title, scriptSettings, warnings) {
    if (!Array.isArray(entries) || entries.length === 0) {
        warnings.push(`Lorebook "${title}" contains no entries.`);
        return null;
    }
    const context = getContext();
    const chid = context.characterId !== undefined ? context.characterId : null;
    if (chid === null) {
        warnings.push('No character selected — the lorebook was created as a standalone book (attach it in World Info).');
    }
    try {
        const { bookName, warnings: convertWarnings } = await convertJanitorLorebook(entries, title, chid, scriptSettings);
        warnings.push(...convertWarnings);
        return bookName;
    } catch (error) {
        console.error('[JaiBridge] Lorebook conversion failed', error);
        warnings.push(`Lorebook conversion failed: ${error?.message ?? error}`);
        return null;
    }
}

function importAdvanced(code, title, depth, description) {
    const script = addScript({ title, code, depth, description });
    return script;
}

/**
 * Imports a single file chosen via the file picker.
 *
 * @param {File} file
 * @param {object} log shared sink
 */
export async function importFile(file, log = { warnings: [], books: [], scripts: 0 }) {
    const title = String(file.name || '').replace(/\.(js|json|txt)$/i, '');
    const text = await file.text();
    const isJs = /\.js$/i.test(file.name ?? '');

    if (isJs) {
        // .js files are always Advanced scripts.
        importAdvanced(text, title, null, null);
        log.scripts++;
    } else {
        // .json (or anything else): route by content detection.
        await detectAndImport(text, title, log);
    }

    return { title };
}
