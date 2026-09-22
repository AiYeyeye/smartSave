import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { ImportAuthority } from '../background/import-authority';
import { MutationCoordinator } from '../background/mutation-coordinator';
import { TreeProjection } from '../background/tree-projection';
import type { ImportCheckpoint } from '../persistence/import-checkpoints';
import { ImportPersistenceStore } from '../persistence/import-persistence';
import { importContextDigest } from '../domain/import-evidence';
import type { SettingsStore } from '../persistence/settings';
import type { BookmarkWriter } from '../adapters/bookmarks-write';

async function setup(fault = 0, change = 'privacy', name = 'zhilan-operations') {
  const tree: chrome.bookmarks.BookmarkTreeNode[] = [
    {
      id: '0',
      title: '',
      syncing: false,
      children: [
        {
          id: 'bar',
          parentId: '0',
          title: 'Bar',
          syncing: false,
          children: [{ id: 'existing', parentId: 'bar', title: 'Existing', syncing: false, children: [] }],
        },
      ],
    },
  ];
  const events = new Set<() => void>();
  const listeners = new Set<() => void>();
  const projection = new TreeProjection(
    {
      read: async () => structuredClone(tree),
      listen: cb => {
        const event = () => cb();
        events.add(event);
        return () => events.delete(event);
      },
    },
    async () => 'install',
    'epoch',
  );
  projection.start();
  const snapshot = await projection.fresh();
  let settings: Awaited<ReturnType<SettingsStore['snapshot']>> = {
    key: '',
    version: 1,
    revision: 'one',
    sessionRevision: 0,
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
  };
  const settingsStore = {
    snapshot: async () => structuredClone(settings),
    subscribe: (cb: () => void) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const factory = new IDBFactory();
  const operations = new ImportPersistenceStore(factory, name);
  const checkpoints = operations.importCheckpoints;
  const root = snapshot.nodes.find(n => n.ref.nativeId === 'bar')!.ref;
  const items = [0, 1].map(sourceOrdinal => ({
    titleLocked: true,
    item: {
      sourceOrdinal,
      sourceSpan: { start: 0, end: 1 },
      rawURL: `https://example.test/${sourceOrdinal}?a=1#中`,
      title: 'Source',
      oldPath: [],
      provenance: { format: 'txt' as const, urlSpan: { start: 0, end: 1 } },
    },
  }));
  const context = { ...settings, tree: snapshot };
  const checkpoint: ImportCheckpoint = {
    schemaVersion: 1,
    id: 'import',
    revision: 0,
    installationId: 'install',
    root,
    items,
    diagnostics: [],
    classified: [
      { sourceOrdinal: 0, folderId: 'inner', title: 'Source' },
      { sourceOrdinal: 1, folderId: 'unused', title: 'Source' },
    ],
    newFolders: [
      { id: 'outer', parentId: 'existing', title: 'Outer' },
      { id: 'inner', parentId: 'outer', title: 'Inner' },
      { id: 'unused', parentId: 'bar', title: 'Unused' },
    ],
    phase: 'classified',
    runtime: {
      version: 3,
      stage: 'classification',
      format: 'txt',
      sourceItems: items.map(i => i.item),
      candidates: [],
      mappedGroups: [],
      mappedItems: [],
      contextDigest: await importContextDigest(context, root),
    },
  };
  await checkpoints.put(checkpoint, null);
  const authority = new ImportAuthority(settingsStore, projection, checkpoints, 'test');
  const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
  const token = authority.open(sender);
  let calls = 0;
  const find = (id: string): chrome.bookmarks.BookmarkTreeNode | undefined => {
    const stack = [...tree];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === id) return n;
      stack.push(...(n.children ?? []));
    }
  };
  const writer: BookmarkWriter = {
    create: async details => {
      calls++;
      if (change === 'unknown' && calls === 2) throw Error('ambiguous');
      const parent = find(details.parentId!)!;
      const node = {
        ...details,
        id: `new${calls}`,
        syncing: false,
        ...(details.url === undefined ? { children: [] } : {}),
      };
      parent.children!.push(node);
      events.forEach(cb => cb());
      return structuredClone(node);
    },
    update: async () => {
      throw Error('forbidden');
    },
    move: async () => {
      throw Error('forbidden');
    },
    remove: async () => {
      throw Error('forbidden');
    },
  };
  const invalidate = () => {
    if (change === 'privacy') {
      settings = { ...settings, revision: 'two', privacy: { ...settings.privacy, excludedFolders: [root] } };
      listeners.forEach(cb => cb());
    } else if (change === 'disconnect') authority.close(token);
    else if (change === 'url') {
      tree[0]!.children!.push({
        id: 'global',
        title: 'Dup',
        parentId: '0',
        url: items[0]!.item.rawURL,
        syncing: false,
      });
      events.forEach(cb => cb());
    } else if (change === 'deleted') {
      tree[0]!.children![0]!.children = [];
      events.forEach(cb => cb());
    } else if (change === 'managed') {
      find('existing')!.unmodifiable = 'managed';
      events.forEach(cb => cb());
    } else if (change === 'moved') {
      const target = find('existing')!;
      tree[0]!.children![0]!.children = [];
      target.parentId = '0';
      tree[0]!.children!.push(target);
      events.forEach(cb => cb());
    } else if (change === 'root') {
      tree[0]!.children![0]!.id = 'replaced';
      events.forEach(cb => cb());
    }
  };
  let puts = 0;
  const journal = {
    importCheckpoints: checkpoints,
    handoffImport: (...args: Parameters<typeof operations.handoffImport>) => operations.handoffImport(...args),
    all: () => operations.all(),
    put: async (record: Parameters<typeof operations.put>[0]) => {
      if (change === 'quota') throw new DOMException('quota', 'QuotaExceededError');
      await operations.put(record);
      if (++puts === fault) invalidate();
    },
  };
  const handoff = operations.handoffImport.bind(operations);
  vi.spyOn(operations, 'handoffImport').mockImplementation(async (...args) => {
    if (change === 'quota') throw new DOMException('quota', 'QuotaExceededError');
    await handoff(...args);
    if (++puts === fault) invalidate();
  });
  const coordinator = new MutationCoordinator(projection, writer, journal, 'test', undefined, undefined, authority);
  const selection = { root, selectedSourceOrdinals: [0], titleEdits: [{ sourceOrdinal: 0, title: 'User title' }] };
  const request = (await coordinator.registerImportPreview(
    token,
    checkpoint.id,
    checkpoint.revision,
    selection,
    sender,
  ))!;
  return {
    factory,
    checkpoints,
    operations,
    journal,
    authority,
    coordinator,
    sender,
    token,
    request,
    checkpoint,
    selection,
    projection,
    writer,
    tree,
    calls: () => calls,
    invalidate,
    notify: () => events.forEach(cb => cb()),
  };
}
it('scope-independent prepare/validate: changes outside the classification scope keep the lease current, the coordinator still fails closed on its whole-tree baseline', async () => {
  const h = await setup();
  expect(h.authority.current(h.request)).toBe(true);
  h.tree[0]!.children!.push({ id: 'aside', parentId: '0', title: 'Aside', url: 'https://aside.test/', syncing: false });
  h.notify();
  // Synchronous semantics: the projection published loading, so the lease is not current until the next ready state.
  expect(h.authority.current(h.request)).toBe(false);
  await h.projection.fresh();
  expect(h.projection.state.status).toBe('ready');
  expect(h.authority.current(h.request)).toBe(true);
  expect(await h.authority.validate(h.request, h.sender)).toBe(true);
  expect(h.authority.current(h.request)).toBe(true);
  expect((await h.coordinator.submit(h.request, h.sender)).reason).toBe('preflight-conflict');
  expect(h.calls()).toBe(0);
});
it.each(['root-title', 'scope-folder-title', 'scope-folder-removed'] as const)(
  'a %s change inside the scope rejects validate and the synchronous current check',
  async change => {
    const h = await setup();
    const bar = h.tree[0]!.children![0]!;
    if (change === 'root-title') bar.title = 'Renamed root';
    if (change === 'scope-folder-title') bar.children![0]!.title = 'Renamed scope folder';
    if (change === 'scope-folder-removed') bar.children = [];
    h.notify();
    await h.projection.fresh();
    expect(h.projection.state.status).toBe('ready');
    expect(h.authority.current(h.request)).toBe(false);
    expect(await h.authority.validate(h.request, h.sender)).toBe(false);
    expect(['rejected', 'failed']).toContain((await h.coordinator.submit(h.request, h.sender)).status);
    expect(h.calls()).toBe(0);
  },
);
it('a fresh preview after an unrelated change registers and applies with the current baseline', async () => {
  const h = await setup();
  h.tree[0]!.children!.push({ id: 'aside', parentId: '0', title: 'Aside', url: 'https://aside.test/', syncing: false });
  h.notify();
  await h.projection.fresh();
  const request = (await h.coordinator.registerImportPreview(
    h.authority.open(h.sender),
    'import',
    0,
    h.selection,
    h.sender,
  ))!;
  expect(request.importBinding?.contextDigest).toBe(h.request.importBinding?.contextDigest);
  expect((await h.coordinator.submit(request, h.sender)).status).toBe('completed');
  expect(h.calls()).toBe(3);
});
it('real coordinator imports nested selected rows only and retains exact frozen source/plan without ephemeral IDB data', async () => {
  const h = await setup();
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('completed');
  expect(h.calls()).toBe(3);
  expect(JSON.stringify(h.tree)).not.toContain('Unused');
  expect(JSON.stringify(h.tree)).toContain('User title');
  const checkpoint = (await h.checkpoints.get('import'))!;
  expect(checkpoint.items[0]!.item.title).toBe('Source');
  expect(checkpoint.writePlan?.command).toEqual(h.request.command);
  await h.checkpoints.put({ ...checkpoint, revision: 2, phase: 'finished' }, 1);
  const raw = await new Promise<unknown>(resolve => {
    const open = h.factory.open('zhilan-operations');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['operations', 'importCheckpoints']);
      const a = tx.objectStore('operations').getAll();
      const b = tx.objectStore('importCheckpoints').getAll();
      tx.oncomplete = () => {
        resolve([a.result, b.result]);
        db.close();
      };
    };
  });
  for (const forbidden of [h.token, 'importContext', 'previewId', 'apiKey'])
    expect(JSON.stringify(raw)).not.toContain(forbidden);
  const [[journal]] = raw as [Record<string, unknown>[], unknown[]];
  expect(journal).toMatchObject({ schemaVersion: 2, final: { nodes: expect.any(Array) } });
  expect(JSON.stringify(journal!.steps)).not.toMatch(/"before"|"expectedAfter"|"after"/);
  const restarted = new MutationCoordinator(h.projection, h.writer, h.operations, 'test');
  expect((await restarted.submit(h.request, h.sender)).status).toBe('completed');
  expect(h.calls()).toBe(3);
  expect(
    (
      await restarted.submit(
        { ...h.request, importBinding: { ...h.request.importBinding!, checkpointId: 'swapped' } },
        h.sender,
      )
    ).reason,
  ).toBe('request-id-conflict');
});
it.each(['privacy', 'url', 'root', 'deleted', 'moved', 'managed', 'disconnect'])(
  'queue and backup/intent invalidation %s makes zero native calls',
  async change => {
    for (const point of [0, 1, 2]) {
      const h = await setup(point, change);
      if (!point) h.invalidate();
      const result = await h.coordinator.submit(h.request, h.sender);
      expect(['rejected', 'failed']).toContain(result.status);
      expect(h.calls()).toBe(0);
    }
  },
);
it('quota failure and checkpoint CAS failure issue zero native calls', async () => {
  const h = await setup(0, 'quota');
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('rejected');
  expect(h.calls()).toBe(0);
  const other = await setup();
  await other.checkpoints.put({ ...other.checkpoint, revision: 1 }, 0);
  expect((await other.coordinator.submit(other.request, other.sender)).status).toBe('rejected');
  expect(other.calls()).toBe(0);
});
it('unknown partial create outcomes survive restart with zero replay and no branch or URL adoption', async () => {
  const h = await setup(0, 'unknown');
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('unknown');
  expect(h.calls()).toBe(2);
  const restart = new MutationCoordinator(h.projection, h.writer, h.operations, 'test');
  expect((await restart.submit(h.request, h.sender)).status).toBe('unknown');
  expect(h.calls()).toBe(2);
  const checkpoint = (await h.checkpoints.get('import'))!;
  await expect(
    h.checkpoints.put(
      { ...checkpoint, phase: 'classified', requestId: undefined, writePlan: undefined, revision: 2 },
      1,
    ),
  ).rejects.toThrow();
  await expect(h.authority.prepare(h.authority.open(h.sender), 'import', 1, h.selection, h.sender)).rejects.toThrow();
});
it('last authority await invalidation and plan/sender tampering fail closed', async () => {
  const h = await setup();
  const validate = h.authority.validate.bind(h.authority);
  let count = 0;
  vi.spyOn(h.authority, 'validate').mockImplementation(async (...args) => {
    const valid = await validate(...args);
    if (++count === 3) h.invalidate();
    return valid;
  });
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('failed');
  expect(h.calls()).toBe(0);
  const other = await setup();
  expect(
    (
      await other.coordinator.submit(
        { ...other.request, importBinding: { ...other.request.importBinding!, selectedSourceOrdinals: [1] } },
        other.sender,
      )
    ).status,
  ).toBe('rejected');
  expect(
    (
      await other.coordinator.submit(other.request, {
        ...other.sender,
        url: 'chrome-extension://test/panel/index.html',
      })
    ).status,
  ).toBe('rejected');
  expect(other.calls()).toBe(0);
});
it('atomic handoff quota abort retains classification and no orphan applying checkpoint', async () => {
  const h = await setup();
  const { IDBObjectStore } = await import('fake-indexeddb');
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    ...args: Parameters<IDBObjectStore['put']>
  ) {
    if (this.name === 'importCheckpoints') throw new DOMException('quota', 'QuotaExceededError');
    return put.apply(this, args);
  });
  try {
    expect((await h.coordinator.submit(h.request, h.sender)).reason).toBe('import-checkpoint-freeze-failed');
  } finally {
    spy.mockRestore();
  }
  expect(h.calls()).toBe(0);
  expect(await h.operations.all()).toEqual([]);
  expect((await h.checkpoints.get('import'))!.phase).toBe('classified');
});
it('restart immediately after atomic handoff has actionable 05 row and cannot replay', async () => {
  const h = await setup();
  const { operationRecord } = await import('../persistence/operations');
  const { preflight } = await import('../domain/preflight');
  const tree = await h.projection.fresh();
  const plan = preflight(h.request, tree);
  const handoff = await h.authority.authorizeHandoff(h.request, h.sender);
  expect(Object.isFrozen(handoff.checkpoint.writePlan!.command)).toBe(true);
  expect(await h.operations.all()).toEqual([]);
  await h.operations.handoffImport(
    handoff.checkpoint,
    operationRecord(h.request, plan.steps, plan.affected),
    handoff.expectedRevision,
  );
  const restart = new MutationCoordinator(h.projection, h.writer, h.operations, 'test');
  expect((await restart.submit(h.request, h.sender)).status).toBe('unknown');
  expect(h.calls()).toBe(0);
  const listing = await restart.recovery({ version: 1, type: 'recoveryList', requestId: 'list' }, h.sender);
  expect(listing.status).toBe('ready');
  if (listing.status !== 'ready') throw Error('not ready');
  expect(listing.records[0]!.requestId).toBe(h.request.requestId);
  expect(listing.records[0]!.steps.every(s => s.state === 'planned')).toBe(true);
  expect(listing.records[0]!.schemaVersion).toBe(2);
  expect(listing.records[0]!.backup?.nodes).toEqual(tree.nodes);
});
it('finished checkpoint requires exact journal plan and binding, not just successful root', async () => {
  const h = await setup();
  await h.coordinator.submit(h.request, h.sender);
  const checkpoint = (await h.checkpoints.get('import'))!;
  const record = (await h.operations.all())[0]!;
  await h.operations.put({
    ...record,
    request: { ...record.request, importBinding: { ...record.request.importBinding!, selectedSourceOrdinals: [1] } },
  });
  await expect(h.checkpoints.put({ ...checkpoint, revision: 2, phase: 'finished' }, 1)).rejects.toThrow(
    'recovery-required',
  );
  expect((await h.checkpoints.get('import'))!.phase).toBe('applying');
});
it('external edit after first receipt produces partial and restart never resumes remaining creates', async () => {
  const h = await setup(0, 'url');
  const put = h.operations.put.bind(h.operations);
  vi.spyOn(h.operations, 'put').mockImplementation(async record => {
    await put(record);
    if (record.steps.filter(s => s.state === 'receipt').length === 1) h.invalidate();
  });
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('partial');
  expect(h.calls()).toBe(1);
  const restart = new MutationCoordinator(h.projection, h.writer, h.operations, 'test');
  expect((await restart.submit(h.request, h.sender)).status).toBe('partial');
  expect(h.calls()).toBe(1);
});
it('empty explicit selection registers no command and never freezes or creates folders', async () => {
  const h = await setup();
  const token = h.authority.open(h.sender);
  expect(
    await h.coordinator.registerImportPreview(
      token,
      'import',
      0,
      { ...h.selection, selectedSourceOrdinals: [], titleEdits: [] },
      h.sender,
    ),
  ).toBeUndefined();
  expect(h.calls()).toBe(0);
  expect(await h.operations.all()).toEqual([]);
  expect((await h.checkpoints.get('import'))!.phase).toBe('classified');
});
it('checkpoint raw selected-plan tamper during backup cannot issue first native call', async () => {
  const h = await setup();
  const handoff = ImportPersistenceStore.prototype.handoffImport.bind(h.operations);
  vi.spyOn(h.operations, 'handoffImport').mockImplementation(async (...args) => {
    await handoff(...args);
    await new Promise<void>((resolve, reject) => {
      const open = h.factory.open('zhilan-operations');
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('importCheckpoints', 'readwrite');
        const store = tx.objectStore('importCheckpoints');
        const get = store.get('import');
        get.onsuccess = () => {
          const row = get.result;
          row.writePlan.binding.titleEdits[0].title = 'Tampered';
          store.put(row);
        };
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  });
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('failed');
  expect(h.calls()).toBe(0);
});
it('observed root invalidation in final projection await fails synchronous issuance check', async () => {
  const h = await setup(0, 'root');
  const fresh = h.projection.fresh.bind(h.projection);
  let reads = 0;
  // queue validation, initial, freeze validation, pre-intent, post-intent, final authority, final coordinator.
  vi.spyOn(h.projection, 'fresh').mockImplementation(async () => {
    const tree = await fresh();
    if (++reads === 7) h.invalidate();
    return tree;
  });
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('failed');
  expect(h.calls()).toBe(0);
  expect(reads).toBe(7);
});
it('real mutation service routes the dedicated preview and existing confirmation to the same writer', async () => {
  const h = await setup();
  const { startMutationService } = await import('../background/mutation-service');
  let handler!: (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: unknown) => void) => boolean;
  vi.stubGlobal('indexedDB', h.factory);
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'test',
      onMessage: {
        addListener: (cb: typeof handler) => {
          handler = cb;
        },
      },
    },
    bookmarks: h.writer,
  });
  try {
    startMutationService(h.projection, undefined, undefined, h.authority, h.operations);
    const token = h.authority.open(h.sender);
    const preview = await new Promise<unknown>(resolve => {
      expect(
        handler(
          {
            version: 1,
            type: 'registerImportPreview',
            importContext: token,
            checkpointId: 'import',
            checkpointRevision: 0,
            selection: h.selection,
          },
          h.sender,
          resolve,
        ),
      ).toBe(true);
    });
    const { confirmSchema } = await import('../schemas/messages');
    const request = confirmSchema.parse((preview as { proposal: unknown }).proposal);
    const result = await new Promise(resolve => {
      handler(request, h.sender, resolve);
    });
    expect(result).toMatchObject({ status: 'completed', completedSteps: 3 });
    expect(h.calls()).toBe(3);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('custom journal without atomic import capability rejects before checkpoint or native side effects', async () => {
  const h = await setup();
  const journal = {
    all: () => h.operations.all(),
    put: (record: Parameters<typeof h.operations.put>[0]) => h.operations.put(record),
  };
  const coordinator = new MutationCoordinator(
    h.projection,
    h.writer,
    journal,
    'test',
    undefined,
    undefined,
    h.authority,
  );
  await expect(
    coordinator.registerImportPreview(h.authority.open(h.sender), 'import', 0, h.selection, h.sender),
  ).rejects.toThrow('import-persistence-owner-mismatch');
  expect((await coordinator.submit(h.request, h.sender)).reason).toBe('import-persistence-owner-mismatch');
  expect(await h.checkpoints.get('import')).toEqual(h.checkpoint);
  expect(await h.operations.all()).toEqual([]);
  expect(h.calls()).toBe(0);
});

it.each(['name', 'factory', 'same-database-new-facet'])(
  'different %s owner fails closed including completion lookup',
  async mismatch => {
    const h = await setup();
    const other = new ImportPersistenceStore(
      mismatch === 'factory' ? new IDBFactory() : h.factory,
      mismatch === 'name' ? 'other-journal' : 'zhilan-operations',
    );
    const coordinator = new MutationCoordinator(
      h.projection,
      h.writer,
      other,
      'test',
      undefined,
      undefined,
      h.authority,
    );
    await expect(
      coordinator.registerImportPreview(h.authority.open(h.sender), 'import', 0, h.selection, h.sender),
    ).rejects.toThrow('import-persistence-owner-mismatch');
    expect((await coordinator.submit(h.request, h.sender)).reason).toBe('import-persistence-owner-mismatch');
    expect(await h.checkpoints.get('import')).toEqual(h.checkpoint);
    expect(await h.operations.all()).toEqual([]);
    expect(await other.all()).toEqual([]);
    expect(h.calls()).toBe(0);
    await expect(
      other.importCheckpoints.put(
        { ...h.checkpoint, phase: 'finished', revision: 1, requestId: h.request.requestId },
        0,
      ),
    ).rejects.toThrow();
    expect(await h.checkpoints.get('import')).toEqual(h.checkpoint);
  },
);
it('explicit custom-name owner and forwarding journal share intent receipts completion and restart', async () => {
  const h = await setup(0, 'privacy', 'custom-import-owner');
  expect((await h.coordinator.submit(h.request, h.sender)).status).toBe('completed');
  const checkpoint = (await h.checkpoints.get('import'))!;
  await h.checkpoints.put({ ...checkpoint, revision: 2, phase: 'finished' }, 1);
  expect((await h.checkpoints.get('import'))!.phase).toBe('finished');
  const restart = new ImportPersistenceStore(h.factory, 'custom-import-owner');
  expect((await restart.all())[0]!.result!.status).toBe('completed');
  expect((await restart.importCheckpoints.get('import'))!.phase).toBe('finished');
  expect(await new ImportPersistenceStore(h.factory).all()).toEqual([]);
  expect(await new ImportPersistenceStore(new IDBFactory(), 'custom-import-owner').all()).toEqual([]);
  const coordinator = new MutationCoordinator(h.projection, h.writer, restart, 'test');
  expect((await coordinator.submit(h.request, h.sender)).status).toBe('completed');
  expect(h.calls()).toBe(3);
});
it('destination adjustments are frozen in handoff binding and durable retry identity', async () => {
  const h = await setup();
  const selection = { ...h.selection, destinationEdits: [{ sourceOrdinal: 0, folderId: 'existing' }] };
  const request = (await h.coordinator.registerImportPreview(
    h.authority.open(h.sender),
    'import',
    0,
    selection,
    h.sender,
  ))!;
  expect((await h.coordinator.submit(request, h.sender)).status).toBe('completed');
  expect(h.calls()).toBe(1);
  expect((await h.checkpoints.get('import'))?.writePlan?.binding.destinationEdits).toEqual(selection.destinationEdits);
  expect(
    (
      await h.coordinator.submit(
        {
          ...request,
          importBinding: { ...request.importBinding!, destinationEdits: [{ sourceOrdinal: 0, folderId: 'bar' }] },
        },
        h.sender,
      )
    ).reason,
  ).toBe('request-id-conflict');
});
