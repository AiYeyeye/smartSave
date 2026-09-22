import type { ModelAuthority } from '../adapters/model-authority';
import { serializeAiPayload, type AiPrivacy } from './ai-payload';
import type { NodeRef, TreeSnapshot } from './node-reference';
type Context = Awaited<ReturnType<ModelAuthority['read']>>;
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
/** Writable folders under the selected root after privacy projection; the classification and preview owners share it. */
export function importScopeFolders(tree: TreeSnapshot, privacy: AiPrivacy, root: NodeRef): string[] {
  const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
  const selected = nodes.get(root.nativeId);
  if (
    root.installationId !== tree.installationId ||
    root.kind !== 'folder' ||
    !selected ||
    !equal(selected.ref, root) ||
    selected.childrenWritable === false
  )
    throw Error('invalid-root');
  const descendants = tree.nodes
    .filter(n => {
      if (n.ref.kind !== 'folder' || n.childrenWritable === false) return false;
      let cursor: typeof n | undefined = n;
      const seen = new Set<string>();
      while (cursor) {
        if (seen.has(cursor.ref.nativeId)) throw Error('invalid-tree');
        seen.add(cursor.ref.nativeId);
        if (cursor.ref.nativeId === root.nativeId) return true;
        cursor = cursor.parentId === undefined ? undefined : nodes.get(cursor.parentId);
      }
      return false;
    })
    .map(n => n.ref.nativeId);
  // Reuse the final privacy/scope owner, including excluded ancestors of the selected root.
  const projected: { folders: { id: string }[] } = JSON.parse(
    serializeAiPayload(tree, privacy, {
      task: 'import-classify',
      targetId: root.nativeId,
      items: [],
      folderIds: descendants,
    }),
  );
  return projected.folders.map(f => f.id);
}
/**
 * Runtime v3 evidence: installation, root, the projected writable scope folders (identity, placement, label,
 * protection), privacy and the non-secret model route. Epochs, observation clocks, settings revisions and
 * bookmarks outside the classification context are deliberately absent, so a worker restart or an unrelated
 * bookmark change never strands a classified task. Unavailable scopes digest their reason instead of throwing.
 */
export async function importContextDigest(context: Pick<Context, 'tree' | 'privacy' | 'config'>, root: NodeRef) {
  const { tree, privacy, config } = context;
  let scope: unknown;
  try {
    const nodes = new Map(tree.nodes.map(n => [n.ref.nativeId, n]));
    scope = importScopeFolders(tree, privacy, root)
      .map(id => nodes.get(id)!)
      .map(n => ({
        nativeId: n.ref.nativeId,
        parentId: n.parentId,
        title: n.title,
        childrenWritable: n.childrenWritable,
      }))
      .sort((a, b) => (a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0));
  } catch (error) {
    scope = { unavailable: error instanceof Error ? error.message : 'invalid-root' };
  }
  return sha256({
    version: 3,
    installationId: tree.installationId,
    root,
    scope,
    privacy,
    config: config ? { adapter: config.adapter, baseUrl: config.baseUrl, model: config.model } : undefined,
  });
}
/** Runtime v2 records only: strict epoch/revision-bound context, or the semantic variant that omits observation clocks. */
export async function legacyImportContextDigest(context: Context, root: NodeRef, semantic = false) {
  const tree = semantic
    ? {
        ...context.tree,
        epoch: undefined,
        observedRevision: undefined,
        nodes: context.tree.nodes.map(node => ({ ...node, observedRevision: undefined })),
      }
    : context.tree;
  return sha256({ root, tree, revision: context.revision, config: context.config, privacy: context.privacy });
}
/** True when a stored runtime still matches the current owners: v3 by scope digest, v2 by either legacy digest. */
export async function importContextCurrent(
  runtime: { version: 1 | 2 | 3; contextDigest: string; semanticDigest?: string },
  context: Context,
  root: NodeRef,
): Promise<boolean> {
  if (runtime.version === 3) return runtime.contextDigest === (await importContextDigest(context, root));
  if (runtime.version !== 2) return false;
  return (
    runtime.contextDigest === (await legacyImportContextDigest(context, root)) ||
    (!!runtime.semanticDigest && runtime.semanticDigest === (await legacyImportContextDigest(context, root, true)))
  );
}
