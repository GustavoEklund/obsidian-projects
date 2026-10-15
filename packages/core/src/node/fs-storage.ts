import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileExistsError, NotFoundError, type Storage } from '../storage';

/** `Storage` over a vault directory on disk. Paths are vault-relative, forward slashes. */
export class FsStorage implements Storage {
  readonly root: string;

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
    const next = fn(await this.read(rel));
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
    await fs.writeFile(tmp, next, 'utf8');
    await fs.rename(tmp, file);
    return next;
  }

  /** Moves to the vault's `.trash/` (what Obsidian's "move to Obsidian trash" does) so it is recoverable. */
  async remove(rel: string): Promise<void> {
    const file = this.abs(rel);
    const trash = path.join(this.root, '.trash');
    await fs.mkdir(trash, { recursive: true });
    let target = path.join(trash, path.basename(file));
    try {
      await fs.access(target);
      const { name, ext } = path.parse(target);
      target = path.join(trash, `${name} ${Date.now()}${ext}`);
    } catch {
      // free name
    }
    try {
      await fs.rename(file, target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(rel);
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
