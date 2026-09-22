import { describe, expect, it, vi } from 'vitest';
import { SettingsStore, type SettingsLock } from '../persistence/settings';
import { ModelTransport } from '../adapters/model-transport';
import { readModelResponse } from '../adapters/model-byte-limits';
import { serializeAiPayload } from '../domain/ai-payload';
import type { TreeSnapshot } from '../domain/node-reference';
const config = { adapter: 'openai-compatible' as const, baseUrl: 'https://a.test/proxy', model: 'm', timeoutMs: 1000 };
const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [{ installationId: 'i', nativeId: 'private', kind: 'folder' as const }] };
const tree: TreeSnapshot = { installationId: 'i', epoch: 'e', observedRevision: 1, roots: ['root'], nodes: [
  { ref: { installationId: 'i', nativeId: 'root', kind: 'folder' }, title: 'Root', index: 0, childrenIds: ['private'], readOnly: false, observedRevision: 1 },
  { ref: { installationId: 'i', nativeId: 'private', kind: 'folder' }, title: 'SECRET', parentId: 'root', index: 0, childrenIds: ['hidden'], readOnly: false, observedRevision: 1 },
  { ref: { installationId: 'i', nativeId: 'hidden', kind: 'bookmark' }, title: 'SECRET', url: 'https://secret.test/?secret#secret', parentId: 'private', index: 0, childrenIds: [], readOnly: false, observedRevision: 1 },
] };
function disk() {
  const data: Record<string, unknown> = {}; let tail = Promise.resolve();
  const lock: SettingsLock = operation => { const next = tail.then(operation); tail = next.then(() => {}, () => {}); return next; };
  const storage = { get: async (key: string) => ({ [key]: structuredClone(data[key]) }), set: async (value: Record<string, unknown>) => { Object.assign(data, structuredClone(value)); }, remove: async (key: string) => { delete data[key]; }, setAccessLevel: async () => {} };
  return { data, storage, lock, store: () => new SettingsStore(storage, lock) };
}
const request = { task: 'search' as const, query: 'synthetic', itemIds: [], folderIds: [] };
async function setup() {
  const d = disk(); const store = d.store(); await store.load(); await store.save(config, privacy, 'key-a', true);
  let currentTree = tree;
  const authority = { read: async () => ({ ...await store.snapshot(), tree: currentTree }), subscribe: (listener: () => void) => store.subscribe(listener) };
  const input = { config, privacy, key: 'key-a', tree, request };
  return { d, store, authority, input, changeTree: () => { currentTree = { ...tree, observedRevision: 2 }; } };
}
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rankedIds: [] }) } }] }));
describe('atomic settings security envelope', () => {
  it('concurrent pages cannot mix credentials/configuration or overwrite stale settings', async () => {
    const d = disk(); const a = d.store(); const b = d.store(); await a.load(); await b.load();
    const results = await Promise.allSettled([a.save(config, privacy, 'key-a', true), b.save({ ...config, baseUrl: 'https://b.test' }, privacy, 'key-b', true)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']);
    const reopened = d.store(); await reopened.load(); expect(await reopened.snapshot()).toMatchObject({ config, key: 'key-a' });
    expect(JSON.stringify(d.data)).not.toContain('key-b');
  });
  it('delete rotates revision and prevents stale page republishing remembered key', async () => {
    const { d, store } = await setup(); const stale = d.store(); await stale.load(); const before = await store.snapshot();
    await store.clearCredential(); expect((await store.snapshot()).revision).not.toBe(before.revision);
    await expect(stale.save(config, privacy, 'key-a', true)).rejects.toThrow('conflict');
    expect(JSON.stringify(d.data)).not.toContain('key-a');
  });
  it('migrates configuration but never reuses unbound legacy credentials', async () => {
    const d = disk(); d.data.modelSettings = { version: 1, config, privacy, revision: 'legacy' }; d.data.modelCredential = 'unbound';
    const store = d.store(); await store.load(); expect(await store.snapshot()).toMatchObject({ config, key: '' }); expect(store.legacyCredentialDiscarded).toBe(true); expect(d.data.modelCredential).toBeUndefined();
  });
});
describe('transport-owned freshness', () => {
  it.each(['privacy', 'tree', 'config'] as const)('blocks stale %s before fetch without UI listeners', async kind => {
    const { authority, input, d, changeTree } = await setup(); const fetcher = vi.fn();
    const transport = new ModelTransport({ fetch: fetcher, contains: async () => {
      if (kind === 'tree') changeTree(); else { const other = d.store(); await other.load(); await other.save(kind === 'config' ? { ...config, baseUrl: 'https://b.test' } : config, { ...privacy, fullUrl: true }, 'key-b', true); } return true;
    } }, authority);
    expect(await transport.run(input)).toMatchObject({ status: 'failed', reason: 'stale-context' }); expect(fetcher).not.toHaveBeenCalled(); transport.dispose();
  });
  it.each(['privacy', 'tree', 'delete', 'permission'] as const)('rejects inflight %s changes', async kind => {
    const { authority, input, d, store, changeTree } = await setup(); let release!: (value: Response) => void; let granted = true;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
    const transport = new ModelTransport({ fetch: fetcher, contains: async () => granted }, authority);
    const pending = transport.run(input); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    if (kind === 'tree') changeTree(); if (kind === 'permission') granted = false;
    if (kind === 'delete') await store.clearCredential();
    if (kind === 'privacy') { const other = d.store(); await other.load(); await other.save(config, { ...privacy, fullUrl: true }, 'key-a', true); }
    release(response()); expect((await pending).status).not.toBe('completed'); transport.dispose();
  });
});
describe('final provenance', () => {
  it.each(['save', 'import-classify'] as const)('resolves existing %s from tree and excludes hidden content', task => {
    const item = { source: 'bookmark' as const, id: 'hidden', title: 'forged', url: 'https://forged.test' };
    const payload = serializeAiPayload(tree, privacy, task === 'save' ? { task, targetId: 'root', item, folderIds: [] } : { task, targetId: 'root', items: [item], folderIds: [] });
    expect(JSON.parse(payload).items).toEqual([]); expect(payload).not.toMatch(/SECRET|forged|secret.test/);
  });
  it('fails closed on unknown mapping provenance and free-text query tokens, retains legitimate new samples', () => {
    const base = { task: 'import-map' as const, targetId: 'root', folderIds: [] };
    expect(() => serializeAiPayload(tree, privacy, { ...base, fields: [{ path: ['url'], samples: [{ value: 'secret', kind: 'text' } as never] }] })).toThrow('invalid-provenance');
    expect(() => serializeAiPayload(tree, privacy, { ...base, fields: [{ path: ['url'], samples: [{ source: 'new-import', value: 'See https://a.test/?secret', kind: 'text' }] }] })).toThrow('unsafe-text-sample');
    const payload = serializeAiPayload(tree, privacy, { ...base, fields: [{ path: ['url'], samples: [{ source: 'bookmark', contextId: 'hidden', field: 'url' }, { source: 'new-import', value: 'https://a.test/?secret#x', kind: 'url' }, { source: 'new-import', value: 'Useful title', kind: 'text' }] }] });
    expect(JSON.parse(payload).fields[0].samples).toEqual(['https://a.test/', 'Useful title']);
  });
});
describe('byte limits', () => {
  it('counts multibyte response bytes at the exact limit without Content-Length', async () => {
    const text = '"文"'; const bytes = new TextEncoder().encode(text).byteLength;
    await expect(readModelResponse(new Response(text), bytes)).resolves.toBe('文');
    await expect(readModelResponse(new Response(text), bytes - 1)).rejects.toThrow('response-too-large');
  });
  it('cancels over-limit stream instead of parsing a partial response', async () => {
    const cancel = vi.fn(); const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); }, cancel });
    await expect(readModelResponse(new Response(stream), 4)).rejects.toThrow('response-too-large'); expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects final UTF-8 request above injected budget before fetch', async () => {
    const { authority, input } = await setup(); const fetcher = vi.fn();
    const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority, { requestBytes: 1, responseBytes: 1024 });
    expect(await transport.run(input)).toEqual({ status: 'failed', reason: 'payload-too-large' }); expect(fetcher).not.toHaveBeenCalled(); transport.dispose();
  });
});

it('route identity distinguishes adapters, ports and paths while normalizing origin', async () => {
  const { parseModelEndpoint } = await import('../domain/model-route');
  const original = parseModelEndpoint(config);
  expect(parseModelEndpoint({ ...config, baseUrl: 'https://A.test:443/proxy/' }).identity).toBe(original.identity);
  for (const changed of [{ ...config, adapter: 'lm-studio' as const }, { ...config, baseUrl: 'https://a.test:444/proxy' }, { ...config, baseUrl: 'https://a.test/other' }]) expect(parseModelEndpoint(changed).identity).not.toBe(original.identity);
});
it('migration failure preserves legacy configuration and credential for retry without using them', async () => {
  const d = disk(); d.data.modelSettings = { version: 1, config, privacy, revision: 'old' }; d.data.modelCredential = 'old-key';
  const store = new SettingsStore({ ...d.storage, set: async () => { throw Error('quota'); } }, d.lock);
  await expect(store.load()).rejects.toThrow('settings-unavailable'); expect(d.data.modelCredential).toBe('old-key'); expect(d.data.modelSettings).toBeDefined(); expect(store.credential()).toBe('');
});
it('lock failure has no unlocked persistence fallback', async () => {
  const d = disk(); const set = vi.fn(d.storage.set);
  const store = new SettingsStore({ ...d.storage, set }, async () => { throw Error('unavailable'); });
  await expect(store.load()).rejects.toThrow('settings-unavailable'); await expect(store.save(config, privacy, 'key', true)).rejects.toThrow(); expect(set).not.toHaveBeenCalled();
});
it('concurrent save wins before stale delete and delete does not clobber the new route', async () => {
  const { d, store } = await setup(); const other = d.store(); await other.load();
  const result = await Promise.allSettled([other.save({ ...config, baseUrl: 'https://b.test' }, privacy, 'key-b', true), store.clearCredential()]);
  expect(result.map(r => r.status)).toEqual(['fulfilled', 'rejected']); expect(await other.snapshot()).toMatchObject({ key: 'key-b', config: { baseUrl: 'https://b.test' } });
});
it('session-only deletion invalidates inflight authority without persisting the session key', async () => {
  const { d, store, authority } = await setup(); await store.save(config, privacy, 'session-key', false);
  const before = await authority.read(); expect(JSON.stringify(d.data)).not.toContain('session-key');
  await store.clearCredential(); expect((await authority.read()).revision).not.toBe(before.revision); expect((await authority.read()).key).toBe('');
});
it('request byte boundary counts final multibyte adapter envelope exactly', async () => {
  const { authority, input } = await setup(); let body = '';
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { body = String(init?.body); return response(); });
  const first = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  const candidate = { ...input, request: { ...request, query: '文' } };
  expect((await first.run(candidate)).status).toBe('completed'); first.dispose();
  const bytes = new TextEncoder().encode(body).byteLength;
  const exact = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority, { requestBytes: bytes, responseBytes: 1024 });
  expect((await exact.run(candidate)).status).toBe('completed'); exact.dispose();
  const tooSmall = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority, { requestBytes: bytes - 1, responseBytes: 1024 });
  expect(await tooSmall.run(candidate)).toMatchObject({ reason: 'payload-too-large' }); tooSmall.dispose(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it('saving unchanged settings keeps revision, disk and subscribers untouched; a real change still rotates', async () => {
  const { d, store } = await setup(); const listener = vi.fn(); store.subscribe(listener); const before = await store.snapshot(); const written = JSON.stringify(d.data);
  expect((await store.save(config, privacy, 'key-a', true)).revision).toBe(before.revision);
  expect(await store.snapshot()).toEqual(before); expect(JSON.stringify(d.data)).toBe(written); expect(listener).not.toHaveBeenCalled();
  await store.save(config, privacy, 'key-a', false);
  expect((await store.snapshot()).revision).not.toBe(before.revision); expect(listener).toHaveBeenCalledOnce(); expect(JSON.stringify(d.data)).not.toContain('key-a');
});
it('credential deletion that cannot persist neither clears the session nor announces a deletion', async () => {
  const d = disk(); let fail = false;
  const store = new SettingsStore({ ...d.storage, set: async (value: Record<string, unknown>) => { if (fail) throw Error('quota'); await d.storage.set(value); } }, d.lock);
  await store.load(); await store.save(config, privacy, 'key-a', true); const listener = vi.fn(); store.subscribe(listener); const before = await store.snapshot();
  fail = true; await expect(store.clearCredential()).rejects.toThrow('settings-unavailable');
  expect(await store.snapshot()).toEqual(before); expect(store.credential()).toBe('key-a'); expect(listener).not.toHaveBeenCalled();
  fail = false; const other = d.store(); await other.load(); await other.savePrivacy({ ...privacy, fullUrl: true });
  await expect(store.clearCredential()).rejects.toThrow('settings-unavailable');
  expect(listener).not.toHaveBeenCalled(); expect((await store.snapshot()).key).toBe('key-a'); expect(JSON.stringify(d.data)).toContain('key-a');
});
