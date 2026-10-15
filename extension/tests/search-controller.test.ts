import { expect, it, vi } from 'vitest';
import { SearchController, type SearchState } from '../panel/search-controller';
import { ModelTransport } from '../adapters/model-transport';
import type { AiPrivacy } from '../domain/ai-payload';
import type { ModelAuthority } from '../adapters/model-authority';
import { searchTree } from './fixtures/search-tree';
function setup() {
  const tree = searchTree(12);
  const listeners = new Set<() => void>();
  const context = {
    tree,
    version: 1 as const,
    revision: 'r',
    sessionRevision: 0,
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://model.test',
      model: 'synthetic',
      timeoutMs: 10000,
    },
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] } as AiPrivacy,
    key: 'synthetic-key',
  };
  const authority: ModelAuthority = {
    read: async () => structuredClone(context),
    subscribe: listener => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  let release!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>(resolve => {
        release = resolve;
      }),
  );
  let state!: SearchState;
  const controller = new SearchController(
    value => {
      state = value;
    },
    authority,
    new ModelTransport({ fetch: fetcher, contains: async () => true }, authority),
  );
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.setQuery('example');
  return {
    controller,
    context,
    authority,
    fetcher,
    state: () => state,
    invalidate: () => {
      for (const listener of listeners) listener();
    },
    respond: (rankedIds: string[]) =>
      release(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rankedIds }) } }] }))),
  };
}
it('uses actual transport and privacy projection; explicit request only, no automatic opening', async () => {
  const f = setup();
  expect(f.fetcher).not.toHaveBeenCalled();
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  const call = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(call[1].body));
  const payload = JSON.parse(body.messages[1].content);
  expect(payload.query).toBe('example');
  expect(payload.items).toHaveLength(12);
  expect(payload.folderTree).toBe('');
  expect(body.messages).toHaveLength(2);
  expect(body.messages[0].content).toContain('rank the given items by relevance to the query');
  expect(body.messages[0].content).not.toContain('Depth policy');
  expect(JSON.stringify(payload)).not.toContain('secret=');
  expect(JSON.stringify(payload)).not.toContain('#part');
  f.respond(['2', '1']);
  await pending;
  expect(f.state().hits[0]?.id).toBe('2');
  expect(f.state().hits).toHaveLength(12);
  f.invalidate();
  expect(f.state().hits[0]?.id).toBe('1');
  f.controller.dispose();
});
it.each(['query', 'tree-loss', 'settings', 'session', 'permission', 'cancel'] as const)(
  'rejects late response after %s invalidation',
  async kind => {
    const f = setup();
    const pending = f.controller.rerank();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    if (kind === 'query') f.controller.setQuery('重庆');
    else if (kind === 'tree-loss') f.controller.setTree({ status: 'loading' });
    else if (kind === 'cancel') f.controller.cancel();
    else {
      if (kind === 'session') f.context.sessionRevision++;
      if (kind === 'settings') f.context.revision = 'new';
      f.invalidate();
    }
    f.respond(['2']);
    await pending;
    expect(f.state().hits[0]?.id).not.toBe('2');
    expect(f.state().reranking).toBe(false);
    f.controller.dispose();
  },
);
it.each([['unknown'], ['1', '1']])('retains local results after invalid IDs %j', async (...ids) => {
  const f = setup();
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  f.respond(ids);
  await pending;
  expect(f.state().hits).toHaveLength(12);
  expect(f.state().message).toContain('未完成');
  f.controller.dispose();
});
it('a tree change outside the candidates during rerank still delivers the order over the current local results', async () => {
  const f = setup();
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  const grown = searchTree(13);
  grown.observedRevision = 2;
  grown.epoch = 'restarted';
  f.context.tree = grown;
  f.controller.setTree({ status: 'ready', snapshot: grown });
  expect(f.state().reranking).toBe(true);
  expect(f.state().hits).toHaveLength(13);
  f.respond(['2', '1']);
  await pending;
  expect(
    f
      .state()
      .hits.map(hit => hit.id)
      .slice(0, 2),
  ).toEqual(['2', '1']);
  expect(f.state().hits).toHaveLength(13);
  expect(f.state().reranking).toBe(false);
  expect(f.state().message).toContain('AI 找到');
  f.controller.dispose();
});
it('a candidate removed locally before the answer arrives is ignored rather than failing the order', async () => {
  const f = setup();
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  const shrunk = searchTree(12);
  shrunk.nodes = shrunk.nodes.filter(node => node.ref.nativeId !== '3');
  shrunk.nodes[0]!.childrenIds = shrunk.nodes[0]!.childrenIds.filter(id => id !== '3');
  f.controller.setTree({ status: 'ready', snapshot: shrunk });
  f.respond(['3', '2']);
  await pending;
  expect(f.state().hits[0]?.id).toBe('2');
  expect(f.state().hits).toHaveLength(11);
  expect(f.state().hits.some(hit => hit.id === '3')).toBe(false);
  f.controller.dispose();
});
it('safe opening resolves current native identity and refuses removed/unsupported results', () => {
  const f = setup();
  const open = vi.fn();
  expect(f.controller.open('1', open)).toBe(true);
  expect(open).toHaveBeenCalledWith(expect.stringContaining('example.com'), '_blank', 'noopener,noreferrer');
  const tree = searchTree();
  tree.nodes = tree.nodes.filter(node => node.ref.nativeId !== '1');
  f.controller.setTree({ status: 'ready', snapshot: tree });
  expect(f.controller.open('1', open)).toBe(false);
  f.controller.dispose();
});
it('excluded subtrees remain local but never trigger transport when no candidate is allowed', async () => {
  const f = setup();
  f.context.privacy.excludedFolders = [f.context.tree.nodes[0]!.ref];
  await f.controller.rerank();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.state().hits).toHaveLength(12);
  f.controller.dispose();
});
it('network failure retains local results without retry', async () => {
  const f = setup();
  f.fetcher.mockRejectedValueOnce(Error('synthetic failure'));
  await f.controller.rerank();
  expect(f.fetcher).toHaveBeenCalledOnce();
  expect(f.state().hits).toHaveLength(12);
  expect(f.state().message).toContain('未完成');
  f.controller.dispose();
});
it('native tree updates remain authoritative across query changes', () => {
  const f = setup();
  const tree = searchTree();
  tree.nodes = tree.nodes.filter(node => node.ref.nativeId !== '1');
  f.invalidate();
  f.controller.setQuery('重庆');
  f.controller.setTree({ status: 'ready', snapshot: tree });
  expect(f.controller.open('1', vi.fn())).toBe(false);
  expect(f.state().hits).toEqual([]);
  f.controller.dispose();
});
it('optional model settings failure retains local results and local safe opening', async () => {
  const f = setup();
  vi.spyOn(f.authority, 'read').mockRejectedValue(Error('settings-unavailable'));
  f.invalidate();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.state().hits).toHaveLength(12);
  expect(f.controller.open('1', vi.fn())).toBe(true);
  await f.controller.rerank();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.state().hits).toHaveLength(12);
  f.controller.setTree({ status: 'ready', snapshot: searchTree() });
  expect(f.controller.open('1', vi.fn())).toBe(true);
  f.controller.dispose();
});

it('finds a semantic match absent from keyword results and beyond the old eight-item limit', async () => {
  const f = setup();
  f.context.tree.nodes[12]!.title = 'diagrams.net';
  f.context.tree.nodes[12]!.url = 'https://app.diagrams.net/?secret=private#part';
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  f.controller.setQuery('之前收藏的那个做流程图的网站');
  expect(f.state().hits).toEqual([]);
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  const call = f.fetcher.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(call[1].body));
  const payload = JSON.parse(body.messages[1].content);
  expect(payload.items.find((item: { id: string }) => item.id === '12')).toEqual({
    id: '12',
    title: 'diagrams.net',
    url: 'https://app.diagrams.net/',
    path: ['学习资料'],
  });
  f.respond(['12']);
  await pending;
  expect(f.state().hits.map(hit => hit.id)).toEqual(['12']);
  expect(f.controller.open('12', vi.fn())).toBe(true);
  f.controller.setTree({ status: 'loading' });
  f.controller.setTree({ status: 'ready', snapshot: structuredClone(f.context.tree) });
  expect(f.state().hits.map(hit => hit.id)).toEqual(['12']);
  const removed = structuredClone(f.context.tree);
  removed.nodes = removed.nodes.filter(node => node.ref.nativeId !== '12');
  f.controller.setTree({ status: 'ready', snapshot: removed });
  expect(f.state().hits).toEqual([]);
  expect(f.controller.open('12', vi.fn())).toBe(false);
  f.controller.setQuery('another description');
  expect(f.state().hits).toEqual([]);
  f.controller.dispose();
});

it('retains a searchable snapshot during disconnect but cannot open stale or deleted results', () => {
  const f = setup();
  f.controller.setTree({ status: 'loading' });
  expect(f.state().hits).toHaveLength(12);
  expect(f.state().connectionReady).toBe(false);
  f.controller.setQuery('重庆');
  expect(f.state().hits.map(hit => hit.id)).toEqual(['1']);
  expect(f.controller.open('1', vi.fn())).toBe(false);
  f.controller.setTree({ status: 'error', message: 'disconnected' });
  expect(f.state().hits).toHaveLength(1);
  const next = searchTree();
  next.nodes = next.nodes.filter(node => node.ref.nativeId !== '1');
  f.controller.setTree({ status: 'ready', snapshot: next });
  expect(f.state().hits).toEqual([]);
  expect(f.controller.open('1', vi.fn())).toBe(false);
  f.controller.dispose();
});

it('a first load without a snapshot cannot invent searchable data', () => {
  let state!: SearchState;
  const controller = new SearchController(value => {
    state = value;
  });
  controller.setQuery('画图');
  controller.setTree({ status: 'error', message: 'failed' });
  expect(state.status).toBe('error');
  expect(state.hits).toEqual([]);
  controller.dispose();
});

it('bounds stalled preparation and ignores its late completion', async () => {
  vi.useFakeTimers();
  const f = setup();
  let finish!: (context: typeof f.context) => void;
  vi.spyOn(f.authority, 'read').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = f.controller.rerank();
  await vi.advanceTimersByTimeAsync(10_000);
  await pending;
  expect(f.state().reranking).toBe(false);
  expect(f.state().message).toContain('读取书签或模型设置超时');
  finish(f.context);
  await Promise.resolve();
  expect(f.fetcher).not.toHaveBeenCalled();
  f.controller.dispose();
  vi.useRealTimers();
});

it('cancellation releases preparation immediately and a newer search owns the UI', async () => {
  const f = setup();
  let finish!: (context: typeof f.context) => void;
  vi.spyOn(f.authority, 'read').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const old = f.controller.rerank();
  f.controller.cancel();
  await old;
  expect(f.state().reranking).toBe(false);
  const current = f.controller.rerank();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  finish(f.context);
  await Promise.resolve();
  expect(f.state().reranking).toBe(true);
  f.respond(['12']);
  await current;
  expect(f.state().hits[0]?.id).toBe('12');
  f.controller.dispose();
});

it('charges preparation time against the configured total deadline', async () => {
  vi.useFakeTimers();
  const f = setup();
  vi.spyOn(f.authority, 'read').mockImplementationOnce(
    () =>
      new Promise(resolve => {
        setTimeout(() => resolve(structuredClone(f.context)), 4000);
      }),
  );
  const pending = f.controller.rerank();
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.fetcher).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(6000);
  await pending;
  expect(f.state().message).toContain('模型搜索超时');
  expect(f.state().hits).toHaveLength(12);
  f.controller.dispose();
  vi.useRealTimers();
});

it('keeps a live semantic-search stream past the former outer total deadline', async () => {
  vi.useFakeTimers();
  const f = setup();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  f.fetcher.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            source = c;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  );
  const pending = f.controller.rerank();
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(7000);
    source.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.state().reranking).toBe(true);
  }
  const chunk = {
    choices: [{ index: 0, delta: { content: JSON.stringify({ rankedIds: ['12'] }) }, finish_reason: 'stop' }],
  };
  source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`));
  source.close();
  await pending;
  expect(f.state().hits[0]?.id).toBe('12');
  expect(f.state().reranking).toBe(false);
  f.controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it('a renamed folder path invalidates semantic results through the actual transport', async () => {
  const f = setup();
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
  f.context.tree.nodes[0]!.title = 'different topic';
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  f.respond(['12']);
  await pending;
  expect(f.state().message).toContain('书签或设置已变化');
  expect(f.state().hits[0]?.id).toBe('1');
  f.controller.dispose();
});
