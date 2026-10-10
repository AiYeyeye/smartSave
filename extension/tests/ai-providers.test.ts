import { describe, expect, it } from 'vitest';
import { KEY_VENDORS, SUB_VENDORS, apiModeToAdapter, findVendor } from '../domain/ai-providers';
import { parseModelEndpoint, parseModelListEndpoint } from '../domain/model-route';
import { curatedModelsForPreset, modelPresets } from '../domain/model-presets';

describe('AI provider catalog', () => {
  it('includes required API-key vendors with Anthropic display name', () => {
    const names = KEY_VENDORS.map(v => v.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'OpenAI',
        'Anthropic',
        'Google Gemini',
        'xAI',
        'Kimi / 月之暗面',
        'Z.AI',
        'DeepSeek',
        '通义千问 / DashScope',
        '智谱 AI',
        'SiliconFlow',
        '火山方舟',
        'MiniMax',
        'OpenRouter',
        'Groq',
        'Mistral',
        '自定义端点',
      ]),
    );
    expect(names.some(n => n === 'Claude')).toBe(false);
    expect(modelPresets.find(p => p.id === 'claude')?.name).toBe('Anthropic');
  });

  it('marks every subscription vendor as not silently succeeding OAuth', () => {
    for (const v of SUB_VENDORS) {
      expect(v.oauth === 'needs-browser-flow' || v.oauth === 'unsupported').toBe(true);
      expect(v.oauthNote?.length).toBeGreaterThan(10);
    }
  });

  it('maps UI modes to transport adapters', () => {
    expect(apiModeToAdapter('openai')).toBe('openai-compatible');
    expect(apiModeToAdapter('openai-responses')).toBe('openai-compatible');
    expect(apiModeToAdapter('anthropic')).toBe('anthropic');
  });

  it('joins versioned CN / Gemini bases without duplicating /v1', () => {
    expect(parseModelListEndpoint({ adapter: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }).url).toBe(
      'https://open.bigmodel.cn/api/paas/v4/models',
    );
    expect(parseModelEndpoint({ adapter: 'openai-compatible', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'm', timeoutMs: 1 }).url).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    );
    expect(
      parseModelListEndpoint({
        adapter: 'openai-compatible',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      }).url,
    ).toBe('https://generativelanguage.googleapis.com/v1beta/openai/models');
  });

  it('exposes curated fallbacks for Anthropic and DeepSeek', () => {
    expect(curatedModelsForPreset('claude').length).toBeGreaterThan(0);
    expect(findVendor('deepseek')?.curatedModels).toContain('deepseek-chat');
  });
});
