import type { TreeSnapshot } from '../domain/node-reference';
import type { SettingsStore } from '../persistence/settings';
import { connectTree } from '../panel/tree-client';
/** Which owner changed: tree port state, settings/session envelope, or a removed host permission. Legacy no-argument notifiers are treated as settings-level changes. */
export type ModelAuthorityChange = 'tree' | 'settings' | 'permissions';
export interface ModelAuthority {
  read(): Promise<Awaited<ReturnType<SettingsStore['snapshot']>> & { tree: TreeSnapshot }>;
  subscribe(listener: (change?: ModelAuthorityChange) => void): () => void;
}
// Every consumer uses the same settings owner and authoritative tree port; UI state is not authority.
export function browserModelAuthority(store: Pick<SettingsStore, 'snapshot' | 'subscribe'>): ModelAuthority {
  let tree: TreeSnapshot | undefined;
  const listeners = new Set<(change?: ModelAuthorityChange) => void>();
  let stop: (() => void) | undefined;
  const changed = (change: ModelAuthorityChange) => {
    for (const listener of listeners) listener(change);
  };
  const permissionsRemoved = () => changed('permissions');
  return {
    async read() {
      if (!tree) throw Error('tree-unavailable');
      const settings = await store.snapshot();
      if (!tree) throw Error('tree-unavailable');
      return { ...settings, tree: structuredClone(tree) };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        const stopTree = connectTree(chrome.runtime, state => {
          tree = state.status === 'ready' ? state.snapshot : undefined;
          changed('tree');
        });
        const stopStore = store.subscribe(() => changed('settings'));
        chrome.permissions.onRemoved.addListener(permissionsRemoved);
        stop = () => {
          stopTree();
          stopStore();
          chrome.permissions.onRemoved.removeListener(permissionsRemoved);
          tree = undefined;
        };
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
}
