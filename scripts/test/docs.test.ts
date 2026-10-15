import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  changelogProblems,
  checkCliDocs,
  checkLinks,
  checkRepo,
  commandsFromHelp,
  headingSlugs,
  markdownLinks,
  mentionedPaths,
  npmScriptsMentioned,
  readmeCliCommands,
  withoutCode,
  workflowProblems,
} from '../quality/docs';
import { at } from '../quality/lib';

describe('withoutCode', () => {
  it('blanks fenced blocks and inline code but keeps the line count', () => {
    const md = 'a `inline` b\n```js\ncode [x](y)\n```\n~~~\nmore\n~~~\nend';
    const out = withoutCode(md);
    expect(out.split('\n')).toHaveLength(md.split('\n').length);
    expect(out).not.toContain('code');
    expect(out).not.toContain('inline');
    expect(out).not.toContain('more');
    expect(out.startsWith('a  b')).toBe(true);
    expect(out.endsWith('end')).toBe(true);
  });

  it('does not close a backtick fence with a tilde fence', () => {
    expect(withoutCode('```\n~~~\nstill code\n```\nafter')).not.toContain('still code');
  });
});

describe('markdownLinks', () => {
  it('finds links and images with their line numbers', () => {
    const md = 'See [one](a.md) and ![img](docs/p.png "title").\n\n[two](b.md#top)';
    expect(markdownLinks(md)).toEqual([
      { target: 'a.md', line: 1 },
      { target: 'docs/p.png', line: 1 },
      { target: 'b.md#top', line: 3 },
    ]);
  });

  it('ignores links in code, and reference-style definitions', () => {
    expect(markdownLinks('`[x](y)`\n```\n[x](z)\n```\n[ref]: https://example.com')).toEqual([]);
  });
});

describe('headingSlugs', () => {
  it('follows the GitHub rules: lowercase, punctuation dropped, spaces to hyphens', () => {
    const slugs = headingSlugs(
      '# Obsidian Projects\n## What a card looks like\n## Known limitations\n### CLI (and `exit` codes)!',
    );
    expect([...slugs]).toEqual([
      'obsidian-projects',
      'what-a-card-looks-like',
      'known-limitations',
      'cli-and-exit-codes',
    ]);
  });

  it('numbers duplicates like GitHub does', () => {
    expect([...headingSlugs('## Added\n## Added\n## Added')]).toEqual(['added', 'added-1', 'added-2']);
  });

  it('uses the text of a link in a heading and skips headings inside code', () => {
    expect([...headingSlugs('## See [the docs](x.md)\n```\n## not a heading\n```')]).toEqual(['see-the-docs']);
  });
});

describe('checkLinks', () => {
  const docs: Record<string, string> = {
    'README.md': '# Title\n\n## Install\n',
    'docs/guide.md': '# Guide\n\n## Steps\n',
    'docs/pic.png': '',
  };
  const exists = (p: string) => p in docs;
  const read = (p: string) => docs[p] ?? null;

  it('accepts links to files, images and headings that exist', () => {
    const md = '[a](../README.md#install) ![p](pic.png) [s](#steps) [g](guide.md#steps)\n\n## Steps\n';
    expect(checkLinks('docs/guide.md', md, read, exists)).toEqual([]);
  });

  it('flags a file that does not exist, with where it was looked for', () => {
    expect(checkLinks('docs/guide.md', 'x\n[gone](missing.md)', read, exists)).toEqual([
      'docs/guide.md:2: the link "missing.md" points at docs/missing.md, which does not exist',
    ]);
  });

  it('flags a heading that does not exist, in the same file or in another one', () => {
    const problems = checkLinks(
      'docs/guide.md',
      '[a](#nope) [b](../README.md#nope) [c](guide.md#steps)\n\n## Steps\n',
      read,
      exists,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('heading that does not exist in docs/guide.md');
    expect(problems[1]).toContain('heading that does not exist in README.md');
  });

  it('skips external links', () => {
    expect(
      checkLinks('README.md', '[w](https://example.com/x) [m](mailto:a@b.c) [p](//cdn.example.com/x)', read, exists),
    ).toEqual([]);
  });

  it('resolves percent-encoded paths', () => {
    expect(checkLinks('README.md', '[p](docs/pic%2Epng)', read, exists)).toEqual([]);
  });
});

describe('mentionedPaths', () => {
  it('finds repo paths in inline code, dropping a trailing slash', () => {
    expect(mentionedPaths('Edit `packages/core/src/x.ts` or `scripts/` or `.github/workflows/ci.yml`.')).toEqual([
      { target: 'packages/core/src/x.ts', line: 1 },
      { target: 'scripts', line: 1 },
      { target: '.github/workflows/ci.yml', line: 1 },
    ]);
  });

  it('ignores other inline code, and fenced blocks', () => {
    expect(mentionedPaths('`npm test` and `src/x.ts`\n```\n`packages/a`\n```')).toEqual([]);
  });
});

describe('npmScriptsMentioned', () => {
  it('finds `npm run <script>` with colons and hyphens', () => {
    expect(
      npmScriptsMentioned('Run npm run build, then `npm run install:vault -- dev-vault`.\nnpm run test:ui'),
    ).toEqual([
      { target: 'build', line: 1 },
      { target: 'install:vault', line: 1 },
      { target: 'test:ui', line: 2 },
    ]);
  });

  it('does not take `npm test` or `npm install` for a script name', () => {
    expect(npmScriptsMentioned('npm test\nnpm install\nnpm ci')).toEqual([]);
  });
});

describe('CLI docs', () => {
  const readme =
    '## CLI\n\n```\noprojects add <title…> [-t type]\noprojects list|ls [-s column]\noprojects comment|c <key>\noprojects comment <key> --edit <id>\noprojects init | config\n```\n';

  it('reads the commands and their aliases from the README block', () => {
    expect(readmeCliCommands(readme).sort()).toEqual(['add', 'c', 'comment', 'config', 'init', 'list', 'ls']);
  });

  it('reads the command names from the help text', () => {
    const help =
      'oprojects 0.1.0\n\nUsage\n  oprojects <command>\n\nCommands\n  add      Create a card\n  list     List cards\n\nGlobal options\n  --json   x';
    expect(commandsFromHelp(help)).toEqual(['add', 'list']);
    expect(commandsFromHelp('nothing here')).toEqual([]);
  });

  it('accepts the real README against the real CLI', async () => {
    expect(await checkCliDocs(readFileSync(at('README.md'), 'utf8'))).toEqual([]);
  });

  it('flags a real command missing from the README', async () => {
    const real = readFileSync(at('README.md'), 'utf8');
    const problems = await checkCliDocs(real.replace(/^oprojects rm .*$/m, ''));
    expect(problems).toEqual(['README.md: the CLI command "rm" is not documented in the CLI section']);
  });

  it('flags a documented command that does not exist', async () => {
    const real = readFileSync(at('README.md'), 'utf8');
    const problems = await checkCliDocs(
      real.replace('oprojects init | config', 'oprojects init | config | frobnicate'),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('documents "oprojects frobnicate", which is not a command');
  });
});

describe('changelogProblems', () => {
  const good = `# Changelog

## [Unreleased]

## [0.2.0] - 2026-11-01

### Added

- x

## [0.1.0] - 2026-10-15

- y

[Unreleased]: https://github.com/o/r/compare/0.2.0...HEAD
[0.2.0]: https://github.com/o/r/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/o/r/releases/tag/0.1.0
`;

  it('accepts a well-formed changelog', () => {
    expect(changelogProblems(good)).toEqual([]);
  });

  it('requires an Unreleased section, first', () => {
    expect(changelogProblems(good.replace('## [Unreleased]\n\n', ''))).toContain(
      'CHANGELOG.md: there is no "## [Unreleased]" section',
    );
    const swapped = good.replace(
      '## [Unreleased]\n\n## [0.2.0] - 2026-11-01',
      '## [0.2.0] - 2026-11-01\n\n## [Unreleased]',
    );
    expect(changelogProblems(swapped)).toContain('CHANGELOG.md: "## [Unreleased]" must come first');
  });

  it('requires versions newest first, valid SemVer and real dates', () => {
    expect(
      changelogProblems(good.replace('## [0.2.0]', '## [0.0.5]').replace('[0.2.0]:', '[0.0.5]:')).join(),
    ).toContain('newest first');
    expect(changelogProblems(good.replace('## [0.2.0]', '## [v0.2]'))[0]).toContain('not a valid SemVer');
    expect(changelogProblems(good.replace('2026-11-01', '2026-13-45')).join()).toContain('needs a date');
    expect(changelogProblems(good.replace(' - 2026-11-01', '')).join()).toContain('needs a date');
  });

  it('requires a compare link for each version and for Unreleased, based on the latest release', () => {
    expect(changelogProblems(good.replace(/^\[0\.1\.0\]:.*\n/m, ''))).toEqual([
      'CHANGELOG.md: no link reference for [0.1.0] at the bottom',
    ]);
    expect(changelogProblems(good.replace(/^\[Unreleased\]:.*\n/m, ''))[0]).toContain('no "[Unreleased]');
    expect(changelogProblems(good.replace('compare/0.2.0...HEAD', 'compare/0.1.0...HEAD'))[0]).toContain(
      'compares from 0.1.0, but the latest release is 0.2.0',
    );
  });

  it('accepts pre-release versions in order', () => {
    const pre = good
      .replace('## [Unreleased]\n', '## [Unreleased]\n\n## [0.3.0-beta.1] - 2026-12-01\n')
      .replace(
        '[Unreleased]: https://github.com/o/r/compare/0.2.0...HEAD',
        '[Unreleased]: https://github.com/o/r/compare/0.3.0-beta.1...HEAD\n[0.3.0-beta.1]: https://github.com/o/r/compare/0.2.0...0.3.0-beta.1',
      );
    expect(changelogProblems(pre)).toEqual([]);
  });

  it('accepts the real CHANGELOG', () => {
    expect(changelogProblems(readFileSync(at('CHANGELOG.md'), 'utf8'))).toEqual([]);
  });
});

describe('workflowProblems', () => {
  const scripts = new Set(['build', 'test', 'check']);
  const ok =
    'name: x\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v7\n      - run: npm run build\n';

  it('accepts a valid workflow with pinned actions and real scripts', () => {
    expect(workflowProblems('w.yml', ok, scripts)).toEqual([]);
  });

  it('accepts a commit SHA pin and a local action', () => {
    const text = `${ok}      - uses: org/act@${'a'.repeat(40)}\n      - uses: ./.github/actions/local\n`;
    expect(workflowProblems('w.yml', text, scripts)).toEqual([]);
  });

  it('flags an action that is not pinned', () => {
    for (const ref of ['actions/checkout@main', 'actions/checkout', 'actions/checkout@v7-beta']) {
      expect(workflowProblems('w.yml', ok.replace('actions/checkout@v7', ref), scripts), ref).toHaveLength(1);
    }
  });

  it('flags a script that does not exist, with its line', () => {
    expect(workflowProblems('w.yml', ok.replace('npm run build', 'npm run buidl'), scripts)).toEqual([
      'w.yml:8: runs "npm run buidl", which is not a script in package.json',
    ]);
  });

  it('flags YAML that does not parse, and a file without jobs', () => {
    expect(workflowProblems('w.yml', 'jobs: [unclosed', scripts)[0]).toContain('not valid YAML');
    expect(workflowProblems('w.yml', 'name: x\n', scripts)).toEqual(['w.yml: no jobs']);
  });
});

describe('the repository', () => {
  it('passes the whole documentation gate', async () => {
    expect(await checkRepo()).toEqual([]);
  });
});
