// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { browserMessage } from '../domain/browser-message';
import { validateLocales } from '../scripts/validate-build.mjs';

afterEach(() => vi.unstubAllGlobals());

it('uses the browser message API and leaves replacements literal, with a Chinese fallback outside Chrome', () => {
  expect(browserMessage('organizeWorking', ['$2 {total}', '20'])).toBe(
    '智栏：已分析 $2 {total}/20 条书签，可关闭工作台',
  );
  const getMessage = vi.fn(() => 'Browser-owned translation');
  vi.stubGlobal('chrome', { i18n: { getMessage } });
  expect(browserMessage('organizeWorking', ['3', '20'])).toBe('Browser-owned translation');
  expect(getMessage).toHaveBeenCalledWith('organizeWorking', ['3', '20']);
  getMessage.mockReturnValue('');
  expect(browserMessage('brand')).toBe('智栏');
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
