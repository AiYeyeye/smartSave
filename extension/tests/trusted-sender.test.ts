import { expect, it } from 'vitest';
import { extensionDocumentKind, trustedMutationSender } from '../domain/trusted-sender';

const id = 'ext';
const panel = `chrome-extension://${id}/panel/index.html`;
const options = `chrome-extension://${id}/options/index.html`;
const save = `chrome-extension://${id}/save/index.html`;

it('trusts only the exact top-level save document, never its framed or query variants', () => {
  expect(extensionDocumentKind({ id, url: save, frameId: 0, tab: { id: 1, url: save } }, id)).toBe('save');
  expect(extensionDocumentKind({ id, url: `${save}?tabId=1` }, id)).toBeUndefined();
  expect(extensionDocumentKind({ id, url: save, frameId: 2, tab: { url: save } }, id)).toBeUndefined();
  expect(extensionDocumentKind({ id, url: save, frameId: 2, tab: { url: 'https://evil.test/' } }, id)).toBeUndefined();
});

it('trusts the popup and options documents by exact extension id and path', () => {
  expect(extensionDocumentKind({ id, url: panel, documentId: 'popup' }, id)).toBe('panel');
  expect(extensionDocumentKind({ id, url: options, tab: { id: 7, url: options } }, id)).toBe('options');
  expect(trustedMutationSender({ id, url: panel }, id)).toBe(true);
  expect(trustedMutationSender({ id, url: options }, id)).toBe(true);
});
it('allows a routing hash but rejects any query string', () => {
  expect(extensionDocumentKind({ id, url: `${options}#organize` }, id)).toBe('options');
  expect(extensionDocumentKind({ id, url: `${panel}#pending` }, id)).toBe('panel');
  expect(extensionDocumentKind({ id, url: `${panel}?forged=1` }, id)).toBeUndefined();
  expect(trustedMutationSender({ id, url: `${options}?forged=1` }, id)).toBe(false);
});
it('rejects foreign extension ids, foreign hosts, other paths and mismatched origins', () => {
  expect(trustedMutationSender({ id: 'other', url: panel }, id)).toBe(false);
  expect(trustedMutationSender({ id, url: 'chrome-extension://other/panel/index.html' }, id)).toBe(false);
  expect(trustedMutationSender({ id, url: `chrome-extension://${id}/other.html` }, id)).toBe(false);
  expect(trustedMutationSender({ id, url: `https://evil.test/${id}/options/index.html` }, id)).toBe(false);
  expect(trustedMutationSender({ id, url: panel, origin: 'https://evil.test' }, id)).toBe(false);
  expect(trustedMutationSender({ id, url: panel }, '')).toBe(false);
  expect(trustedMutationSender({ id, url: 'not a url' }, id)).toBe(false);
  expect(trustedMutationSender({ id }, id)).toBe(false);
});
it('rejects content scripts and any extension document framed inside a web tab', () => {
  const contentScript = { id, url: 'https://page.test/article', tab: { id: 4, url: 'https://page.test/article' } };
  expect(trustedMutationSender(contentScript, id)).toBe(false);
  const framed = { id, url: panel, frameId: 3, documentId: 'frame', tab: { id: 4, url: 'https://page.test/' } };
  expect(extensionDocumentKind(framed, id)).toBeUndefined();
  expect(trustedMutationSender(framed, id)).toBe(false);
});
