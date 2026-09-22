import { expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { ImportPipeline } from '../domain/import-pipeline';
import { ImportCheckpointStore } from '../persistence/import-checkpoints';
import { ModelTransport, modelRequestBody } from '../adapters/model-transport';
import { serializeAiPayload } from '../domain/ai-payload';
import { parseImport } from '../import/parsers';
import type { TreeSnapshot } from '../domain/node-reference';

function setup(slack = 1200) {
  const tree: TreeSnapshot = {
    installationId: 'i',
    epoch: 'e',
    observedRevision: 1,
    roots: ['root'],
    nodes: ['root', 'child', 'outside'].map((id, index) => ({
      ref: { installationId: 'i', nativeId: id, kind: 'folder' },
      title: id,
      parentId: index === 1 ? 'root' : undefined,
      index,
      childrenIds: [],
      readOnly: false,
      childrenWritable: true,
      observedRevision: 1,
    })),
  };
  const state = {
    version: 1 as const,
    revision: 'r',
    sessionRevision: 0,
    key: 'synthetic-key',
    config: { adapter: 'openai-compatible' as const, baseUrl: 'https://synthetic.test', model: 'm', timeoutMs: 10000 },
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
    tree,
  };
  // Synthetic budget = measured fixed envelope (prompt, schema, folder context) + slack, so batching pressure survives prompt growth.
  const requestBytes =
    new TextEncoder().encode(
      modelRequestBody(
        state.config,
        'import-classify',
        serializeAiPayload(tree, state.privacy, {
          task: 'import-classify',
          targetId: 'root',
          items: [],
          folderIds: ['root', 'child'],
        }),
      ),
    ).byteLength + slack;
  const authority = { read: async () => structuredClone(state), subscribe: () => () => {} };
  const payloads: {
    task: string;
    items: { id: string; title: string; url: string }[];
    folders: { id: string }[];
    fields?: { path: string[]; samples: string[] }[];
  }[] = [];
  let failure = 0;
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
    payloads.push(payload);
    if (failure === payloads.length) throw Error('synthetic interruption');
    const output =
      payload.task === 'import-map'
        ? {
            urlPath: payload.fields.find((f: { path: string[] }) => f.path.at(-1) === 'link').path,
            titlePath: payload.fields.find((f: { path: string[] }) => f.path.at(-1) === 'label')?.path ?? null,
          }
        : {
            assignments: payload.items.map((i: { id: string }) => ({
              itemId: i.id,
              folderId: payload.folders.find((f: { id: string }) => f.id.startsWith('import-folder:'))?.id ?? 'new',
            })),
            newFolders: payload.folders.some((f: { id: string }) => f.id.startsWith('import-folder:'))
              ? []
              : [{ id: 'new', parentId: 'root', title: 'Proposed' }],
          };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
  });
  const factory = new IDBFactory();
  const store = new ImportCheckpointStore(factory);
  const make = () =>
    new ImportPipeline(
      new ModelTransport({ fetch: fetcher, contains: async () => true }, authority, {
        requestBytes,
        responseBytes: 100000,
      }),
      authority,
      new ImportCheckpointStore(factory),
    );
  return {
    factory,
    state,
    store,
    make,
    payloads,
    fetcher,
    failAt: (n: number) => {
      failure = n;
    },
    root: tree.nodes[0]!.ref,
  };
}
const parsed = (text: string, format: Parameters<typeof parseImport>[1] = 'txt') =>
  parseImport(new TextEncoder().encode(text), format);
it('classifies every byte-batched item, retains original URLs and locked titles, and reuses stable proposed folders without native writes', async () => {
  const s = setup();
  const source = parsed(
    JSON.stringify(
      Array.from({ length: 12 }, (_, i) => ({
        url: `https://example.test/${i}?private=yes#secret`,
        title: `Locked ${i} ${'长'.repeat(60)}`,
      })),
    ),
    'json',
  );
  const result = await s.make().start({ id: 'all', source, format: 'json', root: s.root });
  expect(result.status).toBe('classified');
  const checkpoint = (await s.store.all())[0]!;
  expect(checkpoint.classified).toHaveLength(12);
  expect(s.payloads.length).toBeGreaterThan(1);
  expect(new Set(checkpoint.classified.map(r => r.folderId)).size).toBe(1);
  expect(checkpoint.newFolders).toHaveLength(1);
  expect(checkpoint.classified.map(r => r.title)).toEqual(source.items.map(i => i.title));
  expect(JSON.stringify(s.payloads)).not.toContain('private=yes');
  expect(JSON.stringify(s.payloads)).not.toContain('outside');
  expect(checkpoint.items[0]!.item.rawURL).toContain('?private=yes#secret');
});
it('manually resumes in a new instance without repeating committed batches', async () => {
  const s = setup();
  s.failAt(2);
  const source = parsed(
    Array.from({ length: 20 }, (_, i) => `https://example.test/${i}/${'a'.repeat(150)}`).join('\n'),
  );
  expect((await s.make().start({ id: 'resume', source, format: 'txt', root: s.root })).status).toBe('paused');
  const saved = (await s.store.all())[0]!;
  expect(saved.classified.length).toBeGreaterThan(0);
  const completedIds = s.payloads[0]!.items.map(i => i.id);
  const before = s.payloads.length;
  expect((await s.make().resume('resume', { root: s.root })).status).toBe('classified');
  expect(
    s.payloads
      .slice(before)
      .flatMap(p => p.items.map(i => i.id))
      .some(id => completedIds.includes(id)),
  ).toBe(false);
  expect((await s.store.all())[0]!.classified).toHaveLength(20);
});
it('maps isomorphic unfamiliar elements with one model decision per structure, at most five samples per field, never invented URLs', async () => {
  const s = setup(10000);
  const rows = Array.from({ length: 7 }, (_, i) => ({
    link: `https://source.test/${i}?secret=1`,
    label: `Label ${i}`,
  }));
  const source = parsed(JSON.stringify([...rows, { label: 'No link here' }]), 'json');
  expect((await s.make().start({ id: 'mapping', source, format: 'json', root: s.root })).status).toBe('classified');
  const checkpoint = (await s.store.all())[0]!;
  expect(checkpoint.items.map(i => i.item.rawURL)).toEqual(rows.map(r => r.link));
  expect(s.payloads.map(p => p.task)).toEqual(['import-map', 'import-classify']);
  expect(s.payloads[0]!.fields!.map(f => [f.path.join('/'), f.samples.length]).sort()).toEqual([
    ['*/label', 5],
    ['*/link', 5],
  ]);
  expect(JSON.stringify(s.payloads)).not.toContain('secret=1');
  expect(checkpoint.classified.map(i => i.title)).toEqual(rows.map(r => r.label));
  expect(checkpoint.diagnostics).toEqual([{ reason: 'unmapped-elements', count: 1 }]);
  expect(checkpoint.runtime).toMatchObject({ stage: 'classification', mappedGroups: ['["*"]'] });
  expect(checkpoint.runtime!.mappedItems).toHaveLength(7);
});
it('recognized rows skip mapping entirely: no import-map call and one counted diagnostic for ignored candidate fields', async () => {
  const s = setup(10000);
  const source = parsed(
    '[{"link":"https://source.test","label":"First"},{"url":"https://source.test","title":"Later"}]',
    'json',
  );
  expect((await s.make().start({ id: 'mixed', source, format: 'json', root: s.root })).status).toBe('classified');
  const saved = (await s.store.all())[0]!;
  expect(s.payloads.map(p => p.task)).toEqual(['import-classify']);
  expect(saved.classified).toHaveLength(1);
  expect(saved.classified[0]!.title).toBe('Later');
  expect(saved.items[0]!.titleLocked).toBe(true);
  expect(saved.diagnostics).toEqual([{ reason: 'unmapped-candidates', count: 2 }]);
  expect(saved.runtime).toMatchObject({ stage: 'classification', mappedGroups: [], mappedItems: [] });
  expect(saved.runtime!.candidates).toHaveLength(2);
});
it('the extension export fixture never enters mapping: zero calls when every row exists, else classification only', async () => {
  const s = setup();
  const source = parsed(readFileSync('import/fixtures/export-v1.json', 'utf8'), 'json');
  s.state.tree.nodes.push({
    ...s.state.tree.nodes[0]!,
    ref: { installationId: 'i', nativeId: 'existing', kind: 'bookmark' },
    parentId: 'root',
    url: source.items[0]!.rawURL,
  });
  expect((await s.make().start({ id: 'export-existing', source, format: 'json', root: s.root })).status).toBe(
    'classified',
  );
  expect(s.fetcher).not.toHaveBeenCalled();
  expect(await s.store.get('export-existing')).toMatchObject({
    items: [],
    diagnostics: [
      { sourceOrdinal: 0, reason: 'existing-url' },
      { reason: 'unmapped-candidates', count: 8 },
    ],
    runtime: { stage: 'classification', mappedGroups: [] },
  });
  s.state.tree.nodes.pop();
  expect((await s.make().start({ id: 'export', source, format: 'json', root: s.root })).status).toBe('classified');
  expect(s.payloads.map(p => p.task)).toEqual(['import-classify']);
  const checkpoint = (await s.store.get('export'))!;
  expect(checkpoint.items.map(i => i.item.rawURL)).toEqual(['https://example.test/article?id=1#part']);
  expect(checkpoint.classified).toMatchObject([{ sourceOrdinal: 0, title: '示例' }]);
  expect(checkpoint.diagnostics).toEqual([{ reason: 'unmapped-candidates', count: 8 }]);
});
it('honors an explicit model refusal: the structure is marked mapped with zero rows and is never asked again', async () => {
  const s = setup(10000);
  s.fetcher.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ urlPath: null, titlePath: null }) } }] }),
      ),
  );
  const source = parsed(
    '[{"link":"https://source.test/a","label":"A"},{"link":"https://source.test/b","label":"B"}]',
    'json',
  );
  expect((await s.make().start({ id: 'refusal', source, format: 'json', root: s.root })).status).toBe('classified');
  const checkpoint = (await s.store.get('refusal'))!;
  expect(checkpoint.items).toEqual([]);
  expect(checkpoint.classified).toEqual([]);
  expect(checkpoint.diagnostics).toEqual([]);
  expect(checkpoint.runtime).toMatchObject({ stage: 'classification', mappedGroups: ['["*"]'], mappedItems: [] });
  expect((await s.make().resume('refusal', { root: s.root })).status).toBe('classified');
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
it('duplicate-only imports do not call the model or propose folders', async () => {
  const s = setup();
  s.state.tree.nodes.push({
    ...s.state.tree.nodes[0]!,
    ref: { installationId: 'i', nativeId: 'existing', kind: 'bookmark' },
    parentId: 'root',
    url: 'https://existing.test',
  });
  expect(
    (
      await s.make().start({
        id: 'empty',
        source: parsed('https://existing.test'),
        format: 'txt',
        root: s.root,
      })
    ).status,
  ).toBe('classified');
  expect(s.fetcher).not.toHaveBeenCalled();
  expect((await s.store.all())[0]!.newFolders).toEqual([]);
});
it('reports an impossible single-item payload locally and preserves evidence', async () => {
  const s = setup(1000);
  const result = await s.make().start({
    id: 'large',
    source: parsed(`https://example.test/${'x'.repeat(10000)}`),
    format: 'txt',
    root: s.root,
  });
  expect(result).toMatchObject({ status: 'paused', reason: 'single-item-payload-too-large' });
  expect(s.fetcher).not.toHaveBeenCalled();
  expect((await s.store.all())[0]!.items).toHaveLength(1);
});
it.each(['config', 'privacy', 'root', 'scope-folder'] as const)(
  'fails closed on %s change after reload without overwriting evidence',
  async change => {
    const s = setup();
    s.failAt(2);
    await s.make().start({
      id: 'stale',
      source: parsed(Array.from({ length: 20 }, (_, i) => `https://example.test/${i}/${'x'.repeat(150)}`).join('\n')),
      format: 'txt',
      root: s.root,
    });
    const before = await s.store.all();
    const calls = s.fetcher.mock.calls.length;
    if (change === 'config') s.state.config.model = 'other';
    if (change === 'privacy') s.state.privacy.fullUrl = true;
    if (change === 'root') s.state.tree.nodes[0]!.childrenWritable = false;
    if (change === 'scope-folder') s.state.tree.nodes[1]!.title = 'renamed child';
    expect((await s.make().resume('stale', { root: s.root })).status).toBe('paused');
    expect(await s.store.all()).toEqual(before);
    expect(s.fetcher).toHaveBeenCalledTimes(calls);
  },
);
it.each(['settings-revision', 'worker-restart', 'outside-bookmark', 'inside-bookmark'] as const)(
  'resumes after an unrelated %s change without repeating committed batches',
  async change => {
    const s = setup();
    s.failAt(2);
    await s.make().start({
      id: 'unrelated',
      source: parsed(Array.from({ length: 20 }, (_, i) => `https://example.test/${i}/${'x'.repeat(150)}`).join('\n')),
      format: 'txt',
      root: s.root,
    });
    const before = (await s.store.all())[0]!;
    expect(before.classified.length).toBeGreaterThan(0);
    const completed = before.classified.map(c => `import-item:unrelated:${c.sourceOrdinal}`);
    const calls = s.payloads.length;
    if (change === 'settings-revision') {
      s.state.revision = 'rotated';
      s.state.sessionRevision++;
    }
    if (change === 'worker-restart') {
      s.state.tree.epoch = 'new-epoch';
      s.state.tree.observedRevision = 0;
      s.state.tree.nodes.forEach(n => {
        n.observedRevision = 0;
      });
    }
    if (change !== 'settings-revision' && change !== 'worker-restart')
      s.state.tree.nodes.push({
        ...s.state.tree.nodes[0]!,
        ref: { installationId: 'i', nativeId: 'later', kind: 'bookmark' },
        parentId: change === 'inside-bookmark' ? 'child' : 'outside',
        childrenWritable: undefined,
        url: 'https://later.test/',
      });
    expect((await s.make().resume('unrelated', { root: s.root })).status).toBe('classified');
    expect(
      s.payloads
        .slice(calls)
        .flatMap(p => p.items.map(i => i.id))
        .some(id => completed.includes(id)),
    ).toBe(false);
    expect((await s.store.get('unrelated'))!.classified).toHaveLength(20);
  },
);
it.each(['item', 'target', 'title', 'path'] as const)(
  'rejects invalid model %s without committing a classification',
  async invalid => {
    const s = setup(10000);
    s.fetcher.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    invalid === 'path'
                      ? { urlPath: ['invented'], titlePath: null }
                      : {
                          assignments: [
                            {
                              itemId: invalid === 'item' ? 'invented' : 'import-item:invalid:0',
                              folderId: invalid === 'target' ? 'outside' : 'root',
                              ...(invalid === 'title' ? { title: 42 } : {}),
                            },
                          ],
                          newFolders: [],
                        },
                  ),
                },
              },
            ],
          }),
        ),
    );
    const source =
      invalid === 'path'
        ? parsed('[{"link":"https://source.test","label":"Locked"}]', 'json')
        : parsed('https://source.test');
    expect(
      await s.make().start({
        id: 'invalid',
        source,
        format: invalid === 'path' ? 'json' : 'txt',
        root: s.root,
      }),
    ).toMatchObject({ status: 'paused', reason: 'schema' });
    expect((await s.store.all())[0]!.classified).toEqual([]);
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  },
);
it('cancels a provider call, preserves committed batches and resumes only manually', async () => {
  const s = setup();
  const pipeline = s.make();
  const original = s.fetcher.getMockImplementation()!;
  s.fetcher.mockImplementation(async (url, init) => {
    if (s.fetcher.mock.calls.length === 2) {
      queueMicrotask(() => pipeline.cancel());
      return new Promise<Response>(() => {});
    }
    return original(url, init);
  });
  expect(
    await pipeline.start({
      id: 'cancel',
      source: parsed(Array.from({ length: 20 }, (_, i) => `https://example.test/${i}/${'x'.repeat(150)}`).join('\n')),
      format: 'txt',
      root: s.root,
    }),
  ).toMatchObject({ status: 'paused', reason: 'cancelled' });
  const before = (await s.store.all())[0]!;
  expect(before.classified.length).toBeGreaterThan(0);
  s.fetcher.mockImplementation(original);
  const fresh = s.make();
  expect((await s.store.all())[0]).toEqual(before);
  expect((await fresh.resume('cancel', { root: s.root })).status).toBe('classified');
});
it('preserves a completed structure mapping across interruption and reload', async () => {
  const s = setup(10000);
  s.failAt(2);
  const source = parsed(
    '{"a":[{"link":"https://source.test/a","label":"A"}],"b":[{"link":"https://source.test/b","label":"B"}]}',
    'json',
  );
  expect((await s.make().start({ id: 'map-resume', source, format: 'json', root: s.root })).status).toBe('paused');
  expect((await s.store.all())[0]!.runtime!.mappedGroups).toHaveLength(1);
  expect((await s.make().resume('map-resume', { root: s.root })).status).toBe('classified');
  expect(s.payloads.filter(p => p.task === 'import-map').map(p => p.fields![0]!.path.slice(0, -1).join('/'))).toEqual([
    'a/*',
    'b/*',
    'b/*',
  ]);
  expect((await s.store.all())[0]!.classified.map(r => r.title)).toEqual(['A', 'B']);
});
it('never repeats calls for duplicate checkpoint creation or a concurrent CAS conflict', async () => {
  const s = setup(10000);
  const input = {
    id: 'cas',
    source: parsed('https://example.test'),
    format: 'txt' as const,
    root: s.root,
  };
  const results = await Promise.all([s.make().start(input), s.make().start(input)]);
  expect(results.filter(r => r.status === 'classified')).toHaveLength(1);
  expect(results).toContainEqual({ status: 'paused', reason: 'import-checkpoint-conflict' });
  expect(s.fetcher).toHaveBeenCalledTimes(1);
});
it('preserves durable evidence on a real IDB quota fault and does not send another batch', async () => {
  const s = setup();
  const original = s.fetcher.getMockImplementation()!;
  let fault: ReturnType<typeof vi.spyOn> | undefined;
  s.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (s.fetcher.mock.calls.length === 2) {
      const { IDBObjectStore } = await import('fake-indexeddb');
      fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
        throw new DOMException('synthetic quota', 'QuotaExceededError');
      });
    }
    return response;
  });
  try {
    const result = await s.make().start({
      id: 'quota',
      source: parsed(Array.from({ length: 20 }, (_, i) => `https://example.test/${i}/${'x'.repeat(150)}`).join('\n')),
      format: 'txt',
      root: s.root,
    });
    expect(result.status).toBe('paused');
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    const saved = (await s.store.all())[0]!;
    expect(saved.classified.length).toBeGreaterThan(0);
    expect(saved.classified.length).toBeLessThan(20);
  } finally {
    fault?.mockRestore();
  }
});
it('rejects unsafe unknown text with URL privacy disabled before sending any model request', async () => {
  const s = setup(10000);
  expect(
    await s.make().start({
      id: 'unsafe',
      source: parsed('[{"link":"https://source.test?a=1","label":"ambiguous?secret"}]', 'json'),
      format: 'json',
      root: s.root,
    }),
  ).toMatchObject({ status: 'paused', reason: 'unsafe-text-sample' });
  expect(s.fetcher).not.toHaveBeenCalled();
  expect((await s.store.all())[0]!.runtime!.candidates).toHaveLength(2);
});
it('preserves nested proposed relationships across batches while permitting only descendants of the chosen root', async () => {
  const s = setup();
  const original = s.fetcher.getMockImplementation()!;
  s.fetcher
    .mockImplementationOnce(async (_url, init) => {
      const payload = JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
      s.payloads.push(payload);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: payload.items.map((i: { id: string }) => ({ itemId: i.id, folderId: 'leaf' })),
                  newFolders: [
                    { id: 'leaf', parentId: 'parent', title: 'Leaf' },
                    { id: 'parent', parentId: 'child', title: 'Parent' },
                  ],
                }),
              },
            },
          ],
        }),
      );
    })
    .mockImplementation(original);
  expect(
    (
      await s.make().start({
        id: 'nested',
        source: parsed(Array.from({ length: 20 }, (_, i) => `https://example.test/${i}/${'x'.repeat(150)}`).join('\n')),
        format: 'txt',
        root: s.root,
      })
    ).status,
  ).toBe('classified');
  const saved = (await s.store.all())[0]!;
  expect(saved.newFolders).toEqual([
    { id: 'import-folder:nested:0', parentId: 'import-folder:nested:1', title: 'Leaf' },
    { id: 'import-folder:nested:1', parentId: 'child', title: 'Parent' },
  ]);
  expect(saved.classified).toHaveLength(20);
  expect(s.payloads[1]!.folders.some(f => f.id === 'import-folder:nested:0')).toBe(true);
});
it('does not retry a provider response-budget error', async () => {
  const s = setup(10000);
  s.fetcher.mockImplementationOnce(async () => new Response('x'.repeat(100001)));
  expect(
    await s.make().start({
      id: 'response-limit',
      source: parsed('https://source.test'),
      format: 'txt',
      root: s.root,
    }),
  ).toMatchObject({ status: 'paused', reason: 'response-too-large' });
  expect(s.fetcher).toHaveBeenCalledTimes(1);
  expect((await s.store.all())[0]!.classified).toEqual([]);
});
it('continues directly after a worker restart (new epoch, reset revisions) and recover stays an alias of resume', async () => {
  const s = setup();
  s.failAt(2);
  await s.make().start({
    id: 'epoch',
    source: parsed(Array.from({ length: 20 }, (_, i) => `https://example.test/${i}/${'x'.repeat(150)}`).join('\n')),
    format: 'txt',
    root: s.root,
  });
  const before = (await s.store.all())[0]!;
  const calls = s.payloads.length;
  s.state.tree.epoch = 'new-epoch';
  s.state.tree.observedRevision = 0;
  s.state.tree.nodes.forEach(n => {
    n.observedRevision = 0;
  });
  expect((await s.make().recover('epoch', { root: s.root })).status).toBe('classified');
  const completed = before.classified.map(c => `import-item:epoch:${c.sourceOrdinal}`);
  expect(
    s.payloads
      .slice(calls)
      .flatMap(p => p.items.map(i => i.id))
      .some(id => completed.includes(id)),
  ).toBe(false);
  expect((await s.store.get('epoch'))!.classified).toHaveLength(20);
  const after = s.payloads.length;
  expect((await s.make().resume('epoch', { root: s.root })).status).toBe('classified');
  expect(s.payloads).toHaveLength(after);
});
it.each(['installation', 'root', 'privacy', 'config', 'title'] as const)(
  'continuation rejects changed %s semantics without mutation',
  async change => {
    const s = setup();
    s.failAt(1);
    s.state.tree.nodes.push({
      ...s.state.tree.nodes[0]!,
      ref: { installationId: 'i', nativeId: 'bookmark', kind: 'bookmark' },
      parentId: 'outside',
      url: 'https://outside.test',
    });
    await s.make().start({
      id: 'semantic',
      source: parsed('https://source.test'),
      format: 'txt',
      root: s.root,
    });
    const before = await s.store.get('semantic');
    const calls = s.fetcher.mock.calls.length;
    s.state.tree.epoch = 'new';
    if (change === 'installation') s.state.tree.installationId = 'other';
    if (change === 'root') s.state.tree.nodes[0]!.childrenWritable = false;
    if (change === 'privacy') s.state.privacy.fullUrl = true;
    if (change === 'config') s.state.config.model = 'other';
    if (change === 'title') s.state.tree.nodes[1]!.title = 'other';
    expect((await s.make().recover('semantic', { root: s.root })).status).toBe('paused');
    expect(await s.store.get('semantic')).toEqual(before);
    expect(s.fetcher).toHaveBeenCalledTimes(calls);
  },
);
it('a settings revision rotation or an outside bookmark URL change is not classification evidence', async () => {
  const s = setup();
  s.failAt(1);
  s.state.tree.nodes.push({
    ...s.state.tree.nodes[0]!,
    ref: { installationId: 'i', nativeId: 'bookmark', kind: 'bookmark' },
    parentId: 'outside',
    childrenWritable: undefined,
    url: 'https://outside.test',
  });
  await s.make().start({ id: 'lenient', source: parsed('https://source.test'), format: 'txt', root: s.root });
  expect((await s.store.get('lenient'))!.classified).toHaveLength(0);
  s.state.tree.epoch = 'new';
  s.state.revision = 'other';
  s.state.tree.nodes.at(-1)!.url = 'https://elsewhere.test';
  expect((await s.make().resume('lenient', { root: s.root })).status).toBe('classified');
  expect((await s.store.get('lenient'))!.classified).toHaveLength(1);
});
it('reclassification retains all original rows, old progress and atomic source revision provenance', async () => {
  const s = setup();
  const source = parsed('https://source.test\nhttps://source.test');
  await s.make().start({ id: 'original', source, format: 'txt', root: s.root });
  const before = await s.store.get('original');
  expect(before!.runtime!.sourceItems).toHaveLength(2);
  s.state.tree.epoch = 'new';
  s.state.tree.nodes[1]!.title = 'new';
  expect((await s.make().reclassify('original', { id: 'replacement', root: s.root })).status).toBe('classified');
  expect(await s.store.get('original')).toEqual(before);
  expect((await s.store.get('replacement'))!.sourceCheckpoint).toEqual({ id: 'original', revision: before!.revision });
  const branch = {
    ...(await s.store.get('replacement'))!,
    id: 'race',
    revision: 0,
    sourceCheckpoint: { id: 'original', revision: before!.revision - 1 },
  };
  await expect(s.store.put(branch, null)).rejects.toThrow('import-checkpoint-conflict');
  expect(await s.store.get('race')).toBeUndefined();
});
it('a scope folder change during execution rejects delivery and preserves durable evidence', async () => {
  const s = setup();
  s.failAt(1);
  await s.make().start({ id: 'active', source: parsed('https://source.test'), format: 'txt', root: s.root });
  const before = await s.store.get('active');
  s.state.tree.epoch = 'recovered';
  const original = s.fetcher.getMockImplementation()!;
  s.fetcher.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    s.state.tree.nodes[1]!.title = 'renamed while the model answered';
    return response;
  });
  expect(await s.make().recover('active', { root: s.root })).toMatchObject({
    status: 'paused',
    reason: 'stale-context',
  });
  expect(await s.store.get('active')).toEqual(before);
});
it('runtime v2 records continue under legacy strict-or-semantic evidence and otherwise require reclassification', async () => {
  const s = setup();
  const { legacyImportContextDigest } = await import('../domain/import-evidence');
  const { deduplicateImport } = await import('../domain/import-deduplication');
  const source = parsed('https://legacy.test/a\nhttps://legacy.test/b');
  const context = structuredClone(s.state);
  const legacy = {
    schemaVersion: 1 as const,
    id: 'v2',
    revision: 0,
    installationId: 'i',
    root: s.root,
    items: deduplicateImport(source.items, s.state.tree).pending,
    diagnostics: [],
    classified: [],
    newFolders: [],
    phase: 'paused' as const,
    runtime: {
      version: 2 as const,
      contextDigest: await legacyImportContextDigest(context, s.root),
      semanticDigest: await legacyImportContextDigest(context, s.root, true),
      stage: 'classification' as const,
      format: 'txt' as const,
      candidates: [],
      sourceItems: source.items,
      mappedGroups: [],
      mappedItems: [],
    },
  };
  await s.store.put(legacy, null);
  // A worker restart breaks the strict v2 digest, but the semantic digest still matches: continue as recover once did.
  s.state.tree.epoch = 'restarted';
  s.state.tree.observedRevision = 0;
  expect((await s.make().resume('v2', { root: s.root })).status).toBe('classified');
  const saved = (await s.store.get('v2'))!;
  expect(saved.runtime).toMatchObject({ version: 2, semanticDigest: legacy.runtime.semanticDigest });
  expect(saved.classified).toHaveLength(2);
  await s.store.put({ ...legacy, id: 'v2-stale' }, null);
  s.state.revision = 'rotated';
  expect(await s.make().resume('v2-stale', { root: s.root })).toMatchObject({
    status: 'paused',
    reason: 'import-reclassification-required',
  });
  expect((await s.store.get('v2-stale'))!.classified).toEqual([]);
});
it('target reads isolate unknown rows, legacy requires supplied source, and missing targets fail explicitly', async () => {
  const s = setup();
  await s.make().start({ id: 'valid', source: parsed('https://source.test'), format: 'txt', root: s.root });
  const valid = (await s.store.get('valid'))!;
  // Synthetic raw legacy/future rows; no production migration or cleanup.
  const factory = (s.store as unknown as { factory: IDBFactory }).factory;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = factory.open('zhilan-operations');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const legacy = { ...valid, id: 'legacy', runtime: undefined };
  const future = { id: 'future', schemaVersion: 999, retained: 'untouched' };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('importCheckpoints', 'readwrite');
    tx.objectStore('importCheckpoints').put(legacy);
    tx.objectStore('importCheckpoints').put(future);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  expect((await s.make().resume('valid', { root: s.root })).status).toBe('classified');
  expect((await s.make().recover('valid', { root: s.root })).status).toBe('classified');
  expect(await s.make().recover('legacy', { root: s.root })).toMatchObject({
    reason: 'import-reclassification-required',
  });
  expect(await s.make().reclassify('legacy', { id: 'new', root: s.root })).toMatchObject({
    reason: 'import-source-required',
  });
  expect(
    (
      await s.make().reclassify('legacy', {
        id: 'new',
        source: parsed('https://source.test'),
        format: 'txt',
        root: s.root,
      })
    ).status,
  ).toBe('classified');
  expect(await s.store.get('legacy')).toEqual(legacy);
  for (const id of ['future', 'missing']) {
    const reason = id === 'future' ? 'unsupported-import-checkpoint' : 'import-checkpoint-not-found';
    expect(await s.make().resume(id, { root: s.root })).toMatchObject({ reason });
    expect(await s.make().recover(id, { root: s.root })).toMatchObject({ reason });
    expect(await s.make().reclassify(id, { id: 'no', root: s.root })).toMatchObject({ reason });
  }
  expect(
    await new Promise(resolve => {
      const r = db.transaction('importCheckpoints').objectStore('importCheckpoints').get('future');
      r.onsuccess = () => resolve(r.result);
    }),
  ).toEqual(future);
  db.close();
});
it('request-bearing tasks remain journal-owned for resume, recovery and reclassification', async () => {
  const s = setup();
  await s.make().start({ id: 'owned', source: parsed('https://source.test'), format: 'txt', root: s.root });
  const checkpoint = (await s.store.get('owned'))!;
  // Seed historical request-bearing evidence; new applying transitions require atomic journal handoff.
  const db = await new Promise<IDBDatabase>(resolve => {
    const open = s.factory.open('zhilan-operations');
    open.onsuccess = () => resolve(open.result);
  });
  await new Promise<void>(resolve => {
    const tx = db.transaction('importCheckpoints', 'readwrite');
    tx.objectStore('importCheckpoints').put({
      ...checkpoint,
      revision: checkpoint.revision + 1,
      phase: 'applying',
      requestId: 'unknown-request',
    });
    tx.oncomplete = () => resolve();
  });
  db.close();
  const before = await s.store.get('owned');
  const calls = s.fetcher.mock.calls.length;
  expect(await s.make().resume('owned', { root: s.root })).toMatchObject({
    reason: 'import-checkpoint-recovery-required',
  });
  expect(await s.make().recover('owned', { root: s.root })).toMatchObject({
    reason: 'import-checkpoint-recovery-required',
  });
  expect(await s.make().reclassify('owned', { id: 'forbidden', root: s.root })).toMatchObject({
    reason: 'import-checkpoint-recovery-required',
  });
  expect(await s.store.get('owned')).toEqual(before);
  expect(await s.store.get('forbidden')).toBeUndefined();
  expect(s.fetcher).toHaveBeenCalledTimes(calls);
});
it('concurrent explicit recoveries cannot overwrite committed batches', async () => {
  const s = setup();
  s.failAt(1);
  await s.make().start({
    id: 'concurrent',
    source: parsed('https://source.test'),
    format: 'txt',
    root: s.root,
  });
  s.state.tree.epoch = 'new';
  const results = await Promise.all([
    s.make().recover('concurrent', { root: s.root }),
    s.make().recover('concurrent', { root: s.root }),
  ]);
  expect(results.some(r => r.status === 'classified')).toBe(true);
  expect((await s.store.get('concurrent'))!.classified).toHaveLength(1);
});

it('import title suggestions fill only missing unlocked source titles', async () => {
  const s = setup(10000);
  s.fetcher.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  assignments: [0, 1].map(i => ({
                    itemId: `import-item:titles:${i}`,
                    folderId: 'root',
                    title: 'Suggested',
                  })),
                  newFolders: [],
                }),
              },
            },
          ],
        }),
      ),
  );
  const source = parsed('[{"url":"https://a.test","title":"Locked"},{"url":"https://b.test","title":""}]', 'json');
  expect((await s.make().start({ id: 'titles', source, format: 'json', root: s.root })).status).toBe('classified');
  expect((await s.store.get('titles'))?.classified.map(row => row.title)).toEqual(['Locked', 'Suggested']);
});
