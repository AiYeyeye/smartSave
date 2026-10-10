import type { ModelConfig } from './model-route';
import { KEY_VENDORS } from './ai-providers';

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
    name: 'Anthropic',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    // Curated fallback when GET /v1/models is unavailable; discovery replaces when the endpoint works.
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    adapter: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro'],
  },
  {
    id: 'xai',
    name: 'xAI',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-3', 'grok-3-mini'],
  },
  {
    id: 'moonshot',
    name: 'Kimi / 月之暗面',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-128k', 'kimi-latest'],
  },
  {
    id: 'qwen',
    name: '通义千问',
    adapter: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max'],
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    adapter: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.5', 'glm-4-flash'],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: [],
  },
  {
    id: 'volc',
    name: '火山方舟',
    adapter: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    adapter: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [],
  },
  {
    id: 'groq',
    name: 'Groq',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'mistral-large-latest'],
  },
  {
    id: 'zai',
    name: 'Z.AI',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-4.5', 'glm-4-flash'],
  },
  { id: 'ollama', name: 'Ollama（本地）', adapter: 'ollama', baseUrl: 'http://localhost:11434', models: [] },
  { id: 'lm-studio', name: 'LM Studio（本地）', adapter: 'lm-studio', baseUrl: 'http://localhost:1234', models: [] },
];

export function curatedModelsForPreset(presetId: string): readonly string[] {
  const fromPreset = modelPresets.find(item => item.id === presetId)?.models;
  if (fromPreset?.length) return fromPreset;
  // Map legacy/ui vendor ids (openai-key, anthropic-key, claude) onto curated lists.
  const alias: Record<string, string> = {
    claude: 'anthropic-key',
    openai: 'openai-key',
    'openai-key': 'openai-key',
    'anthropic-key': 'anthropic-key',
  };
  const vendorId = alias[presetId] ?? presetId;
  const vendor = KEY_VENDORS.find(v => v.id === vendorId || v.id === presetId);
  return vendor?.curatedModels ?? [];
}
