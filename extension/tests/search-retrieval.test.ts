import { expect, it, vi } from 'vitest';
import { SearchController, type SearchState } from '../panel/search-controller';
import { ModelTransport } from '../adapters/model-transport';
import { searchTree } from './fixtures/search-tree';
import { parseModelOutput } from '../schemas/model-output';

function setup(fetcher: typeof fetch) {
  const tree = searchTree(200);
  tree.nodes.find(node => node.ref.nativeId === '190')!.title = 'diagrams.net';
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
  const authority = { read: async () => structuredClone(context), subscribe: () => () => {} };
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  let state!: SearchState;
  const controller = new SearchController(
    value => {
      state = value;
    },
    authority,
    transport,
  );
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.setQuery('我想把想法画成关系图');
  return { controller, state: () => state };
}
function reply(output: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }),
  );
}

it('large-catalog fast search expands only the query and sends bounded privacy-filtered metadata', async () => {
  const payloads: { task: string; items: { id: string }[]; query: string }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    payloads.push(payload);
    return reply(
      payload.task === 'search-expand' ? { terms: ['diagrams.net', 'flowchart', '流程图'] } : { rankedIds: ['190'] },
    );
  });
  const h = setup(fetcher);
  expect(h.state().hits).toEqual([]);
  await h.controller.rerank();
  expect(payloads).toHaveLength(2);
  expect(payloads[0]).toMatchObject({ task: 'search-expand', items: [], query: '我想把想法画成关系图' });
  expect(payloads[1]!.items.length).toBeLessThanOrEqual(80);
  expect(payloads[1]!.items.map(item => item.id)).toContain('190');
  expect(JSON.stringify(payloads)).not.toMatch(/private-bookmark|secret\.example|secret=yes/);
  expect(h.state().hits[0]?.id).toBe('190');
  h.controller.dispose();
});

it('explicit deep search covers every allowed item in bounded segments even with zero lexical recall', async () => {
  const offered: string[][] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    expect(payload.task).toBe('search');
    const ids = payload.items.map((item: { id: string }) => item.id);
    offered.push(ids);
    return reply({ rankedIds: ids.includes('190') ? ['190'] : [] });
  });
  const h = setup(fetcher);
  await h.controller.rerank('deep');
  expect(offered.map(ids => ids.length)).toEqual([80, 80, 40, 1]);
  expect(new Set(offered.slice(0, 3).flat()).size).toBe(200);
  expect(offered.flat()).not.toContain('private-bookmark');
  expect(h.state().hits[0]?.id).toBe('190');
  h.controller.dispose();
});

it('offers deep search when expanded local retrieval has no candidates, without sending the whole catalog', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => reply({ terms: ['nonexistent-synthetic-concept'] }));
  const h = setup(fetcher);
  await h.controller.rerank();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(h.state().hits).toEqual([]);
  expect(h.state().message).toContain('深度搜索');
  h.controller.dispose();
});

it('does not issue candidate requests after cancelling query expansion, even if fetch ignores abort', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise(reply => {
        resolve = reply;
      }),
  );
  const h = setup(fetcher);
  const pending = h.controller.rerank();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  h.controller.cancel();
  resolve(reply({ terms: ['diagrams.net'] }));
  await pending;
  expect(fetcher).toHaveBeenCalledOnce();
  expect(h.state().hits).toEqual([]);
  h.controller.dispose();
});

it.each([
  { terms: [] },
  { terms: ['x'.repeat(65)] },
  { terms: Array(13).fill('x') },
  { terms: ['ok'], rankedIds: ['invented'] },
])('rejects unbounded or mixed query-expansion output: %j', output => {
  expect(() => parseModelOutput(output, { task: 'search-expand', items: [], folders: [] })).toThrow('invalid-output');
});
