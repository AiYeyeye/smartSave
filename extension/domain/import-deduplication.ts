import { importURLDiagnostic } from './import-url';
import type { ImportItem } from '../import/parsers';
import type { TreeSnapshot } from './node-reference';

export interface PendingImportItem {
  item: ImportItem;
  /** A source title is immutable to AI; only an explicit preview edit may replace it. */
  titleLocked: boolean;
}
export type ImportDiagnostic =
  | { sourceOrdinal: number; reason: 'invalid-url' | 'unsupported-protocol' | 'existing-url' }
  | { sourceOrdinal: number; reason: 'file-duplicate'; retainedSourceOrdinal: number };
export interface ImportDeduplication {
  pending: PendingImportItem[];
  diagnostics: ImportDiagnostic[];
}

/** Original strings across the entire native tree, not canonical URLs or just the selected root. */
export function deduplicateImport(items: readonly ImportItem[], tree: TreeSnapshot): ImportDeduplication {
  const existing = new Set(tree.nodes.filter(node => node.ref.kind === 'bookmark').map(node => node.url));
  const retained = new Map<string, PendingImportItem>();
  const diagnostics: ImportDiagnostic[] = [];
  const ordinals = new Set<number>();
  for (const item of items) {
    if (!Number.isSafeInteger(item.sourceOrdinal) || item.sourceOrdinal < 0 || ordinals.has(item.sourceOrdinal)) throw Error('invalid-source-ordinal');
    ordinals.add(item.sourceOrdinal);
  }
  for (const item of [...items].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal)) {
    if (item.diagnostic) { diagnostics.push({ sourceOrdinal: item.sourceOrdinal, reason: item.diagnostic }); continue; }
    // Validate again at the domain boundary: callers must not bypass parser diagnostics.
    const reason = importURLDiagnostic(item.rawURL);
    if (reason) { diagnostics.push({ sourceOrdinal: item.sourceOrdinal, reason }); continue; }
    if (existing.has(item.rawURL)) { diagnostics.push({ sourceOrdinal: item.sourceOrdinal, reason: 'existing-url' }); continue; }
    const first = retained.get(item.rawURL);
    if (first) {
      if (!first.titleLocked && item.title.trim()) { first.item.title = item.title; first.titleLocked = true; }
      diagnostics.push({ sourceOrdinal: item.sourceOrdinal, reason: 'file-duplicate', retainedSourceOrdinal: first.item.sourceOrdinal });
    } else retained.set(item.rawURL, { item: structuredClone(item), titleLocked: Boolean(item.title.trim()) });
  }
  return { pending: [...retained.values()], diagnostics };
}
