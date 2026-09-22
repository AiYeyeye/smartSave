import { validateUrl } from '../domain/preflight';
import { trustedMutationSender } from '../schemas/messages';
import type { CapturedPage } from './ui-identity';
import { uiRegistry } from './ui-identity';
export const SAVE_PORT = 'zhilan.save.v1';
export interface SavePage {
  tabId: number;
  token: string;
  title: string;
  url: string;
}
export function startSaveEntrypoints(
  onInvalidated: () => void = () => {},
  show?: (tab: chrome.tabs.Tab | undefined, capture?: CapturedPage) => void,
) {
  const sessions = new Map<
    number,
    { page?: SavePage; port?: chrome.runtime.Port; generation: number; uiTabId?: number }
  >();
  const session = (id: number) => {
    let value = sessions.get(id);
    if (!value) {
      value = { generation: 0 };
      sessions.set(id, value);
    }
    return value;
  };
  const post = (port: chrome.runtime.Port | undefined, value: unknown) => {
    try {
      port?.postMessage(value);
    } catch {
      /* Disconnection invalidates via the port lifecycle. */
    }
  };
  const invalidateTab = (tabId: number) => {
    const value = sessions.get(tabId);
    if (!value) return;
    value.generation++;
    value.page = undefined;
    onInvalidated();
    post(value.port, { type: 'invalidated' });
    uiRegistry().invalidateCapturedTab(tabId);
  };
  function capture(tab: chrome.tabs.Tab | undefined): CapturedPage | undefined {
    if (tab?.id === undefined || !Number.isInteger(tab.windowId) || !tab.url) return;
    try {
      validateUrl(tab.url);
    } catch {
      return;
    }
    const value = session(tab.id);
    value.generation++;
    onInvalidated();
    value.page = { tabId: tab.id, token: crypto.randomUUID(), url: tab.url, title: tab.title ?? tab.url };
    post(value.port, { type: 'page', page: value.page });
    return { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title ?? tab.url };
  }
  function activate(tab: chrome.tabs.Tab | undefined, capturePage: boolean) {
    if (tab?.id === undefined || !Number.isInteger(tab.windowId)) return;
    if (!capturePage) invalidateTab(tab.id);
    const captured = capturePage ? capture(tab) : undefined;
    if (capturePage && !captured)
      post(session(tab.id).port, {
        type: 'error',
        reason: '当前页面资料不可用；请使用页面菜单或已配置命名快捷键激活收藏。',
      });
    show?.(tab, captured);
  }
  chrome.action.onClicked.addListener(tab => activate(tab, false));
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'save-current-page') activate(tab, true);
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'zhilan-save-page') activate(tab, true);
  });
  chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create(
      {
        id: 'zhilan-save-page',
        title: '使用智栏收藏当前页面',
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      () => {
        if (chrome.runtime.lastError) console.error('智栏收藏菜单创建失败');
      },
    );
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'loading' && change.url === undefined) return;
    invalidateTab(tabId);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    invalidateTab(tabId);
    sessions.delete(tabId);
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== SAVE_PORT || !port.sender || !trustedMutationSender(port.sender, chrome.runtime.id)) return;
    let owner: number | undefined;
    const owned = () => owner !== undefined && sessions.get(owner)?.port === port;
    port.onDisconnect.addListener(() => {
      if (!owned()) return;
      invalidateTab(owner!);
      session(owner!).port = undefined;
    });
    port.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      if (raw.type === 'register') {
        const attach = () => {
          const uiTab = port.sender?.tab;
          const hostUrl = uiTab?.url ?? '';
          const transferred =
            uiTab?.id !== undefined && !/^https?:/i.test(hostUrl) ? uiRegistry().takeTransfer(uiTab.id) : undefined;
          owner = transferred?.tabId ?? (/^https?:/i.test(hostUrl) ? uiTab?.id : undefined);
          if (owner === undefined) return false;
          const value = session(owner);
          const old = value.port;
          value.port = port;
          value.uiTabId = uiTab?.id;
          if (old && old !== port) {
            post(old, { type: 'invalidated' });
            old.disconnect();
          }
          if (value.page) post(port, { type: 'page', page: value.page });
          return true;
        };
        if (attach()) return;
        const uiTabId = port.sender?.tab?.id;
        const hostUrl = port.sender?.tab?.url ?? '';
        if (uiTabId !== undefined && !/^https?:/i.test(hostUrl)) uiRegistry().whenTransferBound(uiTabId, attach);
        return;
      }
      if (!owned()) return;
      if (raw.type === 'close') {
        invalidateTab(owner!);
        return;
      }
      if (raw.type === 'current') return;
    });
  });
  return {
    validateSaveContext: (request: import('../schemas/messages').ConfirmMutation) => {
      if (!request.saveContext) return true;
      return [...sessions.values()].some(value => value.port && value.page?.token === request.saveContext);
    },
    livePageForSender: (sender: chrome.runtime.MessageSender) => {
      const uiTabId = sender.tab?.id ?? uiRegistry().mountFor(sender, chrome.runtime?.id ?? '')?.tabId;
      if (uiTabId === undefined) return;
      return [...sessions.values()].find(s => s.port && s.uiTabId === uiTabId && s.page)?.page;
    },
  };
}
