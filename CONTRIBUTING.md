# Contributing to Obsidian Projects

Thanks for wanting to help. Bug reports, ideas and pull requests are all welcome.

By contributing you agree that your contribution is released under the same terms as the rest of the project:
the [Unlicense](LICENSE), which dedicates the work to the public domain.

## Reporting a bug

Open an issue with:

- what you did, what you expected and what happened;
- the plugin version (*Settings → Community plugins*) or `oprojects --version`, your Obsidian version and your OS;
- if a card is involved, the text of its note (frontmatter included), with anything private removed;
- for the CLI, the command you ran and its output with `--json`.

For anything security-sensitive, do not open a public issue: follow [SECURITY.md](SECURITY.md) and report it privately.

## Getting set up

You need Node ≥ 20 and, for the UI tests, Chrome or Chromium. The MCP server and the native command line in `packages/mcp` are
Rust: if you work on them, install the toolchain pinned in `.tool-versions` (`asdf install` reads it; with plain `rustup`,
install that version). You do not need Rust to work on the plugin or the core.

```bash
git clone https://github.com/GustavoEklund/obsidian-projects.git
cd obsidian-projects
npm install
npm run check          # every quality gate for the TypeScript side (see below); this is what CI runs
npm run check:mcp      # the same for the Rust server (needs the Rust toolchain)
```

A comfortable loop for working on the plugin:

```bash
npm run seed                                           # 24 sample cards in ./dev-vault
npm run build
npm run install:vault -- dev-vault --link --enable     # link the build into the demo vault
npm run dev                                            # rebuild on every change; reload the plugin in Obsidian
```

Open `dev-vault` as a vault in Obsidian. For quicker UI work you can skip Obsidian: serve `packages/plugin` with
`python3 -m http.server -d packages/plugin` and open `/dev/harness.html` (see the README).

## How the code is organised

```
packages/core     card model, YAML, ranking, filters and CardService: no Obsidian, no DOM
packages/cli      oprojects in TypeScript: the reference the Rust command line is tested against (deprecated as a program)
packages/plugin   the Obsidian plugin; ui/ never imports 'obsidian' so it runs in a plain browser
packages/mcp      Rust: oprojects-mcp (the MCP server) and oprojects (the command line), ports of core and cli
scripts/          build, demo data, installer, tests that drive a browser or the real Obsidian, release tooling
```

The rule that keeps this manageable: **behavior goes in `core`**, behind the `Storage` interface. The command line, the plugin
and the MCP server are thin shells over `CardService`, so a rule written there is the same everywhere.
Anything in `packages/plugin/src/ui/` talks to the app only through the `BoardHost` interface.

## Making a change

- Keep the change focused, and match the style of the code around it (naming, comment density, idioms). The project is
  strict TypeScript. Run `npm run format` before you commit: formatting is done by [Oxfmt](https://oxc.rs) and checked in CI,
  so there is nothing to argue about in review. [Oxlint](https://oxc.rs) catches the bugs a compiler does not.
- **Add tests.** Logic goes in a unit test next to the package (`packages/*/test`); for anything with invariants (ranking,
  parsing, round trips) prefer a property test with [fast-check](https://fast-check.dev). The interface is tested under
  jsdom in `packages/plugin/test` and in a real browser in `scripts/ui-test.mjs`. Anything that depends on how Obsidian
  itself behaves goes in `scripts/e2e-obsidian.mjs`, which runs the real app in a throwaway profile and never touches your
  own vaults (`npm run test:obsidian`). A bug fix starts with a test that fails without it.
- **Think about performance.** The board has to stay fast with thousands of cards: no per-card work on every render,
  no reads from disk while rendering (the board reads from the in-memory `CardStore`).
- **Be careful with dependencies.** The plugin ships as a single `main.js`; a new runtime dependency is
  a cost for every user. Open an issue first.
- The CSS classes are prefixed `op-`, and colors come from Obsidian's theme variables so the board follows the user's theme.
- If you change how the board looks, run `SHOTS=./shots npm run test:ui` and look at the screenshots.

## Quality gates

`npm run check` runs every gate, in the order CI does. CI runs them as separate jobs so a failure points at its cause, and
a final job, **All gates**, passes only when all of them do.

| Gate | Command | What it protects |
| --- | --- | --- |
| Lint | `npm run lint` | Bugs and suspicious code: Oxlint with the correctness, suspicious and perf rules, plus the import and vitest plugins. No `console` in the plugin or the core. |
| Formatting | `npm run format:check` | One code style (Oxfmt, 120 columns). `npm run format` fixes it. |
| Types | `npm run typecheck` | Strict TypeScript, including unused variables and parameters and implicit returns. |
| English only | `npm run check:language` | Source, tests, sample data and docs are English; only the interface dictionary may carry other languages. |
| Documentation | `npm run check:docs` | Every link, anchor, mentioned path, `npm run` script and CLI command in the docs exists; the CHANGELOG is well formed; the workflows are valid and pin their actions. |
| Versions | `npm run version:check` | Every file that carries the version agrees. |
| Unit tests and coverage | `npm run test:coverage` | Logic, property-based and model-based tests, the DOM UI under jsdom, and the gate scripts themselves. Fails below the coverage thresholds in `vitest.config.mts`. Runs on Node 20 and 22. |
| Build artifacts | `npm run check:bundle` | What ships: size budgets, no Node modules in the plugin (it must run on mobile), a license notice for every bundled package, and the plugin loads and exports a plugin class. |
| CLI smoke test | `npm run test:smoke` | The built `oprojects.cjs` works as a real process (shebang, bundled dependencies, stdin, exit codes). |
| Browser UI | `npm run test:ui` | The board in a real Chrome: drag and drop, editing, the resizable panel, wide content staying inside it. |
| Real Obsidian | `npm run test:obsidian` | The plugin inside Obsidian itself, in a throwaway profile (CI pins the Obsidian version). |
| Conformance corpus | `npm run conformance:check` | The fixtures that the Rust programs are tested against match what the TypeScript core and CLI produce today. |
| Rust programs | `npm run check:mcp` | `cargo fmt`, `clippy -D warnings` and the tests on Linux, macOS and Windows (the command line replays 2,300 invocations of the TypeScript one and runs as a real process); then, on Linux, the MCP binary driven as a real process (the official MCP SDK client judges the protocol; notes written by Rust are read back by the TypeScript core and the other way round). |
| Server budgets | `npm run check:mcp-perf` | Memory and latency of the MCP release binary on a 2,000-card vault: about 5 MB idle and 11 MB indexed, reads in about a millisecond. Fails on a regression of an order of magnitude. |
| Command line budgets | `npm run check:cli-perf` | Start-up, `list`, `show` and `add` of the `oprojects` release binary on a 2,000-card vault, and its size (about 1 MB). Fails on a regression of an order of magnitude. |
| Rust binaries | the `MCP binaries` workflow | The server and the command line build for the six release platforms (Linux x64/arm64 static, macOS Intel/Apple Silicon, Windows x64/arm64). |
| Dependency audit | `npm run audit:deps` | Known vulnerabilities in what ships. Advisories in development tools are reported without blocking. |

When the repository is public, make **All gates** a required status check for `main`.

### Changing the card logic

`packages/core` is the reference implementation, and `packages/mcp` is a port of it; `packages/cli` is the reference for
what the command line prints. If you change how notes are read, written, ordered, filtered or validated, or what a command
reads from its arguments or writes to the terminal, run `npm run conformance` (it regenerates `packages/mcp/tests/fixtures`
from the TypeScript code), commit the result, and make `cargo test` pass: the failing cases tell you what the Rust side
has to do. CI runs `npm run conformance:check` and fails on a stale corpus.

### Language

Code, comments, identifiers, tests, sample data, commit messages and documentation are in **English**. The interface text
is the exception: it lives in `packages/plugin/src/i18n.ts`, which has English (the source) and Brazilian Portuguese.
A new interface string needs an entry in every language, and a unit test fails if a language is missing a key or
changes the `{placeholders}`. To add a language, add a dictionary there and register it in `dictionaries`.

### Commits and pull requests

- A short imperative subject ("Fix drag handle on touch screens"), and a body explaining **why** when it is not obvious.
- Explain in the pull request what changed for the user, and how you tested it.
- `npm run check` must pass; it is what CI runs.

### The changelog and versioning

For every user-visible change, add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md), in the right group
(`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`). Start breaking changes with **BREAKING:** and say how
to migrate. Do not edit version numbers: maintainers do that when releasing. What counts as a breaking change, and how
a release is cut, is in [RELEASING.md](RELEASING.md).
