import { expect, it, vi } from 'vitest';
import { organizeModelAuthority } from '../background/organize-model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { syntheticConnectionTree } from '../adapters/ai-connection';
import { settingsIdentity } from '../domain/context-dependencies';

it('uses the same bound temporary key in every fresh authority read without changing stored settings', async () => {
  const tree = syntheticConnectionTree();
  const context = {
    version: 1 as const,
    revision: 'stored-revision',
    sessionRevision: 99,
    key: '',
    config: { adapter: 'openai-compatible' as const, baseUrl: 'https://models.test/v1', model: 'm', timeoutMs: 1000 },
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
  };
  const settings = { snapshot: async () => structuredClone(context), subscribe: () => () => {} };
  const projection = {
    fresh: async () => structuredClone(tree),
    subscribe: () => () => {},
  };
  const grant = { revision: context.revision, identity: settingsIdentity(context), key: 'temporary-test-key' };
  const authority = organizeModelAuthority(projection, settings, grant);
  grant.key = 'caller-replaced-it';
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: '{"rankedIds":["test-bookmark"]}',
              },
            },
          ],
        }),
      ),
  );
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  const current = await authority.read();
  expect(current.key).toBe('temporary-test-key');
  expect(current.sessionRevision).toBe(99); // Never compare another page's private session counter.
  const result = await transport.run({
    ...current,
    config: current.config!,
    request: {
      task: 'search',
      query: 'test',
      itemIds: ['test-bookmark'],
      folderIds: [],
    },
  });
  expect(result.status).toBe('completed');
  expect(fetcher).toHaveBeenCalledOnce();
  expect(context.key).toBe('');
  context.revision = 'revoked';
  await expect(authority.read()).rejects.toThrow('stale-context');
  transport.dispose();
});
