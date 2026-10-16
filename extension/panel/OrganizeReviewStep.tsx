import type { ReactNode } from 'react';
import type { OrganizeState } from '../domain/organize-state';
import { actionDependencies, type OrganizeAction } from '../domain/organize-proposal';
import type { organizeReview } from '../domain/organize-review';
import type { OrganizeMemory } from '../persistence/organize-memory';
import type { OrganizeWorkbenchOwner } from './organize-task-client';
import type { OrganizeMemoryEditor } from './organize-workbench-view';
import { useI18n } from '../ui/i18n';
import { Select } from '../ui/Select';
import { DuplicateReview } from './DuplicateReview';
import { OrganizeTreePreview } from './OrganizeTreePreview';
import { OrganizeFlowDetails } from './OrganizeFlowDetails';
import { OrganizeTargetReview } from './OrganizeTargetReview';
import { organizeActionReason, organizeActionNames as actionNames } from './organize-action-text';

type Props = {
  hidden: boolean;
  state: OrganizeState;
  method: 'ai' | 'duplicates';
  memory: OrganizeMemory;
  memoryBusy: boolean;
  currentPaths: Map<string, string>;
  proposalPaths: Map<string, string>;
  targetLabels: Map<string, string>;
  targetOptions: ReactNode;
  review: ReturnType<typeof organizeReview> | undefined;
  bookmarkMoves: OrganizeAction[];
  ignoredActions: OrganizeAction[];
  rejectionKeys: Map<string, string>;
  duplicateChoicesReady: boolean;
  changeMemory: OrganizeMemoryEditor;
  rememberRejection: (action: OrganizeAction) => Promise<void>;
  commands: Pick<OrganizeWorkbenchOwner, 'choice' | 'previewDuplicates' | 'toggle' | 'toggleMany' | 'target'>;
};
/** Review views share selection/target authority; hiding a step keeps its disclosure state mounted. */
export function OrganizeReviewStep({
  hidden,
  state,
  method,
  memory,
  memoryBusy,
  currentPaths,
  proposalPaths,
  targetLabels,
  targetOptions,
  review,
  bookmarkMoves,
  ignoredActions,
  rejectionKeys,
  duplicateChoicesReady,
  changeMemory,
  rememberRejection,
  commands,
}: Props) {
  const { t, message, language } = useI18n();
  const proposal = state.proposal;
  const folderReview = state.pipeline?.stage === 'folders';
  const locked = (id: string) => state.pipeline?.lockedActionIds.includes(id) ?? false;
  return (
    <div hidden={hidden || !!state.result}>
      <DuplicateReview
        groups={state.duplicates}
        choices={state.choices}
        paths={currentPaths}
        disabled={state.busy || state.invalid}
        onChoice={(id, choice) => commands.choice(id, choice)}
      />
      {!!state.duplicates.length && !proposal && (
        <button
          className="primary"
          disabled={state.busy || state.invalid || !duplicateChoicesReady}
          onClick={() => void commands.previewDuplicates()}
        >
          {t('生成去重预览')}
        </button>
      )}
      {!!state.duplicates.length && !proposal && !duplicateChoicesReady && (
        <p className="hint">{t('选择要删除的重复项，并为同组书签指定至少一项保留。')}</p>
      )}
      {proposal && (
        <article>
          <h3>{t('本次整理：{path}', { path: proposalPaths.get(proposal.scope.nativeId) ?? '' })}</h3>
          {!state.invalid && review?.tree && (
            <details className="organize-review-section" open>
              <summary>{t('完整分类树与内容去向')}</summary>
              <OrganizeTreePreview proposal={proposal} after={review.tree} selected={state.selected} />
              <OrganizeFlowDetails proposal={proposal} after={review.tree} />
            </details>
          )}
          {review?.error && <p role="alert">{message(review.error)}</p>}
          {state.invalid && <p role="alert">{t('此方案已失效，请重新生成；下方仅保留旧建议供核对。')}</p>}
          <p className="workflow-summary">
            {t('已选 {count} / {total} 项建议', { count: state.selected.length, total: proposal.actions.length })}
          </p>
          {method === 'ai' && (
            <OrganizeTargetReview
              proposal={proposal}
              actions={bookmarkMoves}
              selected={state.selected}
              targets={state.targets}
              targetLabels={targetLabels}
              targetOptions={targetOptions}
              disabled={state.busy || state.invalid || !!state.result}
              rejectDisabled={memoryBusy}
              reject={rememberRejection}
              toggle={(id, value) => commands.toggle(id, value)}
              toggleMany={(ids, value) => commands.toggleMany(ids, value)}
              target={(id, value) => commands.target(id, value)}
            />
          )}
          <details className="organize-review-section" open={folderReview}>
            <summary>
              {t('目录变更与其他操作 · {count} 项', {
                count: proposal.actions.filter(
                  action => !bookmarkMoves.includes(action) && !ignoredActions.includes(action),
                ).length,
              })}
            </summary>
            <section className="organize-adjustments" aria-label={t('详细调整方案')}>
              {!!ignoredActions.length && (
                <details className="workflow-help">
                  <summary>
                    {t('已按你的记录忽略 {count} 条建议（含关联操作）', { count: ignoredActions.length })}
                  </summary>
                  {ignoredActions.map(action => (
                    <p key={action.id}>
                      {action.title}
                      {memory.rejected.some(r => r.signature === rejectionKeys.get(action.id)) ? (
                        <button
                          disabled={state.busy || memoryBusy}
                          onClick={() =>
                            void changeMemory(value => ({
                              ...value,
                              rejected: value.rejected.filter(r => r.signature !== rejectionKeys.get(action.id)),
                            }))
                          }
                        >
                          {t('恢复此建议')}
                        </button>
                      ) : (
                        <small>{t('随前置建议一同忽略；恢复前置建议后可重新选择。')}</small>
                      )}
                    </p>
                  ))}
                </details>
              )}
              {proposal.actions
                .filter(action => !ignoredActions.includes(action) && !bookmarkMoves.includes(action))
                .map(action => (
                  <div className="workflow-review-row" key={action.id}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={t('选择 {title}', { title: action.id })}
                        checked={state.selected.includes(action.id)}
                        disabled={state.busy || state.invalid || !!state.result || locked(action.id)}
                        onChange={e => commands.toggle(action.id, e.target.checked)}
                      />
                      {message(actionNames[action.kind])}：{action.title}
                    </label>
                    <p>
                      {t('当前路径：{path}', {
                        path: action.kind === 'create' ? t('新建目录') : (proposalPaths.get(action.sourceId) ?? ''),
                      })}
                    </p>
                    <div className="organize-reason">
                      <p>
                        {t('建议理由：{reason}', {
                          reason: organizeActionReason(language, action, proposal),
                        })}
                      </p>
                      {method === 'ai' && (
                        <button
                          className="organize-reject"
                          title={t('记住此选择，以后不再建议这个操作；仅本次不采用请取消勾选')}
                          disabled={state.busy || state.invalid || !!state.result || memoryBusy || locked(action.id)}
                          onClick={() => rememberRejection(action)}
                        >
                          {t('不再建议')}
                        </button>
                      )}
                    </div>
                    {action.newTitle && (
                      <p>
                        {t('名称：')}
                        {action.title} → <strong>{action.newTitle}</strong>
                      </p>
                    )}
                    {!!actionDependencies(proposal, action, state.targets).length && (
                      <p className="hint">
                        {t('需要同时选择：')}
                        {actionDependencies(proposal, action, state.targets)
                          .map(id => proposal.actions.find(a => a.id === id)?.title ?? id)
                          .join(language === 'en' ? ', ' : '、')}
                      </p>
                    )}
                    {action.targetId && (
                      <label>
                        {t('建议目标')}
                        <Select
                          aria-label={t('{id} 目标', { id: action.id })}
                          disabled={state.busy || state.invalid || !!state.result || locked(action.id)}
                          value={state.targets[action.id] ?? action.targetId}
                          onChange={e => commands.target(action.id, e.target.value)}
                        >
                          {targetOptions}
                        </Select>
                      </label>
                    )}
                    {action.kind === 'merge' && (
                      <>
                        <p>
                          {t(
                            '先迁移下列直接子项（包含其内容），然后仅移除空目录：{title}。任何新增子项都将导致停止。',
                            { title: action.title },
                          )}
                        </p>
                        <ul>
                          {action.children.map(id => (
                            <li key={id}>{proposalPaths.get(id)}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                ))}
            </section>
          </details>
        </article>
      )}
    </div>
  );
}
