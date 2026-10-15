# Versioning and releases

Obsidian Projects follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html), and every user-visible
change is recorded in the [CHANGELOG](CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format).

## One version for everything

The plugin, the CLI and the core library are released together, under a single version. It lives in:

| File | Field |
| --- | --- |
| `packages/plugin/manifest.json` | `version` (the one Obsidian reads; the source of truth) |
| `package.json` and `packages/*/package.json` | `version` |
| `package-lock.json` | `version` of the root and of each workspace |
| `versions.json` | an entry `"<version>": "<minAppVersion>"` |

You never edit these by hand: `npm run release` updates all of them, and `npm run version:check` (part of
`npm run check` and of CI) fails if any of them disagree. `oprojects --version` reads `packages/cli/package.json`.

## What counts as the public API

A change that can break something a user or a script depends on is a **breaking change**:

- **The CLI**: command and flag names, their meaning, exit codes, and the shape of `--json` output.
- **The note format**: the frontmatter keys and values of a card, the `KEY-n.md` file naming, and the
  `## Comments` callout format. Existing notes must keep working, or the release must say how to migrate them.
- **The plugin's saved data**: the schema of `data.json` and of the saved view state.
- **The MCP tools**, once the MCP server exists: tool names, parameters and result shapes.

Raising `minAppVersion` (dropping support for older Obsidian versions) is also treated as breaking.

Not public API, and free to change in any release: the CSS class names, the internal modules of `packages/*`
(they are not published to npm), the visual design, and the exact text of the interface.

## Which number to bump

| Change | Bump | Example |
| --- | --- | --- |
| Bug fix, no behavior change otherwise | patch | `0.1.0` → `0.1.1` |
| New feature, backward compatible | minor | `0.1.1` → `0.2.0` |
| Breaking change | major | `1.4.2` → `2.0.0` |

While the version is `0.y.z` (initial development) the API is not considered stable: a breaking change bumps the
**minor** number instead, and is marked **BREAKING** in the changelog. The project moves to `1.0.0` when the public
API above is something we are ready to keep stable.

Pre-releases use a SemVer suffix, such as `0.3.0-beta.1`. They are published as GitHub pre-releases.

## Cutting a release

You need a clean checkout of `main` with the changes merged. Along the way, every user-visible change should
already have been described under `## [Unreleased]` in the CHANGELOG (see [CONTRIBUTING](CONTRIBUTING.md)).

1. **Verify.** `npm run check`, plus `npm run test:obsidian` (it needs the Obsidian desktop app, so CI does not run it).
2. **Preview.** `npm run release -- minor --dry-run` prints the old and new version and refuses to continue
   when the working tree is dirty, the tag already exists, the version would not increase, or `## [Unreleased]` is empty.
3. **Release.** `npm run release -- minor` (or `major`, `patch`, or an explicit `0.3.0-beta.1`). It updates every file in
   the table above, turns `## [Unreleased]` into `## [x.y.z] - date` with a fresh empty `Unreleased` above it, commits
   `Release x.y.z` and creates the annotated tag `x.y.z`. Pass `--no-git` to only edit the files.
4. **Publish.** `git push origin main x.y.z`. Pushing the tag starts the
   [Release workflow](.github/workflows/release.yml), which checks that the tag equals the version in
   `manifest.json` (no `v` prefix: Obsidian requires it), runs the type check, the unit tests and the build, and
   creates the GitHub release with the notes taken from the CHANGELOG.
5. **Check.** Open the release and confirm the assets are there.

Each release carries:

| Asset | What it is |
| --- | --- |
| `main.js`, `manifest.json`, `styles.css` | the plugin, the three files Obsidian and [BRAT](https://github.com/TfTHacker/obsidian42-brat) install |
| `obsidian-projects-x.y.z.zip` | the same three files in an `obsidian-projects/` folder, to unzip into `.obsidian/plugins/` |
| `oprojects.cjs` | the CLI, a single executable file (needs Node ≥ 20) |
| `SHA256SUMS.txt` | checksums of the files above |

If the workflow fails before publishing, fix the problem, then move the tag: `git push --delete origin x.y.z`,
`git tag -d x.y.z`, commit the fix, and tag again. Never reuse a version that was already published; release `x.y.(z+1)`.

## Obsidian community directory

Submitting the plugin to Obsidian's community plugin directory needs `manifest.json` (and `versions.json`) at the
**root** of the repository. `versions.json` is already there; the manifest currently lives in `packages/plugin/`
(the release assets are all BRAT and manual installs need). Adding a root copy is the only step missing.
