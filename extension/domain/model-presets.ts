import type { ModelConfig } from './model-route';
// Convenience defaults only, not capability detection. Custom IDs always remain available.
export const modelPresets: ReadonlyArray<{
  id: string;
  name: string;
  adapter: ModelConfig['adapter'];
  baseUrl: string;
  models: readonly string[];
}> = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.openai.com',
    models: ['gpt-4.1-mini', 'gpt-4.1'],
  },
  {
    id: 'claude',
    name: 'Claude',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    // Curated fallback when GET /v1/models is unavailable; discovery replaces when the endpoint works.
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  { id: 'ollama', name: 'Ollama（本地）', adapter: 'ollama', baseUrl: 'http://localhost:11434', models: [] },
  { id: 'lm-studio', name: 'LM Studio（本地）', adapter: 'lm-studio', baseUrl: 'http://localhost:1234', models: [] },
];

export function curatedModelsForPreset(presetId: string): readonly string[] {
  return modelPresets.find(item => item.id === presetId)?.models ?? [];
}
