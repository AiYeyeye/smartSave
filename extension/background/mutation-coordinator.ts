import type { ImportAuthority } from './import-authority';
import type { ImportPreviewSelection } from '../domain/import-preview';
import type { OrganizerAuthority } from './organizer-authority';
import { recoveryMessageSchema, type RecoveryResponse } from '../schemas/recovery';
import { prepareRecovery } from '../domain/undo';
import { prepareRecoveryCopy } from '../domain/recovery-copy';
import type { ConfirmMutation } from '../schemas/messages';
import type { BookmarkWriter } from '../adapters/bookmarks-write';
import { preflight, type Step } from '../domain/preflight';
import type { TreeSnapshot } from '../domain/node-reference';
import { confirmSchema, durableMutationRequestSchema, mutationMessageSchema, trustedMutationSender, type MutationResult } from '../schemas/messages';
import { operationRecord, operationResult, type OperationJournal, type OperationRecord } from '../persistence/operations';
import { sameTree, expectedAfter } from '../domain/mutation-effect';
import type { TreeProjection } from './tree-projection';


export class MutationCoordinator {
  private registeredRequestIds = new Set<string>();
  private previews = new Map<string, ConfirmMutation>();
  purgeSavePreviews() { for (const [id, request] of this.previews) if (request.saveContext && !this.validateSaveContext(request)) this.previews.delete(id); }
  registerPreview(raw: unknown, sender: { id?: string; url?: string; tab?: unknown }): ConfirmMutation {
    return this.register(raw, sender, false);
  }
  private register(raw: unknown, sender: { id?: string; url?: string; tab?: unknown }, organizerValidated: boolean): ConfirmMutation {
    if (!trustedMutationSender(sender, this.extensionId)) throw Error('invalid-sender');
    const request = confirmSchema.parse(raw);
    if (((request.organizerContext || request.importContext || request.importBinding) && !organizerValidated) || this.previews.has(request.requestId) || request.previewId || !this.validateSaveContext(request)) throw Error('invalid-preview');
    const registered = confirmSchema.parse({ ...request, previewId: crypto.randomUUID() });
    this.registeredRequestIds.add(request.requestId);
    this.previews.clear(); // One outstanding registered proposal per writer; superseded proposals are not authority.
    this.previews.set(request.requestId, registered);
    return structuredClone(registered);
  }
  async registerOrganizerPreview(raw: unknown, sender: { id?: string; url?: string; tab?: unknown }) {
    const request = confirmSchema.parse(raw);
    if (!request.organizerContext || request.saveContext || !trustedMutationSender(sender, this.extensionId) || !await this.organizerAuthority?.validate(request, sender)) throw Error('invalid-organizer-authority');
    preflight(request, await this.projection.fresh());
    if (!this.organizerAuthority?.current(request)) throw Error('stale-organizer-authority');
    return this.register(request, sender, true);
  }
  async registerImportPreview(token: string, id: string, revision: number, selection: ImportPreviewSelection, sender: { id?: string; url?: string; tab?: unknown }) {
    if (!this.importAuthority?.sharesPersistence(this.journal)) throw Error('import-persistence-owner-mismatch');
    const request = await this.importAuthority?.prepare(token, id, revision, selection, sender);
    if (!this.importAuthority) throw Error('import-authority-unavailable');
    if (!request) return undefined;
    preflight(request, await this.projection.fresh());
    if (!await this.importAuthority.validate(request, sender) || !this.importAuthority.current(request)) throw Error('stale-import-authority');
    return this.register(request, sender, true);
  }
  private queue: Promise<unknown> = Promise.resolve();
  private blocked = false;
  private recoveryPreviews = new Map<string, ConfirmMutation>();
  private cancellations = new Set<string>();
  // Retain ambiguous state even when its final journal write fails in this worker.
  private volatile = new Map<string, { result: MutationResult; semantics: string }>();
  private requestSemantics(request: OperationRecord['request']): string {
    const { installationId, scope, command, recovery, importBinding } = durableMutationRequestSchema.parse(request);
    // Cleanup clears before; epochs/revisions are preview freshness, not retry identity.
    return JSON.stringify({ installationId, scope, command, recovery, importBinding });
  }
  private cacheResult(record: OperationRecord, result: MutationResult) {
    this.volatile.set(record.requestId, { result, semantics: this.requestSemantics(record.request) });
  }
  constructor(private projection: Pick<TreeProjection, 'fresh'> & Partial<Pick<TreeProjection, 'invalidatePreviews'>>, private writer: BookmarkWriter, private journal: OperationJournal, private extensionId: string, private validateSaveContext: (request: ConfirmMutation) => boolean = request => !request.saveContext && !request.requestId.startsWith('save:'), private organizerAuthority?: OrganizerAuthority, private importAuthority?: ImportAuthority) {}
  submit(raw: unknown, sender: { id?: string; url?: string; tab?: unknown }): Promise<MutationResult> {
    const parsed = mutationMessageSchema.safeParse(raw);
    if (!trustedMutationSender(sender, this.extensionId) || !parsed.success) return Promise.resolve({ requestId: '', status: 'rejected', needsReconcile: false, completedSteps: 0, remainingSteps: 0, reason: 'invalid-message-or-sender' });
    const message = parsed.data;
    // Cancellation is a stop signal, not a second writer or queue bypass for native calls.
    if (message.type === 'cancelMutation') this.cancellations.add(message.requestId);
    const task = this.queue.then(() => this.run(message, sender));
    this.queue = task.catch(() => {});
    return task;
  }
  recovery(raw: unknown, sender: { id?: string; url?: string; tab?: unknown }): Promise<RecoveryResponse> {
    const parsed = recoveryMessageSchema.safeParse(raw);
    if (!parsed.success || !trustedMutationSender(sender, this.extensionId)) return Promise.resolve({ status: 'error', requestId: '', reason: 'invalid-message-or-sender' });
    const message = parsed.data;
    const task = this.queue.then(async (): Promise<RecoveryResponse> => {
      try {
        if (message.type === 'recoveryDiscard') { this.recoveryPreviews.delete(message.proposalRequestId); this.previews.delete(message.proposalRequestId); return { status: 'cleaned', requestId: message.requestId }; }
        const records = await this.journal.all();
        if (message.type === 'recoveryList') {
          const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
          return { status: 'ready', requestId: message.requestId, records, destinations: (await this.projection.fresh()).nodes.filter(n => n.childrenWritable), usage: estimate?.usage, quota: estimate?.quota };
        }
        const record = records.find(r => r.requestId === message.sourceRequestId);
        if (!record) throw Error('source-not-found');
        if (message.type === 'recoveryCleanup') {
          if (!this.journal.cleanup) throw Error('cleanup-unavailable');
          await this.journal.cleanup(record.requestId);
          this.recoveryPreviews.clear();
          return { status: 'cleaned', requestId: message.requestId };
        }
        const tree = await this.projection.fresh();
        const preview = message.mode === 'copy'
          ? prepareRecoveryCopy(record, tree, message.destination!, message.selectedNativeIds ?? [])
          : prepareRecovery(record, tree, message.mode, records);
        let proposal: ConfirmMutation | undefined;
        if (preview.command.operations.length) {
          const scope = tree.nodes.find(n => n.parentId === undefined && n.ref.kind === 'folder');
          if (!scope) throw Error('scope-unavailable');
          proposal = { version: 1, type: 'confirmMutation', requestId: crypto.randomUUID(), installationId: tree.installationId, epoch: tree.epoch, observedRevision: tree.observedRevision, scope: scope.ref, before: tree.nodes, command: preview.command, recovery: { sourceRequestId: record.requestId, mode: message.mode, conflicts: preview.conflicts } };
          preflight(proposal, tree);
          this.recoveryPreviews.clear();
          this.recoveryPreviews.set(proposal.requestId, confirmSchema.parse(proposal));
        }
        return { status: 'preview', requestId: message.requestId, proposal, conflicts: preview.conflicts, warning: message.mode === 'copy' ? '恢复为新副本，可能重复；不证明缺失，不认领原身份。' : '仅应用预览中的安全项；冲突保留当前数据。' };
      } catch { return { status: 'error', requestId: message.requestId, reason: 'recovery-unavailable-or-conflict' }; }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  private async run(message: ReturnType<typeof mutationMessageSchema.parse>, sender: { id?: string; url?: string; tab?: unknown }): Promise<MutationResult> {
    const rejected = (reason: string): MutationResult => ({ requestId: message.requestId, status: 'rejected', needsReconcile: false, completedSteps: 0, remainingSteps: 0, reason });
    const cached = this.volatile.get(message.requestId);
    if (cached && !['reconcileMutation', 'quarantineMutation'].includes(message.type)) {
      if (message.type === 'confirmMutation' && cached.semantics !== this.requestSemantics(message)) return rejected('request-id-conflict');
      return cached.result;
    }
    let records: OperationRecord[];
    try { records = await this.journal.all(); } catch { this.blocked = true; return rejected('journal-unavailable-or-unsupported'); }
    const existing = records.find(r => r.requestId === message.requestId);
    if (existing && message.type === 'confirmMutation' && this.requestSemantics(existing.request) !== this.requestSemantics(message)) return rejected('request-id-conflict');
    if (existing && message.type === 'quarantineMutation') {
      if (existing.quarantine) return this.reconcile(existing);
      if (existing.result && !existing.result.needsReconcile) return rejected('not-unknown');
      try {
        const fresh = await this.projection.fresh();
        existing.result ??= operationResult(existing, 'unknown', 'interrupted-review-required');
        existing.quarantine = { acknowledgedAt: new Date().toISOString(), epoch: fresh.epoch, observedRevision: fresh.observedRevision };
        await this.journal.put(existing);
        await this.journal.all();
        this.projection.invalidatePreviews?.();
        this.recoveryPreviews.clear();
        this.blocked = false;
        return this.reconcile(existing);
      } catch { this.blocked = true; return rejected('quarantine-checkpoint-failed'); }
    }
    if (existing) return this.reconcile(existing, message.type === 'reconcileMutation');
    if (message.type !== 'confirmMutation') return rejected('request-not-found');
    if (message.importBinding && !this.importAuthority?.sharesPersistence(this.journal)) return rejected('import-persistence-owner-mismatch');
    const registered = this.previews.get(message.requestId);
    if (registered || this.registeredRequestIds.has(message.requestId) || message.previewId || message.saveContext || message.organizerContext || message.importContext || message.importBinding) {
      if (!registered || JSON.stringify(registered) !== JSON.stringify(message)) return rejected('preview-required');
      this.previews.delete(message.requestId);
    }
    if (!this.validateSaveContext(message)) return rejected('expired-save-context');
    if (message.organizerContext && !await this.organizerAuthority?.validate(message, sender)) return rejected('expired-organizer-context');
    if ((message.importContext || message.importBinding) && !await this.importAuthority?.validate(message, sender)) return rejected('expired-import-context');
    if (message.recovery) {
      const preview = this.recoveryPreviews.get(message.requestId);
      this.recoveryPreviews.delete(message.requestId);
      if (JSON.stringify(preview) !== JSON.stringify(confirmSchema.parse({ ...message, previewId: undefined }))) return rejected('recovery-preview-required');
    }
    if (this.blocked || records.some(r => (!r.result || r.result.needsReconcile) && !r.quarantine)) return rejected('reconciliation-required');
    if (records.some(r => r.quarantine && r.quarantine.epoch === message.epoch && message.observedRevision <= r.quarantine.observedRevision)) return rejected('fresh-preview-required-after-quarantine');
    let initial: TreeSnapshot;
    let record: OperationRecord;
    try {
      initial = await this.projection.fresh();
      const plan = preflight(message, initial);
      record = operationRecord(message, plan.steps, plan.affected);
    } catch {
      return this.finish(operationRecord(message, [], []), 'rejected', 'preflight-conflict');
    }
    if (message.importBinding) {
      try { const handoff = await this.importAuthority!.authorizeHandoff(message, sender); await this.journal.handoffImport!(handoff.checkpoint, record, handoff.expectedRevision); } catch { return rejected('import-checkpoint-freeze-failed'); }
    }
    else { try { await this.journal.put(record); } catch { this.blocked = true; return rejected('backup-or-intent-failed'); } }
    let expected = initial;
    for (const entry of record.steps) {
      if (this.cancellations.delete(record.requestId)) return this.finish(record, record.steps.some(s => s.state === 'receipt') ? 'partial' : 'failed', 'cancelled-remaining-not-issued');
      let current: TreeSnapshot;
      let step = entry.step;
      if (step.type !== 'create') step = { ...step, id: record.mapping[step.id] ?? step.id };
      if (step.type === 'move') step = { ...step, parentId: record.mapping[step.parentId] ?? step.parentId };
      try {
        current = await this.projection.fresh();
        if (current.epoch !== expected.epoch || current.installationId !== expected.installationId || current.observedRevision !== expected.observedRevision || !sameTree(expected.nodes, current.nodes)) throw Error('changed-before-call');
        if (step.type === 'create') {
          const parentId = record.mapping[step.parentId] ?? step.parentId;
          step = { ...step, parentId };
          if (!current.nodes.find(n => n.ref.nativeId === parentId)?.childrenWritable) throw Error('invalid-parent');
          const url = step.url;
          if (url !== undefined && record.request.recovery?.mode !== 'copy' && current.nodes.some(n => n.url === url)) throw Error('duplicate-url');
        }
        if (step.type === 'remove') { const id = step.id; if (current.nodes.find(n => n.ref.nativeId === id)?.childrenIds.length !== 0) throw Error('not-empty'); }
        entry.before = current.nodes; entry.state = 'intent';
        await this.journal.put(record);
        // Journal await is another race window: revalidate after durable intent, immediately before API.
        const latest = await this.projection.fresh();
        if (latest.observedRevision !== current.observedRevision || latest.epoch !== current.epoch || !sameTree(current.nodes, latest.nodes)) throw Error('changed-after-intent');
      } catch { return this.finish(record, record.steps.some(s => s.state === 'receipt') ? 'partial' : 'failed', 'pre-call-conflict-or-journal-failure'); }
      if (this.cancellations.delete(record.requestId)) { entry.state = 'planned'; return this.finish(record, record.steps.some(s => s.state === 'receipt') ? 'partial' : 'failed', 'cancelled-remaining-not-issued'); }
      if (!record.steps.some(s => s.state === 'receipt') && !this.validateSaveContext(message)) { entry.state = 'planned'; return this.finish(record, 'failed', 'expired-save-context'); }
      if (!record.steps.some(s => s.state === 'receipt') && message.organizerContext) {
        let valid = await this.organizerAuthority?.validate(message, sender);
        try {
          const finalTree = await this.projection.fresh();
          valid = valid && finalTree.installationId === current.installationId && finalTree.epoch === current.epoch && finalTree.observedRevision === current.observedRevision && sameTree(finalTree.nodes, current.nodes);
        } catch { valid = false; }
        // All awaits precede the final synchronous lease/version check.
        if (!valid || !this.organizerAuthority?.current(message) || !this.validateSaveContext(message)) {
          entry.state = 'planned'; return this.finish(record, 'failed', 'expired-organizer-context');
        }
      }
      if (!record.steps.some(s => s.state === 'receipt') && message.importBinding) {
        let valid = await this.importAuthority?.validate(message, sender);
        try {
          const finalTree = await this.projection.fresh();
          valid = valid && finalTree.installationId === current.installationId && finalTree.epoch === current.epoch && finalTree.observedRevision === current.observedRevision && sameTree(finalTree.nodes, current.nodes);
        } catch { valid = false; }
        if (!valid || !this.importAuthority?.current(message)) { entry.state = 'planned'; return this.finish(record, 'failed', 'expired-import-context'); }
      }
      if (this.cancellations.delete(record.requestId)) { entry.state = 'planned'; return this.finish(record, record.steps.some(s => s.state === 'receipt') ? 'partial' : 'failed', 'cancelled-remaining-not-issued'); }
      // Observed invalidations stop issuance; undelivered external events are not atomic with native calls.
      try {
        const returned = await this.issue(step);
        if (returned) entry.returnedNativeId = returned.id;
        const after = expectedAfter(current, step, returned);
        entry.expectedAfter = after;
        // Persist returned identity before readback; a crash before this commit remains unclaimed.
        await this.journal.put(record);
        const observed = await this.projection.fresh();
        if (observed.epoch !== current.epoch || observed.installationId !== current.installationId || observed.observedRevision - current.observedRevision > 1 || !sameTree(after, observed.nodes)) throw Error('readback-conflict');
        entry.after = observed.nodes; entry.state = 'receipt';
        if (step.type === 'create' && returned) record.mapping[step.temporaryId] = returned.id;
        await this.journal.put(record);
        expected = observed;
      } catch {
        // API rejection can be ambiguous too. Never claim it proves no native change.
        entry.state = 'intent';
        return this.finish(record, 'unknown', 'native-result-or-receipt-unknown');
      }
    }
    return this.finish(record, 'completed');
  }
  private issue(step: Step) {
    if (step.type === 'create') return this.writer.create({ parentId: step.parentId, title: step.title, url: step.url });
    if (step.type === 'update') return this.writer.update(step.id, step.changes);
    if (step.type === 'move') return this.writer.move(step.id, { parentId: step.parentId, index: step.index });
    return this.writer.remove(step.id).then(() => undefined);
  }
  private async finish(record: OperationRecord, status: MutationResult['status'], reason?: string): Promise<MutationResult> {
    record.result = operationResult(record, status, reason);
    try { await this.journal.put(record); } catch {
      this.blocked = true;
      record.result = operationResult(record, 'unknown', 'journal-checkpoint-failed');
    }
    this.cacheResult(record, record.result);
    return record.result;
  }
  private async reconcile(record: OperationRecord, explicit = false): Promise<MutationResult> {
    if (record.result && !explicit) return record.result;
    let current: TreeSnapshot | undefined;
    try { current = await this.projection.fresh(); } catch { /* Report unavailable evidence, never issue a write. */ }
    const evidence: NonNullable<MutationResult['evidence']> = record.steps.map((entry, stepIndex) => ({
      stepIndex,
      state: entry.state === 'receipt' ? 'checkpointed' : entry.state === 'planned' ? 'not-issued' : 'unknown',
      nativeId: entry.returnedNativeId ?? (entry.step.type === 'create' ? undefined : entry.step.id),
      currentMatchesReceipt: !!(current && current.installationId === record.request.installationId && entry.after && sameTree(entry.after, current.nodes)),
    }));
    const last = record.steps.at(-1);
    if (record.steps.length && record.steps.every(s => s.state === 'receipt') && last?.after && current && current.installationId === record.request.installationId && sameTree(last.after, current.nodes)) {
      const candidate = { ...operationResult(record, 'completed', 'reconciled-from-receipts'), evidence };
      try {
        await this.journal.put({ ...record, result: candidate });
        // Re-enable only after rereading every record successfully; other unknowns still block run().
        await this.journal.all(); this.blocked = false;
        this.cacheResult(record, candidate);
        return candidate;
      } catch {
        this.blocked = true;
        const unknown = { ...operationResult(record, 'unknown', 'reconcile-checkpoint-failed'), evidence };
        this.cacheResult(record, unknown);
        return unknown;
      }
    }
    const result = { ...(record.result ?? operationResult(record, 'unknown', 'interrupted-review-required')), evidence };
    // Terminal known results remain terminal. Unknown evidence never becomes a resume authorization.
    this.cacheResult(record, result);
    return result;
  }
}
