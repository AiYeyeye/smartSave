import { describe, expect, it } from 'vitest';
import { decodeImportBytes } from '../import/encoding';

const utf8 = (text: string) => new TextEncoder().encode(text);
const utf16 = (text: string, little: boolean) => {
  const bytes = new Uint8Array(2 + text.length * 2);
  bytes.set(little ? [255, 254] : [254, 255]);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), little);
  return bytes;
};
describe('import encoding boundary', () => {
  it('decodes UTF-8 with or without BOM without changing original URLs', () => {
    const text = '中文 https://example.test/?x=%2F#片段';
    expect(decodeImportBytes(utf8(text))).toEqual({ encoding: 'utf-8', text });
    expect(decodeImportBytes(new Uint8Array([239, 187, 191, ...utf8(text)]))).toEqual({ encoding: 'utf-8', text });
  });
  it.each([true, false])('decodes BOM-marked UTF-16 (little endian %s)', little => {
    const text = '书签🦉\r\nhttps://example.test/';
    expect(decodeImportBytes(utf16(text, little))).toEqual({ encoding: little ? 'utf-16le' : 'utf-16be', text });
  });
  it.each([
    [0xc0, 0xaf],
    [0xe4, 0xb8],
    [0xff, 0xfe, 0x61],
    [0xff, 0xfe, 0, 0xd8],
    [0xfe, 0xff, 0xdc, 0],
    [0xff, 0xfe, 0, 0, 0x61, 0, 0, 0],
    [0, 0, 0xfe, 0xff, 0, 0, 0, 0x61],
    [0xd6, 0xd0, 0xce, 0xc4],
  ])('rejects malformed or unsupported bytes %j without fallback', (...bytes) => {
    expect(() => decodeImportBytes(new Uint8Array(bytes))).toThrow('unsupported-or-malformed-encoding');
  });
  it('does not guess UTF-16 from BOM-less bytes that are valid UTF-8', () => {
    expect(decodeImportBytes(new Uint8Array([0x61, 0, 0x62, 0]))).toEqual({ encoding: 'utf-8', text: 'a\0b\0' });
  });
  it('preserves interior BOM and literal replacement characters', () => {
    expect(decodeImportBytes(utf8('a\uFEFFb\uFFFD')).text).toBe('a\uFEFFb\uFFFD');
  });
  it('accepts an empty file for the parser to report no items', () => {
    expect(decodeImportBytes(new Uint8Array())).toEqual({ encoding: 'utf-8', text: '' });
  });
});
