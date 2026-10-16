import { useEffect, useState, type ReactNode } from 'react';

/** Delay presentation only; readiness and permission checks stay with the caller. */
export function DeferredNotice({ show, children }: { show: boolean; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(timer);
  }, [show]);
  return show && visible ? children : null;
}
