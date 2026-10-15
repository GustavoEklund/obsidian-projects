// Conformance cases for reading and writing a card (packages/core/src/card.ts), ported by packages/mcp/src/card.rs:
// the key and date rules, labels, checklists, parsing a hand-edited note into a card, the text of a new card, and the
// local patch the UIs apply.
import type { Card, CardPatch, Comment } from '@oprojects/core';
import {
  applyPatch,
  countChecklist,
  formatSection,
  isValidDate,
  keyNumber,
  newCardContent,
  normalizeLabels,
  parseCard,
  sameCard,
} from '@oprojects/core';
import { chance, int, pick, rng, type Case, type FixtureFile, type Random } from './lib';
import { attempt } from './outcome';

// Comment titles show local time: the corpus is produced in UTC and Rust is given an offset of 0.
process.env.TZ = 'UTC';

export const name = 'card';

// --- dates and keys ---------------------------------------------------------------------------------------------------

const DATES = [
  '2026-10-20',
  '2024-02-29',
  '2023-02-29',
  '1900-02-29',
  '2000-02-29',
  '0000-02-29',
  '0000-01-01',
  '9999-12-31',
  '2026-13-01',
  '2026-00-10',
  '2026-10-00',
  '2026-04-31',
  '2026-04-30',
  '2026-06-31',
  '2026-02-28',
  '2026-02-30',
  '2026-1-01',
  '2026-01-1',
  '26-01-01',
  ' 2026-01-01',
  '2026-01-01 ',
  '2026-01-01\n',
  '2026-01-01T00:00:00Z',
  '2026/01/01',
  '２０２６-01-01',
  '2026-01-0١',
  '',
  '-',
  '----------',
  '2026-01-011',
  '+2026-01-01',
  'abcd-ef-gh',
  '1582-10-10',
  '0001-01-01',
];

const KEYS = [
  'OP-1',
  'OP-007',
  'OP-12',
  'AB-99999999999999999999',
  'AB-123456789012345678901234567890',
  'OP-1\n',
  'op-1',
  'A-1',
  'AB-1',
  'ABCDEFGHIJ-1',
  'ABCDEFGHIJK-1',
  'A1-1',
  '1A-1',
  'A1B2C3D4E5-9',
  'OP-',
  'OP--1',
  'OP-1-2',
  'OP-１',
  'OP-1.5',
  'OP-0',
  'OP- 1',
  ' OP-1',
  'ÀB-1',
  'ZZ-9007199254740993',
  '',
  'OP',
  '-1',
];

const PREFIXES = ['OP', 'AB', 'ZZ', 'A1B2C3D4E5', 'op', '', 'OPX', 'O'];

// --- checklists --------------------------------------------------------------------------------------------------------

const BODY_LINES = [
  '- [ ] a',
  '- [x] b',
  '- [X] c',
  '* [ ] star',
  '+ [x] plus',
  '1. [ ] numbered',
  '12) [x] paren',
  '  - [ ] nested',
  '\t- [x] tabbed',
  '> - [ ] quoted',
  '- [ ]no space',
  '-  [x]  two spaces',
  '-\t[ ]\ttabs',
  '- [x]',
  '- [x] ',
  '- [ ]\r',
  '- [-] dash',
  '- [] empty',
  '- [é] accent',
  '-[ ] glued',
  '- [ ] [ ] twice',
  '[ ] bare',
  '1.[ ] glued number',
  '1.2 [ ] no',
  '٣. [ ] arabic digit',
  '- [ ]\u00a0nbsp',
  '- [ ]\u2003em',
  '```',
  '```js',
  '````',
  '~~~',
  '~~~~ text',
  '  ```',
  '``',
  '- [ ] after',
  '',
  'text',
  '# Heading',
  '## Comments',
  '> [!comment|a,2026-10-20T10:00:00.000Z] Ana · 2026-10-20 10:00',
  '> second line',
  '> - [ ] task inside a comment',
];

function checklistBody(r: Random): string {
  return Array.from({ length: int(r, 0, 12) }, () => pick(r, BODY_LINES)).join(chance(r, 0.2) ? '\r\n' : '\n');
}

// --- labels ------------------------------------------------------------------------------------------------------------

const LABELS = [
  'bug',
  '#bug',
  '##bug',
  '###',
  '#',
  '',
  ' ',
  ' a  b ',
  '# a',
  '#  a  b',
  'a\tb',
  'a\u00a0b',
  'a\u0085b',
  '\ufeffx',
  'x\ufeff',
  'a\u2028b',
  'a\u3000b',
  'dup',
  'dup',
  '#dup',
  'Dup',
  'ünï',
  '日本語',
  '🙂',
  'a#b',
  '#a#b',
  'a,b',
  'with space',
  '  spaced out  ',
  '\n#x\n',
];

// --- notes -------------------------------------------------------------------------------------------------------------

const VALUES: Record<string, string[]> = {
  key: [
    'OP-12',
    'op-3',
    'AB-007',
    ' OP-1 ',
    '12',
    'bad',
    '""',
    '"OP-1\\n"',
    'OP-9007199254740993',
    '"\\u00a0OP-5"',
    'Op-8',
    'ß-1',
  ],
  title: [
    'Fix the login',
    '"Quoted: title"',
    "'single'",
    '12',
    '0.5',
    '1e21',
    '.nan',
    '.inf',
    '-.inf',
    'true',
    'null',
    '~',
    '',
    '"  spaced  "',
    '"\\u00a0nbsp"',
    '"\\ufefftitle"',
    '[a, b]',
    '{k: v}',
    '日本語 🙂',
    'Zoë café',
    '"a\\nb"',
  ],
  status: ['todo', 'doing', 'Done', '12', '"  review "', 'null', '[x]', 'true', '""'],
  type: ['task', 'story', 'bug', 'epic', 'Bug', '"bug "', '12', 'null', 'unknown', '[bug]'],
  priority: ['highest', 'high', 'medium', 'low', 'lowest', 'HIGH', '"high "', '3', 'null', 'urgent'],
  assignee: ['Ana', '"  Bruno  "', '12', 'null', '[x]', 'true', '""', 'Zoë'],
  labels: [
    '[a, b]',
    '[#a, "#b", c d]',
    '[a, a, "#a"]',
    'a, b, c',
    '"#tag, #other"',
    '[1, 2.5, true, null, [x]]',
    '[]',
    'null',
    'single',
    '12',
    '"  "',
    '[" ", "#"]',
    '{k: v}',
    '[.inf, .nan]',
  ],
  due: [
    '2026-10-20',
    '"2026-10-20"',
    '2026-10-20T10:00:00Z',
    '"2026-02-30"',
    '2026-1-1',
    '"2026-10-20 trailing"',
    '2026',
    'null',
    '"  2026-10-20  "',
    '20261020',
    '.inf',
    '[2026-10-20]',
    '"2026-10-2😀"',
    '"2026-10-20😀"',
    '"１２３４-10-20"',
  ],
  estimate: [
    '3',
    '2.5',
    '0',
    '-1',
    '1e3',
    '"3"',
    '.inf',
    '-.inf',
    '.nan',
    'null',
    '0x10',
    'true',
    '[3]',
    '1e400',
    '123456789012345678901234567890',
  ],
  parent: ['OP-1', 'op-2', '" op-3 "', 'bad', 'null', '12', 'AB-0007', '""', 'A-1', 'ABCDEFGHIJK-1'],
  rank: ['V', 'a0', '"Zz"', '12', '1.5', 'null', '""', '"  m "'],
  created: ['2026-10-20T10:00:00.000Z', '"2026-10-20T10:00:00.000Z"', '2026-10-20', '12', 'null', '1e21', '""'],
  updated: ['2026-10-21T10:00:00.000Z', '2026-10-20', 'null', '12', '""'],
  resolved: ['2026-10-22T10:00:00.000Z', 'null', '""', '12', 'true'],
  custom: ['anything', '[1, 2]', '{a: 1}', '"x: y"'],
};

const NOTE_KEYS = Object.keys(VALUES);

function frontmatter(r: Random): string {
  const eol = chance(r, 0.15) ? '\r\n' : '\n';
  const lines: string[] = [];
  for (const key of NOTE_KEYS) {
    // `key` is nearly always there: a note without one is not a card, which is the other half of the story
    if (!chance(r, key === 'key' ? 0.93 : 0.6)) continue;
    if (chance(r, 0.08)) lines.push(pick(r, ['# a comment', '', '  # indented', '#']));
    const sep = pick(r, [': ', ': ', ': ', ':  ', ':\t']);
    lines.push(`${key}${sep}${pick(r, VALUES[key]!)}${chance(r, 0.08) ? ' # why' : ''}`);
  }
  if (chance(r, 0.03)) lines.push(pick(r, ['broken: [', 'dup: 1\ndup: 2', '\tbad: 1', '- stray']));
  const bom = chance(r, 0.05) ? '\ufeff' : '';
  return `${bom}---${eol}${lines.join(eol)}${eol}---${eol}`;
}

function isoDate(r: Random): string {
  return new Date(
    Date.UTC(
      int(r, 2000, 2100),
      int(r, 0, 11),
      int(r, 1, 28),
      int(r, 0, 23),
      int(r, 0, 59),
      int(r, 0, 59),
      int(r, 0, 999),
    ),
  ).toISOString();
}

const AUTHORS = ['Ana', 'Bruno', 'Zoë Müller', '  Carla  ', 'Ana · [admin]', '日本語'];
const COMMENT_TEXTS = [
  'Reproduced on Safari',
  'Line one\nLine two',
  '- [ ] a task inside',
  '> quoted',
  '`code` and **bold**',
  '日本語 🙂',
  'a\r\nb',
];

function comments(r: Random): Comment[] {
  return Array.from({ length: int(r, 0, 3) }, (_, i) => ({
    id: `c${i}${int(r, 0, 99)}`,
    author: pick(r, AUTHORS),
    at: chance(r, 0.9) ? isoDate(r) : '',
    text: pick(r, COMMENT_TEXTS),
  }));
}

function noteBody(r: Random): string {
  const description = Array.from({ length: int(r, 0, 5) }, () =>
    pick(
      r,
      BODY_LINES.filter((l) => l !== '## Comments' && !l.startsWith('> [!comment')),
    ),
  ).join(chance(r, 0.15) ? '\r\n' : '\n');
  const cs = comments(r);
  const section = cs.length ? `\n${formatSection(cs)}` : chance(r, 0.1) ? '\n## Comments\n' : '';
  return `${description}\n${section}`;
}

function randomNote(r: Random): string {
  return `${frontmatter(r)}${noteBody(r)}`;
}

// --- cards -------------------------------------------------------------------------------------------------------------

const TITLES = [
  'Fix the login',
  'Zoë café',
  'Refactor: queue',
  "It's ok",
  'a "quote"',
  '日本語',
  '12',
  'true',
  '  Padded  ',
  'multi\nline',
  'tab\there',
  'x'.repeat(90),
  '- dash',
  '#hash',
  'a: b',
];
const STATUSES = ['todo', 'doing', 'review', 'done', 'in-progress', 'wip'];

function randomCard(r: Random, withComments: boolean): Card {
  const card: Card = {
    key: `${pick(r, ['OP', 'AB', 'XYZ'])}-${int(r, 1, 120)}`,
    path: `Cards/${pick(r, ['OP-1', 'AB-2', 'XYZ-3'])}.md`,
    title: pick(r, TITLES),
    status: pick(r, STATUSES),
    type: pick(r, ['task', 'story', 'bug', 'epic'] as const),
    priority: pick(r, ['highest', 'high', 'medium', 'low', 'lowest'] as const),
    labels: chance(r, 0.5) ? normalizeLabels(Array.from({ length: int(r, 0, 4) }, () => pick(r, LABELS))) : [],
    rank: pick(r, ['V', 'a0', 'Zz', 'm', 'V5']),
    created: isoDate(r),
    updated: isoDate(r),
    body: chance(r, 0.6)
      ? pick(r, [
          '',
          'A description',
          '- [ ] one\n- [x] two',
          '  padded body \n',
          '```\n- [ ] in code\n```',
          'multi\n\nparagraph\n\n',
        ])
      : '',
    checklist: { done: 0, total: 0 },
    comments: withComments ? comments(r) : [],
  };
  if (chance(r, 0.5)) card.assignee = pick(r, AUTHORS);
  if (chance(r, 0.4)) card.due = pick(r, ['2026-10-20', '2027-01-31', '2026-02-28']);
  if (chance(r, 0.4)) card.estimate = pick(r, [0, 1, 2.5, 3, 13, 0.1, 100]);
  if (chance(r, 0.3)) card.parent = pick(r, ['OP-1', 'AB-9', 'XYZ-10']);
  if (chance(r, 0.3)) card.resolved = isoDate(r);
  card.checklist = countChecklist(card.body);
  return card;
}

// eslint-disable-next-line no-control-regex
const CONTROL_OR_SEPARATOR = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

/** Plain short text the Rust writer reproduces byte for byte (see frontmatter.fixture.ts). */
function ordinary(s: string | undefined): boolean {
  if (s === undefined) return true;
  return (
    s.length <= 40 &&
    !/[\n\r]/.test(s) &&
    !CONTROL_OR_SEPARATOR.test(s) &&
    !/[^\S ]/.test(s) &&
    !/^(---|\.\.\.)/.test(s) &&
    !/^ | $/.test(s)
  );
}

function writtenExactly(card: Card): boolean {
  return (
    [card.title, card.status, card.assignee, card.rank, ...card.labels].every(ordinary) &&
    // the TypeScript folds long lines and writes quotes its own way for text with both kinds
    !card.labels.some((l) => /['"]/.test(l)) &&
    !/['"]/.test(card.title) &&
    card.labels.join('').length < 30
  );
}

const PATCH_TITLES = ['  New   title  ', 'Plain', '', '   ', 'tab\tand\nnewline', 'a\u00a0b', '\u3000x\u3000'];

function randomPatch(r: Random): CardPatch {
  const patch: CardPatch = {};
  if (chance(r, 0.4)) patch.title = pick(r, PATCH_TITLES);
  if (chance(r, 0.3)) patch.status = pick(r, STATUSES);
  if (chance(r, 0.3)) patch.type = pick(r, ['task', 'story', 'bug', 'epic'] as const);
  if (chance(r, 0.3)) patch.priority = pick(r, ['highest', 'high', 'medium', 'low', 'lowest'] as const);
  if (chance(r, 0.3)) patch.rank = pick(r, ['V', 'a0', 'Zz']);
  if (chance(r, 0.35)) patch.assignee = pick(r, ['  Ana  ', '', '   ', null, 'Zoë', '\u00a0x']);
  if (chance(r, 0.35)) patch.labels = Array.from({ length: int(r, 0, 4) }, () => pick(r, LABELS));
  if (chance(r, 0.3)) patch.due = pick(r, ['2026-12-31', null, '2026-02-30', '']);
  if (chance(r, 0.3)) patch.estimate = pick(r, [null, 0, 5, 2.5]);
  if (chance(r, 0.3)) patch.parent = pick(r, [null, '', 'op-4', 'AB-5', 'weird']);
  if (chance(r, 0.3))
    patch.body = pick(r, ['', 'New body', '- [x] done\n- [ ] open', '```\n- [ ] no\n```', '  spaced  ']);
  return patch;
}

export function generate(): FixtureFile {
  const r = rng(20261016);
  const cases: Case[] = [];

  DATES.forEach((d, i) => cases.push({ id: `date:${i}`, input: d, expected: isValidDate(d) }));
  for (let i = 0; i < 80; i++) {
    const y = int(r, 0, 9999).toString().padStart(4, '0');
    const d = `${y}-${pick(r, ['01', '02', '04', '12', '13', '00'])}-${pick(r, ['01', '28', '29', '30', '31', '00', '32'])}`;
    cases.push({ id: `date:r${i}`, input: d, expected: isValidDate(d) });
  }

  KEYS.forEach((key, i) =>
    PREFIXES.forEach((prefix, j) =>
      cases.push({ id: `key:${i}:${j}`, input: { key, prefix }, expected: keyNumber(key, prefix) }),
    ),
  );

  for (let i = 0; i < 300; i++) {
    const body = checklistBody(r);
    cases.push({ id: `checklist:${i}`, input: body, expected: countChecklist(body) });
  }

  for (let i = 0; i < 200; i++) {
    const labels = Array.from({ length: int(r, 0, 6) }, () => pick(r, LABELS));
    cases.push({ id: `labels:${i}`, input: labels, expected: normalizeLabels(labels) });
  }

  for (let i = 0; i < 600; i++) {
    const content = randomNote(r);
    const path = `Cards/${pick(r, ['OP-1', 'AB-2', 'x'])}.md`;
    cases.push({ id: `parse:${i}`, input: { path, content }, expected: attempt(() => parseCard(path, content)) });
  }
  for (const content of [
    '',
    'no frontmatter',
    '---\n---\n',
    '---\nkey: OP-1\n---\n',
    '---\nkey: OP-1\n---',
    '\ufeff---\nkey: OP-1\n---\nbody',
  ]) {
    cases.push({
      id: `parse:raw${cases.length}`,
      input: { path: 'p.md', content },
      expected: attempt(() => parseCard('p.md', content)),
    });
  }

  for (let i = 0; i < 250; i++) {
    const card = randomCard(r, chance(r, 0.5));
    const text = attempt(() => newCardContent(card));
    cases.push({
      id: `new:${i}`,
      input: card,
      expected: text.ok
        ? {
            ok: true,
            text: text.value,
            parsed: attempt(() => parseCard(card.path, text.value)),
            exact: writtenExactly(card),
          }
        : { ok: false },
    });
  }

  for (let i = 0; i < 200; i++) {
    const a = randomCard(r, true);
    const b: Card = { ...a, labels: [...a.labels], comments: a.comments.map((c) => ({ ...c })) };
    const roll = r();
    if (roll < 0.15) b.title += '!';
    else if (roll < 0.25) b.labels.push('extra');
    else if (roll < 0.35 && b.comments.length) b.comments[0]!.text += ' edited';
    else if (roll < 0.45) b.estimate = (a.estimate ?? 0) + 1;
    else if (roll < 0.5) b.checklist = { done: 9, total: 9 }; // derived: not compared
    else if (roll < 0.58) b.assignee = a.assignee === undefined ? 'Zed' : undefined;
    else if (roll < 0.64) b.path = `${a.path}x`;
    else if (roll < 0.7) b.resolved = a.resolved === undefined ? isoDate(r) : undefined;
    else if (roll < 0.76) b.body += '\nmore';
    else if (roll < 0.8) b.comments = b.comments.slice(1);
    cases.push({ id: `same:${i}`, input: { a, b }, expected: sameCard(a, b) });
  }

  for (let i = 0; i < 300; i++) {
    const card = randomCard(r, chance(r, 0.4));
    const patch = randomPatch(r);
    cases.push({ id: `apply:${i}`, input: { card, patch }, expected: applyPatch(card, patch) });
  }

  return {
    description:
      'isValidDate, keyNumber, countChecklist, normalizeLabels, parseCard (hand-edited notes), newCardContent, sameCard and applyPatch.',
    cases,
  };
}
