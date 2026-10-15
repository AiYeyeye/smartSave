import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import './busy-indicator.css';
import { useI18n } from './i18n';

export function BusyIndicator({ label }: { label: string }) {
  const { t, message } = useI18n();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="busy-indicator" role="status" aria-live="polite">
      <LoaderCircle className="busy-spinner" aria-hidden="true" />
      <span>{message(label)}</span>
      <small aria-hidden="true">{t('已等待 {seconds} 秒', { seconds })}</small>
    </div>
  );
}
