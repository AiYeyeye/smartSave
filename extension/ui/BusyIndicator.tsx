import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import './busy-indicator.css';

export function BusyIndicator({ label }: { label: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="busy-indicator" role="status" aria-live="polite">
      <LoaderCircle className="busy-spinner" aria-hidden="true" />
      <span>{label}</span>
      <small aria-hidden="true">已等待 {seconds} 秒</small>
    </div>
  );
}
