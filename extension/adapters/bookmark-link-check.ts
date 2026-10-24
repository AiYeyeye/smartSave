import type { LinkResult } from '../domain/bookmark-check';

/** Skip non-web, credential-bearing and literal/local network addresses in unattended checks. */
export function checkableLink(raw: string): { url: string } | { reason: 'unsupported' | 'restricted' } {
  try {
    if (raw.length > 16_384 || /[\s\\\p{Cc}]/u.test(raw)) return { reason: 'unsupported' };
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return { reason: 'unsupported' };
    const host = url.hostname
      .toLowerCase()
      .replace(/\.$/u, '')
      .replace(/^\[|\]$/gu, '');
    const ipv4 = /^\d+\.\d+\.\d+\.\d+$/u.test(host) ? host.split('.').map(Number) : undefined;
    if (
      url.username ||
      url.password ||
      (!host.includes('.') && !host.includes(':')) ||
      /\.(localhost|local|internal|lan)$/u.test(host) ||
      (ipv4 &&
        (ipv4[0] === 0 ||
          ipv4[0] === 10 ||
          ipv4[0] === 127 ||
          ipv4[0]! >= 224 ||
          (ipv4[0] === 169 && ipv4[1] === 254) ||
          (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31) ||
          (ipv4[0] === 192 && ipv4[1] === 168) ||
          (ipv4[0] === 100 && ipv4[1]! >= 64 && ipv4[1]! <= 127))) ||
      (host.includes(':') && /^(::|fc|fd|fe[89ab])/iu.test(host))
    )
      return { reason: 'restricted' };
    url.hash = '';
    return { url: url.href };
  } catch {
    return { reason: 'unsupported' };
  }
}

/** HTTP availability only: never read page text, send cookies or follow an unverified redirect. */
export async function probeBookmarkLink(
  raw: string,
  signal: AbortSignal,
  options: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): Promise<LinkResult> {
  const now = options.now ?? Date.now;
  const parsed = checkableLink(raw);
  if ('reason' in parsed) return { status: 'skipped', reason: parsed.reason, at: now() };
  if (signal.aborted) throw Error('cancelled');
  const url = parsed.url;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const deadline = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 12_000);
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(Error('aborted'));
  });
  controller.signal.addEventListener('abort', rejectAbort, { once: true });
  const fetcher = options.fetch ?? fetch;
  async function request(method: 'HEAD' | 'GET') {
    const response = await Promise.race([
      fetcher(url, {
        method,
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'manual',
        cache: 'no-store',
      }),
      aborted,
    ]);
    // GET fallback consumes headers only, including when a server sends a large error page.
    void response.body?.cancel().catch(() => {});
    return response;
  }
  try {
    let response = await request('HEAD');
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      return { status: 'review', reason: 'redirect', at: now() };
    // Some sites reject HEAD or return a false 404. Verify with GET before calling a page broken.
    if (!response.ok) response = await request('GET');
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      return { status: 'review', reason: 'redirect', at: now() };
    const code = response.status >= 100 && response.status <= 599 ? response.status : undefined;
    return {
      status: response.ok ? 'ok' : code === 404 || code === 410 ? 'broken' : 'review',
      reason: code ? 'http' : 'network',
      ...(code ? { code } : {}),
      at: now(),
    };
  } catch {
    if (signal.aborted) throw Error('cancelled');
    return { status: 'review', reason: timedOut ? 'timeout' : 'network', at: now() };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}
