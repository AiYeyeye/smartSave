import type { TreeSnapshot } from '../../domain/node-reference';
export function searchTree(count = 3): TreeSnapshot {
  return { installationId: 'test', epoch: 'one', observedRevision: 1, roots: ['0'], nodes: [
    { ref: { installationId: 'test', nativeId: '0', kind: 'folder' }, title: '学习资料', index: 0, childrenIds: Array.from({ length: count }, (_, i) => String(i + 1)), readOnly: true, observedRevision: 1 },
    ...Array.from({ length: count }, (_, i) => ({ ref: { installationId: 'test', nativeId: String(i + 1), kind: 'bookmark' as const }, parentId: '0', title: i === 0 ? '重庆大学' : `Bookmark ${i}`, url: `https://example.com/guide/${i}?secret=yes#part`, index: i, childrenIds: [], readOnly: false, observedRevision: 1 })),
  ] };
}
