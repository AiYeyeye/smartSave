import type { ModelSettingsReader } from '../adapters/feature-model-settings';
import { organizeCheckpointContext, type OrganizeCheckpoint } from '../domain/organize-checkpoint';
import { restoreOrganizeGeneration } from '../domain/organize-generation-checkpoint';
import { dependencyDigest } from '../domain/context-dependencies';
import { organizeRequest } from '../domain/organize-proposal';
import { organizeRejectionKey } from '../domain/organize-review';
import type { OrganizeCheckpointStore } from '../persistence/organize-checkpoints';
import type { OrganizeMemoryStore } from '../persistence/organize-memory';
import type { OperationJournal } from '../persistence/operations';
import { confirmSchema, type ConfirmMutation } from '../schemas/messages';
import { trustedMutationSender } from '../domain/trusted-sender';
import type { OrganizerAuthority } from './organizer-authority';
import type { TreeProjection } from './tree-projection';

type Sender = { id?: string; url?: string; tab?: unknown };
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))),
    byte => byte.toString(16).padStart(2, '0'),
  ).join('');
const scope = (tree: Parameters<typeof dependencyDigest>[0], rootId: string) =>
  dependencyDigest(tree, { task: 'organize', rootId, itemIds: [], folderIds: [] });
type Prepared = {
  original: OrganizeCheckpoint;
  request: ConfirmMutation;
  scope: string;
  version: number;
};

/** Rebuilds a durable suggestion under a fresh page lease. The mutation coordinator alone writes bookmarks. */
export class OrganizeTaskAuthority {
  private version = 0;
  private prepared = new Map<string, Prepared>();
  constructor(
    private settings: ModelSettingsReader,
    private projection: Pick<TreeProjection, 'fresh' | 'state'>,
    private store: Pick<OrganizeCheckpointStore, 'get'>,
    private organizer: OrganizerAuthority,
    private extensionId: string,
    private memory?: Pick<OrganizeMemoryStore, 'load'>,
    private onHandoff?: (checkpoint: OrganizeCheckpoint) => void,
  ) {
    settings.subscribe(() => {
      this.version++;
      this.prepared.clear();
    });
  }
  sharesPersistence(journal: OperationJournal) {
    return !!journal.handoffOrganize && journal.organizeCheckpoints === this.store;
  }
  memoryChanged(installationId: string) {
    if ([...this.prepared.values()].some(value => value.original.installationId === installationId)) {
      this.version++;
      this.prepared.clear();
    }
  }
  private submitted(value: Prepared): OrganizeCheckpoint {
    const request = value.request;
    if (request.command.type !== 'batch' || !request.organizerBinding) throw Error('invalid-organize-authority');
    return {
      ...value.original,
      revision: value.original.revision + 1,
      submission: {
        requestId: request.requestId,
        binding: request.organizerBinding,
        command: request.command,
      },
    };
  }
  async prepare(token: string, id: string, revision: number, sender: Sender): Promise<ConfirmMutation | undefined> {
    if (!trustedMutationSender(sender, this.extensionId)) throw Error('invalid-sender');
    const version = this.version;
    const checkpoint = await this.store.get(id);
    if (
      !checkpoint ||
      checkpoint.revision !== revision ||
      checkpoint.submission ||
      checkpoint.stage !== 'complete' ||
      checkpoint.status !== 'review'
    )
      throw Error('organize-task-conflict');
    const settings = await this.settings.snapshot();
    const tree = await this.projection.fresh();
    const { state } = await restoreOrganizeGeneration(
      checkpoint,
      { ...settings, tree },
      { allowMissingCredential: true },
    );
    if (!state.proposal || state.invalid) throw Error('stale-organize-authority');
    if (!state.selected.length) return undefined;
    if (this.memory) {
      const memory = await this.memory.load(tree.installationId);
      state.proposal.protectedFolderIds = [
        ...new Set([...(state.proposal.protectedFolderIds ?? []), ...memory.protectedFolderIds]),
      ];
      if (
        state.proposal.actions.some(
          action =>
            state.selected.includes(action.id) &&
            memory.rejected.some(
              entry => entry.signature === organizeRejectionKey(state.proposal!, action, state.targets),
            ),
        )
      )
        throw Error('organize-selection-rejected');
    }
    const request = confirmSchema.parse({
      ...organizeRequest(state.proposal, state.selected, state.targets, token),
      organizerBinding: {
        checkpointId: id,
        checkpointRevision: revision,
        contextDigest: await hash([checkpoint.scopeDigest, checkpoint.settingsDigest, checkpoint.settingsRevision]),
        selectionDigest: await hash(checkpoint.selection),
      },
    });
    if (version !== this.version) throw Error('stale-organize-authority');
    this.prepared.clear();
    this.prepared.set(request.requestId, {
      original: checkpoint,
      request,
      scope: scope(tree, checkpoint.root.nativeId),
      version,
    });
    if (!(await this.validate(request, sender)) || !this.current(request)) throw Error('stale-organize-authority');
    return request;
  }
  async validate(request: ConfirmMutation, sender: Sender): Promise<boolean> {
    try {
      if (
        !request.organizerContext ||
        !request.organizerBinding ||
        request.importContext ||
        request.importBinding ||
        request.saveContext ||
        request.recovery ||
        !trustedMutationSender(sender, this.extensionId)
      )
        return false;
      const prepared = this.prepared.get(request.requestId);
      if (
        !prepared ||
        !equal({ ...request, previewId: undefined }, { ...prepared.request, previewId: undefined }) ||
        !(await this.organizer.validate(request, sender))
      )
        return false;
      const checkpoint = await this.store.get(prepared.original.id);
      if (!equal(checkpoint, prepared.original) && !equal(checkpoint, this.submitted(prepared))) return false;
      const settings = await this.settings.snapshot();
      const tree = await this.projection.fresh();
      const digests = await organizeCheckpointContext({ ...settings, tree }, prepared.original.root.nativeId);
      if (
        digests.scopeDigest !== prepared.original.scopeDigest ||
        digests.settingsDigest !== prepared.original.settingsDigest ||
        digests.settingsRevision !== prepared.original.settingsRevision
      )
        return false;
      if (this.memory) {
        // Any memory edit invalidates this registered selection, even if its storage event is still in flight.
        const memory = await this.memory.load(tree.installationId);
        const baseline = await restoreOrganizeGeneration(
          prepared.original,
          { ...settings, tree },
          { allowMissingCredential: true },
        );
        const proposal = baseline.state.proposal!;
        proposal.protectedFolderIds = [
          ...new Set([...(proposal.protectedFolderIds ?? []), ...memory.protectedFolderIds]),
        ];
        const rebuilt = organizeRequest(
          proposal,
          baseline.state.selected,
          baseline.state.targets,
          request.organizerContext,
        );
        if (
          !equal(rebuilt.command, request.command) ||
          proposal.actions.some(
            action =>
              baseline.state.selected.includes(action.id) &&
              memory.rejected.some(
                entry => entry.signature === organizeRejectionKey(proposal, action, baseline.state.targets),
              ),
          )
        )
          return false;
      }
      return equal(await this.store.get(prepared.original.id), checkpoint) && this.current(request);
    } catch {
      return false;
    }
  }
  current(request: ConfirmMutation): boolean {
    const prepared = this.prepared.get(request.requestId);
    const state = this.projection.state;
    return (
      !!prepared &&
      prepared.version === this.version &&
      this.organizer.current(request) &&
      state.status === 'ready' &&
      state.snapshot.installationId === prepared.original.installationId &&
      scope(state.snapshot, prepared.original.root.nativeId) === prepared.scope
    );
  }
  async authorizeHandoff(request: ConfirmMutation, sender: Sender) {
    if (!(await this.validate(request, sender))) throw Error('invalid-organize-authority');
    const prepared = this.prepared.get(request.requestId)!;
    // Repeating this method cannot replace the first atomic association.
    if (!equal(await this.store.get(prepared.original.id), prepared.original)) throw Error('organize-task-conflict');
    const checkpoint = structuredClone(this.submitted(prepared));
    const freeze = (value: object): void => {
      for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
      Object.freeze(value);
    };
    freeze(checkpoint);
    return Object.freeze({ checkpoint, expectedRevision: prepared.original.revision });
  }
  committed(checkpoint: OrganizeCheckpoint) {
    this.onHandoff?.(structuredClone(checkpoint));
  }
}
