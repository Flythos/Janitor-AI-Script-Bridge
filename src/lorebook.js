// Janitor AI Script Bridge — Janitor lorebook ⇄ SillyTavern World Info
//
// Janitor "Lorebook"-type scripts are JSON arrays of entries. On import they
// become a native SillyTavern World Info book `JAI: <title>` that carries the
// full original data inside the book file itself (data.jaiBridge), and the
// user picks how it is attached to the character:
//
//   **Native mode** — the book is linked as the character's primary lorebook
//   (data.extensions.world) and ST's own WI engine handles everything. Field
//   mapping (Janitor → ST):
//     Keys            → key
//     Regex keys      → key (as /pattern/flags strings; ST parses them natively)
//     Secondary keys  → keysecondary (+ selective = true)
//     Secondary logic → selectiveLogic (AND ANY/AND ALL/NOT ANY/NOT ALL map 1:1)
//     Content         → content
//     Entry Name      → comment
//     Category        → comment prefix ("Category / Name")
//     Probability     → probability (+ useProbability = true)
//     Order           → order
//     Group Label(s)  → group (commas inside labels replaced with ';')
//     Group Weight    → groupWeight (clamped to ST's editor max 10000)
//     "Use insertion order instead of weight" (prioritizeInclusion) → groupOverride
//     Case Sensitive  → caseSensitive
//     Match Whole Word→ matchWholeWords
//     Active          → disable (inverted)
//     Constant        → constant
//     Depth           → scanDepth (per-entry scan depth override)
//     Placement × Pos → world_info_position (Default = after personality)
//
//   **Bridge mode** — the book is NOT linked; the character gets the book name
//   in data.extensions.jaiBridgeBooks and the lorebook engine
//   (src/lorebook-engine.js) re-implements Janitor's activation rules at
//   generation time (Min Messages, weighted group picks, key scan, probability,
//   placement) and injects matching entries itself. The ST copy is view-only.
//
// The original Janitor entry JSON is stored inside the book file
// (data.jaiBridge.entries) for both modes — settings.json only keeps small
// provenance metadata.

import { createNewWorldInfo, createWorldInfoEntry, loadWorldInfo, saveWorldInfo, world_names } from '/scripts/world-info.js';
import { writeExtensionField } from '/scripts/extensions.js';
import { getContext } from '/scripts/st-context.js';
import { download } from '/scripts/utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';
import {
    normalizeJanitorEntry,
    looksLikeLorebook,
    extractLorebookEntries,
    compileRegexKey,
    placementToWIPosition,
    sanitizeGroupLabelsForST,
} from './janitor-format.js';
import { getBookProvenance, setBookProvenance, deleteBookProvenance, getOptions, addBridgedBook, removeBridgedBook, stripProvenanceOriginal } from './storage.js';

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
 * Converts a Janitor lorebook entry array into a native ST World Info book.
 * The book file itself carries the bridge payload (data.jaiBridge: original
 * entries + depth) and is NOT linked to any character here — the caller picks
 * the attach mode (native link vs bridge list) and calls the matching helper.
 *
 * @param {object[]} rawEntries Parsed Janitor lorebook JSON (array of entries)
 * @param {string} title        Script/book title
 * @param {object} [scriptSettings] Original script settings ({depth} when known)
 * @returns {Promise<{bookName: string, entryCount: number, warnings: string[]}>}
 */
export async function convertJanitorLorebook(rawEntries, title, scriptSettings = null) {
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
    let skippedCount = 0;

    for (const raw of rawEntries) {
        const record = normalizeJanitorEntry(raw);
        if (!record) {
            skippedCount++;
            continue;
        }

        const entry = createWorldInfoEntry(bookName, data);
        if (!entry) {
            warnings.push('Ran out of entry UIDs; some entries were skipped.');
            break;
        }

        // Keys: plain keys plus regex keys in ST's "/pattern/flags" notation.
        // ST only accepts the [gimsuy] flag set — flags outside it are dropped
        // (with a warning), otherwise ST would treat the key as literal text.
        const keyList = [...record.keys];
        for (const regexKey of record.regexKeys) {
            const details = {};
            if (compileRegexKey(regexKey, record.caseSensitive, details)) {
                keyList.push(regexKey.startsWith('/') ? regexKey : `/${regexKey}/`);
                if (details.droppedFlags) {
                    warnings.push(`Regex key "${regexKey}" in entry "${record.entryName}" uses flag(s) "${details.droppedFlags}" that ST does not support — they were dropped.`);
                }
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
            // ST splits the group field on commas — keep labels intact.
            const labels = sanitizeGroupLabelsForST(record.groupLabels);
            if (labels.changed) {
                warnings.push(`Group label(s) of entry "${record.entryName}" contained commas (ST splits groups on commas) — commas were replaced with ';'.`);
            }
            entry.group = labels.joined;
            entry.groupWeight = Math.min(10000, Math.max(1, Math.round(record.groupWeight || 100)));
            // "Use insertion order instead of weight" → ST's Inclusion Priority.
            if (record.groupMode === 'byOrder') {
                entry.groupOverride = true;
            }
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
        entry.position = placementToWIPosition(record.placement, record.position);

        entryCount++;
    }

    if (skippedCount > 0) {
        warnings.push(`${skippedCount} entr${skippedCount === 1 ? 'y was' : 'ies were'} skipped (no content and no keys).`);
    }

    // The book file carries the full bridge payload: original entries for the
    // lorebook engine (bridge mode) and for re-export. ST serializes the data
    // object as-is, so the custom key survives.
    const depth = scriptSettings?.depth !== undefined
        ? Math.max(1, Math.min(10, Math.round(Number(scriptSettings.depth) || 3)))
        : getOptions().defaultDepth;
    data.jaiBridge = {
        title: String(title),
        importedAt: Date.now(),
        entryCount,
        depth,
        entries: Array.isArray(rawEntries) ? rawEntries : [],
    };

    await saveWorldInfo(bookName, data, true);

    // Small metadata only — the big JSON lives in the book file now.
    setBookProvenance(bookName, {
        source: 'janitor-lorebook',
        title: String(title),
        importedAt: Date.now(),
        entryCount,
        settings: { depth },
    });

    return { bookName, entryCount, warnings };
}

/**
 * Links a book as the character's primary lorebook (native mode). Asks for
 * confirmation before replacing an existing link — the old book itself is
 * kept, only the link changes.
 *
 * @returns {boolean} false when the user cancelled the overwrite
 */
export async function attachBookToCharacter(chid, bookName, { confirmOverwrite = true } = {}) {
    const context = getContext();
    const character = context.characters[chid];
    const existing = character?.data?.extensions?.world;
    if (existing && existing !== bookName && confirmOverwrite) {
        const result = await callGenericPopup(
            `"${escapeHtmlText(existing)}" is currently the primary lorebook. Replace the link with "${escapeHtmlText(bookName)}"? (The old book itself is kept.)`,
            POPUP_TYPE.CONFIRM,
        );
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return false;
        }
    }
    await writeExtensionField(chid, 'world', bookName);
    if (Number(context.characterId) === Number(chid)) {
        const select = document.getElementById('character_world');
        if (select) {
            select.value = bookName;
        }
    }
    return true;
}

/**
 * Removes the primary-lorebook link when it points at the given book.
 */
async function unlinkBookFromCharacter(chid, bookName) {
    const context = getContext();
    const character = context.characters[chid];
    if (character?.data?.extensions?.world !== bookName) {
        return;
    }
    await writeExtensionField(chid, 'world', '');
    if (Number(context.characterId) === Number(chid)) {
        const select = document.getElementById('character_world');
        if (select) {
            select.value = '';
        }
    }
}

/**
 * Switches a book's attach mode for a character.
 *
 * @param {number} chid
 * @param {string} bookName
 * @param {boolean} bridged true = Bridge mode (Janitor engine), false = Native
 * @returns {Promise<boolean>} false when the user cancelled (native overwrite)
 */
export async function setBookBridgeMode(chid, bookName, bridged) {
    if (bridged) {
        // Bridge books are enforced by the engine — they must not also be
        // linked, or ST would activate the same entries twice.
        await unlinkBookFromCharacter(chid, bookName);
        await addBridgedBook(chid, bookName);
        return true;
    }
    await removeBridgedBook(chid, bookName);
    return await attachBookToCharacter(chid, bookName);
}

export async function deleteConvertedBook(bookName) {
    deleteBookProvenance(bookName);
}

/**
 * Re-exports the original Janitor JSON. v0.3.0 books carry it inside the book
 * file (data.jaiBridge.entries); legacy imports fall back to the settings
 * provenance copy.
 */
export async function exportBookOriginal(bookName) {
    let original = null;
    try {
        const data = await loadWorldInfo(bookName);
        if (Array.isArray(data?.jaiBridge?.entries) && data.jaiBridge.entries.length > 0) {
            original = data.jaiBridge.entries;
        }
    } catch {
        /* fall through to the legacy provenance copy */
    }

    const provenance = getBookProvenance(bookName);
    if (!original && Array.isArray(provenance?.original)) {
        original = provenance.original;
        // The book file is authoritative now — drop the settings.json copy.
        stripProvenanceOriginal(bookName);
    }

    if (!original) {
        toastr.warning(`No original Janitor JSON stored for "${bookName}".`, 'Janitor AI Script Bridge');
        return;
    }
    const payload = {
        title: provenance?.title ?? bookName,
        type: 'lorebook',
        script: original,
        settings: provenance?.settings,
    };
    download(JSON.stringify(payload, null, 4), `${bookName.replace(/[\\<>:"/|?*]/g, '_')}.json`, 'application/json');
}

function escapeHtmlText(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
