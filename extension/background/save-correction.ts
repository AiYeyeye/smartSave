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
    if (!sender.documentId) throw Error('session-expired');
    const owner = JSON.stringify([sender.id, sender.documentId, sender.frameId, sender.tab?.id]);
    for (const [token, session] of this.sessions) if (session.expires < Date.now()) this.sessions.delete(token);
    if (message.action === 'begin') {
      if (this.sessions.size >= 32) throw Error('session-limit');
      return this.receipts.withAction(message.receiptId, async () => {
        let receipt = await this.receipts.get(message.receiptId);
        if (!receipt || receipt.status === 'classifying') throw Error('stale-correction');
        if ((await this.receipts.latestForBookmark(receipt.bookmarkId))?.id !== receipt.id)
          throw Error('stale-correction');
        if (!receipt.installationId) throw Error('legacy-receipt');
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
        return { status: 'ready', token, bookmarkId: receipt.bookmarkId, tree };
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
        const request = prepareMutation(session.tree, {
          type: 'move',
          target: source.ref,
          parent: target.ref,
          index: target.childrenIds.length,
        });
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
