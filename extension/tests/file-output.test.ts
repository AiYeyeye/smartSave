import { configureFileOutput, sendFileOutputCommand, type FileOutputCommand } from '../export/file-output-control';
import { fileOutputAncestry } from '../domain/file-output-scope';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { FileOutputStore, type OutputFileHandle } from '../persistence/file-output';
import { FileOutputSink, fileOutputMessageSchema } from '../background/file-output';
import { TreeProjection } from '../background/tree-projection';
import type { BookmarkSource } from '../adapters/bookmarks-read';
import { openOperationsDatabase } from '../persistence/operations-database';

const clone = globalThis.structuredClone;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
async function harness() {
  const handles = new Map<string, OutputFileHandle>();
  // Node has no FileSystemHandle structured clone implementation. Model only that platform
  // boundary; actual store transactions, sink, native projection and serializers remain real.
  vi.stubGlobal('structuredClone', (value: unknown) => {
    if (value && typeof value === 'object' && 'handle' in value) {
      const record = value as { handle: OutputFileHandle & { name: string } };
      const { handle, ...rest } = record;
      return { ...clone(rest), handle: handles.get(handle.name) };
    }
    return clone(value);
  });
  const factory = new IDBFactory();
  const store = new FileOutputStore(factory);
  let notify!: () => void;
  let title = 'initial';
  let deleted = false;
  const source: BookmarkSource = {
    read: vi.fn(async () => [
      {
        id: '0',
        syncing: false,
        title: '',
        children: deleted ? [] : [{ id: '1', syncing: false, parentId: '0', title, children: [] }],
      },
    ]),
    listen: listener => {
      notify = listener;
      return () => {};
    },
  };
  const tree = new TreeProjection(source, async () => 'install', 'epoch');
  tree.start();
  await vi.waitFor(() => expect(tree.state.status).toBe('ready'));
  if (tree.state.status !== 'ready') throw Error('fixture');
  const scope = { roots: [tree.state.snapshot.nodes[1]!.ref], excludedFolders: [] };
  const ancestry = fileOutputAncestry(tree.state.snapshot, scope);
  function handle(name: string) {
    const stream = {
      write: vi.fn(async (text: string) => {
        void text;
      }),
      close: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    };
    const file = {
      kind: 'file' as const,
      name,
      queryPermission: vi.fn(async (): Promise<PermissionState> => 'granted'),
      createWritable: vi.fn(async () => stream),
    };
    handles.set(name, file);
    return { file, stream };
  }
  const a = handle('a');
  await store.configure(a.file, scope, ancestry, await store.issueLease());
  // Zero debounce keeps the event-driven assertions immediate; the trailing debounce has its own fake-timer case.
  const sink = new FileOutputSink(tree, store, { debounceMs: 0 });
  return {
    factory,
    store,
    source,
    tree,
    sink,
    a,
    handle,
    scope,
    ancestry,
    change: (next = 'changed') => {
      title = next;
      notify();
    },
    remove: () => {
      deleted = true;
      notify();
    },
  };
}
it('starts disabled in the shared additive database', async () => {
  expect(await new FileOutputStore(new IDBFactory()).read()).toBeUndefined();
});
it('startup catches current snapshot without panel and never refreshes itself into a write loop', async () => {
  const h = await harness();
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.sink.status().status).toBe('success'));
  expect(h.a.stream.write.mock.calls[0]![0]).toContain('initial');
  h.tree.refresh();
  await vi.waitFor(() => expect(h.tree.state.status).toBe('ready'));
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(h.a.stream.close).toHaveBeenCalledTimes(1);
  // Startup and explicit reload write the published snapshot; only the explicit refresh above re-reads natively.
  expect(h.source.read).toHaveBeenCalledTimes(2);
  h.sink.dispose();
  h.tree.stop();
});
it('silent fresh reads and same-revision refreshes never fence an in-flight write', async () => {
  const h = await harness();
  const gate = deferred();
  h.a.stream.write.mockImplementationOnce(async () => {
    await gate.promise;
  });
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.a.stream.write).toHaveBeenCalledTimes(1));
  await h.tree.fresh();
  h.tree.refresh();
  await vi.waitFor(() => expect(h.tree.state.status).toBe('ready'));
  gate.resolve();
  await vi.waitFor(() => expect(h.sink.status().status).toBe('success'));
  expect(h.a.stream.abort).not.toHaveBeenCalled();
  expect(h.a.stream.close).toHaveBeenCalledTimes(1);
  expect(h.a.stream.write).toHaveBeenCalledTimes(1);
  h.sink.dispose();
  h.tree.stop();
});
it('a burst of native events produces one trailing write of the latest snapshot after the debounce window', async () => {
  const h = await harness();
  h.sink.dispose();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 2000 && !done(); i++) await new Promise(resolve => setImmediate(resolve));
    expect(done()).toBe(true);
  };
  const sink = new FileOutputSink(h.tree, h.store, { debounceMs: 1500 });
  try {
    await sink.control('reload');
    await settle(() => sink.status().status === 'success');
    expect(h.a.stream.write).toHaveBeenCalledTimes(1);
    h.change('one');
    await settle(() => h.tree.state.status === 'ready' && h.tree.state.snapshot.observedRevision === 1);
    await vi.advanceTimersByTimeAsync(1000);
    h.change('two');
    await settle(() => h.tree.state.status === 'ready' && h.tree.state.snapshot.observedRevision === 2);
    await vi.advanceTimersByTimeAsync(1400);
    expect(h.a.stream.write).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    await settle(() => h.a.stream.write.mock.calls.length === 2);
    await settle(() => sink.status().status === 'success');
    expect(h.a.stream.write.mock.calls[1]![0]).toContain('two');
    expect(h.a.stream.close).toHaveBeenCalledTimes(2);
  } finally {
    sink.dispose();
    vi.useRealTimers();
    h.tree.stop();
  }
});
it.each(['denied', 'prompt', 'error', 'close'] as const)(
  '%s pauses durably, no event-driven retry, explicit retry catches current',
  async failure => {
    const h = await harness();
    if (failure === 'error') h.a.file.queryPermission.mockRejectedValueOnce(Error('permission'));
    else if (failure === 'close') h.a.stream.close.mockRejectedValueOnce(Error('disk'));
    else h.a.file.queryPermission.mockResolvedValueOnce(failure);
    await h.sink.control('reload');
    await vi.waitFor(() =>
      expect(h.sink.status().status).toBe(failure === 'denied' || failure === 'prompt' ? 'needs-permission' : 'paused'),
    );
    expect(h.sink.status().lastSuccess).toBeUndefined();
    h.change('latest');
    await vi.waitFor(() => expect(h.tree.state.status).toBe('ready'));
    expect(h.a.file.queryPermission).toHaveBeenCalledTimes(1);
    await h.sink.control('retry');
    await vi.waitFor(() => expect(h.sink.status().status).toBe('success'));
    expect(h.a.stream.write.mock.calls.at(-1)![0]).toContain('latest');
    h.sink.dispose();
    h.tree.stop();
  },
);
it.each(['permission', 'open', 'write', 'close'] as const)(
  'configuration switch during %s cannot retarget old work or publish old success',
  async stage => {
    const h = await harness();
    const gate = deferred();
    if (stage === 'permission')
      h.a.file.queryPermission.mockImplementationOnce(async () => {
        await gate.promise;
        return 'granted';
      });
    if (stage === 'open')
      h.a.file.createWritable.mockImplementationOnce(async () => {
        await gate.promise;
        return h.a.stream;
      });
    if (stage === 'write')
      h.a.stream.write.mockImplementationOnce(async () => {
        await gate.promise;
      });
    if (stage === 'close')
      h.a.stream.close.mockImplementationOnce(async () => {
        await gate.promise;
      });
    await h.sink.control('reload');
    const observed =
      stage === 'permission'
        ? h.a.file.queryPermission
        : stage === 'open'
          ? h.a.file.createWritable
          : stage === 'write'
            ? h.a.stream.write
            : h.a.stream.close;
    await vi.waitFor(() => expect(observed).toHaveBeenCalled());
    await h.sink.control('stop');
    const b = h.handle('b');
    const generation = await h.store.configure(b.file, h.scope, h.ancestry, await h.store.issueLease());
    await h.sink.control('reload');
    gate.resolve();
    await vi.waitFor(() => expect(h.sink.status()).toMatchObject({ status: 'success', generation }));
    expect(b.stream.close).toHaveBeenCalledTimes(1);
    expect(b.stream.write).toHaveBeenCalledTimes(1);
    h.sink.dispose();
    h.tree.stop();
  },
);
it('loading during awaited write fences success and bursts coalesce to latest snapshot', async () => {
  const h = await harness();
  const gate = deferred();
  h.a.stream.write.mockImplementationOnce(async () => {
    await gate.promise;
  });
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.a.stream.write).toHaveBeenCalledTimes(1));
  h.change('one');
  h.change('two');
  h.change('final');
  gate.resolve();
  await vi.waitFor(() => expect(h.sink.status().status).toBe('success'));
  expect(h.a.stream.abort).toHaveBeenCalledTimes(1);
  expect(h.a.stream.close).toHaveBeenCalledTimes(1);
  expect(h.a.stream.write.mock.calls.at(-1)![0]).toContain('final');
  h.sink.dispose();
  h.tree.stop();
});
it('deleted scope fails closed and explicit retry cannot fall back to whole tree', async () => {
  const h = await harness();
  h.remove();
  await vi.waitFor(() => expect(h.tree.state.status).toBe('ready'));
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.sink.status().status).toBe('scope-invalid'));
  await h.sink.control('retry');
  await vi.waitFor(() => expect(h.sink.status().status).toBe('scope-invalid'));
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  h.sink.dispose();
  h.tree.stop();
});
it('storage failure pauses and dispose fences pending permission', async () => {
  const h = await harness();
  vi.spyOn(h.store, 'read').mockRejectedValueOnce(Error('disk'));
  await h.sink.control('reload');
  expect(h.sink.status().status).toBe('storage-error');
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  const gate = deferred();
  h.a.file.queryPermission.mockImplementationOnce(async () => {
    await gate.promise;
    return 'granted';
  });
  await h.sink.control('retry');
  await vi.waitFor(() => expect(h.a.file.queryPermission).toHaveBeenCalled());
  h.sink.dispose();
  gate.resolve();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  h.tree.stop();
});
it('additive v3 migration preserves raw operation/import evidence and future versions fail closed', async () => {
  const factory = new IDBFactory();
  await new Promise<void>((resolve, reject) => {
    const request = factory.open('legacy', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('operations').put({ evidence: 'operation' }, 'old');
      db.createObjectStore('importCheckpoints').put({ evidence: 'import' }, 'old');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
  const db = await openOperationsDatabase(factory, 'legacy');
  expect(db.version).toBe(3);
  for (const [store, evidence] of [
    ['operations', 'operation'],
    ['importCheckpoints', 'import'],
  ]) {
    const value = await new Promise(resolve => {
      const request = db.transaction(store!).objectStore(store!).get('old');
      request.onsuccess = () => resolve(request.result);
    });
    expect(value).toEqual({ evidence });
  }
  db.close();
  await new Promise<void>(resolve => {
    const request = factory.open('future', 4);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
  });
  await expect(new FileOutputStore(factory, 'future').read()).rejects.toThrow('unsupported-journal');
});
it('control messages are exact metadata only', () => {
  expect(
    fileOutputMessageSchema.safeParse({
      version: 1,
      type: 'fileOutput',
      action: 'retry',
      ticket: 'ticket',
      expectedGeneration: 'target',
      expectedRevision: 0,
    }).success,
  ).toBe(true);
  expect(
    fileOutputMessageSchema.safeParse({ version: 1, type: 'fileOutput', action: 'retry', handle: {} }).success,
  ).toBe(false);
});
it('matching generation CAS rejects stale success and guard prevents publication', async () => {
  const h = await harness();
  const old = (await h.store.read())!;
  const b = h.handle('b');
  const generation = await h.store.configure(b.file, h.scope, h.ancestry, await h.store.issueLease());
  expect(await h.store.update(old.generation, { status: 'success', lastSuccess: 'old' })).toBe(false);
  expect(await h.store.update(generation, { status: 'success', lastSuccess: 'guarded' }, () => false)).toBe(false);
  expect(await h.store.read()).toMatchObject({ generation, status: 'pending' });
  h.sink.dispose();
  h.tree.stop();
});
it('last-success storage failure is not reported as file success or retried on events', async () => {
  const h = await harness();
  vi.spyOn(h.store, 'update').mockRejectedValue(Error('disk'));
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.sink.status().status).toBe('storage-error'));
  expect(h.a.stream.close).toHaveBeenCalledTimes(1);
  expect(h.sink.status().lastSuccess).toBeUndefined();
  h.change();
  await vi.waitFor(() => expect(h.tree.state.status).toBe('ready'));
  expect(h.a.stream.close).toHaveBeenCalledTimes(1);
  h.sink.dispose();
  h.tree.stop();
});
it('stop while write is pending prevents close and remains stopped after source changes', async () => {
  const h = await harness();
  const gate = deferred();
  h.a.stream.write.mockImplementationOnce(async () => {
    await gate.promise;
  });
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.a.stream.write).toHaveBeenCalled());
  await h.sink.control('stop');
  gate.resolve();
  h.change();
  await vi.waitFor(() => expect(h.a.stream.abort).toHaveBeenCalled());
  expect(h.a.stream.close).not.toHaveBeenCalled();
  expect(h.sink.status()).toEqual({ status: 'stopped' });
  expect(await h.store.read()).toMatchObject({ enabled: false, status: 'stopped' });
  h.sink.dispose();
  h.tree.stop();
});
it('switch while old storage read is pending cannot install old handle', async () => {
  const h = await harness();
  const original = await h.store.read();
  const gate = deferred();
  vi.spyOn(h.store, 'read').mockImplementationOnce(async () => {
    await gate.promise;
    return original;
  });
  const reload = h.sink.control('reload');
  await Promise.resolve();
  const stop = h.sink.control('stop');
  gate.resolve();
  await reload;
  await stop;
  const b = h.handle('b');
  await h.store.configure(b.file, h.scope, h.ancestry, await h.store.issueLease());
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.sink.status().status).toBe('success'));
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  expect(b.stream.close).toHaveBeenCalledOnce();
  h.sink.dispose();
  h.tree.stop();
});
it('configuration client stops before structured-clone persistence and sends no handle', async () => {
  const h = await harness();
  const sendMessage = vi.fn((message: FileOutputCommand) => h.sink.command(message));
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  const { configureFileOutput } = await import('../export/file-output-control');
  if (h.tree.state.status !== 'ready') throw Error('fixture');
  const generation = await configureFileOutput(h.a.file, h.tree.state.snapshot, h.scope, h.store);
  expect(sendMessage.mock.calls.map(call => call[0].action)).toEqual(['prepare', 'reload']);
  expect(JSON.stringify(sendMessage.mock.calls)).not.toContain('handle');
  await vi.waitFor(() => expect(h.sink.status()).toMatchObject({ status: 'success', generation }));
  h.sink.dispose();
  h.tree.stop();
});

it('changed persisted ancestry requires reselect rather than following a moved scope', async () => {
  const h = await harness();
  await h.store.configure(h.a.file, h.scope, [['1', 'previous-parent', '0']], await h.store.issueLease());
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.sink.status().status).toBe('scope-invalid'));
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  h.sink.dispose();
  h.tree.stop();
});
it('projection resource failure pauses without misreporting invalid scope or opening a file', async () => {
  const h = await harness();
  h.change('x'.repeat(16 * 1024 * 1024 + 1));
  await vi.waitFor(() => expect(h.tree.state.status).toBe('ready'));
  await h.sink.control('reload');
  await vi.waitFor(() => expect(h.sink.status().status).toBe('paused'));
  expect((await h.store.read())?.status).toBe('paused');
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  h.sink.dispose();
  h.tree.stop();
});
it('stale generation retry cannot invalidate or pause an active replacement write', async () => {
  const h = await harness();
  const old = (await h.store.read())!.generation;
  const b = h.handle('active-b');
  await h.sink.control('stop');
  await h.store.configure(b.file, h.scope, h.ancestry, await h.store.issueLease());
  const gate = deferred();
  b.stream.write.mockImplementationOnce(async () => {
    await gate.promise;
  });
  await h.sink.control('reload');
  await vi.waitFor(() => expect(b.stream.write).toHaveBeenCalled());
  await h.sink.control('retry', old);
  gate.resolve();
  await vi.waitFor(() => expect(h.sink.status().status).toBe('success'));
  expect(b.stream.abort).not.toHaveBeenCalled();
  expect(b.stream.close).toHaveBeenCalledTimes(1);
  h.change('still active');
  await vi.waitFor(() => expect(b.stream.close).toHaveBeenCalledTimes(2));
  h.sink.dispose();
  h.tree.stop();
});

it('empty-store stop invalidates an independently issued configuration lease across restart', async () => {
  const factory = new IDBFactory();
  const a = new FileOutputStore(factory);
  const b = new FileOutputStore(factory);
  const lease = await a.issueLease();
  await b.stop();
  expect(await new FileOutputStore(factory).validateLease(lease)).toBe(false);
});
it('competing configuration leases cannot both commit', async () => {
  const h = await harness();
  const a = await h.store.issueLease();
  const b = await new FileOutputStore(h.factory).issueLease();
  await h.store.configure(h.a.file, h.scope, h.ancestry, a);
  await expect(h.store.configure(h.a.file, h.scope, h.ancestry, b)).rejects.toThrow('conflict');
  await expect(h.store.configure(h.a.file, h.scope, h.ancestry, a)).rejects.toThrow('conflict');
  h.sink.dispose();
  h.tree.stop();
});
it.each(['open', 'commit'] as const)('independent page stop wins while configuration %s is deferred', async phase => {
  const h = await harness();
  const pageA = new FileOutputStore(h.factory);
  const pageB = new FileOutputStore(h.factory);
  const gate = deferred();
  const entered = deferred();
  const b = h.handle('pending');
  const originalOpen = h.factory.open.bind(h.factory);
  const spy = vi.spyOn(h.factory, 'open');
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (command: FileOutputCommand) => {
        const result = await h.sink.command(command);
        if (command.action === 'prepare') {
          if (phase === 'commit') {
            entered.resolve();
            await gate.promise;
          } else
            spy.mockImplementationOnce((...args) => {
              const request = originalOpen(...args);
              request.addEventListener('success', event => {
                event.stopImmediatePropagation();
                entered.resolve();
                void gate.promise.then(() => request.onsuccess?.call(request, event));
              });
              return request;
            });
        }
        return result;
      },
    },
  });
  if (h.tree.state.status !== 'ready') throw Error('fixture');
  const pending = configureFileOutput(b.file, h.tree.state.snapshot, h.scope, pageA);
  const refusal = expect(pending).rejects.toThrow('conflict');
  await entered.promise;
  await sendFileOutputCommand({ version: 1, type: 'fileOutput', action: 'stop', ticket: 'page-b-stop' });
  expect((await pageB.read())?.enabled).toBe(false);
  gate.resolve();
  await refusal;
  expect(b.file.createWritable).not.toHaveBeenCalled();
  expect((await pageB.read())?.enabled).toBe(false);
  const restarted = new FileOutputSink(h.tree, pageB, { debounceMs: 0 });
  await restarted.control('reload');
  expect(restarted.status().status).toBe('stopped');
  restarted.dispose();
  h.sink.dispose();
  h.tree.stop();
});
it('stale prepare acknowledgement cannot replace a running target from another page', async () => {
  const h = await harness();
  const gate = deferred();
  const entered = deferred();
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (command: FileOutputCommand) => {
        const receipt = await h.sink.command(command);
        if (command.action === 'prepare' && !enteredOnce) {
          enteredOnce = true;
          entered.resolve();
          await gate.promise;
        }
        return receipt;
      },
    },
  });
  let enteredOnce = false;
  if (h.tree.state.status !== 'ready') throw Error('fixture');
  const snapshot = h.tree.state.snapshot;
  const a = h.handle('late-a');
  const b = h.handle('running-b');
  const pending = configureFileOutput(a.file, snapshot, h.scope, new FileOutputStore(h.factory));
  const refusal = expect(pending).rejects.toThrow('conflict');
  await entered.promise;
  const generation = await configureFileOutput(b.file, snapshot, h.scope, new FileOutputStore(h.factory));
  await vi.waitFor(() => expect(h.sink.status()).toMatchObject({ status: 'success', generation }));
  gate.resolve();
  await refusal;
  expect((await h.store.read())?.generation).toBe(generation);
  expect(a.file.createWritable).not.toHaveBeenCalled();
  h.sink.dispose();
  h.tree.stop();
});
it('reload returns correlated storage-error, and an overtaken read returns stale rather than stop success', async () => {
  const h = await harness();
  const target = (await h.store.read())!;
  const command: FileOutputCommand = {
    version: 1,
    type: 'fileOutput',
    action: 'reload',
    ticket: 'reload-ticket',
    expectedGeneration: target.generation,
    expectedRevision: target.controlRevision,
  };
  vi.spyOn(h.store, 'read').mockRejectedValueOnce(Error('disk'));
  expect(await h.sink.command(command)).toMatchObject({
    outcome: 'storage-error',
    ticket: command.ticket,
    expectedGeneration: target.generation,
  });
  const gate = deferred();
  const entered = deferred();
  vi.spyOn(h.store, 'read').mockImplementationOnce(async () => {
    entered.resolve();
    await gate.promise;
    return target;
  });
  const reload = h.sink.command(command);
  await entered.promise;
  const stop = h.sink.command({ version: 1, type: 'fileOutput', action: 'stop', ticket: 'stop-ticket' });
  gate.resolve();
  expect(await reload).toMatchObject({ outcome: 'stale', ticket: command.ticket });
  expect(await stop).toMatchObject({ outcome: 'accepted', ticket: 'stop-ticket' });
  expect(h.a.file.createWritable).not.toHaveBeenCalled();
  h.sink.dispose();
  h.tree.stop();
});
it.each(['ticket', 'expectedGeneration', 'expectedRevision', 'revision'] as const)(
  'client refuses mismatched %s in an accepted receipt',
  async field => {
    const command: FileOutputCommand = {
      version: 1,
      type: 'fileOutput',
      action: 'reload',
      ticket: 'ticket',
      expectedGeneration: 'generation',
      expectedRevision: 4,
    };
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: async () => ({
          version: 1,
          type: 'fileOutputResult',
          action: 'reload',
          outcome: 'accepted',
          ticket: 'ticket',
          expectedGeneration: 'generation',
          expectedRevision: 4,
          revision: 4,
          [field]: field.includes('evision') ? 5 : 'wrong',
        }),
      },
    });
    await expect(sendFileOutputCommand(command)).rejects.toThrow('receipt-mismatch');
  },
);
it('handle clone failure rolls back lease consumption and target replacement in the same transaction', async () => {
  const h = await harness();
  const old = await h.store.read();
  const lease = await h.store.issueLease();
  const boundary = globalThis.structuredClone;
  vi.stubGlobal('structuredClone', (value: unknown) => {
    if (value && typeof value === 'object' && 'handle' in value) throw new DOMException('clone', 'DataCloneError');
    return boundary(value);
  });
  await expect(h.store.configure(h.a.file, h.scope, h.ancestry, lease)).rejects.toThrow('storage');
  vi.stubGlobal('structuredClone', boundary);
  expect(await h.store.validateLease(lease)).toBe(true);
  expect((await h.store.read())?.generation).toBe(old?.generation);
  h.sink.dispose();
  h.tree.stop();
});
it('a delayed configuration commit callback followed by stop cannot schedule the committed old generation', async () => {
  const h = await harness();
  const entered = deferred();
  const gate = deferred();
  const b = h.handle('commit-b');
  const originalOpen = h.factory.open.bind(h.factory);
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (command: FileOutputCommand) => {
        const receipt = await h.sink.command(command);
        if (command.action === 'prepare')
          vi.spyOn(h.factory, 'open').mockImplementationOnce((...args) => {
            const request = originalOpen(...args);
            request.addEventListener('success', () => {
              const db = request.result;
              const transaction = db.transaction.bind(db);
              vi.spyOn(db, 'transaction').mockImplementation((...arguments_) => {
                const tx = transaction(...arguments_);
                tx.addEventListener('complete', event => {
                  event.stopImmediatePropagation();
                  entered.resolve();
                  void gate.promise.then(() => tx.oncomplete?.call(tx, event));
                });
                return tx;
              });
            });
            return request;
          });
        return receipt;
      },
    },
  });
  if (h.tree.state.status !== 'ready') throw Error('fixture');
  const pending = configureFileOutput(b.file, h.tree.state.snapshot, h.scope, new FileOutputStore(h.factory));
  const refusal = expect(pending).rejects.toThrow('stale');
  await entered.promise;
  await sendFileOutputCommand({ version: 1, type: 'fileOutput', action: 'stop', ticket: 'stop-after-commit' });
  gate.resolve();
  await refusal;
  expect((await h.store.read())?.enabled).toBe(false);
  expect(b.file.createWritable).not.toHaveBeenCalled();
  h.sink.dispose();
  h.tree.stop();
});
it('legacy target metadata is additive and malformed authority fails closed without erasing evidence', async () => {
  const h = await harness();
  const target = (await h.store.read())!;
  const db = await openOperationsDatabase(h.factory, 'zhilan-operations');
  async function putLegacy(control?: unknown) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('fileOutput', 'readwrite');
      const store = tx.objectStore('fileOutput');
      const legacy = { ...target };
      Reflect.deleteProperty(legacy, 'controlRevision');
      store.put(legacy, 'target');
      if (control === undefined) store.delete('control');
      else store.put(control, 'control');
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
  }
  await putLegacy();
  expect(await h.store.read()).toMatchObject({ generation: target.generation, controlRevision: 0 });
  await putLegacy({ version: 2, revision: 0, leases: [] });
  await expect(h.store.read()).rejects.toThrow('storage');
  await expect(h.store.issueLease()).rejects.toThrow('storage');
  await expect(h.store.stop()).rejects.toThrow('storage');
  const request = db.transaction('fileOutput').objectStore('fileOutput').get('target');
  const retained = await new Promise(resolve => {
    request.onsuccess = () => resolve(request.result);
  });
  expect(retained).toMatchObject({ generation: target.generation });
  db.close();
  h.sink.dispose();
  h.tree.stop();
});
