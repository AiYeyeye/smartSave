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
