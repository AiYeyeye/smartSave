import { createDebugLog, type DebugDetail } from '../domain/debug-log';
import {
  ORGANIZER_HEARTBEAT_MS,
  organizerGreeting,
  organizerHeartbeatAck,
  organizerHeartbeatPing,
} from '../domain/organizer-connection';
export interface OrganizerLease {
  token: string;
  close(): void;
  setActive?(active: boolean): void;
}
export type OpenOrganizerLease = (invalidated: () => void, runId?: string) => Promise<OrganizerLease>;
export const openOrganizerLease: OpenOrganizerLease = (invalidated, runId) =>
  new Promise((resolve, reject) => {
    const debug = createDebugLog('organizer-client');
    const attemptId = crypto.randomUUID();
    const startedAt = Date.now();
    let connectionId: string | undefined;
    let workerInstance: string | undefined;
    let heartbeatOwner: 'worker' | 'page' = 'page';
    let active = false;
    let sequence = 0;
    let acknowledged = 0;
    let sentAt: number | undefined;
    let ackAt: number | undefined;
    const record = (event: string, detail?: DebugDetail) =>
      debug(event, {
        runId,
        attemptId,
        connectionId,
        workerInstance,
        heartbeatOwner,
        elapsedMs: Date.now() - startedAt,
        visibility: typeof document === 'undefined' ? 'unavailable' : document.visibilityState,
        sequence,
        acknowledged,
        lastSendAgeMs: sentAt === undefined ? undefined : Date.now() - sentAt,
        lastAckAgeMs: ackAt === undefined ? undefined : Date.now() - ackAt,
        ...detail,
      });
    record('connecting');
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connect({ name: 'zhilan-organizer-authority-v1' });
    } catch {
      record('connect-failed');
      reject(Error('authority-unavailable'));
      return;
    }
    let closed = false;
    let delivered = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const pageEvent = (event: Event) =>
      record('page-lifecycle', {
        kind: event.type,
        persisted: 'persisted' in event && event.persisted === true,
      });
    const documentEvents = ['visibilitychange', 'freeze', 'resume'];
    const windowEvents = ['pagehide', 'pageshow'];
    documentEvents.forEach(event => globalThis.document?.addEventListener(event, pageEvent));
    windowEvents.forEach(event => globalThis.window?.addEventListener(event, pageEvent));
    const detachPage = () => {
      documentEvents.forEach(event => globalThis.document?.removeEventListener(event, pageEvent));
      windowEvents.forEach(event => globalThis.window?.removeEventListener(event, pageEvent));
    };
    const sendHeartbeat = (lagMs?: number) => {
      try {
        sentAt = Date.now();
        port.postMessage({ version: 1, type: 'keepalive', sequence });
        record('heartbeat-sent', { lagMs });
      } catch {
        record('heartbeat-send-failed', { lagMs });
        close('heartbeat-send-failed');
        invalidated();
      }
    };
    const setActive = (nextActive: boolean) => {
      active = nextActive;
      clearInterval(heartbeat);
      heartbeat = undefined;
      record('heartbeat-state', { active, closed });
      if (closed) return;
      if (heartbeatOwner === 'worker') {
        try {
          port.postMessage({ version: 1, type: 'heartbeat-control', active });
        } catch {
          record('heartbeat-control-failed');
          close('heartbeat-control-failed');
          invalidated();
        }
        return;
      }
      // Compatibility with an older worker only. New workers own the clock so hidden tabs cannot delay it.
      if (active && !closed) {
        let expectedAt = Date.now() + ORGANIZER_HEARTBEAT_MS;
        heartbeat = setInterval(() => {
          const now = Date.now();
          const lagMs = Math.max(0, now - expectedAt);
          expectedAt = now + ORGANIZER_HEARTBEAT_MS;
          sequence++;
          sendHeartbeat(lagMs);
        }, ORGANIZER_HEARTBEAT_MS);
      }
    };
    const close = (reason = 'owner-close') => {
      if (!closed) {
        record('closed', { reason });
        closed = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        detachPage();
        port.disconnect();
      }
    };
    const timer = setTimeout(() => {
      close('open-timeout');
      reject(Error('authority-unavailable'));
    }, 10000);
    port.onDisconnect.addListener(() => {
      // Read lastError synchronously in the callback. Record only an allowlisted category.
      const message = chrome.runtime.lastError?.message;
      record('disconnected', {
        localClose: closed,
        delivered,
        runtimeError: !message
          ? 'none'
          : /context invalidated/i.test(message)
            ? 'context-invalidated'
            : /receiving end does not exist|could not establish connection/i.test(message)
              ? 'receiver-unavailable'
              : /closed|disconnected/i.test(message)
                ? 'port-closed'
                : 'other',
      });
      clearTimeout(timer);
      clearInterval(heartbeat);
      detachPage();
      if (!closed) {
        closed = true;
        invalidated();
      }
      if (!delivered) reject(Error('authority-disconnected'));
    });
    port.onMessage.addListener((raw: unknown) => {
      if (closed) return;
      if (delivered) {
        const ping = organizerHeartbeatPing.safeParse(raw);
        if (
          active &&
          heartbeatOwner === 'worker' &&
          ping.success &&
          ping.data.workerInstance === workerInstance &&
          ping.data.sequence > sequence
        ) {
          sequence = ping.data.sequence;
          record('heartbeat-ping-received');
          sendHeartbeat();
          return;
        }
        const ack = organizerHeartbeatAck.safeParse(raw);
        if (
          ack.success &&
          ack.data.workerInstance === workerInstance &&
          ack.data.sequence > acknowledged &&
          ack.data.sequence <= sequence
        ) {
          acknowledged = ack.data.sequence;
          ackAt = Date.now();
          record('heartbeat-ack', {
            roundTripMs: acknowledged === sequence && sentAt !== undefined ? ackAt - sentAt : undefined,
          });
        }
        return;
      }
      const parsed = organizerGreeting.safeParse(raw);
      clearTimeout(timer);
      if (!parsed.success) {
        close('invalid-greeting');
        reject(Error('authority-invalid'));
        return;
      }
      delivered = true;
      connectionId = parsed.data.connectionId;
      workerInstance = parsed.data.workerInstance;
      heartbeatOwner = parsed.data.heartbeatOwner ?? 'page';
      record('lease-opened');
      // Only an open organizer lease stays active; close/dispose releases this bounded operation owner.
      setActive(true);
      resolve({ token: parsed.data.organizerContext, close: () => close(), setActive });
    });
  });
