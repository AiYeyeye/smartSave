import type { ImportEncoding } from './encoding';

export type ImportFormat = 'html' | 'json' | 'csv' | 'txt' | 'markdown';
/** Half-open UTF-16 offsets in decoded text (BOM excluded), never normalized text. */
export interface SourceSpan { start: number; end: number }
export interface ImportItem {
  sourceOrdinal: number; sourceSpan: SourceSpan; rawURL: string; title: string; oldPath: string[];
  provenance: { format: ImportFormat; sourcePath?: (string | number)[]; urlSpan: SourceSpan };
  diagnostic?: 'invalid-url' | 'unsupported-protocol';
}
export interface SourceCandidate { sourcePath: (string | number)[]; value: string; sourceSpan: SourceSpan }
export interface ImportResult { text: string; encoding: ImportEncoding; items: ImportItem[]; candidates: SourceCandidate[] }
export class ImportParseError extends Error {
  constructor(public readonly code: 'malformed' | 'resource' | 'encoding' | 'unsupported-format', message: string) { super(message); }
}
// Engineering guards: whole-file rejection, not a bookmark count cap. Measurements are recorded in task progress.
export const IMPORT_RESOURCE_BUDGET = { bytes: 32 * 1024 * 1024, depth: 256 } as const;

export interface ParseRequest { bytes: ArrayBuffer; format: ImportFormat }
export type ParseResponse = { ok: true; result: ImportResult } | { ok: false; code: ImportParseError['code']; message: string };
