import { expect, it, vi } from 'vitest';
import { SearchController, type SearchState } from '../panel/search-controller';
import { ModelTransport } from '../adapters/model-transport';
import { searchTree } from './fixtures/search-tree';
import { parseModelOutput } from '../schemas/model-output';
import { SearchIndex } from '../domain/search-index';
import { localSearchRule } from '../domain/search-local-query';

function setup(fetcher: typeof fetch, count = 203, requestBytes?: number) {
  const tree = searchTree(count);
  const folder = {
    ...tree.nodes[0]!,
    ref: { ...tree.nodes[0]!.ref, nativeId: 'private' },
    parentId: '0',
    title: 'Private',
    childrenIds: ['private-bookmark'],
  };
  tree.nodes.push(folder, {
    ...tree.nodes[1]!,
    ref: { ...tree.nodes[1]!.ref, nativeId: 'private-bookmark' },
    parentId: 'private',
    title: 'diagrams.net private secret',
    url: 'https://secret.example.test/',
  });
  tree.nodes[0]!.childrenIds.push('private');
  const context = {
    version: 1 as const,
    revision: 'r',
    sessionRevision: 0,
    tree,
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [folder.ref] },
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://search.test/v1',
      model: 'synthetic',
      timeoutMs: 1000,
    },
    key: '',
  };
  const listeners = new Set<() => void>();
  const authority = {
    read: async () => structuredClone(context),
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  const transport = new ModelTransport(
    { fetch: fetcher, contains: async () => true },
    authority,
    requestBytes ? { requestBytes, responseBytes: 1024 * 1024 } : undefined,
  );
  let state!: SearchState;
  const states: SearchState[] = [];
  const controller = new SearchController(
    value => {
      state = value;
      states.push(value);
    },
    authority,
    transport,
  );
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.setQuery('找出所有能把想法画成关系图的书签');
  return {
    controller,
    context,
    transport,
    states,
    state: () => state,
    invalidate: () => listeners.forEach(fn => fn()),
  };
}
function reply(output: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }),
  );
}
function payload(init?: RequestInit): { task: string; query: string; items: { id: string; title: string }[] } {
  return JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
}
function output(ids: string[], matchedIds = ids, uncertainIds: string[] = []) {
  return {
    matchedIds,
    unmatchedIds: ids.filter(id => !matchedIds.includes(id) && !uncertainIds.includes(id)),
    uncertainIds,
  };
}

it('checks every permitted bookmark in 100-item batches and publishes before the next reply', async () => {
  const offered: string[][] = [];
  let release!: () => void;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const input = payload(init);
    expect(input.task).toBe('search-batch');
    expect(input.query).toBe('找出所有能把想法画成关系图的书签');
    const ids = input.items.map(item => item.id);
    offered.push(ids);
    if (offered.length === 2)
      await new Promise<void>(resolve => {
        release = resolve;
      });
    return reply(output(ids));
  });
  const h = setup(fetcher);
  const pending = h.controller.rerank();
  await vi.waitFor(() => expect(offered).toHaveLength(2));
  expect(h.state().hits).toHaveLength(100);
  expect(h.state().progress).toMatchObject({ checked: 100, total: 203, excluded: 1, complete: false });
  expect(h.state().reranking).toBe(true);
  expect(h.controller.open('1', vi.fn())).toBe(true);
  release();
  await pending;
  expect(offered.map(ids => ids.length)).toEqual([100, 100, 3]);
  expect(new Set(offered.flat()).size).toBe(203);
  expect(h.state().hits).toHaveLength(203);
  expect(h.state().progress?.complete).toBe(true);
  expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(/private-bookmark|secret\.example|secret=yes/);
  h.controller.dispose();
});

it('finds a semantic result in the last batch with zero local recall, including flat roots', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const ids = payload(init).items.map(item => item.id);
    return reply(output(ids, ids.includes('501') ? ['501'] : []));
  });
  const h = setup(fetcher, 501);
  expect(h.state().hits).toEqual([]);
  await h.controller.rerank();
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(h.state().hits.map(hit => hit.id)).toEqual(['501']);
  h.controller.dispose();
});

it.each(['cancel', 'network', 'schema', 'query', 'settings'] as const)(
  'handles %s during a later batch without losing accepted work or accepting a late reply',
  async kind => {
    let release!: (response: Response) => void;
    let fail!: (error: Error) => void;
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const ids = payload(init).items.map(item => item.id);
      if (++calls === 2)
        return new Promise<Response>((resolve, reject) => {
          release = resolve;
          fail = reject;
        });
      return reply(output(ids, [ids[0]!]));
    });
    const h = setup(fetcher);
    const pending = h.controller.rerank();
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(h.state().hits.map(hit => hit.id)).toEqual(['1']);
    if (kind === 'cancel') h.controller.cancel();
    if (kind === 'query') h.controller.setQuery('unrelated-new-query');
    if (kind === 'settings') h.invalidate();
    if (kind === 'network') fail(Error('offline'));
    else
      release(
        reply(
          kind === 'schema'
            ? { matchedIds: [], unmatchedIds: [], uncertainIds: [] }
            : output(Array.from({ length: 100 }, (_, i) => String(i + 101))),
        ),
      );
    await pending;
    expect(calls).toBe(2);
    expect(h.state().reranking).toBe(false);
    if (kind === 'query' || kind === 'settings') expect(h.state().hits).toEqual([]);
    else {
      expect(h.state().hits.map(hit => hit.id)).toEqual(['1']);
      expect(h.state().progress).toMatchObject({ checked: 100, complete: false });
      expect(h.state().message).toContain('未完成');
    }
    h.controller.dispose();
  },
);

it('does not append locally matched items rejected by the model; uncertainty and private local hits stay separate', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    reply(
      output(
        payload(init).items.map(item => item.id),
        ['2'],
        ['3'],
      ),
    ),
  );
  const h = setup(fetcher, 4);
  h.controller.setQuery('example');
  await h.controller.rerank();
  expect(h.state().hits.map(hit => hit.id)).toEqual(['2']);
  expect(h.state().uncertainHits?.map(hit => hit.id)).toEqual(['3']);
  expect(h.state().localOnlyHits?.map(hit => hit.id)).toEqual(['private-bookmark']);
  expect(h.controller.open('3', vi.fn())).toBe(true);
  expect(h.controller.open('private-bookmark', vi.fn())).toBe(true);
  expect(h.controller.open('1', vi.fn())).toBe(false);
  h.controller.dispose();
});

it.each(['title', 'url', 'path', 'new'] as const)(
  'marks %s changes incomplete and drops stale accepted hits',
  async field => {
    let calls = 0;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (++calls === 2) {
        const next = structuredClone(h.context.tree);
        if (field === 'new') next.nodes.push({ ...next.nodes[1]!, ref: { ...next.nodes[1]!.ref, nativeId: 'added' } });
        else if (field === 'path') next.nodes[1]!.parentId = 'private';
        else next.nodes[1]![field] = field === 'url' ? 'https://changed.test/' : 'Changed';
        h.context.tree = next;
        h.controller.setTree({ status: 'ready', snapshot: next });
      }
      return reply(output(payload(init).items.map(item => item.id)));
    });
    const h = setup(fetcher);
    await h.controller.rerank();
    expect(h.state().progress).toMatchObject({ complete: false, changed: true });
    expect(h.state().hits.some(hit => hit.id === '1')).toBe(field === 'new');
    expect(h.state().hits.some(hit => hit.id === 'added')).toBe(false);
    expect(h.state().message).toContain('书签已变化');
    h.controller.dispose();
  },
);

it('splits by actual envelope size without dropping or truncating items', async () => {
  const offered: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new TextEncoder().encode(String(init?.body)).length).toBeLessThanOrEqual(9000);
    const input = payload(init);
    offered.push(...input.items.map(item => item.id));
    expect(input.items.every(item => item.title.length > 900)).toBe(true);
    return reply(output(input.items.map(item => item.id)));
  });
  const h = setup(fetcher, 10, 9000);
  h.context.tree.nodes
    .filter(node => node.ref.kind === 'bookmark')
    .forEach(node => {
      node.title = '长标题'.repeat(310);
    });
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  await h.controller.rerank();
  expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  expect(offered).toEqual(Array.from({ length: 10 }, (_, i) => String(i + 1)));
  expect(h.state().progress?.complete).toBe(true);
  h.controller.dispose();
});

it('reports an indivisible oversized item without sending or marking it irrelevant', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const h = setup(fetcher, 1, 5000);
  h.context.tree.nodes[1]!.title = 'x'.repeat(6000);
  h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
  await h.controller.rerank();
  expect(fetcher).not.toHaveBeenCalled();
  expect(h.state().progress).toMatchObject({ checked: 0, total: 1, complete: false });
  expect(h.state().message).toContain('单条书签');
  h.controller.dispose();
});

it('does not resurrect judgments from a different installation during a disconnect', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => reply(output(payload(init).items.map(item => item.id))));
  const h = setup(fetcher, 2);
  await h.controller.rerank();
  const next = structuredClone(h.context.tree);
  next.installationId = 'another-installation';
  next.nodes.forEach(node => {
    node.ref.installationId = next.installationId;
  });
  h.controller.setTree({ status: 'ready', snapshot: next });
  expect(h.state().hits).toEqual([]);
  h.controller.setTree({ status: 'loading' });
  expect(h.state().hits).toEqual([]);
  expect(h.state().progress?.complete).toBe(false);
  h.controller.dispose();
});

it('a later model timeout preserves accepted earlier batches', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (++calls === 2) return new Promise<Response>(() => {});
    return reply(output(payload(init).items.map(item => item.id)));
  });
  const h = setup(fetcher);
  const pending = h.controller.rerank();
  await vi.advanceTimersByTimeAsync(0);
  expect(calls).toBe(2);
  await vi.advanceTimersByTimeAsync(1000);
  await pending;
  expect(h.state().hits).toHaveLength(100);
  expect(h.state().progress).toMatchObject({ checked: 100, complete: false });
  expect(h.state().message).toContain('模型搜索超时');
  h.controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it.each([
  { matchedIds: ['1'], unmatchedIds: [], uncertainIds: [] },
  { matchedIds: ['1', '1'], unmatchedIds: ['2'], uncertainIds: [] },
  { matchedIds: ['1'], unmatchedIds: ['2'], uncertainIds: ['1'] },
  { matchedIds: ['unknown'], unmatchedIds: ['2'], uncertainIds: [] },
  { matchedIds: ['1', '2'], unmatchedIds: [] },
])('rejects incomplete, duplicate, unknown or missing decisions: %j', result => {
  expect(() =>
    parseModelOutput(result, {
      task: 'search-batch',
      items: [
        { id: '1', title: '' },
        { id: '2', title: '' },
      ],
      folders: [],
    }),
  ).toThrow('invalid-output');
});

it.each(['我想要所有的知乎文章', '所有知乎的书签', '知乎', 'site:zhihu.com', 'all bookmarks from zhihu.com'])(
  'resolves the complete site query locally: %s',
  async query => {
    const fetcher = vi.fn<typeof fetch>();
    const h = setup(fetcher, 203);
    h.context.tree.nodes
      .filter(n => n.ref.kind === 'bookmark')
      .forEach(n => {
        n.url = 'https://zhuanlan.zhihu.com/p/123';
      });
    h.controller.setTree({ status: 'ready', snapshot: h.context.tree });
    h.controller.setQuery(query);
    await h.controller.rerank();
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.state().hits).toHaveLength(204); // Includes the private folder locally, without disclosure.
    expect(h.state().progress?.complete).toBe(true);
    h.controller.dispose();
  },
);

it('uses exact hostname boundaries and never confuses query strings or suffixes with a site', () => {
  const rule = localSearchRule('site:zhihu.com', searchTree())!;
  const hit = new SearchIndex(searchTree()).all()[0]!;
  for (const url of ['https://evilzhihu.com/', 'https://zhihu.com.evil.test/', 'https://other.test/?url=zhihu.com'])
    expect(rule.matches({ ...hit, url })).toBe(false);
  expect(rule.matches({ ...hit, url: 'https://www.zhihu.com/question/1' })).toBe(true);
});
it.each([
  '知乎关于Python的文章',
  '知乎不要招聘',
  '关于知乎的文章',
  '不是知乎的书签',
  '知乎或掘金的文章',
  'site:zhihu.com Python',
  '只要知乎专栏文章',
  'constructor',
  '__proto__',
  'toString',
])('does not discard extra conditions: %s', query => {
  expect(localSearchRule(query, searchTree())).toBeUndefined();
});
it('matches explicit unique folder subtrees and falls back for ambiguous folder names', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const h = setup(fetcher, 4);
  h.controller.setQuery('folder:"学习资料"');
  await h.controller.rerank();
  expect(h.state().hits).toHaveLength(5);
  expect(fetcher).not.toHaveBeenCalled();
  expect(localSearchRule('文件夹“学习资料”里的所有书签', h.context.tree)?.kind).toBe('folder');
  h.context.tree.nodes.find(n => n.ref.nativeId === 'private')!.title = '学习资料';
  expect(localSearchRule('folder:"学习资料"', h.context.tree)).toBeUndefined();
  expect(localSearchRule('文件夹“学习资料”里关于Python的书签', h.context.tree)).toBeUndefined();
  h.controller.dispose();
});
