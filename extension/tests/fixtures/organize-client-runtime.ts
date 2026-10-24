import { vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { OrganizeTaskOwner } from '../../background/organize-task-owner';
import { startOrganizeTaskService } from '../../background/organize-task-service';
import { startMutationService } from '../../background/mutation-service';
import { OrganizeTaskAuthority } from '../../background/organize-task-authority';
import { OrganizerAuthority } from '../../background/organizer-authority';
import type { TreeProjection } from '../../background/tree-projection';
import { ImportPersistenceStore } from '../../persistence/import-persistence';
import { OrganizeMemoryStore } from '../../persistence/organize-memory';
import { TREE_PORT, type TreeState } from '../../domain/node-reference';
import { expectedAfter } from '../../domain/mutation-effect';
import type { ModelTransport } from '../../adapters/model-transport';
import type { BookmarkWriter } from '../../adapters/bookmarks-write';
import { OrganizeTaskClient } from '../../panel/organize-task-client';
import type { OrganizeState } from '../../domain/organize-state';
import { organizerTree } from './organizer-tree';

function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (fn: T) => {
      listeners.add(fn);
    },
    removeListener: (fn: T) => {
      listeners.delete(fn);
    },
    emit: (...args: Parameters<T>) => {
      for (const fn of listeners) fn(...args);
    },
  };
}
/** Real task service/owner/controller/checkpoints and sole coordinator behind synthetic Chrome boundaries. */
export function organizeClientRuntime() {
  const messages =
    event<(input: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => unknown>();
  const connects = event<(port: chrome.runtime.Port) => void>();
  const tree = organizerTree();
  const treeListeners = new Set<(tree: TreeState) => void>();
  const source = {
    state: { status: 'ready', snapshot: tree } as TreeState,
    fresh: async () => structuredClone(tree),
    subscribe: (fn: (tree: TreeState) => void) => {
      treeListeners.add(fn);
      fn(source.state);
      return () => {
        treeListeners.delete(fn);
      };
    },
  };
  const sender = { id: 'extension', url: 'chrome-extension://extension/options/index.html' };
  const log: Record<string, unknown>[] = [];
  let dropConfirmationReply = false;
  const ports: chrome.runtime.Port[] = [];
  const runtime = {
    id: 'extension',
    lastError: undefined as { message: string } | undefined,
    onMessage: messages,
    onConnect: connects,
    connect({ name }: { name: string }) {
      const pageMessage = event<(value: unknown) => void>(),
        workerMessage = event<(value: unknown) => void>();
      const disconnected = event<() => void>();
      let closed = false;
      const disconnect = () => {
        if (!closed) {
          closed = true;
          disconnected.emit();
        }
      };
      const page = {
        name,
        onMessage: pageMessage,
        onDisconnect: disconnected,
        disconnect,
        postMessage: (value: unknown) => {
          if (!closed) {
            if (name === TREE_PORT) pageMessage.emit({ version: 1, state: source.state });
            else workerMessage.emit(value);
          }
        },
      };
      const worker = {
        name,
        sender,
        onMessage: workerMessage,
        onDisconnect: disconnected,
        disconnect,
        postMessage: (value: unknown) => {
          if (!closed) pageMessage.emit(structuredClone(value));
        },
      };
      connects.emit(worker as unknown as chrome.runtime.Port);
      ports.push(page as unknown as chrome.runtime.Port);
      return page;
    },
    sendMessage(input: Record<string, unknown>, reply: (value: unknown) => void) {
      log.push(structuredClone(input));
      const respond = input.type === 'confirmMutation' && dropConfirmationReply ? () => {} : reply;
      queueMicrotask(() => messages.emit(input, sender, respond));
    },
  };
  vi.stubGlobal('chrome', {
    runtime,
    permissions: { contains: async () => true, onRemoved: { addListener: () => {}, removeListener: () => {} } },
  });
  const value = {
    version: 1 as const,
    revision: 'one',
    sessionRevision: 0,
    key: '',
    config: { adapter: 'openai-responses' as const, baseUrl: 'https://model.test/v1', model: 'm', timeoutMs: 1000 },
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
  };
  let key = 'dummy-page-memory-key';
  const settings = { snapshot: async () => structuredClone(value), subscribe: () => () => {} };
  const pageSettings = { ...settings, snapshot: async () => ({ ...structuredClone(value), key }) };
  const journal = new ImportPersistenceStore(new IDBFactory());
  const memory = new OrganizeMemoryStore();
  const run = vi.fn<ModelTransport['run']>();
  const model = { run, cancel: vi.fn(), dispose: vi.fn(), fork: () => ({ run, cancel: vi.fn(), dispose: vi.fn() }) };
  let owner: OrganizeTaskOwner;
  let stopTasks: () => void;
  const restart = () => {
    stopTasks?.();
    owner = new OrganizeTaskOwner({
      projection: source,
      settings,
      store: journal.organizeCheckpoints,
      memory,
      model: () => model,
      lifetime: { acquire: () => () => {}, dispose: () => {} },
    });
    stopTasks = startOrganizeTaskService(owner);
  };
  restart();
  const organizer = new OrganizerAuthority(settings, 'extension');
  const authority = new OrganizeTaskAuthority(
    settings,
    source,
    journal.organizeCheckpoints,
    organizer,
    'extension',
    memory,
    checkpoint => owner.submitted(checkpoint),
  );
  const move = vi.fn<BookmarkWriter['move']>(async (id, input) => {
    const node = tree.nodes.find(n => n.ref.nativeId === id)!;
    const returned = {
      id,
      title: node.title,
      url: node.url,
      parentId: input.parentId,
      index: input.index,
      syncing: false,
    };
    tree.nodes = expectedAfter(tree, { type: 'move', id, parentId: input.parentId!, index: input.index! }, returned);
    tree.observedRevision++;
    treeListeners.forEach(fn => fn(source.state));
    return returned;
  });
  const writer = { move, create: vi.fn(), update: vi.fn(), remove: vi.fn() } as BookmarkWriter;
  startMutationService(
    source as unknown as TreeProjection,
    undefined,
    organizer,
    undefined,
    journal,
    writer,
    authority,
  );
  const client = (emit: (value: OrganizeState) => void) => {
    const page = new OrganizeTaskClient(emit, pageSettings, runtime as unknown as typeof chrome.runtime, async () => {
      const token = await organizer.open(sender);
      return { token, close: () => organizer.close(token) };
    });
    page.setTree(source.state);
    return page;
  };
  return {
    client,
    owner: () => owner,
    restart,
    changeModel: (model: string) => {
      value.config.model = model;
      value.revision = 'changed';
    },
    run,
    journal,
    memory,
    tree,
    move,
    log,
    dropConfirmationReply: () => {
      dropConfirmationReply = true;
    },
    ports,
    forgetKey: () => {
      key = '';
    },
    restoreKey: () => {
      key = 'renewed-dummy-key';
    },
    dispose: () => {
      stopTasks();
      ports.forEach(port => port.disconnect());
    },
  };
}
