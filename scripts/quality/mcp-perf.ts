// Performance gate of the Rust MCP server: the reason it exists is a tiny memory footprint and instant responses, so
// those are budgets that fail CI, measured on the real release binary against a realistic vault.
//
//   npm run build -w packages/mcp && npm run check:mcp-perf [-- --cards 2000] [-- --bin <path>] [-- --json]
//
// Budgets are deliberately loose (CI machines are noisy): they catch a regression of an order of magnitude, such as a
// heavy dependency pulled in or an accidental O(n) scan per call, not a few percent.
import { existsSync } from 'node:fs';
import { McpProcess } from '../mcp/client';
import { createVault } from '../mcp/vault';
import { at, finish, isMain } from './lib';
import { overBudget, percentile, report, type Measurements } from './mcp-perf-lib';

async function timed(work: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await work();
  return performance.now() - started;
}

async function repeat(times: number, work: (i: number) => Promise<unknown>): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) samples.push(await timed(() => work(i)));
  return samples;
}

/** Runs every scenario against `bin` on a fresh vault of `cards` cards. */
export async function measure(bin: string, cards: number): Promise<Measurements> {
  const vault = await createVault(cards);
  const server = McpProcess.start(bin, ['--vault', vault.root]);
  try {
    await server.initialize();
    const initializeMs = server.startupMs;
    const idleRssMB = server.rssMB();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await server.callTool(name, args, 30_000);
      if (result.isError) throw new Error(`${name} failed: ${McpProcess.text(result)}`);
      return result;
    };

    // The index loads in the background: the first call that needs it waits for it.
    const firstListMs = await timed(() => call('list_cards', { limit: 50 }));
    const indexedRssMB = server.rssMB();

    const reads = [
      ...(await repeat(60, (i) =>
        call('list_cards', { status: ['In Progress'], limit: 50, assignee: i % 2 ? ['me'] : ['none', 'Bruno'] }),
      )),
      ...(await repeat(60, (i) => call('get_card', { key: String(1 + ((i * 37) % cards)) }))),
      ...(await repeat(30, () => call('board_summary'))),
    ];
    const searches = await repeat(30, (i) =>
      call('list_cards', { text: i % 2 ? 'login redirect' : 'SSO query string', limit: 20 }),
    );

    const concurrentMs = await timed(() =>
      Promise.all(
        Array.from({ length: 20 }, (_, i) => call('list_cards', { limit: 10, labels: [i % 2 ? 'api' : 'ux'] })),
      ),
    );

    const before = server.rssMB();
    const writes: number[] = [];
    const created: string[] = [];
    for (let i = 0; i < 60; i++) {
      writes.push(
        await timed(async () => {
          const text = McpProcess.text(
            await call('create_card', { title: `Created by the performance gate ${i}`, labels: ['perf'] }),
          );
          created.push(/OP-\d+/.exec(text)![0]);
        }),
      );
    }
    for (const key of created) {
      writes.push(await timed(() => call('update_card', { key, title: `Renamed ${key}`, priority: 'high' })));
      writes.push(await timed(() => call('move_card', { key, column: 'In Progress' })));
      writes.push(
        await timed(() => call('add_comment', { key, text: 'A comment from the performance gate.', author: 'perf' })),
      );
    }
    const writeGrowthMB = server.rssMB() - before;

    return {
      cards,
      idleRssMB,
      initializeMs,
      indexedRssMB,
      firstListMs,
      readP95Ms: percentile(reads, 95),
      searchP95Ms: percentile(searches, 95),
      writeP95Ms: percentile(writes, 95),
      writeGrowthMB,
      concurrentMs,
    };
  } finally {
    await server.close();
    vault.cleanup();
  }
}

if (isMain(import.meta.url)) {
  const arg = (name: string) => {
    const position = process.argv.indexOf(name);
    return position >= 0 ? process.argv[position + 1] : undefined;
  };
  const bin = arg('--bin') ?? at('packages/mcp/target/release/oprojects-mcp');
  const cards = Number(arg('--cards') ?? 2000);
  if (!existsSync(bin)) {
    console.error(`${bin} does not exist: build it first with \`npm run build -w packages/mcp\`.`);
    process.exit(2);
  }
  measure(bin, cards)
    .then((m) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(m, null, 2));
      else console.log(report(m));
      finish('MCP performance gate', overBudget(m));
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
