/**
 * The seam between the card logic and wherever notes actually live.
 * Two adapters exist: Node `fs` (CLI, future MCP) and the Obsidian vault
 * (plugin). Paths are vault-relative with forward slashes.
 */
export interface Storage {
  /** Every markdown file under `folder` (recursive). */
  listMarkdown(folder: string): Promise<string[]>;
  read(path: string): Promise<string>;
  /** Must reject with `FileExistsError` when `path` already exists. */
  create(path: string, content: string): Promise<void>;
  /** Atomic read-modify-write. */
  modify(path: string, fn: (content: string) => string): Promise<string>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export class FileExistsError extends Error {
  constructor(public readonly path: string) {
    super(`File already exists: ${path}`);
  }
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
  }
}

/** Tiny in-memory adapter for tests and prototypes. */
export class MemoryStorage implements Storage {
  readonly files = new Map<string, string>();

  async listMarkdown(folder: string): Promise<string[]> {
    const prefix = folder ? `${folder}/` : '';
    return [...this.files.keys()].filter((p) => p.startsWith(prefix) && p.endsWith('.md'));
  }
  async read(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) throw new NotFoundError(path);
    return v;
  }
  async create(path: string, content: string): Promise<void> {
    if (this.files.has(path)) throw new FileExistsError(path);
    this.files.set(path, content);
  }
  async modify(path: string, fn: (content: string) => string): Promise<string> {
    const next = fn(await this.read(path));
    this.files.set(path, next);
    return next;
  }
  async remove(path: string): Promise<void> {
    if (!this.files.delete(path)) throw new NotFoundError(path);
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
