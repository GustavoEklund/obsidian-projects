// The HTTP mode (`--http`) of the real `oprojects-mcp` binary, as a client would use it: over TCP, with a bearer token,
// driven by plain `fetch` and by the official SDK client, and with every effect verified by reading the notes with the
// TypeScript core (the reference implementation), so Rust writes and TypeScript reads.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CardService } from '@oprojects/core';
import { FsStorage, loadBoardConfig } from '@oprojects/core/node';
import { createVault, type TestVault } from '../mcp/vault';
import { HttpServerProcess, TOKEN, callTool, eventually, rpc, toolText } from './http-support';
import { binaryPath } from './support';

interface Running {
  server: HttpServerProcess;
  vault: TestVault;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A throwaway vault and an HTTP server on it, both cleaned up after the test. */
async function start(
  options: { cards?: number; args?: string[]; env?: Record<string, string | undefined> } = {},
): Promise<Running> {
  const vault = await createVault(options.cards ?? 12);
  const args = options.args ?? ['--token', TOKEN];
  const server = await HttpServerProcess.start([...args, '--vault', vault.root], { env: options.env });
  cleanups.push(async () => {
    await server.stop('SIGKILL');
    vault.cleanup();
  });
  return { server, vault };
}

const reference = async (root: string): Promise<CardService> =>
  new CardService(new FsStorage(root), await loadBoardConfig(root));

async function connectSdk(url: string, token: string = TOKEN): Promise<Client> {
  const client = new Client({ name: 'http-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { authProvider: { token: async () => token } }));
  cleanups.push(() => client.close().catch(() => undefined));
  return client;
}

const sdkText = (result: { content?: unknown }): string =>
  ((result.content ?? []) as { type: string; text?: string }[]).map((c) => c.text ?? '').join('\n');

/** A fingerprint of every file in a folder (path, size, content hash). */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else
        out[path.relative(root, full)] =
          `${statSync(full).size}:${createHash('sha1').update(readFileSync(full)).digest('hex')}`;
    }
  };
  walk(root);
  return out;
}

describe('authentication', () => {
  it('refuses a request without the token, and says how to authenticate', async () => {
    const { server } = await start();
    const response = await rpc(server.url, 'tools/list', {}, { token: null });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(response.text).not.toContain(TOKEN);
  });

  it('refuses a wrong token and lets the right one in', async () => {
    const { server } = await start();
    expect((await rpc(server.url, 'tools/list', {}, { token: 'wrong-token-0123456789abcdef' })).status).toBe(401);
    expect((await rpc(server.url, 'tools/list', {}, { token: `${TOKEN}x` })).status).toBe(401);
    expect((await rpc(server.url, 'tools/list', {}, { token: TOKEN.toUpperCase() })).status).toBe(401);
    expect((await rpc(server.url, 'tools/list', {})).status).toBe(200);
  });

  it('refuses the official SDK client when it has no valid token', async () => {
    const { server } = await start();
    await expect(connectSdk(server.url, 'wrong-token-0123456789abcdef')).rejects.toBeDefined();
  });

  it('answers a request for any other path with 404 and any other method with 405', async () => {
    const { server } = await start();
    const other = await fetch(`http://127.0.0.1:${server.port}/other`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(other.status).toBe(404);
    const get = await fetch(server.url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
  });

  it('refuses a request whose Host or Origin is not this machine (DNS rebinding)', async () => {
    const { server } = await start();
    // `fetch` forbids setting Host, so this one goes through a raw socket.
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(server.port, '127.0.0.1');
      let data = '';
      socket.on('data', (d) => (data += d.toString('utf8')));
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
      const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      socket.write(
        `POST /mcp HTTP/1.1\r\nHost: evil.example.com\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      );
    });
    expect(raw.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    const foreign = await rpc(server.url, 'tools/list', {}, { headers: { origin: 'http://evil.example.com' } });
    expect(foreign.status).toBe(403);
    const own = await rpc(server.url, 'tools/list', {}, { headers: { origin: `http://127.0.0.1:${server.port}` } });
    expect(own.status).toBe(200);
  });
});

describe('the protocol over HTTP', () => {
  it('initializes with plain JSON, no session, and the instructions of the board', async () => {
    const { server } = await start();
    const response = await rpc(server.url, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fetch', version: '0' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    expect(response.headers.get('mcp-session-id')).toBeNull();
    expect(response.json.result.serverInfo.name).toBe('oprojects-mcp');
    expect(response.json.result.instructions).toContain('OP-12');
  });

  it('lists ten tools to the official SDK client, which also reads the board', async () => {
    const { server } = await start({ cards: 15 });
    const client = await connectSdk(server.url);
    expect(client.getServerVersion()).toMatchObject({ name: 'oprojects-mcp' });
    const { tools } = await client.listTools();
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
    const summary = await client.callTool({ name: 'board_summary', arguments: {} });
    expect(sdkText(summary)).toContain('Board OP (folder Cards): 15 cards');
  });

  it('reports a board error as a tool error and a bad tool name as a protocol error', async () => {
    const { server } = await start();
    const missing = await callTool(server.url, 'get_card', { key: 'OP-9999' });
    expect(missing.json.result.isError).toBe(true);
    expect(toolText(missing)).toContain('OP-9999');
    const unknown = await callTool(server.url, 'no_such_tool');
    expect(unknown.json.error).toBeDefined();
    const nonsense = await rpc(server.url, 'tools/call', { arguments: {} });
    expect(nonsense.json.error ?? nonsense.json.result?.isError).toBeTruthy();
  });

  it('survives garbage: odd bodies are client errors and the next request is served', async () => {
    const { server } = await start();
    for (const body of ['not json', '{', '[]', 'null', '{"jsonrpc":"2.0"}', '"x"']) {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${TOKEN}`,
        },
        body,
      });
      expect(response.status, body).toBeGreaterThanOrEqual(400);
      expect(response.status, body).toBeLessThan(500);
      await response.arrayBuffer();
    }
    expect((await rpc(server.url, 'tools/list', {})).status).toBe(200);
  });

  it('keeps stdout empty: in HTTP mode only stderr speaks, and it never prints the token', async () => {
    const { server } = await start();
    await callTool(server.url, 'board_summary');
    await rpc(server.url, 'tools/list', {}, { token: 'wrong-token-0123456789abcdef' });
    expect(server.stdout).toBe('');
    expect(server.stderr).not.toContain(TOKEN);
    expect(server.stderr).not.toContain('wrong-token');
  });
});

describe('a full workflow, verified with the TypeScript core', () => {
  it('creates, reads, updates, moves, comments and deletes a card over HTTP', async () => {
    const { server, vault } = await start();
    const client = await connectSdk(server.url);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, `${name}: ${sdkText(result)}`).toBeFalsy();
      return sdkText(result);
    };
    const core = await reference(vault.root);
    const before = (await core.list()).length;

    const created = await call('create_card', {
      title: 'Written by Rust, read by TypeScript',
      type: 'bug',
      priority: 'high',
      labels: ['http'],
      due: '2026-12-24',
    });
    const key = /^Created: (\S+) /.exec(created)![1]!;
    let card = await core.get(key);
    expect(card).toMatchObject({
      title: 'Written by Rust, read by TypeScript',
      type: 'bug',
      priority: 'high',
      labels: ['http'],
      due: '2026-12-24',
      status: 'todo',
    });
    expect(await core.list()).toHaveLength(before + 1);

    expect(await call('get_card', { key })).toContain('Written by Rust, read by TypeScript');

    await call('update_card', {
      key,
      title: 'Renamed over HTTP',
      assignee: 'Ana',
      body: '- [x] first\n- [ ] second\n',
    });
    card = await core.get(key);
    expect(card).toMatchObject({ title: 'Renamed over HTTP', assignee: 'Ana', checklist: { done: 1, total: 2 } });

    await call('move_card', { key, column: 'Review' });
    expect((await core.get(key)).status).toBe('review');

    await call('add_comment', { key, text: 'Looks **good**', author: 'Claude' });
    card = await core.get(key);
    expect(card.comments.map((c) => [c.author, c.text])).toEqual([['Claude', 'Looks **good**']]);
    expect(card.body).toContain('- [x] first'); // adding a comment never touches the description

    await call('delete_card', { key });
    await expect(core.get(key)).rejects.toThrow(`${key} not found`);
    expect(existsSync(path.join(vault.root, '.trash', `${key}.md`))).toBe(true);
    expect(await core.list()).toHaveLength(before);
  });

  it('sees a card that TypeScript wrote after the server started', async () => {
    const { server, vault } = await start();
    const core = await reference(vault.root);
    const made = await core.create({
      title: 'Written by TypeScript, read by Rust',
      status: 'doing',
      assignee: 'Bruno',
    });
    // A single card is always read from its note.
    expect(toolText(await callTool(server.url, 'get_card', { key: made.key }))).toContain(
      'Written by TypeScript, read by Rust',
    );
    // The lists come from the index, which follows the file system events.
    await eventually(async () =>
      toolText(await callTool(server.url, 'list_cards', { text: 'read by Rust' })).includes(made.key),
    );
  });
});

describe('several clients at once', () => {
  it('serves two SDK clients that create cards at the same time: every card exists, with unique keys', async () => {
    const { server, vault } = await start();
    const [one, two] = await Promise.all([connectSdk(server.url), connectSdk(server.url)]);
    const core = await reference(vault.root);
    const before = (await core.list()).length;
    const created = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 ? one : two).callTool({ name: 'create_card', arguments: { title: `Parallel ${i}` } }),
      ),
    );
    const keys = created.map((r) => /^Created: (\S+) /.exec(sdkText(r))?.[1]);
    expect(keys.every(Boolean)).toBe(true);
    expect(new Set(keys).size).toBe(24);
    const after = await core.list();
    expect(after).toHaveLength(before + 24);
    for (const key of keys) expect(after.some((c) => c.key === key)).toBe(true);
  });

  it('serves many plain connections at once', async () => {
    const { server } = await start();
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, i) => callTool(server.url, 'board_summary', {}, { id: i + 1 })),
    );
    answers.forEach((answer, i) => {
      expect(answer.status).toBe(200);
      expect(answer.json.id).toBe(i + 1);
    });
  });
});

describe('--read-only', () => {
  it('offers only the three reading tools and refuses the rest, leaving every file as it was', async () => {
    const { server, vault } = await start({ args: ['--token', TOKEN, '--read-only'] });
    const before = fingerprint(vault.root);
    const client = await connectSdk(server.url);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['board_summary', 'get_card', 'list_cards']);
    for (const [name, args] of [
      ['create_card', { title: 'no' }],
      ['update_card', { key: 'OP-1', title: 'no' }],
      ['move_card', { key: 'OP-1', column: 'done' }],
      ['delete_card', { key: 'OP-1' }],
      ['add_comment', { key: 'OP-1', text: 'no' }],
    ] as const) {
      expect((await callTool(server.url, name, args)).json.error, name).toBeDefined();
    }
    expect(sdkText(await client.callTool({ name: 'board_summary', arguments: {} }))).toContain('Board OP');
    expect(fingerprint(vault.root)).toEqual(before);
  });
});

describe('tokens', () => {
  it('generates a token when none is given, shows it once, and it works', async () => {
    const vault = await createVault(5);
    cleanups.push(() => vault.cleanup());
    const server = await HttpServerProcess.start(['--vault', vault.root]);
    cleanups.push(() => server.stop('SIGKILL').then(() => undefined));
    const token = /token \(generated for this run only\): ([0-9a-f]{64})/.exec(server.stderr)?.[1];
    expect(token, server.stderr).toBeDefined();
    expect(server.stderr).toContain(`Bearer ${token}`);
    expect(server.stderr).toContain('claude mcp add --transport http obsidian-projects');
    expect((await rpc(server.url, 'tools/list', {}, { token: token! })).status).toBe(200);
    expect((await rpc(server.url, 'tools/list', {}, { token: null })).status).toBe(401);

    const second = await HttpServerProcess.start(['--vault', vault.root]);
    cleanups.push(() => second.stop('SIGKILL').then(() => undefined));
    expect(/generated for this run only\): ([0-9a-f]{64})/.exec(second.stderr)?.[1]).not.toBe(token);
  });

  it('takes the token from the environment and never prints it', async () => {
    const secret = 'from-the-environment-0123456789';
    const { server } = await start({ args: [], env: { OPROJECTS_MCP_TOKEN: secret } });
    expect((await rpc(server.url, 'tools/list', {}, { token: secret })).status).toBe(200);
    expect(server.stderr).not.toContain(secret);
    expect(server.stderr).toContain('<your token>');
  });

  it('keeps the token in a file: created readable by its owner only, then reused by the next start', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oprojects-token-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'mcp.token');
    const first = await start({ args: ['--token-file', file] });
    expect(first.server.stderr).toContain(`token file ${file} (created)`);
    const token = readFileSync(file, 'utf8').trim();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(first.server.stderr).not.toContain(token);
    expect((await rpc(first.server.url, 'tools/list', {}, { token })).status).toBe(200);
    await first.server.stop();

    const second = await start({ args: ['--token-file', file] });
    expect(second.server.stderr).toContain(`token file ${file} (in use)`);
    expect(second.server.stderr).not.toContain(token);
    expect((await rpc(second.server.url, 'tools/list', {}, { token })).status).toBe(200);
    expect(readFileSync(file, 'utf8').trim()).toBe(token);
    expect(second.server.stderr).toContain(`$(cat ${file})`);
  });

  it('refuses to start with a token that is too short, without echoing it, and a bad token file', async () => {
    const vault = await createVault(3);
    cleanups.push(() => vault.cleanup());
    const short = await HttpServerProcess.start(['--token', 'tooshort-secret', '--vault', vault.root]).catch(
      (e: Error) => e,
    );
    expect(short).toBeInstanceOf(Error);
    expect((short as Error).message).toContain('exited (code 2');
    expect((short as Error).message).toContain('at least 16');
    expect((short as Error).message).not.toContain('tooshort-secret');

    const dir = mkdtempSync(path.join(tmpdir(), 'oprojects-token-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const garbage = path.join(dir, 'garbage');
    writeFileSync(garbage, 'short\n');
    const bad = await HttpServerProcess.start(['--token-file', garbage, '--vault', vault.root]).catch((e: Error) => e);
    expect((bad as Error).message).toContain('exited (code 1');
    expect((bad as Error).message).toContain('is not a token file');
  });
});

describe('starting and stopping', () => {
  it('stops cleanly on SIGTERM, and on SIGINT, and stops listening', async () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const { server } = await start();
      expect((await rpc(server.url, 'tools/list', {})).status).toBe(200);
      const started = Date.now();
      const exit = await server.stop(signal);
      expect(exit, signal).toEqual({ code: 0, signal: null });
      expect(Date.now() - started, signal).toBeLessThan(3000);
      await expect(fetch(server.url, { method: 'POST' })).rejects.toBeDefined();
      expect(server.stdout).toBe('');
    }
  });

  it('says so and exits with an error when the port is taken', async () => {
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => taken.close(() => resolve())));
    const port = (taken.address() as net.AddressInfo).port;
    const vault = await createVault(3);
    cleanups.push(() => vault.cleanup());
    const failure = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      // Not HttpServerProcess: it asks for port 0 itself, and this test needs a chosen port.
      const child = spawn(binaryPath(), ['--http', '--port', String(port), '--token', TOKEN, '--vault', vault.root], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain(`cannot listen on 127.0.0.1:${port}`);
    expect(failure.stderr).toContain('--port 0');
  });

  it('rejects the HTTP flags without --http, and documents the mode in --help', async () => {
    const flags = spawnSync(binaryPath(), ['--port', '9000'], { encoding: 'utf8' });
    expect(flags.status).toBe(2);
    expect(flags.stderr).toContain('--port only applies with --http');
    const help = spawnSync(binaryPath(), ['--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--http');
    expect(help.stdout).toContain('127.0.0.1 only');
    expect(help.stdout).toContain('claude mcp add --transport http');
  });
});

describe('weight', () => {
  it('stays small idle and does not grow under 500 requests', async () => {
    const { server } = await start({ cards: 12 });
    await callTool(server.url, 'board_summary'); // warm up: the first request builds what the next ones reuse
    await new Promise((resolve) => setTimeout(resolve, 300));
    const idle = server.rssMB();
    for (let i = 0; i < 500; i++) {
      const response =
        i % 2 ? await callTool(server.url, 'list_cards', { limit: 3 }) : await callTool(server.url, 'board_summary');
      expect(response.status).toBe(200);
    }
    const after = server.rssMB();
    console.log(`HTTP server: idle ${idle.toFixed(1)} MB, after 500 requests ${after.toFixed(1)} MB`);
    expect(idle).toBeLessThanOrEqual(8);
    expect(after - idle).toBeLessThanOrEqual(3);
  });
});
