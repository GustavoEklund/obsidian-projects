import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileExistsError, NotFoundError, type Storage } from '../storage';

/** `Storage` over a vault directory on disk. Paths are vault-relative, forward slashes. */
export class FsStorage implements Storage {
  readonly root: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private tmpCounter = 0;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  private abs(rel: string): string {
    const full = path.resolve(this.root, ...rel.split('/'));
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`Path escapes the vault: ${rel}`);
    return full;
  }

  async listMarkdown(folder: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(this.abs(rel), { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // no cards yet
        throw e;
      }
      await Promise.all(
        entries.map(async (entry) => {
          if (entry.name.startsWith('.')) return; // temp files, .trash, .obsidian
          const child = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isDirectory()) await walk(child);
          else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child);
        }),
      );
    };
    await walk(folder);
    return out;
  }

  async read(rel: string): Promise<string> {
    try {
      return await fs.readFile(this.abs(rel), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(rel);
      throw e;
    }
  }

  async create(rel: string, content: string): Promise<void> {
    const file = this.abs(rel);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExistsError(rel);
      throw e;
    }
  }

  /**
   * Writes through a hidden temp file + rename so Obsidian (which watches the
   * folder) never reads a half-written note.
   */
  async modify(rel: string, fn: (content: string) => string): Promise<string> {
    const file = this.abs(rel);
    // Concurrent calls on one note (an MCP client firing several tools at once) must not interleave: each reads
    // what the previous one wrote. They queue up per file; different files still run in parallel.
    const run = (this.queues.get(file) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.rewrite(rel, file, fn));
    this.queues.set(file, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(file) === run) this.queues.delete(file);
    }
  }

  private async rewrite(rel: string, file: string, fn: (content: string) => string): Promise<string> {
    const next = fn(await this.read(rel));
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${++this.tmpCounter}.tmp`);
    try {
      await fs.writeFile(tmp, next, 'utf8');
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    return next;
  }

  /** Moves to the vault's `.trash/` (what Obsidian's "move to Obsidian trash" does) so it is recoverable. */
  async remove(rel: string): Promise<void> {
    const file = this.abs(rel);
    const trash = path.join(this.root, '.trash');
    await fs.mkdir(trash, { recursive: true });
    const target = await this.freeTrashName(trash, path.parse(file));
    try {
      await fs.rename(file, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(rel);
      throw e;
    }
  }

  /** `name.md`, else `name <timestamp>.md`, else `name <timestamp>-2.md`...: never an existing file (rename would overwrite it). */
  private async freeTrashName(
    trash: string,
    { name, ext }: { name: string; ext: string },
    attempt = 0,
  ): Promise<string> {
    const label = attempt === 0 ? name : `${name} ${Date.now()}${attempt > 1 ? `-${attempt}` : ''}`;
    const target = path.join(trash, `${label}${ext}`);
    const taken = await fs.access(target).then(
      () => true,
      () => false,
    );
    return taken ? this.freeTrashName(trash, { name, ext }, attempt + 1) : target;
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await fs.access(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }
}
