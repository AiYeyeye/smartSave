import type { BookmarkSource } from '../adapters/bookmarks-read';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';

export class TreeProjection {
  state: TreeState = { status: 'loading' };
  private listeners = new Set<(state: TreeState) => void>();
  private revision = 0;
  private generation = 0;
  private active = false;
  private importing = false;
  private reading = false;
  private dirty = false;
  private detach = () => {};
  constructor(private source: BookmarkSource, private ensureIdentity: () => Promise<string>, private epoch: string) {}
  subscribe(listener: (state: TreeState) => void) { this.listeners.add(listener); listener(this.state); return () => { this.listeners.delete(listener); }; }
  private publish(state: TreeState) { this.state = state; this.listeners.forEach(listener => listener(state)); }
  fresh(): Promise<TreeSnapshot> {
    return new Promise((resolve, reject) => {
      this.refresh();
      const listener = (state: TreeState) => {
        if (state.status === 'loading') return;
        this.listeners.delete(listener);
        if (state.status === 'ready') resolve(state.snapshot);
        else reject(new Error('tree-unavailable'));
      };
      this.listeners.add(listener);
      if (this.state.status !== 'loading') listener(this.state);
      if (this.importing || !this.active) { this.listeners.delete(listener); reject(new Error('tree-unavailable')); }
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
  stop() { this.active = false; this.generation++; this.detach(); }
  refresh() {
    this.dirty = true;
    this.publish({ status: 'loading' });
    if (!this.reading && this.active && !this.importing) void this.read();
  }
  private async read() {
    this.reading = true;
    const generation = this.generation;
    try {
      const installationId = await this.ensureIdentity();
      while (this.active && generation === this.generation && this.dirty && !this.importing) {
        this.dirty = false;
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
          nodes.push({ ref: { installationId, nativeId: node.id, kind: node.url === undefined ? 'folder' : 'bookmark' }, parentId: node.parentId, index: node.index ?? index, title: node.title, url: node.url, childrenIds: node.children?.map(child => child.id) ?? [], readOnly, childrenWritable: node.url === undefined && entry.depth > 0 && !entry.protectedAncestor && !node.unmodifiable, observedRevision: revision });
          const children = node.children ?? [];
          for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i]!, index: i, protectedAncestor: entry.protectedAncestor || !!node.unmodifiable, depth: entry.depth + 1 });
        }
        const snapshot = { installationId, epoch: this.epoch, observedRevision: revision, roots: tree.map(node => node.id), nodes };
        nodes.forEach(node => { Object.freeze(node.ref); Object.freeze(node.childrenIds); Object.freeze(node); });
        Object.freeze(nodes); Object.freeze(snapshot.roots); Object.freeze(snapshot);
        this.publish({ status: 'ready', snapshot });
      }
    } catch {
      if (this.active && generation === this.generation) this.publish({ status: 'error', message: '无法读取书签或安装身份，请重试。' });
    } finally { this.reading = false; }
  }
}
