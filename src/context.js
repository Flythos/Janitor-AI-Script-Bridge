// Janitor AI Script Bridge — context facade
//
// Builds the global `context` object that Janitor AI scripts expect, from
// SillyTavern's coreChat (the prompt-destined message copies passed to the
// generate interceptor) and the active character.
//
// Verified Janitor API surface (help.janitorai.com + FcGod guide + user testing):
//   context.character.{name, chat_name, personality*, scenario*, example_dialogs*}
//     - Janitor `personality` corresponds to ST's "Description" block
//   context.chat.{last_message, last_messages[], message_count,
//                 first_message_date, last_bot_message_date}
//     - last_messages INCLUDES the just-sent user message (latest = user)
//     - message objects carry {is_bot, role: 'user'|'assistant', date, message}
//     - message_count = total messages (not turns), counts the just-sent message,
//       swipes not counted
//     - `last_user_message` does NOT exist on Janitor (user-verified) — not emulated
//   (*) writable — final values are spliced into the prompt for the current
//       generation only; the character card itself is never changed.
//   Chat message mutation does NOT work on Janitor (user-verified): messages
//   cannot be edited or removed by scripts. The facade exposes last_messages
//   read-only — script mutations are ignored, exactly like on Janitor.
//   The Message Depth (1-10) setting does NOT limit last_messages — scripts see
//   the whole chat and self-limit. It only determines the LOREBOOK scan depth
//   of converted books.

// Mapping: [field on context.character (Janitor name), field on the ST character card]
// Verified against Janitor behavior: Janitor's `personality` is the block ST
// calls "Description" (emptying it empties ST's Description for that turn).
export const CONTEXT_CHAR_FIELDS = [
    ['personality', 'description'],
    ['scenario', 'scenario'],
    ['example_dialogs', 'mes_example'],
];

export const JANITOR_MESSAGE_SHAPE = '{ is_bot: boolean, date: string, message: string }';

/**
 * Builds a fresh, JSON-pure Janitor context facade.
 *
 * @param {object[]} coreChat ST coreChat entries ({mes, is_user, send_date, ...})
 * @param {object} character  ST character object (card fields are read for the seeds)
 * @returns {object} context  Mutable Janitor context; scripts mutate this object
 */
export function buildContext(coreChat, character) {
    const messages = (coreChat ?? []).map(message => ({
        is_bot: !message.is_user,
        role: message.is_user ? 'user' : 'assistant',
        date: String(message.send_date ?? ''),
        message: String(message.mes ?? ''),
    }));

    // No depth cap: on Janitor, scripts see the whole chat in last_messages and
    // self-limit; the Message Depth setting only affects lorebook scan depth.
    const lastBot = findLast(coreChat ?? [], message => !message.is_user);

    const context = {
        character: {},
        chat: {
            last_message: messages.at(-1)?.message ?? '',
            last_messages: messages,
            message_count: (coreChat ?? []).length,
            first_message_date: String((coreChat ?? [])[0]?.send_date ?? ''),
            last_bot_message_date: String(lastBot?.send_date ?? ''),
        },
    };

    // Writable character fields, seeded from the card.
    for (const [contextField, charField] of CONTEXT_CHAR_FIELDS) {
        context.character[contextField] = String(character?.[charField] ?? '');
    }

    // Read-only identity fields (Janitor exposes these too; scripts only read them).
    context.character.name = String(character?.name ?? '');
    context.character.chat_name = String(character?.name ?? '');

    return context;
}

/**
 * Snapshot of the seeded character fields, used to detect what a script changed
 * and to restore the card values after the prompt has been materialized.
 *
 * @param {object} context Janitor context facade
 * @returns {object} { contextField: seedString }
 */
export function snapshotSeeds(context) {
    const seeds = {};
    for (const [contextField] of CONTEXT_CHAR_FIELDS) {
        seeds[contextField] = String(context.character[contextField] ?? '');
    }
    return seeds;
}

/**
 * Human-readable diff of one field, for the debug report.
 */
export function fieldDiff(seed, final) {
    seed = String(seed ?? '');
    final = String(final ?? '');
    if (seed === final) {
        return null;
    }
    if (final.startsWith(seed)) {
        return `+ appended: ${JSON.stringify(final.slice(seed.length))}`;
    }
    if (seed === '') {
        return `+ set: ${JSON.stringify(final)}`;
    }
    return `~ replaced:\n  - before: ${JSON.stringify(seed)}\n  - after: ${JSON.stringify(final)}`;
}


function findLast(array, predicate) {
    for (let index = array.length - 1; index >= 0; index--) {
        if (predicate(array[index])) {
            return array[index];
        }
    }
    return null;
}
