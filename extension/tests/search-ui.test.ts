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
it('production App input reaches search without model calls or writes', () => {
  chromeStub();
  const fetcher = vi.spyOn(globalThis, 'fetch');
  render(createElement(App, { page: 'panel' }));
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'cqdx' } });
  expect(
    within(screen.getByRole('region', { name: '搜索结果' })).getByRole('button', { name: /重庆大学/ }),
  ).toBeVisible();
  const row = screen.getByRole('button', { name: /^重庆大学$/ });
  expect(row).toHaveTextContent(/^重庆大学$/);
  expect(row).not.toHaveTextContent('https://');
  expect(row).not.toHaveTextContent('学习资料');
  expect(fetcher).not.toHaveBeenCalled();
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
  const result = screen.getByRole('button', { name: /重庆大学/ });
  expect(open).not.toHaveBeenCalled();
  for (const name of APPEARANCES) {
    await user.click(screen.getByRole('radio', { name }));
    expect(screen.getByRole('button', { name: /重庆大学/ })).toBe(result);
  }
  result.focus();
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledOnce();
  await user.click(result);
  expect(open).toHaveBeenCalledTimes(2);
  act(() => listeners.forEach(listener => listener({ status: 'loading' })));
  expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'true');
  act(() => listeners.forEach(listener => listener({ status: 'error', message: '合成断线' })));
  expect(screen.getByRole('alert')).toHaveTextContent('合成断线');
  view.rerender(createElement(SearchResults, { query: 'nonexistent' }));
  expect(screen.getByText(/没有匹配/)).toBeVisible();
  view.rerender(createElement(SearchResults, { query: '整理学习资料' }));
  expect(screen.getByRole('note')).toHaveTextContent('整理工作台');
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
  expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'true');
  // A native change outside the candidates reaches both the view and the shared authority mid-flight and is not a cancellation.
  const grown = searchTree(4);
  grown.observedRevision = 2;
  await act(async () => {
    listeners.forEach(listener => listener({ status: 'loading' }));
    listeners.forEach(listener => listener({ status: 'ready', snapshot: grown }));
  });
  expect(screen.getByRole('region')).toHaveAttribute('aria-busy', 'true');
  await act(async () => {
    finish(new Response(JSON.stringify({ choices: [{ message: { content: '{"rankedIds":["2"]}' } }] })));
  });
  expect(view.container.querySelector('.search-hit-list button')).toHaveTextContent('Bookmark 1');
  expect(view.container.querySelectorAll('.search-hit-list li')).toHaveLength(4);
  expect(fetcher).toHaveBeenCalledOnce();
  await act(async () => {
    invalidations.forEach(listener => listener());
  });
  expect(view.container.querySelector('.search-hit-list button')).toHaveTextContent('重庆大学');
  expect(JSON.stringify(data)).not.toContain('memory-key');
  view.unmount();
  settings.dispose();
  expect(invalidations.size).toBe(0);
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
