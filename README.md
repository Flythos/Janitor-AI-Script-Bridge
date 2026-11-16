# Janitor AI Script Bridge (SillyTavern extension)

Runs **Janitor AI** bot scripts inside **SillyTavern** (tested against 1.19.0) as if they were native.
Strict bridging — no extension features beyond Janitor's own semantics:

- **Advanced (JS) scripts** — the script body runs synchronously before every generation
  (send, swipe, regenerate, continue, group drafts — the same "User → Script → LLM" slot Janitor uses).
  Scripts read and mutate Janitor's `context` object; the final `personality` / `scenario` /
  `example_dialogs` values are spliced into the prompt **for that generation only** (the character
  card is never modified on disk). Exactly like Janitor, scripts **cannot edit or remove chat
  messages** — `last_messages` is read-only.
- **Lorebook-type scripts (JSON)** — detected on import and turned into a World Info book
  `JAI: <title>`. You choose how it attaches (see [Lorebook modes](#lorebook-modes)):
  **Native** (plain ST book, ST's WI engine runs it) or **Bridge** (this plugin re-implements
  Janitor's lorebook engine and enforces it every generation).
  The converter is aligned with the **real Janitor export schema** (verified against a 90-entry export)
  and the **entry editor UI** (verified via screenshots):
  `key` (regex keys live inside it, wrapped in slashes `/pattern/gi`), `keysecondary` (numeric
  `selectiveLogic` 0–3), `insertion_order`, `probability`, `minMessages`, `inclusionGroupRaw` (groups),
  `groupWeight`, `matchWholeWords` (**Janitor default ON**), `case_sensitive`, `constant`, `enabled`,
  `comment`/`category`, per-entry `depth` ("how many messages to search"),
  `activationMode`/`activationScript`.

## Lorebook modes

At the end of a lorebook import (with a character selected) a popup asks how to attach the book.
The mode can be switched any time with the **⇄ button** in the "Imported Janitor lorebooks" list.

### Native (plain ST book)

The book is linked as the character's primary lorebook (`data.extensions.world`) and **ST's own
World Info engine does everything** — key scanning, budget, recursion, activation.

Placement/Position → ST position (per-entry): Personality+Before → ST "Before Char Defs";
Example msg → ST "Before/After Example Messages" (exact); Default, Scenario and everything else →
ST "After Char Defs" (ST has no between-description-and-scenario slot — approximate).
`prioritizeInclusion` ("Use insertion order instead of weight") maps to ST's **Inclusion Priority**
(`groupOverride`) — an exact 1:1 equivalent. Weighted-random group picking has no ST equivalent
(ST picks per keyword score).

Known native-mode approximations: group labels containing commas are split by ST (the converter
replaces them with `;`), `minMessages` and per-entry `activationScript` are dropped, regex flags
outside ST's `[gimsuy]` set are removed.

### Bridge (Janitor engine at runtime)

The book is **not** linked to the character (no double activation) — instead the character card
records it in `data.extensions.jaiBridgeBooks`, and the plugin's lorebook engine
(`src/lorebook-engine.js`) re-implements Janitor's activation rules **every generation**:

- keys: literal keys with **Match Whole Words** (Janitor default ON) and **Case Sensitive**,
  plus regex keys (`/pattern/flags` embedded in the key list)
- secondary keys with the 4 logic modes (AND ANY / NOT ALL / NOT ANY / AND ALL — Janitor's numeric enum)
- scan window: per-entry **Depth** ("how many messages to search"), falling back to the book's
  Depth setting (the Janitor script's Message Depth, default 3)
- **Min Messages** = total chat message count (incl. the just-sent message)
- **Probability %** rerolled per generation (send/swipe)
- **inclusion groups**: exactly ONE entry per group activates — **weighted random by Group Weight**
  (Janitor default) or **insertion-order priority** when "Use insertion order instead of weight"
  is set (lowest `insertion_order` wins)
- **Placement**: Default / Personality / Scenario / Example msg × Before/After
  (Default = after personality), at Janitor's exact positions
- within each block, entries order like ST would place them (higher `insertion_order` = closer to
  the anchored section)

Matched entry content is injected into the prompt **for that generation only**, riding the same
single-generation injection/restore path as script results (faithful mode splices it into the
character sections exactly; ephemeral mode lands it as an extension prompt at a fixed position —
approximate). The **debug report** (wand menu → "JAI debug") lists every entry's decision:
matched keys, constant, won/lost group roll, waiting for Min Messages, probability fail, and more.

**Source of truth:** the engine reads the **original Janitor records stored inside the book file**
(`data.jaiBridge.entries`). The World Info copy of a bridged book is **view-only** — edits there
do not affect bridging; re-import the JSON to update. This also keeps the big JSON out of
`settings.json` (it lives in the book file, same as before v0.3.0 exports).

Known bridge-mode deviations: `keyMatchPriority` is not emulated; per-entry `activationScript`
is ignored (imported as a standard entry); ordering ties in `prioritizeInclusion` groups resolve
by lowest `insertion_order`.

## When scripts run (ordering)

Scripts execute in ST's **generate-interceptor phase**: after the user message is committed and
regex-processed, **before** World Info scanning and prompt assembly (`Generate()` →
`runGenerationInterceptors`). The manifest declares `loading_order: 1000`, so the bridge runs
**last among all interceptor extensions** (built-ins: Image Generation = 10, Vector Storage = 100 —
vectors rearranges/removes chat messages before scripts see them). Extensions that mutate the
prompt at even later phases (prompt-ready handlers, depth injections during assembly) run after
scripts by design — scripts own the "context preparation" slot, exactly where Janitor runs them.
Bridged lorebook entries are applied **after** the scripts: scripts never see lorebook content,
the lorebook enriches what the scripts produced.

## Install

1. In SillyTavern: **Extensions → Install extension**, paste
   `https://github.com/Flythos/Janitor-AI-Script-Bridge` and confirm.
2. Restart SillyTavern, then open **Extensions → Janitor AI Script Bridge**.
3. On the first load ST may ask to allow third-party extensions — confirm.

Manual alternative: copy (or symlink) this folder into your SillyTavern installation:
`data/<your-user-handle>/extensions/JanitorAiScriptUsage` (create the `extensions` folder if it
doesn't exist) and restart.

No build step, no dependencies. Requires SillyTavern ≥ 1.19 (uses `generate_interceptor`).

## Importing Janitor content

| Source | Result |
| --- | --- |
| Paste JavaScript (or import `.js`) | Advanced script added to the **Script library** |
| Paste lorebook JSON (or import `.json`) | Converted to a World Info book `JAI: <title>`; popup asks **Native vs Bridge** (with a character selected) |
| Janitor script export `{title, script, settings}` | Routed by content (JSON array → lorebook, else → JS) |
| Bundle `{scripts: [...]}` | Every item routed individually |

Accepted lorebook JSON shapes: plain array of entries, `{entries: [...]}`, `{script: [...]}` — with
Janitor UI field names, snake_case, or community-exporter names. The original JSON is stored
**inside the book file** (`data.jaiBridge`) and stays re-exportable from the
"Imported Janitor lorebooks" list.

## Assigning scripts (Janitor parity)

Scripts are stacked **per character, in order**; later scripts see what earlier scripts added.
Assign in the panel (drag to reorder; in group chats pick the member first) or with slash commands
(solo chats — group members are managed via the panel pickers). Assignment is stored on the
character card (`data.extensions.jaiBridge`), so it survives card export/import.

### The "Scripts" panel (options menu, like Author's Note)

Open the **☰ menu below the chat** (the one with Author's Note / CFG Scale) — a **Scripts** entry
sits right under **Author's Note**. It opens a floating, draggable panel with two stacks:

- **Scripts for this chat** — saved to the **chat** (same place Author's Note stores its data:
  chat metadata). Applies to every generation in this chat, shared by all group members, and
  follows the chat through checkpoints.
- **Scripts for \<character\>** — saved on the **character card** (`data.extensions`), Janitor's
  bot-level stack, shared by all of the character's chats.

Both stacks are **import + sort** interfaces: each section has **Add** (from the library),
**Import** (files) and **Paste** — imported scripts are attached to the section you imported
them from automatically — and drag-to-sort lists. Rows can be edited (pencil) or removed from
the stack (✕); the enable checkbox is library-wide. In group chats both the panel and the
Extensions panel share the same member picker selection.

**Run order:** character stack first, then the chat stack (a script attached to both runs once,
at its character position). The debug report shows each run as `[char]` or `[chat]`.

## The `context` API available to scripts

All field semantics below are **verified against Janitor by the user**.

```js
context.character.name            // read-only
context.character.chat_name       // read-only
context.character.personality     // writable — this is ST's "Description" block (not ST's Personality field!)
context.character.scenario       // writable  (ST Scenario)
context.character.example_dialogs // writable  (ST example dialogs)
context.chat.last_message         // most recent message = the message just sent (read-only; assigning to it does nothing — same as Janitor)
context.chat.last_messages        // [{is_bot, role: 'user'|'assistant', date, message}] — READ-ONLY.
                                  //   includes the just-sent user message and the WHOLE chat — the Message
                                  //   Depth (1-10) setting does NOT limit it; scripts self-limit.
                                  //   Mutating it (or last_message) does nothing — same as Janitor.
context.chat.message_count        // total messages (not turns), counts the just-sent message, swipes not counted
context.chat.first_message_date / last_bot_message_date   // timestamps, if supported
```

The **Message Depth (1–10) setting does not apply to JS scripts** — it only determines the scan
depth of lorebooks (native: ST per-entry scan depth; bridge: the engine's scan window).

Sandbox (like Janitor): synchronous JS only — no `fetch`, timers, DOM, or `async`/`await`.
The sandbox compiles your script inside a Web Worker via `new Function` with every host global
shadowed — scripts physically cannot reach the network, the page, or timers, and breakout
attempts fail as syntax errors. Real-world dialect works: `const/let`, template literals, spread,
`?.`, `??`, `matchAll`, `try/catch`, `console.log` (captured in the **debug report** — panel button
or wand menu → "JAI debug"). A script that hangs is killed after the configured timeout; other
scripts still run. Scripts may leave "breadcrumbs" for each other: later scripts see (and can
rewrite/remove) earlier scripts' `personality`/`scenario` additions — nothing persists to the
character card.

## Slash commands

- `/jai-list` — library + current character's stack
- `/jai-toggle <id|title>` — enable/disable a library script
- `/jai-assign <id|title>` / `/jai-unassign <id|title>` — edit the current character's stack
  (solo chats; in group chats use the panel member pickers)
- `/jai-test [id|title]` — dry-run script(s) AND the bridged lorebook engine against the current
  chat; the report shows what **would** happen, nothing is injected
- `/jai-debug` — open the last generation report

## Developer tools

Inside this repo (Node ≥ 18, no dependencies to install):

- `npm test` — functional smoke tests (`tests/smoke.mjs`): sandbox (incl. breakout-regression
  security tests), context facade, Janitor format parsing, and the lorebook engine.
- `npm run audit` — mechanical import audit: every named import must resolve against the shipped
  modules and a local SillyTavern reference clone (expects `.st-src/public` next to this folder).

## Manual test checklist

Run these after install; each step says what you should see. Enable **Debug capture** in the options first.

1. **Panel renders** — Extensions tab shows "Janitor AI Script Bridge" with library/stack/books/options sections.
2. **Official template script** — create a script with the template below, assign it, send a message:
   ```js
   if (!context.character) context.character = {};
   if (!context.character.personality) context.character.personality = "";
   context.character.personality += "\n\nbecomes more relaxed around books and reading";
   ```
   Expected: the reply prompt contains the appended line (visible in the server terminal log for that turn);
   the character editor still shows the **original** personality afterwards (restore worked); the debug
   report lists the script "ok" with the diff `+ appended`.
3. **Full-chat window** — make the script log its view: `console.log(context.chat.last_messages.length, context.chat.message_count);`
   → both log the full chat length (scripts see the whole chat, not a depth window).
4. **Ordering** — script A appends "ALPHA_MARKER" to personality; script B logs `context.character.personality`.
   With B **below** A, B's logs must contain ALPHA_MARKER. Move B above A → B no longer sees it.
5. **Error isolation** — script A: `throw new Error("boom")`; script B: the template above.
   Expected: report shows A failed (error captured), B still ran and its text reached the prompt; generation completes.
6. **Lorebook import + mode popup** — select a character and import this JSON:
   ```json
   [
     {"name": "Rain check", "key": "rain, storm", "content": "It starts to rain heavily.",
      "probability": 100, "order": 100, "active": true},
     {"name": "Regex key", "key": ["/thunder[0-9]/"], "content": "Thunder rumbles."},
     {"name": "A-side", "key": "coin", "content": "Heads!", "inclusionGroupRaw": "coinflip", "groupWeight": 75},
     {"name": "B-side", "key": "coin", "content": "Tails!", "inclusionGroupRaw": "coinflip", "groupWeight": 25}
   ]
   ```
   Expected: a popup offers **Bridge mode** vs **Native**. Pick **Native**: book `JAI: …` appears in
   the World Info editor, linked to the character (green book icon), plugin book list shows it with a
   "Native" badge and 4 entries. (Old v0.2.0 behavior.)
7. **Bridge mode** — import the same JSON again (a second book is created), pick **Bridge**.
   Expected: the book is **not** linked in World Info (no green book icon), the book list shows a
   "Bridged" badge. Send a message containing "rain" → the debug report's **Lorebook engine** section
   shows "Rain check" ✓ activated (key matched) and the reply prompt contains "It starts to rain
   heavily." A message without any key → all entries listed with "no key matched".
8. **Bridge: Min Messages + groups** — import an entry with `"minMessages": 5` and the coinflip pair:
   with fewer than 5 messages the report shows "waiting for Min Messages (n/5)"; at ≥5 it activates.
   The coinflip entries activate exactly one per generation — swiping rerolls the weighted pick
   (visible in the report: "won/lost inclusion group").
9. **Mode toggle** — press the ⇄ button on a book row: Native → Bridged unlinks it (and removes the
   green book icon); Bridged → Native links it (ST asks nothing; if another book was primary, a
   confirm popup appears). The badge updates.
10. **Swipe/regenerate** — swipe the last reply → scripts and the lorebook engine rerun (debug report
    timestamp/type `swipe` updates).
11. **Abort safety** — start a generation and press Stop mid-stream → the character editor shows the
    original fields (no leftover script/lorebook text).
12. **Group chat** (if used) — with a group open, assign different scripts to two members → each draft
    runs its member's stack; the debug report's "Character" line matches the drafting member. The
    member picked in the Scripts panel is the same one the Extensions panel edits (shared picker).
13. **Strict parity check** — add a script with `context.chat.last_messages.pop(); context.chat.last_message = "tampered";`
    → the AI still sees the full untouched chat (messages are read-only, exactly like Janitor); the character
    card fields remain unchanged after generation.
14. **Sandbox probe** — paste this as a script, assign it, send a message:
    `})(); fetch("https://example.invalid/steal"); (function(){`
    Expected: the debug report shows the script **failed** with a syntax error, the generation completes
    normally, and nothing was fetched (the sandbox compiles scripts as functions; breakout attempts
    cannot escape).

## Known limitations

- **Bridged lorebooks are read from the book file's stored Janitor records** — edits in the World
  Info editor don't affect bridging (re-import to update). Native books are fully editable as usual.
- Native books keep ST-native group behavior for weighted groups (ST picks by keyword score, Janitor
  by weighted random); `prioritizeInclusion` maps exactly (Inclusion Priority). `minMessages` and
  per-entry `activationScript` have no ST equivalent and are dropped at native conversion — use
  Bridge mode for those.
- Ephemeral injection mode cannot reproduce Janitor's exact placements (extension prompts have no
  "after personality" slot) — use faithful mode for exact placement.
- Example-message placement prepends/appends to ST's example-dialogs block (approximation).
- Janitor's lorebook JSON field names are undocumented — the parser is tolerant (verified against a
  real export + the editor UI), but exotic exports may need field-name variants added to
  `src/janitor-format.js`. Placement/position and depth are absent from exports and default to
  After / lorebook-scan-depth.
- Community bot exporters that embed only script *references* (`{id, title}`) without script content
  cannot be imported — the content must be in the JSON (Janitor serves scripts separately).
- Live-fetching scripts from janitorai.com is deliberately out of scope (no official export API);
  import via paste/files. The bundle format keeps a future fetcher possible.
- Faithful injection mode briefly holds modified values in the in-memory character object during
  prompt assembly; saving the character during that split second would persist them (restore happens
  right after the prompt is materialized and on every generation end/abort).
- The last-generation debug report is kept **for the session only** (it contains chat-derived
  content and must not leak into shared `settings.json` files) — after an ST reload it starts empty.
