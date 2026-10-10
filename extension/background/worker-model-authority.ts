import type { ModelAuthority, ModelAuthorityChange } from '../adapters/model-authority';
import type { TreeSnapshot } from '../domain/node-reference';
import type { SettingsStore } from '../persistence/settings';
import type { TreeProjection } from './tree-projection';

/**
 * Service-worker ModelAuthority: reads the live TreeProjection (no TREE_PORT loopback)
 * and SettingsStore. Tree subscribe uses projection publish; settings/permissions cancel in-flight runs.
 */
export function workerModelAuthority(projection: TreeProjection, store: SettingsStore): ModelAuthority {
  const listeners = new Set<(change?: ModelAuthorityChange) => void>();
  let stop: (() => void) | undefined;
  const changed = (change: ModelAuthorityChange) => {
    for (const listener of listeners) listener(change);
  };
  const permissionsRemoved = () => changed('permissions');
  return {
    async read() {
      const tree = await projection.fresh();
      const settings = await store.snapshot();
      return { ...settings, tree: structuredClone(tree) as TreeSnapshot };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        const stopTree = projection.subscribe(() => changed('tree'));
        const stopStore = store.subscribe(() => changed('settings'));
        if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved)
          chrome.permissions.onRemoved.addListener(permissionsRemoved);
        stop = () => {
          stopTree();
          stopStore();
          if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved)
            chrome.permissions.onRemoved.removeListener(permissionsRemoved);
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
