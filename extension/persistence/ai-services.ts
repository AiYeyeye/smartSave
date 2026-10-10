import { z } from 'zod';
import { parseModelEndpoint, type ModelAdapter } from '../domain/model-route';
import { apiModeToAdapter, type ApiMode } from '../domain/ai-providers';
import type { IdentityStorage } from '../background/installation-identity';
import type { SettingsStore } from './settings';

const modelMetaSchema = z.strictObject({ id: z.string().min(1), ctx: z.string() });
const apiModeSchema = z.enum(['openai', 'openai-responses', 'anthropic', 'google']);
const serviceKindSchema = z.enum(['api', 'sub']);
const serviceStatusSchema = z.enum(['ok', 'warn']);

const connectedServiceSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  serviceType: z.string().min(1),
  kind: serviceKindSchema,
  detail: z.string(),
  baseUrl: z.string(),
  mode: apiModeSchema,
  status: serviceStatusSchema,
  letter: z.string().min(1),
  avatarClass: z.string().min(1),
  catalog: z.array(modelMetaSchema),
  enabled: z.array(z.string().min(1)),
  vendorId: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(2147483647).optional(),
});

const featureAssignmentSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  desc: z.string(),
  connId: z.string(),
  modelId: z.string(),
});

const envelopeSchema = z.strictObject({
  version: z.literal(1),
  revision: z.string(),
  services: z.array(connectedServiceSchema),
  features: z.array(featureAssignmentSchema),
  /** Remembered keys keyed by service id; route must match current base/adapter identity. */
  credentials: z.record(z.string(), z.strictObject({ route: z.string(), key: z.string() })).optional(),
});

export type ConnectedServiceRecord = z.infer<typeof connectedServiceSchema>;
export type FeatureAssignmentRecord = z.infer<typeof featureAssignmentSchema>;
export type AiServicesEnvelope = z.infer<typeof envelopeSchema>;

export type AiServicesLock = <T>(operation: () => Promise<T>) => Promise<T>;
const browserLock: AiServicesLock = operation => {
  if (!globalThis.navigator?.locks) return Promise.reject(Error('ai-services-lock-unavailable'));
  return navigator.locks.request('zhilan-ai-services', operation);
};

export const DEFAULT_FEATURES: FeatureAssignmentRecord[] = [
  { id: 'import', name: '智能导入', desc: '导入书签时自动分类与整理', connId: '', modelId: '' },
  { id: 'save', name: '智能收藏', desc: '保存当前页时建议目录与标题', connId: '', modelId: '' },
  { id: 'search', name: '智能搜索', desc: '语义检索与结果重排', connId: '', modelId: '' },
  { id: 'organize', name: '智能整理', desc: '批量重组书签树提案', connId: '', modelId: '' },
  { id: 'classify', name: '页面分类', desc: '弹出层即时分类建议', connId: '', modelId: '' },
];

function emptyEnvelope(): AiServicesEnvelope {
  return { version: 1, revision: '', services: [], features: DEFAULT_FEATURES.map(f => ({ ...f })) };
}

function serviceRoute(service: Pick<ConnectedServiceRecord, 'mode' | 'baseUrl'>): string {
  if (!service.baseUrl.trim()) return '';
  const adapter: ModelAdapter = apiModeToAdapter(service.mode as ApiMode);
  const model = 'pending';
  return parseModelEndpoint({
    adapter,
    baseUrl: service.baseUrl,
    model,
    timeoutMs: 60000,
  }).identity;
}

/** Multi-connection AI services store. Secrets optional per service; syncs primary into SettingsStore. */
export class AiServicesStore {
  private value = emptyEnvelope();
  private session = new Map<string, { revision: string; route: string; key: string }>();
  private listeners = new Set<() => void>();
  private storageListening = false;

  constructor(
    private readonly storage: IdentityStorage & { remove(key: string): Promise<void> },
    private readonly lock: AiServicesLock = browserLock,
  ) {}

  private readonly storageChanged = (changes: Record<string, unknown>, area: string) => {
    if (area === 'local' && Object.hasOwn(changes, 'aiServices')) this.changed();
  };

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (!this.storageListening && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(this.storageChanged);
      this.storageListening = true;
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stopStorageListener();
    };
  }

  private stopStorageListener() {
    if (this.storageListening) chrome.storage.onChanged.removeListener(this.storageChanged);
    this.storageListening = false;
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }

  private async read(): Promise<AiServicesEnvelope> {
    await this.storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const data = await this.storage.get('aiServices');
    if (data.aiServices === undefined) return emptyEnvelope();
    return envelopeSchema.parse(data.aiServices);
  }

  async load() {
    try {
      await this.lock(async () => {
        const envelope = await this.read();
        this.value = envelope;
        // Drop session entries that no longer match a service route.
        for (const [id, sess] of [...this.session]) {
          const svc = envelope.services.find(s => s.id === id);
          if (!svc || serviceRoute(svc) !== sess.route || sess.revision !== envelope.revision) this.session.delete(id);
        }
      });
      return this.snapshotServices();
    } catch {
      throw Error('ai-services-unavailable');
    }
  }

  snapshotServices() {
    return {
      services: structuredClone(this.value.services),
      features: structuredClone(this.value.features),
      revision: this.value.revision,
    };
  }

  credential(serviceId: string): string {
    const svc = this.value.services.find(s => s.id === serviceId);
    if (!svc) return '';
    const route = serviceRoute(svc);
    const sess = this.session.get(serviceId);
    if (sess && sess.revision === this.value.revision && sess.route === route) return sess.key;
    const remembered = this.value.credentials?.[serviceId];
    if (remembered && remembered.route === route) return remembered.key;
    return '';
  }

  async upsertService(
    service: ConnectedServiceRecord,
    key: string,
    remember: boolean,
  ): Promise<{ services: ConnectedServiceRecord[]; features: FeatureAssignmentRecord[] }> {
    try {
      return await this.lock(async () => {
        const envelope = await this.read();
        if (envelope.revision !== this.value.revision && this.value.revision !== '')
          throw Error('ai-services-conflict');
        const route = service.baseUrl.trim() ? serviceRoute(service) : '';
        const services = [...envelope.services];
        const idx = services.findIndex(s => s.id === service.id);
        if (idx >= 0) services[idx] = connectedServiceSchema.parse(service);
        else services.push(connectedServiceSchema.parse(service));

        const credentials = { ...(envelope.credentials ?? {}) };
        if (remember && key && route) credentials[service.id] = { route, key };
        else delete credentials[service.id];

        const next: AiServicesEnvelope = envelopeSchema.parse({
          version: 1,
          revision: crypto.randomUUID(),
          services,
          features: envelope.features,
          ...(Object.keys(credentials).length ? { credentials } : {}),
        });
        await this.storage.set({ aiServices: next });
        this.value = next;
        if (key && route) this.session.set(service.id, { revision: next.revision, route, key });
        else this.session.delete(service.id);
        this.changed();
        return this.snapshotServices();
      });
    } catch {
      throw Error('ai-services-unavailable-or-conflict');
    }
  }

  async removeService(serviceId: string) {
    try {
      return await this.lock(async () => {
        const envelope = await this.read();
        if (envelope.revision !== this.value.revision && this.value.revision !== '')
          throw Error('ai-services-conflict');
        const services = envelope.services.filter(s => s.id !== serviceId);
        const credentials = { ...(envelope.credentials ?? {}) };
        delete credentials[serviceId];
        const fallback = services[0];
        const features = envelope.features.map(f =>
          f.connId === serviceId
            ? {
                ...f,
                connId: fallback?.id ?? '',
                modelId: fallback?.enabled[0] ?? '',
              }
            : f,
        );
        const next: AiServicesEnvelope = envelopeSchema.parse({
          version: 1,
          revision: crypto.randomUUID(),
          services,
          features,
          ...(Object.keys(credentials).length ? { credentials } : {}),
        });
        await this.storage.set({ aiServices: next });
        this.value = next;
        this.session.delete(serviceId);
        this.changed();
        return this.snapshotServices();
      });
    } catch {
      throw Error('ai-services-unavailable-or-conflict');
    }
  }

  async saveFeatures(features: FeatureAssignmentRecord[]) {
    try {
      return await this.lock(async () => {
        const envelope = await this.read();
        if (envelope.revision !== this.value.revision && this.value.revision !== '')
          throw Error('ai-services-conflict');
        const next: AiServicesEnvelope = envelopeSchema.parse({
          ...envelope,
          revision: crypto.randomUUID(),
          features: features.map(f => featureAssignmentSchema.parse(f)),
        });
        await this.storage.set({ aiServices: next });
        this.value = next;
        this.changed();
        return this.snapshotServices();
      });
    } catch {
      throw Error('ai-services-unavailable-or-conflict');
    }
  }

  async replaceAll(services: ConnectedServiceRecord[], features: FeatureAssignmentRecord[]) {
    try {
      return await this.lock(async () => {
        const envelope = await this.read();
        if (envelope.revision !== this.value.revision && this.value.revision !== '')
          throw Error('ai-services-conflict');
        // Import never carries secrets.
        const next: AiServicesEnvelope = envelopeSchema.parse({
          version: 1,
          revision: crypto.randomUUID(),
          services: services.map(s => connectedServiceSchema.parse(s)),
          features: features.map(f => featureAssignmentSchema.parse(f)),
        });
        await this.storage.set({ aiServices: next });
        this.value = next;
        this.session.clear();
        this.changed();
        return this.snapshotServices();
      });
    } catch {
      throw Error('ai-services-unavailable-or-conflict');
    }
  }

  /** Export without credentials. */
  exportConfig() {
    return {
      version: 1 as const,
      services: this.value.services.map(
        ({ id, name, serviceType, kind, detail, baseUrl, mode, enabled, catalog, vendorId, timeoutMs, letter, avatarClass, status }) => ({
          id,
          name,
          serviceType,
          kind,
          detail,
          baseUrl,
          mode,
          enabled,
          catalog,
          vendorId,
          timeoutMs,
          letter,
          avatarClass,
          status,
        }),
      ),
      features: this.value.features,
    };
  }

  /**
   * Push the feature「智能收藏」assignment (or first connected service) into SettingsStore
   * so existing save/search/organize paths keep working on a single active route.
   */
  async syncPrimaryToSettings(settings: SettingsStore | undefined) {
    if (!settings) return;
    try {
      await settings.load();
    } catch {
      /* keep going; save will surface conflicts */
    }
    const snap = this.snapshotServices();
    const saveFeat = snap.features.find(f => f.id === 'save');
    const primary =
      (saveFeat?.connId && snap.services.find(s => s.id === saveFeat.connId)) ||
      snap.services.find(s => s.enabled.length > 0) ||
      snap.services[0];
    if (!primary?.baseUrl.trim()) return;
    const modelId = (saveFeat?.connId === primary.id && saveFeat.modelId) || primary.enabled[0];
    if (!modelId) return;
    const key = this.credential(primary.id);
    const privacy = (await settings.snapshot()).privacy;
    const config = {
      adapter: apiModeToAdapter(primary.mode as ApiMode),
      baseUrl: primary.baseUrl,
      model: modelId,
      timeoutMs: primary.timeoutMs ?? 60000,
    };
    const remembered = Boolean(this.value.credentials?.[primary.id]?.key);
    await settings.save(config, privacy, key, remembered, primary.vendorId);
  }

  dispose() {
    this.session.clear();
    this.changed();
    this.stopStorageListener();
    this.listeners.clear();
  }
}
