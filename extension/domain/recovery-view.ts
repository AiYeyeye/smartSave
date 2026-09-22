/**
 * Presentation-only view of the recovery journal: pure functions, zero chrome/DOM dependencies.
 *
 * Persisted requests carry no `origin` field today, so an AI-driven batch and a manual batch are
 * indistinguishable here; kinds are derived from the command shape alone. When automatic
 * classification lands, durable requests should gain an explicit origin marker (for example
 * `origin: 'ai' | 'manual' | 'import'`) and this module should prefer that marker over shape.
 */
import type { OperationRecord } from '../persistence/operations';
import type { Command, ConfirmMutation } from '../schemas/messages';

export type OperationKind = '收藏' | '编辑' | '移动' | '删除' | '整理批次' | '导入批次' | '批量操作' | '恢复操作';
export type OperationDescription = { kind: OperationKind; steps: number; receipts: number; when?: string };
export type StepEntry = OperationRecord['steps'][number];

const resultStatusLabels: Record<NonNullable<OperationRecord['result']>['status'], string> = {
  completed: '已完成',
  partial: '部分完成',
  failed: '失败',
  rejected: '已拒绝',
  unknown: '结果未知',
};
const stepTypeLabels: Record<StepEntry['step']['type'], string> = {
  create: '新建',
  update: '修改',
  move: '移动',
  remove: '删除',
};
const stepStateLabels: Record<StepEntry['state'], string> = {
  planned: '未发起',
  intent: '已发起，未确认',
  receipt: '有回执',
};

/** Settlement wording for one record; quarantine is an acknowledgement, never a completion, so it is appended rather than substituted. */
export function describeResultStatus(record: OperationRecord): string {
  const base = record.result ? resultStatusLabels[record.result.status] : '中断，需核对';
  return record.quarantine ? `${base} · 已人工隔离（仍未知）` : base;
}

export function describeStep(entry: StepEntry): string {
  const suffix = entry.returnedNativeId ? `，ID ${entry.returnedNativeId}` : '';
  return `${stepTypeLabels[entry.step.type]}：${stepStateLabels[entry.state]}${suffix}`;
}
export type RecoveryGroups = {
  /** Unknown or unsettled outcome (no result, or result still needs reconcile) that nobody has quarantined yet. */
  attention: OperationRecord[];
  /** Settled with at least one receipt, not itself a recovery, and not yet used as a recovery source. */
  undoable: OperationRecord[];
  /** Everything else: quarantined, already undone/restored sources, recovery operations, rejected/failed batches. */
  history: OperationRecord[];
};

export type SingleCommand = Exclude<Command, { type: 'batch' }>;
type BatchCommand = Extract<Command, { type: 'batch' }>;
export type ProposalOperation = { id: string; command: SingleCommand };

const changeLabels = { title: '标题', url: '网址' } as const;

/** One-line, user-facing wording of a proposed single command; ids stay visible because they are the only stable evidence. */
export function describeCommand(command: SingleCommand): string {
  switch (command.type) {
    case 'create':
      return `新建「${command.title}」${command.url ? `（${command.url}）` : ''} → 目录 ${command.parent.nativeId}`;
    case 'createFolderAndBookmark':
      return `新建目录「${command.folderTitle}」并收藏「${command.title}」（${command.url}） → 目录 ${command.parent.nativeId}`;
    case 'update': {
      const changes = Object.entries(command.changes)
        .filter((entry): entry is [keyof typeof changeLabels, string] => entry[1] !== undefined)
        .map(([field, value]) => `${changeLabels[field]}改为「${value}」`)
        .join('，');
      return `修改 ${command.target.nativeId}：${changes}`;
    }
    case 'move':
      return `移动 ${command.target.nativeId} → 目录 ${command.parent.nativeId} 第 ${command.index + 1} 位`;
    case 'remove':
      return `删除 ${command.target.nativeId}`;
    case 'deleteSubtree':
      return `删除子树 ${command.target.nativeId}`;
  }
}

/** Flattens a proposal to its single commands so the preview lists batch and single proposals alike. */
export function proposalOperations(proposal: Pick<ConfirmMutation, 'requestId' | 'command'>): ProposalOperation[] {
  const { command } = proposal;
  if (command.type === 'batch')
    return command.operations.map(operation => ({ id: operation.id, command: operation.command }));
  return [{ id: proposal.requestId, command }];
}

const createTypes: ReadonlySet<SingleCommand['type']> = new Set(['create', 'createFolderAndBookmark']);
const removeTypes: ReadonlySet<SingleCommand['type']> = new Set(['remove', 'deleteSubtree']);

function singleKind(type: SingleCommand['type']): OperationKind {
  switch (type) {
    case 'create':
    case 'createFolderAndBookmark':
      return '收藏';
    case 'update':
      return '编辑';
    case 'move':
      return '移动';
    case 'remove':
    case 'deleteSubtree':
      return '删除';
  }
}

/** Only selected operations execute; unselected entries never describe what the batch did. */
function batchKind(command: BatchCommand): OperationKind {
  const selected = new Set(command.selectedOperationIds);
  const chosen = command.operations.filter(operation => selected.has(operation.id));
  const types = (chosen.length ? chosen : command.operations).map(operation => operation.command.type);
  const hasMove = types.includes('move');
  const hasCreate = types.some(type => createTypes.has(type));
  const hasRemove = types.some(type => removeTypes.has(type));
  if (hasMove || (hasRemove && hasCreate)) return '整理批次';
  if (types.every(type => createTypes.has(type))) return '导入批次';
  return '批量操作';
}

export function describeOperation(record: OperationRecord): OperationDescription {
  const { command, recovery } = record.request;
  const kind = recovery ? '恢复操作' : command.type === 'batch' ? batchKind(command) : singleKind(command.type);
  return {
    kind,
    steps: record.steps.length,
    receipts: record.steps.filter(step => step.state === 'receipt').length,
    when: record.createdAt,
  };
}

/** Same definition the coordinator uses to gate new writes: no result or a result that still needs reconcile, unless quarantined. */
export function isUnsettled(record: OperationRecord): boolean {
  return (!record.result || record.result.needsReconcile) && !record.quarantine;
}

function isUndoable(record: OperationRecord, restoredSources: ReadonlySet<string>): boolean {
  const { result } = record;
  if (!result || result.needsReconcile || record.quarantine) return false;
  if (result.status !== 'completed' && result.status !== 'partial') return false;
  if (record.request.recovery) return false;
  if (restoredSources.has(record.requestId)) return false;
  return record.steps.some(step => step.state === 'receipt');
}

function stamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Newest first; records without a parseable createdAt (legacy) sort last, keeping their relative order. */
export function sortByRecency(records: readonly OperationRecord[]): OperationRecord[] {
  return [...records].sort((a, b) => {
    const left = stamp(a.createdAt);
    const right = stamp(b.createdAt);
    if (left === right) return 0;
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    return right - left;
  });
}

export function classifyRecoveryRecords(records: readonly OperationRecord[]): RecoveryGroups {
  const restoredSources = new Set(
    records.flatMap(record => (record.request.recovery ? [record.request.recovery.sourceRequestId] : [])),
  );
  const attention: OperationRecord[] = [];
  const undoable: OperationRecord[] = [];
  const history: OperationRecord[] = [];
  for (const record of records) {
    if (isUnsettled(record)) attention.push(record);
    else if (isUndoable(record, restoredSources)) undoable.push(record);
    else history.push(record);
  }
  return { attention: sortByRecency(attention), undoable: sortByRecency(undoable), history: sortByRecency(history) };
}

/** Legacy records have no createdAt; an unparseable stamp is shown verbatim rather than invented. */
export function formatOperationTime(when: string | undefined): string {
  if (when === undefined) return '时间未知（旧版记录）';
  const parsed = Date.parse(when);
  if (Number.isNaN(parsed)) return when;
  return new Date(parsed).toLocaleString('zh-CN', { hour12: false });
}
