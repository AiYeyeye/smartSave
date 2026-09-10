/** Validate the original spelling; never return a normalized URL for storage or deduplication. */
export function importURLDiagnostic(rawURL: string): 'invalid-url' | 'unsupported-protocol' | undefined {
  try {
    const url = new URL(rawURL);
    if (!['http:', 'https:'].includes(url.protocol)) return 'unsupported-protocol';
    if (rawURL.trim() !== rawURL || [...rawURL].some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return 'invalid-url';
  } catch { return 'invalid-url'; }
  return undefined;
}
