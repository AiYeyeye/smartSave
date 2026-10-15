import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StrictMode, useEffect, useState } from 'react';
import { createPreferenceSync, startPreferenceSync, SYNC_PREFERENCE_KEYS as keys } from '../ui/preferences-sync';
import { APPEARANCE_KEY, LANGUAGE_KEY } from '../ui/preferences';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';
import { ThemePicker, ThemeProvider } from '../ui/ThemeProvider';

type Listener = Parameters<typeof chrome.storage.onChanged.addListener>[0];
const envelope = (value: string) => ({ version: 1, value });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => (resolve = done));
  return { promise, resolve };
}
function fixture(initial: Record<string, unknown> = {}) {
  const listeners = new Set<Listener>();
  const get = vi.fn<(keys: string[]) => Promise<Record<string, unknown>>>().mockResolvedValue(initial);
  const set = vi.fn<(values: Record<string, unknown>) => Promise<void>>().mockResolvedValue(undefined);
  const events = {
    addListener: (listener: Listener) => {
      listeners.add(listener);
    },
    removeListener: (listener: Listener) => {
      listeners.delete(listener);
    },
  };
  return {
    area: { get, set },
    events,
    listeners,
    change: (changes: Record<string, chrome.storage.StorageChange>, area: chrome.storage.AreaName = 'sync') => {
      for (const listener of listeners) listener(changes, area);
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it('reads only three allowlisted keys, migrates explicit choices and never uploads unrelated local data/defaults', async () => {
  localStorage.setItem(
    'model.settings',
    JSON.stringify({ key: 'secret', url: 'https://private.example', folderId: '7' }),
  );
  const f = fixture();
  const empty = createPreferenceSync(f.area, f.events);
  await Promise.resolve();
  expect(f.area.get).toHaveBeenCalledWith(Object.values(keys));
  expect(f.area.set).not.toHaveBeenCalled();
  empty.dispose();
  localStorage.setItem(LANGUAGE_KEY, 'en');
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ mode: 'dark', accent: 'teal', secret: 'secret' }));
  const owner = createPreferenceSync(f.area, f.events);
  await Promise.resolve();
  expect(f.area.set.mock.calls.map(call => call[0])).toEqual([
    { [keys.language]: envelope('en') },
    { [keys.mode]: envelope('dark') },
    { [keys.accent]: envelope('teal') },
  ]);
  owner.dispose();
  expect(f.listeners.size).toBe(0);
});

it('applies remote fields independently without echoing them and rejects invalid, future and sensitive payloads', async () => {
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ mode: 'light', accent: 'rose' }));
  const f = fixture({
    [keys.mode]: envelope('dark'),
    [keys.accent]: envelope('blue'),
    [keys.language]: envelope('en'),
  });
  const owner = createPreferenceSync(f.area, f.events);
  await Promise.resolve();
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual({ mode: 'dark', accent: 'blue' });
  f.change({ [keys.accent]: { newValue: envelope('teal') } });
  expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual({ mode: 'dark', accent: 'teal' });
  for (const value of [
    envelope('https://private.example'),
    { version: 2, value: 'zh-CN' },
    { ...envelope('zh-CN'), key: 'secret' },
    null,
    undefined,
  ]) {
    f.change({ [keys.language]: { newValue: value } });
  }
  f.change({ [keys.language]: { newValue: envelope('zh-CN') } }, 'local');
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  expect(f.area.set).not.toHaveBeenCalled();
  owner.dispose();
});

it('late startup snapshots cannot override local clicks or newer sync events', async () => {
  const f = fixture();
  const read = deferred<Record<string, unknown>>();
  f.area.get.mockReturnValue(read.promise);
  const owner = createPreferenceSync(f.area, f.events);
  localStorage.setItem(LANGUAGE_KEY, 'en');
  owner.publish('language', 'en');
  f.change({ [keys.mode]: { newValue: envelope('dark') } });
  read.resolve({ [keys.language]: envelope('zh-CN'), [keys.mode]: envelope('light') });
  await Promise.resolve();
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!).mode).toBe('dark');
  owner.dispose();
});

it('applying a remote mode does not persist or upload an unchosen accent default, including after reopening', async () => {
  const f = fixture({ [keys.mode]: envelope('dark') });
  const owner = createPreferenceSync(f.area, f.events);
  await Promise.resolve();
  expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY)!)).toEqual({ mode: 'dark' });
  expect(f.area.set).not.toHaveBeenCalled();
  owner.dispose();
  const reopened = createPreferenceSync(f.area, f.events);
  await Promise.resolve();
  expect(f.area.set).not.toHaveBeenCalled();
  reopened.dispose();
});

it('serializes rapid writes per field and retains local operation after sync quota/read errors without retry loops', async () => {
  const f = fixture();
  f.area.get.mockRejectedValue(new Error('unavailable'));
  const write = deferred<void>();
  f.area.set.mockReturnValueOnce(write.promise).mockRejectedValue(new Error('quota'));
  const owner = createPreferenceSync(f.area, f.events);
  localStorage.setItem(LANGUAGE_KEY, 'en');
  owner.publish('language', 'zh-CN');
  owner.publish('language', 'en');
  f.change({ [keys.language]: { newValue: envelope('zh-CN') } });
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  expect(f.area.set).toHaveBeenCalledTimes(1);
  write.resolve();
  await waitFor(() => expect(f.area.set).toHaveBeenCalledTimes(2));
  expect(f.area.set).toHaveBeenLastCalledWith({ [keys.language]: envelope('en') });
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  owner.dispose();
});

it('disposed initialization cannot overwrite a remounted owner or migrate stale values', async () => {
  const f = fixture();
  const read = deferred<Record<string, unknown>>();
  f.area.get.mockReturnValue(read.promise);
  const owner = createPreferenceSync(f.area, f.events);
  owner.dispose();
  localStorage.setItem(LANGUAGE_KEY, 'en');
  read.resolve({ [keys.language]: envelope('zh-CN') });
  await Promise.resolve();
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  expect(f.area.set).not.toHaveBeenCalled();
});

it('actual providers retain draft DOM through sync updates and strict-mode clicks write once', async () => {
  const f = fixture();
  vi.stubGlobal('chrome', { storage: { sync: f.area, onChanged: f.events } });
  function Harness() {
    useEffect(startPreferenceSync, []);
    const [draft, setDraft] = useState('');
    return (
      <LocaleProvider>
        <ThemeProvider>
          <LanguagePicker />
          <ThemePicker />
          <input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
        </ThemeProvider>
      </LocaleProvider>
    );
  }
  const view = render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  const input = screen.getByLabelText('draft');
  fireEvent.change(input, { target: { value: '未保存的标题' } });
  act(() => f.change({ [keys.language]: { newValue: envelope('en') }, [keys.mode]: { newValue: envelope('dark') } }));
  expect(screen.getByLabelText('draft')).toBe(input);
  expect(input).toHaveValue('未保存的标题');
  expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  expect(f.area.set).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
  await waitFor(() => expect(f.area.set).toHaveBeenCalledTimes(1));
  expect(f.area.set).toHaveBeenLastCalledWith({ [keys.mode]: envelope('light') });
  fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'zh-CN' } });
  expect(f.area.set).toHaveBeenLastCalledWith({ [keys.language]: envelope('zh-CN') });
  view.unmount();
  expect(f.listeners.size).toBe(0);
});
