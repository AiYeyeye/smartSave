import { afterEach, expect, it, vi } from 'vitest';
import type { BookmarkSource } from '../adapters/bookmarks-read';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
import { TreeProjection } from '../background/tree-projection';
import { OwnWriteGuard } from '../background/own-write-guard';
import { isSaveFeatureConfigured, startNativeBookmarkIngress } from '../background/native-bookmark-ingress';
import { AiServicesStore, type ConnectedServiceRecord } from '../persistence/ai-services';
import { SettingsStore } from '../persistence/settings';
import { noopDebugLog } from '../domain/debug-log';
import { SaveReceiptLog, readSaveReceipts, SAVE_RECEIPTS_KEY, type SaveReceipt } from '../persistence/save-receipts';
import type { ApiMode } from '../domain/ai-providers';
import { ModelTransport } from '../adapters/model-transport';
import type { SiteRulesStore } from '../persistence/site-rules';
import { BookmarkKeywordsStore } from '../persistence/bookmark-keywords';
import { SearchIndex } from '../domain/search-index';

function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => {
      listeners.add(listener);
    },
    removeListener: (listener: T) => {
      listeners.delete(listener);
    },
    emit: (...args: Parameters<T>) => {
      listeners.forEach(listener => listener(...args));
    },
  };
}

const sampleService: ConnectedServiceRecord = {
  id: 'c1',
  name: 'OpenAI',
  serviceType: 'OpenAI',
  kind: 'api',
  detail: '',
  baseUrl: 'https://api.openai.com/v1',
  mode: 'openai',
  status: 'ok',
  letter: 'O',
  avatarClass: 'av-o',
  catalog: [{ id: 'gpt-4.1-mini', ctx: '128k' }],
  enabled: ['gpt-4.1-mini'],
};

function memoryStorage() {
  const data: Record<string, unknown> = {};
  return {
    storage: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (value: Record<string, unknown>) => {
        Object.assign(data, value);
      },
      remove: async (key: string) => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function harness(
  opts: {
    configureSave?: boolean;
    settlingMs?: number;
    syncLegacy?: boolean;
    rememberKey?: boolean;
    mode?: ApiMode;
    streaming?: boolean;
    initialReceipts?: SaveReceipt[];
    rules?: Pick<SiteRulesStore, 'load' | 'subscribe'>;
  } = {},
) {
  let nextId = 10;
  const tree: chrome.bookmarks.BookmarkTreeNode[] = [
    {
      syncing: false,
      id: '0',
      title: '',
      children: [
        {
          syncing: false,
          id: '1',
          parentId: '0',
          title: 'Bar',
          children: [],
        },
        {
          syncing: false,
          id: '2',
          parentId: '0',
          title: 'Other',
          children: [],
        },
      ],
    },
  ];
  const changeListeners = new Set<() => void>();
  const source: BookmarkSource = {
    read: async () => structuredClone(tree),
    listen: cb => {
      changeListeners.add(cb);
      return () => {
        changeListeners.delete(cb);
      };
    },
  };
  const projection = new TreeProjection(source, async () => 'install', 'epoch');
  projection.start();
  await projection.fresh();

  const writer: BookmarkWriter = {
    create: async details => {
      const id = String(nextId++);
      const node: chrome.bookmarks.BookmarkTreeNode = {
        syncing: false,
        id,
        parentId: details.parentId,
        title: details.title,
        url: details.url,
        children: details.url === undefined ? [] : undefined,
      };
      const parent = find(details.parentId);
      if (!parent.children) parent.children = [];
      parent.children.push(node);
      changeListeners.forEach(cb => cb());
      return structuredClone(node);
    },
    update: async () => {
      throw Error('unused');
    },
    move: async (id, destination) => {
      const node = detach(id);
      node.parentId = destination.parentId;
      const parent = find(destination.parentId);
      if (!parent.children) parent.children = [];
      parent.children.splice(destination.index, 0, node);
      changeListeners.forEach(cb => cb());
      return structuredClone(node);
    },
    remove: async () => {},
  };

  function find(id: string): chrome.bookmarks.BookmarkTreeNode {
    const stack = [...tree];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      if (n.children) stack.push(...n.children);
    }
    throw Error(`missing ${id}`);
  }
  function detach(id: string): chrome.bookmarks.BookmarkTreeNode {
    const stack = [...tree];
    while (stack.length) {
      const n = stack.pop()!;
      if (!n.children) continue;
      const idx = n.children.findIndex(c => c.id === id);
      if (idx >= 0) return n.children.splice(idx, 1)[0]!;
      stack.push(...n.children);
    }
    throw Error(`missing ${id}`);
  }

  const { storage } = memoryStorage();
  if (opts.initialReceipts) await storage.set({ [SAVE_RECEIPTS_KEY]: opts.initialReceipts });
  const ai = new AiServicesStore(storage, run => run());
  const settings = new SettingsStore(storage, run => run());
  await ai.load();
  await settings.load();
  if (opts.configureSave !== false) {
    await ai.upsertService(
      {
        ...sampleService,
        mode: opts.mode ?? sampleService.mode,
        ...(opts.streaming === undefined ? {} : { streaming: opts.streaming }),
      },
      'sk-test',
      opts.rememberKey !== false,
    );
    await ai.saveFeatures([
      { id: 'save', name: '智能收藏', desc: '', connId: 'c1', modelId: 'gpt-4.1-mini' },
      { id: 'import', name: '智能导入', desc: '', connId: '', modelId: '' },
      { id: 'search', name: '智能搜索', desc: '', connId: '', modelId: '' },
      { id: 'organize', name: '智能整理', desc: '', connId: '', modelId: '' },
      { id: 'classify', name: '页面分类', desc: '', connId: '', modelId: '' },
    ]);
    if (opts.syncLegacy !== false) await ai.syncPrimaryToSettings(settings);
  }
  // A fresh worker-side store sees only what storage holds (no in-page session keys).
  const workerAi = new AiServicesStore(storage, run => run());
  const receipts = new SaveReceiptLog(storage);

  const onCreated = event<(id: string, node: chrome.bookmarks.BookmarkTreeNode) => void>();
  const onRemoved = event<(id: string) => void>();
  const onImportBegan = event<() => void>();
  const onImportEnded = event<() => void>();
  const guard = new OwnWriteGuard();
  const wrapped = guard.wrap(writer);
  const fetchMock = vi.fn<typeof fetch>();
  const permissions = { contains: vi.fn(async () => true) };
  const keywords = new BookmarkKeywordsStore(storage, () => projection.fresh());

  const ingress = startNativeBookmarkIngress({
    projection,
    settings,
    aiServices: workerAi,
    receipts,
    writer: wrapped,
    guard,
    settlingMs: opts.settlingMs ?? 10,
    debug: noopDebugLog,
    bookmarks: {
      onCreated,
      onRemoved,
      onImportBegan,
      onImportEnded,
    },
    permissions,
    fetch: fetchMock,
    rules: opts.rules,
    keywords,
  });

  return {
    tree: () => tree,
    find,
    onCreated,
    onRemoved,
    onImportBegan,
    onImportEnded,
    ingress,
    guard,
    wrapped,
    fetchMock,
    ai,
    settings,
    writer,
    projection,
    storage,
    keywords,
  };
}

it('one native save request enriches local search only after successful readback', async () => {
  const h = await harness({ streaming: false });
  const node = {
    syncing: false,
    id: 'keyword-book',
    parentId: '1',
    title: 'Drawing site',
    url: 'https://drawing.test/',
  };
  h.find('1').children!.push(node);
  await h.writer.create({ parentId: '2', title: '_touch' });
  h.fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assignments: [{ itemId: node.id, folderId: '2', keywords: ['流程图', 'diagramming', '图表'] }],
                newFolders: [],
              }),
            },
          },
        ],
      }),
    ),
  );
  expect(await h.ingress.classify(node.id)).toMatchObject({ status: 'completed' });
  expect(h.fetchMock).toHaveBeenCalledOnce();
  expect(
    new SearchIndex(await h.projection.fresh(), await h.keywords.read()).query('diagramming').map(hit => hit.id),
  ).toEqual([node.id]);
  h.ingress.dispose();
});

it('recovers abandoned receipts before new saves without replaying any model or bookmark writes', async () => {
  const pending: SaveReceipt = {
    id: 'old',
    bookmarkId: 'old-bookmark',
    title: 'Old',
    url: 'https://example.test/',
    at: 123,
    status: 'classifying',
    fromParentId: '1',
    fromIndex: 0,
    fromPath: 'Bar',
    createdFolderIds: ['uncertain-folder'],
  };
  const completed: SaveReceipt = { ...pending, id: 'done', status: 'moved', toId: '2' };
  const h = await harness({ initialReceipts: [pending, completed] });
  const create = vi.spyOn(h.writer, 'create');
  const move = vi.spyOn(h.writer, 'move');
  await vi.waitFor(async () =>
    expect((await readSaveReceipts(h.storage))[0]).toMatchObject({
      ...pending,
      status: 'failed',
      reason: 'worker-interrupted',
    }),
  );
  expect((await readSaveReceipts(h.storage))[1]).toEqual(completed);
  expect(h.fetchMock).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(move).not.toHaveBeenCalled();
  h.ingress.dispose();
});

it('never reuses automatic undo after an explicit correction attempt', async () => {
  const h = await harness({
    initialReceipts: [
      {
        id: 'corrected',
        bookmarkId: 'book',
        title: 'Book',
        url: 'https://example.test/',
        at: 1,
        status: 'moved',
        fromParentId: '1',
        fromIndex: 0,
        fromPath: 'Bar',
        toId: '2',
        correction: {
          requestId: 'correction',
          status: 'completed',
          target: { installationId: 'install', nativeId: '2', kind: 'folder' },
        },
      },
    ],
  });
  const move = vi.spyOn(h.writer, 'move');
  expect(await h.ingress.undo('corrected')).toEqual({ status: 'refused', reason: 'not-undoable' });
  expect(move).not.toHaveBeenCalled();
  expect(h.fetchMock).not.toHaveBeenCalled();
  h.ingress.dispose();
});

it.each(['complete', 'timeout', 'dispose'] as const)(
  'keeps a slow native save alive and releases after %s',
  async outcome => {
    vi.useFakeTimers();
    const h = await harness();
    const pulse = vi.fn(async () => ({}));
    vi.stubGlobal('chrome', { runtime: { getPlatformInfo: pulse } });
    h.find('1').children!.push({
      syncing: false,
      id: 'slow',
      parentId: '1',
      title: 'Slow',
      url: 'https://example.test/',
    });
    await h.projection.refresh();
    let reply!: (response: Response) => void;
    h.fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          reply = resolve;
        }),
    );
    const run = h.ingress.classify('slow');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(h.fetchMock).toHaveBeenCalledOnce();
    expect(pulse).toHaveBeenCalledTimes(3);
    expect((await readSaveReceipts(h.storage))[0]?.status).toBe('classifying');
    if (outcome === 'complete') {
      reply(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assignments: [{ itemId: 'slow', folderId: '1' }],
                    newFolders: [],
                  }),
                },
              },
            ],
          }),
        ),
      );
    } else if (outcome === 'dispose') h.ingress.dispose();
    else await vi.advanceTimersByTimeAsync(20_000);
    await run;
    expect((await readSaveReceipts(h.storage))[0]).toMatchObject(
      outcome === 'complete'
        ? { status: 'kept' }
        : { status: 'failed', reason: outcome === 'dispose' ? 'cancelled' : 'timeout' },
    );
    const calls = pulse.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(pulse).toHaveBeenCalledTimes(calls);
    h.ingress.dispose();
  },
);

it.each([false, true])('native save respects service streaming=%s without legacy synchronization', async streaming => {
  const h = await harness({ mode: 'openai-responses', streaming, syncLegacy: false, settlingMs: 5 });
  const text = JSON.stringify({ assignments: [{ itemId: 'stream-save', folderId: '2' }], newFolders: [] });
  h.fetchMock.mockImplementation(async (_url, init) => {
    expect(JSON.parse(String(init?.body)).stream).toBe(streaming);
    if (!streaming) return new Response(JSON.stringify({ status: 'completed', output_text: text }));
    return new Response(
      `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text' }] }] } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  });
  const node = { syncing: false, id: 'stream-save', parentId: '1', title: 'Documentation', url: 'https://docs.test/' };
  h.find('1').children!.push(node);
  await h.writer.create({ parentId: '2', title: '_touch' });
  h.onCreated.emit(node.id, node);
  await vi.waitFor(async () => expect((await readSaveReceipts(h.storage))[0]?.status).toBe('moved'));
  expect(h.find(node.id).parentId).toBe('2');
  h.ingress.dispose();
});

it.each(['privacy', 'metadata', 'user-move', 'dispose'])(
  'native auto-save rechecks %s after model completion before writing',
  async change => {
    const h = await harness();
    const node = { syncing: false, id: 'race', parentId: '1', title: 'Before', url: 'https://race.test/' };
    h.find('1').children!.push(node);
    await h.projection.refresh();
    h.fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assignments: [{ itemId: 'race', folderId: '2' }],
                    newFolders: [],
                  }),
                },
              },
            ],
          }),
        ),
    );
    const original = ModelTransport.prototype.run;
    let calls = 0;
    vi.spyOn(ModelTransport.prototype, 'run').mockImplementation(async function (this: ModelTransport, input) {
      const result = await original.call(this, input);
      // The race happens once; a retry sees settled state.
      if (calls++) return result;
      expect(result.status).toBe('completed');
      if (change === 'dispose') h.ingress.dispose();
      else if (change === 'metadata') {
        h.find('race').title = 'Changed by user';
        await h.projection.refresh();
      } else if (change === 'user-move') {
        // The user picks a folder in the browser's own bookmark dialog while the model is running.
        const from = h.find('1').children!;
        const moved = from.splice(
          from.findIndex(child => child.id === 'race'),
          1,
        )[0]!;
        moved.parentId = '2';
        h.find('2').children!.push(moved);
        await h.projection.refresh();
      } else {
        const snapshot = await h.projection.fresh();
        const current = await h.settings.snapshot();
        await h.settings.save(
          current.config!,
          { ...current.privacy, excludedFolders: [snapshot.nodes.find(n => n.ref.nativeId === '2')!.ref] },
          current.key,
          true,
        );
      }
      return result;
    });
    const move = vi.spyOn(h.writer, 'move');
    const create = vi.spyOn(h.writer, 'create');
    if (change === 'metadata') {
      // Nothing was written, so a renamed bookmark is classified once more on fresh state instead of failing.
      expect(await h.ingress.classify(node.id)).toMatchObject({ status: 'completed', destinationId: '2' });
      expect(ModelTransport.prototype.run).toHaveBeenCalledTimes(2);
      expect(move).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
      expect((await readSaveReceipts(h.storage)).map(receipt => receipt.status)).toEqual(['moved']);
    } else if (change === 'user-move') {
      expect(await h.ingress.classify(node.id)).toMatchObject({ status: 'skipped', reason: 'user-placed' });
      expect(move).not.toHaveBeenCalled();
      expect(h.find('race').parentId).toBe('2');
      expect((await readSaveReceipts(h.storage))[0]).toMatchObject({
        status: 'kept',
        reason: 'user-placed',
        toId: '2',
      });
    } else if (change === 'privacy') {
      // The retry sees folder 2 excluded, so the stale model answer can never move the bookmark there.
      expect(await h.ingress.classify(node.id)).toMatchObject({ status: 'failed' });
      expect(move).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(h.find('race').parentId).toBe('1');
    } else {
      expect(await h.ingress.classify(node.id)).toMatchObject({ status: 'failed', reason: 'stale-context' });
      expect(move).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(h.find('race').parentId).toBe('1');
    }
    h.ingress.dispose();
  },
);

it('stops before later native calls if settings change during folder creation', async () => {
  const h = await harness();
  const node = { syncing: false, id: 'create-race', parentId: '1', title: 'Before', url: 'https://race.test/' };
  h.find('1').children!.push(node);
  await h.projection.refresh();
  h.fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assignments: [{ itemId: node.id, folderId: 'nested' }],
                newFolders: [
                  { id: 'new', parentId: '2', title: 'New' },
                  { id: 'nested', parentId: 'new', title: 'Nested' },
                ],
              }),
            },
          },
        ],
      }),
    ),
  );
  const original = h.writer.create;
  const create = vi.spyOn(h.writer, 'create').mockImplementation(async details => {
    const created = await original(details);
    const current = await h.settings.snapshot();
    await h.settings.save(
      current.config!,
      { ...current.privacy, fullUrl: !current.privacy.fullUrl },
      current.key,
      true,
    );
    return created;
  });
  const move = vi.spyOn(h.writer, 'move');
  expect(await h.ingress.classify(node.id)).toMatchObject({ status: 'failed', reason: 'stale-context' });
  expect(create).toHaveBeenCalledOnce();
  expect(move).not.toHaveBeenCalled();
  expect((await readSaveReceipts(h.storage))[0]).toMatchObject({
    status: 'failed',
    createdFolderIds: [expect.any(String)],
  });
  h.ingress.dispose();
});

it('disposing cancels every parallel native classification and prevents late writes', async () => {
  const h = await harness();
  for (const id of ['parallel-a', 'parallel-b'])
    h.find('1').children!.push({ syncing: false, id, parentId: '1', title: id, url: `https://${id}.test/` });
  await h.projection.refresh();
  const signals: AbortSignal[] = [];
  h.fetchMock.mockImplementation(async (_url, init) => {
    signals.push(init!.signal!);
    return new Promise<Response>(() => {});
  });
  const first = h.ingress.classify('parallel-a');
  const second = h.ingress.classify('parallel-b');
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  h.ingress.dispose();
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(await Promise.all([first, second])).toEqual([
    expect.objectContaining({ status: 'failed', reason: 'cancelled' }),
    expect.objectContaining({ status: 'failed', reason: 'cancelled' }),
  ]);
});

it('does not record success when a native move resolves without the expected readback', async () => {
  const h = await harness();
  const node = { syncing: false, id: 'readback', parentId: '1', title: 'Before', url: 'https://readback.test/' };
  h.find('1').children!.push(node);
  await h.projection.refresh();
  h.fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                assignments: [{ itemId: node.id, folderId: '2' }],
                newFolders: [],
              }),
            },
          },
        ],
      }),
    ),
  );
  const move = vi.spyOn(h.writer, 'move').mockResolvedValue({ ...node, parentId: '2' });
  expect(await h.ingress.classify(node.id)).toMatchObject({ status: 'failed', reason: 'native-write-uncertain' });
  expect(move).toHaveBeenCalledOnce();
  expect((await readSaveReceipts(h.storage))[0]?.status).toBe('failed');
  h.ingress.dispose();
});

it.each(['response.failed', 'response.incomplete', 'missing-terminal', 'refusal'])(
  'native save never moves valid partial classification when stream ends with %s',
  async terminal => {
    const h = await harness({ mode: 'openai-responses', settlingMs: 5 });
    const text = JSON.stringify({ assignments: [{ itemId: 'failed-stream', folderId: '2' }], newFolders: [] });
    const values: unknown[] = [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text }];
    if (terminal === 'refusal') values.push({ type: 'response.refusal.done', refusal: 'no' });
    else if (terminal !== 'missing-terminal') values.push({ type: terminal, response: { status: terminal.slice(9) } });
    h.fetchMock.mockImplementation(
      async () =>
        new Response(values.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const node = {
      syncing: false,
      id: 'failed-stream',
      parentId: '1',
      title: 'Documentation',
      url: 'https://docs.test/',
    };
    h.find('1').children!.push(node);
    await h.writer.create({ parentId: '2', title: '_touch' });
    const move = vi.spyOn(h.writer, 'move');
    const create = vi.spyOn(h.writer, 'create');
    h.onCreated.emit(node.id, node);
    await vi.waitFor(async () => expect((await readSaveReceipts(h.storage))[0]?.status).toBe('failed'));
    expect(h.find(node.id).parentId).toBe('1');
    expect(move).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(h.fetchMock).toHaveBeenCalledOnce();
    h.ingress.dispose();
  },
);

it('isSaveFeatureConfigured requires save connId+modelId and a service baseUrl', async () => {
  const { storage } = memoryStorage();
  const ai = new AiServicesStore(storage, run => run());
  await ai.load();
  expect(isSaveFeatureConfigured(ai)).toBe(false);
  await ai.upsertService(sampleService, 'k', true);
  await ai.saveFeatures([
    { id: 'save', name: '智能收藏', desc: '', connId: 'c1', modelId: 'gpt-4.1-mini' },
    { id: 'import', name: '智能导入', desc: '', connId: '', modelId: '' },
    { id: 'search', name: '智能搜索', desc: '', connId: '', modelId: '' },
    { id: 'organize', name: '智能整理', desc: '', connId: '', modelId: '' },
    { id: 'classify', name: '页面分类', desc: '', connId: '', modelId: '' },
  ]);
  expect(isSaveFeatureConfigured(ai)).toBe(true);
});

it('skips plugin-created bookmarks and unconfigured save feature', async () => {
  const h = await harness({ configureSave: false, settlingMs: 5 });
  const created = await h.wrapped.create({ parentId: '1', title: 'Mine', url: 'https://mine.test/' });
  h.onCreated.emit(created.id, created);
  await vi.waitFor(async () => {
    // settle timer fired
  });
  await new Promise(r => setTimeout(r, 20));
  expect(h.fetchMock).not.toHaveBeenCalled();

  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u1',
    parentId: '1',
    title: 'User',
    url: 'https://user.test/',
  };
  h.find('1').children!.push(userNode);
  h.onCreated.emit('u1', userNode);
  await new Promise(r => setTimeout(r, 20));
  expect(h.fetchMock).not.toHaveBeenCalled();
  h.ingress.dispose();
});

it('after settling, runs TASKS.save and moves the bookmark into a suggested existing folder', async () => {
  const h = await harness({ settlingMs: 5 });
  h.fetchMock.mockImplementation(async () => {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              assignments: [{ itemId: 'u2', folderId: '2' }],
              newFolders: [],
            }),
          },
        },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u2',
    parentId: '1',
    title: 'Docs',
    url: 'https://docs.test/guide',
  };
  h.find('1').children!.push(userNode);
  // Simulate projection noticing the create (browser would fire change listeners via bookmarksRead).
  // Our fake source listeners are not tied to onCreated; bump via a no-op create/mark path:
  // Call projection refresh by mutating through a marked write that we then ignore... simpler: touch via writer.create of a temp folder then remove — or just rely on fresh() reading tree.
  // Tree already has u2 in the array; revision must bump for fresh waiters. Emit via source listen by doing a fake write:
  await h.writer.create({ parentId: '2', title: '_touch' });

  h.onCreated.emit('u2', userNode);
  await vi.waitFor(
    () => {
      expect(h.fetchMock).toHaveBeenCalled();
    },
    { timeout: 2000 },
  );
  await vi.waitFor(() => {
    expect(h.find('u2').parentId).toBe('2');
  });
  // Request body includes task save system prompt marker via model transport
  const init = h.fetchMock.mock.calls[0]![1] as RequestInit;
  const body = String(init.body);
  expect(body).toContain('choose the single best destination folder');
  expect(body).toContain('u2');
  h.ingress.dispose();
});

it('creates suggested folders then moves, and marks creates as own so they do not re-enter', async () => {
  const h = await harness({ settlingMs: 5 });
  h.fetchMock.mockImplementation(async () => {
    const body = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              assignments: [{ itemId: 'u3', folderId: 'nf1' }],
              newFolders: [{ id: 'nf1', parentId: '2', title: 'Reading' }],
            }),
          },
        },
      ],
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });

  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u3',
    parentId: '1',
    title: 'Article',
    url: 'https://article.test/',
  };
  h.find('1').children!.push(userNode);
  await h.writer.create({ parentId: '2', title: '_touch2' });

  const seenCreates: string[] = [];
  const orig = h.onCreated.emit.bind(h.onCreated);
  // When wrapped writer creates, ingress would also see onCreated in production; simulate:
  const prevCreate = h.wrapped.create;
  h.wrapped.create = async details => {
    const node = await prevCreate(details);
    seenCreates.push(node.id);
    h.onCreated.emit(node.id, node);
    return node;
  };

  h.onCreated.emit('u3', userNode);
  await vi.waitFor(() => expect(h.find('u3').parentId).not.toBe('1'), { timeout: 2000 });
  expect(seenCreates.length).toBeGreaterThanOrEqual(1);
  // plugin-created folder should be skipped (no second model call for folder)
  expect(h.fetchMock).toHaveBeenCalledTimes(1);
  void orig;
  h.ingress.dispose();
});

it('skips bookmarks observed during an import window', async () => {
  const h = await harness({ settlingMs: 5 });
  h.onImportBegan.emit();
  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u4',
    parentId: '1',
    title: 'Imported',
    url: 'https://imported.test/',
  };
  h.find('1').children!.push(userNode);
  h.onCreated.emit('u4', userNode);
  await new Promise(r => setTimeout(r, 30));
  expect(h.fetchMock).not.toHaveBeenCalled();
  h.onImportEnded.emit();
  h.ingress.dispose();
});

function modelReply(itemId: string, folderId: string) {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ assignments: [{ itemId, folderId }], newFolders: [] }) } }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
}

it('applies an explicit site rule before AI even without a configured model or host permission, and remains undoable', async () => {
  const rules = {
    load: vi.fn(async () => [
      {
        host: 'rule.test',
        includeSubdomains: false,
        folder: { installationId: 'test-install', nativeId: '2', kind: 'folder' as const },
      },
    ]),
    subscribe: () => () => {},
  };
  const h = await harness({ configureSave: false, rules });
  const snapshot = await h.projection.fresh();
  rules.load.mockImplementation(async () => [
    {
      host: 'rule.test',
      includeSubdomains: false,
      folder: { installationId: snapshot.installationId, nativeId: '2', kind: 'folder' as const },
    },
  ]);
  h.find('1').children!.push({
    syncing: false,
    id: 'local',
    parentId: '1',
    title: 'Local',
    url: 'https://rule.test/page',
  });
  h.projection.refresh();
  await h.projection.fresh();
  expect(await h.ingress.classify('local')).toEqual({
    status: 'completed',
    bookmarkId: 'local',
    destinationId: '2',
    createdFolderIds: [],
  });
  expect(h.fetchMock).not.toHaveBeenCalled();
  const receipt = (await readSaveReceipts(h.storage))[0]!;
  expect(receipt).toMatchObject({ status: 'moved', source: 'rule', model: '本地网站规则', toId: '2' });
  expect(receipt.timing?.model).toBeUndefined();
  expect(await h.ingress.undo(receipt.id)).toEqual({ status: 'undone' });
  expect(h.find('local').parentId).toBe('1');
  h.ingress.dispose();
});

it('stops a local move if its rule is revoked during the last authoritative check', async () => {
  let invalidate = () => {};
  const rules = {
    load: vi.fn<SiteRulesStore['load']>(),
    subscribe: (listener: () => void) => {
      invalidate = listener;
      return () => {};
    },
  };
  const h = await harness({ configureSave: false, rules });
  const snapshot = await h.projection.fresh();
  const rule = {
    host: 'rule.test',
    includeSubdomains: false,
    folder: { installationId: snapshot.installationId, nativeId: '2', kind: 'folder' as const },
  };
  rules.load
    .mockResolvedValueOnce([rule])
    .mockImplementationOnce(async () => {
      invalidate();
      return [rule];
    })
    // The rule is gone when the stale run is retried on fresh state.
    .mockResolvedValue([]);
  h.find('1').children!.push({
    syncing: false,
    id: 'revoked',
    parentId: '1',
    title: 'Local',
    url: 'https://rule.test/page',
  });
  h.projection.refresh();
  await h.projection.fresh();
  const move = vi.spyOn(h.writer, 'move');
  expect(await h.ingress.classify('revoked')).toMatchObject({
    status: 'skipped',
    reason: 'save-feature-unconfigured',
  });
  expect(move).not.toHaveBeenCalled();
  expect(h.fetchMock).not.toHaveBeenCalled();
  h.ingress.dispose();
});

it('classifies from the AI services assignment alone, without the legacy single-connection settings', async () => {
  const h = await harness({ settlingMs: 5, syncLegacy: false });
  h.fetchMock.mockImplementation(modelReply('u5', '2'));
  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u5',
    parentId: '1',
    title: 'Guide',
    url: 'https://guide.test/',
  };
  h.find('1').children!.push(userNode);
  await h.writer.create({ parentId: '2', title: '_touch5' });
  h.onCreated.emit('u5', userNode);
  await vi.waitFor(() => expect(h.find('u5').parentId).toBe('2'), { timeout: 2000 });
  const [receipt] = await readSaveReceipts(h.storage);
  expect(receipt).toMatchObject({ bookmarkId: 'u5', status: 'moved', fromParentId: '1', toId: '2', toPath: 'Other' });
  expect(receipt!.model).toContain('gpt-4.1-mini');
  expect(receipt!.timing?.totalMs).toBeGreaterThanOrEqual(receipt!.ms!);
  expect(receipt!.timing?.prepareMs).toBeGreaterThanOrEqual(5);
  expect(receipt!.timing?.model).toMatchObject({ attempts: 1, streaming: false });
  expect(receipt!.timing?.model?.firstTokenMs).toBeUndefined();
  h.ingress.dispose();
});

it('leaves a visible receipt when AI was not called because no model is assigned', async () => {
  const h = await harness({ settlingMs: 5, configureSave: false });
  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u6',
    parentId: '1',
    title: 'Plain',
    url: 'https://plain.test/',
  };
  h.find('1').children!.push(userNode);
  await h.writer.create({ parentId: '2', title: '_touch6' });
  h.onCreated.emit('u6', userNode);
  await vi.waitFor(async () => expect((await readSaveReceipts(h.storage))[0]?.status).toBe('skipped'), {
    timeout: 2000,
  });
  expect((await readSaveReceipts(h.storage))[0]?.reason).toBe('save-feature-unconfigured');
  expect(h.fetchMock).not.toHaveBeenCalled();
  h.ingress.dispose();
});

it('reports no-key instead of silently failing when the key was not remembered', async () => {
  const h = await harness({ settlingMs: 5, rememberKey: false });
  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u7',
    parentId: '1',
    title: 'Keyless',
    url: 'https://keyless.test/',
  };
  h.find('1').children!.push(userNode);
  await h.writer.create({ parentId: '2', title: '_touch7' });
  h.onCreated.emit('u7', userNode);
  await vi.waitFor(async () => expect((await readSaveReceipts(h.storage))[0]?.reason).toBe('no-key'), {
    timeout: 2000,
  });
  expect(h.fetchMock).not.toHaveBeenCalled();
  h.ingress.dispose();
});

it('undo moves the bookmark back and removes empty folders the save created', async () => {
  const h = await harness({ settlingMs: 5 });
  h.fetchMock.mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: [{ itemId: 'u8', folderId: 'nf8' }],
                  newFolders: [{ id: 'nf8', parentId: '2', title: 'Later' }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const userNode: chrome.bookmarks.BookmarkTreeNode = {
    syncing: false,
    id: 'u8',
    parentId: '1',
    title: 'Undo me',
    url: 'https://undo.test/',
  };
  h.find('1').children!.push(userNode);
  await h.writer.create({ parentId: '2', title: '_touch8' });
  const removed: string[] = [];
  const remove = h.writer.remove;
  h.wrapped.remove = async id => {
    removed.push(id);
    const parent = h.find('2');
    parent.children = parent.children!.filter(child => child.id !== id);
    await remove(id);
  };
  h.onCreated.emit('u8', userNode);
  await vi.waitFor(async () => expect((await readSaveReceipts(h.storage))[0]?.status).toBe('moved'), {
    timeout: 2000,
  });
  const [receipt] = await readSaveReceipts(h.storage);
  expect(receipt!.toPath).toBe('Other / Later');
  await expect(h.ingress.undo(receipt!.id)).resolves.toEqual({ status: 'undone' });
  expect(h.find('u8').parentId).toBe('1');
  expect(removed).toEqual(receipt!.createdFolderIds);
  expect((await readSaveReceipts(h.storage))[0]?.status).toBe('undone');
  h.ingress.dispose();
});
