import { afterEach, expect, it, vi } from 'vitest';
import { BookmarkKeywordsStore, BOOKMARK_KEYWORDS_KEY, watchBookmarkKeywords } from '../persistence/bookmark-keywords';
import { type BookmarkKeywordRecord } from '../domain/bookmark-keywords';
import { SearchIndex } from '../domain/search-index';
import { SearchController } from '../panel/search-controller';
import { searchTree } from './fixtures/search-tree';
import { parseModelOutput } from '../schemas/model-output';
import { completedSaveBookmark } from '../panel/save-receipt';
import { startBookmarkKeywords } from '../background/bookmark-keywords';
import type { TreeProjection } from '../background/tree-projection';
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const tree = searchTree();
  let data: unknown = [];
  const area = {
    get: async () => ({ [BOOKMARK_KEYWORDS_KEY]: data }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      data = items[BOOKMARK_KEYWORDS_KEY];
    }),
  };
  const store = new BookmarkKeywordsStore(area, async () => structuredClone(tree));
  const record: BookmarkKeywordRecord = {
    installationId: tree.installationId,
    nativeId: '1',
    title: tree.nodes[1]!.title,
    url: tree.nodes[1]!.url!,
    keywords: ['流程图', 'diagramming', '工作流'],
  };
  return { tree, store, area, record };
}
it('save output accepts optional bounded keywords and legacy responses without weakening item identity checks', () => {
  const context = { task: 'save', items: [{ id: '1', title: 'Diagram' }], folders: [{ id: '0' }] };
  const output = {
    assignments: [{ itemId: '1', folderId: '0', keywords: [' 流程图 ', 'diagrams', '绘图'] }],
    newFolders: [],
  };
  expect(parseModelOutput(output, context)).toMatchObject({
    assignments: [{ keywords: ['流程图', 'diagrams', '绘图'] }],
  });
  expect(() => parseModelOutput({ ...output, assignments: [{ itemId: '1', folderId: '0' }] }, context)).not.toThrow();
  for (const keywords of [['x'.repeat(33)], Array(6).fill('word'), [''], 'word']) {
    expect(() =>
      parseModelOutput({ ...output, assignments: [{ ...output.assignments[0], keywords }] }, context),
    ).toThrow();
  }
  expect(() =>
    parseModelOutput({ ...output, assignments: [{ ...output.assignments[0], itemId: 'unknown' }] }, context),
  ).toThrow();
});
it('enriches only fresh native hits, preserves moves, prunes edits/deletion and never changes native fields', async () => {
  const { tree, store, area, record } = fixture();
  const original = structuredClone(tree);
  await store.remember(record);
  const records = await store.read();
  expect(new SearchIndex(tree).query('diagramming')).toEqual([]);
  expect(new SearchIndex(tree, records).query('diagramming')).toEqual([
    { id: '1', title: record.title, url: record.url, path: '学习资料' },
  ]);
  expect(tree).toEqual(original);
  tree.nodes[1]!.index = 2;
  await store.prune();
  expect(await store.read()).toHaveLength(1);
  expect(area.set).toHaveBeenCalledTimes(1);
  tree.nodes[1]!.title = 'Changed title';
  expect(new SearchIndex(tree, records).query('diagramming')).toEqual([]);
  await store.prune();
  expect(await store.read()).toEqual([]);
  await store.remember(record);
  expect(await store.read()).toEqual([]);
  tree.nodes[1]!.title = record.title;
  await store.remember(record);
  tree.nodes[1]!.url += '/changed';
  await store.prune();
  expect(await store.read()).toEqual([]);
  tree.nodes[1]!.url = record.url;
  await store.remember(record);
  tree.nodes = tree.nodes.filter(node => node.ref.nativeId !== '1');
  await store.prune();
  expect(await store.read()).toEqual([]);
});
it('serializes concurrent enrichment, refuses installation mismatch, and recovers from storage failure without replay', async () => {
  const { tree, store, area, record } = fixture();
  const second = { ...record, nativeId: '2', title: tree.nodes[2]!.title, url: tree.nodes[2]!.url! };
  await Promise.all([store.remember(record), store.remember(second)]);
  expect((await store.read()).map(item => item.nativeId)).toEqual(['1', '2']);
  await store.remember({ ...record, installationId: 'other' });
  expect(area.set).toHaveBeenCalledTimes(2);
  area.set.mockRejectedValueOnce(Error('quota'));
  await expect(store.remember({ ...record, keywords: ['changed'] })).rejects.toThrow('quota');
  expect((await store.read())[0]!.keywords).toEqual(record.keywords);
  await store.remember({ ...record, keywords: ['retry', 'retry'] });
  expect((await store.read()).at(-1)!.keywords).toEqual(['retry']);
});
it('updates active local queries without requesting a model and ignores stale sidecar metadata immediately', () => {
  const { tree, record } = fixture();
  const emit = vi.fn();
  const controller = new SearchController(emit);
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.setQuery('diagramming');
  expect(emit.mock.lastCall?.[0].hits).toEqual([]);
  controller.setKeywords([record]);
  expect(emit.mock.lastCall?.[0].hits.map((hit: { id: string }) => hit.id)).toEqual(['1']);
  tree.installationId = 'other';
  controller.setTree({ status: 'ready', snapshot: tree });
  expect(emit.mock.lastCall?.[0].hits).toEqual([]);
  controller.dispose();
});
it('uses only the final reconciled bookmark checkpoint and rejects uncertain or mismatched save evidence', () => {
  const result = {
    requestId: 'request',
    status: 'completed',
    needsReconcile: false,
    completedSteps: 2,
    remainingSteps: 0,
    evidence: [
      { stepIndex: 0, state: 'checkpointed', nativeId: 'folder', currentMatchesReceipt: true },
      { stepIndex: 1, state: 'checkpointed', nativeId: 'bookmark', currentMatchesReceipt: true },
    ],
  };
  expect(completedSaveBookmark(result, 'request')).toBe('bookmark');
  expect(() => completedSaveBookmark(result, 'other')).toThrow();
  expect(() => completedSaveBookmark({ ...result, status: 'unknown' }, 'request')).toThrow();
  expect(() => completedSaveBookmark({ ...result, evidence: result.evidence.slice(0, 1) }, 'request')).toThrow();
  expect(() =>
    completedSaveBookmark(
      { ...result, evidence: [{ ...result.evidence[1], currentMatchesReceipt: false }] },
      'request',
    ),
  ).toThrow();
});

it('bounds actual UTF-8 size and retains recent matching records', async () => {
  const tree = searchTree(1000);
  for (const node of tree.nodes) if (node.url) node.url += 'x'.repeat(4000);
  const records = tree.nodes
    .slice(1)
    .map(node => ({
      installationId: tree.installationId,
      nativeId: node.ref.nativeId,
      title: node.title,
      url: node.url!,
      keywords: ['流程图'],
    }));
  let stored: unknown = records;
  const store = new BookmarkKeywordsStore(
    {
      get: async () => ({ [BOOKMARK_KEYWORDS_KEY]: stored }),
      set: async items => {
        stored = items[BOOKMARK_KEYWORDS_KEY];
      },
    },
    async () => tree,
  );
  await store.remember(records[0]!);
  expect(new TextEncoder().encode(JSON.stringify(stored)).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect((await store.read()).at(-1)?.nativeId).toBe('1');
  expect((await store.read()).length).toBeLessThan(records.length);
});

it('a storage event fences a late page read and disposal removes its listener', async () => {
  const { record } = fixture();
  let resolve!: (data: Record<string, unknown>) => void;
  let listener!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const removeListener = vi.fn();
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: () =>
          new Promise(done => {
            resolve = done;
          }),
      },
      onChanged: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
        removeListener,
      },
    },
  });
  const receive = vi.fn();
  const stop = watchBookmarkKeywords(receive);
  listener({ [BOOKMARK_KEYWORDS_KEY]: { newValue: [record] } }, 'local');
  resolve({ [BOOKMARK_KEYWORDS_KEY]: [] });
  await Promise.resolve();
  await Promise.resolve();
  expect(receive).toHaveBeenCalledExactlyOnceWith([record]);
  stop();
  expect(removeListener).toHaveBeenCalledWith(listener);
});

it('the worker rejects untrusted or malformed attachment messages and rechecks native identity for trusted callers', async () => {
  const { store, record } = fixture();
  let listener!: Parameters<typeof chrome.runtime.onMessage.addListener>[0];
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension',
      onMessage: {
        addListener: (fn: typeof listener) => {
          listener = fn;
        },
      },
    },
  });
  const projection = { subscribe: vi.fn(() => () => {}) } as Pick<TreeProjection, 'subscribe'>;
  startBookmarkKeywords(store, projection);
  const message = { version: 1, type: 'rememberBookmarkKeywords', record };
  const reply = vi.fn();
  listener(message, { id: 'foreign', url: 'https://page.test' }, reply);
  expect(reply).toHaveBeenLastCalledWith({ status: 'untrusted' });
  const sender = { id: 'extension', url: 'chrome-extension://extension/options/index.html', frameId: 0 };
  listener({ ...message, record: { ...record, key: 'not-allowed' } }, sender, reply);
  expect(reply).toHaveBeenLastCalledWith({ status: 'invalid' });
  await new Promise<void>(resolve => listener(message, sender, () => resolve()));
  expect(await store.read()).toEqual([record]);
});
