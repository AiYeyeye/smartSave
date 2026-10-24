import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { OrganizeAction, OrganizeProposal } from '../domain/organize-proposal';
import { organizePaths } from '../domain/organize-review';
import { Select } from '../ui/Select';
import { useI18n } from '../ui/i18n';
import { organizeActionReason } from './organize-action-text';

function GroupChoice({
  checked,
  mixed,
  disabled,
  label,
  change,
}: {
  checked: boolean;
  mixed: boolean;
  disabled: boolean;
  label: string;
  change: (selected: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <label className="organize-group-choice">
      <input
        ref={input}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-checked={mixed ? 'mixed' : checked}
        onChange={e => change(e.target.checked)}
      />
      {label}
    </label>
  );
}

/** Review only proposed bookmark moves. Deselected suggestions remain visible and can be restored. */
export function OrganizeTargetReview({
  proposal,
  actions,
  selected,
  targets,
  targetLabels,
  targetOptions,
  disabled,
  toggle,
  toggleMany,
  target,
  reject,
  rejectDisabled,
}: {
  proposal: OrganizeProposal;
  actions: OrganizeAction[];
  selected: string[];
  targets: Record<string, string>;
  targetLabels: Map<string, string>;
  targetOptions: ReactNode;
  disabled: boolean;
  toggle: (id: string, selected: boolean) => void;
  toggleMany: (ids: string[], selected: boolean) => void;
  target: (id: string, target: string) => void;
  reject: (action: OrganizeAction) => void;
  rejectDisabled: boolean;
}) {
  const { t, language } = useI18n();
  const groups = useMemo(() => {
    const result = new Map<string, OrganizeAction[]>();
    for (const action of actions) {
      const id = targets[action.id] ?? action.targetId!;
      const group = result.get(id) ?? [];
      group.push(action);
      result.set(id, group);
    }
    return [...result];
  }, [actions, targets]);
  const rootLabel = t('根目录');
  const paths = useMemo(() => organizePaths(proposal.tree, rootLabel), [proposal.tree, rootLabel]);
  const chosen = new Set(selected);
  if (!groups.length) return null;
  return (
    <section className="organize-target-review" aria-label={t('按目标目录审核')}>
      <h3 className="organize-section-title">{t('按目标目录审核')}</h3>
      {groups.map(([id, items]) => {
        const count = items.filter(action => chosen.has(action.id)).length;
        const label = targetLabels.get(id) ?? id;
        return (
          <article key={id} className="organize-target-group">
            <GroupChoice
              checked={count === items.length}
              mixed={count > 0 && count < items.length}
              disabled={disabled}
              label={t('采纳 {title}', { title: label })}
              change={value =>
                toggleMany(
                  items.map(a => a.id),
                  value,
                )
              }
            />
            <p className="hint">{t('已选 {count} / {total} 条书签', { count, total: items.length })}</p>
            <details>
              <summary>{t('查看并调整 {count} 条书签', { count: items.length })}</summary>
              {items.map(action => (
                <div className="workflow-review-row" key={action.id}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={t('选择 {title}', { title: action.id })}
                      checked={chosen.has(action.id)}
                      disabled={disabled}
                      onChange={e => toggle(action.id, e.target.checked)}
                    />
                    {action.title}
                  </label>
                  <p>{t('当前路径：{path}', { path: paths.get(action.sourceId) ?? '' })}</p>
                  <div className="organize-reason">
                    <p>{t('建议理由：{reason}', { reason: organizeActionReason(language, action, proposal) })}</p>
                    <button
                      className="organize-reject"
                      disabled={disabled || rejectDisabled}
                      title={t('记住此选择，以后不再建议这个操作；仅本次不采用请取消勾选')}
                      onClick={() => reject(action)}
                    >
                      {t('不再建议')}
                    </button>
                  </div>
                  <label>
                    {t('建议目标')}
                    <Select
                      aria-label={t('{id} 目标', { id: action.id })}
                      value={id}
                      disabled={disabled}
                      onChange={e => target(action.id, e.target.value)}
                    >
                      {targetOptions}
                    </Select>
                  </label>
                </div>
              ))}
            </details>
          </article>
        );
      })}
    </section>
  );
}
