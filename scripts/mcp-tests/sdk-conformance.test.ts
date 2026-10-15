// The official MCP SDK client as an independent judge of the protocol: if it connects, lists and calls without complaint,
// the server speaks MCP the way the rest of the world does (our own test client could share a blind spot with the server).
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { createVault, type TestVault } from '../mcp/vault';
import { binaryPath, repoVersion } from './support';

let vault: TestVault | undefined;
let client: Client | undefined;

async function connect(args: string[] = []): Promise<Client> {
  vault = await createVault(15);
  const transport = new StdioClientTransport({
    command: binaryPath(),
    args: ['--vault', vault.root, ...args],
    stderr: 'pipe',
  });
  client = new Client({ name: 'sdk-conformance', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = undefined;
  vault?.cleanup();
  vault = undefined;
});

const textOf = (result: { content?: unknown }): string =>
  ((result.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');

describe('the official SDK client', () => {
  it('connects, and sees who it is talking to and what it was told', async () => {
    const c = await connect();
    expect(c.getServerVersion()).toMatchObject({ name: 'oprojects-mcp', version: repoVersion() });
    expect(c.getServerCapabilities()?.tools).toBeDefined();
    expect(c.getServerCapabilities()?.resources).toBeUndefined();
    expect(c.getInstructions()).toContain('OP-12');
  });

  it('lists ten tools with object schemas and annotations', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_comment',
      'board_summary',
      'create_card',
      'delete_card',
      'delete_comment',
      'edit_comment',
      'get_card',
      'list_cards',
      'move_card',
      'update_card',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
    expect(
      tools
        .filter((t) => t.annotations?.readOnlyHint === true)
        .map((t) => t.name)
        .sort(),
    ).toEqual(['board_summary', 'get_card', 'list_cards']);
  });

  it('calls tools and gets text back', async () => {
    const c = await connect();
    const summary = await c.callTool({ name: 'board_summary', arguments: {} });
    expect(summary.isError).toBeFalsy();
    expect(textOf(summary)).toContain('Board OP (folder Cards): 15 cards');
    const list = await c.callTool({ name: 'list_cards', arguments: { status: 'doing', limit: 3 } });
    expect(textOf(list)).toMatch(/^3 of \d+ cards/);
    const one = await c.callTool({ name: 'get_card', arguments: { key: 'OP-7' } });
    expect(textOf(one)).toContain('login redirect');
  });

  it('reports a failing tool as a tool error, and an unknown tool as a rejected call', async () => {
    const c = await connect();
    const missing = await c.callTool({ name: 'get_card', arguments: { key: 'OP-9999' } });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('Card OP-9999 not found');
    await expect(c.callTool({ name: 'frobnicate', arguments: {} })).rejects.toThrow('tool not found');
  });

  it('writes through the protocol', async () => {
    const c = await connect();
    const created = await c.callTool({
      name: 'create_card',
      arguments: { title: 'Made by the SDK client', due: 'tomorrow' },
    });
    expect(created.isError).toBeFalsy();
    expect(textOf(created)).toMatch(
      /^Created: OP-16 \[todo\] medium task "Made by the SDK client" due:\d{4}-\d{2}-\d{2}/,
    );
  });

  it('answers ping, and a read-only server offers only the reads', async () => {
    const c = await connect(['--read-only']);
    await expect(c.ping()).resolves.toBeDefined();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(['board_summary', 'get_card', 'list_cards']);
    expect(c.getInstructions()).toContain('read-only');
  });
});
