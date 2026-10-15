# Security policy

## Supported versions

Obsidian Projects is `0.x`: only the latest release receives fixes. Please check that a problem still happens on the
[latest release](https://github.com/GustavoEklund/obsidian-projects/releases/latest) before reporting it.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately through GitHub:
[report a vulnerability](https://github.com/GustavoEklund/obsidian-projects/security/advisories/new).

Include what you can of:

- the affected part (the plugin or the `oprojects` CLI) and its version;
- what you did, what you expected and what happened, and the impact you see;
- if a note is involved, the text of that note (frontmatter included), with anything private removed.

This is a personal project maintained in spare time, so reports are handled on a best-effort basis. A fix is released as
a new version and described in the [CHANGELOG](CHANGELOG.md); you are credited there unless you prefer not to be.

## What the software does, for your threat model

- It runs entirely on your machine. It reads and writes Markdown notes inside your vault, and the plugin's own
  `data.json`. It makes **no network requests**: neither the plugin nor the CLI contains any code that does.
- The only other thing it launches is the CLI's `open` command, which asks your operating system to open an
  `obsidian://` link.
- The CLI refuses paths that escape the vault, and `rm` moves a note to the vault's `.trash` instead of deleting it.
- Notes are plain text that you and your sync tool can read: do not put secrets in cards.

What is in scope: the plugin and the CLI as released, for example a crafted note or comment that makes them write
outside the vault, run code, or lose data. What is not: Obsidian itself, your sync tool, and the third-party code the
bundles include ([`yaml`](https://github.com/eemeli/yaml), reported to its own maintainers).
