import { afterEach, expect, it, vi } from 'vitest';
import {
  isClaimedOverlayDocument,
  issueTokenForTests,
  overlayInjectable,
  resetOverlayHostForTests,
  startOverlayHost,
  OVERLAY_CLAIMS_KEY,
  overlayTrustRestored,
  toggleOverlay,
} from '../background/overlay-host';
import { extensionDocumentKind, setOverlayDocumentTrust, withTrustedSender } from '../domain/trusted-sender';
import { IDBFactory } from 'fake-indexeddb';
import { TreeProjection } from '../background/tree-projection';
import { startMutationService } from '../background/mutation-service';
import { prepareMove } from '../panel/TreeDragController';

it.each([undefined, 520, 0])('opens with a compact default and retains a valid saved width: %s', async saved => {
  const executeScript = vi.fn(async () => []);
  vi.stubGlobal('chrome', {
    storage: { local: { get: async () => ({ overlayWidth: saved }) } },
    scripting: { executeScript },
  });
  expect(await toggleOverlay(5, 'https://example.test/')).toBe(true);
  expect(executeScript.mock.calls[0]).toEqual([
    expect.objectContaining({ args: [expect.objectContaining({ width: saved === 520 ? 520 : 320 })] }),
  ]);
});

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

function persistentBoot(data: Record<string, unknown>, get?: () => Promise<Record<string, unknown>>) {
  const messages: ((message: unknown, sender: chrome.runtime.MessageSender, reply: (v: unknown) => void) => unknown)[] =
    [];
  let navigate!: (tabId: number, change: { status: string }) => void;
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', onMessage: { addListener: (fn: (typeof messages)[number]) => messages.push(fn) } },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: {
        addListener: (fn: typeof navigate) => {
          navigate = fn;
        },
      },
    },
    storage: {
      local: { set: async () => {} },
      session: {
        setAccessLevel: async () => {},
        get: get ?? (async () => structuredClone(data)),
        set: async (value: Record<string, unknown>) => {
          Object.assign(data, structuredClone(value));
        },
      },
    },
  });
  startOverlayHost();
  setOverlayDocumentTrust(
    sender => isClaimedOverlayDocument(sender as Parameters<typeof isClaimedOverlayDocument>[0]),
    overlayTrustRestored,
  );
  return {
    navigate,
    messages,
    send: (message: unknown, sender = framed('doc-a')) =>
      new Promise(resolve => messages[0]!(message, sender, resolve)),
  };
}

it('restores only exact claimed document/tab/frame identities after a worker restart, including requests arriving during hydration', async () => {
  const data: Record<string, unknown> = {};
  const first = persistentBoot(data);
  const token = issueTokenForTests(5);
  expect(await first.send({ type: 'zhilan-overlay-claim', token })).toEqual({ ok: true });
  expect(data[OVERLAY_CLAIMS_KEY]).toEqual({ version: 1, claims: [{ documentId: 'doc-a', tabId: 5, frameId: 3 }] });
  resetOverlayHostForTests();
  persistentBoot(data);
  const accepted = vi.fn();
  await new Promise<void>(resolve =>
    withTrustedSender(
      framed('doc-a'),
      'ext',
      () => {
        accepted();
        resolve();
      },
      resolve,
    ),
  );
  expect(accepted).toHaveBeenCalledOnce();
  expect(extensionDocumentKind(framed('doc-a'), 'ext')).toBe('panel');
  expect(extensionDocumentKind(framed('doc-a', 6), 'ext')).toBeUndefined();
  expect(extensionDocumentKind(framed('doc-a', 5, 4), 'ext')).toBeUndefined();
  expect(extensionDocumentKind(framed('doc-b'), 'ext')).toBeUndefined();
});

it('the actual mutation service registers and executes one move from a restored overlay, while other documents remain rejected', async () => {
  const data: Record<string, unknown> = {
    [OVERLAY_CLAIMS_KEY]: { version: 1, claims: [{ documentId: 'doc-a', tabId: 5, frameId: 3 }] },
  };
  vi.stubGlobal('indexedDB', new IDBFactory());
  const h = persistentBoot(data);
  const bookmark = { id: 'b', parentId: 'left', title: 'Synthetic', url: 'https://example.test/', syncing: false };
  const left = { id: 'left', parentId: 'bar', title: 'Left', syncing: false, children: [bookmark] };
  const right = { id: 'right', parentId: 'bar', title: 'Right', syncing: false, children: [] as (typeof bookmark)[] };
  const native = [
    {
      id: '0',
      title: '',
      syncing: false,
      children: [{ id: 'bar', parentId: '0', title: 'Bar', syncing: false, children: [left, right] }],
    },
  ];
  const projection = new TreeProjection(
    { read: async () => structuredClone(native), listen: () => () => {} },
    async () => 'install',
    'epoch',
  );
  projection.start();
  const before = await projection.fresh();
  const move = vi.fn(async () => {
    left.children = [];
    bookmark.parentId = 'right';
    right.children.push(bookmark);
    return bookmark;
  });
  const forbidden = async (): Promise<never> => {
    throw Error('unexpected write');
  };
  startMutationService(projection, request => !request.saveContext, undefined, undefined, undefined, {
    create: forbidden,
    update: forbidden,
    remove: forbidden,
    move,
  });
  const request = prepareMove(before, 'b', 'right', 0);
  const call = (message: unknown, sender = framed('doc-a')) =>
    new Promise<unknown>(resolve => h.messages[1]!(message, sender, resolve));
  const bad = await call({ type: 'registerMutationPreview', request }, framed('other-document'));
  expect(bad).toMatchObject({ status: 'rejected', reason: 'invalid-sender' });
  expect(move).not.toHaveBeenCalled();
  const registered = await call({ type: 'registerMutationPreview', request });
  expect(registered).toMatchObject({ status: 'preview' });
  if (!registered || typeof registered !== 'object' || !('proposal' in registered)) throw Error('missing preview');
  const result = await call(registered.proposal);
  expect(result).toMatchObject({ status: 'completed', completedSteps: 1 });
  expect(move).toHaveBeenCalledOnce();
  expect(move).toHaveBeenCalledWith('b', { parentId: 'right', index: 0 });
  await call(registered.proposal);
  expect(move).toHaveBeenCalledOnce();
  projection.stop();
});

it('navigation during session hydration cannot resurrect a revoked document', async () => {
  const data: Record<string, unknown> = {
    [OVERLAY_CLAIMS_KEY]: { version: 1, claims: [{ documentId: 'doc-a', tabId: 5, frameId: 3 }] },
  };
  let finish!: (value: Record<string, unknown>) => void;
  const h = persistentBoot(
    data,
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  h.navigate(5, { status: 'loading' });
  finish(structuredClone(data));
  await overlayTrustRestored();
  await Promise.resolve();
  expect(extensionDocumentKind(framed('doc-a'), 'ext')).toBeUndefined();
  resetOverlayHostForTests();
  persistentBoot(data);
  await overlayTrustRestored();
  expect(extensionDocumentKind(framed('doc-a'), 'ext')).toBeUndefined();
});

it.each(['native', 'restored'] as const)(
  'rejects malformed registrations once without hanging or writing (%s sender)',
  async kind => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    const data: Record<string, unknown> = {
      [OVERLAY_CLAIMS_KEY]: { version: 1, claims: [{ documentId: 'doc-a', tabId: 5, frameId: 3 }] },
    };
    const h = persistentBoot(data);
    const projection = new TreeProjection(
      { read: async () => [], listen: () => () => {} },
      async () => 'install',
      'epoch',
    );
    const forbidden = vi.fn(async (): Promise<never> => {
      throw Error('unexpected write');
    });
    startMutationService(projection, undefined, undefined, undefined, undefined, {
      create: forbidden,
      update: forbidden,
      remove: forbidden,
      move: forbidden,
    });
    const sender =
      kind === 'restored'
        ? framed('doc-a')
        : {
            id: 'ext',
            url: 'chrome-extension://ext/options/index.html',
            documentId: 'options',
            frameId: 0,
          };
    for (const [message, reason] of [
      [{ type: 'registerImportPreview', version: 1 }, 'invalid-import-preview'],
      [{ type: 'registerMutationPreview' }, 'invalid-preview'],
    ] as const) {
      const reply = vi.fn();
      const result = await new Promise<unknown>(resolve =>
        h.messages[1]!(message, sender, value => {
          reply(value);
          resolve(value);
        }),
      );
      expect(result).toEqual({ status: 'rejected', reason });
      expect(reply).toHaveBeenCalledOnce();
    }
    expect(forbidden).not.toHaveBeenCalled();
  },
);

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

it('accepts Chrome retaining the bootstrap hash but rejects mismatched tokens, queries and origins', () => {
  const send = boot();
  setOverlayDocumentTrust(sender => isClaimedOverlayDocument(sender as never));
  const token = issueTokenForTests(5);
  const sender = { ...framed('chrome-initial-url'), url: `chrome-extension://ext/panel/index.html#overlay=${token}` };
  for (const rejected of [
    { ...sender, url: `${sender.url}-wrong` },
    { ...sender, url: `chrome-extension://ext/panel/index.html?x=1#overlay=${token}` },
    { ...sender, url: `chrome-extension://other/panel/index.html#overlay=${token}` },
    { ...sender, origin: 'https://untrusted.test' },
    { ...sender, frameId: 0 },
    { ...sender, tab: { ...sender.tab, id: 6 } },
  ]) {
    expect(send({ type: 'zhilan-overlay-claim', token }, rejected)).toEqual({ ok: false });
    expect(isClaimedOverlayDocument(rejected)).toBe(false);
  }
  expect(send({ type: 'zhilan-overlay-claim', token }, sender)).toEqual({ ok: true });
  expect(extensionDocumentKind(sender, 'ext')).toBe('panel');
  expect(send({ type: 'zhilan-overlay-claim', token }, { ...sender, documentId: 'other-document' })).toEqual({
    ok: false,
  });
});
