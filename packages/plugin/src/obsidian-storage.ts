import { FileExistsError, NotFoundError, type Storage } from '@oprojects/core';
import { TFile, normalizePath, type App } from 'obsidian';

/** `Storage` over the Obsidian vault: the same interface the CLI implements with `fs`. */
export class ObsidianStorage implements Storage {
  constructor(private readonly app: App) {}

  async listMarkdown(folder: string): Promise<string[]> {
    const prefix = folder ? `${folder}/` : '';
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => f.path.startsWith(prefix))
      .map((f) => f.path);
  }

  read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  async create(path: string, content: string): Promise<void> {
    const target = normalizePath(path);
    if (this.app.vault.getAbstractFileByPath(target)) throw new FileExistsError(target);
    await this.ensureFolder(target.split('/').slice(0, -1).join('/'));
    try {
      await this.app.vault.create(target, content);
    } catch (e) {
      // Lost a race with another writer (sync, CLI): report it so the service picks the next key.
      if (/already exists/i.test(String(e))) throw new FileExistsError(target);
      throw e;
    }
  }

  /** `Vault.process` is Obsidian's atomic read-modify-write, safe against the editor saving at the same time. */
  modify(path: string, fn: (content: string) => string): Promise<string> {
    return this.app.vault.process(this.file(path), fn);
  }

  /** Honors the user's "deleted files" preference (system trash, .trash, or permanent). */
  async remove(path: string): Promise<void> {
    await this.app.fileManager.trashFile(this.file(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  private file(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(f instanceof TFile)) throw new NotFoundError(path);
    return f;
  }

  private async ensureFolder(dir: string): Promise<void> {
    let current = '';
    for (const part of dir.split('/').filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (this.app.vault.getAbstractFileByPath(current)) continue;
      try {
        await this.app.vault.createFolder(current);
      } catch (e) {
        if (!/already exists/i.test(String(e))) throw e;
      }
    }
  }
}
