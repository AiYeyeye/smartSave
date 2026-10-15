import { afterEach, expect, it, vi } from 'vitest';
import { testConnection } from '../adapters/ai-connection';
import { SettingsStore } from '../persistence/settings';

const output = { assignments: [{ itemId: 'test-bookmark', folderId: 'test-docs' }], newFolders: [] };
const draft = {
  mode: 'openai-responses' as const,
  baseUrl: 'https://draft.test/v1',
  model: 'new-model',
  key: 'draft-key',
  streaming: false,
  timeoutMs: 1000,
  maxOutputTokens: 64000,
};
function store() {
  const data: Record<string, unknown> = {};
  const settings = new SettingsStore(
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
  return { data, settings };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('tests draft classification without saving, primary-route comparison or real tree access', async () => {
  const { settings, data } = store();
  await settings.load();
  await settings.save(
    { adapter: 'anthropic', baseUrl: 'https://saved.test', model: 'old-model', timeoutMs: 60000 },
    { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    'saved-key',
    true,
  );
  const before = structuredClone(data);
  const save = vi.spyOn(settings, 'save');
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe('new-model');
    expect(body.stream).toBe(false);
    expect(body.max_output_tokens).toBe(64000);
    const payload = JSON.parse(body.input);
    expect(payload.task).toBe('save');
    expect(payload.items).toHaveLength(1);
    expect(payload.folderTree.split('\n')).toHaveLength(2);
    expect(payload.folderTree).toContain('"test-docs" "Documentation"');
    expect(JSON.stringify(body)).not.toContain('saved-key');
    return new Response(
      JSON.stringify({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }],
      }),
    );
  }) as typeof fetch;
  expect(await testConnection({ draft, settings, fetch: fetcher, contains: async () => true })).toEqual({
    status: 'completed',
    via: 'synthetic',
  });
  expect(vi.mocked(fetcher).mock.calls[0]![0]).toBe('https://draft.test/v1/responses');
  expect(save).not.toHaveBeenCalled();
  expect(data).toEqual(before);
  expect((await settings.snapshot()).config?.model).toBe('old-model');
  settings.dispose();
});

it.each([
  { rankedIds: [] },
  { assignments: [], newFolders: [] },
  { assignments: [{ itemId: 'test-bookmark', folderId: 'unknown' }], newFolders: [] },
])('rejects a response that does not classify the synthetic bookmark: %j', async result => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }),
      ),
  );
  expect(
    await testConnection({ draft: { ...draft, mode: 'openai' }, fetch: fetcher, contains: async () => true }),
  ).toEqual({ status: 'failed', reason: 'schema' });
});

it('does not substitute model-list reachability for a generation test', async () => {
  const fetcher = vi.fn();
  expect(await testConnection({ draft: { ...draft, model: '' }, fetch: fetcher })).toEqual({
    status: 'failed',
    reason: 'model-required',
  });
  expect(fetcher).not.toHaveBeenCalled();
});

it('cancel during privacy loading returns promptly and cannot send a later request', async () => {
  const { settings } = store();
  const fetcher = vi.fn();
  let resolve: (value: Awaited<ReturnType<SettingsStore['snapshot']>>) => void = () => {};
  vi.spyOn(settings, 'snapshot').mockImplementation(
    () =>
      new Promise(done => {
        resolve = done;
      }),
  );
  const controller = new AbortController();
  const promise = testConnection({
    draft,
    settings,
    fetch: fetcher,
    contains: async () => true,
    signal: controller.signal,
  });
  controller.abort();
  expect(await promise).toEqual({ status: 'failed', reason: 'cancelled' });
  resolve({
    version: 1,
    revision: '',
    sessionRevision: 0,
    key: '',
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
  });
  await Promise.resolve();
  expect(fetcher).not.toHaveBeenCalled();
  settings.dispose();
});

it('privacy loading belongs to the test deadline', async () => {
  vi.useFakeTimers();
  const { settings } = store();
  const fetcher = vi.fn();
  vi.spyOn(settings, 'snapshot').mockImplementation(() => new Promise(() => {}));
  const promise = testConnection({ draft, settings, fetch: fetcher });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await promise).toEqual({ status: 'failed', reason: 'timeout' });
  expect(fetcher).not.toHaveBeenCalled();
  settings.dispose();
});

it('does not leave the preparation timer running across a live SSE response, even if JSON was requested', async () => {
  vi.useFakeTimers();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const promise = testConnection({
    draft,
    contains: async () => true,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            source = c;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 3; i++) {
    await vi.advanceTimersByTimeAsync(700);
    source.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
  }
  const events = [
    { type: 'response.output_text.delta', delta: JSON.stringify(output) },
    { type: 'response.completed', response: { status: 'completed' } },
  ];
  source.enqueue(new TextEncoder().encode(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')));
  source.close();
  expect(await promise).toEqual({ status: 'completed', via: 'synthetic' });
  expect(vi.getTimerCount()).toBe(0);
});

it('settings invalidation during generation aborts the test and cleans listeners', async () => {
  const { settings } = store();
  await settings.load();
  const listeners = new Set<() => void>();
  const removals = new Set<() => void>();
  vi.spyOn(settings, 'subscribe').mockImplementation(fn => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  });
  vi.stubGlobal('chrome', {
    permissions: {
      onRemoved: {
        addListener: (fn: () => void) => removals.add(fn),
        removeListener: (fn: () => void) => removals.delete(fn),
      },
    },
  });
  const fetcher = vi.fn(() => new Promise<Response>(() => {}));
  const promise = testConnection({ draft, settings, fetch: fetcher, contains: async () => true });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  listeners.forEach(fn => fn());
  expect(await promise).toEqual({ status: 'failed', reason: 'cancelled' });
  expect(listeners.size).toBe(0);
  expect(removals.size).toBe(0);
  settings.dispose();
});
