import { z } from 'zod';
import { ImportCheckpointStore, type ImportCheckpoint } from '../persistence/import-checkpoints';
export type ImportSubmission = {
  state: 'idle' | 'rejected-before-handoff' | 'journal-owned' | 'uncertain';
  request?: ConfirmMutation;
  result?: MutationResult;
};
import { confirmSchema, type ConfirmMutation, type MutationResult } from '../schemas/messages';
import type { ImportPreviewSelection } from '../domain/import-preview';
import { submitMutation } from './mutation-client';
export interface ImportLease {
  token: string;
  close(): void;
}
export const openImportLease = (invalidated: () => void): Promise<ImportLease> =>
  new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'zhilan-import-authority-v1' });
    let closed = false;
    let delivered = false;
    const close = () => {
      if (!closed) {
        closed = true;
        port.disconnect();
      }
    };
    const timer = setTimeout(() => {
      close();
      reject(Error('import-authority-unavailable'));
    }, 10000);
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      if (!closed) {
        closed = true;
        invalidated();
      }
      if (!delivered) reject(Error('import-authority-disconnected'));
    });
    port.onMessage.addListener((raw: unknown) => {
      if (closed || delivered) return;
      clearTimeout(timer);
      const value = z
        .object({ version: z.literal(1), importContext: z.string().min(1) })
        .strict()
        .safeParse(raw);
      if (!value.success) {
        close();
        reject(Error('invalid-import-authority'));
        return;
      }
      delivered = true;
      resolve({ token: value.data.importContext, close });
    });
  });
const send = (message: unknown): Promise<unknown> =>
  new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(message, (response: unknown) => {
      if (chrome.runtime.lastError) reject(Error('import-transport-unavailable'));
      else resolve(response);
    }),
  );
/** Callable real worker client for later UI. No constructor replay and no native adapter. */
export class ImportController {
  private lease?: ImportLease;
  private request?: ConfirmMutation;
  private applying?: ConfirmMutation;
  private generation = 0;
  private checkpointId?: string;
  private submissions = new Map<string, ImportSubmission>();
  submission(id: string): ImportSubmission {
    return structuredClone(this.submissions.get(id) ?? { state: 'idle' });
  }
  observe(checkpoint: ImportCheckpoint) {
    if (checkpoint.requestId && !this.submissions.has(checkpoint.id))
      this.submissions.set(checkpoint.id, { state: 'journal-owned' });
    return this.submission(checkpoint.id);
  }
  constructor(
    private transport = send,
    private openLease = openImportLease,
    private checkpoints: Pick<ImportCheckpointStore, 'get'> = new ImportCheckpointStore(),
  ) {}
  async preview(
    checkpointId: string,
    checkpointRevision: number,
    selection: ImportPreviewSelection,
  ): Promise<ConfirmMutation | undefined> {
    if (['journal-owned', 'uncertain'].includes(this.submission(checkpointId).state))
      throw Error('import-checkpoint-recovery-required');
    if (this.applying) throw Error('import-apply-in-progress');
    this.invalidatePreview();
    const generation = this.generation;
    const lease = await this.openLease(() => {
      this.invalidatePreview();
    });
    if (generation !== this.generation) {
      lease.close();
      throw Error('import-cancelled');
    }
    this.lease = lease;
    try {
      const response = z
        .union([
          z.object({ status: z.literal('preview'), proposal: confirmSchema }).strict(),
          z.object({ status: z.literal('empty') }).strict(),
          z.object({ status: z.literal('rejected'), reason: z.string().optional() }).strict(),
        ])
        .parse(
          await this.transport({
            version: 1,
            type: 'registerImportPreview',
            importContext: lease.token,
            checkpointId,
            checkpointRevision,
            selection,
          }),
        );
      if (generation !== this.generation) throw Error('import-cancelled');
      if (response.status === 'rejected') throw Error(response.reason ?? 'import-preview-rejected');
      if (response.status === 'empty') {
        this.invalidatePreview();
        return undefined;
      }
      this.checkpointId = checkpointId;
      this.request = response.proposal;
      return structuredClone(response.proposal);
    } catch (error) {
      if (generation === this.generation) this.invalidatePreview();
      throw error;
    }
  }
  async apply(): Promise<MutationResult> {
    const request = this.request;
    if (!request) throw Error('import-preview-required');
    this.request = undefined;
    this.applying = request;
    const id = this.checkpointId!;
    this.submissions.set(id, { state: 'uncertain', request });
    try {
      const result = await submitMutation(request, this.transport);
      let state: ImportSubmission['state'] = result.status === 'unknown' ? 'uncertain' : 'journal-owned';
      try {
        const saved = await this.checkpoints.get(id);
        if (saved?.requestId) state = 'journal-owned';
        else if (result.status === 'rejected' && saved && (saved.phase === 'classified' || saved.phase === 'paused'))
          state = 'rejected-before-handoff';
      } catch {
        state = 'uncertain';
      }
      this.submissions.set(id, { state, ...(state === 'rejected-before-handoff' ? {} : { request }), result });
      return result;
    } finally {
      this.applying = undefined;
      this.cancel();
    }
  }
  /** Same frozen durable envelope only; journal dedupe precedes expired/restarted ephemeral authorization. */
  retry(request: ConfirmMutation): Promise<MutationResult> {
    return submitMutation(confirmSchema.parse(request), this.transport);
  }
  async retrySubmission(id: string) {
    const state = this.submission(id);
    if (!state.request) throw Error('import-preview-required');
    const result = await this.retry(state.request);
    this.submissions.set(id, { ...state, result });
    return this.submission(id);
  }
  /** Context invalidation: drops the unapplied proposal and its lease; an apply already handed to the worker keeps running. */
  invalidatePreview() {
    this.generation++;
    this.request = undefined;
    this.lease?.close();
    this.lease = undefined;
  }
  /** Explicit user cancellation: also signals the worker to stop steps not yet issued for an in-flight apply. */
  cancel() {
    const request = this.request ?? this.applying;
    this.invalidatePreview();
    if (request)
      void this.transport({ version: 1, type: 'cancelMutation', requestId: request.requestId }).catch(() => {});
  }
  dispose() {
    this.cancel();
  }
}
