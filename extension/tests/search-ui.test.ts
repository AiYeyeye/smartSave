import { createElement, StrictMode } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchResults } from '../panel/SearchResults';
import { ThemePicker, ThemeProvider } from '../ui/ThemeProvider';
import { App } from '../ui/App';
import { searchTree } from './fixtures/search-tree';
import type { TreeState } from '../domain/node-reference';
import { APPEARANCES } from './appearance';
import { LANGUAGE_KEY, LocaleProvider } from '../ui/i18n';
import { searchFolders } from './fixtures/search-folders';
let snapshot = searchTree();
const listeners = new Set<(state: TreeState) => void>();
vi.mock('../panel/tree-client', () => ({
  connectTree: (_runtime: unknown, listener: (state: TreeState) => void) => {
    listeners.add(listener);
    listener({ status: 'ready', snapshot });
    return () => {
      listeners.delete(listener);
    };
  },
}));
afterEach(() => {
  listeners.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  snapshot = searchTree();
  location.hash = '';
});
function chromeStub() {
  vi.stubGlobal('chrome', {
    windows: { getCurrent: async () => ({ id: 1 }) },
    runtime: {
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
    },
  });
}
it.each(['panel', 'options'] as const)(
  'recent bookmarks in %s retain search/filter/menu state across language changes',
  async page => {
    chromeStub();
    location.hash = '#browse';
    const now = Date.now();
    snapshot.nodes[1]!.dateAdded = now - 20 * 86400000;
    snapshot.nodes[2]!.dateAdded = now - 86400000;
    const fetcher = vi.spyOn(globalThis, 'fetch');
    render(createElement(App, { page }));
    const tabs = within(
      page === 'panel'
        ? screen.getByRole('navigation', { name: '书签导航' })
        : screen.getByRole('group', { name: '搜索范围' }),
    );
    expect(tabs.getAllByRole('button').map(button => button.textContent)).toEqual(
      page === 'panel' ? ['目录', '最近', '历史', '检查'] : ['目录', '最近收藏', '历史'],
    );
    expect(tabs.getByRole('button', { name: '目录' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '最近收藏' }));
    expect(tabs.getByRole('button', { name: '目录' })).toHaveAttribute('aria-pressed', 'false');
    expect(tabs.getByRole('button', { name: '最近收藏' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByText(/收藏范围：|默认查找近 90 天/)).toBeNull();
    const region = screen.getByRole('region', { name: '最近收藏' });
    expect(
      within(region)
        .getAllByRole('button')
        .filter(button => button.classList.contains('search-hit-open'))
        .map(button => button.textContent),
    ).toEqual(['Bookmark 1', '重庆大学']);
    expect(screen.getByRole('combobox', { name: '收藏时间' })).toHaveValue('auto');
    fireEvent.change(screen.getByRole('combobox', { name: '收藏时间' }), { target: { value: '7' } });
    expect(screen.queryByRole('button', { name: '重庆大学' })).toBeNull();
    const input = screen.getByRole('searchbox');
    fireEvent.change(input, { target: { value: 'Bookmark' } });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Bookmark 1' }));
    expect(screen.getByRole('menu')).toBeVisible();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'en' })));
    expect(screen.getByRole('combobox', { name: 'Date saved' })).toHaveValue('7');
    expect(screen.getByRole('searchbox')).toBe(input);
    expect(input).toHaveValue('Bookmark');
    expect(screen.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'zh-CN' })));
  },
);
it('brief recent-list refreshes keep rows mounted without flashing notices; errors remain actionable', () => {
  vi.useFakeTimers();
  chromeStub();
  snapshot.nodes[1]!.dateAdded = Date.now() - 86400000;
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const view = render(createElement(SearchResults, { query: '', recentView: true }));
  const row = screen.getByRole('button', { name: '重庆大学' });
  try {
    for (let i = 0; i < 3; i++) {
      act(() => listeners.forEach(listener => listener({ status: 'loading' })));
      expect(row).toBeDisabled();
      fireEvent.click(row);
      expect(open).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1200));
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('button', { name: '重试读取' })).toBeNull();
      act(() => listeners.forEach(listener => listener({ status: 'ready', snapshot })));
      expect(screen.getByRole('button', { name: '重庆大学' })).toBe(row);
      expect(row).toBeEnabled();
    }
    act(() => listeners.forEach(listener => listener({ status: 'loading' })));
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole('status')).toHaveTextContent('正在更新书签');
    act(() => listeners.forEach(listener => listener({ status: 'error', message: '合成断线' })));
    expect(screen.getByRole('alert')).toHaveTextContent('合成断线');
    expect(screen.getByRole('button', { name: '重试读取' })).toBeVisible();
    expect(screen.getByRole('button', { name: '重庆大学' })).toBe(row);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
it('recent all-time view shows legacy bookmarks and directory switching restores the native tree', () => {
  chromeStub();
  render(createElement(App, { page: 'panel' }));
  fireEvent.click(screen.getByRole('button', { name: '最近收藏' }));
  expect(screen.getByText('所选时间内没有记录收藏时间的书签，可切换到全部时间。')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: '收藏时间' }), { target: { value: 'all' } });
  expect(screen.getByRole('button', { name: '重庆大学' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '目录' }));
  expect(screen.getByRole('region', { name: '书签目录' })).toBeVisible();
  expect(screen.queryByRole('region', { name: '最近收藏' })).toBeNull();
});
it('production App input reaches search without model calls or writes', () => {
  chromeStub();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  render(createElement(App, { page: 'panel' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cqdx' } });
  expect(
    within(screen.getByRole('region', { name: '搜索结果' })).getByRole('button', { name: '重庆大学' }),
  ).toBeVisible();
  const row = screen.getByRole('button', { name: /^重庆大学$/ });
  expect(row).toHaveTextContent(/^重庆大学$/);
  expect(row).not.toHaveTextContent('https://');
  expect(row).not.toHaveTextContent('学习资料');
  expect(fetcher).not.toHaveBeenCalled();
});
it('search result right-click and keyboard menus share safe open, copy and selection commands', async () => {
  chromeStub();
  const user = userEvent.setup();
  const createTab = vi.fn(async () => ({}));
  const createWindow = vi.fn(async () => ({}));
  Object.assign(chrome, { tabs: { create: createTab }, windows: { create: createWindow } });
  const send = vi.fn();
  chrome.runtime.sendMessage = send;
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  render(createElement(SearchResults, { query: 'Bookmark 1' }));
  const result = screen.getByRole('button', { name: 'Bookmark 1' });
  const showMenu = () => fireEvent.contextMenu(result);
  showMenu();
  expect(screen.getByRole('menu')).toBeVisible();
  expect(screen.getByRole('menuitem', { name: '在新标签页打开' })).toHaveFocus();
  showMenu();
  expect(screen.getAllByRole('menu')).toHaveLength(1);
  expect(screen.getByRole('menuitem', { name: '置顶' })).toBeEnabled();
  expect(send).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  await user.click(screen.getByRole('menuitem', { name: '在新标签页打开' }));
  expect(createTab).toHaveBeenCalledExactlyOnceWith({ url: snapshot.nodes[2]!.url, active: true });
  showMenu();
  await user.click(screen.getByRole('menuitem', { name: '在新窗口中打开' }));
  showMenu();
  await user.click(screen.getByRole('menuitem', { name: '在无痕窗口中打开' }));
  expect(createWindow.mock.calls).toEqual([
    [{ url: snapshot.nodes[2]!.url, type: 'normal', focused: true, incognito: false }],
    [{ url: snapshot.nodes[2]!.url, type: 'normal', focused: true, incognito: true }],
  ]);
  showMenu();
  await user.click(screen.getByRole('menuitem', { name: '复制链接' }));
  expect(copy).toHaveBeenCalledExactlyOnceWith(snapshot.nodes[2]!.url);
  expect(screen.getByText('已复制链接')).toBeVisible();
  fireEvent.keyDown(result, { key: 'F10', shiftKey: true });
  await user.click(screen.getByRole('menuitem', { name: '选择书签' }));
  expect(screen.getByRole('checkbox', { name: '选择 Bookmark 1' })).toBeChecked();
  expect(screen.getByText('已选 1 项')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '退出选择' }));
  fireEvent.keyDown(result, { key: 'ContextMenu' });
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('button', { name: 'Bookmark 1 操作' })).toHaveFocus();
  expect(send).not.toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
});
it('filtered results edit/delete the clicked ID and reorder within its original native siblings', async () => {
  chromeStub();
  const user = userEvent.setup();
  const requests: import('../schemas/messages').ConfirmMutation[] = [];
  const send = vi.fn((message, reply) => {
    if (message.type === 'registerMutationPreview') reply({ proposal: message.request });
    else {
      requests.push(message);
      reply({
        requestId: message.requestId,
        status: 'completed',
        needsReconcile: false,
        completedSteps: 1,
        remainingSteps: 0,
      });
    }
  });
  Object.assign(chrome.runtime, { sendMessage: send });
  snapshot.nodes[0]!.childrenWritable = true;
  const view = render(createElement(SearchResults, { query: 'Bookmark 1' }));
  const result = screen.getByRole('button', { name: 'Bookmark 1' });
  fireEvent.contextMenu(result);
  await user.click(screen.getByRole('menuitem', { name: '编辑' }));
  expect(screen.getByRole('textbox', { name: '标题' })).toHaveValue('Bookmark 1');
  expect(screen.getByRole('textbox', { name: '网址' })).toHaveValue(snapshot.nodes[2]!.url);
  await user.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.contextMenu(result);
  await user.click(screen.getByRole('menuitem', { name: '删除' }));
  expect(screen.getByRole('dialog', { name: '是否确认删除？' })).toHaveTextContent(/^是否确认删除？取消确认删除$/);
  expect(send).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '取消' }));
  fireEvent.contextMenu(result);
  await user.click(screen.getByRole('menuitem', { name: '置顶' }));
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]!.command).toMatchObject({
    type: 'move',
    target: snapshot.nodes[2]!.ref,
    parent: snapshot.nodes[0]!.ref,
    index: 0,
  });
  // One displayed hit is not the first sibling in its native folder.
  expect(view.container.querySelectorAll('.search-hit-list li')).toHaveLength(1);
});
it('cached results block open and mutation commands while disconnected and discard deleted result menus', () => {
  chromeStub();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  render(createElement(SearchResults, { query: 'Bookmark 1' }));
  const result = screen.getByRole('button', { name: 'Bookmark 1' });
  fireEvent.contextMenu(result);
  act(() => listeners.forEach(listener => listener({ status: 'error', message: '合成断线' })));
  expect(result).toBeDisabled();
  for (const name of ['在新标签页打开', '在新窗口中打开', '在无痕窗口中打开', '置顶', '编辑', '移入…', '删除']) {
    expect(screen.getByRole('menuitem', { name })).toBeDisabled();
  }
  act(() => listeners.forEach(listener => listener({ status: 'ready', snapshot })));
  expect(screen.getByRole('menuitem', { name: '编辑' })).toBeEnabled();
  const changed = structuredClone(snapshot);
  changed.nodes = changed.nodes.filter(node => node.ref.nativeId !== '2');
  changed.nodes[0]!.childrenIds = ['1', '3'];
  act(() => listeners.forEach(listener => listener({ status: 'ready', snapshot: changed })));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Bookmark 1' })).toBeNull();
  expect(open).not.toHaveBeenCalled();
});
it('English search translates interface text but preserves native bookmark titles and query', () => {
  chromeStub();
  localStorage.setItem(LANGUAGE_KEY, 'en');
  snapshot.nodes[1]!.title = '搜索书签';
  render(createElement(App, { page: 'panel' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search bookmarks' }), { target: { value: '搜索书签' } });
  expect(screen.getByRole('region', { name: 'Search results' })).toBeVisible();
  expect(screen.getByRole('button', { name: /^搜索书签$/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Find with AI' })).toBeVisible();
  const search = screen.getByRole('searchbox');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'zh-CN' })));
  expect(screen.getByRole('searchbox', { name: '搜索书签' })).toBe(search);
  expect(search).toHaveValue('搜索书签');
  expect(screen.getByRole('button', { name: /^搜索书签$/ })).toBeVisible();
});
it('Ctrl+K returns from settings and focuses the existing search; composition is ignored', () => {
  chromeStub();
  render(createElement(App, { page: 'panel' }));
  fireEvent.click(screen.getByRole('button', { name: /^设置$/ }));
  expect(screen.queryByRole('searchbox')).toBeNull();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true, isComposing: true });
  expect(screen.queryByRole('searchbox')).toBeNull();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  expect(screen.getByRole('searchbox')).toHaveFocus();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cqdx' } });
  fireEvent.keyDown(window, { key: 'k', metaKey: true });
  expect(screen.getByRole('searchbox')).toHaveValue('cqdx');
});
it('opaque search launch claims the query once and clears its route without automatic AI', async () => {
  chromeStub();
  const send = vi.fn<(message: unknown) => Promise<{ query: string }>>(async () => ({ query: 'cqdx' }));
  chrome.runtime.sendMessage = send as unknown as typeof chrome.runtime.sendMessage;
  location.hash = '#search/test-token';
  const fetcher = vi.spyOn(globalThis, 'fetch');
  render(createElement(StrictMode, null, createElement(App, { page: 'options' })));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('searchbox')).toHaveValue('cqdx');
  expect(screen.getByRole('searchbox')).toHaveFocus();
  expect(location.hash).toBe('#browse');
  expect(send).toHaveBeenCalledWith({ type: 'claimSearchLaunch', token: 'test-token' });
  expect(
    send.mock.calls.filter(args => (args[0] as { type?: string } | undefined)?.type === 'claimSearchLaunch'),
  ).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
});
it('four themes preserve results, query draft and keyboard/click safe activation', async () => {
  chromeStub();
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  const user = userEvent.setup();
  const view = render(
    createElement(ThemeProvider, null, createElement(ThemePicker), createElement(SearchResults, { query: 'cqdx' })),
  );
  const result = screen.getByRole('button', { name: '重庆大学' });
  expect(open).not.toHaveBeenCalled();
  for (const name of APPEARANCES) {
    await user.click(screen.getByRole('radio', { name }));
    expect(screen.getByRole('button', { name: '重庆大学' })).toBe(result);
  }
  result.focus();
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledOnce();
  await user.click(result);
  expect(open).toHaveBeenCalledTimes(2);
  act(() => listeners.forEach(listener => listener({ status: 'loading' })));
  expect(screen.getByRole('region', { name: '搜索结果' })).toHaveAttribute('aria-busy', 'true');
  act(() => listeners.forEach(listener => listener({ status: 'error', message: '合成断线' })));
  expect(screen.getByRole('alert')).toHaveTextContent('合成断线');
  view.rerender(createElement(SearchResults, { query: 'nonexistent' }));
  expect(screen.getByText(/没有匹配/)).toBeVisible();
  view.rerender(createElement(SearchResults, { query: '整理学习资料' }));
  expect(screen.queryByRole('note')).toBeNull();
  expect(open).toHaveBeenCalledTimes(2);
});
it('measures synthetic input-to-render with all1000 returned candidates, excluding index build', () => {
  chromeStub();
  snapshot = searchTree(1000);
  const view = render(createElement(SearchResults, { query: '' }));
  const start = performance.now();
  view.rerender(createElement(SearchResults, { query: 'example' }));
  const elapsed = performance.now() - start;
  expect(view.container.querySelectorAll('.search-hit-list li')).toHaveLength(1000);
  console.info(
    JSON.stringify({
      syntheticJsdomInputToRenderMs: elapsed,
      returnedCandidates: 1000,
      indexBuildExcluded: true,
      browserTiming: 'NOT RUN',
    }),
  );
  // jsdom timing under a loaded machine is noisy; only a pathological regression (seconds, not hundreds of ms) should fail here.
  expect(elapsed).toBeLessThan(1500);
});

it('explicit UI rerank uses shared settings and actual browser authority; accepted order resets on permission removal', async () => {
  const { SettingsStore } = await import('../persistence/settings');
  const invalidations = new Set<() => void>();
  const event = {
    addListener: (listener: () => void) => invalidations.add(listener),
    removeListener: (listener: () => void) => invalidations.delete(listener),
  };
  chromeStub();
  Object.assign(chrome, {
    storage: { onChanged: event },
    permissions: { onRemoved: event, contains: async () => true },
  });
  const data: Record<string, unknown> = {};
  const settings = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async value => {
        Object.assign(data, value);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    operation => operation(),
  );
  await settings.load();
  await settings.save(
    { adapter: 'openai-compatible', baseUrl: 'https://model.test', model: 'synthetic', timeoutMs: 1000 },
    { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    'memory-key',
    false,
  );
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = render(createElement(SearchResults, { query: 'example', settings }));
  expect(fetcher).not.toHaveBeenCalled();
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'AI 帮我找' }));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  expect(screen.getByRole('region', { name: '搜索结果' })).toHaveAttribute('aria-busy', 'true');
  // A native change outside the candidates reaches both the view and the shared authority mid-flight and is not a cancellation.
  const grown = searchTree(4);
  grown.observedRevision = 2;
  await act(async () => {
    listeners.forEach(listener => listener({ status: 'loading' }));
    listeners.forEach(listener => listener({ status: 'ready', snapshot: grown }));
  });
  expect(screen.getByRole('region', { name: '搜索结果' })).toHaveAttribute('aria-busy', 'true');
  await act(async () => {
    finish(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"matchedIds":["2"],"unmatchedIds":["1","3"],"uncertainIds":[]}' } }],
        }),
      ),
    );
  });
  expect(view.container.querySelector('.search-hit-list .search-hit-open')).toHaveTextContent('Bookmark 1');
  expect(view.container.querySelectorAll('.search-hit-list li')).toHaveLength(1);
  expect(screen.getByText('书签已变化，当前结果尚未覆盖最新书签，请重新搜索。')).toBeVisible();
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => {
    invalidations.forEach(listener => listener());
  });
  expect(view.container.querySelector('.search-hit-list .search-hit-open')).toHaveTextContent('重庆大学');
  expect(JSON.stringify(data)).not.toContain('memory-key');
  view.unmount();
  settings.dispose();
  expect(invalidations.size).toBe(0);
});
it('shows bilingual paused coverage and resumes only remaining bookmarks through the real controller', async () => {
  const { SettingsStore } = await import('../persistence/settings');
  snapshot = searchFolders();
  chromeStub();
  const event = { addListener: () => {}, removeListener: () => {} };
  Object.assign(chrome, {
    storage: { onChanged: event },
    permissions: { onRemoved: event, contains: async () => true },
  });
  const data: Record<string, unknown> = {};
  const settings = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async value => {
        Object.assign(data, value);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    operation => operation(),
  );
  await settings.load();
  await settings.save(
    { adapter: 'openai-compatible', baseUrl: 'https://model.test', model: 'synthetic', timeoutMs: 1000 },
    {
      fullUrl: false,
      bodyEnabled: false,
      excludedFolders: [snapshot.nodes.find(node => node.ref.nativeId === 'private')!.ref],
    },
    '',
    false,
  );
  const requests: { task: string; items: { id: string }[] }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (_url, init) => {
      const input: { task: string; items: { id: string }[] } = JSON.parse(
        JSON.parse(String(init?.body)).messages[1].content,
      );
      requests.push(input);
      const ids = input.items.map(item => item.id);
      const output =
        input.task === 'search-plan'
          ? { folderIds: ['useful', 'early', 'misc'], terms: [] }
          : {
              matchedIds: ids.filter(id => id === '81'),
              unmatchedIds: ids.filter(id => id !== '81'),
              uncertainIds: [],
            };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }),
      );
    }),
  );
  const view = render(
    createElement(LocaleProvider, null, createElement(SearchResults, { query: '找个画图工具', settings })),
  );
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'AI 帮我找' }));
  });
  expect(screen.getByRole('button', { name: '继续搜索剩余书签' })).toBeVisible();
  expect(screen.getByText('已检查 100 / 240 条 · 匹配 1 条 · 无法确定 0 条')).toBeVisible();
  expect(requests).toHaveLength(2);
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'en' })));
  expect(screen.getByRole('button', { name: 'Search remaining bookmarks' })).toBeVisible();
  expect(screen.getByText('Checked 100 / 240 · Matches 1 · Uncertain 0')).toBeVisible();
  expect(requests).toHaveLength(2);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Search remaining bookmarks' }));
  });
  expect(screen.queryByRole('button', { name: 'Search remaining bookmarks' })).toBeNull();
  expect(screen.getByText('Checked 240 / 240 · Matches 1 · Uncertain 0')).toBeVisible();
  const ids = requests.flatMap(input => input.items.map(item => item.id));
  expect(ids).toHaveLength(240);
  expect(new Set(ids).size).toBe(240);
  const selected = snapshot.nodes.find(node => node.ref.nativeId === 'useful')!.ref;
  fireEvent.change(screen.getByRole('combobox', { name: 'Search folder' }), {
    target: { value: JSON.stringify(selected) },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Find with AI' }));
  });
  expect(requests).toHaveLength(5);
  expect(requests.at(-1)!.items.map(item => item.id)).toEqual(Array.from({ length: 80 }, (_, i) => String(i + 81)));
  expect(screen.getByText('Checked 80 / 80 · Matches 1 · Uncertain 0')).toBeVisible();
  view.unmount();
  settings.dispose();
});

it.each(['panel', 'options'] as const)(
  'keeps folder/time selection and result hierarchy through locale changes in %s',
  page => {
    chromeStub();
    snapshot = searchFolders();
    snapshot.nodes.find(node => node.ref.nativeId === '81')!.dateAdded = Date.now() - 86400000;
    snapshot.nodes.find(node => node.ref.nativeId === '82')!.dateAdded = Date.now() - 20 * 86400000;
    location.hash = '#browse';
    const fetcher = vi.spyOn(globalThis, 'fetch');
    render(createElement(App, { page }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'example' } });
    const folder = screen.getByRole('combobox', { name: '搜索文件夹' });
    const region = screen.getByRole('region', { name: '搜索结果' });
    const heading = within(region).getByRole('heading', { name: '搜索结果' });
    expect(folder).toHaveValue('');
    expect(folder.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    const selected = snapshot.nodes.find(node => node.ref.nativeId === 'useful')!.ref;
    fireEvent.change(folder, { target: { value: JSON.stringify(selected) } });
    expect(region.querySelectorAll('.search-hit-open')).toHaveLength(80);
    fireEvent.change(screen.getByRole('combobox', { name: '收藏时间' }), { target: { value: '7' } });
    expect(region.querySelectorAll('.search-hit-open')).toHaveLength(1);
    expect(within(region).getByRole('button', { name: 'Bookmark 80' })).toBeVisible();
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'en' })));
    expect(screen.getByRole('combobox', { name: 'Search folder' })).toBe(folder);
    expect(folder).toHaveValue(JSON.stringify(selected));
    expect(screen.getByRole('combobox', { name: 'Date saved' })).toHaveValue('7');
    expect(screen.getByRole('searchbox')).toHaveValue('example');
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it('keeps a deleted folder visibly unavailable until the user chooses a new scope', () => {
  chromeStub();
  snapshot = searchFolders();
  render(createElement(SearchResults, { query: 'example' }));
  const folder = screen.getByRole('combobox', { name: '搜索文件夹' });
  const selected = snapshot.nodes.find(node => node.ref.nativeId === 'useful')!.ref;
  fireEvent.change(folder, { target: { value: JSON.stringify(selected) } });
  const deleted = structuredClone(snapshot);
  const ids = new Set(['useful', ...Array.from({ length: 80 }, (_, i) => String(i + 81))]);
  deleted.nodes = deleted.nodes.filter(node => !ids.has(node.ref.nativeId));
  deleted.nodes.forEach(node => {
    node.childrenIds = node.childrenIds.filter(id => !ids.has(id));
  });
  act(() => listeners.forEach(listener => listener({ status: 'ready', snapshot: deleted })));
  expect(folder).toHaveValue(JSON.stringify(selected));
  expect(screen.getByRole('alert')).toHaveTextContent('所选文件夹已不可用');
  expect(screen.queryByRole('button', { name: 'Bookmark 80' })).toBeNull();
  fireEvent.change(folder, { target: { value: '' } });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByRole('button', { name: '重庆大学' })).toBeVisible();
});

it('actual options App side nav and write-intent search route to the retained organizer without model or write effects', () => {
  chromeStub();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  location.hash = '#browse';
  render(createElement(App, { page: 'options' }));
  const nav = screen.getByRole('navigation', { name: '设置导航' });
  fireEvent.click(within(nav).getByRole('button', { name: 'AI 整理' }));
  expect(screen.getByRole('region', { name: '整理工作台' })).toBeVisible();
  fireEvent.click(within(nav).getByRole('button', { name: '书签目录' }));
  expect(screen.queryByRole('region', { name: '整理工作台' })).toBeNull();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '整理学习资料' } });
  fireEvent.click(screen.getByRole('button', { name: '前往整理工作台' }));
  expect(screen.getByRole('region', { name: '整理工作台' })).toBeVisible();
  expect(fetcher).not.toHaveBeenCalled();
});
it('popup write-intent search hands the organizer over to the options page instead of hosting it', () => {
  chromeStub();
  const create = vi.fn(async () => ({ id: 1 }));
  vi.stubGlobal('chrome', {
    ...chrome,
    runtime: { ...chrome.runtime, getURL: (path: string) => `chrome-extension://i/${path}` },
    tabs: { create },
  });
  vi.stubGlobal('close', vi.fn());
  render(createElement(App, { page: 'panel' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '整理学习资料' } });
  fireEvent.click(screen.getByRole('button', { name: '前往整理工作台' }));
  expect(create).toHaveBeenCalledWith({ url: 'chrome-extension://i/options/index.html#organize' });
  expect(screen.queryByRole('region', { name: '整理工作台' })).toBeNull();
  expect(screen.getByRole('searchbox')).toHaveValue('整理学习资料');
});
