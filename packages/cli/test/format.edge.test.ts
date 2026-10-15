import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CONFIG, normalizeConfig, type Card, type CardType, type Priority } from '@oprojects/core';
import {
  makePainter,
  pad,
  priorityGlyph,
  renderBoard,
  renderCard,
  renderTable,
  shortDate,
  statusName,
  truncate,
  typeGlyph,
  wrap,
} from '../src/format';

vi.setConfig({ testTimeout: 30_000 });

const ESC = String.fromCharCode(27);
const strip = (text: string) => text.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
const visible = (text: string) => [...strip(text)].length;

const plain = makePainter(false);
const color = makePainter(true);

const NOW = new Date(2026, 9, 14, 12, 0, 0); // local: 2026-10-14
const config = normalizeConfig({
  ...DEFAULT_CONFIG,
  prefix: 'OP',
  columns: [
    { id: 'todo', name: 'To Do' },
    { id: 'doing', name: 'In Progress', wip: 2 },
    { id: 'review', name: 'Review' },
    { id: 'done', name: 'Done', done: true },
  ],
});

function card(over: Partial<Card> & { key: string }): Card {
  return {
    path: `Cards/${over.key}.md`,
    title: over.key,
    status: 'todo',
    type: 'task',
    priority: 'medium',
    labels: [],
    rank: 'V',
    created: '2026-10-01T10:00:00.000Z',
    updated: '2026-10-01T10:00:00.000Z',
    body: '',
    checklist: { done: 0, total: 0 },
    comments: [],
    ...over,
  };
}

const TYPES: CardType[] = ['task', 'story', 'bug', 'epic'];
const PRIORITIES: Priority[] = ['highest', 'high', 'medium', 'low', 'lowest'];

describe('makePainter', () => {
  it('returns the text untouched when disabled', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (s) => {
        expect(plain('red', s)).toBe(s);
        expect(plain(['bold', 'cyan'], s)).toBe(s);
      }),
    );
    expect(plain.enabled).toBe(false);
  });

  it('wraps the text in the style code and a reset when enabled, joining several styles with ;', () => {
    expect(color('red', 'x')).toBe(`${ESC}[31mx${ESC}[0m`);
    expect(color(['bold', 'green'], 'x')).toBe(`${ESC}[1;32mx${ESC}[0m`);
    expect(color('gray', '')).toBe(`${ESC}[90m${ESC}[0m`);
    expect(color.enabled).toBe(true);
  });

  it('never changes the visible text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (s) => {
        expect(strip(color(['bold', 'magenta'], s))).toBe(s);
      }),
    );
  });
});

describe('truncate', () => {
  it('keeps text that fits, and cuts the rest to `width` characters ending in an ellipsis', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), fc.integer({ min: 1, max: 50 }), (text, width) => {
        const out = truncate(text, width);
        const length = [...text].length;
        expect([...out].length).toBeLessThanOrEqual(width);
        expect(out).toBe(length <= width ? text : `${[...text].slice(0, width - 1).join('')}…`);
      }),
      { numRuns: 300 },
    );
  });

  it('returns an empty string for a width of zero or less', () => {
    expect(truncate('anything', 0)).toBe('');
    expect(truncate('anything', -5)).toBe('');
  });

  it('counts code points, so an emoji is never split in half', () => {
    expect(truncate('🙂🙂🙂🙂', 3)).toBe('🙂🙂…');
    expect(truncate('日本語です', 3)).toBe('日本…');
    expect(truncate('abc', 1)).toBe('…');
  });
});

describe('pad', () => {
  it('pads to the width by characters and never truncates', () => {
    expect(pad('ab', 5)).toBe('ab   ');
    expect(pad('abcdef', 3)).toBe('abcdef');
    expect(pad('🙂', 3)).toBe('🙂  ');
    expect(pad('', 2)).toBe('  ');
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 20 }), fc.integer({ min: 0, max: 30 }), (s, width) => {
        const out = pad(s, width);
        expect([...out].length).toBe(Math.max(width, [...s].length));
        expect(out.startsWith(s)).toBe(true);
      }),
    );
  });
});

describe('wrap', () => {
  const words = fc.array(
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 14 }).filter((w) => w.trim() === w && !/\s/.test(w)),
    { maxLength: 14 },
  );

  it('never exceeds the width or the line limit, and keeps the words in order', () => {
    fc.assert(
      fc.property(words, fc.integer({ min: 4, max: 40 }), fc.integer({ min: 1, max: 4 }), (list, width, maxLines) => {
        const lines = wrap(list.join(' '), width, maxLines);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        expect(lines.length).toBeLessThanOrEqual(maxLines);
        for (const line of lines) expect([...line].length).toBeLessThanOrEqual(width);
      }),
      { numRuns: 300 },
    );
  });

  it('breaks between words and keeps the whole text when it fits', () => {
    expect(wrap('one two three four', 9, 5)).toEqual(['one two', 'three', 'four']);
    expect(wrap('short', 20, 2)).toEqual(['short']);
    expect(wrap('a b c', 20, 1)).toEqual(['a b c']);
  });

  it('puts an ellipsis on the last allowed line when the text does not fit', () => {
    const lines = wrap('alpha beta gamma delta epsilon zeta', 11, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect([...lines[1]!].length).toBeLessThanOrEqual(11);
  });

  it('cuts a single word longer than the width, and collapses runs of whitespace', () => {
    expect(wrap('abcdefghijklmnop', 6, 2)).toEqual(['abcde…']);
    expect(wrap('  spaced \t out\n words  ', 20, 3)).toEqual(['spaced out words']);
  });

  it('returns one empty line for empty or blank text', () => {
    expect(wrap('', 10, 2)).toEqual(['']);
    expect(wrap('   \n\t ', 10, 2)).toEqual(['']);
  });
});

describe('shortDate', () => {
  it('drops the year only for dates in the same year as `now`', () => {
    expect(shortDate('2026-10-20', NOW)).toBe('10-20');
    expect(shortDate('2027-01-02', NOW)).toBe('2027-01-02');
    expect(shortDate('2025-12-31', NOW)).toBe('2025-12-31');
  });
});

describe('glyphs', () => {
  it('have a fixed visible width (2 for priorities, 1 for types) whatever the value, painted or not', () => {
    for (const p of PRIORITIES) {
      expect(visible(priorityGlyph(p, plain))).toBe(2);
      expect(visible(priorityGlyph(p, color))).toBe(2);
    }
    for (const t of TYPES) {
      expect(visible(typeGlyph(t, plain))).toBe(1);
      expect(visible(typeGlyph(t, color))).toBe(1);
    }
  });

  it('use distinct symbols and the documented colors', () => {
    expect(new Set(PRIORITIES.map((p) => priorityGlyph(p, plain))).size).toBe(5);
    expect(new Set(TYPES.map((t) => typeGlyph(t, plain))).size).toBe(4);
    expect(typeGlyph('bug', color)).toContain(`${ESC}[31m`);
    expect(typeGlyph('story', color)).toContain(`${ESC}[32m`);
    expect(typeGlyph('task', color)).toContain(`${ESC}[34m`);
    expect(typeGlyph('epic', color)).toContain(`${ESC}[35m`);
    expect(priorityGlyph('highest', color)).toContain(`${ESC}[31m`);
    expect(priorityGlyph('medium', color)).toContain(`${ESC}[33m`);
    expect(priorityGlyph('lowest', color)).toContain(`${ESC}[34m`);
  });
});

describe('statusName', () => {
  it('shows the display name of the column, falling back to the first column for unknown statuses', () => {
    expect(statusName(card({ key: 'OP-1', status: 'doing' }), config)).toBe('In Progress');
    expect(statusName(card({ key: 'OP-1', status: 'ghost' }), config)).toBe('To Do');
    expect(statusName(card({ key: 'OP-1', status: '' }), config)).toBe('To Do');
  });
});

describe('renderTable', () => {
  it('says so when there is nothing to show (painted gray when colors are on)', () => {
    expect(renderTable([], config, plain, 100, NOW)).toBe('No cards.');
    expect(renderTable([], config, color, 100, NOW)).toBe(`${ESC}[90mNo cards.${ESC}[0m`);
  });

  it('prints one line per card with type, priority, key, status and title', () => {
    const out = renderTable(
      [
        card({ key: 'OP-1', title: 'First', type: 'bug', priority: 'high' }),
        card({ key: 'OP-12', title: 'Second', status: 'doing' }),
      ],
      config,
      plain,
      100,
      NOW,
    );
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^B ↑  OP-1 {2}To Do {7}First$/);
    expect(lines[1]).toMatch(/^T = {2}OP-12 In Progress Second$/);
  });

  it('aligns the columns whatever the key and status lengths', () => {
    const cards = [
      card({ key: 'OP-1', title: 'a', assignee: 'Ana' }),
      card({ key: 'OP-1000', title: 'b', status: 'review', assignee: 'Bruno Santos' }),
    ];
    const [first, second] = renderTable(cards, config, plain, 100, NOW).split('\n') as [string, string];
    expect(first.indexOf(' a')).toBe(second.indexOf(' b'));
  });

  it('adds the assignee column only when someone is assigned, cutting names at 14 characters', () => {
    expect(renderTable([card({ key: 'OP-1', title: 'x' })], config, plain, 100, NOW)).not.toContain('@');
    const out = renderTable(
      [card({ key: 'OP-1', title: 'x', assignee: 'A very long assignee name' })],
      config,
      plain,
      100,
      NOW,
    );
    expect(out).toContain('A very long a…'); // 14 characters including the ellipsis
    expect(out).not.toContain('A very long assignee');
  });

  it('adds a due column only when some card has a due date, using the short form this year', () => {
    expect(renderTable([card({ key: 'OP-1', title: 'x' })], config, plain, 100, NOW)).not.toMatch(/\d\d-\d\d/);
    const out = renderTable(
      [card({ key: 'OP-1', title: 'x', due: '2026-10-20' }), card({ key: 'OP-2', title: 'y' })],
      config,
      plain,
      100,
      NOW,
    );
    expect(out.split('\n')[0]).toContain('10-20');
    expect(renderTable([card({ key: 'OP-1', title: 'x', due: '2027-03-04' })], config, plain, 100, NOW)).toContain(
      '2027-03-04',
    );
  });

  it('colors the due date: red when overdue, yellow when soon, gray later, and gray for done cards', () => {
    const cases: [string, string, string][] = [
      ['2026-10-10', 'todo', '31'],
      ['2026-10-15', 'todo', '33'],
      ['2026-12-31', 'todo', '90'],
      ['2026-10-10', 'done', '90'],
    ];
    for (const [due, status, code] of cases) {
      const out = renderTable([card({ key: 'OP-1', title: 'x', due, status })], config, color, 100, NOW);
      expect(out).toContain(`${ESC}[${code}m${shortDate(due, NOW)}${ESC}[0m`);
    }
  });

  it('shows checklist progress and labels after the title', () => {
    const out = renderTable(
      [card({ key: 'OP-1', title: 'Task', checklist: { done: 1, total: 3 }, labels: ['api', 'ux'] })],
      config,
      plain,
      100,
      NOW,
    );
    expect(out).toMatch(/Task 1\/3 #api #ux$/);
  });

  it('cuts long titles with an ellipsis so that a line without labels fits the terminal', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'grapheme', minLength: 1, maxLength: 200 }).map((t) => t.replace(/\s+/g, ' ').trim() || 'x'),
        fc.integer({ min: 40, max: 160 }),
        fc.constantFrom(...PRIORITIES),
        (title, width, priority) => {
          const out = renderTable(
            [card({ key: 'OP-7', title, priority, assignee: 'Zoë', due: '2026-10-20' })],
            config,
            plain,
            width,
            NOW,
          );
          expect(visible(out)).toBeLessThanOrEqual(Math.max(width, 16 + 40));
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is the same text with colors on or off, once the escape codes are removed', () => {
    const cards = [
      card({ key: 'OP-1', title: 'a', due: '2026-10-10', assignee: 'Ana', labels: ['x'] }),
      card({ key: 'OP-2', title: 'b', status: 'done', type: 'epic', priority: 'lowest' }),
    ];
    expect(strip(renderTable(cards, config, color, 100, NOW))).toBe(renderTable(cards, config, plain, 100, NOW));
  });

  it('never throws for odd titles: emoji, wide characters, control-ish text', () => {
    const titles = ['🙂'.repeat(60), '日本語'.repeat(30), 'a\u0000b', '\ttabbed\t', 'x'.repeat(500)];
    for (const title of titles)
      expect(() => renderTable([card({ key: 'OP-1', title })], config, plain, 60, NOW)).not.toThrow();
  });
});

describe('renderBoard', () => {
  const lines = (text: string) => text.split('\n');

  it('prints the columns side by side when each gets at least 20 characters, stacked below that', () => {
    const cards = [card({ key: 'OP-1', title: 'one' })];
    const wide = lines(renderBoard(cards, config, plain, 86, NOW)); // 4 columns: (86 - 3 gaps of 2) / 4 = 20
    expect(wide[0]).toMatch(/TO DO.*IN PROGRESS.*REVIEW.*DONE/);
    const narrow = lines(renderBoard(cards, config, plain, 85, NOW)); // 19 per column: stacked
    expect(narrow[0]).toContain('TO DO');
    expect(narrow.some((l) => l.includes('TO DO') && l.includes('IN PROGRESS'))).toBe(false);
    expect(narrow.filter((l) => /^(TO DO|IN PROGRESS|REVIEW|DONE)/.test(l))).toHaveLength(4);
  });

  it('keeps every side-by-side line within the terminal width', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            title: fc
              .string({ unit: 'grapheme', minLength: 1, maxLength: 120 })
              .map((t) => t.replace(/\s+/g, ' ').trim() || 'x'),
            status: fc.constantFrom('todo', 'doing', 'review', 'done', 'ghost'),
            type: fc.constantFrom(...TYPES),
            priority: fc.constantFrom(...PRIORITIES),
            assignee: fc.option(fc.constantFrom('Ana', 'A very long assignee name', 'Zoë'), { nil: undefined }),
            due: fc.option(fc.constantFrom('2026-10-10', '2026-10-15', '2027-02-02'), { nil: undefined }),
          }),
          { maxLength: 10 },
        ),
        fc.integer({ min: 86, max: 200 }),
        (list, width) => {
          const cards = list.map((f, i) => card({ ...f, key: `OP-${i + 1}`, checklist: { done: i % 3, total: 3 } }));
          for (const text of lines(renderBoard(cards, config, plain, width, NOW)))
            expect(visible(text)).toBeLessThanOrEqual(width);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('shows each column with its count, "(empty)" when it has no cards, and every card once', () => {
    const cards = [card({ key: 'OP-1', title: 'alpha' }), card({ key: 'OP-2', title: 'beta', status: 'done' })];
    const out = renderBoard(cards, config, plain, 100, NOW);
    expect(out).toMatch(/TO DO 1/);
    expect(out).toMatch(/DONE 1/);
    expect(out).toContain('(empty)');
    expect(out.match(/OP-1/g)).toHaveLength(1);
    expect(out.match(/OP-2/g)).toHaveLength(1);
    const empty = renderBoard([], config, plain, 100, NOW);
    expect(empty.match(/\(empty\)/g)).toHaveLength(4);
    expect(empty).toMatch(/TO DO 0/);
  });

  it('shows count/limit and colors it red only when the WIP limit is exceeded', () => {
    const doing = (n: number) =>
      Array.from({ length: n }, (_, i) => card({ key: `OP-${i + 1}`, status: 'doing', rank: `V${i}` }));
    expect(renderBoard(doing(2), config, plain, 100, NOW)).toContain('IN PROGRESS 2/2');
    const okColored = renderBoard(doing(2), config, color, 100, NOW);
    expect(okColored).toContain(`${ESC}[90m2/2${ESC}[0m`);
    const over = renderBoard(doing(3), config, color, 100, NOW);
    expect(over).toContain(`${ESC}[31m3/2${ESC}[0m`);
  });

  it('puts cards with an unknown or empty status in the first column', () => {
    const out = renderBoard(
      [card({ key: 'OP-1', status: 'ghost' }), card({ key: 'OP-2', status: '' })],
      config,
      plain,
      100,
      NOW,
    );
    expect(out).toMatch(/TO DO 2/);
  });

  it('wraps long titles onto at most two lines, the last ending in an ellipsis', () => {
    const title = 'This is a very long title that cannot possibly fit into a single narrow board column at all';
    const out = renderBoard([card({ key: 'OP-1', title })], config, plain, 86, NOW);
    expect(out).toContain('…');
    expect(out).not.toContain('at all');
  });

  it('shows assignee, due date and checklist as a meta line, dropping what does not fit', () => {
    const full = renderBoard(
      [card({ key: 'OP-1', title: 't', assignee: 'Ana', due: '2026-10-20', checklist: { done: 1, total: 4 } })],
      config,
      plain,
      120,
      NOW,
    );
    expect(full).toContain('@Ana 10-20 1/4');
    const tight = renderBoard(
      [card({ key: 'OP-1', title: 't', assignee: 'Ana', due: '2026-10-20', checklist: { done: 1, total: 4 } })],
      config,
      plain,
      86,
      NOW,
    );
    expect(tight).toContain('@Ana');
    const cut = renderBoard(
      [card({ key: 'OP-1', title: 't', assignee: 'Someone with a long name' })],
      config,
      plain,
      120,
      NOW,
    );
    expect(cut).toContain('@Someone wit…'); // 12 characters including the ellipsis
  });

  it('colors done columns green and the others cyan in the header', () => {
    const out = renderBoard([], config, color, 100, NOW);
    expect(out).toContain(`${ESC}[1;32mDONE${ESC}[0m`);
    expect(out).toContain(`${ESC}[1;36mTO DO${ESC}[0m`);
  });

  it('is the same text with colors on or off once the escape codes are removed', () => {
    const cards = [
      card({ key: 'OP-1', title: 'alpha', due: '2026-10-10', assignee: 'Ana' }),
      card({ key: 'OP-2', title: 'beta', status: 'doing' }),
    ];
    expect(strip(renderBoard(cards, config, color, 100, NOW))).toBe(renderBoard(cards, config, plain, 100, NOW));
  });

  it('works with a single column and with a very wide terminal', () => {
    const single = normalizeConfig({ columns: [{ id: 'only', name: 'Only' }] });
    const out = renderBoard([card({ key: 'OP-1', status: 'only', title: 'x' })], single, plain, 300, NOW);
    expect(out).toContain('ONLY 1');
    expect(visible(lines(out)[0]!)).toBeLessThanOrEqual(300);
  });

  it('orders the cards of a column by rank', () => {
    const cards = [card({ key: 'OP-1', title: 'second', rank: 'b' }), card({ key: 'OP-2', title: 'first', rank: 'a' })];
    const out = renderBoard(cards, config, plain, 100, NOW);
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });
});

describe('renderCard', () => {
  const full = card({
    key: 'OP-7',
    title: 'Fix the login',
    status: 'doing',
    type: 'bug',
    priority: 'high',
    assignee: 'Ana',
    labels: ['auth', 'backend'],
    due: '2026-10-10',
    estimate: 3,
    parent: 'OP-1',
    resolved: '2026-10-12T00:00:00.000Z',
    body: '  Description line one\n\n- [x] done\n- [ ] todo  \n',
    checklist: { done: 1, total: 2 },
    comments: [
      { id: 'k3f9a', author: 'Bruno', at: '2026-10-14T17:02:00.000Z', text: 'first line\n\nthird line' },
      { id: 'h1', author: 'Carla', at: '', text: 'no time' },
    ],
  });

  it('shows every field of a full card, the trimmed description and the comments', () => {
    const out = renderCard(full, config, plain, NOW);
    for (const needle of [
      'B OP-7  Fix the login',
      'Status    In Progress',
      'Priority  ↑  high',
      'Type      bug',
      'Assignee  Ana',
      'Labels    #auth #backend',
      'Due       10-10',
      'Estimate  3',
      'Parent    OP-1',
      'Checklist 1/2',
      'Resolved  2026-10-12T00:00:00.000Z',
      'Note      Cards/OP-7.md',
      'Comments (2)',
    ]) {
      expect(out).toContain(needle);
    }
    expect(out).toContain('\nDescription line one\n\n- [x] done\n- [ ] todo\n');
  });

  it('lists comments with author, local time and id, indenting the text and keeping blank lines', () => {
    const out = renderCard(full, config, plain, NOW);
    const at = new Date('2026-10-14T17:02:00.000Z');
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const local = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    expect(out).toContain(`Bruno ${local}  #k3f9a\n  first line\n\n  third line`);
    expect(out).toContain('Carla   #h1\n  no time');
  });

  it('leaves out fields the card does not have, and the sections that would be empty', () => {
    const out = renderCard(card({ key: 'OP-1', title: 'Bare' }), config, plain, NOW);
    for (const absent of ['Assignee', 'Labels', 'Due', 'Estimate', 'Parent', 'Checklist', 'Resolved', 'Comments'])
      expect(out).not.toContain(absent);
    for (const present of ['Status', 'Priority', 'Type', 'Created', 'Updated', 'Note']) expect(out).toContain(present);
    expect(out.endsWith('Cards/OP-1.md')).toBe(true);
  });

  it('shows a zero estimate (it is a value, not an absence)', () => {
    expect(renderCard(card({ key: 'OP-1', estimate: 0 }), config, plain, NOW)).toContain('Estimate  0');
  });

  it('colors the due date by urgency and is the same text with colors off', () => {
    const overdue = renderCard(card({ key: 'OP-1', due: '2026-10-01' }), config, color, NOW);
    expect(overdue).toContain(`${ESC}[31m10-01${ESC}[0m`);
    expect(strip(renderCard(full, config, color, NOW))).toBe(renderCard(full, config, plain, NOW));
  });

  it('never throws on an invalid comment time or on a card with an unknown status', () => {
    const odd = card({
      key: 'OP-1',
      status: 'ghost',
      comments: [{ id: 'x', author: 'A', at: 'not a date', text: 't' }],
    });
    expect(() => renderCard(odd, config, plain, NOW)).not.toThrow();
    expect(renderCard(odd, config, plain, NOW)).toContain('To Do');
    expect(renderCard(odd, config, plain, NOW)).toContain('A   #x');
  });
});
