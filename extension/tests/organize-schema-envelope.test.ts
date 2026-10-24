import { expect, it, vi } from 'vitest';
import { ModelTransport, normalizeModelJson } from '../adapters/model-transport';
import { compactAiPayload, serializeAiPayload } from '../domain/ai-payload';
import type { TreeSnapshot } from '../domain/node-reference';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import { modelOutputJsonSchema, parseModelOutput } from '../schemas/model-output';
import { organizerTree } from './fixtures/organizer-tree';

const empty = { moves: [], newFolders: [], merges: [] };
const envelope = (properties: unknown) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties,
});
const parseContext = {
  task: 'organize',
  stage: 'folders' as const,
  items: [{ id: '12', title: 'Sample category' }],
  folders: [{ id: 'scope' }, { id: '12', ancestorIds: ['scope'] }],
};

it('unwraps only an explicit answer envelope, preserving action reasons and normal ID validation', () => {
  const answer = { ...empty, renames: [{ folderId: 12, title: 'Examples', reason: 'Clearer topic' }] };
  expect(parseModelOutput(normalizeModelJson(envelope(answer), 'organize'), parseContext)).toEqual({
    ...empty,
    renames: [{ folderId: '12', title: 'Examples', reason: 'Clearer topic' }],
  });
});

it.each([
  ['schema definition', modelOutputJsonSchema('organize')],
  ['empty properties', envelope({})],
  ['missing action array', envelope({ moves: [], newFolders: [] })],
  ['mixed root fields', { ...envelope(empty), renames: [] }],
  ['nested envelope', envelope(envelope(empty))],
  ['unknown schema', { ...envelope(empty), $schema: 'https://untrusted.test/schema' }],
  ['unknown answer field', envelope({ ...empty, url: 'https://untrusted.test/' })],
  ['unknown action field', envelope({ ...empty, renames: [{ folderId: '12', title: 'A', url: 'x' }] })],
  ['invented destination', envelope({ ...empty, moves: [{ itemId: '12', folderId: 'invented' }] })],
  [
    'contradictory unchanged annotation',
    envelope({ ...empty, unchangedIds: ['12'], renames: [{ folderId: '12', title: 'A' }] }),
  ],
])('rejects %s instead of silently accepting an empty or unsafe plan', (_name, answer) => {
  expect(() => parseModelOutput(normalizeModelJson(answer, 'organize'), parseContext)).toThrow('invalid-output');
});

it('projects root and offered read-only source constraints without leaking excluded or unrelated IDs', () => {
  const tree = organizerTree();
  tree.nodes.find(n => n.ref.nativeId === 'left')!.readOnly = true;
  const payload = serializeAiPayload(
    tree,
    { fullUrl: false, bodyEnabled: false, excludedFolders: [tree.nodes.find(n => n.ref.nativeId === 'right')!.ref] },
    { task: 'organize', rootId: 'bar', stage: 'folders', itemIds: [], folderIds: ['bar', 'left', 'right'] },
  );
  for (const serialized of [payload, compactAiPayload(payload)]) {
    expect(JSON.parse(serialized)).toMatchObject({ rootId: 'bar', protectedSourceIds: ['bar', 'left'] });
    expect(serialized).not.toContain('right');
    expect(serialized).not.toContain('outside');
  }
});

function setup(answers: unknown[], providerFailure = false) {
  const tree: TreeSnapshot = {
    installationId: 'install',
    epoch: 'epoch',
    observedRevision: 1,
    roots: ['scope'],
    nodes: [
      {
        ref: { installationId: 'install', nativeId: 'scope', kind: 'folder' },
        title: 'Sample scope',
        index: 0,
        childrenIds: ['b1'],
        readOnly: false,
        childrenWritable: true,
        observedRevision: 1,
      },
      {
        ref: { installationId: 'install', nativeId: 'b1', kind: 'bookmark' },
        title: 'Sample bookmark',
        url: 'https://example.test/',
        parentId: 'scope',
        index: 0,
        childrenIds: [],
        readOnly: false,
        observedRevision: 1,
      },
    ],
  };
  const context = {
    tree,
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    key: '',
    privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    config: {
      adapter: 'openai-compatible' as const,
      baseUrl: 'https://api.minimax.cn/v1',
      model: 'MiniMax-M3.1-Flash-Preview',
      timeoutMs: 1000,
    },
  };
  const authority = { read: async () => structuredClone(context), subscribe: () => () => {} };
  const requests: {
    system: string;
    payload: { rootId: string; protectedSourceIds: string[]; stage: string; items: { id: string }[] };
  }[] = [];
  let folderCalls = 0;
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const payload = JSON.parse(body.messages[1].content);
    requests.push({ system: body.messages[0].content, payload });
    expect(body.response_format).toBeUndefined();
    const answer =
      payload.stage === 'folders'
        ? answers[Math.min(folderCalls++, answers.length - 1)]
        : { ...empty, unchangedIds: payload.items.map((item: { id: string }) => item.id) };
    const events = [
      { choices: [{ index: 0, delta: { content: JSON.stringify(answer) }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ...(providerFailure ? [{ error: { type: 'server_error', message: 'Synthetic provider failure' } }] : []),
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  });
  const transport = new ModelTransport({ contains: async () => true, fetch }, authority, undefined, async () => {});
  let state!: OrganizeState;
  const send = vi.fn(async (request: { requestId: string }) => ({
    requestId: request.requestId,
    status: 'completed',
    completedSteps: 1,
    remainingSteps: 0,
    needsReconcile: false,
  }));
  const controller = new OrganizeController(
    s => {
      state = s;
    },
    authority,
    transport,
    async () => ({ token: 'lease', close: vi.fn() }),
    send,
  );
  controller.setTree({ status: 'ready', snapshot: tree });
  controller.selectScope('scope');
  return {
    controller,
    requests,
    fetch,
    send,
    state: () => state,
    start: () => controller.generate(undefined, { staged: true, cleanupEmpty: false }),
    dispose: () => {
      controller.dispose();
      transport.dispose();
    },
  };
}

const protectedRename = { ...empty, renames: [{ folderId: 'scope', title: 'Renamed scope' }] };
const conflict = envelope({ ...protectedRename, unchangedIds: ['scope'] });

it('runs an enveloped Chat SSE answer through folder review, bookmark batches and explicit apply', async () => {
  const h = setup([envelope({ ...empty, newFolders: [{ id: 'new-category', parentId: 'scope', title: 'Examples' }] })]);
  try {
    await h.start();
    expect(h.state().failure).toBeUndefined();
    expect(h.state().pipeline).toMatchObject({ stage: 'folders', status: 'review' });
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.requests[0]!.payload).toMatchObject({ rootId: 'scope', protectedSourceIds: ['scope'], items: [] });
    expect(h.requests[0]!.system).toContain('return an instance, not the schema itself');
    expect(h.requests[0]!.system).toContain('never move, merge as source, rename or remove');
    expect(h.send).not.toHaveBeenCalled();
    await h.controller.confirmFolders();
    expect(h.state().failure).toBeUndefined();
    expect(h.state().pipeline).toMatchObject({ stage: 'complete', completed: 1 });
    expect(h.send).not.toHaveBeenCalled();
    await h.controller.apply();
    expect(h.send).toHaveBeenCalledOnce();
  } finally {
    h.dispose();
  }
});

it.each([
  ['schema and action conflict', conflict],
  ['protected root action', envelope(protectedRename)],
])('corrects %s once without dropping unsafe actions or writing bookmarks', async (_name, answer) => {
  const h = setup([answer, { ...empty, unchangedIds: ['scope'] }]);
  try {
    await h.start();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.requests[1]!.system).toContain('Correction:');
    expect(h.state().failure).toBeUndefined();
    expect(h.state().pipeline).toMatchObject({ stage: 'folders', status: 'review' });
    expect(h.state().proposal?.actions).toEqual([]);
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it.each([
  ['schema', conflict],
  ['protected-source', protectedRename],
])('shares one correction budget across schema and compiler failures, ending with %s', async (code, second) => {
  const h = setup([conflict, second]);
  try {
    await h.start();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.state().failure?.code).toBe(code);
    expect(h.state().pipeline?.status).toBe('failed');
    await h.controller.confirmFolders();
    await h.controller.apply();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});

it('does not unwrap or retry past a provider failure even with valid answer text', async () => {
  const h = setup([envelope(empty)], true);
  try {
    await h.start();
    expect(h.fetch).toHaveBeenCalledOnce();
    expect(h.state().failure?.code).toBe('provider-error');
    expect(h.send).not.toHaveBeenCalled();
  } finally {
    h.dispose();
  }
});
