import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { openUrl } from '../domain/open-url';
import { prepareMutation, prepareMove } from '../panel/TreeDragController';
import { BookmarkActions } from '../panel/BookmarkActions';
import type { TreeSnapshot } from '../domain/node-reference';
import { APPEARANCES } from './appearance';
export const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 0,
  roots: ['r'],
  nodes: [
    {
      ref: { installationId: 'i', nativeId: 'r', kind: 'folder' },
      title: 'Root',
      index: 0,
      childrenIds: ['f', 'g'],
      readOnly: true,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'f', kind: 'folder' },
      title: 'Folder',
      parentId: 'r',
      index: 0,
      childrenIds: ['b'],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'g', kind: 'folder' },
      title: 'Other',
      parentId: 'r',
      index: 1,
      childrenIds: [],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 0,
    },
    {
      ref: { installationId: 'i', nativeId: 'b', kind: 'bookmark' },
      title: 'Book',
      url: 'https://example.test/',
      parentId: 'f',
      index: 0,
      childrenIds: [],
      readOnly: false,
      observedRevision: 0,
    },
  ],
};
it('uses one open policy without repairing URLs or executing unsupported schemes', () => {
  const open = vi.fn();
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///x', ' https://a.test', 'https:\n//a.test'])
    expect(openUrl(url, open)).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect(openUrl('https://example.test/', open)).toBe(true);
  expect(open).toHaveBeenCalledWith('https://example.test/', '_blank', 'noopener,noreferrer');
});
it('prepares bounded subtree deletion and rejects cyclic, missing and protected drag targets', () => {
  const request = prepareMutation(tree, { type: 'deleteSubtree', target: tree.nodes[1]!.ref });
  expect(request.command.type).toBe('deleteSubtree');
  expect(request.before).toEqual(tree.nodes);
  expect(() => prepareMove(tree, 'f', 'f', 0)).toThrow();
  expect(() => prepareMove(tree, 'b', 'missing', 0)).toThrow();
  expect(() => prepareMove(tree, 'r', 'g', 0)).toThrow();
  expect(prepareMove(tree, 'b', 'g', 0).command).toMatchObject({ type: 'move', index: 0 });
});
it('cancelled destructive confirmation sends nothing; confirmed deletion sends one composite', async () => {
  const send = vi.fn(async request => ({
    requestId: request.requestId,
    status: 'partial',
    needsReconcile: false,
    completedSteps: 1,
    remainingSteps: 1,
  }));
  const user = userEvent.setup();
  render(createElement(BookmarkActions, { snapshot: tree, selectedId: 'f', send }));
  await user.click(screen.getByRole('button', { name: '删除' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('1 个子项');
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '删除' }));
  await user.click(screen.getByRole('button', { name: '确认删除' }));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0].command.type).toBe('deleteSubtree');
  expect(await screen.findByText(/部分完成/)).toHaveTextContent('已完成 1');
});
it('retains frozen draft when target disappears and never chooses another folder', async () => {
  const send = vi.fn();
  const user = userEvent.setup();
  const view = render(createElement(BookmarkActions, { snapshot: tree, selectedId: 'f', send }));
  await user.click(screen.getByRole('button', { name: '新建书签' }));
  await user.type(screen.getByRole('textbox', { name: '标题' }), 'Draft');
  view.rerender(
    createElement(BookmarkActions, {
      snapshot: { ...tree, nodes: tree.nodes.filter(n => n.ref.nativeId !== 'f') },
      selectedId: 'f',
      send,
    }),
  );
  expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Draft');
  expect(screen.getByRole('button', { name: '确认保存' })).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

it('creates a new folder plus bookmark through one message and keeps draft across four themes', async () => {
  const { ThemeProvider, ThemePicker } = await import('../ui/ThemeProvider');
  const send = vi.fn(async request => ({
    requestId: request.requestId,
    status: 'completed',
    needsReconcile: false,
    completedSteps: 2,
    remainingSteps: 0,
  }));
  const user = userEvent.setup();
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(ThemePicker),
      createElement(BookmarkActions, { snapshot: tree, selectedId: 'f', send }),
    ),
  );
  await user.click(screen.getByRole('button', { name: '新建书签' }));
  await user.type(screen.getByRole('textbox', { name: '标题' }), 'New');
  await user.type(screen.getByRole('textbox', { name: '网址' }), 'https://new.test/');
  await user.click(screen.getByRole('checkbox'));
  await user.type(screen.getByRole('textbox', { name: '新目录名称' }), 'New folder');
  for (const name of APPEARANCES) {
    await user.click(screen.getByRole('radio', { name }));
    expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('New');
  }
  expect(send).not.toHaveBeenCalled();
  screen.getByRole('button', { name: '确认保存' }).focus();
  await user.keyboard('{Enter}');
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0].command).toEqual({
    type: 'createFolderAndBookmark',
    parent: tree.nodes[1]!.ref,
    title: 'New',
    url: 'https://new.test/',
    folderTitle: 'New folder',
  });
});
it('keeps historical URL out of title-only edits and reports lost response as unknown', async () => {
  const historical = structuredClone(tree);
  historical.nodes[3]!.url = 'javascript:alert(1)';
  const send = vi.fn(async (request: import('../schemas/messages').ConfirmMutation) => {
    expect(request.type).toBe('confirmMutation');
    throw Error('connection lost');
  });
  const user = userEvent.setup();
  render(createElement(BookmarkActions, { snapshot: historical, selectedId: 'b', send }));
  await user.click(screen.getByRole('button', { name: '编辑 / 重命名' }));
  await user.type(screen.getByRole('textbox', { name: '标题' }), ' renamed');
  await user.click(screen.getByRole('button', { name: '确认保存' }));
  expect(send).toHaveBeenCalledTimes(1);
  const request = send.mock.calls[0];
  expect(request?.[0].command).toEqual({
    type: 'update',
    target: historical.nodes[3]!.ref,
    changes: { title: 'Book renamed' },
  });
  expect(await screen.findByText(/结果未知/)).toBeVisible();
});
it('validates response shape and request correlation; no transport fallback or replay', async () => {
  const { submitMutation } = await import('../panel/mutation-client');
  const request = prepareMove(tree, 'b', 'g', 0);
  for (const response of [
    undefined,
    { status: 'completed' },
    { requestId: 'other', status: 'completed', needsReconcile: false, completedSteps: 1, remainingSteps: 0 },
  ]) {
    const send = vi.fn(async () => response);
    expect(await submitMutation(request, send)).toMatchObject({ status: 'unknown', needsReconcile: true });
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it('traps destructive dialog keyboard focus and Escape cancels without writing', async () => {
  const send = vi.fn();
  const user = userEvent.setup();
  render(createElement(BookmarkActions, { snapshot: tree, selectedId: 'f', send }));
  await user.click(screen.getByRole('button', { name: '删除' }));
  expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByRole('button', { name: '确认删除' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: '取消' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '删除' })).toHaveFocus();
});
it('prepared UI deletion consumes real durable owner and preserves late children', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { OperationsStore } = await import('../persistence/operations');
  const { MutationCoordinator } = await import('../background/mutation-coordinator');
  const { submitMutation } = await import('../panel/mutation-client');
  const current = structuredClone(tree);
  const remove = vi.fn(async (id: string) => {
    expect(id).toBe('b');
    current.nodes = current.nodes.filter(n => n.ref.nativeId !== id);
    current.nodes[1]!.childrenIds = ['late'];
    current.nodes.push({ ...tree.nodes[3]!, ref: { ...tree.nodes[3]!.ref, nativeId: 'late' }, title: 'Late' });
  });
  const unused = async (): Promise<never> => {
    throw Error('unexpected native method');
  };
  const store = new OperationsStore(new IDBFactory());
  const writer = { remove, create: unused, update: unused, move: unused };
  const projection = { fresh: async () => structuredClone(current) };
  const coordinator = new MutationCoordinator(projection, writer, store, 'test');
  const request = prepareMutation(tree, { type: 'deleteSubtree', target: tree.nodes[1]!.ref });
  const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
  const result = await submitMutation(request, r => coordinator.submit(r, sender));
  expect(result.status).toBe('unknown');
  expect(remove).toHaveBeenCalledTimes(1);
  expect(current.nodes.some(n => n.ref.nativeId === 'late')).toBe(true);
  const restarted = new MutationCoordinator(projection, writer, store, 'test');
  await submitMutation(request, r => restarted.submit(r, sender));
  expect(remove).toHaveBeenCalledTimes(1);
});
it('keyboard move requires explicit destination and submits one scoped move', async () => {
  const send = vi.fn(async request => ({
    requestId: request.requestId,
    status: 'completed',
    needsReconcile: false,
    completedSteps: 1,
    remainingSteps: 0,
  }));
  const user = userEvent.setup();
  render(createElement(BookmarkActions, { snapshot: tree, selectedId: 'b', send }));
  await user.click(screen.getByRole('button', { name: '移动' }));
  expect(screen.getByRole('combobox')).toHaveValue('');
  expect(screen.queryByRole('button', { name: '确认保存' })).toBeNull();
  await user.selectOptions(screen.getByRole('combobox'), 'g');
  await waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.calls[0]![0].command).toMatchObject({ type: 'move', parent: tree.nodes[2]!.ref, index: 0 });
});
it('drag uses private node data only and an invalidated target cannot submit on drop', async () => {
  const { TreeRows } = await import('../panel/BookmarkTree');
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: {
      local: { get: async () => ({ 'tree.expanded.i.r': true, 'tree.expanded.i.f': true }) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  const view = render(createElement(TreeRows, { snapshot: tree }));
  const source = (await screen.findByRole('button', { name: 'Book' })).closest('.bookmark-label')!;
  vi.spyOn(
    screen.getByRole('button', { name: 'Other' }).closest('.bookmark-row')!,
    'getBoundingClientRect',
  ).mockReturnValue({ top: 0, height: 40 } as DOMRect);
  const transfer = { clearData: vi.fn(), setData: vi.fn(), effectAllowed: '' };
  fireEvent.dragStart(source, { dataTransfer: transfer });
  expect(transfer.setData).toHaveBeenCalledExactlyOnceWith('application/x-zhilan-node', 'b');
  fireEvent(screen.getByRole('button', { name: 'Other' }), new MouseEvent('dragover', { bubbles: true, clientY: 20 }));
  view.rerender(
    createElement(TreeRows, { snapshot: { ...tree, nodes: tree.nodes.filter(n => n.ref.nativeId !== 'g') } }),
  );
  // Drop against the now-invalid destination list; no confirmation or submission can revive it.
  fireEvent.drop(source, { dataTransfer: transfer });
  expect(screen.queryByRole('button', { name: '确认移动' })).toBeNull();
  expect(sendMessage).not.toHaveBeenCalled();
  view.unmount();
  vi.unstubAllGlobals();
});
it('existing link opens only on click/Enter; unsupported URL has no executable outlet', async () => {
  const { TreeRows } = await import('../panel/BookmarkTree');
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: async () => ({ 'tree.expanded.i.r': true, 'tree.expanded.i.f': true }) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  const user = userEvent.setup();
  const view = render(createElement(TreeRows, { snapshot: tree }));
  const button = await screen.findByRole('button', { name: 'Book' });
  expect(open).not.toHaveBeenCalled();
  button.focus();
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledTimes(1);
  const historical = structuredClone(tree);
  historical.nodes[3]!.url = 'javascript:alert(1)';
  view.rerender(createElement(TreeRows, { snapshot: historical }));
  expect(screen.queryByRole('button', { name: 'Book' })).toBeNull();
  expect(view.container.querySelector('[href]')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Book 操作' }));
  for (const name of ['在新标签页打开', '在新窗口中打开', '在无痕窗口中打开'])
    expect(screen.getByRole('menuitem', { name })).toBeDisabled();
  open.mockRestore();
  view.unmount();
  vi.unstubAllGlobals();
});
it('does not display a contradictory completed response as success', async () => {
  const { submitMutation } = await import('../panel/mutation-client');
  const request = prepareMove(tree, 'b', 'g', 0);
  expect(
    await submitMutation(request, async () => ({
      requestId: request.requestId,
      status: 'completed',
      needsReconcile: true,
      completedSteps: 0,
      remainingSteps: 1,
    })),
  ).toMatchObject({ status: 'unknown' });
});
it('rejected preview wrote nothing, so the panel invites a fresh preview instead of forbidding resubmission', async () => {
  const send = vi.fn(async request => ({
    requestId: request.requestId,
    status: 'rejected',
    needsReconcile: false,
    completedSteps: 0,
    remainingSteps: 0,
    reason: 'preview-unavailable',
  }));
  const user = userEvent.setup();
  render(createElement(BookmarkActions, { snapshot: tree, selectedId: 'f', send }));
  await user.click(screen.getByRole('button', { name: '新建目录' }));
  await user.type(screen.getByRole('textbox', { name: '标题' }), 'New');
  await user.click(screen.getByRole('button', { name: '确认保存' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未执行操作，请检查连接或重新操作');
  expect(screen.getByRole('alert')).not.toHaveTextContent('勿重复提交');
  expect(screen.getByRole('button', { name: '新建目录' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: '新建目录' }));
  expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(send).toHaveBeenCalledTimes(1);
});
it.each(['新建目录', '新建书签'])(
  'submits %s only after explicit confirmation and prevents repeated pending submit',
  async label => {
    let resolve!: (value: unknown) => void;
    const send = vi.fn(
      (request: import('../schemas/messages').ConfirmMutation) =>
        new Promise(done => {
          resolve = () =>
            done({
              requestId: request.requestId,
              status: 'completed',
              needsReconcile: false,
              completedSteps: 1,
              remainingSteps: 0,
            });
        }),
    );
    const user = userEvent.setup();
    render(createElement(BookmarkActions, { snapshot: tree, selectedId: 'f', send }));
    await user.click(screen.getByRole('button', { name: label }));
    await user.type(screen.getByRole('textbox', { name: '标题' }), 'New');
    if (label === '新建书签') await user.type(screen.getByRole('textbox', { name: '网址' }), 'https://new.test/');
    expect(send).not.toHaveBeenCalled();
    await user.dblClick(screen.getByRole('button', { name: '确认保存' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].command.type).toBe('create');
    expect(screen.getByRole('button', { name: '确认保存' })).toBeDisabled();
    resolve(undefined);
    expect(await screen.findByText(/请求编号/)).toBeVisible();
  },
);
it('form draft and drag confirmation are mutually exclusive panel interactions', async () => {
  const { TreeRows } = await import('../panel/BookmarkTree');
  const sendMessage = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { sendMessage },
    storage: {
      local: { get: async () => ({ 'tree.expanded.i.r': true, 'tree.expanded.i.f': true }) },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  });
  const user = userEvent.setup();
  const view = render(createElement(TreeRows, { snapshot: tree }));
  const source = (await screen.findByRole('button', { name: 'Book' })).closest('.bookmark-label')!;
  await user.click(screen.getByRole('button', { name: 'Book 操作' }));
  await user.click(screen.getByRole('menuitem', { name: '编辑' }));
  vi.spyOn(
    screen.getByRole('button', { name: 'Other' }).closest('.bookmark-row')!,
    'getBoundingClientRect',
  ).mockReturnValue({ top: 0, height: 40 } as DOMRect);
  const transfer = { clearData: vi.fn(), setData: vi.fn(), effectAllowed: '' };
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent(screen.getByRole('button', { name: 'Other' }), new MouseEvent('dragover', { bubbles: true, clientY: 20 }));
  fireEvent.drop(screen.getByRole('button', { name: 'Other' }), { dataTransfer: transfer });
  expect(transfer.setData).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: '确认移动' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.dragStart(source, { dataTransfer: transfer });
  fireEvent(screen.getByRole('button', { name: 'Other' }), new MouseEvent('dragover', { bubbles: true, clientY: 20 }));
  fireEvent.drop(screen.getByRole('button', { name: 'Other' }), { dataTransfer: transfer });
  expect(screen.queryByRole('button', { name: '确认移动' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Book 操作' }));
  await user.click(screen.getByRole('menuitem', { name: '编辑' }));
  expect(screen.queryByRole('textbox', { name: '标题' })).toBeNull();
  expect(sendMessage).toHaveBeenCalledOnce();
  view.unmount();
  vi.unstubAllGlobals();
});

it('resolves all drop placements with shared lightweight index/cycle rules', async () => {
  const { resolveDropTarget } = await import('../panel/TreeDragController');
  const byId = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  expect(resolveDropTarget(byId, 'f', 'g', 'after')).toEqual({ parentId: 'r', index: 1 });
  expect(resolveDropTarget(byId, 'g', 'f', 'before')).toEqual({ parentId: 'r', index: 0 });
  expect(resolveDropTarget(byId, 'b', 'g', 'inside')).toEqual({ parentId: 'g', index: 0 });
  expect(resolveDropTarget(byId, 'b', 'g', 'before')).toEqual({ parentId: 'r', index: 1 });
  expect(resolveDropTarget(byId, 'b', 'f', 'inside')).toEqual({ parentId: 'f', index: 0 });
  for (const [source, target, placement] of [
    ['r', 'g', 'inside'],
    ['f', 'b', 'before'],
    ['f', 'f', 'inside'],
    ['b', 'r', 'before'],
  ] as const) {
    expect(resolveDropTarget(byId, source, target, placement)).toBeUndefined();
  }
  const frozen = new Map(byId);
  frozen.set('g', { ...byId.get('g')!, childrenWritable: false });
  expect(resolveDropTarget(frozen, 'b', 'g', 'inside')).toBeUndefined();
});
