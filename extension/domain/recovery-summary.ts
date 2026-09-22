import type { ConfirmMutation, MutationResult } from '../schemas/messages';

/** Executed-step completion is not evidence that the whole recovery was covered. */
export function summarizeRecovery(result: MutationResult, recovery?: ConfirmMutation['recovery']) {
  const conflicts = recovery?.conflicts;
  const incomplete =
    result.status !== 'completed' || (recovery !== undefined && (conflicts === undefined || conflicts.length > 0));
  const coverage =
    recovery === undefined
      ? ''
      : conflicts === undefined
        ? '恢复覆盖范围未知（旧版记录），不代表完整恢复。'
        : conflicts.length
          ? `恢复未完整：保留 / 跳过 ${conflicts.length} 项；${conflicts.map(c => `${c.nativeId}：${c.reason}`).join('；')}。`
          : '恢复预览无跳过项。';
  return {
    incomplete,
    text: `${result.requestId}：执行子计划 ${result.status}；已完成 ${result.completedSteps}，剩余 ${result.remainingSteps}；${result.reason ?? ''}。${coverage}未知结果不会自动重试。`,
  };
}
