import type { Placement } from '@oprojects/core';

export interface DragHooks {
  onStart(): void;
  onEnd(): void;
  /** Called only when the card actually lands somewhere new. */
  onDrop(key: string, status: string, placement: Placement): void;
}

interface Target {
  col: HTMLElement;
  status: string;
  before: HTMLElement | null;
  after: HTMLElement | null;
}

const keyOf = (el: HTMLElement) => el.dataset.key!;

/**
 * Drag & drop between and inside columns with native HTML5 DnD, delegated from
 * one root. Work per `dragover` is one pass over the hovered column's cards
 * (reads first, a single write after), throttled to animation frames.
 */
export class DragController {
  private dragEl: HTMLElement | null = null;
  private target: Target | null = null;
  private frame = 0;
  private lastY = 0;
  private lastCol: HTMLElement | null = null;
  private overCol: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: DragHooks,
  ) {
    root.addEventListener('dragstart', this.onDragStart);
    root.addEventListener('dragover', this.onDragOver);
    root.addEventListener('dragleave', this.onDragLeave);
    root.addEventListener('drop', this.onDrop);
    root.addEventListener('dragend', this.onDragEnd);
  }

  destroy(): void {
    this.root.removeEventListener('dragstart', this.onDragStart);
    this.root.removeEventListener('dragover', this.onDragOver);
    this.root.removeEventListener('dragleave', this.onDragLeave);
    this.root.removeEventListener('drop', this.onDrop);
    this.root.removeEventListener('dragend', this.onDragEnd);
    cancelAnimationFrame(this.frame);
  }

  private onDragStart = (e: DragEvent): void => {
    const card = (e.target as Element).closest<HTMLElement>('.op-card');
    if (!card || !e.dataTransfer) return;
    this.dragEl = card;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', keyOf(card));
    // Defer so the drag image is captured before the card is dimmed.
    requestAnimationFrame(() => card.classList.add('op-dragging'));
    this.root.classList.add('op-is-dragging');
    this.hooks.onStart();
  };

  private onDragOver = (e: DragEvent): void => {
    if (!this.dragEl) return;
    const col = (e.target as Element).closest<HTMLElement>('.op-col');
    if (!col) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.lastY = e.clientY;
    this.lastCol = col;
    if (!this.frame) this.frame = requestAnimationFrame(this.update);
  };

  private update = (): void => {
    this.frame = 0;
    const col = this.lastCol;
    if (!col || !this.dragEl) return;
    const list = col.querySelector<HTMLElement>('.op-col-list')!;
    const cards = [...list.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c !== this.dragEl);

    // Reads
    const rects = cards.map((c) => c.getBoundingClientRect());
    let index = rects.findIndex((r) => this.lastY < r.top + r.height / 2);
    if (index < 0) index = cards.length;
    const before = cards[index] ?? null;
    const after = index > 0 ? cards[index - 1]! : null;
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    const top = before ? before.offsetTop - gap / 2 : after ? after.offsetTop + after.offsetHeight + gap / 2 : 0;

    // Writes
    this.target = { col, status: col.dataset.col!, before, after: before ? null : after };
    const line = col.querySelector<HTMLElement>('.op-drop-line')!;
    line.style.transform = `translateY(${Math.max(0, top)}px)`;
    line.hidden = false;
    if (this.overCol !== col) {
      this.overCol?.classList.remove('op-col-over');
      this.overCol?.querySelector<HTMLElement>('.op-drop-line')!.setAttribute('hidden', '');
      col.classList.add('op-col-over');
      this.overCol = col;
    }
  };

  private onDragLeave = (e: DragEvent): void => {
    const next = e.relatedTarget as Node | null;
    if (this.overCol && (!next || !this.overCol.contains(next))) {
      this.overCol.classList.remove('op-col-over');
      this.overCol.querySelector<HTMLElement>('.op-drop-line')!.setAttribute('hidden', '');
      this.overCol = null;
      this.target = null;
    }
  };

  private onDrop = (e: DragEvent): void => {
    if (!this.dragEl) return;
    e.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.lastCol) this.update(); // make sure the target reflects the final pointer position
    const target = this.target;
    const card = this.dragEl;
    if (!target) return;

    const list = target.col.querySelector<HTMLElement>('.op-col-list')!;
    const sameColumn = card.parentElement === list;
    const unchanged = sameColumn && (target.before ? target.before === card.nextElementSibling : target.after ? target.after === card.previousElementSibling : list.children.length === 1);
    if (unchanged) return;

    const placement: Placement = target.before ? { before: keyOf(target.before) } : target.after ? { after: keyOf(target.after) } : {};
    this.hooks.onDrop(keyOf(card), target.status, placement);
  };

  private onDragEnd = (): void => {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.dragEl?.classList.remove('op-dragging');
    this.overCol?.classList.remove('op-col-over');
    this.root.querySelectorAll('.op-drop-line').forEach((l) => l.setAttribute('hidden', ''));
    this.root.classList.remove('op-is-dragging');
    this.dragEl = null;
    this.target = null;
    this.overCol = null;
    this.lastCol = null;
    this.hooks.onEnd();
  };
}
