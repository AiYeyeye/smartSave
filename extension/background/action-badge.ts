import { browserMessage } from '../domain/browser-message';
export type NativeBadgeState = 'working' | 'done' | 'attention' | 'clear';
export type BadgeStyle = { text: string; color: string; title: string };
export const SAVE_BADGE = '●';
const empty: BadgeStyle = { text: '', color: '#6155A6', title: browserMessage('brand') };
const nativeStyles: Record<Exclude<NativeBadgeState, 'clear'>, BadgeStyle> = {
  working: { text: '…', color: '#6366F1', title: browserMessage('nativeWorking') },
  done: { text: '✓', color: '#16A34A', title: browserMessage('nativeDone') },
  attention: { text: '!', color: '#D97706', title: browserMessage('nativeAttention') },
};
const pending: BadgeStyle = { text: SAVE_BADGE, color: '#6155A6', title: browserMessage('savePending') };

/** Sole action API writer. Timers withdraw their own source; they never clear another feature's badge. */
export class ActionBadgeOwner {
  private native?: BadgeStyle;
  private organizer?: BadgeStyle;
  private tabs = new Map<number, boolean>();
  private applied = new Map<number | 'global', string>();
  private queue: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  constructor(private action: Pick<typeof chrome.action, 'setBadgeText'> & Partial<typeof chrome.action>) {}
  /** Old per-tab overrides outlive a worker. Captures do not, so clear them without restoring capture authority. */
  async initialize(tabs: Pick<typeof chrome.tabs, 'query' | 'onRemoved'>) {
    tabs.onRemoved.addListener(id => {
      this.tabs.delete(id);
      this.applied.delete(id);
    });
    try {
      for (const tab of await tabs.query({}))
        if (tab.id !== undefined && !this.tabs.has(tab.id)) this.tabs.set(tab.id, false);
      await this.render();
    } catch {
      /* Advisory UI never blocks a save or organizer task. */
    }
  }
  savePending(tabId: number, on: boolean) {
    this.tabs.set(tabId, on);
    return this.render();
  }
  nativeSave(state: NativeBadgeState) {
    const sequence = ++this.sequence;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.native = state === 'clear' ? undefined : nativeStyles[state];
    if (state === 'done' || state === 'attention')
      this.timer = setTimeout(
        () => {
          if (sequence !== this.sequence) return;
          this.native = undefined;
          this.timer = undefined;
          void this.render();
        },
        state === 'done' ? 3000 : 8000,
      );
    return this.render();
  }
  organize(style: BadgeStyle | undefined) {
    this.organizer = style;
    return this.render();
  }
  private render() {
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        const fallback = this.native ?? this.organizer ?? empty;
        const entries: [number | 'global', BadgeStyle][] = [
          ['global', fallback],
          ...[...this.tabs].map(([id, on]) => [id, on ? pending : fallback] as [number, BadgeStyle]),
        ];
        for (const [id, style] of entries) {
          // null restores global text inheritance; colors/titles are explicitly projected for previously touched tabs.
          const text = id === 'global' || this.tabs.get(id) ? style.text : null;
          const key = JSON.stringify([text, style.color, style.title]);
          if (this.applied.get(id) === key) continue;
          const scope = id === 'global' ? {} : { tabId: id };
          try {
            // Chrome documents null to restore inheritance; the pinned @types/chrome omits this accepted value.
            // https://developer.chrome.com/docs/extensions/reference/api/action#method-setBadgeText
            const setText = this.action.setBadgeText as (details: {
              tabId?: number;
              text: string | null;
            }) => Promise<void>;
            await setText.call(this.action, { ...scope, text });
            await this.action.setBadgeBackgroundColor?.({ ...scope, color: style.color });
            await this.action.setTitle?.({ ...scope, title: style.title });
            this.applied.set(id, key);
          } catch {
            /* A tab may close while its projection is in flight. Retry on the next source update. */
          }
        }
      });
    return this.queue;
  }
}

const owners = new WeakMap<object, ActionBadgeOwner>();
export function actionBadges(): ActionBadgeOwner | undefined {
  const action = typeof chrome !== 'undefined' ? chrome.action : undefined;
  if (!action?.setBadgeText) return;
  let owner = owners.get(action);
  if (!owner) {
    owner = new ActionBadgeOwner(action);
    owners.set(action, owner);
  }
  return owner;
}
