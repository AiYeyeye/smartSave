import { openOrganizerLease } from '../../panel/organizer-client';

declare global {
  interface Window {
    organizerLeaseProbe: { status: string; blockedIntervals: number; close?: () => void };
  }
}
window.organizerLeaseProbe = { status: 'opening', blockedIntervals: 0 };
void openOrganizerLease(() => {
  window.organizerLeaseProbe.status = 'disconnected';
}, 'browser-clock-probe')
  .then(lease => {
    window.organizerLeaseProbe.status = 'connected';
    window.organizerLeaseProbe.close = () => {
      lease.close();
      window.organizerLeaseProbe.status = 'closed';
    };
  })
  .catch(() => {
    window.organizerLeaseProbe.status = 'failed';
  });
