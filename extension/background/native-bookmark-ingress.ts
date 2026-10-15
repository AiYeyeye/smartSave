import type { BookmarkWriter } from '../adapters/bookmarks-write';
import type { ModelAuthority, ModelAuthorityChange } from '../adapters/model-authority';
import { ModelTransport } from '../adapters/model-transport';
import { apiModeToAdapter, type ApiMode } from '../domain/ai-providers';
import { DEFAULT_CLASSIFICATION_POLICY } from '../domain/classification-policy';
import { createDebugLog, type DebugLog } from '../domain/debug-log';
import type { ModelConfig } from '../domain/model-route';
import { parseModelEndpoint } from '../domain/model-route';
import { dependencyDigest, settingsIdentity } from '../domain/context-dependencies';
import type { AiRequest } from '../domain/ai-payload';
import { planNativeSaveApply } from '../domain/native-save-apply';
import type { TreeSnapshot } from '../domain/node-reference';
import { AiServicesStore } from '../persistence/ai-services';
import type { SaveReceipt, SaveReceiptLog } from '../persistence/save-receipts';
import type { SettingsStore } from '../persistence/settings';
import type { OwnWriteGuard } from './own-write-guard';
import type { TreeProjection } from './tree-projection';
import { createWorkerTaskLifetime } from './worker-task-lifetime';

export type NativeClassifyResult =
  | { status: 'skipped'; reason: string; bookmarkId: string }
  | { status: 'failed'; reason: string; bookmarkId: string }
  | { status: 'completed'; bookmarkId: string; destinationId: string; createdFolderIds: string[] };

export type BadgeState = 'working' | 'done' | 'attention' | 'clear';

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
  /** Receipts the popup shows (where it went / why AI did not run). Optional for tests. */
  receipts?: SaveReceiptLog;
  /** Toolbar badge hint; never throws. */
  badge?: (state: BadgeState) => void;
  /** Optional UI hint after a successful auto-classify. Never throws. */
  notify?: (result: Extract<NativeClassifyResult, { status: 'completed' }>) => void;
};

const DEFAULT_SETTLING_MS = 800;
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/** True when AiServicesStore「智能收藏」has a connection+model assignment. */
export function isSaveFeatureConfigured(ai: AiServicesStore): boolean {
  const { features, services } = ai.snapshotServices();
  const feat = features.find(f => f.id === 'save');
  if (!feat?.connId || !feat.modelId) return false;
  return services.some(s => s.id === feat.connId && s.baseUrl.trim().length > 0);
}

export type SaveRoute =
  | { status: 'ok'; config: ModelConfig; key: string; label: string }
  | { status: 'skip'; reason: 'save-feature-unconfigured' | 'service-missing' | 'no-key' | 'settings-unavailable' };

/**
 * The route for background auto-classify comes straight from the AI services「智能收藏」assignment.
 * It no longer depends on the legacy single-connection settings, which made saves silently skip.
 */
export async function resolveSaveRoute(ai: AiServicesStore): Promise<SaveRoute> {
  try {
    await ai.load();
  } catch {
    return { status: 'skip', reason: 'settings-unavailable' };
  }
  const { features, services } = ai.snapshotServices();
  const feat = features.find(f => f.id === 'save');
  if (!feat?.connId || !feat.modelId) return { status: 'skip', reason: 'save-feature-unconfigured' };
  const service = services.find(s => s.id === feat.connId);
  if (!service?.baseUrl.trim()) return { status: 'skip', reason: 'service-missing' };
  const config: ModelConfig = {
    adapter: apiModeToAdapter(service.mode as ApiMode),
    baseUrl: service.baseUrl,
    model: feat.modelId,
    timeoutMs: service.timeoutMs ?? 60000,
    ...(service.streaming === undefined ? {} : { streaming: service.streaming }),
    ...(service.maxOutputTokens === undefined ? {} : { maxOutputTokens: service.maxOutputTokens }),
  };
  const key = ai.credential(service.id);
  let host: string;
  try {
    host = new URL(service.baseUrl).hostname;
  } catch {
    return { status: 'skip', reason: 'service-missing' };
  }
  if (!key && !LOOPBACK.test(host)) return { status: 'skip', reason: 'no-key' };
  return { status: 'ok', config, key, label: `${feat.modelId} · ${service.name}` };
}

/** Model authority whose route identity is the AI services「智能收藏」assignment plus current privacy settings. */
export function saveFeatureAuthority(
  projection: TreeProjection,
  settings: SettingsStore,
  ai: AiServicesStore,
): ModelAuthority {
  const listeners = new Set<(change?: ModelAuthorityChange) => void>();
  let stop: (() => void) | undefined;
  const changed = (change: ModelAuthorityChange) => {
    for (const listener of listeners) listener(change);
  };
  const permissionsRemoved = () => changed('permissions');
  return {
    async read() {
      const tree = await projection.fresh();
      const snapshot = await settings.snapshot();
      const route = await resolveSaveRoute(ai);
      return {
        ...snapshot,
        ...(route.status === 'ok' ? { config: route.config, key: route.key } : { config: undefined, key: '' }),
        tree: structuredClone(tree) as TreeSnapshot,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        const stopTree = projection.subscribe(() => changed('tree'));
        const stopStore = settings.subscribe(() => changed('settings'));
        const stopAi = ai.subscribe(() => changed('settings'));
        if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved)
          chrome.permissions.onRemoved.addListener(permissionsRemoved);
        stop = () => {
          stopTree();
          stopStore();
          stopAi();
          if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved)
            chrome.permissions.onRemoved.removeListener(permissionsRemoved);
        };
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}

/** "书签栏 / 开发 / 前端" for a folder id in a snapshot. */
export function folderPath(tree: TreeSnapshot, folderId: string | undefined): string {
  const byId = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const parts: string[] = [];
  let cursor = folderId ? byId.get(folderId) : undefined;
  let guard = 0;
  while (cursor && guard++ < 64) {
    if (cursor.title) parts.unshift(cursor.title);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return parts.join(' / ');
}

/**
 * Listen to chrome.bookmarks.onCreated after the browser has written the star/Ctrl+D bookmark.
 * When「智能收藏」is configured, run ModelTransport task save and move/create folders.
 * Every observed user save leaves a receipt, so the popup can say whether AI ran and where the bookmark went.
 */
export function startNativeBookmarkIngress(options: NativeBookmarkIngressOptions) {
  const {
    projection,
    settings,
    aiServices,
    writer,
    guard,
    settlingMs = DEFAULT_SETTLING_MS,
    debug = createDebugLog('save'),
    notify,
    receipts,
    badge,
  } = options;
  const bookmarksApi = options.bookmarks ?? chrome.bookmarks;
  const permissionsApi = options.permissions ?? chrome.permissions;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);

  let importing = false;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;
  const active = new Set<{ id: string; transport: ModelTransport; invalidated: boolean }>();
  const lifetime = createWorkerTaskLifetime();

  const setBadge = (state: BadgeState) => {
    try {
      badge?.(state);
    } catch {
      /* advisory */
    }
  };
  const record = async (receipt: SaveReceipt) => {
    try {
      await receipts?.upsert(receipt);
    } catch {
      /* receipts are advisory */
    }
  };
  // Queue recovery before registering ingress. A new save waits for it so its
  // own receipt cannot be mistaken for an abandoned task from a previous worker.
  const ready = receipts
    ?.interruptPending()
    .then(count => {
      if (count) {
        debug('interrupted-receipts', { count });
        if (!disposed) setBadge('attention');
      }
    })
    .catch(() => debug('receipt-recovery-failed', {}));

  const clearPending = (id: string) => {
    const timer = pending.get(id);
    if (timer) clearTimeout(timer);
    pending.delete(id);
  };

  const onCreated = (id: string, node: chrome.bookmarks.BookmarkTreeNode) => {
    if (disposed) return;
    guard.sweep();
    if (importing) {
      debug('skip', { bookmarkId: id, reason: 'importing' });
      return;
    }
    if (guard.isOwn(id)) {
      debug('skip', { bookmarkId: id, reason: 'plugin-created' });
      return;
    }
    if (!node.url) {
      debug('skip', { bookmarkId: id, reason: 'folder' });
      return;
    }
    try {
      const url = new URL(node.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        debug('skip', { bookmarkId: id, reason: 'unsafe-url' });
        return;
      }
    } catch {
      debug('skip', { bookmarkId: id, reason: 'bad-url' });
      return;
    }
    clearPending(id);
    debug('observed', { bookmarkId: id, parentId: node.parentId });
    pending.set(
      id,
      setTimeout(() => {
        pending.delete(id);
        void classify(id).catch(error =>
          debug('error', {
            bookmarkId: id,
            reason: error instanceof Error ? error.message : 'unknown',
          }),
        );
      }, settlingMs),
    );
  };

  const onRemoved = (id: string) => {
    clearPending(id);
    for (const operation of active)
      if (operation.id === id) {
        operation.invalidated = true;
        operation.transport.cancel();
        debug('cancel', { bookmarkId: id, reason: 'removed' });
      }
  };

  async function classify(bookmarkId: string): Promise<NativeClassifyResult> {
    if (disposed) return { status: 'skipped', reason: 'disposed', bookmarkId };
    const release = lifetime.acquire();
    try {
      await ready;
      return await classifyBookmark(bookmarkId);
    } finally {
      release();
    }
  }

  async function classifyBookmark(bookmarkId: string): Promise<NativeClassifyResult> {
    if (disposed) return { status: 'skipped', reason: 'disposed', bookmarkId };
    if (guard.isOwn(bookmarkId)) return { status: 'skipped', reason: 'plugin-created', bookmarkId };

    let tree: TreeSnapshot;
    try {
      tree = await projection.fresh();
    } catch {
      debug('skip', { bookmarkId, reason: 'tree-unavailable' });
      return { status: 'skipped', reason: 'tree-unavailable', bookmarkId };
    }
    const node = tree.nodes.find(n => n.ref.nativeId === bookmarkId && n.ref.kind === 'bookmark');
    if (!node?.url) {
      debug('skip', { bookmarkId, reason: 'missing-bookmark' });
      return { status: 'skipped', reason: 'missing-bookmark', bookmarkId };
    }
    const parent = tree.nodes.find(n => n.ref.nativeId === node.parentId);
    const receipt: SaveReceipt = {
      id: typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${bookmarkId}`,
      bookmarkId,
      title: node.title,
      url: node.url,
      at: Date.now(),
      status: 'classifying',
      fromParentId: node.parentId ?? '',
      fromIndex: Math.max(0, parent?.childrenIds.indexOf(bookmarkId) ?? 0),
      fromPath: folderPath(tree, node.parentId),
    };
    const started = Date.now();
    const finish = async (status: SaveReceipt['status'], extra: Partial<SaveReceipt> = {}): Promise<void> => {
      await record({ ...receipt, ...extra, status, ms: Date.now() - started });
    };

    const route = await resolveSaveRoute(aiServices);
    if (route.status !== 'ok') {
      debug('skip', { bookmarkId, reason: route.reason });
      await finish('skipped', { reason: route.reason });
      setBadge('attention');
      return { status: 'skipped', reason: route.reason, bookmarkId };
    }

    const root = tree.nodes.find(n => n.parentId === undefined && n.ref.kind === 'folder');
    const folderIds = tree.nodes.filter(n => n.childrenWritable).map(n => n.ref.nativeId);
    if (!root || !folderIds.length) {
      await finish('failed', { reason: 'no-writable-folders', model: route.label });
      setBadge('attention');
      return { status: 'failed', reason: root ? 'no-writable-folders' : 'no-root', bookmarkId };
    }

    let privacy: Awaited<ReturnType<SettingsStore['snapshot']>>['privacy'];
    try {
      await settings.load();
      privacy = (await settings.snapshot()).privacy;
    } catch {
      await finish('failed', { reason: 'settings-unavailable', model: route.label });
      setBadge('attention');
      return { status: 'failed', reason: 'settings-unavailable', bookmarkId };
    }

    await record({ ...receipt, model: route.label });
    setBadge('working');
    const authority = saveFeatureAuthority(projection, settings, aiServices);
    const transport = new ModelTransport(
      {
        fetch: fetchFn,
        contains: request => permissionsApi.contains(request),
      },
      authority,
    );
    const operation = { id: bookmarkId, transport, invalidated: false };
    active.add(operation);
    const stopAuthority = authority.subscribe(change => {
      if (change !== 'tree') operation.invalidated = true;
    });
    const request: AiRequest = {
      task: 'save',
      targetId: root.ref.nativeId,
      item: { source: 'bookmark', id: bookmarkId },
      folderIds,
    };
    const originalContext = { config: route.config, privacy };
    const dependencies = dependencyDigest(tree, request);
    const createdFolderIds: string[] = [];
    const createdFolders: { id: string; parentId: string; title: string }[] = [];
    const checkActive = () => {
      if (disposed || operation.invalidated) throw Error('stale-context');
    };
    const checkTree = (current: TreeSnapshot) => {
      if (
        current.installationId !== tree.installationId ||
        dependencyDigest(current, request) !== dependencies ||
        createdFolders.some(
          expected =>
            !current.nodes.some(
              node =>
                node.ref.nativeId === expected.id &&
                node.parentId === expected.parentId &&
                node.title === expected.title &&
                node.childrenWritable,
            ),
        )
      )
        throw Error('stale-context');
    };
    const checkBeforeWrite = () => {
      checkActive();
      const state = projection.state;
      if (state.status !== 'ready') throw Error('stale-context');
      checkTree(state.snapshot);
    };
    const checkApply = async () => {
      checkActive();
      if (!(await permissionsApi.contains({ origins: [parseModelEndpoint(route.config).permission] })))
        throw Error('permission');
      const current = await authority.read();
      if (settingsIdentity(current) !== settingsIdentity(originalContext) || current.key !== route.key)
        throw Error('stale-context');
      checkTree(current.tree);
      checkBeforeWrite();
      return current.tree;
    };
    debug('model-start', { bookmarkId, model: route.config.model, adapter: route.config.adapter });

    try {
      checkActive();
      const response = await transport.run({
        config: route.config,
        key: route.key,
        privacy,
        tree,
        policy: DEFAULT_CLASSIFICATION_POLICY,
        request,
      });

      if (response.status !== 'completed') {
        debug('model-failed', { bookmarkId, reason: response.reason });
        await finish('failed', { reason: response.reason, model: route.label });
        setBadge('attention');
        return { status: 'failed', reason: response.reason, bookmarkId };
      }
      if (!('assignments' in response.output)) {
        await finish('failed', { reason: 'schema', model: route.label });
        setBadge('attention');
        return { status: 'failed', reason: 'schema', bookmarkId };
      }
      const assignment = response.output.assignments.find(a => a.itemId === bookmarkId);
      if (!assignment) {
        await finish('failed', { reason: 'schema', model: route.label });
        setBadge('attention');
        return { status: 'failed', reason: 'no-assignment', bookmarkId };
      }

      // A completed model reply does not authorize later writes after its dependencies change.
      const live = await checkApply();
      if (guard.isOwn(bookmarkId)) return { status: 'skipped', reason: 'plugin-created', bookmarkId };
      if (!live.nodes.some(n => n.ref.nativeId === bookmarkId && n.ref.kind === 'bookmark')) {
        await finish('skipped', { reason: 'missing-bookmark', model: route.label });
        setBadge('clear');
        return { status: 'skipped', reason: 'missing-bookmark', bookmarkId };
      }

      const plan = planNativeSaveApply(live, bookmarkId, assignment.folderId, response.output.newFolders);
      if (plan.status === 'noop') {
        debug('noop', { bookmarkId, reason: plan.reason });
        await finish('kept', {
          reason: 'already-in-destination',
          model: route.label,
          toId: receipt.fromParentId,
          toPath: receipt.fromPath,
        });
        setBadge('done');
        return { status: 'skipped', reason: plan.reason, bookmarkId };
      }
      if (plan.status === 'invalid') {
        debug('invalid-plan', { bookmarkId, reason: plan.reason });
        await finish('failed', { reason: 'schema', model: route.label });
        setBadge('attention');
        return { status: 'failed', reason: plan.reason, bookmarkId };
      }

      let parentId = plan.anchorParentId;
      for (const title of plan.createTitles) {
        await checkApply();
        checkBeforeWrite();
        const created = await writer.create({ parentId, title });
        createdFolderIds.push(created.id);
        createdFolders.push({ id: created.id, parentId, title });
        parentId = created.id;
      }
      const destinationId = plan.createTitles.length ? parentId : plan.destinationFolderId;
      if (live.nodes.find(n => n.ref.nativeId === bookmarkId)?.parentId !== destinationId) {
        await checkApply();
        checkBeforeWrite();
        await writer.move(bookmarkId, { parentId: destinationId, index: 0 });
      }

      const after = await projection.fresh();
      if (!after.nodes.some(n => n.ref.nativeId === bookmarkId && n.parentId === destinationId))
        throw Error('native-write-uncertain');
      await finish('moved', {
        model: route.label,
        toId: destinationId,
        toPath: folderPath(after, destinationId),
        createdFolderIds,
      });
      setBadge('done');
      const result: Extract<NativeClassifyResult, { status: 'completed' }> = {
        status: 'completed',
        bookmarkId,
        destinationId,
        createdFolderIds,
      };
      debug('completed', {
        bookmarkId,
        destinationId,
        createdFolders: createdFolderIds.length,
        ms: Date.now() - started,
      });
      try {
        notify?.(result);
      } catch {
        /* notify is advisory */
      }
      return result;
    } catch (error) {
      const reason =
        error instanceof Error && ['stale-context', 'permission'].includes(error.message)
          ? error.message
          : 'native-write-uncertain';
      await finish('failed', { reason, model: route.label, createdFolderIds });
      setBadge('attention');
      return { status: 'failed', reason, bookmarkId };
    } finally {
      stopAuthority();
      transport.dispose();
      active.delete(operation);
    }
  }

  /**
   * Undo one auto-classify: move the bookmark back to where the browser put it and remove folders
   * this save created when they are empty. Refuses when the bookmark has been moved since.
   */
  async function undo(receiptId: string): Promise<{ status: 'undone' } | { status: 'refused'; reason: string }> {
    const receipt = await receipts?.get(receiptId);
    if (!receipt || receipt.status !== 'moved' || !receipt.toId) return { status: 'refused', reason: 'not-undoable' };
    let tree: TreeSnapshot;
    try {
      tree = await projection.fresh();
    } catch {
      return { status: 'refused', reason: 'tree-unavailable' };
    }
    const node = tree.nodes.find(n => n.ref.nativeId === receipt.bookmarkId);
    if (!node) return { status: 'refused', reason: 'missing-bookmark' };
    if (node.parentId !== receipt.toId) return { status: 'refused', reason: 'moved-since' };
    const origin = tree.nodes.find(n => n.ref.nativeId === receipt.fromParentId && n.childrenWritable);
    if (!origin) return { status: 'refused', reason: 'origin-missing' };
    await writer.move(receipt.bookmarkId, {
      parentId: receipt.fromParentId,
      index: Math.min(receipt.fromIndex, origin.childrenIds.length),
    });
    // Remove created folders deepest first, only if empty now.
    for (const folderId of [...(receipt.createdFolderIds ?? [])].reverse()) {
      const fresh = await projection.fresh().catch(() => undefined);
      const folder = fresh?.nodes.find(n => n.ref.nativeId === folderId);
      if (folder && folder.ref.kind === 'folder' && folder.childrenIds.length === 0) {
        await writer.remove(folderId).catch(() => {});
      }
    }
    await receipts?.patch(receipt.id, { status: 'undone' });
    debug('undo', { bookmarkId: receipt.bookmarkId });
    return { status: 'undone' };
  }

  bookmarksApi.onCreated.addListener(onCreated);
  bookmarksApi.onRemoved.addListener(onRemoved);
  const onImportBegan = () => {
    importing = true;
    debug('import-began', {});
  };
  const onImportEnded = () => {
    importing = false;
    debug('import-ended', {});
  };
  bookmarksApi.onImportBegan.addListener(onImportBegan);
  bookmarksApi.onImportEnded.addListener(onImportEnded);

  debug('ingress-started', { settlingMs });

  return {
    /** Test/debug: run classify for an id without waiting for settling. */
    classify,
    undo,
    dispose() {
      disposed = true;
      lifetime.dispose();
      for (const id of [...pending.keys()]) clearPending(id);
      for (const operation of active) {
        operation.invalidated = true;
        operation.transport.cancel();
      }
      active.clear();
      bookmarksApi.onCreated.removeListener(onCreated);
      bookmarksApi.onRemoved.removeListener(onRemoved);
      bookmarksApi.onImportBegan.removeListener(onImportBegan);
      bookmarksApi.onImportEnded.removeListener(onImportEnded);
      debug('ingress-stopped', {});
    },
  };
}

let badgeTimer: ReturnType<typeof setTimeout> | undefined;

/** Toolbar badge: … while classifying, ✓ on success, ! when AI did not run or failed. */
export function nativeSaveBadge(state: BadgeState) {
  const action = typeof chrome !== 'undefined' ? chrome.action : undefined;
  if (!action?.setBadgeText) return;
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = undefined;
  const styles: Record<Exclude<BadgeState, 'clear'>, { text: string; color: string }> = {
    working: { text: '…', color: '#6366F1' },
    done: { text: '✓', color: '#16A34A' },
    attention: { text: '!', color: '#D97706' },
  };
  if (state === 'clear') {
    void Promise.resolve(action.setBadgeText({ text: '' })).catch(() => {});
    return;
  }
  const style = styles[state];
  void Promise.resolve(action.setBadgeText({ text: style.text })).catch(() => {});
  if (action.setBadgeBackgroundColor)
    void Promise.resolve(action.setBadgeBackgroundColor({ color: style.color })).catch(() => {});
  if (state !== 'working') {
    badgeTimer = setTimeout(
      () => {
        void Promise.resolve(action.setBadgeText({ text: '' })).catch(() => {});
      },
      state === 'attention' ? 8000 : 3000,
    );
  }
}
