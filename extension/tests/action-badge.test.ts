import { afterEach, expect, it, vi } from 'vitest';
import { ActionBadgeOwner, SAVE_BADGE } from '../background/action-badge';

afterEach(() => vi.useRealTimers());
function setup() {
  const action = {
    setBadgeText: vi.fn(async () => {}),
    setBadgeBackgroundColor: vi.fn(async () => {}),
    setTitle: vi.fn(async () => {}),
  };
  return { action, owner: new ActionBadgeOwner(action) };
}
const organize = { text: '37%', color: '#6366F1', title: '分析中' };
it('expires only its own native feedback and restores the current organizer with no stale timer clearing new work', async () => {
  vi.useFakeTimers();
  const { action, owner } = setup();
  await owner.organize(organize);
  await owner.nativeSave('done');
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '✓' });
  await owner.organize({ ...organize, text: '60%' });
  await vi.advanceTimersByTimeAsync(3000);
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '60%' });
  await owner.nativeSave('attention');
  await vi.advanceTimersByTimeAsync(1000);
  await owner.nativeSave('working');
  await vi.advanceTimersByTimeAsync(8000);
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '…' });
  await owner.nativeSave('clear');
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '60%' });
});
it('keeps pending saves tab-scoped and restores text inheritance plus the latest fallback colors', async () => {
  const { action, owner } = setup();
  await owner.organize(organize);
  await owner.savePending(4, true);
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 4, text: SAVE_BADGE });
  await owner.savePending(5, false);
  await owner.nativeSave('done');
  expect(action.setBadgeText).toHaveBeenCalledWith({ text: '✓' });
  expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 5, color: '#16A34A' });
  expect(action.setBadgeText).not.toHaveBeenCalledWith({ tabId: 4, text: null });
  await owner.savePending(4, false);
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ tabId: 4, text: null });
  expect(action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ tabId: 4, color: '#16A34A' });
  await owner.nativeSave('clear');
  expect(action.setBadgeBackgroundColor).toHaveBeenCalledWith({ tabId: 4, color: organize.color });
});
it('resets pre-existing per-tab overrides at worker startup without erasing a new pending capture', async () => {
  const { action, owner } = setup();
  let resolve!: (tabs: chrome.tabs.Tab[]) => void;
  const removed = new Set<(id: number) => void>();
  const ready = owner.initialize({
    query: vi.fn(
      () =>
        new Promise(done => {
          resolve = done;
        }),
    ),
    onRemoved: { addListener: (listener: (id: number) => void) => removed.add(listener) },
  } as never);
  await owner.savePending(4, true);
  resolve([{ id: 4 }, { id: 5 }] as chrome.tabs.Tab[]);
  await ready;
  expect(action.setBadgeText).toHaveBeenCalledWith({ tabId: 5, text: null });
  expect(action.setBadgeText).not.toHaveBeenCalledWith({ tabId: 4, text: null });
  removed.forEach(listener => listener(4));
  action.setBadgeText.mockClear();
  await owner.organize(organize);
  expect(action.setBadgeText).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: 4 }));
  const count = action.setBadgeText.mock.calls.length;
  await owner.organize({ ...organize });
  expect(action.setBadgeText).toHaveBeenCalledTimes(count);
});
