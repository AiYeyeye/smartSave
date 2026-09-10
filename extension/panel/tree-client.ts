import { z } from 'zod';
import { TREE_PORT, treeStateSchema, type TreeState } from '../domain/node-reference';
const envelope = z.object({ version: z.literal(1), state: treeStateSchema });
export function connectTree(runtime: Pick<typeof chrome.runtime, 'connect'>, receive: (state: TreeState) => void) {
  let closed = false;
  let port: chrome.runtime.Port | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  function connect() {
    const current = ++generation;
    receive({ status: 'loading' });
    try {
      const connection = runtime.connect({ name: TREE_PORT });
      port = connection;
      connection.onMessage.addListener((message: unknown) => {
        if (closed || generation !== current) return;
        const parsed = envelope.safeParse(message);
        receive(parsed.success ? parsed.data.state : { status: 'error', message: '书签响应无效，请重新连接。' });
      });
      connection.postMessage({ version: 1, type: 'refresh' });
      connection.onDisconnect.addListener(() => {
        if (closed || generation !== current) return;
        generation++;
        receive({ status: 'error', message: '书签连接已断开，正在重新连接…' });
        timer = setTimeout(connect, 1000);
      });
    } catch { receive({ status: 'error', message: '无法连接书签服务，请重试。' }); }
  }
  connect();
  return () => { closed = true; generation++; clearTimeout(timer); port?.disconnect(); };
}
