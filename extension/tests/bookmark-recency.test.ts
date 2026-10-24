import { afterEach, expect, it, vi } from 'vitest';
import { collectionPlan, inCollectionRange, newestBookmarks, queryCollectionRange } from '../domain/bookmark-recency';
import { TreeProjection } from '../background/tree-projection';
import { treeStateSchema } from '../domain/node-reference';
import { SearchController, type SearchState } from '../panel/search-controller';
import { ModelTransport } from '../adapters/model-transport';
import { dependencyDigest } from '../domain/context-dependencies';
import { serializeAiPayload } from '../domain/ai-payload';
import { searchTree } from './fixtures/search-tree';

const DAY = 86400000;
const NOW = new Date(2026, 9, 19, 12).getTime();
afterEach(() => vi.useRealTimers());

it('retains native dates through tree projection and wire parsing, without inventing missing/invalid dates', async () => {
  const projection = new TreeProjection(
    {
      read: async () => [
        {
          id: '0',
          syncing: false,
          title: '',
          children: [
            { id: '1', syncing: false, parentId: '0', title: 'Recent', url: 'https://example.test/1', dateAdded: NOW },
            { id: '2', syncing: false, parentId: '0', title: 'Legacy', url: 'https://example.test/2' },
            { id: '3', syncing: false, parentId: '0', title: 'Invalid', url: 'https://example.test/3', dateAdded: NaN },
          ],
        },
      ],
      listen: () => () => {},
    },
    async () => 'synthetic',
    'epoch',
  );
  projection.start();
  await vi.waitFor(() => expect(projection.state.status).toBe('ready'));
  const state = treeStateSchema.parse(projection.state);
  if (state.status !== 'ready') throw Error('not-ready');
  expect(state.snapshot.nodes.map(n => n.dateAdded)).toEqual([undefined, NOW, undefined, undefined]);
  projection.stop();
});

it.each([
  '我最近收藏了一个画图的工具',
  '最近保存的网页',
  '我刚收藏的一个网站',
  'find my recently bookmarked drawing tool',
  'recent bookmarks about diagrams',
])('defaults vague collection query to90 days with360 fallback: %s', query => {
  const plan = collectionPlan(query, 'auto', false, NOW);
  expect(plan).toEqual({
    range: { startTime: NOW - 90 * DAY, endTime: NOW + 1 },
    fallback: { startTime: NOW - 360 * DAY, endTime: NOW + 1 },
  });
});
it.each([
  ['近7天收藏的工具', 7],
  ['过去两周收藏的', 14],
  ['最近一个月保存的', 30],
  ['最近三个月收藏的', 90],
  ['bookmarked in the past two weeks', 14],
  ['saved in the last 30 days', 30],
] as const)('resolves explicit rolling scope without fallback: %s', (query, days) => {
  expect(collectionPlan(query, 'auto', true, NOW)).toEqual({
    range: { startTime: NOW - days * DAY, endTime: NOW + 1 },
  });
});
it('uses local calendar boundaries for last week, last month, yesterday and explicit date intervals', () => {
  expect(queryCollectionRange('上周收藏的文档', NOW)).toEqual({
    startTime: new Date(2026, 9, 12).getTime(),
    endTime: new Date(2026, 9, 19).getTime(),
  });
  expect(queryCollectionRange('saved last month', NOW)).toEqual({
    startTime: new Date(2026, 8, 1).getTime(),
    endTime: new Date(2026, 9, 1).getTime(),
  });
  expect(queryCollectionRange('昨天保存的', NOW)).toEqual({
    startTime: new Date(2026, 9, 18).getTime(),
    endTime: new Date(2026, 9, 19).getTime(),
  });
  expect(queryCollectionRange('2026-09-01 到 2026-09-03 收藏的', NOW)).toEqual({
    startTime: new Date(2026, 8, 1).getTime(),
    endTime: new Date(2026, 8, 4).getTime(),
  });
  expect(queryCollectionRange('2026年9月1日收藏的', NOW)).toEqual({
    startTime: new Date(2026, 8, 1).getTime(),
    endTime: new Date(2026, 8, 2).getTime(),
  });
  expect(queryCollectionRange('2026-02-30 收藏的', NOW)).toBeUndefined();
});
it.each(['不是最近收藏的画图工具', '上周以前收藏的文章', 'bookmarks not saved last week', 'saved before 2026-09-01'])(
  'does not invert a complex temporal condition into a positive local filter: %s',
  query => {
    expect(collectionPlan(query, 'auto', true, NOW)).toEqual({});
    expect(collectionPlan(query, '30', true, NOW).range?.startTime).toBe(NOW - 30 * DAY);
  },
);
it('intersects explicit manual/query periods, includes boundary timestamps and keeps missing dates only in all time', () => {
  expect(collectionPlan('最近收藏', 'all', true, NOW)).toEqual({});
  expect(collectionPlan('画图工具', 'auto', false, NOW)).toEqual({});
  const plan = collectionPlan('过去30天收藏', '7', true, NOW);
  expect(plan.range?.startTime).toBe(NOW - 7 * DAY);
  expect(plan.fallback).toBeUndefined();
  expect(inCollectionRange({ dateAdded: NOW - 7 * DAY }, plan.range)).toBe(true);
  expect(inCollectionRange({ dateAdded: NOW + 1 }, plan.range)).toBe(false);
  expect(inCollectionRange({}, plan.range)).toBe(false);
  expect(inCollectionRange({})).toBe(true);
  expect(newestBookmarks([{ id: 'u' }, { id: 'a', dateAdded: 10 }, { id: 'b', dateAdded: 20 }]).map(n => n.id)).toEqual(
    ['b', 'a', 'u'],
  );
});

type Input = {
  query: string;
  collectionRange?: { startTime: number; endTime: number };
  items: { id: string; dateAdded?: number }[];
};
function fixture(
  decide: (
    input: Input,
  ) =>
    Promise<{ matched?: string[]; uncertain?: string[] }> | { matched?: string[]; uncertain?: string[] } = () => ({}),
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const tree = searchTree(9);
  [1, 89, 90, 91, 359, 360, 361, undefined, 20].forEach((days, i) => {
    if (days !== undefined) tree.nodes[i + 1]!.dateAdded = NOW - days * DAY;
  });
  const folder = {
    ...tree.nodes[0]!,
    ref: { ...tree.nodes[0]!.ref, nativeId: 'private' },
    parentId: '0',
    childrenIds: ['9'],
  };
  tree.nodes.push(folder);
  tree.nodes[9]!.parentId = 'private';
  tree.nodes[0]!.childrenIds = [...tree.nodes[0]!.childrenIds.filter(id => id !== '9'), 'private'];
  const context = {
    tree,
    version: 1 as const,
    revision: 'r',
    sessionRevision: 0,
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [folder.ref] },
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://synthetic.test/v1',
      model: 'synthetic',
      timeoutMs: 10000,
    },
    key: '',
  };
  const offered: Input[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const input: Input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    offered.push(input);
    const { matched = [], uncertain = [] } = await decide(input);
    return new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                matchedIds: matched,
                uncertainIds: uncertain,
                unmatchedIds: input.items
                  .map(item => item.id)
                  .filter(id => !matched.includes(id) && !uncertain.includes(id)),
              }),
            },
          },
        ],
      }),
    );
  });
  const authority = { read: async () => structuredClone(context), subscribe: () => () => {} };
  const states: SearchState[] = [];
  let state!: SearchState;
  const controller = new SearchController(
    value => {
      state = value;
      states.push(value);
    },
    authority,
    new ModelTransport({ fetch: fetcher, contains: async () => true }, authority),
  );
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.setQuery('我最近收藏了一个画关系图的工具');
  return { controller, context, offered, states, state: () => state, fetcher };
}
it('filters locally before AI, expands90 to360 only after zero matches and never resends the first window', async () => {
  const f = fixture(input => ({ matched: input.items.some(item => item.id === '4') ? ['4'] : [] }));
  await f.controller.rerank();
  expect(f.offered.map(input => input.items.map(item => item.id))).toEqual([
    ['1', '2', '3'],
    ['4', '5', '6'],
  ]);
  expect(f.offered[0]?.collectionRange?.startTime).toBe(NOW - 90 * DAY);
  expect(f.offered[1]?.collectionRange?.startTime).toBe(NOW - 360 * DAY);
  expect(f.offered[0]?.items[0]?.dateAdded).toBe(NOW - DAY);
  expect(f.state().hits.map(hit => hit.id)).toEqual(['4']);
  expect(f.state().progress).toMatchObject({ total: 6, checked: 6, excluded: 1, complete: true });
  expect(f.state().expandedRange).toBe(true);
  expect(JSON.stringify(f.offered)).not.toContain('secret=yes');
  f.controller.dispose();
});
it('stops at90 days when a match exists', async () => {
  const f = fixture(() => ({ matched: ['1'] }));
  await f.controller.rerank();
  expect(f.offered).toHaveLength(1);
  expect(f.state().expandedRange).toBe(false);
  f.controller.dispose();
});
it.each([false, true])('finishes every90-day batch before deciding on fallback (late match=%s)', async match => {
  const f = fixture(input => ({ matched: match && input.items.some(item => item.id === '201') ? ['201'] : [] }));
  f.controller.setQuery('找出所有最近收藏的画图工具');
  const tree = searchTree(205);
  tree.nodes.forEach((node, index) => {
    if (index) node.dateAdded = NOW - (index <= 201 ? 1 : 200) * DAY;
  });
  f.context.tree = tree;
  f.context.privacy.excludedFolders = [];
  f.controller.setTree({ status: 'ready', snapshot: tree });
  await f.controller.rerank();
  expect(f.offered.map(input => input.items.length)).toEqual(match ? [100, 100, 1] : [100, 100, 1, 4]);
  expect(new Set(f.offered.flatMap(input => input.items.map(item => item.id))).size).toBe(match ? 201 : 205);
  expect(f.state().progress?.complete).toBe(true);
  f.controller.dispose();
});
it('widens an empty first window without an empty model request, and stops at360 days', async () => {
  const f = fixture();
  for (const node of f.context.tree.nodes) if (node.dateAdded !== undefined) node.dateAdded -= 100 * DAY;
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  await f.controller.rerank();
  expect(f.offered).toHaveLength(1);
  expect(f.offered[0]!.items.map(item => item.id)).toEqual(['1', '2', '3', '4']);
  expect(f.state().expandedRange).toBe(true);
  expect(f.state().progress?.complete).toBe(true);
  f.controller.dispose();
});
it.each(['explicit-query', 'manual', 'ordinary', 'all'] as const)('does not widen %s searches', async mode => {
  const f = fixture();
  if (mode === 'explicit-query') f.controller.setQuery('近7天收藏的画图工具');
  if (mode === 'manual') f.controller.setCollectionFilter('30', true);
  if (mode === 'ordinary') f.controller.setQuery('画图工具');
  if (mode === 'all') f.controller.setCollectionFilter('all', true);
  await f.controller.rerank();
  expect(f.offered).toHaveLength(1);
  expect(f.offered[0]!.items.map(item => item.id)).toEqual(
    mode === 'explicit-query' || mode === 'manual' ? ['1'] : ['1', '2', '3', '4', '5', '6', '7', '8'],
  );
  expect(f.state().expandedRange).toBe(false);
  f.controller.dispose();
});
it('retains uncertain judgments while expanding, without treating them as confirmed matches', async () => {
  const f = fixture(input => ({ uncertain: input.items.some(item => item.id === '1') ? ['1'] : [] }));
  await f.controller.rerank();
  expect(f.offered).toHaveLength(2);
  expect(f.state().uncertainHits?.map(hit => hit.id)).toEqual(['1']);
  f.controller.dispose();
});
it('network failure does not widen a scope', async () => {
  const f = fixture(() => {
    throw Error('network');
  });
  await f.controller.rerank();
  expect(f.offered).toHaveLength(1);
  expect(f.state().expandedRange).toBe(false);
  expect(f.state().message).toContain('未完成');
  f.controller.dispose();
});
it.each(['cancel', 'filter', 'date-change'] as const)(
  'fences a late reply after %s and never starts fallback',
  async mode => {
    let release!: () => void;
    const f = fixture(
      () =>
        new Promise(resolve => {
          release = () => resolve({});
        }),
    );
    const pending = f.controller.rerank();
    await vi.waitFor(() => expect(f.offered).toHaveLength(1));
    if (mode === 'cancel') f.controller.cancel();
    else if (mode === 'filter') f.controller.setCollectionFilter('7');
    else {
      f.context.tree.nodes[1]!.dateAdded = NOW - 200 * DAY;
      f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
    }
    release();
    await pending;
    expect(f.offered).toHaveLength(1);
    expect(f.state().expandedRange).toBe(false);
    expect(f.state().progress?.complete ?? false).toBe(false);
    f.controller.dispose();
  },
);
it('local recent browsing sorts by native dates and keeps missing dates in all-time view', () => {
  const f = fixture();
  f.controller.setQuery('');
  f.controller.setCollectionFilter('auto', true);
  expect(f.state().hits.map(hit => hit.id)).toEqual(['1', '9', '2', '3']);
  f.controller.setCollectionFilter('all', true);
  expect(f.state().hits.at(-1)?.id).toBe('8');
  expect(f.offered).toEqual([]);
  f.controller.dispose();
});
it('idle recent browsing follows bookmarks saved after the view was opened', () => {
  const f = fixture();
  f.controller.setQuery('');
  f.controller.setCollectionFilter('auto', true);
  vi.setSystemTime(NOW + DAY);
  f.context.tree.nodes[8]!.dateAdded = NOW + DAY;
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  expect(f.state().hits[0]?.id).toBe('8');
  expect(f.state().collectionRange?.endTime).toBe(NOW + DAY + 1);
  f.controller.dispose();
});
it('collection dates bind search freshness and cannot leak into other model tasks', () => {
  const f = fixture();
  const request = { task: 'search-batch' as const, query: 'recent', itemIds: ['1'], folderIds: [] };
  const first = dependencyDigest(f.context.tree, request);
  const other = { task: 'search' as const, query: 'legacy', itemIds: ['1'], folderIds: [] };
  const legacy = dependencyDigest(f.context.tree, other);
  f.context.tree.nodes[1]!.dateAdded! -= DAY;
  expect(dependencyDigest(f.context.tree, request)).not.toBe(first);
  expect(dependencyDigest(f.context.tree, other)).toBe(legacy);
  expect(serializeAiPayload(f.context.tree, f.context.privacy, other)).not.toContain('dateAdded');
  expect(() =>
    serializeAiPayload(f.context.tree, f.context.privacy, {
      ...request,
      collectionRange: { startTime: NOW - DAY, endTime: NOW + 1 },
    }),
  ).toThrow('stale-context');
  f.controller.dispose();
});
