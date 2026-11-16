// Janitor AI Script Bridge — Janitor data-format handling (pure, no ST imports)
//
// Tolerant parsing of the JSON side of Janitor's script system. Janitor's
// native lorebook entry field names are undocumented, so every accessor
// accepts the known naming variants (Janitor UI labels, snake_case, and the
// shapes emitted by community exporter userscripts).

// ST world_info_logic values, verified in SillyTavern 1.19.0
// (public/scripts/world-info.js:33): AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3.
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

function pick(object, keys, fallback) {
    for (const key of keys) {
        if (object && object[key] !== undefined && object[key] !== null) {
            return object[key];
        }
    }
    return fallback;
}

function pickNonEmpty(object, keys) {
    for (const key of keys) {
        const value = object ? object[key] : undefined;
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return value;
        }
    }
    return '';
}

function asArray(value) {
    if (value === undefined || value === null || value === '') {
        return [];
    }
    if (Array.isArray(value)) {
        return value.map(item => String(item).trim()).filter(item => item.length > 0);
    }
    return String(value)
        .split(',')
        .map(item => item.trim())
        .filter(item => item.length > 0);
}

function asBool(value, fallback = false) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'active'].includes(normalized)) {
        return true;
    }
    if (['false', '0', 'no', 'off', 'inactive'].includes(normalized)) {
        return false;
    }
    return fallback;
}

function asNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Normalizes a secondary-key logic value into an ST world_info_logic number.
 * Real Janitor exports carry the ST-compatible numeric enum (0-3, verified in
 * a 90-entry export); UI labels ("AND ANY") and snake/camelCase variants are
 * also accepted.
 */
export function normalizeSecondaryLogic(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) {
        return value;
    }
    if (typeof value === 'string' && value.trim() !== '' && /^\s*[0-3]\s*$/.test(value)) {
        return Number(value.trim());
    }
    const normalized = String(value ?? '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '_');
    switch (normalized) {
        case 'AND_ANY':
        case 'ANDANY':
            return WI_LOGIC.AND_ANY;
        case 'AND_ALL':
        case 'ANDALL':
            return WI_LOGIC.AND_ALL;
        case 'NOT_ANY':
        case 'NOTANY':
            return WI_LOGIC.NOT_ANY;
        case 'NOT_ALL':
        case 'NOTALL':
            return WI_LOGIC.NOT_ALL;
        default:
            return null;
    }
}

/**
 * Normalizes a group selection mode value. Real Janitor exports encode it as
 * the `prioritizeInclusion` checkbox ("Use insertion order instead of weight",
 * default = weighted random pick of ONE entry per group); a string mode is
 * accepted too. Returns 'weighted' | 'byOrder' | 'all' | null (unknown).
 */
export function normalizeGroupMode(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (/^(true|1|yes|on)$/.test(normalized)) {
        return 'byOrder';
    }
    if (/^(false|0|no|off)$/.test(normalized)) {
        return 'weighted';
    }
    if (/(insertion|order|priorit)/.test(normalized) && !/weight|random/.test(normalized)) {
        return 'byOrder';
    }
    if (/(all|any|multiple|every)/.test(normalized)) {
        return 'all';
    }
    if (/(one|single|weighted|random|pick)/.test(normalized)) {
        return 'weighted';
    }
    return null;
}

/**
 * Normalizes a Placement value: Default / Personality / Scenario / Example msg
 * (verified in the Janitor entry editor). Null when unrecognized.
 */
export function normalizePlacement(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || /^(default|standard)$/.test(normalized)) {
        return 'default';
    }
    if (/personality|description/.test(normalized)) {
        return 'personality';
    }
    if (/scenario/.test(normalized)) {
        return 'scenario';
    }
    if (/example|dialog/.test(normalized)) {
        return 'example';
    }
    return null;
}

/**
 * Normalizes a Position value: Before/Above or After/Below (UI shows "After" as
 * the default). Null when unrecognized.
 */
export function normalizePosition(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (/^(before|above|top)$/.test(normalized)) {
        return 'before';
    }
    if (/^(after|below|bottom)$/.test(normalized)) {
        return 'after';
    }
    return null;
}

/**
 * Parses a raw imported lorebook entry into a canonical Janitor-shaped record.
 */
export function normalizeJanitorEntry(raw) {
    if (typeof raw !== 'object' || raw === null) {
        return null;
    }

    const rawKeys = asArray(pick(raw, ['key', 'keys', 'keywords', 'trigger_keys', 'triggerKeys']));
    // Janitor embeds regex keys IN the key list, wrapped in slashes ("/pattern/gi"
    // — verified in the entry editor). Split them out so matching treats them
    // as patterns instead of literal substrings.
    const keys = [];
    const embeddedRegexKeys = [];
    for (const item of rawKeys) {
        if (/^\/.+\/[a-z]*$/i.test(item)) {
            embeddedRegexKeys.push(item);
        } else {
            keys.push(item);
        }
    }
    const regexKeys = embeddedRegexKeys.concat(asArray(pick(raw, ['regexKeys', 'regex_keys', 'regex', 'regexes', 'regex_key', 'regexKey'])));
    const secondary = asArray(pick(raw, ['keysecondary', 'secondary_keys', 'secondaryKeys', 'secondary', 'secondary_key']));
    const content = pick(raw, ['content', 'text', 'entry', 'value']);
    // Real exports leave `name` empty and carry the entry title in `comment` —
    // prefer the first non-empty candidate.
    const entryName = pickNonEmpty(raw, ['name', 'entryName', 'entry_name', 'comment', 'title', 'memo']);
    const category = pick(raw, ['category', 'categories']);
    const logicRaw = pick(raw, ['secondary_logic', 'secondaryLogic', 'selectiveLogic', 'logic', 'secondary_keys_logic']);
    const groupModeRaw = pick(raw, ['groupSelectionMode', 'group_selection_mode', 'groupMode', 'group_mode']);
    const prioritizeInclusion = asBool(pick(raw, ['prioritizeInclusion', 'prioritize_inclusion']), false);
    const depth = pick(raw, ['depth', 'scanDepth', 'scan_depth']);
    const minMessages = pick(raw, ['minMessages', 'min_messages', 'minMsg', 'min_msgs', 'minimumMessages']);
    const order = pick(raw, ['order', 'insertion_order', 'insertionOrder']);
    const groupWeight = pick(raw, ['groupWeight', 'group_weight']);
    const groupLabels = asArray(pick(raw, ['group', 'groups', 'groupLabels', 'group_labels', 'groupLabel', 'group_label', 'inclusionGroupRaw', 'inclusionGroup', 'inclusion_groups']));
    const placementRaw = pick(raw, ['placement', 'placement_mode', 'injection_placement']);
    const positionRaw = pick(raw, ['position', 'injection_position', 'placement_position']);

    // Group selection mode: Janitor's default is a weighted random pick of ONE
    // entry per inclusion group; the "Use insertion order instead of weight"
    // checkbox (prioritizeInclusion) switches it to insertion-order priority.
    // An explicit string mode always wins over the checkbox.
    let groupMode = normalizeGroupMode(groupModeRaw);
    if (groupMode === null) {
        groupMode = prioritizeInclusion ? 'byOrder' : 'weighted';
    }

    const record = {
        keys,
        regexKeys,
        secondary,
        secondaryLogic: normalizeSecondaryLogic(logicRaw),
        content: String(content ?? ''),
        entryName: String(entryName ?? ''),
        category: String(category ?? ''),
        probability: asNumber(pick(raw, ['probability']), 100),
        minMessages: Math.max(0, Math.round(asNumber(minMessages, 0))),
        order: asNumber(order, 100),
        groupLabels,
        groupWeight: asNumber(groupWeight, 100),
        groupMode,
        caseSensitive: asBool(pick(raw, ['caseSensitive', 'case_sensitive']), false),
        matchWholeWords: asBool(pick(raw, ['matchWholeWords', 'match_whole_words', 'wholeWords', 'whole_words']), true),
        active: asBool(pick(raw, ['active', 'enabled', 'isEnabled']), true),
        constant: asBool(pick(raw, ['constant', 'constantEntry', 'alwaysActive']), false),
        depth: depth === undefined || depth === null || depth === '' ? null : Math.max(1, Math.min(10, Math.round(asNumber(depth, 3)))),
        placement: normalizePlacement(placementRaw),
        position: normalizePosition(positionRaw),
        keyMatchPriority: asBool(pick(raw, ['keyMatchPriority', 'key_match_priority']), false),
        activationMode: String(pick(raw, ['activationMode'], 'standard')),
        activationScript: String(pick(raw, ['activationScript'], '')),
    };

    // A record is only considered an entry if it carries some content or some keys.
    if (!record.content && record.keys.length === 0 && record.regexKeys.length === 0) {
        return null;
    }
    return record;
}

/**
 * Detects whether a parsed JSON value looks like a Janitor lorebook (an array
 * of entries, optionally wrapped in {entries: [...]} or {script: [...]}).
 */
export function looksLikeLorebook(parsed) {
    if (Array.isArray(parsed)) {
        return parsed.some(item => typeof item === 'object' && item !== null && (item.content !== undefined || item.key !== undefined || item.text !== undefined));
    }
    if (typeof parsed === 'object' && parsed !== null) {
        if (Array.isArray(parsed.entries)) {
            return looksLikeLorebook(parsed.entries);
        }
        if (Array.isArray(parsed.script)) {
            return looksLikeLorebook(parsed.script);
        }
    }
    return false;
}

/**
 * Extracts the entry array from the possible wrapper shapes.
 */
export function extractLorebookEntries(parsed) {
    if (Array.isArray(parsed)) {
        return parsed;
    }
    if (Array.isArray(parsed?.entries)) {
        return parsed.entries;
    }
    if (Array.isArray(parsed?.script)) {
        return parsed.script;
    }
    return null;
}

/**
 * Compiles a Janitor regex key ("/pattern/flags" or bare "pattern") honoring
 * the entry's case sensitivity. Returns null for invalid patterns.
 */
export function compileRegexKey(regexKey, caseSensitive) {
    let pattern = String(regexKey).trim();
    let flags = caseSensitive ? '' : 'i';
    const match = pattern.match(/^\/(.*?)\/([a-z]*)$/);
    if (match) {
        pattern = match[1];
        flags = (match[2] || (caseSensitive ? '' : 'i')).replace(/[^dgimsuvy]/g, '');
        if (!flags.includes('i') && !caseSensitive) {
            flags += 'i';
        }
    }
    try {
        return new RegExp(pattern, flags);
    } catch {
        return null;
    }
}
