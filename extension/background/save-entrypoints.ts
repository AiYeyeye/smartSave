import { validateUrl } from '../domain/preflight';
export const SAVE_PORT = 'zhilan.save.v1';
export interface SavePage { tabId: number; token: string; title: string; url: string }
export function startSaveEntrypoints(onInvalidated: () => void = () => {}) {
  const sessions = new Map<number, { page?: SavePage; port?: chrome.runtime.Port; generation: number }>();
  const session = (id: number) => { let value = sessions.get(id); if (!value) { value = { generation: 0 }; sessions.set(id, value); } return value; };
  const post = (port: chrome.runtime.Port | undefined, value: unknown) => { try { port?.postMessage(value); } catch { /* Disconnection invalidates via the port lifecycle. */ } };
  const invalidate = (windowId: number) => { const value = sessions.get(windowId); if (!value) return; value.generation++; value.page = undefined; onInvalidated(); post(value.port, { type: 'invalidated' }); };
  function capture(tab: chrome.tabs.Tab | undefined, windowId: number) {
    const value = session(windowId); value.generation++; value.page = undefined; onInvalidated();
    try {
      if (tab?.id === undefined || tab.windowId !== windowId || !tab.url) throw Error(); validateUrl(tab.url);
      value.page = { tabId: tab.id, token: crypto.randomUUID(), url: tab.url, title: tab.title ?? tab.url };
      post(value.port, { type: 'page', page: value.page });
    } catch { value.page = undefined; post(value.port, { type: 'error', reason: '当前页面资料不可用；请从扩展工具栏、页面菜单或已配置命名快捷键激活。' }); }
  }
  function activate(tab?: chrome.tabs.Tab) {
    if (tab?.id === undefined || !Number.isInteger(tab.windowId)) return;
    if (!chrome.sidePanel.open) { post(session(tab.windowId).port, { type: 'error', reason: '浏览器不支持侧栏打开接口，请升级浏览器。' }); return; }
    capture(tab, tab.windowId);
    const value = session(tab.windowId); const generation = value.generation;
    const failed = () => {
      if (sessions.get(tab.windowId) === value && value.generation === generation) post(value.port, { type: 'error', reason: '侧栏打开失败，请检查浏览器支持。' });
    };
    // Capture is synchronous: open stays in the original user gesture, without awaiting initialization.
    try { void chrome.sidePanel.open({ tabId: tab.id }).catch(failed); } catch { failed(); }
  }
  chrome.action.onClicked.addListener(activate);
  chrome.commands.onCommand.addListener((command, tab) => { if (command === 'save-current-page') activate(tab); });
  chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === 'zhilan-save-page') activate(tab); });
  chrome.runtime.onInstalled.addListener(() => { chrome.contextMenus.create({ id: 'zhilan-save-page', title: '使用智栏收藏当前页面', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] }, () => { if (chrome.runtime.lastError) console.error('智栏收藏菜单创建失败'); }); });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => { if (change.status !== 'loading' && change.url === undefined) return; for (const [id, value] of sessions) if (value.page?.tabId === tabId || (!value.page && tab.active && tab.windowId === id)) invalidate(id); });
  chrome.tabs.onRemoved.addListener((tabId, info) => { const value = sessions.get(info.windowId); if (value?.page?.tabId === tabId || !value?.page) invalidate(info.windowId); });
  chrome.tabs.onActivated.addListener(info => invalidate(info.windowId));
  chrome.windows.onRemoved.addListener(id => { invalidate(id); sessions.delete(id); });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== SAVE_PORT || port.sender?.id !== chrome.runtime.id || port.sender.tab !== undefined || port.sender.url !== chrome.runtime.getURL('panel/index.html')) return;
    let windowId: number | undefined;
    const owned = () => windowId !== undefined && sessions.get(windowId)?.port === port;
    port.onDisconnect.addListener(() => { if (!owned()) return; invalidate(windowId!); session(windowId!).port = undefined; });
    port.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      if (raw.type === 'register' && windowId === undefined && 'windowId' in raw && typeof raw.windowId === 'number' && Number.isInteger(raw.windowId) && raw.windowId >= 0) {
        windowId = raw.windowId; const value = session(windowId); const old = value.port; value.port = port;
        if (old && old !== port) { post(old, { type: 'invalidated' }); old.disconnect(); }
        if (value.page) post(port, { type: 'page', page: value.page }); return;
      }
      if (!owned()) return;
      if (raw.type === 'close') { invalidate(windowId!); return; }
      if (raw.type === 'current') {
        const id = windowId!; const value = session(id); const token = ++value.generation;
        void chrome.tabs.query({ active: true, windowId: id }).then(tabs => { if (owned() && token === value.generation) capture(tabs[0], id); }).catch(() => { if (owned() && token === value.generation) post(port, { type: 'error', reason: '当前标签页查询失败；未采集正文。' }); });
      }
    });
  });
  return (request: import('../schemas/messages').ConfirmMutation) => {
    if (!request.saveContext) return true;
    return [...sessions.values()].some(value => value.port && value.page?.token === request.saveContext);
  };
}
