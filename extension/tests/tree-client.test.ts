import { expect, it, vi } from 'vitest';
import { connectTree } from '../panel/tree-client';
import { saveExpansion } from '../panel/expansion-memory';
function portHarness() {
  const ports: { message: (value: unknown) => void; disconnect: () => void; postMessage: ReturnType<typeof vi.fn> }[] =
    [];
  const connect = vi.fn(() => {
    const callbacks = {
      message: (_: unknown) => {
        void _;
      },
      disconnect: () => {},
      postMessage: vi.fn(),
    };
    ports.push(callbacks);
    return {
      onMessage: {
        addListener: (fn: (value: unknown) => void) => {
          callbacks.message = fn;
        },
      },
      onDisconnect: {
        addListener: (fn: () => void) => {
          callbacks.disconnect = fn;
        },
      },
      postMessage: callbacks.postMessage,
      disconnect: vi.fn(),
    } as unknown as chrome.runtime.Port;
  });
  return { ports, connect };
}
it('requests a fresh tree on reconnect and rejects messages from the disconnected port', () => {
  vi.useFakeTimers();
  const { ports, connect } = portHarness();
  const receive = vi.fn();
  const stop = connectTree({ connect }, receive);
  expect(ports[0]!.postMessage).toHaveBeenCalledWith({ version: 1, type: 'refresh' });
  expect(receive).toHaveBeenLastCalledWith({ status: 'loading' });
  ports[0]!.disconnect();
  expect(receive).toHaveBeenLastCalledWith({ status: 'loading' });
  vi.advanceTimersByTime(1000);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(ports[1]!.postMessage).toHaveBeenCalledWith({ version: 1, type: 'refresh' });
  receive.mockClear();
  ports[0]!.message({ version: 1, state: { status: 'loading' } });
  expect(receive).not.toHaveBeenCalled();
  stop();
  vi.useRealTimers();
});
it('invalidates authority immediately and only faults after three reconnects', () => {
  vi.useFakeTimers();
  const { ports, connect } = portHarness();
  const receive = vi.fn();
  const stop = connectTree({ connect }, receive);
  const ready = {
    status: 'ready' as const,
    snapshot: { installationId: 'i', epoch: 'e', observedRevision: 0, roots: [], nodes: [] },
  };
  ports[0]!.message({ version: 1, state: ready });
  expect(receive).toHaveBeenLastCalledWith(ready);
  for (let i = 0; i < 3; i++) {
    ports[i]!.disconnect();
    expect(receive).toHaveBeenLastCalledWith({ status: 'loading' });
    vi.advanceTimersByTime(1000);
  }
  expect(connect).toHaveBeenCalledTimes(4);
  ports[3]!.disconnect();
  expect(receive).toHaveBeenLastCalledWith({ status: 'error', message: '书签连接已断开，请重试。' });
  const calls = connect.mock.calls.length;
  vi.advanceTimersByTime(5000);
  expect(connect).toHaveBeenCalledTimes(calls);
  stop();
  vi.useRealTimers();
});
it('clean teardown does not surface a disconnect fault', () => {
  vi.useFakeTimers();
  const { ports, connect } = portHarness();
  const receive = vi.fn();
  const stop = connectTree({ connect }, receive);
  receive.mockClear();
  stop();
  ports[0]!.disconnect();
  vi.advanceTimersByTime(5000);
  expect(receive).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});
it('connect throws retry with the same bound and keep last state', () => {
  vi.useFakeTimers();
  const ports: { message: (value: unknown) => void; disconnect: () => void }[] = [];
  const connect = vi.fn(() => {
    if (connect.mock.calls.length > 1) throw Error('worker asleep');
    const callbacks = {
      message: (_: unknown) => {
        void _;
      },
      disconnect: () => {},
    };
    ports.push(callbacks);
    return {
      onMessage: {
        addListener: (fn: (value: unknown) => void) => {
          callbacks.message = fn;
        },
      },
      onDisconnect: {
        addListener: (fn: () => void) => {
          callbacks.disconnect = fn;
        },
      },
      postMessage: vi.fn(),
      disconnect: vi.fn(),
    } as unknown as chrome.runtime.Port;
  });
  const receive = vi.fn();
  const stop = connectTree({ connect }, receive);
  const ready = {
    status: 'ready' as const,
    snapshot: { installationId: 'i', epoch: 'e', observedRevision: 0, roots: [], nodes: [] },
  };
  ports[0]!.message({ version: 1, state: ready });
  ports[0]!.disconnect();
  expect(receive).toHaveBeenLastCalledWith({ status: 'loading' });
  vi.advanceTimersByTime(1000);
  expect(receive).toHaveBeenLastCalledWith({ status: 'loading' });
  vi.advanceTimersByTime(1000);
  expect(receive).toHaveBeenLastCalledWith({ status: 'loading' });
  vi.advanceTimersByTime(1000);
  expect(receive).toHaveBeenLastCalledWith({ status: 'error', message: '无法连接书签服务，请重试。' });
  stop();
  vi.useRealTimers();
});
it('writes only the changed expansion key across concurrent panels', async () => {
  const values: Record<string, unknown> = {};
  const set = vi.fn(async (patch: Record<string, unknown>) => {
    Object.assign(values, patch);
  });
  await Promise.all([saveExpansion({ set }, 'i', 'a', true), saveExpansion({ set }, 'i', 'b', false)]);
  expect(values).toEqual({ 'tree.expanded.i.a': true, 'tree.expanded.i.b': false });
});
it('silent and malformed ports exhaust a bounded retry budget, even after loading messages', () => {
  vi.useFakeTimers();
  const { ports, connect } = portHarness();
  const receive = vi.fn();
  const stop = connectTree({ connect }, receive);
  ports[0]!.message({ invalid: true });
  vi.advanceTimersByTime(1000);
  ports[1]!.message({ version: 1, state: { status: 'loading' } });
  vi.advanceTimersByTime(10000);
  vi.advanceTimersByTime(1000);
  ports[2]!.message({ invalid: true });
  vi.advanceTimersByTime(1000);
  ports[3]!.message({ invalid: true });
  expect(receive).toHaveBeenLastCalledWith({ status: 'error', message: '书签响应无效，请重新连接。' });
  vi.advanceTimersByTime(60000);
  expect(connect).toHaveBeenCalledTimes(4);
  stop();
  vi.useRealTimers();
});
