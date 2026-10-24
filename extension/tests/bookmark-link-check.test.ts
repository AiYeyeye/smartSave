import { expect, it, vi } from 'vitest';
import { checkableLink, probeBookmarkLink } from '../adapters/bookmark-link-check';

it.each(['file:///a', 'javascript:alert(1)', 'not a url', 'https://a.test/ bad'])('skips unsupported URL %s', url => {
  expect(checkableLink(url)).toEqual({ reason: 'unsupported' });
});
it.each([
  'http://localhost/a',
  'http://127.1/',
  'http://0x7f000001',
  'http://10.1.1.1/',
  'http://192.168.1.1',
  'http://172.16.0.1',
  'http://[::1]/',
  'http://[::ffff:127.0.0.1]/',
  'http://[fd00::1]/',
  'http://printer.local',
  'https://user:pass@example.test/',
])('skips local or credential URL %s', url => {
  expect(checkableLink(url)).toEqual({ reason: 'restricted' });
});
it.each([
  [200, 200, 'ok', 1],
  [404, 200, 'ok', 2],
  [405, 404, 'broken', 2],
  [404, 410, 'broken', 2],
  [403, 403, 'review', 2],
  [429, 429, 'review', 2],
  [500, 503, 'review', 2],
  [302, 200, 'review', 1],
])('checks %s then %s without reading response text', async (head, get, status, calls) => {
  const responses = [new Response('head', { status: head as number }), new Response('body', { status: get as number })];
  const texts = responses.map(r => vi.spyOn(r, 'text'));
  const cancels = responses.map(r => vi.spyOn(r.body!, 'cancel'));
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(responses[0]!).mockResolvedValueOnce(responses[1]!);
  expect(
    await probeBookmarkLink('https://example.test/a?token=1#frag', new AbortController().signal, {
      fetch: fetcher,
      now: () => 7,
    }),
  ).toMatchObject({ status, at: 7 });
  expect(fetcher).toHaveBeenCalledTimes(calls as number);
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    'https://example.test/a?token=1',
    expect.objectContaining({ method: 'HEAD', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer' }),
  );
  if (calls === 2)
    expect(fetcher).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ method: 'GET' }));
  expect(cancels[0]).toHaveBeenCalled();
  for (const text of texts) expect(text).not.toHaveBeenCalled();
});
it('marks network/timeouts uncertain, while user cancellation rejects without a false verdict', async () => {
  const signal = new AbortController();
  expect(
    await probeBookmarkLink('https://example.test', signal.signal, { fetch: vi.fn().mockRejectedValue(Error('dns')) }),
  ).toMatchObject({ status: 'review', reason: 'network' });
  const hanging = vi.fn<typeof fetch>(() => new Promise(() => {}));
  expect(
    await probeBookmarkLink('https://example.test', signal.signal, { fetch: hanging, timeoutMs: 5 }),
  ).toMatchObject({ status: 'review', reason: 'timeout' });
  const result = probeBookmarkLink('https://example.test', signal.signal, { fetch: hanging });
  signal.abort();
  await expect(result).rejects.toThrow('cancelled');
});
