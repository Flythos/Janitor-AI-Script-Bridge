# Janitor AI Script Bridge (SillyTavern extension)

Runs **Janitor AI** bot scripts inside **SillyTavern** (tested against 1.19.0) as if they were native.
Strict bridging — no extension features beyond Janitor's own semantics:

- **Advanced (JS) scripts** — the script body runs synchronously before every generation
  (send, swipe, regenerate, continue, group drafts — the same "User → Script → LLM" slot Janitor uses).
  Scripts read and mutate Janitor's `context` object; the final `personality` / `scenario` /
  `example_dialogs` values are spliced into the prompt **for that generation only** (the character
  card is never modified on disk). Exactly like Janitor, scripts **cannot edit or remove chat
  messages** — `last_messages` is read-only.
- **Lorebook-type scripts (JSON)** — detected on import and **simply converted** into a native
  SillyTavern World Info book linked to the character (`data.extensions.world`); no runtime bridging —
  ST's own WI engine handles everything from there.
  The converter is aligned with the **real Janitor export schema** (verified against a 90-entry export)
  and the **entry editor UI** (verified via screenshots):
  `key` (regex keys live inside it, wrapped in slashes `/pattern/gi` — passed through to ST's native
  regex-key syntax), `keysecondary` (numeric `selectiveLogic` 0–3), `insertion_order`, `probability`,
  `minMessages`, `inclusionGroupRaw` (groups), `groupWeight`, `matchWholeWords` (**Janitor default ON**),
  `case_sensitive`, `constant`, `enabled`, `comment`/`category`, per-entry `depth` ("how many messages
  to search"), `activationMode`/`activationScript`.

  **Placement/Position → ST position (per-entry):** Janitor offers Placement Default / Personality /
  Scenario / Example msg × Position Before/After. Default means "after personality". Mapping:
  Personality+Before → ST "Before Char Defs"; Example msg → ST "Before/After Example Messages"
  (exact); everything else → ST "After Char Defs" (ST has no between-description-and-scenario slot —
  Scenario placement is therefore approximate).

  **Inclusion Groups** convert to ST's native group fields (`group` + `groupWeight`). Note the
  behavioral difference: Janitor activates ONE entry per group (weighted random, or insertion-order
  when "Use insertion order instead of weight" is set), while ST picks per keyword-score. That Janitor
  behavior is intentionally **not** emulated — converted books are plain ST books. `keyMatchPriority`,
  `minMessages` and per-entry `activationScript` are likewise stored as provenance / ignored on
  import (no ST-native equivalent).

## When scripts run (ordering)

Scripts execute in ST's **generate-interceptor phase**: after the user message is committed and
regex-processed, **before** World Info scanning and prompt assembly (`Generate()` →
`runGenerationInterceptors`, script.js:4562). The manifest declares `loading_order: 1000`, so the
bridge runs **last among all interceptor extensions** (built-ins: Image Generation = 10, Vector
Storage = 100 — vectors rearranges/removes chat messages before scripts see them). Extensions that
mutate the prompt at even later phases (prompt-ready handlers, depth injections during assembly) run
after scripts by design — scripts own the "context preparation" slot, exactly where Janitor runs them.

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
| Paste lorebook JSON (or import `.json`) | Converted to a World Info book `JAI: <title>` and linked to the selected character |
| Janitor script export `{title, script, settings}` | Routed by content (JSON array → lorebook, else → JS) |
| Bundle `{scripts: [...]}` | Every item routed individually |

Accepted lorebook JSON shapes: plain array of entries, `{entries: [...]}`, `{script: [...]}` — with
Janitor UI field names, snake_case, or community-exporter names. The original JSON is stored as
provenance (re-exportable from the "Imported Janitor lorebooks" list).

## Assigning scripts (Janitor parity)

Scripts are stacked **per character, in order**; later scripts see what earlier scripts added.
Assign in the panel (drag to reorder; in group chats pick the member first) or with slash commands.
Assignment is stored on the character card (`data.extensions.jaiBridge`), so it survives card export/import.

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
the stack (✕); the enable checkbox is library-wide.

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

The **Message Depth (1–10) setting does not apply to JS scripts** — it only determines the scan depth
of lorebooks. For a converted lorebook the script's depth becomes the ST per-entry scan depth.

Sandbox (like Janitor): synchronous JS only — no `fetch`, timers, DOM, or `async`/`await`.
Real-world dialect works: `const/let`, template literals, spread, `?.`, `??`, `matchAll`, `try/catch`,
`console.log` (captured in the **debug report** — panel button or wand menu → "JAI debug").
A script that hangs is killed after the configured timeout; other scripts still run.
Scripts may leave "breadcrumbs" for each other: later scripts see (and can rewrite/remove) earlier
scripts' `personality`/`scenario` additions — nothing persists to the character card.

## Slash commands

- `/jai-list` — library + current character's stack
- `/jai-toggle <id|title>` — enable/disable a library script
- `/jai-assign <id|title>` / `/jai-unassign <id|title>` — edit the current character's stack
- `/jai-test [id|title]` — dry-run script(s) against the current chat, nothing injected
- `/jai-debug` — open the last generation report

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
6. **Lorebook import** — import this JSON (select the character first):
   ```json
   [
     {"name": "Rain check", "key": "rain, storm", "content": "It starts to rain heavily.",
      "probability": 100, "order": 100, "active": true},
     {"name": "Regex key", "key": ["/thunder[0-9]/"], "content": "Thunder rumbles."},
     {"name": "A-side", "key": "coin", "content": "Heads!", "inclusionGroupRaw": "coinflip", "groupWeight": 75},
     {"name": "B-side", "key": "coin", "content": "Tails!", "inclusionGroupRaw": "coinflip", "groupWeight": 25}
   ]
   ```
   Expected: book `JAI: …` appears in the World Info editor with keys/content/probability/order/groups
   mapped, linked to the character (green book icon), and the plugin's book list shows it with 4 entries.
7. **Lorebook activation** — send a message containing "rain" → entry activates (WI toast / terminal log
   shows `It starts to rain heavily.` in the prompt). A message without the keyword → no activation.
8. **Swipe/regenerate** — swipe the last reply → scripts rerun (debug report timestamp/type `swipe` updates).
9. **Abort safety** — start a generation and press Stop mid-stream → the character editor shows the
   original fields (no leftover script text).
10. **Group chat** (if used) — with a group open, assign different scripts to two members → each draft
    runs its member's stack; the debug report's "Character" line matches the drafting member.
11. **Strict parity check** — add a script with `context.chat.last_messages.pop(); context.chat.last_message = "tampered";`
    → the AI still sees the full untouched chat (messages are read-only, exactly like Janitor); the character
    card fields remain unchanged after generation.

## Known limitations

- **Converted lorebooks keep ST-native group behavior**: Janitor activates one entry per inclusion
  group (weighted random / insertion order); ST activates by keyword-score instead. `minMessages`
  gates and per-entry activation scripts have no ST equivalent and are dropped at conversion.
- Janitor's lorebook JSON field names are undocumented — the parser is tolerant (verified against a
  real export + the editor UI), but exotic exports may need field-name variants added to
  `src/janitor-format.js`. Placement/position and depth are absent from exports and default to
  After / lorebook-scan-depth.
- Scenario placement (above/below scenario) lands at ST "After Char Defs" — ST cannot place text
  between the description and the scenario block.
- Community bot exporters that embed only script *references* (`{id, title}`) without script content
  cannot be imported — the content must be in the JSON (Janitor serves scripts separately).
- Live-fetching scripts from janitorai.com is deliberately out of scope (no official export API);
  import via paste/files. The bundle format keeps a future fetcher possible.
- Faithful injection mode briefly holds modified values in the in-memory character object during
  prompt assembly; saving the character during that split second would persist them (restore happens
  right after the prompt is materialized and on every generation end/abort).
