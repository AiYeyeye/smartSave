import { expect, it, vi } from 'vitest';
import { SaveReceiptLog, SAVE_RECEIPTS_KEY, pendingSaveReceipts, type SaveReceipt } from '../persistence/save-receipts';

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

it('durably dismisses reminders without changing recovery evidence or resurrecting on late upserts', async () => {
  const receipt: SaveReceipt = {
    id: 'old',
    bookmarkId: 'deleted',
    installationId: 'install',
    title: 'Gone',
    url: 'https://example.test',
    at: 1,
    status: 'failed',
    reason: 'native-write-uncertain',
    fromParentId: '1',
    fromIndex: 0,
    fromPath: 'Bar',
    nameRequestId: 'rename',
    reviewRequestId: 'review',
    correction: {
      requestId: 'move',
      target: { installationId: 'install', nativeId: '2', kind: 'folder' },
      status: 'pending',
    },
  };
  let list = [receipt];
  const storage = {
    get: vi.fn(async () => ({ [SAVE_RECEIPTS_KEY]: structuredClone(list) })),
    set: vi.fn(async (data: Record<string, unknown>) => {
      list = data[SAVE_RECEIPTS_KEY] as SaveReceipt[];
    }),
  };
  const log = new SaveReceiptLog(storage);
  await log.dismiss('old');
  expect(list[0]).toEqual({ ...receipt, dismissedAt: expect.any(Number) });
  const restored = new SaveReceiptLog(storage);
  await restored.upsert({ ...receipt, status: 'kept' });
  expect(pendingSaveReceipts(list)).toEqual([]);
  expect(list[0]).toMatchObject({
    dismissedAt: expect.any(Number),
    correction: receipt.correction,
    nameRequestId: 'rename',
    reviewRequestId: 'review',
  });
  expect(list[0]!.reviewedAt).toBeUndefined();
  const writes = storage.set.mock.calls.length;
  await restored.dismiss('old');
  await restored.dismiss('missing');
  expect(storage.set).toHaveBeenCalledTimes(writes);
  await restored.upsert({ ...receipt, id: 'new' });
  expect(pendingSaveReceipts(list).map(item => item.id)).toEqual(['new']);
});

it('keeps a reminder pending when durable dismissal cannot read or write storage', async () => {
  const receipt: SaveReceipt = {
    id: 'old',
    bookmarkId: 'deleted',
    title: 'Gone',
    url: 'https://example.test',
    at: 1,
    status: 'kept',
    fromParentId: '1',
    fromIndex: 0,
    fromPath: 'Bar',
  };
  const storage = {
    get: vi.fn(async () => ({ [SAVE_RECEIPTS_KEY]: structuredClone([receipt]) })),
    set: vi.fn(async () => {}),
  };
  const log = new SaveReceiptLog(storage);
  storage.get.mockRejectedValueOnce(Error('read-failed'));
  await expect(log.dismiss('old')).rejects.toThrow('read-failed');
  expect(storage.set).not.toHaveBeenCalled();
  storage.set.mockRejectedValueOnce(Error('write-failed'));
  await expect(log.dismiss('old')).rejects.toThrow('write-failed');
  expect(pendingSaveReceipts([(await log.get('old')) as SaveReceipt])).toEqual([receipt]);
});
