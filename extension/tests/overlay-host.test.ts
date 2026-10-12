import { afterEach, expect, it, vi } from 'vitest';
import {
  isClaimedOverlayDocument,
  issueTokenForTests,
  overlayInjectable,
  resetOverlayHostForTests,
  startOverlayHost,
} from '../background/overlay-host';
import { extensionDocumentKind, setOverlayDocumentTrust } from '../domain/trusted-sender';

function boot() {
  let listener:
    ((message: unknown, sender: chrome.runtime.MessageSender, reply: (v: unknown) => void) => unknown) | undefined;
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', onMessage: { addListener: (fn: typeof listener) => (listener = fn) } },
    tabs: { onRemoved: { addListener: vi.fn() }, onUpdated: { addListener: vi.fn() } },
    storage: { local: { set: vi.fn(async () => {}) } },
  });
  startOverlayHost();
  return (message: unknown, sender: Partial<chrome.runtime.MessageSender>) => {
    let result: unknown;
    listener!(message, { id: 'ext', ...sender } as chrome.runtime.MessageSender, value => (result = value));
    return result;
  };
}

const framed = (documentId: string, tabId = 5, frameId = 3) => ({
  id: 'ext',
  url: 'chrome-extension://ext/panel/index.html',
  origin: 'chrome-extension://ext',
  documentId,
  frameId,
  tab: { id: tabId, url: 'https://news.example/' } as chrome.tabs.Tab,
});

afterEach(() => {
  resetOverlayHostForTests();
  setOverlayDocumentTrust(undefined);
  vi.unstubAllGlobals();
});

it('only scriptable web pages get the overlay; browser pages fall back to the side panel', () => {
  expect(overlayInjectable('https://example.com/a')).toBe(true);
  expect(overlayInjectable('chrome://newtab/')).toBe(false);
  expect(overlayInjectable('https://chromewebstore.google.com/detail/x')).toBe(false);
  expect(overlayInjectable(undefined)).toBe(false);
});

it('a framed panel is trusted only after claiming the one-time token minted for its own tab', () => {
  const send = boot();
  setOverlayDocumentTrust(sender => isClaimedOverlayDocument(sender as never));
  // Unclaimed: an extension document inside a web page stays untrusted.
  expect(extensionDocumentKind(framed('doc-a'), 'ext')).toBeUndefined();
  const token = issueTokenForTests(5);
  // Wrong tab, top frame or wrong document path cannot claim.
  expect(send({ type: 'zhilan-overlay-claim', token }, framed('doc-x', 6))).toEqual({ ok: false });
  expect(send({ type: 'zhilan-overlay-claim', token }, framed('doc-y', 5, 0))).toEqual({ ok: false });
  expect(send({ type: 'zhilan-overlay-claim', token }, framed('doc-a'))).toEqual({ ok: true });
  expect(extensionDocumentKind(framed('doc-a'), 'ext')).toBe('panel');
  // Tokens are single use; another frame in the same tab cannot reuse it.
  expect(send({ type: 'zhilan-overlay-claim', token }, framed('doc-b'))).toEqual({ ok: false });
  expect(extensionDocumentKind(framed('doc-b'), 'ext')).toBeUndefined();
  // Closing the overlay forgets the tab.
  send({ type: 'zhilan-overlay-closed' }, { tab: { id: 5 } as chrome.tabs.Tab, frameId: 0 });
  expect(extensionDocumentKind(framed('doc-a'), 'ext')).toBeUndefined();
});
