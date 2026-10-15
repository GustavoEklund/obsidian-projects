import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { parseFrontmatter, patchFrontmatter, splitFrontmatter } from '../src/frontmatter';

// Property tests run many cases; a loaded machine (CI, parallel test runs) must not trip the default 5 s limit.
vi.setConfig({ testTimeout: 30_000 });

/** Text with the characters YAML is picky about, whitespace-only values and exotic spaces included. */
const nastyString = fc.oneof(
  fc.string({ maxLength: 30 }),
  fc.string({ unit: 'grapheme', maxLength: 20 }),
  fc.stringMatching(/^[a-z:#'"\-?|>&*!%@`{}[\],~ \\]{0,24}$/),
  fc.constantFrom(
    '',
    ' ',
    '\u00a0',
    '-\u00a0',
    'a\u2028',
    '\u3000',
    'true',
    'null',
    '~',
    '123',
    '1e3',
    '0x1F',
    '2026-10-14',
    'yes',
    'no',
    '- x',
    '# not a comment',
    'a: b',
    '"q"',
    "it's",
    'multi\nline',
    '日本語',
    'Zoë',
    'Straße',
    '🙂',
  ),
);

/** A YAML key we are happy to generate (plain identifiers). */
const keyArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/);

describe('splitFrontmatter', () => {
  it('returns the whole content as body when there is no fence', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 60 }).filter((s) => !s.startsWith('---')),
        (text) => {
          expect(splitFrontmatter(text)).toEqual({ yaml: null, body: text });
        },
      ),
    );
  });

  it('splits yaml from body and ignores a BOM and CRLF fences', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('\n', '\r\n'),
        fc.boolean(),
        fc.string({ maxLength: 40 }).filter((s) => !s.includes('\r')),
        (eol, bom, body) => {
          const content = `${bom ? '\ufeff' : ''}---${eol}a: 1${eol}---${eol}${body}`;
          const split = splitFrontmatter(content);
          expect(split.yaml).toBe('a: 1');
          expect(split.body).toBe(body);
        },
      ),
    );
  });

  it('handles an empty frontmatter block', () => {
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ yaml: '', body: 'body' });
    expect(splitFrontmatter('---\r\n---\r\nbody')).toEqual({ yaml: '', body: 'body' });
    expect(splitFrontmatter('---\n---')).toEqual({ yaml: '', body: '' });
  });

  it('does not treat an unterminated fence or a later rule as frontmatter', () => {
    expect(splitFrontmatter('---\na: 1\nno closing fence').yaml).toBeNull();
    expect(splitFrontmatter('text\n---\na: 1\n---\n').yaml).toBeNull();
  });
});

describe('patchFrontmatter + parseFrontmatter', () => {
  it('round-trips arbitrary string values through a write/read cycle', () => {
    fc.assert(
      fc.property(fc.dictionary(keyArb, nastyString, { maxKeys: 6 }), (data) => {
        const content = patchFrontmatter('', data);
        expect(parseFrontmatter(content)).toEqual(data);
      }),
      { numRuns: 400 },
    );
  });

  it('round-trips numbers, booleans and string arrays (written in flow style)', () => {
    fc.assert(
      fc.property(
        fc.record({
          n: fc.integer({ min: -1_000_000, max: 1_000_000 }),
          f: fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }),
          b: fc.boolean(),
          list: fc.array(nastyString, { maxLength: 6 }),
        }),
        (data) => {
          const content = patchFrontmatter('', data);
          expect(parseFrontmatter(content)).toEqual(data);
          // A non-empty list is written in flow style (`list: [a, b]`, wrapped over lines when it must be).
          const flowStyle = data.list.length === 0 || /^list:\s*\[/m.test(content);
          expect(flowStyle).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('patching one key leaves every other key, the user comments and the body untouched', () => {
    fc.assert(
      fc.property(
        fc.dictionary(keyArb, nastyString, { minKeys: 2, maxKeys: 6 }),
        nastyString,
        fc.string({ maxLength: 80 }),
        (data, value, body) => {
          const target = Object.keys(data)[0]!;
          const base = `${patchFrontmatter('', data)}`.replace(/^---\n/, '---\n# my note\n');
          const withBody = patchFrontmatter(base, {}, body);
          const patched = patchFrontmatter(withBody, { [target]: value });
          expect(splitFrontmatter(patched).body).toBe(body);
          expect(patched).toContain('# my note');
          expect(parseFrontmatter(patched)).toEqual({ ...data, [target]: value });
        },
      ),
      { numRuns: 200 },
    );
  });

  it('removes a key with null or undefined and leaves the rest alone', () => {
    fc.assert(
      fc.property(
        fc.dictionary(keyArb, nastyString, { minKeys: 1, maxKeys: 5 }),
        fc.constantFrom(null, undefined),
        (data, gone) => {
          const target = Object.keys(data)[0]!;
          const out = parseFrontmatter(patchFrontmatter(patchFrontmatter('', data), { [target]: gone }));
          const expected = { ...data };
          delete expected[target];
          expect(out).toEqual(expected);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('is idempotent: applying the same patch twice gives the same note', () => {
    fc.assert(
      fc.property(fc.dictionary(keyArb, nastyString, { maxKeys: 5 }), fc.string({ maxLength: 40 }), (data, body) => {
        const once = patchFrontmatter('', data, body);
        expect(patchFrontmatter(once, data)).toBe(once);
      }),
      { numRuns: 150 },
    );
  });

  it('keeps CRLF-fenced notes parseable and a BOM does not leak into the output', () => {
    const crlf = '\ufeff---\r\ntitle: Hello\r\n---\r\nBody\r\n';
    expect(parseFrontmatter(crlf)).toEqual({ title: 'Hello' });
    const out = patchFrontmatter(crlf, { priority: 'high' });
    expect(out.charCodeAt(0)).not.toBe(0xfeff);
    expect(parseFrontmatter(out)).toEqual({ title: 'Hello', priority: 'high' });
    expect(splitFrontmatter(out).body).toBe('Body\r\n');
  });

  it('writes a block with a closing fence even when the yaml ends without a newline', () => {
    const out = patchFrontmatter('', { a: 1 });
    expect(out).toBe('---\na: 1\n---\n');
  });

  it('replaces the body only when asked, including with an empty string', () => {
    const base = '---\na: 1\n---\nold';
    expect(splitFrontmatter(patchFrontmatter(base, { a: 2 })).body).toBe('old');
    expect(splitFrontmatter(patchFrontmatter(base, { a: 2 }, '')).body).toBe('');
    expect(splitFrontmatter(patchFrontmatter(base, {}, 'new')).body).toBe('new');
  });

  it('refuses to rewrite broken or non-map frontmatter rather than destroying it', () => {
    expect(() => patchFrontmatter('---\na: [oops\n---\nx', { b: 1 })).toThrow(/Invalid frontmatter/);
    expect(() => patchFrontmatter('---\n- a\n- b\n---\nx', { b: 1 })).toThrow(/key: value/);
    expect(() => patchFrontmatter('---\n"just a string"\n---\nx', { b: 1 })).toThrow(/key: value/);
  });

  it('never throws from parseFrontmatter, whatever the note looks like', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (junk) => {
        const result = parseFrontmatter(`---\n${junk}\n---\nbody`);
        expect(result !== null && typeof result === 'object' && !Array.isArray(result)).toBe(true);
        const loose = parseFrontmatter(junk);
        expect(typeof loose).toBe('object');
      }),
      { numRuns: 300 },
    );
  });

  it('returns {} for scalar or list frontmatter and for an empty block', () => {
    expect(parseFrontmatter('---\njust text\n---\n')).toEqual({});
    expect(parseFrontmatter('---\n- a\n- b\n---\n')).toEqual({});
    expect(parseFrontmatter('---\n---\n')).toEqual({});
    expect(parseFrontmatter('')).toEqual({});
  });

  it('writes an empty block (not the string "null") when there is nothing to write', () => {
    expect(patchFrontmatter('', {})).toBe('---\n---\n');
    expect(patchFrontmatter('body only', { gone: null })).toBe('---\n---\nbody only');
    expect(patchFrontmatter('---\na: 1\n---\nx', { a: null })).toBe('---\n---\nx');
    // ...and the result can be patched again.
    expect(parseFrontmatter(patchFrontmatter(patchFrontmatter('', {}), { a: 1 }))).toEqual({ a: 1 });
  });

  it('keeps trailing and whitespace-only values intact, even when they are the last key', () => {
    // Regression: the writer used `trimEnd()`, which also ate a trailing no-break space (or U+2028, U+3000...)
    // of the last value: it either vanished or left invalid YAML such as `a: -`.
    for (const value of ['\u00a0', 'a\u00a0', '-\u00a0', '-\u2028', '\u3000', ' ', 'x ', '\n']) {
      const once = patchFrontmatter('', { k: value });
      expect(parseFrontmatter(once).k).toBe(value);
      expect(parseFrontmatter(patchFrontmatter(once, { other: 1 })).k).toBe(value);
    }
  });

  it('keeps unquoted dates as plain strings when written back', () => {
    const out = patchFrontmatter('---\ndue: 2026-10-20\n---\n', { priority: 'low' });
    expect(out).toContain('due: 2026-10-20');
    expect(parseFrontmatter(out).due).toBe('2026-10-20');
  });
});
