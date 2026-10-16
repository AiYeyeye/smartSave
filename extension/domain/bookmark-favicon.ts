export function bookmarkFaviconUrl(
  pageUrl: string | undefined,
  runtime?: Pick<typeof chrome.runtime, 'getURL'>,
): string | undefined {
  if (!pageUrl) return;
  try {
    const parsed = new URL(pageUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  } catch {
    return;
  }
  const owner = runtime ?? (typeof chrome !== 'undefined' ? chrome.runtime : undefined);
  if (!owner?.getURL) return;
  const url = new URL(owner.getURL('/_favicon/'));
  url.searchParams.set('pageUrl', pageUrl);
  // Shown at 16 CSS px; 32 keeps it sharp on high-DPI screens.
  url.searchParams.set('size', '32');
  return url.href;
}
