import { expect, it, vi } from 'vitest';
import { SettingsStore } from '../persistence/settings';
import { browserModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
vi.mock('../panel/tree-client', () => ({ connectTree: (_runtime: unknown, listener: (value: unknown) => void) => { listener({ status: 'ready', snapshot: { installationId: 'i', epoch: 'e', observedRevision: 0, roots: [], nodes: [] } }); return () => {}; } }));
it.each([['tree.expanded.i', 'local', true], ['siteRules', 'local', true], ['modelSecurity', 'sync', true], ['modelSecurity', 'local', false]] as const)('filters %s in %s without losing authority invalidation', async (key, area, completes) => {
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  const event = { addListener: (f: (changes: Record<string, unknown>, area: string) => void) => listeners.add(f), removeListener: (f: (changes: Record<string, unknown>, area: string) => void) => listeners.delete(f) };
  vi.stubGlobal('chrome', { runtime: {}, storage: { onChanged: event }, permissions: { onRemoved: { addListener: () => {}, removeListener: () => {} } } });
  const data: Record<string, unknown> = {};
  const store = new SettingsStore({ get: async key => ({ [key]: data[key] }), set: async value => { Object.assign(data, value); }, remove: async key => { delete data[key]; }, setAccessLevel: async () => {} }, run => run());
  await store.load();
  const config = { adapter: 'openai-compatible' as const, baseUrl: 'https://model.test', model: 'm', timeoutMs: 10000 };
  await store.save(config, { fullUrl: true, bodyEnabled: false, excludedFolders: [] }, '', false);
  const authority = browserModelAuthority(store);
  let release!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  try {
    const state = await authority.read();
    const pending = transport.run({ ...state, config, request: { task: 'search', query: 'synthetic', itemIds: [], folderIds: [] } });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    for (const listener of listeners) listener({ [key]: { newValue: {} } }, area);
    release(new Response(JSON.stringify({ choices: [{ message: { content: '{"rankedIds":[]}' } }] })));
    expect((await pending).status === 'completed').toBe(completes);
  } finally { transport.dispose(); store.dispose(); expect(listeners.size).toBe(0); vi.unstubAllGlobals(); }
});
