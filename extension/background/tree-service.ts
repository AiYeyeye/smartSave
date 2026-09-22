import { bookmarksRead } from '../adapters/bookmarks-read';
import { TREE_PORT } from '../domain/node-reference';
import { installationIdentity } from './installation-identity';
import { TreeProjection } from './tree-projection';
import { trustedMutationSender } from '../domain/trusted-sender';
export function startTreeService() {
  const ensureIdentity = installationIdentity(chrome.storage.local);
  const projection = new TreeProjection(bookmarksRead(chrome.bookmarks), ensureIdentity, crypto.randomUUID());
  projection.start();
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== TREE_PORT) return;
    if (!port.sender || !trustedMutationSender(port.sender, chrome.runtime.id)) {
      port.disconnect();
      return;
    }
    const unsubscribe = projection.subscribe(state => {
      try {
        port.postMessage({ version: 1, state });
      } catch {
        /* Disconnected port: onDisconnect removes subscription. */
      }
    });
    port.onMessage.addListener((message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        'version' in message &&
        message.version === 1 &&
        'type' in message &&
        message.type === 'refresh'
      ) {
        // A connecting page only needs the current authoritative state; a global native re-read is reserved for recovery.
        if (projection.state.status === 'ready') {
          try {
            port.postMessage({ version: 1, state: projection.state });
          } catch {
            /* Disconnected port: onDisconnect removes subscription. */
          }
        } else projection.refresh();
      }
    });
    port.onDisconnect.addListener(unsubscribe);
    if (projection.state.status === 'error') projection.refresh();
  });
  return projection;
}
