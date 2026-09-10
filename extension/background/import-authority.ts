import type { OperationJournal } from '../persistence/operations';
import type { SettingsStore } from '../persistence/settings';
import type { ImportCheckpointStore, ImportCheckpoint } from '../persistence/import-checkpoints';
import { compileImportPreview, importSelectionSchema, type ImportPreviewSelection } from '../domain/import-preview';
import { importContextDigest } from '../domain/import-evidence';
import { serializeAiPayload } from '../domain/ai-payload';
import { confirmSchema, trustedMutationSender, type ConfirmMutation } from '../schemas/messages';
import type { TreeProjection } from './tree-projection';
import type { TreeSnapshot } from '../domain/node-reference';

type Sender = { id?: string; url?: string; tab?: unknown };
export const IMPORT_PORT = 'zhilan-import-authority-v1';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Lease = { sender: Sender; version: number; checkpoint?: ImportCheckpoint; request?: ConfirmMutation; tree?: TreeSnapshot };
/** Independently reads evidence and current owners; the coordinator remains the only executor. */
export class ImportAuthority {
  private version = 0;
  private leases = new Map<string, Lease>();
  constructor(private settings: Pick<SettingsStore, 'snapshot' | 'subscribe'>, private projection: Pick<TreeProjection, 'fresh' | 'state'>, private store: Pick<ImportCheckpointStore, 'get'>, private extensionId = chrome.runtime.id) {
    settings.subscribe(() => { this.version++; this.leases.clear(); });
  }
  open(sender: Sender) {
    if (!trustedMutationSender(sender, this.extensionId)) throw Error('invalid-sender');
    const token = crypto.randomUUID(); this.leases.set(token, { sender: { id: sender.id, url: sender.url }, version: this.version }); return token;
  }
  close(token: string) { this.leases.delete(token); }
  private lease(token: string, sender: Sender) {
    const lease = this.leases.get(token);
    if (!lease || lease.version !== this.version || lease.sender.id !== sender.id || lease.sender.url !== sender.url || !trustedMutationSender(sender, this.extensionId)) throw Error('invalid-import-authority');
    return lease;
  }
  async prepare(token: string, id: string, revision: number, input: ImportPreviewSelection, sender: Sender): Promise<ConfirmMutation | undefined> {
    const lease = this.lease(token, sender);
    if (lease.request) throw Error('new-import-session-required');
    const selection = importSelectionSchema.parse(input);
    const checkpoint = await this.store.get(id);
    if (!checkpoint || checkpoint.revision !== revision || checkpoint.phase !== 'classified' || checkpoint.requestId || !checkpoint.runtime) throw Error('import-reclassification-required');
    const settings = await this.settings.snapshot(); const tree = await this.projection.fresh(); const context = { ...settings, tree };
    // A new explicit preview may bind recovered semantic work, but execution always uses this strict epoch digest.
    const digest = await importContextDigest(context, selection.root);
    if (checkpoint.runtime.contextDigest !== digest && (checkpoint.runtime.version !== 2 || checkpoint.runtime.semanticDigest !== await importContextDigest(context, selection.root, true))) throw Error('import-reclassification-required');
    const request = compileImportPreview(checkpoint, selection, tree, crypto.randomUUID());
    if (!request) { this.close(token); return undefined; }
    // The same privacy owner checks root ancestors and every existing destination, never caller folder labels.
    const folderIds = tree.nodes.filter(n => n.ref.kind === 'folder' && request.command.type === 'batch' && request.command.operations.some(o => 'parent' in o.command && o.command.parent.nativeId === n.ref.nativeId)).map(n => n.ref.nativeId);
    const projected: { folders: { id: string }[] } = JSON.parse(serializeAiPayload(tree, settings.privacy, { task: 'import-classify', targetId: selection.root.nativeId, items: [], folderIds }));
    if (projected.folders.length !== folderIds.length) throw Error('privacy-excluded');
    const proposal = confirmSchema.parse({ ...request, importContext: token, importBinding: { checkpointId: id, checkpointRevision: revision, contextDigest: digest, selectedSourceOrdinals: selection.selectedSourceOrdinals, titleEdits: selection.titleEdits, ...(selection.destinationEdits ? { destinationEdits: selection.destinationEdits } : {}) } });
    lease.checkpoint = checkpoint; lease.request = proposal; lease.tree = tree;
    if (!await this.validate(proposal, sender) || !this.current(proposal)) { this.close(token); throw Error('stale-import-authority'); }
    return proposal;
  }
  async validate(request: ConfirmMutation, sender: Sender): Promise<boolean> {
    try {
      if (!request.importContext || !request.importBinding || request.saveContext || request.organizerContext || request.recovery) return false;
      const lease = this.lease(request.importContext, sender);
      if (!lease.request || !lease.checkpoint || !equal({ ...request, previewId: undefined }, { ...lease.request, previewId: undefined })) return false;
      const checkpoint = await this.store.get(request.importBinding.checkpointId);
      const original = lease.checkpoint;
      const applying = { ...original, phase: 'applying', revision: original.revision + 1, requestId: request.requestId, writePlan: { command: request.command, binding: request.importBinding } };
      if (!equal(checkpoint, original) && !equal(checkpoint, applying)) return false;
      const settings = await this.settings.snapshot(); const tree = await this.projection.fresh();
      const digest = await importContextDigest({ ...settings, tree }, request.scope);
      const finalCheckpoint = await this.store.get(request.importBinding.checkpointId);
      return equal(finalCheckpoint, checkpoint) && digest === request.importBinding.contextDigest && this.current(request);
    } catch { return false; }
  }
  current(request: ConfirmMutation): boolean {
    const lease = request.importContext ? this.leases.get(request.importContext) : undefined;
    const state = this.projection.state;
    return !!lease && lease.version === this.version && !!lease.request && state.status === 'ready' && equal(state.snapshot, lease.tree);
  }
  sharesPersistence(journal: OperationJournal): boolean { return !!journal.handoffImport && journal.importCheckpoints === this.store; }
  /** Validation only; persistence belongs to the coordinator journal. */
  async authorizeHandoff(request: ConfirmMutation, sender: Sender) {
    if (!await this.validate(request, sender) || !request.importBinding || !request.importContext || request.command.type !== 'batch') throw Error('invalid-import-authority');
    const original = this.lease(request.importContext, sender).checkpoint!;
    const checkpoint: ImportCheckpoint = structuredClone({ ...original, revision: original.revision + 1, phase: 'applying', requestId: request.requestId, writePlan: { command: request.command, binding: request.importBinding } });
    const freeze = (value: object): void => { Object.values(value).forEach(child => { if (child && typeof child === 'object') freeze(child); }); Object.freeze(value); };
    freeze(checkpoint);
    return Object.freeze({ checkpoint, expectedRevision: original.revision });
  }
}
export function startImportAuthority(settings: SettingsStore, projection: TreeProjection, checkpoints: ImportCheckpointStore) {
  const authority = new ImportAuthority(settings, projection, checkpoints);
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== IMPORT_PORT) return;
    if (!port.sender || !trustedMutationSender(port.sender, chrome.runtime.id)) { port.disconnect(); return; }
    const token = authority.open(port.sender);
    port.onDisconnect.addListener(() => authority.close(token));
    try { port.postMessage({ version: 1, importContext: token }); } catch { authority.close(token); port.disconnect(); }
  });
  return authority;
}
