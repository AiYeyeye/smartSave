import type { ImportItem } from '../import/contracts';
import type { ImportCheckpoint } from '../persistence/import-checkpoints';
/** Mapping-origin ordinals use stable span order: original items precede mapped items on ties. */
export function importSourceItems(runtime: NonNullable<ImportCheckpoint['runtime']>): ImportItem[] {
  return runtime.candidates.length
    ? [...runtime.sourceItems, ...runtime.mappedItems].sort((a, b) => a.sourceSpan.start - b.sourceSpan.start).map((item, sourceOrdinal) => ({ ...item, sourceOrdinal }))
    : runtime.sourceItems;
}
export function importDiagnosticSources(checkpoint: ImportCheckpoint) {
  const sources = checkpoint.runtime ? importSourceItems(checkpoint.runtime) : checkpoint.items.map(row => row.item);
  return checkpoint.diagnostics.map(diagnostic => ({ diagnostic, item: sources.find(item => item.sourceOrdinal === diagnostic.sourceOrdinal) }));
}
