import { expect, it, vi } from 'vitest';
import { OrganizeMemoryStore } from '../persistence/organize-memory';

function setup() {
  const data: Record<string, unknown> = {};
  const storage = {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(data, structuredClone(value));
    }),
    setAccessLevel: vi.fn(async () => {}),
  };
  return { storage, data, store: new OrganizeMemoryStore(storage) };
}
it('persists explicit protection/rejection choices by installation and merges queued changes', async () => {
  const h = setup();
  await Promise.all([
    h.store.update('one', value => ({ ...value, protectedFolderIds: ['left'] })),
    h.store.update('one', value => ({ ...value, rejected: [{ signature: 'key', label: '不合并' }] })),
  ]);
  expect(await new OrganizeMemoryStore(h.storage).load('one')).toMatchObject({
    protectedFolderIds: ['left'],
    rejected: [{ signature: 'key', label: '不合并' }],
  });
  expect((await h.store.load('two')).rejected).toEqual([]);
  await h.store.update('one', value => ({ ...value, rejected: [] }));
  expect((await h.store.load('one')).protectedFolderIds).toEqual(['left']);
  expect(h.storage.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
});
it('rejects corrupt data and failed writes instead of pretending preferences were saved', async () => {
  const h = setup();
  h.data['organize.memory.one'] = { version: 1, protectedFolderIds: 'invalid', rejected: [] };
  await expect(h.store.load('one')).rejects.toThrow();
  h.storage.set.mockRejectedValueOnce(Error('quota'));
  await expect(h.store.update('two', value => ({ ...value, protectedFolderIds: ['x'] }))).rejects.toThrow('quota');
  expect((await h.store.load('two')).protectedFolderIds).toEqual([]);
  await h.store.update('two', value => ({ ...value, protectedFolderIds: ['y'] }));
  expect((await h.store.load('two')).protectedFolderIds).toEqual(['y']);
});
it('bounds stalled reads and never converts a late result into a successful load', async () => {
  vi.useFakeTimers();
  try {
    const h = setup();
    h.storage.get.mockImplementationOnce(() => new Promise(() => {}));
    const pending = expect(h.store.load('one')).rejects.toThrow('organize-memory-timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(h.storage.set).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
