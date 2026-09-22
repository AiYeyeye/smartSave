export type ImportEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

/** Decode only the approved encodings. Never substitute malformed input or guess a legacy charset. */
export function decodeImportBytes(bytes: Uint8Array): { encoding: ImportEncoding; text: string } {
  const invalid = () => Error('unsupported-or-malformed-encoding');
  // UTF-32LE shares the UTF-16LE prefix; reject it before choosing the decoder.
  if (
    (bytes[0] === 255 && bytes[1] === 254 && bytes[2] === 0 && bytes[3] === 0) ||
    (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 254 && bytes[3] === 255)
  )
    throw invalid();
  const encoding: ImportEncoding =
    bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
  return { encoding, text };
}
