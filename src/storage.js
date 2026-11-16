// Janitor AI Script Bridge — settings & storage
//
// Global state lives in extension_settings.jaiBridge:
//   scripts        — library of Advanced (JS) scripts
//   bookProvenance — per-lorebook import metadata (small: title/count/depth —
//                    the original Janitor JSON lives inside the book file itself)
//   options        — user preferences
//
// The last-generation debug report is intentionally NOT persisted: it contains
// chat-derived content (script logs, character diffs) and settings.json is a
// file users share/sync — it lives in a module variable for the session only.
//
// Per-character script assignment is stored on the character card itself
// (data.extensions.jaiBridge.assignedScriptIds) via writeExtensionField so it
// survives card export/import — mirroring how Janitor attaches scripts to bots.
// Bridged lorebooks are tracked the same way
// (data.extensions.jaiBridgeBooks = [book names]) and enforced at generation
// time by the lorebook engine.
// Per-chat script assignment lives in the chat's metadata
// (chat_metadata.jaiBridge.assignedScriptIds) — the same slot Author's Note
// uses for chat-scoped data, so it follows the chat through checkpoints.

// Note: saveSettingsDebounced is exported by /script.js, NOT by extensions.js.
// Note: saveMetadataDebounced is exported by /scripts/extensions.js, NOT by script.js.
import { extension_settings, writeExtensionField, saveMetadataDebounced } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { uuidv4 } from '/scripts/utils.js';
import { CONTEXT_CHAR_FIELDS } from './context.js';

export { CONTEXT_CHAR_FIELDS };

const SETTINGS_KEY = 'jaiBridge';

// Character-card extension field holding the bridged lorebook book names.
export const BRIDGE_BOOKS_FIELD = 'jaiBridgeBooks';

const DEFAULT_OPTIONS = {
    // 'faithful' — temporarily write script results into the in-memory character
    //              fields (personality / scenario / example dialogs) exactly like
    //              Janitor splices them into the prompt sections. Restored after
    //              the prompt for this generation has been materialized.
    // 'ephemeral' — inject the appended text as an extension prompt instead.
    //               Never touches the character object, but lands at a fixed
    //               prompt position rather than inside the char sections.
    injectionMode: 'faithful',
    // Janitor has no "generate user message" equivalent; impersonation skips scripts by default.
    runOnImpersonate: false,
    // Capture per-script console output, diffs and errors of the last generation.
    debugCapture: true,
    // Hard kill for a script sandbox (ms). Janitor gives each script "a few ms".
    scriptTimeoutMs: 500,
    // Default lorebook scan depth for converted Janitor lorebooks (Janitor default 3, range 1-10).
    defaultDepth: 3,
};

export function getSettings() {
    if (typeof extension_settings[SETTINGS_KEY] !== 'object' || extension_settings[SETTINGS_KEY] === null) {
        extension_settings[SETTINGS_KEY] = {
            scripts: [],
            bookProvenance: {},
            options: {},
        };
    }

    const settings = extension_settings[SETTINGS_KEY];
    if (!Array.isArray(settings.scripts)) {
        settings.scripts = [];
    }
    // Self-heal corrupt entries (null / non-object) — one bad item used to
    // crash both the UI init and the interceptor loop.
    settings.scripts = settings.scripts.filter(script => script !== null && typeof script === 'object');
    if (typeof settings.bookProvenance !== 'object' || settings.bookProvenance === null) {
        settings.bookProvenance = {};
    }
    if (typeof settings.options !== 'object' || settings.options === null) {
        settings.options = {};
    }
    // v0.3.0: the debug report is session-only now — drop any persisted copy.
    if ('lastReport' in settings) {
        delete settings.lastReport;
    }
    for (const [key, value] of Object.entries(DEFAULT_OPTIONS)) {
        if (settings.options[key] === undefined) {
            settings.options[key] = value;
        }
    }

    return settings;
}

export function getOptions() {
    return getSettings().options;
}

export function setOption(key, value) {
    getSettings().options[key] = value;
    saveSettingsDebounced();
}

export function saveSettings() {
    saveSettingsDebounced();
}

// --- Script library (Advanced scripts) ---

export function getScripts() {
    return getSettings().scripts;
}

export function getScript(id) {
    return getScripts().find(script => script.id === id) ?? null;
}

export function getScriptByTitle(title) {
    const needle = String(title ?? '').trim().toLowerCase();
    return getScripts().find(script => script.title.toLowerCase() === needle) ?? null;
}

export function addScript({ title, code, description = '' }) {
    const settings = getSettings();
    const script = {
        id: uuidv4(),
        title: String(title || 'Untitled script').slice(0, 100),
        code: String(code ?? ''),
        // Note: Janitor's Message Depth (1-10) applies to LOREBOOK scan depth
        // only — Advanced scripts have no depth (user-verified), so none is
        // stored here.
        description: String(description ?? '').slice(0, 500),
        enabled: true,
        createdAt: Date.now(),
    };
    settings.scripts.push(script);
    saveSettingsDebounced();
    return script;
}

export function updateScript(id, patch) {
    const script = getScript(id);
    if (!script) {
        return null;
    }
    if (patch.title !== undefined) {
        script.title = String(patch.title || script.title).slice(0, 100);
    }
    if (patch.code !== undefined) {
        script.code = String(patch.code ?? '');
    }
    if (patch.description !== undefined) {
        script.description = String(patch.description ?? '').slice(0, 500);
    }
    if (patch.enabled !== undefined) {
        script.enabled = !!patch.enabled;
    }
    saveSettingsDebounced();
    return script;
}

export function deleteScript(id) {
    const settings = getSettings();
    const index = settings.scripts.findIndex(script => script.id === id);
    if (index === -1) {
        return false;
    }
    settings.scripts.splice(index, 1);
    // Drop the script from every assignment as well.
    setChatAssignment(getChatAssignment().filter(chatId => chatId !== id));
    removeScriptFromAllCharacters(id);
    saveSettingsDebounced();
    return true;
}

export function toggleScript(id) {
    const script = getScript(id);
    if (!script) {
        return null;
    }
    script.enabled = !script.enabled;
    saveSettingsDebounced();
    return script;
}


// --- Per-character assignment (ordered stack, Janitor-style) ---

export function getAssignment(character) {
    const ids = character?.data?.extensions?.[SETTINGS_KEY]?.assignedScriptIds;
    if (!Array.isArray(ids)) {
        return [];
    }
    // Keep only ids that still exist in the library, in order.
    return ids.filter(id => getScript(id) !== null);
}

export function getAssignedScripts(character) {
    return getAssignment(character)
        .map(id => getScript(id))
        .filter(script => script !== null);
}

export async function setAssignment(chid, ids) {
    const value = { assignedScriptIds: ids.filter(id => getScript(id) !== null) };
    await writeExtensionField(chid, SETTINGS_KEY, value);
}

export async function assignScript(chid, scriptId) {
    const context = getContext();
    const character = context.characters[chid];
    if (!character) {
        return;
    }
    const ids = getAssignment(character);
    if (!ids.includes(scriptId)) {
        ids.push(scriptId);
    }
    await setAssignment(chid, ids);
}

export async function unassignScript(chid, scriptId) {
    const context = getContext();
    const character = context.characters[chid];
    if (!character) {
        return;
    }
    const ids = getAssignment(character).filter(id => id !== scriptId);
    await setAssignment(chid, ids);
}

async function removeScriptFromAllCharacters(scriptId) {
    const context = getContext();
    for (let index = 0; index < context.characters.length; index++) {
        const character = context.characters[index];
        const ids = character?.data?.extensions?.[SETTINGS_KEY]?.assignedScriptIds;
        if (Array.isArray(ids) && ids.includes(scriptId)) {
            try {
                await setAssignment(index, ids.filter(id => id !== scriptId));
            } catch (error) {
                console.warn('[JaiBridge] Failed to unassign script from character', character?.name, error);
            }
        }
    }
}

// --- Per-chat assignment (chat metadata, ordered overlay stack) ---

/**
 * Live reference to the current chat's metadata (same object ST saves with the
 * chat file). Empty object when no chat is open.
 */
function getChatMetadata() {
    return getContext().chatMetadata ?? {};
}

export function getChatAssignment() {
    const ids = getChatMetadata()?.[SETTINGS_KEY]?.assignedScriptIds;
    if (!Array.isArray(ids)) {
        return [];
    }
    // Keep only ids that still exist in the library, in order.
    return ids.filter(id => getScript(id) !== null);
}

export function getChatAssignedScripts() {
    return getChatAssignment()
        .map(id => getScript(id))
        .filter(script => script !== null);
}

export function setChatAssignment(ids) {
    const metadata = getChatMetadata();
    metadata[SETTINGS_KEY] = { ...(metadata[SETTINGS_KEY] ?? {}), assignedScriptIds: ids.filter(id => getScript(id) !== null) };
    saveMetadataDebounced();
}

export function assignChatScript(scriptId) {
    const ids = getChatAssignment();
    if (!ids.includes(scriptId)) {
        ids.push(scriptId);
        setChatAssignment(ids);
    }
}

export function unassignChatScript(scriptId) {
    setChatAssignment(getChatAssignment().filter(id => id !== scriptId));
}

// --- Converted lorebook provenance ---

export function getBookProvenance(bookName) {
    return getSettings().bookProvenance[bookName] ?? null;
}

export function setBookProvenance(bookName, provenance) {
    getSettings().bookProvenance[bookName] = provenance;
    saveSettingsDebounced();
}

export function deleteBookProvenance(bookName) {
    delete getSettings().bookProvenance[bookName];
    saveSettingsDebounced();
}

export function getBookProvenanceNames() {
    return Object.keys(getSettings().bookProvenance);
}

/**
 * Drops a legacy `original` copy from the settings provenance once the book
 * file itself carries the entries (v0.3.0 keeps big JSON out of settings.json).
 */
export function stripProvenanceOriginal(bookName) {
    const provenance = getSettings().bookProvenance[bookName];
    if (provenance && provenance.original !== undefined) {
        delete provenance.original;
        saveSettingsDebounced();
    }
}

// --- Bridged lorebooks (per-character book list) ---

/**
 * Bridged lorebook names attached to a character (Janitor attaches lorebooks
 * to bots). Bridged books are enforced by the lorebook engine at generation
 * time; the World Info copies stay unlinked and view-only.
 */
export function getBridgedBookNames(character) {
    const names = character?.data?.extensions?.[BRIDGE_BOOKS_FIELD];
    if (!Array.isArray(names)) {
        return [];
    }
    return names.filter(name => typeof name === 'string' && name.length > 0);
}

export async function addBridgedBook(chid, bookName) {
    const context = getContext();
    const character = context.characters[chid];
    if (!character) {
        return;
    }
    const names = getBridgedBookNames(character);
    if (!names.includes(bookName)) {
        names.push(bookName);
    }
    await writeExtensionField(chid, BRIDGE_BOOKS_FIELD, names);
}

export async function removeBridgedBook(chid, bookName) {
    const context = getContext();
    const character = context.characters[chid];
    if (!character) {
        return;
    }
    const names = getBridgedBookNames(character);
    if (names.includes(bookName)) {
        await writeExtensionField(chid, BRIDGE_BOOKS_FIELD, names.filter(name => name !== bookName));
    }
}

// --- Debug report of the last generation (session-only, never persisted) ---

let lastReport = null;

export function getLastReport() {
    return lastReport;
}

export function setLastReport(report) {
    lastReport = report;
}
