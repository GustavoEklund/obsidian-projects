// Conformance cases for the board configuration (packages/core/src/config.ts), ported by packages/mcp/src/config.rs.
import {
  columnById,
  displayColumn,
  isDoneStatus,
  isValidPrefix,
  normalizeConfig,
  normalizeFolder,
  resolveColumn,
  slugifyColumnId,
} from '@oprojects/core';
import { chance, int, pick, rng, type Case, type FixtureFile, type Random } from './lib';

export const name = 'config';

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const NAME_PIECES = [
  'é',
  'ü',
  'ñ',
  'ç',
  'Å',
  'ǅ',
  'ß',
  'İ',
  'ı',
  'Ω',
  '日',
  '本',
  '🙂',
  '_',
  '-',
  ' ',
  '/',
  '.',
  '!',
  '́',
  'ﬁ',
  'Ⅷ',
  '①',
  ' ',
  '\t',
  ...'abcXYZ019',
];
const TRICKY_SPACE = ['\u0085', '﻿', ' ', '　', ' ', '​', ' ', '\t'];

function piecesString(r: Random, pieces: string[], max: number): string {
  return Array.from({ length: int(r, 0, max) }, () => pick(r, pieces)).join('');
}

/** A value of any JSON type, biased towards the ones a hand-edited settings file really contains. */
function junk(r: Random): unknown {
  return pick(r, [
    null,
    true,
    false,
    0,
    1,
    -1,
    2.5,
    7.9,
    1e6,
    '',
    ' ',
    'text',
    ' padded ',
    [],
    {},
    [1, 2],
    { a: 1 },
    ['x', 3, null],
    'WEB',
    'web',
    '../..',
    '/Work\\Board/',
    42,
  ]);
}

function padded(r: Random, s: string): string {
  return chance(r, 0.3) ? `${pick(r, TRICKY_SPACE)}${s}${pick(r, TRICKY_SPACE)}` : s;
}

function rawColumn(r: Random): unknown {
  if (chance(r, 0.08)) return junk(r);
  const column: Record<string, unknown> = {};
  const label = padded(
    r,
    chance(r, 0.6)
      ? piecesString(r, NAME_PIECES, 6)
      : pick(r, ['Backlog', 'To do', 'In Review', 'Done', 'QA', 'Café', 'todo', 'doing']),
  );
  if (chance(r, 0.85)) column.name = label;
  if (chance(r, 0.7))
    column.id = chance(r, 0.5)
      ? pick(r, ['todo', 'doing', 'done', 'review', 'a', 'qa', 'UPPER', 'Needs Review!', '-bad', '_bad', 'ok-id_1', ''])
      : piecesString(r, NAME_PIECES, 5);
  if (chance(r, 0.4)) column.done = chance(r, 0.6) ? true : junk(r);
  if (chance(r, 0.4)) column.wip = chance(r, 0.6) ? pick(r, [1, 2, 3, 4.7, 0.5, 0, -3, 100]) : junk(r);
  if (chance(r, 0.05)) column.extra = junk(r);
  return column;
}

function rawConfig(r: Random): unknown {
  if (chance(r, 0.06)) return junk(r);
  const config: Record<string, unknown> = {};
  const maybe = (key: string, p: number, value: () => unknown) => {
    if (chance(r, p)) config[key] = value();
  };
  maybe('folder', 0.7, () =>
    chance(r, 0.6)
      ? padded(
          r,
          pick(r, [
            'Cards',
            'Work/Board',
            '/Work\\Board/',
            '../../etc/./passwd',
            'a//b///c',
            '..',
            '',
            ' ',
            'Zoë/Ünïcode',
          ]),
        )
      : junk(r),
  );
  maybe('prefix', 0.8, () =>
    chance(r, 0.6)
      ? padded(r, pick(r, ['OP', 'web', 'WEB', 'A', '1AB', 'A B', 'TOOLONGPREFIX', 'ABCDEFGHIJ', 'x9', 'ß', '']))
      : junk(r),
  );
  maybe('columns', 0.8, () => (chance(r, 0.9) ? Array.from({ length: int(r, 0, 6) }, () => rawColumn(r)) : junk(r)));
  maybe('hideDoneAfterDays', 0.6, () => (chance(r, 0.6) ? pick(r, [0, 1, 7, 14, 7.9, -1, 365, 1e5]) : junk(r)));
  maybe('me', 0.6, () => (chance(r, 0.6) ? padded(r, pick(r, ['Ana', 'Zoë', ' Bruno ', ''])) : junk(r)));
  maybe('members', 0.6, () =>
    chance(r, 0.85)
      ? Array.from({ length: int(r, 0, 6) }, () =>
          chance(r, 0.8) ? padded(r, pick(r, ['Ana', 'Bruno', 'Ana', 'Carla', '', ' ', 'Zoë'])) : junk(r),
        )
      : junk(r),
  );
  maybe('version', 0.3, () => 1);
  maybe('unknown', 0.2, () => junk(r));
  return config;
}

export function generate(): FixtureFile {
  const r = rng(424242);
  const cases: Case[] = [];

  // --- isValidPrefix -------------------------------------------------------------------------------------------------
  const prefixes = [
    'OP',
    'AB',
    'WEB',
    'A1',
    'ABCDEFGHIJ',
    'X9Y8Z7',
    '',
    'A',
    'a1',
    'op',
    '1AB',
    'ABCDEFGHIJK',
    'A-B',
    'A B',
    'AÉ',
    '_AB',
    'AB\n',
    ' AB',
    'AB ',
  ];
  for (let i = 0; i < 150; i++)
    prefixes.push(
      chance(r, 0.7)
        ? Array.from({ length: int(r, 0, 12) }, () => pick(r, [...ALNUM])).join('')
        : piecesString(r, [...ALNUM, 'a', '-', ' ', 'É'], 11),
    );
  prefixes.forEach((s, i) => cases.push({ id: `prefix:${i}`, input: s, expected: isValidPrefix(s) }));

  // --- slugifyColumnId --------------------------------------------------------------------------------------------------
  const names = [
    'In Review',
    '  Zoë  Müller!! ',
    'Café / Bar',
    'WIP_2',
    '',
    '   ',
    '!!!',
    '日本語',
    '---',
    '🙂',
    'ÀÉÎÓÜ',
    'İstanbul',
    'Straße',
    'ﬁne',
    'Ⅷ ①',
    'áb',
    'x--y',
    '-lead',
    'trail-',
  ];
  for (let i = 0; i < 220; i++) names.push(piecesString(r, NAME_PIECES, 10));
  names.forEach((s, i) => cases.push({ id: `slug:${i}`, input: s, expected: slugifyColumnId(s) }));

  // --- normalizeFolder -------------------------------------------------------------------------------------------------
  const folders = [
    '/Cards/',
    'Work\\Board',
    '../../etc/./passwd',
    'a//b///c',
    '..',
    '',
    '.',
    '/',
    '\\',
    'a/./b/../c',
    ' spaced / dir ',
    'Zoë/Ünïcode',
  ];
  for (let i = 0; i < 120; i++)
    folders.push(piecesString(r, ['a', 'b', '/', '\\', '.', '..', '/', ' ', 'é', 'Cards'], 9));
  folders.forEach((s, i) => cases.push({ id: `folder:${i}`, input: s, expected: normalizeFolder(s) }));

  // --- normalizeConfig --------------------------------------------------------------------------------------------------
  const raws: unknown[] = [
    undefined,
    null,
    0,
    1,
    'text',
    true,
    [],
    [1, 2],
    {},
    { prefix: 'web' },
    { prefix: '  web  ' },
    { folder: '/Work\\Board/' },
    { hideDoneAfterDays: 7.9 },
    { hideDoneAfterDays: 0 },
    { hideDoneAfterDays: -1 },
    { me: '  Ana ' },
    { members: [' Ana ', 'Ana', 'Bruno', '', '  ', 3, null, 'Bruno '] },
    { columns: [{ id: 'qa' }, { name: 'Ready to ship' }] },
    {
      columns: [
        { id: 'a', name: 'A', done: true, wip: 4.7 },
        { id: 'b', name: 'B', done: 'true', wip: 0 },
        { id: 'c', name: 'C', wip: 0.5 },
      ],
    },
    {
      columns: [
        { id: 'Needs Review!', name: 'Needs review' },
        { id: 'todo', name: 'To do' },
        { id: 'todo', name: 'Duplicate' },
        { name: 'Backlog items' },
        { id: 'UPPER', name: 'Upper' },
      ],
    },
    JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "extra": 1, "prefix": "OK"}'),
  ];
  for (let i = 0; i < 420; i++) raws.push(rawConfig(r));
  raws.forEach((raw, i) =>
    cases.push({ id: `normalize:${i}`, input: raw === undefined ? null : raw, expected: normalizeConfig(raw) }),
  );

  // --- column helpers ---------------------------------------------------------------------------------------------------
  const boards = [
    {
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'in-review', name: 'In Review' },
        { id: 'done', name: 'Done', done: true },
      ],
    },
    {
      columns: [
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
      ],
    },
    {},
  ];
  const needles = [
    'todo',
    'TODO',
    'To Do',
    'in-review',
    '  IN REVIEW ',
    'done',
    'DONE',
    'ghost',
    '',
    ' todo ',
    'a',
    'Beta',
    'Alpha',
    'doing',
    'In Progress',
  ];
  boards.forEach((raw, b) => {
    const config = normalizeConfig(raw);
    needles.forEach((needle, n) => {
      const out = (op: string, expected: unknown) =>
        cases.push({ id: `helper:${op}:${b}:${n}`, input: { raw, needle }, expected: expected ?? null });
      out('by-id', columnById(config, needle));
      out('display', displayColumn(config, needle));
      out('is-done', isDoneStatus(config, needle));
      out('resolve', resolveColumn(config, needle));
    });
  });

  return {
    description:
      'normalizeConfig and its helpers: tolerant parsing of a hand-edited settings object, column lookups, prefix/folder/slug rules.',
    cases,
  };
}
