import { useEffect, useState, type ReactNode } from 'react';

/** Delay presentation only; readiness and permission checks stay with the caller. */
export function DeferredNotice({
  show,
  children,
  delayMs = 250,
}: {
  show: boolean;
  children: ReactNode;
  delayMs?: number;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), delayMs);
    return () => clearTimeout(timer);
  }, [show, delayMs]);
  return show && visible ? children : null;
}
