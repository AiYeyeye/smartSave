import { z } from 'zod';
export const nodeRefSchema = z.object({ installationId: z.string().min(1), nativeId: z.string(), kind: z.enum(['folder', 'bookmark']) });
export type NodeRef = z.infer<typeof nodeRefSchema>;
// readOnly describes native structural/managed protection, NOT permission to write.
// Every consumer in task 02 is read-only; no snapshot authorizes a future write.
export const nodeSchema = z.object({ ref: nodeRefSchema, parentId: z.string().optional(), index: z.number(), title: z.string(), url: z.string().optional(), childrenIds: z.array(z.string()), readOnly: z.boolean(), childrenWritable: z.boolean().optional(), observedRevision: z.number() });
export const treeStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('loading') }),
  z.object({ status: z.literal('error'), message: z.string() }),
  z.object({ status: z.literal('ready'), snapshot: z.object({ installationId: z.string(), epoch: z.string(), observedRevision: z.number(), roots: z.array(z.string()), nodes: z.array(nodeSchema) }) }),
]);
export type TreeState = z.infer<typeof treeStateSchema>;
export type TreeSnapshot = Extract<TreeState, { status: 'ready' }>['snapshot'];
export const TREE_PORT = 'zhilan.tree.v1';
