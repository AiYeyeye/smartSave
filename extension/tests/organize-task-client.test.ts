import { afterEach, expect, it, vi } from 'vitest';
import type { OrganizeState } from '../domain/organize-state';
import type { ModelResult } from '../adapters/model-transport';
import { organizeClientRuntime } from './fixtures/organize-client-runtime';

afterEach(() => vi.unstubAllGlobals());
const folders = { status: 'completed' as const, output: { moves: [], newFolders: [], merges: [] } };
function observer(h: ReturnType<typeof organizeClientRuntime>) {
  let state!: OrganizeState;
  const client = h.client(value => {
    state = value;
  });
  return { client, state: () => state };
}
async function review(h: ReturnType<typeof organizeClientRuntime>, page: ReturnType<typeof observer>) {
  h.run.mockResolvedValueOnce(folders).mockImplementation(async input => ({
    status: 'completed',
    output: {
      newFolders: [],
      merges: [],
      moves: 'itemIds' in input.request ? input.request.itemIds.map(itemId => ({ itemId, folderId: 'right' })) : [],
    },
  }));
  await page.client.generate(undefined, { batchSize: 1, staged: true, cleanupEmpty: false });
  await vi.waitFor(() => expect(page.state().pipeline).toMatchObject({ stage: 'folders', status: 'review' }));
  await vi.waitFor(() => expect(page.state().busy).toBe(false));
  await page.client.confirmFolders();
  await vi.waitFor(() => expect(page.state().pipeline).toMatchObject({ stage: 'complete', status: 'review' }));
  await vi.waitFor(() => expect(page.state().busy).toBe(false));
}

it.each([false, true])(
  'keeps repair consent explicit across page reopen; worker restart=%s discards unaccepted fragments',
  async restart => {
    const h = organizeClientRuntime(),
      first = observer(h);
    h.run.mockResolvedValueOnce(folders).mockResolvedValueOnce({
      status: 'repairable',
      reason: 'partial-invalid-targets',
      repair: {
        retained: { newFolders: [], merges: [], moves: [{ itemId: 'a', folderId: 'right', reason: 'kept-row' }] },
        itemIds: ['b'],
      },
    });
    await first.client.generate(undefined, { staged: true, batchSize: 100, cleanupEmpty: false });
    await vi.waitFor(() => expect(first.state().busy).toBe(false));
    await first.client.confirmFolders();
    await vi.waitFor(() => expect(first.state().repair).toEqual({ count: 1, retained: 1 }));
    await vi.waitFor(() => expect(first.state().busy).toBe(false));
    const id = first.state().task!.id!;
    const saved = (await h.journal.organizeCheckpoints.get(id))!;
    expect(saved.batches[0]).toMatchObject({ status: 'pending', itemIds: ['a', 'b'] });
    expect(JSON.stringify(saved)).not.toContain('kept-row');
    first.client.dispose();
    if (restart) h.restart();
    const next = observer(h);
    await vi.waitFor(() => expect(next.state().task?.id).toBe(id));
    expect(h.run).toHaveBeenCalledTimes(2);
    h.run.mockResolvedValue({ status: 'completed', output: { newFolders: [], merges: [], moves: [] } });
    if (restart) {
      expect(next.state().repair).toBeUndefined();
      await next.client.repairBatches();
      expect(h.run).toHaveBeenCalledTimes(2);
      await next.client.resumeBatches();
    } else {
      expect(next.state().repair).toEqual({ count: 1, retained: 1 });
      await next.client.repairBatches();
    }
    await vi.waitFor(() => expect(next.state().pipeline?.stage).toBe('complete'));
    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.run.mock.calls.at(-1)![0].request).toMatchObject({ itemIds: restart ? ['a', 'b'] : ['b'] });
    expect(h.move).not.toHaveBeenCalled();
    next.client.dispose();
    h.dispose();
  },
);

it('continues with no page observer, restores the same task without model traffic and persists serialized edits', async () => {
  const h = organizeClientRuntime(),
    first = observer(h);
  let finish!: (result: ModelResult) => void;
  h.run.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await first.client.generate(undefined, { staged: true, batchSize: 1, cleanupEmpty: false });
  const id = first.state().task!.id!;
  await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
  first.client.dispose();
  expect(h.log.filter(message => message.action === 'cancel' || message.action === 'pause')).toEqual([]);
  finish(folders);
  await vi.waitFor(async () => expect((await h.owner().get(id)).state.busy).toBe(false));
  const next = observer(h);
  await vi.waitFor(() => expect(next.state().task?.id).toBe(id));
  expect(h.run).toHaveBeenCalledTimes(1);
  h.run.mockImplementation(async input => ({
    status: 'completed',
    output: {
      newFolders: [],
      merges: [],
      moves: 'itemIds' in input.request ? input.request.itemIds.map(itemId => ({ itemId, folderId: 'right' })) : [],
    },
  }));
  await next.client.confirmFolders();
  await vi.waitFor(() => expect(next.state().pipeline?.stage).toBe('complete'));
  await vi.waitFor(() => expect(next.state().busy).toBe(false));
  await Promise.all([next.client.toggle('move:a', false), next.client.target('move:b', 'bar')]);
  const checkpoint = (await h.journal.organizeCheckpoints.get(id))!;
  expect(checkpoint.selection).toEqual({ selected: ['move:b'], targets: { 'move:b': 'bar' } });
  expect(JSON.stringify(checkpoint)).not.toContain('dummy-page-memory-key');
  expect(h.move).not.toHaveBeenCalled();
  next.client.dispose();
  h.dispose();
});

it('restores an interrupted worker without credentials or automatic calls and only explicitly resumes missing work', async () => {
  const h = organizeClientRuntime(),
    first = observer(h);
  const finish = new Map<string, (result: ModelResult) => void>();
  h.run.mockImplementation(input =>
    input.request.task === 'organize' && input.request.stage === 'folders'
      ? Promise.resolve(folders)
      : new Promise(resolve => {
          if ('itemIds' in input.request) finish.set(input.request.itemIds[0]!, resolve);
        }),
  );
  await first.client.generate(undefined, { staged: true, batchSize: 1, cleanupEmpty: false });
  await vi.waitFor(() => expect(first.state().busy).toBe(false));
  await first.client.confirmFolders();
  await vi.waitFor(() => expect(finish.size).toBe(2));
  const id = first.state().task!.id!;
  finish.get('b')!({
    status: 'completed',
    output: { newFolders: [], merges: [], moves: [{ itemId: 'b', folderId: 'right' }] },
  });
  await vi.waitFor(async () =>
    expect((await h.journal.organizeCheckpoints.get(id))?.batches[1]?.status).toBe('accepted'),
  );
  first.client.dispose();
  h.restart();
  h.forgetKey();
  const next = observer(h);
  await vi.waitFor(() => expect(next.state().pipeline?.status).toBe('paused'));
  expect(next.state().task?.needsCredential).toBe(true);
  expect(h.run).toHaveBeenCalledTimes(3);
  await next.client.resumeBatches();
  expect(h.run).toHaveBeenCalledTimes(3);
  expect(next.state().message).toContain('API Key');
  h.restoreKey();
  h.run.mockResolvedValue({
    status: 'completed',
    output: { newFolders: [], merges: [], moves: [{ itemId: 'a', folderId: 'right' }] },
  });
  await next.client.resumeBatches();
  await vi.waitFor(() => expect(next.state().pipeline?.stage).toBe('complete'));
  expect(h.run).toHaveBeenCalledTimes(4);
  expect(h.run.mock.calls.at(-1)![0]).toMatchObject({ key: 'renewed-dummy-key', request: { itemIds: ['a'] } });
  next.client.dispose();
  h.dispose();
});

it('confirms exactly one worker-compiled proposal and reopens a submitted task by status without registering or replaying', async () => {
  const h = organizeClientRuntime(),
    page = observer(h);
  await review(h, page);
  await page.client.toggle('move:b', false);
  await page.client.apply();
  expect(page.state().result).toMatchObject({ status: 'completed' });
  expect(h.move).toHaveBeenCalledTimes(1);
  const id = page.state().task!.id!,
    requestId = page.state().task!.requestId!;
  expect((await h.journal.organizeCheckpoints.get(id))?.submission?.requestId).toBe(requestId);
  expect(h.log.filter(message => message.type === 'registerMutationPreview')).toEqual([]);
  expect(h.log.filter(message => message.type === 'registerOrganizeTaskPreview')).toHaveLength(1);
  expect(h.log.filter(message => message.type === 'confirmMutation')).toHaveLength(1);
  page.client.dispose();
  const next = observer(h);
  await vi.waitFor(() => expect(next.state().result?.status).toBe('completed'));
  expect(next.state().task?.requestId).toBe(requestId);
  await next.client.observe(true);
  expect(h.move).toHaveBeenCalledTimes(1);
  expect(h.log.filter(message => message.type === 'confirmMutation')).toHaveLength(1);
  next.client.dispose();
  h.dispose();
});

it('does not report a rejection as saved when the deselection CAS fails', async () => {
  const h = organizeClientRuntime(),
    page = observer(h);
  await review(h, page);
  const put = vi
    .spyOn(h.journal.organizeCheckpoints, 'put')
    .mockRejectedValue(Error('organize-checkpoint-unavailable'));
  expect(await page.client.deselectForMemory('move:a')).toBe(false);
  put.mockRestore();
  expect((await h.journal.organizeCheckpoints.get(page.state().task!.id!))?.selection.selected).toContain('move:a');
  expect(h.move).not.toHaveBeenCalled();
  page.client.dispose();
  h.dispose();
});

it('retains an unconfirmed request ID across rereads and never turns request-not-found into a new submission', async () => {
  const h = organizeClientRuntime(),
    page = observer(h);
  await review(h, page);
  const runtime = chrome.runtime as unknown as {
    sendMessage(input: Record<string, unknown>, reply: (value: unknown) => void): void;
    lastError?: { message: string };
  };
  const send = runtime.sendMessage.bind(runtime);
  let attempts = 0;
  const replaced = vi.spyOn(runtime, 'sendMessage').mockImplementation((input, reply) => {
    if (input.type !== 'confirmMutation') {
      send(input, reply);
      return;
    }
    attempts++;
    runtime.lastError = { message: 'port closed' };
    reply(undefined);
    runtime.lastError = undefined;
  });
  await page.client.apply();
  const id = page.state().task!.id!,
    requestId = page.state().task!.requestId!;
  expect(page.state().result).toMatchObject({ requestId, status: 'unknown', needsReconcile: true });
  expect((await h.journal.organizeCheckpoints.get(id))?.submission).toBeUndefined();
  await page.client.restoreTask(id);
  expect(page.state().task?.requestId).toBe(requestId);
  expect(page.state().result).toMatchObject({ status: 'unknown', needsReconcile: true });
  await page.client.apply();
  expect(attempts).toBe(1);
  expect(h.move).not.toHaveBeenCalled();
  replaced.mockRestore();
  page.client.dispose();
  h.dispose();
});
