import type { BookmarkWriter } from '../adapters/bookmarks-write';

/**
 * Tracks bookmark/folder ids this extension just created so chrome.bookmarks.onCreated
 * handlers can skip plugin-originated nodes and avoid classify→write→classify loops.
 */
export class OwnWriteGuard {
  private readonly until = new Map<string, number>();
  private readonly edits = new Set<{ id: string; type: 'move' | 'update'; value: string; until: number }>();
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
    for (const edit of this.edits) if (edit.until < now) this.edits.delete(edit);
  }

  /** Consume exactly one matching native event, not every user edit during a time window. */
  consumeEdit(id: string, type: 'move' | 'update', value: string) {
    this.sweep();
    const edit = [...this.edits].find(item => item.id === id && item.type === type && item.value === value);
    if (!edit) return false;
    this.edits.delete(edit);
    return true;
  }
  private async edit<T>(id: string, type: 'move' | 'update', value: string, write: () => Promise<T>) {
    const edit = { id, type, value, until: Date.now() + this.ttlMs };
    this.edits.add(edit);
    try {
      return await write();
    } catch (error) {
      this.edits.delete(edit);
      throw error;
    }
  }

  wrap(writer: BookmarkWriter): BookmarkWriter {
    return {
      create: async details => {
        const node = await writer.create(details);
        this.mark(node.id);
        return node;
      },
      update: (id, changes) =>
        changes.title === undefined
          ? writer.update(id, changes)
          : this.edit(id, 'update', changes.title, () => writer.update(id, changes)),
      move: (id, destination) => this.edit(id, 'move', destination.parentId ?? '', () => writer.move(id, destination)),
      remove: id => writer.remove(id),
    };
  }
}
