import { UI_PORT } from '../background/sidebar-host';

export function bindUi(): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return Promise.resolve(true);
  return new Promise(resolve => {
    const port = chrome.runtime.connect({ name: UI_PORT });
    const nonce = location.hash.startsWith('#') ? location.hash.slice(1) : '';
    const timer = setTimeout(() => resolve(false), 3000);
    port.onMessage.addListener((raw: unknown) => {
      clearTimeout(timer);
      const ok = !!raw && typeof raw === 'object' && 'ok' in raw && raw.ok === true;
      if (ok && location.hash) history.replaceState(null, '', `${location.pathname}${location.search}`);
      resolve(ok);
    });
    port.onDisconnect.addListener(() => { clearTimeout(timer); resolve(false); });
    port.postMessage({ type: 'bind', nonce });
  });
}
