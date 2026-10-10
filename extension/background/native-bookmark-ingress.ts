import type { BookmarkWriter } from '../adapters/bookmarks-write';
import { ModelTransport } from '../adapters/model-transport';
import { DEFAULT_CLASSIFICATION_POLICY } from '../domain/classification-policy';
import { createDebugLog, type DebugLog } from '../domain/debug-log';
import { planNativeSaveApply } from '../domain/native-save-apply';
import type { TreeSnapshot } from '../domain/node-reference';
import { AiServicesStore } from '../persistence/ai-services';
import type { SettingsStore } from '../persistence/settings';
import type { OwnWriteGuard } from './own-write-guard';
import type { TreeProjection } from './tree-projection';
import { workerModelAuthority } from './worker-model-authority';

export type NativeClassifyResult =
  | { status: 'skipped'; reason: string; bookmarkId: string }
  | { status: 'failed'; reason: string; bookmarkId: string }
  | { status: 'completed'; bookmarkId: string; destinationId: string; createdFolderIds: string[] };

export type NativeBookmarkIngressOptions = {
  projection: TreeProjection;
  settings: SettingsStore;
  aiServices: AiServicesStore;
  writer: BookmarkWriter;
  guard: OwnWriteGuard;
  /** chrome.bookmarks surface; defaults to global chrome.bookmarks. */
  bookmarks?: {
    onCreated: {
      addListener(cb: (id: string, node: chrome.bookmarks.BookmarkTreeNode) => void): void;
      removeListener(cb: (id: string, node: chrome.bookmarks.BookmarkTreeNode) => void): void;
    };
    onRemoved: { addListener(cb: (id: string) => void): void; removeListener(cb: (id: string) => void): void };
    onImportBegan: { addListener(cb: () => void): void; removeListener(cb: () => void): void };
    onImportEnded: { addListener(cb: () => void): void; removeListener(cb: () => void): void };
  };
  permissions?: { contains(request: { origins?: string[]; permissions?: string[] }): Promise<boolean> };
  fetch?: typeof fetch;
  settlingMs?: number;
  debug?: DebugLog;
  /** Optional UI hint after a successful auto-classify (badge). Never throws. */
  notify?: (result: Extract<NativeClassifyResult, { status: 'completed' }>) => void;
};

const DEFAULT_SETTLING_MS = 800;

/** True when AiServicesStore「智能收藏」has a connection+model assignment. */
export function isSaveFeatureConfigured(ai: AiServicesStore): boolean {
  const { features, services } = ai.snapshotServices();
  const feat = features.find(f => f.id === 'save');
  if (!feat?.connId || !feat.modelId) return false;
  return services.some(s => s.id === feat.connId && s.baseUrl.trim().length > 0);
}

async function loadSaveRoute(ai: AiServicesStore, settings: SettingsStore) {
  await ai.load();
  if (!isSaveFeatureConfigured(ai)) return undefined;
  try {
    await settings.load();
  } catch {
    return undefined;
  }
  const snap = await settings.snapshot();
  if (!snap.config) return undefined;
  return snap;
}

/**
 * Listen to chrome.bookmarks.onCreated after the browser has written the star/Ctrl+D bookmark.
 * When「智能收藏」is configured, run ModelTransport task save and move/create folders.
 * Does not hijack browser shortcuts. Skips plugin-created ids via OwnWriteGuard.
 */
export function startNativeBookmarkIngress(options: NativeBookmarkIngressOptions) {
  const {
    projection,
    settings,
    aiServices,
    writer,
    guard,
    settlingMs = DEFAULT_SETTLING_MS,
    debug = createDebugLog(),
    notify,
  } = options;
  const bookmarksApi = options.bookmarks ?? chrome.bookmarks;
  const permissionsApi = options.permissions ?? chrome.permissions;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  let importing = false;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  let active: { id: string; transport: ModelTransport } | undefined;

  const clearPending = (id: string) => {
    const timer = pending.get(id);
    if (timer) clearTimeout(timer);
    pending.delete(id);
  };

  const onCreated = (id: string, node: chrome.bookmarks.BookmarkTreeNode) => {
    if (disposed) return;
    guard.sweep();
    if (importing) {
      debug('native-save-skip', { bookmarkId: id, reason: 'importing' });
      return;
    }
    if (guard.isOwn(id)) {
      debug('native-save-skip', { bookmarkId: id, reason: 'plugin-created' });
      return;
    }
    if (!node.url) {
      debug('native-save-skip', { bookmarkId: id, reason: 'folder' });
      return;
    }
    try {
      const url = new URL(node.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        debug('native-save-skip', { bookmarkId: id, reason: 'unsafe-url' });
        return;
      }
    } catch {
      debug('native-save-skip', { bookmarkId: id, reason: 'bad-url' });
      return;
    }
    clearPending(id);
    debug('native-save-observed', { bookmarkId: id, parentId: node.parentId });
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        void classify(id).catch(error =>
          debug('native-save-error', {
            bookmarkId: id,
            reason: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }, settlingMs),
    );
  };

  const onRemoved = (id: string) => {
    clearPending(id);
    if (active?.id === id) {
      active.transport.cancel();
      active = undefined;
      debug('native-save-cancel', { bookmarkId: id, reason: 'removed' });
    }
  };

  async function classify(bookmarkId: string): Promise<NativeClassifyResult> {
    if (disposed) return { status: 'skipped', reason: 'disposed', bookmarkId };
    if (guard.isOwn(bookmarkId)) return { status: 'skipped', reason: 'plugin-created', bookmarkId };

    const route = await loadSaveRoute(aiServices, settings);
    if (!route?.config) {
      debug('native-save-skip', { bookmarkId, reason: 'save-feature-unconfigured' });
      return { status: 'skipped', reason: 'save-feature-unconfigured', bookmarkId };
    }

    let tree: TreeSnapshot;
    try {
      tree = await projection.fresh();
    } catch {
      debug('native-save-skip', { bookmarkId, reason: 'tree-unavailable' });
      return { status: 'skipped', reason: 'tree-unavailable', bookmarkId };
    }

    const node = tree.nodes.find(n => n.ref.nativeId === bookmarkId && n.ref.kind === 'bookmark');
    if (!node?.url) {
      debug('native-save-skip', { bookmarkId, reason: 'missing-bookmark' });
      return { status: 'skipped', reason: 'missing-bookmark', bookmarkId };
    }

    const root = tree.nodes.find(n => n.parentId === undefined && n.ref.kind === 'folder');
    if (!root) return { status: 'failed', reason: 'no-root', bookmarkId };

    const folderIds = tree.nodes.filter(n => n.childrenWritable).map(n => n.ref.nativeId);
    if (!folderIds.length) return { status: 'failed', reason: 'no-writable-folders', bookmarkId };

    const authority = workerModelAuthority(projection, settings);
    const transport = new ModelTransport(
      {
        fetch: fetchFn,
        contains: request => permissionsApi.contains(request),
      },
      authority,
    );
    active = { id: bookmarkId, transport };
    debug('native-save-model-start', { bookmarkId });

    try {
      const response = await transport.run({
        config: route.config,
        key: route.key,
        privacy: route.privacy,
        tree,
        policy: DEFAULT_CLASSIFICATION_POLICY,
        request: {
          task: 'save',
          targetId: root.ref.nativeId,
          item: { source: 'bookmark', id: bookmarkId },
          folderIds,
        },
      });

      if (response.status !== 'completed') {
        debug('native-save-model-failed', { bookmarkId, reason: response.reason });
        return { status: 'failed', reason: response.reason, bookmarkId };
      }
      if (!('assignments' in response.output)) {
        return { status: 'failed', reason: 'schema', bookmarkId };
      }
      const assignment = response.output.assignments.find(a => a.itemId === bookmarkId);
      if (!assignment) return { status: 'failed', reason: 'no-assignment', bookmarkId };

      // Re-read after model: tree may have moved; plan against fresh state.
      let live: TreeSnapshot;
      try {
        live = await projection.fresh();
      } catch {
        return { status: 'failed', reason: 'tree-unavailable', bookmarkId };
      }
      if (guard.isOwn(bookmarkId)) return { status: 'skipped', reason: 'plugin-created', bookmarkId };
      if (!live.nodes.some(n => n.ref.nativeId === bookmarkId && n.ref.kind === 'bookmark'))
        return { status: 'skipped', reason: 'missing-bookmark', bookmarkId };

      const plan = planNativeSaveApply(live, bookmarkId, assignment.folderId, response.output.newFolders);
      if (plan.status === 'noop') {
        debug('native-save-noop', { bookmarkId, reason: plan.reason });
        return { status: 'skipped', reason: plan.reason, bookmarkId };
      }
      if (plan.status === 'invalid') {
        debug('native-save-invalid-plan', { bookmarkId, reason: plan.reason });
        return { status: 'failed', reason: plan.reason, bookmarkId };
      }

      let parentId = plan.anchorParentId;
      const createdFolderIds: string[] = [];
      for (const title of plan.createTitles) {
        const created = await writer.create({ parentId, title });
        createdFolderIds.push(created.id);
        parentId = created.id;
      }
      const destinationId = plan.createTitles.length ? parentId : plan.destinationFolderId;
      if (live.nodes.find(n => n.ref.nativeId === bookmarkId)?.parentId !== destinationId) {
        await writer.move(bookmarkId, { parentId: destinationId, index: 0 });
      }

      const result: Extract<NativeClassifyResult, { status: 'completed' }> = {
        status: 'completed',
        bookmarkId,
        destinationId,
        createdFolderIds,
      };
      debug('native-save-completed', {
        bookmarkId,
        destinationId,
        createdFolders: createdFolderIds.length,
      });
      try {
        notify?.(result);
      } catch {
        /* notify is advisory */
      }
      return result;
    } finally {
      transport.dispose();
      if (active?.transport === transport) active = undefined;
    }
  }

  bookmarksApi.onCreated.addListener(onCreated);
  bookmarksApi.onRemoved.addListener(onRemoved);
  const onImportBegan = () => {
    importing = true;
    debug('native-save-import-began', {});
  };
  const onImportEnded = () => {
    importing = false;
    debug('native-save-import-ended', {});
  };
  bookmarksApi.onImportBegan.addListener(onImportBegan);
  bookmarksApi.onImportEnded.addListener(onImportEnded);

  debug('native-save-ingress-started', { settlingMs });

  return {
    /** Test/debug: run classify for an id without waiting for settling. */
    classify,
    dispose() {
      disposed = true;
      for (const id of [...pending.keys()]) clearPending(id);
      active?.transport.cancel();
      active = undefined;
      bookmarksApi.onCreated.removeListener(onCreated);
      bookmarksApi.onRemoved.removeListener(onRemoved);
      bookmarksApi.onImportBegan.removeListener(onImportBegan);
      bookmarksApi.onImportEnded.removeListener(onImportEnded);
      debug('native-save-ingress-stopped', {});
    },
  };
}

/** Brief action badge when auto-classify succeeds; no notifications permission required. */
export async function notifyNativeSaveBadge(result: Extract<NativeClassifyResult, { status: 'completed' }>) {
  const action = typeof chrome !== 'undefined' ? chrome.action : undefined;
  if (!action?.setBadgeText) return;
  try {
    await action.setBadgeText({ text: '✓' });
    if (action.setBadgeBackgroundColor) await action.setBadgeBackgroundColor({ color: '#34A853' });
    setTimeout(() => {
      void action.setBadgeText({ text: '' }).catch(() => {});
    }, 2500);
  } catch {
    /* badge is advisory */
  }
  void result;
}
