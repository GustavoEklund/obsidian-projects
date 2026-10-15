// A small MCP client over stdio (newline-delimited JSON-RPC 2.0), for driving the Rust server in smoke, memory/latency
// and interoperability tests. It is deliberately independent from the official SDK client, which is used separately as
// the conformance judge: two unrelated clients agreeing with the server is a stronger signal than one.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as readline from 'node:readline';

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema: { type: string; properties?: Record<string, unknown>; required?: string[] };
  annotations?: Record<string, unknown>;
}

export interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface StartOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class McpProcess {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrText = '';
  private exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  private readonly exitPromise: Promise<void>;
  /** Server-initiated notifications, in arrival order. */
  readonly notifications: { method: string; params?: unknown }[] = [];
  /** Milliseconds from spawning the process to the `initialize` response (set by `initialize`). */
  startupMs = 0;
  private readonly spawnedAt = performance.now();

  private constructor(private readonly child: ChildProcess) {
    readline.createInterface({ input: child.stdout! }).on('line', (line) => this.onLine(line));
    child.stderr!.on('data', (chunk: Buffer) => (this.stderrText += chunk.toString('utf8')));
    this.exitPromise = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exited = { code, signal };
        this.failAll(
          new Error(
            `the server exited (code ${code}, signal ${signal}) with requests pending. stderr: ${this.stderrText.trim()}`,
          ),
        );
        resolve();
      });
    });
    child.once('error', (e) => this.failAll(e));
  }

  static start(command: string, args: string[] = [], options: StartOptions = {}): McpProcess {
    const env = { ...process.env, ...options.env };
    return new McpProcess(
      spawn(command, args, { cwd: options.cwd, env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] }),
    );
  }

  get pid(): number {
    return this.child.pid!;
  }

  get stderr(): string {
    return this.stderrText;
  }

  get exitInfo() {
    return this.exited;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string; data?: unknown };
    };
    try {
      message = JSON.parse(line);
    } catch {
      this.failAll(new Error(`the server wrote something that is not JSON on stdout: ${line.slice(0, 200)}`));
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data));
      else pending.resolve(message.result);
    } else if (message.method !== undefined && message.id === undefined) {
      this.notifications.push({ method: message.method, params: message.params });
    }
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private write(message: object): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`the server has exited (code ${this.exited.code})`));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms. stderr: ${this.stderrText.trim()}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  /** Sends `initialize` and `notifications/initialized`; resolves with the server's answer. */
  async initialize(protocolVersion = '2025-06-18'): Promise<{
    protocolVersion: string;
    capabilities: Record<string, unknown>;
    serverInfo: { name: string; version: string };
    instructions?: string;
  }> {
    const result = await this.request<{
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo: { name: string; version: string };
      instructions?: string;
    }>('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'oprojects-test-client', version: '0.0.0' },
    });
    this.startupMs = performance.now() - this.spawnedAt;
    this.notify('notifications/initialized');
    return result;
  }

  async listTools(): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.request<{ tools: Tool[]; nextCursor?: string }>('tools/list', cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<ToolResult> {
    return this.request<ToolResult>('tools/call', { name, arguments: args }, timeoutMs);
  }

  /** The concatenated text of a tool result. */
  static text(result: ToolResult): string {
    return result.content.map((c) => c.text ?? '').join('\n');
  }

  /** Resident memory of the server process in MB (Linux /proc, otherwise `ps`). */
  rssMB(): number {
    try {
      const status = readFileSync(`/proc/${this.pid}/status`, 'utf8');
      return Number(/VmRSS:\s+(\d+)/.exec(status)![1]) / 1024;
    } catch {
      return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(this.pid)], { encoding: 'utf8' }).trim()) / 1024;
    }
  }

  /** Closes stdin (the polite way to stop a stdio server), then kills it if it lingers. */
  async close(graceMs = 2000): Promise<void> {
    if (this.exited) return;
    this.child.stdin!.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), graceMs);
    await this.exitPromise;
    clearTimeout(timer);
  }
}
