import { expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { featureModelSettings, type AiFeature } from '../adapters/feature-model-settings';
import { syntheticConnectionTree } from '../adapters/ai-connection';
import type { ModelAuthority } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { AiServicesStore } from '../persistence/ai-services';
import { SettingsStore } from '../persistence/settings';
import { ImportCheckpointStore } from '../persistence/import-checkpoints';
import { ImportPipeline } from '../domain/import-pipeline';
import { ImportAuthority } from '../background/import-authority';
import { OrganizerAuthority } from '../background/organizer-authority';
import { parseImport } from '../import/parsers';
import type { AiRequest } from '../domain/ai-payload';
import type { ConfirmMutation } from '../schemas/messages';

async function setup() {
  const data: Record<string, unknown> = {};
  const storage = {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (patch: Record<string, unknown>) => {
      Object.assign(data, patch);
    },
    remove: async (key: string) => {
      delete data[key];
    },
    setAccessLevel: async () => {},
  };
  const settings = new SettingsStore(storage, run => run());
  await settings.load();
  await settings.save(
    { adapter: 'openai-compatible', baseUrl: 'https://save.test', model: 'save-model', timeoutMs: 1000 },
    { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    'save-key',
    false,
  );
  const services = new AiServicesStore(storage, run => run());
  await services.load();
  const service = {
    id: 'features',
    name: 'Features',
    serviceType: 'API',
    kind: 'api' as const,
    detail: '',
    baseUrl: 'https://features.test/v1',
    mode: 'openai-responses' as const,
    status: 'ok' as const,
    letter: 'F',
    avatarClass: 'custom',
    catalog: [],
    enabled: ['chosen'],
    timeoutMs: 5000,
    streaming: false,
    maxOutputTokens: 64000,
  };
  const tree = syntheticConnectionTree();
  const configure = async () => {
    await services.upsertService(service, 'feature-key', false);
    await services.saveFeatures(
      services.snapshotServices().features.map(f => ({ ...f, connId: service.id, modelId: `${f.id}-model` })),
    );
  };
  const reader = (feature: AiFeature) => featureModelSettings(settings, services, feature);
  const authority = (feature: AiFeature): ModelAuthority => {
    const owner = reader(feature);
    return { read: async () => ({ ...(await owner.snapshot()), tree }), subscribe: owner.subscribe };
  };
  const dispose = () => {
    settings.dispose();
    services.dispose();
  };
  return { settings, services, tree, configure, reader, authority, dispose };
}

it.each(['organize', 'import', 'classify', 'search'] as const)(
  '%s calls its selected endpoint/key/model and preserves primary settings',
  async feature => {
    const f = await setup();
    await f.configure();
    const authority = f.authority(feature);
    const original = await f.settings.snapshot();
    const output =
      feature === 'search'
        ? { rankedIds: [] }
        : feature === 'organize'
          ? { newFolders: [], moves: [], merges: [] }
          : { newFolders: [], assignments: [{ itemId: 'test-bookmark', folderId: 'test-docs' }] };
    const request: AiRequest =
      feature === 'search'
        ? { task: 'search', query: 'docs', itemIds: ['test-bookmark'], folderIds: ['test-docs'] }
        : feature === 'organize'
          ? { task: 'organize', rootId: 'test-root', itemIds: ['test-bookmark'], folderIds: ['test-root', 'test-docs'] }
          : feature === 'import'
            ? {
                task: 'import-classify',
                targetId: 'test-root',
                items: [{ source: 'bookmark', id: 'test-bookmark' }],
                folderIds: ['test-docs'],
              }
            : {
                task: 'save',
                targetId: 'test-root',
                item: { source: 'bookmark', id: 'test-bookmark' },
                folderIds: ['test-docs'],
              };
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ status: 'completed', output_text: JSON.stringify(output) })),
    );
    const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
    const context = await authority.read();
    expect(await transport.run({ ...context, config: context.config!, request })).toMatchObject({
      status: 'completed',
    });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://features.test/v1/responses');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer feature-key');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: `${feature}-model`,
      stream: false,
      max_output_tokens: 64000,
    });
    expect(await f.settings.snapshot()).toEqual(original);
    transport.dispose();
    f.dispose();
  },
);

it('features use only AI services; unassigned or deleted services cannot resurrect the old single connection', async () => {
  const f = await setup();
  expect((await f.reader('organize').snapshot()).config).toBeUndefined();
  await f.configure();
  await f.services.saveFeatures([]);
  expect((await f.reader('organize').snapshot()).config).toBeUndefined();
  await f.services.removeService('features');
  expect((await f.reader('organize').snapshot()).config).toBeUndefined();
  f.dispose();
});

it('worker import validation accepts evidence from the import route and revokes both workbench leases on assignment changes', async () => {
  const f = await setup();
  await f.configure();
  const authority = f.authority('import');
  const fetcher: typeof fetch = async (_url, init) => {
    const envelope = JSON.parse(String(init?.body));
    const payload = JSON.parse(envelope.input[1].content);
    expect(envelope.model).toBe('import-model');
    return new Response(
      JSON.stringify({
        status: 'completed',
        output_text: JSON.stringify({
          newFolders: [],
          assignments: payload.items.map((item: { id: string }) => ({ itemId: item.id, folderId: 'test-docs' })),
        }),
      }),
    );
  };
  const transport = new ModelTransport({ fetch: fetcher, contains: async () => true }, authority);
  const store = new ImportCheckpointStore(new IDBFactory());
  const pipeline = new ImportPipeline(transport, authority, store);
  const root = f.tree.nodes[0]!.ref;
  const source = parseImport(new TextEncoder().encode('https://new.test/path'), 'txt');
  const result = await pipeline.start({ id: 'route-audit', root, source, format: 'txt' });
  expect(result.status).toBe('classified');
  if (!result.checkpoint) throw Error('missing checkpoint');
  const projection = { fresh: async () => f.tree, state: { status: 'ready' as const, snapshot: f.tree } };
  const workerStore = f.reader('import');
  const worker = new ImportAuthority(workerStore, projection, store, 'test');
  const sender = { id: 'test', url: 'chrome-extension://test/options/index.html' };
  const token = worker.open(sender);
  const request = await worker.prepare(
    token,
    result.checkpoint.id,
    result.checkpoint.revision,
    { root, selectedSourceOrdinals: [0], titleEdits: [] },
    sender,
  );
  expect(request).toBeDefined();
  expect(await worker.validate(request!, sender)).toBe(true);
  const organizer = new OrganizerAuthority(f.reader('organize'), 'test');
  const organizerContext = await organizer.open(sender);
  const organizeRequest: ConfirmMutation = {
    ...request!,
    importContext: undefined,
    importBinding: undefined,
    organizerContext,
  };
  expect(await organizer.validate(organizeRequest, sender)).toBe(true);
  await f.services.saveFeatures(
    f.services.snapshotServices().features.map(entry => ({ ...entry, modelId: 'replacement' })),
  );
  expect(worker.current(request!)).toBe(false);
  expect(await worker.validate(request!, sender)).toBe(false);
  expect(organizer.current(organizeRequest)).toBe(false);
  pipeline.dispose();
  f.dispose();
});
