import type { BookmarkWriter } from '../adapters/bookmarks-write';

/**
 * Tracks bookmark/folder ids this extension just created so chrome.bookmarks.onCreated
 * handlers can skip plugin-originated nodes and avoid classify→write→classify loops.
 */
export class OwnWriteGuard {
  private readonly until = new Map<string, number>();
  constructor(private readonly ttlMs = 15_000) {}

  mark(id: string) {
    this.until.set(id, Date.now() + this.ttlMs);
  }

  /** True when id was recently created (or explicitly marked) by a wrapped writer. */
  isOwn(id: string): boolean {
    const expiry = this.until.get(id);
    if (expiry === undefined) return false;
    if (expiry < Date.now()) {
      this.until.delete(id);
      return false;
    }
    return true;
  }

  /** Forget expired entries; useful from long-lived service workers. */
  sweep() {
    const now = Date.now();
    for (const [id, expiry] of this.until) if (expiry < now) this.until.delete(id);
  }

  wrap(writer: BookmarkWriter): BookmarkWriter {
    return {
      create: async details => {
        const node = await writer.create(details);
        this.mark(node.id);
        return node;
      },
      update: (id, changes) => writer.update(id, changes),
      move: (id, destination) => writer.move(id, destination),
      remove: id => writer.remove(id),
    };
  }
}
