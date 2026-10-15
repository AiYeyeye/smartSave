import type { ModelAuthority, ModelAuthorityChange } from '../adapters/model-authority';
import type { ModelSettingsReader } from '../adapters/feature-model-settings';
import { settingsIdentity } from '../domain/context-dependencies';
import type { TreeProjection } from './tree-projection';

export type OrganizeCredentialGrant = { revision: string; identity: string; key: string };

/** Temporary credentials are task memory only, bound to the worker's current persisted feature configuration. */
export function organizeModelAuthority(
  projection: Pick<TreeProjection, 'fresh' | 'subscribe'>,
  settings: ModelSettingsReader,
  grant?: OrganizeCredentialGrant,
): ModelAuthority {
  grant = grant ? { ...grant } : undefined;
  const listeners = new Set<(change?: ModelAuthorityChange) => void>();
  let stop: (() => void) | undefined;
  const changed = (change: ModelAuthorityChange) => listeners.forEach(listener => listener(change));
  const permissionsRemoved = () => changed('permissions');
  return {
    async read() {
      const tree = await projection.fresh();
      const current = await settings.snapshot();
      if (grant && (grant.revision !== current.revision || grant.identity !== settingsIdentity(current)))
        throw Error('stale-context');
      return { ...current, tree: structuredClone(tree), ...(grant ? { key: grant.key } : {}) };
    },
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        const stopTree = projection.subscribe(() => changed('tree'));
        const stopSettings = settings.subscribe(() => changed('settings'));
        if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved)
          chrome.permissions.onRemoved.addListener(permissionsRemoved);
        stop = () => {
          stopTree();
          stopSettings();
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
