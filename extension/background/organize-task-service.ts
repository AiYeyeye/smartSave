import { withTrustedSender } from '../domain/trusted-sender';
import {
  organizeTaskError,
  organizeTaskMessageSchema,
  organizeTaskSubscriptionSchema,
  ORGANIZE_TASK_PORT,
  type OrganizeTaskReply,
} from '../domain/organize-task-protocol';
import type { OrganizeTaskOwner } from './organize-task-owner';
import type { OrganizeTaskBadge } from './organize-task-badge';

/** Register synchronously. Page disconnect only removes its subscription, never the worker's task. */
export function startOrganizeTaskService(
  owner: Pick<OrganizeTaskOwner, 'start' | 'get' | 'list' | 'command' | 'select' | 'subscribe' | 'dispose'>,
  badge?: Pick<OrganizeTaskBadge, 'focus' | 'seen'>,
) {
  const message = (
    input: unknown,
    sender: chrome.runtime.MessageSender,
    respond: (reply: OrganizeTaskReply) => void,
  ) => {
    if (!input || typeof input !== 'object' || !('type' in input) || input.type !== 'organizeTask') return false;
    return withTrustedSender(
      sender,
      chrome.runtime.id,
      () => {
        const parsed = organizeTaskMessageSchema.safeParse(input);
        if (!parsed.success) {
          respond({ ok: false, reason: 'invalid-organize-task-request' });
          return false;
        }
        const request = parsed.data;
        const execute = async (): Promise<OrganizeTaskReply> => {
          if (request.action === 'list') return { ok: true, tasks: await owner.list() };
          if (request.action === 'start') {
            const task = await owner.start(request);
            badge?.focus(task);
            return { ok: true, task };
          }
          if (request.action === 'get') return { ok: true, task: await owner.get(request.id, request.credential) };
          if (request.action === 'select')
            return {
              ok: true,
              task: await owner.select(request.id, request.expectedRevision, {
                ids: request.ids,
                selected: request.selected,
              }),
            };
          if (request.action === 'target')
            return {
              ok: true,
              task: await owner.select(request.id, request.expectedRevision, {
                id: request.actionId,
                target: request.targetId,
              }),
            };
          const task = await owner.command(request.id, request.expectedRevision, request.action, request.credential);
          if (['confirmFolders', 'resume', 'repair', 'returnToFolders'].includes(request.action)) badge?.focus(task);
          return { ok: true, task };
        };
        void execute().then(respond, error => respond({ ok: false, reason: organizeTaskError(error) }));
        return true;
      },
      () => respond({ ok: false, reason: 'invalid-sender' }),
    );
  };
  const connect = (port: chrome.runtime.Port) => {
    if (port.name !== ORGANIZE_TASK_PORT) return;
    if (!port.sender) {
      port.disconnect();
      return;
    }
    let connected = true;
    let watched: string | undefined;
    let delivered: { id: string; revision: number } | undefined;
    let stop: (() => void) | undefined;
    const send = (value: unknown) => {
      if (connected) {
        try {
          port.postMessage(value);
        } catch {
          /* Disconnect cleanup owns the subscription. */
        }
      }
    };
    port.onDisconnect.addListener(() => {
      connected = false;
      stop?.();
    });
    withTrustedSender(
      port.sender,
      chrome.runtime.id,
      () => {
        if (!connected) return;
        stop = owner.subscribe(task => {
          if (!watched || watched === task.id) {
            delivered = { id: task.id, revision: task.revision };
            send({ version: 1, task });
          }
        });
        port.onMessage.addListener((input: unknown) => {
          const parsed = organizeTaskSubscriptionSchema.safeParse(input);
          if (!parsed.success) {
            port.disconnect();
            return;
          }
          if (parsed.data.type === 'seen') {
            if (watched === parsed.data.id && delivered?.id === watched && parsed.data.revision <= delivered.revision)
              badge?.seen(parsed.data.id, parsed.data.revision);
            return;
          }
          watched = parsed.data.id;
          if (watched) {
            const requested = watched;
            void owner.get(requested).then(
              task => {
                if (watched === requested) {
                  delivered = { id: task.id, revision: task.revision };
                  send({ version: 1, task });
                }
              },
              error => {
                if (watched === requested) send({ version: 1, error: organizeTaskError(error) });
              },
            );
          }
        });
      },
      () => port.disconnect(),
    );
  };
  chrome.runtime.onMessage.addListener(message);
  chrome.runtime.onConnect.addListener(connect);
  return () => {
    chrome.runtime.onMessage.removeListener(message);
    chrome.runtime.onConnect.removeListener(connect);
    owner.dispose();
  };
}
