import { afterEach, expect, it, vi } from 'vitest';
import { IDBDatabase, IDBFactory } from 'fake-indexeddb';
import { BookmarkCheckStore } from '../persistence/bookmark-check';
import { emptyBookmarkCheck } from '../domain/bookmark-check';

afterEach(() => vi.restoreAllMocks());

it('times out a stalled database open, closes its late connection and permits a fresh attempt', async () => {
  const factory = new IDBFactory();
  const pending = {} as IDBOpenDBRequest;
  const open = vi.spyOn(factory, 'open').mockReturnValueOnce(pending);
  const store = new BookmarkCheckStore(factory, 'open-retry', 30);
  await expect(store.read()).rejects.toThrow('storage-timeout');
  const late = { close: vi.fn() };
  Object.assign(pending, { result: late });
  pending.onsuccess!.call(pending, new Event('success'));
  expect(late.close).toHaveBeenCalledOnce();
  expect(await store.read()).toEqual(emptyBookmarkCheck());
  expect(open).toHaveBeenCalledTimes(2);
});

it.each(['read', 'write'] as const)(
  'aborts a stalled %s transaction so it cannot overwrite a later retry',
  async action => {
    const factory = new IDBFactory(),
      store = new BookmarkCheckStore(factory, 'transaction-retry', 40);
    const before = { ...emptyBookmarkCheck(), revision: 1 };
    await store.write(before);
    const original = IDBDatabase.prototype.transaction;
    let stalled!: IDBTransaction;
    let aborted = false;
    vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementationOnce(function (this: IDBDatabase, ...args) {
      stalled = original.apply(this, args);
      const state = stalled.objectStore('state');
      const keepAlive = () => {
        const request = state.get('keep-alive');
        request.onsuccess = keepAlive;
      };
      keepAlive();
      stalled.addEventListener('abort', () => {
        aborted = true;
      });
      return stalled;
    });
    const pending = action === 'read' ? store.read() : store.write({ ...before, revision: 2 });
    await expect(pending).rejects.toThrow('storage-timeout');
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(await store.read()).toEqual(before);
    const retry = { ...before, revision: 3 };
    await store.write(retry);
    expect(await new BookmarkCheckStore(factory, 'transaction-retry').read()).toEqual(retry);
  },
);
