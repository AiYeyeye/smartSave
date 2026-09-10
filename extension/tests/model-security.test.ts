import { describe, expect, it } from 'vitest';
import { serializeAiPayload } from '../domain/ai-payload';
import type { TreeSnapshot } from '../domain/node-reference';
const tree: TreeSnapshot = { installationId: 'i', epoch: 'e', observedRevision: 1, roots: ['root'], nodes: [
  ['root', undefined, 'Root', undefined], ['private', 'root', 'SECRET', undefined], ['hidden', 'private', 'SECRET CHILD', 'http://intranet/a?q=secret#x'], ['public', 'root', 'Public', 'http://intranet/a?q=ok#x'],
].map(([id, parentId, title, url]) => ({ ref: { installationId: 'i', nativeId: id!, kind: url ? 'bookmark' : 'folder' }, parentId, title: title!, url, index: 0, childrenIds: [], readOnly: false, observedRevision: 1 })) };
const privacy = { fullUrl: true, bodyEnabled: false, excludedFolders: [{ installationId: 'i', nativeId: 'private', kind: 'folder' as const }] };
describe('final AI payload boundary', () => {
  it('filters recursive exclusions and directory references without changing native URLs', () => {
    const request = { task: 'search' as const, query: 'find', itemIds: ['hidden', 'public'], folderIds: ['root', 'private'] };
    const full = serializeAiPayload(tree, privacy, request);
    expect(full).not.toContain('SECRET'); expect(full).not.toContain('hidden');
    expect(full).toContain('http://intranet/a?q=ok#x');
    expect(serializeAiPayload(tree, { ...privacy, fullUrl: false }, request)).toContain('http://intranet/a');
    expect(serializeAiPayload(tree, { ...privacy, fullUrl: false }, request)).not.toContain('?q=');
    expect(tree.nodes[3]?.url).toBe('http://intranet/a?q=ok#x');
  });
});

import { parseModelEndpoint, ModelTransport } from '../adapters/model-transport';
import { SettingsStore } from '../persistence/settings';
import { parseModelOutput } from '../schemas/model-output';
import { vi } from 'vitest';
const config = { adapter: 'openai-compatible' as const, baseUrl: 'https://model.example/proxy', model: 'explicit-model', timeoutMs: 60000 };
function storage() {
  const data: Record<string, unknown> = {};
  return { data, get: vi.fn(async () => structuredClone(data)), set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }), remove: vi.fn(async (key: string) => { delete data[key]; }), setAccessLevel: vi.fn(async () => {}) };
}

function makeTransport(boundary: ConstructorParameters<typeof ModelTransport>[0]) {
  let last: Parameters<ModelTransport['run']>[0];
  const authority = { read: async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...last }), subscribe: () => () => {} };
  const transport = new ModelTransport(boundary, authority);
  return { cancel: () => transport.cancel(), run(input: Parameters<ModelTransport['run']>[0]) { last = structuredClone(input); return transport.run(input); } };
}
describe('model settings and credential storage', () => {
  it('keeps default keys in page session, remembers only explicitly, and deletes remembered keys', async () => {
    const disk = storage(); const settings = new SettingsStore(disk, async operation => operation());
    await settings.load(); await settings.save(config, privacy, 'test-only-key', false);
    expect(JSON.stringify(disk.data)).not.toContain('test-only-key');
    expect(settings.credential()).toBe('test-only-key');
    const reopened = new SettingsStore(disk, async operation => operation()); await reopened.load(); expect(reopened.credential()).toBe('');
    await settings.save(config, privacy, 'test-only-key', true);
    const remembered = new SettingsStore(disk, async operation => operation()); await remembered.load(); expect(remembered.credential()).toBe('test-only-key');
    await remembered.clearCredential(); expect(JSON.stringify(disk.data)).not.toContain('test-only-key');
  });
  it('retries trusted storage initialization instead of caching a rejected promise', async () => {
    const disk = storage(); disk.setAccessLevel.mockRejectedValueOnce(Error('private error'));
    const settings = new SettingsStore(disk, async operation => operation());
    await expect(settings.load()).rejects.toThrow('settings-unavailable');
    await expect(settings.load()).resolves.toMatchObject({ privacy: { fullUrl: true, bodyEnabled: false } });
  });
});
describe('controlled model endpoint', () => {
  it.each(['http://localhost:11434', 'http://127.9.8.7:80', 'http://[::1]:1234', 'https://192.168.1.1'])('allows approved endpoint %s', address => {
    expect(parseModelEndpoint({ ...config, baseUrl: address }).url).toContain('/v1/chat/completions');
  });
  it.each(['http://192.168.1.2', 'http://localhost.example', 'https://user:secret@model.example', 'https://model.example/#key', 'https://model.example/?key=x', 'file:///tmp/model'])('rejects unsafe endpoint %s', address => {
    expect(() => parseModelEndpoint({ ...config, baseUrl: address })).toThrow('invalid-endpoint');
  });
});
describe('local output validation', () => {
  const context = { task: 'search' as const, items: [{ id: 'a', title: 'A', url: 'https://a.test' }], folders: [] };
  it('accepts only real candidate IDs and no URL/code/action additions', () => {
    expect(parseModelOutput({ rankedIds: ['a'] }, context)).toEqual({ rankedIds: ['a'] });
    for (const output of [{ rankedIds: ['unknown'] }, { rankedIds: ['a', 'a'] }, { rankedIds: ['a'], url: 'https://evil.test' }, { code: 'alert(1)' }]) expect(() => parseModelOutput(output, context)).toThrow('invalid-output');
  });
});
describe('single attempt model transport', () => {
  it('uses frozen explicit routing, omits credentials, forbids redirects, and validates output', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"rankedIds":["public"]}' } }] })));
    const contains = vi.fn(async () => true);
    const transport = makeTransport({ fetch: fetcher, contains });
    const result = await transport.run({ config, key: 'test-only-key', tree, privacy, request: { task: 'search', query: 'find', itemIds: ['public'], folderIds: [] } });
    expect(result).toEqual({ status: 'completed', output: { rankedIds: ['public'] } });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]).toEqual(['https://model.example/proxy/v1/chat/completions', expect.objectContaining({ credentials: 'omit', redirect: 'error', method: 'POST' })]);
    expect(contains).toHaveBeenCalledWith({ origins: ['https://model.example/*'] });
  });
});

import { createElement } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ModelSettings } from '../options/ModelSettings';
it('shows explicit model configuration, privacy defaults, and a non-vault warning without invoking models', async () => {
  const store = new SettingsStore(storage(), async operation => operation());
  render(createElement(ModelSettings, { store }));
  expect(await screen.findByLabelText('发送完整网址（含查询参数和片段）')).toBeChecked();
  expect(screen.getByLabelText('正文辅助（仅主动收藏）')).not.toBeChecked();
  expect(screen.getByText(/不是操作系统保险库/)).toBeVisible();
  fireEvent.change(screen.getByLabelText('服务基础地址'), { target: { value: 'http://remote.example' } });
  fireEvent.click(screen.getByText('保存模型设置'));
  expect(await screen.findByRole('alert')).toHaveTextContent('配置或存储不可用');
});

it.each([401, 403, 429, 500])('classifies HTTP %s without leaking response or key', async status => {
  const fetcher = vi.fn(async () => new Response('sensitive-provider-body', { status }));
  const transport = makeTransport({ fetch: fetcher, contains: async () => true });
  const result = await transport.run({ config, key: 'test-only-key', tree, privacy, request: { task: 'search', query: 'find', itemIds: ['public'], folderIds: [] } });
  expect(result).toEqual({ status: 'failed', reason: status === 500 ? 'http-error' : `http-${status}` });
  expect(fetcher).toHaveBeenCalledOnce();
});
it('rejects an old response after cancellation even if fetch ignores abort', async () => {
  let release!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { release = resolve; }));
  const transport = makeTransport({ fetch: fetcher, contains: async () => true });
  const pending = transport.run({ config, key: '', tree, privacy, request: { task: 'search', query: 'find', itemIds: ['public'], folderIds: [] } });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); transport.cancel();
  release(new Response('{"choices":[{"message":{"content":"{\\"rankedIds\\":[\\"public\\"]}"}}]}'));
  expect(await pending).toEqual({ status: 'cancelled', reason: 'cancelled' });
});
it('does not send without permission', async () => {
  const fetcher = vi.fn(); const transport = makeTransport({ fetch: fetcher, contains: async () => false });
  expect(await transport.run({ config, key: '', tree, privacy, request: { task: 'search', query: '', itemIds: [], folderIds: [] } })).toEqual({ status: 'failed', reason: 'permission' });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['save', 'import-map', 'import-classify'] as const)('blocks excluded %s target before sending any samples', task => {
  const request = task === 'save' ? { task, targetId: 'private', item: { source: 'current-page' as const, id: 'x', title: 'SECRET', url: 'https://x.test' }, folderIds: [] } : task === 'import-map' ? { task, targetId: 'private', fields: [], folderIds: [] } : { task, targetId: 'private', items: [{ source: 'new-import' as const, id: 'x', title: 'SECRET', url: 'https://x.test' }], folderIds: [] };
  expect(() => serializeAiPayload(tree, privacy, request)).toThrow('privacy-excluded');
});
it('body is opt-in, save-only and capped at 1500 characters', () => {
  const request = { task: 'save' as const, targetId: 'root', item: { source: 'current-page' as const, id: 'x', title: 'X', url: 'https://x.test' }, folderIds: [], snippet: '文'.repeat(1501) };
  expect(JSON.parse(serializeAiPayload(tree, privacy, request))).not.toHaveProperty('snippet');
  expect(JSON.parse(serializeAiPayload(tree, { ...privacy, bodyEnabled: true }, request)).snippet).toHaveLength(1500);
});
it.each(['ollama', 'lm-studio'] as const)('constructs explicit %s structured protocol without fallback', async adapter => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(adapter === 'ollama' ? { message: { content: '{"rankedIds":[]}' } } : { choices: [{ message: { content: '{"rankedIds":[]}' } }] })));
  const transport = makeTransport({ fetch: fetcher, contains: async () => true });
  const result = await transport.run({ config: { ...config, adapter }, key: '', tree, privacy, request: { task: 'search', query: '', itemIds: [], folderIds: [] } });
  expect(result.status).toBe('completed'); expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.stringify(fetcher.mock.calls)).toContain(adapter === 'ollama' ? '/api/chat' : 'json_schema');
});
it('settles timeout without waiting for a server that never answers', async () => {
  vi.useFakeTimers();
  try {
    const transport = makeTransport({ fetch: async () => new Promise<Response>(() => {}), contains: async () => true });
    const result = transport.run({ config: { ...config, timeoutMs: 40000 }, key: '', tree, privacy, request: { task: 'search', query: '', itemIds: [], folderIds: [] } });
    await vi.advanceTimersByTimeAsync(40001);
    expect(await result).toEqual({ status: 'failed', reason: 'timeout' });
  } finally { vi.useRealTimers(); }
});
it('mapping sends only projected field samples and accepts only offered field paths', () => {
  const request = { task: 'import-map' as const, targetId: 'root', fields: [{ path: ['link'], samples: [{ source: 'new-import' as const, value: 'http://intranet/a?q=ok#x', kind: 'url' as const }] }], folderIds: [] };
  const payload = JSON.parse(serializeAiPayload(tree, { ...privacy, fullUrl: false }, request));
  expect(payload.fields).toEqual([{ path: ['link'], samples: ['http://intranet/a'] }]);
  expect(parseModelOutput({ urlPath: ['link'], titlePath: null }, payload)).toEqual({ urlPath: ['link'], titlePath: null });
  expect(() => parseModelOutput({ urlPath: ['fake'], titlePath: null }, payload)).toThrow('invalid-output');
});
it('rejects organize moves into current descendants even without an explicit output cycle', () => {
  const context = { task: 'organize', items: [{ id: 'parent', title: 'Parent' }], folders: [{ id: 'child', ancestorIds: ['parent'] }] };
  expect(() => parseModelOutput({ moves: [{ itemId: 'parent', folderId: 'child' }], newFolders: [], merges: [] }, context)).toThrow('invalid-output');
});
