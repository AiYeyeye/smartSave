import { Check } from 'lucide-react';
import './workflow.css';
import { useI18n } from './i18n';

/** Shared, non-interactive progress: advancing always uses the current step's explicit action. */
export function WorkflowSteps({ labels, current }: { labels: readonly string[]; current: number }) {
  const { t } = useI18n();
  return (
    <ol className="workflow-steps" aria-label={t('操作步骤')}>
      {labels.map((label, index) => (
        <li
          key={index}
          aria-current={current === index + 1 ? 'step' : undefined}
          className={current === index + 1 ? 'is-current' : current > index + 1 ? 'is-done' : ''}
        >
          <span className="workflow-step-number" aria-hidden="true">
            {current > index + 1 ? <Check /> : index + 1}
          </span>
          <span>{label}</span>
        </li>
      ))}
    </ol>
  );
}
