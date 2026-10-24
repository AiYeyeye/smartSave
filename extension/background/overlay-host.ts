/**
 * Overlay sidebar host: on an explicit toolbar click (activeTab), injects a left-edge sidebar over the page
 * that closes when the user clicks outside it. The sidebar is the regular panel document in an iframe.
 *
 * Trust: an extension document inside a web tab is untrusted by default. Each injection mints a one-time
 * token that only the injected content script (isolated world, closed shadow root) knows; the framed panel
 * claims it once and only that document id is trusted afterwards. A page that frames the panel itself never
 * learns a token.
 */
import { z } from 'zod';
export type PanelMode = 'overlay' | 'sidepanel';
export const PANEL_MODE_KEY = 'panelMode';
export const OVERLAY_WIDTH_KEY = 'overlayWidth';
export const OVERLAY_SCRIPT = 'overlay-sidebar.js';
const DEFAULT_WIDTH = 320;

const tokens = new Map<string, number>(); // token → tabId
type Claim = { documentId: string; tabId: number; frameId: number };
const claimed = new Map<string, Claim>();
export const OVERLAY_CLAIMS_KEY = 'overlayClaimsV1';
let ready: Promise<void> = Promise.resolve();
let writes: Promise<void> = Promise.resolve();
let session: chrome.storage.StorageArea | undefined;
const revokedTabs = new Set<number>();
let ownerGeneration = 0;
const claimsSchema = z.strictObject({
  version: z.literal(1),
  claims: z
    .array(
      z.strictObject({
        documentId: z.string().min(1).max(256),
        tabId: z.number().int().nonnegative(),
        frameId: z.number().int().positive(),
      }),
    )
    .max(1000),
});
export function overlayTrustRestored() {
  return ready;
}
function persistClaims() {
  const pending = writes
    .catch(() => {})
    .then(async () => {
      await ready;
      if (session) await session.set({ [OVERLAY_CLAIMS_KEY]: { version: 1, claims: [...claimed.values()] } });
    });
  writes = pending;
  return pending;
}

/** Pages Chrome never lets extensions script; those fall back to the native side panel. */
export function overlayInjectable(url: string | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') return false;
  if (parsed.hostname === 'chromewebstore.google.com') return false;
  if (parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore')) return false;
  if (parsed.hostname === 'microsoftedge.microsoft.com') return false;
  return true;
}

export function isClaimedOverlayDocument(sender: {
  documentId?: string;
  frameId?: number;
  tab?: { id?: number };
}): boolean {
  if (!sender.documentId) return false;
  const claim = claimed.get(sender.documentId);
  return !!claim && claim.tabId === sender.tab?.id && claim.frameId === sender.frameId;
}

async function storedWidth(): Promise<number> {
  try {
    const data = await chrome.storage.local.get(OVERLAY_WIDTH_KEY);
    const value = Number(data[OVERLAY_WIDTH_KEY]);
    return Number.isFinite(value) && value >= 300 && value <= 720 ? value : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** Toggles the overlay in a tab. Resolves false when the page cannot be scripted. */
export async function toggleOverlay(tabId: number, url: string | undefined, ensureOpen = false): Promise<boolean> {
  if (!overlayInjectable(url)) return false;
  for (const [token, owner] of tokens) if (owner === tabId) tokens.delete(token);
  const token = crypto.randomUUID();
  tokens.set(token, tabId);
  const width = await storedWidth();
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (init: { token: string; width: number; ensureOpen: boolean }) => {
        (globalThis as unknown as { __zhilanOverlayInit?: unknown }).__zhilanOverlayInit = init;
      },
      args: [{ token, width, ensureOpen }],
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: [OVERLAY_SCRIPT] });
    return true;
  } catch {
    tokens.delete(token);
    return false;
  }
}

function forgetTab(tabId: number) {
  revokedTabs.add(tabId);
  for (const [token, owner] of tokens) if (owner === tabId) tokens.delete(token);
  for (const [doc, claim] of claimed) if (claim.tabId === tabId) claimed.delete(doc);
  void persistClaims().catch(() => {});
}

/** Wires claim / width / close messages and tab cleanup. Call once from the service worker. */
export function startOverlayHost() {
  const generation = ++ownerGeneration;
  const storage = chrome.storage.session;
  session = storage;
  if (session) {
    ready = (async () => {
      await storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
      const data = await storage.get(OVERLAY_CLAIMS_KEY);
      const record = data[OVERLAY_CLAIMS_KEY];
      if (record === undefined) return;
      const restored = claimsSchema.parse(record).claims;
      if (generation !== ownerGeneration) return;
      for (const claim of restored) if (!revokedTabs.has(claim.tabId)) claimed.set(claim.documentId, claim);
    })();
    void ready.catch(() => {});
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return false;
    const tabId = sender.tab?.id;
    if (sender.id !== chrome.runtime.id || tabId === undefined) return false;
    if (message.type === 'zhilan-overlay-claim') {
      // Only the framed panel document (never the top frame) may claim, and only with the token minted for its tab.
      const token = 'token' in message && typeof message.token === 'string' ? message.token : '';
      const panelUrl = `chrome-extension://${chrome.runtime.id}/panel/index.html`;
      const check = () =>
        !!sender.documentId &&
        (sender.frameId ?? 0) > 0 &&
        // Chrome may retain the initial document URL in MessageSender after history.replaceState.
        // Accept only our exact bootstrap fragment, still bound to the one-use token for this tab.
        (sender.url === panelUrl || sender.url === `${panelUrl}#overlay=${token}`) &&
        (!sender.origin || sender.origin === `chrome-extension://${chrome.runtime.id}`) &&
        (claimed.size < 1000 || claimed.has(sender.documentId!)) &&
        tokens.get(token) === tabId;
      const claim = async () => {
        await ready;
        if (!check()) {
          reply({ ok: false });
          return;
        }
        tokens.delete(token);
        const value: Claim = { documentId: sender.documentId!, tabId, frameId: sender.frameId! };
        claimed.set(value.documentId, value);
        try {
          await persistClaims();
          reply({ ok: claimed.get(value.documentId) === value });
        } catch {
          if (claimed.get(value.documentId) === value) claimed.delete(value.documentId);
          reply({ ok: false });
        }
      };
      if (!session) {
        const ok = check();
        if (ok) {
          tokens.delete(token);
          claimed.set(sender.documentId!, { documentId: sender.documentId!, tabId, frameId: sender.frameId! });
        }
        reply({ ok });
        return false;
      }
      void claim().catch(() => reply({ ok: false }));
      return true;
    }
    if (message.type === 'zhilan-overlay-width' && (sender.frameId ?? 0) === 0) {
      const width = 'width' in message ? Number(message.width) : NaN;
      if (Number.isFinite(width) && width >= 300 && width <= 720)
        void chrome.storage.local.set({ [OVERLAY_WIDTH_KEY]: Math.round(width) }).catch(() => {});
      return false;
    }
    if (message.type === 'zhilan-overlay-closed' && (sender.frameId ?? 0) === 0) {
      forgetTab(tabId);
      return false;
    }
    return false;
  });
  chrome.tabs?.onRemoved?.addListener(forgetTab);
  chrome.tabs?.onUpdated?.addListener((tabId, change) => {
    if (change.status === 'loading') forgetTab(tabId);
  });
}

/** Test hook. */
export function resetOverlayHostForTests() {
  ownerGeneration++;
  tokens.clear();
  claimed.clear();
  revokedTabs.clear();
  session = undefined;
  ready = Promise.resolve();
  writes = Promise.resolve();
}
export function issueTokenForTests(tabId: number) {
  const token = crypto.randomUUID();
  tokens.set(token, tabId);
  return token;
}

let mode: PanelMode = 'overlay';
/** Current open mode, cached from storage and kept in sync. */
export function panelMode(): PanelMode {
  return mode;
}
export function watchPanelMode() {
  if (!chrome.storage?.local) return;
  void Promise.resolve(chrome.storage.local.get(PANEL_MODE_KEY))
    .then(data => {
      if (data?.[PANEL_MODE_KEY] === 'sidepanel' || data[PANEL_MODE_KEY] === 'overlay') mode = data[PANEL_MODE_KEY];
    })
    .catch(() => {});
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'local' || !Object.hasOwn(changes, PANEL_MODE_KEY)) return;
    const next = changes[PANEL_MODE_KEY]?.newValue;
    mode = next === 'sidepanel' ? 'sidepanel' : 'overlay';
  });
}
