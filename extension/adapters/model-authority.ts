import type { TreeSnapshot } from '../domain/node-reference';
import type { SettingsStore } from '../persistence/settings';
import { connectTree } from '../panel/tree-client';
export interface ModelAuthority {
  read(): Promise<Awaited<ReturnType<SettingsStore['snapshot']>> & { tree: TreeSnapshot }>;
  subscribe(listener: () => void): () => void;
}
// Every consumer uses the same settings owner and authoritative tree port; UI state is not authority.
export function browserModelAuthority(store: SettingsStore): ModelAuthority {
  let tree: TreeSnapshot | undefined;
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const changed = () => { for (const listener of listeners) listener(); };
  return {
    async read() { if (!tree) throw Error('tree-unavailable'); const settings = await store.snapshot(); if (!tree) throw Error('tree-unavailable'); return { ...settings, tree: structuredClone(tree) }; },
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        const stopTree = connectTree(chrome.runtime, state => { tree = state.status === 'ready' ? state.snapshot : undefined; changed(); });
        const stopStore = store.subscribe(changed);
        chrome.permissions.onRemoved.addListener(changed);
        stop = () => { stopTree(); stopStore(); chrome.permissions.onRemoved.removeListener(changed); tree = undefined; };
      }
      return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; } };
    },
  };
}
