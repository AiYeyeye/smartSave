import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

/**
 * Two hosts share this document: the browser side panel, and the overlay sidebar a toolbar click injects into
 * the page (an iframe carrying a one-time token in its hash). The overlay claims its token before anything
 * connects, then drops it from the URL.
 */
const overlayToken = window.top !== window ? /^#overlay=([\w-]+)$/.exec(location.hash)?.[1] : undefined;
document.body.classList.add('sidepanel');
if (overlayToken) document.body.classList.add('overlay');

async function claim(token: string) {
  try {
    history.replaceState(null, '', location.pathname);
  } catch {
    /* keep going */
  }
  try {
    await chrome.runtime.sendMessage({ type: 'zhilan-overlay-claim', token });
  } catch {
    /* an unclaimed frame simply stays untrusted; the UI shows its disconnected state */
  }
}

void (overlayToken ? claim(overlayToken) : Promise.resolve()).then(() => {
  createRoot(root).render(
    <StrictMode>
      <App page="panel" overlay={!!overlayToken} />
    </StrictMode>,
  );
});
