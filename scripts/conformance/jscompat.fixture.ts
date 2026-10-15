// The JavaScript behaviors the Rust crate reproduces (src/jscompat.rs): trim, Number#toString and ISO Date.parse.
// The timezone is pinned: a date-time without an offset is local time in JavaScript, and the corpus must not depend on
// the machine that generates it.
import { agreesWithRust } from './iso';
import { chance, int, pick, rng, type Case, type FixtureFile, type Random } from './lib';

process.env.TZ = 'UTC';

export const name = 'jscompat';

const SPACES = [' ', '\t', '\n', '\r', '\u000b', '\u000c', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿'];
const NOT_SPACES = ['\u0085', '​', '᠎', 'a', 'é', '日', '-', '0'];

function spacey(r: Random): string {
  const part = () => Array.from({ length: int(r, 0, 3) }, () => pick(r, SPACES)).join('');
  const core = Array.from({ length: int(r, 0, 4) }, () => pick(r, [...SPACES, ...NOT_SPACES])).join('');
  return `${part()}${core}${part()}`;
}

function numbers(r: Random): number[] {
  const out = [
    0,
    1,
    -1,
    0.1,
    0.5,
    1.5,
    100,
    1e21,
    1e20,
    123456789012345680000,
    1.5e-7,
    0.000001,
    0.0000001,
    5e-324,
    1.7976931348623157e308,
    4.35,
    1 / 3,
    2 ** 53,
    2 ** 53 + 2,
    -1e-7,
    1e100,
    12345.6789,
    0.30000000000000004,
    1e-10,
  ];
  for (let i = 0; i < 120; i++) out.push(int(r, -100000, 100000));
  for (let i = 0; i < 120; i++) out.push((r() - 0.5) * 10 ** int(r, -12, 25));
  for (let i = 0; i < 40; i++) out.push(Math.round(r() * 1000) / 100);
  return out;
}

const pad = (n: number, width: number) => String(n).padStart(width, '0');

function isoString(r: Random): string {
  const year = chance(r, 0.9) ? int(r, 1970, 2100) : pick(r, [0, 1, 99, 1969, 9999, 275760]);
  const sign = year > 9999 ? '+' : '';
  const yearText = year > 9999 ? `${sign}${pad(year, 6)}` : pad(year, 4);
  let text = yearText;
  const precision = r();
  const month = chance(r, 0.95) ? int(r, 1, 12) : pick(r, [0, 13, 99]);
  const day = chance(r, 0.95) ? int(r, 1, 31) : pick(r, [0, 32, 99]);
  if (precision > 0.1) text += `-${pad(month, 2)}`;
  if (precision > 0.2) text += `-${pad(day, 2)}`;
  if (precision > 0.35) {
    text += pick(r, ['T', 'T', 'T', 't', ' ']);
    const hour = chance(r, 0.95) ? int(r, 0, 23) : pick(r, [24, 25, 99]);
    text += `${pad(hour, 2)}:${pad(chance(r, 0.97) ? int(r, 0, 59) : 60, 2)}`;
    if (chance(r, 0.8)) {
      text += `:${pad(chance(r, 0.97) ? int(r, 0, 59) : 60, 2)}`;
      if (chance(r, 0.5)) text += `.${String(int(r, 0, 999999999)).padStart(int(r, 1, 9), '0')}`;
    }
    text += pick(r, ['', '', 'Z', 'Z', 'Z', 'z', '+02:00', '-03:00', '+0530', '-0300', '+00:00', '+2', ' Z', '+24:00']);
  }
  return `${pick(r, ['', '', '', ' ', '  '])}${text}${pick(r, ['', '', '', ' '])}`;
}

export function generate(): FixtureFile {
  const r = rng(1015);
  const cases: Case[] = [];

  const strings = ['', ' ', 'a', ' a ', '\u0085a\u0085', '​a', '﻿a﻿', ' 　x '];
  for (let i = 0; i < 150; i++) strings.push(spacey(r));
  strings.forEach((s, i) =>
    cases.push({ id: `trim:${i}`, input: s, expected: { trim: s.trim(), start: s.trimStart(), end: s.trimEnd() } }),
  );

  numbers(r).forEach((x, i) => cases.push({ id: `number:${i}`, input: x, expected: String(x) }));

  const dates = [
    '2026-10-14',
    '2026-10',
    '2026',
    '2026-10-14T17:02:00.000Z',
    '2026-10-14T17:02:00Z',
    '2026-10-14T17:02Z',
    '2026-10-14T17:02',
    '2026-10-14T17:02:00',
    '2026-10-14 17:02',
    '2026-10-14 17:02:00Z',
    '2026-10-14T17:02:00+02:00',
    '2026-10-14T17:02:00-0300',
    '2026-10-14T17:02:00.5Z',
    '2026-10-14T17:02:00.123456Z',
    '2026-02-30',
    '2026-02-29',
    '2024-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-10-32',
    '2026-10-14T24:00:00Z',
    '2026-10-14T24:00:01Z',
    '2026-10-14T25:00:00Z',
    '2026-10-14T17:60:00Z',
    '2026-10-14T17:02:60Z',
    '+002026-10-14',
    '-000001-01-01',
    '+275760-09-13',
    '+275760-09-14',
    '2026-10-14t17:02:00z',
    '2026-10-14T17:02:00 Z',
    '',
    '  2026-10-14',
    '2026-10-14  ',
    'foo',
    '0000-01-01',
    '9999-12-31T23:59:59.999Z',
    '2026-10-14T17:02:00.000+00:00',
    '2026-10-14T17:02:00+2',
    '2026-10-14T7:02:00Z',
    '20261014',
    '-000000-01-01',
    '2026-10-14T17:02:00.Z',
    '2026-10-14T17',
  ];
  for (let i = 0; i < 400; i++) dates.push(isoString(r));
  // V8 falls back to a legacy parser for strings that are not ISO-8601 ("2026-10-14T17" is read as 2001-01-01!). Those
  // are recorded apart: the Rust crate deliberately does not read them and must return None.
  const legacyForms = [
    'Oct 14 2026',
    '2026/10/14',
    '12',
    '1',
    '2026-1-14',
    '2026-10-4',
    'Tue Oct 14 2026 17:02:00 GMT+0000',
    '14 October 2026',
  ];
  const iso: string[] = [];
  const legacy = new Set<string>();
  for (const s of [...dates, ...legacyForms]) {
    if (agreesWithRust(s)) iso.push(s);
    else legacy.add(s);
  }
  const outcome = (s: string) => {
    const ms = Date.parse(s);
    return Number.isNaN(ms) ? null : { ms, iso: new Date(ms).toISOString() };
  };
  iso.forEach((s, i) => cases.push({ id: `date:${i}`, input: s, expected: outcome(s) }));
  [...legacy].forEach((s, i) => cases.push({ id: `legacy:${i}`, input: s, expected: outcome(s) }));

  return {
    description:
      'String#trim, Number#toString and the ISO-8601 forms of Date.parse / toISOString (timezone pinned to UTC).',
    cases,
  };
}
