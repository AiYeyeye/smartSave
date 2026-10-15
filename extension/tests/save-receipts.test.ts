import { expect, it, vi } from 'vitest';
import { SaveReceiptLog, SAVE_RECEIPTS_KEY, type SaveReceipt } from '../persistence/save-receipts';

it('queues startup recovery before current-run writes and preserves terminal receipts', async () => {
  const old: SaveReceipt = {
    id: 'old',
    bookmarkId: 'b',
    title: 'Title',
    url: 'https://example.test/',
    at: 1,
    status: 'classifying',
    fromParentId: '1',
    fromIndex: 0,
    fromPath: 'Bar',
  };
  const moved: SaveReceipt = { ...old, id: 'moved', status: 'moved', toId: '2', createdFolderIds: ['2'] };
  let list = [old, moved];
  const storage = {
    get: async () => ({ [SAVE_RECEIPTS_KEY]: structuredClone(list) }),
    set: vi.fn(async (data: Record<string, unknown>) => {
      list = data[SAVE_RECEIPTS_KEY] as SaveReceipt[];
    }),
  };
  const log = new SaveReceiptLog(storage);
  const recovery = log.interruptPending();
  const current: SaveReceipt = { ...old, id: 'new' };
  const write = log.upsert(current);
  expect(await recovery).toBe(1);
  await write;
  expect(list).toEqual([current, { ...old, status: 'failed', reason: 'worker-interrupted' }, moved]);
  await log.patch(current.id, { status: 'kept' });
  const calls = storage.set.mock.calls.length;
  expect(await new SaveReceiptLog(storage).interruptPending()).toBe(0);
  expect(storage.set).toHaveBeenCalledTimes(calls);
});
