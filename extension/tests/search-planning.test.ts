import { afterEach, expect, it, vi } from 'vitest';
import { SearchController, type SearchState } from '../panel/search-controller';
import { ModelTransport, normalizeModelJson } from '../adapters/model-transport';
import { compactAiPayload, serializeAiPayload, type AiRequest } from '../domain/ai-payload';
import { dependencyDigest } from '../domain/context-dependencies';
import { prioritizeSearchCandidates, searchFolderIds } from '../domain/search-planning';
import { SEARCH_PLAN_TIMEOUT_MS } from '../domain/search-limits';
import { SearchIndex } from '../domain/search-index';
import { parseModelOutput } from '../schemas/model-output';
import { searchFolders } from './fixtures/search-folders';

interface Input {
  task: string;
  query: string;
  items: { id: string; title: string }[];
  folderProfiles?: { id: string; path: string[]; count: number; sampleTitles: string[] }[];
}
const owners: SearchController[] = [];
afterEach(() => {
  owners.splice(0).forEach(owner => owner.dispose());
  vi.useRealTimers();
});
const plan = { folderIds: ['useful', 'early', 'misc'], terms: ['diagrams'] };
function reply(output: unknown) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }] }),
  );
}
function decisions(input: Input, matches: string[] = ['81', '230']) {
  const ids = input.items.map(item => item.id);
  return {
    matchedIds: ids.filter(id => matches.includes(id)),
    unmatchedIds: ids.filter(id => !matches.includes(id)),
    uncertainIds: [],
  };
}
function setup(
  respond: (input: Input, init?: RequestInit) => Response | Promise<Response> = input =>
    reply(input.task === 'search-plan' ? plan : decisions(input)),
) {
  const tree = searchFolders();
  const context = {
    tree,
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    privacy: {
      fullUrl: false,
      bodyEnabled: false,
      excludedFolders: [tree.nodes.find(node => node.ref.nativeId === 'private')!.ref],
    },
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://synthetic.test/v1',
      model: 'synthetic',
      timeoutMs: 30_000,
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
  const inputs: Input[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const input: Input = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    inputs.push(input);
    return respond(input, init);
  });
  const usage = vi.fn(async () => {});
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority, undefined, usage);
  let state!: SearchState;
  const controller = new SearchController(
    value => {
      state = value;
    },
    authority,
    transport,
  );
  owners.push(controller);
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.setQuery('帮我找画关系图的工具');
  return {
    controller,
    context,
    inputs,
    fetcher,
    transport,
    usage,
    state: () => state,
    invalidate: () => listeners.forEach(fn => fn()),
  };
}

it('plans folders without private metadata, prioritizes cross-folder expansion hits and resumes without repeats', async () => {
  const f = setup();
  await f.controller.rerank();
  expect(f.inputs.map(input => input.task)).toEqual(['search-plan', 'search-batch']);
  const profiles = f.inputs[0]!.folderProfiles!;
  expect(profiles.map(profile => profile.id)).toEqual(['early', 'useful', 'misc']);
  expect(profiles.every(profile => profile.count === 80 && profile.sampleTitles.length === 3)).toBe(true);
  expect(profiles[1]!.path).toEqual(['Bookmarks', 'useful']);
  expect(f.inputs[0]!.items).toEqual([]);
  expect(JSON.stringify(f.inputs)).not.toMatch(/PRIVATE_SAMPLE|secret=yes|secret\.example/);
  expect(f.inputs[1]!.items.slice(0, 3).map(item => item.id)).toEqual(['230', '81', '82']);
  expect(f.inputs[1]!.query).toBe('帮我找画关系图的工具');
  expect(f.state().hits.map(hit => hit.id)).toEqual(['230', '81']);
  expect(f.state().progress).toMatchObject({ checked: 100, total: 240, excluded: 1, complete: false });
  expect(f.state().canContinue).toBe(true);
  await Promise.all([f.controller.continueSearch(), f.controller.continueSearch()]);
  const batches = f.inputs.filter(input => input.task === 'search-batch');
  expect(batches.map(input => input.items.length)).toEqual([100, 100, 40]);
  expect(new Set(batches.flatMap(input => input.items.map(item => item.id))).size).toBe(240);
  expect(f.inputs.filter(input => input.task === 'search-plan')).toHaveLength(1);
  expect(f.state().progress?.complete).toBe(true);
  expect(f.state().canContinue).toBe(false);
  expect(f.usage.mock.calls.flat()).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: 'search' })]));
});

it.each(['找出全部画图工具', 'find every drawing tool', 'find all drawing tools'])(
  'keeps exhaustive coverage for %s',
  async query => {
    const f = setup();
    f.controller.setQuery(query);
    await f.controller.rerank();
    expect(f.state().progress).toMatchObject({ checked: 240, complete: true });
    expect(f.state().canContinue).not.toBe(true);
  },
);

it('continues across all folders when no confirmed match is found', async () => {
  const f = setup(input => reply(input.task === 'search-plan' ? plan : decisions(input, [])));
  await f.controller.rerank();
  expect(f.state().progress).toMatchObject({ checked: 240, complete: true });
  expect(f.state().hits).toEqual([]);
});

it.each(['duplicate', 'unknown', 'missing', 'network'] as const)(
  'falls back from a %s folder plan without dropping candidates',
  async kind => {
    const f = setup(input => {
      if (input.task !== 'search-plan') return reply(decisions(input, []));
      if (kind === 'network') throw Error('network');
      return reply({
        folderIds:
          kind === 'duplicate'
            ? ['early', 'early', 'misc']
            : kind === 'unknown'
              ? ['early', 'useful', 'foreign']
              : ['early'],
        terms: [],
      });
    });
    await f.controller.rerank();
    expect(f.state().planningFallback).toBe(true);
    expect(f.state().progress).toMatchObject({ checked: 240, complete: true });
  },
);

it('bounds even a hanging folder request by a separate wall clock and continues with bookmark assessment', async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | null | undefined;
  const f = setup((input, init) => {
    if (input.task === 'search-plan') {
      signal = init?.signal;
      return new Promise(() => {});
    }
    return reply(decisions(input, []));
  });
  const pending = f.controller.rerank();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.inputs).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(SEARCH_PLAN_TIMEOUT_MS);
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(f.state().planningFallback).toBe(true);
  expect(f.state().progress?.complete).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels planning immediately and fences a late plan without starting bookmark requests', async () => {
  let finish!: (response: Response) => void;
  const f = setup(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.inputs).toHaveLength(1));
  f.controller.cancel();
  await pending;
  finish(reply(plan));
  await Promise.resolve();
  expect(f.inputs).toHaveLength(1);
  expect(f.state().canContinue).toBe(false);
  expect(f.state().progress).toMatchObject({ checked: 0, complete: false });
});

it.each(['query', 'filter', 'folder', 'settings', 'tree', 'dispose'] as const)(
  'clears a paused continuation on %s changes',
  async kind => {
    const f = setup();
    await f.controller.rerank();
    expect(f.state().canContinue).toBe(true);
    if (kind === 'query') f.controller.setQuery('another query');
    if (kind === 'filter') f.controller.setCollectionFilter('7');
    if (kind === 'folder')
      f.controller.setFolderScope(f.context.tree.nodes.find(node => node.ref.nativeId === 'useful')!.ref);
    if (kind === 'settings') f.invalidate();
    if (kind === 'tree') {
      f.context.tree.nodes[1]!.title = 'changed';
      f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
    }
    if (kind === 'dispose') f.controller.dispose();
    await f.controller.continueSearch();
    expect(f.inputs).toHaveLength(2);
  },
);

function nestedScope(f: ReturnType<typeof setup>) {
  const tree = f.context.tree;
  const selected = {
    ...tree.nodes[0]!,
    ref: { ...tree.nodes[0]!.ref, nativeId: 'selected' },
    parentId: '0',
    title: 'Selected resources',
    childrenIds: ['early', 'useful', 'private'],
    childrenWritable: false,
  };
  tree.nodes.push(selected);
  tree.nodes[0]!.childrenIds = ['selected', 'misc'];
  for (const node of tree.nodes) if (selected.childrenIds.includes(node.ref.nativeId)) node.parentId = 'selected';
  f.controller.setTree({ status: 'ready', snapshot: tree });
  f.controller.setFolderScope(selected.ref);
  return selected.ref;
}

it('scopes planning samples, privacy, local-only results and continuation to a selected subtree', async () => {
  const f = setup(input =>
    reply(input.task === 'search-plan' ? { folderIds: ['useful', 'early'], terms: ['diagrams'] } : decisions(input)),
  );
  nestedScope(f);
  f.controller.setQuery('example');
  expect(f.state().hits).toHaveLength(161);
  await f.controller.rerank();
  expect(f.inputs[0]!.folderProfiles?.map(profile => [profile.id, profile.count])).toEqual([
    ['early', 80],
    ['useful', 80],
  ]);
  expect(f.state().progress).toMatchObject({ checked: 100, total: 160, excluded: 1, changed: false });
  expect(f.state().localOnlyHits?.map(hit => hit.id)).toEqual(['secret']);
  expect(f.state().canContinue).toBe(true);
  f.context.tree.nodes.find(node => node.ref.nativeId === '230')!.title = 'Changed outside the selected folder';
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  expect(f.state().canContinue).toBe(true);
  expect(f.state().progress?.changed).toBe(false);
  await f.controller.continueSearch();
  const ids = f.inputs.flatMap(input => input.items.map(item => item.id));
  expect(ids).toHaveLength(160);
  expect(new Set(ids).size).toBe(160);
  expect(ids.every(id => Number(id) >= 1 && Number(id) <= 160)).toBe(true);
  expect(JSON.stringify(f.inputs)).not.toMatch(/PRIVATE_SAMPLE|diagrams.net|Changed outside/);
  expect(f.state().progress?.complete).toBe(true);
});

it('intersects local site/folder shortcuts and collection time with scope, retaining scoped cache on reconnect', async () => {
  const f = setup();
  nestedScope(f);
  const now = Date.now();
  f.context.tree.nodes.find(node => node.ref.nativeId === '1')!.dateAdded = now - 86400000;
  f.context.tree.nodes.find(node => node.ref.nativeId === '81')!.dateAdded = now - 20 * 86400000;
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  f.controller.setCollectionFilter('7');
  f.controller.setQuery('site:example.com');
  await f.controller.rerank();
  expect(f.state().hits.map(hit => hit.id)).toEqual(['1']);
  f.controller.setCollectionFilter('all');
  f.controller.setQuery('folder:useful');
  await f.controller.rerank();
  expect(f.state().hits).toHaveLength(80);
  f.controller.setQuery('folder:misc');
  await f.controller.rerank();
  expect(f.state().hits).toEqual([]);
  expect(f.inputs).toEqual([]);
  f.controller.setQuery('example');
  f.controller.setTree({ status: 'loading' });
  expect(f.state().hits).toHaveLength(161);
  expect(f.state().folderUnavailable).toBe(false);
});

it('expands recent time only inside the selected folder', async () => {
  const f = setup(input => reply(decisions(input, ['81'])));
  nestedScope(f);
  const now = Date.now();
  f.context.tree.nodes.find(node => node.ref.nativeId === '1')!.dateAdded = now - 86400000;
  f.context.tree.nodes.find(node => node.ref.nativeId === '81')!.dateAdded = now - 200 * 86400000;
  f.context.tree.nodes.find(node => node.ref.nativeId === '230')!.dateAdded = now - 200 * 86400000;
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  f.controller.setQuery('我最近收藏了一个工具');
  await f.controller.rerank();
  expect(f.inputs.map(input => input.items.map(item => item.id))).toEqual([['1'], ['81']]);
  expect(f.state().expandedRange).toBe(true);
  expect(f.state().progress).toMatchObject({ checked: 2, total: 2, complete: true });
});

it.each(['plan', 'batch'] as const)('fences a late %s reply after selecting another folder', async phase => {
  let finish!: (response: Response) => void;
  const f = setup(input =>
    input.task === 'search-plan' && phase === 'batch'
      ? reply({ folderIds: ['useful', 'early'], terms: [] })
      : new Promise(resolve => {
          finish = resolve;
        }),
  );
  nestedScope(f);
  const pending = f.controller.rerank();
  await vi.waitFor(() => expect(f.inputs).toHaveLength(phase === 'plan' ? 1 : 2));
  f.controller.setFolderScope(f.context.tree.nodes.find(node => node.ref.nativeId === 'misc')!.ref);
  await pending;
  finish(reply(phase === 'plan' ? { folderIds: ['useful', 'early'], terms: [] } : decisions(f.inputs.at(-1)!)));
  await Promise.resolve();
  await f.controller.continueSearch();
  expect(f.inputs).toHaveLength(phase === 'plan' ? 1 : 2);
  expect(f.state().progress).toBeUndefined();
  expect(f.state().canContinue).toBe(false);
  expect(f.state().hits).toEqual([]);
});

it.each(['deleted', 'installation'] as const)(
  'fails closed when a selected folder has %s identity and requires explicit global selection',
  async kind => {
    const f = setup();
    const selected = f.context.tree.nodes.find(node => node.ref.nativeId === 'useful')!.ref;
    f.controller.setFolderScope(selected);
    f.controller.setQuery('example');
    expect(f.state().hits).toHaveLength(80);
    if (kind === 'deleted') {
      const removed = new Set(['useful', ...Array.from({ length: 80 }, (_, i) => String(i + 81))]);
      f.context.tree.nodes = f.context.tree.nodes.filter(node => !removed.has(node.ref.nativeId));
      for (const node of f.context.tree.nodes) node.childrenIds = node.childrenIds.filter(id => !removed.has(id));
    } else {
      f.context.tree.installationId = 'new-installation';
      for (const node of f.context.tree.nodes) node.ref.installationId = 'new-installation';
    }
    f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
    await f.controller.rerank();
    expect(f.state().folderUnavailable).toBe(true);
    expect(f.state().hits).toEqual([]);
    expect(f.inputs).toEqual([]);
    f.controller.setFolderScope(undefined);
    expect(f.state().folderUnavailable).toBe(false);
    expect(f.state().hits.length).toBeGreaterThan(0);
  },
);

it('stops on changed folder evidence rather than treating stale planning as a network fallback', async () => {
  const f = setup(input => {
    f.context.tree.nodes.find(node => node.ref.nativeId === 'useful')!.title = 'changed';
    f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
    return reply(input.task === 'search-plan' ? plan : decisions(input));
  });
  await f.controller.rerank();
  expect(f.inputs).toHaveLength(1);
  expect(f.state().planningFallback).not.toBe(true);
  expect(f.state().message).toContain('变化');
});

it('retains current judgments if a continued batch fails', async () => {
  let batches = 0;
  const f = setup(input => {
    if (input.task === 'search-plan') return reply(plan);
    if (++batches > 1) throw Error('network');
    return reply(decisions(input));
  });
  await f.controller.rerank();
  const first = f.state().hits;
  await f.controller.continueSearch();
  expect(f.state().hits).toEqual(first);
  expect(f.state().message).toContain('未完成');
  expect(f.state().canContinue).toBe(false);
});

it('skips an oversized plan and still checks the complete catalog', async () => {
  const f = setup(input => reply(decisions(input, [])));
  const fits = f.transport.fits.bind(f.transport);
  vi.spyOn(f.transport, 'fits').mockImplementation(input => input.request.task !== 'search-plan' && fits(input));
  await f.controller.rerank();
  expect(f.inputs.every(input => input.task === 'search-batch')).toBe(true);
  expect(f.state().planningFallback).toBe(true);
  expect(f.state().progress?.complete).toBe(true);
});

it('skips planning for small multi-folder catalogs', async () => {
  const f = setup(input => reply(decisions(input)));
  const keep = new Set(['1', '81', '230', 'secret']);
  f.context.tree.nodes = f.context.tree.nodes.filter(node => node.ref.kind === 'folder' || keep.has(node.ref.nativeId));
  for (const node of f.context.tree.nodes)
    node.childrenIds = node.childrenIds.filter(id => f.context.tree.nodes.some(child => child.ref.nativeId === id));
  f.controller.setTree({ status: 'ready', snapshot: f.context.tree });
  await f.controller.rerank();
  expect(f.inputs.map(input => input.task)).toEqual(['search-batch']);
  expect(f.state().progress).toMatchObject({ checked: 3, total: 3, complete: true });
});

it('normalizes numeric native folder IDs before validating the complete plan', () => {
  const output = normalizeModelJson({ folderIds: [12, 10], terms: [] }, 'search-plan');
  expect(parseModelOutput(output, { task: 'search-plan', items: [], folders: [{ id: '10' }, { id: '12' }] })).toEqual({
    folderIds: ['12', '10'],
    terms: [],
  });
});

it('computes profile counts and samples after privacy/time filtering and binds dates and paths to freshness', () => {
  const f = setup();
  f.context.tree.nodes.forEach(node => {
    if (node.ref.kind === 'bookmark') node.dateAdded = 5;
  });
  f.context.tree.nodes[1]!.dateAdded = 20;
  const request: AiRequest = {
    task: 'search-plan',
    query: 'recent tools',
    itemIds: ['1', 'secret'],
    folderIds: ['early', 'private'],
    collectionRange: { startTime: 10, endTime: 30 },
  };
  const payload = serializeAiPayload(f.context.tree, f.context.privacy, request);
  const wire = JSON.parse(compactAiPayload(payload));
  expect(wire.folderProfiles).toEqual([
    { id: 'early', path: ['Bookmarks', 'early'], count: 1, sampleTitles: ['重庆大学'] },
  ]);
  expect(payload).not.toContain('PRIVATE_SAMPLE');
  const digest = dependencyDigest(f.context.tree, request);
  f.context.tree.nodes[1]!.dateAdded = 21;
  expect(dependencyDigest(f.context.tree, request)).not.toBe(digest);
  f.context.tree.nodes[1]!.dateAdded = 5;
  expect(() => serializeAiPayload(f.context.tree, f.context.privacy, request)).toThrow('stale-context');
});

it('rotates oversized folders without losing unranked or locally prioritized candidates', () => {
  const tree = searchFolders();
  const candidates = new SearchIndex(tree).all().filter(hit => hit.id !== 'secret');
  expect(searchFolderIds(tree, candidates)).toEqual(['early', 'useful', 'misc']);
  const ids = prioritizeSearchCandidates(tree, candidates, ['useful'], ['230', '230', 'foreign', 'secret']);
  expect(ids[0]).toBe('230');
  expect(ids[1]).toBe('81');
  expect(ids[26]).toBe('1');
  expect(ids).toHaveLength(240);
  expect(new Set(ids).size).toBe(240);
});

it.each([
  { folderIds: ['early', 'useful', 'misc'], terms: Array(13).fill('term') },
  { folderIds: ['early', 'useful', 'misc'], terms: ['x'.repeat(65)] },
  { folderIds: ['early', 'useful', 'misc'], terms: [''] },
  { folderIds: ['early', 'useful', 'misc'], terms: [], matchedIds: ['1'] },
])('rejects malformed expansion or unsolicited match claims: %j', output => {
  expect(() =>
    parseModelOutput(output, { task: 'search-plan', items: [], folders: plan.folderIds.map(id => ({ id })) }),
  ).toThrow('invalid-output');
});
