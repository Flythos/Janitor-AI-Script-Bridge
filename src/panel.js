// Janitor AI Script Bridge — floating "Scripts" panel
//
// Mirrors the Author's Note UX: a "Scripts" entry in the options menu (the
// three-bars popup below the chat) opens a floating, draggable panel with two
// ordered stacks:
//   - "Scripts for this chat"   — saved to the chat (chat_metadata), applies to
//     every generation in this chat, shared by all group members
//   - "Scripts for <character>" — saved on the character card
//     (data.extensions), Janitor's bot-level script stack
// Each section imports scripts (auto-attaching them to that scope), attaches
// library scripts, drag-sorts its run order, and edits/unassigns rows.
//
// Run order at generation time: character stack first, then chat stack.

import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { getContext } from '/scripts/st-context.js';
import { animation_duration } from '/script.js';
import { escapeHtml, getSortableDelay, delay } from '/scripts/utils.js';
import { dragElement } from '/scripts/RossAscends-mods.js';
import { loadMovingUIState } from '/scripts/power-user.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';
import {
    getScripts, toggleScript,
    getChatAssignment, getChatAssignedScripts, assignChatScript, unassignChatScript, setChatAssignment,
    getAssignment, getAssignedScripts, assignScript, unassignScript, setAssignment,
} from './storage.js';
import { detectAndImport, importFile } from './importer.js';
import { getExtensionName, openScriptEditor, refreshExtensionsPanel, reportImportResult } from './ui.js';

// `$` (jQuery) and `toastr` are page-level globals provided by SillyTavern.

let panelElement = null;
let initialized = false;
let selectedGroupMemberChid = null;

/**
 * Appends the "Scripts" entry to the options menu and builds the panel.
 */
export async function initScriptsPanel() {
    if (initialized) {
        return;
    }
    initialized = true;

    // Menu entry, right below "Author's Note" — same markup as the built-ins
    // (.options-content styles its <a> children automatically).
    if ($('#option_toggle_jai').length === 0) {
        $('#option_toggle_AN').after(`
            <a id="option_toggle_jai" title="Janitor AI Script Bridge">
                <i class="fa-lg fa-solid fa-scroll"></i>
                <span>Scripts</span>
            </a>
        `);
    }

    const template = await renderExtensionTemplateAsync(getExtensionName(), 'templates/panel');
    panelElement = $(template);
    $('#movingDivs').append(panelElement);

    wirePanel();
    loadMovingUIState();
    dragElement(panelElement);

    $('#option_toggle_jai').on('click', onMenuItemClick);

    // Re-render when the chat (and with it the chat metadata) changes.
    const { eventSource, event_types } = await import('/scripts/events.js');
    eventSource.on(event_types.CHAT_CHANGED, () => {
        selectedGroupMemberChid = null;
        refreshPanel();
    });
}

function onMenuItemClick() {
    const context = getContext();
    // Same guard as Author's Note: without a character or group there is no
    // chat to scope anything to.
    if (context.characterId === undefined && !context.groupId) {
        toastr.warning('Select a character before trying to use Scripts', '', { timeOut: 2000 });
        return;
    }

    // Close the options menu — our item is appended after ST has bound its own
    // menu dispatcher, so the menu would otherwise stay open.
    $('#options').hide();

    // Toggle like the Author's Note panel does.
    const $panel = panelElement;
    if ($panel.css('display') !== 'flex') {
        $panel.addClass('resizing');
        $panel.css('display', 'flex');
        $panel.css('opacity', 0.0);
        $panel.transition({
            opacity: 1.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            $panel.removeClass('resizing');
        });
        refreshPanel();
    } else {
        $panel.addClass('resizing');
        $panel.transition({
            opacity: 0.0,
            duration: animation_duration,
        }, async function () {
            await delay(50);
            $panel.removeClass('resizing');
        });
        setTimeout(function () {
            $panel.hide();
        }, animation_duration);
    }
}

function wirePanel() {
    const panel = panelElement;

    panel.find('#jaiScriptsPanelClose').on('click', function () {
        panel.transition({
            opacity: 0,
            duration: animation_duration,
            easing: 'ease-in-out',
        });
        setTimeout(function () {
            panel.hide();
        }, animation_duration);
    });

    // --- Chat stack ---
    panel.find('#jai_panel_chat_add').on('click', () => {
        const scriptId = String(panel.find('#jai_panel_chat_select').val() ?? '');
        if (scriptId) {
            assignChatScript(scriptId);
            refreshPanel();
        }
    });
    panel.find('#jai_panel_chat_import').on('click', () => panel.find('#jai_panel_chat_file').trigger('click'));
    panel.find('#jai_panel_chat_file').on('change', async function () {
        const files = Array.from(this.files ?? []);
        this.value = '';
        const { log, createdIds } = await importFiles(files);
        for (const id of createdIds) {
            assignChatScript(id);
        }
        reportImportResult(log);
        refreshPanel();
    });
    panel.find('#jai_panel_chat_paste').on('click', async () => {
        const { log, createdIds } = await pasteImport();
        if (!log) {
            return;
        }
        for (const id of createdIds) {
            assignChatScript(id);
        }
        reportImportResult(log);
        refreshPanel();
    });
    panel.on('click', '#jai_panel_chat_list .jai-unassign-script', function () {
        unassignChatScript(String($(this).closest('.jai-assign-item').data('id')));
        refreshPanel();
    });
    panel.on('click', '#jai_panel_chat_list .jai-edit-script', function () {
        openScriptEditor(String($(this).closest('.jai-assign-item').data('id')), {
            onChanged: () => {
                refreshExtensionsPanel();
                refreshPanel();
            },
        });
    });
    panel.on('change', '#jai_panel_chat_list .jai-enable-script', function () {
        toggleScript(String($(this).closest('.jai-assign-item').data('id')));
        refreshExtensionsPanel();
    });
    panel.find('#jai_panel_chat_list').sortable({
        delay: getSortableDelay(),
        stop: () => {
            setChatAssignment(readListOrder('#jai_panel_chat_list'));
            refreshPanel();
        },
    });

    // --- Character stack ---
    panel.on('change', '#jai_panel_member_select', function () {
        selectedGroupMemberChid = $(this).val() !== '' ? Number($(this).val()) : null;
        refreshCharSection();
    });
    panel.find('#jai_panel_char_add').on('click', async () => {
        const target = getAssignmentTarget();
        const scriptId = String(panel.find('#jai_panel_char_select').val() ?? '');
        if (target && scriptId) {
            await assignScript(target.chid, scriptId);
            refreshPanel();
        }
    });
    panel.find('#jai_panel_char_import').on('click', () => panel.find('#jai_panel_char_file').trigger('click'));
    panel.find('#jai_panel_char_file').on('change', async function () {
        const files = Array.from(this.files ?? []);
        this.value = '';
        const target = getAssignmentTarget();
        if (!target) {
            return;
        }
        const { log, createdIds } = await importFiles(files);
        for (const id of createdIds) {
            await assignScript(target.chid, id);
        }
        reportImportResult(log);
        refreshPanel();
    });
    panel.find('#jai_panel_char_paste').on('click', async () => {
        const { log, createdIds } = await pasteImport();
        if (!log) {
            return;
        }
        const target = getAssignmentTarget();
        if (target) {
            for (const id of createdIds) {
                await assignScript(target.chid, id);
            }
        }
        reportImportResult(log);
        refreshPanel();
    });
    panel.on('click', '#jai_panel_char_list .jai-unassign-script', async function () {
        const target = getAssignmentTarget();
        if (!target) {
            return;
        }
        await unassignScript(target.chid, String($(this).closest('.jai-assign-item').data('id')));
        refreshPanel();
    });
    panel.on('click', '#jai_panel_char_list .jai-edit-script', function () {
        openScriptEditor(String($(this).closest('.jai-assign-item').data('id')), {
            onChanged: () => {
                refreshExtensionsPanel();
                refreshPanel();
            },
        });
    });
    panel.on('change', '#jai_panel_char_list .jai-enable-script', function () {
        toggleScript(String($(this).closest('.jai-assign-item').data('id')));
        refreshExtensionsPanel();
    });
    panel.find('#jai_panel_char_list').sortable({
        delay: getSortableDelay(),
        stop: async () => {
            const target = getAssignmentTarget();
            if (!target) {
                return;
            }
            await setAssignment(target.chid, readListOrder('#jai_panel_char_list'));
            refreshPanel();
        },
    });
}

// --- Import helpers ---

/**
 * Imports files through the shared import pipeline and returns the library ids
 * created by it, so the caller can attach them to a scope. Lorebook imports
 * produce World Info books (not scripts) and only appear in the log.
 */
async function importFiles(files) {
    const before = new Set(getScriptIds());
    const log = { warnings: [], books: [], scripts: 0 };
    for (const file of files) {
        try {
            await importFile(file, log);
        } catch (error) {
            log.warnings.push(`"${file?.name}": ${error?.message ?? error}`);
        }
    }
    return { log, createdIds: getScriptIds().filter(id => !before.has(id)) };
}

/**
 * Paste-import dialog (same as the Extensions panel's). Resolves with the
 * created script ids; log is null when the dialog was cancelled.
 */
async function pasteImport() {
    const dialog = $(`
        <div>
            <label for="jai_paste_title">Title (optional — used for the script or lorebook)</label>
            <input id="jai_paste_title" type="text" maxlength="100" />
            <label for="jai_paste_area">Paste JavaScript (Advanced script) or Janitor lorebook / script / bundle JSON here:</label>
            <textarea id="jai_paste_area" spellcheck="false"></textarea>
        </div>
    `);
    const result = await callGenericPopup(dialog, POPUP_TYPE.CONFIRM, '', {
        okButton: 'Import',
        cancelButton: 'Cancel',
        wide: true,
        large: true,
    });
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return { log: null, createdIds: [] };
    }
    const text = String(dialog.find('#jai_paste_area').val() ?? '');
    const title = String(dialog.find('#jai_paste_title').val() ?? '');
    const before = new Set(getScriptIds());
    const log = { warnings: [], books: [], scripts: 0 };
    await detectAndImport(text, title, log);
    return { log, createdIds: getScriptIds().filter(id => !before.has(id)) };
}

function getScriptIds() {
    return getScripts().map(script => script.id);
}

// --- Rendering ---

function refreshPanel() {
    if (!panelElement || panelElement.css('display') === 'none') {
        return;
    }
    refreshChatSection();
    refreshCharSection();
}

function refreshChatSection() {
    const list = panelElement.find('#jai_panel_chat_list');
    const select = panelElement.find('#jai_panel_chat_select');
    list.empty();
    select.empty();

    const assigned = getChatAssignedScripts();
    if (assigned.length === 0) {
        list.append('<div class="jai-empty">No scripts attached to this chat yet.</div>');
    }
    for (const script of assigned) {
        list.append(rowHtml(script));
    }

    const assignedIds = new Set(getChatAssignment());
    fillSelect(select, getScripts().filter(script => !assignedIds.has(script.id)));
}

function refreshCharSection() {
    const context = getContext();
    const memberWrapper = panelElement.find('#jai_panel_member_wrapper');
    const list = panelElement.find('#jai_panel_char_list');
    const select = panelElement.find('#jai_panel_char_select');
    list.empty();
    select.empty();

    // Group chats: pick which member's stack to edit.
    if (context.characterId === undefined && context.groupId) {
        const group = (context.groups ?? []).find(candidate => candidate.id === context.groupId);
        const members = (group?.members ?? [])
            .map(avatar => ({ chid: (context.characters ?? []).findIndex(character => character.avatar === avatar) }))
            .filter(member => member.chid !== -1);
        if (members.length > 0) {
            memberWrapper.removeClass('jai-hidden');
            if (selectedGroupMemberChid === null || !members.some(member => member.chid === selectedGroupMemberChid)) {
                selectedGroupMemberChid = members[0].chid;
            }
            const memberSelect = memberWrapper.find('#jai_panel_member_select');
            memberSelect.empty();
            for (const member of members) {
                const name = context.characters[member.chid]?.name ?? member.avatar;
                memberSelect.append(`<option value="${member.chid}" ${member.chid === selectedGroupMemberChid ? 'selected' : ''}>${escapeHtml(name)}</option>`);
            }
        } else {
            memberWrapper.addClass('jai-hidden');
        }
    } else {
        memberWrapper.addClass('jai-hidden');
    }

    const target = getAssignmentTarget();
    if (!target) {
        panelElement.find('#jai_panel_char_name').text('');
        list.append('<div class="jai-empty">No character selected.</div>');
        fillSelect(select, []);
        return;
    }

    panelElement.find('#jai_panel_char_name').text(target.name);

    const character = context.characters[target.chid];
    const assigned = getAssignedScripts(character);
    if (assigned.length === 0) {
        list.append('<div class="jai-empty">No scripts attached to this character yet.</div>');
    }
    for (const script of assigned) {
        list.append(rowHtml(script));
    }

    const assignedIds = new Set(getAssignment(character));
    fillSelect(select, getScripts().filter(script => !assignedIds.has(script.id)));
}

function rowHtml(script) {
    return $(`
        <div class="jai-assign-item ${script.enabled ? '' : 'jai-disabled-script'}" data-id="${escapeHtml(script.id)}">
            <span class="jai-order-icon"><i class="fa-solid fa-bars"></i></span>
            <input class="jai-enable-script" type="checkbox" ${script.enabled ? 'checked' : ''} title="Enabled" />
            <span class="jai-assign-title" title="${escapeHtml(script.description || script.title)}">${escapeHtml(script.title)}</span>
            <button class="menu_button jai-edit-script" title="Edit code"><i class="fa-solid fa-pencil"></i></button>
            <button class="menu_button jai-unassign-script" title="Remove from this stack"><i class="fa-solid fa-xmark"></i></button>
        </div>
    `);
}

function fillSelect(select, available) {
    if (available.length === 0) {
        select.append('<option value="">No unassigned scripts</option>');
        return;
    }
    select.append('<option value="">Add script…</option>');
    for (const script of available) {
        select.append(`<option value="${escapeHtml(script.id)}">${escapeHtml(script.title)}</option>`);
    }
}

// --- Shared helpers ---

/**
 * Which character the character-stack section edits: the selected character in
 * solo chats, or the picked group member when a group chat is open.
 */
function getAssignmentTarget() {
    const context = getContext();
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

function readListOrder(listSelector) {
    return panelElement.find(`${listSelector} .jai-assign-item`)
        .map((_, element) => String($(element).data('id')))
        .get();
}
