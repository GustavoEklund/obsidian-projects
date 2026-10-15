import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsStorage, loadBoardConfig } from '@oprojects/core/node';
import { CardService } from '@oprojects/core';
import { McpProcess, RpcError } from '../mcp/client';
import { createVault } from '../mcp/vault';
import { at } from '../quality/lib';

const FAKE = at('scripts/test/fixtures/fake-mcp-server.mjs');
const open: McpProcess[] = [];
const start = (env: Record<string, string> = {}) => {
  const p = McpProcess.start(process.execPath, [FAKE], { env });
  open.push(p);
  return p;
};
afterEach(async () => {
  await Promise.all(open.splice(0).map((p) => p.close(500)));
});

describe('McpProcess', () => {
  it('initializes, echoing the protocol version, and records the startup time', async () => {
    const p = start();
    const init = await p.initialize('2025-11-25');
    expect(init.protocolVersion).toBe('2025-11-25');
    expect(init.serverInfo).toEqual({ name: 'fake', version: '1.2.3' });
    expect(p.startupMs).toBeGreaterThan(0);
  });

  it('follows pagination when listing tools', async () => {
    const p = start();
    await p.initialize();
    expect((await p.listTools()).map((t) => t.name)).toEqual(['tool_1', 'tool_2', 'tool_3']);
  });

  it('calls a tool and joins the text parts of the result', async () => {
    const p = start();
    await p.initialize();
    const result = await p.callTool('anything', { a: 1 });
    expect(McpProcess.text(result)).toBe('called anything\n{"a":1}');
  });

  it('keeps the notifications the server sends', async () => {
    const p = start();
    await p.initialize();
    await p.callTool('x');
    expect(p.notifications).toEqual([{ method: 'notifications/message', params: { level: 'info', data: 'called' } }]);
  });

  it('turns a JSON-RPC error into an RpcError with its code and data', async () => {
    const p = start();
    await p.initialize();
    const error = await p.callTool('boom').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error).toMatchObject({ code: -32602, message: 'Invalid params', data: { field: 'x' } });
    await expect(p.request('nope')).rejects.toMatchObject({ code: -32601 });
  });

  it('matches concurrent requests to their own answers', async () => {
    const p = start();
    await p.initialize();
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((n) => p.callTool(n)));
    expect(results.map((r) => McpProcess.text(r).split('\n')[0])).toEqual([
      'called a',
      'called b',
      'called c',
      'called d',
    ]);
  });

  it('times out a request the server never answers, and says so', async () => {
    const p = start({ FAKE_SILENT: '1' });
    await p.initialize();
    await expect(p.callTool('x', {}, 150)).rejects.toThrow('tools/call timed out after 150 ms');
  });

  it('rejects pending requests, with the stderr, when the server exits', async () => {
    const p = start({ FAKE_EXIT_AFTER_INIT: '1' });
    await p.initialize();
    await expect(p.callTool('x')).rejects.toThrow(/server (exited|has exited)/);
    expect(p.exitInfo?.code).toBe(3);
  });

  it('fails loudly when the server writes something that is not JSON on stdout', async () => {
    const p = start({ FAKE_GARBAGE: '1' });
    await expect(p.request('initialize', { protocolVersion: '2025-06-18' })).rejects.toThrow('not JSON on stdout');
  });

  it('reports the resident memory of the server', async () => {
    const p = start();
    await p.initialize();
    const rss = p.rssMB();
    expect(rss).toBeGreaterThan(5);
    expect(rss).toBeLessThan(500);
  });

  it('closes a server politely by ending its stdin, and close is idempotent', async () => {
    const p = start();
    await p.initialize();
    await p.close();
    expect(p.exitInfo).not.toBeNull();
    await p.close();
  });
});

describe('createVault', () => {
  it('writes the requested number of cards, and the reference core reads them back', async () => {
    const vault = await createVault(40);
    try {
      const config = await loadBoardConfig(vault.root);
      expect(config.prefix).toBe('OP');
      const service = new CardService(new FsStorage(vault.root), config);
      const cards = await service.list();
      expect(cards).toHaveLength(40);
      const one = await service.get('OP-7');
      expect(one.title).toContain('login redirect');
      expect(one.comments).toHaveLength(2);
      expect(one.checklist).toEqual({ done: 1, total: 3 });
      expect(new Set(cards.map((c) => c.status))).toEqual(new Set(['todo', 'doing', 'review', 'done']));
    } finally {
      vault.cleanup();
    }
  });

  it('is deterministic apart from the folder it lives in, and cleans up after itself', async () => {
    const a = await createVault(5, { prefix: 'ZZ', me: 'Bruno' });
    const b = await createVault(5, { prefix: 'ZZ', me: 'Bruno' });
    try {
      const read = async (root: string) => new CardService(new FsStorage(root), await loadBoardConfig(root)).list();
      expect(await read(a.root)).toEqual(await read(b.root));
      expect(path.basename(a.root)).toMatch(/^oprojects-mcp-vault-/);
    } finally {
      a.cleanup();
      b.cleanup();
    }
    await expect(new FsStorage(a.root).listMarkdown('Cards')).resolves.toEqual([]);
  });
});
