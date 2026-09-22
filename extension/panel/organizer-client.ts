import { z } from 'zod';
export interface OrganizerLease {
  token: string;
  close(): void;
}
export type OpenOrganizerLease = (invalidated: () => void) => Promise<OrganizerLease>;
export const openOrganizerLease: OpenOrganizerLease = invalidated =>
  new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'zhilan-organizer-authority-v1' });
    let closed = false;
    let delivered = false;
    const close = () => {
      if (!closed) {
        closed = true;
        port.disconnect();
      }
    };
    const timer = setTimeout(() => {
      close();
      reject(Error('authority-unavailable'));
    }, 10000);
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      if (!closed) {
        closed = true;
        invalidated();
      }
      if (!delivered) reject(Error('authority-disconnected'));
    });
    port.onMessage.addListener((raw: unknown) => {
      const parsed = z.strictObject({ version: z.literal(1), organizerContext: z.string().min(1) }).safeParse(raw);
      if (closed || delivered) return;
      clearTimeout(timer);
      if (!parsed.success) {
        close();
        reject(Error('authority-invalid'));
        return;
      }
      delivered = true;
      resolve({ token: parsed.data.organizerContext, close });
    });
  });
