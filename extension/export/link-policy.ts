/** Export execution policy, independent of import write eligibility. Never normalize output. */
export function isExportLinkClickable(originalURL: string): boolean {
  if (
    originalURL.trim() !== originalURL ||
    [...originalURL].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
  )
    return false;
  try {
    const protocol = new URL(originalURL).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
