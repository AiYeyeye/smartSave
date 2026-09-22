import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { overlayHost } from './ThemeProvider';

type Option = { value: string; label: string; disabled: boolean };

function readOptions(select: HTMLSelectElement | null): Option[] {
  if (!select) return [];
  return [...select.options].map(option => ({ value: option.value, label: option.text, disabled: option.disabled }));
}

function placeList(trigger: HTMLElement, list: HTMLElement) {
  const rect = trigger.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const margin = 4;
  list.style.position = 'fixed';
  list.style.minWidth = `${rect.width}px`;
  list.style.maxWidth = `${Math.max(80, vw - 16)}px`;
  const width = Math.min(Math.max(list.offsetWidth, rect.width), vw - 16);
  let left = rect.left;
  if (left + width > vw - 8) left = Math.max(8, vw - 8 - width);
  if (left < 8) left = 8;
  const below = vh - rect.bottom - 8;
  const above = rect.top - 8;
  const flip = below < 96 && above > below;
  const maxHeight = Math.max(80, flip ? above : below);
  list.style.maxHeight = `${maxHeight}px`;
  const height = Math.min(list.offsetHeight, maxHeight);
  list.style.left = `${left}px`;
  list.style.top = `${flip ? Math.max(8, rect.top - margin - height) : rect.bottom + margin}px`;
}

export function Select({ children, disabled, onMouseDown, onKeyDown, onBlur, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const root = useRef<HTMLSpanElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Option[]>([]);
  const [active, setActive] = useState(0);
  const typed = useRef({ prefix: '', at: 0 });
  const value = props.value === undefined || props.value === null ? '' : String(props.value);
  function enabledIndexes(list: Option[]) {
    return list.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
  }
  function matchTypeahead(list: Option[], prefix: string, from: number) {
    const needle = prefix.toLowerCase();
    const enabled = enabledIndexes(list);
    if (!enabled.length) return 0;
    const start = Math.max(0, enabled.indexOf(from));
    for (let i = 0; i < enabled.length; i++) {
      const index = enabled[(start + i) % enabled.length]!;
      if (list[index]!.label.toLowerCase().startsWith(needle)) return index;
    }
    return enabled[0]!;
  }
  function commit(next: string) {
    const select = selectRef.current;
    if (!select || select.disabled || select.value === next) { setOpen(false); select?.focus(); return; }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, next);
    select.dispatchEvent(new Event('change', { bubbles: true }));
    setOpen(false);
    select.focus();
  }
  function openList() {
    if (disabled || props['aria-disabled'] === true) return;
    const list = readOptions(selectRef.current);
    setOptions(list);
    const current = list.findIndex(option => option.value === value && !option.disabled);
    setActive(current >= 0 ? current : (enabledIndexes(list)[0] ?? 0));
    setOpen(true);
  }
  function containsNode(node: Node | null) {
    return !!node && !!(root.current?.contains(node) || listRef.current?.contains(node));
  }
  useLayoutEffect(() => {
    if (!open || !selectRef.current || !listRef.current) return;
    placeList(selectRef.current, listRef.current);
    listRef.current.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [open, options, active]);
  useEffect(() => { setOpen(false); }, [value]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (event: MouseEvent) => { if (!containsNode(event.target as Node)) setOpen(false); };
    const onReposition = () => { if (selectRef.current && listRef.current) placeList(selectRef.current, listRef.current); };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onReposition);
    document.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onReposition);
      document.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);
  function onSelectMouseDown(event: ReactMouseEvent<HTMLSelectElement>) {
    onMouseDown?.(event);
    if (event.defaultPrevented || disabled) return;
    event.preventDefault();
    selectRef.current?.focus();
    if (open) setOpen(false); else openList();
  }
  function onSelectKeyDown(event: ReactKeyboardEvent<HTMLSelectElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled) return;
    const list = open ? options : readOptions(selectRef.current);
    const enabled = enabledIndexes(list);
    if (event.key === 'Escape') {
      if (!open) return;
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'Tab') { if (open) setOpen(false); return; }
    const opens = event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ' || event.key === 'Home' || event.key === 'End' || (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'));
    if (opens) {
      event.preventDefault();
      if (!open) { openList(); return; }
      if (!enabled.length) return;
      const position = Math.max(0, enabled.indexOf(active));
      if (event.key === 'ArrowDown') setActive(enabled[(position + 1) % enabled.length]!);
      if (event.key === 'ArrowUp') setActive(enabled[(position - 1 + enabled.length) % enabled.length]!);
      if (event.key === 'Home') setActive(enabled[0]!);
      if (event.key === 'End') setActive(enabled.at(-1)!);
      if (event.key === 'Enter' || event.key === ' ') commit(list[active]?.value ?? value);
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      typed.current.prefix = now - typed.current.at > 500 ? event.key : `${typed.current.prefix}${event.key}`;
      typed.current.at = now;
      const currentList = list.length ? list : readOptions(selectRef.current);
      const next = matchTypeahead(currentList, typed.current.prefix, active);
      if (!open) {
        const option = currentList[next];
        if (option) commit(option.value);
        return;
      }
      setActive(next);
    }
  }
  return <span className="in-panel-select" ref={root} data-open={open || undefined}>
    <select {...props} ref={selectRef} disabled={disabled} aria-expanded={open} aria-controls={open ? listId : undefined} onMouseDown={onSelectMouseDown} onKeyDown={onSelectKeyDown} onBlur={event => { onBlur?.(event); if (!containsNode(event.relatedTarget as Node)) setOpen(false); }}>{children}</select>
    {open && createPortal(<div ref={listRef} id={listId} role="listbox" className="in-panel-select-list">
      {options.map((option, index) => <div key={`${option.value}:${index}`} role="option" aria-selected={index === active} aria-disabled={option.disabled || undefined} className={option.disabled ? 'is-disabled' : undefined} onMouseEnter={() => { if (!option.disabled) setActive(index); }} onMouseDown={event => event.preventDefault()} onClick={() => { if (!option.disabled) commit(option.value); }}>{option.label}</div>)}
    </div>, overlayHost())}
  </span>;
}
