import { isMap, parseDocument, type Document } from 'yaml';

export interface Split {
  /** Raw YAML between the `---` fences, or null when the note has none. */
  yaml: string | null;
  /** Everything after the closing fence (or the whole content). */
  body: string;
}

const FENCE_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const EMPTY_FENCE_RE = /^---[ \t]*\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(content: string): Split {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const m = FENCE_RE.exec(text);
  if (m) return { yaml: m[1] ?? '', body: text.slice(m[0].length) };
  const empty = EMPTY_FENCE_RE.exec(text);
  if (empty) return { yaml: '', body: text.slice(empty[0].length) };
  return { yaml: null, body: text };
}

/** Parsed frontmatter as a plain object; `{}` for no/invalid frontmatter. */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const { yaml } = splitFrontmatter(content);
  if (!yaml) return {};
  const doc = parseDocument(yaml);
  if (doc.errors.length) return {};
  const value = doc.toJS();
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type FrontmatterPatch = Record<string, unknown>;

function setValue(doc: Document, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    // Flow style (`labels: [a, b]`) keeps the Properties panel and diffs tidy.
    const node = doc.createNode(value);
    (node as { flow?: boolean }).flow = true;
    doc.set(key, node);
  } else {
    doc.set(key, value);
  }
}

/**
 * Apply `patch` to the note's frontmatter and return the new content.
 * `undefined`/`null` removes a key. Keys that are not in the patch (including
 * ones the user added by hand) and the body are left untouched.
 */
export function patchFrontmatter(content: string, patch: FrontmatterPatch, body?: string): string {
  const split = splitFrontmatter(content);
  const doc = parseDocument(split.yaml ?? '');
  if (doc.errors.length) throw new Error(`Invalid frontmatter: ${doc.errors[0]!.message}`);
  // Empty frontmatter (null contents) is fine: `doc.set` creates the map. Anything else that
  // is not a map would be destroyed by a rewrite, so refuse instead.
  if (doc.contents !== null && !isMap(doc.contents)) throw new Error('Invalid frontmatter: expected `key: value` pairs');

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) doc.delete(key);
    else setValue(doc, key, value);
  }

  const yaml = String(doc).trimEnd();
  const nextBody = body ?? split.body;
  return `---\n${yaml}\n---\n${nextBody}`;
}
