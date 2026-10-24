import { afterEach, expect, it, vi } from 'vitest';
import { PersonalizationStore } from '../persistence/personalization';
import {
  emptyPersonalization,
  preferenceEvidence,
  preferenceHints,
  type PersonalPreference,
} from '../domain/personalization';
import { organizerTree } from './fixtures/organizer-tree';
import { ModelTransport } from '../adapters/model-transport';
import { parseModelOutput } from '../schemas/model-output';

afterEach(() => vi.unstubAllGlobals());
const tree = organizerTree();
const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
const entry = (id = 'one', fields: Partial<PersonalPreference> = {}): PersonalPreference => ({
  id,
  text: 'Tutorials are learning resources.',
  source: 'feedback',
  status: 'active',
  enabled: true,
  scopes: ['search', 'organize'],
  updatedAt: 1,
  evidence: preferenceEvidence(tree, ['a']),
  ...fields,
});
function setup() {
  const data: Record<string, unknown> = {};
  const local = {
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (value: Record<string, unknown>) => {
      Object.assign(data, structuredClone(value));
    }),
    setAccessLevel: vi.fn(async () => {}),
  };
  vi.stubGlobal('chrome', { storage: { local } });
  return { data, local, store: new PersonalizationStore(local) };
}

it('keeps explicit examples local per installation, merges queued edits, preserves rules and honors disabled learning', async () => {
  const h = setup();
  await Promise.all([h.store.remember('install', entry()), h.store.remember('install', entry('two'))]);
  expect((await h.store.load('install')).entries).toHaveLength(2);
  expect((await h.store.load('other')).entries).toHaveLength(0);
  await expect(h.store.rememberMany('install', [entry('large', { text: 'x'.repeat(3000) })])).rejects.toThrow(
    'preference-capacity',
  );
  const bounded = await h.store.load('install');
  expect(bounded.entries).toHaveLength(2);
  await h.store.update('install', value => ({ ...value, enabled: false }));
  await h.store.remember('install', entry('disabled-choice'));
  expect((await h.store.load('install')).entries.some(value => value.id === 'disabled-choice')).toBe(false);
  h.local.set.mockRejectedValueOnce(Error('quota'));
  await expect(h.store.update('install', value => ({ ...value, entries: [] }))).rejects.toThrow('quota');
  expect((await h.store.load('install')).entries).toHaveLength(2);
});

it('filters pending/disabled/wrong-feature/private/deleted/changed evidence and does not expose local evidence URLs', () => {
  const memory = {
    ...emptyPersonalization(),
    entries: [
      entry(),
      entry('pending', { status: 'pending' }),
      entry('disabled', { enabled: false }),
      entry('save', { scopes: ['save'] }),
    ],
  };
  expect(preferenceHints(memory, tree, privacy, 'search').map(value => value.id)).toEqual(['one']);
  expect(JSON.stringify(preferenceHints(memory, tree, privacy, 'search'))).not.toContain('url');
  const excluded = { ...privacy, excludedFolders: [tree.nodes.find(node => node.ref.nativeId === 'left')!.ref] };
  expect(preferenceHints(memory, tree, excluded, 'search')).toEqual([]);
  const changed = structuredClone(tree);
  changed.nodes.find(node => node.ref.nativeId === 'a')!.title = 'Changed';
  expect(preferenceHints(memory, changed, privacy, 'search')).toEqual([]);
  expect(preferenceHints({ ...memory, enabled: false }, tree, privacy, 'search')).toEqual([]);
  expect(
    preferenceHints(
      { ...memory, entries: [entry('query', { text: 'https://example.test/?private=secret' })] },
      tree,
      privacy,
      'search',
    ),
  ).toEqual([]);
});

it('injects active preferences into actual model requests and never sends pending AI rules', async () => {
  const h = setup();
  await h.store.rememberMany('install', [
    entry('active'),
    entry('pending', { text: 'Do not send this pending rule', source: 'ai', status: 'pending' }),
  ]);
  const context = {
    version: 1 as const,
    revision: 'r',
    sessionRevision: 0,
    tree,
    privacy,
    key: '',
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://model.test',
      model: 'synthetic',
      timeoutMs: 1000,
      streaming: false,
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"rankedIds":["a"]}' } }] }),
      ),
  );
  const model = new ModelTransport(
    { fetch, contains: async () => true },
    { read: async () => structuredClone(context), subscribe: () => () => {} },
  );
  const request = { task: 'search' as const, query: 'tutorials', itemIds: ['a'], folderIds: ['bar', 'left'] };
  expect(await model.run({ ...context, request })).toMatchObject({ status: 'completed' });
  const body = JSON.parse(String(fetch.mock.calls[0]![1]?.body));
  const payload = JSON.parse(body.messages[1].content);
  expect(payload.personalPreferences).toEqual([
    { id: 'active', text: 'Tutorials are learning resources.', kind: 'feedback' },
  ]);
  expect(JSON.stringify(body)).not.toContain('Do not send this pending rule');
  await h.store.update('install', value => ({ ...value, entries: [] }));
  await model.run({ ...context, request });
  expect(
    JSON.parse(JSON.parse(String(fetch.mock.calls[1]![1]?.body)).messages[1].content).personalPreferences,
  ).toBeUndefined();
  model.dispose();
});

it.each(['search-plan', 'search-batch'] as const)('filters out-of-folder preference evidence from actual %s requests', async task => {
  const h = setup();
  await h.store.rememberMany('install', [
    entry('inside'),
    entry('outside', { text: 'OUTSIDE_BOOKMARK_EXAMPLE', evidence: preferenceEvidence(tree, ['c']) }),
    entry('generic', { source: 'manual', text: 'Prefer concise results.', evidence: [] }),
  ]);
  const context = {
    version: 1 as const, revision: 'r', sessionRevision: 0, tree, privacy, key: '',
    config: { adapter: 'openai-compatible' as const, baseUrl: 'https://model.test', model: 'synthetic', timeoutMs: 1000, streaming: false },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ choices: [{
    finish_reason: 'stop', message: { content: JSON.stringify(task === 'search-plan'
      ? { folderIds: ['left'], terms: [] }
      : { matchedIds: ['a'], unmatchedIds: [], uncertainIds: [] }) },
  }] })));
  const model = new ModelTransport({ fetch, contains: async () => true }, { read: async () => structuredClone(context), subscribe: () => () => {} });
  const request = { task, query: 'tutorials', itemIds: ['a'], folderIds: ['left'], folderScope: tree.nodes.find(node => node.ref.nativeId === 'left')!.ref };
  expect(await model.run({ ...context, request })).toMatchObject({ status: 'completed' });
  const payload = JSON.parse(JSON.parse(String(fetch.mock.calls[0]![1]?.body)).messages[1].content);
  expect(payload.personalPreferences.map((hint: { id: string }) => hint.id)).toEqual(['inside', 'generic']);
  expect(JSON.stringify(payload)).not.toContain('OUTSIDE_BOOKMARK_EXAMPLE');
  model.dispose();
});

it('rejects a scoped request if an included preference example moves outside before sending', async () => {
  const h = setup();
  const current = structuredClone(tree);
  await h.store.rememberMany('install', [entry('other-batch-example', { evidence: preferenceEvidence(current, ['b']) })]);
  const context = {
    version: 1 as const, revision: 'r', sessionRevision: 0, tree: current, privacy, key: '',
    config: { adapter: 'openai-compatible' as const, baseUrl: 'https://model.test', model: 'synthetic', timeoutMs: 1000 },
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const model = new ModelTransport({ fetch, contains: async () => true }, {
    read: async () => {
      current.nodes.find(node => node.ref.nativeId === 'b')!.parentId = 'outside';
      return structuredClone(context);
    }, subscribe: () => () => {},
  });
  const request = { task: 'search-batch' as const, query: 'tutorials', itemIds: ['a'], folderIds: [], folderScope: current.nodes.find(node => node.ref.nativeId === 'left')!.ref };
  expect(await model.run({ ...context, request })).toMatchObject({ status: 'failed', reason: 'stale-context' });
  expect(fetch).not.toHaveBeenCalled();
  model.dispose();
});

it('requires strict cited example IDs for AI summaries; summaries are never native commands', () => {
  const context = {
    task: 'preference-summary',
    items: [],
    folders: [],
    examples: [{ id: 'e', text: 'Tutorials in Learning' }],
  };
  expect(
    parseModelOutput({ rules: [{ text: 'Put tutorials in Learning', exampleIds: ['e'] }] }, context),
  ).toMatchObject({ rules: [{ exampleIds: ['e'] }] });
  expect(() => parseModelOutput({ rules: [{ text: 'Invented', exampleIds: ['unknown'] }] }, context)).toThrow();
  expect(() => parseModelOutput({ rules: [], moves: [{ itemId: 'a', folderId: 'bar' }] }, context)).toThrow();
});

it('counts Unicode characters and preserves oversized legacy data before migrating its effective view', async () => {
  const h = setup();
  await h.store.remember('install', entry('unicode', { text: '😀'.repeat(3000) }));
  expect((await h.store.load('install')).entries).toHaveLength(1);
  await expect(h.store.remember('install', entry('extra', { text: 'x' }))).rejects.toThrow('preference-capacity');
  const legacy = {
    version: 1,
    enabled: true,
    revision: 'legacy',
    entries: [entry('large', { text: 'x'.repeat(3001) }), entry('small')],
  };
  h.data[h.store.key('old')] = legacy;
  expect((await h.store.load('old')).entries.map(item => item.id)).toEqual(['small']);
  expect((await h.store.migrate('old'))?.entries).toHaveLength(2);
  expect(h.data[h.store.key('old') + '.migration']).toEqual(legacy);
  expect((await h.store.load('old')).entries.map(item => item.id)).toEqual(['small']);
});

it.each(['界', '😀'])('accepts 3000 Unicode characters and rejects 3001 without replacing saved preferences: %s', async character => {
  const h = setup();
  const text = character.repeat(3000);
  await h.store.remember('boundary', entry('full', { text }));
  expect((await h.store.load('boundary')).entries[0]!.text).toBe(text);
  await expect(h.store.update('boundary', value => ({ ...value, entries: [entry('full', { text: text + character })] }))).rejects.toThrow('preference-capacity');
  expect((await h.store.load('boundary')).entries[0]!.text).toBe(text);
  const context = { task: 'preference-summary', items: [], folders: [], examples: [{ id: 'e', text: 'Example' }] };
  expect(parseModelOutput({ rules: [{ text, exampleIds: ['e'] }] }, context)).toMatchObject({ rules: [{ text }] });
  expect(() => parseModelOutput({ rules: [{ text: text + character, exampleIds: ['e'] }] }, context)).toThrow();
});

it('rejects over-budget or incomplete whole-profile summaries', () => {
  const context = {
    task: 'preference-summary',
    items: [],
    folders: [],
    examples: [
      { id: 'old', text: 'Existing' },
      { id: 'new', text: 'Latest' },
    ],
    characterLimit: 20,
    ruleLimit: 1,
    latestExampleIds: ['new'],
  };
  expect(() => parseModelOutput({ rules: [{ text: 'x'.repeat(21), exampleIds: ['new'] }] }, context)).toThrow();
  expect(() => parseModelOutput({ rules: [{ text: 'Old only', exampleIds: ['old'] }] }, context)).toThrow();
  expect(() => parseModelOutput({ rules: [] }, context)).toThrow();
  expect(parseModelOutput({ rules: [{ text: 'Merged', exampleIds: ['old', 'new'] }] }, context)).toMatchObject({
    rules: [{ text: 'Merged' }],
  });
});
