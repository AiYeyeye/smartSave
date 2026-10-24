// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { browserMessage, setBrowserLanguage, watchBrowserLanguage } from '../domain/browser-message';
import { LANGUAGE_KEY } from '../ui/preferences';
import { ActionBadgeOwner } from '../background/action-badge';
import { validateLocales } from '../scripts/validate-build.mjs';

afterEach(() => {
  setBrowserLanguage('zh-CN');
  vi.unstubAllGlobals();
});

it('defaults runtime labels to Chinese and follows the app choice independently of browser locale', () => {
  expect(browserMessage('organizeWorking', ['$2 {total}', '20'])).toBe(
    '智栏：已分析 $2 {total}/20 条书签，可关闭工作台',
  );
  const getMessage = vi.fn(() => 'Browser-owned translation');
  vi.stubGlobal('chrome', { i18n: { getMessage } });
  expect(browserMessage('brand')).toBe('智栏');
  setBrowserLanguage('en');
  expect(browserMessage('brand')).toBe('Zhilan');
  expect(browserMessage('organizeWorking', ['$2 {total}', '20'])).toContain('$2 {total}/20');
  expect(getMessage).not.toHaveBeenCalled();
});

it('keeps a newer language event when the initial storage read arrives late and detaches on disposal', async () => {
  let read!: (value: Record<string, unknown>) => void;
  let changed!: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
  const removeListener = vi.fn();
  vi.stubGlobal('chrome', { storage: {
    local: { get: () => new Promise<Record<string, unknown>>(resolve => { read = resolve; }) },
    onChanged: { addListener: (fn: typeof changed) => { changed = fn; }, removeListener },
  } });
  const stop = watchBrowserLanguage();
  changed({ [LANGUAGE_KEY]: { newValue: 'en' } }, 'local');
  read({ [LANGUAGE_KEY]: 'zh-CN' });
  await Promise.resolve();
  expect(browserMessage('brand')).toBe('Zhilan');
  changed({ [LANGUAGE_KEY]: { newValue: 'zh-CN' } }, 'sync');
  expect(browserMessage('brand')).toBe('Zhilan');
  stop();
  expect(removeListener).toHaveBeenCalledWith(changed);
});

it('refreshes an existing native toolbar state without resetting its task', async () => {
  const action = { setBadgeText: vi.fn(async () => {}), setTitle: vi.fn(async () => {}) };
  const owner = new ActionBadgeOwner(action);
  await owner.nativeSave('working');
  setBrowserLanguage('en');
  await vi.waitFor(() => expect(action.setTitle).toHaveBeenLastCalledWith({ title: browserMessage('nativeWorking') }));
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: '…' });
});

it('validates shipped catalogs and rejects missing messages, mismatched counts and missing locale files', async () => {
  const manifest = JSON.parse(await readFile('public/manifest.json', 'utf8'));
  await expect(validateLocales('public', manifest)).resolves.toBeUndefined();
  const root = await mkdtemp(join(tmpdir(), 'zhilan-browser-locale-'));
  for (const locale of ['zh_CN', 'en']) {
    await mkdir(join(root, '_locales', locale), { recursive: true });
    await writeFile(join(root, '_locales', locale, 'messages.json'), JSON.stringify({ count: { message: '$1/$2' } }));
  }
  await expect(validateLocales(root, { commands: { search: { description: '__MSG_missing__' } } })).rejects.toThrow(
    'Missing browser locale message',
  );
  await writeFile(join(root, '_locales/en/messages.json'), JSON.stringify({ count: { message: '$1' } }));
  await expect(validateLocales(root, {})).rejects.toThrow('substitutions differ');
  await writeFile(join(root, '_locales/en/messages.json'), '{}');
  await expect(validateLocales(root, {})).rejects.toThrow('keys differ');
  await expect(validateLocales(join(root, 'missing'), {})).rejects.toThrow('ENOENT');
});
