import { afterEach, expect, it, vi } from 'vitest';
import { BookmarkCheckOwner } from '../background/bookmark-check-owner';
import { emptyBookmarkCheck, WEEK_MS, type BookmarkCheckState, type LinkResult } from '../domain/bookmark-check';
import { organizerTree } from './fixtures/organizer-tree';
import type { TreeState } from '../domain/node-reference';

const owners: BookmarkCheckOwner[] = [];
afterEach(() => {
  for (const owner of owners) owner.dispose();
  owners.length = 0;
});
const ok: LinkResult = { status: 'ok', reason: 'http', code: 200, at: 10 };
function fixture() {
  let state = emptyBookmarkCheck();
  const tree = organizerTree();
  const store = {
    read: vi.fn(async () => structuredClone(state)),
    write: vi.fn(async (next: BookmarkCheckState) => {
      state = structuredClone(next);
    }),
  };
  const options = {
    store,
    projection: { fresh: vi.fn(async () => structuredClone(tree)) },
    permitted: vi.fn(async () => true),
    schedule: vi.fn(async () => {}),
    probe: vi.fn<(url: string, signal: AbortSignal) => Promise<LinkResult>>(async () => ok),
    now: () => 1000,
    batchDelayMs: 0,
    scheduleTimeoutMs: 40,
    lifetime: { acquire: vi.fn(() => vi.fn()) },
  };
  const create = () => {
    const owner = new BookmarkCheckOwner(options);
    owners.push(owner);
    return owner;
  };
  return {
    options,
    tree,
    create,
    get saved() {
      return state;
    },
  };
}
const get = (owner: BookmarkCheckOwner) => owner.handle({ type: 'bookmarkCheck', action: 'get' });
const start = (owner: BookmarkCheckOwner) =>
  owner.handle({ type: 'bookmarkCheck', action: 'start', installationId: 'install', scopeId: null });
async function settled(owner: BookmarkCheckOwner, status: string) {
  await vi.waitFor(async () => expect((await get(owner)).job?.status).toBe(status));
  return get(owner);
}

it('retries a failed initial read instead of permanently rejecting every later command', async () => {
  const f = fixture();
  f.options.store.read.mockRejectedValueOnce(Error('storage-unavailable'));
  const owner = f.create();
  await expect(get(owner)).rejects.toThrow('storage-unavailable');
  expect(await get(owner)).toEqual(emptyBookmarkCheck());
  await start(owner);
  await settled(owner, 'completed');
  expect(f.options.store.read).toHaveBeenCalledTimes(2);
});

it('keeps manual controls usable after alarm restoration fails and retries the alarm separately', async () => {
  const f = fixture();
  f.options.schedule.mockRejectedValue(Error('alarms unavailable'));
  const owner = f.create();
  expect((await get(owner)).notice).toBe('schedule-unavailable');
  await start(owner);
  await settled(owner, 'completed');
  f.options.schedule.mockResolvedValue(undefined);
  await get(owner);
  await vi.waitFor(async () => expect((await get(owner)).notice).toBeUndefined());
  expect(f.options.store.read).toHaveBeenCalledTimes(1);
});

it('bounds a hung alarm restoration so initialization and later commands remain usable', async () => {
  const f = fixture();
  let finishSchedule!: () => void;
  f.options.schedule.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishSchedule = resolve;
      }),
  );
  const owner = f.create();
  expect((await get(owner)).notice).toBe('schedule-unavailable');
  await start(owner);
  const completed = await settled(owner, 'completed');
  finishSchedule();
  await vi.waitFor(async () => expect((await get(owner)).job).toEqual(completed.job));
  await vi.waitFor(() => expect(f.options.schedule).toHaveBeenCalledTimes(3));
});

it.each(['resolve', 'reject'] as const)(
  'restarts even when an old probe ignores cancellation; its late %s cannot alter the new job',
  async outcome => {
    const f = fixture(),
      owner = f.create();
    const originalTree = structuredClone(f.tree);
    await owner.handle({
      type: 'bookmarkCheck',
      action: 'verify',
      installationId: 'install',
      nativeId: 'a',
      url: 'https://x.test/?a#b',
      available: true,
    });
    let finish!: () => void;
    let oldSignal!: AbortSignal;
    f.options.probe.mockImplementationOnce(
      (_url, signal) =>
        new Promise((resolve, reject) => {
          oldSignal = signal;
          finish = () =>
            outcome === 'resolve'
              ? resolve({ status: 'broken', reason: 'http', code: 404, at: 20 })
              : reject(Error('late old failure'));
        }),
    );
    const previous = await start(owner);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const restarted = await owner.handle({
      type: 'bookmarkCheck',
      action: 'restart',
      installationId: 'install',
      scopeId: null,
    });
    expect(oldSignal.aborted).toBe(true);
    expect(restarted.job!.id).not.toBe(previous.job!.id);
    const completed = await settled(owner, 'completed');
    expect(completed.job!.items.find(item => item.nativeId === 'a')!.result?.reason).toBe('manual');
    expect(completed.job!.items.find(item => item.nativeId === 'b')!.result).toEqual(ok);
    finish();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await get(owner)).toEqual(completed);
    expect(f.tree).toEqual(originalTree);
  },
);

it('stops old traffic when restart scope validation fails and leaves the previous report resumable', async () => {
  const f = fixture(),
    owner = f.create();
  let signal!: AbortSignal;
  f.options.probe.mockImplementationOnce(
    (_url, current) =>
      new Promise((_resolve, reject) => {
        signal = current;
        current.addEventListener('abort', () => reject(Error('cancelled')));
      }),
  );
  const prior = await start(owner);
  await vi.waitFor(() => expect(signal).toBeDefined());
  await expect(
    owner.handle({ type: 'bookmarkCheck', action: 'restart', installationId: 'install', scopeId: 'missing' }),
  ).rejects.toThrow('invalid-scope');
  expect(signal.aborted).toBe(true);
  expect((await get(owner)).job).toMatchObject({ id: prior.job!.id, status: 'paused' });
  await owner.handle({ type: 'bookmarkCheck', action: 'resume' });
  await settled(owner, 'completed');
});

it('does not begin old URL requests after a cancelled scope read finally resolves', async () => {
  const f = fixture(),
    owner = f.create();
  let finishScope!: () => void;
  f.options.projection.fresh.mockResolvedValueOnce(structuredClone(f.tree)).mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finishScope = () => resolve(structuredClone(f.tree));
      }),
  );
  await start(owner);
  await vi.waitFor(() => expect(finishScope).toBeTypeOf('function'));
  await owner.handle({ type: 'bookmarkCheck', action: 'restart', installationId: 'install', scopeId: null });
  const completed = await settled(owner, 'completed');
  expect(f.options.probe).toHaveBeenCalledTimes(1);
  finishScope();
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.options.probe).toHaveBeenCalledTimes(1);
  expect(await get(owner)).toEqual(completed);
});

it('publishes a newer error revision when both progress and failure checkpoints fail, then permits restart', async () => {
  const f = fixture(),
    owner = f.create();
  f.options.probe.mockImplementationOnce(async () => {
    f.options.store.write.mockRejectedValue(Error('storage-timeout'));
    return ok;
  });
  const prior = await start(owner);
  const failed = await settled(owner, 'error');
  expect(failed.notice).toBe('storage-timeout');
  expect(failed.revision).toBeGreaterThan(prior.revision);
  f.options.store.write.mockResolvedValue(undefined);
  await owner.handle({ type: 'bookmarkCheck', action: 'restart', installationId: 'install', scopeId: null });
  await settled(owner, 'completed');
});

it('aborts a pause immediately while the prior progress checkpoint is pending', async () => {
  const f = fixture(),
    owner = f.create();
  let signal!: AbortSignal;
  let rejectCheckpoint!: (error: Error) => void;
  f.options.probe.mockImplementationOnce(async (_url, current) => {
    signal = current;
    f.options.store.write.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCheckpoint = reject;
        }),
    );
    return ok;
  });
  await start(owner);
  await vi.waitFor(() => expect(rejectCheckpoint).toBeTypeOf('function'));
  const pause = owner.handle({ type: 'bookmarkCheck', action: 'pause' });
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  rejectCheckpoint(Error('storage-timeout'));
  expect((await pause).job?.status).toBe('paused');
  await owner.handle({ type: 'bookmarkCheck', action: 'resume' });
  await settled(owner, 'completed');
});

it('preserves per-bookmark manual confirmation through weekly scans and restart, never across URL changes', async () => {
  const f = fixture(),
    owner = f.create();
  await start(owner);
  await settled(owner, 'completed');
  const verify = {
    type: 'bookmarkCheck' as const,
    action: 'verify' as const,
    installationId: 'install',
    nativeId: 'a',
    url: 'https://x.test/?a#b',
    available: true,
  };
  await owner.handle(verify);
  await owner.handle({
    type: 'bookmarkCheck',
    action: 'configure',
    installationId: 'install',
    scopeId: null,
    weekly: true,
  });
  owner.dispose();
  const restored = f.create();
  f.options.probe.mockResolvedValue({ status: 'broken', reason: 'http', code: 404, at: 100 });
  await restored.weekly();
  const report = await settled(restored, 'completed');
  expect(report.job!.items.find(item => item.nativeId === 'a')!.result).toMatchObject({
    status: 'ok',
    reason: 'manual',
  });
  expect(report.job!.items.find(item => item.nativeId === 'b')!.result).toMatchObject({ status: 'broken' });
  f.tree.nodes.find(node => node.ref.nativeId === 'a')!.url = 'https://changed.test/';
  await expect(restored.handle(verify)).rejects.toThrow('stale-selection');
  await start(restored);
  expect((await settled(restored, 'completed')).job!.items.find(item => item.nativeId === 'a')!.result).toMatchObject({
    status: 'broken',
  });
});

it('manual confirmation wins an in-flight probe and can be restored without native mutations', async () => {
  const f = fixture(),
    owner = f.create();
  let finish!: (result: LinkResult) => void;
  f.options.probe.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await start(owner);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const verify = {
    type: 'bookmarkCheck' as const,
    action: 'verify' as const,
    installationId: 'install',
    nativeId: 'a',
    url: 'https://x.test/?a#b',
    available: true,
  };
  const before = structuredClone(f.tree);
  await owner.handle(verify);
  finish({ status: 'broken', reason: 'http', code: 404, at: 100 });
  expect((await settled(owner, 'completed')).job!.items.find(item => item.nativeId === 'a')!.result!.reason).toBe(
    'manual',
  );
  await owner.handle({ ...verify, available: false });
  expect((await get(owner)).verified).toEqual([]);
  await start(owner);
  expect((await settled(owner, 'completed')).job!.items.find(item => item.nativeId === 'a')!.result!.reason).toBe(
    'http',
  );
  expect(f.tree).toEqual(before);
});

it('checks locally owned native URLs once, persists progress and never mutates the native tree', async () => {
  const f = fixture(),
    before = structuredClone(f.tree),
    owner = f.create();
  await start(owner);
  const state = await settled(owner, 'completed');
  expect(state.job?.items).toHaveLength(3);
  expect(state.job?.duplicateGroups).toBe(1);
  expect(f.options.probe).toHaveBeenCalledTimes(1);
  expect(f.tree).toEqual(before);
  expect(f.saved).toEqual(state);
});
it('rejects stale installations and scopes before probing', async () => {
  const f = fixture(),
    owner = f.create();
  await expect(
    owner.handle({ type: 'bookmarkCheck', action: 'start', installationId: 'other', scopeId: null }),
  ).rejects.toThrow('installation-changed');
  await expect(
    owner.handle({ type: 'bookmarkCheck', action: 'start', installationId: 'install', scopeId: 'missing' }),
  ).rejects.toThrow('invalid-scope');
  expect(f.options.probe).not.toHaveBeenCalled();
});

it('uses native event updates between probes without rereading the entire tree for every link', async () => {
  const f = fixture();
  const projection = {
    ...f.options.projection,
    state: { status: 'ready', snapshot: structuredClone(f.tree) } as TreeState,
  };
  const owner = new BookmarkCheckOwner({ ...f.options, projection });
  owners.push(owner);
  f.options.probe.mockImplementationOnce(async () => {
    const changed = structuredClone(f.tree);
    changed.nodes.find(node => node.ref.nativeId === 'b')!.url = 'https://changed.test/';
    projection.state = { status: 'ready', snapshot: changed };
    return ok;
  });
  await start(owner);
  const report = await settled(owner, 'completed');
  expect(projection.fresh).toHaveBeenCalledTimes(1);
  expect(report.job?.items.find(item => item.nativeId === 'b')?.result?.reason).toBe('changed');
  expect(f.options.probe).toHaveBeenCalledTimes(1);
});
it('pauses without classifying in-flight requests; immediate resume survives late cancellation', async () => {
  const f = fixture();
  let abort!: () => void;
  f.options.probe.mockImplementationOnce(
    (_url?: unknown, signal?: unknown) =>
      new Promise((_resolve, reject) => {
        abort = () => reject(Error('cancelled'));
        (signal as AbortSignal).addEventListener('abort', abort);
      }),
  );
  const owner = f.create();
  await start(owner);
  await vi.waitFor(() => expect(abort).toBeDefined());
  await owner.handle({ type: 'bookmarkCheck', action: 'pause' });
  expect((await get(owner)).job?.items.every(item => !item.result)).toBe(true);
  await owner.handle({ type: 'bookmarkCheck', action: 'resume' });
  await settled(owner, 'completed');
  expect(f.options.probe).toHaveBeenCalledTimes(2);
});
it('stops on failed pause checkpoints and does not relaunch aborted traffic', async () => {
  const f = fixture();
  f.options.probe.mockImplementationOnce(
    (_url?: unknown, signal?: unknown) =>
      new Promise((_resolve, reject) =>
        (signal as AbortSignal).addEventListener('abort', () => reject(Error('cancelled'))),
      ),
  );
  const owner = f.create();
  await start(owner);
  await vi.waitFor(() => expect(f.options.probe).toHaveBeenCalled());
  let rejectCheckpoint!: (error: Error) => void;
  f.options.store.write.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectCheckpoint = reject;
      }),
  );
  const paused = owner.handle({ type: 'bookmarkCheck', action: 'pause' });
  const failed = expect(paused).rejects.toThrow('storage-unavailable');
  await vi.waitFor(() => expect(rejectCheckpoint).toBeDefined());
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.options.probe).toHaveBeenCalledTimes(1);
  rejectCheckpoint(Error('storage-unavailable'));
  await failed;
  expect((await get(owner)).job?.status).toBe('paused');
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.options.probe).toHaveBeenCalledTimes(1);
});
it('revoked access aborts requests and retains pending work for explicit resume', async () => {
  const f = fixture();
  let aborted = false;
  f.options.probe.mockImplementationOnce(
    (_url?: unknown, signal?: unknown) =>
      new Promise((_resolve, reject) =>
        (signal as AbortSignal).addEventListener('abort', () => {
          aborted = true;
          reject(Error('cancelled'));
        }),
      ),
  );
  const owner = f.create();
  await start(owner);
  await vi.waitFor(() => expect(f.options.probe).toHaveBeenCalled());
  f.options.permitted.mockResolvedValue(false);
  await owner.permissionsChanged();
  expect(aborted).toBe(true);
  expect((await get(owner)).notice).toBe('permission-required');
  await expect(owner.handle({ type: 'bookmarkCheck', action: 'resume' })).rejects.toThrow('permission-required');
  f.options.permitted.mockResolvedValue(true);
  await owner.handle({ type: 'bookmarkCheck', action: 'resume' });
  await settled(owner, 'completed');
});
it('restores unfinished work after worker shutdown without rechecking completed URLs', async () => {
  const f = fixture();
  f.tree.nodes.find(n => n.ref.nativeId === 'b')!.url = 'https://second.test/';
  let secondStarted = false;
  f.options.probe.mockImplementation(async (url?: unknown, signal?: unknown) => {
    if (url === 'https://second.test/') {
      secondStarted = true;
      return new Promise((_resolve, reject) =>
        (signal as AbortSignal).addEventListener('abort', () => reject(Error('cancelled'))),
      );
    }
    return ok;
  });
  // Seed a checkpoint representing the prior worker's completed first item.
  await f.options.store.write({
    ...emptyBookmarkCheck(),
    installationId: 'install',
    job: {
      id: 'job',
      installationId: 'install',
      scopeId: null,
      status: 'running',
      startedAt: 1,
      updatedAt: 1,
      duplicateGroups: 1,
      items: f.tree.nodes
        .filter(n => n.url)
        .map(n => ({ nativeId: n.ref.nativeId, url: n.url!, ...(n.ref.nativeId === 'a' ? { result: ok } : {}) })),
    },
  });
  const owner = f.create();
  await vi.waitFor(() => expect(secondStarted).toBe(true));
  owner.dispose();
  f.options.probe.mockImplementation(async () => ok);
  const restored = f.create();
  await settled(restored, 'completed');
  expect(f.options.probe.mock.calls.map(args => args[0])).toEqual(['https://second.test/', 'https://second.test/']);
});
it('weekly opt-in persists its due date, checks without an observer and can be disabled after folder removal', async () => {
  const f = fixture(),
    owner = f.create();
  await get(owner);
  expect(f.options.schedule).toHaveBeenCalledWith(undefined);
  await owner.handle({
    type: 'bookmarkCheck',
    action: 'configure',
    installationId: 'install',
    scopeId: 'left',
    weekly: true,
  });
  expect(f.saved.nextRun).toBe(1000 + WEEK_MS);
  const other = f.create();
  await get(other);
  expect(f.options.schedule).toHaveBeenLastCalledWith(1000 + WEEK_MS);
  await owner.weekly();
  await settled(owner, 'completed');
  f.tree.nodes = f.tree.nodes.filter(n => n.ref.nativeId !== 'left');
  await owner.handle({
    type: 'bookmarkCheck',
    action: 'configure',
    installationId: 'install',
    scopeId: 'left',
    weekly: false,
  });
  expect(f.saved.weekly).toBe(false);
  expect(f.options.schedule).toHaveBeenLastCalledWith(undefined);
});
it('weekly retries transient failures but preserves deliberate pauses', async () => {
  const f = fixture(),
    owner = f.create();
  await owner.handle({
    type: 'bookmarkCheck',
    action: 'configure',
    installationId: 'install',
    scopeId: null,
    weekly: true,
  });
  f.options.probe.mockRejectedValueOnce(Error('temporary'));
  await owner.weekly();
  await settled(owner, 'error');
  await owner.weekly();
  await settled(owner, 'completed');
  f.options.probe.mockImplementationOnce(
    (_url?: unknown, signal?: unknown) =>
      new Promise((_resolve, reject) =>
        (signal as AbortSignal).addEventListener('abort', () => reject(Error('cancelled'))),
      ),
  );
  await start(owner);
  await vi.waitFor(() => expect(f.options.probe).toHaveBeenCalledTimes(3));
  await owner.handle({ type: 'bookmarkCheck', action: 'pause' });
  const id = (await get(owner)).job?.id;
  await owner.weekly();
  expect((await get(owner)).job).toMatchObject({ id, status: 'paused' });
});
