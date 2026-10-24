import { browserMessage, setBrowserLanguage } from '../domain/browser-message';
/**
 * Left-edge overlay sidebar, injected only on an explicit toolbar click (activeTab). Runs in the isolated
 * world; the frame lives in a closed shadow root so the page can neither style nor read it. Clicking the
 * dimmed page area, pressing Esc or the panel's close button slides it away. Running the script again
 * toggles it.
 */
type Init = { token: string; width: number; ensureOpen?: boolean };
type Overlay = { toggle: () => void };
const scope = globalThis as unknown as { __zhilanOverlayInit?: Init; __zhilanOverlay?: Overlay };

(() => {
  const init = scope.__zhilanOverlayInit;
  scope.__zhilanOverlayInit = undefined;
  if (scope.__zhilanOverlay) {
    // A save shortcut only needs the sidebar visible; the toolbar button toggles it.
    if (!init?.ensureOpen) scope.__zhilanOverlay.toggle();
    return;
  }
  if (!init?.token) return;

  const MIN = 300;
  const MAX = 720;
  let width = Math.min(MAX, Math.max(MIN, init.width));
  const host = document.createElement('zhilan-sidebar');
  host.style.cssText =
    'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;contain:strict;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .scrim { position: fixed; inset: 0; background: rgba(15, 18, 25, 0.22); opacity: 0; pointer-events: auto;
      transition: opacity 220ms ease; }
    .panel { position: fixed; top: 0; left: 0; bottom: 0; width: var(--w); max-width: 92vw; pointer-events: auto;
      transform: translateX(-104%); transition: transform 280ms cubic-bezier(0.22, 1, 0.36, 1);
      background: #f4f5f7; border-radius: 0 14px 14px 0; overflow: hidden;
      box-shadow: 0 0 0 1px rgba(16, 24, 40, 0.08), 16px 0 48px rgba(16, 24, 40, 0.22); }
    .open .scrim { opacity: 1; }
    .open .panel { transform: none; }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: normal; }
    .grip { position: absolute; top: 0; right: -4px; width: 8px; height: 100%; cursor: ew-resize; }
    .resizing iframe { pointer-events: none; }
    .resizing .panel { transition: none; }
    @media (prefers-color-scheme: dark) { .panel { background: #0f1013; } .scrim { background: rgba(0, 0, 0, 0.45); } }
    @media (prefers-reduced-motion: reduce) { .scrim, .panel { transition: none; } }
  `;
  const shell = document.createElement('div');
  shell.style.setProperty('--w', `${width}px`);
  const scrim = document.createElement('div');
  scrim.className = 'scrim';
  const panel = document.createElement('div');
  panel.className = 'panel';
  const frame = document.createElement('iframe');
  frame.title = browserMessage('sidebarTitle');
  frame.allow = 'clipboard-write';
  frame.src = chrome.runtime.getURL(`panel/index.html#overlay=${init.token}`);
  const grip = document.createElement('div');
  grip.className = 'grip';
  panel.append(frame, grip);
  shell.append(scrim, panel);
  root.append(style, shell);

  let open = false;
  let closing: ReturnType<typeof setTimeout> | undefined;

  function show() {
    if (closing) clearTimeout(closing);
    closing = undefined;
    if (!host.isConnected) document.documentElement.append(host);
    open = true;
    requestAnimationFrame(() => requestAnimationFrame(() => shell.classList.add('open')));
    setTimeout(() => frame.focus(), 300);
  }
  function hide() {
    if (!open) return;
    open = false;
    shell.classList.remove('open');
    closing = setTimeout(() => {
      host.remove();
      closing = undefined;
    }, 300);
  }
  function dispose() {
    hide();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('message', onMessage);
    scope.__zhilanOverlay = undefined;
    try {
      void chrome.runtime.sendMessage({ type: 'zhilan-overlay-closed' });
    } catch {
      /* extension reloaded */
    }
  }
  function onKey(event: KeyboardEvent) {
    if (open && event.key === 'Escape') {
      event.stopPropagation();
      dispose();
    }
  }
  function onMessage(event: MessageEvent) {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { type?: unknown; language?: unknown } | null;
    if (data && data.type === 'zhilan-overlay-close') dispose();
    if (data?.type === 'zhilan-overlay-language' && (data.language === 'en' || data.language === 'zh-CN')) {
      // The verified frame owns the choice; content scripts cannot read trusted-only extension storage.
      setBrowserLanguage(data.language);
      frame.title = browserMessage('sidebarTitle');
    }
  }

  scrim.addEventListener('click', dispose);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('message', onMessage);

  grip.addEventListener('pointerdown', event => {
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    shell.classList.add('resizing');
    const move = (e: PointerEvent) => {
      width = Math.min(MAX, Math.max(MIN, e.clientX));
      shell.style.setProperty('--w', `${width}px`);
    };
    const up = () => {
      shell.classList.remove('resizing');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      try {
        void chrome.runtime.sendMessage({ type: 'zhilan-overlay-width', width });
      } catch {
        /* extension reloaded */
      }
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });

  scope.__zhilanOverlay = { toggle: () => (open ? dispose() : show()) };
  show();
})();
