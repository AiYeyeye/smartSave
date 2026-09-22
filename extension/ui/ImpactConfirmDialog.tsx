import { useEffect, useId, useRef, type ReactNode } from 'react';
export function ImpactConfirmDialog({
  children,
  onCancel,
  onConfirm,
  disabled,
  busy,
}: {
  children: ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  disabled: boolean;
  busy: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const title = useId();
  useEffect(() => {
    const previous = document.activeElement;
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop">
      <div
        ref={ref}
        className="impact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
            const first = buttons[0],
              last = buttons.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            }
            if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
            if (!buttons.length) event.preventDefault();
          }
        }}
      >
        <h2 id={title}>删除影响确认</h2>
        {children}
        <div className="actions">
          <button onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button onClick={onConfirm} disabled={disabled || busy}>
            确认删除
          </button>
        </div>
      </div>
    </div>
  );
}
