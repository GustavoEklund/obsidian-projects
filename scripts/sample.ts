// Realistic demo data, shared by the seed script (writes notes into dev-vault)
// and the browser harness (renders the board without Obsidian).
import { DEFAULT_CONFIG, countChecklist, localDate, spreadRanks, type BoardConfig, type Card, type CardType, type Priority } from '@oprojects/core';

export const SAMPLE_CONFIG: BoardConfig = {
  ...DEFAULT_CONFIG,
  prefix: 'OP',
  me: 'Ana',
  members: ['Ana', 'Bruno', 'Carla', 'Diego'],
  columns: [
    { id: 'todo', name: 'To do' },
    { id: 'doing', name: 'In progress', wip: 4 },
    { id: 'review', name: 'In review', wip: 3 },
    { id: 'done', name: 'Done', done: true },
  ],
};

interface Row {
  title: string;
  status: string;
  type: CardType;
  priority: Priority;
  assignee?: string;
  labels?: string[];
  due?: number; // days from today
  estimate?: number;
  parent?: number; // key number
  body?: string;
  resolvedDaysAgo?: number;
  comments?: { author: string; text: string; daysAgo: number }[];
}

// Index in this list + 1 = card number.
const ROWS: Row[] = [
  { title: 'Checkout redesign', status: 'doing', type: 'epic', priority: 'high', labels: ['checkout'], body: 'Reduce drop-off in the payment funnel.\n\n- [x] User research\n- [ ] New layout\n- [ ] Instant payments\n' },
  { title: 'Onboarding for new users', status: 'todo', type: 'epic', priority: 'medium', labels: ['growth'] },
  { title: 'Platform reliability', status: 'doing', type: 'epic', priority: 'high', labels: ['platform'] },
  { title: 'Map funnel analytics events', status: 'todo', type: 'story', priority: 'medium', assignee: 'Bruno', labels: ['analytics'], parent: 2, estimate: 3, due: 9 },
  { title: "Signup fails with an email containing '+'", status: 'todo', type: 'bug', priority: 'high', assignee: 'Carla', labels: ['signup'], parent: 2, due: -2, comments: [{ author: 'Bruno', text: 'This breaks signups for corporate customers, worth prioritizing.', daysAgo: 2 }], body: 'Steps: sign up with `name+test@example.com`.\n\nThe validator rejects the `+`.\n' },
  { title: 'Add rate limiting to the payments API', status: 'todo', type: 'task', priority: 'high', assignee: 'Diego', labels: ['api', 'security'], parent: 3, estimate: 5, due: 4 },
  { title: 'Document environment variables', status: 'todo', type: 'task', priority: 'low', labels: ['docs'], estimate: 1 },
  { title: 'Friendly error screen for declined payments', status: 'todo', type: 'story', priority: 'medium', assignee: 'Ana', labels: ['ux'], parent: 1, body: '- [ ] Approved copy\n- [ ] Mobile error state\n- [ ] Analytics event\n' },
  { title: 'Review the welcome email copy', status: 'todo', type: 'task', priority: 'lowest', assignee: 'Carla', labels: ['copy'], parent: 2 },
  { title: 'Fix redirect after login', status: 'doing', type: 'bug', priority: 'highest', assignee: 'Ana', labels: ['auth'], parent: 1, estimate: 2, due: 1, comments: [
    { author: 'Carla', text: 'I can only reproduce it in Safari. In Chrome `returnTo` arrives correctly.', daysAgo: 3 },
    { author: 'Ana', text: 'Found it: the SSO redirect drops the query string.\n\n- [x] confirm in the logs\n- [ ] fix in the gateway', daysAgo: 1 },
  ], body: 'The user lands on the home page instead of the page they came from.\n\n- [x] Reproduce\n- [ ] Preserve `returnTo`\n- [ ] Regression test\n' },
  { title: 'New order summary layout', status: 'doing', type: 'story', priority: 'high', assignee: 'Bruno', labels: ['ux', 'frontend'], parent: 1, estimate: 8, due: 6, body: '- [x] Wireframe\n- [x] Base components\n- [ ] Loading states\n- [ ] Responsive\n- [ ] Design review\n' },
  { title: 'Move email jobs to a queue', status: 'doing', type: 'task', priority: 'medium', assignee: 'Diego', labels: ['backend'], parent: 3, estimate: 5 },
  { title: 'Intermittent timeout on the gateway', status: 'doing', type: 'bug', priority: 'high', assignee: 'Carla', labels: ['api', 'incident'], parent: 3, due: 0 },
  { title: 'End-to-end tests for the checkout flow', status: 'doing', type: 'task', priority: 'medium', assignee: 'Ana', labels: ['qa'], parent: 1, estimate: 3 },
  { title: 'Catalog cache at the edge', status: 'review', type: 'story', priority: 'medium', assignee: 'Bruno', labels: ['performance'], parent: 3, estimate: 5 },
  { title: 'Validate tax ID at signup', status: 'review', type: 'task', priority: 'high', assignee: 'Carla', labels: ['signup'], parent: 2, estimate: 2 },
  { title: 'Enable 2FA for administrators', status: 'done', type: 'story', priority: 'high', assignee: 'Diego', labels: ['security'], resolvedDaysAgo: 2 },
  { title: 'Remove the legacy /v1/orders endpoint', status: 'done', type: 'task', priority: 'low', assignee: 'Bruno', labels: ['cleanup'], resolvedDaysAgo: 5 },
  { title: 'Fix shipping cost with coupons', status: 'done', type: 'bug', priority: 'highest', assignee: 'Ana', labels: ['checkout'], parent: 1, resolvedDaysAgo: 1 },
  { title: 'Update critical dependencies', status: 'done', type: 'task', priority: 'medium', assignee: 'Diego', labels: ['security'], resolvedDaysAgo: 40 },
  { title: 'Latency metrics dashboard', status: 'done', type: 'task', priority: 'medium', assignee: 'Carla', labels: ['observability'], parent: 3, resolvedDaysAgo: 9 },
  { title: 'Research SMS provider alternatives', status: 'todo', type: 'task', priority: 'low', labels: ['research'] },
  { title: 'Instant payments at checkout', status: 'todo', type: 'story', priority: 'high', assignee: 'Bruno', labels: ['payments'], parent: 1, estimate: 13, due: 14, body: 'Instant payment through QR code and copy-and-paste.\n\n## Acceptance criteria\n\n- [ ] QR code generated in < 1s\n- [ ] Webhook confirmation\n- [ ] Configurable expiry\n' },
  { title: 'Error 500 when exporting an empty report', status: 'todo', type: 'bug', priority: 'medium', labels: ['reports'] },
];

export function sampleCards(now: Date = new Date()): Card[] {
  const day = (offset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return d;
  };
  const stamp = (daysAgo: number) => day(-daysAgo).toISOString();

  const rankByStatus = new Map<string, string[]>();
  const counts = new Map<string, number>();
  for (const r of ROWS) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  for (const [status, n] of counts) rankByStatus.set(status, spreadRanks(n));
  const used = new Map<string, number>();

  return ROWS.map((r, i): Card => {
    const n = i + 1;
    const key = `OP-${n}`;
    const body = r.body ?? '';
    const k = used.get(r.status) ?? 0;
    used.set(r.status, k + 1);
    return {
      key,
      path: `Cards/${key}.md`,
      title: r.title,
      status: r.status,
      type: r.type,
      priority: r.priority,
      assignee: r.assignee,
      labels: r.labels ?? [],
      due: r.due === undefined ? undefined : localDate(day(r.due)),
      estimate: r.estimate,
      parent: r.parent ? `OP-${r.parent}` : undefined,
      rank: rankByStatus.get(r.status)![k]!,
      created: stamp(30 - n),
      updated: stamp(r.resolvedDaysAgo ?? Math.max(0, 8 - (n % 8))),
      resolved: r.resolvedDaysAgo === undefined ? undefined : stamp(r.resolvedDaysAgo),
      body,
      checklist: countChecklist(body),
      comments: (r.comments ?? []).map((c, ci) => ({ id: `s${n}x${ci + 1}`, author: c.author, at: stamp(c.daysAgo), text: c.text })),
    };
  });
}
