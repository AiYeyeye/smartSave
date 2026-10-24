import type { NodeRef, TreeSnapshot } from '../domain/node-reference';
import { prepareMutation } from '../domain/prepare-mutation';
import { preflight } from '../domain/preflight';
import { siteHost, type SiteRule } from '../domain/site-rules';
import { correctionMessageSchema, type CorrectionMessage, type CorrectionResponse } from '../domain/save-correction';
import { withTrustedSender } from '../domain/trusted-sender';
import type { SiteRulesStore } from '../persistence/site-rules';
import type { SaveReceipt, SaveReceiptLog } from '../persistence/save-receipts';
import type { MutationCoordinator } from './mutation-coordinator';
import type { TreeProjection } from './tree-projection';
import { mutationResultSchema } from '../schemas/messages';
import { withCorrectionLearning } from '../domain/correction-learning';

type Session = {
  owner: string;
  sender: chrome.runtime.MessageSender;
  expires: number;
  receipt: SaveReceipt;
  tree: TreeSnapshot;
  used: boolean;
  requestId?: string;
  target?: NodeRef;
  previousRule?: SiteRule | null;
  response?: CorrectionResponse;
  reviewInput?: { title: string; targetId: string };
};

/** Purpose-bound readback/consent owner. All native moves remain in MutationCoordinator. */
export class SaveCorrectionOwner {
  private sessions = new Map<string, Session>();
  constructor(
    private projection: Pick<TreeProjection, 'fresh' | 'state'>,
    private coordinator: Pick<MutationCoordinator, 'registerPreview' | 'submit'>,
    private receipts: SaveReceiptLog,
    private rules: SiteRulesStore,
  ) {}

  private node(session: Session, tree: TreeSnapshot, moved = false) {
    const node = tree.nodes.find(
      entry => entry.ref.nativeId === session.receipt.bookmarkId && entry.ref.kind === 'bookmark',
    );
    const original = session.tree.nodes.find(entry => entry.ref.nativeId === session.receipt.bookmarkId);
    if (
      tree.installationId !== session.tree.installationId ||
      !node ||
      node.url !== session.receipt.url ||
      node.readOnly ||
      node.parentId !== (moved ? session.target?.nativeId : original?.parentId)
    )
      throw Error('stale-correction');
    if (
      moved &&
      !tree.nodes.some(
        entry =>
          entry.ref.nativeId === session.target?.nativeId &&
          entry.ref.kind === 'folder' &&
          entry.childrenWritable &&
          entry.title === session.tree.nodes.find(node => node.ref.nativeId === session.target?.nativeId)?.title &&
          entry.parentId === session.tree.nodes.find(node => node.ref.nativeId === session.target?.nativeId)?.parentId,
      )
    )
      throw Error('stale-correction');
    return node;
  }

  private async readback(session: Session) {
    const receipt = await this.receipts.get(session.receipt.id);
    if ((await this.receipts.latestForBookmark(session.receipt.bookmarkId))?.id !== session.receipt.id)
      throw Error('stale-correction');
    if (!session.requestId || receipt?.correction?.requestId !== session.requestId) throw Error('stale-correction');
    const result = mutationResultSchema.parse(
      await this.coordinator.submit(
        { version: 1, type: 'mutationStatus', requestId: session.requestId },
        session.sender,
      ),
    );
    if (result.requestId !== session.requestId || result.status !== 'completed' || result.needsReconcile)
      throw Error('correction-unsettled');
    const tree = await this.projection.fresh();
    this.node(session, tree, true);
    return tree;
  }

  async handle(message: CorrectionMessage, sender: chrome.runtime.MessageSender): Promise<CorrectionResponse> {
    // Chrome gives the toolbar popup no tab, frame or document id; it is the one trusted tab-less save document.
    const popup =
      !sender.documentId &&
      sender.tab === undefined &&
      /^chrome-extension:\/\/[^/]+\/save\/index\.html$/.test(sender.url ?? '');
    if (!sender.documentId && !popup) throw Error('session-expired');
    const owner = JSON.stringify([sender.id, sender.documentId ?? sender.url, sender.frameId, sender.tab?.id]);
    for (const [token, session] of this.sessions) if (session.expires < Date.now()) this.sessions.delete(token);
    if (message.action === 'begin') {
      if (this.sessions.size >= 32) throw Error('session-limit');
      return this.receipts.withAction(message.receiptId, async () => {
        let receipt = await this.receipts.get(message.receiptId);
        if (!receipt || receipt.status === 'classifying') throw Error('stale-correction');
        if ((await this.receipts.latestForBookmark(receipt.bookmarkId))?.id !== receipt.id)
          throw Error('stale-correction');
        if (!receipt.installationId) throw Error('legacy-receipt');
        if (receipt.reviewRequestId && !receipt.reviewedAt) {
          const result = mutationResultSchema.parse(
            await this.coordinator.submit(
              { version: 1, type: 'reconcileMutation', requestId: receipt.reviewRequestId },
              sender,
            ),
          );
          if (result.requestId !== receipt.reviewRequestId) throw Error('correction-unsettled');
          if (result.status === 'completed' && !result.needsReconcile) {
            receipt = await this.receipts.patch(receipt.id, {
              reviewedAt: Date.now(),
              ...(receipt.nameRequestId === receipt.reviewRequestId ? { nameReview: 'applied' as const } : {}),
              ...(receipt.correction?.requestId === receipt.reviewRequestId
                ? { correction: { ...receipt.correction, status: 'completed' as const } }
                : {}),
            });
          } else if (result.status === 'rejected' && result.reason === 'request-not-found') {
            receipt = await this.receipts.patch(receipt.id, { reviewRequestId: undefined });
          } else throw Error('correction-unsettled');
          if (!receipt) throw Error('stale-correction');
        }
        if (receipt.nameRequestId && !receipt.nameReview) {
          const result = mutationResultSchema.parse(
            await this.coordinator.submit(
              {
                version: 1,
                type: 'reconcileMutation',
                requestId: receipt.nameRequestId,
              },
              sender,
            ),
          );
          if (result.status === 'completed' && !result.needsReconcile) {
            receipt = await this.receipts.patch(receipt.id, { nameReview: 'applied' });
          } else if (result.status === 'rejected' && result.reason === 'request-not-found') {
            receipt = await this.receipts.patch(receipt.id, { nameRequestId: undefined });
          } else throw Error('correction-unsettled');
          if (!receipt) throw Error('stale-correction');
        }
        if (receipt.correction?.status === 'pending') {
          const result = mutationResultSchema.parse(
            await this.coordinator.submit(
              { version: 1, type: 'reconcileMutation', requestId: receipt.correction.requestId },
              sender,
            ),
          );
          if (result.requestId !== receipt.correction.requestId) throw Error('correction-unsettled');
          const status =
            result.status === 'completed'
              ? 'completed'
              : result.status === 'rejected' && result.reason === 'request-not-found'
                ? 'rejected'
                : undefined;
          if (!status) throw Error('correction-unsettled');
          receipt = await this.receipts.patch(receipt.id, { correction: { ...receipt.correction, status } });
          if (!receipt) throw Error('stale-correction');
        }
        const tree = await this.projection.fresh();
        if (receipt.installationId !== tree.installationId) throw Error('stale-correction');
        const session: Session = {
          owner,
          sender: structuredClone(sender),
          expires: Date.now() + 600_000,
          receipt: structuredClone(receipt),
          tree,
          used: false,
        };
        this.node(session, tree);
        const token = crypto.randomUUID();
        this.sessions.set(token, session);
        const current = this.node(session, tree);
        return {
          status: 'ready',
          token,
          bookmarkId: receipt.bookmarkId,
          tree,
          ...(!receipt.nameReview && current.title === receipt.title && receipt.suggestedTitle
            ? { suggestedTitle: receipt.suggestedTitle }
            : {}),
        };
      });
    }
    const session = this.sessions.get(message.token);
    if (!session || session.owner !== owner) throw Error('session-expired');
    if (message.action === 'close') {
      this.sessions.delete(message.token);
      return { status: 'closed' };
    }
    return this.receipts.withAction(session.receipt.id, async () => {
      if (this.sessions.get(message.token) !== session) throw Error('session-expired');
      if (message.action === 'review') {
        const input = { title: message.title, targetId: message.targetId };
        if (session.used) {
          if (JSON.stringify(input) !== JSON.stringify(session.reviewInput)) throw Error('stale-correction');
          return session.response ?? { status: 'error', reason: 'correction-unsettled' };
        }
        const receipt = await this.receipts.get(session.receipt.id);
        if (
          !receipt ||
          (await this.receipts.latestForBookmark(receipt.bookmarkId))?.id !== receipt.id ||
          receipt.reviewedAt !== session.receipt.reviewedAt ||
          receipt.nameRequestId !== session.receipt.nameRequestId ||
          JSON.stringify(receipt.correction) !== JSON.stringify(session.receipt.correction)
        )
          throw Error('stale-correction');
        const source = this.node(session, session.tree);
        const current = this.node(session, await this.projection.fresh());
        if (current.title !== source.title) throw Error('stale-correction');
        const target = session.tree.nodes.find(
          node => node.ref.nativeId === message.targetId && node.ref.kind === 'folder' && node.childrenWritable,
        );
        if (!target) throw Error('stale-correction');
        const renamed = message.title !== source.title;
        const moved = target.ref.nativeId !== source.parentId;
        if (renamed && (!message.title.trim() || message.title !== message.title.trim() || message.title.length > 200))
          throw Error('stale-correction');
        session.reviewInput = input;
        if (!renamed && !moved) {
          session.used = true;
          await this.receipts.patch(receipt.id, { reviewedAt: Date.now(), nameReview: 'kept' });
          return (session.response = { status: 'closed' });
        }
        const move = {
          type: 'move' as const,
          target: source.ref,
          parent: target.ref,
          index: target.childrenIds.length,
        };
        const rename = { type: 'update' as const, target: source.ref, changes: { title: message.title } };
        let request = prepareMutation(session.tree, moved ? move : rename);
        if (renamed && moved)
          request = {
            ...request,
            command: {
              type: 'batch',
              operations: [
                { id: 'name', dependsOn: [], command: rename },
                { id: 'folder', dependsOn: ['name'], command: move },
              ],
              selectedOperationIds: ['name', 'folder'],
            },
          };
        request = withCorrectionLearning(request, [
          {
            id: source.ref.nativeId,
            title:
              renamed && !session.receipt.nameReview && source.title === session.receipt.title
                ? (session.receipt.suggestedTitle ?? source.title)
                : source.title,
            parentId: source.parentId,
          },
        ]);
        preflight(request, await this.projection.fresh());
        session.used = true;
        const correction = moved
          ? { requestId: request.requestId, target: target.ref, status: 'pending' as const }
          : undefined;
        await this.receipts.patch(receipt.id, {
          reviewRequestId: request.requestId,
          reviewedAt: undefined,
          ...(renamed ? { nameRequestId: request.requestId, nameReview: undefined } : {}),
          ...(correction ? { correction } : {}),
        });
        const proposal = this.coordinator.registerPreview(request, sender);
        const result = mutationResultSchema.parse(await this.coordinator.submit(proposal, sender));
        if (result.requestId !== request.requestId) throw Error('correction-unsettled');
        session.response = { status: 'result', result };
        if (result.status === 'completed' && !result.needsReconcile) {
          await this.receipts.patch(receipt.id, {
            reviewedAt: Date.now(),
            nameReview: renamed ? 'applied' : 'kept',
            ...(correction ? { correction: { ...correction, status: 'completed' } } : {}),
          });
        } else if (result.status === 'rejected' && !result.needsReconcile) {
          await this.receipts.patch(receipt.id, {
            reviewRequestId: undefined,
            ...(renamed ? { nameRequestId: undefined } : {}),
            ...(correction ? { correction: { ...correction, status: 'rejected' } } : {}),
          });
        }
        return session.response;
      }
      if (message.action === 'rename' || message.action === 'keep-name') {
        if (session.used) return session.response ?? { status: 'error', reason: 'correction-unsettled' };
        const receipt = await this.receipts.get(session.receipt.id);
        const source = this.node(session, session.tree);
        if (
          !receipt ||
          receipt.nameRequestId !== session.receipt.nameRequestId ||
          receipt.nameReview !== session.receipt.nameReview
        )
          throw Error('stale-correction');
        if (message.action === 'keep-name' || message.title === source.title) {
          await this.receipts.patch(receipt.id, { nameReview: 'kept' });
          session.used = true;
          return (session.response = { status: 'closed' });
        }
        const baseline =
          !session.receipt.nameReview && source.title === session.receipt.title
            ? (session.receipt.suggestedTitle ?? source.title)
            : source.title;
        const request = withCorrectionLearning(
          prepareMutation(session.tree, {
            type: 'update',
            target: source.ref,
            changes: { title: message.title },
          }),
          [{ id: source.ref.nativeId, title: baseline, parentId: source.parentId }],
        );
        preflight(request, await this.projection.fresh());
        if (receipt.nameRequestId && !receipt.nameReview) throw Error('correction-unsettled');
        session.used = true;
        await this.receipts.patch(receipt.id, { nameRequestId: request.requestId, nameReview: undefined });
        const proposal = this.coordinator.registerPreview(request, sender);
        const result = mutationResultSchema.parse(await this.coordinator.submit(proposal, sender));
        session.response = { status: 'result', result };
        if (result.status === 'completed') await this.receipts.patch(receipt.id, { nameReview: 'applied' });
        else if (result.status === 'rejected' && !result.needsReconcile)
          await this.receipts.patch(receipt.id, { nameRequestId: undefined });
        return session.response;
      }
      if (message.action === 'move') {
        if (session.used) {
          if (session.target?.nativeId !== message.targetId) throw Error('stale-correction');
          if (session.response) return session.response;
          throw Error('correction-unsettled');
        }
        const receipt = await this.receipts.get(session.receipt.id);
        if ((await this.receipts.latestForBookmark(session.receipt.bookmarkId))?.id !== session.receipt.id)
          throw Error('stale-correction');
        if (
          !receipt ||
          receipt.status !== session.receipt.status ||
          JSON.stringify(receipt.correction) !== JSON.stringify(session.receipt.correction)
        )
          throw Error('stale-correction');
        const source = this.node(session, session.tree);
        const target = session.tree.nodes.find(
          node => node.ref.nativeId === message.targetId && node.ref.kind === 'folder' && node.childrenWritable,
        );
        if (!target) throw Error('stale-correction');
        if (source.parentId === target.ref.nativeId) throw Error('same-folder');
        const request = withCorrectionLearning(
          prepareMutation(session.tree, {
            type: 'move',
            target: source.ref,
            parent: target.ref,
            index: target.childrenIds.length,
          }),
        );
        preflight(request, await this.projection.fresh());
        session.used = true;
        session.requestId = request.requestId;
        session.target = target.ref;
        // Durably retire the historical automatic undo before any correction may be issued.
        if (
          !(await this.receipts.patch(receipt.id, {
            correction: { requestId: request.requestId, target: target.ref, status: 'pending' },
          }))
        )
          throw Error('stale-correction');
        const proposal = this.coordinator.registerPreview(request, sender);
        const result = mutationResultSchema.parse(await this.coordinator.submit(proposal, sender));
        if (result.requestId !== request.requestId) throw Error('correction-unsettled');
        session.response = { status: 'result', result };
        if (result.status !== 'completed') {
          if (result.status === 'rejected' && !result.needsReconcile)
            await this.receipts.patch(receipt.id, {
              correction: { requestId: request.requestId, target: target.ref, status: 'rejected' },
            });
          return session.response;
        }
        const tree = await this.readback(session);
        await this.receipts.patch(receipt.id, {
          correction: { requestId: request.requestId, target: target.ref, status: 'completed' },
        });
        const host = siteHost(receipt.url);
        session.previousRule = (await this.rules.load()).find(rule => rule.host === host) ?? null;
        session.response = {
          status: 'moved',
          requestId: request.requestId,
          host,
          target: target.ref,
          targetTitle: tree.nodes.find(node => node.ref.nativeId === target.ref.nativeId)!.title,
          previousRule: session.previousRule,
        };
        return session.response;
      }
      if (session.response?.status !== 'moved' || !session.target || session.previousRule === undefined)
        throw Error('stale-correction');
      const rule = {
        host: session.response.host,
        folder: session.target,
        includeSubdomains: message.includeSubdomains,
      };
      await this.rules.setIfUnchanged(rule, session.previousRule, async () => {
        await this.readback(session);
        if (this.sessions.get(message.token) !== session || this.projection.state.status !== 'ready')
          throw Error('stale-correction');
        this.node(session, this.projection.state.snapshot, true);
      });
      this.sessions.delete(message.token);
      return { status: 'rule-saved' };
    });
  }
}

export function startSaveCorrectionService(owner: SaveCorrectionOwner) {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw) || raw.type !== 'nativeSaveCorrection') return false;
    withTrustedSender(
      sender,
      chrome.runtime.id,
      () => {
        const parsed = correctionMessageSchema.safeParse(raw);
        if (!parsed.success) {
          reply({ status: 'error', reason: 'invalid-message' });
          return;
        }
        void owner
          .handle(parsed.data, sender)
          .then(reply)
          .catch(error =>
            reply({
              status: 'error',
              reason:
                error instanceof Error &&
                [
                  'legacy-receipt',
                  'same-folder',
                  'rule-changed',
                  'stale-correction',
                  'session-expired',
                  'correction-unsettled',
                ].includes(error.message)
                  ? error.message
                  : 'correction-unavailable',
            }),
          );
      },
      () => reply({ status: 'error', reason: 'invalid-sender' }),
    );
    return true;
  });
}
