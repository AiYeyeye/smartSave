import { describe, expect, it, vi } from 'vitest';
import { listModels } from '../adapters/model-discovery';
import { modelRequestBody, ModelTransport } from '../adapters/model-transport';
import { SettingsStore } from '../persistence/settings';

describe('listModels discovery', () => {
  it('GETs openai-compatible /models with Bearer auth and same /v1 join', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }, { id: 'gpt-4.1' }] })),
    );
    const result = await listModels({
      adapter: 'openai-compatible',
      baseUrl: 'https://api.openai.com',
      timeoutMs: 5000,
      key: 'sk-test',
      fetch: fetcher,
      contains: async () => true,
    });
    expect(result).toEqual({ status: 'completed', models: ['gpt-4.1', 'gpt-4.1-mini'], source: 'remote' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
        credentials: 'omit',
        redirect: 'error',
      }),
    );
  });

  it('uses Anthropic x-api-key and version headers; curated fallback on list failure', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 }));
    const result = await listModels({
      adapter: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      timeoutMs: 5000,
      key: 'ak-test',
      fetch: fetcher,
      contains: async () => true,
      presetId: 'claude',
    });
    expect(result.status).toBe('completed');
    if (result.status === 'completed') {
      expect(result.source).toBe('curated');
      expect(result.models.length).toBeGreaterThan(0);
    }
    const listInit = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(listInit[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          'x-api-key': 'ak-test',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });

  it('surfaces 401 without curated success and requires permission first', async () => {
    expect(
      await listModels({
        adapter: 'openai-compatible',
        baseUrl: 'https://api.openai.com',
        timeoutMs: 1000,
        key: '',
        fetch: vi.fn(),
        contains: async () => false,
      }),
    ).toEqual({ status: 'failed', reason: 'permission' });
    const fetcher = vi.fn(async () => new Response('no', { status: 401 }));
    expect(
      await listModels({
        adapter: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        timeoutMs: 1000,
        key: 'bad',
        fetch: fetcher,
        contains: async () => true,
        presetId: 'claude',
      }),
    ).toEqual({ status: 'failed', reason: 'http-401' });
  });
});

describe('Anthropic native chat mapping', () => {
  it('sends Messages API headers/body and reads content[].text', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"rankedIds":[]}' }] })),
    );
    const box: { last?: Parameters<ModelTransport['run']>[0] } = {};
    const authority = {
      read: async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...box.last! }),
      subscribe: () => () => {},
    };
    const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
    const config = {
      adapter: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      timeoutMs: 10000,
      streaming: false,
    };
    const tree = {
      installationId: 'i',
      epoch: 'e',
      observedRevision: 1,
      roots: ['root'],
      nodes: [
        {
          ref: { installationId: 'i', nativeId: 'root', kind: 'folder' as const },
          title: 'Root',
          index: 0,
          childrenIds: [],
          readOnly: false,
          observedRevision: 1,
        },
      ],
    };
    const privacy = { fullUrl: true, bodyEnabled: false, excludedFolders: [] };
    const input = {
      config,
      key: 'ak-test',
      tree,
      privacy,
      request: { task: 'search' as const, query: '', itemIds: [], folderIds: [] },
    };
    box.last = structuredClone(input);
    const result = await transport.run(input);
    expect(result).toEqual({ status: 'completed', output: { rankedIds: [] } });
    const chatCall = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(chatCall[0]).toBe('https://api.anthropic.com/v1/messages');
    expect(chatCall[1]).toEqual(
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
          'x-api-key': 'ak-test',
        },
      }),
    );
    const body = JSON.parse(String(chatCall[1].body));
    expect(body).toMatchObject({
      model: 'claude-sonnet-4-5',
      max_tokens: 64000,
      stream: false,
      messages: [{ role: 'user', content: expect.any(String) }],
    });
    expect(body.system).toContain('Return only one JSON object');
    expect(body.messages[0].role).toBe('user');
    expect(body).not.toHaveProperty('response_format');
    const envelope = JSON.parse(modelRequestBody(config, 'search', '{"task":"search"}'));
    expect(envelope.system).toBeTruthy();
    expect(envelope.messages).toHaveLength(1);
  });
});

describe('OpenAI Responses chat mapping', () => {
  it('POSTs /responses with instructions+input and reads output_text', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ output_text: '{"rankedIds":[]}', output: [] })));
    const box: { last?: Parameters<ModelTransport['run']>[0] } = {};
    const authority = {
      read: async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...box.last! }),
      subscribe: () => () => {},
    };
    const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
    const config = {
      adapter: 'openai-responses' as const,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4.1-mini',
      timeoutMs: 10000,
      streaming: false,
    };
    const tree = {
      installationId: 'i',
      epoch: 'e',
      observedRevision: 1,
      roots: ['root'],
      nodes: [
        {
          ref: { installationId: 'i', nativeId: 'root', kind: 'folder' as const },
          title: 'Root',
          index: 0,
          childrenIds: [],
          readOnly: false,
          observedRevision: 1,
        },
      ],
    };
    const privacy = { fullUrl: true, bodyEnabled: false, excludedFolders: [] };
    const input = {
      config,
      key: 'sk-test',
      tree,
      privacy,
      request: { task: 'search' as const, query: '', itemIds: [], folderIds: [] },
    };
    box.last = structuredClone(input);
    const result = await transport.run(input);
    expect(result).toEqual({ status: 'completed', output: { rankedIds: [] } });
    const chatCall = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(chatCall[0]).toBe('https://api.openai.com/v1/responses');
    expect(chatCall[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
    const body = JSON.parse(String(chatCall[1].body));
    expect(body).toMatchObject({
      model: 'gpt-4.1-mini',
      stream: false,
      input: [
        { role: 'developer', content: expect.stringContaining('JSON') },
        { role: 'user', content: expect.any(String) },
      ],
      text: { format: { type: 'json_object' } },
    });
    expect(body.instructions).toContain('Return only one JSON object');
    expect(body).not.toHaveProperty('messages');
  });
});

describe('Google Generative AI chat and list mapping', () => {
  it('GETs /models with x-goog-api-key and strips models/ prefix', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.0-flash' }],
          }),
        ),
    );
    const result = await listModels({
      adapter: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      timeoutMs: 5000,
      key: 'gk-test',
      fetch: fetcher,
      contains: async () => true,
    });
    expect(result).toEqual({
      status: 'completed',
      models: ['gemini-2.0-flash', 'gemini-2.5-flash'],
      source: 'remote',
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'x-goog-api-key': 'gk-test' }),
      }),
    );
  });

  it('POSTs generateContent with systemInstruction/contents and reads candidates', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '{"rankedIds":[]}' }] } }],
          }),
        ),
    );
    const box: { last?: Parameters<ModelTransport['run']>[0] } = {};
    const authority = {
      read: async () => ({ version: 1 as const, revision: 'r', sessionRevision: 0, ...box.last! }),
      subscribe: () => () => {},
    };
    const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
    const config = {
      adapter: 'google-generative-ai' as const,
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      model: 'gemini-2.5-flash',
      timeoutMs: 10000,
      streaming: false,
    };
    const tree = {
      installationId: 'i',
      epoch: 'e',
      observedRevision: 1,
      roots: ['root'],
      nodes: [
        {
          ref: { installationId: 'i', nativeId: 'root', kind: 'folder' as const },
          title: 'Root',
          index: 0,
          childrenIds: [],
          readOnly: false,
          observedRevision: 1,
        },
      ],
    };
    const privacy = { fullUrl: true, bodyEnabled: false, excludedFolders: [] };
    const input = {
      config,
      key: 'gk-test',
      tree,
      privacy,
      request: { task: 'search' as const, query: '', itemIds: [], folderIds: [] },
    };
    box.last = structuredClone(input);
    const result = await transport.run(input);
    expect(result).toEqual({ status: 'completed', output: { rankedIds: [] } });
    const chatCall = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(chatCall[0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
    );
    expect(chatCall[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-goog-api-key': 'gk-test' }),
      }),
    );
    const body = JSON.parse(String(chatCall[1].body));
    expect(body.systemInstruction.parts[0].text).toContain('Return only one JSON object');
    expect(body.contents[0].role).toBe('user');
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('messages');
  });
});

describe('presetId restore', () => {
  it('persists optional presetId and restores without changing route identity', async () => {
    const data: Record<string, unknown> = {};
    const disk = {
      get: async () => structuredClone(data),
      set: async (values: Record<string, unknown>) => {
        Object.assign(data, structuredClone(values));
      },
      remove: async (key: string) => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    };
    const store = new SettingsStore(disk, async op => op());
    await store.load();
    const config = {
      adapter: 'anthropic' as const,
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4-5',
      timeoutMs: 60000,
    };
    await store.save(config, { fullUrl: true, bodyEnabled: false, excludedFolders: [] }, 'k', true, 'claude');
    const reopened = new SettingsStore(disk, async op => op());
    const loaded = await reopened.load();
    expect(loaded.presetId).toBe('claude');
    expect(loaded.config).toEqual(config);
    expect(JSON.stringify(data.modelSecurity)).toContain('"presetId":"claude"');
  });
});
