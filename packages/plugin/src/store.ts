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

  /** Apply many changes with a single notification. */
  batch(fn: () => void): void {
    const listeners = this.listeners;
    this.listeners = new Set();
    try {
      fn();
    } finally {
      this.listeners = listeners;
    }
    this.changed();
  }

  private put(card: Card): void {
    this.cards.set(card.key, card);
    this.keyByPath.set(card.path, card.key);
  }

  private changed(): void {
    this.cached = null;
    for (const l of [...this.listeners]) l();
  }
}
