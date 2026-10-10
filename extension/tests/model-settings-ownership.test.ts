import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { ModelSettings } from '../options/ModelSettings';
import { SettingsStore } from '../persistence/settings';
afterEach(() => vi.unstubAllGlobals());
it('unmounting settings preserves the page-owned session credential and subscribers', async () => {
  const data: Record<string, unknown> = {};
  const store = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async value => {
        Object.assign(data, value);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    run => run(),
  );
  await store.load();
  await store.save(
    { adapter: 'openai-compatible', baseUrl: 'https://example.com', model: 'synthetic', timeoutMs: 1000 },
    { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    'session-only',
    false,
  );
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  vi.stubGlobal('chrome', {
    storage: {
      onChanged: {
        addListener: (listener: (changes: Record<string, unknown>, area: string) => void) => listeners.add(listener),
        removeListener: (listener: (changes: Record<string, unknown>, area: string) => void) =>
          listeners.delete(listener),
      },
    },
  });
  const invalidated = vi.fn();
  store.subscribe(invalidated);
  const dispose = vi.spyOn(store, 'dispose');
  const view = render(createElement(ModelSettings, { store }));
  await waitFor(() => expect(view.getByLabelText('API Key')).toHaveValue('session-only'));
  view.unmount();
  expect(dispose).not.toHaveBeenCalled();
  expect((await store.snapshot()).key).toBe('session-only');
  expect(JSON.stringify(data)).not.toContain('session-only');
  expect(listeners.size).toBe(1);
  for (const listener of listeners) listener({ siteRules: {} }, 'local');
  expect(invalidated).not.toHaveBeenCalled();
  for (const listener of listeners) listener({ modelSecurity: {} }, 'local');
  expect(invalidated).toHaveBeenCalledTimes(1);
  store.dispose();
  expect(listeners.size).toBe(0);
  expect((await store.snapshot()).key).toBe('');
});
it('privacy drill-in persists without a model endpoint and does not invent a route', async () => {
  const data: Record<string, unknown> = {};
  const store = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async value => {
        Object.assign(data, value);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    run => run(),
  );
  await store.load();
  const user = userEvent.setup();
  const view = render(createElement(ModelSettings, { store, fields: 'privacy' }));
  await user.click(view.getByRole('checkbox', { name: /发送完整网址/ }));
  await user.click(view.getByRole('button', { name: '保存隐私设置' }));
  await waitFor(async () => expect((await store.snapshot()).privacy.fullUrl).toBe(false));
  expect((await store.snapshot()).config).toBeUndefined();
  expect(JSON.stringify(data.modelSecurity)).not.toContain('openai');
  view.unmount();
});
it('preset changes are draft-only, clear credentials, and retain custom protocol paths', async () => {
  const user = userEvent.setup();
  const view = render(createElement(ModelSettings, { fields: 'model' }));
  await user.type(view.getByLabelText('API Key'), 'old-service-key');
  await user.click(view.getByRole('checkbox', { name: /明确记住/ }));
  await user.selectOptions(view.getByLabelText('模型服务'), 'deepseek');
  expect(view.getByLabelText('API Key')).toHaveValue('');
  expect(view.getByRole('checkbox', { name: /明确记住/ })).not.toBeChecked();
  // Advanced fields remain accessible and filled by the vendor preset.
  expect(view.getByLabelText('服务基础地址')).toHaveValue('https://api.deepseek.com');
  expect(view.getByLabelText('模型名称')).toHaveValue('deepseek-chat');
  await user.selectOptions(view.getByLabelText('模型'), '');
  await user.clear(view.getByLabelText('模型名称'));
  await user.type(view.getByLabelText('模型名称'), 'custom-id');
  expect(view.getByLabelText('模型名称')).toHaveValue('custom-id');
  expect(view.getByRole('status')).toHaveTextContent('尚未保存');
  expect(view.getByRole('button', { name: '授权并获取模型' })).toBeEnabled();
  view.unmount();
});

it('restores saved presetId into the vendor dropdown', async () => {
  const data: Record<string, unknown> = {};
  const store = new SettingsStore(
    {
      get: async key => ({ [key]: data[key] }),
      set: async value => {
        Object.assign(data, value);
      },
      remove: async key => {
        delete data[key];
      },
      setAccessLevel: async () => {},
    },
    run => run(),
  );
  await store.load();
  await store.save(
    { adapter: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', timeoutMs: 60000 },
    { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
    '',
    false,
    'claude',
  );
  const view = render(createElement(ModelSettings, { store, fields: 'model' }));
  await waitFor(() => expect(view.getByLabelText('模型服务')).toHaveValue('claude'));
  expect(view.getByLabelText('接口协议')).toHaveValue('anthropic');
  expect(view.getByLabelText('服务基础地址')).toHaveValue('https://api.anthropic.com');
  view.unmount();
});
