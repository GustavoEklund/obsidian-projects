// Conformance corpus for packages/core/src/query.ts: the Rust port (packages/mcp/src/query.rs) replays every case.
// Nothing here is hand-computed: each `expected` is what the TypeScript functions return when the generator runs them.
// Dates depend on the time zone, so every use of them runs under a fixed zone: the corpus is the same on any machine.
import {
  DEFAULT_CONFIG,
  PRIORITIES,
  CARD_TYPES,
  UNASSIGNED,
  displayColumn,
  dueState,
  filterCards,
  groupByColumn,
  isArchivedDone,
  localDate,
  normalizeConfig,
  normalizeText,
  priorityWeight,
  rankForPlacement,
  sortCards,
  spreadRanks,
  type BoardConfig,
  type Card,
  type CardFilter,
  type Placement,
} from '@oprojects/core';
import { chance, int, pick, rng, type Case, type FixtureFile, type Random } from './lib';

export const name = 'query';

function withTimezone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

// Zones without daylight saving time, so the results do not depend on the tz database version.
const ZONES = ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Etc/GMT+5'] as const;

// --- cards -------------------------------------------------------------------------------------------------------

function makeCard(over: Partial<Card> & { key: string }): Card {
  return {
    path: `Cards/${over.key}.md`,
    title: over.key,
    status: 'todo',
    type: 'task',
    priority: 'medium',
    labels: [],
    rank: 'V',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    body: '',
    checklist: { done: 0, total: 0 },
    comments: [],
    ...over,
  };
}

const comment = (text: string, n = 0) => ({ id: `c${n}`, author: 'x', at: '', text });

const WORDS = [
  'login',
  'Café',
  'résumé',
  'Zoë',
  'checkout',
  'API',
  'Müller',
  'bug',
  'ünïcode',
  'payments',
  'Straße',
  'STRASSE',
  'İstanbul',
  'Ångström',
  'ǅemal',
  'naïve',
  'Σίσυφος',
  'ΟΔΟΣ',
  'Ελλάδα',
  'Привет',
  '日本語',
  '한국어',
  'ﬁnal',
  '😀',
  'Café',
  'Zoë',
  'ê',
  'ệ',
  'Ångstrom',
];
const phrase = (r: Random, max = 3) =>
  Array.from({ length: int(r, 1, max) }, () => pick(r, WORDS)).join(chance(r, 0.9) ? ' ' : ' ');

const RANKS = ['V', 'W', 'Vb', 'A', 'z', '1', 'V1', 'Z', '', '\u{10000}', '￿', '😀', '', 'Vé', 'a', 'B'];
const CREATED = [
  '2026-01-01T00:00:00.000Z',
  '2026-01-02T00:00:00.000Z',
  '2026-01-03T09:30:00.000Z',
  '2025-12-31T23:59:59.999Z',
];
const ASSIGNEES = ['Ana', 'Bruno', 'Zoë', 'ana', 'ZOË', 'Ångström', '', '@none', '@NONE', 'Zoë', 'İ', 'Müller'];
const LABELS = ['api', 'ux', 'Café', 'Café', 'bug', 'ops', 'İstanbul', 'STRASSE', 'straße', 'Ångström', '日本語'];

function randomCard(r: Random, i: number, statuses: string[]): Card {
  const labels = [...new Set(Array.from({ length: int(r, 0, 3) }, () => pick(r, LABELS)))];
  const card = makeCard({
    key: chance(r, 0.9) ? `OP-${i + 1}` : `OP-${pick(r, [1, 2, 10, 100, 9])}`,
    title: phrase(r),
    status: chance(r, 0.15) ? pick(r, ['ghost', '', 'Todo', 'DONE']) : pick(r, statuses),
    type: pick(r, CARD_TYPES),
    priority: pick(r, PRIORITIES),
    labels,
    rank: pick(r, RANKS),
    created: pick(r, CREATED),
    body: chance(r, 0.8) ? phrase(r, 5) : '',
    comments: Array.from({ length: int(r, 0, 2) }, (_, n) => comment(phrase(r), n)),
  });
  if (chance(r, 0.6)) card.assignee = pick(r, ASSIGNEES);
  if (chance(r, 0.3)) card.parent = pick(r, ['OP-1', 'OP-2', 'op-3', 'OP-10']);
  if (chance(r, 0.3)) card.due = pick(r, ['2026-10-14', '2026-10-16', '2026-12-31', '2025-01-01']);
  if (chance(r, 0.3)) card.estimate = pick(r, [1, 2.5, 8, 0]);
  return card;
}

// --- configs -----------------------------------------------------------------------------------------------------

interface ConfigVariant {
  config: BoardConfig;
  statuses: string[];
}

const CONFIGS: ConfigVariant[] = [
  {
    config: normalizeConfig({ ...DEFAULT_CONFIG, hideDoneAfterDays: 14, me: 'Ana' }),
    statuses: ['todo', 'doing', 'review', 'done'],
  },
  {
    config: normalizeConfig({
      prefix: 'OP',
      hideDoneAfterDays: 7,
      columns: [
        { id: 'backlog', name: 'Backlog' },
        { id: 'wip', name: 'WIP', wip: 2 },
        { id: 'qa', name: 'QA' },
        { id: 'shipped', name: 'Shipped', done: true },
        { id: 'archived', name: 'Archived', done: true },
      ],
    }),
    statuses: ['backlog', 'wip', 'qa', 'shipped', 'archived'],
  },
  {
    config: normalizeConfig({ prefix: 'OP', columns: [{ id: 'only', name: 'Only' }], hideDoneAfterDays: 0 }),
    statuses: ['only'],
  },
  {
    // Not what `normalizeConfig` would produce: a repeated id, as a hand-built config may have.
    config: {
      folder: 'Cards',
      prefix: 'OP',
      columns: [
        { id: 'a', name: 'A first' },
        { id: 'b', name: 'B' },
        { id: 'a', name: 'A second', done: true },
      ],
      hideDoneAfterDays: 14,
      me: '',
      members: [],
    },
    statuses: ['a', 'b'],
  },
];

// --- filters -----------------------------------------------------------------------------------------------------

const TEXT_QUERIES = [
  '',
  ' ',
  ' ',
  '﻿',
  '\u0085',
  '﻿ ',
  'login',
  'LOGIN',
  'café',
  'CAFE',
  'café',
  'zoe',
  'ZOË',
  'straße',
  'strasse',
  'istanbul',
  'İSTANBUL',
  'angstrom',
  'ångström',
  'op-1',
  'OP-2',
  'résumé resume',
  'login  bug',
  'login\tbug',
  'login bug',
  'login bug',
  'login\u0085bug',
  '😀',
  '日本',
  'nothing-matches-this',
  'op',
  '-',
  'σισυφος',
  'οδος',
  'ΟΔΟΣ',
  'привет',
  'ﬁnal',
  'final',
  'ê',
  'ệ',
  'e',
];

function randomFilter(r: Random, statuses: string[]): CardFilter {
  const f: CardFilter = {};
  if (chance(r, 0.5)) f.text = pick(r, TEXT_QUERIES);
  if (chance(r, 0.3))
    f.status = [...new Set(Array.from({ length: int(r, 1, 2) }, () => pick(r, [...statuses, 'ghost'])))];
  if (chance(r, 0.25)) f.type = [...new Set(Array.from({ length: int(r, 1, 2) }, () => pick(r, CARD_TYPES)))];
  if (chance(r, 0.25)) f.priority = [...new Set(Array.from({ length: int(r, 1, 2) }, () => pick(r, PRIORITIES)))];
  if (chance(r, 0.3))
    f.assignee = [
      ...new Set(Array.from({ length: int(r, 1, 2) }, () => pick(r, [...ASSIGNEES, UNASSIGNED, 'ZOE', 'bruno']))),
    ];
  if (chance(r, 0.3))
    f.labels = [...new Set(Array.from({ length: int(r, 1, 2) }, () => pick(r, [...LABELS, 'CAFE', 'nope'])))];
  if (chance(r, 0.15)) f.parent = pick(r, ['OP-1', 'op-1', 'OP-2', 'op-3', '', 'OP-10']);
  // empty arrays are "no filter" too
  if (chance(r, 0.1)) f.labels = [];
  if (chance(r, 0.05)) f.status = [];
  return f;
}

interface BoardInput {
  config: BoardConfig;
  cards: Card[];
  filters: CardFilter[];
}

function boardCase(id: string, input: BoardInput): Case {
  const { config, cards, filters } = input;
  return {
    id,
    input: { fn: 'board', config, cards, filters },
    expected: {
      filter: filters.map((f) => filterCards(cards, f, config).map((c) => c.key)),
      sort: sortCards(cards, config).map((c) => c.key),
      group: groupByColumn(cards, config).map((g) => ({ column: g.column, cards: g.cards.map((c) => c.key) })),
    },
  };
}

function handWrittenBoards(): Case[] {
  const config = CONFIGS[0]!.config;
  const searchable = makeCard({
    key: 'OP-42',
    title: 'Alpha',
    assignee: 'Zoë',
    labels: ['café'],
    body: 'needle in body',
    comments: [comment('secret comment', 1)],
  });
  const searchFilters = [
    'op-42',
    'alpha',
    'zoe',
    'cafe',
    'needle',
    'secret',
    'NEEDLE IN',
    'comment secret',
    'nope',
    'op-43',
    'needlex',
  ].map((text): CardFilter => ({ text }));
  const cards = [
    makeCard({ key: 'OP-1', status: 'ghost' }),
    makeCard({ key: 'OP-2', status: '' }),
    makeCard({ key: 'OP-3', status: 'done', parent: 'OP-1', labels: ['Café', 'api'], assignee: 'Zoë' }),
    makeCard({ key: 'OP-4', status: 'doing', rank: 'A', title: 'Résumé parser', priority: 'highest', type: 'bug' }),
    makeCard({ key: 'OP-5', status: 'doing', rank: 'A', created: '2026-01-02T00:00:00.000Z' }),
    makeCard({ key: 'OP-10', status: 'doing', rank: 'A', created: '2026-01-02T00:00:00.000Z' }),
    makeCard({ key: 'OP-2', status: 'doing', rank: 'A', created: '2026-01-02T00:00:00.000Z' }),
  ];
  const everything: CardFilter[] = [
    {},
    { text: '   ', status: [], labels: [] },
    { status: ['todo'] },
    { status: ['doing'] },
    { labels: ['CAFE'] },
    { labels: ['nope', 'API'] },
    { parent: 'op-1' },
    { parent: 'OP-2' },
    { assignee: [UNASSIGNED] },
    { assignee: ['ZOE'] },
    { assignee: ['zoe', UNASSIGNED] },
    { type: ['bug'], priority: ['highest'] },
    { text: 'RESUME', status: ['doing'] },
  ];
  return [
    boardCase('hand-text-covers-every-field', {
      config,
      cards: [searchable, makeCard({ key: 'OP-43', title: 'Beta' })],
      filters: searchFilters,
    }),
    boardCase('hand-mixed-statuses-and-dimensions', { config, cards, filters: everything }),
    boardCase('hand-empty-board', { config, cards: [], filters: [{}, { text: 'x' }, { status: ['todo'] }] }),
    boardCase('hand-equal-ranks-sort-by-created-then-key', {
      config,
      cards: ['OP-9', 'OP-10', 'OP-1', 'OP-100'].map((key, i) =>
        makeCard({ key, rank: 'V', created: i % 2 ? '2026-01-02T00:00:00.000Z' : '2026-01-01T00:00:00.000Z' }),
      ),
      filters: [{}],
    }),
    boardCase('hand-utf16-order-of-ranks', {
      config,
      cards: ['', '\u{10000}', '￿', '😀', 'z', 'A'].map((rank, i) => makeCard({ key: `OP-${i + 1}`, rank })),
      filters: [{}],
    }),
    boardCase('hand-duplicate-column-ids', {
      config: CONFIGS[3]!.config,
      cards: ['a', 'b', 'a', 'ghost', 'b'].map((status, i) => makeCard({ key: `OP-${i + 1}`, status })),
      filters: [{}, { status: ['a'] }, { status: ['b'] }],
    }),
  ];
}

function randomBoards(): Case[] {
  const r = rng(0x51c0de);
  const out: Case[] = [];
  for (let n = 0; n < 150; n++) {
    const variant = CONFIGS[n % CONFIGS.length]!;
    const cards = Array.from({ length: int(r, 0, 10) }, (_, i) => randomCard(r, i, variant.statuses));
    const filters = Array.from({ length: 8 }, () => randomFilter(r, variant.statuses));
    out.push(boardCase(`random-board-${String(n).padStart(3, '0')}`, { config: variant.config, cards, filters }));
  }
  return out;
}

// --- normalize_text ----------------------------------------------------------------------------------------------

const NORMALIZE_SAMPLES = [
  'Résumé',
  'RESUME',
  'Zoë Müller',
  'Straße',
  'STRASSE',
  'Ångström',
  'ΑΣ',
  'ΑΣ ΑΣ.',
  'ΟΔΟΣ',
  'ΣΑΣ',
  'İ',
  'ı',
  'I',
  'ǅ',
  'ǆ',
  'Ǆ',
  'ﬁ',
  'ﬃ',
  '한국어',
  '日本語',
  '😀',
  '👨‍👩‍👧',
  '́',
  'á̂',
  'ệ',
  'ệ',
  'Café',
  'Café',
  ' ',
  ' ',
  '',
  'MiXeD CaSe',
  'ÀÉÎÔÜ',
  'àéîôü',
  'ñ',
  'Ñ',
  'ø',
  'Ø',
  'đ',
  'Đ',
  'ł',
  'Ł',
  'æ',
  'Œ',
  'ǰ',
  'ẛ̣',
  'ẞ',
  'ᾳ',
  'Привет',
  'ПРИВЕТ',
  'Ёё',
  'ΐ',
  'ά',
  'Ά',
  '१२३',
  '٣',
  'ｆｕｌｌ',
  'ℌ',
  'ª',
  '²',
  'ͅ',
  'aͅ',
  'Å',
  'Å',
  'ǻ',
];

function normalizeCases(): Case[] {
  const r = rng(0x4e0b);
  const pool = [...WORDS, ...NORMALIZE_SAMPLES, ' ', '-', '́', '̈', ' ', 'a', 'E', 'ß', 'Σ', 'ς', '0'];
  const batches: Case[] = [
    {
      id: 'samples',
      input: { fn: 'normalize_text', texts: NORMALIZE_SAMPLES },
      expected: NORMALIZE_SAMPLES.map(normalizeText),
    },
  ];
  for (let n = 0; n < 20; n++) {
    const texts = Array.from({ length: 25 }, () =>
      Array.from({ length: int(r, 0, 8) }, () => pick(r, pool)).join(chance(r, 0.5) ? '' : ' '),
    );
    batches.push({
      id: `random-${String(n).padStart(2, '0')}`,
      input: { fn: 'normalize_text', texts },
      expected: texts.map(normalizeText),
    });
  }
  return batches;
}

// --- dates -------------------------------------------------------------------------------------------------------

interface NowInput {
  zone: string;
  epoch_ms: number;
  year: number;
  month: number;
  day: number;
}

function nowIn(zone: string, y: number, m: number, d: number, h: number, min: number): NowInput & { date: Date } {
  return withTimezone(zone, () => {
    const date = new Date(y, m - 1, d, h, min);
    return {
      zone,
      epoch_ms: date.getTime(),
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      date,
    };
  });
}

const publicNow = ({ zone, epoch_ms, year, month, day }: NowInput) => ({ zone, epoch_ms, year, month, day });

const DUE_TEXTS = [
  '',
  'tomorrow',
  '2026-1-5',
  '2026-10-14T10:00',
  '9999-99-99',
  '2026-10-14 ',
  'soon',
  '٢٠٢٦-١٠-١٤',
  '2026-10',
  '2026',
];

function dueCases(): Case[] {
  const r = rng(0xd0e);
  const config = CONFIGS[0]!.config;
  const out: Case[] = [];
  const dates: [number, number, number][] = [
    [2026, 10, 14],
    [2026, 12, 31],
    [2027, 1, 1],
    [2024, 2, 28],
    [2024, 2, 29],
    [2026, 2, 27],
    [2026, 2, 28],
    [2026, 3, 1],
    [2026, 12, 30],
    [2000, 12, 31],
    [1999, 12, 31],
    [2100, 2, 28],
    [2030, 6, 15],
  ];
  for (const zone of ZONES) {
    for (const [y, m, d] of dates) {
      const now = nowIn(zone, y, m, d, int(r, 0, 23), int(r, 0, 59));
      const cards: Card[] = [];
      const expected: unknown[] = [];
      withTimezone(zone, () => {
        for (let offset = -4; offset <= 5; offset++) {
          const when = new Date(y, m - 1, d + offset);
          cards.push(makeCard({ key: `OP-${cards.length + 1}`, status: 'todo', due: localDate(when) }));
        }
        for (const text of DUE_TEXTS)
          cards.push(makeCard({ key: `OP-${cards.length + 1}`, status: 'doing', due: text }));
        cards.push(makeCard({ key: `OP-${cards.length + 1}`, status: 'todo' }));
        cards.push(
          makeCard({ key: `OP-${cards.length + 1}`, status: 'done', due: localDate(new Date(y, m - 1, d - 3)) }),
        );
        cards.push(
          makeCard({ key: `OP-${cards.length + 1}`, status: 'ghost', due: localDate(new Date(y, m - 1, d - 1)) }),
        );
        for (const c of cards) expected.push(dueState(c, config, now.date) ?? null);
      });
      out.push({
        id: `due-${zone.replace('/', '-')}-${y}-${m}-${d}`,
        input: {
          fn: 'due_state',
          config,
          now: publicNow(now),
          cards: cards.map((c) => ({ status: c.status, due: c.due ?? null })),
        },
        expected,
      });
    }
  }
  return out;
}

const DAY = 86_400_000;

function timestampText(r: Random): string {
  const y = pick(r, ['2026', '2025', '2020', '0001', '1970', '2999', '9999', '+002026', '-000001']);
  const mo = String(int(r, 1, 12)).padStart(2, '0');
  const d = String(int(r, 1, 31)).padStart(2, '0');
  const date = pick(r, [y, `${y}-${mo}`, `${y}-${mo}-${d}`, `${y}-${mo}-${d}`]);
  if (!date.includes(`-${mo}-${d}`) || chance(r, 0.2)) return date;
  const time = `${String(int(r, 0, 23)).padStart(2, '0')}:${String(int(r, 0, 59)).padStart(2, '0')}`;
  const sec = chance(r, 0.7) ? `:${String(int(r, 0, 59)).padStart(2, '0')}` : '';
  const frac =
    sec && chance(r, 0.5)
      ? `.${'0123456789'
          .slice(0, int(r, 1, 6))
          .split('')
          .map(() => int(r, 0, 9))
          .join('')}`
      : '';
  const zone = pick(r, ['Z', 'z', '+02:00', '-03:30', '+0530', '-0000', '+23:59', '-12:00']);
  return `${date}${pick(r, ['T', 'T', 't'])}${time}${sec}${frac}${zone}`;
}

/** V8's result under two zones: when they differ, the text is read as local time and Rust deliberately refuses it. */
function parseStable(text: string): number | null | undefined {
  const [a, b] = ['UTC', 'Asia/Kolkata'].map((zone) => withTimezone(zone, () => Date.parse(text)));
  if (Number.isNaN(a) !== Number.isNaN(b) || (!Number.isNaN(a!) && a !== b)) return undefined;
  return Number.isNaN(a!) ? null : a!;
}

const NEGATIVE_TIMESTAMPS = [
  '',
  'garbage',
  '2026-13-01',
  '2026-00-10',
  '2026-10-00',
  '2026-10-32',
  '2026-10-14T25:00:00Z',
  '2026-10-14T24:00:01Z',
  '2026-10-14T12:60:00Z',
  '2026-10-14T12:00:60Z',
  '2026-10-14T12:00:00+24:00',
  '2026-10-14T12:00:00+02',
  '2026-10-14T12:00:00,5Z',
  '2026-10-14T12:00:00.Z',
  '2026-10-14T12',
  '2026-10-14T1:00:00Z',
  '2026-10-14T12:0:00Z',
  '-000000-01-01T00:00:00Z',
  '+275760-09-13T00:00:00.001Z',
  '-271821-04-19T23:59:59.999Z',
  '2026-10-14T12:00:00.000 Z',
  'T',
  'Z',
  '2026-10-14+02:00',
  '2026-10-14T12:00:00+02:60',
  '275760-09-13',
  '2026-10-14T12:00:00Zjunk',
];

function timestampCases(): Case[] {
  const r = rng(0x7157);
  const fixed = [
    '2026-10-14T12:00:00.000Z',
    '2026-10-14T12:00:00Z',
    '2026-10-14T12:00Z',
    '2026-10-14T12:00:00.5Z',
    '2026-10-14T12:00:00.123456Z',
    '2026-10-14',
    '2026-10',
    '2026',
    '2026-10-14T12:00:00+02:00',
    '2026-10-14T12:00:00-03:30',
    '2026-10-14T12:00:00+0200',
    '2026-10-14T24:00:00Z',
    '2026-10-14T24:00Z',
    '2026-02-30',
    '2026-02-30T00:00:00Z',
    '2026-02-29',
    '2024-02-29',
    '2026-04-31',
    '2026-02-31T00:00:00Z',
    '0000-01-01',
    '+002026-10-14T00:00:00Z',
    '-000001-01-01T00:00:00Z',
    '+002026-10',
    '+002026',
    '-000001',
    '2026-10-14t12:00:00z',
    '0001-01-06t02:01:00z',
    '0050-03-04T00:00:00Z',
    '1970-01-01T00:00:00Z',
    '0001-01-01T00:00:00Z',
    '+275760-09-13T00:00:00.000Z',
    '-271821-04-20T00:00:00.000Z',
    '2026-10-14T12:00:00.000+00:00',
    '2026-10-14T12:00:00.000-0000',
    '2026-10-14T12:00:00+23:59',
  ];
  const texts = new Set<string>([...fixed, ...NEGATIVE_TIMESTAMPS]);
  for (let n = 0; n < 400; n++) texts.add(timestampText(r));
  // Mutations of valid timestamps: V8 rejects most of them, and those are what Rust must reject too.
  for (let n = 0; n < 300; n++) {
    const base = [...timestampText(r)];
    const at = int(r, 0, base.length - 1);
    base[at] = pick(r, ['x', ':', '-', ' ', '9', '0', 'T', 'Z', '.', '+', '']);
    texts.add(base.join(''));
  }
  const parsed: { text: string; value: number | null }[] = [];
  for (const text of texts) {
    const value = parseStable(text);
    if (value === undefined) continue; // local-time reading: not part of the contract
    // V8 also accepts legacy, zone-independent forms (RFC 2822 dates, `2026-10-14Z`, ...) that Rust does not read.
    if (
      value !== null &&
      !/^(?:[+-]\d{6}|\d{4})(?:-\d{2}(?:-\d{2})?)?(?:[Tt]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2}))?$/.test(
        text,
      )
    )
      continue;
    parsed.push({ text, value });
  }
  const sorted = parsed.sort((a, b) => (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
  return [
    {
      id: 'parse-timestamp',
      input: { fn: 'parse_timestamp', texts: sorted.map((p) => p.text) },
      expected: sorted.map((p) => p.value),
    },
  ];
}

function archiveCases(): Case[] {
  const r = rng(0xa4c);
  const out: Case[] = [];
  const nowMs = Date.parse('2026-10-14T12:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const variant of CONFIGS) {
    for (const days of [0, 1, 7, 14, 60]) {
      const config = { ...variant.config, hideDoneAfterDays: days };
      const cards: Card[] = [];
      const doneId = config.columns.find((c) => c.done)?.id ?? 'ghost';
      for (const status of [...variant.statuses, doneId, 'ghost']) {
        for (const ago of [0, 1, days - 1, days, days + 1, days * 2, 400]) {
          for (const mode of ['resolved', 'updated']) {
            const stamp = iso(nowMs - ago * DAY - (days > 0 && ago === days ? 0 : int(r, 0, 3_600_000)));
            cards.push(
              mode === 'resolved'
                ? makeCard({
                    key: `OP-${cards.length + 1}`,
                    status,
                    resolved: stamp,
                    updated: '2030-01-01T00:00:00.000Z',
                  })
                : makeCard({ key: `OP-${cards.length + 1}`, status, updated: stamp }),
            );
          }
        }
      }
      // exact boundary, in milliseconds
      for (const delta of [-1, 0, 1]) {
        cards.push(
          makeCard({ key: `OP-${cards.length + 1}`, status: doneId, resolved: iso(nowMs - days * DAY - delta) }),
        );
      }
      // timestamps of other shapes, and ones that are not dates at all
      for (const text of [
        'garbage',
        '',
        '2020-01-01',
        '2020-01-01T00:00:00+02:00',
        '2020-02-30',
        '2020-01-01T00:00:00,5Z',
        '+002020-01-01T00:00:00Z',
      ]) {
        cards.push(
          makeCard({
            key: `OP-${cards.length + 1}`,
            status: doneId,
            resolved: text,
            updated: '2019-01-01T00:00:00.000Z',
          }),
        );
        cards.push(makeCard({ key: `OP-${cards.length + 1}`, status: doneId, updated: text }));
      }
      const expected = withTimezone('UTC', () => cards.map((c) => isArchivedDone(c, config, new Date(nowMs))));
      out.push({
        id: `archive-${variant.statuses.length}cols-${days}days`,
        input: {
          fn: 'is_archived_done',
          config,
          now: { epoch_ms: nowMs },
          cards: cards.map((c) => ({ status: c.status, resolved: c.resolved ?? null, updated: c.updated })),
        },
        expected,
      });
    }
  }
  return out;
}

function localDateCases(): Case[] {
  const dates: [number, number, number][] = [
    [2026, 1, 5],
    [2026, 12, 31],
    [2024, 2, 29],
    [1970, 1, 1],
    [1969, 12, 31],
    [2100, 3, 1],
    [1000, 1, 1],
    [9999, 12, 31],
    [2026, 10, 14],
  ];
  return [
    {
      id: 'local-date-format',
      input: { fn: 'local_date', dates },
      expected: withTimezone('UTC', () => dates.map(([y, m, d]) => localDate(new Date(Date.UTC(y, m - 1, d, 12))))),
    },
    {
      id: 'priority-weight',
      input: { fn: 'priority_weight', priorities: [...PRIORITIES] },
      expected: PRIORITIES.map(priorityWeight),
    },
  ];
}

// --- rank_for_placement ------------------------------------------------------------------------------------------

function placementCases(): Case[] {
  const r = rng(0x9ace);
  const config = CONFIGS[0]!.config;
  const statuses = CONFIGS[0]!.statuses;
  const out: Case[] = [];
  for (let n = 0; n < 120; n++) {
    const size = int(r, 0, 9);
    const ranks = spreadRanks(size);
    const cards = Array.from({ length: size }, (_, i) =>
      makeCard({
        key: `OP-${i + 1}`,
        status: pick(r, statuses),
        // mostly well-formed ranks; sometimes equal or inverted ones, as hand-edited notes can have
        rank: chance(r, 0.8) ? ranks[i]! : pick(r, ['V', 'V', 'A', 'Z', '1']),
      }),
    );
    const moves = Array.from({ length: 10 }, () => {
      const moving = chance(r, 0.8) ? `OP-${int(r, 1, Math.max(1, size))}` : 'OP-99';
      const status = pick(r, [...statuses, 'ghost']);
      // Mostly an anchor that really is in the destination column, so the success paths get exercised too.
      const column = displayColumn(config, status).id;
      const inColumn = cards.filter((c) => c.key !== moving && displayColumn(config, c.status).id === column);
      const anchor =
        chance(r, 0.85) && inColumn.length > 0
          ? pick(r, inColumn).key
          : pick(r, ['OP-98', '', `OP-${int(r, 1, Math.max(1, size))}`]);
      const how = pick(r, ['bottom', 'before', 'before', 'after', 'after', 'both', 'empty-before']);
      const placement: Placement =
        how === 'bottom'
          ? {}
          : how === 'before'
            ? { before: anchor }
            : how === 'after'
              ? { after: anchor }
              : how === 'both'
                ? { before: anchor, after: pick(r, ['OP-98', anchor]) }
                : { before: '', after: anchor };
      return { moving, status, placement };
    });
    const expected = moves.map((m) => {
      try {
        return { rank: rankForPlacement(cards, config, m.moving, m.status, m.placement) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    });
    out.push({
      id: `placement-${String(n).padStart(3, '0')}`,
      input: { fn: 'rank_for_placement', config, cards, moves },
      expected,
    });
  }
  return out;
}

export function generate(): FixtureFile {
  return {
    description:
      'query.ts: filter/sort/group boards, text normalization, due dates, archiving, Date.parse subset, rank_for_placement. ' +
      'Dates are generated under fixed zones; `expected` is what the TypeScript returns.',
    cases: [
      ...handWrittenBoards(),
      ...randomBoards(),
      ...normalizeCases(),
      ...dueCases(),
      ...archiveCases(),
      ...timestampCases(),
      ...localDateCases(),
      ...placementCases(),
    ],
  };
}
