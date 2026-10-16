import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BookmarkTree, TreeRows } from '../panel/BookmarkTree';
import { OverlayStatus } from '../panel/OverlayStatus';
import { searchTree } from './fixtures/search-tree';
import type { TreeState } from '../domain/node-reference';
import type { OrganizeState } from '../domain/organize-state';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { organizeClientRuntime } from './fixtures/organize-client-runtime';
import { MutationFeedback } from '../panel/BookmarkActions';
let receive: (tree: TreeState) => void;
vi.mock('../panel/tree-client', () => ({
  connectTree: (_: unknown, listener: typeof receive) => {
    receive = listener;
    return () => {};
  },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('does not flash fast startup or refresh notices, while disabling mutation immediately during refresh', async () => {
  vi.stubGlobal('chrome', { runtime: { connect: () => {} } });
  vi.useFakeTimers();
  render(<BookmarkTree />);
  expect(screen.queryByText('正在读取书签')).toBeNull();
  act(() => vi.advanceTimersByTime(100));
  act(() => receive({ status: 'ready', snapshot: searchTree() }));
  const row = screen.getByRole('button', { name: /^重庆大学$/ });
  act(() => receive({ status: 'loading' }));
  fireEvent.contextMenu(row);
  expect(screen.getByRole('menuitem', { name: '编辑' })).toBeDisabled();
  act(() => vi.advanceTimersByTime(100));
  expect(screen.queryByText('正在重新连接书签')).toBeNull();
  act(() => receive({ status: 'ready', snapshot: searchTree() }));
  expect(screen.getByRole('menuitem', { name: '编辑' })).toBeEnabled();
  expect(screen.queryByText('正在重新连接书签')).toBeNull();
});

it('shows genuinely slow startup after250ms and immediate authorization errors', () => {
  vi.useFakeTimers();
  const page = render(<OverlayStatus />);
  expect(screen.queryByText('正在连接智栏…')).toBeNull();
  act(() => vi.advanceTimersByTime(249));
  expect(screen.queryByText('正在连接智栏…')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByText('正在连接智栏…')).toBeVisible();
  page.rerender(<OverlayStatus failed />);
  expect(screen.getByText('侧栏启动验证未通过')).toBeVisible();
});

it('ignores unrelated local storage and another installations expansion events', async () => {
  let storageChanged!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const get = vi.fn(async () => ({ 'tree.expanded.test.0': true }));
  vi.stubGlobal('chrome', {
    storage: {
      local: { get },
      onChanged: {
        addListener: (listener: typeof storageChanged) => {
          storageChanged = listener;
        },
        removeListener: () => {},
      },
    },
  });
  const committed = vi.fn();
  render(
    <Profiler id="tree" onRender={committed}>
      <TreeRows snapshot={searchTree()} />
    </Profiler>,
  );
  await waitFor(() => expect(get).toHaveBeenCalledOnce());
  await act(async () => {});
  committed.mockClear();
  act(() => storageChanged({ modelSecurity: { newValue: {} }, debugLog: { newValue: 'tick' } }, 'local'));
  act(() => storageChanged({ 'tree.expanded.other.0': { newValue: false } }, 'local'));
  expect(committed).not.toHaveBeenCalled();
  act(() => storageChanged({ 'tree.expanded.test.0': { newValue: false } }, 'local'));
  expect(screen.getByRole('button', { name: '学习资料' })).toHaveAttribute('aria-expanded', 'false');
});

it('keeps organizer preferences loaded through transient same-installation refreshes', async () => {
  const h = organizeClientRuntime();
  const load = vi.spyOn(h.memory, 'load');
  let current!: OrganizeState;
  let deliver!: (state: OrganizeState) => void;
  const create = (emit: typeof deliver) => {
    deliver = state => {
      current = state;
      emit(state);
    };
    return h.client(deliver);
  };
  const page = render(<OrganizeWorkbench visible createController={create} memoryStore={h.memory} />);
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  await act(async () => {});
  const ready = current.tree;
  for (let i = 0; i < 3; i++) {
    await act(async () => deliver({ ...current, tree: { status: 'loading' } }));
    await act(async () => deliver({ ...current, tree: ready }));
  }
  expect(load).toHaveBeenCalledOnce();
  expect(screen.queryByText('正在读取或保存整理偏好…')).toBeNull();
  page.unmount();
  h.dispose();
});

it('does not present missing transport counters as zero completed native writes', () => {
  render(
    <MutationFeedback
      result={{
        requestId: 'unknown-request',
        status: 'unknown',
        completedSteps: 0,
        remainingSteps: 0,
        needsReconcile: true,
        reason: 'transport-unavailable',
      }}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('结果未知');
  expect(screen.getByRole('alert')).not.toHaveTextContent('已完成 0');
  expect(screen.getByRole('alert')).toHaveTextContent('unknown-request');
});

it('shows submitted organizer execution instead of an empty zero-operation confirmation', async () => {
  const h = organizeClientRuntime();
  let current!: OrganizeState;
  let deliver!: (state: OrganizeState) => void;
  const create = (emit: typeof deliver) => {
    deliver = state => {
      current = state;
      emit(state);
    };
    return h.client(deliver);
  };
  const page = render(<OrganizeWorkbench visible createController={create} memoryStore={h.memory} />);
  await act(async () => {});
  act(() =>
    deliver({
      ...current,
      busy: true,
      selected: [],
      proposal: undefined,
      pipeline: undefined,
      task: { ...current.task!, id: 'submitted-task', requestId: 'known-request' },
      message: '正在提交书签操作，请等待完成。',
    }),
  );
  expect(screen.getByRole('heading', { name: '正在执行整理' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '确认并执行 0 项操作' })).toBeNull();
  expect(screen.queryByText('整理目录： · 已选 0 项操作')).toBeNull();
  expect(screen.queryByRole('button', { name: '核对这次整理的执行结果' })).toBeNull();
  expect(screen.getByRole('button', { name: '停止当前任务' })).toBeVisible();
  expect(h.move).not.toHaveBeenCalled();
  page.unmount();
  h.dispose();
});
