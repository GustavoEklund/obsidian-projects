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
    const target = await this.claimTrashName(trash, path.parse(file));
    // A folder cannot be renamed over a file, so a (rare) folder gives its claim up just before the move.
    if (
      await fs.lstat(file).then(
        (s) => s.isDirectory(),
        () => false,
      )
    )
      await fs.rm(target, { force: true });
    try {
      await fs.rename(file, target);
    } catch (e) {
      await fs.rm(target, { force: true }); // the placeholder claimed above (nothing to do if a folder gave it up)
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(rel);
      throw e;
    }
  }

  /**
   * `name.md`, else `name <timestamp>.md`, else `name <timestamp>-2.md`...: never a name that is taken. The name is
   * CLAIMED with an exclusive create (`wx`) and the rename that follows replaces that placeholder. Checking that the name
   * is free and renaming afterwards would not do: `rename` overwrites, so two removals running at once (an MCP client
   * deleting several notes with the same file name) both saw it free and the second destroyed the first.
   */
  private async claimTrashName(
    trash: string,
    { name, ext }: { name: string; ext: string },
    attempt = 0,
  ): Promise<string> {
    const label = attempt === 0 ? name : `${name} ${Date.now()}${attempt > 1 ? `-${attempt}` : ''}`;
    const target = path.join(trash, `${label}${ext}`);
    try {
      await fs.writeFile(target, '', { flag: 'wx' });
      return target;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return this.claimTrashName(trash, { name, ext }, attempt + 1);
      throw e;
    }
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
