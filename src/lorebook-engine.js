// Janitor AI Script Bridge — Janitor lorebook engine (pure, no ST imports)
//
// Runtime engine for lorebooks imported in **Bridge mode**: instead of letting
// SillyTavern's World Info scan activate entries, this module re-implements
// Janitor's lorebook semantics against the chat and hands back ready-made
// content blocks that the interceptor splices into the character fields for
// exactly one generation (same injection/restore path as script results).
//
// Implemented Janitor behaviors (verified against the entry editor UI and a
// real 90-entry export):
//   - constant entries ("Always include this entry")
//   - literal keys with Match Whole Words (Janitor default ON) / Case Sensitive
//   - regex keys ("/pattern/flags" embedded in the key list)
//   - secondary keys with the 4 logic modes (numeric enum = ST world_info_logic)
//   - per-entry Depth ("how many messages to search") over the most recent
//     user+bot messages, falling back to the book's Depth setting
//   - Min Messages = total chat message count (incl. the just-sent message)
//   - Probability % rerolled per generation (send/swipe)
//   - inclusion groups: ONE entry per group — weighted random by Group Weight
//     (Janitor default) or insertion-order priority ("prioritizeInclusion")
//   - Placement Default/Personality/Scenario/Example msg × Before/After
//     (Default = after personality); ordering within a block mirrors ST's
//     within-block convention (higher order = closer to the anchored section)
//
// Known deviations (documented in the README): keyMatchPriority is not
// emulated; per-entry activationScript is ignored; entries are read from the
// original Janitor records stored in the book file (the visible ST copy is
// view-only).

import { normalizeJanitorEntry, compileRegexKey } from './janitor-format.js';

/** Anchor keys of the returned blocks, in Janitor placement terms. */
export const LOREBOOK_ANCHORS = {
    personalityBefore: 'personality before',
    personalityAfter: 'personality after',
    scenarioBefore: 'scenario before',
    scenarioAfter: 'scenario after',
    exampleBefore: 'example messages before',
    exampleAfter: 'example messages after',
};

const DEFAULT_BOOK_DEPTH = 3;
const MIN_WEIGHT = 1;
const MIN_ORDER = 100; // Janitor's insertion_order default

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampDepth(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_BOOK_DEPTH;
    }
    return Math.max(1, Math.min(10, Math.round(parsed)));
}

/**
 * Builds the regex that matches one literal key against the scan window.
 * Mirrors ST's whole-word handling: \b boundaries (which only work for keys
 * that start/end on word characters — same caveat as ST's native matching).
 */
function literalKeyRegex(key, record) {
    const flags = record.caseSensitive ? 'u' : 'iu';
    const body = escapeRegExp(key);
    const pattern = record.matchWholeWords ? `\\b(?:${body})\\b` : body;
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}

/**
 * Checks the secondary-key condition for one record against the window text.
 * Logic values are the ST/Janitor numeric enum:
 * 0 = AND ANY, 1 = NOT ALL, 2 = NOT ANY, 3 = AND ALL.
 *
 * @param {Map<string, RegExp|null>} secondaryMatchers key → compiled regex
 */
function secondaryKeysPass(record, windowText, secondaryMatchers) {
    if (!record.secondary || record.secondary.length === 0) {
        return { pass: true };
    }
    const results = record.secondary.map(key => !!secondaryMatchers.get(key)?.test(windowText));
    const matchedCount = results.filter(Boolean).length;
    switch (record.secondaryLogic) {
        case 0: // AND ANY — at least one secondary key must match
            return matchedCount > 0 ? { pass: true } : { pass: false, reason: 'secondary keys: none matched (AND ANY)' };
        case 1: // NOT ALL — not all secondary keys may match
            return matchedCount < results.length ? { pass: true } : { pass: false, reason: 'secondary keys: all matched (NOT ALL)' };
        case 2: // NOT ANY — no secondary key may match
            return matchedCount === 0 ? { pass: true } : { pass: false, reason: 'secondary keys: one matched (NOT ANY)' };
        case 3: // AND ALL — every secondary key must match
            return matchedCount === results.length ? { pass: true } : { pass: false, reason: 'secondary keys: not all matched (AND ALL)' };
        default:
            return { pass: true };
    }
}

/**
 * Resolves inclusion groups among the surviving candidates: one winner per
 * group label. Weighted random by Group Weight is Janitor's default;
 * "prioritizeInclusion" switches the group to insertion-order priority
 * (lowest insertion_order wins — the first entry in insertion sequence).
 *
 * @returns {{rejected: Map<object, string>, winners: Map<object, string>}}
 *   rejected: per losing candidate → reason; winners: per winning candidate → reason
 */
function resolveInclusionGroups(candidates, rng) {
    const rejected = new Map();
    const winners = new Map();
    const byLabel = new Map();
    for (const candidate of candidates) {
        for (const label of candidate.record.groupLabels) {
            if (!byLabel.has(label)) {
                byLabel.set(label, []);
            }
            byLabel.get(label).push(candidate);
        }
    }

    for (const [label, group] of byLabel) {
        if (group.length <= 1) {
            continue;
        }
        // Any entry opting for insertion-order priority makes the whole group
        // deterministic (matches the checkbox's "instead of weight" wording).
        const byOrder = group.some(candidate => candidate.record.groupMode === 'byOrder');
        let winnerIndex;
        if (byOrder) {
            winnerIndex = 0;
            for (let index = 1; index < group.length; index++) {
                if (group[index].record.order < group[winnerIndex].record.order) {
                    winnerIndex = index;
                }
            }
        } else {
            const weights = group.map(candidate => Math.max(MIN_WEIGHT, Number(candidate.record.groupWeight) || MIN_WEIGHT));
            const total = weights.reduce((sum, weight) => sum + weight, 0);
            let roll = rng() * total;
            winnerIndex = group.length - 1;
            for (let index = 0; index < group.length; index++) {
                roll -= weights[index];
                if (roll < 0) {
                    winnerIndex = index;
                    break;
                }
            }
        }
        winners.set(group[winnerIndex], byOrder
            ? `won inclusion group "${label}" (insertion-order priority)`
            : `won inclusion group "${label}" (weighted roll)`);
        for (let index = 0; index < group.length; index++) {
            if (index !== winnerIndex) {
                rejected.set(group[index], byOrder
                    ? `lost inclusion group "${label}" (insertion-order priority)`
                    : `lost inclusion group "${label}" (weighted roll)`);
            }
        }
    }
    return { rejected, winners };
}

/**
 * Runs the Janitor lorebook engine for one book against the current chat.
 *
 * @param {object} options
 * @param {object[]} options.entries      Raw Janitor entry records (from the book file)
 * @param {object[]} options.messages     Chat messages [{is_bot, role, message, date}]
 *                                        (the facade's last_messages; includes the just-sent message)
 * @param {number}   options.messageCount Total chat message count (facade chat.message_count)
 * @param {number}  [options.bookDepth]   Book-level scan depth (script settings depth)
 * @param {() => number} [options.rng]    Random source (injectable for tests)
 * @returns {{blocks: object, decisions: object[], activatedCount: number}}
 *   blocks: { personalityBefore, personalityAfter, scenarioBefore, scenarioAfter,
 *             exampleBefore, exampleAfter } — ready-to-splice content strings
 *   decisions: per-entry {entryName, placement, position, activated, reason}
 */
export function runLorebookEngine({ entries, messages, messageCount, bookDepth = DEFAULT_BOOK_DEPTH, rng = Math.random }) {
    const decisions = [];
    const candidates = [];
    const allMessages = Array.isArray(messages) ? messages : [];
    const chat = Array.isArray(entries) ? entries : [];

    // Precompile literal + regex matchers once per entry (keys and secondary keys).
    const matcherCache = new Map();

    function keyMatcher(key, record) {
        const cacheKey = `${record.caseSensitive ? 'c' : 'i'}|${record.matchWholeWords ? 'w' : 'f'}|${key}`;
        if (!matcherCache.has(cacheKey)) {
            if (/^\/.+\/[a-z]*$/i.test(key)) {
                matcherCache.set(cacheKey, compileRegexKey(key, record.caseSensitive));
            } else {
                matcherCache.set(cacheKey, literalKeyRegex(key, record));
            }
        }
        return matcherCache.get(cacheKey) ?? null;
    }

    function buildSecondaryMatchers(record) {
        const map = new Map();
        for (const key of record.secondary) {
            map.set(key, keyMatcher(key, record));
        }
        return map;
    }

    let scanSequence = 0;

    for (const raw of chat) {
        const record = normalizeJanitorEntry(raw);
        if (!record) {
            continue;
        }

        const placement = record.placement ?? 'default';
        const position = record.position ?? 'after';
        const decision = {
            seq: scanSequence++,
            entryName: record.entryName || record.content.slice(0, 40) || '(unnamed entry)',
            placement,
            position,
            activated: false,
            reason: '',
        };

        if (!record.active) {
            decision.reason = 'entry is disabled';
            decisions.push(decision);
            continue;
        }

        // Min Messages = total message count (incl. the just-sent user message).
        if (record.minMessages > 0 && messageCount < record.minMessages) {
            decision.reason = `waiting for Min Messages (${messageCount}/${record.minMessages})`;
            decisions.push(decision);
            continue;
        }

        const depth = record.depth ?? clampDepth(bookDepth);
        const window = allMessages.slice(Math.max(0, allMessages.length - depth));
        const windowText = window.map(message => String(message?.message ?? '')).join('\n');

        if (record.constant) {
            decision.reason = 'constant entry';
            candidates.push({ record, decision, windowText });
            continue;
        }

        if (record.keys.length === 0 && record.regexKeys.length === 0) {
            decision.reason = 'no keys and not constant';
            decisions.push(decision);
            continue;
        }

        // Primary keys: any literal or regex key somewhere in the window.
        const matchedKeys = [
            ...record.keys.filter(key => keyMatcher(key, record)?.test(windowText)),
            ...record.regexKeys.filter(key => keyMatcher(key, record)?.test(windowText)),
        ];
        if (matchedKeys.length === 0) {
            decision.reason = `no key matched in the last ${depth} message(s)`;
            decisions.push(decision);
            continue;
        }

        const secondary = secondaryKeysPass(record, windowText, buildSecondaryMatchers(record));
        if (!secondary.pass) {
            decision.reason = secondary.reason;
            decisions.push(decision);
            continue;
        }

        decision.reason = `key matched (${matchedKeys.length} key${matchedKeys.length === 1 ? '' : 's'})`;
        candidates.push({ record, decision, windowText });
    }

    // Inclusion groups: losers are removed before the probability rolls (same
    // order as ST's native pipeline: group filter, then probability).
    const { rejected: groupRejections, winners: groupWinners } = resolveInclusionGroups(
        candidates.filter(candidate => candidate.record.groupLabels.length > 0),
        rng,
    );

    const activated = [];
    for (const candidate of candidates) {
        const { record, decision } = candidate;
        if (groupRejections.has(candidate)) {
            decision.reason = groupRejections.get(candidate);
            decisions.push(decision);
            continue;
        }
        if (groupWinners.has(candidate)) {
            decision.reason = groupWinners.get(candidate);
        }
        if (record.probability < 100 && rng() * 100 >= record.probability) {
            decision.reason = `probability roll failed (${record.probability}%)`;
            decisions.push(decision);
            continue;
        }
        decision.activated = true;
        decisions.push(decision);
        activated.push(candidate);
    }

    // Assemble the six anchor blocks. Within one block, ST places entries so
    // that a higher order sits closer to the anchored section — replicate that
    // for consistency between native and bridged books.
    const buckets = {
        personalityBefore: [], personalityAfter: [],
        scenarioBefore: [], scenarioAfter: [],
        exampleBefore: [], exampleAfter: [],
    };
    for (const candidate of activated) {
        const { record } = candidate;
        const anchor = anchorFor(record);
        buckets[anchor].push(record);
    }

    const blocks = {
        personalityBefore: joinBlock(buckets.personalityBefore, 'before'),
        personalityAfter: joinBlock(buckets.personalityAfter, 'after'),
        scenarioBefore: joinBlock(buckets.scenarioBefore, 'before'),
        scenarioAfter: joinBlock(buckets.scenarioAfter, 'after'),
        exampleBefore: joinBlock(buckets.exampleBefore, 'before'),
        exampleAfter: joinBlock(buckets.exampleAfter, 'after'),
    };

    // Report decisions in the book's own entry order (candidates get their
    // final reason after the group/probability phase, so re-sort by scan order).
    decisions.sort((a, b) => a.seq - b.seq);
    for (const decision of decisions) {
        delete decision.seq;
    }

    return { blocks, decisions, activatedCount: activated.length };
}

/**
 * Maps a normalized record's placement/position to one of the six anchors.
 * Janitor's Default placement = after personality (verified in the editor UI).
 */
function anchorFor(record) {
    const position = record.position === 'before' ? 'before' : 'after';
    switch (record.placement) {
        case 'personality':
            return position === 'before' ? 'personalityBefore' : 'personalityAfter';
        case 'scenario':
            return position === 'before' ? 'scenarioBefore' : 'scenarioAfter';
        case 'example':
            return position === 'before' ? 'exampleBefore' : 'exampleAfter';
        case 'default':
        default:
            return position === 'before' ? 'personalityBefore' : 'personalityAfter';
    }
}

/**
 * Joins one anchor's entries in ST's within-block order:
 * "before" blocks run highest-order-first, "after" blocks lowest-order-first —
 * in both cases the higher order ends up closer to the anchored section.
 */
function joinBlock(records, direction) {
    if (records.length === 0) {
        return '';
    }
    const sorted = [...records].sort((a, b) => direction === 'before'
        ? (b.order ?? MIN_ORDER) - (a.order ?? MIN_ORDER)
        : (a.order ?? MIN_ORDER) - (b.order ?? MIN_ORDER));
    return sorted.map(record => String(record.content ?? '')).filter(content => content.length > 0).join('\n');
}
