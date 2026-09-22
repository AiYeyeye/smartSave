// Full production App; only browser API boundaries are fixtures.
import { createRoot } from 'react-dom/client';
import { App } from '../../ui/App';
import { TREE_PORT, type TreeSnapshot } from '../../domain/node-reference';
import { SAVE_PORT } from '../../background/save-entrypoints';
const snapshot: TreeSnapshot = { installationId: 'visual', epoch: 'fixture', observedRevision: 0, roots: ['root'], nodes: [
  { ref: { installationId: 'visual', nativeId: 'root', kind: 'folder' }, title: '书签栏', index: 0, childrenIds: ['design', 'dev'], readOnly: true, childrenWritable: true, observedRevision: 0 },
  { ref: { installationId: 'visual', nativeId: 'design', kind: 'folder' }, title: '设计与灵感', parentId: 'root', index: 0, childrenIds: ['figma'], readOnly: false, childrenWritable: true, observedRevision: 0 },
  { ref: { installationId: 'visual', nativeId: 'dev', kind: 'folder' }, title: '开发手册', parentId: 'root', index: 1, childrenIds: ['docs'], readOnly: false, childrenWritable: true, observedRevision: 0 },
  { ref: { installationId: 'visual', nativeId: 'figma', kind: 'bookmark' }, title: 'Figma — 把想法变成作品', url: 'https://example.test/figma', parentId: 'design', index: 0, childrenIds: [], readOnly: false, observedRevision: 0 },
  { ref: { installationId: 'visual', nativeId: 'docs', kind: 'bookmark' }, title: 'MDN Web Docs · 前端开发完整参考与长期学习指南', url: 'https://example.test/docs', parentId: 'dev', index: 0, childrenIds: [], readOnly: false, observedRevision: 0 },
] };
const noop = () => {};
Object.assign(chrome, {
  permissions: { contains: async () => false, onRemoved: { addListener: noop, removeListener: noop } },
  runtime: {
    connect: ({ name }: { name: string }) => {
      const listeners: ((message: unknown) => void)[] = [];
      return { onMessage: { addListener: (fn: (message: unknown) => void) => listeners.push(fn) }, onDisconnect: { addListener: noop }, disconnect: noop,
        postMessage: () => {
          if (name === TREE_PORT) listeners.forEach(fn => fn({ version: 1, state: { status: 'ready', snapshot } }));
          if (name === SAVE_PORT && location.search.includes('pending')) listeners.forEach(fn => fn({ type: 'page', page: { tabId: 1, token: 'fixture-token', title: '待收藏示例', url: 'https://example.test/pending' } }));
        } };
    }, sendMessage: noop,
  },
  storage: { local: { get: async () => ({ 'tree.expanded.visual.root': true, 'tree.expanded.visual.design': true, 'tree.expanded.visual.dev': true }), set: async () => {}, remove: async () => {}, setAccessLevel: async () => {} }, onChanged: { addListener: noop, removeListener: noop } },
});
createRoot(document.getElementById('root')!).render(<App page="panel" />);
