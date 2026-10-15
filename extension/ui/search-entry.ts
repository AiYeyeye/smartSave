import { useEffect, useRef, useState } from 'react';

/** Scoped to the extension document; page shortcuts and IME composition remain untouched. */
export function useSearchKey(onSearch: () => void) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.shiftKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== 'k'
      )
        return;
      event.preventDefault();
      onSearch();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [onSearch]);
}

/** A one-use opaque route transfers a query without putting bookmark text in browser history. */
export function useSearchLaunch(onQuery: (query: string) => void) {
  const [token] = useState(() => /^#search\/([\w-]+)$/.exec(location.hash)?.[1]);
  const request = useRef<Promise<unknown> | undefined>(undefined);
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!token) return;
    let active = true;
    request.current ??= Promise.resolve().then(() => chrome.runtime.sendMessage({ type: 'claimSearchLaunch', token }));
    void request.current
      .then(
        value => {
          if (!active) return;
          if (value && typeof value === 'object' && 'query' in value && typeof value.query === 'string')
            onQuery(value.query);
          else setStatus('搜索入口已过期，请重新输入关键词。');
        },
        () => {
          if (active) setStatus('搜索入口不可用，请重新输入关键词。');
        },
      )
      .finally(() => {
        if (active && location.hash === `#search/${token}`) history.replaceState(null, '', '#browse');
      });
    return () => {
      active = false;
    };
  }, [token, onQuery]);
  return { requested: !!token, status };
}
