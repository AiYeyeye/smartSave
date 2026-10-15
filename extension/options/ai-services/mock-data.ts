/** Types + vendor catalog for AI Services UI. Vendors come from domain/ai-providers (real catalog). */

import {
  KEY_VENDORS as DOMAIN_KEY_VENDORS,
  SUB_VENDORS as DOMAIN_SUB_VENDORS,
  curatedModelsForVendor,
  type ApiMode,
  type ProviderVendor,
  type ServiceKind,
} from '../../domain/ai-providers';

export type { ApiMode };
export type ModelMeta = { id: string; ctx: string };
export type ServiceStatus = 'ok' | 'warn';
export type ServiceKindAlias = ServiceKind;
export type ServiceKindUi = ServiceKind;

export type ConnectedService = {
  id: string;
  name: string;
  serviceType: string;
  kind: ServiceKind;
  detail: string;
  baseUrl: string;
  mode: ApiMode;
  status: ServiceStatus;
  letter: string;
  avatarClass: string;
  catalog: ModelMeta[];
  enabled: string[];
  vendorId?: string;
  timeoutMs?: number;
  streaming?: boolean;
  maxOutputTokens?: number;
};

export type FeatureAssignment = {
  id: string;
  name: string;
  desc: string;
  connId: string;
  modelId: string;
};

export type Vendor = {
  id: string;
  name: string;
  subtitle: string;
  avatarClass: string;
  letter: string;
  isCustom?: boolean;
  baseUrl?: string;
  oauthNote?: string;
  oauth?: ProviderVendor['oauth'];
  adapter?: ProviderVendor['adapter'];
};

export type AiServicesTab = 'connected' | 'add' | 'features' | 'io';

function toVendor(v: ProviderVendor): Vendor {
  return {
    id: v.id,
    name: v.name,
    subtitle: v.subtitle,
    avatarClass: v.avatarClass,
    letter: v.letter,
    isCustom: v.isCustom,
    baseUrl: v.baseUrl,
    oauthNote: v.oauthNote,
    oauth: v.oauth,
    adapter: v.adapter,
  };
}

export const SUB_VENDORS: Vendor[] = DOMAIN_SUB_VENDORS.map(toVendor);
export const KEY_VENDORS: Vendor[] = DOMAIN_KEY_VENDORS.map(toVendor);

export function catalogFromVendor(vendorId: string | undefined, nameHint = ''): ModelMeta[] {
  const ids = vendorId ? curatedModelsForVendor(vendorId) : [];
  if (ids.length) return ids.map(id => ({ id, ctx: '常用' }));
  if (/anthropic|claude/i.test(nameHint)) {
    return curatedModelsForVendor('anthropic-key').map(id => ({ id, ctx: '常用' }));
  }
  if (/deepseek/i.test(nameHint)) {
    return curatedModelsForVendor('deepseek').map(id => ({ id, ctx: '常用' }));
  }
  if (/openai|gpt/i.test(nameHint)) {
    return curatedModelsForVendor('openai-key').map(id => ({ id, ctx: '常用' }));
  }
  return [];
}

/** @deprecated Prefer catalogFromVendor — kept for any leftover call sites. */
export function defaultCatalogFor(name: string): ModelMeta[] {
  return catalogFromVendor(undefined, name);
}

export const DEFAULT_FEATURES: FeatureAssignment[] = [
  { id: 'import', name: '智能导入', desc: '导入书签时自动分类与整理', connId: '', modelId: '' },
  { id: 'save', name: '智能收藏', desc: '保存当前页时建议目录与标题', connId: '', modelId: '' },
  { id: 'search', name: '智能搜索', desc: '语义检索与结果重排', connId: '', modelId: '' },
  { id: 'organize', name: '智能整理', desc: '批量重组书签树提案', connId: '', modelId: '' },
  { id: 'classify', name: '页面分类', desc: '弹出层即时分类建议', connId: '', modelId: '' },
];

export const TAB_HASH: Record<AiServicesTab, string> = {
  connected: 'ai-services',
  add: 'ai-services/add',
  features: 'ai-services/features',
  io: 'ai-services/io',
};

export function parseAiServicesHash(hash: string): AiServicesTab | null {
  const raw = hash.replace(/^#/, '');
  if (raw === 'ai-services' || raw === 'ai-services/connected') return 'connected';
  if (raw === 'ai-services/add') return 'add';
  if (raw === 'ai-services/features') return 'features';
  if (raw === 'ai-services/io') return 'io';
  return null;
}

export function modelCtx(services: ConnectedService[], connId: string, modelId: string): string {
  const c = services.find(x => x.id === connId);
  const m = c?.catalog.find(x => x.id === modelId);
  return m?.ctx ?? '';
}
