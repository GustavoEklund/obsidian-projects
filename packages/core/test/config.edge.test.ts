import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COLUMNS,
  DEFAULT_CONFIG,
  columnById,
  displayColumn,
  isDoneStatus,
  isValidPrefix,
  normalizeConfig,
  normalizeFolder,
  resolveColumn,
  slugifyColumnId,
  type BoardConfig,
} from '../src/config';

vi.setConfig({ testTimeout: 30_000 });

const COLUMN_ID = /^[a-z0-9][a-z0-9_-]*$/;

describe('isValidPrefix', () => {
  it('accepts 2-10 upper-case letters/digits starting with a letter, and nothing else', () => {
    for (const ok of ['OP', 'AB', 'WEB', 'A1', 'ABCDEFGHIJ', 'X9Y8Z7']) expect(isValidPrefix(ok)).toBe(true);
    for (const bad of ['', 'A', 'a1', 'op', '1AB', 'ABCDEFGHIJK', 'A-B', 'A B', 'AÉ', '_AB'])
      expect(isValidPrefix(bad)).toBe(false);
  });

  it('agrees with the documented pattern for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (s) => {
        expect(isValidPrefix(s)).toBe(/^[A-Z][A-Z0-9]{1,9}$/.test(s));
      }),
      { numRuns: 300 },
    );
  });
});

describe('slugifyColumnId', () => {
  it('produces a valid column id for any name, and is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (name) => {
        const slug = slugifyColumnId(name);
        expect(slug === 'column' || COLUMN_ID.test(slug)).toBe(true);
        expect(slug).not.toMatch(/^-|-$|--/);
        expect(slugifyColumnId(slug)).toBe(slug);
      }),
      { numRuns: 300 },
    );
  });

  it('strips accents, lower-cases and joins words with single dashes', () => {
    expect(slugifyColumnId('In Review')).toBe('in-review');
    expect(slugifyColumnId('  Zoë  Müller!! ')).toBe('zoe-muller');
    expect(slugifyColumnId('Café / Bar')).toBe('cafe-bar');
    expect(slugifyColumnId('WIP_2')).toBe('wip-2');
  });

  it('falls back to "column" when nothing usable is left', () => {
    for (const name of ['', '   ', '!!!', '日本語', '---', '🙂']) expect(slugifyColumnId(name)).toBe('column');
  });
});

describe('normalizeFolder', () => {
  it('drops leading/trailing slashes, "." and ".." segments, and turns backslashes into slashes', () => {
    expect(normalizeFolder('/Cards/')).toBe('Cards');
    expect(normalizeFolder('Work\\Board')).toBe('Work/Board');
    expect(normalizeFolder('../../etc/./passwd')).toBe('etc/passwd');
    expect(normalizeFolder('a//b///c')).toBe('a/b/c');
    expect(normalizeFolder('..')).toBe('');
    expect(normalizeFolder('')).toBe('');
  });

  it('never returns a path that can leave the vault, and is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (folder) => {
        const clean = normalizeFolder(folder);
        expect(clean.split('/')).not.toContain('..');
        expect(clean).not.toMatch(/^\/|\/$|\/\/|\\/);
        expect(normalizeFolder(clean)).toBe(clean);
      }),
      { numRuns: 300 },
    );
  });
});

describe('normalizeConfig', () => {
  it('falls back to the defaults for anything that is not an object', () => {
    for (const junk of [undefined, null, 0, 1, 'text', true, [], [1, 2], () => 1]) {
      expect(normalizeConfig(junk)).toEqual(DEFAULT_CONFIG);
    }
  });

  it('keeps a good config as it is', () => {
    const good: BoardConfig = {
      folder: 'Work/Board',
      prefix: 'WEB',
      columns: [
        { id: 'backlog', name: 'Backlog' },
        { id: 'doing', name: 'Doing', wip: 3 },
        { id: 'shipped', name: 'Shipped', done: true },
      ],
      hideDoneAfterDays: 7,
      me: 'Ana',
      members: ['Ana', 'Bruno'],
    };
    expect(normalizeConfig(good)).toEqual(good);
  });

  it('upper-cases a lower-case prefix and rejects invalid ones', () => {
    expect(normalizeConfig({ prefix: 'web' }).prefix).toBe('WEB');
    expect(normalizeConfig({ prefix: '  web  ' }).prefix).toBe('WEB');
    for (const bad of ['a', '1ab', 'A B', 'TOOLONGPREFIX', '', 42, null, {}])
      expect(normalizeConfig({ prefix: bad }).prefix).toBe(DEFAULT_CONFIG.prefix);
  });

  it('normalizes the folder and falls back to Cards when nothing is left', () => {
    expect(normalizeConfig({ folder: '/Work\\Board/' }).folder).toBe('Work/Board');
    for (const bad of ['', '   ', '../..', 5, null]) expect(normalizeConfig({ folder: bad }).folder).toBe('Cards');
  });

  it('floors hideDoneAfterDays, keeps 0, and rejects negatives and non-numbers', () => {
    expect(normalizeConfig({ hideDoneAfterDays: 7.9 }).hideDoneAfterDays).toBe(7);
    expect(normalizeConfig({ hideDoneAfterDays: 0 }).hideDoneAfterDays).toBe(0);
    for (const bad of [-1, '7', null, NaN, undefined])
      expect(normalizeConfig({ hideDoneAfterDays: bad }).hideDoneAfterDays).toBe(14);
  });

  it('trims `me` and ignores non-strings', () => {
    expect(normalizeConfig({ me: '  Ana ' }).me).toBe('Ana');
    for (const bad of [5, null, [], {}]) expect(normalizeConfig({ me: bad }).me).toBe('');
  });

  it('de-duplicates and trims members and drops blanks and non-strings', () => {
    expect(normalizeConfig({ members: [' Ana ', 'Ana', 'Bruno', '', '  ', 3, null, 'Bruno '] }).members).toEqual([
      'Ana',
      'Bruno',
    ]);
    expect(normalizeConfig({ members: 'Ana' }).members).toEqual([]);
  });

  describe('columns', () => {
    it('uses the default columns when the list is missing, empty or unusable', () => {
      for (const bad of [undefined, null, 'x', {}, [], [null, 3, 'x', {}], [{ id: '', name: '' }]]) {
        expect(normalizeConfig({ columns: bad }).columns).toEqual(DEFAULT_COLUMNS);
      }
    });

    it('gives every column a unique, valid id: bad ids are slugified and the first of a duplicate wins', () => {
      const cols = normalizeConfig({
        columns: [
          { id: 'Needs Review!', name: 'Needs review' },
          { id: 'todo', name: 'To do' },
          { id: 'todo', name: 'Duplicate' },
          { name: 'Backlog items' },
          { id: 'UPPER', name: 'Upper' },
        ],
      }).columns;
      expect(cols.map((c) => c.id)).toEqual(['needs-review', 'todo', 'backlog-items', 'upper']);
      expect(cols.find((c) => c.id === 'todo')!.name).toBe('To do');
    });

    it('uses the id as the name when the name is missing, and the name as the id when the id is missing', () => {
      const cols = normalizeConfig({ columns: [{ id: 'qa' }, { name: 'Ready to ship' }] }).columns;
      expect(cols).toEqual([
        { id: 'qa', name: 'qa' },
        { id: 'ready-to-ship', name: 'Ready to ship' },
      ]);
    });

    it('accepts `done` only when it is exactly true, and `wip` only as a positive finite number (floored)', () => {
      const cols = normalizeConfig({
        columns: [
          { id: 'a', name: 'A', done: true, wip: 4.7 },
          { id: 'b', name: 'B', done: 'true', wip: 0 },
          { id: 'c', name: 'C', done: 1, wip: -3 },
          { id: 'd', name: 'D', wip: Infinity },
          { id: 'e', name: 'E', wip: '5' },
        ],
      }).columns;
      expect(cols).toEqual([
        { id: 'a', name: 'A', done: true, wip: 4 },
        { id: 'b', name: 'B' },
        { id: 'c', name: 'C' },
        { id: 'd', name: 'D' },
        { id: 'e', name: 'E' },
      ]);
    });

    it('allows a board with no done column (nothing ever resolves) and with a single column', () => {
      const none = normalizeConfig({
        columns: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      });
      expect(none.columns.some((c) => c.done)).toBe(false);
      expect(isDoneStatus(none, 'a')).toBe(false);
      expect(normalizeConfig({ columns: [{ id: 'only', name: 'Only' }] }).columns).toHaveLength(1);
    });

    it('never aliases the shared default columns: editing a result must not change DEFAULT_COLUMNS', () => {
      const first = normalizeConfig({});
      first.columns[0]!.name = 'Hacked';
      first.columns.push({ id: 'extra', name: 'Extra' });
      expect(DEFAULT_COLUMNS[0]!.name).toBe('To Do');
      expect(DEFAULT_COLUMNS).toHaveLength(4);
      expect(normalizeConfig({}).columns[0]!.name).toBe('To Do');
    });
  });

  it('never throws and always returns a valid config, whatever JSON it is given', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const c = normalizeConfig(raw);
        expect(isValidPrefix(c.prefix)).toBe(true);
        expect(c.folder.length).toBeGreaterThan(0);
        expect(c.folder.split('/')).not.toContain('..');
        expect(c.columns.length).toBeGreaterThan(0);
        const ids = c.columns.map((col) => col.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) expect(COLUMN_ID.test(id)).toBe(true);
        expect(Number.isInteger(c.hideDoneAfterDays) && c.hideDoneAfterDays >= 0).toBe(true);
        expect(new Set(c.members).size).toBe(c.members.length);
        expect(typeof c.me).toBe('string');
      }),
      { numRuns: 400 },
    );
  });

  it('is idempotent and survives a JSON round trip', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (raw) => {
        const once = normalizeConfig(raw);
        expect(normalizeConfig(once)).toEqual(once);
        expect(normalizeConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
      }),
      { numRuns: 300 },
    );
  });

  it('does not mutate its input', () => {
    const raw = { prefix: 'web', columns: [{ id: 'A b', name: 'A', wip: 2.5 }], members: ['x', 'x'] };
    const copy = structuredClone(raw);
    normalizeConfig(raw);
    expect(raw).toEqual(copy);
  });

  it('ignores unknown keys and prototype-pollution attempts', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "extra": 1, "prefix": "OK"}');
    const c = normalizeConfig(raw);
    expect(c.prefix).toBe('OK');
    expect(Object.keys(c).sort()).toEqual(['columns', 'folder', 'hideDoneAfterDays', 'me', 'members', 'prefix']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('column helpers', () => {
  const config = normalizeConfig({
    columns: [
      { id: 'todo', name: 'To Do' },
      { id: 'in-review', name: 'In Review' },
      { id: 'done', name: 'Done', done: true },
    ],
  });

  it('columnById finds by exact id only', () => {
    expect(columnById(config, 'todo')!.name).toBe('To Do');
    expect(columnById(config, 'TODO')).toBeUndefined();
    expect(columnById(config, 'To Do')).toBeUndefined();
  });

  it('displayColumn falls back to the first column for unknown or empty statuses', () => {
    expect(displayColumn(config, 'done').id).toBe('done');
    for (const status of ['ghost', '', ' todo ']) expect(displayColumn(config, status).id).toBe('todo');
  });

  it('isDoneStatus is true only for a known done column', () => {
    expect(isDoneStatus(config, 'done')).toBe(true);
    for (const status of ['todo', 'ghost', '', 'DONE']) expect(isDoneStatus(config, status)).toBe(false);
  });

  it('resolveColumn accepts ids and display names, trimmed and case-insensitive', () => {
    expect(resolveColumn(config, 'in-review')!.id).toBe('in-review');
    expect(resolveColumn(config, '  IN REVIEW ')!.id).toBe('in-review');
    expect(resolveColumn(config, 'done')!.id).toBe('done');
    expect(resolveColumn(config, 'nope')).toBeUndefined();
    expect(resolveColumn(config, '')).toBeUndefined();
  });

  it('the default config is itself valid and stable under normalization', () => {
    expect(normalizeConfig(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG);
    expect(isValidPrefix(DEFAULT_CONFIG.prefix)).toBe(true);
    expect(DEFAULT_COLUMNS.filter((c) => c.done).map((c) => c.id)).toEqual(['done']);
  });
});
