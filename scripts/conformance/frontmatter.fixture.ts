// Conformance cases for the YAML frontmatter (packages/core/src/frontmatter.ts), ported by packages/mcp/src/frontmatter.rs:
// splitting a note, reading its frontmatter, and patching it. The reference is whatever the TypeScript core does.
import { parseFrontmatter, patchFrontmatter, splitFrontmatter } from '@oprojects/core';
import { attempt } from './outcome';
import { chance, int, pick, rng, type Case, type FixtureFile, type Random } from './lib';

export const name = 'frontmatter';

// --- YAML snippets -----------------------------------------------------------------------------------------------------

/** Valid YAML documents (mappings) that exercise the reader: every kind of scalar, collection, comment and style. */
const VALID: string[] = [
  'a: 1',
  'title: Fix the login\nstatus: doing\ntype: bug\npriority: high',
  'labels: [auth, backend]',
  'labels: [ auth, backend ]',
  'labels:\n  - auth\n  - backend',
  'labels: []\nempty: {}',
  'due: 2026-10-20\nestimate: 3\nparent: OP-1',
  'created: 2026-10-01T10:00:00.000Z\nupdated: 2026-10-02T10:00:00.000Z',
  'note: |\n  line one\n  line two\nnext: 1',
  'note: |-\n  stripped\nnext: 1',
  'note: |+\n  kept\n\nnext: 1',
  'note: >\n  folded\n  text\nnext: 1',
  'note: >-\n  folded\n  text\n\nnext: 1',
  'note: |2\n    indented more\nnext: 1',
  'q: "double \\"quoted\\" \\\\ \\n text \\u00e9 \\x41 \\t"',
  "q: 'single ''quoted'' text'",
  'multi: first line\n  continued line\nnext: 1',
  'multi: "first\n  second"\nnext: 1',
  "multi: 'first\n  second'\nnext: 1",
  'anchors: &x [1, 2]\nref: *x',
  'nested:\n  a: 1\n  b:\n    - x\n    - y\nafter: 1',
  'list_of_maps:\n  - a: 1\n    b: 2\n  - c: 3',
  'empty:\nnull_value: ~\nexplicit: null\nNull: Null',
  'a: yes\nb: no\nc: on\nd: off\ne: y\nf: n\ng: True\nh: FALSE',
  'a: 0x1F\nb: 0o17\nc: 1e3\nd: .5\ne: +.inf\nf: -.inf\ng: .nan\nh: 007\ni: 1_000\nj: 0b1\nk: 12e\nl: 1.2.3\nm: +5\nn: -0\no: 1.\np: 1.0',
  'a: 123456789012345678901234567890\nb: 1.7976931348623157e308\nc: 1e400\nd: 0.1\ne: 100',
  'unicode: Zoë 日本語 🙂\nspaces: a  b   c',
  'tagged: !!str 123\nint: !!int "12"\nother: !custom foo',
  'flow_map: {a: 1, b: [2, 3], c: {d: e}}',
  '"quoted key": 1\n\'single key\': 2',
  '? complex\n: value',
  'key with spaces: v\nkey-with-dashes: v\nkey_with_underscores: v',
  'inline comment: value # trailing comment\nother: 1 #c',
  '# leading comment\na: 1\n# middle\nb: 2\n# trailing comment',
  'a: 1\n\n\nb: 2\n\n',
  'a:   spaced   value  \nb:\t tabbed',
  'colon: a:b\ncolon2: "a: b"\nhash: a#b\nurl: https://example.com/a?b=c#d',
  'date_time: 2026-10-20T10:00:00Z\nversion: 1.0\nversion2: 1.10\npercent: 100%',
  'at: "@home"\nstar: "*"\ndash: "- x"\nq: "?"',
  'a: -\nb: ?\nc: - x',
  'a: [1, [2, 3], {b: 4}, "x", \'y\', ~]',
  'a: {b: 1, c}',
  'k: v\n...',
  '---\na: 1',
  'a: 1\nb: 2',
  'related: ["[[Other]]", "[[Another note]]"]\ntags:\n  - a/b\n  - c',
  'a:\n- x\n- y\nb: z',
  'a: |\n  # not a comment\n  - [ ] not a task\nb: 1',
  'a: &anchor value\nb: *anchor',
  'merge: &m {x: 1}\nother:\n  <<: *m\n  y: 2',
  'a: \u00a0\nb: \u3000',
  '"": empty key',
  'a: 1 # one\nb: |  # block comment\n  text\nc: [x,\n  y] # flow comment',
];

/**
 * Explicit tags for types that are not in the core schema. `yaml` resolves them to a Buffer, a Set, a Map...: objects,
 * never a string or number. The Rust reader reads them as an empty object, which is what a card field cannot tell apart.
 */
const EXOTIC: string[] = [
  'a: !!binary aGVsbG8=\nb: !!set {x, y}',
  'title: !!binary aGVsbG8=\nstatus: !!omap [a: 1]\nkey: ok',
  'list: !!set\n  ? a\n  ? b\nnext: 1',
];

/** Documents the reader must reject (the TypeScript reports errors, so frontmatter reads as `{}`). */
const BROKEN: string[] = [
  'a: [unclosed',
  'a: {unclosed',
  'a: "unclosed',
  "a: 'unclosed",
  'a: b: c',
  'a: 1\na: 2',
  'A: 1\n"A": 2',
  'a: *missing',
  '- a\n- b',
  'just a string',
  'a: 1\n  b: 2',
  'a:\n  - x\n b: y',
  '\ttab: 1',
  'a: @bad',
  'a: `bad',
  'a: %bad',
  ': value',
  'a: 1\n---\nb: 2',
  'a: !!int abc',
  'a: "bad \\q escape"',
  'a: [1, 2,, 3]',
  'a: [1 2]',
  '{a: 1',
  'a: ]',
  'a: 1 b',
  'key',
  'a: &x 1\nb: &x 2\nc: *x',
  'a: |\nb: 1\n  c',
  "a: 'it's'",
  'a: "x" y',
  '- a\nb: 1',
  'a: 1\n- b',
  '? [unclosed\n: v',
  'a: 1\n\tb: 2',
  '[a, b]',
  '{a: 1}\nb: 2',
  '"quoted"\nmore',
  'a: {b: 1,, c: 2}',
  'a: -',
  '%YAML 1.2\n---\na: 1',
  'a: 1\n...\n---\nb: 2',
];

const KEYS = [
  'title',
  'status',
  'type',
  'priority',
  'assignee',
  'labels',
  'due',
  'estimate',
  'parent',
  'rank',
  'created',
  'updated',
  'resolved',
  'custom',
  'related',
  'note',
  'x',
  'my_field',
  'key-1',
];

const WORDS = [
  'Fix the login',
  'OP-12',
  'todo',
  'high',
  '2026-10-20',
  'Zoë café',
  'a, b',
  'x: y',
  "it's",
  'say "hi"',
  'both \' and "',
  'path/to/file',
  '100%',
  'a#b',
  'C++',
  'node.js',
  'https://x.y/z?a=b#c',
  '— dash',
  'ünïcode',
  '日本語',
  '🙂 emoji',
  '1',
  '-1',
  '1.5',
  'true',
  'null',
  '~',
  '0x1F',
  '0o7',
  '1e3',
  '.inf',
  'yes',
  'no',
  'on',
  '',
  ' ',
  '-',
  '?',
  '- x',
  '? x',
  '#c',
  '&a',
  '*a',
  '!t',
  '|',
  '>',
  "'q'",
  '"q"',
  '%p',
  '@at',
  '`bt`',
  '[x]',
  '{y}',
  'a,b',
  'x ',
  ' x',
  ':',
  'a:',
  ': b',
  'a: ',
  'a :b',
  'a #b',
  'a\tb',
  'tab\t',
  'x  y',
  '---',
  '--- x',
  '...',
  'a\nb',
  'line1\n\nline3',
  'trailing\n',
  '\u00a0',
  'a\u00a0',
  '\u3000',
  'x\u2028y',
  'ctl\u0007x',
  'del\u007fx',
  'nel\u0085',
  '\ufeffbom',
  'quote"mid',
  "apo'strophe",
  'back\\slash',
  'a'.repeat(95),
  'word '.repeat(30).trim(),
  '=',
  '<>',
  '!',
  '*',
  '&',
  '%',
  '@',
  '`',
];

function randomScalarText(r: Random): string {
  const roll = r();
  if (roll < 0.25)
    return pick(r, [
      'yes',
      'no',
      'true',
      'false',
      'null',
      '~',
      '0x1F',
      '0o17',
      '1e3',
      '.5',
      '+5',
      '-0',
      '007',
      '2026-10-20',
      '1.0',
      '12',
      '3.14',
      'on',
      'off',
      'Null',
      'TRUE',
    ]);
  if (roll < 0.6)
    return pick(
      r,
      WORDS.filter((w) => !/[\n\r\u0085\u2028\u2029\ufeff]/.test(w)),
    ).replace(/^(\s)/, 'x$1');
  if (roll < 0.75)
    return `"${pick(r, WORDS).replace(/[\\"\n\r\t]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]!)}"`;
  if (roll < 0.85) return `'${pick(r, WORDS).replace(/['\n\r]/g, (c) => (c === "'" ? "''" : ' '))}'`;
  if (roll < 0.93)
    return `[${Array.from({ length: int(r, 0, 4) }, () => pick(r, ['a', 'b', '1', '"x y"', 'true', '[1, 2]', '{k: v}', '~'])).join(', ')}]`;
  return `{${Array.from({ length: int(r, 0, 3) }, (_, i) => `k${i}: ${pick(r, ['1', 'v', '[a]', '"s"'])}`).join(', ')}}`;
}

/** A random document: pairs with comments, blank lines and the odd broken line, in LF or CRLF. */
function randomYaml(r: Random, breakIt: boolean): string {
  const lines: string[] = [];
  const keys = Array.from({ length: int(r, 0, 6) }, () => pick(r, KEYS));
  const used = new Set<string>();
  for (const key of keys) {
    if (used.has(key)) continue;
    used.add(key);
    if (chance(r, 0.2)) lines.push(pick(r, ['# a comment', '#', '  # indented comment', '', '   ']));
    const value = randomScalarText(r);
    lines.push(
      `${key}:${pick(r, [' ', ' ', ' ', '  ', '   ', '\t'])}${value}${chance(r, 0.15) ? pick(r, [' # why', '  #x']) : ''}`,
    );
    if (chance(r, 0.1)) lines.push(`  - nested ${int(r, 0, 9)}`);
  }
  if (chance(r, 0.15)) lines.push(pick(r, ['# footer comment', '', '  # ']));
  if (breakIt && lines.length)
    lines.splice(
      int(r, 0, lines.length),
      0,
      pick(r, [
        'a: [unclosed',
        'dup: 1\ndup: 2',
        ' bad indent: x',
        '\tTab: 1',
        'novalue',
        '- stray item',
        'a: "open',
        ': x',
      ]),
    );
  return lines.join(chance(r, 0.15) ? '\r\n' : '\n');
}

function note(r: Random, yaml: string): string {
  const eol = yaml.includes('\r\n') ? '\r\n' : '\n';
  const bom = chance(r, 0.06) ? '\ufeff' : '';
  const open = pick(r, ['---', '---', '---', '---  ', '--- \t']);
  const close = pick(r, ['---', '---', '---', '---  ']);
  const body = pick(r, [
    '',
    'body\n',
    'Body text\r\n',
    '# Heading\n\nSome *markdown* and a rule\n\n---\n\nmore',
    '- [ ] task\n',
    '\n',
    'x',
  ]);
  return `${bom}${open}${eol}${yaml}${eol}${close}${eol}${body}`;
}

// --- values for patches ------------------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_OR_SEPARATOR = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

/** What the Rust writer reproduces byte for byte: short single-line text without exotic characters. */
function isOrdinaryString(s: string): boolean {
  return (
    s.length <= 60 &&
    !/[\n\r]/.test(s) &&
    !CONTROL_OR_SEPARATOR.test(s) &&
    !/[^\S ]/.test(s) &&
    !/^(---|\.\.\.)/.test(s) &&
    !/\s$|^\s/.test(s.replace(/^ +| +$/g, (m) => m.replace(/ /g, '_')))
  );
}

function isOrdinary(v: unknown): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return isOrdinaryString(v);
  if (Array.isArray(v))
    return (
      v.length <= 5 &&
      v.every((x) => (typeof x === 'string' ? isOrdinaryString(x) : isOrdinary(x) && !Array.isArray(x) && x !== null))
    );
  return false;
}

function patchValue(r: Random): unknown {
  const roll = r();
  if (roll < 0.12) return null;
  if (roll < 0.55) return pick(r, WORDS);
  if (roll < 0.68) return pick(r, [0, 1, 3, 13, -2, 2.5, 0.1, 1e21, 123456789, 1.5e-7, 4.35, 2 ** 53]);
  if (roll < 0.75) return chance(r, 0.5);
  if (roll < 0.95)
    return Array.from({ length: int(r, 0, 4) }, () =>
      chance(r, 0.85)
        ? pick(
            r,
            WORDS.filter((w) => w.length < 20),
          )
        : pick(r, [1, 2.5, true, 'x']),
    ).filter((x) => typeof x !== 'string' || !x.includes('\n') || chance(r, 0.5));
  return pick(r, [{ a: 1 }, { nested: ['x', 2] }, {}]);
}

type Patch = [string, unknown][];

function randomPatch(r: Random, existing: string[]): Patch {
  const patch: Patch = [];
  const used = new Set<string>();
  for (let i = int(r, 0, 4); i > 0; i--) {
    const key = chance(r, 0.6) && existing.length ? pick(r, existing) : pick(r, KEYS);
    if (used.has(key)) continue;
    used.add(key);
    patch.push([key, patchValue(r)]);
  }
  return patch;
}

function runPatch(content: string, patch: Patch, body: string | null) {
  return attempt(() => {
    const out =
      body === null
        ? patchFrontmatter(content, Object.fromEntries(patch))
        : patchFrontmatter(content, Object.fromEntries(patch), body);
    return { text: out, parsed: attempt(() => parseFrontmatter(out)), body: splitFrontmatter(out).body };
  });
}

/**
 * Notes that use tags (`!t`, `!!int`) or aliases (`*x`). The core edits the node it finds, so a replaced value keeps its
 * tag and its anchor: `resolved: !t` patched with `true` stays the *string* "true", and an alias follows the anchor it
 * points to. Rust writes the value that was asked for, plain, and rewrites the note from its values when an anchor would
 * be left dangling. Such cases only require that the result says what was asked.
 */
const hasTagOrAlias = (content: string): boolean => /(^|[\s:[,])(!|\*[A-Za-z_])/m.test(content);

function patchCase(id: string, content: string, patch: Patch, body: string | null, canonicalSource: boolean): Case {
  const outcome = runPatch(content, patch, body);
  const exact = canonicalSource && patch.every(([, v]) => isOrdinary(v)) && outcome.ok;
  const lenient = hasTagOrAlias(content);
  const expected = outcome.ok
    ? { ok: true, ...outcome.value, exact, ...(lenient ? { lenient } : {}) }
    : {
        ok: false,
        kind: outcome.error.includes('key: value') ? 'not-map' : 'invalid',
        ...(lenient ? { lenient } : {}),
      };
  return { id, input: { content, patch, body }, expected };
}

export function generate(): FixtureFile {
  const r = rng(515151);
  const cases: Case[] = [];

  // --- split ---------------------------------------------------------------------------------------------------------------------
  const splits = [
    '---\na: 1\n---\nhello\n',
    '# Title\ntext',
    '\ufeff---\r\na: 1\r\n---\r\nbody',
    '---\n---\nbody',
    '---\r\n---\r\nbody',
    '---\n---',
    'intro\n\n---\n\nmore',
    '---\na: 1\nno closing fence',
    'text\n---\na: 1\n---\n',
    '---\na: 1\n---\nbody\n---\nrule\n',
    '---\n---\n---\nx',
    '---  \ta: 1\n',
    '---  \t\na: 1\n---   \nbody',
    '',
    '---',
    '---\n',
    '---\n\n---\n',
    '---\r\n\r\n---\r\nb',
    '---\na: 1\n\n---\nbody',
    '---\na: 1\r\n---\nmixed',
    '---\na: 1\n---\r\nmixed',
    '---\r\na: 1\n---\nmixed',
    '---\na: 1\n---x\nnot a fence',
    '---\na: 1\n----\nfour dashes',
    '---\na: 1\n--- \t',
    '\ufeff\ufeff---\na: 1\n---\n',
    ' ---\na: 1\n---\n',
    '---\n\n\n---\n',
    '---\r\n---\n',
    '---\n---\r\nb',
    '---\na: 1\n---\n\n\nbody',
    '---a\nb\n---\n',
  ];
  for (let i = 0; i < 160; i++) splits.push(note(r, randomYaml(r, chance(r, 0.3))));
  for (let i = 0; i < 40; i++)
    splits.push(
      Array.from({ length: int(r, 0, 7) }, () =>
        pick(r, ['---', '--- ', 'a: 1', '', '\r', '---\r', 'text', '- x', '\u2028']),
      ).join(pick(r, ['\n', '\r\n', '\n\n'])),
    );
  splits.forEach((s, i) => cases.push({ id: `split:${i}`, input: s, expected: splitFrontmatter(s) }));

  // --- parse ----------------------------------------------------------------------------------------------------------------------
  const docs = [...VALID, ...BROKEN];
  for (let i = 0; i < 260; i++) docs.push(randomYaml(r, chance(r, 0.25)));
  docs.forEach((y, i) => {
    const content = chance(r, 0.2) ? note(r, y) : `---\n${y}\n---\n`;
    cases.push({ id: `parse:${i}`, input: content, expected: attempt(() => parseFrontmatter(content)) });
  });
  EXOTIC.forEach((y, i) => {
    const content = `---\n${y}\n---\n`;
    cases.push({ id: `exotic:${i}`, input: content, expected: attempt(() => parseFrontmatter(content)) });
  });
  for (const raw of [
    '',
    '---\n---\n',
    'no frontmatter',
    '---\nnull\n---\n',
    '---\n~\n---\n',
    '---\n"just a string"\n---\n',
    '---\n# only a comment\n---\nx',
    '---\n   \n---\n',
  ])
    cases.push({
      id: `parse:raw:${raw.length}:${cases.length}`,
      input: raw,
      expected: attempt(() => parseFrontmatter(raw)),
    });

  // --- patch ----------------------------------------------------------------------------------------------------------------------
  let n = 0;
  const add = (c: Case) => cases.push({ ...c, id: `patch:${n++}` });

  // From nothing, and from notes the core wrote itself (canonical text): the output is expected byte for byte.
  for (let i = 0; i < 160; i++) {
    let content = chance(r, 0.15) ? 'just a body\n' : '';
    const rounds = int(r, 1, 3);
    for (let round = 0; round < rounds; round++) {
      const existing = Object.keys(attempt(() => parseFrontmatter(content)).ok ? parseFrontmatter(content) : {});
      const patch = randomPatch(r, existing);
      const body = chance(r, 0.15) ? pick(r, ['', 'new body\n', 'x']) : null;
      const outcome = runPatch(content, patch, body);
      add(patchCase('', content, patch, body, true));
      if (!outcome.ok) break;
      content = outcome.value.text;
    }
  }

  // From notes written by hand: comments, spacing, block scalars, quotes. Only the meaning is compared.
  for (let i = 0; i < 90; i++) {
    const yaml = i < VALID.length ? VALID[i]! : randomYaml(r, false);
    const content = chance(r, 0.5) ? note(r, yaml) : `---\n${yaml}\n---\nbody\n`;
    const existing = Object.keys(attempt(() => parseFrontmatter(content)).ok ? parseFrontmatter(content) : {});
    add(patchCase('', content, randomPatch(r, existing), chance(r, 0.15) ? 'replaced\n' : null, false));
  }
  // Every key of a hand-written note replaced, and every key removed.
  for (let i = 0; i < VALID.length; i++) {
    const content = `---\n${VALID[i]}\n---\nbody\n`;
    const keys = Object.keys(attempt(() => parseFrontmatter(content)).ok ? parseFrontmatter(content) : {});
    if (!keys.length) continue;
    add(
      patchCase(
        '',
        content,
        keys.map((k): [string, unknown] => [k, 'REPLACED']),
        null,
        false,
      ),
    );
    add(
      patchCase(
        '',
        content,
        keys.map((k): [string, unknown] => [k, null]),
        null,
        false,
      ),
    );
    add(patchCase('', content, [[keys[0]!, null]], null, false));
    add(patchCase('', content, [[keys[keys.length - 1]!, ['x', 'y']]], null, false));
  }
  // Notes that must not be rewritten.
  for (const yaml of BROKEN) add(patchCase('', `---\n${yaml}\n---\nbody\n`, [['a', 1]], null, false));
  for (const content of [
    '---\njust a string\n---\nx',
    '---\n- a\n- b\n---\nx',
    '---\n"just a string"\n---\nx',
    '---\n~\n---\nx',
    '---\nnull\n---\nx',
  ])
    add(patchCase('', content, [['b', 1]], null, false));
  // Edge shapes: BOM, CRLF, empty blocks, no frontmatter, trailing spaces, only comments.
  const edges = [
    '\ufeff---\r\ntitle: Hello\r\n---\r\nBody\r\n',
    '---\n---\nx',
    '---\r\n---\r\nx',
    'body only',
    '',
    '---\n# only a comment\n---\nx',
    '---\na: 1\n\n\n---\nx',
    '---\na: 1   \n---\nx',
    '---\ntitle: Old\nstatus: todo\n---\nBody text\n',
    '---\n# my note\ntitle: A\ncustom: keep me\nrelated: ["[[Other]]"]\n---\nx',
    '---\ntitle: |-\n  first\n  second\nother: kept\n---\nbody\n',
    '---\ntitle: |- # why\n  first\n  second\n---\n',
    '---\n  indented: 1\n  other: 2\n---\nx',
  ];
  for (const content of edges) {
    for (const patch of [
      [['a', 1]],
      [['title', 'New']],
      [['title', ' ']],
      [['gone', null]],
      [
        ['title', null],
        ['status', null],
      ],
      [['labels', ['a', 'b']]],
      [['k', '\u00a0']],
      [['k', 'a\u00a0']],
      [['k', '-\u00a0']],
      [['a', null]],
    ] as Patch[])
      add(patchCase('', content, patch, null, false));
  }
  // The values that were bugs once: whitespace-only and exotic trailing characters.
  for (const value of [
    '\u00a0',
    'a\u00a0',
    '-\u00a0',
    '-\u2028',
    '\u3000',
    ' ',
    'x ',
    '\n',
    'a\u2028',
    'multi\nline',
  ]) {
    add(patchCase('', '', [['k', value]], null, false));
    add(
      patchCase(
        '',
        '',
        [
          ['k', value],
          ['other', 1],
        ],
        null,
        false,
      ),
    );
  }

  return {
    description:
      'splitFrontmatter, parseFrontmatter (valid and broken YAML) and patchFrontmatter (canonical and hand-written notes, errors).',
    cases,
  };
}
