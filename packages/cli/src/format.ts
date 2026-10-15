import { dueState, groupByColumn, type BoardConfig, type Card, type CardType, type Priority } from '@oprojects/core';

const CODES = { reset: 0, bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90 } as const;
export type Style = keyof typeof CODES;

export interface Painter {
  (style: Style | Style[], text: string): string;
  enabled: boolean;
}

export function makePainter(enabled: boolean): Painter {
  const paint = ((style: Style | Style[], text: string) => {
    if (!enabled) return text;
    const codes = (Array.isArray(style) ? style : [style]).map((s) => CODES[s]).join(';');
    return `\x1b[${codes}m${text}\x1b[${CODES.reset}m`;
  }) as Painter;
  paint.enabled = enabled;
  return paint;
}

const PRIORITY_GLYPH: Record<Priority, { glyph: string; style: Style }> = {
  highest: { glyph: '↑↑', style: 'red' },
  high: { glyph: '↑ ', style: 'red' },
  medium: { glyph: '= ', style: 'yellow' },
  low: { glyph: '↓ ', style: 'blue' },
  lowest: { glyph: '↓↓', style: 'blue' },
};

const TYPE_GLYPH: Record<CardType, { glyph: string; style: Style }> = {
  bug: { glyph: 'B', style: 'red' },
  story: { glyph: 'S', style: 'green' },
  task: { glyph: 'T', style: 'blue' },
  epic: { glyph: 'E', style: 'magenta' },
};

/** Fixed visible width: 2. */
export const priorityGlyph = (p: Priority, paint: Painter) => paint(PRIORITY_GLYPH[p].style, PRIORITY_GLYPH[p].glyph);
/** Fixed visible width: 1. */
export const typeGlyph = (t: CardType, paint: Painter) => paint(TYPE_GLYPH[t].style, TYPE_GLYPH[t].glyph);

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  const chars = [...text];
  return chars.length <= width ? text : chars.slice(0, Math.max(0, width - 1)).join('') + '…';
}

export const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - [...text].length));

/** Word-wrap to `width`, at most `maxLines` lines (last line gets an ellipsis). */
export function wrap(text: string, width: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const w = [...word].length > width ? truncate(word, width) : word;
    if (!line) line = w;
    else if ([...line].length + 1 + [...w].length <= width) line += ` ${w}`;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = truncate(`${kept[maxLines - 1]!} ${lines[maxLines]!}`, width);
    return kept;
  }
  return lines.length ? lines : [''];
}

/** `2026-10-20` -> `10-20` (same year as `now`) to save room. */
export function shortDate(date: string, now: Date): string {
  return date.startsWith(String(now.getFullYear())) ? date.slice(5) : date;
}

function dueText(card: Card, config: BoardConfig, now: Date, paint: Painter): string {
  if (!card.due) return '';
  const state = dueState(card, config, now);
  const label = shortDate(card.due, now);
  return state === 'overdue' ? paint('red', label) : state === 'soon' ? paint('yellow', label) : paint('gray', label);
}

export function statusName(card: Card, config: BoardConfig): string {
  return (config.columns.find((c) => c.id === card.status) ?? config.columns[0]!).name;
}

/** Aligned table; one line per card. */
export function renderTable(cards: Card[], config: BoardConfig, paint: Painter, width: number, now: Date): string {
  if (!cards.length) return paint('gray', 'No cards.');
  const keyW = Math.max(...cards.map((c) => c.key.length));
  const statusW = Math.max(...cards.map((c) => [...statusName(c, config)].length));
  const asgW = Math.min(14, Math.max(0, ...cards.map((c) => [...(c.assignee ?? '')].length)));
  const dueW = cards.some((c) => c.due) ? 5 : 0;
  const fixed = 1 + 1 + 2 + 1 + keyW + 1 + statusW + 1 + (asgW ? asgW + 1 : 0) + (dueW ? dueW + 1 : 0);
  const titleW = Math.max(16, width - fixed);

  return cards
    .map((c) => {
      const parts = [
        typeGlyph(c.type, paint),
        priorityGlyph(c.priority, paint),
        paint('bold', pad(c.key, keyW)),
        paint('cyan', pad(statusName(c, config), statusW)),
      ];
      if (asgW) parts.push(pad(truncate(c.assignee ?? '', asgW), asgW));
      if (dueW) parts.push(c.due ? dueText(c, config, now, paint) + ' '.repeat(Math.max(0, dueW - [...shortDate(c.due, now)].length)) : ' '.repeat(dueW));
      const checklist = c.checklist.total ? paint('gray', ` ${c.checklist.done}/${c.checklist.total}`) : '';
      const labels = c.labels.length ? paint('gray', ` #${c.labels.join(' #')}`) : '';
      const title = truncate(c.title, titleW - [...(c.checklist.total ? ` ${c.checklist.done}/${c.checklist.total}` : '')].length);
      return `${parts.join(' ')} ${title}${checklist}${labels}`;
    })
    .join('\n');
}

interface Cell {
  text: string;
  len: number;
}

const plain = (text: string): Cell => ({ text, len: [...text].length });

/** Kanban in the terminal: columns side by side, or stacked when the terminal is narrow. */
export function renderBoard(cards: Card[], config: BoardConfig, paint: Painter, width: number, now: Date): string {
  const groups = groupByColumn(cards, config);
  const gap = 2;
  const colW = Math.floor((width - gap * (groups.length - 1)) / groups.length);
  const sideBySide = colW >= 20;
  const w = sideBySide ? colW : Math.max(30, width);

  const columns: Cell[][] = groups.map(({ column, cards: list }) => {
    const over = column.wip && list.length > column.wip;
    const count = column.wip ? `${list.length}/${column.wip}` : String(list.length);
    const title = truncate(column.name.toUpperCase(), w - count.length - 3);
    const head = paint(['bold', column.done ? 'green' : 'cyan'], title) + ' ' + paint(over ? 'red' : 'gray', count);
    const out: Cell[] = [{ text: head, len: [...title].length + 1 + count.length }, { text: paint('gray', '─'.repeat(w)), len: w }];
    for (const c of list) {
      const idLine = `${typeGlyph(c.type, paint)} ${paint('bold', c.key)} ${priorityGlyph(c.priority, paint)}`;
      const idLen = 1 + 1 + c.key.length + 1 + 2;
      const meta: string[] = [];
      let metaLen = 0;
      const push = (text: string, len: number) => {
        if (metaLen + len + (meta.length ? 1 : 0) > w) return;
        metaLen += len + (meta.length ? 1 : 0);
        meta.push(text);
      };
      if (c.assignee) push(paint('magenta', '@' + truncate(c.assignee, 12)), 1 + Math.min(12, [...c.assignee].length));
      if (c.due) push(dueText(c, config, now, paint), [...shortDate(c.due, now)].length);
      if (c.checklist.total) push(paint('gray', `${c.checklist.done}/${c.checklist.total}`), `${c.checklist.done}/${c.checklist.total}`.length);
      out.push({ text: idLine, len: idLen });
      for (const l of wrap(c.title, w, 2)) out.push(plain(l));
      if (meta.length) out.push({ text: meta.join(' '), len: metaLen });
      out.push(plain(''));
    }
    if (!list.length) out.push({ text: paint('gray', '(empty)'), len: 7 });
    return out;
  });

  if (!sideBySide) {
    return columns.map((col) => col.map((c) => c.text).join('\n')).join('\n\n');
  }
  const rows = Math.max(...columns.map((c) => c.length));
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    lines.push(
      columns
        .map((col) => {
          const cell = col[r];
          return cell ? cell.text + ' '.repeat(Math.max(0, w - cell.len)) : ' '.repeat(w);
        })
        .join(' '.repeat(gap))
        .trimEnd(),
    );
  }
  return lines.join('\n');
}

/** `2026-10-14T17:02:00Z` -> `2026-10-14 14:02` (local time). */
function commentTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderCard(card: Card, config: BoardConfig, paint: Painter, now: Date): string {
  const lines: string[] = [];
  lines.push(`${typeGlyph(card.type, paint)} ${paint('bold', card.key)}  ${paint('bold', card.title)}`);
  const field = (label: string, value: string | undefined) => value && lines.push(`${paint('gray', pad(label, 10))}${value}`);
  field('Status', paint('cyan', statusName(card, config)));
  field('Priority', `${priorityGlyph(card.priority, paint)} ${card.priority}`);
  field('Type', card.type);
  field('Assignee', card.assignee);
  field('Labels', card.labels.length ? card.labels.map((l) => `#${l}`).join(' ') : undefined);
  field('Due', card.due ? dueText(card, config, now, paint) : undefined);
  field('Estimate', card.estimate !== undefined ? String(card.estimate) : undefined);
  field('Parent', card.parent);
  field('Checklist', card.checklist.total ? `${card.checklist.done}/${card.checklist.total}` : undefined);
  field('Created', card.created);
  field('Updated', card.updated);
  field('Resolved', card.resolved);
  field('Note', card.path);
  if (card.body.trim()) lines.push('', card.body.trim());
  if (card.comments.length) {
    lines.push('', paint('bold', `Comments (${card.comments.length})`));
    for (const c of card.comments) {
      lines.push('', `${paint('magenta', c.author)} ${paint('gray', commentTime(c.at))}  ${paint('gray', '#' + c.id)}`);
      lines.push(...c.text.split('\n').map((l) => (l ? `  ${l}` : '')));
    }
  }
  return lines.join('\n');
}
