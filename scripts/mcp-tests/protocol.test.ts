// The protocol surface of the real binary, driven by our own small client: handshake, tools/list, errors, and what
// happens when the input is not what a client would send. The official SDK client is the second, independent judge
// (sdk-conformance.test.ts).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { McpProcess, RpcError } from '../mcp/client';
import { at } from '../quality/lib';
import { binaryPath, repoVersion, withServer } from './support';

const SNAPSHOT = at('scripts/mcp-tests/tools.snapshot.json');

describe('the handshake', () => {
  it('answers initialize with its identity, only the tools capability, and instructions about the board', async () => {
    await withServer({ initialize: false }, async ({ server }) => {
      const init = await server.initialize('2025-06-18');
      expect(init.protocolVersion).toBe('2025-06-18');
      expect(init.serverInfo).toEqual({ name: 'oprojects-mcp', version: repoVersion() });
      expect(Object.keys(init.capabilities)).toEqual(['tools']);
      expect(init.instructions).toContain('OP-12');
      expect(init.instructions).toContain('todo "To Do"');
      expect(init.instructions).toContain('"me" means Ana');
    });
  });

  it('negotiates down to a protocol version it supports, and offers its own when asked for an unknown one', async () => {
    for (const asked of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2099-01-01']) {
      await withServer({ initialize: false }, async ({ server }) => {
        const init = await server.initialize(asked);
        expect(init.protocolVersion, asked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect((await server.listTools()).length, asked).toBe(10);
      });
    }
  });

  it('answers ping', async () => {
    await withServer({}, async ({ server }) => {
      await expect(server.request('ping')).resolves.toEqual({});
    });
  });

  it('starts fast and stays small', async () => {
    await withServer({ cards: 12 }, async ({ server }) => {
      expect(server.startupMs).toBeLessThan(250); // the budget gate is stricter; this only catches a disaster
      expect(server.rssMB()).toBeLessThan(25);
    });
  });
});

describe('tools/list', () => {
  const view = (tools: Awaited<ReturnType<McpProcess['listTools']>>) => JSON.parse(JSON.stringify(tools)) as unknown;

  it('matches the committed snapshot: a change to the tools is deliberate', async () => {
    await withServer({}, async ({ server }) => {
      const tools = view(await server.listTools());
      if (process.env.UPDATE_MCP_SNAPSHOT) writeFileSync(SNAPSHOT, `${JSON.stringify(tools, null, 2)}\n`);
      expect(tools).toEqual(JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
    });
  });

  it('offers only the three reads in read-only mode, and the writes are unknown tools', async () => {
    await withServer({ args: ['--read-only'] }, async ({ server }) => {
      expect((await server.listTools()).map((t) => t.name)).toEqual(['board_summary', 'get_card', 'list_cards']);
      for (const write of [
        'create_card',
        'update_card',
        'move_card',
        'delete_card',
        'add_comment',
        'edit_comment',
        'delete_comment',
      ]) {
        await expect(
          server.callTool(write, { key: 'OP-1', title: 'x', text: 'x', column: 'done', comment_id: 'c' }),
        ).rejects.toBeInstanceOf(RpcError);
      }
    });
  });
});

describe('errors', () => {
  it('answers an unknown method with "method not found", and the lists it does not have with empty ones', async () => {
    await withServer({}, async ({ server }) => {
      await expect(server.request('nonsense/method')).rejects.toMatchObject({ code: -32601 });
      await expect(server.request('completion/complete', {})).rejects.toBeInstanceOf(RpcError);
      // The capabilities do not include resources or prompts; the protocol layer still answers the list calls, with nothing.
      await expect(server.request('resources/list')).resolves.toEqual({ resources: [] });
      await expect(server.request('prompts/list')).resolves.toEqual({ prompts: [] });
    });
  });

  it('answers an unknown tool with a protocol error, but a tool that fails with a tool error the model can read', async () => {
    await withServer({}, async ({ server }) => {
      await expect(server.callTool('frobnicate')).rejects.toMatchObject({ code: -32602 });
      const missing = await server.callTool('get_card', { key: 'OP-9999' });
      expect(missing.isError).toBe(true);
      expect(McpProcess.text(missing)).toBe('Card OP-9999 not found');
      const bad = await server.callTool('create_card', { titel: 'x' });
      expect(bad.isError).toBe(true);
      expect(McpProcess.text(bad)).toMatch(/unknown field `titel`|missing field `title`/);
    });
  });
});

describe('stdout belongs to the protocol', () => {
  it('stays pure JSON-RPC whatever it is fed, and keeps serving', async () => {
    await withServer({}, async ({ server }) => {
      const noise = [
        'this is not json\n',
        '\n',
        '{}\n',
        '{"jsonrpc":"2.0","id":9001}\n',
        '{"jsonrpc":"2.0","id":9002,"method":42}\n',
        '[{"jsonrpc":"2.0","id":9003,"method":"ping"}]\n',
        `${'x'.repeat(200_000)}\n`,
        '{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":123456}}\n',
        '{"jsonrpc":"2.0","method":"notifications/never-heard-of-it"}\n',
      ];
      for (const line of noise) server.sendRaw(line);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(server.badStdout).toEqual([]);
      // Whatever it did with the noise, if it is still running it must still answer properly.
      const stillServing = server.exitInfo ? {} : await server.request('ping', {}, 3000);
      expect(stillServing).toEqual({});
      expect(server.badStdout).toEqual([]);
    });
  });

  it('writes nothing to stdout while serving normally, even with debug logging on (that goes to stderr)', async () => {
    await withServer({ env: { OPROJECTS_LOG: 'debug' } }, async ({ server }) => {
      await server.callTool('board_summary');
      await server.callTool('list_cards', { limit: 2 });
      expect(server.badStdout).toEqual([]);
      expect(server.stderr).toContain('oprojects-mcp: serving board OP');
    });
  });

  it('is silent on stderr by default', async () => {
    await withServer({}, async ({ server }) => {
      await server.callTool('board_summary');
      expect(server.stderr).toBe('');
    });
  });
});

describe('lifetime', () => {
  it('exits cleanly, promptly, when the client closes its end', async () => {
    await withServer({}, async ({ server }) => {
      const started = performance.now();
      server.endInput();
      const exit = await server.waitForExit(3000);
      expect(exit.code).toBe(0);
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });

  it('exits cleanly when the client leaves before ever saying hello', async () => {
    await withServer({ initialize: false }, async ({ server }) => {
      server.endInput();
      expect((await server.waitForExit(3000)).code).toBe(0);
    });
  });
});

describe('the command line', () => {
  const run = (args: string[], cwd?: string) =>
    spawnSync(binaryPath(), args, { encoding: 'utf8', cwd, env: { ...process.env, OPROJECTS_VAULT: '' } });

  it('prints its version and exits 0', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`oprojects-mcp ${repoVersion()}\n`);
  });

  it('prints help with the command to add it to Claude Code', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('claude mcp add obsidian-projects -- oprojects-mcp --vault /path/to/your/vault');
    expect(run(['-h']).stdout).toBe(r.stdout);
  });

  it('rejects an unknown option: exit 2, a message on stderr, nothing on stdout', () => {
    const r = run(['--frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('unknown option "--frobnicate"');
    expect(run(['--vault']).stderr).toContain('--vault needs a value');
  });

  it('fails clearly, with nothing on stdout, when there is no vault', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'oprojects-novault-'));
    try {
      const r = run([], empty);
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('No Obsidian vault found');
      const wrong = run(['--vault', empty]);
      expect(wrong.status).toBe(1);
      expect(wrong.stderr).toContain('is not an Obsidian vault');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('finds the vault from the folder it is started in, and from OPROJECTS_VAULT', async () => {
    await withServer({ initialize: false }, async ({ vault }) => {
      const inside = path.join(vault.root, 'Cards');
      const here = McpProcess.start(binaryPath(), [], { cwd: inside, env: { OPROJECTS_VAULT: '' } });
      const fromEnv = McpProcess.start(binaryPath(), [], { cwd: tmpdir(), env: { OPROJECTS_VAULT: vault.root } });
      try {
        expect((await here.initialize()).instructions).toContain('OP-12');
        expect((await fromEnv.initialize()).instructions).toContain('OP-12');
      } finally {
        await here.close();
        await fromEnv.close();
      }
    });
  });

  it('signs agent comments with --author, or OPROJECTS_AUTHOR, or "Agent"', async () => {
    const author = async (args: string[], env: Record<string, string>) =>
      withServer({ args, env }, async ({ server }) => {
        await server.callTool('add_comment', { key: 'OP-1', text: 'hello' });
        const card = McpProcess.text(await server.callTool('get_card', { key: 'OP-1' }));
        return /\n- \S+ \(([^,)]+)[,)][^\n]*: hello/.exec(card)?.[1];
      });
    expect(await author([], {})).toBe('Agent');
    expect(await author([], { OPROJECTS_AUTHOR: 'EnvBot' })).toBe('EnvBot');
    expect(await author(['--author', 'FlagBot'], { OPROJECTS_AUTHOR: 'EnvBot' })).toBe('FlagBot');
  });
});
