// Janitor AI Script Bridge — generation interceptor
//
// This module implements `JaiRunScripts`, registered via the manifest's
// `generate_interceptor` field. SillyTavern awaits it inside Generate() AFTER
// the user message is in the chat but BEFORE prompt assembly and BEFORE the
// World Info scan (script.js:4562) — the exact equivalent of Janitor's
// "User → Script → LLM" execution slot. It runs for normal sends, swipes,
// regenerates, continues, and once per member in group chats.
//
// Pipeline (this extension declares loading_order 1000, i.e. it runs LAST
// among generate-interceptor extensions — after e.g. Vector Storage (100) and
// Image Generation (10) have already rearranged/triggered):
//   1. drain leftovers from an earlier generation (safety)
//   2. build the Janitor context facade (whole chat in last_messages) and run
//      the character's assigned Advanced scripts in stack order, then the
//      chat's overlay stack (both scope-ordered, deduped), sharing one
//      context — later scripts see earlier scripts' edits ("breadcrumbs")
//   3. apply the script results for this generation only:
//      - faithful mode: temporarily write character field results into the
//        in-memory card fields (Janitor splices them into
//        <Char's Persona>/<Scenario>/...)
//      - ephemeral mode: inject the appended text as an extension prompt
//   4. restore everything once the prompt for this generation has been
//      materialized (CHAT_COMPLETION_PROMPT_READY / GENERATE_AFTER_COMBINE_PROMPTS),
//      with GENERATION_ENDED/STOPPED and CHAT_CHANGED as safety nets.
//
// Strict Janitor parity: scripts CANNOT edit or remove chat messages —
// mutations to context.chat.last_messages / context.chat.last_message are
// ignored. Lorebook conversion happens at import time only (native ST book).

import { eventSource, event_types } from '/scripts/events.js';
import { setExtensionPrompt, extension_prompt_types } from '/script.js';
import { getContext } from '/scripts/st-context.js';
import { buildContext, snapshotSeeds, fieldDiff } from './context.js';
import { runScript } from './runner.js';
import {
    getOptions, getAssignedScripts, getChatAssignedScripts, getScript, getSettings, setLastReport, CONTEXT_CHAR_FIELDS,
} from './storage.js';

// Restores that are still pending. ST serializes generations, so at most one
// entry lives here at a time — the array guards against missed events.
let pending = [];

let listenersRegistered = false;

export function registerInterceptorHooks() {
    if (listenersRegistered) {
        return;
    }
    listenersRegistered = true;

    // Primary restore points: the prompt for this generation has been fully
    // materialized at both events, so the temporary character mutations and WI
    // toggles can never influence the request anymore. WI scan and story string
    // assembly both happen strictly before these events.
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, () => restorePending());
    eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, () => restorePending());

    // Safety nets: end of every generation (also error paths), manual stop,
    // and switching chats while a generation is somehow still open.
    eventSource.on(event_types.GENERATION_ENDED, () => restorePending());
    eventSource.on(event_types.GENERATION_STOPPED, () => restorePending());
    eventSource.on(event_types.CHAT_CHANGED, () => restorePending());
}

export function restorePending() {
    while (pending.length > 0) {
        const item = pending.pop();
        for (const snapshot of item.snapshots ?? []) {
            try {
                snapshot.character[snapshot.field] = snapshot.prev;
            } catch (error) {
                console.warn('[JaiBridge] Failed to restore character field', snapshot.field, error);
            }
        }
        for (const key of item.ephemeralKeys ?? []) {
            try {
                setExtensionPrompt(key, '', extension_prompt_types.IN_PROMPT, 1);
            } catch (error) {
                console.warn('[JaiBridge] Failed to clear extension prompt', key, error);
            }
        }
    }
}

/**
 * The generate interceptor. Registered as globalThis.JaiRunScripts via the
 * manifest. Signature per extensions.js:runGenerationInterceptors.
 *
 * @param {object[]} coreChat Prompt-destined shallow copies of the chat messages
 * @param {number} _contextSize Maximum context size (unused)
 * @param {(immediately?: boolean) => void} _abort Abort callback (unused)
 * @param {string} type Generation type ('normal'|'swipe'|'regenerate'|'continue'|'impersonate'|'quiet'|...)
 * @returns {Promise<void>}
 */
export async function JaiRunScripts(coreChat, _contextSize, _abort, type) {
    const options = getOptions();

    // Janitor runs scripts "before every bot reply". Impersonation produces a
    // user-side draft, and quiet generations are background prompts (e.g.
    // summarization) — neither exists on Janitor, so they are skipped.
    if (type === 'quiet') {
        return;
    }
    if (type === 'impersonate' && !options.runOnImpersonate) {
        return;
    }

    // Safety: if an earlier generation never hit a restore event, undo it now.
    restorePending();

    const context = getContext();
    const chid = context.characterId;
    const character = chid !== undefined ? context.characters[chid] : null;
    if (!character) {
        return;
    }

    const report = {
        timestamp: new Date().toISOString(),
        type,
        character: character.name,
        skipped: null,
        runs: [],
        injection: { mode: options.injectionMode, fields: [] },
    };

    // 1. Scripts to run, in order: the character's stack (Janitor's bot-level
    //    scripts) first, then this chat's overlay stack. A script attached to
    //    both scopes runs once, at its character-stack position.
    const scripts = buildRunList(character);
    if (scripts.length === 0) {
        report.skipped = 'No enabled scripts attached to this character or chat.';
        finishReport(report);
        return;
    }

    // 2. Shared context facade — later scripts see earlier scripts' edits
    //    ("breadcrumbs"). last_messages holds the WHOLE chat: on Janitor the
    //    Message Depth setting does not limit it, scripts self-limit.
    const seedsSource = buildContext(coreChat ?? [], character);
    const seeds = snapshotSeeds(seedsSource);
    const contextFacade = seedsSource;

    let allOk = true;

    for (const script of scripts) {
        const started = Date.now();
        let result;
        try {
            result = await runScript(script.code, contextFacade, options.scriptTimeoutMs);
        } catch (error) {
            result = { ok: false, error: error?.message ?? String(error), logs: [], context: contextFacade, timedOut: false, strategy: 'unknown' };
        }

        // Shared mutations: keep running scripts against the returned context.
        if (result && result.context && typeof result.context === 'object') {
            Object.assign(contextFacade, result.context);
        }

        const changes = {};
        for (const [contextField] of CONTEXT_CHAR_FIELDS) {
            const diff = fieldDiff(seeds[contextField], contextFacade.character[contextField]);
            if (diff) {
                changes[contextField] = diff;
            }
        }

        allOk = allOk && !!result?.ok;
        report.runs.push({
            id: script.id,
            title: script.title,
            scope: script.scope,
            ok: !!result?.ok,
            error: result?.error ?? null,
            timedOut: !!result?.timedOut,
            strategy: result?.strategy ?? 'unknown',
            durationMs: Date.now() - started,
            logs: result?.logs ?? [],
            changes,
        });
    }

    // 3. Injection for this generation only.
    const { snapshots, ephemeralKeys } = applyInjection(character, contextFacade, seeds, report);

    finishReport(report);

    pending.push({ snapshots, ephemeralKeys });

    if (!allOk) {
        // Janitor runs each script independently and swallows errors; we have
        // already isolated every run, so generation continues regardless.
        console.debug(`[JaiBridge] ${report.runs.filter(run => !run.ok).length} script(s) reported errors for ${character.name}.`);
    }
}

/**
 * Builds the ordered run list for a generation: the character's stack
 * (scope 'char') first, then the chat's overlay stack (scope 'chat'), with
 * duplicates removed — a script attached to both scopes runs once, at its
 * character-stack position.
 */
function buildRunList(character) {
    const charScripts = getAssignedScripts(character)
        .map(script => ({ ...script, scope: 'char' }))
        .filter(script => script.enabled);
    const chatScripts = getChatAssignedScripts()
        .map(script => ({ ...script, scope: 'chat' }))
        .filter(script => script.enabled);
    const seen = new Set(charScripts.map(script => script.id));
    return [...charScripts, ...chatScripts.filter(script => !seen.has(script.id))];
}

function applyInjection(character, contextFacade, seeds, report) {
    const options = getOptions();
    const snapshots = [];
    const ephemeralKeys = [];

    for (const [contextField, charField] of CONTEXT_CHAR_FIELDS) {
        const final = String(contextFacade.character[contextField] ?? '');
        const seed = String(seeds[contextField] ?? '');
        if (final === seed) {
            continue;
        }

        const diff = fieldDiff(seed, final);
        report.injection.fields.push({ field: contextField, diff });

        if (options.injectionMode === 'faithful') {
            // Janitor forwards the final values into the prompt sections for
            // this generation. Same here: mutate the in-memory card fields,
            // restore once the prompt has been built.
            snapshots.push({ character, field: charField, prev: String(character[charField] ?? '') });
            character[charField] = final;
        } else {
            // Ephemeral fallback: append the added text as an extension prompt.
            const delta = seed !== '' && final.startsWith(seed) ? final.slice(seed.length) : final;
            const key = `jaiBridge_${charField}`;
            setExtensionPrompt(key, delta, extension_prompt_types.IN_PROMPT, 1);
            ephemeralKeys.push(key);
        }
    }

    return { snapshots, ephemeralKeys };
}


function finishReport(report) {
    if (getOptions().debugCapture) {
        setLastReport(report);
    }
    console.debug('[JaiBridge] Generation report', report);
}

/**
 * Dry-run helper for /jai-test: builds the facade from the live chat and runs
 * scripts WITHOUT injecting anything or touching the WI books.
 *
 * @param {object} character ST character
 * @param {number|null} scriptId Specific script id, or null for all assigned
 * @returns {Promise<object>} Debug report
 */
export async function testRunScripts(character, scriptId = null) {
    const context = getContext();
    const chat = context.chat ?? [];

    // Mirror the interceptor's view of the chat (coreChat skips system messages).
    const coreChatLike = chat
        .filter(message => !message.is_system)
        .map(message => ({
            mes: message.mes,
            is_user: message.is_user,
            send_date: message.send_date,
        }));

    const options = getOptions();
    const scripts = scriptId !== null
        ? ([getScript(scriptId)].filter(Boolean).map(script => ({ ...script, scope: 'test' })))
        : buildRunList(character);

    const report = {
        timestamp: new Date().toISOString(),
        type: 'test',
        character: character.name,
        skipped: null,
        runs: [],
        injection: { mode: 'none (test run)', fields: [] },
    };

    if (scripts.length === 0) {
        report.skipped = 'No (enabled) scripts to run.';
        finishReport(report);
        return report;
    }

    const contextFacade = buildContext(coreChatLike, character);
    const seeds = snapshotSeeds(contextFacade);

    for (const script of scripts) {
        const started = Date.now();
        let result;
        try {
            result = await runScript(script.code, contextFacade, options.scriptTimeoutMs);
        } catch (error) {
            result = { ok: false, error: error?.message ?? String(error), logs: [], context: contextFacade, timedOut: false, strategy: 'unknown' };
        }
        if (result?.context && typeof result.context === 'object') {
            Object.assign(contextFacade, result.context);
        }

        const changes = {};
        for (const [contextField] of CONTEXT_CHAR_FIELDS) {
            const diff = fieldDiff(seeds[contextField], contextFacade.character[contextField]);
            if (diff) {
                changes[contextField] = diff;
            }
        }

        report.runs.push({
            id: script.id,
            title: script.title,
            ok: !!result?.ok,
            error: result?.error ?? null,
            timedOut: !!result?.timedOut,
            strategy: result?.strategy ?? 'unknown',
            durationMs: Date.now() - started,
            logs: result?.logs ?? [],
            changes,
        });
    }

    finishReport(report);
    return report;
}

// Convenience for slash commands / UI.
export function getSettingsSnapshot() {
    return getSettings();
}
