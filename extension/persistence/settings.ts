import { z } from 'zod';
import { nodeRefSchema } from '../domain/node-reference';
import { modelConfigSchema, parseModelEndpoint, type ModelConfig } from '../domain/model-route';
import type { IdentityStorage } from '../background/installation-identity';
export { modelConfigSchema, type ModelConfig } from '../domain/model-route';
const privacySchema = z.strictObject({ fullUrl: z.boolean(), bodyEnabled: z.boolean(), excludedFolders: z.array(nodeRefSchema) });
const settingsSchema = z.strictObject({ version: z.literal(1), config: modelConfigSchema.optional(), privacy: privacySchema, revision: z.string() });
const envelopeSchema = z.strictObject({ version: z.literal(2), settings: settingsSchema, credential: z.strictObject({ route: z.string(), key: z.string() }).optional() });
export type ModelSettingsValue = z.infer<typeof settingsSchema>;
export type SettingsLock = <T>(operation: () => Promise<T>) => Promise<T>;
const browserLock: SettingsLock = operation => {
  if (!globalThis.navigator?.locks) return Promise.reject(Error('settings-lock-unavailable'));
  return navigator.locks.request('zhilan-model-settings', operation);
};
const initial = (): ModelSettingsValue => ({ version: 1, privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] }, revision: '' });
export class SettingsStore {
  private session?: { revision: string; route: string; key: string };
  private value = initial();
  private sessionRevision = 0;
  private listeners = new Set<() => void>();
  legacyCredentialDiscarded = false;
  constructor(private readonly storage: IdentityStorage & { remove(key: string): Promise<void> }, private readonly lock: SettingsLock = browserLock) {}
  private storageListening = false;
  private readonly storageChanged = (changes: Record<string, unknown>, area: string) => {
    // Legacy keys are migration inputs only; every authoritative read uses modelSecurity.
    if (area === 'local' && Object.hasOwn(changes, 'modelSecurity')) this.changed();
  };
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    if (!this.storageListening && typeof chrome !== 'undefined' && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(this.storageChanged); this.storageListening = true;
    }
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.stopStorageListener(); };
  }
  private stopStorageListener() {
    if (this.storageListening) chrome.storage.onChanged.removeListener(this.storageChanged);
    this.storageListening = false;
  }
  private changed() { this.sessionRevision++; for (const listener of this.listeners) listener(); }
  private async read() {
    await this.storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const data = await this.storage.get('modelSecurity');
    if (data.modelSecurity === undefined) return { version: 2 as const, settings: initial() };
    const envelope = envelopeSchema.parse(data.modelSecurity);
    if (envelope.credential && (!envelope.settings.config || envelope.credential.route !== parseModelEndpoint(envelope.settings.config).identity)) throw Error('settings-unavailable');
    return envelope;
  }
  async load() {
    try {
      await this.lock(async () => {
        await this.storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
        const current = await this.storage.get('modelSecurity');
        if (current.modelSecurity === undefined) {
          const legacy = await this.storage.get('modelSettings');
          const settings = legacy.modelSettings === undefined ? initial() : settingsSchema.parse(legacy.modelSettings);
          await this.storage.set({ modelSecurity: { version: 2, settings } });
        }
        const old = await this.storage.get('modelCredential');
        this.legacyCredentialDiscarded = old.modelCredential !== undefined;
        await this.storage.remove('modelCredential');
        const envelope = await this.read(); this.value = envelope.settings;
        if (envelope.credential) this.session = { revision: this.value.revision, ...envelope.credential };
      });
      return structuredClone(this.value);
    } catch { throw Error('settings-unavailable'); }
  }
  async snapshot() {
    const envelope = await this.read();
    const route = envelope.settings.config ? parseModelEndpoint(envelope.settings.config).identity : '';
    const key = this.session?.revision === envelope.settings.revision && this.session.route === route ? this.session.key : envelope.credential?.key ?? '';
    return { ...structuredClone(envelope.settings), key, sessionRevision: this.sessionRevision };
  }
  credential() { return this.session?.revision === this.value.revision ? this.session.key : ''; }
  async save(config: ModelConfig, privacy: ModelSettingsValue['privacy'], key: string, remember: boolean) {
    const route = parseModelEndpoint(config).identity;
    const value = settingsSchema.parse({ version: 1, config, privacy, revision: crypto.randomUUID() });
    try {
      await this.lock(async () => {
        if ((await this.read()).settings.revision !== this.value.revision) throw Error('settings-conflict');
        await this.storage.set({ modelSecurity: { version: 2, settings: value, ...(remember && key ? { credential: { route, key } } : {}) } });
        this.value = value; this.session = { revision: value.revision, route, key }; this.changed();
      });
      return structuredClone(value);
    } catch { throw Error('settings-unavailable-or-conflict'); }
  }
  async clearCredential() {
    this.session = undefined; this.changed();
    try { await this.lock(async () => {
      const envelope = await this.read();
      if (envelope.settings.revision !== this.value.revision) throw Error('settings-conflict');
      const settings = { ...envelope.settings, revision: crypto.randomUUID() };
      await this.storage.set({ modelSecurity: { version: 2, settings } }); this.value = settings;
    }); } catch { throw Error('settings-unavailable'); }
  }
  dispose() { this.session = undefined; this.changed(); this.stopStorageListener(); this.listeners.clear(); }
}
