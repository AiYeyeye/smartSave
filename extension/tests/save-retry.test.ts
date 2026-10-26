import { afterEach, expect, it, vi } from 'vitest';
import { SaveRetryOwner, startSaveRetryService } from '../background/save-retry';
import { ModelTransport } from '../adapters/model-transport';
import { AiServicesStore } from '../persistence/ai-services';
import { SettingsStore } from '../persistence/settings';
import { SaveReceiptLog, type SaveReceipt } from '../persistence/save-receipts';
import type { TreeProjection } from '../background/tree-projection';
import { organizerTree } from './fixtures/organizer-tree';
import { canRetrySave } from '../domain/save-retry';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture() {
  const tree = organizerTree();
  const data: Record<string, unknown> = {
    aiServices: {
      version: 1,
      revision: 'test',
      services: [
        {
          id: 'local',
          name: 'Synthetic model',
          serviceType: 'custom',
          kind: 'api',
          detail: '',
          baseUrl: 'http://127.0.0.1:12345/v1',
          mode: 'openai',
          status: 'ok',
          letter: 'T',
          avatarClass: 'custom',
          catalog: [{ id: 'synthetic', ctx: 'test' }],
          enabled: ['synthetic'],
        },
      ],
      features: [{ id: 'save', name: 'save', desc: '', connId: 'local', modelId: 'synthetic' }],
    },
  };
  const storage = {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(data, structuredClone(value));
    }),
    remove: async (key: string) => {
      delete data[key];
    },
    setAccessLevel: async () => {},
  };
  const receipts = new SaveReceiptLog(storage);
  const receipt: SaveReceipt = {
    id: 'receipt',
    installationId: 'install',
    bookmarkId: 'a',
    title: 'a',
    url: 'https://x.test/?a#b',
    at: 1,
    status: 'failed',
    reason: 'refused',
    fromParentId: 'left',
    fromIndex: 0,
    fromPath: 'left',
  };
  await receipts.upsert(receipt);
  const projection = {
    fresh: async () => structuredClone(tree),
    subscribe: () => () => {},
  } as unknown as TreeProjection;
  const owner = new SaveRetryOwner({
    projection,
    receipts,
    settings: new SettingsStore(storage, run => run()),
    aiServices: new AiServicesStore(storage, run => run()),
    contains: async () => true,
  });
  const result = {
    status: 'completed' as const,
    output: {
      assignments: [{ itemId: 'a', folderId: 'right', suggestedTitle: 'Readable title' }],
      newFolders: [],
    },
  };
  const request = { type: 'nativeSaveRetry' as const, receiptId: 'receipt', requestId: 'attempt' };
  const settled = async () => {
    await vi.waitFor(async () => expect((await receipts.get('receipt'))?.aiRetry?.status).not.toBe('pending'));
    return receipts.get('receipt');
  };
  return { owner, tree, storage, receipts, receipt, request, result, settled };
}

it('starts once, stores read-only suggestions and leaves native bookmarks unchanged', async () => {
  const h = await fixture(),
    before = structuredClone(h.tree);
  let finish!: (value: typeof h.result) => void;
  const run = vi.spyOn(ModelTransport.prototype, 'run').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await h.owner.start(h.request);
  await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  await h.owner.start({ ...h.request, requestId: 'double-click' });
  expect(run).toHaveBeenCalledOnce();
  expect(run.mock.calls[0]![0]).toMatchObject({
    request: { task: 'save', item: { id: 'a', source: 'bookmark' } },
    policy: { existingFoldersOnly: true },
  });
  finish(h.result);
  expect(await h.settled()).toMatchObject({
    status: 'failed',
    reason: 'refused',
    suggestedFolderId: 'right',
    suggestedTitle: 'Readable title',
    aiRetry: { id: 'attempt', status: 'ready' },
  });
  expect(h.tree).toEqual(before);
  await h.owner.start(h.request);
  expect(run).toHaveBeenCalledOnce();
  h.owner.dispose();
});

it('retains a second provider refusal and permits a later explicit retry', async () => {
  const h = await fixture();
  const run = vi
    .spyOn(ModelTransport.prototype, 'run')
    .mockResolvedValueOnce({ status: 'failed', reason: 'refused' })
    .mockResolvedValueOnce(h.result);
  await h.owner.start(h.request);
  expect(await h.settled()).toMatchObject({ aiRetry: { status: 'failed', reason: 'refused' } });
  await h.owner.start({ ...h.request, requestId: 'new-attempt' });
  expect(await h.settled()).toMatchObject({ aiRetry: { status: 'ready' } });
  expect(run).toHaveBeenCalledTimes(2);
  h.owner.dispose();
});

it('rejects uncertain writes, superseded receipts and failed checkpoints before any model request', async () => {
  const h = await fixture(),
    run = vi.spyOn(ModelTransport.prototype, 'run');
  for (const reason of ['native-write-uncertain', 'worker-interrupted', 'excluded']) {
    await h.receipts.patch('receipt', { reason });
    await expect(h.owner.start(h.request)).rejects.toThrow('retry-unavailable');
  }
  await h.receipts.patch('receipt', { reason: 'refused' });
  h.storage.set.mockRejectedValueOnce(Error('storage'));
  await expect(h.owner.start(h.request)).rejects.toThrow('storage');
  vi.spyOn(h.receipts, 'patch').mockResolvedValueOnce(undefined);
  await expect(h.owner.start(h.request)).rejects.toThrow('retry-unavailable');
  await h.receipts.upsert({ ...h.receipt, id: 'newer' });
  await expect(h.owner.start(h.request)).rejects.toThrow('retry-unavailable');
  expect(run).not.toHaveBeenCalled();
});

it('discards late advice after the source changes and never creates proposed folders', async () => {
  const h = await fixture();
  vi.spyOn(ModelTransport.prototype, 'run').mockImplementation(async () => {
    h.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'Edited elsewhere';
    return h.result;
  });
  await h.owner.start(h.request);
  expect(await h.settled()).toMatchObject({ aiRetry: { status: 'failed', reason: 'stale-context' } });
  expect((await h.receipts.get('receipt'))?.suggestedFolderId).toBeUndefined();
  h.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'a';
  vi.spyOn(ModelTransport.prototype, 'run').mockResolvedValue({
    ...h.result,
    output: { ...h.result.output, newFolders: [{ id: 'new', parentId: 'left', title: 'New folder' }] },
  });
  await h.owner.start({ ...h.request, requestId: 'new-folders' });
  expect(await h.settled()).toMatchObject({ aiRetry: { status: 'failed', reason: 'schema' } });
  h.owner.dispose();
});

it('marks abandoned read-only attempts failed at startup without replaying them', async () => {
  const h = await fixture();
  await h.receipts.patch('receipt', { aiRetry: { id: 'old', status: 'pending' } });
  await h.receipts.interruptPending();
  const recovered = (await h.receipts.get('receipt'))!;
  expect(recovered.aiRetry).toEqual({ id: 'old', status: 'failed', reason: 'recognition-interrupted' });
  expect(canRetrySave(recovered)).toBe(true);
});

it('accepts only a strict request from the trusted save document', async () => {
  const h = await fixture();
  let handler!: (raw: unknown, sender: chrome.runtime.MessageSender, reply: (raw: unknown) => void) => boolean;
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      onMessage: {
        addListener: (fn: typeof handler) => {
          handler = fn;
        },
      },
    },
  });
  startSaveRetryService(h.owner);
  const start = vi.spyOn(h.owner, 'start').mockResolvedValue(),
    reply = vi.fn();
  const sender = { id: 'test', url: 'chrome-extension://test/save/index.html' };
  handler(h.request, { ...sender, id: 'foreign' }, reply);
  handler({ ...h.request, url: 'https://untrusted.test' }, sender, reply);
  handler(h.request, { ...sender, url: 'chrome-extension://test/panel/index.html' }, reply);
  expect(start).not.toHaveBeenCalled();
  expect(handler(h.request, sender, reply)).toBe(true);
  await vi.waitFor(() => expect(reply).toHaveBeenLastCalledWith({ status: 'started' }));
  expect(start).toHaveBeenCalledOnce();
});
