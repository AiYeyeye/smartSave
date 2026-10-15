import type { ModelConfig } from './model-route';

/** Verified provider/model capabilities only. An OpenAI-shaped gateway is not evidence of a capability. */
export function modelThinkingPlan(config: ModelConfig) {
  if (config.fastMode === false) return undefined;
  let host: string;
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {
    return undefined;
  }
  const openai = config.adapter === 'openai-compatible' || config.adapter === 'openai-responses';
  if (host === 'api.openai.com' && openai) {
    const effort =
      config.model === 'o3-mini'
        ? 'low'
        : ['gpt-5', 'gpt-5-mini', 'gpt-5-nano'].includes(config.model)
          ? 'minimal'
          : config.model === 'gpt-5.1'
            ? 'none'
            : undefined;
    if (!effort) return undefined;
    return {
      key: `openai-${effort}`,
      fields: ['reasoning_effort', 'reasoning'],
      top: config.adapter === 'openai-responses' ? { reasoning: { effort } } : { reasoning_effort: effort },
      generation: {},
    };
  }
  if (host === 'generativelanguage.googleapis.com' && config.adapter === 'google-generative-ai') {
    const model = config.model.replace(/^models\//, '');
    const thinkingConfig =
      model === 'gemini-2.5-flash'
        ? { thinkingBudget: 0 }
        : model === 'gemini-2.5-pro'
          ? { thinkingBudget: 128 }
          : model === 'gemini-3-flash-preview'
            ? { thinkingLevel: 'minimal' }
            : ['gemini-3-pro-preview', 'gemini-3.1-pro-preview'].includes(model)
              ? { thinkingLevel: 'low' }
              : undefined;
    if (!thinkingConfig) return undefined;
    return {
      key: `google-${JSON.stringify(thinkingConfig)}`,
      fields: [
        'thinkingConfig',
        'thinkingBudget',
        'thinkingLevel',
        'thinking_config',
        'thinking_budget',
        'thinking_level',
      ],
      top: {},
      generation: { thinkingConfig },
    };
  }
  if (
    ['api.z.ai', 'open.bigmodel.cn'].includes(host) &&
    config.adapter === 'openai-compatible' &&
    ['glm-4.5', 'glm-4.5-air'].includes(config.model)
  ) {
    return { key: 'glm-disabled', fields: ['thinking'], top: { thinking: { type: 'disabled' } }, generation: {} };
  }
  if (host === 'api.deepseek.com' && openai && config.model === 'deepseek-flash') {
    return {
      key: 'deepseek-disabled',
      fields: ['thinking', 'reasoning'],
      top:
        config.adapter === 'openai-responses' ? { reasoning: { effort: 'none' } } : { thinking: { type: 'disabled' } },
      generation: {},
    };
  }
  return undefined;
}

/** Only a clear rejection of an automatically added field permits a one-time compatibility replay. */
export function rejectsThinkingParameter(status: number, message: string, fields: string[]) {
  return (
    [400, 422].includes(status) &&
    fields.some(field => message.toLowerCase().includes(field.toLowerCase())) &&
    /unsupported|not supported|unknown (?:parameter|field)|unrecognized|not allowed|not available|does not support|invalid value|only supports|不支持/i.test(
      message,
    )
  );
}
