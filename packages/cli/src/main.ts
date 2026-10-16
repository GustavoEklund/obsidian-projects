import { spawn } from 'node:child_process';
import { run, type IO } from './run';

function openUrl(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const io: IO = {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
  readStdin,
  isTTY: !!process.stdout.isTTY,
  columns: process.stdout.columns || Number(process.env.COLUMNS) || 100,
  now: () => new Date(),
  openUrl,
};

// The native `oprojects` replaces this program; people at a terminal are told once per run, scripts (no terminal) are not.
if (process.stderr.isTTY) {
  process.stderr.write(
    'note: this Node version of oprojects is deprecated; install the native one: https://github.com/GustavoEklund/obsidian-projects/releases/latest\n',
  );
}

run(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  },
);
