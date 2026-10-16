# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). What counts as the public API, and how releases
are cut, is described in [RELEASING.md](RELEASING.md).

## [Unreleased]

## [0.2.0] - 2026-10-16

### Added

- **MCP server** (`oprojects-mcp`), written in Rust so that it stays small: about 5 MB of memory when idle and 11 MB with
  2,000 cards indexed, a 3 MB binary, answers in milliseconds. Ten tools (`board_summary`, `list_cards`, `get_card`,
  `create_card`, `update_card`, `move_card`, `delete_card`, `add_comment`, `edit_comment`, `delete_comment`) over stdio, or
  over HTTP with `--http` (loopback only, bearer token required) to share one server between clients; `--read-only` offers
  only the tools that read. Binaries for Linux (x64, arm64), macOS (Intel, Apple Silicon) and Windows (x64, arm64) are
  attached to each release.

### Fixed

- Deleting several notes with the same name at the same time could lose one of them: the trash name was checked and then
  renamed over, so parallel removals overwrote each other.

## [0.1.0] - 2026-10-15

First release. While the version is `0.x`, anything may change between minor versions; breaking changes are
called out here.

### Added

- **Plugin**: a Jira-style board where every card is a Markdown note with frontmatter. Drag and drop between and
  within columns, WIP limits, due dates, checklist progress, epics, labels, assignees and priorities.
- **Details panel**: every field editable and saved automatically; the description opens rendered (Preview)
  and switches to the editor on click; checklist checkboxes work in the preview; the panel is resizable and
  wide content (tables, code, images) stays inside it.
- **Comments**: a thread per card stored in the note itself, under `## Comments`, as one Obsidian callout per comment.
- Filters (search, assignee, type, priority, label, epic, "only mine"), quick create, keyboard shortcuts,
  context menu, and the commands *Open card board*, *Create card* and *Go to card…*.
- Interface in English and Brazilian Portuguese, following Obsidian's language.
- **CLI** (`oprojects`): `add`, `list`, `board`, `show`, `comment`, `move`, `edit`, `rm`, `open`, `init`, `config`,
  with stable `--json` output and documented exit codes.
- **Core** (`@oprojects/core`): card model, YAML frontmatter, fractional ranking, filters and `CardService` over a
  `Storage` interface, shared by the plugin and the CLI and ready for an MCP server.
- Live updates: changes made outside the board (CLI, sync, hand edits) appear on the open board.
- Unit tests, a browser UI test and an end-to-end test inside the real Obsidian.

[Unreleased]: https://github.com/GustavoEklund/obsidian-projects/compare/0.2.0...HEAD
[0.2.0]: https://github.com/GustavoEklund/obsidian-projects/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/GustavoEklund/obsidian-projects/releases/tag/0.1.0
