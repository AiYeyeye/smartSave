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
  expect(payload.items).toHaveLength(8);
  expect(payload.folders).toEqual([]);
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
it.each(['query', 'tree', 'settings', 'session', 'permission', 'cancel'] as const)(
  'rejects late response after %s invalidation',
  async kind => {
    const f = setup();
    const pending = f.controller.rerank();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    if (kind === 'query') f.controller.setQuery('重庆');
    else if (kind === 'tree') f.controller.setTree({ status: 'loading' });
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
