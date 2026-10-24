import { describe, expect, it, vi } from 'vitest';
import { testConnection } from '../adapters/ai-connection';
import { modelRequestBody } from '../adapters/model-transport';
import { findVendor } from '../domain/ai-providers';
import { curatedModelsForPreset, modelPresets } from '../domain/model-presets';
import { parseModelEndpoint, type ModelConfig } from '../domain/model-route';
import { serviceStatusText } from '../options/ai-services/status-text';
import { modelSettingsNoticeText } from '../options/model-settings-text';
import { readWireReply } from '../adapters/model-stream';
import { tokenUsageAccumulator } from '../domain/token-usage';

const config: ModelConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.minimax.cn/v1',
  model: 'MiniMax-M3.1-Flash-Preview',
  timeoutMs: 1000,
};

describe('documented official provider request contracts', () => {
  it.each([
    ['openai-key', 'max_completion_tokens', true, true],
    ['google-gemini', 'max_tokens', true, true],
    ['xai-key', 'max_tokens', true, true],
    ['moonshot', 'max_tokens', true, true],
    ['zai', 'max_tokens', true, false],
    ['deepseek', 'max_tokens', true, true],
    ['qwen', 'max_tokens', false, true],
    ['zhipu', 'max_tokens', true, false],
    ['siliconflow', 'max_tokens', true, false],
    ['volc', 'max_tokens', false, true],
    ['minimax', 'max_completion_tokens', false, true],
    ['openrouter-key', 'max_tokens', false, false],
    ['groq', 'max_completion_tokens', true, true],
    ['mistral', 'max_tokens', true, false],
  ] as const)('builds default and explicit requests for %s', (id, tokenField, json, usage) => {
    const vendor = findVendor(id)!;
    const c = { ...config, baseUrl: vendor.baseUrl!, model: vendor.curatedModels?.[0] ?? 'account-model-id' };
    for (const streaming of [false, true]) {
      const body = JSON.parse(modelRequestBody({ ...c, streaming }, 'organize', '{}'));
      expect(body.max_tokens).toBeUndefined();
      expect(body.max_completion_tokens).toBeUndefined();
      expect(body.response_format).toEqual(json ? { type: 'json_object' } : undefined);
      expect(body.stream_options).toEqual(usage && streaming ? { include_usage: true } : undefined);
      const explicit = JSON.parse(modelRequestBody({ ...c, streaming, maxOutputTokens: 128000 }, 'organize', '{}'));
      expect(explicit[tokenField]).toBe(128000);
      expect(explicit[tokenField === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined();
    }
  });

  it.each([
    ['https://api.minimax.cn/v1', 'MiniMax-M2.7', 'max_tokens'],
    ['https://api.minimax.io/v1', 'MiniMax-M2.5', 'max_tokens'],
    ['https://api.moonshot.cn/v1', 'kimi-k3', 'max_completion_tokens'],
  ])('keeps model-specific token fields for %s %s', (baseUrl, model, field) => {
    const body = JSON.parse(modelRequestBody({ ...config, baseUrl, model, maxOutputTokens: 32000 }, 'search', '{}'));
    expect(body[field]).toBe(32000);
    expect(body[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens']).toBeUndefined();
  });

  it.each([
    ['claude-sonnet-5-5', 128000],
    ['claude-haiku-4-5', 64000],
    ['claude-opus-4-1', 32000],
    ['custom-model', 4096],
  ] as const)('supplies the mandatory Messages budget for %s', (model, limit) => {
    const c = { ...config, adapter: 'anthropic' as const, model };
    expect(JSON.parse(modelRequestBody(c, 'search', '{}')).max_tokens).toBe(limit);
    expect(JSON.parse(modelRequestBody({ ...c, maxOutputTokens: 128000 }, 'search', '{}')).max_tokens).toBe(128000);
  });

  it('shares all remote preset defaults and excludes retired catalog entries', () => {
    for (const preset of modelPresets.filter(p => !['ollama', 'lm-studio'].includes(p.adapter)))
      expect(preset.models).toEqual(curatedModelsForPreset(preset.id));
    expect(curatedModelsForPreset('deepseek')).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(curatedModelsForPreset('gemini')).not.toContain('gemini-2.0-flash');
    expect(curatedModelsForPreset('groq')).not.toContain('mixtral-8x7b-32768');
    expect(curatedModelsForPreset('volc')).toEqual([]);
  });
  it.each(['api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io'])(
    'uses documented MiniMax envelopes on %s without an unsupported JSON switch',
    host => {
      for (const adapter of ['openai-compatible', 'openai-responses'] as const)
        for (const streaming of [false, true])
          for (const maxOutputTokens of [undefined, 64000]) {
            const c = { ...config, baseUrl: `https://${host}/v1`, adapter, streaming, maxOutputTokens };
            const body = JSON.parse(modelRequestBody(c, 'search', '{}'));
            expect(body.stream).toBe(streaming);
            expect(body.response_format).toBeUndefined();
            expect(body.text).toBeUndefined();
            expect(body.max_completion_tokens ?? body.max_output_tokens).toBe(maxOutputTokens);
            expect(body.instructions ?? body.messages[0].content).toContain('Output schema:');
            expect(body.reasoning_effort ?? body.reasoning.effort).toBe('low');
            expect(body.stream_options).toEqual(
              streaming && adapter === 'openai-compatible' ? { include_usage: true } : undefined,
            );
          }
    },
  );

  it.each(['none', 'low', 'medium', 'high', 'default'] as const)(
    'maps MiniMax M3.1 effort %s without disabling mandatory thinking',
    reasoningEffort => {
      for (const adapter of ['openai-compatible', 'openai-responses'] as const) {
        const body = JSON.parse(modelRequestBody({ ...config, adapter, reasoningEffort }, 'search', '{}'));
        expect(body.reasoning_effort ?? body.reasoning?.effort).toBe(
          reasoningEffort === 'default' ? undefined : reasoningEffort === 'none' ? 'low' : reasoningEffort,
        );
        expect(body.thinking).toBeUndefined();
      }
    },
  );

  it.each([
    'https://open.bigmodel.cn/api/paas/v4',
    'https://api.z.ai/api/paas/v4',
    'https://api.deepseek.com/v1',
    'https://api.mistral.ai/v1',
  ])('uses max_tokens for the documented Chat contract at %s', baseUrl => {
    for (const streaming of [false, true]) {
      const body = JSON.parse(
        modelRequestBody({ ...config, baseUrl, streaming, maxOutputTokens: 32000 }, 'search', '{}'),
      );
      expect(body.max_tokens).toBe(32000);
      expect(body.max_completion_tokens).toBeUndefined();
      expect(body.response_format).toEqual({ type: 'json_object' });
    }
  });

  it.each(['https://gateway.test/v1', 'https://api.minimax.cn.example.org/v1', 'https://api.openai.com/v1'])(
    'does not infer provider capabilities from model names or lookalike hosts: %s',
    baseUrl => {
      const body = JSON.parse(modelRequestBody({ ...config, baseUrl }, 'search', '{}'));
      expect(body.max_completion_tokens).toBeUndefined();
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.reasoning_effort).toBeUndefined();
    },
  );

  it('uses distinct official GLM Chat and Responses bases without an extra version segment', () => {
    expect(parseModelEndpoint({ ...config, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }).url).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    );
    const c = { ...config, adapter: 'openai-responses' as const, baseUrl: 'https://open.bigmodel.cn/api/v1' };
    expect(parseModelEndpoint(c).url).toBe('https://open.bigmodel.cn/api/v1/responses');
    expect(JSON.parse(modelRequestBody(c, 'search', '{}'))).toMatchObject({
      text: { format: { type: 'json_object' } },
    });
  });

  it('omits undocumented GLM stream_options and reads usage on the final choice chunk', async () => {
    const c = { ...config, baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-5.3' };
    expect(JSON.parse(modelRequestBody(c, 'search', '{}')).stream_options).toBeUndefined();
    const usage = tokenUsageAccumulator(c.adapter);
    const frames = [
      { choices: [{ index: 0, delta: { content: '{"rankedIds":[]}' } }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      },
    ];
    const response = new Response(
      frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
    const wire = await readWireReply(response, c.adapter, 1024, undefined, undefined, undefined, undefined, raw =>
      usage.push(raw),
    );
    expect(wire.reply.text).toBe('{"rankedIds":[]}');
    expect(usage.snapshot()).toEqual({ input: 12, output: 5, total: 17 });
  });

  it('keeps legacy and current provider presets aligned without suggesting restricted MiniMax previews', () => {
    for (const id of ['minimax', 'zhipu', 'zai']) {
      expect(curatedModelsForPreset(id)).toEqual(findVendor(id)?.curatedModels);
      expect(modelPresets.find(p => p.id === id)?.baseUrl).toBe(findVendor(id)?.baseUrl);
    }
    expect(findVendor('minimax')?.curatedModels).toEqual(['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5']);
  });
});

describe('provider rejections through the real synthetic connection test', () => {
  it.each([
    ['https://api.minimax.cn/v1', 'MiniMax-M3', 'max_completion_tokens'],
    ['https://open.bigmodel.cn/api/paas/v4', 'glm-5.3', 'max_tokens'],
  ])(
    'sends the selected route, Bearer key and budget and validates a real task envelope at %s',
    async (baseUrl, model, budgetField) => {
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        expect(url).toBe(`${baseUrl}/chat/completions`);
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-key');
        expect(JSON.parse(String(init?.body))[budgetField]).toBeUndefined();
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assignments: [{ itemId: 'test-bookmark', folderId: 'test-docs' }],
                    newFolders: [],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
        );
      });
      expect(
        await testConnection({
          draft: { ...config, baseUrl, model, mode: 'openai', key: 'synthetic-key' },
          fetch: fetcher,
          contains: async () => true,
        }),
      ).toEqual({ status: 'completed', via: 'synthetic' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    ['openai', 422, { error: { type: 'unprocessable_entity_error', message: 'input new_sensitive (1026)' } }],
    [
      'openai-responses',
      400,
      { error: { code: 'image_content_policy_violation', message: 'input new_sensitive (1026)' } },
    ],
    ['openai', 400, { error: { code: 1026, message: 'Input rejected' } }],
    ['openai', 422, { base_resp: { status_code: 1026, status_msg: '输入内容涉敏' } }],
  ] as const)('classifies MiniMax %s HTTP %s content rejection without retrying', async (mode, status, body) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));
    const result = await testConnection({
      draft: { ...config, mode, key: 'synthetic-key' },
      fetch: fetcher,
      contains: async () => true,
    });
    expect(result).toEqual({ status: 'failed', reason: 'refused' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([400, 422])('keeps HTTP %s parameter errors separate from content filtering', async status => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: { message: 'invalid max_tokens (2013)' } }), { status }),
    );
    expect(
      await testConnection({
        draft: { ...config, mode: 'openai', key: '' },
        fetch: fetcher,
        contains: async () => true,
      }),
    ).toEqual({ status: 'failed', reason: `http-${status}` });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not replay an empty MiniMax response when no API JSON switch was sent', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })),
    );
    expect(
      await testConnection({
        draft: { ...config, mode: 'openai', key: '' },
        fetch: fetcher,
        contains: async () => true,
      }),
    ).toEqual({ status: 'failed', reason: 'empty' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('still rejects invalid proposal IDs when MiniMax API JSON mode is omitted', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    assignments: [{ itemId: 'test-bookmark', folderId: 'unknown' }],
                    newFolders: [],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
        ),
    );
    expect(
      await testConnection({
        draft: { ...config, mode: 'openai', key: '' },
        fetch: fetcher,
        contains: async () => true,
      }),
    ).toEqual({ status: 'failed', reason: 'schema' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('shows owned, bilingual content-filter explanations without remote error text', () => {
    expect(serviceStatusText('zh-CN', '分类测试失败：refused')).toContain('内容审核');
    expect(serviceStatusText('en', '分类测试失败：refused')).toContain('blocked its content');
    expect(modelSettingsNoticeText('en', { kind: 'test-failed', reason: 'http-400' })).toContain(
      'supported output limit',
    );
    expect(serviceStatusText('en', '合成分类测试通过：refused')).toContain('refused');
  });
});
