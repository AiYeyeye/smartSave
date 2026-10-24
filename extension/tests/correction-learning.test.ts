import { afterEach, expect, it, vi } from 'vitest';
import { CorrectionLearning } from '../background/correction-learning';
import { LEARNING_QUEUE_KEY, PersonalizationStore } from '../persistence/personalization';
import { organizerTree } from './fixtures/organizer-tree';
import { ModelTransport } from '../adapters/model-transport';
import { preferenceCharacters, preferenceEvidence, type PersonalPreference } from '../domain/personalization';

afterEach(() => vi.unstubAllGlobals());
function harness() {
  const tree = organizerTree();
  const data: Record<string, unknown> = {};
  const local = {
    get: async (key: string) => ({ [key]: structuredClone(data[key]) }),
    set: async (value: Record<string, unknown>) => {
      Object.assign(data, structuredClone(value));
    },
    setAccessLevel: async () => {},
  };
  vi.stubGlobal('chrome', { storage: { local } });
  const memory = new PersonalizationStore(local);
  const settings = {
    snapshot: async () => ({
      version: 1 as const,
      revision: 'r',
      sessionRevision: 0,
      key: '',
      privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
      config: {
        adapter: 'openai-compatible' as const,
        baseUrl: 'https://model.test',
        model: 'synthetic',
        timeoutMs: 1000,
        streaming: false,
      },
    }),
    subscribe: () => () => {},
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const payload = JSON.parse(body.messages[1].content);
    const text = JSON.stringify({
      rules: [
        {
          text: 'Keep a concise tool purpose in names.',
          exampleIds: payload.examples.map((item: { id: string }) => item.id),
        },
      ],
    });
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: text } }] }));
  });
  const projection = { fresh: async () => structuredClone(tree), subscribe: () => () => {} };
  const learner = new CorrectionLearning(
    projection,
    settings,
    local,
    memory,
    authority => new ModelTransport({ fetch, contains: async () => true }, authority),
  );
  const example: PersonalPreference = {
    id: 'edit-1',
    text: 'User renamed a vague tool page to a short product and purpose.',
    source: 'choice',
    status: 'active',
    enabled: true,
    scopes: ['save', 'rename'],
    updatedAt: 1,
    evidence: preferenceEvidence(tree, ['a']),
  };
  const done = async () =>
    vi.waitFor(() => {
      const jobs = data[LEARNING_QUEUE_KEY] as { status: string }[];
      expect(jobs?.[0]?.status).not.toMatch(/queued|running/);
    });
  return { tree, data, local, memory, learner, example, fetch, done };
}
it('separately learns a submitted correction once and saves an active scoped preference', async () => {
  const h = harness();
  await h.learner.enqueue('action-1', 'install', [h.example]);
  await h.done();
  expect(h.fetch).toHaveBeenCalledTimes(1);
  expect((await h.memory.load('install')).entries.find(entry => entry.learnedFrom === 'action-1')).toMatchObject({
    status: 'active',
    scopes: ['save', 'rename'],
  });
  await h.learner.enqueue('action-1', 'install', [h.example]);
  await h.done();
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('skips empty agreement events, disabled personalization and stale evidence without calling AI', async () => {
  const h = harness();
  await h.learner.enqueue('accepted', 'install', []);
  expect(h.fetch).not.toHaveBeenCalled();
  await h.memory.update('install', value => ({ ...value, enabled: false }));
  await h.learner.enqueue('disabled', 'install', [h.example]);
  expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([{ id: 'disabled', status: 'skipped', examples: [] }]);
  await h.memory.update('install', value => ({ ...value, enabled: true }));
  await h.learner.enqueue('disabled', 'install', [h.example]);
  expect(h.fetch).not.toHaveBeenCalled();
  h.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'Later edit';
  await h.learner.enqueue('stale', 'install', [h.example]);
  await vi.waitFor(() =>
    expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([
      { id: 'disabled', status: 'skipped' },
      { id: 'stale', status: 'skipped' },
    ]),
  );
  expect(h.fetch).not.toHaveBeenCalled();
});
it('records learning failure without repeating a model call or any bookmark write', async () => {
  const h = harness();
  await h.memory.remember('install', { ...h.example, id: 'manual', source: 'manual', text: 'Keep API versions.' });
  h.fetch.mockRejectedValue(Error('offline'));
  await h.learner.enqueue('failure', 'install', [h.example]);
  await h.done();
  expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([{ status: 'failed', examples: [{ id: h.example.id }] }]);
  expect((await h.memory.load('install')).entries.map(entry => entry.text)).toEqual(['Keep API versions.']);
  await h.learner.start([]);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});
it('publishes only the interpreted preference, never raw actions while learning is pending', async () => {
  const h = harness();
  const original = h.fetch.getMockImplementation()!;
  let release!: () => void;
  h.fetch.mockImplementation(async (...args) => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return original(...args);
  });
  await h.learner.enqueue('summarize', 'install', [h.example]);
  await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
  expect((await h.memory.load('install')).entries).toEqual([]);
  expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([{ status: 'running', examples: [{ text: h.example.text }] }]);
  release();
  await h.done();
  expect((await h.memory.load('install')).entries.map(entry => entry.text)).toEqual([
    'Keep a concise tool purpose in names.',
  ]);
  expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([{ status: 'completed', examples: [] }]);
});
it('does not recreate a preference deleted while the AI reply is pending', async () => {
  const h = harness();
  const original = h.fetch.getMockImplementation()!;
  let release!: () => void;
  h.fetch.mockImplementation(async (...args) => {
    await new Promise<void>(resolve => {
      release = resolve;
    });
    return original(...args);
  });
  await h.learner.enqueue('late', 'install', [h.example]);
  await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
  await h.memory.update('install', value => ({ ...value, entries: [] }));
  release();
  await h.done();
  expect((await h.memory.load('install')).entries).toEqual([]);
});

it('resumes only unsent work after restart and discards interrupted example copies without replay', async () => {
  const h = harness();
  h.data[LEARNING_QUEUE_KEY] = [
    { id: 'interrupted', installationId: 'install', at: 1, status: 'running', examples: [h.example] },
    { id: 'unsent', installationId: 'install', at: 2, status: 'queued', examples: [h.example] },
  ];
  await h.learner.start([]);
  await vi.waitFor(() =>
    expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([
      { id: 'interrupted', status: 'failed', reason: 'worker-interrupted', examples: [] },
      { id: 'unsent', status: 'completed', examples: [] },
    ]),
  );
  expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('updates the whole profile within 3000 characters and includes existing preferences in compression', async () => {
  const h = harness();
  await h.memory.remember('install', {
    ...h.example,
    id: 'manual',
    source: 'manual',
    text: 'a'.repeat(2950),
    evidence: [],
  });
  await h.learner.enqueue('full', 'install', [{ ...h.example, text: 'Latest explicit choice '.repeat(10) }]);
  await h.done();
  const body = JSON.parse(String(h.fetch.mock.calls[0]![1]?.body));
  const sent = JSON.parse(body.messages[1].content);
  expect(sent.examples).toHaveLength(2);
  expect(sent.examples[0].text).toBe('a'.repeat(2950));
  expect(sent.latestExampleIds).toHaveLength(1);
  expect(sent.characterLimit).toBe(3000);
  const saved = await h.memory.load('install');
  expect(saved.entries).toHaveLength(1);
  expect(preferenceCharacters(saved.entries)).toBeLessThanOrEqual(3000);
});

it('retains the previous full profile and queued evidence when compression returns too much text', async () => {
  const h = harness();
  await h.memory.remember('install', { ...h.example, id: 'existing', text: 'a'.repeat(3000), evidence: [] });
  h.fetch.mockImplementation(async (_url, init) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    const output = {
      rules: [{ text: 'x'.repeat(3001), exampleIds: payload.examples.map((e: { id: string }) => e.id) }],
    };
    return new Response(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }),
    );
  });
  await h.learner.enqueue('overlong', 'install', [h.example]);
  await h.done();
  expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([{ status: 'failed', examples: [{ id: 'edit-1' }] }]);
  expect(preferenceCharacters((await h.memory.load('install')).entries)).toBe(3000);
  expect(h.fetch).toHaveBeenCalledTimes(1);
});

it('reserves disabled and unapproved content without sending it during whole-profile updates', async () => {
  const h = harness();
  await h.memory.remember('install', {
    ...h.example,
    id: 'pending',
    text: 'Private pending rule',
    source: 'ai',
    status: 'pending',
  });
  await h.learner.enqueue('reserve', 'install', [h.example]);
  await h.done();
  const payload = JSON.parse(JSON.parse(String(h.fetch.mock.calls[0]![1]?.body)).messages[1].content);
  expect(JSON.stringify(payload)).not.toContain('Private pending rule');
  expect(payload.characterLimit).toBe(3000 - 'Private pending rule'.length - 1);
  expect(
    (await h.memory.load('install')).entries.some(entry => entry.id === 'pending' && entry.status === 'pending'),
  ).toBe(true);
});

it('keeps the rest of a compressed profile when a new edit changes one of its evidence subjects', async () => {
  const h = harness();
  await h.memory.remember('install', {
    ...h.example,
    id: 'previous',
    learnedFrom: 'earlier',
    text: 'Keep tutorial names short; put reference pages in Work.',
    evidence: preferenceEvidence(h.tree, ['a', 'b']),
  });
  h.tree.nodes.find(node => node.ref.nativeId === 'a')!.title = 'New explicit title';
  await h.learner.enqueue('new-title', 'install', [
    {
      ...h.example,
      text: 'Use New explicit title for this tutorial.',
      evidence: preferenceEvidence(h.tree, ['a']),
    },
  ]);
  await h.done();
  const payload = JSON.parse(JSON.parse(String(h.fetch.mock.calls[0]![1]?.body)).messages[1].content);
  expect(payload.examples[0].text).toContain('put reference pages in Work');
  expect(payload.examples).toHaveLength(2);
  expect(h.data[LEARNING_QUEUE_KEY]).toMatchObject([{ status: 'completed' }]);
});
