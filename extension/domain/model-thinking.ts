import { DEFAULT_REASONING_EFFORT, type ModelConfig, type ReasoningEffort } from './model-route';
import { officialModelProvider } from './model-provider';

const openaiEffort = (adapter: ModelConfig['adapter'], effort: string) => ({
  key: `openai-${effort}`,
  fields: ['reasoning_effort', 'reasoning'],
  top: adapter === 'openai-responses' ? { reasoning: { effort } } : { reasoning_effort: effort },
  generation: {},
});
/** OpenAI reasoning families, also when a gateway serves them under a vendor prefix (e.g. openai/gpt-5.2). */
const OPENAI_REASONING_MODEL = /^(?:[\w.-]+\/)*(?:gpt-5|o[134])(?:[.-]|$)/i;

/** The service's chosen effort; older records only had the fast-mode switch (off = leave the model's default). */
export function reasoningEffortOf(config: Pick<ModelConfig, 'reasoningEffort' | 'fastMode'>): ReasoningEffort {
  return config.reasoningEffort ?? (config.fastMode === false ? 'default' : DEFAULT_REASONING_EFFORT);
}

/**
 * The user's thinking effort, translated per provider. OpenAI reasoning models (gpt-5*, o1/o3/o4, also behind
 * gateways) take it directly; Gemini, GLM and DeepSeek only have verified "think less" controls, used for none/low.
 * 'default' sends nothing. A gateway that rejects the field is replayed once without it and remembered for a day
 * (rejectsThinkingParameter). Thinking tokens count against the output limit, so low is the default.
 */
export function modelThinkingPlan(config: ModelConfig) {
  const effort = reasoningEffortOf(config);
  if (effort === 'default') return undefined;
  const lighter = effort === 'none' || effort === 'low';
  let host: string;
  try {
    host = new URL(config.baseUrl).hostname;
  } catch {
    return undefined;
  }
  const openai = config.adapter === 'openai-compatible' || config.adapter === 'openai-responses';
  if (openai && officialModelProvider(config.baseUrl) === 'minimax' && config.model === 'MiniMax-M3.1-Flash-Preview') {
    // This model always reasons; "none" is rejected. Use the lowest documented effort instead.
    const value = effort === 'none' ? 'low' : effort;
    return {
      key: `minimax-${value}`,
      fields: ['reasoning_effort', 'reasoning'],
      top: config.adapter === 'openai-responses' ? { reasoning: { effort: value } } : { reasoning_effort: value },
      generation: {},
    };
  }
  if (openai && OPENAI_REASONING_MODEL.test(config.model)) {
    const bare = config.model.replace(/^(?:[\w.-]+\/)*/, '');
    // "none" exists from gpt-5.1; gpt-5 (mini/nano) bottom out at minimal and the o-series at low.
    const value =
      effort !== 'none'
        ? effort
        : /^gpt-5(?:-(?:mini|nano))?$/i.test(bare)
          ? 'minimal'
          : /^o[134]/i.test(bare)
            ? 'low'
            : 'none';
    return openaiEffort(config.adapter, value);
  }
  if (!lighter) return undefined;
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
