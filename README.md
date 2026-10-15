# Obsidian Projects

**A.I. first project management in real time.**

A Jira-style card board inside Obsidian, with a CLI (`oprojects`) and a core built to get an MCP server next.
Everything runs locally. **Every card is a Markdown note** with frontmatter: searchable, linkable (`[[OP-12]]`),
versionable and editable by hand. Changes made from anywhere (the board, the CLI, an agent, a sync client) show up
live on the open board.

![Board in Obsidian](docs/screenshots/board-dark.png)

| Details and comments (Obsidian, dark theme) | Phone layout (400 px) |
| --- | --- |
| ![Comments](docs/screenshots/comments.png) | ![Mobile](docs/screenshots/mobile-400px.png) |

## Installation

Requires Node ≥ 20.

```bash
npm install
npm run build
npm run install:vault -- "/path/to/your/vault" --enable   # copies main.js, manifest.json, styles.css
```

Open Obsidian → *Settings → Community plugins* → enable **Projects** (if you did not use `--enable`).
Use `--link` instead of copying while developing (`npm run dev` rebuilds; reload the plugin).

CLI, from any folder inside a vault:

```bash
ln -s "$PWD/packages/cli/dist/oprojects.cjs" ~/.local/bin/oprojects && chmod +x packages/cli/dist/oprojects.cjs
oprojects init --prefix OP --me "Your Name"
oprojects add "Fix login" -t bug -p high --due +3d
oprojects board
```

### From a release

Each [release](https://github.com/GustavoEklund/obsidian-projects/releases) carries `main.js`, `manifest.json` and
`styles.css`: put them in `<vault>/.obsidian/plugins/obsidian-projects/`, reload Obsidian and enable **Projects**
(the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin can install and update it from this repository
too). The CLI is the single file `oprojects.cjs` (Node ≥ 20): make it executable and put it on your `PATH` as
`oprojects`. `SHA256SUMS.txt` lists the checksums.

Without `init` it works with the defaults (`Cards` folder, `OP` key). The vault is found through `--vault`,
`$OPROJECTS_VAULT`, or by walking up the folders until a `.obsidian` is found.

## What a card looks like

```markdown
---
key: OP-12
title: Fix redirect after login
status: doing          # column id
type: bug              # task | story | bug | epic
priority: high         # highest | high | medium | low | lowest
assignee: Ana
labels: [auth, backend]
due: 2026-10-20
estimate: 3
parent: OP-1           # epic
rank: X                # position in the column (fractional index)
created: 2026-10-01T10:00:00.000Z
updated: 2026-10-02T10:00:00.000Z
---
The description is the body of the note.

- [x] Reproduce
- [ ] Regression test     ← becomes the 1/2 counter on the card

## Comments

> [!comment|k3f9a,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 14:02
> Only reproduces in Safari.
> - Markdown works in here
```

**Comments** live at the end of the note itself, in the `## Comments` section, one Obsidian *callout* per comment
(the part after `|` holds the id and the time; the title is what people read). That is why they also show up as boxes
in the note, are searchable, and can be edited by hand. A hand-written `> [!comment] Someone` without metadata counts too.
Editing the description never touches the comments section, and commenting only changes `updated` in the frontmatter.

Fields you add by hand and YAML comments are preserved on every edit.
The file is always `Cards/KEY-n.md`; moving or renaming the note does not break the card (the `key` is what counts).

## Plugin

- **Board** with drag and drop between and within columns, WIP limits (turn red when exceeded), overdue/upcoming due dates,
  checklist progress, epic, labels, avatar and priority.
- **Details panel**: every field is editable and saves by itself. The description opens **rendered (Preview)**:
  click the text to edit (`Esc` or clicking away saves and goes back; selecting text to copy does not open the editor).
  Checklist checkboxes work right in the preview, in the description and in comments, and write to the note.
  Wide tables scroll inside themselves and images scale down; nothing widens the panel.
  **Resizable**: drag the left edge (or focus it and press `←/→`; `Shift` moves faster), double-click restores the default
  (420 px). The width is saved with the layout, with a 300 px minimum and a minimum space left for the board.
- **Comments**: a thread in the panel (author, time, rendered Markdown), edit/delete, `Ctrl+Enter` posts,
  a draft per card and a 💬 counter on the card. The author is your name in *Settings → Projects → My name*.
- **Filters**: search (accent-insensitive, over title/key/label/description), assignee, type, priority, label, epic, "only mine".
  They are saved with the workspace layout.
- **Quick create** at the bottom of each column: `Enter` creates and stays open; first line = title, the rest = description.
- **Keyboard**: `Enter` opens · `Alt+←/→` changes column · `Alt+↑/↓` reorders · `/` searches · `c` creates · `Esc` closes.
  Right click: move, priority, assign to me, copy key/link, delete.
- **Commands**: *Open card board*, *Create card*, *Go to card…*.
- Responsive by **pane width** (not window width): works side by side with a note, in a split view, or on a phone.
- Theme: uses Obsidian's variables, so it follows any light/dark theme. The interface is available in English and
  Brazilian Portuguese (it follows Obsidian's language).

Settings: folder, project key, your name, members, hiding old done cards (14 days by default),
and columns (name, "done", WIP, order). Each column's `id` is stable: renaming one does not touch any card.

## CLI

```
oprojects add <title…> [-t type] [-p priority] [-s column] [-a assignee] [-l a,b] [--due date] [--estimate n] [--parent KEY] [--body text|-]
oprojects list|ls [-s column] [-t type] [-p priority] [-a name|none|me] [-l label] [--parent KEY] [-q text] [--mine] [--all]
oprojects board [--epics]            # kanban in the terminal, columns side by side
oprojects show <key>                 # the key can be OP-12 or just 12; lists the comments with their ids
oprojects comment|c <key> <text…|->  [--author name]        # comment ("-" reads from stdin)
oprojects comment <key> --edit <id> <text…|->   |   --rm <id>
oprojects move|mv <key> <column> [--before KEY | --after KEY]
oprojects edit <key> [--title …] [-p …] [--add-label x] [--rm-label y] [--due none] …   # "none" clears the field
oprojects rm <key>                   # goes to the vault's .trash/ (recoverable)
oprojects open <key>                 # opens it in Obsidian (obsidian://)
oprojects init | config
```

Global options in any position: `--vault <path>`, `--json`, `--no-color`. Dates accept `today`, `tomorrow`, `+3d`, `+2w`.
Exit codes: `0` ok · `1` validation/not-found error · `2` incorrect usage. With `--json` the output is stable for scripts.

## Architecture (and where the MCP fits)

```
packages/
  core/     card model, YAML, ranking, filters and CardService — no Obsidian, no DOM
  cli/      oprojects: a thin layer over CardService (fs)
  plugin/   Obsidian plugin; ui/ does not import 'obsidian' (testable in a browser)
  mcp/      (future) same idea as cli
```

The seam is the `Storage` interface (`packages/core/src/storage.ts`): `CardService` holds all the logic
(keys, ranking, validation, `resolved`, filters) and only asks for “list/read/create/modify/remove a file”.
There are two adapters today — `FsStorage` (CLI) and `ObsidianStorage` (plugin, uses `Vault.process`, atomic) — plus a
third one for tests (`MemoryStorage`).

**Status:** the CLI is the agent-facing interface today (scriptable, stable `--json` output, every write shows up live on
the board). The MCP server is planned and not implemented yet.

**To add the MCP**, create `packages/mcp` and map the tools straight onto the service:

| Tool | Call |
| --- | --- |
| `list_cards` | `svc.find(query)` — accepts `me`, `none`, column names, `includeArchived` |
| `get_card` | `svc.get(key)` |
| `create_card` / `update_card` | `svc.create(input)` / `svc.update(key, patch)` (`null` clears a field) |
| `add_comment` / `edit_comment` / `delete_comment` | `svc.addComment(key, { text, author })` / `svc.editComment(key, id, text)` / `svc.removeComment(key, id)` — the agent passes its own `author` (e.g. "Claude") |
| `move_card` | `svc.move(key, column, { before?, after? })` |
| `delete_card` | `svc.remove(key)` |
| `board_summary` | `groupByColumn(await svc.list(), svc.config)` |

Build the service the way the CLI does: `findVaultRoot` → `loadBoardConfig` → `new CardService(new FsStorage(root), config)`
(`@oprojects/core/node`). The `ValidationError`/`NotFoundError` errors already carry a useful message (they list the valid
columns, etc.) and work as the tool's error result. MCP writes show up live on an open board (the plugin watches the vault).

## Performance

The board reads from the **in-memory index** (`CardStore`), never from disk. On startup the plugin reads each note once;
after that, each vault event reloads only the affected note (batched). Rendering is incremental: each card has a
signature and is only redrawn when it changed; columns reuse elements by key; `content-visibility: auto`
skips layout for off-screen cards. Moving a card writes **one** note (fractional ranking, no renumbering of the column),
and the screen updates before the disk (with a rollback if the write fails).

Measured (Chrome, 2,000 cards, 1,665 visible; the measurement floor is ~33 ms because it waits for 2 frames):

| Operation | Result |
| --- | --- |
| First paint | ~145 ms (≈ 25 ms with 500 cards) |
| Editing a card | < 1 frame |
| Typing in the search | 1–2 frames |
| Clearing the search | ~40 ms |
| Scrolling the largest column | 60 fps |

CLI with 2,000 notes on disk: `show` 0.04 s · `ls/board/add/move` ~0.45 s (they read and parse the YAML of every note).
If your vault grows past a few thousand cards, the next win is reading the frontmatter from Obsidian's `metadataCache`
instead of re-parsing every note on startup.

## Development

```bash
npm run check          # types + unit tests + build + UI tests
npm test               # vitest (core, cli, the plugin's store/host)
npm run test:ui        # browser: drags, filters, edits… on the real BoardUI (needs Chrome; CHROME=/path)
npm run test:obsidian  # inside the real Obsidian, with a throwaway vault and profile (OBSIDIAN=/path)
npm run dev            # rebuilds on change
npm run version:check  # every version in the repo agrees (part of `check`)
npm run seed           # fills ./dev-vault with 24 sample cards
```

- **Browser harness**: after `npm run build`, serve `packages/plugin` (`python3 -m http.server -d packages/plugin`)
  and open `/dev/harness.html?theme=dark&lang=en&width=520px`. It is the same `BoardUI` on top of an in-memory `CardService`.
- `test:obsidian` creates its own Obsidian profile (`--user-data-dir`) and talks to it over the DevTools Protocol in
  headless mode; it **does not open or change your Obsidian, your profile or your vaults**.

## Versioning and releases

The project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html), with a single version for the plugin,
the CLI and the core. Every change is recorded in the [CHANGELOG](CHANGELOG.md), and releases are published on
[GitHub](https://github.com/GustavoEklund/obsidian-projects/releases) when a version tag is pushed. What counts as a
breaking change and how a release is cut: [RELEASING.md](RELEASING.md). The project is still `0.x`: until `1.0.0`,
breaking changes bump the minor version and are flagged in the changelog.

## Contributing

Bug reports and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[The Unlicense](LICENSE): this is free and unencumbered software released into the public domain. Do whatever you want
with it. The released bundles include [`yaml`](https://github.com/eemeli/yaml) (ISC), whose notice is embedded at the
top of `main.js` and `oprojects.cjs`.

## Known limitations

- One board per vault (one project key). Keys are unique; if two notes share the same `key` (a sync conflict), the last one read wins.
- No subtasks as cards, attachments or activity history (use the note body). Comments have no nested replies,
  mentions or reactions, and there is no control over who can edit/delete them (anyone who opens the vault can).
- `oprojects init` writes the plugin's `data.json`: run it **before** opening the plugin, or reload the plugin afterwards.
  Changing the configuration through the CLI while the plugin is open is not detected; changing it in the plugin's settings is (the CLI reads the same file).
- Creating two cards at the same time (plugin + CLI) is safe: the colliding key is dropped and the next one is used.
  Simultaneous edits to the **same** card have no conflict resolution (last write wins).
- The plugin uses only the Obsidian API (no Node) but **has not been tested on a phone**; dragging uses HTML5 DnD
  (on touch, use the context menu or `Alt+arrows`).
- When you remove a column in the settings, its cards appear in the first column (the notes do not change).
