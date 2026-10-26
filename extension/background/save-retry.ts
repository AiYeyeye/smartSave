import { ModelTransport } from '../adapters/model-transport';
import { DEFAULT_CLASSIFICATION_POLICY } from '../domain/classification-policy';
import { localClassification } from '../domain/local-classification';
import { extensionDocumentKind } from '../domain/trusted-sender';
import { canRetrySave, saveRetryMessageSchema, type SaveRetryMessage } from '../domain/save-retry';
import type { TreeSnapshot } from '../domain/node-reference';
import type { AiServicesStore } from '../persistence/ai-services';
import type { SaveReceipt, SaveReceiptLog } from '../persistence/save-receipts';
import type { SettingsStore } from '../persistence/settings';
import type { TreeProjection } from './tree-projection';
import { resolveSaveRoute, saveFeatureAuthority } from './native-bookmark-ingress';
import { createWorkerTaskLifetime } from './worker-task-lifetime';
import { dependencyDigest, settingsIdentity } from '../domain/context-dependencies';

type Options = {
  projection: TreeProjection;
  settings: SettingsStore;
  aiServices: AiServicesStore;
  receipts: SaveReceiptLog;
  fetch?: typeof fetch;
  contains?: (request: { origins?: string[]; permissions?: string[] }) => Promise<boolean>;
};

/** Explicit model retries only save advice. Native writes remain in SaveCorrectionOwner. */
export class SaveRetryOwner {
  private lifetime = createWorkerTaskLifetime();
  private active = new Map<string, ModelTransport>();
  constructor(private readonly options: Options) {}

  private source(receipt: SaveReceipt, tree: TreeSnapshot) {
    const node = tree.nodes.find(node => node.ref.nativeId === receipt.bookmarkId && node.ref.kind === 'bookmark');
    if (
      !node ||
      node.readOnly ||
      tree.installationId !== receipt.installationId ||
      node.url !== receipt.url ||
      node.title !== receipt.title ||
      node.parentId !== receipt.fromParentId
    )
      throw Error('stale-context');
    return node;
  }

  async start(message: SaveRetryMessage) {
    const { receipts, projection } = this.options;
    return receipts.withAction(message.receiptId, async () => {
      const receipt = await receipts.get(message.receiptId);
      if (
        !receipt ||
        !canRetrySave(receipt) ||
        (await receipts.latestForBookmark(receipt.bookmarkId))?.id !== receipt.id
      )
        throw Error('retry-unavailable');
      if (receipt.aiRetry?.id === message.requestId || receipt.aiRetry?.status === 'pending') return;
      this.source(receipt, await projection.fresh());
      const checkpoint = await receipts.patch(receipt.id, { aiRetry: { id: message.requestId, status: 'pending' } });
      if (checkpoint?.aiRetry?.id !== message.requestId || checkpoint.aiRetry.status !== 'pending')
        throw Error('retry-unavailable');
      // A durable pending marker precedes the request; a worker restart marks it failed, never replays it.
      void this.run(receipt, message.requestId);
    });
  }

  private async run(receipt: SaveReceipt, requestId: string) {
    const startedAt = Date.now();
    const { receipts, projection, settings, aiServices } = this.options;
    const release = this.lifetime.acquire();
    const authority = saveFeatureAuthority(projection, settings, aiServices);
    const model = new ModelTransport(
      {
        fetch: this.options.fetch ?? ((...args) => fetch(...args)),
        contains: this.options.contains ?? (value => chrome.permissions.contains(value)),
      },
      authority,
    );
    this.active.set(receipt.id, model);
    try {
      const route = await resolveSaveRoute(aiServices);
      if (route.status !== 'ok') throw Error(route.reason);
      const context = await authority.read();
      if (!context.config) throw Error('save-feature-unconfigured');
      if (JSON.stringify(route.config) !== JSON.stringify(context.config) || route.key !== context.key)
        throw Error('stale-context');
      const node = this.source(receipt, context.tree);
      const local = localClassification(context.tree, receipt.bookmarkId, context.privacy, []);
      if (!local.sourceAllowed) throw Error('excluded');
      const root = context.tree.nodes.find(node => node.parentId === undefined && node.ref.kind === 'folder');
      if (!root) throw Error('tree-unavailable');
      const request = {
        task: 'save' as const,
        targetId: root.ref.nativeId,
        item: { source: 'bookmark' as const, id: receipt.bookmarkId },
        folderIds: local.folderIds,
      };
      const response = await model.run({
        ...context,
        config: context.config,
        policy: {
          ...DEFAULT_CLASSIFICATION_POLICY,
          existingFoldersOnly: true,
        },
        request,
      });
      if (response.status !== 'completed') throw Error(response.reason);
      if (!('assignments' in response.output) || response.output.newFolders.length) throw Error('schema');
      const advice = response.output.assignments.find(item => item.itemId === receipt.bookmarkId);
      if (!advice || !local.folderIds.includes(advice.folderId)) throw Error('schema');
      const suggestedTitle = 'suggestedTitle' in advice ? advice.suggestedTitle : undefined;
      await receipts.withAction(receipt.id, async () => {
        const latest = await receipts.get(receipt.id);
        if (
          !latest ||
          !canRetrySave(latest) ||
          latest.aiRetry?.id !== requestId ||
          (await receipts.latestForBookmark(receipt.bookmarkId))?.id !== receipt.id
        )
          throw Error('stale-context');
        const current = await authority.read();
        this.source(receipt, current.tree);
        if (
          settingsIdentity(current) !== settingsIdentity(context) ||
          current.key !== context.key ||
          dependencyDigest(current.tree, request) !== dependencyDigest(context.tree, request)
        )
          throw Error('stale-context');
        if (!current.tree.nodes.some(folder => folder.ref.nativeId === advice.folderId && folder.childrenWritable))
          throw Error('stale-context');
        await receipts.patch(receipt.id, {
          suggestedTitle: suggestedTitle ?? node.title,
          suggestedFolderId: advice.folderId,
          nameStatus: suggestedTitle && suggestedTitle !== node.title ? 'ready' : 'unchanged',
          model: route.label,
          ms: Date.now() - startedAt,
          timing: undefined,
          aiRetry: { id: requestId, status: 'ready' },
        });
      });
    } catch (error) {
      await receipts
        .withAction(receipt.id, async () => {
          const latest = await receipts.get(receipt.id);
          if (latest?.aiRetry?.id === requestId)
            await receipts.patch(receipt.id, {
              aiRetry: {
                id: requestId,
                status: 'failed',
                reason: error instanceof Error ? error.message : 'provider-error',
              },
            });
        })
        .catch(() => {});
    } finally {
      this.active.delete(receipt.id);
      model.dispose();
      release();
    }
  }

  dispose() {
    for (const model of this.active.values()) model.dispose();
  }
}

export function startSaveRetryService(owner: SaveRetryOwner) {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'nativeSaveRetry') return false;
    const message = saveRetryMessageSchema.safeParse(raw);
    if (!message.success || extensionDocumentKind(sender, chrome.runtime.id) !== 'save') {
      reply({ status: 'error', reason: 'retry-unavailable' });
      return false;
    }
    void owner.start(message.data).then(
      () => reply({ status: 'started' }),
      () => reply({ status: 'error', reason: 'retry-unavailable' }),
    );
    return true;
  });
}
