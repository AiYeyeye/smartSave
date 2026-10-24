import type { ModelAdapter } from './model-route';

/** UI protocol mode shown in the AI services edit form. */
export type ApiMode = 'openai' | 'openai-responses' | 'anthropic' | 'google';

export type ServiceKind = 'api' | 'sub';

/** Honest OAuth readiness — never claim success without a real browser flow. */
export type OAuthStatus =
  | 'ready' // real browser sign-in wired (chrome.identity + official OAuth)
  | 'blocked' // vendor explicitly forbids third-party use of the subscription
  | 'unsupported' // no official OAuth for third-party extensions
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

/** Display labels for the custom-endpoint protocol dropdown (PI-Desktop reference English). */
export const API_MODE_OPTIONS: readonly { value: ApiMode; label: string }[] = [
  { value: 'openai', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
  { value: 'google', label: 'Google Generative AI' },
] as const;

export function apiModeToAdapter(mode: ApiMode): ModelAdapter {
  if (mode === 'anthropic') return 'anthropic';
  if (mode === 'openai-responses') return 'openai-responses';
  if (mode === 'google') return 'google-generative-ai';
  return 'openai-compatible';
}

export function adapterToApiMode(adapter: ModelAdapter): ApiMode {
  if (adapter === 'anthropic') return 'anthropic';
  if (adapter === 'openai-responses') return 'openai-responses';
  if (adapter === 'google-generative-ai') return 'google';
  return 'openai';
}

/** Subscription / OAuth tiles. Only `ready` vendors have a real sign-in; others explain why and point to API keys. */
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
    curatedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
    oauth: 'blocked',
    oauthNote:
      'Anthropic 自 2026 年 2 月起明确禁止第三方工具使用 Claude Pro/Max 订阅登录。请改用 Anthropic API Key（console.anthropic.com）。',
  },
  {
    id: 'github-copilot',
    name: 'GitHub Copilot',
    subtitle: '用 GitHub 账号登录',
    avatarClass: 'c-github',
    letter: 'G',
    kind: 'sub',
    adapter: 'openai-compatible',
    oauth: 'unsupported',
    oauthNote: 'GitHub Copilot 没有向第三方扩展开放模型调用授权。非官方的设备码方案违反其条款，智栏不接入。',
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
    oauth: 'unsupported',
    oauthNote: 'Kimi 目前没有面向第三方扩展的官方订阅登录。请使用「月之暗面」API Key 连接。',
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
    oauth: 'unsupported',
    oauthNote: 'OpenAI 没有向第三方扩展开放 ChatGPT 订阅登录。请改用 OpenAI API Key（platform.openai.com）。',
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
    oauth: 'ready',
    oauthNote:
      '在 openrouter.ai 登录并授权后，智栏会拿到一把只属于你的 API Key（可随时在 OpenRouter 后台撤销），不经过任何第三方服务器。',
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
    oauth: 'unsupported',
    oauthNote: 'xAI 目前没有面向第三方扩展的官方订阅登录。请使用 xAI API Key。',
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
    curatedModels: ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'],
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
    curatedModels: ['gemini-3.8-flash', 'gemini-3.5-flash-lite'],
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
    curatedModels: ['grok-4.3'],
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
    curatedModels: ['glm-5.3', 'glm-5.2', 'glm-4.7'],
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
    curatedModels: ['deepseek-flash', 'deepseek-v4-pro'],
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
    curatedModels: ['glm-5.3', 'glm-5.2', 'glm-4.7-flash'],
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
    curatedModels: ['deepseek-ai/DeepSeek-V3.2', 'deepseek-ai/DeepSeek-V4-Flash'],
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
    curatedModels: [],
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    subtitle: 'api.minimax.cn/v1',
    baseUrl: 'https://api.minimax.cn/v1',
    avatarClass: 'c-minimax',
    letter: 'M',
    kind: 'api',
    adapter: 'openai-compatible',
    curatedModels: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.5'],
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
    curatedModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
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
