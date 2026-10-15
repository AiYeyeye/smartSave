import type { ConfirmMutation } from '../schemas/messages';
import { trustedMutationSender, withTrustedSender } from '../domain/trusted-sender';
import type { SettingsStore } from '../persistence/settings';
import { createDebugLog } from '../domain/debug-log';
import {
  ORGANIZER_HEARTBEAT_MS,
  ORGANIZER_HEARTBEAT_SILENCE_MS,
  organizerHeartbeat,
  organizerHeartbeatControl,
} from '../domain/organizer-connection';
import type { WorkerDiagnostics } from './worker-diagnostics';

type Sender = { id?: string; url?: string; tab?: unknown };
export const ORGANIZER_PORT = 'zhilan-organizer-authority-v1';
// Tokens are random worker-lifetime lease identities, never settings, keys or page bodies.
export class OrganizerAuthority {
  private version = 0;
  private leases = new Map<string, { sender: Sender; version: number; settings: string }>();
  constructor(
    private settings: Pick<SettingsStore, 'snapshot' | 'subscribe'>,
    private extensionId: string,
  ) {
    settings.subscribe(() => {
      this.version++;
      this.leases.clear();
    });
  }
  async open(sender: Sender): Promise<string> {
    if (!trustedMutationSender(sender, this.extensionId)) throw Error('invalid-sender');
    const version = this.version;
    const settings = await this.identity();
    if (version !== this.version) throw Error('stale-authority');
    const token = crypto.randomUUID();
    this.leases.set(token, { sender: { id: sender.id, url: sender.url }, version, settings });
    return token;
  }
  close(token: string) {
    this.leases.delete(token);
  }
  private async identity() {
    const { version, config, privacy, revision } = await this.settings.snapshot();
    return JSON.stringify({ version, config, privacy, revision });
  }
  async validate(request: ConfirmMutation, sender: Sender): Promise<boolean> {
    if (!request.organizerContext) return true;
    const token = request.organizerContext;
    const lease = this.leases.get(token);
    if (!lease || lease.sender.id !== sender.id || lease.sender.url !== sender.url) return false;
    try {
      const identity = await this.identity();
      return this.current(request) && identity === lease.settings;
    } catch {
      this.close(token);
      return false;
    }
  }
  current(request: ConfirmMutation) {
    if (!request.organizerContext) return true;
    const lease = this.leases.get(request.organizerContext);
    return !!lease && lease.version === this.version;
  }
}

export function startOrganizerAuthority(
  settings: Pick<SettingsStore, 'snapshot' | 'subscribe'>,
  diagnostics: WorkerDiagnostics = { workerInstance: crypto.randomUUID(), startedAt: Date.now() },
) {
  const authority = new OrganizerAuthority(settings, chrome.runtime.id);
  const debug = createDebugLog('organizer-worker');
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== ORGANIZER_PORT) return;
    const connectionId = crypto.randomUUID();
    const connectedAt = Date.now();
    let lastHeartbeatAt: number | undefined;
    let sequence = 0;
    let pingSequence = 0;
    const record = (event: string, reason?: string) =>
      debug(event, {
        connectionId,
        workerInstance: diagnostics.workerInstance,
        reason,
        workerUptimeMs: Date.now() - diagnostics.startedAt,
        connectionAgeMs: Date.now() - connectedAt,
        sequence,
        pingSequence,
        lastHeartbeatAgeMs: lastHeartbeatAt === undefined ? undefined : Date.now() - lastHeartbeatAt,
      });
    record('port-connected');
    if (!port.sender) {
      record('port-rejected', 'missing-sender');
      port.disconnect();
      return;
    }
    let connected = true;
    let token: string | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let awaitingSince = Date.now();
    const stopHeartbeat = () => {
      clearInterval(heartbeat);
      heartbeat = undefined;
    };
    const disconnect = (reason: string) => {
      record('port-closed', reason);
      connected = false;
      stopHeartbeat();
      if (token) authority.close(token);
      port.disconnect();
    };
    port.onDisconnect.addListener(() => {
      record('port-disconnected');
      connected = false;
      stopHeartbeat();
      if (token) authority.close(token);
    });
    // Closing this lease is the cancellation/session-key-change boundary. Reopening requires a new preview.
    withTrustedSender(
      port.sender,
      chrome.runtime.id,
      () => {
        if (!connected) return;
        // A message during an active lease resets the MV3 idle timer without changing its authority.
        port.onMessage.addListener((raw: unknown) => {
          if (!connected || !token) return;
          const control = organizerHeartbeatControl.safeParse(raw);
          if (control.success) {
            if (!control.data.active) {
              stopHeartbeat();
              record('heartbeat-stopped');
            } else if (heartbeat === undefined) {
              awaitingSince = Date.now();
              record('heartbeat-started');
              // This clock belongs to the worker, not a hidden/throttled document.
              // Only an active trusted lease owns it; missing page replies bound its lifetime.
              heartbeat = setInterval(() => {
                if (Date.now() - awaitingSince >= ORGANIZER_HEARTBEAT_SILENCE_MS) {
                  disconnect('heartbeat-peer-silent');
                  return;
                }
                try {
                  pingSequence++;
                  port.postMessage({
                    version: 1,
                    type: 'keepalive-ping',
                    sequence: pingSequence,
                    workerInstance: diagnostics.workerInstance,
                  });
                  record('heartbeat-ping');
                } catch {
                  disconnect('heartbeat-ping-failed');
                }
              }, ORGANIZER_HEARTBEAT_MS);
            }
            return;
          }
          const parsed = organizerHeartbeat.safeParse(raw);
          if (!parsed.success || !connected) return;
          if (heartbeat !== undefined && (parsed.data.sequence !== pingSequence || parsed.data.sequence <= sequence))
            return;
          sequence = parsed.data.sequence;
          record('heartbeat-received');
          lastHeartbeatAt = Date.now();
          awaitingSince = lastHeartbeatAt;
          try {
            port.postMessage({
              version: 1,
              type: 'keepalive-ack',
              sequence,
              workerInstance: diagnostics.workerInstance,
            });
          } catch {
            // Diagnostic acknowledgement failure must not revoke authority or change the operation.
            record('heartbeat-ack-failed');
          }
        });
        void authority
          .open(port.sender!)
          .then(value => {
            token = value;
            if (!connected) {
              authority.close(value);
              return;
            }
            try {
              port.postMessage({
                version: 1,
                organizerContext: value,
                connectionId,
                workerInstance: diagnostics.workerInstance,
                heartbeatOwner: 'worker',
              });
              record('lease-opened');
            } catch {
              record('port-rejected', 'greeting-send-failed');
              authority.close(value);
              port.disconnect();
            }
          })
          .catch(() => {
            record('port-rejected', 'lease-open-failed');
            port.disconnect();
          });
      },
      () => {
        record('port-rejected', 'untrusted-sender');
        port.disconnect();
      },
    );
  });
  return authority;
}
