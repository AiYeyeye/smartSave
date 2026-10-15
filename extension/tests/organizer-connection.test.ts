import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openOrganizerLease } from '../panel/organizer-client';
import { startOrganizerAuthority } from '../background/organizer-authority';
import { startWorkerDiagnostics } from '../background/worker-diagnostics';
import { SettingsStore } from '../persistence/settings';
import { DEBUG_SETTINGS_KEY, DEBUG_TRAIL_KEY, resetDebugLogForTests, type DebugEntry } from '../domain/debug-log';

function event<T extends (...args: never[]) => unknown>() {
  const listeners = new Set<T>();
  return {
    addListener: (listener: T) => listeners.add(listener),
    removeListener: (listener: T) => listeners.delete(listener),
    emit: (...args: Parameters<T>) => listeners.forEach(listener => listener(...args)),
  };
}
let data: Record<string, unknown>;
beforeEach(() => {
  vi.useFakeTimers();
  resetDebugLogForTests();
  data = { [DEBUG_SETTINGS_KEY]: { enabled: true } };
  vi.spyOn(console, 'debug').mockImplementation(() => {});
});
afterEach(() => {
  resetDebugLogForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup() {
  const received = event<(raw: unknown) => void>();
  const disconnected = event<() => void>();
  const workerMessages = event<(raw: unknown) => void>();
  const workerDisconnected = event<() => void>();
  const connected = event<(port: chrome.runtime.Port) => void>();
  const suspend = event<() => void>();
  const resume = event<() => void>();
  const page = new EventTarget();
  Object.assign(page, { visibilityState: 'visible' });
  vi.stubGlobal('document', page);
  const local = {
    setAccessLevel: async () => {},
    remove: async (field: string) => {
      delete data[field];
    },
    get: async (field: string) => ({ [field]: data[field] }),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, values);
    },
  };
  const client = {
    name: 'zhilan-organizer-authority-v1',
    onMessage: received,
    onDisconnect: disconnected,
    postMessage: vi.fn((raw: unknown) => workerMessages.emit(raw)),
    disconnect: vi.fn(() => workerDisconnected.emit()),
  };
  const server = {
    name: client.name,
    sender: { id: 'test', url: 'chrome-extension://test/options/index.html' },
    onMessage: workerMessages,
    onDisconnect: workerDisconnected,
    postMessage: vi.fn((raw: unknown) => received.emit(raw)),
    disconnect: vi.fn(() => disconnected.emit()),
  };
  const runtime = {
    id: 'test',
    lastError: undefined as { message: string } | undefined,
    connect: vi.fn(() => {
      queueMicrotask(() => connected.emit(server as unknown as chrome.runtime.Port));
      return client;
    }),
    onConnect: connected,
    onSuspend: suspend,
    onSuspendCanceled: resume,
    getManifest: () => ({ version: 'test-build' }),
  };
  vi.stubGlobal('chrome', { runtime, storage: { local, onChanged: event() } });
  const settings = new SettingsStore(local);
  vi.spyOn(settings, 'snapshot').mockResolvedValue({
    version: 1,
    revision: 'r',
    sessionRevision: 0,
    key: '',
    privacy: { fullUrl: false, bodyEnabled: false, excludedFolders: [] },
  });
  return { client, server, received, disconnected, runtime, settings, page, suspend, resume };
}
async function trail() {
  await vi.advanceTimersByTimeAsync(300);
  return (data[DEBUG_TRAIL_KEY] ?? []) as DebugEntry[];
}
it('correlates real client/worker heartbeats, never logs authority, and stops on close', async () => {
  const h = setup();
  const worker = startWorkerDiagnostics();
  startOrganizerAuthority(h.settings, worker);
  const invalidated = vi.fn();
  const lease = await openOrganizerLease(invalidated, 'test-run');
  await vi.advanceTimersByTimeAsync(20_000);
  let entries = await trail();
  const opened = entries.find(e => e.src === 'organizer-client' && e.event === 'lease-opened')!;
  expect(opened.detail).toMatchObject({ runId: 'test-run', workerInstance: worker.workerInstance });
  expect(entries.find(e => e.event === 'heartbeat-received')?.detail).toMatchObject({
    connectionId: opened.detail!.connectionId,
    sequence: 1,
  });
  expect(entries.find(e => e.event === 'heartbeat-ack')?.detail).toMatchObject({ acknowledged: 1, roundTripMs: 0 });
  expect(JSON.stringify(entries)).not.toContain(lease.token);
  Object.assign(h.page, { visibilityState: 'hidden' });
  h.page.dispatchEvent(new Event('visibilitychange'));
  await vi.advanceTimersByTimeAsync(20_000);
  entries = await trail();
  expect(entries.find(e => e.event === 'page-lifecycle')?.detail).toMatchObject({
    visibility: 'hidden',
    kind: 'visibilitychange',
  });
  expect(h.client.postMessage).toHaveBeenCalledTimes(3); // activity control + two pong replies
  // Cross the reported 170-second failure point with the real client/worker message handlers.
  await vi.advanceTimersByTimeAsync(140_000);
  expect(h.client.postMessage).toHaveBeenCalledTimes(10);
  lease.close();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.client.postMessage).toHaveBeenCalledTimes(10);
  expect(invalidated).not.toHaveBeenCalled();
  const count = (await trail()).filter(e => e.event === 'page-lifecycle').length;
  h.page.dispatchEvent(new Event('visibilitychange'));
  expect((await trail()).filter(e => e.event === 'page-lifecycle')).toHaveLength(count);
  h.settings.dispose();
});
it('new workers drive the clock with no client interval and stop it when inactive', async () => {
  const h = setup();
  const intervals = vi.spyOn(globalThis, 'setInterval');
  startOrganizerAuthority(h.settings);
  const invalidated = vi.fn();
  const lease = await openOrganizerLease(invalidated);
  expect(intervals).toHaveBeenCalledOnce(); // the worker owns the only clock
  expect(
    (await trail()).find(e => e.event === 'lease-opened' && e.src === 'organizer-client')?.detail?.heartbeatOwner,
  ).toBe('worker');
  await vi.advanceTimersByTimeAsync(180_000);
  expect(invalidated).not.toHaveBeenCalled();
  lease.setActive!(false);
  const sends = h.server.postMessage.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.server.postMessage).toHaveBeenCalledTimes(sends);
  lease.setActive!(true);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(h.server.postMessage.mock.calls.length).toBeGreaterThan(sends);
  lease.close();
  await trail();
  expect(vi.getTimerCount()).toBe(0);
  h.settings.dispose();
});
it('stops the worker heartbeat and revokes authority when the page stops replying', async () => {
  const h = setup();
  const authority = startOrganizerAuthority(h.settings);
  const invalidated = vi.fn();
  const lease = await openOrganizerLease(invalidated);
  h.client.postMessage.mockImplementation(() => {}); // simulate frozen page replies
  await vi.advanceTimersByTimeAsync(60_000);
  expect(invalidated).toHaveBeenCalledOnce();
  expect(h.server.disconnect).toHaveBeenCalledOnce();
  const before = h.server.postMessage.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(h.server.postMessage).toHaveBeenCalledTimes(before);
  expect((await trail()).find(e => e.event === 'port-closed')?.detail?.reason).toBe('heartbeat-peer-silent');
  expect(authority.current({ organizerContext: lease.token } as Parameters<typeof authority.current>[0])).toBe(false);
  h.settings.dispose();
});
it('replayed or unsolicited pong sequences cannot prolong a silent peer', async () => {
  const h = setup();
  startOrganizerAuthority(h.settings);
  const invalidated = vi.fn();
  await openOrganizerLease(invalidated);
  await vi.advanceTimersByTimeAsync(20_000); // first legitimate pong accepted
  h.client.postMessage.mockImplementation(() => {});
  await vi.advanceTimersByTimeAsync(20_000);
  h.server.onMessage.emit({ version: 1, type: 'keepalive', sequence: 1 });
  h.server.onMessage.emit({ version: 1, type: 'keepalive', sequence: 999 });
  await vi.advanceTimersByTimeAsync(40_000);
  expect(invalidated).toHaveBeenCalledOnce();
  expect((await trail()).filter(e => e.event === 'heartbeat-received')).toHaveLength(1);
  h.settings.dispose();
});
it('reports delayed timer and missing acknowledgements without creating another timeout or reconnect', async () => {
  const h = setup();
  const invalidated = vi.fn();
  const pending = openOrganizerLease(invalidated, 'lag-run');
  h.received.emit({
    version: 1,
    organizerContext: 'private-authority',
    workerInstance: 'worker-one',
    connectionId: 'connection-one',
  });
  const lease = await pending;
  vi.setSystemTime(Date.now() + 45_000);
  await vi.advanceTimersByTimeAsync(20_000);
  const sent = (await trail()).find(e => e.event === 'heartbeat-sent')!;
  expect(sent.detail).toMatchObject({ lagMs: 45_000, acknowledged: 0 });
  h.received.emit({ version: 1, type: 'keepalive-ack', sequence: 1, workerInstance: 'wrong-worker' });
  expect((await trail()).some(e => e.event === 'heartbeat-ack')).toBe(false);
  expect(invalidated).not.toHaveBeenCalled();
  expect(h.runtime.connect).toHaveBeenCalledOnce();
  h.runtime.lastError = { message: 'Extension context invalidated. private-url' };
  h.disconnected.emit();
  h.disconnected.emit();
  expect(invalidated).toHaveBeenCalledOnce();
  const entries = await trail();
  expect(entries.find(e => e.event === 'disconnected')?.detail).toMatchObject({
    runtimeError: 'context-invalidated',
    localClose: false,
    acknowledged: 0,
  });
  expect(JSON.stringify(entries)).not.toContain('private-url');
  expect(JSON.stringify(entries)).not.toContain('private-authority');
  lease.close();
});
it.each([true, false])(
  'records send failure only when diagnostics enabled=%s and still invalidates once',
  async enabled => {
    const h = setup();
    data[DEBUG_SETTINGS_KEY] = { enabled };
    const invalidated = vi.fn();
    const pending = openOrganizerLease(invalidated);
    // Legacy worker greetings remain accepted.
    h.received.emit({ version: 1, organizerContext: 'private-authority' });
    await pending;
    h.client.postMessage.mockImplementation(() => {
      throw Error('private-error');
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.client.postMessage).toHaveBeenCalledOnce();
    expect(invalidated).toHaveBeenCalledOnce();
    const entries = await trail();
    if (enabled) {
      expect(entries.find(e => e.event === 'closed')?.detail).toMatchObject({ reason: 'heartbeat-send-failed' });
      expect(entries.filter(e => e.event === 'heartbeat-send-failed')).toHaveLength(1);
      expect(JSON.stringify(entries)).not.toContain('private-error');
    } else expect(entries).toEqual([]);
  },
);
it('logs independent worker identities and observational suspend events', async () => {
  const h = setup();
  const first = startWorkerDiagnostics();
  h.suspend.emit();
  h.resume.emit();
  const second = startWorkerDiagnostics();
  expect(first.workerInstance).not.toBe(second.workerInstance);
  const entries = await trail();
  expect(entries.filter(e => e.event === 'started')).toHaveLength(2);
  expect(entries.find(e => e.event === 'suspend-requested')?.detail).toMatchObject({
    workerInstance: first.workerInstance,
  });
  expect(entries.find(e => e.event === 'suspend-cancelled')?.detail).toMatchObject({
    workerInstance: first.workerInstance,
  });
  expect(h.runtime.connect).not.toHaveBeenCalled();
});
