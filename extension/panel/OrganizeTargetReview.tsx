import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { OrganizeAction, OrganizeProposal } from '../domain/organize-proposal';
import { organizePaths } from '../domain/organize-review';
import { Select } from '../ui/Select';

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
  const paths = useMemo(() => organizePaths(proposal.tree), [proposal.tree]);
  const chosen = new Set(selected);
  if (!groups.length) return null;
  return (
    <section className="organize-target-review" aria-label="按目标目录审核">
      <h3>按目标目录审核</h3>
      <p className="hint">勾选整组采用，取消整组保持原位；展开后可逐条调整。尚未修改书签。</p>
      {groups.map(([id, items]) => {
        const count = items.filter(action => chosen.has(action.id)).length;
        const label = targetLabels.get(id) ?? id;
        return (
          <article key={id}>
            <GroupChoice
              checked={count === items.length}
              mixed={count > 0 && count < items.length}
              disabled={disabled}
              label={`采纳 ${label}`}
              change={value =>
                toggleMany(
                  items.map(a => a.id),
                  value,
                )
              }
            />
            <p className="hint">
              已选 {count} / {items.length} 条书签
            </p>
            <details>
              <summary>查看并调整 {items.length} 条书签</summary>
              {items.map(action => (
                <div className="workflow-review-row" key={action.id}>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${action.id}`}
                      checked={chosen.has(action.id)}
                      disabled={disabled}
                      onChange={e => toggle(action.id, e.target.checked)}
                    />
                    {action.title}
                  </label>
                  <p>当前路径：{paths.get(action.sourceId)}</p>
                  <div className="organize-reason">
                    <p>建议理由：{action.reason}</p>
                    <button
                      className="organize-reject"
                      disabled={disabled || rejectDisabled}
                      title="记住此选择，以后不再建议这个操作；仅本次不采用请取消勾选"
                      onClick={() => reject(action)}
                    >
                      不再建议
                    </button>
                  </div>
                  <label>
                    建议目标
                    <Select
                      aria-label={`${action.id} 目标`}
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
