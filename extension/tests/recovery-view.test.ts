import { expect, it } from 'vitest';
import {
  classifyRecoveryRecords,
  describeCommand,
  describeOperation,
  describeResultStatus,
  describeStep,
  formatOperationTime,
  isUnsettled,
  proposalOperations,
  sortByRecency,
  type SingleCommand,
} from '../domain/recovery-view';
import { operationSchema, type OperationRecord } from '../persistence/operations';
import type { Command, DurableMutationRequest } from '../schemas/messages';

type Step = OperationRecord['steps'][number];
type Result = NonNullable<OperationRecord['result']>;
const digest = 'a'.repeat(64);
const ref = (nativeId: string, kind: 'folder' | 'bookmark' = 'bookmark') => ({ installationId: 'i', nativeId, kind });
const root = ref('root', 'folder');
const single = {
  create: { type: 'create', parent: root, title: 'Saved', url: 'https://saved.test/' },
  createFolderAndBookmark: {
    type: 'createFolderAndBookmark',
    parent: root,
    folderTitle: 'Reading',
    title: 'Saved',
    url: 'https://saved.test/',
  },
  update: { type: 'update', target: ref('a'), changes: { title: 'Renamed' } },
  move: { type: 'move', target: ref('a'), parent: root, index: 0 },
  remove: { type: 'remove', target: ref('a') },
  deleteSubtree: { type: 'deleteSubtree', target: ref('f', 'folder') },
} satisfies Record<string, SingleCommand>;
function batch(operations: SingleCommand[], selected?: string[]): Command {
  const entries = operations.map((command, index) => ({ id: `op${index}`, dependsOn: [], command }));
  return { type: 'batch', operations: entries, selectedOperationIds: selected ?? entries.map(entry => entry.id) };
}
function request(
  requestId: string,
  command: Command,
  recovery?: DurableMutationRequest['recovery'],
): DurableMutationRequest {
  return {
    version: 1,
    type: 'confirmMutation',
    requestId,
    installationId: 'i',
    epoch: 'e',
    observedRevision: 0,
    scope: root,
    before: [],
    command,
    recovery,
  };
}
const created = (temporaryId: string, state: Step['state'] = 'receipt'): Step => ({
  step: { type: 'create', parentId: 'root', title: temporaryId, temporaryId },
  state,
  returnedNativeId: state === 'receipt' ? `native-${temporaryId}` : undefined,
});
const settled = (requestId: string, status: Result['status'] = 'completed'): Result => ({
  requestId,
  status,
  needsReconcile: false,
  completedSteps: status === 'completed' || status === 'partial' ? 1 : 0,
  remainingSteps: status === 'partial' ? 1 : 0,
  reason: status === 'completed' ? undefined : status,
});
const unknown = (requestId: string): Result => ({
  requestId,
  status: 'unknown',
  needsReconcile: true,
  completedSteps: 0,
  remainingSteps: 1,
  reason: 'readback-unavailable',
});
function record(spec: {
  requestId: string;
  command?: Command;
  recovery?: DurableMutationRequest['recovery'];
  steps?: Step[];
  result?: Result;
  createdAt?: string;
  quarantine?: OperationRecord['quarantine'];
  schemaVersion?: 1 | 2;
}): OperationRecord {
  const version = spec.schemaVersion ?? 2;
  const steps = spec.steps ?? [created('a')];
  return operationSchema.parse({
    schemaVersion: version,
    requestId: spec.requestId,
    request: request(spec.requestId, spec.command ?? single.create, spec.recovery),
    affected: [],
    mapping: {},
    createdAt: spec.createdAt,
    quarantine: spec.quarantine,
    result: spec.result,
    steps:
      version === 2
        ? steps.map(step =>
            step.state === 'receipt' ? { ...step, beforeDigest: digest, afterDigest: digest, touched: [] } : step,
          )
        : steps,
    ...(version === 2 ? { final: { nodes: [] } } : {}),
  });
}

it('describes single commands by their shape', () => {
  expect(describeOperation(record({ requestId: 'c', command: single.create })).kind).toBe('收藏');
  expect(describeOperation(record({ requestId: 'cf', command: single.createFolderAndBookmark })).kind).toBe('收藏');
  expect(describeOperation(record({ requestId: 'u', command: single.update })).kind).toBe('编辑');
  expect(describeOperation(record({ requestId: 'm', command: single.move })).kind).toBe('移动');
  expect(describeOperation(record({ requestId: 'r', command: single.remove })).kind).toBe('删除');
  expect(describeOperation(record({ requestId: 'd', command: single.deleteSubtree })).kind).toBe('删除');
});

it('describes batches: moves or remove+create are organize, all-create is import, anything else is a plain batch', () => {
  expect(describeOperation(record({ requestId: 'b1', command: batch([single.move, single.update]) })).kind).toBe(
    '整理批次',
  );
  expect(describeOperation(record({ requestId: 'b2', command: batch([single.remove, single.create]) })).kind).toBe(
    '整理批次',
  );
  expect(
    describeOperation(record({ requestId: 'b3', command: batch([single.create, single.createFolderAndBookmark]) }))
      .kind,
  ).toBe('导入批次');
  expect(describeOperation(record({ requestId: 'b4', command: batch([single.remove, single.remove]) })).kind).toBe(
    '批量操作',
  );
  expect(describeOperation(record({ requestId: 'b5', command: batch([single.update]) })).kind).toBe('批量操作');
  // Only selected operations ran, so an unselected move never turns an import into an organize batch.
  expect(
    describeOperation(record({ requestId: 'b6', command: batch([single.create, single.move], ['op0']) })).kind,
  ).toBe('导入批次');
});

it('describes recovery requests as recovery regardless of command shape and counts steps, receipts and time', () => {
  const recovery = record({
    requestId: 'undo-1',
    command: batch([single.move]),
    recovery: { sourceRequestId: 'src', mode: 'undo', conflicts: [] },
    steps: [created('a'), created('b', 'intent'), created('c', 'planned')],
    createdAt: '2026-09-22T01:02:03.000Z',
  });
  expect(describeOperation(recovery)).toEqual({
    kind: '恢复操作',
    steps: 3,
    receipts: 1,
    when: '2026-09-22T01:02:03.000Z',
  });
  expect(describeOperation(record({ requestId: 'legacy', schemaVersion: 1 })).when).toBeUndefined();
});

it('splits records into attention, undoable and history', () => {
  const interrupted = record({ requestId: 'interrupted', steps: [created('a', 'intent')] });
  const unsettled = record({ requestId: 'unsettled', result: unknown('unsettled') });
  const quarantined = record({
    requestId: 'quarantined',
    result: unknown('quarantined'),
    quarantine: { acknowledgedAt: '2026-09-22T00:00:00.000Z', epoch: 'e', observedRevision: 1 },
  });
  const completed = record({ requestId: 'completed', command: batch([single.move]), result: settled('completed') });
  const partial = record({ requestId: 'partial', result: settled('partial', 'partial') });
  const noReceipt = record({
    requestId: 'no-receipt',
    steps: [created('a', 'planned')],
    result: settled('no-receipt'),
  });
  const rejected = record({ requestId: 'rejected', steps: [], result: settled('rejected', 'rejected') });
  const failed = record({ requestId: 'failed', result: settled('failed', 'failed') });
  const restoredSource = record({ requestId: 'restored-source', result: settled('restored-source') });
  const undo = record({
    requestId: 'undo',
    recovery: { sourceRequestId: 'restored-source', mode: 'undo', conflicts: [] },
    result: settled('undo'),
  });
  const copiedSource = record({ requestId: 'copied-source', result: settled('copied-source') });
  const copy = record({
    requestId: 'copy',
    recovery: { sourceRequestId: 'copied-source', mode: 'copy', conflicts: [] },
    result: settled('copy'),
  });
  const legacy = record({ requestId: 'legacy', schemaVersion: 1, result: settled('legacy') });
  const groups = classifyRecoveryRecords([
    interrupted,
    unsettled,
    quarantined,
    completed,
    partial,
    noReceipt,
    rejected,
    failed,
    restoredSource,
    undo,
    copiedSource,
    copy,
    legacy,
  ]);
  const ids = (list: OperationRecord[]) => list.map(item => item.requestId).sort();
  expect(ids(groups.attention)).toEqual(['interrupted', 'unsettled']);
  expect(ids(groups.undoable)).toEqual(['completed', 'legacy', 'partial']);
  expect(ids(groups.history)).toEqual([
    'copied-source',
    'copy',
    'failed',
    'no-receipt',
    'quarantined',
    'rejected',
    'restored-source',
    'undo',
  ]);
  expect(isUnsettled(quarantined)).toBe(false);
  expect(isUnsettled(interrupted)).toBe(true);
});

it('orders every group newest first with legacy records lacking createdAt last', () => {
  const older = record({ requestId: 'older', result: settled('older'), createdAt: '2026-09-22T01:00:00.000Z' });
  const newer = record({ requestId: 'newer', result: settled('newer'), createdAt: '2026-09-22T02:00:00.000Z' });
  const legacy = record({ requestId: 'legacy', schemaVersion: 1, result: settled('legacy') });
  const unparsable = record({ requestId: 'unparsable', result: settled('unparsable'), createdAt: 'yesterday' });
  const groups = classifyRecoveryRecords([legacy, older, unparsable, newer]);
  expect(groups.undoable.map(item => item.requestId)).toEqual(['newer', 'older', 'legacy', 'unparsable']);
  expect(sortByRecency([older, newer]).map(item => item.requestId)).toEqual(['newer', 'older']);
  const attention = classifyRecoveryRecords([
    record({ requestId: 'a', result: unknown('a'), createdAt: '2026-09-22T01:00:00.000Z' }),
    record({ requestId: 'b', result: unknown('b'), createdAt: '2026-09-22T03:00:00.000Z' }),
  ]).attention;
  expect(attention.map(item => item.requestId)).toEqual(['b', 'a']);
});

it('renders settlement, step and time wording without inventing evidence', () => {
  expect(describeResultStatus(record({ requestId: 'x' }))).toBe('中断，需核对');
  expect(describeResultStatus(record({ requestId: 'x', result: settled('x') }))).toBe('已完成');
  expect(describeResultStatus(record({ requestId: 'x', result: settled('x', 'partial') }))).toBe('部分完成');
  expect(
    describeResultStatus(
      record({
        requestId: 'x',
        result: unknown('x'),
        quarantine: { acknowledgedAt: '2026-09-22T00:00:00.000Z', epoch: 'e', observedRevision: 1 },
      }),
    ),
  ).toBe('结果未知 · 已人工隔离（仍未知）');
  expect(describeStep(created('a'))).toBe('新建：有回执，ID native-a');
  expect(describeStep(created('a', 'intent'))).toBe('新建：已发起，未确认');
  expect(describeStep({ step: { type: 'move', id: 'a', parentId: 'root', index: 2 }, state: 'planned' })).toBe(
    '移动：未发起',
  );
  expect(formatOperationTime(undefined)).toBe('时间未知（旧版记录）');
  expect(formatOperationTime('yesterday')).toBe('yesterday');
  expect(formatOperationTime('2026-09-22T01:02:03.000Z')).toContain('2026');
});

it('flattens proposals into readable single commands', () => {
  expect(proposalOperations({ requestId: 'p', command: single.create })).toEqual([{ id: 'p', command: single.create }]);
  const flattened = proposalOperations({ requestId: 'p', command: batch([single.move, single.remove]) });
  expect(flattened.map(operation => operation.id)).toEqual(['op0', 'op1']);
  expect(describeCommand(single.create)).toBe('新建「Saved」（https://saved.test/） → 目录 root');
  expect(describeCommand(single.createFolderAndBookmark)).toBe(
    '新建目录「Reading」并收藏「Saved」（https://saved.test/） → 目录 root',
  );
  expect(describeCommand(single.update)).toBe('修改 a：标题改为「Renamed」');
  expect(describeCommand({ type: 'update', target: ref('a'), changes: { title: 'T', url: 'https://u.test/' } })).toBe(
    '修改 a：标题改为「T」，网址改为「https://u.test/」',
  );
  expect(describeCommand(single.move)).toBe('移动 a → 目录 root 第 1 位');
  expect(describeCommand(single.remove)).toBe('删除 a');
  expect(describeCommand(single.deleteSubtree)).toBe('删除子树 f');
});
