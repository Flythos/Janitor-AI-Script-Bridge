# Janitor AI Script Bridge

A SillyTavern extension that runs **Janitor AI** bot scripts inside SillyTavern as if they were native. It handles the two kinds of content Janitor bots ship with:

- **JavaScript scripts** run synchronously before every generation (send, swipe, regenerate, continue, group drafts — the same "User → Script → LLM" slot Janitor uses). Scripts read and mutate Janitor's `context` object; the final `personality` / `scenario` / `example_dialogs` values are spliced into the prompt **for that generation only** — the character card is never modified on disk. Like Janitor, scripts cannot edit or remove chat messages.
- **Lorebook scripts (JSON)** are detected on import and converted into a World Info book `JAI: <title>`. You choose how it attaches: **Native** (a plain ST book, ST's World Info engine runs it) or **Bridge** (this extension re-implements Janitor's lorebook engine and enforces it every generation).

## Install

In SillyTavern, go to **Extensions → Install extension**, paste

```
https://github.com/Flythos/Janitor-AI-Script-Bridge
```

and confirm (allow third-party extensions if ST asks). Then restart SillyTavern and open **Extensions → Janitor AI Script Bridge**.

No build step, no dependencies. Requires SillyTavern ≥ 1.19 (uses `generate_interceptor`).

## Using it

**Importing** — in the extension panel, paste content or import files:
- JavaScript (or a `.js` file) goes into the **script library**.
- Lorebook JSON (or a `.json` file) is converted to a World Info book; with a character selected, a popup asks **Native vs Bridge**. Janitor script exports (`{title, script, settings}`) and bundles (`{scripts: [...]}`) are routed by content.
- The original Janitor JSON is stored inside the book file and stays re-exportable from the "Imported Janitor lorebooks" list.

**Assigning scripts** — scripts are stacked per character, in order; later scripts see what earlier ones added. Assign in the **Scripts panel**: open the ☰ menu below the chat (the one with Author's Note) — a *Scripts* entry sits right under it. "Scripts for this chat" are stored in the chat metadata and shared by all group members; "Scripts for \<character\>" sit on the character card, Janitor's bot-level stack. Both stacks support Add / Import / Paste and drag-to-sort. Run order: character stack first, then the chat stack. In group chats, pick the member first — the panel shares the member picker with the Extensions panel.

**Slash commands**:

- `/jai-list` — library + current character's stack
- `/jai-toggle <id|title>` — enable/disable a library script
- `/jai-assign` / `/jai-unassign <id|title>` — edit the current character's stack (solo chats; group members are managed via the panel)
- `/jai-test [id|title]` — dry-run scripts and the bridged lorebook engine; shows what *would* happen, nothing is injected
- `/jai-debug` — open the last generation report

## Lorebook modes

The mode of each imported book can be switched any time with the ⇄ button on its row.

**Native** — the book is linked as the character's primary lorebook and ST's World Info engine does everything: key scanning, budget, recursion, activation. Placement maps per-entry (Personality/Before → "Before Char Defs", Example msg → before/after Example Messages, everything else → "After Char Defs"); `prioritizeInclusion` maps exactly to ST's Inclusion Priority. Known approximations: group labels containing commas are split by ST, `minMessages` and per-entry `activationScript` are dropped, regex flags outside ST's set are removed, weighted-random group picking becomes ST's keyword-score picking.

**Bridge** — the book is *not* linked (no double activation). The built-in lorebook engine re-applies Janitor's activation rules on every generation: literal keys with Match Whole Words (Janitor default on) and Case Sensitive, regex keys embedded in the key list, secondary keys with the four logic modes, per-entry scan Depth with book-level fallback, Min Messages, Probability % rerolled per generation, inclusion groups where exactly one entry activates via **weighted random by group weight** (or insertion-order priority when "use insertion order instead of weight" is set), and Janitor's exact placement slots. It reads the original Janitor records stored inside the book file, so the World Info copy of a bridged book is view-only — re-import the JSON to update. The **debug report** (wand menu → "JAI debug") lists every entry's decision: matched keys, constant, won/lost group roll, waiting for Min Messages, probability fail.

## The `context` API (for script authors)

Field semantics verified against Janitor:

```js
context.character.name            // read-only
context.character.chat_name       // read-only
context.character.personality     // writable — this is ST's "Description" block (not ST's Personality field)
context.character.scenario        // writable (ST Scenario)
context.character.example_dialogs // writable (ST example dialogs)
context.chat.last_message         // the message just sent (read-only; assigning does nothing, same as Janitor)
context.chat.last_messages        // [{is_bot, role: 'user'|'assistant', date, message}] — the WHOLE chat, read-only
context.chat.message_count        // total messages incl. the one just sent (swipes not counted)
context.chat.first_message_date / last_bot_message_date  // timestamps, if supported
```

- The Message Depth (1–10) setting does not apply to JS scripts — it only controls lorebook scan depth. Scripts see the whole chat and self-limit.
- Scripts may leave "breadcrumbs" for each other: later scripts see (and can rewrite) earlier scripts' personality/scenario additions. Nothing persists to the card.
- Sandbox, like Janitor: synchronous JS only — no `fetch`, timers, DOM, or `async`. Scripts are compiled inside a Web Worker with every host global shadowed, so breakout attempts fail as syntax errors and nothing can reach the network. A hanging script is killed after the configured timeout; a failing script doesn't stop the others. `console.log` output is captured in the debug report.

## Limitations

- Bridged books are read-only in the World Info editor (re-import to update); native books are fully editable.
- Ephemeral injection mode cannot reproduce Janitor's exact placements — use faithful mode (the default) for exact placement.
- Community bot exporters that embed only script *references* (`{id, title}`) without content cannot be imported; fetching scripts from janitorai.com is deliberately out of scope (no official export API).
- Janitor's lorebook JSON field names are undocumented; the parser handles the known names (verified against a real 90-entry export and the entry editor UI), but exotic exports may need field-name variants added.
- The last-generation debug report is kept for the session only (it contains chat content) and starts empty after an ST reload.

## Development

`npm test` runs smoke tests for the sandbox (including breakout-regression security tests), the context facade, Janitor format parsing and the lorebook engine. `npm run audit` checks every import. Node ≥ 18, no dependencies to install.
