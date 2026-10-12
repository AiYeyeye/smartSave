import { afterEach, expect, it, vi } from 'vitest';
import type { BookmarkSource } from '../adapters/bookmarks-read';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
import { TreeProjection } from '../background/tree-projection';
import { OwnWriteGuard } from '../background/own-write-guard';
import { isSaveFeatureConfigured, startNativeBookmarkIngress } from '../background/native-bookmark-ingress';
import { AiServicesStore, type ConnectedServiceRecord } from '../persistence/ai-services';
import { SettingsStore } from '../persistence/settings';
import { noopDebugLog } from '../domain/debug-log';
import { SaveReceiptLog, readSaveReceipts } from '../persistence/save-receipts';

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
  opts: { configureSave?: boolean; settlingMs?: number; syncLegacy?: boolean; rememberKey?: boolean } = {},
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
  const ai = new AiServicesStore(storage, run => run());
  const settings = new SettingsStore(storage, run => run());
  await ai.load();
  await settings.load();
  if (opts.configureSave !== false) {
    await ai.upsertService(sampleService, 'sk-test', opts.rememberKey !== false);
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
  };
}

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
