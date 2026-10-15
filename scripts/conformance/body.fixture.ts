// Conformance cases for the comments and checkboxes of a note body (packages/core/src/body.ts), ported by
// packages/mcp/src/body.rs. The comment title shows local time, so formatting cases run in a spread of timezones and
// record the UTC offset that applied; Rust is given that offset.
import type { Comment } from '@oprojects/core';
import {
  addCommentToBody,
  cleanAuthor,
  editCommentInBody,
  formatComment,
  formatSection,
  joinBody,
  parseComments,
  removeCommentFromBody,
  splitBody,
  toggleTask,
} from '@oprojects/core';
import { agreesWithRust } from './iso';
import { chance, int, pick, rng, type Case, type FixtureFile, type Random } from './lib';

process.env.TZ = 'UTC';

export const name = 'body';

const ZONES = [
  'UTC',
  'UTC',
  'America/Sao_Paulo',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'America/New_York',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'Europe/London',
];

/** Runs `fn` with the process in `zone`, then back in UTC. */
function inZone<T>(zone: string, fn: () => T): T {
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    process.env.TZ = 'UTC';
  }
}

/** The UTC offset in minutes (east positive) that `zone` has at the instant `at`; 0 when `at` is not a timestamp. */
function offsetAt(zone: string, at: string): number {
  return inZone(zone, () => {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? 0 : -d.getTimezoneOffset() || 0;
  });
}

const LINES = [
  '',
  '   ',
  '\t',
  '> quoted',
  '> > nested',
  '>',
  '## Comments',
  '## Heading',
  '### Comments',
  '```',
  '```js',
  '~~~',
  '- [ ] task',
  '- [x] done',
  '  indented',
  '- item',
  '1. numbered',
  '---',
  '|a|b|',
  'plain words',
  '日本語 and Zoë',
  '🙂',
  '[!comment|fake] boom',
  '  [!comment] indented marker',
  '[!Comment|y,2026-01-01T00:00:00.000Z] Cased · 2026-01-01 10:00',
  '\\[!comment|already] escaped',
  '\\\\[!comment] twice',
  '> [!comment|x,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 14:02',
  '> [!COMMENT] Loud',
  '> [!comment|only-id] Bruno',
  '> [!note] other callout',
  '## comments',
  '##\tComments  ',
  '## COMMENTS ',
  'x y',
  'tab\tseparated',
  '- [ ] a',
  '* [X] star',
  '+ [-] plus',
  '1) [ ] paren',
  '> - [ ] in quote',
  '- [ ]no space',
  '-  [ ]  two spaces',
  '- [x]',
  '  - [ ] nested',
  '10. [ ] ten',
  '> > - [x] deep',
  '- [é] accent',
  '- [🙂] emoji',
  '- [] empty',
  '[ ] bare',
  '> [!comment|a,2026-10-14T17:02:00+02:00] Offset · when',
  '> [!comment| b , 2026-10-14T17:02:00.5Z ] Spaces',
  '> [!comment|c,not a date] Garbage time',
  '> [!comment] no meta',
  '> [!comment|] empty meta',
  '>[!comment|d,2026-10-14T17:02:00Z]Tight',
  '> [!comment|e,2026-10-14T17:02:00Z] Ana · x y',
  '> [!comment|f,2026-10-14T17:02:00Z] Ana ',
];

const WORDS = [
  'fix',
  'login',
  'Safari',
  'redirect',
  'query',
  'string',
  'Zoë',
  'null',
  '[x]',
  '- [ ]',
  '`code`',
  '**bold**',
  '·',
  '[',
  ']',
  '\\',
  '>',
  '#',
];

function line(r: Random): string {
  if (chance(r, 0.78)) return pick(r, LINES);
  return Array.from({ length: int(r, 1, 5) }, () => pick(r, WORDS)).join(chance(r, 0.8) ? ' ' : '');
}

const eol = (r: Random) => (chance(r, 0.25) ? '\r\n' : '\n');

function lines(r: Random, min: number, max: number): string[] {
  return Array.from({ length: int(r, min, max) }, () => line(r));
}

const AUTHORS = [
  'Ana',
  'Bruno',
  'Ana · [admin]\nSouza',
  '  Carla  ',
  '',
  '···',
  '[]',
  'Zoë Müller',
  'A · B · C',
  'a\r\nb',
  ' Diego　',
  'x ·  · y',
  'Ana·Souza',
  '[Ana]',
  '日本語',
];
const IDS = ['a1', 'k3f9a', 'abc', 'x', 'c0ffee', 'dup', 'dup', 'ID-1'];

function iso(r: Random): string {
  const roll = r();
  if (roll < 0.04)
    return pick(r, [
      '+275760-09-13T00:00:00.000Z',
      '0000-01-01T00:00:00.000Z',
      '-000001-06-15T12:00:00.000Z',
      '9999-12-31T23:59:59.999Z',
      '1970-01-01T00:00:00.000Z',
    ]);
  if (roll < 0.1) return pick(r, ['', 'garbage', 'T', 'x', '2026-13-01T00:00:00Z', '2026-10-14T25:00:00Z']);
  const d = new Date(
    Date.UTC(
      int(r, 1970, 2100),
      int(r, 0, 11),
      int(r, 1, 28),
      int(r, 0, 23),
      int(r, 0, 59),
      int(r, 0, 59),
      int(r, 0, 999),
    ),
  );
  return d.toISOString();
}

function comment(r: Random): Comment {
  return {
    id: chance(r, 0.85)
      ? pick(r, IDS) + (chance(r, 0.5) ? String(int(r, 0, 99)) : '')
      : Array.from({ length: int(r, 3, 6) }, () => pick(r, [...'abcdefghijklmnopqrstuvwxyz0123456789'])).join(''),
    author: chance(r, 0.85) ? pick(r, AUTHORS) : line(r),
    at: iso(r),
    text: lines(r, 1, 5).join(eol(r)),
  };
}

/** A note body: a description, optionally the heading, and comments written by the core or by hand. */
function body(r: Random): string {
  const e = eol(r);
  let text = lines(r, 0, 6).join(e);
  const roll = r();
  if (roll < 0.15) return text; // no section at all
  const withCore = (n: number) => {
    for (let i = 0; i < n; i++) text = addCommentToBody(text, comment(r));
  };
  if (roll < 0.65) withCore(int(r, 1, 4));
  else if (roll < 0.8) {
    text = `${text}${e}${pick(r, ['## Comments', '## comments', '##\tComments', '## Comments  '])}${e}${e}${lines(r, 0, 5).join(e)}`; // hand-written section
  } else {
    withCore(int(r, 1, 3));
    text = `${text}${e}${lines(r, 1, 4).join(e)}`; // more lines after the comments
  }
  return text;
}

/** A well-formed one whose timestamps go through `ZONES`, plus the zone's offset at `at`. */
function formatCase(r: Random): { comment: Comment; offset: number; zone: string } {
  const c = comment(r);
  // Before the standard-time era a zone's offset has seconds ("-4:56:02" in New York in the year -1): UTC only there.
  const modern = /^(19[7-9]\d|20\d\d|2100)-/.test(c.at);
  const zone = modern ? pick(r, ZONES) : 'UTC';
  return { comment: c, offset: offsetAt(zone, c.at), zone };
}

const agrees = (c: Comment) => agreesWithRust(c.at);

export function generate(): FixtureFile {
  const r = rng(77001);
  const cases: Case[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < 200; i++) bodies.push(body(r));

  // --- splitBody / joinBody ------------------------------------------------------------------------------------------------
  const fixed = [
    '',
    '\n',
    'just text\n',
    'Example:\n\n```md\n## Comments\n```\n\nthe end\n',
    '## Comments are great\n',
    '### Comments\n',
    '\nDescription\n\n## Comments\n\n> [!comment|a1,2026-10-14T17:02:00.000Z] Ana · x\n> hi\n',
    '## Comments',
    '## Comments\r\n\r\n> [!comment|a] A\r\n> x\r\n',
    '```\n## Comments\n',
    '~~~\n## Comments\n~~~\n## Comments\n',
    '```\n~~~\n## Comments\n```\n',
  ];
  [...fixed, ...bodies].forEach((b, i) => cases.push({ id: `split:${i}`, input: b, expected: splitBody(b) }));
  const joins: [string, string | null][] = [
    ['\nText\n\n\n', '## Comments\n\n> x\n'],
    ['', '## Comments\n'],
    ['just text\n', null],
    ['x', ''],
    ['  \n\n', '## Comments\n'],
    ['a 　', 's'],
  ];
  for (let i = 0; i < 120; i++)
    joins.push([
      lines(r, 0, 4).join('\n') + pick(r, ['', '\n', '\n\n', ' \t\n', ' ']),
      chance(r, 0.15) ? null : pick(r, ['## Comments\n', '## Comments\n\n> x\n', '', 'section']),
    ]);
  joins.forEach(([d, s], i) =>
    cases.push({ id: `join:${i}`, input: { description: d, section: s }, expected: joinBody(d, s) }),
  );

  // --- parseComments -------------------------------------------------------------------------------------------------------
  [...fixed, ...bodies].forEach((b, i) => cases.push({ id: `parse:${i}`, input: b, expected: parseComments(b) }));

  // --- cleanAuthor ------------------------------------------------------------------------------------------------------------
  const authors = [...AUTHORS];
  for (let i = 0; i < 120; i++)
    authors.push(
      Array.from({ length: int(r, 0, 8) }, () =>
        pick(r, ['a', 'Ana', ' ', '  ', '\n', '\r\n', '·', ' · ', '[', ']', '\t', ' ', '　', 'é', '日', ' ·']),
      ).join(''),
    );
  authors.forEach((a, i) => cases.push({ id: `clean-author:${i}`, input: a, expected: cleanAuthor(a) }));

  // --- formatComment / formatSection --------------------------------------------------------------------------------------------
  for (let i = 0; i < 260; i++) {
    const f = formatCase(r);
    if (!agrees(f.comment)) continue;
    cases.push({
      id: `format:${i}`,
      input: { comment: f.comment, offset: f.offset },
      expected: { zone: f.zone, text: inZone(f.zone, () => formatComment(f.comment)) },
    });
  }
  for (let i = 0; i < 40; i++) {
    const list = Array.from({ length: int(r, 0, 4) }, () => comment(r)).filter(agrees);
    cases.push({ id: `section:${i}`, input: { comments: list, offset: 0 }, expected: formatSection(list) });
  }

  // --- addCommentToBody / editCommentInBody / removeCommentFromBody ------------------------------------------------------------
  for (let i = 0; i < 200; i++) {
    const f = formatCase(r);
    if (!agrees(f.comment)) continue;
    const b = chance(r, 0.15) ? '' : pick(r, bodies);
    cases.push({
      id: `add:${i}`,
      input: { body: b, comment: f.comment, offset: f.offset },
      expected: inZone(f.zone, () => addCommentToBody(b, f.comment)),
    });
  }
  const knownIds = (b: string) => parseComments(b).map((c) => c.id);
  for (let i = 0; i < 150; i++) {
    const b = pick(r, bodies);
    const ids = knownIds(b);
    const id = ids.length && chance(r, 0.8) ? pick(r, ids) : pick(r, ['missing', '', 'a1']);
    const text = chance(r, 0.5)
      ? lines(r, 1, 4).join(eol(r))
      : pick(r, ['', '  ', 'edited', '[!comment|x] sneaky', '\\[!comment] escaped\nsecond']);
    cases.push({ id: `edit:${i}`, input: { body: b, id, text }, expected: editCommentInBody(b, id, text) });
    cases.push({ id: `remove:${i}`, input: { body: b, id }, expected: removeCommentFromBody(b, id) });
  }

  // --- toggleTask -----------------------------------------------------------------------------------------------------------------
  const docs = [
    '- [ ] a\n- [x] b\n',
    'Intro\n\n- [x] one\n  - [ ] two (nested)\n1. [ ] three (numbered)\n\n```\n- [ ] this is code\n```\n\n> - [ ] inside a quote\n- [-] custom status\n[ ] loose\nno tasks\n',
    '- [ ]\n',
    '- [ ] x\r\n- [x] y\r\n',
    '~~~\n- [ ] in tildes\n```\n- [ ] still in tildes\n~~~\n- [ ] after\n',
    '```\n- [ ] a\n~~~\n- [ ] b\n```\n- [ ] c\n',
    '',
    'no tasks\n',
    '- [ ] nbsp marker\n',
    '　- [ ] ideographic indent\n',
    '- [ ] x\n',
    '- [ ]x\n',
    '- [é] bmp\n',
    '- [🙂] astral\n',
    '>\t- [ ] tab after quote\n',
    '> > > - [x] deep\n',
  ];
  for (let i = 0; i < 90; i++) docs.push(chance(r, 0.4) ? pick(r, bodies) : lines(r, 1, 9).join(eol(r)));
  docs.forEach((md, i) => {
    for (let index = 0; index < 5; index++)
      cases.push({ id: `toggle:${i}:${index}`, input: { markdown: md, index }, expected: toggleTask(md, index) });
  });

  return {
    description:
      'The comments section and checkboxes of a note body: split/join, parse, format (with UTC offsets), add/edit/remove, toggleTask.',
    cases,
  };
}
