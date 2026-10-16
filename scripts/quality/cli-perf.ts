// Performance gate of the Rust command line: it replaced a Node program, so the reason it exists is a start that feels
// instant and a small executable. Budgets are measured on the real release binary against a realistic vault, and are
// deliberately loose (CI machines are noisy): they catch a regression of an order of magnitude, such as a heavy
// dependency pulled in or a scan of the whole vault where one note would do.
//
//   npm run build -w packages/mcp && npm run check:cli-perf [-- --cards 2000] [-- --bin <path>] [-- --json]
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { createVault } from '../mcp/vault';
import { at, finish, isMain } from './lib';
import { median, overBudget, report, type Measurements } from './cli-perf-lib';

/** The wall-clock milliseconds of one run of the program, which must succeed. */
function timeRun(bin: string, args: string[], cwd: string): number {
  const started = performance.now();
  const ran = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, OPROJECTS_VAULT: '', NO_COLOR: '1' },
  });
  const elapsed = performance.now() - started;
  if (ran.status !== 0)
    throw new Error(`oprojects ${args.join(' ')} failed (${ran.status}): ${ran.error?.message ?? ran.stderr}`);
  return elapsed;
}

const times = (count: number, work: (i: number) => number) => Array.from({ length: count }, (_, i) => work(i));

/** Runs every scenario against `bin` on a fresh vault of `cards` cards. */
export async function measure(bin: string, cards: number): Promise<Measurements> {
  const vault = await createVault(cards);
  const vaultArgs = ['--vault', vault.root];
  const run = (args: string[]) => timeRun(bin, [...args, ...vaultArgs], vault.root);
  try {
    run(['list']); // warm the file cache
    return {
      cards,
      startupMs: median(times(20, () => run(['--version']))),
      listMs: median(times(7, () => run(['list', '--all']))),
      showMs: median(times(15, (i) => run(['show', String(1 + ((i * 37) % cards))]))),
      addMs: median(times(7, (i) => run(['add', `Added by the performance gate ${i}`]))),
      binaryMB: statSync(bin).size / (1024 * 1024),
    };
  } finally {
    vault.cleanup();
  }
}

if (isMain(import.meta.url)) {
  const arg = (name: string) => {
    const position = process.argv.indexOf(name);
    return position >= 0 ? process.argv[position + 1] : undefined;
  };
  // absolute, because the program runs with the vault as its working folder
  const bin = path.resolve(
    arg('--bin') ?? at(`packages/mcp/target/release/oprojects${process.platform === 'win32' ? '.exe' : ''}`),
  );
  const cards = Number(arg('--cards') ?? 2000);
  if (!existsSync(bin)) {
    console.error(`${bin} does not exist: build it first with \`npm run build -w packages/mcp\`.`);
    process.exit(2);
  }
  measure(bin, cards)
    .then((m) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(m, null, 2));
      else console.log(report(m));
      finish('CLI performance gate', overBudget(m));
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
