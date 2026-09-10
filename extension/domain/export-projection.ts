import type { NodeRef, TreeSnapshot } from './node-reference';

export type ExportNode = Readonly<{
  type: 'folder'; id: string; title: string; path: readonly string[]; children: readonly ExportNode[];
} | {
  type: 'bookmark'; id: string; title: string; path: readonly string[]; url: string;
}>;
export interface ExportDocument {
  readonly format: 'markora.bookmarks';
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly roots: readonly ExportNode[];
}
export interface ExportScope {
  readonly roots: readonly NodeRef[];
  readonly excludedFolders: readonly NodeRef[];
}
export interface ExportProjection {
  readonly document: ExportDocument;
  readonly source: Readonly<{ installationId: string; epoch: string; observedRevision: number }>;
  readonly scope: ExportScope;
}
// Private source proof cannot leak into the public document or be forged by a caller.
const proofs = new WeakMap<ExportProjection, string>();
export const EXPORT_RESOURCE_LIMITS = Object.freeze({ nodes: 50_000, depth: 64, bytes: 16 * 1024 * 1024 });
export class ExportProjectionError extends Error {
  constructor(readonly code: 'scope-invalid-or-stale' | 'resource') { super(`export-${code}`); this.name = 'ExportProjectionError'; }
}
const reject = (): never => { throw new ExportProjectionError('scope-invalid-or-stale'); };
const resource = (): never => { throw new ExportProjectionError('resource'); };
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

function validateTree(tree: TreeSnapshot): void {
  if (tree.nodes.length > EXPORT_RESOURCE_LIMITS.nodes || tree.roots.length > EXPORT_RESOURCE_LIMITS.nodes) resource();
  if (tree.installationId.length + tree.epoch.length > EXPORT_RESOURCE_LIMITS.bytes) resource();
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  if (nodes.size !== tree.nodes.length) reject();
  const reached = new Set<string>();
  const pending = tree.roots.map(id => ({ id, parentId: undefined as string | undefined, depth: 0 }));
  let bytes = 0;
  while (pending.length) {
    const { id, parentId, depth } = pending.pop()!;
    if (depth > EXPORT_RESOURCE_LIMITS.depth) resource();
    const node = nodes.get(id);
    if (!node || reached.has(id) || node.parentId !== parentId || node.ref.installationId !== tree.installationId) reject();
    reached.add(id);
    if (node!.ref.kind === 'bookmark' && (node!.url === undefined || node!.childrenIds.length)) reject();
    if (node!.ref.kind === 'folder' && node!.url !== undefined) reject();
    if (node!.childrenIds.length > EXPORT_RESOURCE_LIMITS.nodes) resource();
    // Bound individual strings before encoding/JSON allocation, then the full source proof.
    for (const value of [id, node!.title, node!.url ?? '', node!.ref.installationId, ...node!.childrenIds]) {
      if (value.length > EXPORT_RESOURCE_LIMITS.bytes) resource();
    }
    bytes += byteLength(JSON.stringify(node));
    if (bytes > EXPORT_RESOURCE_LIMITS.bytes) resource();
    node!.childrenIds.forEach(child => pending.push({ id: child, parentId: id, depth: depth + 1 }));
    if (pending.length > EXPORT_RESOURCE_LIMITS.nodes) resource();
  }
  if (reached.size !== nodes.size || byteLength(JSON.stringify(tree)) > EXPORT_RESOURCE_LIMITS.bytes) resource();
}

function project(tree: TreeSnapshot, scope: ExportScope, generatedAt: string): ExportDocument {
  if (!scope.roots.length || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) reject();
  if (scope.roots.length + scope.excludedFolders.length > EXPORT_RESOURCE_LIMITS.nodes) resource();
  validateTree(tree);
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const resolve = (ref: NodeRef) => {
    const node = nodes.get(ref.nativeId);
    if (ref.installationId !== tree.installationId || ref.kind !== 'folder' || node?.ref.kind !== 'folder' || node.parentId === undefined) reject();
    return ref.nativeId;
  };
  const selected = new Set(scope.roots.map(resolve));
  const excluded = new Set(scope.excludedFolders.map(resolve));
  const ancestorsContain = (id: string, ids: Set<string>) => {
    let parent = nodes.get(id)!.parentId;
    while (parent !== undefined) { if (ids.has(parent)) return true; parent = nodes.get(parent)!.parentId; }
    return false;
  };
  let serial = 0;
  let outputBytes = 0;
  const account = (value: object, strings: readonly string[]) => {
    if (strings.reduce((sum, text) => sum + text.length, 0) > EXPORT_RESOURCE_LIMITS.bytes) resource();
    outputBytes += byteLength(JSON.stringify(value));
    if (outputBytes > EXPORT_RESOURCE_LIMITS.bytes) resource();
  };
  const convert = (nativeId: string, parentPath: readonly string[]): ExportNode => {
    const node = nodes.get(nativeId)!;
    const id = `n${++serial}`;
    const path = Object.freeze([...parentPath, node.title]);
    account({ id, title: node.title, path, url: node.url, type: node.ref.kind, children: [] }, [...path, node.title, node.url ?? '']);
    if (node.ref.kind === 'bookmark') return Object.freeze({ type: 'bookmark', id, title: node.title, path, url: node.url! });
    return Object.freeze({ type: 'folder', id, title: node.title, path, children: Object.freeze(node.childrenIds.filter(child => !excluded.has(child)).map(child => convert(child, path))) });
  };
  const roots = [...selected].filter(id => !ancestorsContain(id, selected) && !excluded.has(id) && !ancestorsContain(id, excluded));
  const document = Object.freeze({ format: 'markora.bookmarks' as const, schemaVersion: 1 as const, generatedAt, roots: Object.freeze(roots.map(id => convert(id, []))) });
  if (byteLength(JSON.stringify(document, null, 2)) + 1 > EXPORT_RESOURCE_LIMITS.bytes) resource();
  return document;
}

/** Pure, explicit selection only. No AI policy, native authority, permission or file handle. */
export function createExportProjection(tree: TreeSnapshot, scope: ExportScope, generatedAt: string): ExportProjection {
  if (scope.roots.length + scope.excludedFolders.length > EXPORT_RESOURCE_LIMITS.nodes) resource();
  const frozenScope = Object.freeze({ roots: Object.freeze(scope.roots.map(ref => Object.freeze({ ...ref }))), excludedFolders: Object.freeze(scope.excludedFolders.map(ref => Object.freeze({ ...ref }))) });
  const projection = Object.freeze({ document: project(tree, frozenScope, generatedAt), scope: frozenScope, source: Object.freeze({ installationId: tree.installationId, epoch: tree.epoch, observedRevision: tree.observedRevision }) });
  proofs.set(projection, JSON.stringify(tree));
  return projection;
}

/** Future render/write owners must recheck after awaits; this is not native/file atomicity. */
export function assertExportProjectionCurrent(projection: ExportProjection, current: TreeSnapshot): void {
  validateTree(current);
  if (proofs.get(projection) !== JSON.stringify(current)) reject();
}

export function assertExportProjection(projection: ExportProjection): void {
  if (!proofs.has(projection)) reject();
}

/** All serializers share the same UTF-8 output cap; no partial text is returned. */
export function boundExportText(text: string): string {
  if (text.length > EXPORT_RESOURCE_LIMITS.bytes || byteLength(text) > EXPORT_RESOURCE_LIMITS.bytes) resource();
  return text;
}
