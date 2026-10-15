import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { SaveCorrectionOwner, startSaveCorrectionService } from '../background/save-correction';
import { MutationCoordinator } from '../background/mutation-coordinator';
import { TreeProjection } from '../background/tree-projection';
import { OperationsStore } from '../persistence/operations';
import { SaveReceiptLog, type SaveReceipt } from '../persistence/save-receipts';
import { SiteRulesStore } from '../persistence/site-rules';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
import { localClassification } from '../domain/local-classification';

const sender = { id: 'test', url: 'chrome-extension://test/panel/index.html', documentId: 'page' };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function harness() {
  const data: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      Object.assign(data, structuredClone(items));
    }),
    setAccessLevel: async () => {},
  };
  const node = {
    id: 'bookmark',
    parentId: 'source',
    title: 'Example',
    url: 'https://example.test/article',
    syncing: false,
  };
  const source = { id: 'source', parentId: 'bar', title: 'Source', syncing: false, children: [node] };
  const target = { id: 'target', parentId: 'bar', title: 'Target', syncing: false, children: [] as (typeof node)[] };
  const native = [
    {
      id: '0',
      title: '',
      syncing: false,
      children: [{ id: 'bar', parentId: '0', title: 'Bar', syncing: false, children: [source, target] }],
    },
  ];
  let changed = () => {};
  const projection = new TreeProjection(
    {
      read: async () => structuredClone(native),
      listen: listener => {
        changed = () => listener();
        return () => {};
      },
    },
    async () => 'install',
    'epoch',
  );
  projection.start();
  await projection.fresh();
  const move = vi.fn(async (id: string, destination: { parentId: string; index: number }) => {
    expect(id).toBe('bookmark');
    const from = native[0]!.children[0]!.children.find(folder => folder.id === node.parentId)!;
    from.children.splice(from.children.indexOf(node), 1);
    node.parentId = destination.parentId;
    native[0]!.children[0]!.children.find(folder => folder.id === destination.parentId)!.children.splice(
      destination.index,
      0,
      node,
    );
    changed();
    return { ...node };
  });
  const unused = async () => {
    throw Error('unexpected native operation');
  };
  const writer: BookmarkWriter = { move, create: unused, update: unused, remove: unused };
  const journal = new OperationsStore(new IDBFactory(), 'correction');
  const coordinator = new MutationCoordinator(projection, writer, journal, 'test');
  const receipts = new SaveReceiptLog(storage);
  const receipt: SaveReceipt = {
    id: 'receipt',
    bookmarkId: node.id,
    installationId: 'install',
    title: node.title,
    url: node.url,
    at: 1,
    status: 'moved',
    fromParentId: 'target',
    fromIndex: 0,
    fromPath: 'Target',
    toId: 'source',
    toPath: 'Source',
  };
  await receipts.upsert(receipt);
  const rules = new SiteRulesStore(storage, run => run());
  const owner = new SaveCorrectionOwner(projection, coordinator, receipts, rules);
  const begin = async () => {
    const result = await owner.handle({ type: 'nativeSaveCorrection', action: 'begin', receiptId: 'receipt' }, sender);
    if (result.status !== 'ready') throw Error('expected ready');
    return result.token;
  };
  const apply = (token: string) =>
    owner.handle({ type: 'nativeSaveCorrection', action: 'move', token, targetId: 'target' }, sender);
  const rule = (token: string) =>
    owner.handle(
      { type: 'nativeSaveCorrection', action: 'rule', token, includeSubdomains: false, confirmed: true },
      sender,
    );
  return {
    owner,
    begin,
    apply,
    rule,
    node,
    target,
    source,
    native,
    projection,
    receipts,
    rules,
    data,
    storage,
    move,
    coordinator,
    journal,
    receipt,
  };
}

it('one explicit correction uses the real journal/coordinator and only a separate consent creates an effective exact-host rule', async () => {
  const h = await harness();
  const token = await h.begin();
  expect(h.move).not.toHaveBeenCalled();
  const moved = await h.apply(token);
  expect(moved).toMatchObject({
    status: 'moved',
    host: 'example.test',
    target: { nativeId: 'target', kind: 'folder' },
    previousRule: null,
  });
  expect(h.move).toHaveBeenCalledOnce();
  expect(await h.rules.load()).toEqual([]);
  expect((await h.receipts.get('receipt'))?.correction?.status).toBe('completed');
  expect(await h.apply(token)).toEqual(moved);
  expect(h.move).toHaveBeenCalledOnce();
  expect(await h.rule(token)).toEqual({ status: 'rule-saved' });
  const rules = await h.rules.load();
  expect(rules).toEqual([
    {
      host: 'example.test',
      includeSubdomains: false,
      folder: { installationId: 'install', nativeId: 'target', kind: 'folder' },
    },
  ]);
  const tree = await h.projection.fresh();
  expect(
    localClassification(tree, 'bookmark', { fullUrl: false, bodyEnabled: false, excludedFolders: [] }, rules).choice,
  ).toMatchObject({ source: 'rule' });
  expect((await h.journal.all())[0]?.request.command).toMatchObject({
    type: 'move',
    target: { nativeId: 'bookmark' },
    parent: { nativeId: 'target' },
  });
  h.projection.stop();
});

it('serializes competing page corrections and never creates rules for an ordinary move or close', async () => {
  const h = await harness();
  const a = await h.begin();
  const b = await h.begin();
  const results = await Promise.allSettled([h.apply(a), h.apply(b)]);
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
  expect(h.move).toHaveBeenCalledOnce();
  await h.owner.handle({ type: 'nativeSaveCorrection', action: 'close', token: a }, sender);
  expect(await h.rules.load()).toEqual([]);
  await expect(h.rule(a)).rejects.toThrow('session-expired');
  h.projection.stop();
});

it.each(['url', 'move', 'folder', 'rename', 'receipt', 'rule'] as const)(
  'rejects %s changes between the correction and rule confirmation',
  async change => {
    const h = await harness();
    const token = await h.begin();
    await h.apply(token);
    if (change === 'url') h.node.url = 'https://other.test/';
    if (change === 'move') h.node.parentId = 'source';
    if (change === 'folder') h.target.id = 'replacement';
    if (change === 'rename') h.target.title = 'Different destination';
    if (change === 'receipt') await h.receipts.upsert({ ...h.receipt, id: 'new-receipt', at: 2 });
    if (change === 'rule')
      await h.rules.set({
        host: 'example.test',
        folder: { installationId: 'install', nativeId: 'source', kind: 'folder' },
        includeSubdomains: true,
      });
    await expect(h.rule(token)).rejects.toThrow(change === 'rule' ? 'rule-changed' : 'stale-correction');
    expect(h.move).toHaveBeenCalledOnce();
    expect((await h.rules.load()).some(rule => rule.folder.nativeId === 'target')).toBe(false);
    h.projection.stop();
  },
);

it('rule storage failure retries only rule storage, never the move', async () => {
  const h = await harness();
  const token = await h.begin();
  await h.apply(token);
  h.storage.set.mockRejectedValueOnce(Error('quota'));
  await expect(h.rule(token)).rejects.toThrow('quota');
  expect(await h.rules.load()).toEqual([]);
  expect(await h.rule(token)).toEqual({ status: 'rule-saved' });
  expect(h.move).toHaveBeenCalledOnce();
  h.projection.stop();
});

it('refuses stale source and foreign document; a failed retirement checkpoint issues no move', async () => {
  const h = await harness();
  const token = await h.begin();
  await expect(
    h.owner.handle(
      { type: 'nativeSaveCorrection', action: 'move', token, targetId: 'target' },
      { ...sender, documentId: 'other' },
    ),
  ).rejects.toThrow('session-expired');
  h.node.url = 'https://changed.test/';
  await expect(h.apply(token)).rejects.toThrow();
  expect(h.move).not.toHaveBeenCalled();
  h.node.url = h.receipt.url;
  h.storage.set.mockRejectedValueOnce(Error('quota'));
  await expect(h.apply(token)).rejects.toThrow('quota');
  expect(h.move).not.toHaveBeenCalled();
  h.projection.stop();
});

it('restart reconciles a pending correction without replay and cannot restore old rule consent', async () => {
  const h = await harness();
  const token = await h.begin();
  await h.apply(token);
  const receipt = (await h.receipts.get('receipt'))!;
  await h.receipts.patch('receipt', { correction: { ...receipt.correction!, status: 'pending' } });
  const restarted = new SaveCorrectionOwner(h.projection, h.coordinator, h.receipts, h.rules);
  await expect(
    restarted.handle(
      { type: 'nativeSaveCorrection', action: 'rule', token, includeSubdomains: true, confirmed: true },
      sender,
    ),
  ).rejects.toThrow('session-expired');
  expect(
    await restarted.handle({ type: 'nativeSaveCorrection', action: 'begin', receiptId: 'receipt' }, sender),
  ).toMatchObject({ status: 'ready' });
  expect(h.move).toHaveBeenCalledOnce();
  expect(await h.rules.load()).toEqual([]);
  h.projection.stop();
});

it('unknown outcomes never expose rule consent or reissue a move', async () => {
  const h = await harness();
  const token = await h.begin();
  vi.spyOn(h.coordinator, 'submit').mockImplementationOnce(async raw => ({
    requestId: (raw as { requestId: string }).requestId,
    status: 'unknown',
    needsReconcile: true,
    completedSteps: 0,
    remainingSteps: 1,
  }));
  expect(await h.apply(token)).toMatchObject({ status: 'result', result: { status: 'unknown' } });
  await expect(h.rule(token)).rejects.toThrow('stale-correction');
  expect(await h.apply(token)).toMatchObject({ status: 'result', result: { status: 'unknown' } });
  expect(h.move).not.toHaveBeenCalled();
  expect(await h.rules.load()).toEqual([]);
  h.projection.stop();
});

it('requires installation-bound terminal receipts and rejects untrusted or malformed RPC', async () => {
  const h = await harness();
  await h.receipts.patch('receipt', { installationId: undefined });
  await expect(h.begin()).rejects.toThrow('legacy-receipt');
  await h.receipts.patch('receipt', { installationId: 'foreign' });
  await expect(h.begin()).rejects.toThrow('stale-correction');
  let handler!: (raw: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean;
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      onMessage: {
        addListener: (value: typeof handler) => {
          handler = value;
        },
      },
    },
  });
  startSaveCorrectionService(h.owner);
  const reply = vi.fn();
  handler({ type: 'nativeSaveCorrection', action: 'begin', receiptId: 'receipt' }, { ...sender, id: 'foreign' }, reply);
  expect(reply).toHaveBeenLastCalledWith({ status: 'error', reason: 'invalid-sender' });
  handler(
    { type: 'nativeSaveCorrection', action: 'rule', token: 'x', confirmed: false, includeSubdomains: true },
    sender,
    reply,
  );
  expect(reply).toHaveBeenLastCalledWith({ status: 'error', reason: 'invalid-message' });
  h.projection.stop();
});
