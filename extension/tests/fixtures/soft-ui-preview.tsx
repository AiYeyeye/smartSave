// Full production App; only browser API boundaries are fixtures.
import { createRoot } from 'react-dom/client';
import { App } from '../../ui/App';
import { TREE_PORT, type TreeSnapshot, type TreeState } from '../../domain/node-reference';
import { SAVE_PORT } from '../../background/save-entrypoints';
import { ImportCheckpointStore } from '../../persistence/import-checkpoints';
import { parseImport } from '../../import/parsers';
import { SettingsStore } from '../../persistence/settings';
import { AiServicesStore } from '../../persistence/ai-services';
import type { ConfirmMutation } from '../../schemas/messages';
const snapshot: TreeSnapshot = {
  installationId: 'visual',
  epoch: 'fixture',
  observedRevision: 0,
  roots: ['0'],
  nodes: [
    {
      ref: { installationId: 'visual', nativeId: '0', kind: 'folder' },
      title: '',
      index: 0,
      childrenIds: ['root'],
      readOnly: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'visual', nativeId: 'root', kind: 'folder' },
      title: '书签栏',
      parentId: '0',
      index: 0,
      childrenIds: ['design', 'dev'],
      readOnly: true,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'visual', nativeId: 'design', kind: 'folder' },
      title: '设计与灵感',
      parentId: 'root',
      index: 0,
      childrenIds: ['figma', 'figma-copy'],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'visual', nativeId: 'dev', kind: 'folder' },
      title: '开发手册',
      parentId: 'root',
      index: 1,
      childrenIds: ['docs'],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'visual', nativeId: 'figma', kind: 'bookmark' },
      title: 'Figma — 把想法变成作品',
      url: 'https://example.test/figma',
      parentId: 'design',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'visual', nativeId: 'figma-copy', kind: 'bookmark' },
      title: 'Figma 设计资源（重复收藏）',
      url: 'https://example.test/figma',
      parentId: 'design',
      index: 1,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'visual', nativeId: 'docs', kind: 'bookmark' },
      title: 'MDN Web Docs · 前端开发完整参考与长期学习指南'.repeat(12),
      url: 'https://example.test/docs',
      parentId: 'dev',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
  ],
};
const noop = () => {};
const interactionPreview = location.search.includes('interactions');
const semanticPreview = location.search.includes('semantic');
const organizeStreamPreview = location.search.includes('organize-stream');
const taxonomyPreview = location.search.includes('organize-taxonomy');
const treeListeners: ((message: unknown) => void)[] = [];
const requests: unknown[] = [];
const connections: string[] = [];
Object.assign(globalThis, {
  __visualTreeConnections: connections,
  __visualSearchRequests: requests,
  __visualTreeState: (state: TreeState) => treeListeners.forEach(listener => listener({ version: 1, state })),
  __visualRestoreTree: () =>
    treeListeners.forEach(listener => listener({ version: 1, state: { status: 'ready', snapshot } })),
});
if (semanticPreview) {
  const bookmark = snapshot.nodes.find(node => node.ref.nativeId === 'figma')!;
  bookmark.title = 'diagrams.net';
  bookmark.url = 'https://app.diagrams.net/';
  if (location.search.includes('semantic-large')) {
    const parent = snapshot.nodes.find(node => node.ref.nativeId === 'dev')!;
    for (let i = 0; i < 200; i++) {
      const id = `semantic-${i}`;
      snapshot.nodes.push({
        ...bookmark,
        ref: { ...bookmark.ref, nativeId: id },
        parentId: 'dev',
        title: `Archive reference ${i}`,
        url: `https://catalog.example.test/${i}`,
        index: parent.childrenIds.length,
      });
      parent.childrenIds.push(id);
    }
  }
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const input = JSON.parse(body.input) as { task: string; items: { id: string }[] };
    await new Promise(resolve => setTimeout(resolve, 300));
    const output =
      input.task === 'search-expand'
        ? { terms: ['diagrams.net', '流程图', 'flowchart'] }
        : { rankedIds: input.items.some(item => item.id === 'figma') ? ['figma'] : [] };
    return new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(output) }));
  };
}
const stored: Record<string, unknown> = {};
const submitted: ConfirmMutation[] = [];
Object.assign(globalThis, { __visualSubmitted: submitted });
if (interactionPreview) globalThis.fetch = () => new Promise<Response>(() => {});
if (organizeStreamPreview) {
  const pendingOrganize = new Map<number, (failed: boolean | 'output-limit') => void>();
  Object.assign(globalThis, {
    __visualFinishOrganize: (failed: boolean | 'output-limit' = false, requestIndex?: number) => {
      const id = requestIndex ?? pendingOrganize.keys().next().value;
      if (id !== undefined) pendingOrganize.get(id)?.(failed);
    },
  });
  if (location.search.includes('organize-batches')) {
    const sample = snapshot.nodes.find(n => n.ref.nativeId === 'figma')!;
    const parent = snapshot.nodes.find(n => n.ref.nativeId === 'design')!;
    for (let i = 0; i < 20; i++) {
      const id = `sample-${i}`;
      snapshot.nodes.push({
        ...sample,
        ref: { ...sample.ref, nativeId: id },
        title: `写作与绘图资料 ${i + 1}`,
        index: parent.childrenIds.length,
      });
      parent.childrenIds.push(id);
    }
  }
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const requestIndex = requests.length - 1;
    const input = JSON.parse(body.input) as {
      stage?: string;
      omittedItemsUnchanged?: boolean;
      items: { id: string }[];
    };
    const folderOutput = taxonomyPreview
      ? {
          newFolders: [
            { id: 'writing', parentId: 'root', title: '写作工具', reason: '集中写作用途' },
            { id: 'drawing', parentId: 'root', title: '绘图工具', reason: '集中绘图用途' },
          ],
          moves: [],
          merges: [],
          renames: [{ folderId: 'dev', title: '开发参考', reason: '统一分类名称' }],
        }
      : { newFolders: [{ id: 'tools', parentId: 'root', title: '工具', reason: '按用途整理' }], moves: [], merges: [] };
    const moves = input.items
      .filter(item => (taxonomyPreview ? item.id !== 'docs' : item.id === 'figma'))
      .map(item => ({
        itemId: item.id,
        folderId: taxonomyPreview ? (item.id === 'figma-copy' ? 'drawing' : 'writing') : 'dev',
        reason: '按已确认的用途分类',
      }));
    const answer = JSON.stringify(
      input.stage === 'folders'
        ? folderOutput
        : {
            newFolders: [],
            merges: [],
            moves,
            ...(input.omittedItemsUnchanged
              ? {}
              : {
                  unchangedIds: input.items.filter(item => !moves.some(m => m.itemId === item.id)).map(item => item.id),
                }),
          },
    );
    const split = answer.indexOf('],') + 2;
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          let closed = false;
          const send = (data: unknown) => {
            if (!closed) c.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          };
          const timer = setTimeout(
            () =>
              send({
                type: 'response.output_text.delta',
                output_index: 0,
                content_index: 0,
                delta: answer.slice(0, split),
              }),
            400,
          );
          const stop = () => {
            if (!closed) {
              closed = true;
              pendingOrganize.delete(requestIndex);
              clearTimeout(timer);
              c.close();
            }
          };
          init?.signal?.addEventListener('abort', stop, { once: true });
          pendingOrganize.set(requestIndex, (failed: boolean | 'output-limit' = false) => {
            if (closed) return;
            if (failed === 'output-limit')
              send({
                type: 'response.completed',
                response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
              });
            else if (failed)
              send({
                type: 'response.failed',
                response: { status: 'failed', error: { message: 'synthetic failure' } },
              });
            else {
              send({ type: 'response.output_text.done', output_index: 0, content_index: 0, text: answer });
              send({ type: 'response.completed', response: { status: 'completed' } });
            }
            init?.signal?.removeEventListener('abort', stop);
            stop();
          });
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
}
Object.assign(chrome, {
  permissions: {
    contains: async () =>
      interactionPreview ||
      semanticPreview ||
      organizeStreamPreview ||
      location.search.includes('model-output-settings'),
    request: async () => location.search.includes('model-output-settings'),
    onRemoved: { addListener: noop, removeListener: noop },
  },
  runtime: {
    connect: ({ name }: { name: string }) => {
      connections.push(name);
      const listeners: ((message: unknown) => void)[] = [];
      const disconnectListeners: (() => void)[] = [];
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const resetIdle = () => {
        if (!organizeStreamPreview || name !== 'zhilan-organizer-authority-v1') return;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => disconnectListeners.forEach(fn => fn()), 30_000);
      };
      resetIdle();
      return {
        onMessage: {
          addListener: (fn: (message: unknown) => void) => {
            listeners.push(fn);
            if (name === TREE_PORT) treeListeners.push(fn);
            if (name === 'zhilan-organizer-authority-v1')
              queueMicrotask(() => fn({ version: 1, organizerContext: 'visual-lease' }));
          },
        },
        onDisconnect: { addListener: (fn: () => void) => disconnectListeners.push(fn) },
        disconnect: () => clearTimeout(idleTimer),
        postMessage: () => {
          resetIdle();
          if (name === TREE_PORT) listeners.forEach(fn => fn({ version: 1, state: { status: 'ready', snapshot } }));
          if (name === SAVE_PORT && location.search.includes('pending'))
            listeners.forEach(fn =>
              fn({
                type: 'page',
                page: { tabId: 1, token: 'fixture-token', title: '待收藏示例', url: 'https://example.test/pending' },
              }),
            );
        },
      };
    },
    sendMessage: (
      message: { type?: string; request?: ConfirmMutation; requestId?: string },
      reply?: (value: unknown) => void,
    ) => {
      if (!interactionPreview) return;
      if (message.type === 'registerMutationPreview') reply?.({ status: 'preview', proposal: message.request });
      if (message.type === 'confirmMutation') {
        submitted.push(message as ConfirmMutation);
        setTimeout(
          () =>
            reply?.({
              requestId: message.requestId,
              status: 'completed',
              needsReconcile: false,
              completedSteps: 1,
              remainingSteps: 0,
            }),
          1500,
        );
      }
    },
  },
  storage: {
    local: {
      get: async () => ({
        ...stored,
        'tree.expanded.visual.root': true,
        'tree.expanded.visual.design': true,
        'tree.expanded.visual.dev': true,
      }),
      set: async (value: Record<string, unknown>) => {
        Object.assign(stored, value);
      },
      remove: async () => {},
      setAccessLevel: async () => {},
    },
    onChanged: { addListener: noop, removeListener: noop },
  },
});
async function start() {
  if (location.search.includes('model-output-settings')) {
    const services = new AiServicesStore(chrome.storage.local, run => run());
    await services.load();
    await services.upsertService(
      {
        id: 'visual-responses',
        name: 'Responses 测试服务',
        serviceType: 'Custom',
        kind: 'api',
        detail: 'synthetic.invalid/v1',
        baseUrl: 'https://synthetic.invalid/v1',
        mode: 'openai-responses',
        status: 'ok',
        letter: 'R',
        avatarClass: 'c-openai',
        catalog: [{ id: 'visual', ctx: '' }],
        enabled: ['visual'],
      },
      'synthetic-test-key',
      true,
    );
    services.dispose();
  }
  if (interactionPreview || semanticPreview || organizeStreamPreview) {
    const settings = new SettingsStore(chrome.storage.local, run => run());
    await settings.save(
      { adapter: 'openai-responses', baseUrl: 'https://synthetic.invalid/v1', model: 'visual', timeoutMs: 60_000 },
      { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
      'synthetic-test-key',
      true,
    );
  }
  if (location.search.includes('import-preview')) {
    const store = new ImportCheckpointStore();
    if (!(await store.get('visual-import'))) {
      const parsed = parseImport(
        new TextEncoder().encode('https://example.test/design\nhttps://example.test/dev'),
        'txt',
      );
      await store.put(
        {
          schemaVersion: 1,
          id: 'visual-import',
          revision: 0,
          installationId: 'visual',
          root: snapshot.nodes.find(node => node.ref.nativeId === 'root')!.ref,
          items: parsed.items.map(item => ({ item, titleLocked: false })),
          diagnostics: [],
          classified: parsed.items.map((item, index) => ({
            sourceOrdinal: item.sourceOrdinal,
            title: ['设计参考', '开发手册'][index]!,
            folderId: index === 0 ? 'design' : 'dev',
          })),
          newFolders: [],
          phase: 'classified',
        },
        null,
      );
    }
  }
  createRoot(document.getElementById('root')!).render(
    <App page={location.search.includes('options') ? 'options' : 'panel'} />,
  );
}
void start();
