import type { TreeSnapshot } from './node-reference';
import type { RenameOutput } from '../schemas/model-output';
import type { ConfirmMutation } from '../schemas/messages';
import { preflight } from './preflight';
import { withCorrectionLearning } from './correction-learning';

export type RenameRow = RenameOutput['suggestions'][number] & {
  original: string;
  editedTitle: string;
  selected: boolean;
};
export function compileBookmarkRenames(
  tree: TreeSnapshot,
  rootId: string,
  rows: RenameRow[],
  organizerContext: string,
): ConfirmMutation {
  const root = tree.nodes.find(node => node.ref.nativeId === rootId && node.ref.kind === 'folder');
  if (!root) throw Error('invalid-scope');
  const operations = rows
    .filter(row => row.selected && row.editedTitle.trim() !== row.original)
    .map(row => {
      const node = tree.nodes.find(node => node.ref.nativeId === row.itemId && node.ref.kind === 'bookmark');
      if (!node || node.title !== row.original || !row.editedTitle.trim() || row.editedTitle.trim().length > 200)
        throw Error('invalid-title');
      return {
        id: `rename:${row.itemId}`,
        dependsOn: [],
        command: { type: 'update' as const, target: node.ref, changes: { title: row.editedTitle.trim() } },
      };
    });
  const request: ConfirmMutation = {
    type: 'confirmMutation',
    version: 1,
    requestId: crypto.randomUUID(),
    installationId: tree.installationId,
    epoch: tree.epoch,
    observedRevision: tree.observedRevision,
    scope: root.ref,
    before: tree.nodes,
    organizerContext,
    command: { type: 'batch', operations, selectedOperationIds: operations.map(operation => operation.id) },
  };
  preflight(request, tree);
  return withCorrectionLearning(
    request,
    rows.map(row => ({
      id: row.itemId,
      title: row.title,
      parentId: tree.nodes.find(node => node.ref.nativeId === row.itemId)?.parentId,
    })),
  );
}
