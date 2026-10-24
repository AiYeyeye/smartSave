import type { ModelConfig } from './model-route';
import { KEY_VENDORS } from './ai-providers';

const vendorAliases: Record<string, string> = {
  openai: 'openai-key',
  claude: 'anthropic-key',
  gemini: 'google-gemini',
  xai: 'xai-key',
  openrouter: 'openrouter-key',
};
type ModelPreset = {
  id: string;
  name: string;
  adapter: ModelConfig['adapter'];
  baseUrl: string;
  models: readonly string[];
};

// Both settings screens share the same reviewed defaults. Discovery and custom IDs remain available.
export const modelPresets: readonly ModelPreset[] = [
  ...[
    'deepseek',
    'openai',
    'claude',
    'gemini',
    'xai',
    'moonshot',
    'qwen',
    'zhipu',
    'siliconflow',
    'volc',
    'minimax',
    'openrouter',
    'groq',
    'mistral',
    'zai',
  ].flatMap(id => {
    const vendor = KEY_VENDORS.find(v => v.id === (vendorAliases[id] ?? id));
    return vendor?.baseUrl
      ? [
          {
            id,
            name: vendor.name,
            adapter: vendor.adapter,
            baseUrl: vendor.baseUrl,
            models: vendor.curatedModels ?? [],
          },
        ]
      : [];
  }),
  { id: 'ollama', name: 'Ollama（本地）', adapter: 'ollama', baseUrl: 'http://localhost:11434', models: [] },
  { id: 'lm-studio', name: 'LM Studio（本地）', adapter: 'lm-studio', baseUrl: 'http://localhost:1234', models: [] },
];

export function curatedModelsForPreset(presetId: string): readonly string[] {
  return KEY_VENDORS.find(v => v.id === (vendorAliases[presetId] ?? presetId))?.curatedModels ?? [];
}
