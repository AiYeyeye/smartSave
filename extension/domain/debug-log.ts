/** Lightweight debug sink for background classify/save paths. Safe for secrets: never log keys or payloads. */
export type DebugDetail = Record<string, string | number | boolean | undefined | null>;
export type DebugLog = (event: string, detail?: DebugDetail) => void;

/** Always-on console.debug sink; keep detail free of secrets and model bodies. */
export function createDebugLog(prefix = 'zhilan'): DebugLog {
  return (event, detail) => {
    try {
      if (detail) console.debug(`[${prefix}:${event}]`, detail);
      else console.debug(`[${prefix}:${event}]`);
    } catch {
      /* console may be unavailable in some test harnesses */
    }
  };
}

export const noopDebugLog: DebugLog = () => {};
