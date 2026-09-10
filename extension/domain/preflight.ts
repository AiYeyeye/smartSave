import { planBatch } from './batch-plan';
import { planSingle } from './single-plan';
import type { ConfirmMutation } from '../schemas/messages';
import type { TreeSnapshot } from './node-reference';
export { sameNode, validateUrl } from './single-plan';
export type { SnapshotNode, Step } from './single-plan';
export function preflight(request: ConfirmMutation, tree: TreeSnapshot) {
  return request.command.type === 'batch' ? planBatch(request, tree) : planSingle(request, tree);
}
