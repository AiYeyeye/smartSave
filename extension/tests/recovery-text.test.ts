import { expect, it } from 'vitest';
import {
  recoveryCommandText,
  recoveryStatusText,
  recoveryStepText,
  recoverySummaryText,
  recoveryTimeText,
} from '../options/recovery-text';
import type { SingleCommand } from '../domain/recovery-view';

const parent = { installationId: 'i', nativeId: '目录{title}', kind: 'folder' } as const;
const target = { ...parent, nativeId: '删除{id}', kind: 'bookmark' } as const;
it('formats every recovery command while preserving native text and placeholder-like values', () => {
  const commands: [SingleCommand, string[]][] = [
    [
      { type: 'create', parent, title: '确认 {parent}', url: 'https://example.test/标题' },
      ['Create', '确认 {parent}', 'https://example.test/标题', parent.nativeId],
    ],
    [
      { type: 'createFolderAndBookmark', parent, folderTitle: '删除', title: '{folder}', url: 'https://example.test/' },
      ['Create folder “删除”', '“{folder}”', parent.nativeId],
    ],
    [
      { type: 'update', target, changes: { title: '确认 {changes}', url: 'https://example.test/' } },
      ['Update', target.nativeId, '确认 {changes}', 'https://example.test/'],
    ],
    [{ type: 'move', target, parent, index: 2 }, ['Move', target.nativeId, parent.nativeId, 'position 3']],
    [{ type: 'remove', target }, ['Delete', target.nativeId]],
    [{ type: 'deleteSubtree', target: parent }, ['Delete subtree', parent.nativeId]],
  ];
  for (const [command, literals] of commands) {
    const text = recoveryCommandText('en', command);
    for (const literal of literals) expect(text).toContain(literal);
  }
});
it('keeps diagnostics literal and distinguishes successful execution from incomplete restoration', () => {
  const result = {
    requestId: '请求{id}',
    status: 'completed' as const,
    completedSteps: 1,
    remainingSteps: 0,
    needsReconcile: false,
    reason: '诊断{coverage}',
  };
  const source = { sourceRequestId: 'source', mode: 'undo' as const };
  expect(recoverySummaryText('en', result, source)).toContain('Recovery coverage is unknown');
  const skipped = recoverySummaryText('en', result, {
    ...source,
    conflicts: [{ nativeId: target.nativeId, reason: '标题{reason}' }],
  });
  for (const literal of [
    'execution subplan completed',
    'Restoration incomplete',
    result.requestId,
    result.reason,
    '删除{id}: 标题{reason}',
  ])
    expect(skipped).toContain(literal);
  expect(recoverySummaryText('en', result, { ...source, conflicts: [] })).toContain('no skipped items');
  expect(recoveryStatusText('en', '未知诊断{usage}')).toBe('未知诊断{usage}');
  expect(recoveryStatusText('en', '估算使用 12 / 配额 未知 字节；实际备份事务成功后才可写入。')).toContain(
    '12 / quota: Unknown',
  );
  expect(recoveryTimeText('en', undefined)).toBe('Time unknown (legacy record)');
  expect(recoveryTimeText('en', '损坏日期')).toBe('损坏日期');
  expect(recoveryStepText('en', { step: { type: 'remove', id: 'n' }, state: 'intent' })).toContain(
    'Issued, not confirmed',
  );
});
