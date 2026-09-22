import { afterEach, expect, it } from 'vitest';
import { extensionDocumentKind, resetUiRegistry, trustedMutationSender, uiRegistry } from '../background/ui-identity';

afterEach(() => resetUiRegistry());

const id = 'ext';
it('rejects query and accepts hash-stripped panel path', () => {
  expect(extensionDocumentKind({ id, url: `chrome-extension://${id}/panel/index.html#nonce` }, id)).toBe('panel');
  expect(extensionDocumentKind({ id, url: `chrome-extension://${id}/panel/index.html?forged=1` }, id)).toBeUndefined();
  expect(extensionDocumentKind({ id, url: `chrome-extension://${id}/options/index.html` }, id)).toBe('options');
});
it('options path is trusted without nonce; panel requires bind', () => {
  const options = { id, url: `chrome-extension://${id}/options/index.html` };
  expect(trustedMutationSender(options, id)).toBe(true);
  const panel = {
    id,
    url: `chrome-extension://${id}/panel/index.html`,
    frameId: 3,
    documentId: 'd',
    tab: { id: 1, windowId: 1 },
  };
  expect(trustedMutationSender(panel, id)).toBe(false);
  const nonce = uiRegistry().issueNonce();
  expect(uiRegistry().bind(nonce, panel, id)).toBeTruthy();
  expect(trustedMutationSender(panel, id)).toBe(true);
});
it('second frame with reused nonce is rejected', () => {
  const nonce = uiRegistry().issueNonce();
  const a = {
    id,
    url: `chrome-extension://${id}/panel/index.html#${nonce}`,
    frameId: 3,
    documentId: 'a',
    tab: { id: 1, windowId: 1 },
  };
  const b = {
    id,
    url: `chrome-extension://${id}/panel/index.html#${nonce}`,
    frameId: 4,
    documentId: 'b',
    tab: { id: 1, windowId: 1 },
  };
  expect(uiRegistry().bind(nonce, a, id)).toBeTruthy();
  expect(uiRegistry().bind(nonce, b, id)).toBeUndefined();
  expect(trustedMutationSender(b, id)).toBe(false);
});
it('transfer is bound to exact ui tab and fail-closed before bind', () => {
  const captured = { tabId: 9, windowId: 1, url: 'https://a.test/', title: 'A' };
  const id = uiRegistry().beginTransfer(captured);
  expect(uiRegistry().takeTransfer(100)).toBeUndefined();
  uiRegistry().bindTransfer(id, 77);
  expect(uiRegistry().takeTransfer(76)).toBeUndefined();
  expect(uiRegistry().takeTransfer(77)?.tabId).toBe(9);
  expect(uiRegistry().takeTransfer(77)).toBeUndefined();
});
it('expired and captured-tab invalidation drop transfers', () => {
  const id = uiRegistry().beginTransfer({ tabId: 9, windowId: 1, url: 'https://a.test/', title: 'A' });
  uiRegistry().bindTransfer(id, 77);
  uiRegistry().invalidateCapturedTab(9);
  expect(uiRegistry().takeTransfer(77)).toBeUndefined();
});
it('connect-before-bind retries when the exact created tab is bound', () => {
  const captured = { tabId: 9, windowId: 1, url: 'https://a.test/', title: 'A' };
  const id = uiRegistry().beginTransfer(captured);
  let seen = 0;
  uiRegistry().whenTransferBound(77, () => {
    seen++;
  });
  expect(seen).toBe(0);
  expect(uiRegistry().takeTransfer(77)).toBeUndefined();
  uiRegistry().bindTransfer(id, 77);
  expect(seen).toBe(1);
  expect(uiRegistry().takeTransfer(77)?.tabId).toBe(9);
});
