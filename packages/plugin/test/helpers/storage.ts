import { MemoryStorage } from '@oprojects/core';

/**
 * In-memory notes with Obsidian's `Vault.process` semantics: read-modify-write calls on a note never interleave.
 * (The core `MemoryStorage` is not atomic, which makes two edits fired back to back lose one of them.)
 */
export class AtomicStorage extends MemoryStorage {
  private chain: Promise<unknown> = Promise.resolve();

  override modify(path: string, fn: (content: string) => string): Promise<string> {
    const result = this.chain.then(() => super.modify(path, fn));
    this.chain = result.catch(() => undefined);
    return result;
  }
}
