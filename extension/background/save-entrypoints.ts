import { initializeOnboarding } from '../persistence/onboarding';
import { browserMessage, onBrowserLanguageChange } from '../domain/browser-message';
import { validateUrl } from '../domain/preflight';
import { extensionDocumentKind, withTrustedSender } from '../domain/trusted-sender';
import type { ConfirmMutation } from '../schemas/messages';
import { actionBadges } from './action-badge';
export { SAVE_BADGE } from './action-badge';

export const SAVE_PORT = 'zhilan.save.v1';
const PAGE_UNAVAILABLE = '当前页面资料不可用；仅支持 http(s) 网页，请切换到网页标签后重试。';
const NO_ACTIVE_TAB = '无法确定当前标签页；请在浏览器窗口中重新打开智栏。';

export interface SavePage {
  tabId: number;
  token: string;
  title: string;
  url: string;
}
/** Brings the extension UI to the user after a capture; the production host is an independent bookmark window. */
export type OpenSaveUi = (tabId: number) => Promise<void>;

type Session = { page?: SavePage; port?: chrome.runtime.Port; generation: number; uiKey?: string };
type Sender = Pick<chrome.runtime.MessageSender, 'documentId' | 'tab'>;

async function setBadge(tabId: number, on: boolean): Promise<void> {
  await actionBadges()?.savePending(tabId, on);
}
const uiKeyOf = (sender: Sender | undefined): string | undefined =>
  sender?.documentId ?? (sender?.tab?.id !== undefined ? `tab:${sender.tab.id}` : undefined);
function capturable(tab: chrome.tabs.Tab | undefined): tab is chrome.tabs.Tab & { id: number; url: string } {
  if (tab?.id === undefined || !Number.isInteger(tab.windowId) || !tab.url) return false;
  try {
    validateUrl(tab.url);
    return true;
  } catch {
    return false;
  }
}
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id !== undefined && Number.isInteger(tab.windowId) ? tab : undefined;
  } catch {
    return undefined;
  }
}

export function startSaveEntrypoints(
  onInvalidated: () => void,
  open: OpenSaveUi,
  dialog?: {
    sourceForSender(sender: chrome.runtime.MessageSender): Promise<number | undefined>;
    finishCapture(sender: chrome.runtime.MessageSender, sourceTabId: number): Promise<void>;
  },
) {
  const sessions = new Map<number, Session>();
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
    void setBadge(tabId, false);
  };
  function capture(tab: chrome.tabs.Tab | undefined): SavePage | undefined {
    if (!capturable(tab)) return;
    const value = session(tab.id);
    if (value.page && value.port && extensionDocumentKind(value.port.sender ?? {}, chrome.runtime.id) === 'save')
      return value.page;
    value.generation++;
    onInvalidated();
    value.page = { tabId: tab.id, token: crypto.randomUUID(), url: tab.url, title: tab.title ?? tab.url };
    post(value.port, { type: 'page', page: value.page });
    return value.page;
  }
  /** Shortcut and page menu: capture the gesture tab, then bring the UI up unless a popup already shows that tab. */
  function activate(tab: chrome.tabs.Tab | undefined) {
    if (tab?.id === undefined || !Number.isInteger(tab.windowId)) return;
    if (!capture(tab)) {
      post(sessions.get(tab.id)?.port, { type: 'error', reason: PAGE_UNAVAILABLE });
      return;
    }
    const owner = sessions.get(tab.id)?.port;
    if (owner && owner.sender?.tab === undefined) return;
    void open(tab.id).catch(() => {});
  }
  chrome.commands.onCommand.addListener((command, tab) => {
    if (command === 'save-current-page') activate(tab);
  });
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'zhilan-save-page') activate(tab);
  });
  chrome.runtime.onInstalled.addListener(details => {
    if (details?.reason === 'install')
      void initializeOnboarding(details.reason, chrome.storage.local).catch(() => {
        /* The sidebar guide remains available from settings if local persistence fails. */
      });
    chrome.contextMenus.create(
      {
        id: 'zhilan-save-page',
        title: browserMessage('savePage'),
        contexts: ['page'],
        documentUrlPatterns: ['http://*/*', 'https://*/*'],
      },
      () => {
        if (chrome.runtime.lastError) console.error('智栏收藏菜单创建失败');
      },
    );
  });
  // Menus survive worker/browser restarts; update their label without replacing their handlers.
  const refreshLanguage = () =>
    chrome.contextMenus.update?.('zhilan-save-page', { title: browserMessage('savePage') }, () => {
      // On first install the menu may not exist yet; onInstalled creates it with the same localized title.
      void chrome.runtime.lastError;
    });
  refreshLanguage();
  onBrowserLanguageChange(refreshLanguage);
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== 'loading' && change.url === undefined) return;
    invalidateTab(tabId);
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    invalidateTab(tabId);
    sessions.delete(tabId);
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== SAVE_PORT || !port.sender) return;
    let owner: number | undefined;
    let alive = true;
    const owned = () => owner !== undefined && sessions.get(owner)?.port === port;
    const release = () => {
      if (!owned()) return;
      const value = session(owner!);
      value.port = undefined;
      value.uiKey = undefined;
      invalidateTab(owner!);
    };
    /** The popup has no tab of its own: the active tab of its window is the page it speaks for. */
    function attach(tabId: number) {
      if (owner === tabId && owned()) return;
      release();
      owner = tabId;
      const value = session(tabId);
      const old = value.port;
      value.port = port;
      value.uiKey = uiKeyOf(port.sender);
      if (old && old !== port) {
        post(old, { type: 'invalidated' });
        old.disconnect();
      }
      if (value.page) post(port, { type: 'page', page: value.page });
      // The badge only invites the user to open the UI for this tab; once a UI is attached it has served its purpose.
      void setBadge(tabId, false);
    }
    async function bindActive(captureNow: boolean) {
      if (extensionDocumentKind(port.sender!, chrome.runtime.id) === 'save') {
        const tabId = await dialog?.sourceForSender(port.sender!);
        if (!alive) return;
        if (tabId !== undefined) {
          if (sessions.get(tabId)?.page) attach(tabId);
          else if (dialog) {
            await dialog.finishCapture(port.sender!, tabId);
            await bindActive(false);
          }
        }
        // Never recapture from the now-focused popup or revive an expired capture after worker restart.
        return;
      }
      const tab = await activeTab();
      if (!alive) return;
      if (!tab) {
        if (captureNow) post(port, { type: 'error', reason: NO_ACTIVE_TAB });
        return;
      }
      attach(tab.id!);
      if (captureNow && !capture(tab)) post(port, { type: 'error', reason: PAGE_UNAVAILABLE });
    }
    port.onDisconnect.addListener(() => {
      alive = false;
      release();
    });
    port.onMessage.addListener((raw: unknown) => {
      withTrustedSender(
        port.sender!,
        chrome.runtime.id,
        () => {
          if (!alive) return;
          if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
          if (raw.type === 'register') {
            void bindActive(false);
            return;
          }
          if (raw.type === 'capture') {
            void bindActive(true);
            return;
          }
          if (!owned()) return;
          if (raw.type === 'close') {
            invalidateTab(owner!);
            if (dialog && extensionDocumentKind(port.sender!, chrome.runtime.id) === 'save')
              void dialog.finishCapture(port.sender!, owner!).then(() => bindActive(false));
          }
        },
        () => port.disconnect(),
      );
    });
    withTrustedSender(
      port.sender,
      chrome.runtime.id,
      () => {},
      () => port.disconnect(),
    );
  });
  return {
    validateSaveContext: (request: ConfirmMutation) => {
      if (!request.saveContext) return true;
      return [...sessions.values()].some(value => value.port && value.page?.token === request.saveContext);
    },
    /** Exact popup document first; a lone tab-less popup is unambiguous, any tab-hosted sender must match exactly. */
    livePageForSender: (sender: chrome.runtime.MessageSender) => {
      const live = [...sessions.values()].filter(value => value.port && value.page);
      const key = uiKeyOf(sender);
      const exact = key === undefined ? undefined : live.find(value => value.uiKey === key);
      if (exact) return exact.page;
      return sender.tab === undefined && live.length === 1 ? live[0]!.page : undefined;
    },
  };
}
