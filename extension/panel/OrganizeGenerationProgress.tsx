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
          <OrganizeTiming pipeline={state.pipeline} />
          {folderReview ? (
            <>
              <p>
                {t('整理范围共 {total} 条书签；每批最多 {size} 条。', {
                  total: state.pipeline.total,
                  size: state.pipeline.batchSize,
                })}
              </p>
              <p>
                {t('当前先规划 {count} 个目录的分类结构，仅发送目录信息、书签数量和少量标题样本。', {
                  count: state.pipeline.folderCount,
                })}
              </p>
              <p className="hint">{t('确认分类后才逐批分析书签去向，内容过长会继续拆小。当前尚未开始书签批次。')}</p>
            </>
          ) : (
            <>
              <p role="status" aria-live="polite">
                {t('已完成 {finished} / {batches} 批，已分析 {analyzed} / {total} 条书签。', {
                  finished: state.pipeline.finished.length,
                  batches: state.pipeline.batchCount,
                  analyzed: state.pipeline.analyzed ?? state.pipeline.completed,
                  total: state.pipeline.total,
                })}
              </p>
              <p className="hint">
                {t('分类结构已固定。下方显示已完成批次的预览；全部批次完成并由你确认后才修改书签。')}
              </p>
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
          {state.failure.outputTokenLimit !== undefined && (
            <p>
              {t('本次请求的模型输出上限：{limit} tokens（包含推理和正文）。', {
                limit: state.failure.outputTokenLimit.toLocaleString('en-US'),
              })}
            </p>
          )}
          {state.failure.code === 'output-limit' && <a href="#ai-services">{t('调整模型输出上限')}</a>}
          <details>
            <summary>{t('错误详情')}</summary>
            <p>
              {t('错误代码：')}
              <code>{state.failure.code}</code>
              {t('。反馈问题时可附上此代码和调试日志。')}
            </p>
          </details>
        </section>
      )}
      {state.busy && state.progress && (
        <section className="organize-progress" aria-label={t('生成中的建议')}>
          <p className="hint">
            {folderReview
              ? t('文件夹分类阶段')
              : t('{scope} {count} 条书签', {
                  scope: t(state.pipeline ? '当前批次' : '本次参与整理'),
                  count: state.progress.bookmarkCount,
                })}
            {t(
              '，连接或连续无流数据的等待上限 {seconds} 秒；持续收到数据会继续等待。非流式响应按总时间限制。这是超时上限，实际完成后即可继续，无需等满；可随时停止。',
              { seconds: state.progress.timeoutSeconds },
            )}
          </p>
          {state.progress.outputTokenLimit !== undefined && (
            <p className="hint">
              {t('本次模型输出上限：{limit} tokens（包含推理和正文）。', {
                limit: state.progress.outputTokenLimit.toLocaleString('en-US'),
              })}
            </p>
          )}
          {!state.progress.streaming && <p className="hint">{t('当前服务按完整响应返回，完成后显示方案。')}</p>}
          {!!state.progress.preview.length && (
            <>
              <h4>{t('正在生成的建议')}</h4>
              <ul>
                {state.progress.preview.map((text, index) => (
                  <li key={index}>{organizePreviewText(language, text)}</li>
                ))}
              </ul>
              <p className="hint">{t('先预览部分建议；完整方案返回并检查后，才能选择和确认执行。')}</p>
            </>
          )}
        </section>
      )}
    </>
  );
}
