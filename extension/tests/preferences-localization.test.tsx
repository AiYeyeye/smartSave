import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelSettings } from '../options/ModelSettings';
import { modelSettingsNoticeText } from '../options/model-settings-text';
import { SettingsStore } from '../persistence/settings';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';
import { organizerTree } from './fixtures/organizer-tree';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('keeps privacy drafts and an explicit pending save intact across language switches', async () => {
  const data: Record<string, unknown> = {};
  const store = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async patch => {
        Object.assign(data, patch);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    run => run(),
  );
  await store.load();
  const tree = organizerTree();
  tree.nodes.find(node => node.ref.nativeId === 'left')!.title = '隐私 {id}';
  const connect = vi.fn(() => {
    let deliver: (value: unknown) => void = () => {};
    return {
      onMessage: {
        addListener: (listener: typeof deliver) => {
          deliver = listener;
        },
      },
      onDisconnect: { addListener: () => {} },
      postMessage: () => deliver({ version: 1, state: { status: 'ready', snapshot: tree } }),
      disconnect: vi.fn(),
    };
  });
  vi.stubGlobal('chrome', { runtime: { connect } });
  render(
    <LocaleProvider>
      <LanguagePicker />
      <ModelSettings store={store} fields="privacy" />
    </LocaleProvider>,
  );
  const folder = await screen.findByRole('checkbox', { name: '隐私 {id}（left）' });
  fireEvent.click(folder);
  fireEvent.click(screen.getByRole('checkbox', { name: '发送完整网址（含查询参数和片段）' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '正文辅助（仅主动收藏）' }));
  const before = await store.snapshot();
  const load = vi.spyOn(store, 'load');
  fireEvent.change(screen.getByRole('combobox', { name: '语言' }), { target: { value: 'en' } });
  expect(screen.getByRole('checkbox', { name: '隐私 {id}（left）' })).toBe(folder);
  expect(folder).toBeChecked();
  expect(
    screen.getByRole('checkbox', { name: 'Send full URLs (including query parameters and fragments)' }),
  ).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Use page content (explicit saves only)' })).toBeChecked();
  expect(await store.snapshot()).toEqual(before);
  expect(load).not.toHaveBeenCalled();
  expect(connect).toHaveBeenCalledTimes(1);
  const originalSave = store.savePrivacy.bind(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const save = vi.spyOn(store, 'savePrivacy').mockImplementation(async privacy => {
    await gate;
    return originalSave(privacy);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save privacy settings' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Language' }), { target: { value: 'zh-CN' } });
  expect(screen.getByRole('button', { name: '保存隐私设置' })).toBeDisabled();
  expect(save).toHaveBeenCalledTimes(1);
  await act(async () => release());
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('隐私设置已保存'));
  const saved = await store.snapshot();
  expect(saved.privacy).toMatchObject({ fullUrl: false, bodyEnabled: true });
  expect(saved.privacy.excludedFolders.map(ref => ref.nativeId)).toEqual(['left']);
  expect(saved.config).toBeUndefined();
});
it('translates settings notifications while retaining diagnostic tokens literally', () => {
  expect(modelSettingsNoticeText('en', { kind: 'listed', count: 4 })).toContain('fetched 4 models');
  expect(modelSettingsNoticeText('en', { kind: 'list-failed', reason: 'permission {reason}' })).toContain(
    'permission {reason}',
  );
  expect(modelSettingsNoticeText('en', { kind: 'test-failed', reason: '确认 {count}' })).toContain('确认 {count}');
});
