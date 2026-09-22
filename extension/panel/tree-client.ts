import { z } from 'zod';
import { TREE_PORT, treeStateSchema, type TreeState } from '../domain/node-reference';
const envelope = z.object({ version: z.literal(1), state: treeStateSchema });
const MAX_RECONNECTS = 3;
const RESPONSE_TIMEOUT_MS = 10_000;
export function connectTree(runtime: Pick<typeof chrome.runtime, 'connect'>, receive: (state: TreeState) => void) {
  let closed = false;
  let port: chrome.runtime.Port | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let responseTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let failures = 0;
  function detach() {
    generation++;
    clearTimeout(responseTimer);
    const old = port;
    port = undefined;
    try {
      old?.disconnect();
    } catch {
      /* Already disconnected. */
    }
  }
  function retry(message: string) {
    if (closed) return;
    detach();
    clearTimeout(retryTimer);
    // Invalidate authority immediately. Only the view may retain a read-only snapshot.
    receive({ status: 'loading' });
    if (++failures > MAX_RECONNECTS) {
      receive({ status: 'error', message });
      return;
    }
    retryTimer = setTimeout(connect, 1000);
  }
  function connect() {
    if (closed) return;
    const current = ++generation;
    receive({ status: 'loading' });
    try {
      const connection = runtime.connect({ name: TREE_PORT });
      port = connection;
      function awaitResponse() {
        clearTimeout(responseTimer);
        responseTimer = setTimeout(() => {
          if (!closed && generation === current) retry('书签服务响应超时，请重试；若仍失败，请重新打开智栏。');
        }, RESPONSE_TIMEOUT_MS);
      }
      connection.onMessage.addListener((message: unknown) => {
        if (closed || generation !== current) return;
        const parsed = envelope.safeParse(message);
        if (!parsed.success) {
          retry('书签响应无效，请重新连接。');
          return;
        }
        if (parsed.data.state.status === 'loading') {
          // Repeated loading events must not extend an already-running deadline.
          if (responseTimer === undefined) awaitResponse();
        } else {
          clearTimeout(responseTimer);
          responseTimer = undefined;
        }
        if (parsed.data.state.status === 'ready') failures = 0;
        receive(parsed.data.state);
      });
      // Subscribe before postMessage: a synchronous disconnect/throw must not be lost.
      connection.onDisconnect.addListener(() => {
        if (closed || generation !== current) return;
        retry('书签连接已断开，请重试。');
      });
      awaitResponse();
      connection.postMessage({ version: 1, type: 'refresh' });
    } catch {
      if (generation === current) retry('无法连接书签服务，请重试。');
    }
  }
  connect();
  return () => {
    closed = true;
    clearTimeout(retryTimer);
    detach();
  };
}
