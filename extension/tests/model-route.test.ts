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

  it('keeps Ollama tags/chat routes separate from OpenAI join', () => {
    expect(parseModelEndpoint({ ...base, adapter: 'ollama', baseUrl: 'http://localhost:11434' }).url).toBe(
      'http://localhost:11434/api/chat',
    );
    expect(parseModelListEndpoint({ adapter: 'ollama', baseUrl: 'http://localhost:11434' }).url).toBe(
      'http://localhost:11434/api/tags',
    );
  });
});
