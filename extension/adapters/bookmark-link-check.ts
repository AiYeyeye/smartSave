import { siteResponse, type SiteResult, type LinkResult } from '../domain/bookmark-check';

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

type ProbeOptions = { fetch?: typeof fetch; now?: () => number; timeoutMs?: number };
type HeadersResult = { reason: SiteResult['reason']; code?: number; ok: boolean };

/** Read headers only. Each request has its own deadline so a failed page cannot exhaust the site check. */
async function headers(
  url: string,
  method: 'HEAD' | 'GET',
  signal: AbortSignal,
  options: ProbeOptions,
): Promise<HeadersResult> {
  if (signal.aborted) throw Error('cancelled');
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
  try {
    const response = await Promise.race([
      (options.fetch ?? fetch)(url, {
        method,
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'manual',
        cache: 'no-store',
        headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
      }),
      aborted,
    ]);
    void response.body?.cancel().catch(() => {});
    if (signal.aborted) throw Error('cancelled');
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400))
      return { ok: false, reason: 'redirect' };
    const code = response.status >= 100 && response.status <= 599 ? response.status : undefined;
    return { ok: response.ok, reason: code ? 'http' : 'network', ...(code ? { code } : {}) };
  } catch {
    if (signal.aborted) throw Error('cancelled');
    return { ok: false, reason: timedOut ? 'timeout' : 'network' };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', rejectAbort);
  }
}

async function probeSite(
  url: string,
  signal: AbortSignal,
  options: ProbeOptions,
  observed?: SiteResult,
): Promise<SiteResult> {
  const root = new URL('/', url);
  const alternative = new URL(root);
  alternative.protocol = root.protocol === 'https:' ? 'http:' : 'https:';
  // Keep custom ports; never guess another hostname or follow an unverified redirect.
  const roots = [root.href, alternative.href];
  let result: HeadersResult = { ok: false, reason: 'network' };
  for (let round = 0; round < 2; round++) {
    for (const target of roots) {
      result = await headers(target, 'GET', signal, {
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 12_000, 6000),
      });
      if (result.reason === 'http' || result.reason === 'redirect')
        return {
          status: 'responding',
          reason: result.reason,
          ...(result.code ? { code: result.code } : {}),
          at: (options.now ?? Date.now)(),
        };
      if (observed) return observed;
    }
  }
  return { status: 'unreachable', reason: result.reason, at: (options.now ?? Date.now)() };
}

type SiteCache = Map<string, Promise<SiteResult>>;
/** HTTP availability only: no page text, cookies, DNS services or redirect following. */
export async function probeBookmarkLink(
  raw: string,
  signal: AbortSignal,
  options: ProbeOptions & { sites?: SiteCache } = {},
): Promise<LinkResult> {
  const now = options.now ?? Date.now;
  const parsed = checkableLink(raw);
  if ('reason' in parsed) return { status: 'skipped', reason: parsed.reason, at: now() };
  if (signal.aborted) throw Error('cancelled');
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return { status: 'review', reason: 'network', at: now() };
  const url = parsed.url,
    origin = new URL(url).origin;
  let response = await headers(url, 'HEAD', signal, options);
  const attempts = [response];
  if (!response.ok && response.reason === 'http') {
    response = await headers(url, 'GET', signal, options);
    attempts.push(response);
  }
  if (response.code === 404 || response.code === 410) {
    response = await headers(url, 'GET', signal, options);
    attempts.push(response);
  }
  const result: LinkResult = {
    status: response.ok ? 'ok' : response.code === 404 || response.code === 410 ? 'broken' : 'review',
    reason: response.reason,
    ...(response.code ? { code: response.code } : {}),
    at: now(),
  };
  const observedResponse = attempts.find(response => response.reason === 'http' || response.reason === 'redirect');
  const observed: SiteResult | undefined = observedResponse && {
    status: 'responding',
    reason: observedResponse.reason,
    ...(observedResponse.code ? { code: observedResponse.code } : {}),
    at: now(),
  };
  if (result.status === 'ok') {
    if (observed) options.sites?.set(origin, Promise.resolve(observed));
    return result;
  }
  let check = options.sites?.get(origin);
  if (!check) {
    // A bookmark at the root already checked the website entry; any HTTP response is enough.
    check =
      observed && url === new URL('/', url).href
        ? Promise.resolve(observed)
        : probeSite(url, signal, options, observed);
    options.sites?.set(origin, check);
  }
  let site = await check;
  if (signal.aborted) throw Error('cancelled');
  if (site.status === 'unreachable' && typeof navigator !== 'undefined' && navigator.onLine === false) return result;
  // A page can respond even when its homepage is restricted or temporarily unavailable.
  if (site.status === 'unreachable' && observed) {
    site = observed;
    options.sites?.set(origin, Promise.resolve(site));
  }
  return { ...result, site };
}

/** Cache only within one scan/resume, including durable evidence from completed items. */
export function createBookmarkLinkProbe(items: { url: string; result?: LinkResult }[] = []) {
  const sites: SiteCache = new Map();
  const seeds = new Map<string, SiteResult>();
  for (const item of items) {
    if (!item.result || item.result.reason === 'manual' || item.result.reason === 'changed') continue;
    const site = siteResponse(item.result) ?? item.result.site;
    try {
      const origin = new URL(item.url).origin;
      if (site && seeds.get(origin)?.status !== 'responding') seeds.set(origin, site);
    } catch {
      /* Unsupported legacy URL. */
    }
  }
  for (const [origin, site] of seeds) sites.set(origin, Promise.resolve(site));
  return (url: string, signal: AbortSignal) => probeBookmarkLink(url, signal, { sites });
}
