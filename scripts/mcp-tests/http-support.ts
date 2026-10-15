// Shared by the tests of the HTTP mode of the real `oprojects-mcp` binary: a server process that reports its real port.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { binaryPath } from './support';

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface StartOptions {
  /** Flags after `--http --port 0`. Default: a fixed test token. */
  args?: string[];
  env?: Record<string, string | undefined>;
}

export const TOKEN = 'http-test-token-0123456789abcdef';

/** `oprojects-mcp --http`, started on a free port. In HTTP mode stdout carries nothing and stderr says where it listens. */
export class HttpServerProcess {
  private stdoutText = '';
  private stderrText = '';
  private exitInfo: Exit | null = null;
  private readonly exited: Promise<Exit>;

  private constructor(
    private readonly child: ChildProcess,
    readonly port: number,
  ) {
    this.exited = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve((this.exitInfo = { code, signal }))),
    );
  }

  /** Starts the binary and waits for the line that announces its port. Rejects, with everything the process said, if it dies first. */
  static async start(args: string[], options: Pick<StartOptions, 'env'> = {}): Promise<HttpServerProcess> {
    const child = spawn(binaryPath(), ['--http', '--port', '0', ...args], {
      env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "listening" line within 15 s. stderr:\n${stderr}`)), 15_000);
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        const match = /listening on http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(stderr);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(
          new Error(
            `the server exited (code ${code}, signal ${signal}) before listening.\nstdout: ${stdout}\nstderr:\n${stderr}`,
          ),
        );
      });
    });
    const server = new HttpServerProcess(child, port);
    server.stdoutText = stdout;
    child.stdout!.on('data', (chunk: Buffer) => (server.stdoutText += chunk.toString('utf8')));
    child.stderr!.on('data', (chunk: Buffer) => (server.stderrText += chunk.toString('utf8')));
    server.stderrText = stderr;
    return server;
  }

  get pid(): number {
    return this.child.pid!;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get stdout(): string {
    return this.stdoutText;
  }

  get stderr(): string {
    return this.stderrText;
  }

  get exit(): Exit | null {
    return this.exitInfo;
  }

  rssMB(): number {
    try {
      return Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${this.pid}/status`, 'utf8'))![1]) / 1024;
    } catch {
      return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(this.pid)], { encoding: 'utf8' }).trim()) / 1024;
    }
  }

  /** Sends a signal and waits for the process to exit. */
  async stop(signal: NodeJS.Signals = 'SIGTERM', waitMs = 10_000): Promise<Exit> {
    if (this.exitInfo) return this.exitInfo;
    this.child.kill(signal);
    const timer = setTimeout(() => this.child.kill('SIGKILL'), waitMs);
    const exit = await this.exited;
    clearTimeout(timer);
    return exit;
  }

  waitForExit(): Promise<Exit> {
    return this.exited;
  }
}

export interface RpcResponse {
  status: number;
  headers: Headers;
  text: string;
  /** The parsed body, or undefined when it is not JSON. */
  json: any;
}

/** One JSON-RPC request over HTTP with `fetch`. `token: null` sends no Authorization header. */
export async function rpc(
  url: string,
  method: string,
  params: unknown = {},
  options: { token?: string | null; id?: number; headers?: Record<string, string> } = {},
): Promise<RpcResponse> {
  const token = options.token === undefined ? TOKEN : options.token;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...options.headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? 1, method, params }),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json };
}

export const callTool = (
  url: string,
  name: string,
  args: Record<string, unknown> = {},
  options: { token?: string | null; id?: number } = {},
): Promise<RpcResponse> => rpc(url, 'tools/call', { name, arguments: args }, options);

/** The text of the first content block of a tool-call response. */
export const toolText = (response: RpcResponse): string => response.json?.result?.content?.[0]?.text ?? '';

/** Polls until `check` returns something other than undefined/false, or fails after `ms`. */
export async function eventually<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`the condition did not become true within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
