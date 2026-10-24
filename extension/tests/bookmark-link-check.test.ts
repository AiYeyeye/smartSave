import { afterEach, expect, it, vi } from 'vitest';
import { checkableLink, createBookmarkLinkProbe, probeBookmarkLink } from '../adapters/bookmark-link-check';
import { linkCategory } from '../domain/bookmark-check';
afterEach(() => vi.unstubAllGlobals());

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
  [405, 404, 'broken', 3],
  [404, 410, 'broken', 3],
  [403, 403, 'review', 2],
  [429, 429, 'review', 2],
  [500, 503, 'review', 2],
  [302, 200, 'review', 1],
])('checks %s then %s without reading response text', async (head, get, status, calls) => {
  const responses = [
    new Response('head', { status: head as number }),
    new Response('body', { status: get as number }),
    new Response('retry', { status: get as number }),
  ];
  const texts = responses.map(r => vi.spyOn(r, 'text'));
  const cancels = responses.map(r => vi.spyOn(r.body!, 'cancel'));
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(responses[0]!)
    .mockResolvedValueOnce(responses[1]!)
    .mockResolvedValueOnce(responses[2]!)
    .mockImplementation(async () => new Response(null, { status: 200 }));
  expect(
    await probeBookmarkLink('https://example.test/a?token=1#frag', new AbortController().signal, {
      fetch: fetcher,
      now: () => 7,
    }),
  ).toMatchObject({ status, at: 7 });
  expect(fetcher).toHaveBeenCalledTimes((calls as number) + (status === 'ok' ? 0 : 1));
  expect(fetcher).toHaveBeenNthCalledWith(
    1,
    'https://example.test/a?token=1',
    expect.objectContaining({ method: 'HEAD', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer' }),
  );
  if ((calls as number) >= 2)
    expect(fetcher).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ method: 'GET' }));
  expect(cancels[0]).toHaveBeenCalled();
  for (const text of texts) expect(text).not.toHaveBeenCalled();
});
it.each([401, 403, 404, 410, 429, 503, 302])(
  'keeps responding sites out of the unreachable category for page HTTP %s',
  async code => {
    const fetcher = vi.fn<typeof fetch>(
      async input => new Response(null, { status: String(input).endsWith('/') ? 200 : code }),
    );
    const result = await probeBookmarkLink(
      'https://example.test/article?q=private#fragment',
      new AbortController().signal,
      { fetch: fetcher },
    );
    expect(result.site).toMatchObject({ status: 'responding', code: 200 });
    expect(linkCategory(result)).not.toBe('site');
    expect(fetcher).toHaveBeenCalledWith(
      'https://example.test/',
      expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'manual' }),
    );
  },
);

it('checks both protocols twice before marking a site unreachable, without guessing other hosts', async () => {
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(Error('connection failed'));
  const result = await probeBookmarkLink('https://gone.test:8443/private?q=secret', new AbortController().signal, {
    fetch: fetcher,
  });
  expect(result.site).toMatchObject({ status: 'unreachable', reason: 'network' });
  expect(linkCategory(result)).toBe('site');
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    'https://gone.test:8443/private?q=secret',
    'https://gone.test:8443/',
    'http://gone.test:8443/',
    'https://gone.test:8443/',
    'http://gone.test:8443/',
  ]);
});

it('an alternate protocol response or a root redirect means the site still responds', async () => {
  const fetcher = vi.fn<typeof fetch>(async input => {
    if (String(input) === 'http://moved.test/')
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    throw Error('failed');
  });
  const result = await probeBookmarkLink('https://moved.test/article', new AbortController().signal, {
    fetch: fetcher,
  });
  expect(result.site).toMatchObject({ status: 'responding', reason: 'redirect' });
  expect(linkCategory(result)).toBe('temporary');
  expect(fetcher.mock.calls.every(([url]) => String(url).includes('moved.test'))).toBe(true);
});

it('does not lose an earlier HTTP response when a later page retry and homepage fail', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockRejectedValue(Error('network'));
  const result = await probeBookmarkLink('https://example.test/page', new AbortController().signal, { fetch: fetcher });
  expect(result).toMatchObject({ reason: 'network', site: { status: 'responding', code: 404 } });
  expect(linkCategory(result)).toBe('temporary');
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('reuses website entry checks per scan, but does not treat manual confirmation as network evidence', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async input => new Response(null, { status: String(input).endsWith('/') ? 200 : 404 }),
  );
  vi.stubGlobal('fetch', fetcher);
  const probe = createBookmarkLinkProbe([
    { url: 'https://example.test/manual', result: { status: 'ok', reason: 'manual', at: 1 } },
  ]);
  for (const path of ['a', 'b'])
    expect((await probe(`https://example.test/${path}`, new AbortController().signal)).site?.status).toBe('responding');
  expect(fetcher.mock.calls.filter(([url]) => url === 'https://example.test/')).toHaveLength(1);
});

it('never reports a permanently gone site when the browser itself is offline', async () => {
  vi.stubGlobal('navigator', { onLine: false });
  const fetcher = vi.fn<typeof fetch>().mockRejectedValue(Error('offline'));
  const result = await probeBookmarkLink('https://example.test/', new AbortController().signal, { fetch: fetcher });
  expect(linkCategory(result)).toBe('unknown');
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not keep a transient GET 404 verdict when the repeat request succeeds', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 405 }))
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  expect(
    await probeBookmarkLink('https://example.test/', new AbortController().signal, { fetch: fetcher }),
  ).toMatchObject({ status: 'ok', code: 200 });
  expect(fetcher).toHaveBeenNthCalledWith(
    2,
    expect.any(String),
    expect.objectContaining({ headers: { Accept: expect.stringContaining('text/html') } }),
  );
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
