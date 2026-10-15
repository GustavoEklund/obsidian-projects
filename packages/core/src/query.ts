import { displayColumn, isDoneStatus, type BoardConfig, type Column } from './config';
import { rankBetween } from './rank';
import { PRIORITIES, type Card, type CardType, type Placement, type Priority } from './types';

/** Value for `CardFilter.assignee` that matches cards with nobody assigned. */
export const UNASSIGNED = '@none';

export interface CardFilter {
  /** Matches key, title, labels, assignee, description and comments (accent/case-insensitive, all words). */
  text?: string;
  status?: string[];
  type?: CardType[];
  priority?: Priority[];
  assignee?: string[];
  /** Matches cards having ANY of these labels. */
  labels?: string[];
  parent?: string;
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

// Normalizing every card's text on each keystroke is the hot path of search-as-you-type.
// Cards are replaced (never mutated) on change, so caching per object is safe.
const haystacks = new WeakMap<Card, string>();
function haystack(card: Card): string {
  let hay = haystacks.get(card);
  if (hay === undefined) {
    hay = normalizeText(
      [
        card.key,
        card.title,
        card.assignee ?? '',
        card.labels.join(' '),
        card.body,
        ...card.comments.map((c) => c.text),
      ].join('\n'),
    );
    haystacks.set(card, hay);
  }
  return hay;
}

export function matchesFilter(card: Card, f: CardFilter, config: BoardConfig): boolean {
  if (f.status?.length && !f.status.includes(displayColumn(config, card.status).id)) return false;
  if (f.type?.length && !f.type.includes(card.type)) return false;
  if (f.priority?.length && !f.priority.includes(card.priority)) return false;
  if (f.assignee?.length) {
    const who = card.assignee ? normalizeText(card.assignee) : UNASSIGNED;
    if (!f.assignee.some((a) => (a === UNASSIGNED ? who === UNASSIGNED : normalizeText(a) === who))) return false;
  }
  if (f.labels?.length && !f.labels.some((l) => card.labels.some((cl) => normalizeText(cl) === normalizeText(l))))
    return false;
  if (f.parent && card.parent !== f.parent.toUpperCase()) return false;
  if (f.text?.trim()) {
    const hay = haystack(card);
    if (
      !normalizeText(f.text)
        .split(/\s+/)
        .filter(Boolean)
        .every((w) => hay.includes(w))
    )
      return false;
  }
  return true;
}

export function filterCards(cards: Card[], f: CardFilter, config: BoardConfig): Card[] {
  return cards.filter((c) => matchesFilter(c, f, config));
}

/** Board order: column order, then rank, then creation time, then key (stable). */
export function compareCards(config: BoardConfig): (a: Card, b: Card) => number {
  const index = new Map(config.columns.map((c, i) => [c.id, i]));
  const col = (c: Card) => index.get(displayColumn(config, c.status).id) ?? 0;
  return (a, b) => col(a) - col(b) || cmp(a.rank, b.rank) || cmp(a.created, b.created) || cmp(a.key, b.key);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortCards(cards: Card[], config: BoardConfig): Card[] {
  return [...cards].sort(compareCards(config));
}

export interface ColumnGroup {
  column: Column;
  cards: Card[];
}

/** Cards grouped per column, each group already sorted by rank. */
export function groupByColumn(cards: Card[], config: BoardConfig): ColumnGroup[] {
  const groups = new Map(config.columns.map((c) => [c.id, { column: c, cards: [] as Card[] }]));
  for (const card of sortCards(cards, config)) groups.get(displayColumn(config, card.status).id)!.cards.push(card);
  return config.columns.map((c) => groups.get(c.id)!);
}

/** `YYYY-MM-DD` in local time. */
export function localDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export type DueState = 'overdue' | 'soon' | 'later';

/** Done cards are never overdue. "soon" = due today or within 2 days. */
export function dueState(card: Card, config: BoardConfig, now: Date): DueState | undefined {
  if (!card.due) return undefined;
  if (isDoneStatus(config, card.status)) return 'later';
  const today = localDate(now);
  if (card.due < today) return 'overdue';
  const limit = new Date(now);
  limit.setDate(limit.getDate() + 2);
  return card.due <= localDate(limit) ? 'soon' : 'later';
}

/** Done cards resolved more than `hideDoneAfterDays` ago are kept off the board. */
export function isArchivedDone(card: Card, config: BoardConfig, now: Date): boolean {
  const days = config.hideDoneAfterDays;
  if (!days || !isDoneStatus(config, card.status)) return false;
  const at = Date.parse(card.resolved ?? card.updated);
  return Number.isFinite(at) && now.getTime() - at > days * 86_400_000;
}

export function priorityWeight(p: Priority): number {
  return PRIORITIES.indexOf(p);
}

/**
 * Rank for putting `moving` into column `status` at `placement`.
 * `cards` is any snapshot of the board; `moving` itself is ignored so the same
 * call works for reordering inside a column.
 */
export function rankForPlacement(
  cards: Card[],
  config: BoardConfig,
  moving: string,
  status: string,
  placement: Placement = {},
): string {
  const columnId = displayColumn(config, status).id;
  const column = sortCards(
    cards.filter((c) => c.key !== moving && displayColumn(config, c.status).id === columnId),
    config,
  );
  let prev: Card | undefined;
  let next: Card | undefined;
  if (placement.before) {
    const i = column.findIndex((c) => c.key === placement.before);
    if (i < 0) throw new Error(`Card ${placement.before} is not in column "${columnId}"`);
    prev = column[i - 1];
    next = column[i];
  } else if (placement.after) {
    const i = column.findIndex((c) => c.key === placement.after);
    if (i < 0) throw new Error(`Card ${placement.after} is not in column "${columnId}"`);
    prev = column[i];
    next = column[i + 1];
  } else {
    prev = column[column.length - 1];
  }
  const lo = prev?.rank ?? null;
  const hi = next?.rank ?? null;
  // Neighbours with equal/inverted ranks (hand-edited notes, sync merges): there is no
  // rank "between" them, so settle for right after the upper neighbour.
  if (lo !== null && hi !== null && lo >= hi) return rankBetween(lo, null);
  return rankBetween(lo, hi);
}
