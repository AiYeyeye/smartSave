import { bookmarksRead } from '../adapters/bookmarks-read';
import { TREE_PORT } from '../domain/node-reference';
import { installationIdentity } from './installation-identity';
import { TreeProjection } from './tree-projection';
export function startTreeService() {
  const ensureIdentity = installationIdentity(chrome.storage.local);
  const projection = new TreeProjection(bookmarksRead(chrome.bookmarks), ensureIdentity, crypto.randomUUID());
  projection.start();
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== TREE_PORT) return;
    if ( port.sender?.id !== chrome.runtime.id || ![chrome.runtime.getURL('panel/index.html'), chrome.runtime.getURL('options/index.html')].includes(port.sender.url ?? '')) { port.disconnect(); return; }
    const unsubscribe = projection.subscribe(state => {
      try { port.postMessage({ version: 1, state }); } catch { /* Disconnected port: onDisconnect removes subscription. */ }
    });
    port.onMessage.addListener((message: unknown) => {
      if (message && typeof message === 'object' && 'version' in message && message.version === 1 && 'type' in message && message.type === 'refresh') projection.refresh();
    });
    port.onDisconnect.addListener(unsubscribe);
    if (projection.state.status === 'error') projection.refresh();
  });
  return projection;
}
