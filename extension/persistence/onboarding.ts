/** Local UI state only. An existing installation without this key is not a new user. */
export const ONBOARDING_KEY = 'sidebarOnboarding.v1';

export function onboardingPending(value: unknown): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 1 &&
    'pending' in value &&
    value.pending === true
  );
}

export async function initializeOnboarding(reason: string, storage: Pick<chrome.storage.StorageArea, 'set'>) {
  if (reason === 'install') await storage.set({ [ONBOARDING_KEY]: { version: 1, pending: true } });
}
