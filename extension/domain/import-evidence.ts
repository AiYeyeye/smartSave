import type { ModelAuthority } from '../adapters/model-authority';
import type { NodeRef } from './node-reference';
type Context = Awaited<ReturnType<ModelAuthority['read']>>;
// Semantic v2 retains global URL/directory/protection dependencies; only observation clocks are omitted.
export async function importContextDigest(context: Context, root: NodeRef, semantic = false) {
  // No key, request/response body, session token or reversible settings envelope is durable.
  const tree = semantic
    ? {
        ...context.tree,
        epoch: undefined,
        observedRevision: undefined,
        nodes: context.tree.nodes.map(node => ({ ...node, observedRevision: undefined })),
      }
    : context.tree;
  const bytes = new TextEncoder().encode(
    JSON.stringify({ root, tree, revision: context.revision, config: context.config, privacy: context.privacy }),
  );
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
