// Interoperability: the Rust server and the TypeScript core read and write the same notes (so do the Obsidian plugin and
// the CLI). Whatever one writes, the other must read as the same card; and the server's answers must agree with the
// reference implementation's for the same questions.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CardService, type Card, type CardQuery } from '@oprojects/core';
import { FsStorage, loadBoardConfig } from '@oprojects/core/node';
import { McpProcess } from '../mcp/client';
import { listedKeys, text, withServer } from './support';

const reference = async (root: string) => new CardService(new FsStorage(root), await loadBoardConfig(root));

const eventually = async <T>(
  what: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 8000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const call = (server: McpProcess, name: string, args: Record<string, unknown> = {}) => server.callTool(name, args);

describe('Rust writes, TypeScript reads', () => {
  it('a created card reads back with every field', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const out = await call(server, 'create_card', {
        title: '  A card made by the server  ',
        status: 'In Progress',
        type: 'story',
        priority: 'high',
        assignee: 'Bruno',
        labels: ['alpha', '#beta'],
        due: '2026-12-24',
        estimate: 2.5,
        parent: 'OP-1',
        body: 'First line.\n\n- [x] one\n- [ ] two\n',
      });
      expect(out.isError).toBeFalsy();
      const card = await (await reference(vault.root)).get('OP-13');
      expect(card).toMatchObject({
        key: 'OP-13',
        title: 'A card made by the server',
        status: 'doing',
        type: 'story',
        priority: 'high',
        assignee: 'Bruno',
        labels: ['alpha', 'beta'],
        due: '2026-12-24',
        estimate: 2.5,
        parent: 'OP-1',
        checklist: { done: 1, total: 2 },
        comments: [],
      });
      expect(card.body.trim()).toBe('First line.\n\n- [x] one\n- [ ] two');
      expect(Date.parse(card.created)).not.toBeNaN();
      expect(card.updated).toBe(card.created);
      expect(readFileSync(path.join(vault.root, 'Cards/OP-13.md'), 'utf8').startsWith('---\nkey: OP-13\n')).toBe(true);
    });
  });

  it('new cards go to the bottom of their column, in the order they were made', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      for (const title of ['first new', 'second new', 'third new'])
        await call(server, 'create_card', { title, status: 'review' });
      const cards = (await (await reference(vault.root)).list()).filter((c) => c.status === 'review');
      expect(cards.slice(-3).map((c) => c.title)).toEqual(['first new', 'second new', 'third new']);
      expect(new Set(cards.map((c) => c.rank)).size).toBe(cards.length);
    });
  });

  it('`me` as an assignee is stored as the name of the board user, so the same word in a filter finds it', async () => {
    // Found by using the installed server: it stored the word "me", while the instructions say "me" is the user.
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const created = text(await call(server, 'create_card', { title: 'Mine', assignee: 'me' }));
      const key = /OP-\d+/.exec(created)![0];
      expect((await (await reference(vault.root)).get(key)).assignee).toBe(vault.config.me);

      await call(server, 'update_card', { key: 'OP-2', assignee: 'Bruno' });
      await call(server, 'update_card', { key: 'OP-2', assignee: 'ME' });
      expect((await (await reference(vault.root)).get('OP-2')).assignee).toBe(vault.config.me);

      const mine = text(await call(server, 'list_cards', { assignee: ['me'], limit: 200 }));
      expect(mine).toContain(key);
      expect(mine).toContain('OP-2 [');
      expect(mine).not.toContain('@me ');
    });
  });

  it('an update changes only what it names and keeps what a person added to the note by hand', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const file = path.join(vault.root, 'Cards/OP-3.md');
      const original = readFileSync(file, 'utf8');
      const edited = original.replace('\n---\n', '\n# a comment someone wrote\nmy-field: keep me   # trailing\n---\n');
      expect(edited).not.toBe(original);
      writeFileSync(file, edited);

      const out = await call(server, 'update_card', {
        key: 'OP-3',
        title: 'Renamed',
        priority: 'low',
        assignee: null,
        labels: ['x', 'y'],
      });
      expect(out.isError).toBeFalsy();

      const after = readFileSync(file, 'utf8');
      expect(after).toContain('# a comment someone wrote\nmy-field: keep me   # trailing\n');
      const card = await (await reference(vault.root)).get('OP-3');
      expect(card).toMatchObject({ title: 'Renamed', priority: 'low', labels: ['x', 'y'] });
      expect(card.assignee).toBeUndefined();
      expect(card.comments).toHaveLength(2); // the comments the vault builder wrote survived a description-free update
      expect(Date.parse(card.updated)).toBeGreaterThan(Date.parse('2026-10-15T12:00:00.000Z'));
    });
  });

  it('replacing the description keeps the comments, and the checklist follows', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      await call(server, 'update_card', { key: '5', body: 'New text.\n\n- [x] a\n- [x] b\n- [ ] c\n- [ ] d\n' });
      const card = await (await reference(vault.root)).get('OP-5');
      expect(card.body.trim()).toBe('New text.\n\n- [x] a\n- [x] b\n- [ ] c\n- [ ] d');
      expect(card.checklist).toEqual({ done: 2, total: 4 });
      expect(card.comments.map((c) => c.author)).toEqual(['Ana', 'Bruno']);
    });
  });

  it('moving to a done column resolves the card; moving away unresolves it; before/after orders it', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const ref = await reference(vault.root);
      await call(server, 'move_card', { key: 'OP-1', column: 'Done' });
      let card = await ref.get('OP-1');
      expect(card.status).toBe('done');
      expect(card.resolved).toBeTruthy();
      await call(server, 'move_card', { key: 'OP-1', column: 'To Do' });
      card = await ref.get('OP-1');
      expect(card.status).toBe('todo');
      expect(card.resolved).toBeUndefined();

      const todo = (await ref.list()).filter((c) => c.status === 'todo').map((c) => c.key);
      const target = todo.find((k) => k !== 'OP-1')!;
      await call(server, 'move_card', { key: 'OP-1', column: 'todo', before: target });
      const reordered = (await ref.list()).filter((c) => c.status === 'todo').map((c) => c.key);
      expect(reordered.indexOf('OP-1')).toBe(reordered.indexOf(target) - 1);
      await call(server, 'move_card', { key: 'OP-1', column: 'todo', after: target });
      const again = (await ref.list()).filter((c) => c.status === 'todo').map((c) => c.key);
      expect(again.indexOf('OP-1')).toBe(again.indexOf(target) + 1);
    });
  });

  it('comments are written as callouts the reference reads back, with ids the tools can use', async () => {
    await withServer({ cards: 12, args: ['--author', 'Claude'] }, async ({ server, vault }) => {
      const ref = await reference(vault.root);
      const added = text(await call(server, 'add_comment', { key: 'OP-2', text: 'Two lines.\n\n- and a list' }));
      const id = /Added comment (\S+) to OP-2 \(3 in all\)\./.exec(added)?.[1];
      expect(id).toBeTruthy();
      let card = await ref.get('OP-2');
      expect(card.comments.at(-1)).toMatchObject({ id, author: 'Claude', text: 'Two lines.\n\n- and a list' });
      expect(card.comments).toHaveLength(3);
      expect(readFileSync(path.join(vault.root, 'Cards/OP-2.md'), 'utf8')).toMatch(
        new RegExp(`> \\[!comment\\|${id},\\d{4}-\\d{2}-\\d{2}T[^\\]]+\\] Claude · `),
      );

      await call(server, 'edit_comment', { key: 'OP-2', comment_id: id, text: 'Edited.' });
      card = await ref.get('OP-2');
      expect(card.comments.at(-1)?.text).toBe('Edited.');
      expect(card.comments.at(-1)?.at).toBeTruthy();

      await call(server, 'delete_comment', { key: 'OP-2', comment_id: id });
      card = await ref.get('OP-2');
      expect(card.comments.map((c) => c.id)).toEqual(['c2a', 'c2b']);
    });
  });

  it('a comment line that looks like another comment header survives the round trip', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const tricky = 'before\n[!comment|fake,2026-01-01T00:00:00.000Z] Mallory\nafter';
      await call(server, 'add_comment', { key: 'OP-4', text: tricky });
      const card = await (await reference(vault.root)).get('OP-4');
      expect(card.comments).toHaveLength(3);
      expect(card.comments.at(-1)?.text).toBe(tricky);
    });
  });

  it('deleting moves the note to .trash, and the reference no longer finds it', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const out = text(await call(server, 'delete_card', { key: 'OP-6' }));
      expect(out).toContain('moved to the vault');
      expect(existsSync(path.join(vault.root, 'Cards/OP-6.md'))).toBe(false);
      expect(readdirSync(path.join(vault.root, '.trash'))).toContain('OP-6.md');
      await expect((await reference(vault.root)).get('OP-6')).rejects.toThrow('not found');
    });
  });

  it('many creations at once get distinct, consecutive keys', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => call(server, 'create_card', { title: `parallel ${i}` })),
      );
      expect(results.every((r) => !r.isError)).toBe(true);
      const keys = (await (await reference(vault.root)).list()).map((c) => c.key);
      expect(new Set(keys).size).toBe(32);
      expect(keys).toContain('OP-32');
    });
  });
});

describe('TypeScript writes, Rust reads', () => {
  it('get_card is always fresh: a note edited behind the server is read at once', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const ref = await reference(vault.root);
      await ref.update('OP-2', { title: 'Retitled by the reference implementation' });
      expect(text(await call(server, 'get_card', { key: 'OP-2' }))).toContain(
        '"Retitled by the reference implementation"',
      );
    });
  });

  it('the index picks up cards created, edited, moved and deleted by someone else', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const ref = await reference(vault.root);
      const listed = async () =>
        listedKeys(text(await call(server, 'list_cards', { limit: 200, include_archived: true })));
      expect(await listed()).toHaveLength(12);

      const created = await ref.create({ title: 'Made behind the server', status: 'review' });
      await eventually('the new card to be listed', async () => (await listed()).includes(created.key));

      await ref.update(created.key, { title: 'Edited behind the server', priority: 'highest' });
      await eventually('the edit to show', async () =>
        text(await call(server, 'list_cards', { text: 'edited behind' })).includes(created.key),
      );

      await ref.move(created.key, 'done');
      await eventually('the move to show', async () =>
        text(await call(server, 'list_cards', { status: 'done', text: 'behind' })).includes(created.key),
      );

      await ref.remove(created.key);
      await eventually('the deletion to show', async () => !(await listed()).includes(created.key));
    });
  });

  it('notes that are not cards, and hidden files, do not confuse the index', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      writeFileSync(path.join(vault.root, 'Cards/scratch.md'), '# just a note\nno frontmatter');
      writeFileSync(path.join(vault.root, 'Cards/.hidden.md'), '---\nkey: OP-77\ntitle: hidden\n---\n');
      writeFileSync(path.join(vault.root, 'Cards/broken.md'), '---\nkey: OP-78\ntitle: [unclosed\n---\n');
      await new Promise((resolve) => setTimeout(resolve, 600));
      const keys = listedKeys(text(await call(server, 'list_cards', { limit: 200 })));
      expect(keys).toHaveLength(12);
      expect(keys).not.toContain('OP-77');
    });
  });
});

// The same question put to the reference implementation and to the server must give the same cards, in the same order.
describe('the server agrees with the reference implementation', () => {
  const queries: { name: string; query: CardQuery; args: Record<string, unknown> }[] = [
    { name: 'no filter', query: {}, args: {} },
    { name: 'one column by id', query: { status: ['doing'] }, args: { status: 'doing' } },
    { name: 'two columns by name', query: { status: ['To Do', 'Review'] }, args: { status: ['To Do', 'Review'] } },
    { name: 'me', query: { assignee: ['me'] }, args: { assignee: 'me' } },
    { name: 'none', query: { assignee: ['none'] }, args: { assignee: 'none' } },
    { name: 'two names', query: { assignee: ['Bruno', 'Carla'] }, args: { assignee: ['Bruno', 'Carla'] } },
    { name: 'a label', query: { labels: ['ux'] }, args: { labels: ['ux'] } },
    { name: 'either of two labels', query: { labels: ['ux', 'backend'] }, args: { labels: ['ux', 'backend'] } },
    { name: 'a type', query: { type: ['bug'] }, args: { type: ['bug'] } },
    { name: 'priorities', query: { priority: ['highest', 'high'] }, args: { priority: ['highest', 'high'] } },
    { name: 'text, any case', query: { text: 'LOGIN' }, args: { text: 'LOGIN' } },
    { name: 'text with several words', query: { text: 'number 1 reasonably' }, args: { text: 'number 1 reasonably' } },
    { name: 'text in a comment', query: { text: 'safari' }, args: { text: 'safari' } },
    { name: 'text that matches nothing', query: { text: 'zzzz' }, args: { text: 'zzzz' } },
    {
      name: 'a combination',
      query: { status: ['doing', 'todo'], assignee: ['Ana'], labels: ['api'], type: ['task', 'story'] },
      args: { status: ['doing', 'todo'], assignee: ['Ana'], labels: ['api'], type: ['task', 'story'] },
    },
    { name: 'a parent that nobody has', query: { parent: 'OP-1' }, args: { parent: 'OP-1' } },
    { name: 'archived included', query: { includeArchived: true }, args: { include_archived: true } },
  ];

  it('returns the same cards in the same order for every query', async () => {
    await withServer({ cards: 60 }, async ({ server, vault }) => {
      const ref = await reference(vault.root);
      for (const { name, query, args } of queries) {
        const expected = (await ref.find(query)).map((c) => c.key);
        const answer = text(await call(server, 'list_cards', { ...args, limit: 200 }));
        expect(listedKeys(answer), name).toEqual(expected);
        const header =
          expected.length > 0 ? new RegExp(`^${expected.length} of ${expected.length} card`) : /^No cards match\.$/;
        expect(answer.split('\n')[0], name).toMatch(header);
      }
    });
  });

  it('describes each card with the same facts the reference reads', async () => {
    await withServer({ cards: 30 }, async ({ server, vault }) => {
      const cards = await (await reference(vault.root)).list();
      const answer = text(await call(server, 'list_cards', { limit: 200, include_archived: true }));
      const byKey = new Map(
        answer
          .split('\n')
          .slice(1)
          .map((line) => [/^(\S+) /.exec(line)![1]!, line]),
      );
      for (const card of cards) {
        const line = byKey.get(card.key)!;
        const fragments = [
          `[${card.status}] ${card.priority} ${card.type} "${card.title}"`,
          ...(card.assignee ? [` @${card.assignee}`] : []),
          ...(card.due ? [` due:${card.due}`] : []),
          ...(card.estimate !== undefined ? [` est:${card.estimate}`] : []),
          ...(card.labels.length ? [` labels:${card.labels.join(',')}`] : []),
          ...(card.checklist.total ? [` tasks:${card.checklist.done}/${card.checklist.total}`] : []),
          ...(card.comments.length ? [` comments:${card.comments.length}`] : []),
        ];
        for (const fragment of fragments) expect(line, `${card.key}: ${fragment}`).toContain(fragment);
      }
    });
  });

  it('refuses what the reference refuses, with the same message', async () => {
    await withServer({ cards: 12 }, async ({ server, vault }) => {
      const ref = await reference(vault.root);
      const message = async (op: () => Promise<unknown>) =>
        await op().then(
          () => '',
          (e: Error) => e.message,
        );
      const cases: [string, () => Promise<unknown>, { tool: string; args: Record<string, unknown> }][] = [
        [
          'an unknown column',
          () => ref.move('OP-1', 'limbo'),
          { tool: 'move_card', args: { key: 'OP-1', column: 'limbo' } },
        ],
        ['a missing card', () => ref.get('OP-999'), { tool: 'get_card', args: { key: 'OP-999' } }],
        ['a bad key', () => ref.get('nonsense'), { tool: 'get_card', args: { key: 'nonsense' } }],
        [
          'an empty comment',
          () => ref.addComment('OP-1', { text: '   ' }),
          { tool: 'add_comment', args: { key: 'OP-1', text: '   ' } },
        ],
        [
          'an unknown comment',
          () => ref.editComment('OP-1', 'nope', 'x'),
          { tool: 'edit_comment', args: { key: 'OP-1', comment_id: 'nope', text: 'x' } },
        ],
        [
          'a card as its own parent',
          () => ref.update('OP-1', { parent: 'OP-1' }),
          { tool: 'update_card', args: { key: 'OP-1', parent: 'OP-1' } },
        ],
        [
          'an unknown parent',
          () => ref.create({ title: 'x', parent: 'OP-999' }),
          { tool: 'create_card', args: { title: 'x', parent: 'OP-999' } },
        ],
        [
          'an unknown status',
          () => ref.create({ title: 'x', status: 'limbo' }),
          { tool: 'create_card', args: { title: 'x', status: 'limbo' } },
        ],
        ['an empty title', () => ref.create({ title: '   ' }), { tool: 'create_card', args: { title: '   ' } }],
      ];
      for (const [name, operation, { tool, args }] of cases) {
        const expected = await message(operation);
        expect(expected, `${name}: the reference should refuse`).not.toBe('');
        const result = await call(server, tool, args);
        expect(result.isError, name).toBe(true);
        expect(text(result), name).toBe(expected);
      }
    });
  });

  it('counts the board the way the reference does', async () => {
    await withServer({ cards: 60 }, async ({ server, vault }) => {
      const ref = await reference(vault.root);
      const config = await loadBoardConfig(vault.root);
      const visible = await ref.find({});
      const answer = text(await call(server, 'board_summary'));
      const head = answer.split('\n')[0]!;
      expect(head).toContain(`${visible.length} cards`);
      expect(head).toContain(`${visible.filter((c: Card) => !c.assignee).length} unassigned`);
      for (const column of config.columns) {
        const count = visible.filter((c) => c.status === column.id).length;
        expect(answer, column.id).toContain(`${column.id} "${column.name}": ${count}`);
      }
    });
  });
});

describe('read-only mode', () => {
  const fingerprint = (root: string): string[] => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir).sort()) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(`${path.relative(root, full)}:${readFileSync(full, 'utf8').length}:${statSync(full).mtimeMs}`);
      }
    };
    walk(root);
    return files;
  };

  it('cannot change the vault: every read works, every write is refused, and nothing on disk moves', async () => {
    await withServer({ cards: 20, args: ['--read-only'] }, async ({ server, vault }) => {
      const before = fingerprint(vault.root);
      await call(server, 'list_cards', { limit: 200 });
      await call(server, 'get_card', { key: 'OP-3' });
      await call(server, 'board_summary');
      for (const [tool, args] of [
        ['create_card', { title: 'nope' }],
        ['update_card', { key: 'OP-1', title: 'nope' }],
        ['move_card', { key: 'OP-1', column: 'done' }],
        ['delete_card', { key: 'OP-1' }],
        ['add_comment', { key: 'OP-1', text: 'nope' }],
        ['edit_comment', { key: 'OP-1', comment_id: 'c1a', text: 'nope' }],
        ['delete_comment', { key: 'OP-1', comment_id: 'c1a' }],
      ] as const) {
        await expect(call(server, tool, args)).rejects.toBeDefined();
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(fingerprint(vault.root)).toEqual(before);
    });
  });
});
