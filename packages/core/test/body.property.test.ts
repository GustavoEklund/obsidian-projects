import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
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
} from '../src/body';
import type { Comment } from '../src/types';

// Property tests run many cases; a loaded machine (CI, parallel test runs) must not trip the default 5 s limit.
vi.setConfig({ testTimeout: 30_000 });

// --- generators --------------------------------------------------------------------------------------

/** One line of text, never containing a line break. Lookalikes of the syntax we parse are over-represented. */
const lineArb = fc.oneof(
  fc.string({ maxLength: 24 }).map((s) => s.replace(/[\r\n]/g, ' ')),
  fc.string({ unit: 'grapheme', maxLength: 12 }).map((s) => s.replace(/[\r\n]/g, ' ')),
  fc.constantFrom(
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
  ),
);

/** A multi-line comment text using LF or CRLF. */
const textArb = fc
  .tuple(fc.array(lineArb, { minLength: 1, maxLength: 6 }), fc.constantFrom('\n', '\r\n'))
  .map(([lines, eol]) => lines.join(eol));

/** What `formatComment` + `parseComments` guarantee for a text: CRLF folded, blank lines emptied, tail trimmed. */
const normalizeText = (text: string): string =>
  text
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => (l.trim() ? l : ''))
    .join('\n');

const authorArb = fc.oneof(
  fc.string({ maxLength: 16 }),
  fc.constantFrom('Ana', 'Ana · [admin]\nSouza', '  Bruno  ', '', '···', '[]'),
);

const idArb = fc.stringMatching(/^[a-z0-9]{3,6}$/);
const isoArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2035-01-01'), noInvalidDate: true })
  .map((d) => d.toISOString());

/** Description text without a comments heading and without an unclosed code fence (see the notes in the tests). */
const descriptionArb = fc
  .array(
    fc.oneof(
      fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, ' ')),
      fc.constantFrom('', 'Some text', '- [ ] a', '## Other heading', '> quote', '    code'),
    ),
    { maxLength: 6 },
  )
  .map((lines) => lines.join('\n'))
  .filter((d) => !/^##[ \t]+(?:comments)\s*$/im.test(d) && !/^\s*(```|~~~)/m.test(d));

const commentArb = fc.record({ id: idArb, author: authorArb, at: isoArb, text: textArb });

/** Comments with unique ids. */
const commentsArb = fc.uniqueArray(commentArb, { selector: (c) => c.id, minLength: 1, maxLength: 5 });

const expectedComment = (c: Comment): Comment => ({
  id: c.id,
  author: cleanAuthor(c.author) || 'Unknown',
  at: c.at,
  text: normalizeText(c.text),
});

function build(description: string, comments: Comment[]): string {
  return comments.reduce((body, c) => addCommentToBody(body, c), description);
}

// --- cleanAuthor -------------------------------------------------------------------------------------

describe('cleanAuthor', () => {
  it('never leaves line breaks, brackets or the title separator, and is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 30 }), (name) => {
        const clean = cleanAuthor(name);
        expect(clean).not.toMatch(/[\r\n[\]·]/);
        expect(clean).toBe(clean.trim());
        expect(clean).not.toMatch(/\s{2,}/);
        expect(cleanAuthor(clean)).toBe(clean);
      }),
      { numRuns: 300 },
    );
  });
});

// --- adding / parsing --------------------------------------------------------------------------------

describe('addCommentToBody + parseComments', () => {
  it('round-trips every comment: id, author, time and the normalized text', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, (description, comments) => {
        const body = build(description, comments);
        expect(parseComments(body)).toEqual(comments.map(expectedComment));
      }),
      { numRuns: 300 },
    );
  });

  it('keeps the description exactly as it was (modulo trailing blank lines) and in front of the section', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, (description, comments) => {
        const body = build(description, comments);
        const split = splitBody(body);
        expect(split.description.trimEnd()).toBe(description.trimEnd());
        expect(split.section).not.toBeNull();
        expect(split.section!.startsWith('## Comments')).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('a section written by formatSection parses back to the same comments', () => {
    fc.assert(
      fc.property(commentsArb, (comments) => {
        expect(parseComments(formatSection(comments))).toEqual(comments.map(expectedComment));
      }),
      { numRuns: 200 },
    );
  });

  it('formatComment is a single callout whose first line carries the id and the ISO time', () => {
    fc.assert(
      fc.property(commentArb, (c) => {
        const block = formatComment(c);
        const [head, ...rest] = block.split('\n');
        expect(head!.startsWith(`> [!comment|${c.id},${c.at}] `)).toBe(true);
        expect(rest.every((l) => l === '>' || l.startsWith('> '))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('cannot be fooled by text that looks like the comment syntax (quotes, headings, fences)', () => {
    const tricky = ['> [!comment|x] not another', '## Comments', '```', '> > [!comment|y] nested', '---'];
    const c: Comment = { id: 'real1', author: 'Ana', at: '2026-01-01T00:00:00.000Z', text: tricky.join('\n') };
    const body = addCommentToBody('Description', c);
    expect(parseComments(body)).toEqual([c]);
  });

  it('keeps a line that starts with the callout marker as text of the same comment', () => {
    // Without escaping, the marker on its own line would split the comment in two and invent a fake author.
    const c: Comment = {
      id: 'real1',
      author: 'Ana',
      at: '2026-01-01T00:00:00.000Z',
      text: 'before\n[!comment|fake] boom\nafter',
    };
    const body = addCommentToBody('Description', c);
    expect(parseComments(body)).toEqual([c]);
  });

  it('escapes a marker line with one extra backslash, and reads it back without it (exact round trip)', () => {
    const lines = [
      '[!comment|a] x',
      '  [!comment] x',
      '\\[!comment] x',
      '\\\\[!comment] x',
      '[!COMMENT] x',
      'not [!comment] at the start',
    ];
    const c: Comment = { id: 'esc01', author: 'Ana', at: '2026-01-01T00:00:00.000Z', text: lines.join('\n') };
    const note = formatComment(c);
    // On disk: each marker line gained exactly one backslash; the other line is untouched.
    expect(note.split('\n').slice(1)).toEqual([
      '> \\[!comment|a] x',
      '>   \\[!comment] x',
      '> \\\\[!comment] x',
      '> \\\\\\[!comment] x',
      '> \\[!COMMENT] x',
      '> not [!comment] at the start',
    ]);
    expect(parseComments(`## Comments\n\n${note}\n`)).toEqual([c]);
  });

  it('never throws, whatever the note contains', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 200 }), (junk) => {
        expect(() => parseComments(junk)).not.toThrow();
        expect(() => splitBody(junk)).not.toThrow();
        const body = `${junk}\n## Comments\n\n${junk}`;
        expect(() => parseComments(body)).not.toThrow();
        expect(Array.isArray(parseComments(body))).toBe(true);
      }),
      { numRuns: 120 },
    );
  });

  it('derives the same id for a hand-written callout every time it is parsed', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }).map((s) => s.replace(/[\r\n]/g, ' ')),
        fc.string({ maxLength: 30 }).map((s) => s.replace(/[\r\n]/g, ' ')),
        (title, text) => {
          const body = `## Comments\n\n> [!comment] ${title}\n> ${text}\n`;
          const first = parseComments(body);
          expect(first).toHaveLength(1);
          expect(parseComments(body)[0]!.id).toBe(first[0]!.id);
          expect(first[0]!.id).toMatch(/^h[0-9a-z]+$/);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// --- editing and removing ----------------------------------------------------------------------------

describe('editCommentInBody', () => {
  it('rewrites only the target: others, the target header and the description stay as they were', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, textArb, fc.nat(), (description, comments, replacement, pick) => {
        const target = comments[pick % comments.length]!;
        const body = build(description, comments);
        const out = editCommentInBody(body, target.id, replacement);
        expect(out).not.toBeNull();
        const expected = comments.map((c) =>
          c.id === target.id ? { ...expectedComment(c), text: normalizeText(replacement) } : expectedComment(c),
        );
        expect(parseComments(out!)).toEqual(expected);
        expect(splitBody(out!).description.trimEnd()).toBe(description.trimEnd());
      }),
      { numRuns: 300 },
    );
  });

  it('returns null for an unknown id and for a note without comments', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, (description, comments) => {
        expect(editCommentInBody(build(description, comments), 'nope-id', 'x')).toBeNull();
        expect(editCommentInBody(description, comments[0]!.id, 'x')).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  it('editing twice with the same text is a no-op the second time', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, textArb, (description, comments, text) => {
        const once = editCommentInBody(build(description, comments), comments[0]!.id, text)!;
        expect(editCommentInBody(once, comments[0]!.id, text)).toBe(once);
      }),
      { numRuns: 150 },
    );
  });
});

describe('removeCommentFromBody', () => {
  it('removes exactly the target and keeps the rest, in order', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, fc.nat(), (description, comments, pick) => {
        const target = comments[pick % comments.length]!;
        const out = removeCommentFromBody(build(description, comments), target.id);
        expect(out).not.toBeNull();
        expect(parseComments(out!)).toEqual(comments.filter((c) => c.id !== target.id).map(expectedComment));
        expect(splitBody(out!).description.trimEnd()).toBe(description.trimEnd());
      }),
      { numRuns: 300 },
    );
  });

  it('drops the whole section (heading included) when the last comment goes', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, (description, comments) => {
        let body = build(description, comments);
        for (const c of comments) body = removeCommentFromBody(body, c.id)!;
        expect(parseComments(body)).toEqual([]);
        expect(splitBody(body).section).toBeNull();
        expect(body.trimEnd()).toBe(description.trimEnd());
      }),
      { numRuns: 200 },
    );
  });

  it('returns null for an unknown id', () => {
    expect(removeCommentFromBody('no section', 'x')).toBeNull();
    expect(removeCommentFromBody(build('d', [{ id: 'a1', author: 'A', at: '', text: 'x' }]), 'zz')).toBeNull();
  });
});

// --- splitBody / joinBody ----------------------------------------------------------------------------

describe('splitBody / joinBody', () => {
  it('joinBody then splitBody gives back the section untouched and the description without trailing blanks', () => {
    fc.assert(
      fc.property(descriptionArb, commentsArb, (description, comments) => {
        const section = formatSection(comments);
        const joined = joinBody(description, section);
        const split = splitBody(joined);
        expect(split.section).toBe(section);
        expect(split.description.trimEnd()).toBe(description.trimEnd());
      }),
      { numRuns: 200 },
    );
  });

  it('joinBody without a section returns the description verbatim', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (d) => {
        expect(joinBody(d, null)).toBe(d);
        expect(joinBody(d, '')).toBe(d);
      }),
    );
  });

  it('a body without the heading is all description', () => {
    fc.assert(
      fc.property(descriptionArb, (d) => {
        expect(splitBody(d)).toEqual({ description: d, section: null });
      }),
      { numRuns: 100 },
    );
  });

  it('ignores a "## Comments" line inside a closed code fence, but not after it', () => {
    const body =
      'Intro\n\n```md\n## Comments\n```\n\n## Comments\n\n> [!comment|a1,2026-01-01T00:00:00.000Z] Ana\n> real\n';
    const split = splitBody(body);
    expect(split.description).toBe('Intro\n\n```md\n## Comments\n```\n');
    expect(parseComments(body)).toHaveLength(1);
  });

  it('matches the heading case-insensitively and tolerates trailing spaces', () => {
    for (const heading of ['## Comments', '## comments', '##   COMMENTS  ', '##\tComments']) {
      expect(splitBody(`text\n${heading}\n`).section).not.toBeNull();
    }
    for (const nope of ['# Comments', '### Comments', '## Comments are great', '##Comments', ' ## Comments']) {
      expect(splitBody(`text\n${nope}\n`).section).toBeNull();
    }
  });
});

// --- toggleTask --------------------------------------------------------------------------------------

const taskLine = fc.constantFrom(
  '- [ ] a',
  '- [x] b',
  '* [X] c',
  '+ [ ] d',
  '1. [ ] e',
  '2) [x] f',
  '  - [ ] nested',
  '> - [ ] quoted',
);
const otherLine = fc.constantFrom(
  '',
  'plain text',
  '- plain item',
  '- [link](x)',
  'text [ ] stray',
  '- [-] custom status',
  '## Heading',
  '- [ ]nospace',
);
const docArb = fc.array(fc.oneof(taskLine, otherLine), { maxLength: 12 });

/** All the task indexes toggleTask will accept: it returns null right after the last one. */
function taskCount(markdown: string): number {
  let n = 0;
  while (toggleTask(markdown, n) !== null) n++;
  return n;
}

describe('toggleTask', () => {
  it('changes exactly one line, only its status character, and toggling twice restores the original', () => {
    fc.assert(
      fc.property(docArb, fc.constantFrom('\n', '\r\n'), (lines, eol) => {
        const doc = lines.join(eol);
        const total = taskCount(doc);
        for (let i = 0; i < total; i++) {
          const once = toggleTask(doc, i)!;
          const before = doc.split('\n');
          const after = once.split('\n');
          expect(after).toHaveLength(before.length);
          const at = before.findIndex((l, n) => l !== after[n]);
          expect(before.filter((l, n) => l !== after[n])).toHaveLength(1);
          expect(before[at]!.replace(/\[.\]/, '[?]')).toBe(after[at]!.replace(/\[.\]/, '[?]'));
          // Toggling back restores the note, except that any "checked" status ([X], [-]...) comes back as [x].
          const restored = before
            .map((l, n) => (n === at ? l.replace(/\[(.)\]/, (_m, st: string) => (st === ' ' ? '[ ]' : '[x]')) : l))
            .join('\n');
          expect(toggleTask(once, i)).toBe(restored);
        }
        expect(toggleTask(doc, total)).toBeNull();
        expect(toggleTask(doc, -1)).toBeNull();
      }),
      { numRuns: 300 },
    );
  });

  it('flips unchecked to x and every other status (x, X) to a space', () => {
    expect(toggleTask('- [ ] a', 0)).toBe('- [x] a');
    expect(toggleTask('- [x] a', 0)).toBe('- [ ] a');
    expect(toggleTask('- [X] a', 0)).toBe('- [ ] a');
  });

  it('never touches tasks inside code fences, and counts the ones around them', () => {
    const doc = [
      '- [ ] before',
      '```',
      '- [ ] inside',
      '```',
      '- [ ] after',
      '~~~',
      '- [x] inside tilde',
      '~~~',
      '- [x] last',
    ].join('\n');
    expect(taskCount(doc)).toBe(3);
    expect(toggleTask(doc, 1)!.split('\n')[4]).toBe('- [x] after');
    expect(toggleTask(doc, 2)!.split('\n')[8]).toBe('- [ ] last');
    expect(toggleTask(doc, 0)!.split('\n')[2]).toBe('- [ ] inside');
  });

  it('is a pure function of its input', () => {
    fc.assert(
      fc.property(docArb, (lines) => {
        const doc = lines.join('\n');
        const copy = `${doc}`;
        toggleTask(doc, 0);
        expect(doc).toBe(copy);
        expect(toggleTask(doc, 0)).toBe(toggleTask(doc, 0));
      }),
      { numRuns: 100 },
    );
  });
});
