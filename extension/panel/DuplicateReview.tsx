import type { DuplicateGroup } from '../domain/suspected-duplicates';
import type { DuplicateChoice } from '../domain/exact-duplicates';
import { Select } from '../ui/Select';
import { useI18n } from '../ui/i18n';
import { useState } from 'react';

export function DuplicateReview({
  groups,
  choices,
  paths,
  disabled,
  onChoice,
  compact = false,
  onKeepOnly,
}: {
  groups: DuplicateGroup[];
  choices: Record<string, DuplicateChoice>;
  paths: ReadonlyMap<string, string>;
  disabled: boolean;
  onChoice(id: string, choice: DuplicateChoice): void;
  compact?: boolean;
  onKeepOnly?: (group: DuplicateGroup, keeperId: string) => void;
}) {
  const { t } = useI18n();
  const [customGroups, setCustomGroups] = useState(new Set<string>());
  return (
    <div className={`duplicate-review${compact ? ' is-compact' : ''}`}>
      {groups.map(group => (
        <article key={group.url}>
          <div className="duplicate-group-heading">
            <h3 title={compact ? t('保留至少一项；未选择的项目不删除。') : undefined}>
              {t(group.suspected ? '疑似重复 · {count} 条' : '精确重复 · {count} 条', { count: group.items.length })}
            </h3>
            {onKeepOnly && group.suspected && (
              <button
                type="button"
                className="duplicate-custom"
                disabled={disabled}
                aria-expanded={customGroups.has(group.url)}
                onClick={() =>
                  setCustomGroups(old => {
                    const next = new Set(old);
                    if (next.has(group.url)) next.delete(group.url);
                    else next.add(group.url);
                    return next;
                  })
                }
              >
                {t(customGroups.has(group.url) ? '收起自选' : '自定义选择')}
              </button>
            )}
          </div>
          {!compact && (
            <p>
              {t(
                group.suspected
                  ? '忽略 utm_* 参数、http/https、www 和末尾斜杠后相同，仍可能是不同内容。请核对下面的原始链接；同组也可能包含完全相同的副本。'
                  : '原始链接完全相同。',
              )}{' '}
              {t('保留至少一项；未选择的项目不删除。')}
            </p>
          )}
          {group.items.map(node => (
            <div className="field" key={node.ref.nativeId}>
              <strong>{node.title}</strong>
              <span>{paths.get(node.ref.nativeId)}</span>
              <span className="duplicate-url">{node.url}</span>
              {onKeepOnly && group.suspected && !customGroups.has(group.url) ? (
                <button
                  type="button"
                  className="duplicate-keep"
                  aria-label={t('保留这条：{title}', { title: node.title })}
                  disabled={
                    disabled || !group.items.some(other => other.ref.nativeId !== node.ref.nativeId && !other.readOnly)
                  }
                  onClick={() => onKeepOnly(group, node.ref.nativeId)}
                >
                  {t('保留这条')}
                </button>
              ) : (
                <Select
                  aria-label={t('{title} 保留或删除', { title: node.title })}
                  disabled={disabled}
                  value={choices[node.ref.nativeId] ?? 'unselected'}
                  onChange={event => onChoice(node.ref.nativeId, event.target.value as DuplicateChoice)}
                >
                  <option value="unselected">{t('未选择')}</option>
                  <option value="keep">{t('明确保留')}</option>
                  <option value="delete" disabled={node.readOnly}>
                    {t('明确删除')}
                  </option>
                </Select>
              )}
            </div>
          ))}
        </article>
      ))}
    </div>
  );
}
