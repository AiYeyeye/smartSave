import { describe, expect, it } from 'vitest';
import { AiServicesStore } from '../persistence/ai-services';
import { SettingsStore } from '../persistence/settings';
import { resolveSaveRoute } from '../background/native-bookmark-ingress';

function memoryStorage() {
  const data: Record<string, unknown> = {};
  return {
    data,
    storage: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (value: Record<string, unknown>) => {
        Object.assign(data, value);
      },
      remove: async (key: string) => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
  };
}

const sampleService = {
  id: 'c1',
  name: 'OpenAI',
  serviceType: 'OpenAI',
  kind: 'api' as const,
  detail: 'api.openai.com/v1',
  baseUrl: 'https://api.openai.com/v1',
  mode: 'openai' as const,
  status: 'ok' as const,
  letter: 'O',
  avatarClass: 'c-openai',
  catalog: [{ id: 'gpt-4.1-mini', ctx: '常用' }],
  enabled: ['gpt-4.1-mini'],
  vendorId: 'openai-key',
  timeoutMs: 60000,
};

describe('AiServicesStore', () => {
  it('retains other temporary keys through same-owner assignments and service edits without persisting them', async () => {
    const { storage, data } = memoryStorage();
    const store = new AiServicesStore(storage, run => run());
    await store.load();
    await store.upsertService(sampleService, 'temporary-one', false);
    await store.upsertService({ ...sampleService, id: 'c2' }, 'temporary-two', false);
    await store.saveFeatures([{ id: 'save', name: 'Save', desc: '', connId: 'c1', modelId: 'model' }]);
    await store.load();
    expect(store.credential('c1')).toBe('temporary-one');
    expect(store.credential('c2')).toBe('temporary-two');
    await store.removeService('c2');
    expect(store.credential('c1')).toBe('temporary-one');
    expect(JSON.stringify(data)).not.toContain('temporary-');
    // A different owner changing persisted state must still revoke this owner's stale key.
    const other = new AiServicesStore(storage, run => run());
    await other.load();
    await other.upsertService(sampleService, '', false);
    await store.load();
    expect(store.credential('c1')).toBe('');
    store.dispose();
    other.dispose();
  });
  it('round-trips output budgets through persistence, export, import, primary settings and native save routing', async () => {
    const { storage } = memoryStorage();
    const store = new AiServicesStore(storage, run => run());
    await store.load();
    const service = { ...sampleService, mode: 'openai-responses' as const, maxOutputTokens: 64000, fastMode: false };
    await store.upsertService(service, 'keep-key', true);
    await store.saveFeatures([
      { id: 'save', name: 'save', desc: '', connId: service.id, modelId: service.enabled[0]! },
    ]);
    const backup = store.exportConfig();
    expect(backup.services[0]?.maxOutputTokens).toBe(64000);
    expect(backup.services[0]?.fastMode).toBe(false);
    await store.upsertService({ ...service, maxOutputTokens: 32000 }, 'keep-key', true);
    expect(store.credential(service.id)).toBe('keep-key');
    await store.replaceAll(backup.services, backup.features);
    expect(store.snapshotServices().services[0]?.maxOutputTokens).toBe(64000);
    const settings = new SettingsStore(storage, run => run());
    await store.syncPrimaryToSettings(settings);
    expect((await settings.snapshot()).config?.maxOutputTokens).toBe(64000);
    expect((await settings.snapshot()).config?.fastMode).toBe(false);
    const reloaded = new AiServicesStore(storage, run => run());
    await reloaded.load();
    expect(reloaded.snapshotServices().services[0]?.maxOutputTokens).toBe(64000);
    await reloaded.upsertService(service, 'keep-key', true);
    expect(await resolveSaveRoute(reloaded)).toMatchObject({ config: { maxOutputTokens: 64000, fastMode: false } });
    await expect(store.upsertService({ ...service, maxOutputTokens: 0 }, '', false)).rejects.toThrow();
    reloaded.dispose();
    store.dispose();
    settings.dispose();
  });
  it('preserves explicit JSON mode through credentials, export/import and primary synchronization', async () => {
    const { storage } = memoryStorage();
    const store = new AiServicesStore(storage, run => run());
    await store.load();
    await store.upsertService({ ...sampleService, streaming: false }, 'keep-key', true);
    const backup = store.exportConfig();
    expect(backup.services[0]?.streaming).toBe(false);
    const settings = new SettingsStore(storage, run => run());
    await settings.load();
    await store.syncPrimaryToSettings(settings);
    expect((await settings.snapshot()).config?.streaming).toBe(false);
    await store.upsertService({ ...sampleService, streaming: true }, 'keep-key', true);
    expect(store.credential(sampleService.id)).toBe('keep-key');
    await store.replaceAll(backup.services, backup.features);
    expect(store.snapshotServices().services[0]?.streaming).toBe(false);
    await store.syncPrimaryToSettings(settings);
    expect((await settings.snapshot()).config?.streaming).toBe(false);
    store.dispose();
    settings.dispose();
  });
  it('persists services and remembers credentials bound to route identity', async () => {
    const { storage, data } = memoryStorage();
    const store = new AiServicesStore(storage, run => run());
    await store.load();
    await store.upsertService(sampleService, 'sk-test', true);
    expect(store.credential('c1')).toBe('sk-test');
    expect(JSON.stringify(data.aiServices)).toContain('sk-test');
    const exported = store.exportConfig();
    expect(JSON.stringify(exported)).not.toContain('sk-test');
    expect(exported.services[0]?.enabled).toEqual(['gpt-4.1-mini']);
  });

  it('drops remembered key when remember is false and clears on remove', async () => {
    const { storage } = memoryStorage();
    const store = new AiServicesStore(storage, run => run());
    await store.load();
    await store.upsertService(sampleService, 'sk-session', false);
    expect(store.credential('c1')).toBe('sk-session');
    expect(JSON.stringify(await storage.get('aiServices'))).not.toContain('sk-session');
    await store.removeService('c1');
    expect(store.snapshotServices().services).toEqual([]);
    expect(store.credential('c1')).toBe('');
  });

  it('syncs primary save-feature connection into SettingsStore', async () => {
    const { storage } = memoryStorage();
    const ai = new AiServicesStore(storage, run => run());
    const settings = new SettingsStore(storage, run => run());
    await ai.load();
    await settings.load();
    await ai.upsertService(sampleService, 'sk-sync', true);
    await ai.saveFeatures([
      { id: 'save', name: '智能收藏', desc: '', connId: 'c1', modelId: 'gpt-4.1-mini' },
      { id: 'import', name: '智能导入', desc: '', connId: '', modelId: '' },
      { id: 'search', name: '智能搜索', desc: '', connId: '', modelId: '' },
      { id: 'organize', name: '智能整理', desc: '', connId: '', modelId: '' },
      { id: 'classify', name: '页面分类', desc: '', connId: '', modelId: '' },
    ]);
    await ai.syncPrimaryToSettings(settings);
    const snap = await settings.snapshot();
    expect(snap.config?.model).toBe('gpt-4.1-mini');
    expect(snap.config?.adapter).toBe('openai-compatible');
    expect(snap.key).toBe('sk-sync');
  });

  it('import replaceAll never carries credentials', async () => {
    const { storage } = memoryStorage();
    const store = new AiServicesStore(storage, run => run());
    await store.load();
    await store.upsertService(sampleService, 'sk-old', true);
    await store.replaceAll(
      [{ ...sampleService, id: 'c2', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }],
      [],
    );
    expect(store.credential('c1')).toBe('');
    expect(store.credential('c2')).toBe('');
    expect(store.snapshotServices().services[0]?.id).toBe('c2');
  });
});
