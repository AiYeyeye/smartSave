import { expect, it, vi } from 'vitest';
import { connectTree } from '../panel/tree-client';
import { saveExpansion } from '../panel/expansion-memory';
it('requests a fresh tree on reconnect and rejects messages from the disconnected port', () => {
  vi.useFakeTimers();
  const ports: { message: (value: unknown) => void; disconnect: () => void; postMessage: ReturnType<typeof vi.fn> }[] = [];
  const connect = vi.fn(() => {
    const callbacks = { message: (_: unknown) => { void _; }, disconnect: () => {}, postMessage: vi.fn() };
    ports.push(callbacks);
    return { onMessage: { addListener: (fn: (value: unknown) => void) => { callbacks.message = fn; } }, onDisconnect: { addListener: (fn: () => void) => { callbacks.disconnect = fn; } }, postMessage: callbacks.postMessage, disconnect: vi.fn() } as unknown as chrome.runtime.Port;
  });
  const receive = vi.fn();
  const stop = connectTree({ connect }, receive);
  expect(ports[0]!.postMessage).toHaveBeenCalledWith({ version: 1, type: 'refresh' });
  ports[0]!.disconnect();
  expect(receive).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'error' }));
  vi.advanceTimersByTime(1000);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(ports[1]!.postMessage).toHaveBeenCalledWith({ version: 1, type: 'refresh' });
  receive.mockClear(); ports[0]!.message({ version: 1, state: { status: 'loading' } });
  expect(receive).not.toHaveBeenCalled();
  stop(); vi.useRealTimers();
});
it('writes only the changed expansion key across concurrent panels', async () => {
  const values: Record<string, unknown> = {};
  const set = vi.fn(async (patch: Record<string, unknown>) => { Object.assign(values, patch); });
  await Promise.all([saveExpansion({ set }, 'i', 'a', true), saveExpansion({ set }, 'i', 'b', false)]);
  expect(values).toEqual({ 'tree.expanded.i.a': true, 'tree.expanded.i.b': false });
});
