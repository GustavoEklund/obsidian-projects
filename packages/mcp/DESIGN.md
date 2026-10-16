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

### Platform notes

- macOS reports a deleted or renamed folder as one event, with none for the notes inside it, so a folder-level event
  triggers a rescan (hidden temporary files, which every atomic write makes, do not).
- On Windows the watch of a cards folder that was deleted and made again sometimes misses the notes written next. The
  server looks at the folder once a second, rebuilds its watcher when the folder goes away, and the periodic
  reconciliation (every 60 seconds) heals whatever is still missed.

## Writing

Writes are atomic (temp file and rename), queued per file so two writes to one note never interleave, and refuse to
overwrite frontmatter they cannot parse. Deleting a card moves its note to the vault's `.trash`. New cards take the next
free number and retry if another writer (the plugin, the CLI) took it first.

## Transports

### stdio (default)

The client starts the server and talks to it over stdin and stdout; nothing to configure beyond the command
(`claude mcp add obsidian-projects -- oprojects-mcp --vault <path>`). One process per client.

### HTTP (`--http`)

One shared server for several clients: `oprojects-mcp --http --token-file ~/.config/oprojects-mcp.token --vault <path>`.
The implementation is `src/http.rs` (the server) and `src/token.rs` (the secret): the Streamable HTTP service of `rmcp`
driven by `hyper` directly, with no web framework.

- **Local only.** It binds to `127.0.0.1`. There is no `--host` flag on purpose: exposing the server to a network is a
  different threat model (TLS, accounts) that this does not try to be.
- **A bearer token is required.** Reachable is not allowed: every program of the user can reach a loopback port. The token is
  given (`--token`, `$OPROJECTS_MCP_TOKEN`), kept in a file (`--token-file`, created with mode 0600 and reused on the next
  start), or generated for the run (32 random bytes as hex, printed once on stderr with the exact `claude mcp add` command). A
  given token is never printed back. It must have at least 16 visible ASCII characters. It is compared in constant time, and
  the request pipeline checks it right after the path, before the protocol layer sees anything else about the request.
- **DNS rebinding.** The protocol layer refuses a `Host` that is not a loopback name and any browser `Origin` other than this
  server's own two (`http://127.0.0.1:<port>`, `http://localhost:<port>`); listing the origins also turns the check on, since an
  empty list would turn it off.
- **Stateless.** Every request is complete in itself, the server keeps no session, answers with plain JSON and builds a fresh
  handler per request (cheap: the board and the tool router are shared). A restart loses nothing and an idle client costs no
  memory.
- **Bounded.** Request bodies up to 1 MiB (`413` above), 64 simultaneous connections (the next ones get `503` with
  `Retry-After`), a 30 s deadline for a connection to send its headers (this also closes idle keep-alive connections and cuts
  off a client that dribbles bytes), a 60 s deadline for a request (`408`), and a 5 s grace period at shutdown. Ctrl-C and
  SIGTERM stop the server gracefully.
- **Quiet.** stdout carries nothing. stderr tells where it listens and how to connect, never the token of a user and never a
  request body.

Measured with the release build (2.92 MB; the same binary without the HTTP code was 2.31 MB), a vault of 12 cards and then of
2,000, an idle server after one request and again after 500 requests:

| | 12 cards | 2,000 cards |
| --- | --- | --- |
| stdio, idle / after 500 calls | 4.7 / 4.7 MB | 10.6 / 10.8 MB |
| HTTP, idle / after 500 requests | 4.8 / 4.9 MB | 10.7 / 10.8 MB |
| `initialize` over stdio | 2 ms | 7 ms |

Serving HTTP adds about 0.6 MB to the binary and nothing measurable to the memory in use: the difference between the modes is
the index, not the transport. The tests (`tests/http.rs` in process, `scripts/mcp-tests/http.test.ts` against the binary with
`fetch` and the official SDK client) hold the budgets: at most 8 MB idle, and at most 3 MB of growth over 500 requests.

## Safety

`--read-only` removes every write tool. Writes never touch anything outside the vault's cards folder. The server makes no
network requests of its own.

## Tools

`list_cards`, `get_card`, `create_card`, `update_card`, `move_card`, `delete_card`, `add_comment`, `edit_comment`,
`delete_comment`, `board_summary`. Results are compact text, one line per card in lists, with a default `limit`, because
what the agent reads costs context.
