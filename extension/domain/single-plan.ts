import type { NodeRef, TreeSnapshot } from './node-reference';
import type { ConfirmMutation } from '../schemas/messages';
export type SnapshotNode = TreeSnapshot['nodes'][number];
export type Step =
  | { type: 'update'; id: string; changes: { title?: string; url?: string } }
  | { type: 'move'; id: string; parentId: string; index: number }
  | { type: 'remove'; id: string }
  | { type: 'create'; parentId: string; title: string; url?: string; temporaryId: string };
export function sameNode(a: SnapshotNode, b: SnapshotNode) {
  return (
    a.ref.nativeId === b.ref.nativeId &&
    a.ref.installationId === b.ref.installationId &&
    a.ref.kind === b.ref.kind &&
    a.parentId === b.parentId &&
    a.index === b.index &&
    a.title === b.title &&
    a.url === b.url &&
    a.readOnly === b.readOnly &&
    a.childrenWritable === b.childrenWritable &&
    a.childrenIds.length === b.childrenIds.length &&
    a.childrenIds.every((id, index) => id === b.childrenIds[index])
  );
}
export function validateUrl(value: string) {
  if (value.trim() !== value || [...value].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127))
    throw Error('unsafe-url');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('unsafe-url');
}
export function planSingle(request: ConfirmMutation, tree: TreeSnapshot): { steps: Step[]; affected: SnapshotNode[] } {
  if (request.command.type === 'batch') throw Error('single-command-required');
  if (
    request.installationId !== tree.installationId ||
    request.epoch !== tree.epoch ||
    request.observedRevision !== tree.observedRevision
  )
    throw Error('stale-preview');
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const before = new Map(request.before.map(n => [n.ref.nativeId, n]));
  if (before.size !== request.before.length) throw Error('invalid-before');
  const resolve = (ref: NodeRef) => {
    const node = nodes.get(ref.nativeId);
    if (!node || ref.installationId !== tree.installationId || ref.kind !== node.ref.kind)
      throw Error('invalid-reference');
    return node;
  };
  const scope = resolve(request.scope);
  if (scope.ref.kind !== 'folder') throw Error('invalid-scope');
  const affected = new Map<string, SnapshotNode>();
  const checkBefore = (node: SnapshotNode) => {
    const saved = before.get(node.ref.nativeId);
    if (!saved || !sameNode(saved, node) || saved.observedRevision !== node.observedRevision)
      throw Error('changed-before');
    affected.set(node.ref.nativeId, node);
  };
  const inScope = (node: SnapshotNode) => {
    let current: SnapshotNode | undefined = node;
    let inside = false;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.ref.nativeId)) throw Error('cycle');
      seen.add(current.ref.nativeId);
      checkBefore(current);
      if (current.ref.nativeId === scope.ref.nativeId) inside = true;
      current = current.parentId === undefined ? undefined : nodes.get(current.parentId);
    }
    if (!inside) throw Error('outside-scope');
  };
  const target = (ref: NodeRef) => {
    const n = resolve(ref);
    inScope(n);
    if (n.readOnly) throw Error('read-only');
    return n;
  };
  const parent = (ref: NodeRef) => {
    const n = resolve(ref);
    inScope(n);
    if (!n.childrenWritable || n.ref.kind !== 'folder') throw Error('read-only-parent');
    return n;
  };
  const c = request.command;
  const steps: Step[] = [];
  if (c.type === 'create' || c.type === 'createFolderAndBookmark') {
    const p = parent(c.parent);
    if (c.url !== undefined) {
      validateUrl(c.url);
      if (request.recovery?.mode !== 'copy' && tree.nodes.some(n => n.url === c.url)) throw Error('duplicate-url');
    }
    if (c.type === 'create')
      steps.push({ type: 'create', parentId: p.ref.nativeId, title: c.title, url: c.url, temporaryId: '$created' });
    else
      steps.push(
        { type: 'create', parentId: p.ref.nativeId, title: c.folderTitle, temporaryId: '$folder' },
        { type: 'create', parentId: '$folder', title: c.title, url: c.url, temporaryId: '$bookmark' },
      );
  } else {
    const n = target(c.target);
    // Moving/renaming a folder affects descendant paths; back up and validate the full subtree.
    const descendants = [...n.childrenIds];
    while (descendants.length) {
      const child = nodes.get(descendants.pop()!);
      if (!child) throw Error('invalid-tree');
      target(child.ref);
      descendants.push(...child.childrenIds);
    }
    if (c.type === 'update') {
      if (c.changes.url !== undefined && c.changes.url !== n.url) {
        if (n.ref.kind !== 'bookmark') throw Error('kind-change');
        validateUrl(c.changes.url);
      }
      const changes = { ...c.changes };
      if (changes.url === n.url) delete changes.url;
      steps.push({ type: 'update', id: n.ref.nativeId, changes });
    } else if (c.type === 'move') {
      const p = parent(c.parent);
      let ancestor: SnapshotNode | undefined = p;
      while (ancestor) {
        if (ancestor.ref.nativeId === n.ref.nativeId) throw Error('cycle');
        ancestor = ancestor.parentId === undefined ? undefined : nodes.get(ancestor.parentId);
      }
      if (c.index > p.childrenIds.length) throw Error('invalid-index');
      steps.push({ type: 'move', id: n.ref.nativeId, parentId: p.ref.nativeId, index: c.index });
    } else if (c.type === 'remove') {
      if (n.childrenIds.length) throw Error('not-empty');
      steps.push({ type: 'remove', id: n.ref.nativeId });
    } else {
      const stack: { node: SnapshotNode; visited: boolean }[] = [{ node: n, visited: false }];
      while (stack.length) {
        const { node, visited } = stack.pop()!;
        target(node.ref);
        if (visited) steps.push({ type: 'remove', id: node.ref.nativeId });
        else {
          stack.push({ node, visited: true });
          for (const id of [...node.childrenIds].reverse()) {
            const child = nodes.get(id);
            if (!child) throw Error('invalid-tree');
            stack.push({ node: child, visited: false });
          }
        }
      }
    }
  }
  return { steps, affected: [...affected.values()] };
}
