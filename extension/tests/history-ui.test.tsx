import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SearchWorkspace } from '../panel/SearchWorkspace';
import { HistorySearch } from '../panel/HistorySearch';
import { LocaleProvider, LanguagePicker } from '../ui/i18n';
import { searchTree } from './fixtures/search-tree';
import { SaveCard } from '../panel/SaveCard';
import { SiteRulesStore } from '../persistence/site-rules';
import { useState } from 'react';
import type { SearchSource } from '../domain/history-search';
import { SettingsStore } from '../persistence/settings';

function Workspace({ query = '' }: { query?: string }) {
  const [source, setSource] = useState<SearchSource>('bookmarks');
  const [recent, setRecent] = useState(false);
  return (
    <SearchWorkspace
      query={query}
      source={source}
      onSource={setSource}
      recentBookmarks={recent}
      onRecentBookmarks={setRecent}
    />
  );
}

const snapshot = searchTree();
snapshot.nodes[0]!.childrenWritable = true;
vi.mock('../panel/tree-client', () => ({
  connectTree: (_runtime: unknown, listener: (state: unknown) => void) => {
    listener({ status: 'ready', snapshot });
    return () => {};
  },
}));
function fixture() {
  let allowed = false;
  const removed = new Set<(value: unknown) => void>();
  const item = {
    id: 'visit-item',
    title: 'Synthetic 历史网页',
    url: 'https://history-fixture.test/article?original=1',
    lastVisitTime: Date.now() - 1000,
  };
  const search = vi.fn(async () => [item]);
  const visits = vi.fn(async () => [{ id: item.id, visitTime: item.lastVisitTime }]);
  const request = vi.fn(async () => {
    allowed = true;
    return true;
  });
  const create = vi.fn(async () => ({}));
  const createWindow = vi.fn(async () => ({}));
  const writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const event = {
    addListener: (listener: (value: unknown) => void) => {
      removed.add(listener);
    },
    removeListener: (listener: (value: unknown) => void) => {
      removed.delete(listener);
    },
  };
  const storage = { setAccessLevel: vi.fn(async () => {}), get: vi.fn(async () => ({})), set: vi.fn(async () => {}) };
  vi.stubGlobal('chrome', {
    runtime: { connect: vi.fn(), sendMessage: vi.fn(), getURL: (path: string) => `chrome-extension://test${path}` },
    tabs: { create },
    windows: { create: createWindow },
    permissions: {
      contains: vi.fn(async () => allowed),
      request,
      remove: vi.fn(async () => {
        allowed = false;
        removed.forEach(listener => listener({ permissions: ['history'] }));
        return true;
      }),
      onRemoved: event,
      onAdded: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    history: {
      search,
      getVisits: visits,
      onVisitRemoved: event,
    },
    storage: { local: storage, onChanged: { addListener: vi.fn(), removeListener: vi.fn() } },
  });
  return {
    item,
    search,
    visits,
    request,
    create,
    createWindow,
    writeText,
    storage,
    revoke: () => {
      allowed = false;
      removed.forEach(listener => listener({ permissions: ['history'] }));
    },
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

it('bookmark-only mode neither reads history nor requests permission', () => {
  const h = fixture();
  render(<SearchWorkspace query="cqdx" source="bookmarks" onSource={() => {}} />);
  expect(screen.getByRole('button', { name: '重庆大学' })).toBeVisible();
  expect(h.search).not.toHaveBeenCalled();
  expect(h.request).not.toHaveBeenCalled();
  expect(
    within(screen.getByRole('group', { name: '搜索范围' }))
      .getAllByRole('button')
      .map(button => button.textContent),
  ).toEqual(['目录', '历史']);
});
it('enables history only from a user gesture, opens exact URLs, and clears results on revoke', async () => {
  const h = fixture();
  render(<HistorySearch active query="" />);
  expect(h.request).not.toHaveBeenCalled();
  expect(h.search).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '启用历史查询' }));
  const result = await screen.findByRole('button', { name: h.item.title });
  expect(h.request).toHaveBeenCalledExactlyOnceWith({ permissions: ['history'] });
  fireEvent.click(result);
  await waitFor(() => expect(h.create).toHaveBeenCalledWith({ url: h.item.url, active: true }));
  act(() => h.revoke());
  await waitFor(() => expect(screen.queryByRole('button', { name: h.item.title })).toBeNull());
  expect(screen.getByRole('button', { name: '启用历史查询' })).toBeVisible();
});
it('shows refusal without reading history and keeps bookmark search available after switching back', async () => {
  const h = fixture();
  h.request.mockImplementation(async () => false);
  render(<Workspace query="cqdx" />);
  fireEvent.click(screen.getByRole('button', { name: '历史' }));
  fireEvent.click(screen.getByRole('button', { name: '启用历史查询' }));
  expect(await screen.findByText('未授权历史访问，书签搜索仍可使用。')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: '目录' }));
  expect(screen.getByRole('button', { name: '重庆大学' })).toBeVisible();
  expect(h.search).not.toHaveBeenCalled();
});
it.each(['zh-CN', 'en'] as const)('starts history AI only from the compact search button (%s)', async language => {
  const h = fixture();
  localStorage.setItem('zhilan.language', language);
  const settings = new SettingsStore({ ...h.storage, remove: vi.fn(async () => {}) });
  vi.spyOn(settings, 'snapshot').mockResolvedValue({
    version: 1,
    revision: 'history-ui',
    sessionRevision: 0,
    key: '',
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    config: {
      adapter: 'openai-compatible',
      baseUrl: 'https://model.example.test/v1',
      model: 'synthetic',
      timeoutMs: 5000,
      streaming: false,
    },
  });
  const payloads: { task: string; items: { id: string; url: string }[] }[] = [];
  const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    payloads.push(payload);
    const output =
      payload.task === 'history-query'
        ? { terms: ['history'], startDate: null, endDate: null, domains: [] }
        : { rankedIds: payload.items.map((item: { id: string }) => item.id) };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }),
    );
  });
  const view = render(
    <LocaleProvider>
      <HistorySearch active query="history" settings={settings} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: language === 'en' ? 'Enable history search' : '启用历史查询' }));
  await screen.findByRole('button', { name: h.item.title });
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: language === 'en' ? 'AI history search' : 'AI 查历史' }));
  await screen.findByText(language === 'en' ? 'Compared 1 candidate records' : '已比较 1 条候选记录');
  expect(payloads.map(payload => payload.task)).toEqual(['history-query', 'history-rank']);
  expect(payloads[1]?.items[0]?.url).toBe('https://history-fixture.test/article');
  view.rerender(
    <LocaleProvider>
      <HistorySearch active query="article" settings={settings} />
    </LocaleProvider>,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: language === 'en' ? 'AI history search' : 'AI 查历史' })).toBeEnabled(),
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it('keeps source/range and existing result ownership across language changes without new reads', async () => {
  const h = fixture();
  render(
    <LocaleProvider>
      <LanguagePicker />
      <HistorySearch active query="" />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '启用历史查询' }));
  await screen.findByRole('button', { name: h.item.title });
  fireEvent.change(screen.getByLabelText('时间范围'), { target: { value: 'custom' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '查询历史' })).toBeEnabled());
  await waitFor(() => expect(h.search.mock.calls.length).toBeGreaterThanOrEqual(2));
  const input = screen.getByLabelText('开始日期');
  const reads = h.search.mock.calls.length;
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByLabelText('Start date')).toBe(input);
  expect(screen.getByRole('button', { name: h.item.title })).toBeVisible();
  expect(h.search).toHaveBeenCalledTimes(reads);
});
it('shows already-bookmarked history in its own scope and disables duplicate saving in the menu', async () => {
  const h = fixture();
  h.item.url = snapshot.nodes[1]!.url!;
  h.item.title = '重庆大学';
  render(<Workspace query="cqdx" />);
  fireEvent.click(screen.getByRole('button', { name: '历史' }));
  fireEvent.click(screen.getByRole('button', { name: '启用历史查询' }));
  await waitFor(() => expect(h.search).toHaveBeenCalled());
  expect(screen.getAllByRole('button', { name: '重庆大学' })).toHaveLength(1);
  fireEvent.contextMenu(screen.getByRole('button', { name: '重庆大学' }));
  expect(screen.getByRole('menuitem', { name: '已收藏' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '目录' }));
  expect(screen.queryByRole('menu')).toBeNull();
});

it('uses compact favicon/title rows and verified original URLs for context-menu opening and copying', async () => {
  const h = fixture();
  render(<HistorySearch active query="" />);
  fireEvent.click(screen.getByRole('button', { name: '启用历史查询' }));
  const result = await screen.findByRole('button', { name: h.item.title });
  const icon = result.querySelector('img')!;
  expect(new URL(icon.src).searchParams.get('pageUrl')).toBe(h.item.url);
  expect(within(result.closest('li')!).queryByText('复制链接')).toBeNull();
  fireEvent.contextMenu(result);
  fireEvent.click(screen.getByRole('menuitem', { name: '在新窗口中打开' }));
  await waitFor(() =>
    expect(h.createWindow).toHaveBeenCalledWith({ url: h.item.url, type: 'normal', focused: true, incognito: false }),
  );
  fireEvent.keyDown(result, { key: 'F10', shiftKey: true });
  fireEvent.click(screen.getByRole('menuitem', { name: '在无痕窗口中打开' }));
  await waitFor(() =>
    expect(h.createWindow).toHaveBeenCalledWith({ url: h.item.url, type: 'normal', focused: true, incognito: true }),
  );
  fireEvent.contextMenu(result);
  fireEvent.click(screen.getByRole('menuitem', { name: '复制链接' }));
  await waitFor(() => expect(h.writeText).toHaveBeenCalledWith(h.item.url));
  expect(h.create).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});

it('dismisses menus on Escape, outside click, source switches and history revocation', async () => {
  const h = fixture();
  const view = render(<HistorySearch active query="" />);
  fireEvent.click(screen.getByRole('button', { name: '启用历史查询' }));
  const result = await screen.findByRole('button', { name: h.item.title });
  fireEvent.keyDown(result, { key: 'ContextMenu' });
  expect(screen.getByRole('menu')).toBeVisible();
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.contextMenu(result);
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.contextMenu(result);
  view.rerender(<HistorySearch active={false} query="" />);
  expect(screen.queryByRole('menu')).toBeNull();
  view.rerender(<HistorySearch active query="" />);
  fireEvent.contextMenu(await screen.findByRole('button', { name: h.item.title }));
  act(() => h.revoke());
  expect(screen.queryByRole('menu')).toBeNull();
});

it('context actions reject deleted visits and save opens a retained confirmation draft', async () => {
  const h = fixture();
  render(<Workspace />);
  fireEvent.click(screen.getByRole('button', { name: '历史' }));
  fireEvent.click(screen.getByRole('button', { name: '启用历史查询' }));
  const result = await screen.findByRole('button', { name: h.item.title });
  h.visits.mockResolvedValueOnce([]);
  fireEvent.contextMenu(result);
  fireEvent.click(screen.getByRole('menuitem', { name: '在新标签页打开' }));
  expect(await screen.findByText('此记录已不存在或访问权限已撤销，请重新查询。')).toBeVisible();
  expect(h.create).not.toHaveBeenCalled();
  fireEvent.contextMenu(result);
  fireEvent.click(screen.getByRole('menuitem', { name: '收藏此网页' }));
  expect(await screen.findByRole('heading', { name: '从历史记录收藏' })).toBeVisible();
  const input = screen.getByLabelText('收藏标题');
  fireEvent.change(input, { target: { value: 'Retained draft' } });
  fireEvent.click(screen.getByRole('button', { name: '目录' }));
  expect(screen.getByLabelText('收藏标题')).toBe(input);
  expect(input).toHaveValue('Retained draft');
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
it('history save uses the existing draft without automatic AI, body capture or writes', async () => {
  const h = fixture();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  render(
    <SaveCard
      source="history"
      page={h.item}
      snapshot={snapshot}
      rulesStore={new SiteRulesStore(h.storage)}
      onClose={() => {}}
    />,
  );
  expect(screen.getByRole('heading', { name: '从历史记录收藏' })).toBeVisible();
  await screen.findByRole('button', { name: '确认收藏保存' });
  expect(
    within(screen.getByRole('region', { name: '收藏确认卡' })).queryByRole('checkbox', { name: /本次允许正文辅助/ }),
  ).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
});
