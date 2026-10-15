import { useEffect, useState } from 'react';
import { organizeDuration, organizeProgressTiming } from '../domain/organize-progress';
import type { OrganizeState } from './organize-controller';
import { useI18n } from '../ui/i18n';

export function OrganizeTiming({ pipeline }: { pipeline: NonNullable<OrganizeState['pipeline']> }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (pipeline.activeSince === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pipeline.activeSince]);
  const timing = organizeProgressTiming(pipeline, now);
  const duration = (ms: number) => organizeDuration(ms, { second: t('秒'), minute: t('分'), hour: t('小时') });
  return (
    <p className="hint" aria-label={t('整理用时')}>
      {t('已用时 {duration}', { duration: duration(timing.elapsedMs) })}
      {pipeline.stage === 'bookmarks' &&
        pipeline.status === 'running' &&
        (timing.remainingMs === undefined
          ? t(' · 正在估算剩余时间')
          : t(' · 预计剩余约 {duration}', { duration: duration(timing.remainingMs) }))}
      {pipeline.stage === 'complete' && t(' · 分析完成')}
    </p>
  );
}
