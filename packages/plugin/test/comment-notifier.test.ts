import type { Card, Comment } from '@oprojects/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommentNotifier, desktopNotify, type NotifierDeps } from '../src/comment-notifier';
import { setLanguage } from '../src/i18n';
import { makeCard } from './helpers/cards';

/** The slice of the Web Notifications API that the notifier uses. */
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requested = 0;
  static asked: NotificationPermission = 'granted';
  static shown: FakeNotification[] = [];
  static failToCreate = false;
  static failToRequest = false;
  closed = false;
  private readonly listeners: Record<string, Array<() => void>> = {};
  constructor(
    readonly title: string,
    readonly options?: { body?: string },
  ) {
    if (FakeNotification.failToCreate) throw new Error('not allowed here');
    FakeNotification.shown.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  /** What the system does when the person clicks the notification. */
  click(): void {
    for (const listener of this.listeners['click'] ?? []) listener();
  }
  close(): void {
    this.closed = true;
  }
  static requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requested++;
    if (FakeNotification.failToRequest) return Promise.reject(new Error('no'));
    FakeNotification.permission = FakeNotification.asked;
    return Promise.resolve(FakeNotification.asked);
  }
}

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const AFTER = '2026-10-20T12:05:00.000Z';

const comment = (id: string, author: string, text: string, at = AFTER): Comment => ({ id, author, at, text });
const before = (): Card => makeCard('OP-7', { title: 'Fix login' });
const after = (...comments: Comment[]): Card => makeCard('OP-7', { title: 'Fix login', comments });

let inApp: string[];
let opened: Card[];
let deps: NotifierDeps;
let enabled: boolean;
let focused: boolean;
let notifier: CommentNotifier;

beforeEach(() => {
  setLanguage('en');
  Object.assign(FakeNotification, {
    permission: 'granted',
    requested: 0,
    asked: 'granted',
    shown: [],
    failToCreate: false,
    failToRequest: false,
  });
  vi.stubGlobal('Notification', FakeNotification);
  inApp = [];
  opened = [];
  enabled = true;
  focused = false;
  deps = {
    enabled: () => enabled,
    me: () => 'Gustavo',
    focused: () => focused,
    inApp: (message) => inApp.push(message),
    open: (card) => opened.push(card),
    now: () => NOW,
  };
  notifier = new CommentNotifier(deps);
});

afterEach(() => vi.unstubAllGlobals());

const shown = () => FakeNotification.shown;
const delivered = () => vi.waitFor(() => expect(shown().length + inApp.length).toBeGreaterThan(0));

describe('desktopNotify', () => {
  it('shows the notification with its title and body, and a click opens the card and closes it', async () => {
    const open = vi.fn();
    expect(await desktopNotify('OP-7 · Fix login', 'Claude: done', open)).toBe(true);
    expect(shown()).toHaveLength(1);
    expect(shown()[0]!.title).toBe('OP-7 · Fix login');
    expect(shown()[0]!.options).toEqual({ body: 'Claude: done' });
    shown()[0]!.click();
    expect(open).toHaveBeenCalledOnce();
    expect(shown()[0]!.closed).toBe(true);
  });

  it('asks for permission once when it was never decided, and shows if it is granted', async () => {
    FakeNotification.permission = 'default';
    expect(await desktopNotify('t', 'b', vi.fn())).toBe(true);
    expect(FakeNotification.requested).toBe(1);
    expect(shown()).toHaveLength(1);
  });

  it('says it could not when the person refuses, without showing anything', async () => {
    FakeNotification.permission = 'default';
    FakeNotification.asked = 'denied';
    expect(await desktopNotify('t', 'b', vi.fn())).toBe(false);
    expect(shown()).toHaveLength(0);
  });

  it('says it could not when permission was already denied, and does not ask again', async () => {
    FakeNotification.permission = 'denied';
    expect(await desktopNotify('t', 'b', vi.fn())).toBe(false);
    expect(FakeNotification.requested).toBe(0);
  });

  it('says it could not when the API is not there', async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('Notification', undefined);
    expect(await desktopNotify('t', 'b', vi.fn())).toBe(false);
  });

  it('says it could not when the API throws, whether asking or showing', async () => {
    FakeNotification.failToCreate = true;
    expect(await desktopNotify('t', 'b', vi.fn())).toBe(false);
    FakeNotification.failToCreate = false;
    FakeNotification.permission = 'default';
    FakeNotification.failToRequest = true;
    expect(await desktopNotify('t', 'b', vi.fn())).toBe(false);
  });
});

describe('CommentNotifier', () => {
  it('shows a desktop notification for a comment from someone else when the app is in the background', async () => {
    notifier.cardChanged(before(), after(comment('c1', 'Claude', 'I pushed the fix.')));
    await delivered();
    expect(shown()[0]!.title).toBe('OP-7 · Fix login');
    expect(shown()[0]!.options!.body).toBe('Claude: I pushed the fix.');
    expect(inApp).toEqual([]);
  });

  it('a click takes the person to the card as it is now', async () => {
    const next = after(comment('c1', 'Claude', 'hi'));
    notifier.cardChanged(before(), next);
    await delivered();
    shown()[0]!.click();
    expect(opened).toEqual([next]);
  });

  it('shows a notice inside the app instead when the app has the focus', () => {
    focused = true;
    notifier.cardChanged(before(), after(comment('c1', 'Claude', 'hi')));
    expect(inApp).toEqual(['OP-7 · Fix login: Claude: hi']);
    expect(shown()).toHaveLength(0);
  });

  it('falls back to the notice inside the app when the system notification cannot be shown', async () => {
    FakeNotification.permission = 'denied';
    notifier.cardChanged(before(), after(comment('c1', 'Claude', 'hi')));
    await delivered();
    expect(inApp).toEqual(['OP-7 · Fix login: Claude: hi']);
  });

  it('says nothing when the setting is off', async () => {
    enabled = false;
    notifier.cardChanged(before(), after(comment('c1', 'Claude', 'hi')));
    await Promise.resolve();
    expect(shown().length + inApp.length).toBe(0);
  });

  it('says nothing about my own comments, a card without new comments, or a comment from before it started', async () => {
    notifier.cardChanged(before(), after(comment('c1', 'gustavo', 'mine')));
    notifier.cardChanged(before(), before());
    notifier.cardChanged(before(), after(comment('c2', 'Claude', 'old', '2026-10-19T09:00:00.000Z')));
    notifier.cardChanged(undefined, after(comment('c3', 'Claude', 'new card')));
    await Promise.resolve();
    expect(shown().length + inApp.length).toBe(0);
  });

  it('shows the latest comment on one line, cut when long, and counts the others', async () => {
    const long = `${'word '.repeat(60)}\n\nand more`;
    notifier.cardChanged(
      before(),
      after(comment('c1', 'Claude', 'first'), comment('c2', 'Claude', 'second'), comment('c3', 'Ana', long)),
    );
    await delivered();
    const body = shown()[0]!.options!.body!;
    expect(body.startsWith('Ana: word word word')).toBe(true);
    expect(body).not.toContain('\n');
    expect(body).toContain('…');
    expect(body.endsWith('(+2)')).toBe(true);
  });

  it('does not cut a comment that fits', async () => {
    notifier.cardChanged(before(), after(comment('c1', 'Claude', 'x'.repeat(140))));
    await delivered();
    expect(shown()[0]!.options!.body).toBe(`Claude: ${'x'.repeat(140)}`);
  });

  it('names a comment with no author "Anonymous"', async () => {
    notifier.cardChanged(before(), after(comment('c1', ' ', 'hi')));
    await delivered();
    expect(shown()[0]!.options!.body).toBe('Anonymous: hi');
  });

  it('starts counting when it is made, using the real clock by default', () => {
    const real = new CommentNotifier({ ...deps, now: undefined, focused: () => true });
    real.cardChanged(before(), after(comment('c1', 'Claude', 'from long ago', '2001-01-01T00:00:00.000Z')));
    expect(inApp).toEqual([]);
    real.cardChanged(before(), after(comment('c2', 'Claude', 'now', new Date(Date.now() + 1000).toISOString())));
    expect(inApp).toHaveLength(1);
  });
});
