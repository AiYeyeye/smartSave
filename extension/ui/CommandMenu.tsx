import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { overlayHost } from './ThemeProvider';

export type CommandMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  separatorBefore?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onSelect: () => void;
};

export function CommandMenu({
  label,
  items,
  children,
  open: openProp,
  onOpenChange,
  description,
}: {
  label: string;
  items: CommandMenuItem[];
  children?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  description?: string;
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
  useLayoutEffect(() => {
    if (!open) return;
    function position() {
      const list = menu.current;
      const anchor = trigger.current;
      if (!list || !anchor) return;
      const bounds = anchor.getBoundingClientRect();
      const width = window.innerWidth;
      const height = window.innerHeight;
      list.style.maxHeight = `${Math.max(0, height - 16)}px`;
      list.style.left = `${Math.max(8, Math.min(bounds.right - list.offsetWidth, width - list.offsetWidth - 8))}px`;
      list.style.top = `${Math.max(8, Math.min(bounds.bottom + 4, height - list.offsetHeight - 8))}px`;
    }
    position();
    window.addEventListener('resize', position);
    document.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', position, true);
    };
  }, [open, items.length, description, label]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node))
        setOpen(false);
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
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={label}
            aria-describedby={description ? `${menuId}-description` : undefined}
            className="command-menu-list"
            onKeyDown={onMenuKey}
          >
            {description && (
              <p id={`${menuId}-description`} className="command-menu-hint" role="status">
                {description}
              </p>
            )}
            {items.map(item => (
              <Fragment key={item.id}>
                {item.separatorBefore && <div role="separator" />}
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  title={item.disabled ? item.disabledReason : undefined}
                  onClick={() => {
                    if (item.disabled) return;
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.icon}
                  {item.label}
                </button>
              </Fragment>
            ))}
          </div>,
          overlayHost(),
        )}
    </div>
  );
}
