import type { ImportCheckpoint } from '../persistence/import-checkpoints';
export interface ImportDraft { selected: number[]; edits: Record<number, string>; destinations?: Record<number, string> }
/** Page-memory user intent, separate from durable classification evidence. */
export class ImportDrafts {
  private readonly drafts = new Map<string, { initialized: boolean; userEdited: boolean; value: ImportDraft }>();
  updateItems(id: string, ordinals: number[]): ImportDraft {
    let entry = this.drafts.get(id);
    if (!entry) { entry = { initialized: false, userEdited: false, value: { selected: [], edits: {} } }; this.drafts.set(id, entry); }
    if (!entry.initialized && !entry.userEdited && ordinals.length) { entry.value.selected = [...ordinals]; entry.initialized = true; }
    return structuredClone(entry.value);
  }
  get(checkpoint: ImportCheckpoint): ImportDraft { return this.updateItems(checkpoint.id, checkpoint.items.map(row => row.item.sourceOrdinal)); }
  set(id: string, draft: ImportDraft) { this.drafts.set(id, { initialized: true, userEdited: true, value: structuredClone(draft) }); }
}
