import { describe, expect, it } from 'vitest';
import { parseFrontmatter, patchFrontmatter, splitFrontmatter } from '../src/frontmatter';

describe('splitFrontmatter', () => {
  it('splits yaml and body', () => {
    expect(splitFrontmatter('---\na: 1\n---\nhello\n')).toEqual({ yaml: 'a: 1', body: 'hello\n' });
  });
  it('treats notes without a fence as body only', () => {
    expect(splitFrontmatter('# Title\ntext')).toEqual({ yaml: null, body: '# Title\ntext' });
  });
  it('handles CRLF and a BOM', () => {
    expect(splitFrontmatter('﻿---\r\na: 1\r\n---\r\nbody')).toEqual({ yaml: 'a: 1', body: 'body' });
  });
  it('handles an empty frontmatter block', () => {
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ yaml: '', body: 'body' });
  });
  it('does not mistake a horizontal rule later in the body for a fence', () => {
    const s = splitFrontmatter('intro\n\n---\n\nmore');
    expect(s.yaml).toBeNull();
  });
});

describe('parseFrontmatter', () => {
  it('returns {} for broken yaml instead of throwing', () => {
    expect(parseFrontmatter('---\na: [unclosed\n---\nx')).toEqual({});
  });
  it('keeps unquoted dates as strings', () => {
    expect(parseFrontmatter('---\ndue: 2026-10-20\n---\n')).toEqual({ due: '2026-10-20' });
  });
});

describe('patchFrontmatter', () => {
  it('updates, adds and removes keys; leaves the body alone', () => {
    const out = patchFrontmatter('---\ntitle: Old\nstatus: todo\n---\nBody text\n', {
      title: 'New',
      priority: 'high',
      status: null,
    });
    expect(parseFrontmatter(out)).toEqual({ title: 'New', priority: 'high' });
    expect(splitFrontmatter(out).body).toBe('Body text\n');
  });

  it('preserves keys and comments the user added by hand', () => {
    const src = '---\n# my note\ntitle: A\ncustom: keep me\nrelated: ["[[Other]]"]\n---\nx';
    const out = patchFrontmatter(src, { title: 'B' });
    expect(out).toContain('# my note');
    expect(out).toContain('custom: keep me');
    expect(parseFrontmatter(out).related).toEqual(['[[Other]]']);
  });

  it('writes arrays in flow style', () => {
    expect(patchFrontmatter('', { labels: ['a', 'b'] })).toContain('labels: [ a, b ]');
  });

  it('creates frontmatter for a note that has none', () => {
    const out = patchFrontmatter('just body', { key: 'OP-1' });
    expect(out.startsWith('---\nkey: OP-1\n---\n')).toBe(true);
    expect(out.endsWith('just body')).toBe(true);
  });

  it('replaces the body when asked', () => {
    const out = patchFrontmatter('---\na: 1\n---\nold', { a: 2 }, 'new body');
    expect(splitFrontmatter(out).body).toBe('new body');
  });

  it('refuses to rewrite broken frontmatter rather than destroying it', () => {
    expect(() => patchFrontmatter('---\na: [oops\n---\nx', { a: 1 })).toThrow(/Invalid frontmatter/);
  });
});

describe('patchFrontmatter with non-map frontmatter', () => {
  it('refuses to overwrite frontmatter that is not key/value pairs', () => {
    expect(() => patchFrontmatter('---\njust a string\n---\nx', { a: 1 })).toThrow(/Invalid frontmatter/);
  });
});

describe('patchFrontmatter replacing a multi-line value', () => {
  const multiline = '---\ntitle: |-\n  first\n  second\nother: kept\n---\nbody\n';

  it('can replace it with text made only of spaces (a block scalar would read it back as empty)', () => {
    // Found by a property test with the counterexample { a: 'multi\nline' } patched with ' '.
    const out = patchFrontmatter(multiline, { title: ' ' });
    expect(parseFrontmatter(out)).toEqual({ title: ' ', other: 'kept' });
  });

  it('still replaces it with ordinary text, and keeps the other keys and the body', () => {
    const out = patchFrontmatter(multiline, { title: 'one line now' });
    expect(parseFrontmatter(out)).toEqual({ title: 'one line now', other: 'kept' });
    expect(splitFrontmatter(out).body).toBe('body\n');
  });

  it('keeps a comment on the value line when the style is dropped', () => {
    const out = patchFrontmatter('---\ntitle: |- # why\n  first\n  second\n---\n', { title: 'x' });
    expect(out).toContain('# why');
    expect(parseFrontmatter(out)).toEqual({ title: 'x' });
  });
});
