/**
 * Session state for the save confirmation popup.
 *
 * Ownership is split so two extension contexts never read-modify-write the same key: the service worker is the only
 * writer of the queue, and the popup is the only writer of its per-receipt drafts. Session storage survives worker
 * sleep and popup close, and is discarded with the browser session.
 */
/** Presence port the popup holds open while it is shown. */
export const SAVE_CONFIRM_PORT = 'zhilan.save-confirm.v1';
export const SAVE_CONFIRM_QUEUE_KEY = 'saveConfirm.queue.v1';
export const SAVE_CONFIRM_DRAFT_PREFIX = 'saveConfirm.draft.v1.';
export const SAVE_CONFIRM_QUEUE_LIMIT = 50;

/** Only fields the user touched win over newer receipt results; untouched fields follow the latest result. */
export type SaveConfirmDraft = {
  title?: string;
  titleEdited?: boolean;
  folderId?: string;
  folderEdited?: boolean;
  expanded?: string[];
  treeOpen?: boolean;
};

type SessionArea = {
  get(key: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(key: string | string[]): Promise<void>;
};

export const draftKey = (receiptId: string) => SAVE_CONFIRM_DRAFT_PREFIX + receiptId;

export function parseQueue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))];
}

export function parseDraft(value: unknown): SaveConfirmDraft {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const draft: SaveConfirmDraft = {};
  if (typeof raw.title === 'string') draft.title = raw.title;
  if (raw.titleEdited === true) draft.titleEdited = true;
  if (typeof raw.folderId === 'string') draft.folderId = raw.folderId;
  if (raw.folderEdited === true) draft.folderEdited = true;
  if (Array.isArray(raw.expanded)) draft.expanded = raw.expanded.filter((id): id is string => typeof id === 'string');
  if (typeof raw.treeOpen === 'boolean') draft.treeOpen = raw.treeOpen;
  return draft;
}

/** Worker-owned FIFO of receipts the popup presents one at a time. */
export class SaveConfirmQueue {
  private chain: Promise<unknown> = Promise.resolve();
  private memory: string[] = [];
  constructor(private readonly area: SessionArea | undefined) {}

  private run<T>(operation: (queue: string[]) => { next: string[]; value: T }): Promise<T> {
    const step = this.chain.then(async () => {
      const queue = await this.read();
      const { next, value } = operation(queue);
      const bounded = next.slice(-SAVE_CONFIRM_QUEUE_LIMIT);
      this.memory = bounded;
      await this.area?.set({ [SAVE_CONFIRM_QUEUE_KEY]: bounded }).catch(() => {});
      return value;
    });
    this.chain = step.catch(() => {});
    return step;
  }

  async read(): Promise<string[]> {
    if (!this.area) return [...this.memory];
    try {
      return parseQueue((await this.area.get(SAVE_CONFIRM_QUEUE_KEY))[SAVE_CONFIRM_QUEUE_KEY]);
    } catch {
      return [...this.memory];
    }
  }

  /** Appends unseen ids in order; returns the queue length. */
  enqueue(ids: string[]) {
    return this.run(queue => {
      const next = [...queue];
      for (const id of ids) if (id && !next.includes(id)) next.push(id);
      return { next, value: next.length };
    });
  }

  /** Removes one id and its draft; returns the remaining length. */
  async remove(id: string) {
    const length = await this.run(queue => {
      const next = queue.filter(item => item !== id);
      return { next, value: next.length };
    });
    await this.area?.remove?.(draftKey(id)).catch(() => {});
    return length;
  }

  /** Drops ids that no longer name a reviewable receipt. */
  retain(keep: (id: string) => boolean) {
    return this.run(queue => {
      const next = queue.filter(keep);
      return { next, value: next.length };
    });
  }
}
