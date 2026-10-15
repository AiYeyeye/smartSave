import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { OrganizeController } from '../panel/organize-controller';
import { organizerTree } from './fixtures/organizer-tree';
import { ThemeProvider, ThemePicker } from '../ui/ThemeProvider';
import { APPEARANCES } from './appearance';
import { SettingsStore } from '../persistence/settings';
import { organizeClientRuntime } from './fixtures/organize-client-runtime';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';
import type { ModelResult } from '../adapters/model-transport';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('retains custom inputs, a pending worker request and final confirmation across language changes', async () => {
  const h = organizeClientRuntime();
  let finish!: (result: ModelResult) => void;
  h.run
    .mockImplementationOnce(
      () =>
        new Promise<ModelResult>(resolve => {
          finish = resolve;
        }),
    )
    .mockImplementation(async input => ({
      status: 'completed',
      output: {
        newFolders: [],
        merges: [],
        moves:
          input.request.task === 'organize' ? input.request.itemIds.map(itemId => ({ itemId, folderId: 'right' })) : [],
      },
    }));
  const settings = new SettingsStore({
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    setAccessLevel: async () => {},
  });
  const create = vi.fn((emit: ConstructorParameters<typeof OrganizeController>[0]) => h.client(emit));
  const page = render(
    <LocaleProvider>
      <LanguagePicker />
      <OrganizeWorkbench visible settings={settings} createController={create} memoryStore={h.memory} />
    </LocaleProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '下一步：生成整理方案' })).toBeEnabled());
  fireEvent.click(screen.getByText('高级选项'));
  fireEvent.change(screen.getByLabelText('分类方式'), { target: { value: 'custom' } });
  const instructions = screen.getByLabelText('分类要求');
  fireEvent.change(instructions, { target: { value: '移动 <&> {count}' } });
  fireEvent.change(screen.getByLabelText('每批最多书签'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByLabelText('Organization instructions')).toBe(instructions);
  expect(instructions).toHaveValue('移动 <&> {count}');
  expect(screen.getByLabelText('Folder style')).toHaveValue('custom');
  expect(screen.getByLabelText('Bookmarks per batch')).toHaveValue(2);
  fireEvent.click(screen.getByRole('button', { name: 'Next: generate plan' }));
  await waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByRole('button', { name: '确认分类，开始分批整理书签' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(create).toHaveBeenCalledOnce();
  expect(h.run).toHaveBeenCalledTimes(1);
  expect(h.run.mock.calls[0]![0].request).toMatchObject({
    preference: { style: 'custom', instructions: '移动 <&> {count}' },
  });
  expect(h.move).not.toHaveBeenCalled();
  await act(async () => finish({ status: 'completed', output: { newFolders: [], moves: [], merges: [] } }));
  const confirmFolders = screen.getByRole('button', { name: 'Confirm folders and start bookmark batches' });
  await waitFor(() => expect(confirmFolders).toBeEnabled());
  fireEvent.click(confirmFolders);
  await screen.findByText('Review and adjust bookmarks (2)');
  fireEvent.click(screen.getByText('Review and adjust bookmarks (2)'));
  await waitFor(() => expect(screen.getByLabelText('Select move:a')).toBeEnabled());
  const selected = screen.getByLabelText('Select move:a');
  const expanded = screen.getByText('Review and adjust bookmarks (2)').closest('details');
  fireEvent.click(selected);
  await waitFor(() => expect(screen.getByLabelText('Select move:a')).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Next: confirm changes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByLabelText('Select move:a')).toBe(selected);
  expect(selected).not.toBeChecked();
  expect(expanded).toHaveAttribute('open');
  expect(screen.getByLabelText('Organization instructions')).toBe(instructions);
  expect(instructions).toHaveValue('移动 <&> {count}');
  expect(h.run).toHaveBeenCalledTimes(2);
  expect(h.move).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Next: confirm changes' }));
  const apply = screen.getByRole('button', { name: 'Confirm and apply operations (1)' });
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByRole('button', { name: '确认并执行 1 项操作' })).toBe(apply);
  expect(screen.getByRole('heading', { name: '确认所选操作' })).toBeVisible();
  expect(h.run).toHaveBeenCalledTimes(2);
  expect(h.move).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  fireEvent.click(apply);
  await waitFor(() => expect(h.move).toHaveBeenCalledExactlyOnceWith('b', expect.anything()));
  await screen.findByText(/Request: .*Status: completed/);
  expect(create).toHaveBeenCalledOnce();
  page.unmount();
  settings.dispose();
  h.dispose();
});

it('shows a separate one-shot repair action, keeps apply unavailable and sends only failed identities on click', async () => {
  const h = organizeClientRuntime();
  h.run
    .mockResolvedValueOnce({ status: 'completed', output: { moves: [], newFolders: [], merges: [] } })
    .mockResolvedValueOnce({
      status: 'repairable',
      reason: 'partial-invalid-targets',
      repair: {
        retained: { moves: [{ itemId: 'a', folderId: 'right' }], newFolders: [], merges: [] },
        itemIds: ['b'],
      },
    })
    .mockResolvedValue({
      status: 'completed',
      output: { moves: [{ itemId: 'b', folderId: 'right' }], newFolders: [], merges: [] },
    });
  const settings = new SettingsStore({
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    setAccessLevel: async () => {},
  });
  const page = render(
    <LocaleProvider>
      <LanguagePicker />
      <OrganizeWorkbench visible settings={settings} createController={emit => h.client(emit)} memoryStore={h.memory} />
    </LocaleProvider>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '下一步：生成整理方案' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '下一步：生成整理方案' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认分类，开始分批整理书签' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认分类，开始分批整理书签' }));
  const repair = await screen.findByRole('button', { name: '只补问这 1 条' });
  await waitFor(() => expect(repair).toBeEnabled());
  expect(h.run).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('button', { name: 'Retry these items (1)' })).toBe(repair);
  expect(screen.getByRole('button', { name: 'Next: confirm changes' })).toBeDisabled();
  expect(screen.getByText('A few bookmarks have invalid destination folders.', { exact: false })).toBeVisible();
  expect(h.run).toHaveBeenCalledTimes(2);
  fireEvent.click(repair);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next: confirm changes' })).toBeEnabled());
  expect(h.run).toHaveBeenCalledTimes(3);
  expect(h.run.mock.calls[2]![0].request).toMatchObject({ itemIds: ['b'] });
  expect(screen.queryByRole('button', { name: 'Retry these items (1)' })).not.toBeInTheDocument();
  expect(h.move).not.toHaveBeenCalled();
  page.unmount();
  settings.dispose();
  h.dispose();
});

it('acknowledges a task only after its workbench is visible in a visible document', () => {
  const seen = vi.fn();
  const settings = new SettingsStore({
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    setAccessLevel: async () => {},
  });
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    const controller = new OrganizeController(emit);
    return Object.assign(controller, { setVisible: seen });
  };
  const page = render(<OrganizeWorkbench visible={false} settings={settings} createController={create} />);
  expect(seen).toHaveBeenLastCalledWith(false);
  expect(seen).not.toHaveBeenCalledWith(true);
  page.rerender(<OrganizeWorkbench visible settings={settings} createController={create} />);
  expect(seen).toHaveBeenLastCalledWith(true);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  fireEvent(document, new Event('visibilitychange'));
  expect(seen).toHaveBeenLastCalledWith(false);
  visibility.mockRestore();
  fireEvent(document, new Event('visibilitychange'));
  expect(seen).toHaveBeenLastCalledWith(true);
  settings.dispose();
});

it('uses the worker client to reopen a persisted review and confirms only the restored selection', async () => {
  const h = organizeClientRuntime();
  h.run.mockImplementation(async input => ({
    status: 'completed',
    output: {
      newFolders: [],
      merges: [],
      moves:
        input.request.task === 'organize' && input.request.stage === 'bookmarks'
          ? input.request.itemIds.map(itemId => ({ itemId, folderId: 'right' }))
          : [],
    },
  }));
  const settings = new SettingsStore({
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    setAccessLevel: async () => {},
  });
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => h.client(emit);
  const first = render(
    <OrganizeWorkbench visible settings={settings} createController={create} memoryStore={h.memory} />,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: '下一步：生成整理方案' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '下一步：生成整理方案' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认分类，开始分批整理书签' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '确认分类，开始分批整理书签' }));
  await screen.findByText('查看并调整 2 条书签');
  fireEvent.click(screen.getByText('查看并调整 2 条书签'));
  await waitFor(() => expect(screen.getByLabelText('选择 move:a')).toBeEnabled());
  fireEvent.click(screen.getByLabelText('选择 move:a'));
  await waitFor(() => expect(screen.getByLabelText('选择 move:a')).toBeEnabled());
  expect(screen.getByLabelText('选择 move:a')).not.toBeChecked();
  first.unmount();
  expect(h.move).not.toHaveBeenCalled();
  const reopened = render(
    <OrganizeWorkbench visible settings={settings} createController={create} memoryStore={h.memory} />,
  );
  await screen.findByText('查看并调整 2 条书签');
  expect(screen.getByLabelText('选择 move:a')).not.toBeChecked();
  expect(screen.getByLabelText('选择 move:b')).toBeChecked();
  expect(h.run).toHaveBeenCalledTimes(2);
  const next = await screen.findByRole('button', { name: '下一步：确认操作' });
  await waitFor(() => expect(next).toBeEnabled());
  fireEvent.click(next);
  fireEvent.click(screen.getByRole('button', { name: '确认并执行 1 项操作' }));
  await waitFor(() => expect(h.move).toHaveBeenCalledTimes(1));
  await screen.findByText(/请求编号：.*状态 completed/);
  expect(h.move.mock.calls[0]![0]).toBe('b');
  reopened.unmount();
  settings.dispose();
  h.dispose();
});
it('requires custom instructions, previews streaming suggestions read-only and exposes retry after failure', async () => {
  let fail!: (value: { status: 'failed'; reason: string; detail?: 'output-limit' }) => void;
  let disconnect!: () => void;
  const run = vi.fn<NonNullable<ConstructorParameters<typeof OrganizeController>[2]>['run']>(input => {
    input.onProgress?.({
      phase: 'receiving',
      text: '{"newFolders":[{"id":"new","parentId":"bar","title":"工具"}],',
      receivedChars: 50,
      streaming: true,
    });
    return new Promise(resolve => {
      fail = resolve;
    });
  });
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    const tree = organizerTree();
    const controller = new OrganizeController(
      emit,
      {
        read: async () => ({
          tree,
          version: 1,
          revision: 'one',
          sessionRevision: 0,
          key: '',
          privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
          config: {
            adapter: 'anthropic',
            baseUrl: 'https://example.test/v1',
            model: 'test',
            timeoutMs: 1000,
            maxOutputTokens: 64000,
          },
        }),
        subscribe: () => () => {},
      },
      { run, cancel: vi.fn(), dispose: vi.fn() },
      async invalidated => {
        disconnect = invalidated;
        return { token: 'lease', close: vi.fn() };
      },
    );
    controller.setTree({ status: 'ready', snapshot: tree });
    return controller;
  };
  const settings = new SettingsStore({
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    setAccessLevel: async () => {},
  });
  render(<OrganizeWorkbench visible settings={settings} createController={create} />);
  expect(screen.getByLabelText('整理范围')).toHaveValue('bar');
  expect(screen.getByLabelText('每批最多书签')).not.toBeVisible();
  fireEvent.click(screen.getByText('高级选项'));
  fireEvent.click(screen.getByLabelText('只整理未分类的书签'));
  expect(screen.getByLabelText('建议清理原有空分类和迁移后变空的分类')).toBeDisabled();
  expect(screen.getByLabelText('建议清理原有空分类和迁移后变空的分类')).not.toBeChecked();
  expect(screen.getByLabelText('允许建议重命名分类')).toBeDisabled();
  fireEvent.click(screen.getByLabelText('只整理未分类的书签'));
  expect(screen.getByLabelText('建议清理原有空分类和迁移后变空的分类')).toBeChecked();
  expect(screen.getByLabelText('每批最多书签')).toHaveValue(100);
  fireEvent.change(screen.getByLabelText('整理范围'), { target: { value: 'bar' } });
  fireEvent.change(screen.getByLabelText('分类方式'), { target: { value: 'custom' } });
  expect(screen.getByRole('button', { name: '下一步：生成整理方案' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('分类要求'), { target: { value: '分成写作、画图' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '下一步：生成整理方案' })).toBeEnabled());
  const generate = vi.spyOn(OrganizeController.prototype, 'generate');
  for (const value of ['', '0', '-1', '1.5']) {
    fireEvent.change(screen.getByLabelText('每批最多书签'), { target: { value } });
    expect(screen.getByRole('button', { name: '下一步：生成整理方案' })).toBeDisabled();
    expect(screen.getByText('请输入大于或等于 1 的有效整数。')).toBeVisible();
  }
  fireEvent.change(screen.getByLabelText('每批最多书签'), { target: { value: '200' } });
  expect(screen.getByRole('button', { name: '下一步：生成整理方案' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '下一步：生成整理方案' }));
  await screen.findByText('正在生成的建议');
  expect(generate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ batchSize: 200 }));
  generate.mockRestore();
  expect(screen.getByText(/整理范围共 2 条书签；每批最多 200 条/)).toBeVisible();
  expect(screen.getByText(/连接或连续无流数据的等待上限 180 秒/)).toBeVisible();
  expect(screen.getByRole('button', { name: '确认分类，开始分批整理书签' })).toBeDisabled();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fail({ status: 'failed', reason: 'incomplete', detail: 'output-limit' });
  await screen.findByRole('button', { name: '重新生成方案' });
  const failure = screen.getByRole('alert', { name: '整理未完成' });
  expect(failure).toHaveTextContent('输出额度上限');
  expect(failure).toHaveTextContent('最大输出 tokens');
  expect(failure).toHaveTextContent('整理范围共 2 条书签');
  expect(failure).toHaveTextContent('失败阶段：文件夹分类 · 模型生成');
  expect(failure).toHaveTextContent('64,000 tokens');
  expect(screen.getByRole('link', { name: '调整模型输出上限' })).toHaveAttribute('href', '#ai-services');
  expect(screen.getByRole('button', { name: '缩小整理范围' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '确认分类，开始分批整理书签' })).toBeDisabled();
  expect(screen.queryByText('正在生成的建议')).toBeNull();
  expect(run.mock.calls[0]![0].request).toMatchObject({
    preference: { style: 'custom', instructions: '分成写作、画图' },
  });
  run.mockResolvedValueOnce({
    status: 'completed',
    output: { moves: [], newFolders: [], merges: [] },
  });
  fireEvent.click(screen.getByRole('button', { name: '重新生成方案' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认分类，开始分批整理书签' })).toBeEnabled());
  expect(run).toHaveBeenCalledTimes(2);
  run.mockResolvedValueOnce({
    status: 'completed',
    output: {
      moves: [{ itemId: 'a', folderId: 'right' }],
      newFolders: [],
      merges: [],
      unchangedIds: ['b'],
    },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认分类，开始分批整理书签' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeEnabled());
  expect(screen.queryByRole('alert', { name: '整理未完成' })).toBeNull();
  const footer = screen.getByRole('button', { name: '下一步：确认操作' }).closest('.organize-footer')!;
  expect(footer).toHaveTextContent('全部 1 批已完成');
  expect(screen.getByRole('region', { name: '按目标目录审核' })).toBeVisible();
  expect(screen.getByRole('list', { name: '整理后分类树', hidden: true })).not.toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: /^采纳 / }));
  expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: /^采纳 / }));
  expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeEnabled();
  fireEvent.click(screen.getByLabelText('选择 move:a'));
  expect(footer).toHaveTextContent('请至少勾选一项建议');
  expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('选择 move:a'));
  fireEvent.click(screen.getByRole('button', { name: '下一步：确认操作' }));
  disconnect();
  await waitFor(() => expect(screen.getByRole('button', { name: '确认并执行 1 项操作' })).toBeDisabled());
  expect(screen.getByRole('button', { name: '重新生成方案' }).closest('.organize-footer')).toHaveTextContent(
    '整理连接已中断',
  );
  run.mockResolvedValueOnce({ status: 'completed', output: { moves: [], newFolders: [], merges: [] } });
  fireEvent.click(screen.getByRole('button', { name: '上一步' }));
  fireEvent.click(screen.getByRole('button', { name: '上一步' }));
  fireEvent.click(screen.getByLabelText('建议清理原有空分类和迁移后变空的分类'));
  fireEvent.click(screen.getByRole('button', { name: '下一步：生成整理方案' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '确认分类，开始分批整理书签' })).toBeEnabled());
  run.mockResolvedValueOnce({
    status: 'completed',
    output: { moves: [], newFolders: [], merges: [], unchangedIds: ['a', 'b'] },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认分类，开始分批整理书签' }));
  await screen.findByText(/全部 1 批已完成.*没有需要应用的操作/);
  expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeDisabled();
});
it.each(APPEARANCES)('retains unchecked selection across hidden navigation in %s', async theme => {
  const tree = organizerTree();
  let controller: OrganizeController;
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    controller = new OrganizeController(
      emit,
      {
        read: async () => ({
          tree,
          version: 1,
          revision: 'one',
          sessionRevision: 0,
          key: '',
          privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
        }),
        subscribe: () => () => {},
      },
      undefined,
      async () => ({ token: 'lease', close: vi.fn() }),
    );
    controller.setTree({ status: 'ready', snapshot: tree });
    return controller;
  };
  const view = render(
    <ThemeProvider>
      <ThemePicker />
      <OrganizeWorkbench visible createController={create} />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByLabelText(theme));
  fireEvent.change(screen.getByLabelText('整理范围'), { target: { value: 'bar' } });
  fireEvent.click(screen.getByText('下一步：查找重复书签'));
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  fireEvent.change(screen.getByLabelText('b 保留或删除'), { target: { value: 'delete' } });
  fireEvent.click(screen.getByText('生成去重预览'));
  await waitFor(() => expect(screen.getByLabelText('选择 delete:b')).toBeChecked());
  fireEvent.click(screen.getByLabelText('选择 delete:b'));
  view.rerender(
    <ThemeProvider>
      <ThemePicker />
      <OrganizeWorkbench visible={false} createController={create} />
    </ThemeProvider>,
  );
  view.rerender(
    <ThemeProvider>
      <ThemePicker />
      <OrganizeWorkbench visible createController={create} />
    </ThemeProvider>,
  );
  expect(screen.getByLabelText('选择 delete:b')).not.toBeChecked();
  expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeDisabled();
  expect(controller!).toBeDefined();
});
it('renders a sizable frozen preview and updates selection without replacing its snapshots', async () => {
  const tree = organizerTree();
  const sample = tree.nodes.find(n => n.ref.nativeId === 'a')!;
  for (let i = 0; i < 120; i++) {
    const id = `render-${i}`;
    tree.nodes.push({ ...sample, index: i + 2, ref: { ...sample.ref, nativeId: id }, title: id });
    tree.nodes.find(n => n.ref.nativeId === 'left')!.childrenIds.push(id);
  }
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    const controller = new OrganizeController(emit, undefined, undefined, async () => ({
      token: 'lease',
      close: vi.fn(),
    }));
    controller.setTree({ status: 'ready', snapshot: tree });
    return controller;
  };
  render(<OrganizeWorkbench visible createController={create} />);
  fireEvent.change(screen.getByLabelText('整理范围'), { target: { value: 'bar' } });
  fireEvent.click(screen.getByText('下一步：查找重复书签'));
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  for (let i = 0; i < 120; i++)
    fireEvent.change(screen.getByLabelText(`render-${i} 保留或删除`), { target: { value: 'delete' } });
  fireEvent.click(screen.getByText('生成去重预览'));
  await waitFor(() => expect(screen.getByLabelText('选择 delete:render-119')).toBeChecked());
  fireEvent.click(screen.getByLabelText('选择 delete:render-119'));
  expect(screen.getByLabelText('选择 delete:render-119')).not.toBeChecked();
}, 60000); // 120 jsdom select changes without list virtualization: correctness test, not a timing budget.

it('requires an explicit kept duplicate and a separate final confirmation before applying', async () => {
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    const controller = new OrganizeController(emit, undefined, undefined, async () => ({
      token: 'lease',
      close: vi.fn(),
    }));
    controller.setTree({ status: 'ready', snapshot: organizerTree() });
    return controller;
  };
  const apply = vi.spyOn(OrganizeController.prototype, 'apply').mockResolvedValue(undefined);
  render(<OrganizeWorkbench visible createController={create} />);
  expect(screen.getByRole('button', { name: '下一步：查找重复书签' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('整理范围'), { target: { value: 'bar' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步：查找重复书签' }));
  expect(screen.getByRole('button', { name: '生成去重预览' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('b 保留或删除'), { target: { value: 'delete' } });
  expect(screen.getByRole('button', { name: '生成去重预览' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  fireEvent.click(screen.getByRole('button', { name: '生成去重预览' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '下一步：确认操作' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: '下一步：确认操作' }));
  expect(apply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认并执行 1 项操作' }));
  expect(apply).toHaveBeenCalledOnce();
  apply.mockRestore();
});
