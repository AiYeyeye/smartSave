import { ModelTransport } from '../adapters/model-transport';
import type { ModelSettingsReader } from '../adapters/feature-model-settings';
import type { SaveReceiptLog } from '../persistence/save-receipts';
import type { TreeProjection } from './tree-projection';
import { organizeModelAuthority } from './organize-model-authority';
import { createWorkerTaskLifetime } from './worker-task-lifetime';
import { serializeAiPayload } from '../domain/ai-payload';

/** Local folder rules still finish immediately; name advice is a separate read-only background request. */
export function saveNameSuggestions(
  projection: TreeProjection,
  settings: ModelSettingsReader,
  receipts: SaveReceiptLog,
) {
  const lifetime = createWorkerTaskLifetime();
  return async (receiptId: string) => {
    const release = lifetime.acquire();
    const authority = organizeModelAuthority(projection, settings);
    const model = new ModelTransport(
      { fetch: (...args) => fetch(...args), contains: value => chrome.permissions.contains(value) },
      authority,
    );
    try {
      const receipt = await receipts.get(receiptId);
      if (!receipt || receipt.nameReview || receipt.suggestedTitle) return;
      const context = await authority.read();
      if (!context.config) return;
      const node = context.tree.nodes.find(node => node.ref.nativeId === receipt.bookmarkId);
      if (
        !node ||
        node.title !== receipt.title ||
        node.url !== receipt.url ||
        context.tree.installationId !== receipt.installationId
      )
        return;
      const request = { task: 'rename' as const, itemIds: [receipt.bookmarkId], folderIds: [] };
      const payload: { items: unknown[] } = JSON.parse(serializeAiPayload(context.tree, context.privacy, request));
      if (!payload.items.length) return;
      await receipts.patch(receiptId, { nameStatus: 'pending' });
      const response = await model.run({ ...context, config: context.config, request });
      if (response.status !== 'completed' || !('suggestions' in response.output)) throw Error('name-unavailable');
      const advice = response.output.suggestions[0];
      const current = await projection.fresh();
      const present = current.nodes.find(item => item.ref.nativeId === receipt.bookmarkId);
      const latest = await receipts.get(receiptId);
      if (!present || present.title !== node.title || present.url !== node.url || latest?.nameReview)
        throw Error('stale-context');
      await receipts.patch(receiptId, {
        nameStatus:
          advice?.decision === 'uncertain' ? 'uncertain' : advice?.decision === 'rename' ? 'ready' : 'unchanged',
        ...(advice?.decision === 'rename' && advice.title !== node.title ? { suggestedTitle: advice.title } : {}),
      });
    } catch {
      await receipts.patch(receiptId, { nameStatus: 'failed' }).catch(() => {});
    } finally {
      model.dispose();
      release();
    }
  };
}
