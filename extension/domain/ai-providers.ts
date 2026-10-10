import type { ModelAdapter } from './model-route';

/** UI protocol mode shown in the AI services edit form. */
export type ApiMode = 'openai' | 'openai-responses' | 'anthropic';

export type ServiceKind = 'api' | 'sub';

/** Honest OAuth readiness — never claim success without a real browser flow. */
export type OAuthStatus =
  | 'unsupported' // no public OAuth for extensions yet
  | 'needs-browser-flow' // possible later via chrome.identity / launchWebAuthFlow; not wired
  | 'api-key-only'; // subscription tile is decorative; use API key path

export type ProviderVendor = {
  id: string;
  name: string;
  subtitle: string;
  avatarClass: string;
  letter: string;
  kind: ServiceKind;
  /** Default adapter for API-key / custom endpoint connections. */
  adapter: ModelAdapter;
  baseUrl?: string;
  isCustom?: boolean;
  /** Curated model IDs when list API is unavailable. */
  curatedModels?: readonly string[];
  oauth?: OAuthStatus;
  /** Optional note shown in the subscription dialog. */
  oauthNote?: string;
};

export function apiModeToAdapter(mode: ApiMode): ModelAdapter {
  if (mode === 'anthropic') return 'anthropic';
  // openai-responses is not implemented in ModelTransport; treat as OpenAI-compatible chat.
  return 'openai-compatible';
}

export function adapterToApiMode(adapter: ModelAdapter): ApiMode {
  return adapter === 'anthropic' ? 'anthropic' : 'openai';
}

/** Subscription / OAuth tiles — UI stubs only until a real browser OAuth flow is implemented. */
export const SUB_VENDORS: readonly ProviderVendor[] = [
  {
    id: 'anthropic-sub',
    name: 'Anthropic',
    subtitle: '用 Claude Pro/Max 登录',
    avatarClass: 'c-anthropic',
    letter: 'A',
    kind: 'sub',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    curatedModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
    oauth: 'needs-browser-flow',
    oauthNote: 'Claude Pro/Max 订阅登录需要浏览器 OAuth（chrome.identity / launchWebAuthFlow），当前未接入。请改用 API Key。',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    subtitle: '用 GitHub 账号登录',
    avatarClass: 'c-github',
    letter: 'G',
    kind: 'sub',
    adapter: 'openai-compatible',
    oauth: 'needs-browser-flow',
    oauthNote: 'GitHub Copilot 需要 GitHub OAuth + 设备码/令牌交换，扩展内尚未实现。',
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    subtitle: '用 Kimi 订阅登录',
    avatarClass: 'c-kimi',
    letter: 'K',
    kind: 'sub',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    oauth: 'needs-browser-flow',
    oauthNote: 'Kimi 订阅登录需要官方 OAuth；请使用「月之暗面」API Key 连接。',
  },
  {
    id: 'meta-sub',
    name: 'Meta',
    subtitle: '用 Meta AI 订阅登录',
    avatarClass: 'c-meta',
    letter: 'M',
    kind: 'sub',
    adapter: 'openai-compatible',
    oauth: 'unsupported',
    oauthNote: 'Meta AI 订阅暂无面向浏览器扩展的公开 OAuth/API 接入。',
  },
  {
    id: 'openai-sub',
    name: 'OpenAI',
    subtitle: '用 ChatGPT 订阅登录',
    avatarClass: 'c-openai',
    letter: 'O',
    kind: 'sub',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    curatedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o3-mini'],
    oauth: 'needs-browser-flow',
    oauthNote: 'ChatGPT 订阅登录需要 OpenAI OAuth；当前未接入。请改用 API Key（可自定义 Base URL）。',
  },
  {
    id: 'openrouter-oauth',
    name: 'OpenRouter OAuth',
    subtitle: '用 OpenRouter 账号登录',
    avatarClass: 'c-openrouter',
    letter: 'R',
    kind: 'sub',
    adapter: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    oauth: 'needs-browser-flow',
    oauthNote: 'OpenRouter OAuth/PKCE 需浏览器授权回调，尚未接线。请使用 OpenRouter API Key。',
  },
  {
    id: 'xai-sub',
    name: 'xAI',
    subtitle: '用 Grok/X 订阅登录',
    avatarClass: 'c-xai',
    letter: 'x',
    kind: 'sub',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    oauth: 'needs-browser-flow',
    oauthNote: 'xAI/Grok 订阅登录需要浏览器 OAuth，尚未实现。请使用 xAI API Key。',
  },
];

/** API Key vendors shown in「添加服务」. OpenAI / Anthropic allow custom Base URL in the slide panel. */
export const KEY_VENDORS: readonly ProviderVendor[] = [
  {
    id: 'custom',
    name: '自定义端点',
    subtitle: 'OpenAI / Anthropic 兼容地址',
    avatarClass: 'plus',
    letter: '+',
    kind: 'api',
    adapter: 'openai-compatible',
    isCustom: true,
  },
  {
    id: 'openai-key',
    name: 'OpenAI',
    subtitle: 'api.openai.com/v1',
    baseUrl: 'https://api.openai.com/v1',
    avatarClass: 'c-openai',
    letter: 'O',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'o3-mini'],
  },
  {
    id: 'anthropic-key',
    name: 'Anthropic',
    subtitle: 'api.anthropic.com',
    baseUrl: 'https://api.anthropic.com',
    avatarClass: 'c-anthropic',
    letter: 'A',
    kind: 'api',
    adapter: 'anthropic',
    curatedModels: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'],
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    subtitle: 'generativelanguage.googleapis.com (OpenAI 兼容)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    avatarClass: 'c-google',
    letter: 'G',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  },
  {
    id: 'xai-key',
    name: 'xAI',
    subtitle: 'api.x.ai/v1',
    baseUrl: 'https://api.x.ai/v1',
    avatarClass: 'c-xai',
    letter: 'x',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['grok-3', 'grok-3-mini', 'grok-2'],
  },
  {
    id: 'moonshot',
    name: 'Kimi / 月之暗面',
    subtitle: 'api.moonshot.cn/v1',
    baseUrl: 'https://api.moonshot.cn/v1',
    avatarClass: 'c-moonshot',
    letter: 'K',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
  },
  {
    id: 'zai',
    name: 'Z.AI',
    subtitle: 'api.z.ai/api/paas/v4',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    avatarClass: 'c-zai',
    letter: 'Z',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    subtitle: 'api.deepseek.com/v1',
    baseUrl: 'https://api.deepseek.com/v1',
    avatarClass: 'c-deepseek',
    letter: 'D',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    id: 'qwen',
    name: '通义千问 / DashScope',
    subtitle: 'dashscope.aliyuncs.com/compatible-mode/v1',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    avatarClass: 'c-qwen',
    letter: '通',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'],
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    subtitle: 'open.bigmodel.cn/api/paas/v4',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    avatarClass: 'c-zhipu',
    letter: '智',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['glm-4.5', 'glm-4-flash', 'glm-4-plus'],
  },
  {
    id: 'siliconflow',
    name: 'SiliconFlow',
    subtitle: 'api.siliconflow.cn/v1',
    baseUrl: 'https://api.siliconflow.cn/v1',
    avatarClass: 'c-siliconflow',
    letter: 'S',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  {
    id: 'volc',
    name: '火山方舟',
    subtitle: 'ark.cn-beijing.volces.com/api/v3',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    avatarClass: 'c-volc',
    letter: '火',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['doubao-pro-32k', 'doubao-lite-32k'],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    subtitle: 'api.minimaxi.com/v1',
    baseUrl: 'https://api.minimaxi.com/v1',
    avatarClass: 'c-minimax',
    letter: 'M',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['MiniMax-Text-01', 'abab6.5s-chat'],
  },
  {
    id: 'openrouter-key',
    name: 'OpenRouter',
    subtitle: 'openrouter.ai/api/v1',
    baseUrl: 'https://openrouter.ai/api/v1',
    avatarClass: 'c-openrouter',
    letter: 'R',
    kind: 'api',
    adapter: 'openai-compatible',
  },
  {
    id: 'groq',
    name: 'Groq',
    subtitle: 'api.groq.com/openai/v1',
    baseUrl: 'https://api.groq.com/openai/v1',
    avatarClass: 'c-groq',
    letter: 'Q',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    subtitle: 'api.mistral.ai/v1',
    baseUrl: 'https://api.mistral.ai/v1',
    avatarClass: 'c-mistral',
    letter: 'M',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['mistral-small-latest', 'mistral-large-latest', 'codestral-latest'],
  },
];

export function findVendor(id: string): ProviderVendor | undefined {
  return KEY_VENDORS.find(v => v.id === id) ?? SUB_VENDORS.find(v => v.id === id);
}

export function curatedModelsForVendor(vendorId: string): readonly string[] {
  return findVendor(vendorId)?.curatedModels ?? [];
}
