import { expect, it, vi } from 'vitest';
import { searchModelAuthority } from '../adapters/search-model-authority';
import { ModelTransport } from '../adapters/model-transport';
import type { ModelAuthority } from '../adapters/model-authority';
import { AiServicesStore } from '../persistence/ai-services';
import { searchTree } from './fixtures/search-tree';

async function setup() {
  const data: Record<string, unknown> = {};
  const store = new AiServicesStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async patch => {
        Object.assign(data, patch);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    operation => operation(),
  );
  await store.load();
  const context = {
    version: 1 as const,
    revision: 'save',
    sessionRevision: 0,
    tree: searchTree(),
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://save.test',
      model: 'save-model',
      timeoutMs: 1000,
    },
    key: 'save-key',
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
  };
  const base: ModelAuthority = { read: async () => structuredClone(context), subscribe: () => () => {} };
  const service = {
    id: 'search-connection',
    name: 'Search',
    serviceType: 'API',
    kind: 'api' as const,
    detail: '',
    baseUrl: 'https://search.test',
    mode: 'openai-responses' as const,
    status: 'ok' as const,
    letter: 'S',
    avatarClass: 'custom',
    catalog: [{ id: 'search-model', ctx: '' }],
    enabled: ['search-model'],
    streaming: false,
    maxOutputTokens: 48000,
  };
  const assign = async (modelId: string) =>
    store.saveFeatures(
      store
        .snapshotServices()
        .features.map(feature => (feature.id === 'search' ? { ...feature, connId: service.id, modelId } : feature)),
    );
  return { data, store, base, context, service, assign };
}

it('uses the search assignment and same-session key without changing collection settings or credentials', async () => {
  const f = await setup();
  await f.store.upsertService(f.service, 'search-key', false);
  await f.assign('search-model');
  const authority = searchModelAuthority(f.base, f.store);
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output_text: '{"rankedIds":["1"]}',
        }),
      ),
  );
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  const context = await authority.read();
  expect(context.key).toBe('search-key');
  expect(context.config?.model).toBe('search-model');
  expect(context.config?.maxOutputTokens).toBe(48000);
  expect(context.privacy).toEqual(f.context.privacy);
  const before = JSON.stringify(f.data);
  const result = await transport.run({
    ...context,
    config: context.config!,
    request: { task: 'search', query: '学习', itemIds: ['1'], folderIds: [] },
  });
  expect(result.status).toBe('completed');
  expect(fetcher.mock.calls[0]).toEqual(expect.arrayContaining(['https://search.test/v1/responses']));
  expect(JSON.stringify(f.data)).toBe(before);
  expect(JSON.stringify(f.data)).not.toContain('search-key');
  expect((await f.base.read()).config?.model).toBe('save-model');
  transport.dispose();
  f.store.dispose();
});

it('changing the search assignment cancels a pending request and prevents old result delivery', async () => {
  const f = await setup();
  await f.store.upsertService(f.service, 'search-key', true);
  await f.assign('search-model');
  const authority = searchModelAuthority(f.base, f.store);
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  const context = await authority.read();
  const pending = transport.run({
    ...context,
    config: context.config!,
    request: { task: 'search', query: '学习', itemIds: ['1'], folderIds: [] },
  });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await f.assign('new-model');
  expect(await pending).toEqual({ status: 'cancelled', reason: 'cancelled' });
  transport.dispose();
  f.store.dispose();
});

it('supports legacy settings but does not silently use collection models for an unassigned multi-service search', async () => {
  const f = await setup();
  const authority = searchModelAuthority(f.base, f.store);
  expect((await authority.read()).config?.model).toBe('save-model');
  await f.store.upsertService(f.service, 'search-key', true);
  await expect(authority.read()).rejects.toThrow('unavailable');
  f.store.dispose();
});
