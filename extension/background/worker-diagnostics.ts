import { createDebugLog } from '../domain/debug-log';

export interface WorkerDiagnostics {
  workerInstance: string;
  startedAt: number;
}

/** Observational only: no keepalive timer, persistence recovery, or new authority. */
export function startWorkerDiagnostics(): WorkerDiagnostics {
  const context = { workerInstance: crypto.randomUUID(), startedAt: Date.now() };
  const debug = createDebugLog('worker');
  const record = (event: string, detail = {}) =>
    debug(event, { ...context, uptimeMs: Date.now() - context.startedAt, ...detail });
  record('started', { diagnosticVersion: 2, version: chrome.runtime.getManifest?.().version });
  // Chrome does not guarantee async persistence during suspension; absence is not evidence of a crash.
  chrome.runtime.onSuspend?.addListener(() => record('suspend-requested'));
  chrome.runtime.onSuspendCanceled?.addListener(() => record('suspend-cancelled'));
  globalThis.addEventListener?.('error', () => record('uncaught-error'));
  globalThis.addEventListener?.('unhandledrejection', () => record('unhandled-rejection'));
  return context;
}
