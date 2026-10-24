import { extensionDocumentKind, withTrustedSender } from '../domain/trusted-sender';
import { SAVE_CONFIRM_PORT, SaveConfirmQueue } from '../persistence/save-confirm';
import { createWorkerTaskLifetime } from './worker-task-lifetime';

const PAGE = 'save/index.html';
export { SAVE_CONFIRM_PORT };
/**
 * `action.openPopup` (Chrome 127+) needs the target window to be active and to show a toolbar. The native bookmark
 * bubble, another app or fullscreen can hold that state for a while, so an automatic presentation keeps retrying
 * instead of creating a window or stealing focus.
 */
const RETRY_MS = [400, 800, 1200, 2000, 3000, 5000, 5000, 8000, 10000, 15000, 15000];
/** After the schedule, a later focus return to the same window may still present it within this time. */
const DORMANT_MS = 10 * 60 * 1000;
/** An armed toolbar popup that never connected must not keep replacing the toolbar click. */
const CONNECT_MS = 5000;

type ActionPopupApi = {
  setPopup(details: { tabId?: number; popup: string }): Promise<void>;
  openPopup(options?: { windowId?: number }): Promise<void>;
  getPopup?(details: { tabId?: number }): Promise<string>;
};
export type SaveDialogOptions = {
  /** Unreviewed receipts in display order; the sidebar launcher queues all of them. */
  pending?: () => Promise<string[]>;
  /** Toolbar hint for a confirmation the browser could not show automatically. Never throws. */
  hint?: (tabId: number, on: boolean) => void;
  action?: ActionPopupApi;
};
type Request = {
  windowId: number;
  step: number;
  deadline: number;
  retry: boolean;
  timer?: ReturnType<typeof setTimeout>;
  release?: () => void;
};

/**
 * Presents the save confirmation as the extension's toolbar popup, anchored next to the bookmark star.
 * One popup at a time; later saves join a worker-owned queue the open popup reads. No browser window, tab or
 * taskbar entry is ever created for it.
 */
export class SaveDialogHost {
  readonly queue: SaveConfirmQueue;
  /** Connected popups and the browser window each one is shown in. */
  private popups = new Map<chrome.runtime.Port, Promise<number | undefined>>();
  private windows = new Map<string, Promise<number | undefined>>();
  private armed = new Map<number, ReturnType<typeof setTimeout> | undefined>();
  private hinted = new Set<number>();
  private request?: Request;
  private opening?: Promise<boolean>;
  /** Every browser window has its own toolbar popup, so shortcut captures queue per source window. */
  private captures = new Map<number, number[]>();
  private capturing = new Set<Promise<void>>();
  private presented = new Set<string>();
  private lifetime = createWorkerTaskLifetime();
  constructor(private readonly options: SaveDialogOptions = {}) {
    this.queue = new SaveConfirmQueue(chrome.storage?.session);
    chrome.runtime.onConnect?.addListener(port => this.connect(port));
    chrome.windows?.onFocusChanged?.addListener(windowId => {
      if (this.request?.windowId === windowId) void this.attempt();
    });
    chrome.tabs?.onActivated?.addListener(info => {
      if (this.request?.windowId === info.windowId) void this.attempt();
    });
    chrome.windows?.onRemoved?.addListener(windowId => {
      if (this.request?.windowId === windowId) this.stop();
    });
    chrome.tabs?.onRemoved?.addListener(tabId => {
      clearTimeout(this.armed.get(tabId));
      this.armed.delete(tabId);
      this.hinted.delete(tabId);
    });
    void this.sweep();
  }
  /**
   * Per-tab popup assignments outlive the worker. Return unclaimed toolbar clicks to the sidebar; an open popup
   * can outlive worker sleep too and reconnect its presence when the user interacts with it.
   */
  private async sweep() {
    const getPopup = this.action.getPopup?.bind(this.action);
    if (!getPopup || !chrome.tabs?.query) return;
    try {
      const page = chrome.runtime.getURL(PAGE);
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id === undefined || this.armed.has(tab.id) || this.popups.size) continue;
        const popup = await getPopup({ tabId: tab.id }).catch(() => '');
        if ((popup === page || popup.endsWith(`/${PAGE}`)) && !this.armed.has(tab.id) && !this.popups.size)
          await Promise.resolve(this.action.setPopup({ tabId: tab.id, popup: '' })).catch(() => {});
      }
    } catch {
      /* Advisory cleanup; an arm left behind still opens the confirmation popup. */
    }
  }
  private get action(): ActionPopupApi {
    return this.options.action ?? chrome.action;
  }
  /** The toolbar popup is the top-level save document without a hosting tab. */
  /**
   * The toolbar popup is this extension's top-level save document without a hosting tab. Chrome attaches no tab,
   * frame or document id to popup senders (only id, url and origin); only extension documents carry this URL.
   */
  private isPopup(sender: chrome.runtime.MessageSender | undefined) {
    return (
      !!sender &&
      extensionDocumentKind(sender, chrome.runtime.id) === 'save' &&
      (sender.frameId ?? 0) === 0 &&
      sender.tab === undefined
    );
  }
  get showing() {
    return this.popups.size > 0;
  }
  /**
   * The window a popup is shown in: its extension context when Chrome reports one, else the focused window
   * (a toolbar popup closes as soon as its window loses focus).
   */
  private windowOf(sender: chrome.runtime.MessageSender) {
    const documentId = sender.documentId;
    const known = documentId ? this.windows.get(documentId) : undefined;
    if (known) return known;
    const lookup = (async () => {
      const contexts = await Promise.resolve(
        chrome.runtime.getContexts?.({
          contextTypes: ['POPUP' as chrome.runtime.ContextType],
          ...(documentId ? { documentIds: [documentId] } : {}),
        }),
      ).catch(() => undefined);
      const matching = (contexts ?? []).filter(context =>
        documentId ? context.documentId === documentId : context.documentUrl === sender.url,
      );
      const windowId = matching.length === 1 ? matching[0]!.windowId : undefined;
      if (windowId !== undefined && windowId >= 0) return windowId;
      return (await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined))?.id;
    })();
    if (documentId) {
      this.windows.set(documentId, lookup);
      while (this.windows.size > 20) this.windows.delete(this.windows.keys().next().value!);
    }
    return lookup;
  }
  private async showingIn(windowId: number) {
    for (const shown of this.popups.values()) if ((await shown) === windowId) return true;
    return false;
  }
  private connect(port: chrome.runtime.Port) {
    if (port.name !== SAVE_CONFIRM_PORT) return;
    if (!this.isPopup(port.sender)) {
      port.disconnect();
      return;
    }
    this.popups.set(port, this.windowOf(port.sender!));
    this.stop();
    for (const [tabId, timer] of this.armed) {
      clearTimeout(timer);
      this.armed.set(tabId, undefined);
    }
    for (const tabId of this.hinted) this.options.hint?.(tabId, false);
    this.hinted.clear();
    port.onDisconnect.addListener(() => {
      this.popups.delete(port);
      if (port.sender?.documentId) this.windows.delete(port.sender.documentId);
      // A closed popup returns the toolbar click to the sidebar.
      if (!this.popups.size) void this.disarm();
    });
  }
  private async arm(tabId: number) {
    clearTimeout(this.armed.get(tabId));
    this.armed.set(tabId, undefined);
    await this.action.setPopup({ tabId, popup: PAGE });
  }
  private expire(tabId: number) {
    if (this.popups.size || !this.armed.has(tabId)) return;
    this.armed.set(
      tabId,
      setTimeout(() => {
        if (!this.popups.size) void this.disarm(tabId);
      }, CONNECT_MS),
    );
  }
  private async disarm(only?: number) {
    for (const tabId of only === undefined ? [...this.armed.keys()] : [only]) {
      if (!this.armed.has(tabId)) continue;
      clearTimeout(this.armed.get(tabId));
      this.armed.delete(tabId);
      await Promise.resolve(this.action.setPopup({ tabId, popup: '' })).catch(() => {});
    }
  }
  private stop() {
    const request = this.request;
    if (!request) return;
    clearTimeout(request.timer);
    request.release?.();
    this.request = undefined;
  }
  private attempt(): Promise<boolean> {
    if (this.opening) return this.opening;
    const request = this.request;
    if (!request) return Promise.resolve(false);
    // One automatic popup at a time; an explicit entry may still open its own window's popup.
    if (this.popups.size && request.retry) {
      this.stop();
      return Promise.resolve(true);
    }
    if (Date.now() > request.deadline) {
      this.stop();
      return Promise.resolve(false);
    }
    clearTimeout(request.timer);
    request.timer = undefined;
    const run = async () => {
      let tabId: number | undefined;
      try {
        const [tab] = await chrome.tabs.query({ active: true, windowId: request.windowId });
        tabId = tab?.id;
        if (tabId === undefined) throw Error('no-active-tab');
        await this.arm(tabId);
        await this.action.openPopup({ windowId: request.windowId });
        this.expire(tabId);
        if (this.request === request) this.stop();
        return true;
      } catch {
        if (tabId !== undefined && !this.popups.size) await this.disarm(tabId);
        if (this.request === request) await this.retry(request, tabId);
        return false;
      }
    };
    const pending = run().finally(() => {
      if (this.opening === pending) this.opening = undefined;
    });
    this.opening = pending;
    return pending;
  }
  private async retry(request: Request, tabId: number | undefined) {
    const delay = request.retry ? RETRY_MS[request.step++] : undefined;
    if (delay !== undefined) {
      request.timer = setTimeout(() => void this.attempt(), delay);
      return;
    }
    // Out of quick retries: stay reachable from this tab's toolbar icon, and let a focus return try once more.
    request.release?.();
    request.release = undefined;
    if (!request.retry) this.stop();
    if (tabId === undefined || this.popups.size) return;
    await this.arm(tabId).catch(() => {});
    if (!this.hinted.has(tabId)) {
      this.hinted.add(tabId);
      this.options.hint?.(tabId, true);
    }
  }
  /** Explicit entries (sidebar launcher, shortcut) try once; automatic presentation retries without taking focus. */
  private present(windowId: number, retry: boolean): Promise<boolean> {
    if (this.popups.size && retry) return Promise.resolve(true);
    if (this.request?.windowId !== windowId || this.request.retry !== retry) {
      this.stop();
      this.request = {
        windowId,
        step: 0,
        retry,
        deadline: Date.now() + (retry ? DORMANT_MS : 60_000),
        release: retry ? this.lifetime.acquire() : undefined,
      };
    } else {
      this.request.step = 0;
      this.request.release ??= retry ? this.lifetime.acquire() : undefined;
    }
    return this.attempt();
  }
  async openReceipts(sender: chrome.runtime.MessageSender) {
    const windowId = sender.tab?.windowId ?? (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
    if (windowId === undefined) throw Error('dialog-unavailable');
    await this.queue.enqueue((await this.options.pending?.()) ?? []);
    if (!(await this.present(windowId, false))) throw Error('dialog-unavailable');
  }
  /** Only a newly settled native save calls this; stored receipts are never replayed on startup. */
  async openAutomatic(receiptId: string, sourceWindowId: number) {
    if (this.presented.has(receiptId)) return;
    this.presented.add(receiptId);
    while (this.presented.size > 100) this.presented.delete(this.presented.values().next().value!);
    await this.queue.enqueue([receiptId]);
    // An open popup already lists the new entry as "1/N"; it never replaces the draft being edited.
    await this.present(sourceWindowId, true);
  }
  /** Removes an entry the popup confirmed or set aside; the receipt itself stays in history. */
  done(receiptId: string) {
    return this.queue.remove(receiptId);
  }
  openCapture(tabId: number) {
    const pending = this.capture(tabId);
    this.capturing.add(pending);
    return pending.finally(() => this.capturing.delete(pending));
  }
  private async capture(tabId: number) {
    const source = await chrome.tabs.get(tabId);
    const list = this.captures.get(source.windowId) ?? [];
    if (!list.includes(tabId)) list.push(tabId);
    this.captures.set(source.windowId, list);
    if (await this.showingIn(source.windowId)) {
      // A page can register before the capture was bound; wake it after the source binding exists.
      void Promise.resolve(chrome.runtime.sendMessage?.({ type: 'saveDialogUpdated' })).catch(() => {});
      return;
    }
    if (!(await this.present(source.windowId, false))) throw Error('dialog-unavailable');
  }
  /** Captures of the trusted popup's own window; any other sender gets none. */
  private async owned(sender: chrome.runtime.MessageSender) {
    await Promise.allSettled([...this.capturing]);
    if (!this.isPopup(sender)) return;
    const windowId = await this.windowOf(sender);
    return windowId === undefined ? undefined : this.captures.get(windowId);
  }
  async sourceForSender(sender: chrome.runtime.MessageSender) {
    return (await this.owned(sender))?.[0];
  }
  async finishCapture(sender: chrome.runtime.MessageSender, sourceTabId: number) {
    const list = await this.owned(sender);
    if (list?.[0] === sourceTabId) list.shift();
  }
}

export function startSaveDialogService(host: SaveDialogHost) {
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (!raw || typeof raw !== 'object' || !('type' in raw)) return false;
    if (raw.type === 'saveConfirmDone') {
      const receiptId = 'receiptId' in raw ? raw.receiptId : undefined;
      if (
        Object.keys(raw).length !== 2 ||
        typeof receiptId !== 'string' ||
        extensionDocumentKind(sender, chrome.runtime.id) !== 'save'
      ) {
        reply({ status: 'error' });
        return false;
      }
      void host.done(receiptId).then(
        remaining => reply({ status: 'done', remaining }),
        () => reply({ status: 'error' }),
      );
      return true;
    }
    if (raw.type !== 'openSaveDialog') return false;
    if (Object.keys(raw).length !== 1) {
      reply({ status: 'error' });
      return false;
    }
    withTrustedSender(
      sender,
      chrome.runtime.id,
      () => {
        void host.openReceipts(sender).then(
          () => reply({ status: 'opened' }),
          () => reply({ status: 'error' }),
        );
      },
      () => reply({ status: 'error' }),
    );
    return true;
  });
}
