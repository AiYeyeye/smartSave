export type SenderLite = {
  id?: string;
  url?: string;
  origin?: string;
  tab?: unknown;
  frameId?: number;
  documentId?: string;
};
export type CapturedPage = { tabId: number; windowId: number; url: string; title: string; documentId?: string };
export type BoundUi = {
  kind: 'panel' | 'options';
  tabId?: number;
  windowId?: number;
  frameId?: number;
  documentId?: string;
  url: string;
};

export function extensionDocumentKind(sender: SenderLite, extensionId: string): 'panel' | 'options' | undefined {
  if (sender.id !== extensionId || !sender.url) return;
  let parsed: URL;
  try {
    parsed = new URL(sender.url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'chrome-extension:' || parsed.host !== extensionId) return;
  if (parsed.search) return;
  if (sender.origin && sender.origin !== `chrome-extension://${extensionId}`) return;
  const path = parsed.pathname.replace(/^\//, '');
  if (path === 'panel/index.html') return 'panel';
  if (path === 'options/index.html') return 'options';
}

export class UiIdentityRegistry {
  private mounts = new Map<string, BoundUi>();
  private nonces = new Map<string, { captured?: CapturedPage; expires: number; used: boolean }>();
  private transfers = new Map<string, { captured: CapturedPage; uiTabId: number; expires: number; used: boolean }>();
  private transferWaiters = new Map<number, Array<() => void>>();
  issueNonce(captured?: CapturedPage) {
    const nonce = crypto.randomUUID();
    this.nonces.set(nonce, { captured, expires: Date.now() + 60_000, used: false });
    return nonce;
  }
  bind(nonce: string, sender: SenderLite, extensionId: string): BoundUi | undefined {
    const kind = extensionDocumentKind(sender, extensionId);
    if (kind === 'options') {
      const tab =
        sender.tab && typeof sender.tab === 'object' ? (sender.tab as { id?: number; windowId?: number }) : undefined;
      const ui: BoundUi = {
        kind,
        tabId: tab?.id,
        windowId: tab?.windowId,
        frameId: sender.frameId ?? 0,
        documentId: sender.documentId,
        url: sender.url!,
      };
      this.mounts.set(this.key(ui), ui);
      return ui;
    }
    if (kind !== 'panel') return;
    const ticket = this.nonces.get(nonce);
    if (!ticket || ticket.used || ticket.expires < Date.now()) return;
    if (sender.documentId && [...this.mounts.values()].some(m => m.documentId === sender.documentId)) return;
    ticket.used = true;
    const panelTab =
      sender.tab && typeof sender.tab === 'object' ? (sender.tab as { id?: number; windowId?: number }) : undefined;
    const ui: BoundUi = {
      kind,
      tabId: panelTab?.id,
      windowId: panelTab?.windowId,
      frameId: sender.frameId,
      documentId: sender.documentId,
      url: sender.url!,
    };
    this.mounts.set(this.key(ui), ui);
    return ui;
  }
  mountFor(sender: SenderLite, extensionId: string) {
    const kind = extensionDocumentKind(sender, extensionId);
    if (!kind) return;
    const tab = sender.tab && typeof sender.tab === 'object' ? (sender.tab as { id?: number }) : undefined;
    return [...this.mounts.values()].find(
      m =>
        m.kind === kind &&
        ((sender.documentId && m.documentId === sender.documentId) ||
          (tab?.id !== undefined && m.tabId === tab.id && m.frameId === sender.frameId)),
    );
  }
  isBound(sender: SenderLite, extensionId: string) {
    const kind = extensionDocumentKind(sender, extensionId);
    if (!kind) return false;
    const tab =
      sender.tab && typeof sender.tab === 'object' ? (sender.tab as { id?: number; url?: string }) : undefined;
    if (kind === 'options') {
      if (tab?.url) return extensionDocumentKind({ ...sender, url: tab.url }, extensionId) === 'options';
      return true;
    }
    return [...this.mounts.values()].some(
      m =>
        m.kind === 'panel' &&
        m.documentId &&
        m.documentId === sender.documentId &&
        m.frameId === sender.frameId &&
        (tab?.id === undefined || m.tabId === tab.id),
    );
  }
  unbind(sender: SenderLite) {
    const tab = sender.tab && typeof sender.tab === 'object' ? (sender.tab as { id?: number }) : undefined;
    for (const [key, m] of this.mounts)
      if (m.documentId === sender.documentId || (m.tabId && m.tabId === tab?.id && m.frameId === sender.frameId))
        this.mounts.delete(key);
  }
  beginTransfer(captured: CapturedPage) {
    const id = crypto.randomUUID();
    this.transfers.set(id, { captured, uiTabId: 0, expires: Date.now() + 60_000, used: false });
    return id;
  }
  bindTransfer(id: string, uiTabId: number) {
    const t = this.transfers.get(id);
    if (!t || t.used || t.expires < Date.now() || uiTabId <= 0) {
      this.transfers.delete(id);
      return;
    }
    t.uiTabId = uiTabId;
    const waiters = this.transferWaiters.get(uiTabId) ?? [];
    this.transferWaiters.delete(uiTabId);
    for (const waiter of waiters) waiter();
  }
  whenTransferBound(uiTabId: number, waiter: () => void) {
    if (uiTabId <= 0) return;
    const ready = [...this.transfers.values()].some(t => !t.used && t.expires >= Date.now() && t.uiTabId === uiTabId);
    if (ready) waiter();
    else this.transferWaiters.set(uiTabId, [...(this.transferWaiters.get(uiTabId) ?? []), waiter]);
  }
  dropTransfer(id: string) {
    this.transfers.delete(id);
  }
  takeTransfer(uiTabId: number) {
    for (const [id, t] of this.transfers) {
      if (t.used || t.expires < Date.now()) {
        this.transfers.delete(id);
        continue;
      }
      if (t.uiTabId === uiTabId && uiTabId > 0) {
        t.used = true;
        this.transfers.delete(id);
        return t.captured;
      }
    }
  }
  invalidateCapturedTab(tabId: number) {
    for (const [id, t] of this.transfers) if (t.captured.tabId === tabId) this.transfers.delete(id);
    for (const [nonce, n] of this.nonces) if (n.captured?.tabId === tabId) this.nonces.delete(nonce);
  }
  invalidateUiTab(tabId: number) {
    for (const [key, m] of this.mounts) if (m.tabId === tabId) this.mounts.delete(key);
  }
  private key(ui: BoundUi) {
    return `${ui.kind}:${ui.tabId}:${ui.frameId}:${ui.documentId}`;
  }
}

let registry = new UiIdentityRegistry();
export function uiRegistry() {
  return registry;
}
export function resetUiRegistry() {
  registry = new UiIdentityRegistry();
}
export function trustedMutationSender(sender: SenderLite, extensionId: string) {
  const kind = extensionDocumentKind(sender, extensionId);
  if (kind === 'options') return true;
  if (kind === 'panel') return registry.isBound(sender, extensionId);
  return false;
}
