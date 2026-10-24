/**
 * Sender authority for extension-owned documents.
 *
 * The panel, options and standalone save documents are the trusted UI documents. Trust is decided from exact facts Chrome attaches to the sender (extension id, exact document URL,
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
export type ExtensionDocumentKind = 'panel' | 'options' | 'save';

const DOCUMENTS: Record<string, ExtensionDocumentKind> = {
  'panel/index.html': 'panel',
  'options/index.html': 'options',
  'save/index.html': 'save',
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

/**
 * Overlay sidebar exception: the service worker vouches for exactly the panel documents that claimed a
 * one-time token minted for an explicit toolbar click. Unset (tests, pages) means no exception.
 */
let overlayDocumentTrusted: ((sender: SenderLite) => boolean) | undefined;
let overlayTrustReady: (() => Promise<void>) | undefined;
export function setOverlayDocumentTrust(
  check: ((sender: SenderLite) => boolean) | undefined,
  ready?: () => Promise<void>,
) {
  overlayDocumentTrusted = check;
  overlayTrustReady = ready;
}

/** Register listeners synchronously; a previously claimed frame may wait for worker-session hydration. */
export function withTrustedSender(
  sender: SenderLite,
  extensionId: string,
  run: () => void,
  denied: () => void = () => {},
): boolean {
  if (trustedMutationSender(sender, extensionId)) {
    run();
    return true;
  }
  const url = sender.url ? extensionOrigin(sender.url, extensionId) : undefined;
  if (
    !overlayTrustReady ||
    sender.id !== extensionId ||
    !sender.documentId ||
    (sender.frameId ?? 0) <= 0 ||
    !url ||
    url.search ||
    url.pathname !== '/panel/index.html' ||
    (sender.origin && sender.origin !== `chrome-extension://${extensionId}`)
  ) {
    denied();
    return false;
  }
  void overlayTrustReady().then(() => {
    if (trustedMutationSender(sender, extensionId)) run();
    else denied();
  }, denied);
  return true;
}

/** An extension document can only be hosted inside a web tab through an iframe; that host is never trusted. */
function hostedOutsideExtension(sender: SenderLite, extensionId: string): boolean {
  const tab = sender.tab;
  if (!tab || typeof tab !== 'object' || !('url' in tab)) return false;
  const url = (tab as { url?: unknown }).url;
  if (typeof url !== 'string' || !url) return false;
  if (extensionOrigin(url, extensionId) !== undefined) return false;
  return !(overlayDocumentTrusted?.(sender) ?? false);
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
  if (parsed.pathname === '/save/index.html' && (sender.frameId ?? 0) !== 0) return;
  if (sender.origin && sender.origin !== `chrome-extension://${extensionId}`) return;
  if (hostedOutsideExtension(sender, extensionId)) return;
  return DOCUMENTS[parsed.pathname.replace(/^\//, '')];
}

/** Both extension-owned documents may drive mutations, reads and save capture; no other sender may. */
export function trustedMutationSender(sender: SenderLite, extensionId: string): boolean {
  return extensionDocumentKind(sender, extensionId) !== undefined;
}
