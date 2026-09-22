import type { ConfirmMutation } from '../schemas/messages';
import { trustedMutationSender } from '../schemas/messages';
import type { SettingsStore } from '../persistence/settings';

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

export function startOrganizerAuthority(settings: SettingsStore) {
  const authority = new OrganizerAuthority(settings, chrome.runtime.id);
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== ORGANIZER_PORT) return;
    if (!port.sender || !trustedMutationSender(port.sender, chrome.runtime.id)) {
      port.disconnect();
      return;
    }
    let connected = true;
    let token: string | undefined;
    port.onDisconnect.addListener(() => {
      connected = false;
      if (token) authority.close(token);
    });
    // Closing this lease is the cancellation/session-key-change boundary. Reopening requires a new preview.
    void authority
      .open(port.sender)
      .then(value => {
        token = value;
        if (!connected) {
          authority.close(value);
          return;
        }
        try {
          port.postMessage({ version: 1, organizerContext: value });
        } catch {
          authority.close(value);
          port.disconnect();
        }
      })
      .catch(() => port.disconnect());
  });
  return authority;
}
