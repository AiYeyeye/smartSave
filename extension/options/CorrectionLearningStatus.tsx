import { useEffect, useState } from 'react';
import { LEARNING_QUEUE_KEY } from '../persistence/personalization';
import { useI18n } from '../ui/i18n';

export function CorrectionLearningStatus() {
  const { t } = useI18n();
  const [counts, setCounts] = useState({ queued: 0, running: 0, failed: 0, completed: 0 });
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local || !chrome.storage.onChanged) return;
    let live = true;
    const read = async () => {
      const data = await chrome.storage.local.get(LEARNING_QUEUE_KEY);
      if (!live) return;
      const jobs = Array.isArray(data[LEARNING_QUEUE_KEY]) ? data[LEARNING_QUEUE_KEY] : [];
      setCounts({
        queued: jobs.filter(job => job?.status === 'queued').length,
        running: jobs.filter(job => job?.status === 'running').length,
        failed: jobs.filter(job => job?.status === 'failed').length,
        completed: jobs.filter(job => job?.status === 'completed').length,
      });
    };
    void read().catch(() => {});
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[LEARNING_QUEUE_KEY]) void read().catch(() => {});
    };
    chrome.storage.onChanged.addListener(changed);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(changed);
    };
  }, []);
  if (!counts.queued && !counts.running && !counts.failed) return null;
  return (
    <div role="status">
      {(counts.queued > 0 || counts.running > 0) && <p>{t('正在更新偏好…')}</p>}
      {counts.failed > 0 && <p>{t('有 {count} 次偏好更新未完成', { count: counts.failed })}</p>}
    </div>
  );
}
