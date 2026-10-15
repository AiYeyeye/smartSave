import {
  describeCommand,
  describeStep,
  describeResultStatus,
  formatOperationTime,
  type SingleCommand,
  type StepEntry,
} from '../domain/recovery-view';
import { summarizeRecovery } from '../domain/recovery-summary';
import type { OperationRecord } from '../persistence/operations';
import type { ConfirmMutation, MutationResult } from '../schemas/messages';
import { translate, translateKnown, type Language } from '../ui/i18n';

export function recoveryStatusText(language: Language, text: string): string {
  if (language === 'zh-CN') return text;
  const capacity = /^估算使用 (\d+|未知) \/ 配额 (\d+|未知) 字节；实际备份事务成功后才可写入。$/.exec(text);
  if (capacity)
    return translate(language, '估算使用 {usage} / 配额 {quota} 字节；实际备份事务成功后才可写入。', {
      usage: translateKnown(language, capacity[1]!),
      quota: translateKnown(language, capacity[2]!),
    });
  const transport = /^传输或响应不可用；写入结果可能未知。请求编号 ([\s\S]*)；刷新并核对日志，不自动重试。$/.exec(text);
  if (transport)
    return translate(language, '传输或响应不可用；写入结果可能未知。请求编号 {id}；刷新并核对日志，不自动重试。', {
      id: transport[1]!,
    });
  const cancel = /^取消未获确认，请求 ([\s\S]*) 结果仍待核对。$/.exec(text);
  if (cancel) return translate(language, '取消未获确认，请求 {id} 结果仍待核对。', { id: cancel[1]! });
  return translateKnown(language, text);
}

export function recoveryResultText(language: Language, record: OperationRecord): string {
  const text = describeResultStatus(record);
  if (language === 'zh-CN') return text;
  const suffix = ' · 已人工隔离（仍未知）';
  return record.quarantine
    ? translate(language, '{status} · 已人工隔离（仍未知）', {
        status: translateKnown(language, text.slice(0, -suffix.length)),
      })
    : translateKnown(language, text);
}

export function recoveryTimeText(language: Language, when: string | undefined): string {
  if (language === 'zh-CN') return formatOperationTime(when);
  if (when === undefined) return translate(language, '时间未知（旧版记录）');
  const parsed = Date.parse(when);
  return Number.isNaN(parsed) ? when : new Date(parsed).toLocaleString(language, { hour12: false });
}

export function recoveryStepText(language: Language, entry: StepEntry): string {
  if (language === 'zh-CN') return describeStep(entry);
  const type = { create: '新建', update: '修改', move: '移动', remove: '删除' } as const;
  const state = { planned: '未发起', intent: '已发起，未确认', receipt: '有回执' } as const;
  return translate(language, '{action}：{state}{identity}', {
    action: translate(language, type[entry.step.type]),
    state: translate(language, state[entry.state]),
    identity: entry.returnedNativeId ? translate(language, '，ID {id}', { id: entry.returnedNativeId }) : '',
  });
}

/** Format structured commands, never parse or translate embedded native titles, URLs or IDs. */
export function recoveryCommandText(language: Language, command: SingleCommand): string {
  if (language === 'zh-CN') return describeCommand(command);
  switch (command.type) {
    case 'create':
      return translate(language, '新建「{title}」{url} → 目录 {parent}', {
        title: command.title,
        url: command.url ? ` (${command.url})` : '',
        parent: command.parent.nativeId,
      });
    case 'createFolderAndBookmark':
      return translate(language, '新建目录「{folder}」并收藏「{title}」（{url}） → 目录 {parent}', {
        folder: command.folderTitle,
        title: command.title,
        url: command.url,
        parent: command.parent.nativeId,
      });
    case 'update': {
      const changes = [
        command.changes.title !== undefined
          ? translate(language, '标题改为「{value}」', { value: command.changes.title })
          : undefined,
        command.changes.url !== undefined
          ? translate(language, '网址改为「{value}」', { value: command.changes.url })
          : undefined,
      ]
        .filter(value => value !== undefined)
        .join(', ');
      return translate(language, '修改 {id}：{changes}', { id: command.target.nativeId, changes });
    }
    case 'move':
      return translate(language, '移动 {id} → 目录 {parent} 第 {index} 位', {
        id: command.target.nativeId,
        parent: command.parent.nativeId,
        index: command.index + 1,
      });
    case 'remove':
      return translate(language, '删除 {id}', { id: command.target.nativeId });
    case 'deleteSubtree':
      return translate(language, '删除子树 {id}', { id: command.target.nativeId });
  }
}

/** Coverage is shown separately from execution status. The domain helper still owns the incomplete/error flag. */
export function recoverySummaryText(
  language: Language,
  result: MutationResult,
  recovery?: ConfirmMutation['recovery'],
): string {
  if (language === 'zh-CN') return summarizeRecovery(result, recovery).text;
  const conflicts = recovery?.conflicts;
  const coverage =
    recovery === undefined
      ? ''
      : conflicts === undefined
        ? translate(language, '恢复覆盖范围未知（旧版记录），不代表完整恢复。')
        : conflicts.length
          ? translate(language, '恢复未完整：保留 / 跳过 {count} 项；{details}。', {
              count: conflicts.length,
              details: conflicts.map(c => `${c.nativeId}: ${c.reason}`).join('; '),
            })
          : translate(language, '恢复预览无跳过项。');
  return translate(
    language,
    '{id}：执行子计划 {status}；已完成 {completed}，剩余 {remaining}；{reason}。{coverage}未知结果不会自动重试。',
    {
      id: result.requestId,
      status: result.status,
      completed: result.completedSteps,
      remaining: result.remainingSteps,
      reason: result.reason ?? '',
      coverage,
    },
  );
}
