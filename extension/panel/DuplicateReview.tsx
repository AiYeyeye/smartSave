import type { DuplicateGroup } from '../domain/suspected-duplicates';
import type { DuplicateChoice } from '../domain/exact-duplicates';
import { Select } from '../ui/Select';
import { useI18n } from '../ui/i18n';

export function DuplicateReview({
  groups,
  choices,
  paths,
  disabled,
  onChoice,
}: {
  groups: DuplicateGroup[];
  choices: Record<string, DuplicateChoice>;
  paths: ReadonlyMap<string, string>;
  disabled: boolean;
  onChoice(id: string, choice: DuplicateChoice): void;
}) {
  const { t } = useI18n();
  return (
    <div className="duplicate-review">
      {groups.map(group => (
        <article key={group.url}>
          <h3>
            {t(group.suspected ? '疑似重复 · {count} 条' : '精确重复 · {count} 条', { count: group.items.length })}
          </h3>
          <p>
            {t(
              group.suspected
                ? '忽略 utm_* 参数、http/https、www 和末尾斜杠后相同，仍可能是不同内容。请核对下面的原始链接；同组也可能包含完全相同的副本。'
                : '原始链接完全相同。',
            )}{' '}
            {t('保留至少一项；未选择的项目不删除。')}
          </p>
          {group.items.map(node => (
            <label className="field" key={node.ref.nativeId}>
              <strong>{node.title}</strong>
              <span>{paths.get(node.ref.nativeId)}</span>
              <span className="duplicate-url">{node.url}</span>
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
            </label>
          ))}
        </article>
      ))}
    </div>
  );
}
