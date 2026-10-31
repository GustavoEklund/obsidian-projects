import type { Comment } from '@oprojects/core';
import { describe, expect, it } from 'vitest';
import { incomingComments } from '../src/incoming';
import { makeCard } from './helpers/cards';

const SINCE = Date.parse('2026-10-20T12:00:00.000Z');
const AFTER = '2026-10-20T12:05:00.000Z';
const BEFORE = '2026-10-19T09:00:00.000Z';

const comment = (id: string, author: string, at = AFTER, text = `text ${id}`): Comment => ({ id, author, at, text });
const withComments = (...comments: Comment[]) => makeCard('OP-1', { comments });

describe('incomingComments', () => {
  it('returns the comments that the card did not have, in order', () => {
    const prev = withComments(comment('a', 'Ana'));
    const next = withComments(comment('a', 'Ana'), comment('b', 'Claude'), comment('c', 'Claude'));
    expect(incomingComments(prev, next, 'Gustavo', SINCE).map((c) => c.id)).toEqual(['b', 'c']);
  });

  it('is empty when nothing was added, or when the card has no previous state', () => {
    const card = withComments(comment('a', 'Ana'));
    expect(incomingComments(card, card, 'Gustavo', SINCE)).toEqual([]);
    expect(incomingComments(undefined, card, 'Gustavo', SINCE)).toEqual([]);
  });

  it('skips comments signed with my name, whatever the case or spacing', () => {
    const next = withComments(comment('a', ' gustavo EKLUND '), comment('b', 'Claude'));
    expect(incomingComments(makeCard('OP-1'), next, 'Gustavo Eklund', SINCE).map((c) => c.id)).toEqual(['b']);
  });

  it('counts every new comment as someone else’s when no name is configured', () => {
    const next = withComments(comment('a', 'Gustavo'), comment('b', 'Claude'));
    expect(incomingComments(makeCard('OP-1'), next, '', SINCE)).toHaveLength(2);
    expect(incomingComments(makeCard('OP-1'), next, '   ', SINCE)).toHaveLength(2);
  });

  it('skips what was written before the plugin started: a sync delivering old comments is not news', () => {
    const next = withComments(comment('old', 'Claude', BEFORE), comment('new', 'Claude', AFTER));
    expect(incomingComments(makeCard('OP-1'), next, 'Gustavo', SINCE).map((c) => c.id)).toEqual(['new']);
  });

  it('counts a comment written exactly when the plugin started', () => {
    const next = withComments(comment('now', 'Claude', '2026-10-20T12:00:00.000Z'));
    expect(incomingComments(makeCard('OP-1'), next, 'Gustavo', SINCE)).toHaveLength(1);
  });

  it('counts a comment with no usable time (written by hand in the note)', () => {
    const next = withComments(comment('a', 'Claude', ''), comment('b', 'Claude', 'yesterday-ish'));
    expect(incomingComments(makeCard('OP-1'), next, 'Gustavo', SINCE)).toHaveLength(2);
  });

  it('does not count an edited comment (its id is the same)', () => {
    const prev = withComments(comment('a', 'Claude', AFTER, 'first'));
    const next = withComments(comment('a', 'Claude', AFTER, 'edited'));
    expect(incomingComments(prev, next, 'Gustavo', SINCE)).toEqual([]);
  });
});
