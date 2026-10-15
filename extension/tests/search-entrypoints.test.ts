import { expect, it, vi } from 'vitest';
import { startSearchEntrypoints } from '../background/search-entrypoints';
import { searchTree } from './fixtures/search-tree';
import type { TreeState } from '../domain/node-reference';

function event<T extends (...args: never[]) => unknown>() {
  let listener: T;
  return {
    addListener: (value: T) => {
      listener = value;
    },
    fire: (...args: Parameters<T>) => listener(...args),
  };
}
function setup(ready = true) {
  const snapshot = searchTree(12);
  const projection = {
    state: (ready ? { status: 'ready', snapshot } : { status: 'loading' }) as TreeState,
    fresh: vi.fn(async () => snapshot),
  };
  const browser = {
    runtime: {
      id: 'test',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage:
        event<(message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean>(),
    },
    commands: { onCommand: event<(command: string) => void>() },
    omnibox: {
      onInputStarted: event<() => void>(),
      onInputCancelled: event<() => void>(),
      onInputChanged: event<(text: string, suggest: (results: chrome.omnibox.SuggestResult[]) => void) => void>(),
      onInputEntered: event<(text: string, disposition: string) => void>(),
      setDefaultSuggestion: vi.fn(),
    },
    tabs: {
      query: vi.fn(async () => [{ id: 7 }]),
      update: vi.fn<(id: number, properties: { url: string }) => Promise<object>>(async () => ({})),
      create: vi.fn<(properties: { url: string; active: boolean }) => Promise<object>>(async () => ({})),
    },
  };
  startSearchEntrypoints(projection, browser as unknown as Parameters<typeof startSearchEntrypoints>[1]);
  return { browser, projection, snapshot };
}
const flush = async () => {
  await new Promise(resolve => setTimeout(resolve, 0));
};

it('bounded local suggestions escape XML, exclude unsafe protocols, and never navigate on typing', async () => {
  const { browser, snapshot } = setup();
  snapshot.nodes[1]!.title = '<tag>&"\' example';
  snapshot.nodes[2]!.url = 'javascript:example()';
  const suggest = vi.fn();
  browser.omnibox.onInputChanged.fire('example', suggest);
  await flush();
  const results = suggest.mock.calls[0]![0] as chrome.omnibox.SuggestResult[];
  expect(results).toHaveLength(8);
  expect(results[0]!.description).toContain('&lt;tag&gt;&amp;&quot;&apos;');
  expect(results.every(result => result.content.startsWith('zhilan-result:'))).toBe(true);
  expect(browser.tabs.create).not.toHaveBeenCalled();
  expect(browser.tabs.update).not.toHaveBeenCalled();
});
it('cancel and a later query fence asynchronous reads and stale suggestions', async () => {
  const { browser, projection, snapshot } = setup(false);
  let resolve!: (value: typeof snapshot) => void;
  projection.fresh.mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const first = vi.fn();
  browser.omnibox.onInputChanged.fire('old', first);
  browser.omnibox.onInputCancelled.fire();
  resolve(snapshot);
  await flush();
  expect(first).not.toHaveBeenCalled();
  browser.omnibox.onInputChanged.fire('old', first);
  const oldResolve = resolve;
  const second = vi.fn();
  browser.omnibox.onInputChanged.fire('cqdx', second);
  oldResolve(snapshot);
  resolve(snapshot);
  await flush();
  expect(first).not.toHaveBeenCalled();
  expect(second.mock.calls[0]![0]).toHaveLength(1);
});
it.each(['currentTab', 'newForegroundTab', 'newBackgroundTab'])(
  'fresh native identity opens only on Enter with %s',
  async disposition => {
    const { browser, projection, snapshot } = setup();
    const suggest = vi.fn();
    browser.omnibox.onInputChanged.fire('cqdx', suggest);
    await flush();
    browser.omnibox.onInputEntered.fire(suggest.mock.calls[0]![0][0].content, disposition);
    await flush();
    expect(projection.fresh).toHaveBeenCalledOnce();
    if (disposition === 'currentTab')
      expect(browser.tabs.update).toHaveBeenCalledWith(7, { url: snapshot.nodes[1]!.url });
    else
      expect(browser.tabs.create).toHaveBeenCalledWith({
        url: snapshot.nodes[1]!.url,
        active: disposition !== 'newBackgroundTab',
      });
  },
);
it.each(['deleted', 'url', 'installation'])(
  'stale %s falls back to query UI; one-use launch requires the exact top-level options sender',
  async change => {
    const { browser, snapshot } = setup();
    const suggest = vi.fn();
    browser.omnibox.onInputChanged.fire('cqdx', suggest);
    await flush();
    if (change === 'deleted') snapshot.nodes.splice(1, 1);
    if (change === 'url') snapshot.nodes[1]!.url = 'https://changed.test/';
    if (change === 'installation') snapshot.installationId = 'other';
    browser.omnibox.onInputEntered.fire(suggest.mock.calls[0]![0][0].content, 'currentTab');
    await flush();
    const url = browser.tabs.update.mock.calls[0]![1].url as string;
    expect(url).toMatch(/^chrome-extension:\/\/test\/options\/index.html#search\/[\w-]+$/);
    expect(url).not.toContain('cqdx');
    const token = url.split('/').at(-1)!;
    const reply = vi.fn();
    const sender = { id: 'test', url, frameId: 0 };
    const message = { type: 'claimSearchLaunch', token };
    browser.runtime.onMessage.fire(message, { ...sender, frameId: 1 }, reply);
    browser.runtime.onMessage.fire(message, { ...sender, url: url.replace('options', 'panel') }, reply);
    expect(reply).not.toHaveBeenCalled();
    browser.runtime.onMessage.fire(message, sender, reply);
    expect(reply).toHaveBeenLastCalledWith({ query: 'cqdx' });
    browser.runtime.onMessage.fire(message, sender, reply);
    expect(reply).toHaveBeenLastCalledWith({ error: 'expired' });
  },
);
it('raw input opens search, not an arbitrary URL; save command does not activate search', async () => {
  const { browser } = setup();
  browser.commands.onCommand.fire('save-current-page');
  expect(browser.tabs.create).not.toHaveBeenCalled();
  browser.omnibox.onInputEntered.fire('https://arbitrary.test/', 'newBackgroundTab');
  await flush();
  expect(browser.tabs.create).toHaveBeenCalledWith({ url: expect.stringContaining('#search/'), active: false });
  browser.commands.onCommand.fire('search-bookmarks');
  await flush();
  expect(browser.tabs.create).toHaveBeenLastCalledWith({ url: expect.stringContaining('#search/'), active: true });
});
it('launch expires and an unknown selection never becomes a URL', async () => {
  const { browser } = setup();
  browser.omnibox.onInputEntered.fire('zhilan-result:old', 'newForegroundTab');
  await flush();
  const url = browser.tabs.create.mock.calls[0]![0].url as string;
  const reply = vi.fn();
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
  browser.runtime.onMessage.fire(
    { type: 'claimSearchLaunch', token: url.split('/').at(-1) },
    { id: 'test', url, frameId: 0 },
    reply,
  );
  now.mockRestore();
  expect(reply).toHaveBeenCalledWith({ error: 'expired' });
});
it('native read failure preserves background-tab intent and refuses the cached URL', async () => {
  const { browser, projection } = setup();
  const suggest = vi.fn();
  browser.omnibox.onInputChanged.fire('cqdx', suggest);
  await flush();
  projection.fresh.mockRejectedValue(new Error('unavailable'));
  browser.omnibox.onInputEntered.fire(suggest.mock.calls[0]![0][0].content, 'newBackgroundTab');
  await flush();
  expect(browser.tabs.create).toHaveBeenCalledWith({ url: expect.stringContaining('#search/'), active: false });
  expect(browser.tabs.update).not.toHaveBeenCalled();
});
