// Janitor AI Script Bridge — settings & storage
//
// Global state lives in extension_settings.jaiBridge:
//   scripts        — library of Advanced (JS) scripts
//   bookProvenance — per-converted-lorebook metadata (original Janitor entries + gating info)
//   options        — user preferences
//   lastReport     — debug report of the last generation
//
// Per-character script assignment is stored on the character card itself
// (data.extensions.jaiBridge.assignedScriptIds) via writeExtensionField so it
// survives card export/import — mirroring how Janitor attaches scripts to bots.
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
            lastReport: null,
        };
    }

    const settings = extension_settings[SETTINGS_KEY];
    if (!Array.isArray(settings.scripts)) {
        settings.scripts = [];
    }
    if (typeof settings.bookProvenance !== 'object' || settings.bookProvenance === null) {
        settings.bookProvenance = {};
    }
    if (typeof settings.options !== 'object' || settings.options === null) {
        settings.options = {};
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

// --- Debug report of the last generation ---

export function getLastReport() {
    return getSettings().lastReport;
}

export function setLastReport(report) {
    getSettings().lastReport = report;
    saveSettingsDebounced();
}
