// Janitor AI Script Bridge — Janitor lorebook ⇄ SillyTavern World Info
//
// Janitor "Lorebook"-type scripts are JSON arrays of entries. On import they are
// converted 1:1 into a native SillyTavern World Info book that is linked to the
// active character (data.extensions.world), so the entries take part in the
// regular WI scan every generation.
//
// Field mapping (Janitor → ST):
//   Keys            → key
//   Regex keys      → key (as /pattern/flags strings; ST parses them natively)
//   Secondary keys  → keysecondary (+ selective = true)
//   Secondary logic → selectiveLogic (AND ANY/AND ALL/NOT ANY/NOT ALL map 1:1)
//   Content         → content
//   Entry Name      → comment
//   Category        → comment prefix ("Category / Name")
//   Probability     → probability (+ useProbability = true)
//   Order           → order
//   Group Label(s)  → group (comma separated)
//   Group Weight    → groupWeight
//   Case Sensitive  → caseSensitive
//   Match Whole Word→ matchWholeWords
//   Active          → disable (inverted)
//   Constant        → constant
//   Depth           → scanDepth (per-entry scan depth override; falls back to
//                     the lorebook script's Depth setting)
//
// Conversion is import-time only: the result is a plain native ST World Info
// book with no plugin runtime involvement. The original Janitor JSON is kept
// as provenance so imports stay re-exportable. Janitor behaviors with no
// ST-native equivalent (Min Messages gating, weighted group rolls, per-entry
// activation scripts) are intentionally NOT emulated — strict bridging only.

import { createNewWorldInfo, createWorldInfoEntry, loadWorldInfo, saveWorldInfo, world_info_position, world_names } from '/scripts/world-info.js';
import { writeExtensionField } from '/scripts/extensions.js';
import { getContext } from '/scripts/st-context.js';
import { download } from '/scripts/utils.js';
import {
    normalizeJanitorEntry,
    looksLikeLorebook,
    extractLorebookEntries,
    compileRegexKey,
} from './janitor-format.js';
import { getBookProvenance, setBookProvenance, deleteBookProvenance, getOptions } from './storage.js';

// `toastr` is a page-level global provided by SillyTavern.
const toastr = globalThis.toastr;

export { looksLikeLorebook, extractLorebookEntries };

// --- Conversion ---

function uniqueBookName(base) {
    const safeBase = String(base || 'Janitor Lorebook').replace(/[\\<>:"/|?*\x00-\x1F]/g, '_').trim() || 'Janitor Lorebook';
    if (!world_names.includes(safeBase)) {
        return safeBase;
    }
    for (let counter = 2; counter < 1000; counter++) {
        const candidate = `${safeBase} (${counter})`;
        if (!world_names.includes(candidate)) {
            return candidate;
        }
    }
    return `${safeBase} (${Date.now()})`;
}

/**
 * Converts a Janitor lorebook entry array into a native ST World Info book and
 * links it to the given character (Janitor attaches lorebook scripts to bots).
 *
 * @param {object[]} rawEntries Parsed Janitor lorebook JSON (array of entries)
 * @param {string} title        Script/book title
 * @param {number|null} chid    Character index to attach the book to
 * @param {object} [scriptSettings] Original script settings ({depth} when known)
 * @returns {Promise<{bookName: string, entryCount: number, warnings: string[]}>}
 */
export async function convertJanitorLorebook(rawEntries, title, chid, scriptSettings = null) {
    const warnings = [];
    const bookName = uniqueBookName(`JAI: ${title}`);

    const created = await createNewWorldInfo(bookName, {});
    if (!created) {
        throw new Error(`Could not create World Info book "${bookName}" (name already taken?)`);
    }

    const data = await loadWorldInfo(bookName);
    if (!data || typeof data.entries !== 'object') {
        throw new Error(`Created book "${bookName}" could not be loaded`);
    }

    let entryCount = 0;

    for (const raw of rawEntries) {
        const record = normalizeJanitorEntry(raw);
        if (!record) {
            continue;
        }

        const entry = createWorldInfoEntry(bookName, data);
        if (!entry) {
            warnings.push('Ran out of entry UIDs; some entries were skipped.');
            break;
        }

        // Keys: plain keys plus regex keys in ST's "/pattern/flags" notation.
        const keyList = [...record.keys];
        for (const regexKey of record.regexKeys) {
            if (compileRegexKey(regexKey, record.caseSensitive)) {
                keyList.push(regexKey.startsWith('/') ? regexKey : `/${regexKey}/`);
            } else {
                warnings.push(`Invalid regex key "${regexKey}" in entry "${record.entryName}" was skipped.`);
            }
        }

        entry.key = keyList;
        entry.keysecondary = [...record.secondary];
        entry.selective = record.secondary.length > 0;
        if (record.secondaryLogic !== null) {
            entry.selectiveLogic = record.secondaryLogic;
        }
        entry.content = record.content;
        entry.comment = record.category ? `${record.category} / ${record.entryName}` : record.entryName;
        entry.probability = Math.min(100, Math.max(0, Math.round(record.probability)));
        entry.useProbability = true;
        entry.order = record.order;
        entry.constant = record.constant;
        entry.disable = !record.active;
        if (record.groupLabels.length > 0) {
            entry.group = record.groupLabels.join(', ');
            entry.groupWeight = Math.min(100000, Math.max(1, Math.round(record.groupWeight || 100)));
        }
        // Janitor defaults: Match Whole Word ON, Case Sensitive OFF (verified in
        // a real 90-entry export). Map both explicitly — never rely on ST's
        // global defaults, which differ (whole-word defaults OFF there).
        entry.matchWholeWords = record.matchWholeWords;
        entry.caseSensitive = record.caseSensitive;
        // Janitor Depth = "how many messages to search" (entry override, else
        // the lorebook setting). ST: per-entry scanDepth override.
        const scanDepth = record.depth ?? scriptSettings?.depth ?? getOptions().defaultDepth;
        entry.scanDepth = Math.max(1, Math.min(10, Math.round(Number(scanDepth) || 3)));

        // Placement/Position (per-entry in Janitor's editor; Default = after
        // personality) → ST world_info_position. ST cannot express every slot:
        // personality/scenario land relative to the whole char block,
        // example-message placement maps exactly.
        switch (record.placement) {
            case 'personality':
                entry.position = record.position === 'before'
                    ? world_info_position.before
                    : world_info_position.after;
                break;
            case 'example':
                entry.position = record.position === 'before'
                    ? world_info_position.EMTop
                    : world_info_position.EMBottom;
                break;
            case 'scenario':
            case 'default':
            default:
                entry.position = world_info_position.after;
                break;
        }



        entryCount++;
    }

    await saveWorldInfo(bookName, data, true);

    setBookProvenance(bookName, {
        source: 'janitor-lorebook',
        title: String(title),
        importedAt: Date.now(),
        entryCount,
        settings: {
            depth: scriptSettings?.depth !== undefined ? Math.max(1, Math.min(10, Math.round(Number(scriptSettings.depth) || 3))) : getOptions().defaultDepth,
        },
        original: rawEntries,
    });

    if (chid !== null && chid !== undefined && chid !== -1) {
        await attachBookToCharacter(chid, bookName);
    }

    return { bookName, entryCount, warnings };
}

export async function attachBookToCharacter(chid, bookName) {
    await writeExtensionField(chid, 'world', bookName);
    const context = getContext();
    if (Number(context.characterId) === Number(chid)) {
        const select = document.getElementById('character_world');
        if (select) {
            select.value = bookName;
        }
    }
}

export async function deleteConvertedBook(bookName) {
    deleteBookProvenance(bookName);
}

export function exportBookOriginal(bookName) {
    const provenance = getBookProvenance(bookName);
    if (!provenance?.original) {
        toastr.warning(`No original Janitor JSON stored for "${bookName}".`, 'Janitor AI Script Bridge');
        return;
    }
    const payload = {
        title: provenance.title,
        type: 'lorebook',
        script: provenance.original,
        settings: provenance.settings,
    };
    download(JSON.stringify(payload, null, 4), `${bookName.replace(/[\\<>:"/|?*]/g, '_')}.json`, 'application/json');
}
