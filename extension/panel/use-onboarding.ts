import { useEffect, useRef, useState } from 'react';
import { ONBOARDING_KEY, onboardingPending } from '../persistence/onboarding';

export function useOnboarding() {
  const [visible, setVisible] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const revision = useRef(0);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    let live = true;
    const initial = revision.current;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !(ONBOARDING_KEY in changes)) return;
      revision.current++;
      setVisible(onboardingPending(changes[ONBOARDING_KEY]?.newValue));
    };
    chrome.storage.onChanged?.addListener(changed);
    void chrome.storage.local
      .get(ONBOARDING_KEY)
      .then(stored => {
        if (live && revision.current === initial) setVisible(onboardingPending(stored[ONBOARDING_KEY]));
      })
      .catch(() => {
        /* Browsing remains available; the guide can be opened from settings. */
      });
    return () => {
      live = false;
      chrome.storage.onChanged?.removeListener(changed);
    };
  }, []);

  function show() {
    revision.current++;
    setSaveFailed(false);
    setVisible(true);
  }

  async function dismiss() {
    const operation = ++revision.current;
    setVisible(false);
    setSaveFailed(false);
    try {
      await chrome.storage.local.set({ [ONBOARDING_KEY]: { version: 1, pending: false } });
    } catch {
      if (revision.current === operation) setSaveFailed(true);
    }
  }

  return { visible, saveFailed, show, dismiss };
}
