import type { BookmarkSource } from '../adapters/bookmarks-read';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';
import { validCollectionTime } from '../domain/bookmark-recency';

type Waiter = { resolve: (snapshot: TreeSnapshot) => void; reject: (error: Error) => void };
export class TreeProjection {
  state: TreeState = { status: 'loading' };
  private listeners = new Set<(state: TreeState) => void>();
  private waiters = new Set<Waiter>();
  private revision = 0;
  private published?: number;
  private generation = 0;
  private active = false;
  private importing = false;
  private reading = false;
  private dirty = false;
  private detach = () => {};
  constructor(
    private source: BookmarkSource,
    private ensureIdentity: () => Promise<string>,
    private epoch: string,
  ) {}
  subscribe(listener: (state: TreeState) => void) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish(state: TreeState) {
    this.state = state;
    this.listeners.forEach(listener => listener(state));
  }
  /** Silent authoritative read: resolves from a native read started after this call, publishing nothing unless the tree actually changed. */
  fresh(): Promise<TreeSnapshot> {
    if (this.importing || !this.active) return Promise.reject(new Error('tree-unavailable'));
    return new Promise((resolve, reject) => {
      this.waiters.add({ resolve, reject });
      this.dirty = true;
      if (!this.reading) void this.read();
    });
  }
  invalidatePreviews() {
    // Quarantine changes authorization, even when the native tree has not changed.
    this.revision++;
    this.refresh();
  }
  start() {
    if (this.active) return;
    this.active = true;
    this.detach = this.source.listen(event => {
      this.revision++;
      if (event === 'import-begin') this.importing = true;
      if (event === 'import-end') this.importing = false;
      this.refresh();
    });
    this.refresh();
  }
  stop() {
    this.active = false;
    this.generation++;
    this.detach();
  }
  /** Explicit broadcast refresh: subscribers see loading, then the (re)published ready state. */
  refresh() {
    this.dirty = true;
    this.publish({ status: 'loading' });
    if (!this.reading && this.active && !this.importing) void this.read();
  }
  private async read() {
    this.reading = true;
    const generation = this.generation;
    let taken: Waiter[] = [];
    try {
      const installationId = await this.ensureIdentity();
      while (this.active && generation === this.generation && this.dirty && !this.importing) {
        this.dirty = false;
        taken.push(...this.waiters);
        this.waiters.clear();
        const revision = this.revision;
        const tree = await this.source.read();
        if (!this.active || generation !== this.generation) return;
        if (this.dirty || revision !== this.revision || this.importing) continue;
        const nodes: TreeSnapshot['nodes'] = [];
        const stack = tree.map((node, index) => ({ node, index, protectedAncestor: false, depth: 0 })).reverse();
        while (stack.length) {
          const entry = stack.pop()!;
          const { node, index } = entry;
          const readOnly = entry.protectedAncestor || !!node.unmodifiable || entry.depth <= 1;
          nodes.push({
            ref: { installationId, nativeId: node.id, kind: node.url === undefined ? 'folder' : 'bookmark' },
            parentId: node.parentId,
            index: node.index ?? index,
            title: node.title,
            url: node.url,
            ...(validCollectionTime(node.dateAdded) ? { dateAdded: node.dateAdded } : {}),
            childrenIds: node.children?.map(child => child.id) ?? [],
            readOnly,
            childrenWritable:
              node.url === undefined && entry.depth > 0 && !entry.protectedAncestor && !node.unmodifiable,
            observedRevision: revision,
          });
          const children = node.children ?? [];
          for (let i = children.length - 1; i >= 0; i--)
            stack.push({
              node: children[i]!,
              index: i,
              protectedAncestor: entry.protectedAncestor || !!node.unmodifiable,
              depth: entry.depth + 1,
            });
        }
        const snapshot = {
          installationId,
          epoch: this.epoch,
          observedRevision: revision,
          roots: tree.map(node => node.id),
          nodes,
        };
        nodes.forEach(node => {
          Object.freeze(node.ref);
          Object.freeze(node.childrenIds);
          Object.freeze(node);
        });
        Object.freeze(nodes);
        Object.freeze(snapshot.roots);
        Object.freeze(snapshot);
        // A silent read at an already published revision keeps the published state; only real changes or explicit refreshes publish.
        if (this.state.status !== 'ready' || this.published !== revision) {
          this.published = revision;
          this.publish({ status: 'ready', snapshot });
        }
        taken.forEach(waiter => waiter.resolve(snapshot));
        taken = [];
      }
    } catch {
      if (this.active && generation === this.generation)
        this.publish({ status: 'error', message: '无法读取书签或安装身份，请重试。' });
    } finally {
      this.reading = false;
      // Reads abandoned by stop/import or failed identity/native reads never resolve a stale snapshot.
      const pending = [...taken, ...this.waiters];
      this.waiters.clear();
      pending.forEach(waiter => waiter.reject(new Error('tree-unavailable')));
    }
  }
}
