import { expect, it, vi } from 'vitest';
import { OPENROUTER_KEYS_URL, signInWithOpenRouter } from '../adapters/openrouter-oauth';

function deps(responseUrl: (authUrl: string) => string | undefined, keyResponse = { key: 'sk-or-user' }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(keyResponse), { status: 200 }));
  const launch = vi.fn(async ({ url }: { url: string }) => responseUrl(url));
  return {
    fetchMock,
    launch,
    deps: {
      permissions: { request: vi.fn(async () => true) } as unknown as Pick<typeof chrome.permissions, 'request'>,
      identity: {
        getRedirectURL: (path?: string) => `https://ext.chromiumapp.org/${path ?? ''}`,
        launchWebAuthFlow: launch,
      } as unknown as Pick<typeof chrome.identity, 'launchWebAuthFlow' | 'getRedirectURL'>,
      fetch: fetchMock as unknown as typeof fetch,
    },
  };
}

it('runs PKCE: S256 challenge in the auth URL, verifier in the key exchange', async () => {
  const h = deps(authUrl => {
    const state = new URL(authUrl).searchParams.get('state');
    return `https://ext.chromiumapp.org/openrouter?code=abc&state=${state}`;
  });
  await expect(signInWithOpenRouter(h.deps)).resolves.toEqual({ status: 'completed', key: 'sk-or-user' });
  const authUrl = new URL(h.launch.mock.calls[0]![0].url);
  expect(authUrl.origin + authUrl.pathname).toBe('https://openrouter.ai/auth');
  expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authUrl.searchParams.get('callback_url')).toBe('https://ext.chromiumapp.org/openrouter');
  const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(OPENROUTER_KEYS_URL);
  const body = JSON.parse(String(init.body));
  expect(body).toMatchObject({ code: 'abc', code_challenge_method: 'S256' });
  // Verifier must hash to the challenge that was sent.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier)));
  const expected = btoa(String.fromCharCode(...digest))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  expect(authUrl.searchParams.get('code_challenge')).toBe(expected);
});

it('rejects a callback whose state does not match and never exchanges the code', async () => {
  const h = deps(() => 'https://ext.chromiumapp.org/openrouter?code=abc&state=forged');
  await expect(signInWithOpenRouter(h.deps)).resolves.toEqual({ status: 'failed', reason: 'state-mismatch' });
  expect(h.fetchMock).not.toHaveBeenCalled();
});

it('reports a denied permission without opening the auth window', async () => {
  const h = deps(() => undefined);
  h.deps.permissions = { request: vi.fn(async () => false) } as unknown as Pick<typeof chrome.permissions, 'request'>;
  await expect(signInWithOpenRouter(h.deps)).resolves.toEqual({ status: 'failed', reason: 'permission-denied' });
  expect(h.launch).not.toHaveBeenCalled();
});
