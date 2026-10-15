// A hand-written stand-in for the slice of the Obsidian API that `ObsidianStorage` and `VaultSync` use.
// Test files install it with: vi.mock('obsidian', async () => await import('./helpers/fake-obsidian'));
import { vi } from 'vitest';

export class TAbstractFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split('/').at(-1)!;
  }
}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

/** Like Obsidian's: forward slashes only, no duplicate, leading or trailing slashes. */
export function normalizePath(path: string): string {
  const cleaned = path.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
  return cleaned || '/';
}

type VaultEvent = 'create' | 'modify' | 'delete' | 'rename';
type Listener = (...args: unknown[]) => void;

export interface EventRef {
  event: VaultEvent;
  fn: Listener;
}

export class FakeVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  /** What `cachedRead` returns when set (a stale metadata cache); otherwise the live content. */
  readonly cache = new Map<string, string>();
  readonly reads: string[] = [];
  readonly cachedReads: string[] = [];
  private readonly listeners: EventRef[] = [];
  private readonly handles = new Map<string, TFile>();
  /** Serializes `process`, like Obsidian's atomic read-modify-write. */
  private chain: Promise<unknown> = Promise.resolve();

  /** Seed notes (and their folders) without firing events. */
  seed(files: Record<string, string>): void {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(path, content);
      this.addParents(path);
    }
  }

  getMarkdownFiles(): TFile[] {
    return [...this.files.keys()].filter((p) => p.endsWith('.md')).map((p) => this.handle(p));
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path)) return this.handle(path);
    if (this.folders.has(path)) return new TFolder(path);
    return null;
  }

  async read(file: TFile): Promise<string> {
    this.reads.push(file.path);
    return this.content(file.path);
  }

  async cachedRead(file: TFile): Promise<string> {
    this.cachedReads.push(file.path);
    return this.cache.get(file.path) ?? this.content(file.path);
  }

  async create(path: string, content: string): Promise<TFile> {
    if (this.files.has(path) || this.folders.has(path)) throw new Error('File already exists.');
    const parent = path.split('/').slice(0, -1).join('/');
    if (parent && !this.folders.has(parent)) throw new Error(`ENOENT: no such folder ${parent}`);
    this.files.set(path, content);
    const file = this.handle(path);
    this.emit('create', file);
    return file;
  }

  async createFolder(path: string): Promise<void> {
    if (this.folders.has(path) || this.files.has(path)) throw new Error('Folder already exists.');
    this.folders.add(path);
  }

  process(file: TFile, fn: (content: string) => string): Promise<string> {
    const run = async () => {
      const next = fn(this.content(file.path));
      this.files.set(file.path, next);
      this.emit('modify', file);
      return next;
    };
    const result = this.chain.then(run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  // --- what a test does to the vault from "outside" (another plugin, sync, the user) -------------------------

  /** Write a note the way the file system watcher reports it: create or modify, with the event. */
  write(path: string, content: string): void {
    const existed = this.files.has(path);
    this.files.set(path, content);
    this.addParents(path);
    this.emit(existed ? 'modify' : 'create', this.handle(path));
  }

  delete(path: string): void {
    const file = this.handle(path);
    this.files.delete(path);
    this.cache.delete(path);
    this.handles.delete(path);
    this.emit('delete', file);
  }

  rename(from: string, to: string): void {
    const content = this.content(from);
    this.files.delete(from);
    this.handles.delete(from);
    this.files.set(to, content);
    this.addParents(to);
    this.emit('rename', this.handle(to), from);
  }

  on(event: VaultEvent, fn: Listener): EventRef {
    const ref = { event, fn };
    this.listeners.push(ref);
    return ref;
  }

  emit(event: VaultEvent, ...args: unknown[]): void {
    for (const l of this.listeners.filter((x) => x.event === event)) l.fn(...args);
  }

  listenerCount(event: VaultEvent): number {
    return this.listeners.filter((l) => l.event === event).length;
  }

  private content(path: string): string {
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT: ${path}`);
    return value;
  }

  private handle(path: string): TFile {
    let h = this.handles.get(path);
    if (!h) {
      h = new TFile(path);
      this.handles.set(path, h);
    }
    return h;
  }

  private addParents(path: string): void {
    const parts = path.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) this.folders.add(parts.slice(0, i).join('/'));
  }
}

export class FakeApp {
  readonly vault = new FakeVault();
  readonly trashed: string[] = [];
  readonly fileManager = {
    trashFile: vi.fn(async (file: TFile) => {
      this.trashed.push(file.path);
      this.vault.delete(file.path);
    }),
  };
}

export class FakePlugin {
  readonly app: FakeApp;
  readonly registered: EventRef[] = [];
  constructor(app = new FakeApp()) {
    this.app = app;
  }
  registerEvent = vi.fn((ref: EventRef) => void this.registered.push(ref));
}
