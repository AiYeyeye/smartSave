import { ImportParseError, type ImportResult, type SourceCandidate } from './contracts';

/** AI supplies only paths. Values and URLs are always recovered from the original parse, never model text. */
export function resolveSourceCandidates(result: ImportResult, paths: (string | number)[][]): SourceCandidate[] {
  // One typed-path index per call keeps whole-structure lookups linear; the first original occurrence wins.
  const index = new Map<string, SourceCandidate>();
  for (const candidate of result.candidates) { const key = JSON.stringify(candidate.sourcePath); if (!index.has(key)) index.set(key, candidate); }
  return paths.map(path => {
    const candidate = index.get(JSON.stringify(path));
    if (!candidate) throw new ImportParseError('malformed', 'Mapping does not identify an original string');
    return candidate;
  });
}
/** Isomorphic siblings share one structure: numeric segments become '*', the relative field is the last template segment, and each concrete parent (or each bare array string) is one element. */
export function candidateStructure(sourcePath: readonly (string | number)[]): { structure: string[]; field: string; element: string } {
  const template = sourcePath.map(segment => typeof segment === 'number' ? '*' : segment);
  const field = template.at(-1) ?? '';
  return { structure: template.slice(0, -1), field, element: JSON.stringify(field === '*' ? sourcePath : sourcePath.slice(0, -1)) };
}
