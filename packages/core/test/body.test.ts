import { describe, expect, it } from 'vitest';
import {
  addCommentToBody,
  editCommentInBody,
  formatComment,
  joinBody,
  parseComments,
  removeCommentFromBody,
  splitBody,
  toggleTask,
} from '../src/body';
import type { Comment } from '../src/types';

const c = (id: string, text: string, author = 'Ana', at = '2026-10-14T17:02:00.000Z'): Comment => ({
  id,
  author,
  at,
  text,
});

describe('splitBody / joinBody', () => {
  it('separates the description from the comments section', () => {
    const body = '\nDescription\n\n## Comments\n\n> [!comment|a1,2026-10-14T17:02:00.000Z] Ana · x\n> hi\n';
    const { description, section } = splitBody(body);
    expect(description).toBe('\nDescription\n');
    expect(section).toMatch(/^## Comments\n/);
  });

  it('returns the whole body as description when there is no section', () => {
    expect(splitBody('just text\n')).toEqual({ description: 'just text\n', section: null });
    expect(joinBody('just text\n', null)).toBe('just text\n');
  });

  it('ignores a "## Comments" line that sits inside a code fence', () => {
    const body = 'Example:\n\n```md\n## Comments\n```\n\nthe end\n';
    expect(splitBody(body).section).toBeNull();
    expect(parseComments(body)).toEqual([]);
  });

  it('does not treat other ## headings as the section', () => {
    expect(splitBody('## Comments are great\n').section).toBeNull();
    expect(splitBody('### Comments\n').section).toBeNull();
  });

  it('joins with exactly one blank line', () => {
    expect(joinBody('\nText\n\n\n', '## Comments\n\n> x\n')).toBe('\nText\n\n## Comments\n\n> x\n');
    expect(joinBody('', '## Comments\n')).toBe('\n## Comments\n');
  });
});

describe('parseComments', () => {
  it('parses id, author, time and multi-line markdown text', () => {
    const body = [
      'Desc',
      '',
      '## Comments',
      '',
      '> [!comment|k3f9a,2026-10-14T17:02:00.000Z] Ana Souza · 2026-10-14 14:02',
      '> line 1',
      '>',
      '> - item',
      '> - item 2',
      '',
    ].join('\n');
    expect(parseComments(body)).toEqual([
      { id: 'k3f9a', author: 'Ana Souza', at: '2026-10-14T17:02:00.000Z', text: 'line 1\n\n- item\n- item 2' },
    ]);
  });

  it('keeps document order and separates adjacent blocks', () => {
    const body =
      '## Comments\n\n> [!comment|a,2026-01-01T00:00:00.000Z] A\n> one\n> [!comment|b,2026-01-02T00:00:00.000Z] B\n> two\n\n> [!comment|c] C\n> three\n';
    expect(parseComments(body).map((x) => [x.id, x.text])).toEqual([
      ['a', 'one'],
      ['b', 'two'],
      ['c', 'three'],
    ]);
  });

  it('accepts a hand-written callout without metadata, with a stable derived id', () => {
    const body = '## Comments\n\n> [!comment] Bruno\n> handwritten\n';
    const [first] = parseComments(body);
    expect(first).toMatchObject({ author: 'Bruno', text: 'handwritten', at: '' });
    expect(first!.id).toMatch(/^h[0-9a-z]+$/);
    expect(parseComments(body)[0]!.id).toBe(first!.id);
  });

  it('ignores other callouts and loose text inside the section', () => {
    const body =
      '## Comments\n\nmy loose notes\n\n> [!note] Something else\n> not a comment\n\n> [!comment|z] Ana\n> yes\n';
    expect(parseComments(body).map((x) => x.id)).toEqual(['z']);
  });

  it('handles CRLF notes', () => {
    const body = 'Desc\r\n\r\n## Comments\r\n\r\n> [!comment|a,2026-01-01T00:00:00.000Z] Ana\r\n> hi\r\n';
    expect(parseComments(body)).toMatchObject([{ id: 'a', author: 'Ana', text: 'hi' }]);
  });

  it('keeps nested quotes inside a comment as quotes', () => {
    const text = 'see:\n\n> quote\n> [!comment|fake] not another comment';
    const body = addCommentToBody('', c('real', text));
    const parsed = parseComments(body);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.text).toBe(text);
  });
});

describe('formatComment', () => {
  it('writes a callout that parses back to the same comment', () => {
    const original = c('k3f9a', 'Text\n\n- a\n- b\n\n```js\nconst x = 1;\n```');
    expect(parseComments(`## Comments\n\n${formatComment(original)}\n`)).toEqual([original]);
  });

  it('cleans authors that would break the title or the metadata', () => {
    const out = formatComment(c('a', 'x', 'Ana · [admin]\nSouza'));
    expect(out.split('\n')[0]).toMatch(/^> \[!comment\|a,2026-10-14T17:02:00\.000Z\] Ana admin Souza/);
    expect(parseComments(`## Comments\n\n${out}\n`)[0]!.author).toBe('Ana admin Souza');
  });
});

describe('addCommentToBody', () => {
  it('creates the section after the description', () => {
    const out = addCommentToBody('\nDescription\n', c('a', 'first'));
    expect(out.startsWith('\nDescription\n\n## Comments\n\n> [!comment|a,')).toBe(true);
    expect(splitBody(out).description).toBe('\nDescription\n');
  });

  it('works on an empty body and appends to an existing section in order', () => {
    let body = addCommentToBody('', c('a', 'one'));
    body = addCommentToBody(body, c('b', 'two'));
    body = addCommentToBody(body, c('c', 'three'));
    expect(parseComments(body).map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(body.match(/## Comments/g)).toHaveLength(1);
  });

  it('keeps unrelated content of the section', () => {
    const body = '## Comments\n\nmy loose notes\n';
    const out = addCommentToBody(body, c('a', 'new'));
    expect(out).toContain('my loose notes');
    expect(parseComments(out).map((x) => x.id)).toEqual(['a']);
  });
});

describe('editCommentInBody / removeCommentFromBody', () => {
  const base = () =>
    [c('a', 'one'), c('b', 'two'), c('c', 'three')].reduce((acc, x) => addCommentToBody(acc, x), '\nDesc\n');

  it('edits only the targeted comment and keeps its header', () => {
    const body = base();
    const out = editCommentInBody(body, 'b', 'two (edited)\non two lines')!;
    expect(parseComments(out).map((x) => x.text)).toEqual(['one', 'two (edited)\non two lines', 'three']);
    const before = parseComments(body)[1]!;
    const after = parseComments(out)[1]!;
    expect([after.id, after.author, after.at]).toEqual([before.id, before.author, before.at]);
    expect(splitBody(out).description).toBe(splitBody(body).description);
  });

  it('removes the targeted comment without disturbing the others', () => {
    const out = removeCommentFromBody(base(), 'b')!;
    expect(parseComments(out).map((x) => x.id)).toEqual(['a', 'c']);
    expect(out).not.toMatch(/\n\n\n/);
  });

  it('drops the whole section when the last comment is removed', () => {
    let body = addCommentToBody('\nDesc\n', c('a', 'only one'));
    body = removeCommentFromBody(body, 'a')!;
    expect(body).toBe('\nDesc\n');
    expect(splitBody(body).section).toBeNull();
  });

  it('returns null for an unknown id (never guesses)', () => {
    expect(editCommentInBody(base(), 'zzz', 'x')).toBeNull();
    expect(removeCommentFromBody(base(), 'zzz')).toBeNull();
    expect(removeCommentFromBody('no comments', 'a')).toBeNull();
  });

  it('can edit and remove a hand-written comment through its derived id', () => {
    const body = '## Comments\n\n> [!comment] Bruno\n> by hand\n';
    const id = parseComments(body)[0]!.id;
    expect(parseComments(editCommentInBody(body, id, 'editado')!)[0]!.text).toBe('editado');
    expect(removeCommentFromBody(body, id)).toBe('');
  });
});

describe('toggleTask', () => {
  const doc = [
    'Intro',
    '',
    '- [x] one',
    '  - [ ] two (nested)',
    '1. [ ] three (numbered)',
    '',
    '```',
    '- [ ] this is code',
    '```',
    '',
    '> - [ ] inside a quote',
    '- [-] custom status',
    '- [ ]',
    'stray [ ] text',
  ].join('\n');

  it('flips the n-th task, counting nested, numbered, quoted and custom ones', () => {
    expect(toggleTask(doc, 0)!.split('\n')[2]).toBe('- [ ] one');
    expect(toggleTask(doc, 1)!.split('\n')[3]).toBe('  - [x] two (nested)');
    expect(toggleTask(doc, 2)!.split('\n')[4]).toBe('1. [x] three (numbered)');
    expect(toggleTask(doc, 3)!.split('\n')[10]).toBe('> - [x] inside a quote'); // index 3 skips the code fence
    expect(toggleTask(doc, 4)!.split('\n')[11]).toBe('- [ ] custom status'); // any non-space status -> unchecked
    expect(toggleTask(doc, 5)!.split('\n')[12]).toBe('- [x]'); // empty task at end of line
  });

  it('never touches code fences or stray brackets, and changes exactly one line', () => {
    const out = toggleTask(doc, 1)!;
    expect(out.split('\n').filter((l, i) => l !== doc.split('\n')[i])).toHaveLength(1);
    expect(out).toContain('- [ ] this is code');
    expect(out).toContain('stray [ ] text');
  });

  it('returns null when there is no such task (never guesses)', () => {
    expect(toggleTask(doc, 6)).toBeNull();
    expect(toggleTask('no tasks', 0)).toBeNull();
    expect(toggleTask(doc, -1)).toBeNull();
  });

  it('toggling twice restores the original', () => {
    expect(toggleTask(toggleTask(doc, 2)!, 2)).toBe(doc);
  });
});
