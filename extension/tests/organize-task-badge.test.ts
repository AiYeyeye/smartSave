import { expect, it, vi } from 'vitest';
import { OrganizeTaskBadge } from '../background/organize-task-badge';
import type { OrganizeTaskView } from '../background/organize-task-owner';
import type { OrganizeCheckpoint } from '../domain/organize-checkpoint';
import type { BadgeStyle } from '../background/action-badge';

function view(revision = 1, status = 'running', stage = 'bookmarks', id = 'task'): OrganizeTaskView {
  return {
    id,
    revision,
    needsCredential: false,
    state: {
      tree: { status: 'loading' },
      scopeId: 'bar',
      selected: ['move:a'],
      targets: {},
      duplicates: [],
      choices: {},
      invalid: false,
      busy: status === 'running',
      message: '',
      pipeline: {
        stage,
        status,
        total: 10,
        analyzed: 3,
        completed: 0,
        batchSize: 1,
        batchCount: 10,
        folderCount: 2,
        finished: [],
        lockedActionIds: [],
      },
    },
  } as OrganizeTaskView;
}
function setup() {
  const organize = vi.fn<(style: BadgeStyle | undefined) => Promise<void>>(async () => {}),
    set = vi.fn(async () => {});
  const session = { get: vi.fn(async () => ({})), set };
  const badge = new OrganizeTaskBadge({ organize }, session);
  return { badge, organize, set, session };
}
it('uses accepted progress, only acknowledges the observed phase, and does not notify again for selection edits', () => {
  const h = setup();
  h.badge.focus(view());
  expect(h.organize).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: '30%', title: expect.stringContaining('3/10') }),
  );
  h.badge.seen('task', 1);
  expect(h.organize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '30%' }));
  h.badge.observe(view(4, 'review', 'complete'));
  h.badge.seen('task', 1);
  expect(h.organize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '审' }));
  h.badge.seen('task', 4);
  expect(h.organize).toHaveBeenLastCalledWith(undefined);
  h.badge.observe(view(5, 'review', 'complete'));
  expect(h.organize).toHaveBeenLastCalledWith(undefined);
  h.badge.observe(view(6, 'paused'));
  expect(h.organize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '停' }));
  h.badge.observe(view(3, 'review', 'complete'));
  h.badge.focus(view(3, 'running'));
  expect(h.organize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '停' }));
  h.badge.observe(view(99, 'review', 'complete', 'old'));
  expect(h.organize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '停' }));
  h.badge.observe({ ...view(7), submission: { requestId: 'request' } });
  expect(h.organize).toHaveBeenLastCalledWith(undefined);
});
it('restores interrupted metadata as paused without restoring the task or allowing late startup to replace a new focus', async () => {
  const h = setup();
  const record = {
    id: 'saved',
    revision: 8,
    stage: 'bookmarks',
    status: 'running',
    bookmarkIds: ['a', 'b'],
    batches: [
      { status: 'pending', itemIds: ['a'] },
      { status: 'accepted', itemIds: ['b'] },
    ],
    selection: { selected: [] },
    requiresCredential: true,
  } as unknown as OrganizeCheckpoint;
  const store = { list: vi.fn(async () => [{ id: 'saved', readable: true }] as never), get: vi.fn(async () => record) };
  await h.badge.restore(store);
  expect(h.organize).toHaveBeenLastCalledWith(
    expect.objectContaining({ text: '停', title: expect.stringContaining('1/2') }),
  );
  expect(h.organize.mock.calls.at(-1)![0]?.title).toContain('凭据');
  let resolve!: (value: OrganizeCheckpoint) => void;
  store.get.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const late = h.badge.restore(store);
  await vi.waitFor(() => expect(store.get).toHaveBeenCalledTimes(2));
  h.badge.focus(view(1, 'running', 'bookmarks', 'new'));
  resolve(record);
  await late;
  expect(h.organize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '30%' }));
});
it('preserves a seen terminal phase across worker replacement but not a newly interrupted running phase', async () => {
  const h = setup();
  h.session.get.mockResolvedValue({
    'organize.badge.v1': { id: 'task', phase: 'complete:review', eventRevision: 4, seen: true },
  } as never);
  const record = {
    id: 'task',
    revision: 7,
    stage: 'complete',
    status: 'review',
    bookmarkIds: [],
    batches: [],
    selection: { selected: [] },
    requiresCredential: false,
  } as unknown as OrganizeCheckpoint;
  await h.badge.restore({ list: async () => [{ id: 'task', readable: true }] as never, get: async () => record });
  expect(h.organize).toHaveBeenLastCalledWith(undefined);
  h.badge.observe(view(8, 'running'));
  h.badge.observe(view(9, 'review', 'complete'));
  expect(h.organize).toHaveBeenLastCalledWith(expect.objectContaining({ text: '审' }));
});
