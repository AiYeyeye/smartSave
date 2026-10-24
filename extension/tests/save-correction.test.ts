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
import { correctionExamples } from '../domain/correction-learning';

const sender = { id: 'test', url: 'chrome-extension://test/panel/index.html', documentId: 'page' };

it('reviews the name and folder in one journaled request and does not repeat confirmation', async () => {
  const h = await harness();
  await h.receipts.patch('receipt', { suggestedTitle: 'Readable article' });
  const token = await h.begin();
  const input = {
    type: 'nativeSaveCorrection' as const,
    action: 'review' as const,
    token,
    title: 'Readable article',
    targetId: 'target',
  };
  const result = await h.owner.handle(input, sender);
  expect(result).toMatchObject({ status: 'result', result: { status: 'completed', completedSteps: 2 } });
  expect(h.node).toMatchObject({ title: 'Readable article', parentId: 'target' });
  expect(await h.receipts.get('receipt')).toMatchObject({
    reviewedAt: expect.any(Number),
    nameReview: 'applied',
    correction: { status: 'completed' },
  });
  const records = await h.journal.all();
  expect(records).toHaveLength(1);
  expect(records[0]!.request.command.type).toBe('batch');
  expect(correctionExamples(records[0]!)[0]!.scopes).not.toContain('rename');
  await h.owner.handle(input, sender);
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(h.move).toHaveBeenCalledTimes(1);
  await expect(h.owner.handle({ ...input, title: 'Different' }, sender)).rejects.toThrow('stale-correction');
});

it('the toolbar popup, sent without tab or document id, can review; other id-less senders cannot', async () => {
  const h = await harness();
  const popup = { id: 'test', url: 'chrome-extension://test/save/index.html', origin: 'chrome-extension://test' };
  const begin = { type: 'nativeSaveCorrection' as const, action: 'begin' as const, receiptId: 'receipt' };
  for (const other of [
    { id: 'test', url: 'chrome-extension://test/panel/index.html' },
    { ...popup, tab: { id: 3 } as chrome.tabs.Tab },
  ])
    await expect(h.owner.handle(begin, other)).rejects.toThrow('session-expired');
  const ready = await h.owner.handle(begin, popup);
  expect(ready).toMatchObject({ status: 'ready' });
  const review = {
    type: 'nativeSaveCorrection' as const,
    action: 'review' as const,
    token: (ready as { token: string }).token,
    title: h.node.title,
    targetId: 'target',
  };
  await expect(h.owner.handle(review, sender)).rejects.toThrow('session-expired');
  expect(await h.owner.handle(review, popup)).toMatchObject({ status: 'result', result: { status: 'completed' } });
  expect(h.node.parentId).toBe('target');
});

it('unchanged review resolves the receipt without a native write or learning', async () => {
  const h = await harness();
  const token = await h.begin();
  expect(
    await h.owner.handle(
      { type: 'nativeSaveCorrection', action: 'review', token, title: h.node.title, targetId: h.node.parentId },
      sender,
    ),
  ).toEqual({ status: 'closed' });
  expect(h.update).not.toHaveBeenCalled();
  expect(h.move).not.toHaveBeenCalled();
  expect(await h.journal.all()).toEqual([]);
  expect((await h.receipts.get('receipt'))?.reviewedAt).toEqual(expect.any(Number));
});

it('partial combined review retains unsettled evidence and refuses reopening without replay', async () => {
  const h = await harness();
  h.move.mockRejectedValue(Error('native move failed'));
  const token = await h.begin();
  const input = {
    type: 'nativeSaveCorrection' as const,
    action: 'review' as const,
    token,
    title: 'Edited',
    targetId: 'target',
  };
  const result = await h.owner.handle(input, sender);
  expect(result).toMatchObject({ status: 'result', result: { status: 'unknown', completedSteps: 1 } });
  expect(h.node).toMatchObject({ title: 'Edited', parentId: 'source' });
  expect((await h.receipts.get('receipt'))?.reviewedAt).toBeUndefined();
  await expect(h.begin()).rejects.toThrow('correction-unsettled');
  await h.owner.handle(input, sender);
  expect(h.update).toHaveBeenCalledTimes(1);
  expect(h.move).toHaveBeenCalledTimes(1);
});

it('review detects a renamed source even for a confirmation with no intended changes', async () => {
  const h = await harness();
  const token = await h.begin();
  await h.update('bookmark', { title: 'Changed elsewhere' });
  await expect(
    h.owner.handle(
      { type: 'nativeSaveCorrection', action: 'review', token, title: 'Example', targetId: 'source' },
      sender,
    ),
  ).rejects.toThrow('stale-correction');
  expect((await h.receipts.get('receipt'))?.reviewedAt).toBeUndefined();
});
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
  const update = vi.fn(async (id: string, changes: { title?: string; url?: string }) => {
    expect(id).toBe(node.id);
    Object.assign(node, changes);
    changed();
    return { ...node };
  });
  const writer: BookmarkWriter = { move, create: unused, update, remove: unused };
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
    update,
    coordinator,
    journal,
    receipt,
  };
}

it('accepting an AI name uses the journal without learning, while a user edit records its suggested baseline', async () => {
  const h = await harness();
  await h.receipts.patch('receipt', { suggestedTitle: 'Readable article' });
  const token = await h.begin();
  const accepted = await h.owner.handle(
    { type: 'nativeSaveCorrection', action: 'rename', token, title: 'Readable article' },
    sender,
  );
  expect(accepted.status).toBe('result');
  expect(h.node.title).toBe('Readable article');
  expect(h.update).toHaveBeenCalledTimes(1);
  expect((await h.journal.all())[0]?.request.learning).toBeUndefined();
  const next = await h.begin();
  await h.owner.handle(
    { type: 'nativeSaveCorrection', action: 'rename', token: next, title: 'My article wording' },
    sender,
  );
  expect((await h.journal.all()).find(record => record.request.learning)?.request.learning).toEqual([
    { id: 'bookmark', title: 'Readable article', parentId: 'source' },
  ]);
  const record = (await h.journal.all()).find(record => record.request.learning)!;
  const example = correctionExamples(record)[0]!;
  expect(example.text).toContain('建议名称「Readable article」');
  expect(example.text).toContain('用户采用「My article wording」');
  expect(example.evidence).toEqual([
    { id: 'bookmark', title: 'My article wording', url: h.node.url, parentId: 'source' },
  ]);
  h.projection.stop();
});

it('a stale name confirmation cannot overwrite a later edit, and keeping the original issues no write', async () => {
  const h = await harness();
  await h.receipts.patch('receipt', { suggestedTitle: 'Readable article' });
  const token = await h.begin();
  h.node.title = 'New manual name';
  await expect(
    h.owner.handle({ type: 'nativeSaveCorrection', action: 'rename', token, title: 'Readable article' }, sender),
  ).rejects.toThrow();
  expect(h.update).not.toHaveBeenCalled();
  const keep = await h.begin();
  expect(await h.owner.handle({ type: 'nativeSaveCorrection', action: 'keep-name', token: keep }, sender)).toEqual({
    status: 'closed',
  });
  expect(h.update).not.toHaveBeenCalled();
  h.projection.stop();
});

it('compares learning with the name actually presented, not a later background suggestion', async () => {
  const h = await harness();
  const token = await h.begin();
  await h.receipts.patch('receipt', { suggestedTitle: 'New advice' });
  await h.owner.handle({ type: 'nativeSaveCorrection', action: 'rename', token, title: 'New advice' }, sender);
  expect((await h.journal.all())[0]?.request.learning).toEqual([
    { id: 'bookmark', title: 'Example', parentId: 'source' },
  ]);
  h.projection.stop();
});

it('an uncertain rename is never replayed and blocks later edits until reconciled', async () => {
  const h = await harness();
  await h.receipts.patch('receipt', { nameReview: 'applied' });
  const token = await h.begin();
  vi.spyOn(h.coordinator, 'submit').mockImplementationOnce(async raw => ({
    requestId: (raw as { requestId: string }).requestId,
    status: 'unknown',
    needsReconcile: true,
    completedSteps: 0,
    remainingSteps: 1,
  }));
  const rename = () =>
    h.owner.handle({ type: 'nativeSaveCorrection', action: 'rename', token, title: 'Another name' }, sender);
  expect(await rename()).toMatchObject({ status: 'result', result: { status: 'unknown' } });
  expect(await rename()).toMatchObject({ status: 'result', result: { status: 'unknown' } });
  expect(h.coordinator.submit).toHaveBeenCalledTimes(1);
  expect((await h.receipts.get('receipt'))?.nameReview).toBeUndefined();
  expect(h.update).not.toHaveBeenCalled();
  h.projection.stop();
});

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
