import type { ModelConfig } from './model-route';

/** Official hosts only: a model name or a custom gateway is not a capability declaration. */
export function officialModelProvider(baseUrl: string) {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return undefined;
  }
  if (['api.minimax.cn', 'api.minimaxi.com', 'api.minimax.io'].includes(host)) return 'minimax';
  if (['open.bigmodel.cn', 'api.z.ai'].includes(host)) return 'glm';
  if (host === 'api.deepseek.com') return 'deepseek';
  if (host === 'api.mistral.ai') return 'mistral';
  if (['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com'].includes(host))
    return 'qwen';
  if (['api.moonshot.cn', 'api.moonshot.ai'].includes(host)) return 'moonshot';
  if (['api.siliconflow.cn', 'api.siliconflow.com'].includes(host)) return 'siliconflow';
  if (host === 'ark.cn-beijing.volces.com') return 'volc';
  if (host === 'openrouter.ai') return 'openrouter';
  if (host === 'api.groq.com') return 'groq';
  if (host === 'api.x.ai') return 'xai';
  if (host === 'generativelanguage.googleapis.com') return 'google';
  return undefined;
}

/** Reviewed provider contracts are linked in docs/reference/model-protocols.md. */
export function chatOutputTokenField(config: Pick<ModelConfig, 'baseUrl' | 'model'>) {
  const provider = officialModelProvider(config.baseUrl);
  if (provider === 'minimax')
    return /^MiniMax-M3(?:[.-]|$)/i.test(config.model) ? 'max_completion_tokens' : 'max_tokens';
  if (provider === 'moonshot') return /^kimi-k3(?:[.-]|$)/i.test(config.model) ? 'max_completion_tokens' : 'max_tokens';
  return provider &&
    ['glm', 'deepseek', 'mistral', 'qwen', 'siliconflow', 'volc', 'openrouter', 'xai', 'google'].includes(provider)
    ? 'max_tokens'
    : 'max_completion_tokens';
}

export function supportsStreamUsage(config: Pick<ModelConfig, 'baseUrl'>) {
  // These providers return usage without the OpenAI opt-in or do not document that parameter.
  return !['glm', 'mistral', 'siliconflow', 'openrouter'].includes(officialModelProvider(config.baseUrl) ?? '');
}

export function supportsApiJsonMode(config: Pick<ModelConfig, 'baseUrl' | 'adapter'>) {
  // MiniMax Chat does not document response_format; Responses only documents text.format.type=text.
  // The system prompt and strict local output validation still require the task's JSON schema.
  const provider = officialModelProvider(config.baseUrl);
  if (provider === 'minimax' && ['openai-compatible', 'openai-responses'].includes(config.adapter)) return false;
  // JSON enforcement varies by model/thinking mode or the downstream provider. Keep the schema prompt
  // and strict local validation, without claiming every catalog entry supports this optional API flag.
  if (config.adapter === 'openai-compatible' && ['qwen', 'volc', 'openrouter'].includes(provider ?? '')) return false;
  return true;
}
