import { useEffect, useState } from 'react';
import { organizeDuration, organizeProgressTiming } from '../domain/organize-progress';
import type { OrganizeState } from './organize-controller';

export function OrganizeTiming({ pipeline }: { pipeline: NonNullable<OrganizeState['pipeline']> }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (pipeline.activeSince === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pipeline.activeSince]);
  const timing = organizeProgressTiming(pipeline, now);
  return (
    <p className="hint" aria-label="整理用时">
      已用时 {organizeDuration(timing.elapsedMs)}
      {pipeline.stage === 'bookmarks' &&
        pipeline.status === 'running' &&
        (timing.remainingMs === undefined
          ? ' · 正在估算剩余时间'
          : ` · 预计剩余约 ${organizeDuration(timing.remainingMs)}`)}
      {pipeline.stage === 'complete' && ' · 分析完成'}
    </p>
  );
}
