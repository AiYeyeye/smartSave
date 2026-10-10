import { describe, expect, it } from 'vitest';
import { parseModelEndpoint, parseModelListEndpoint } from '../domain/model-route';

const base = { model: 'm', timeoutMs: 1000 };

describe('URL join rules for chat and models', () => {
  it.each([
    ['https://model.example/v1', 'https://model.example/v1/chat/completions', 'https://model.example/v1/models', '/v1'],
    [
      'https://model.example/v1/',
      'https://model.example/v1/chat/completions',
      'https://model.example/v1/models',
      '/v1',
    ],
    [
      'https://model.example/proxy',
      'https://model.example/proxy/v1/chat/completions',
      'https://model.example/proxy/v1/models',
      '/proxy',
    ],
  ] as const)('openai-compatible %s keeps identity and joins once', (address, chat, models, path) => {
    const config = { ...base, adapter: 'openai-compatible' as const, baseUrl: address };
    expect(parseModelEndpoint(config).url).toBe(chat);
    expect(parseModelListEndpoint(config).url).toBe(models);
    expect(parseModelEndpoint(config).identity).toBe(
      JSON.stringify(['openai-compatible', 'https://model.example', path]),
    );
  });

  it('joins Anthropic messages and models without duplicating /v1', () => {
    expect(parseModelEndpoint({ ...base, adapter: 'anthropic', baseUrl: 'https://api.anthropic.com' }).url).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(parseModelEndpoint({ ...base, adapter: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }).url).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(parseModelListEndpoint({ adapter: 'anthropic', baseUrl: 'https://api.anthropic.com' }).url).toBe(
      'https://api.anthropic.com/v1/models',
    );
    expect(parseModelListEndpoint({ adapter: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' }).url).toBe(
      'https://api.anthropic.com/v1/models',
    );
  });

  it('treats /v3 /v4 and /openai bases as already versioned', () => {
    expect(parseModelListEndpoint({ adapter: 'openai-compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }).url).toBe(
      'https://open.bigmodel.cn/api/paas/v4/models',
    );
    expect(
      parseModelEndpoint({
        adapter: 'openai-compatible',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-2.5-flash',
        timeoutMs: 1000,
      }).url,
    ).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  });

  it('keeps Ollama tags/chat routes separate from OpenAI join', () => {
    expect(parseModelEndpoint({ ...base, adapter: 'ollama', baseUrl: 'http://localhost:11434' }).url).toBe(
      'http://localhost:11434/api/chat',
    );
    expect(parseModelListEndpoint({ adapter: 'ollama', baseUrl: 'http://localhost:11434' }).url).toBe(
      'http://localhost:11434/api/tags',
    );
  });

  it('openai-responses joins /responses not /chat/completions', () => {
    expect(parseModelEndpoint({ ...base, adapter: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }).url).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(parseModelEndpoint({ ...base, adapter: 'openai-responses', baseUrl: 'https://api.openai.com' }).url).toBe(
      'https://api.openai.com/v1/responses',
    );
    expect(parseModelListEndpoint({ adapter: 'openai-responses', baseUrl: 'https://api.openai.com/v1' }).url).toBe(
      'https://api.openai.com/v1/models',
    );
  });

  it('google-generative-ai joins generateContent and models under v1beta', () => {
    expect(
      parseModelEndpoint({
        ...base,
        adapter: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        model: 'gemini-2.5-flash',
      }).url,
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(
      parseModelEndpoint({
        ...base,
        adapter: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'models/gemini-2.0-flash',
      }).url,
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent');
    expect(
      parseModelListEndpoint({
        adapter: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      }).url,
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models');
  });
});
