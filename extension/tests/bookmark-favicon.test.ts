import { createElement } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { bookmarkFaviconUrl } from '../domain/bookmark-favicon';
import { BookmarkFavicon } from '../ui/BookmarkFavicon';

it('uses the privacy-safe browser favicon URL for http(s) only', () => {
  const getURL = vi.fn((path: string) => `chrome-extension://ext${path}`);
  const src = bookmarkFaviconUrl('https://store.steampowered.com/app/1', { getURL });
  expect(src).toBe('chrome-extension://ext/_favicon/?pageUrl=https%3A%2F%2Fstore.steampowered.com%2Fapp%2F1&size=16');
  expect(bookmarkFaviconUrl('javascript:alert(1)', { getURL })).toBeUndefined();
  expect(bookmarkFaviconUrl('https://zhihu.com/', { getURL: undefined as never })).toBeUndefined();
  expect(src).not.toMatch(/google|gstatic|favicon\.ico/i);
});

it('falls back to the local icon when the favicon image errors', () => {
  const getURL = (path: string) => `chrome-extension://ext${path}`;
  vi.stubGlobal('chrome', { runtime: { getURL } });
  const { container } = render(createElement(BookmarkFavicon, { url: 'https://zhihu.com/' }));
  const image = container.querySelector('img.bookmark-favicon');
  expect(image).toHaveAttribute('src', expect.stringContaining('/_favicon/'));
  expect(image).toHaveAttribute('alt', '');
  fireEvent.error(image!);
  expect(container.querySelector('img.bookmark-favicon')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
  vi.unstubAllGlobals();
});
