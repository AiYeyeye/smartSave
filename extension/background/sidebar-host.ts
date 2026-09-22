import { uiRegistry, type CapturedPage } from './ui-identity';
import { trustedMutationSender } from './ui-identity';

export const UI_PORT = 'zhilan.ui.v1';
export const HOST_GEOMETRY = 'zhilan.host.geometry';
const KEY = 'zhilan.host.geometry.v1';

type Geometry = { side: 'left' | 'right'; width: number };
const defaultGeometry = (): Geometry => ({ side: 'right', width: 320 });

export function startSidebarHost() {
  const registry = uiRegistry();
  let geometry = defaultGeometry();
  void chrome.storage.local.get(KEY).then(value => {
    const stored = value[KEY] as { side?: unknown; width?: unknown } | undefined;
    if (stored && (stored.side === 'left' || stored.side === 'right') && typeof stored.width === 'number') geometry = { side: stored.side, width: Math.min(480, Math.max(320, stored.width)) };
  });
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== UI_PORT) return;
    const sender = port.sender;
    if (!sender) { port.disconnect(); return; }
    port.onMessage.addListener((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || !('type' in raw)) return;
      if (raw.type === 'bind') {
        const nonce = 'nonce' in raw && typeof raw.nonce === 'string' ? raw.nonce : '';
        const options = !!sender.url && sender.url.split('#')[0]?.endsWith('options/index.html');
        const bound = options ? registry.bind('', sender, chrome.runtime.id) : registry.bind(nonce, sender, chrome.runtime.id);
        try { port.postMessage(bound ? { ok: true } : { ok: false }); } catch { /* disconnect */ }
        if (!bound) port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => registry.unbind(sender));
  });
  chrome.tabs.onRemoved.addListener(tabId => { registry.invalidateUiTab(tabId); });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== HOST_GEOMETRY) return false;
    if (!trustedMutationSender(sender, chrome.runtime.id)) return false;
    if ('action' in message && message.action === 'status') { reply(geometry); return false; }
    if ('action' in message && message.action === 'set') {
      if ('side' in message && (message.side === 'left' || message.side === 'right')) geometry = { ...geometry, side: message.side };
      if ('width' in message && typeof message.width === 'number') geometry = { ...geometry, width: Math.min(480, Math.max(320, message.width)) };
      void chrome.storage.local.set({ [KEY]: geometry });
      const tabId = sender.tab?.id;
      if (tabId !== undefined && /^https?:/i.test(sender.tab?.url ?? '')) {
        void chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: (side: string, width: number, close: boolean) => {
            const host = document.getElementById('zhilan-sidebar-host');
            if (close) { host?.remove(); return; }
            if (!host) return;
            host.style.left = side === 'left' ? '0' : '';
            host.style.right = side === 'right' ? '0' : '';
            host.style.width = `${width}px`;
          },
          args: [geometry.side, geometry.width, !!(message as { close?: boolean }).close],
        }).catch(() => {});
      }
      reply(geometry);
      return false;
    }
    return false;
  });
  return {
    registry,
    show(tab: chrome.tabs.Tab | undefined, capture?: CapturedPage) {
      if (!tab || tab.id === undefined || !Number.isInteger(tab.windowId) || !tab.url || !/^https?:/i.test(tab.url)) {
        this.fallback(capture);
        return;
      }
      const tabId = tab.id;
      const nonce = registry.issueNonce(capture);
      const src = chrome.runtime.getURL('panel/index.html');
      const side = geometry.side;
      const width = geometry.width;
      const reuse = !!capture;
      try {
        const injected = chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: (frameSrc: string, n: string, place: string, size: number, keep: boolean) => {
            const existing = document.getElementById('zhilan-sidebar-host');
            if (existing) {
              if (keep) return { reused: true };
              existing.remove();
              return { removed: true };
            }
            const host = document.createElement('div');
            host.id = 'zhilan-sidebar-host';
            host.style.cssText = `position:fixed;top:0;bottom:0;width:${size}px;z-index:2147483647;${place === 'left' ? 'left:0;' : 'right:0;'}`;
            const shadow = host.attachShadow({ mode: 'closed' });
            const frame = document.createElement('iframe');
            frame.src = `${frameSrc}#${n}`;
            frame.style.cssText = 'width:100%;height:100%;border:0;background:#fff;';
            shadow.append(frame);
            document.documentElement.append(host);
            return { created: true };
          },
          args: [src, nonce, side, width, reuse],
        });
        void injected.catch(() => {
          registry.invalidateCapturedTab(tabId);
          this.fallback(capture);
        });
      } catch {
        registry.invalidateCapturedTab(tabId);
        this.fallback(capture);
      }
    },
    fallback(capture?: CapturedPage) {
      const creating = chrome.tabs.create({ url: chrome.runtime.getURL('options/index.html') });
      if (!capture) { void creating.catch(() => {}); return; }
      const id = registry.beginTransfer(capture);
      void creating.then(tab => {
        if (tab.id === undefined) registry.dropTransfer(id);
        else registry.bindTransfer(id, tab.id);
      }).catch(() => registry.dropTransfer(id));
    },
  };
}
