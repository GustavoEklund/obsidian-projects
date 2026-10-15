import { formatSection, joinBody, parseComments, splitBody } from './body';
import { parseFrontmatter, patchFrontmatter, splitFrontmatter } from './frontmatter';
import {
  CARD_TYPES,
  PRIORITIES,
  type Card,
  type CardPatch,
  type CardType,
  type Checklist,
  type Priority,
} from './types';

export const KEY_RE = /^([A-Z][A-Z0-9]{1,9})-(\d+)$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCardType(v: unknown): v is CardType {
  return typeof v === 'string' && (CARD_TYPES as readonly string[]).includes(v);
}

export function isPriority(v: unknown): v is Priority {
  return typeof v === 'string' && (PRIORITIES as readonly string[]).includes(v);
}

export function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** `PREFIX-12` -> 12 (null when `key` has another prefix or is malformed). */
export function keyNumber(key: string, prefix: string): number | null {
  const m = KEY_RE.exec(key);
  return m && m[1] === prefix ? Number(m[2]) : null;
}

/** Counts `- [ ]` / `- [x]` items outside fenced code blocks. */
export function countChecklist(body: string): Checklist {
  let done = 0;
  let total = 0;
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      const marker = f[1]!.slice(0, 3);
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const m = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s/.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== ' ') done++;
  }
  return { done, total };
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return undefined;
}

function asLabels(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [];
  return normalizeLabels(raw.map((x) => asString(x) ?? ''));
}

export function normalizeLabels(labels: string[]): string[] {
  const out: string[] = [];
  for (const l of labels) {
    // Every leading `#` goes (`##tag` -> `tag`): stripping just one would not be idempotent, and the card would
    // read back as `tag` after being saved as `#tag`.
    const clean = l.trim().replace(/^#+/, '').replace(/\s+/g, '-');
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function asDue(v: unknown): string | undefined {
  const s = v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : asString(v)?.slice(0, 10);
  return s && isValidDate(s) ? s : undefined;
}

/**
 * Parse a note into a card. Returns null when the note is not a card (no valid
 * `key`). Lenient on purpose: notes get edited by hand, so unknown or broken
 * values degrade to defaults instead of hiding the card.
 */
export function parseCard(path: string, content: string): Card | null {
  const fm = parseFrontmatter(content);
  const key = asString(fm.key)?.toUpperCase();
  if (!key || !KEY_RE.test(key)) return null;

  const { body: fullBody } = splitFrontmatter(content);
  const { description: body } = splitBody(fullBody);
  const estimate = typeof fm.estimate === 'number' && Number.isFinite(fm.estimate) ? fm.estimate : undefined;
  const created = asString(fm.created) ?? '';
  const parent = asString(fm.parent)?.toUpperCase();

  return {
    key,
    path,
    title: asString(fm.title) ?? key,
    status: asString(fm.status) ?? '',
    type: isCardType(fm.type) ? fm.type : 'task',
    priority: isPriority(fm.priority) ? fm.priority : 'medium',
    assignee: asString(fm.assignee),
    labels: asLabels(fm.labels),
    due: asDue(fm.due),
    estimate,
    parent: parent && KEY_RE.test(parent) ? parent : undefined,
    rank: asString(fm.rank) ?? '',
    created,
    updated: asString(fm.updated) ?? created,
    resolved: asString(fm.resolved),
    body,
    checklist: countChecklist(body),
    comments: parseComments(fullBody),
  };
}

/** Frontmatter field order used for newly created cards. */
export function newCardContent(card: Omit<Card, 'path' | 'checklist'>): string {
  const description = card.body.trim() ? `\n${card.body.trim()}\n` : '';
  const body = card.comments.length ? joinBody(description, formatSection(card.comments)) : description;
  return patchFrontmatter(
    '',
    {
      key: card.key,
      title: card.title,
      status: card.status,
      type: card.type,
      priority: card.priority,
      assignee: card.assignee,
      labels: card.labels.length ? card.labels : undefined,
      due: card.due,
      estimate: card.estimate,
      parent: card.parent,
      rank: card.rank,
      created: card.created,
      updated: card.updated,
      resolved: card.resolved,
    },
    body,
  );
}

/** Cheap structural equality, used to skip no-op re-renders after our own writes. */
export function sameCard(a: Card, b: Card): boolean {
  return (
    a.key === b.key &&
    a.path === b.path &&
    a.title === b.title &&
    a.status === b.status &&
    a.type === b.type &&
    a.priority === b.priority &&
    a.assignee === b.assignee &&
    a.due === b.due &&
    a.estimate === b.estimate &&
    a.parent === b.parent &&
    a.rank === b.rank &&
    a.updated === b.updated &&
    a.resolved === b.resolved &&
    a.body === b.body &&
    a.comments.length === b.comments.length &&
    a.comments.every(
      (c, i) =>
        c.id === b.comments[i]!.id &&
        c.text === b.comments[i]!.text &&
        c.author === b.comments[i]!.author &&
        c.at === b.comments[i]!.at,
    ) &&
    a.labels.length === b.labels.length &&
    a.labels.every((l, i) => l === b.labels[i])
  );
}

/**
 * What a card would look like after `patch`, computed locally. UIs use it for
 * optimistic updates; the saved result from `CardService.update` replaces it.
 * (No validation here: that is the service's job.)
 */
export function applyPatch(card: Card, patch: CardPatch): Card {
  const next: Card = { ...card };
  if (patch.title !== undefined) next.title = patch.title.replace(/\s+/g, ' ').trim() || card.title;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.type !== undefined) next.type = patch.type;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.rank !== undefined) next.rank = patch.rank;
  if (patch.assignee !== undefined) next.assignee = patch.assignee?.trim() || undefined;
  if (patch.labels !== undefined) next.labels = normalizeLabels(patch.labels);
  if (patch.due !== undefined) next.due = patch.due ?? undefined;
  if (patch.estimate !== undefined) next.estimate = patch.estimate ?? undefined;
  if (patch.parent !== undefined) next.parent = patch.parent ? patch.parent.toUpperCase() : undefined;
  if (patch.body !== undefined) {
    next.body = patch.body;
    next.checklist = countChecklist(patch.body);
  }
  return next;
}
