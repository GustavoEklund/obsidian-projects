# The MCP server: design

`oprojects-mcp` lets an AI agent (Claude Code, Claude Desktop, Cursor, any MCP client) read and edit the cards of a
vault. It is a Rust program that reads and writes the same notes as the plugin and the CLI.

## Why Rust

The server is a long-lived process that every agent session starts, and the goal is to be fast and small. Measured on the
same 10-tool server, with the official SDK of each language (`scripts` and numbers in the commit history):

| | Memory (RSS) | Start to `initialize` | Program |
| --- | --- | --- | --- |
| Rust, `rmcp` | **3.6 MB** | **18 ms** | 1.9 MB binary |
| TypeScript, hand-written protocol | 44 MB | 81 ms | 3 KB of JS, plus Node |
| TypeScript, official SDK v2 | 66 MB | 243 ms | 396 KB of JS, plus Node |

An idle Node.js process alone is 42 MB, and no Node flag lowers it, so the gap cannot be closed in TypeScript.

## The price, and how it is paid

The card logic now exists twice. To keep the two from drifting apart:

- **`packages/core` (TypeScript) stays the reference implementation.** The Rust crate is a port, never the other way round.
- **A conformance corpus.** `scripts/conformance/*.fixture.ts` generate `packages/mcp/tests/fixtures/*.json` from the
  TypeScript core: inputs and the output the reference produced. The Rust tests replay every case. `npm run
  conformance:check` runs in CI and fails when a committed fixture differs from what the generators produce, so a change
  in the TypeScript behavior cannot land without the corpus (and therefore the Rust tests) being updated.
- **The same version.** `Cargo.toml` and `Cargo.lock` carry the repository's single version, bumped by `npm run release`.
- **Round trips in both directions.** A note written by Rust must be read by TypeScript to the same card, and the reverse.

## What a card edit must preserve

A user may have added keys, YAML comments and prose by hand. Editing a card changes only the keys it touches and leaves
every other byte of the note alone, exactly as the TypeScript core does. Comments live in the `## Comments` section as
Obsidian callouts, and editing a description never touches them.

## Reading the vault: an in-memory index

Parsing every note on every call is too slow for an agent (a full scan of 2,000 notes costs hundreds of milliseconds of
CPU), and `stat`-ing every file per call is too slow as well. So the server keeps an index of the cards in memory:

- Built once, in the background, so `initialize` is never delayed.
- Kept current by file-system events (`notify`), debounced, plus a periodic reconciliation that catches what events miss.
- Strings are copied out of the note text, so a card never keeps its whole note alive.
- `get_card` and every write read the file itself: single-card operations are always fresh, whatever the index says.

## Writing

Writes are atomic (temp file and rename), queued per file so two writes to one note never interleave, and refuse to
overwrite frontmatter they cannot parse. Deleting a card moves its note to the vault's `.trash`. New cards take the next
free number and retry if another writer (the plugin, the CLI) took it first.

## Transports

- **stdio** (default): the client starts the server. Nothing to configure beyond the command.
- **HTTP** (`--http`): a Streamable HTTP endpoint for one shared server across clients. It binds to `127.0.0.1`, requires a
  bearer token, and rejects requests whose `Origin` is not local (DNS rebinding).

## Safety

`--read-only` removes every write tool. Writes never touch anything outside the vault's cards folder. The server makes no
network requests of its own.

## Tools

`list_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `delete_card`, `add_comment`, `edit_comment`,
`delete_comment`, `board_summary`. Results are compact text, one line per card in lists, with a default `limit`, because
what the agent reads costs context.
