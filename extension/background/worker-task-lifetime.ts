// Chrome 110+ resets the worker idle timer on extension API calls. Network
// activity and a pending Promise alone do not keep a service worker alive.
const PULSE_MS = 20_000;

async function extensionPulse(): Promise<unknown> {
  if (typeof chrome !== 'undefined' && chrome.runtime?.getPlatformInfo) return chrome.runtime.getPlatformInfo();
}

/** Active work only: concurrent tasks share a timer; the last release stops it. */
export function createWorkerTaskLifetime(pulse: () => Promise<unknown> = extensionPulse) {
  const owners = new Set<symbol>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  const tick = () => {
    void Promise.resolve()
      .then(pulse)
      .catch(() => {});
  };
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  return {
    acquire() {
      if (disposed) return () => {};
      const owner = Symbol();
      owners.add(owner);
      if (timer === undefined) {
        tick();
        timer = setInterval(tick, PULSE_MS);
      }
      return () => {
        owners.delete(owner);
        if (!owners.size) stop();
      };
    },
    dispose() {
      disposed = true;
      owners.clear();
      stop();
    },
  };
}
