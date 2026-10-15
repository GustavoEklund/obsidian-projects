import type { Comment } from './types';

/**
 * A note's body is the card's description followed (optionally) by a comments section:
 *
 *     Description text…
 *
 *     ## Comments
 *
 *     > [!comment|k3f9a,2026-10-14T17:02:00.000Z] Ana · 2026-10-14 14:02
 *     > First line of the comment
 *     > - markdown works
 *
 * Each comment is an Obsidian callout, so it renders as a box in the note itself. The part after
 * `|` carries the machine data (id, ISO timestamp); the title is what people read. Everything is
 * parsed leniently, because notes get edited by hand: a hand-written callout without metadata still
 * counts (its id is derived from its text), and anything else inside the section is left untouched.
 */

export const COMMENTS_HEADING = '## Comments';

const HEADING_RE = /^##[ \t]+comments\s*$/i;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const CALLOUT_RE = /^>[ \t]*\[!comment(?:\|([^\]]*))?\][ \t]*(.*)$/i;
const TITLE_SEPARATOR = ' · ';

const stripCr = (line: string): string => line.replace(/\r$/, '');

/** Index of the comments heading (ignoring code fences), or -1. */
function headingIndex(lines: string[]): number {
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = FENCE_RE.exec(line);
    if (f) {
      const mark = f[1]![0]!;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence === null && HEADING_RE.test(line)) return i;
  }
  return -1;
}

export interface SplitBody {
  /** Everything before the comments heading. */
  description: string;
  /** From the heading line to the end of the note, or null when there is no comments section. */
  section: string | null;
}

export function splitBody(body: string): SplitBody {
  const lines = body.split('\n');
  const i = headingIndex(lines);
  if (i < 0) return { description: body, section: null };
  return { description: lines.slice(0, i).join('\n'), section: lines.slice(i).join('\n') };
}

/** Inverse of `splitBody`: exactly one blank line between description and the comments section. */
export function joinBody(description: string, section: string | null): string {
  if (!section) return description;
  const head = description.replace(/\s+$/, '');
  return head ? `${head}\n\n${section}` : `\n${section}`;
}

function fnv(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

interface Block {
  /** First line (the `> [!comment…]` line) and one past the last line, as indexes into the body's lines. */
  start: number;
  end: number;
  comment: Comment;
}

function findBlocks(lines: string[], from: number): Block[] {
  const blocks: Block[] = [];
  let i = from;
  while (i < lines.length) {
    const head = CALLOUT_RE.exec(stripCr(lines[i]!));
    if (!head) {
      i++;
      continue;
    }
    let end = i + 1;
    // A callout continues while lines keep starting with ">"; a new `[!comment]` line starts the next one.
    while (end < lines.length && lines[end]!.startsWith('>') && !CALLOUT_RE.test(stripCr(lines[end]!))) end++;

    const text = lines
      .slice(i + 1, end)
      .map((l) => unescapeMarker(stripCr(l).replace(/^>[ ]?/, '')))
      .join('\n')
      .replace(/\s+$/, '');
    const [idPart = '', atPart = ''] = (head[1] ?? '').split(',').map((s) => s.trim());
    const title = (head[2] ?? '').trim();
    const author = title.split(TITLE_SEPARATOR)[0]!.trim();
    blocks.push({
      start: i,
      end,
      comment: {
        id: idPart || `h${fnv(lines.slice(i, end).join('\n'))}`,
        author: author || 'Unknown',
        at: Number.isFinite(Date.parse(atPart)) ? new Date(atPart).toISOString() : '',
        text,
      },
    });
    i = end;
  }
  return blocks;
}

/** Comments in the note's body, oldest first (document order). */
export function parseComments(body: string): Comment[] {
  const lines = body.split('\n');
  const h = headingIndex(lines);
  return h < 0 ? [] : findBlocks(lines, h + 1).map((b) => b.comment);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD HH:mm` in local time (what appears in the callout title). */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function cleanAuthor(author: string): string {
  return author
    .replace(/[\r\n]+/g, ' ')
    .replace(/[[\]]/g, '')
    .replace(/\s*·\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A text line that itself starts with `[!comment…]` would be taken for the header of another comment (and invent
// one). It is written with one extra backslash before the `[`, which Markdown renders identically, and read back
// without it. Counting the backslashes keeps the round trip exact for text that already had some.
const MARKER_LINE_RE = /^([ \t]*)(\\*)(\[!comment)/i;
const ESCAPED_MARKER_LINE_RE = /^([ \t]*)\\(\\*)(\[!comment)/i;
const escapeMarker = (line: string): string => line.replace(MARKER_LINE_RE, '$1$2\\$3');
const unescapeMarker = (line: string): string => line.replace(ESCAPED_MARKER_LINE_RE, '$1$2$3');

/** Text lines of a comment as callout continuation lines (`> text`, empty line -> `>`). */
function quote(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\s+$/, '')
    .split('\n')
    .map((l) => (l.trim() ? `> ${escapeMarker(l)}` : '>'));
}

/** The callout block for one comment (no trailing newline). */
export function formatComment(c: Comment): string {
  const when = stamp(c.at);
  const title = `${cleanAuthor(c.author) || 'Unknown'}${when ? `${TITLE_SEPARATOR}${when}` : ''}`;
  return [`> [!comment|${c.id},${c.at}] ${title}`, ...quote(c.text)].join('\n');
}

/** The whole section (heading + blocks) for a list of comments, with a trailing newline. */
export function formatSection(comments: Comment[]): string {
  return `${COMMENTS_HEADING}\n\n${comments.map(formatComment).join('\n\n')}\n`;
}

/** Append a comment, creating the section if needed. Anything already in the section is kept. */
export function addCommentToBody(body: string, comment: Comment): string {
  const { description, section } = splitBody(body);
  const block = formatComment(comment);
  if (!section) return joinBody(description, `${COMMENTS_HEADING}\n\n${block}\n`);
  return joinBody(description, `${section.replace(/\s+$/, '')}\n\n${block}\n`);
}

/** Replace a comment's text, keeping its header (author, id, time). Returns null when `id` is unknown. */
export function editCommentInBody(body: string, id: string, text: string): string | null {
  const lines = body.split('\n');
  const h = headingIndex(lines);
  const block = h < 0 ? undefined : findBlocks(lines, h + 1).find((b) => b.comment.id === id);
  if (!block) return null;
  lines.splice(block.start, block.end - block.start, lines[block.start]!, ...quote(text));
  return lines.join('\n');
}

/** Remove a comment. Drops the whole section when nothing but the heading would remain. Null if `id` is unknown. */
export function removeCommentFromBody(body: string, id: string): string | null {
  const lines = body.split('\n');
  const h = headingIndex(lines);
  const block = h < 0 ? undefined : findBlocks(lines, h + 1).find((b) => b.comment.id === id);
  if (!block) return null;
  let start = block.start;
  // Also take the blank line that separated it from the previous block.
  if (start > 0 && lines[start - 1]!.trim() === '' && (block.end >= lines.length || lines[block.end]!.trim() === ''))
    start--;
  lines.splice(start, block.end - start);
  if (lines.slice(h + 1).every((l) => l.trim() === '')) {
    const description = lines.slice(0, h).join('\n');
    return description.trim() ? `${description.replace(/\s+$/, '')}\n` : '';
  }
  return lines.join('\n');
}

/**
 * A task line as Obsidian renders it: list marker (also inside a quote/callout), `[`, one status
 * character, `]`, then a space or the end of the line.
 */
const TASK_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)(.)(\](?:\s|$))/;

/**
 * Flip the `index`-th task (`- [ ]` <-> `- [x]`) of some Markdown, counting the same checkboxes a
 * renderer draws (document order, none inside code fences). Returns null if there is no such task.
 * Used so clicking a rendered checkbox can write the change back to the text.
 */
export function toggleTask(markdown: string, index: number): string | null {
  const lines = markdown.split('\n');
  let fence: string | null = null;
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE_RE.exec(lines[i]!);
    if (f) {
      const mark = f[1]![0]!;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence !== null || !TASK_RE.test(lines[i]!)) continue;
    if (++seen !== index) continue;
    lines[i] = lines[i]!.replace(
      TASK_RE,
      (_m, head: string, status: string, tail: string) => `${head}${status === ' ' ? 'x' : ' '}${tail}`,
    );
    return lines.join('\n');
  }
  return null;
}
