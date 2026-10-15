import { expect, it, vi } from 'vitest';
import { ModelTransport } from '../adapters/model-transport';
import { OrganizeController, type OrganizeState } from '../panel/organize-controller';
import { organizeCompilation } from '../domain/organize-proposal';
import type { TreeSnapshot } from '../domain/node-reference';

// Same topology/counts/action combination as the reported reply. All titles,
// URLs, native IDs and model identity are synthetic; no private log is embedded.
it.each(['merge-cleanup', 'unchanged-folders'])(
  'replays 11 folders and 179 bookmarks through Anthropic to final confirmation: %s',
  async variant => {
    const folders = Array.from({ length: 11 }, (_, i) => `f${i}`);
    const counts = [58, 38, 20, 51, 1, 2, 2, 3, 1, 1, 2];
    const tree: TreeSnapshot = {
      installationId: 'install',
      epoch: 'epoch',
      observedRevision: 1,
      roots: ['f0'],
      nodes: folders.map((id, i) => ({
        ref: { installationId: 'install', nativeId: id, kind: 'folder' },
        parentId: i ? 'f0' : undefined,
        index: Math.max(0, i - 1),
        title: `Folder ${i}`,
        childrenIds: i ? [] : folders.slice(1),
        childrenWritable: true,
        readOnly: i === 0,
        observedRevision: 1,
      })),
    };
    for (const [i, count] of counts.entries()) {
      const parent = tree.nodes[i]!;
      for (let j = 0; j < count; j++) {
        const id = `bookmark-${i}-${j}`;
        tree.nodes.push({
          ref: { installationId: 'install', nativeId: id, kind: 'bookmark' },
          parentId: folders[i],
          index: parent.childrenIds.length,
          title: `Item ${i}-${j}`,
          url: `https://example.test/${i}/${j}`,
          childrenIds: [],
          readOnly: false,
          observedRevision: 1,
        });
        parent.childrenIds.push(id);
      }
    }
    const latest = variant === 'unchanged-folders';
    const merges = (latest ? [4, 5, 6, 7, 8, 9] : [4, 5, 6, 8, 9]).map(i => ({
      sourceId: `f${i}`,
      targetId: i < 7 ? 'new-dev' : 'new-web',
    }));
    const reply = {
      unchangedIds: latest ? ['f2', 'f3', 'f10'] : [],
      moves: [],
      newFolders: (latest ? ['dev', 'web'] : ['dev', 'web', 'news']).map(id => ({
        id: `new-${id}`,
        parentId: 'f0',
        title: `Category ${id}`,
      })),
      merges,
      renames: (latest ? [1] : [1, 2, 7]).map(i => ({ folderId: `f${i}`, title: `Renamed ${i}` })),
      removeFolders: latest ? [] : merges.map(m => ({ folderId: m.sourceId, reason: 'Empty after merge' })),
    };
    const context = {
      tree,
      version: 1 as const,
      revision: 'one',
      sessionRevision: 0,
      key: '',
      privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
      config: { adapter: 'anthropic' as const, baseUrl: 'https://model.test', model: 'fixture', timeoutMs: 1000 },
    };
    const authority = { read: async () => structuredClone(context), subscribe: () => () => {} };
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).messages[0].content);
      const output =
        input.stage === 'folders'
          ? reply
          : {
              moves: [],
              newFolders: [],
              merges: [],
              unchangedIds: input.items.map((item: { id: string }) => item.id),
            };
      const events = [
        { type: 'message_start', message: { content: [], stop_reason: null } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: JSON.stringify(output) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        { type: 'message_stop' },
      ];
      return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });
    const transport = new ModelTransport({ contains: async () => true, fetch }, authority);
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
    try {
      controller.setTree({ status: 'ready', snapshot: tree });
      controller.selectScope('f0');
      await controller.generate(undefined, { staged: true });
      expect(state.failure).toBeUndefined();
      expect(state.pipeline).toMatchObject({ stage: 'folders', total: 179 });
      expect(state.proposal?.actions.filter(a => a.kind === 'merge')).toHaveLength(merges.length);
      expect(state.proposal?.actions.filter(a => a.kind === 'delete')).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
      await controller.confirmFolders();
      expect(state.failure).toBeUndefined();
      expect(state.pipeline).toMatchObject({ stage: 'complete', completed: 179 });
      expect(fetch).toHaveBeenCalledTimes(3);
      const after = organizeCompilation(state.proposal!, state.selected, state.targets, 'lease').plan.simulated;
      const metadata = (snapshot: TreeSnapshot) =>
        snapshot.nodes
          .filter(n => n.ref.kind === 'bookmark')
          .map(n => [n.ref.nativeId, n.title, n.url])
          .sort();
      expect(metadata(after)).toEqual(metadata(tree));
      for (const merge of merges) expect(after.nodes.some(n => n.ref.nativeId === merge.sourceId)).toBe(false);
      expect(send).not.toHaveBeenCalled();
      await controller.apply();
      expect(send).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
      transport.dispose();
    }
  },
);
