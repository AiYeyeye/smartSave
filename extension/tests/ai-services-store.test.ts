import { describe, expect, it } from 'vitest';
import { AiServicesStore } from '../persistence/ai-services';
import { SettingsStore } from '../persistence/settings';

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
    await store.replaceAll([{ ...sampleService, id: 'c2', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }], []);
    expect(store.credential('c1')).toBe('');
    expect(store.credential('c2')).toBe('');
    expect(store.snapshotServices().services[0]?.id).toBe('c2');
  });
});
