import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
import { ThemeProvider } from '../ui/ThemeProvider';
import { StateMessage } from '../ui/StateMessage';
import { claimOverlay } from './claim-overlay';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');

/**
 * Two hosts share this document: the browser side panel, and the overlay sidebar a toolbar click injects into
 * the page (an iframe carrying a one-time token in its hash). The overlay claims its token before anything
 * connects, then drops it from the URL.
 */
const framed = window.top !== window;
const overlayToken = framed ? /^#overlay=([\w-]+)$/.exec(location.hash)?.[1] : undefined;
document.body.classList.add('sidepanel');
if (framed) document.body.classList.add('overlay');
const view = createRoot(root);

if (framed)
  view.render(
    <ThemeProvider>
      <StateMessage kind="loading" title="正在连接智栏…" />
    </ThemeProvider>,
  );
void (framed ? (overlayToken ? claimOverlay(overlayToken) : Promise.resolve(false)) : Promise.resolve(true)).then(
  authorized => {
    if (!authorized) {
      view.render(
        <ThemeProvider>
          <StateMessage kind="error" title="侧栏启动验证未通过">
            <p>书签尚未连接。请关闭此侧栏，再点击扩展图标重新打开；若刚更新了扩展，请先刷新当前网页。</p>
            <button onClick={() => window.parent.postMessage({ type: 'zhilan-overlay-close' }, '*')}>关闭侧栏</button>
          </StateMessage>
        </ThemeProvider>,
      );
      return;
    }
    if (overlayToken) {
      try {
        history.replaceState(null, '', location.pathname);
      } catch {
        /* URL cleanup is not an authority check. */
      }
    }
    view.render(
      <StrictMode>
        <App page="panel" overlay={!!overlayToken} />
      </StrictMode>,
    );
  },
);
