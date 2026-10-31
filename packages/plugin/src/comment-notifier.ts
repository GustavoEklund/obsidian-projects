import type { Card } from '@oprojects/core';
import { t } from './i18n';
import { incomingComments } from './incoming';

/** The most characters of a comment that go into a notification. */
const MAX_TEXT = 140;

/**
 * Shows a desktop notification (the operating system's own, through the Web Notifications API that Obsidian's
 * Electron provides). Resolves `false` when it could not: no API, permission refused, or the API failed, so the caller
 * can say it another way.
 */
export async function desktopNotify(title: string, body: string, onClick: () => void): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  try {
    let permission = Notification.permission;
    if (permission === 'default') permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;
    const shown = new Notification(title, { body });
    shown.addEventListener('click', () => {
      onClick();
      shown.close();
    });
    return true;
  } catch {
    return false;
  }
}

export interface NotifierDeps {
  /** The setting: tell me about new comments. */
  enabled(): boolean;
  /** Who "I" am: comments signed with this name never notify. */
  me(): string;
  /** Whether the app is the window the person is looking at. */
  focused(): boolean;
  /** A notification inside the app (an Obsidian `Notice`). */
  inApp(message: string): void;
  /** Takes the person to the card. */
  open(card: Card): void;
  /** The clock, in epoch ms (tests). */
  now?(): number;
}

/**
 * Tells the person when someone else (a teammate, an AI agent) comments on a card, as a desktop notification: they are
 * most likely in another window. When the app itself has the focus a pop-up from the system would only repeat what the
 * board shows, so it is a short notice inside the app instead.
 */
export class CommentNotifier {
  private readonly since: number;

  constructor(private readonly deps: NotifierDeps) {
    this.since = (deps.now ?? Date.now)();
  }

  /** Call with each card the vault changed, as it was and as it is. */
  cardChanged(prev: Card | undefined, next: Card): void {
    if (!this.deps.enabled()) return;
    const fresh = incomingComments(prev, next, this.deps.me(), this.since);
    const last = fresh.at(-1);
    if (!last) return;

    const flat = last.text.split(/\s+/).filter(Boolean).join(' ');
    const text = flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT)}…` : flat;
    const more = fresh.length > 1 ? ` (+${fresh.length - 1})` : '';
    const title = `${next.key} · ${next.title}`;
    const body = `${last.author.trim() || t('comment.anonymous')}: ${text}${more}`;

    if (this.deps.focused()) return this.deps.inApp(`${title}: ${body}`);
    void desktopNotify(title, body, () => this.deps.open(next)).then((shown) => {
      if (!shown) this.deps.inApp(`${title}: ${body}`);
    });
  }
}
