import { afterEach, expect, it, vi } from 'vitest';
import { openBookmarkUrl } from '../domain/open-url';

afterEach(() => vi.unstubAllGlobals());

it('honors each explicit target without interpreting an undefined window result as failure', async () => {
  const tab = vi.fn(async () => ({}));
  const window = vi.fn(async () => undefined);
  vi.stubGlobal('chrome', { tabs: { create: tab }, windows: { create: window } });
  const url = 'https://example.test/path?q=1';
  await openBookmarkUrl(url, 'tab');
  expect(tab).toHaveBeenCalledExactlyOnceWith({ url, active: true });
  await openBookmarkUrl(url, 'window');
  expect(window).toHaveBeenLastCalledWith({ url, type: 'normal', focused: true, incognito: false });
  await openBookmarkUrl(url, 'incognito');
  expect(window).toHaveBeenLastCalledWith({ url, type: 'normal', focused: true, incognito: true });
  expect(window).toHaveBeenCalledTimes(2);
  expect(tab).toHaveBeenCalledTimes(1);
});

it('rejects unsafe URLs before calling any browser API', async () => {
  const create = vi.fn();
  vi.stubGlobal('chrome', { tabs: { create }, windows: { create } });
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///private', 'invalid']) {
    for (const target of ['tab', 'window', 'incognito'] as const)
      await expect(openBookmarkUrl(url, target)).rejects.toThrow('此协议不支持打开');
  }
  expect(create).not.toHaveBeenCalled();
});

it('surfaces browser failure without opening a different target or leaking browser error data', async () => {
  const tab = vi.fn();
  const window = vi.fn(async () => {
    throw new Error('private diagnostic');
  });
  vi.stubGlobal('chrome', { tabs: { create: tab }, windows: { create: window } });
  await expect(openBookmarkUrl('https://example.test', 'incognito')).rejects.toThrow('无法打开无痕窗口');
  expect(window).toHaveBeenCalledTimes(1);
  expect(tab).not.toHaveBeenCalled();
});
