// Janitor AI Script Bridge — settings panel UI
//
// Renders into the Extensions panel (#extensions_settings). Sections:
//   - Script library (Advanced scripts): create/edit/delete/enable, import
//   - Assignment: ordered script stack for the selected character (drag to
//     reorder, later scripts see earlier scripts' edits — Janitor ordering)
//   - Converted lorebooks: imported Janitor lorebook JSON books + provenance
//   - Options: injection mode, impersonation, debug capture, sandbox timeout
//   - Debug: last generation report

import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { getContext } from '/scripts/st-context.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';
import { escapeHtml, getSortableDelay } from '/scripts/utils.js';
import {
    getScripts, getScript, addScript, updateScript, deleteScript, toggleScript,
    getAssignment, getAssignedScripts, assignScript, unassignScript, setAssignment,
    getBookProvenanceNames, getBookProvenance,
    getOptions, setOption, getLastReport,
    getBridgedBookNames, removeBridgedBook,
} from './storage.js';
import { deleteConvertedBook, exportBookOriginal, setBookBridgeMode } from './lorebook.js';
import { detectAndImport, importFile } from './importer.js';
import { createCodeEditor } from './code-editor.js';
import { showReportPopup } from './report.js';

// `$` (jQuery) and `toastr` are page-level globals provided by SillyTavern.

const PANEL_ID = 'jai_bridge_settings';

/** Element of the Extensions settings panel, kept for cross-UI refreshes. */
let extensionsPanel = null;

/**
 * Derives this extension's install path from the module's own URL, so the
 * folder may be renamed freely (e.g. "JanitorAIscriptusage"). Falls back to
 * the canonical name if the URL can't be parsed.
 */
export function getExtensionName() {
    try {
        const rootUrl = new URL('../', import.meta.url); // .../src/ui.js → extension root
        const match = rootUrl.pathname.match(/\/scripts\/extensions\/(.+?)\/?$/);
        if (match) {
            return match[1];
        }
    } catch {
        /* fall through */
    }
    return 'third-party/JanitorAiScriptUsage';
}

export async function renderSettingsUI() {
    const template = await renderExtensionTemplateAsync(getExtensionName(), 'templates/settings');
    const panel = $(template);
    extensionsPanel = panel;
    $('#extensions_settings').append(panel);
    wireLibrarySection(panel);
    wireImportSection(panel);
    wireAssignmentSection(panel);
    wireBooksSection(panel);
    wireOptionsSection(panel);
    wireDebugSection(panel);
    refreshAllSections(panel);

    // Re-render the assignment section when the selected chat/character changes.
    const { eventSource, event_types } = await import('/scripts/events.js');
    eventSource.on(event_types.CHAT_CHANGED, () => refreshAssignmentSection(panel));
}

function refreshAllSections(panel) {
    refreshLibrarySection(panel);
    refreshAssignmentSection(panel);
    refreshBooksSection(panel);
    refreshOptionsSection(panel);
}

// --- Library ---

function wireLibrarySection(panel) {
    panel.find('#jai_new_script').on('click', () => openScriptEditor(null).catch(error => {
        console.warn('[JaiBridge] Script editor failed', error);
        toastr.error(`Editor failed: ${error?.message ?? error}`, 'Janitor AI Script Bridge');
    }));
    panel.on('click', '.jai-edit-script', function () {
        openScriptEditor(String($(this).closest('.jai-script-item').data('id'))).catch(error => {
            console.warn('[JaiBridge] Script editor failed', error);
            toastr.error(`Editor failed: ${error?.message ?? error}`, 'Janitor AI Script Bridge');
        });
    });
    panel.on('click', '.jai-delete-script', async function () {
        const id = String($(this).closest('.jai-script-item').data('id'));
        const script = getScript(id);
        const confirmed = await callGenericPopup(
            `Delete script "${escapeHtml(script?.title ?? id)}"? Characters will lose it from their stacks.`,
            POPUP_TYPE.CONFIRM,
        );
        if (confirmed === POPUP_RESULT.AFFIRMATIVE) {
            deleteScript(id);
            refreshAllSections(panel);
        }
    });
    panel.on('change', '.jai-enable-script', function () {
        const id = String($(this).closest('.jai-script-item').data('id'));
        toggleScript(id);
        refreshAssignmentSection(panel);
    });
}

function refreshLibrarySection(panel) {
    const list = panel.find('#jai_script_list');
    list.empty();
    const scripts = getScripts();
    if (scripts.length === 0) {
        list.append('<div class="jai-empty">No scripts yet. Create one or import a .js / .json file.</div>');
    }
    for (const script of scripts) {
        const item = $(`
            <div class="jai-script-item" data-id="${escapeHtml(script.id)}">
                <input class="jai-enable-script" type="checkbox" ${script.enabled ? 'checked' : ''} title="Enabled" />
                <span class="jai-badge advanced">JS</span>
                <span class="jai-script-title" title="${escapeHtml(script.description || script.title)}">${escapeHtml(script.title)}</span>
                <span class="jai-script-actions">
                    <button class="menu_button jai-edit-script" title="Edit"><i class="fa-solid fa-pencil"></i></button>
                    <button class="menu_button jai-delete-script" title="Delete"><i class="fa-solid fa-trash"></i></button>
                </span>
            </div>
        `);
        list.append(item);
    }
}

/**
 * Opens the script editor popup for a library script. Layout follows the
 * Prompt Patches panel's design language: a titled header row, small form
 * labels, and a rounded, bordered code box.
 *
 * @param {string|null} id Existing script id, or null to create a new script
 * @param {object} [hooks] Optional callbacks
 * @param {(script: object) => Promise<void>} [hooks.onCreated] Receives the newly
 *        created script (default: auto-assign it to the selected character).
 * @param {() => void} [hooks.onChanged] Called after a save (default: refresh the
 *        Extensions settings panel).
 */
export async function openScriptEditor(id, { onCreated = null, onChanged = null } = {}) {
    const existing = id ? getScript(id) : null;
    const codeEditor = createCodeEditor({
        value: existing?.code ?? '',
        height: 380,
        placeholder: '// JavaScript — runs before every generation',
        ariaLabel: 'Script code',
    });
    const editor = $(`
        <div class="jai-script-editor">
            <div class="jai-editor-header">
                <i class="fa-solid fa-scroll"></i>
                <span class="jai-editor-title">Script editor</span>
                <span class="jai-editor-mode">${existing ? 'Editing' : 'New script'}</span>
            </div>
            <div class="jai-editor-grid">
                <div class="jai-form-row">
                    <label class="jai-form-label" for="jai_editor_title">Title</label>
                    <input id="jai_editor_title" type="text" maxlength="100" />
                </div>
                <div class="jai-form-row">
                    <label class="jai-form-label" for="jai_editor_desc">Description</label>
                    <input id="jai_editor_desc" type="text" maxlength="500" />
                </div>
            </div>
            <div class="jai-form-row">
                <label class="jai-form-label" for="jai_editor_code">Script code</label>
                <div class="jai-editor-mount"></div>
            </div>
            <div class="jai-editor-hint">
                JavaScript — runs before every generation. Mutate
                <code>context.character.personality</code>, <code>context.character.scenario</code>,
                <code>context.chat.last_messages</code>, … — the changes apply to this turn's prompt only.
            </div>
        </div>
    `);
    editor.find('.jai-editor-mount').replaceWith(codeEditor.root);
    editor.find('#jai_editor_title').val(existing?.title ?? '');
    editor.find('#jai_editor_desc').val(existing?.description ?? '');

    const result = await callGenericPopup(editor, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Save',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    const patch = {
        title: editor.find('#jai_editor_title').val(),
        description: editor.find('#jai_editor_desc').val(),
        code: codeEditor.getValue(),
    };
    if (existing) {
        updateScript(existing.id, patch);
    } else {
        const created = addScript(patch);
        if (onCreated) {
            await onCreated(created);
        } else {
            // Default: auto-assign the new script to the selected character
            // (Janitor assigns scripts to the bot on creation).
            const context = getContext();
            if (context.characterId !== undefined) {
                await assignScript(context.characterId, created.id);
            }
        }
    }
    if (onChanged) {
        onChanged();
    } else if (extensionsPanel) {
        refreshAllSections(extensionsPanel);
    }
}

/**
 * Refreshes the Extensions settings panel from other UIs (e.g. after a script
 * was edited in the floating Scripts panel).
 */
export function refreshExtensionsPanel() {
    if (extensionsPanel) {
        refreshAllSections(extensionsPanel);
    }
}

// --- Import ---

function wireImportSection(panel) {
    const fileInput = panel.find('#jai_import_file');
    panel.find('#jai_import_file_button').on('click', () => fileInput.trigger('click'));
    fileInput.on('change', async function () {
        const files = Array.from(this.files ?? []);
        if (files.length === 0) {
            return;
        }
        const log = { warnings: [], books: [], scripts: 0 };
        for (const file of files) {
            try {
                await importFile(file, log);
            } catch (error) {
                log.warnings.push(`"${file.name}": ${error?.message ?? error}`);
            }
        }
        reportImportResult(log);
        refreshAllSections(panel);
        fileInput.val('');
    });

    panel.find('#jai_import_paste_button').on('click', async () => {
        const picked = await openPasteImportDialog();
        if (!picked) {
            return;
        }
        const log = { warnings: [], books: [], scripts: 0 };
        try {
            await detectAndImport(picked.text, picked.title, log);
        } catch (error) {
            log.warnings.push(`Import failed: ${error?.message ?? error}`);
        }
        reportImportResult(log);
        refreshAllSections(panel);
    });
}

/**
 * Paste-import dialog shared by the Extensions panel and the floating Scripts
 * panel. Highlighted, patcher-styled code box.
 *
 * @returns {Promise<{title: string, text: string}|null>} null when cancelled
 */
export async function openPasteImportDialog() {
    const codeEditor = createCodeEditor({
        height: 260,
        placeholder: '// JavaScript … or Janitor lorebook / script / bundle JSON',
        ariaLabel: 'Pasted script code or lorebook JSON',
    });
    const dialog = $(`
        <div class="jai-paste-dialog">
            <div class="jai-form-row">
                <label class="jai-form-label" for="jai_paste_title">Title <span class="jai-form-label-note">optional — used for the script or lorebook</span></label>
                <input id="jai_paste_title" type="text" maxlength="100" />
            </div>
            <div class="jai-form-row">
                <label class="jai-form-label">Paste JavaScript (Advanced script) or Janitor lorebook / script / bundle JSON</label>
                <div class="jai-editor-mount"></div>
            </div>
        </div>
    `);
    dialog.find('.jai-editor-mount').replaceWith(codeEditor.root);
    const result = await callGenericPopup(dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Import',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return null;
    }
    return {
        title: String(dialog.find('#jai_paste_title').val() ?? ''),
        text: codeEditor.getValue(),
    };
}

export function reportImportResult(log) {
    const parts = [];
    if (log.scripts > 0) {
        parts.push(`${log.scripts} script${log.scripts === 1 ? '' : 's'}`);
    }
    if (log.books.length > 0) {
        parts.push(`${log.books.length} lorebook${log.books.length === 1 ? '' : 's'} (${log.books.join(', ')})`);
    }
    if (parts.length === 0) {
        toastr.warning('Nothing was imported.', 'Janitor AI Script Bridge');
    } else {
        toastr.success(`Imported: ${parts.join(', ')}`, 'Janitor AI Script Bridge');
    }
    for (const warning of log.warnings) {
        toastr.warning(warning, 'Janitor AI Script Bridge');
    }
}

// --- Assignment (per character, ordered; supports group member picking) ---

// Shared with the floating Scripts panel so both UIs always edit the same
// group member's stacks.
let selectedGroupMemberChid = null;

export function getSelectedGroupMemberChid() {
    return selectedGroupMemberChid;
}

export function setSelectedGroupMemberChid(chid) {
    selectedGroupMemberChid = chid;
}

/**
 * Resolves which character the assignment section edits: the selected character
 * in solo chats, or the picked group member when a group chat is open.
 */
function getAssignmentTarget(context) {
    if (context.characterId !== undefined) {
        const character = context.characters[context.characterId];
        return character ? { chid: context.characterId, name: character.name } : null;
    }
    if (context.groupId && selectedGroupMemberChid !== null) {
        const character = context.characters[selectedGroupMemberChid];
        return character ? { chid: selectedGroupMemberChid, name: character.name } : null;
    }
    return null;
}

function wireAssignmentSection(panel) {
    panel.on('change', '#jai_group_member_select', function () {
        selectedGroupMemberChid = $(this).val() !== '' ? Number($(this).val()) : null;
        refreshAssignmentSection(panel);
    });

    panel.find('#jai_assign_add').on('click', async () => {
        const context = getContext();
        const target = getAssignmentTarget(context);
        if (!target) {
            toastr.warning('Select a character (or a group member) first.', 'Janitor AI Script Bridge');
            return;
        }
        const select = panel.find('#jai_assign_select');
        const scriptId = String(select.val() ?? '');
        if (!scriptId) {
            return;
        }
        try {
            await assignScript(target.chid, scriptId);
        } catch (error) {
            console.warn('[JaiBridge] Failed to assign script', error);
            toastr.error(`Assignment failed: ${error?.message ?? error}`, 'Janitor AI Script Bridge');
        }
        refreshAssignmentSection(panel);
    });

    panel.on('click', '.jai-unassign-script', async function () {
        const context = getContext();
        const target = getAssignmentTarget(context);
        if (!target) {
            return;
        }
        const id = String($(this).closest('.jai-assign-item').data('id'));
        try {
            await unassignScript(target.chid, id);
        } catch (error) {
            console.warn('[JaiBridge] Failed to unassign script', error);
            toastr.error(`Unassign failed: ${error?.message ?? error}`, 'Janitor AI Script Bridge');
        }
        refreshAssignmentSection(panel);
    });

    panel.find('#jai_assign_list').sortable({
        delay: getSortableDelay(),
        stop: async () => {
            const context = getContext();
            const target = getAssignmentTarget(context);
            if (!target) {
                return;
            }
            const ids = panel.find('#jai_assign_list .jai-assign-item')
                .map((_, element) => String($(element).data('id')))
                .get();
            try {
                await setAssignment(target.chid, ids);
            } catch (error) {
                console.warn('[JaiBridge] Failed to save stack order', error);
                toastr.error(`Saving the order failed: ${error?.message ?? error}`, 'Janitor AI Script Bridge');
            }
            refreshAssignmentSection(panel);
        },
    });
}

function refreshAssignmentSection(panel) {
    const context = getContext();
    const wrapper = panel.find('#jai_assignment_wrapper');
    const list = panel.find('#jai_assign_list');
    const select = panel.find('#jai_assign_select');
    const memberSelect = panel.find('#jai_group_member_select_wrapper');
    list.empty();
    select.empty();

    // Group chats: pick which member's stack to edit.
    if (context.characterId === undefined && context.groupId) {
        const group = (context.groups ?? []).find(candidate => candidate.id === context.groupId);
        const members = (group?.members ?? [])
            .map(avatar => ({ chid: (context.characters ?? []).findIndex(character => character.avatar === avatar), avatar }))
            .filter(member => member.chid !== -1);
        if (members.length > 0) {
            memberSelect.removeClass('jai-hidden');
            const current = memberSelect.find('#jai_group_member_select');
            if (selectedGroupMemberChid === null || !members.some(member => member.chid === selectedGroupMemberChid)) {
                selectedGroupMemberChid = members[0].chid;
            }
            current.empty();
            for (const member of members) {
                const name = context.characters[member.chid]?.name ?? member.avatar;
                current.append(`<option value="${member.chid}" ${member.chid === selectedGroupMemberChid ? 'selected' : ''}>${escapeHtml(name)}</option>`);
            }
        } else {
            memberSelect.addClass('jai-hidden');
        }
    } else {
        memberSelect.addClass('jai-hidden');
    }

    const target = getAssignmentTarget(context);
    if (!target) {
        wrapper.addClass('jai-hidden');
        return;
    }
    wrapper.removeClass('jai-hidden');

    panel.find('#jai_assign_char').text(target.name);

    const character = context.characters[target.chid];
    const assigned = getAssignedScripts(character);
    if (assigned.length === 0) {
        list.append('<div class="jai-empty">No scripts assigned. Scripts run in this order before every generation.</div>');
    }
    for (const script of assigned) {
        list.append($(`
            <div class="jai-assign-item" data-id="${escapeHtml(script.id)}">
                <span class="jai-order-icon"><i class="fa-solid fa-bars"></i></span>
                <span class="jai-assign-title" title="${escapeHtml(script.title)}">${escapeHtml(script.title)}</span>
                <button class="menu_button jai-unassign-script" title="Remove"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `));
    }

    const assignedIds = new Set(getAssignment(character));
    const available = getScripts().filter(script => !assignedIds.has(script.id));
    if (available.length === 0) {
        select.append('<option value="">No unassigned scripts</option>');
    } else {
        select.append('<option value="">Add script…</option>');
        for (const script of available) {
            select.append(`<option value="${escapeHtml(script.id)}">${escapeHtml(script.title)}</option>`);
        }
    }
}

// --- Imported lorebooks (Native / Bridge mode) ---

function wireBooksSection(panel) {
    panel.on('click', '.jai-export-book', async function () {
        try {
            await exportBookOriginal(String($(this).closest('.jai-book-item').data('name')));
        } catch (error) {
            console.warn('[JaiBridge] Book export failed', error);
            toastr.error(`Export failed: ${error?.message ?? error}`, 'Janitor AI Script Bridge');
        }
    });
    panel.on('click', '.jai-toggle-book-mode', async function () {
        const bookName = String($(this).closest('.jai-book-item').data('name'));
        const context = getContext();
        const target = getAssignmentTarget(context);
        if (!target) {
            toastr.warning('Select a character (or a group member) first.', 'Janitor AI Script Bridge');
            return;
        }
        const currentlyBridged = getBridgedBookNames(context.characters[target.chid]).includes(bookName);
        try {
            const applied = await setBookBridgeMode(target.chid, bookName, !currentlyBridged);
            if (!applied) {
                toastr.info(`"${bookName}" stays linked as it was.`, 'Janitor AI Script Bridge');
            }
        } catch (error) {
            console.warn('[JaiBridge] Book mode switch failed', error);
            toastr.error(`Mode switch failed: ${error?.message ?? error}`, 'Janitor AI Script Bridge');
        }
        refreshBooksSection(panel);
    });
    panel.on('click', '.jai-forget-book', async function () {
        const bookName = String($(this).closest('.jai-book-item').data('name'));
        const confirmed = await callGenericPopup(
            `Forget "${escapeHtml(bookName)}"? The World Info book itself is kept — Janitor bridge data is dropped and it becomes a plain book.`,
            POPUP_TYPE.CONFIRM,
        );
        if (confirmed === POPUP_RESULT.AFFIRMATIVE) {
            const context = getContext();
            const target = getAssignmentTarget(context);
            if (target) {
                try {
                    await removeBridgedBook(target.chid, bookName);
                } catch (error) {
                    console.warn('[JaiBridge] Failed to detach bridged book', error);
                }
            }
            await deleteConvertedBook(bookName);
            refreshBooksSection(panel);
        }
    });
}

function refreshBooksSection(panel) {
    const list = panel.find('#jai_book_list');
    list.empty();
    const context = getContext();
    const target = getAssignmentTarget(context);
    const bridgedNames = target
        ? new Set(getBridgedBookNames(context.characters[target.chid]))
        : new Set();
    const names = getBookProvenanceNames();
    if (names.length === 0) {
        list.append('<div class="jai-empty">No imported Janitor lorebooks yet.</div>');
    }
    for (const name of names) {
        const provenance = getBookProvenance(name);
        const isBridged = bridgedNames.has(name);
        list.append($(`
            <div class="jai-book-item" data-name="${escapeHtml(name)}">
                <span class="jai-book-title" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
                <span class="jai-badge ${isBridged ? 'bridged' : 'native'}">${isBridged ? 'Bridged' : 'Native'}</span>
                <span class="jai-book-meta">${provenance?.entryCount ?? 0} entries</span>
                <button class="menu_button jai-toggle-book-mode" title="Switch between Native (plain ST book) and Bridge mode (Janitor engine at runtime)"><i class="fa-solid fa-right-left"></i></button>
                <button class="menu_button jai-export-book" title="Re-export original Janitor JSON"><i class="fa-solid fa-file-export"></i></button>
                <button class="menu_button jai-forget-book" title="Forget bridge data / provenance"><i class="fa-solid fa-link-slash"></i></button>
            </div>
        `));
    }
}

// --- Options ---

function wireOptionsSection(panel) {
    panel.find('#jai_opt_injection').on('change', function () {
        setOption('injectionMode', String($(this).val()));
    });
    panel.find('#jai_opt_impersonate').on('change', function () {
        setOption('runOnImpersonate', $(this).prop('checked'));
    });
    panel.find('#jai_opt_debug').on('change', function () {
        setOption('debugCapture', $(this).prop('checked'));
        refreshOptionsSection(panel);
    });
    panel.find('#jai_opt_timeout').on('change', function () {
        const value = Math.max(50, Math.round(Number($(this).val()) || 500));
        setOption('scriptTimeoutMs', value);
        $(this).val(value);
    });
    panel.find('#jai_opt_depth').on('change', function () {
        const value = Math.min(10, Math.max(1, Math.round(Number($(this).val()) || 3)));
        setOption('defaultDepth', value);
        $(this).val(value);
    });
}

function refreshOptionsSection(panel) {
    const options = getOptions();
    panel.find('#jai_opt_injection').val(options.injectionMode);
    panel.find('#jai_opt_impersonate').prop('checked', options.runOnImpersonate);
    panel.find('#jai_opt_debug').prop('checked', options.debugCapture);
    panel.find('#jai_opt_timeout').val(options.scriptTimeoutMs);
    panel.find('#jai_opt_depth').val(options.defaultDepth);
    panel.find('#jai_debug_section').toggleClass('jai-hidden', !options.debugCapture);
}

// --- Debug ---

function wireDebugSection(panel) {
    panel.find('#jai_debug_view').on('click', () => {
        const report = getLastReport();
        if (!report) {
            toastr.info('No generation has run yet with debug capture enabled.', 'Janitor AI Script Bridge');
            return;
        }
        showReportPopup(report);
    });
}
