import { validateUrl } from './preflight';
export function canOpenUrl(url: string | undefined): url is string {
  if (url === undefined) return false;
  try {
    validateUrl(url);
    return true;
  } catch {
    return false;
  }
}
// Call only from explicit user activation. Never expose unchecked href/drag URL data.
export function openUrl(
  url: string,
  open: (url: string, target: string, features: string) => unknown = window.open.bind(window),
): boolean {
  if (!canOpenUrl(url)) return false;
  open(url, '_blank', 'noopener,noreferrer');
  return true;
}

export type BookmarkOpenTarget = 'tab' | 'window' | 'incognito';

// Explicit menu actions must honor the requested target, especially private browsing.
export async function openBookmarkUrl(url: string, target: BookmarkOpenTarget): Promise<void> {
  if (!canOpenUrl(url)) throw new Error('此协议不支持打开。');
  try {
    if (target === 'tab') await chrome.tabs.create({ url, active: true });
    else await chrome.windows.create({ url, type: 'normal', focused: true, incognito: target === 'incognito' });
  } catch {
    throw new Error(
      target === 'incognito'
        ? '无法打开无痕窗口，请检查浏览器的无痕设置或管理策略。'
        : target === 'window'
          ? '无法打开新窗口，请稍后重试。'
          : '无法打开新标签页，请稍后重试。',
    );
  }
}
