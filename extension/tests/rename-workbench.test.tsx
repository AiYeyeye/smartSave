import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RenameWorkbench } from '../panel/RenameWorkbench';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';
import { organizerTree } from './fixtures/organizer-tree';
import type { SettingsStore } from '../persistence/settings';

const mock = vi.hoisted(() => ({
  read: vi.fn(), run: vi.fn(), open: vi.fn(), submit: vi.fn(), tree: vi.fn(),
  cancel: vi.fn(), dispose: vi.fn(),
}));
vi.mock('../adapters/feature-model-settings', () => ({ featureModelSettings: () => ({}) }));
vi.mock('../adapters/model-authority', () => ({ browserModelAuthority: () => ({ read: mock.read }) }));
vi.mock('../adapters/model-transport', () => ({
  ModelTransport: class {
    fits = () => true;
    run = mock.run;
    cancel = mock.cancel;
    dispose = mock.dispose;
  },
}));
vi.mock('../panel/tree-client', () => ({ connectTree: (...args: unknown[]) => mock.tree(...args) }));
vi.mock('../panel/organizer-client', () => ({ openOrganizerLease: (...args: unknown[]) => mock.open(...args) }));
vi.mock('../panel/mutation-client', () => ({ submitMutation: (...args: unknown[]) => mock.submit(...args) }));
vi.mock('../panel/BookmarkActions', () => ({ MutationFeedback: () => <p>Applied</p> }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal('chrome', { runtime: { connect: vi.fn() }, permissions: { contains: async () => true } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(keep = false, total = 2) {
  const tree = organizerTree();
  for (let i = 2; i < total; i++) {
    tree.nodes.push({ ...structuredClone(tree.nodes.find(node => node.ref.nativeId === 'a')!),
      ref: { installationId: 'install', nativeId: 'extra-' + i, kind: 'bookmark' },
      title: 'Original ' + i, index: i });
    tree.nodes.find(node => node.ref.nativeId === 'left')!.childrenIds.push('extra-' + i);
  }
  const context = {
    version: 1, revision: 'settings', sessionRevision: 0, key: '', tree,
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    config: { adapter: 'openai-compatible', baseUrl: 'https://model.test', model: 'synthetic', timeoutMs: 1000, streaming: false },
  };
  mock.read.mockImplementation(async () => structuredClone(context));
  mock.tree.mockImplementation((_runtime, callback) => {
    callback({ status: 'ready', snapshot: tree });
    return () => {};
  });
  mock.run.mockImplementation(async ({ request }: { request: { itemIds: string[] } }) => ({
    status: 'completed', output: { suggestions: request.itemIds.map(itemId => ({
      itemId, title: keep ? tree.nodes.find(node => node.ref.nativeId === itemId)!.title : 'Suggested ' + itemId,
      decision: keep ? 'keep' : 'rename', reason: 'Synthetic evidence',
    })) },
  }));
  let invalidate = () => {};
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const lease = {
    token: 'synthetic-lease',
    close: vi.fn(() => { clearTimeout(expiry); }),
    setActive: vi.fn((active: boolean) => {
      clearTimeout(expiry);
      if (!active) expiry = setTimeout(() => invalidate(), 30000);
    }),
  };
  mock.open.mockImplementation(async (onInvalidated: () => void) => {
    invalidate = onInvalidated;
    lease.setActive(true);
    return lease;
  });
  mock.submit.mockResolvedValue({ status: 'completed' });
  const view = render(<LocaleProvider><LanguagePicker /><RenameWorkbench settings={{} as SettingsStore} /></LocaleProvider>);
  fireEvent.change(screen.getByLabelText('选择目录'), { target: { value: 'left' } });
  return { lease, context, invalidate: () => invalidate(), view };
}
async function generate() {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '生成名称建议' })); });
}

it('keeps generated suggestions actionable through idle review and a language change, then submits only after confirmation', async () => {
  const h = setup();
  await generate();
  expect(screen.getByText('名称建议已生成，请核对后确认。')).toBeVisible();
  expect(h.lease.setActive).toHaveBeenLastCalledWith(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000); });
  fireEvent.change(screen.getAllByLabelText('建议名称')[0]!, { target: { value: 'My edited title' } });
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getAllByLabelText('Suggested name')[0]).toHaveValue('My edited title');
  fireEvent.click(screen.getByRole('button', { name: 'Review renaming' }));
  expect(mock.submit).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm renaming' })); });
  expect(mock.submit).toHaveBeenCalledOnce();
  expect(mock.submit.mock.calls[0]![0]).toMatchObject({
    organizerContext: 'synthetic-lease',
    command: { operations: [expect.objectContaining({ command: { type: 'update', target: expect.any(Object), changes: { title: 'My edited title' } } }), expect.any(Object)] },
  });
  expect(h.lease.close).toHaveBeenCalled();
});

it('retains partial suggestions and their session when stopping a later batch', async () => {
  const h = setup(false, 101);
  const first = mock.run.getMockImplementation()!;
  mock.run.mockImplementationOnce(first).mockImplementationOnce(() => new Promise(() => {}));
  await generate();
  expect(screen.getAllByLabelText('建议名称')).toHaveLength(100);
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.getByRole('button', { name: '预览改名确认' })).toBeEnabled();
  expect(h.lease.setActive).toHaveBeenLastCalledWith(true);
  expect(mock.submit).not.toHaveBeenCalled();
});

it('rejects a real disconnection without reacquiring authorization or submitting', async () => {
  const h = setup();
  await generate();
  act(() => h.invalidate());
  expect(screen.getByRole('button', { name: '预览改名确认' })).toBeDisabled();
  expect(screen.getByRole('alert')).toBeVisible();
  expect(mock.open).toHaveBeenCalledOnce();
  expect(mock.submit).not.toHaveBeenCalled();
});

it('rejects changed bookmark evidence at final confirmation', async () => {
  const h = setup();
  await generate();
  h.context.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'Changed outside';
  fireEvent.click(screen.getByRole('button', { name: '预览改名确认' }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认改名' })); });
  expect(mock.submit).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toBeVisible();
  expect(h.lease.close).toHaveBeenCalled();
});

it('explains unchanged names and lets an explicit edit proceed from the review controls above the list', async () => {
  setup(true);
  await generate();
  const review = screen.getByRole('button', { name: '预览改名确认' });
  expect(review).toBeDisabled();
  expect(screen.getByText('当前没有需要应用的改名。可以编辑建议名称并勾选条目，再预览确认。')).toBeVisible();
  const input = screen.getAllByLabelText('建议名称')[0]!;
  expect(review.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.change(input, { target: { value: 'Explicitly edited title' } });
  expect(review).toBeEnabled();
});
