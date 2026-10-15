import { sameCard, type Card } from '@oprojects/core';

/**
 * In-memory index of all cards. The board reads from here (never from disk),
 * so rendering and filtering stay instant; whatever watches the vault keeps it
 * up to date incrementally, one note at a time.
 */
export class CardStore {
  ready = false;
  private cards = new Map<string, Card>();
  private keyByPath = new Map<string, string>();
  private listeners = new Set<() => void>();
  private cached: readonly Card[] | null = null;
  /** How many `batch` calls are running (they nest); while any is, notifications are held back. */
  private depth = 0;
  /** A change happened inside a batch and subscribers still have to be told. */
  private pending = false;

  all(): readonly Card[] {
    return (this.cached ??= [...this.cards.values()]);
  }

  get(key: string): Card | undefined {
    return this.cards.get(key);
  }

  keyAt(path: string): string | undefined {
    return this.keyByPath.get(path);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Initial load: replaces everything and marks the store ready. */
  replaceAll(cards: Card[]): void {
    this.cards.clear();
    this.keyByPath.clear();
    for (const card of cards) this.put(card);
    this.ready = true;
    this.changed();
  }

  /** Insert or update one card. Returns false (and stays silent) when nothing changed. */
  apply(card: Card): boolean {
    const prev = this.cards.get(card.key);
    if (prev && sameCard(prev, card)) return false;
    if (prev && prev.path !== card.path) this.keyByPath.delete(prev.path);
    this.put(card);
    this.changed();
    return true;
  }

  remove(key: string): boolean {
    const prev = this.cards.get(key);
    if (!prev) return false;
    this.cards.delete(key);
    if (this.keyByPath.get(prev.path) === key) this.keyByPath.delete(prev.path);
    this.changed();
    return true;
  }

  removePath(path: string): boolean {
    const key = this.keyByPath.get(path);
    return key ? this.remove(key) : false;
  }

  /** Tell subscribers that something outside the cards changed (e.g. the board settings). */
  touch(): void {
    this.changed();
  }

  /**
   * Apply many changes with a single notification, sent only if something actually changed (the vault echoing
   * back our own write changes nothing, and should not make the board render again).
   */
  batch(fn: () => void): void {
    this.depth++;
    try {
      fn();
    } finally {
      this.depth--;
      if (this.depth === 0 && this.pending) {
        this.pending = false;
        this.notify();
      }
    }
  }

  private put(card: Card): void {
    this.cards.set(card.key, card);
    this.keyByPath.set(card.path, card.key);
  }

  private changed(): void {
    this.cached = null; // `all()` is fresh at once, even in the middle of a batch
    if (this.depth > 0) this.pending = true;
    else this.notify();
  }

  private notify(): void {
    // Iterate a snapshot: a listener may unsubscribe (or subscribe) while we notify.
    for (const l of Array.from(this.listeners)) l();
  }
}
