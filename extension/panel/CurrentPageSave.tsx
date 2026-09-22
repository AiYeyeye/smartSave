import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { SAVE_PORT } from '../background/save-entrypoints';
import { SaveCard } from './SaveCard';
import { saveBodySchema } from './extract-save-body';
import { connectTree } from './tree-client';
import type { TreeSnapshot, TreeState } from '../domain/node-reference';
import type { SettingsStore } from '../persistence/settings';
import { SiteRulesStore } from '../persistence/site-rules';
const pageSchema = z.object({ tabId: z.number().int(), token: z.string(), title: z.string(), url: z.url() });
type Page = z.infer<typeof pageSchema>;
export function CurrentPageSave({ settings }: { settings?: SettingsStore }) {
  const [page, setPage] = useState<Page>();
  const current = useRef<Page | undefined>(undefined);
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const [message, setMessage] = useState('');
  const [connected, setConnected] = useState(false);
  const [rules] = useState(() =>
    typeof chrome !== 'undefined' && chrome.storage?.local ? new SiteRulesStore(chrome.storage.local) : undefined,
  );
  const [lastSnapshot, setLastSnapshot] = useState<TreeSnapshot>();
  const port = useRef<chrome.runtime.Port | undefined>(undefined);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return;
    const connection = chrome.runtime.connect({ name: SAVE_PORT });
    port.current = connection;
    setConnected(true);
    connection.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      if (raw.type === 'page' && 'page' in raw) {
        const parsed = pageSchema.safeParse(raw.page);
        if (parsed.success) {
          current.current = parsed.data;
          setPage(parsed.data);
          setMessage('请在确认卡检查内容。');
        }
      } else {
        current.current = undefined;
        setPage(undefined);
        setMessage(
          raw.type === 'error' && 'reason' in raw && typeof raw.reason === 'string'
            ? raw.reason
            : '页面已切换或导航；请重新收藏当前页面。',
        );
      }
    });
    connection.onDisconnect.addListener(() => {
      current.current = undefined;
      port.current = undefined;
      setConnected(false);
      setPage(undefined);
      setMessage('收藏入口连接已关闭；请重新打开智栏。');
    });
    connection.postMessage({ type: 'register' });
    const stop = connectTree(chrome.runtime, next => {
      if (next.status === 'ready') setLastSnapshot(next.snapshot);
      setTree(next);
    });
    return () => {
      current.current = undefined;
      port.current = undefined;
      connection.disconnect();
      stop();
    };
  }, []);
  async function extractBody() {
    const frozen = current.current;
    if (!frozen) throw Error('stale');
    return new Promise<string>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'extractSaveBody' }, (response: unknown) => {
        if (chrome.runtime.lastError) {
          reject(Error(chrome.runtime.lastError.message));
          return;
        }
        // Same contract the worker enforced: the frozen page URL and the 1500-code-point bound; anything else degrades to title/URL.
        const parsed = saveBodySchema(frozen.url).safeParse(response);
        if (parsed.success) resolve(parsed.data.snippet);
        else reject(Error('extract-rejected'));
      });
    });
  }
  function requestCapture() {
    const connection = port.current;
    if (!connection) {
      setMessage('收藏入口连接已关闭；请重新打开智栏。');
      return;
    }
    setMessage('正在读取当前标签页…');
    try {
      connection.postMessage({ type: 'capture' });
    } catch {
      setMessage('收藏入口连接已关闭；请重新打开智栏。');
    }
  }
  if (!page) {
    // The popup opens in browse mode; capture is an explicit gesture, never inferred from the page behind it.
    return (
      <div className="current-page">
        <button type="button" className="current-page-capture" disabled={!connected} onClick={requestCapture}>
          收藏当前页面
        </button>
        {message && <p role="status">{message}</p>}
      </div>
    );
  }
  const snapshot = tree.status === 'ready' ? tree.snapshot : lastSnapshot;
  return (
    <>
      {snapshot && rules && (
        <SaveCard
          key={page.token}
          page={page}
          snapshot={snapshot}
          connectionReady={tree.status === 'ready'}
          settings={settings}
          rulesStore={rules}
          extractBody={extractBody}
          onClose={() => {
            current.current = undefined;
            setPage(undefined);
            setMessage('');
            try {
              port.current?.postMessage({ type: 'close' });
            } catch {
              /* A closed port already invalidated the capture. */
            }
          }}
        />
      )}
      {message && <p role="status">{message}</p>}
    </>
  );
}
