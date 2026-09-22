import { trustedMutationSender } from '../domain/trusted-sender';
import type { SavePage } from './save-entrypoints';
import { extractSaveBody, type ExtractionBoundary, type SaveBody } from '../panel/extract-save-body';

/** Production boundary only forwards Chrome calls; token, URL and 1500-code-point validation live in extractSaveBody. */
export const chromeExtractionBoundary: ExtractionBoundary = {
  get: tabId => chrome.tabs.get(tabId),
  inject: tabId => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content-script.js'] }),
  message: (tabId, message, documentId) => chrome.tabs.sendMessage(tabId, message, { documentId }),
};
export function extractSaveBodyForUi(
  sender: chrome.runtime.MessageSender,
  page: SavePage,
  current: () => SavePage | undefined,
  boundary: ExtractionBoundary = chromeExtractionBoundary,
): Promise<SaveBody> {
  if (!trustedMutationSender(sender, chrome.runtime.id)) return Promise.reject(Error('invalid-sender'));
  return extractSaveBody(page, current, boundary).then(snippet => ({ status: 'ready', url: page.url, snippet }));
}
