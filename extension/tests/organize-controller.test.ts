import { expect, it, vi } from 'vitest';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import type { ModelAuthority } from '../adapters/model-authority';
import type { ModelTransport } from '../adapters/model-transport';
import { organizerTree } from './fixtures/organizer-tree';
import type { ModelProgress } from '../adapters/model-transport';
import type { AiPrivacy } from '../domain/ai-payload';
import type { OpenOrganizerLease } from '../panel/organizer-client';
import { organizeRejectionKey } from '../domain/organize-review';
function setup() {
  const tree = organizerTree();
  let state: OrganizeState;
  const listeners = new Set<() => void>();
  const context = {
    tree,
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    key: 'key',
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] } as AiPrivacy,
    config: { adapter: 'openai-compatible' as const, baseUrl: 'https://model.test/v1', model: 'test', timeoutMs: 1000 },
  };
  const authority: ModelAuthority = {
    read: async () => structuredClone(context),
    subscribe: cb => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const close = vi.fn();
  const setActive = vi.fn();
  const open = vi.fn<OpenOrganizerLease>(async () => ({ token: 'lease', close, setActive }));
  const send = vi.fn(async (r: { requestId: string }) => ({
    requestId: r.requestId,
    status: 'completed',
    needsReconcile: false,
    completedSteps: 1,
    remainingSteps: 0,
  }));
  const model = {
    run: vi.fn<ModelTransport['run']>(async () => ({
      status: 'completed' as const,
      output: {
        moves: [
          { itemId: 'a', folderId: 'right' },
          { itemId: 'b', folderId: 'right' },
        ],
        merges: [],
        newFolders: [],
      },
    })),
    cancel: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = new OrganizeController(
    s => {
      state = s;
    },
    authority,
    model,
    open,
    send,
  );
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.selectScope('bar');
  return {
    controller,
    authority,
    context,
    close,
    setActive,
    open,
    send,
    model,
    state: () => state!,
    invalidate: () => listeners.forEach(cb => cb()),
  };
}
it('defaults to the first writable native root and preserves an explicit scope across tree refreshes', () => {
  let state!: OrganizeState;
  const controller = new OrganizeController(value => {
    state = value;
  });
  const tree = organizerTree();
  tree.nodes.reverse(); // Browser child order, rather than flat projection order or localized title.
  controller.setTree({ status: 'ready', snapshot: tree });
  expect(state.scopeId).toBe('bar');
  controller.selectScope('right');
  controller.setTree({ status: 'ready', snapshot: tree });
  expect(state.scopeId).toBe('right');
  controller.selectScope('');
  controller.setTree({ status: 'ready', snapshot: tree });
  expect(state.scopeId).toBe('');
  controller.dispose();
});

it('scans suspected duplicates locally, requires explicit choices and invalidates a changed URL before deletion', async () => {
  const h = setup();
  h.context.tree.nodes.find(node => node.ref.nativeId === 'a')!.url = 'http://www.x.test/a/?utm_source=mail';
  h.context.tree.nodes.find(node => node.ref.nativeId === 'b')!.url = 'https://x.test/a';
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  h.controller.scan();
  expect(h.state().duplicates[0]?.suspected).toBe(true);
  expect(h.state().choices).toEqual({});
  h.controller.choice('a', 'keep');
  h.controller.choice('b', 'delete');
  await h.controller.previewDuplicates();
  expect(h.state().proposal?.actions.map(action => action.id)).toEqual(['delete:b']);
  expect(h.model.run).not.toHaveBeenCalled();
  expect(h.send).not.toHaveBeenCalled();
  h.context.tree.nodes.find(node => node.ref.nativeId === 'b')!.url += '?different=1';
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  await h.controller.apply();
  expect(h.state().invalid).toBe(true);
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('counts active analysis time and stops the clock during review and pauses', async () => {
  let now = 1000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const h = setup();
  let finish!: (value: Awaited<ReturnType<ModelTransport['run']>>) => void;
  h.model.run.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  try {
    const generating = h.controller.generate(undefined, { staged: true });
    await vi.waitFor(() => expect(h.state().pipeline?.stage).toBe('folders'));
    now = 5000;
    finish({ status: 'completed', output: { moves: [], newFolders: [], merges: [] } });
    await generating;
    expect(h.state().pipeline).toMatchObject({ elapsedMs: 4000, activeSince: undefined });
    now = 100_000;
    h.model.run.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const batches = h.controller.confirmFolders();
    await vi.waitFor(() => expect(h.state().pipeline?.status).toBe('running'));
    now = 103_000;
    h.controller.pauseBatches();
    await batches;
    expect(h.state().pipeline).toMatchObject({ status: 'paused', elapsedMs: 3000, activeSince: undefined });
    now = 200_000;
    expect(h.state().pipeline?.elapsedMs).toBe(3000);
  } finally {
    h.controller.dispose();
    clock.mockRestore();
  }
});
it('selects or cancels a target group in one update and ignores foreign action IDs', async () => {
  const h = setup();
  await h.controller.generate();
  expect(h.state().selected).toEqual(expect.arrayContaining(['move:a', 'move:b']));
  h.controller.toggleMany(['move:a', 'move:b', 'foreign'], false);
  expect(h.state().selected).toEqual([]);
  h.controller.toggleMany(['move:a', 'move:b', 'foreign'], true);
  expect(h.state().selected).toEqual(['move:a', 'move:b']);
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('classifies only direct unfiled bookmarks against the existing taxonomy without a folder request or cleanup', async () => {
  const h = setup();
  const tree = h.context.tree;
  tree.nodes.find(node => node.ref.nativeId === 'bar')!.childrenIds.push('direct');
  tree.nodes.push({
    ...structuredClone(tree.nodes.find(node => node.ref.nativeId === 'a')!),
    ref: { installationId: tree.installationId, nativeId: 'direct', kind: 'bookmark' },
    parentId: 'bar',
    title: 'unfiled',
  });
  h.controller.setTree({ status: 'ready', snapshot: tree });
  await h.controller.generate(undefined, { unfiledOnly: true, cleanupEmpty: true, allowRename: true });
  expect(h.model.run).not.toHaveBeenCalled();
  expect(h.state().pipeline).toMatchObject({ stage: 'folders', total: 1, status: 'review' });
  expect(h.state().proposal?.actions).toEqual([]);
  h.model.run.mockResolvedValueOnce({
    status: 'completed',
    output: {
      moves: [{ itemId: 'direct', folderId: 'right' }],
      newFolders: [],
      merges: [],
    },
  });
  await h.controller.confirmFolders();
  expect(h.model.run).toHaveBeenCalledTimes(1);
  expect(h.model.run.mock.calls[0]![0].request).toMatchObject({ stage: 'bookmarks', itemIds: ['direct'] });
  expect(h.state().proposal?.actions.map(action => action.id)).toEqual(['move:direct']);
  expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 1 });
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('retains actionable failure context, no partial proposal, and clears it on retry', async () => {
  const h = setup();
  h.model.run.mockResolvedValueOnce({ status: 'failed', reason: 'incomplete', detail: 'output-limit' });
  await h.controller.generate();
  expect(h.state().failure).toMatchObject({ code: 'output-limit', phase: '模型生成', bookmarkCount: 2 });
  expect(h.state().message).toContain('输出额度上限');
  expect(h.state().message).toContain('未修改书签');
  expect(h.state().proposal).toBeUndefined();
  expect(h.state().busy).toBe(false);
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
  await h.controller.generate();
  expect(h.state().failure).toBeUndefined();
  expect(h.state().proposal).toBeDefined();
  h.controller.dispose();
});
it('correlates generation with its lease and cancels a pending folder call on disconnect without a write', async () => {
  const h = setup();
  h.model.run.mockImplementationOnce(() => new Promise(() => {}));
  const pending = h.controller.generate(undefined, { staged: true });
  await vi.waitFor(() => expect(h.model.run).toHaveBeenCalledOnce());
  const [disconnect, runId] = h.open.mock.calls[0]!;
  const input = h.model.run.mock.calls[0]![0];
  expect(runId).toEqual(expect.any(String));
  expect(input.diagnosticRunId).toBe(runId);
  disconnect();
  await pending;
  expect(input.signal?.aborted).toBe(true);
  expect(h.state().message).toContain('整理连接已中断');
  expect(h.state().pipeline?.status).toBe('invalid');
  expect(h.state().busy).toBe(false);
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('labels local plan conflicts separately and never shows raw unknown exception text', async () => {
  const h = setup();
  const unsafe = {
    status: 'completed' as const,
    output: { newFolders: [], merges: [], moves: [], removeFolders: [{ folderId: 'left' }] },
  };
  // The one correction round repeats the same mistake, so the plan is still rejected.
  h.model.run.mockResolvedValueOnce(unsafe).mockResolvedValueOnce(unsafe);
  await h.controller.generate();
  expect(h.model.run).toHaveBeenCalledTimes(2);
  expect(h.state().failure).toMatchObject({ code: 'unsafe-folder-removal', phase: '方案校验' });
  expect(h.state().message).toContain('仍有内容');
  h.model.run.mockClear();
  h.model.run.mockRejectedValueOnce(Error('secret provider body'));
  await h.controller.generate();
  expect(h.model.run).toHaveBeenCalledTimes(1);
  expect(h.state().failure?.code).toBe('unknown-error');
  expect(h.state().message).not.toContain('secret');
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('selects prerequisites, cancels dependent cleanup and honors remembered refusal on the next generation', async () => {
  const h = setup();
  h.model.run.mockResolvedValue({
    status: 'completed',
    output: {
      newFolders: [{ id: 'new', parentId: 'bar', title: '工具' }],
      moves: [
        { itemId: 'a', folderId: 'new' },
        { itemId: 'b', folderId: 'new' },
      ],
      merges: [],
    },
  });
  await h.controller.generate(undefined, { cleanupEmpty: true });
  expect(h.state().selected).toContain('delete:left');
  h.controller.toggle('create:new', false);
  expect(h.state().selected).not.toContain('move:a');
  expect(h.state().selected).not.toContain('delete:left');
  h.controller.toggle('move:a', true);
  expect(h.state().selected).toContain('create:new');
  expect(h.state().selected).toContain('move:a');
  const p = h.state().proposal!;
  const signature = organizeRejectionKey(
    p,
    p.actions.find(a => a.id === 'move:a')!,
    {},
  );
  await h.controller.generate(undefined, { cleanupEmpty: true, rejectedSignatures: [signature] });
  expect(h.state().selected).not.toContain('move:a');
  expect(h.state().selected).not.toContain('delete:left');
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('excludes protected folders from model candidates without altering saved privacy and permits folder rename only for this run', async () => {
  const h = setup();
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: { moves: [], newFolders: [], merges: [] } });
  await h.controller.generate(undefined, { protectedFolderIds: ['left'], allowRename: true });
  const input = h.model.run.mock.calls[0]![0];
  expect(input.request).toMatchObject({ itemIds: ['right'], folderIds: ['bar', 'right'] });
  expect(input.privacy.excludedFolders).toEqual([]);
  expect(input.policy?.allowRename).toBe(true);
  h.controller.dispose();
});
it.each([
  [2, 180_000],
  [100, 180_000],
  [300, 180_000],
  [1000, 180_000],
])('uses a stream inactivity budget of %i bookmarks / %i ms independent of item count', async (count, budget) => {
  const h = setup();
  const tree = h.context.tree;
  const sample = tree.nodes.find(node => node.ref.nativeId === 'a')!;
  const parent = tree.nodes.find(node => node.ref.nativeId === 'right')!;
  for (let index = 0; index < count; index++) {
    const id = `extra-${index}`;
    tree.nodes.push({ ...sample, ref: { ...sample.ref, nativeId: id }, parentId: 'right', index });
    parent.childrenIds.push(id);
  }
  h.context.privacy.excludedFolders = [tree.nodes.find(node => node.ref.nativeId === 'left')!.ref];
  h.controller.setTree({ status: 'ready', snapshot: tree });
  h.model.run.mockImplementationOnce(() => new Promise(() => {}));
  const pending = h.controller.generate();
  await vi.waitFor(() => expect(h.model.run).toHaveBeenCalled());
  expect(h.model.run.mock.calls[0]![0].timeoutMs).toBe(budget);
  expect(h.state().progress).toMatchObject({ bookmarkCount: count, timeoutSeconds: budget / 1000 });
  expect(h.context.config.timeoutMs).toBe(1000);
  h.controller.cancel();
  await pending;
  h.controller.dispose();
});
it('keeps a completed proposal actionable beyond ten minutes without regenerating or writing early', async () => {
  vi.useFakeTimers();
  try {
    const h = setup();
    await h.controller.generate();
    expect(h.state().message).toContain('方案已生成');
    expect(h.setActive).toHaveBeenLastCalledWith(true);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(h.state().invalid).toBe(false);
    expect(h.close).not.toHaveBeenCalled();
    expect(h.state().message).not.toContain('10 分钟');
    expect(h.send).not.toHaveBeenCalled();
    h.controller.toggle('move:a', false);
    expect(h.state().selected).toEqual(['move:b']);
    await h.controller.apply();
    expect(h.send).toHaveBeenCalledOnce();
    expect(h.model.run).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    h.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it.each(['settings', 'tree', 'disconnect', 'dispose'] as const)(
  'still revokes long-reviewed proposals on %s without replay or automatic reconnection',
  async cause => {
    vi.useFakeTimers();
    try {
      const h = setup();
      await h.controller.generate();
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(h.state().invalid).toBe(false);
      if (cause === 'settings') h.invalidate();
      else if (cause === 'tree') {
        h.context.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'Changed';
        h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
      } else if (cause === 'disconnect') h.open.mock.calls[0]![0]();
      else h.controller.dispose();
      expect(h.state().invalid).toBe(true);
      await h.controller.apply();
      expect(h.send).not.toHaveBeenCalled();
      expect(h.open).toHaveBeenCalledOnce();
      expect(h.close).toHaveBeenCalledOnce();
      h.controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  },
);
it('releases review authority after confirmed apply and preserves its result', async () => {
  vi.useFakeTimers();
  try {
    const h = setup();
    await h.controller.generate();
    await h.controller.apply();
    const message = h.state().message;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.state().message).toBe(message);
    expect(h.send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    h.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});
it('honors a longer configured deadline and releases a completed empty proposal without keeping review alive', async () => {
  const h = setup();
  h.context.config.timeoutMs = 950_000;
  h.model.run.mockResolvedValueOnce({ status: 'completed', output: { moves: [], merges: [], newFolders: [] } });
  await h.controller.generate();
  expect(h.model.run.mock.calls[0]![0].timeoutMs).toBe(950_000);
  expect(h.state().message).toBe('分析已完成，没有需要应用的操作。');
  expect(h.state().invalid).toBe(false);
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.setActive).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('keeps streamed suggestions read-only, freezes custom intent, bounds waiting and ignores late updates', async () => {
  const h = setup();
  let progress!: (value: ModelProgress) => void;
  h.model.run.mockImplementationOnce(input => {
    progress = input.onProgress!;
    return new Promise(() => {});
  });
  const preference = { style: 'custom' as const, instructions: '分成写作、画图' };
  const pending = h.controller.generate(preference);
  preference.instructions = 'changed';
  await vi.waitFor(() => expect(h.model.run).toHaveBeenCalled());
  const input = h.model.run.mock.calls[0]![0];
  expect(input.timeoutMs).toBe(180000);
  expect(input.config.timeoutMs).toBe(1000);
  expect(input.request).toMatchObject({ preference: { instructions: '分成写作、画图' } });
  const update: ModelProgress = {
    phase: 'receiving',
    streaming: true,
    text: '{"moves":[{"itemId":"a","folderId":"right"}],',
    receivedChars: 50,
  };
  progress(update);
  expect(h.state().progress?.preview).toHaveLength(1);
  expect(h.state().proposal).toBeUndefined();
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
  h.controller.cancel();
  await pending;
  progress(update);
  expect(h.state().progress).toBeUndefined();
  expect(h.state().busy).toBe(false);
});
it('has no outer total timer but still cancels ongoing generation without writes', async () => {
  vi.useFakeTimers();
  try {
    const h = setup();
    h.model.run.mockImplementationOnce(input => {
      input.onProgress?.({
        phase: 'receiving',
        streaming: true,
        text: '{"moves":[{"itemId":"a","folderId":"right"}],',
        receivedChars: 50,
      });
      return new Promise(() => {});
    });
    const pending = h.controller.generate();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.state().busy).toBe(true);
    h.controller.cancel();
    await pending;
    expect(h.state().busy).toBe(false);
    expect(h.state().progress).toBeUndefined();
    expect(h.send).not.toHaveBeenCalled();
    h.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});
it('retains unchecked proposal but revokes authority on settings/tree change without reopening', async () => {
  const h = setup();
  await h.controller.generate();
  h.controller.toggle('move:a', false);
  const frozen = h.state().proposal;
  h.context.revision = 'two';
  h.invalidate();
  expect(h.state().selected).toEqual(['move:b']);
  expect(h.state().proposal).toEqual(frozen);
  expect(h.state().invalid).toBe(true);
  expect(h.close).toHaveBeenCalledTimes(1);
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
  expect(h.open).toHaveBeenCalledTimes(1);
});

it('cancels a hanging settings read immediately and late work cannot overwrite a newer run', async () => {
  const h = setup();
  let resolveRead!: (value: typeof h.context) => void;
  vi.spyOn(h.authority, 'read').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        resolveRead = resolve;
      }),
  );
  const first = h.controller.generate();
  await vi.waitFor(() => expect(resolveRead).toBeDefined());
  expect(h.state().busy).toBe(true);
  h.controller.cancel();
  expect(h.state().busy).toBe(false);
  await first;
  await h.controller.generate();
  const proposal = h.state().proposal;
  resolveRead(h.context);
  await Promise.resolve();
  expect(h.state().proposal).toBe(proposal);
  expect(h.state().invalid).toBe(false);
  h.controller.dispose();
});

it('bounds a never-returning preparation and exposes a useful timeout', async () => {
  vi.useFakeTimers();
  try {
    const h = setup();
    vi.spyOn(h.authority, 'read').mockImplementation(() => new Promise(() => {}));
    const run = h.controller.generate();
    await vi.advanceTimersByTimeAsync(10_000);
    await run;
    expect(h.state().busy).toBe(false);
    expect(h.state().message).toContain('读取设置超时');
    expect(h.model.run).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalled();
    h.controller.dispose();
  } finally {
    vi.useRealTimers();
  }
});

it('closes a lease that arrives after cancellation', async () => {
  const h = setup();
  let release!: (lease: { token: string; close: typeof h.close }) => void;
  h.open.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        release = resolve;
      }),
  );
  const run = h.controller.generate();
  h.controller.cancel();
  await run;
  release({ token: 'late', close: h.close });
  await Promise.resolve();
  expect(h.state().busy).toBe(false);
  expect(h.close).toHaveBeenCalledOnce();
  expect(h.model.run).not.toHaveBeenCalled();
  h.controller.dispose();
});

it('shows response size failures instead of an unrelated initial instruction', async () => {
  const h = setup();
  h.model.run.mockImplementationOnce(async () => ({ status: 'failed', reason: 'response-too-large' }));
  await h.controller.generate();
  expect(h.state().message).toContain('返回的数据超过处理限额');
  expect(h.state().busy).toBe(false);
  expect(h.send).not.toHaveBeenCalled();
  h.controller.dispose();
});
it('only explicit generation calls model, applies selected batch once, never replays', async () => {
  const h = setup();
  expect(h.model.run).not.toHaveBeenCalled();
  await h.controller.generate();
  h.controller.toggle('move:a', false);
  await h.controller.apply();
  await h.controller.apply();
  expect(h.send).toHaveBeenCalledTimes(1);
  expect(h.state().result?.status).toBe('completed');
});
it('scope change retains invalid proposal rather than silently retargeting', async () => {
  const h = setup();
  await h.controller.generate();
  h.controller.selectScope('outside');
  expect(h.state().proposal?.scope.nativeId).toBe('bar');
  expect(h.state().invalid).toBe(true);
  expect(h.close).toHaveBeenCalled();
});
it('keeps frozen snapshot identities stable on selection-only updates', async () => {
  const h = setup();
  await h.controller.generate();
  const proposal = h.state().proposal;
  const tree = h.state().tree;
  h.controller.toggle('move:a', false);
  expect(h.state().proposal).toBe(proposal);
  expect(h.state().tree).toBe(tree);
});
it('duplicate edits revoke frozen authorization and failed re-preview cannot leave applicable UI', async () => {
  const h = setup();
  h.controller.scan();
  h.controller.choice('a', 'keep');
  h.controller.choice('b', 'delete');
  await h.controller.previewDuplicates();
  expect(h.state().proposal?.actions).toHaveLength(1);
  h.controller.choice('a', 'delete');
  expect(h.state().proposal).toBeUndefined();
  await h.controller.previewDuplicates();
  expect(h.state().proposal).toBeUndefined();
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
  expect(h.state().message).toContain('明确保留');
});
it('retains a generated proposal across changes outside the scope and revokes it on changes inside', async () => {
  const h = setup();
  await h.controller.generate();
  const proposal = h.state().proposal;
  expect(proposal).toBeDefined();
  const cancels = h.model.cancel.mock.calls.length;
  const outside = organizerTree();
  outside.observedRevision = 7;
  outside.epoch = 'restarted';
  outside.nodes.find(n => n.ref.nativeId === 'outside')!.title = 'renamed outside';
  outside.nodes.push({ ...outside.nodes[7]!, ref: { ...outside.nodes[7]!.ref, nativeId: 'd' }, title: 'd' });
  outside.nodes.find(n => n.ref.nativeId === 'outside')!.childrenIds.push('d');
  h.controller.setTree({ status: 'ready', snapshot: outside });
  h.controller.setTree({ status: 'loading' });
  h.controller.setTree({ status: 'ready', snapshot: outside });
  expect(h.state().invalid).toBe(false);
  expect(h.state().proposal).toEqual(proposal);
  expect(h.close).not.toHaveBeenCalled();
  expect(h.model.cancel).toHaveBeenCalledTimes(cancels);
  const inside = organizerTree();
  inside.nodes.find(n => n.ref.nativeId === 'left')!.title = 'renamed left';
  h.controller.setTree({ status: 'ready', snapshot: inside });
  expect(h.state().invalid).toBe(true);
  expect(h.state().proposal).toEqual(proposal);
  expect(h.close).toHaveBeenCalledTimes(1);
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
});
it('a local scan baseline follows the same scope rule for duplicate previews', async () => {
  const h = setup();
  h.controller.scan();
  expect(h.state().duplicates).toHaveLength(1);
  const outside = organizerTree();
  outside.nodes.find(n => n.ref.nativeId === 'c')!.title = 'renamed outside bookmark';
  h.controller.setTree({ status: 'ready', snapshot: outside });
  expect(h.state().invalid).toBe(false);
  h.controller.choice('a', 'keep');
  h.controller.choice('b', 'delete');
  await h.controller.previewDuplicates();
  expect(h.state().proposal?.actions.map(a => a.id)).toEqual(['delete:b']);
  const inside = organizerTree();
  inside.nodes = inside.nodes.filter(n => n.ref.nativeId !== 'b');
  inside.nodes.find(n => n.ref.nativeId === 'left')!.childrenIds = ['a'];
  h.controller.setTree({ status: 'ready', snapshot: inside });
  expect(h.state().invalid).toBe(true);
  await h.controller.apply();
  expect(h.send).not.toHaveBeenCalled();
});

it('sends a locally rejected plan back once with the reason and accepts the corrected answer', async () => {
  const h = setup();
  h.model.run
    .mockResolvedValueOnce({
      status: 'completed',
      output: { newFolders: [], merges: [], moves: [], removeFolders: [{ folderId: 'left' }] },
    })
    .mockResolvedValueOnce({
      status: 'completed',
      output: { newFolders: [], merges: [], moves: [{ itemId: 'a', folderId: 'right' }] },
    });
  await h.controller.generate();
  expect(h.model.run).toHaveBeenCalledTimes(2);
  expect(h.model.run.mock.calls[0]![0].policy?.retryFeedback).toBeUndefined();
  expect(h.model.run.mock.calls[1]![0].policy?.retryFeedback).toContain('removeFolders');
  expect(h.state().failure).toBeUndefined();
  expect(h.state().proposal?.actions).toEqual([expect.objectContaining({ kind: 'move', sourceId: 'a' })]);
  h.controller.dispose();
});

it('says which folder changed when a staged plan is voided during generation', async () => {
  const h = setup();
  h.model.run.mockImplementationOnce(async () => {
    // The user renames a folder in the scope while the model is still thinking.
    h.context.tree.nodes.find(n => n.ref.nativeId === 'right')!.title = '学习';
    return { status: 'failed', reason: 'stale-context' };
  });
  await h.controller.generate(undefined, { staged: true, batchSize: 100, cleanupEmpty: false });
  expect(h.state().failure?.code).toBe('stale-context');
  expect(h.state().message).toContain('目录「right」被改名为「学习」');
  expect(h.state().message).toContain('请重新生成方案');
  h.controller.dispose();
});
