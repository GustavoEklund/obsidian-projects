// Builds throwaway vaults for the MCP tests, with the TypeScript core (the reference implementation): realistic notes
// for performance and memory budgets, and notes written by TypeScript for the Rust server to read (interoperability).
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_CONFIG,
  newCardContent,
  spreadRanks,
  type BoardConfig,
  type Card,
  type CardType,
  type Priority,
} from '@oprojects/core';
import { FsStorage, saveBoardConfig } from '@oprojects/core/node';

export interface TestVault {
  root: string;
  config: BoardConfig;
  cleanup: () => void;
}

const STATUSES = ['todo', 'doing', 'review', 'done'];
const TYPES: CardType[] = ['task', 'story', 'bug'];
const PRIORITIES: Priority[] = ['highest', 'high', 'medium', 'low'];
const PEOPLE = ['Ana', 'Bruno', 'Carla', 'Diego'];
const DESCRIPTION =
  'The user lands on the home page instead of the page they came from after signing in through the SSO redirect. ';

/** A vault with `count` realistic cards (a short description with a checklist, two comments each). Deterministic. */
export async function createVault(count: number, options: { prefix?: string; me?: string } = {}): Promise<TestVault> {
  const root = mkdtempSync(path.join(tmpdir(), 'oprojects-mcp-vault-'));
  mkdirSync(path.join(root, '.obsidian'), { recursive: true });
  const config: BoardConfig = {
    ...DEFAULT_CONFIG,
    prefix: options.prefix ?? 'OP',
    me: options.me ?? 'Ana',
    members: PEOPLE,
    columns: DEFAULT_CONFIG.columns.map((c) => Object.assign({}, c)),
  };
  await saveBoardConfig(root, config);

  const storage = new FsStorage(root);
  const ranks = spreadRanks(Math.max(1, Math.ceil(count / STATUSES.length)));
  const now = '2026-10-15T12:00:00.000Z';
  for (let i = 1; i <= count; i++) {
    const status = STATUSES[i % STATUSES.length]!;
    const card: Card = {
      key: `${config.prefix}-${i}`,
      path: `${config.folder}/${config.prefix}-${i}.md`,
      title: `Card number ${i}${i % 7 === 0 ? ' login redirect' : ''} with a reasonably long title`,
      status,
      type: TYPES[i % TYPES.length]!,
      priority: PRIORITIES[i % PRIORITIES.length]!,
      assignee: PEOPLE[i % PEOPLE.length],
      labels: ['api', i % 5 ? 'backend' : 'ux'],
      due: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}`,
      estimate: 1 + (i % 8),
      rank: ranks[Math.floor((i - 1) / STATUSES.length)]!,
      created: now,
      updated: now,
      resolved: status === 'done' ? now : undefined,
      body: `${DESCRIPTION.repeat(5)}\n\n- [x] Reproduce\n- [ ] Fix in the gateway\n- [ ] Regression test\n`,
      checklist: { done: 1, total: 3 },
      comments: [
        { id: `c${i}a`, author: 'Ana', at: now, text: 'I can only reproduce it in Safari.' },
        { id: `c${i}b`, author: 'Bruno', at: now, text: 'Found it: the SSO redirect drops the query string.' },
      ],
    };
    await storage.create(card.path, newCardContent(card));
  }
  return { root, config, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
