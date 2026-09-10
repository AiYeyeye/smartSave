import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { SAVE_PORT } from '../background/save-entrypoints';
import { extractSaveBody } from './extract-save-body';
import { SaveCard } from './SaveCard';
import { connectTree } from './tree-client';
import type { TreeState } from '../domain/node-reference';
import type { SettingsStore } from '../persistence/settings';
import { SiteRulesStore } from '../persistence/site-rules';
const pageSchema = z.object({ tabId: z.number().int(), token: z.string(), title: z.string(), url: z.url() });
type Page = z.infer<typeof pageSchema>;
export function CurrentPageSave({ settings }: { settings?: SettingsStore }) {
  const [page, setPage] = useState<Page>(); const current = useRef<Page | undefined>(undefined);
  const [tree, setTree] = useState<TreeState>({ status: 'loading' }); const [message, setMessage] = useState('点击扩展工具栏、页面菜单或已配置命名快捷键可激活收藏。');
  const [rules] = useState(() => typeof chrome !== 'undefined' && chrome.storage?.local ? new SiteRulesStore(chrome.storage.local) : undefined);
  const port = useRef<chrome.runtime.Port | undefined>(undefined);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime) return;
    const connection = chrome.runtime.connect({ name: SAVE_PORT }); port.current = connection;
    connection.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      if (raw.type === 'page' && 'page' in raw) { const parsed = pageSchema.safeParse(raw.page); if (parsed.success) { current.current = parsed.data; setPage(parsed.data); setMessage('请在确认卡检查内容。'); } }
      else { current.current = undefined; setPage(undefined); setMessage(raw.type === 'error' && 'reason' in raw && typeof raw.reason === 'string' ? raw.reason : '页面已切换或导航；请重新激活收藏。'); }
    });
    connection.onDisconnect.addListener(() => { current.current = undefined; setPage(undefined); setMessage('收藏入口连接已关闭；请重新打开侧栏。'); });
    void chrome.windows.getCurrent().then(window => { if (port.current !== connection) return; if (window.id === undefined) throw Error(); connection.postMessage({ type: 'register', windowId: window.id }); }).catch(() => { if (port.current === connection) setMessage('无法确定侧栏所在窗口；未查询或采集其他窗口。'); });
    const stop = connectTree(chrome.runtime, setTree);
    return () => { current.current = undefined; port.current = undefined; connection.disconnect(); stop(); };
  }, []);
  async function extractBody() {
    const frozen = current.current; if (!frozen) throw Error('stale');
    return extractSaveBody(frozen, () => current.current, { get: id => chrome.tabs.get(id), inject: tabId => chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] }), message: (tabId, message, documentId) => chrome.tabs.sendMessage(tabId, message, { documentId }) });
  }
  return <><div className="current-page"><span>{message}</span><button onClick={() => { try { port.current?.postMessage({ type: 'current' }); } catch { setMessage('当前标签页查询不可用；请重新打开侧栏。'); } }}>收藏当前页面</button></div>
    {page && tree.status === 'ready' && rules && <SaveCard key={page.token} page={page} snapshot={tree.snapshot} settings={settings} rulesStore={rules} extractBody={extractBody} onClose={() => { current.current = undefined; setPage(undefined); port.current?.postMessage({ type: 'close' }); }} />}
  </>;
}
