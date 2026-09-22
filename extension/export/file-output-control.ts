import { z } from 'zod';
import type { ExportScope } from '../domain/export-projection';
import type { TreeSnapshot } from '../domain/node-reference';
import { FileOutputStore, type OutputFileHandle } from '../persistence/file-output';
import { fileOutputAncestry } from '../domain/file-output-scope';

const base = { version: z.literal(1), type: z.literal('fileOutput') };
const ticket = z.string().min(1);
const revision = z.number().int().nonnegative();
const leaseSchema = z.object({ revision, token: ticket }).strict();
export const fileOutputCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...base, action: z.literal('stop'), ticket }).strict(),
  z.object({ ...base, action: z.literal('prepare'), ticket, lease: leaseSchema }).strict(),
  z
    .object({ ...base, action: z.literal('reload'), ticket, expectedGeneration: ticket, expectedRevision: revision })
    .strict(),
  z
    .object({ ...base, action: z.literal('retry'), ticket, expectedGeneration: ticket, expectedRevision: revision })
    .strict(),
]);
export const fileOutputMessageSchema = z.union([
  z.object({ ...base, action: z.literal('status') }).strict(),
  fileOutputCommandSchema,
]);
export type FileOutputCommand = z.infer<typeof fileOutputCommandSchema>;
export const fileOutputReceiptSchema = z
  .object({
    version: z.literal(1),
    type: z.literal('fileOutputResult'),
    ticket,
    action: z.enum(['stop', 'prepare', 'reload', 'retry']),
    outcome: z.enum(['accepted', 'stale', 'conflict', 'storage-error']),
    expectedGeneration: ticket.optional(),
    expectedRevision: revision.optional(),
    revision: revision.optional(),
  })
  .strict();
export type FileOutputReceipt = z.infer<typeof fileOutputReceiptSchema>;
export function fileOutputReceipt(
  command: FileOutputCommand,
  outcome: FileOutputReceipt['outcome'],
  currentRevision?: number,
): FileOutputReceipt {
  return {
    version: 1,
    type: 'fileOutputResult',
    ticket: command.ticket,
    action: command.action,
    outcome,
    ...('expectedGeneration' in command
      ? { expectedGeneration: command.expectedGeneration, expectedRevision: command.expectedRevision }
      : command.action === 'prepare'
        ? { expectedRevision: command.lease.revision }
        : {}),
    ...(currentRevision === undefined ? {} : { revision: currentRevision }),
  };
}
export async function sendFileOutputCommand(command: FileOutputCommand): Promise<FileOutputReceipt> {
  const parsed = fileOutputReceiptSchema.safeParse(
    await chrome.runtime.sendMessage(fileOutputCommandSchema.parse(command)),
  );
  const expected = fileOutputReceipt(command, 'accepted');
  if (
    !parsed.success ||
    parsed.data.ticket !== expected.ticket ||
    parsed.data.action !== expected.action ||
    parsed.data.expectedGeneration !== expected.expectedGeneration ||
    parsed.data.expectedRevision !== expected.expectedRevision ||
    (parsed.data.outcome === 'accepted' &&
      (parsed.data.revision === undefined ||
        (expected.expectedRevision !== undefined && parsed.data.revision !== expected.expectedRevision)))
  )
    throw Error('file-output-receipt-mismatch');
  if (parsed.data.outcome !== 'accepted') throw Error(`file-output-${parsed.data.outcome}`);
  return parsed.data;
}
/** Picker/requestPermission run in a visible user gesture before acquiring authority.
 * A delayed acknowledgement cannot replace a target after another page stops or configures. */
export async function configureFileOutput(
  handle: OutputFileHandle,
  tree: TreeSnapshot,
  scope: ExportScope,
  store = new FileOutputStore(),
): Promise<string> {
  const ancestry = fileOutputAncestry(tree, scope);
  const lease = await store.issueLease();
  await sendFileOutputCommand({
    version: 1,
    type: 'fileOutput',
    action: 'prepare',
    ticket: crypto.randomUUID(),
    lease,
  });
  const generation = await store.configure(handle, scope, ancestry, lease);
  await sendFileOutputCommand({
    version: 1,
    type: 'fileOutput',
    action: 'reload',
    ticket: crypto.randomUUID(),
    expectedGeneration: generation,
    expectedRevision: lease.revision + 1,
  });
  return generation;
}
export function fileOutputRefusal(error: unknown): string {
  const code = error instanceof Error ? error.message : '';
  if (code === 'file-output-stale' || code === 'file-output-conflict')
    return '操作已过期或与其他页面冲突，未接受本次请求。请刷新状态后重新操作。';
  if (code === 'file-output-storage-error' || code === 'file-output-storage')
    return '存储失败，未确认接受本次请求。请检查存储并刷新状态；不会报告写入成功。';
  if (code === 'file-output-receipt-mismatch')
    return '后台回执不匹配，无法确认本次请求。请刷新状态核对，不会报告写入成功。';
  return '操作未完成或范围已失效。请刷新状态并明确重选目录/文件；不会回退全树。';
}
