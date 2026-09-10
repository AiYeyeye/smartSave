export function expansionKey(installationId: string, nativeId: string) { return `tree.expanded.${encodeURIComponent(installationId)}.${encodeURIComponent(nativeId)}`; }
export function saveExpansion(storage: Pick<typeof chrome.storage.local, 'set'>, installationId: string, nativeId: string, expanded: boolean) {
  return storage.set({ [expansionKey(installationId, nativeId)]: expanded });
}
