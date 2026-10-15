import type { Card } from '@oprojects/core';

/** A hand-written card for tests that need exact data (the sample board is rich but fixed). */
export function makeCard(key: string, extra: Partial<Card> = {}): Card {
  const body = extra.body ?? '';
  return {
    key,
    path: `Cards/${key}.md`,
    title: `Title ${key}`,
    status: 'todo',
    type: 'task',
    priority: 'medium',
    labels: [],
    rank: 'M',
    created: '2026-10-01T10:00:00.000Z',
    updated: '2026-10-10T10:00:00.000Z',
    body,
    checklist: { done: 0, total: 0 },
    comments: [],
    ...extra,
  };
}
