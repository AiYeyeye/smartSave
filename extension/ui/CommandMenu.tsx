import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export type CommandMenuItem = { id: string; label: string; disabled?: boolean; onSelect: () => void };

export function CommandMenu({
  label,
  items,
  children,
  open: openProp,
  onOpenChange,
}: {
  label: string;
  items: CommandMenuItem[];
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internal, setInternal] = useState(false);
  const open = openProp ?? internal;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  function setOpen(next: boolean) {
    if (openProp === undefined) setInternal(next);
    onOpenChange?.(next);
    if (!next) trigger.current?.focus();
  }
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    const enabled = menu.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)');
    enabled?.focus();
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      buttons[(index + 1 + buttons.length) % buttons.length]?.focus();
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(index - 1 + buttons.length) % buttons.length]?.focus();
    }
    if (event.key === 'Home') {
      event.preventDefault();
      buttons[0]?.focus();
    }
    if (event.key === 'End') {
      event.preventDefault();
      buttons.at(-1)?.focus();
    }
    if (event.key === 'Tab') setOpen(false);
  }
  return (
    <div className="command-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="command-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen(!open)}
      >
        {children ?? '⋯'}
      </button>
      {open && (
        <div ref={menu} id={menuId} role="menu" aria-label={label} className="command-menu-list" onKeyDown={onMenuKey}>
          {items.map(item => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect();
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
