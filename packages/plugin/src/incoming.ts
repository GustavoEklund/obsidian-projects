import type { Card, Comment } from '@oprojects/core';

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The comments `next` has that `prev` did not, written by someone other than `me` and not before `since` (epoch ms).
 *
 * - A card with no previous state is not a change to a thread, so it has none (the board loads every card once
 *   without calling this).
 * - `since` keeps a sync client that delivers last week's comments from notifying about them: only what was written
 *   while the plugin was running counts. A comment with no usable time (written by hand in the note) counts.
 * - With no name configured for `me`, nobody is "me": every new comment is someone else's.
 */
export function incomingComments(prev: Card | undefined, next: Card, me: string, since: number): Comment[] {
  if (!prev) return [];
  const known = new Set(prev.comments.map((c) => c.id));
  return next.comments.filter((c) => {
    if (known.has(c.id)) return false;
    if (me.trim() && sameName(c.author, me)) return false;
    const at = Date.parse(c.at);
    return Number.isNaN(at) || at >= since;
  });
}
