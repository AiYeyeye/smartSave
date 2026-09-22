import { expect, it, vi } from 'vitest';
import { TreeProjection } from '../background/tree-projection';
import { installationIdentity } from '../background/installation-identity';
it('listens before reading and discards a read crossed by an external event', async () => {
  let event = () => {};
  let resolve!: (tree: chrome.bookmarks.BookmarkTreeNode[]) => void;
  const read = vi.fn(
    () =>
      new Promise<chrome.bookmarks.BookmarkTreeNode[]>(r => {
        resolve = r;
      }),
  );
  const projection = new TreeProjection(
    {
      read,
      listen: cb => {
        event = cb;
        return () => {};
      },
    },
    () => Promise.resolve('install'),
    'epoch',
  );
  projection.start();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  event();
  resolve([{ syncing: false, id: 'old', title: 'stale' }]);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(projection.state.status).toBe('loading');
  resolve([
    {
      syncing: false,
      id: 'root',
      title: '',
      children: [{ syncing: false, id: 'folder', title: 'fresh', parentId: 'root' }],
    },
  ]);
  await vi.waitFor(() => expect(projection.state.status).toBe('ready'));
  if (projection.state.status === 'ready') {
    expect(projection.state.snapshot.nodes.map(n => n.title)).toEqual(['', 'fresh']);
    expect(projection.state.snapshot.observedRevision).toBe(1);
    expect(projection.state.snapshot.nodes.every(n => n.readOnly)).toBe(true);
  }
  projection.stop();
});
it('initializes identity once concurrently and never replaces unreadable storage', async () => {
  const storage = { setAccessLevel: vi.fn(async () => {}), get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
  const identity = installationIdentity(storage, () => 'installation');
  expect(await Promise.all([identity(), identity()])).toEqual(['installation', 'installation']);
  expect(storage.set).toHaveBeenCalledTimes(1);
  const broken = {
    setAccessLevel: vi.fn(async () => {}),
    get: vi.fn(async () => {
      throw Error('denied');
    }),
    set: vi.fn(),
  };
  await expect(installationIdentity(broken)()).rejects.toThrow('denied');
  expect(broken.set).not.toHaveBeenCalled();
});

it('retries failed native reads and protects managed ancestry without marking all ordinary nodes protected', async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(Error())
    .mockResolvedValue([
      {
        id: 'r',
        title: '',
        children: [
          {
            id: 's',
            parentId: 'r',
            title: 'system',
            children: [
              {
                id: 'm',
                parentId: 's',
                title: 'managed',
                unmodifiable: 'managed',
                children: [
                  {
                    id: 'c',
                    parentId: 'm',
                    title: 'child',
                    children: [{ id: 'g', parentId: 'c', title: 'grandchild' }],
                  },
                ],
              },
              { id: 'u', parentId: 's', title: 'user' },
            ],
          },
        ],
      },
    ]);
  const projection = new TreeProjection({ read, listen: () => () => {} }, () => Promise.resolve('i'), 'e');
  projection.start();
  await vi.waitFor(() => expect(projection.state.status).toBe('error'));
  projection.refresh();
  await vi.waitFor(() => expect(projection.state.status).toBe('ready'));
  expect(read).toHaveBeenCalledTimes(2);
  if (projection.state.status === 'ready')
    expect(projection.state.snapshot.nodes.map(n => [n.ref.nativeId, n.readOnly])).toEqual([
      ['r', true],
      ['s', true],
      ['m', true],
      ['c', true],
      ['g', true],
      ['u', false],
    ]);
  projection.stop();
});
it('suppresses import intermediate trees and ignores completion after stop', async () => {
  let event: (kind?: 'import-begin' | 'import-end') => void = () => {};
  let resolve!: (value: chrome.bookmarks.BookmarkTreeNode[]) => void;
  const read = vi.fn(
    () =>
      new Promise<chrome.bookmarks.BookmarkTreeNode[]>(r => {
        resolve = r;
      }),
  );
  const projection = new TreeProjection(
    {
      read,
      listen: cb => {
        event = cb;
        return () => {};
      },
    },
    () => Promise.resolve('i'),
    'e',
  );
  projection.start();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  event('import-begin');
  resolve([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(projection.state.status).toBe('loading');
  event('import-end');
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  projection.stop();
  resolve([]);
  await Promise.resolve();
  expect(projection.state.status).toBe('loading');
});
it('does not accept identity write failure or malformed identity', async () => {
  await expect(
    installationIdentity({
      setAccessLevel: async () => {},
      get: async () => ({}),
      set: async () => {
        throw Error('quota');
      },
    })(),
  ).rejects.toThrow('quota');
  const set = vi.fn();
  await expect(
    installationIdentity({ setAccessLevel: async () => {}, get: async () => ({ installationId: 42 }), set })(),
  ).rejects.toThrow('Invalid');
  expect(set).not.toHaveBeenCalled();
});
it('delivers later external changes to an already subscribed view', async () => {
  let event = () => {};
  const read = vi
    .fn()
    .mockResolvedValueOnce([{ id: 'r', title: 'before' }])
    .mockResolvedValueOnce([{ id: 'r', title: 'after' }]);
  const projection = new TreeProjection(
    {
      read,
      listen: cb => {
        event = cb;
        return () => {};
      },
    },
    () => Promise.resolve('i'),
    'e',
  );
  const receive = vi.fn();
  projection.subscribe(receive);
  projection.start();
  await vi.waitFor(() => expect(projection.state.status).toBe('ready'));
  event();
  await vi.waitFor(() =>
    expect(receive).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'ready',
        snapshot: expect.objectContaining({
          observedRevision: 1,
          nodes: expect.arrayContaining([expect.objectContaining({ title: 'after' })]),
        }),
      }),
    ),
  );
  projection.stop();
});
