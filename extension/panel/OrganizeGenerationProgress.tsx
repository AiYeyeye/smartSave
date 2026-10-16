import type { OrganizeState } from '../domain/organize-state';
import { useI18n } from '../ui/i18n';
import { BusyIndicator } from '../ui/BusyIndicator';
import { OrganizeTiming } from './OrganizeTiming';
import { organizeStatusText, organizePreviewText } from './organize-status-text';
import { organizeActionReason } from './organize-action-text';

/** Folder planning and bookmark-batch progress share one frozen state projection. */
export function OrganizeGenerationProgress({
  state,
  returnToFolders,
}: {
  state: OrganizeState;
  returnToFolders: () => void;
}) {
  const { t, language } = useI18n();
  const statusText = (text: string) => organizeStatusText(language, text);
  const folderReview = state.pipeline?.stage === 'folders';
  const proposal = state.proposal;
  return (
    <>
      {state.pipeline && (
        <section className="organize-batches" aria-label={t('分阶段整理进度')}>
          {state.busy && <OrganizeTiming pipeline={state.pipeline} />}
          {folderReview ? null : (
            <>
              <p role="status" aria-live="polite">
                {t('已完成 {finished} / {batches} 批，已分析 {analyzed} / {total} 条书签。', {
                  finished: state.pipeline.finished.length,
                  batches: state.pipeline.batchCount,
                  analyzed: state.pipeline.analyzed ?? state.pipeline.completed,
                  total: state.pipeline.total,
                })}
              </p>
              {!!state.pipeline.finished.length && (
                <details className="workflow-help">
                  <summary>{t('分阶段整理进度')}</summary>
                  <ol>
                    {state.pipeline.finished.map((batch, index) => (
                      <li key={index}>
                        <details>
                          <summary>
                            {t('第 {batch} 批已完成 · {count} 条书签 · {actions} 条变更建议', {
                              batch: index + 1,
                              count: batch.count,
                              actions: batch.actionIds.length,
                            })}
                          </summary>
                          {batch.actionIds.length ? (
                            <ul>
                              {batch.actionIds.map(id => {
                                const action = proposal?.actions.find(a => a.id === id);
                                return (
                                  <li key={id}>
                                    {action?.title}：
                                    {action && proposal ? organizeActionReason(language, action, proposal) : ''}（
                                    {state.selected.includes(id) ? t('已选') : t('未选')}）
                                  </li>
                                );
                              })}
                            </ul>
                          ) : (
                            <p>{t('此批书签保持确认后的目录位置。')}</p>
                          )}
                        </details>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              {!state.busy && !state.invalid && !state.result && (
                <button
                  onClick={() => {
                    returnToFolders();
                  }}
                >
                  {t('更改文件夹方案并重新分析书签')}
                </button>
              )}
            </>
          )}
        </section>
      )}
      {state.busy && <BusyIndicator label={statusText(state.message)} />}
      {state.failure && !state.busy && (
        <section className="organize-failure" role="alert" aria-label={t('整理未完成')}>
          <h3>{t('整理未完成')}</h3>
          <p>{statusText(state.message)}</p>
          {state.failure.code === 'output-limit' && <a href="#ai-services">{t('调整模型输出上限')}</a>}
          <details>
            <summary>{t('错误详情')}</summary>
            <p className="hint">
              {state.failure.bookmarkCount !== undefined &&
                t('{scope} {count} 条书签 · ', {
                  scope: t(folderReview ? '整理范围共' : state.pipeline ? '当前批次' : '本次参与整理'),
                  count: state.failure.bookmarkCount,
                })}
              {t('耗时 {seconds} 秒 · 失败阶段：', { seconds: state.failure.elapsedSeconds })}
              {folderReview && state.failure.phase !== '书签请求准备' ? t('文件夹分类 · ') : ''}
              {t(state.failure.phase)}
            </p>
            {state.failure.outputTokenLimit !== undefined &&
              ['output-limit', 'incomplete'].includes(state.failure.code) && (
                <p>
                  {t('本次请求的模型输出上限：{limit} tokens（包含推理和正文）。', {
                    limit: state.failure.outputTokenLimit.toLocaleString('en-US'),
                  })}
                </p>
              )}
            <p>
              {t('错误代码：')}
              <code>{state.failure.code}</code>
              {t('。反馈问题时可附上此代码和调试日志。')}
            </p>
          </details>
        </section>
      )}
      {state.busy && state.progress && state.progress.preview.length > 0 && (
        <section className="organize-progress" aria-label={t('生成中的建议')}>
          {!!state.progress.preview.length && (
            <>
              <h4>{t('正在生成的建议')}</h4>
              <ul>
                {state.progress.preview.map((text, index) => (
                  <li key={index}>{organizePreviewText(language, text)}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </>
  );
}
