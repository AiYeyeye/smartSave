import { createContext, useCallback, useContext, useState, type PropsWithChildren } from 'react';

type ToastApi = { toast: (msg: string) => void };

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<{ id: number; msg: string }[]>([]);
  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setItems(prev => [...prev, { id, msg }]);
    window.setTimeout(() => setItems(prev => prev.filter(t => t.id !== id)), 2200);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="ai-svc-toast-host" aria-live="polite">
        {items.map(t => (
          <div key={t.id} className="ai-svc-toast">
            {t.msg}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast requires ToastProvider');
  return ctx;
}
