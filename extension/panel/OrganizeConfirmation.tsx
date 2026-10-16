import type { OrganizeState } from '../domain/organize-state';
import type { organizeReview } from '../domain/organize-review';
import type { OrganizeWorkbenchOwner } from './organize-task-client';
import { useI18n } from '../ui/i18n';
import { organizeStatusText } from './organize-status-text';
import { MutationFeedback } from './BookmarkActions';

type Props = {
  state: OrganizeState;
  step: number;
  setStep: (step: number) => void;
  method: 'ai' | 'duplicates';
  memoryBusy: boolean;
  proposalPaths: Map<string, string>;
  review: ReturnType<typeof organizeReview> | undefined;
  preferenceReady: boolean;
  batchSizeValid: boolean;
  scopeProtected: boolean;
  generate: () => void;
  commands: Pick<OrganizeWorkbenchOwner, 'repairBatches' | 'resumeBatches' | 'confirmFolders' | 'apply' | 'observe'>;
};
/** Explicit phase navigation and final write confirmation. No effect may dispatch these commands. */
export function OrganizeConfirmation({
  state,
  step,
  setStep,
  method,
  memoryBusy,
  proposalPaths,
  review,
  preferenceReady,
  batchSizeValid,
  scopeProtected,
  generate,
  commands,
}: Props) {
  const { t, language } = useI18n();
  const statusText = (text: string) => organizeStatusText(language, text);
  const proposal = state.proposal;
  const folderReview = state.pipeline?.stage === 'folders';
  const batchIncomplete = !!state.pipeline && state.pipeline.stage !== 'complete';
  return (
    <>
      {step === 3 && !state.result && !state.task?.requestId && (
        <>
          <p className="workflow-summary">
            {t('整理目录：{path} · 已选 {count} 项操作', {
              path: proposalPaths.get(proposal?.scope.nativeId ?? '') ?? '',
              count: state.selected.length,
            })}
          </p>
          <p>{t('确认后将修改浏览器书签，写入前会自动备份。删除和合并操作也会执行，请确认上一步的选择。')}</p>
        </>
      )}
      {state.result && <MutationFeedback result={state.result} />}
      <div
        hidden={!!state.task?.requestId && !state.result}
        className={`workflow-footer${method === 'ai' ? ' organize-footer' : ''}`}
      >
        {!state.busy && !state.result && !state.failure && (
          <p
            className="organize-footer-status"
            role={state.invalid && !state.failure ? 'alert' : 'status'}
            aria-live="polite"
          >
            {statusText(
              state.failure && !state.busy
                ? t('本次未生成完整方案，不能进入确认步骤。书签未修改，请按上方提示调整后重试。')
                : state.busy && state.pipeline?.stage === 'bookmarks'
                  ? t('可以查看已完成批次；后台继续生成后续建议，全部完成后才能确认执行。')
                  : state.busy
                    ? state.progress
                      ? t('方案尚未完成，收到完整方案并校验后才能继续。')
                      : state.message
                    : memoryBusy
                      ? t('正在读取或保存整理偏好…')
                      : review?.error
                        ? review.error
                        : proposal &&
                            !folderReview &&
                            !state.invalid &&
                            proposal.actions.length > 0 &&
                            !state.selected.length
                          ? t('方案已生成，请至少勾选一项建议后继续。')
                          : state.message,
            )}
          </p>
        )}
        {state.pipeline?.stage === 'bookmarks' &&
          !state.busy &&
          !state.invalid &&
          ['paused', 'failed'].includes(state.pipeline.status) && (
            <>
              {state.repair && (
                <>
                  <p>
                    {t('本批暂存 {retained} 条有效结果，另有 {count} 条待补问。后台重启后，本批需重新生成。', {
                      retained: state.repair.retained,
                      count: state.repair.count,
                    })}
                  </p>
                  <button
                    className="primary"
                    disabled={state.tree.status !== 'ready' || memoryBusy}
                    onClick={() => void commands.repairBatches()}
                  >
                    {t('只补问这 {count} 条', { count: state.repair.count })}
                  </button>
                </>
              )}
              <button
                className={state.repair ? undefined : 'primary'}
                disabled={state.tree.status !== 'ready' || memoryBusy}
                onClick={() => void commands.resumeBatches()}
              >
                {state.repair ? t('重新生成未完成批次') : t('继续未完成批次')}
              </button>
            </>
          )}
        {method === 'ai' && !state.busy && !state.result && (!proposal || state.invalid) && (
          <button
            className={state.failure?.code === 'output-limit' ? undefined : 'primary'}
            disabled={
              state.tree.status !== 'ready' || !preferenceReady || !batchSizeValid || memoryBusy || scopeProtected
            }
            onClick={() => {
              setStep(2);
              generate();
            }}
          >
            {t('重新生成方案')}
          </button>
        )}
        <button
          className={state.failure?.code === 'output-limit' ? 'primary' : undefined}
          disabled={state.busy}
          onClick={() => setStep(step === 3 && !state.result ? 2 : 1)}
        >
          {state.result ? t('开始新的整理') : state.failure?.code === 'output-limit' ? t('缩小整理范围') : t('上一步')}
        </button>
        {!state.result &&
          (step === 2 && folderReview ? (
            <button
              className="primary"
              disabled={state.busy || state.invalid || memoryBusy || !!review?.error || !proposal}
              onClick={() => void commands.confirmFolders()}
            >
              {t('确认分类，开始分批整理书签')}
            </button>
          ) : step === 2 ? (
            <button
              className="primary"
              disabled={
                state.busy ||
                state.invalid ||
                batchIncomplete ||
                memoryBusy ||
                !!review?.error ||
                !proposal ||
                !state.selected.length
              }
              onClick={() => setStep(3)}
            >
              {t('下一步：确认操作')}
            </button>
          ) : (
            <button
              className="primary"
              disabled={
                state.busy ||
                state.invalid ||
                batchIncomplete ||
                memoryBusy ||
                !!review?.error ||
                !state.selected.length ||
                !proposal
              }
              onClick={() => void commands.apply()}
            >
              {t('确认并执行 {count} 项操作', { count: state.selected.length })}
            </button>
          ))}
      </div>
      {state.task?.requestId && !state.busy && (!state.result || state.result.needsReconcile) && (
        <button disabled={state.busy} onClick={() => void commands.observe?.(true)}>
          {t('核对这次整理的执行结果')}
        </button>
      )}
    </>
  );
}
