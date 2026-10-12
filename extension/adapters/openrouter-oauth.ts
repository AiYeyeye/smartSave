import { traceModel } from '../domain/debug-log';

/**
 * OpenRouter OAuth PKCE sign-in (https://openrouter.ai/docs/use-cases/oauth-pkce).
 * The user signs in on openrouter.ai and approves a key for this extension; we receive a
 * user-controlled API key and never see their password. Uses chrome.identity.launchWebAuthFlow,
 * whose `identity` permission is optional and requested on click.
 */
export const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
export const OPENROUTER_KEYS_URL = 'https://openrouter.ai/api/v1/auth/keys';
const ORIGINS = ['https://openrouter.ai/*'];

export type OAuthResult = { status: 'completed'; key: string } | { status: 'failed'; reason: OAuthFailure };
export type OAuthFailure =
  'unavailable' | 'permission-denied' | 'cancelled' | 'no-code' | 'exchange-failed' | 'state-mismatch';

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

export function openRouterAuthUrl(callbackUrl: string, challenge: string, state: string) {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('key_label', '智栏 书签助手');
  url.searchParams.set('state', state);
  return url.toString();
}

type IdentityApi = Pick<typeof chrome.identity, 'launchWebAuthFlow' | 'getRedirectURL'>;
type PermissionsApi = Pick<typeof chrome.permissions, 'request'>;

/** Must be called from a user gesture: the first await is the permission request. */
export async function signInWithOpenRouter(
  deps: { identity?: IdentityApi; permissions?: PermissionsApi; fetch?: typeof fetch } = {},
): Promise<OAuthResult> {
  const permissions = deps.permissions ?? (typeof chrome !== 'undefined' ? chrome.permissions : undefined);
  if (!permissions?.request) return { status: 'failed', reason: 'unavailable' };
  const granted = await permissions.request({ permissions: ['identity'], origins: ORIGINS }).catch(() => false);
  if (!granted) return { status: 'failed', reason: 'permission-denied' };
  const identity = deps.identity ?? (typeof chrome !== 'undefined' ? chrome.identity : undefined);
  if (!identity?.launchWebAuthFlow) return { status: 'failed', reason: 'unavailable' };
  const fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);

  const { verifier, challenge } = await pkcePair();
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const callback = identity.getRedirectURL('openrouter');
  traceModel('oauth-start', { provider: 'openrouter' });
  let responseUrl: string | undefined;
  try {
    responseUrl = await identity.launchWebAuthFlow({
      url: openRouterAuthUrl(callback, challenge, state),
      interactive: true,
    });
  } catch {
    traceModel('oauth-end', { provider: 'openrouter', status: 'cancelled' });
    return { status: 'failed', reason: 'cancelled' };
  }
  if (!responseUrl) return { status: 'failed', reason: 'cancelled' };
  const params = new URL(responseUrl).searchParams;
  const code = params.get('code');
  if (!code) return { status: 'failed', reason: 'no-code' };
  const returnedState = params.get('state');
  if (returnedState !== null && returnedState !== state) return { status: 'failed', reason: 'state-mismatch' };
  try {
    const response = await fetchFn(OPENROUTER_KEYS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    if (!response.ok) {
      traceModel('oauth-end', { provider: 'openrouter', status: 'failed', httpStatus: response.status });
      return { status: 'failed', reason: 'exchange-failed' };
    }
    const data = (await response.json()) as { key?: unknown };
    if (typeof data.key !== 'string' || !data.key) return { status: 'failed', reason: 'exchange-failed' };
    traceModel('oauth-end', { provider: 'openrouter', status: 'completed' });
    return { status: 'completed', key: data.key };
  } catch {
    traceModel('oauth-end', { provider: 'openrouter', status: 'failed' });
    return { status: 'failed', reason: 'exchange-failed' };
  }
}

export function oauthFailureText(reason: OAuthFailure): string {
  switch (reason) {
    case 'unavailable':
      return '当前浏览器不支持扩展登录（chrome.identity 不可用）';
    case 'permission-denied':
      return '需要授权“登录身份”和 openrouter.ai 访问权限才能登录';
    case 'cancelled':
      return '登录已取消';
    case 'no-code':
      return 'OpenRouter 没有返回授权码';
    case 'state-mismatch':
      return '登录回调校验失败，请重试';
    case 'exchange-failed':
      return '换取密钥失败，请稍后重试';
  }
}
