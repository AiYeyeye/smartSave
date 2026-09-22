/**
 * Sender authority for extension-owned documents.
 *
 * The toolbar popup (`panel/index.html`) and the options page (`options/index.html`) are the only trusted UI
 * documents. Trust is decided from exact facts Chrome attaches to the sender (extension id, exact document URL,
 * origin and the hosting tab) — never from a nonce, a registry or any state the page could forge.
 */
export type SenderLite = {
  id?: string;
  url?: string;
  origin?: string;
  tab?: unknown;
  frameId?: number;
  documentId?: string;
};
export type ExtensionDocumentKind = 'panel' | 'options';

const DOCUMENTS: Record<string, ExtensionDocumentKind> = {
  'panel/index.html': 'panel',
  'options/index.html': 'options',
};

function extensionOrigin(url: string, extensionId: string): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  return parsed.protocol === 'chrome-extension:' && parsed.host === extensionId ? parsed : undefined;
}

/** An extension document can only be hosted inside a web tab through an iframe; that host is never trusted. */
function hostedOutsideExtension(sender: SenderLite, extensionId: string): boolean {
  const tab = sender.tab;
  if (!tab || typeof tab !== 'object' || !('url' in tab)) return false;
  const url = (tab as { url?: unknown }).url;
  if (typeof url !== 'string' || !url) return false;
  return extensionOrigin(url, extensionId) === undefined;
}

/**
 * Classifies a sender as the popup (`panel`) or the options page; anything else is untrusted.
 * Query strings are rejected because a forged document could carry state there; a hash is allowed because the
 * options page uses it for routing only.
 */
export function extensionDocumentKind(sender: SenderLite, extensionId: string): ExtensionDocumentKind | undefined {
  if (!extensionId || sender.id !== extensionId || !sender.url) return;
  const parsed = extensionOrigin(sender.url, extensionId);
  if (!parsed || parsed.search) return;
  if (sender.origin && sender.origin !== `chrome-extension://${extensionId}`) return;
  if (hostedOutsideExtension(sender, extensionId)) return;
  return DOCUMENTS[parsed.pathname.replace(/^\//, '')];
}

/** Both extension-owned documents may drive mutations, reads and save capture; no other sender may. */
export function trustedMutationSender(sender: SenderLite, extensionId: string): boolean {
  return extensionDocumentKind(sender, extensionId) !== undefined;
}
