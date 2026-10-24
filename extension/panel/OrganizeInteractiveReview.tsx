import { useState } from 'react';
import type { OrganizeState } from '../domain/organize-state';
import type { OrganizeInteraction } from '../domain/organize-interaction';
import { useI18n } from '../ui/i18n';
import { Select } from '../ui/Select';

export function OrganizeInteractiveReview({
  state,
  targets,
  review,
}: {
  state: OrganizeState;
  targets: Map<string, string>;
  review: (edit: OrganizeInteraction) => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<string[]>([]);
  const [destination, setDestination] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [page, setPage] = useState(0);
  const [uncertainPage, setUncertainPage] = useState(0);
  const [query, setQuery] = useState('');
  if (!state.pipeline?.contentPhase || !state.proposal || !state.pipeline.completedIds?.length) return null;
  const completed = new Set(state.pipeline.completedIds);
  const uncertain = new Set(state.pipeline.uncertainIds);
  const reviewed = new Set(state.pipeline.reviewedIds);
  const reclassifying = new Set(state.pipeline.reclassifyingIds);
  const nodes = new Map(state.proposal.tree.nodes.map(node => [node.ref.nativeId, node]));
  const chosen = selected.filter(id => completed.has(id));
  const disabled =
    busy || state.invalid || !!state.result || !!state.task?.requestId || (state.task && !state.task.connected);
  const matches = (id: string) =>
    !query ||
    (nodes.get(id)?.title ?? nodes.get(id)?.url ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const groups = [
    {
      title: '待确认书签' as const,
      ids: [...uncertain].filter(matches),
      page: uncertainPage,
      setPage: setUncertainPage,
    },
    {
      title: '已生成的分类' as const,
      ids: [...completed].filter(id => !uncertain.has(id) && matches(id)),
      page,
      setPage,
    },
  ];
  async function submit(edit: OrganizeInteraction) {
    setBusy(true);
    setFailed(false);
    try {
      await review(edit);
      setSelected(current => current.filter(id => !edit.ids.includes(id)));
      if (edit.kind === 'feedback') setFeedback('');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  const effectiveTarget = (id: string) => {
    const action = state.proposal!.actions.find(action => action.kind === 'move' && action.sourceId === id);
    return action
      ? (state.targets[action.id] ?? action.targetId)
      : (state.pipeline?.bookmarkTargets?.[id] ?? nodes.get(id)?.parentId);
  };
  return (
    <section className="organize-interactive" aria-label={t('逐批审核与反馈')}>
      <h3>{t('逐批审核与反馈')}</h3>
      <p>
        {t('已生成 {done} 条 · 已审核 {reviewed} 条 · 待生成 {pending} 条', {
          done: completed.size,
          reviewed: reviewed.size,
          pending: Math.max(0, state.pipeline.total - completed.size),
        })}
      </p>
      {state.pipeline.preferenceSaveFailed && (
        <p role="alert">{t('归类已保存，但偏好未能记住，请到个性化偏好中补充。')}</p>
      )}
      <label>
        {t('筛选已生成的书签')}
        <input
          value={query}
          onChange={event => {
            setQuery(event.target.value);
            setPage(0);
            setUncertainPage(0);
          }}
        />
      </label>
      <div className="organize-review-tools">
        <p>{t('已选 {count} 条（每次最多 100 条）', { count: chosen.length })}</p>
        <label>
          {t('目标目录')}
          <Select
            aria-label={t('目标目录')}
            value={destination}
            disabled={!!disabled}
            onChange={event => setDestination(event.target.value)}
          >
            <option value="">{t('请选择目录')}</option>
            {[...targets].map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </Select>
        </label>
        <button
          disabled={!!disabled || !chosen.length || chosen.length > 100 || !targets.has(destination)}
          onClick={() => void submit({ kind: 'destination', ids: chosen, targetId: destination })}
        >
          {t('确认所选归类')}
        </button>
        <label>
          {t('告诉 AI 哪里不合理')}
          <textarea
            aria-label={t('告诉 AI 哪里不合理')}
            value={feedback}
            maxLength={1000}
            placeholder={t('例如：这些是教程，应放到学习资料，不要放到工具。')}
            disabled={!!disabled}
            onChange={event => setFeedback(event.target.value)}
          />
        </label>
        <button
          disabled={!!disabled || !chosen.length || chosen.length > 100 || !feedback.trim()}
          onClick={() => void submit({ kind: 'feedback', ids: chosen, text: feedback.trim() })}
        >
          {t('提交反馈并重新分类')}
        </button>
        {!!reclassifying.size && <p role="status">{t('等待重新分类 {count} 条', { count: reclassifying.size })}</p>}
        {failed && <p role="alert">{t('审核未保存，进度可能已更新。请查看最新结果后重试。')}</p>}
      </div>
      {groups.map(group => {
        const lastPage = Math.max(0, Math.ceil(group.ids.length / 25) - 1);
        const current = Math.min(group.page, lastPage);
        const ids = group.ids.slice(current * 25, current * 25 + 25);
        return (
          <section key={group.title} className="organize-review-group" aria-label={t(group.title)}>
            <h4>
              {t(group.title)}（{group.ids.length}）
            </h4>
            {!!ids.length && (
              <label>
                <input
                  type="checkbox"
                  disabled={!!disabled}
                  checked={ids.every(id => chosen.includes(id))}
                  onChange={event => {
                    const checked = event.target.checked;
                    setSelected(previous =>
                      checked ? [...new Set([...previous, ...ids])] : previous.filter(id => !ids.includes(id)),
                    );
                  }}
                />
                {t('选择本页')}
              </label>
            )}
            <ul>
              {ids.map(id => {
                const node = nodes.get(id);
                const target = effectiveTarget(id);
                return (
                  <li key={id}>
                    <label>
                      <input
                        type="checkbox"
                        disabled={!!disabled}
                        checked={chosen.includes(id)}
                        onChange={event => {
                          const checked = event.target.checked;
                          setSelected(previous =>
                            checked ? [...previous, id] : previous.filter(value => value !== id),
                          );
                        }}
                      />
                      <span title={node?.url}>{node?.title || node?.url || id}</span>
                    </label>
                    <span className="hint">
                      {reclassifying.has(id)
                        ? t('等待重新分类')
                        : reviewed.has(id)
                          ? t('已审核')
                          : uncertain.has(id)
                            ? t('需要选择目录')
                            : (targets.get(target ?? '') ?? t('保留当前位置'))}
                    </span>
                    {reviewed.has(id) && <span className="hint">{targets.get(target ?? '')}</span>}
                    {!uncertain.has(id) && target && targets.has(target) && !reviewed.has(id) && (
                      <button
                        disabled={!!disabled}
                        onClick={() => void submit({ kind: 'destination', ids: [id], targetId: target })}
                      >
                        {t('确认此归类')}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {lastPage > 0 && (
              <div className="actions">
                <button disabled={current === 0} onClick={() => group.setPage(current - 1)}>
                  {t('上一页')}
                </button>
                <span>
                  {current + 1} / {lastPage + 1}
                </span>
                <button disabled={current === lastPage} onClick={() => group.setPage(current + 1)}>
                  {t('下一页')}
                </button>
              </div>
            )}
          </section>
        );
      })}
    </section>
  );
}
