import { dueState, isDoneStatus, type BoardConfig, type Card } from '@oprojects/core';
import { getLocale, t } from '../i18n';
import { distinctHues, h, hueOf, initials } from './dom';
import { icon, priorityIcon, typeIcon } from './icons';

export interface CardCtx {
  config: BoardConfig;
  /** Every card by key (used to show the parent epic's title). */
  byKey: ReadonlyMap<string, Card>;
  now: Date;
}

const MAX_LABELS = 3;

// Colors are assigned per board (not per card) so two people or epics never look alike.
let personHues = new Map<string, number>();
let epicHues = new Map<string, number>();

/** Recompute avatar / epic colors for the people and epics currently on the board. */
export function setColorUniverse(people: Iterable<string>, epics: Iterable<string>): void {
  personHues = distinctHues([...people].map((p) => p.toLowerCase()));
  epicHues = distinctHues(epics);
}

export const personHue = (name: string): number => personHues.get(name.toLowerCase()) ?? hueOf(name.toLowerCase());
export const epicHue = (key: string): number => epicHues.get(key) ?? hueOf(key);

/** `2026-10-20` -> "20 Oct" (adds the year when it is not the current one). */
export function formatDue(date: string, now: Date): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const when = new Date(y, m - 1, d);
  return new Intl.DateTimeFormat(getLocale(), { day: 'numeric', month: 'short', ...(y !== now.getFullYear() ? { year: 'numeric' as const } : {}) }).format(when);
}

/**
 * Everything that affects how a card looks. If the signature is unchanged the
 * existing element is reused, so re-rendering a 500-card board after one edit
 * touches one element.
 */
export function cardSignature(card: Card, ctx: CardCtx): string {
  const parent = card.parent ? (ctx.byKey.get(card.parent)?.title ?? card.parent) : '';
  return [
    card.title,
    card.type,
    card.priority,
    card.assignee ? `${card.assignee}:${personHue(card.assignee)}` : '',
    card.labels.join('\u0001'),
    card.due ?? '',
    dueState(card, ctx.config, ctx.now) ?? '',
    card.estimate ?? '',
    card.checklist.done,
    card.checklist.total,
    card.comments.length,
    card.parent ? `${parent}:${epicHue(card.parent)}` : '',
    isDoneStatus(ctx.config, card.status) ? 1 : 0,
  ].join('\u0000');
}

export function createCardEl(key: string): HTMLDivElement {
  return h('div', { class: 'op-card', attrs: { draggable: 'true', tabindex: 0, role: 'button', 'data-key': key } });
}

export function typeBadge(type: Card['type'], size = 16): HTMLElement {
  return h('span', { class: `op-type op-type-${type}`, attrs: { title: t(`type.${type}`) }, style: { '--op-size': `${size}px` } }, icon(typeIcon(type), Math.round(size * 0.72)));
}

export function priorityMark(priority: Card['priority']): HTMLElement {
  return h('span', { class: `op-prio op-prio-${priority}`, attrs: { title: t(`priority.${priority}`) } }, icon(priorityIcon(priority), 14));
}

export function avatar(name: string, size = 22): HTMLElement {
  return h('span', { class: 'op-avatar', text: initials(name), attrs: { title: name }, style: { '--op-hue': personHue(name), '--op-size': `${size}px` } });
}

export function fillCardEl(el: HTMLElement, card: Card, ctx: CardCtx): void {
  const done = isDoneStatus(ctx.config, card.status);
  el.classList.toggle('op-done', done);
  el.setAttribute('aria-label', `${card.key}: ${card.title}`);

  const children: Node[] = [h('div', { class: 'op-card-title', text: card.title })];

  const epic = card.parent ? ctx.byKey.get(card.parent) : undefined;
  const metaRow: Node[] = [];
  if (card.parent) {
    metaRow.push(h('span', { class: 'op-epic', text: epic?.title ?? card.parent, attrs: { title: `${card.parent}${epic ? `: ${epic.title}` : ''}` }, style: { '--op-hue': epicHue(card.parent) } }));
  }
  for (const label of card.labels.slice(0, MAX_LABELS)) metaRow.push(h('span', { class: 'op-label', text: label }));
  if (card.labels.length > MAX_LABELS) metaRow.push(h('span', { class: 'op-label op-label-more', text: `+${card.labels.length - MAX_LABELS}`, attrs: { title: card.labels.slice(MAX_LABELS).join(', ') } }));
  if (metaRow.length) children.push(h('div', { class: 'op-card-meta' }, ...metaRow));

  const state = dueState(card, ctx.config, ctx.now);
  const right: Node[] = [];
  if (card.comments.length) {
    const label = card.comments.length === 1 ? t('comment.count.one') : t('comment.count.many', { n: card.comments.length });
    right.push(h('span', { class: 'op-chip op-chip-comments', attrs: { title: label } }, icon('message', 12), String(card.comments.length)));
  }
  if (card.checklist.total) {
    const complete = card.checklist.done === card.checklist.total;
    right.push(
      h(
        'span',
        { class: `op-chip op-chip-check${complete ? ' op-chip-ok' : ''}`, attrs: { title: t('checklist.title', { done: card.checklist.done, total: card.checklist.total }) } },
        icon('checklist', 12),
        `${card.checklist.done}/${card.checklist.total}`,
      ),
    );
  }
  if (card.due) {
    const label = state === 'overdue' ? t('due.overdue') : state === 'soon' ? t('due.soon') : '';
    right.push(h('span', { class: `op-chip op-due op-due-${state ?? 'later'}`, attrs: { title: label ? `${label}: ${card.due}` : card.due } }, icon('calendar', 12), formatDue(card.due, ctx.now)));
  }
  if (card.estimate !== undefined) right.push(h('span', { class: 'op-estimate', text: String(card.estimate), attrs: { title: `${t('field.estimate')}: ${card.estimate}` } }));
  right.push(priorityMark(card.priority));
  if (card.assignee) right.push(avatar(card.assignee));
  // Two groups: on a narrow card the right group wraps to its own line instead of overflowing.
  children.push(h('div', { class: 'op-card-foot' }, h('div', { class: 'op-foot-left' }, typeBadge(card.type), h('span', { class: 'op-key', text: card.key })), h('div', { class: 'op-foot-right' }, ...right)));

  el.replaceChildren(...children);
}
