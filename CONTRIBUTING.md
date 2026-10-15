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

For anything security-sensitive, do not open a public issue: contact the maintainer through GitHub instead.

## Getting set up

You need Node ≥ 20 and, for the UI tests, Chrome or Chromium.

```bash
git clone https://github.com/GustavoEklund/obsidian-projects.git
cd obsidian-projects
npm install
npm run check          # types + unit tests + version check + build + browser UI tests
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
packages/cli      oprojects: a thin layer over CardService
packages/plugin   the Obsidian plugin; ui/ never imports 'obsidian' so it runs in a plain browser
scripts/          build, demo data, installer, tests that drive a browser or the real Obsidian, release tooling
```

The rule that keeps this manageable: **behavior goes in `core`**, behind the `Storage` interface. The CLI, the plugin
and the future MCP server are thin shells over `CardService`, so a rule written there is the same everywhere.
Anything in `packages/plugin/src/ui/` talks to the app only through the `BoardHost` interface.

## Making a change

- Keep the change focused, and match the style of the code around it (naming, comment density, idioms). The project is
  TypeScript with `strict` on; there is no separate formatter to run.
- **Add tests.** Logic goes in a unit test next to the package (`packages/*/test`). Behavior of the interface goes in
  `scripts/ui-test.mjs`. Anything that depends on how Obsidian itself behaves goes in `scripts/e2e-obsidian.mjs`, which
  runs the real app in a throwaway profile and never touches your own vaults (`npm run test:obsidian`).
- **Think about performance.** The board has to stay fast with thousands of cards: no per-card work on every render,
  no reads from disk while rendering (the board reads from the in-memory `CardStore`).
- **Be careful with dependencies.** The plugin ships as a single `main.js`; a new runtime dependency is
  a cost for every user. Open an issue first.
- The CSS classes are prefixed `op-`, and colors come from Obsidian's theme variables so the board follows the user's theme.
- If you change how the board looks, run `SHOTS=./shots npm run test:ui` and look at the screenshots.

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
