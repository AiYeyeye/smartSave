import { ImportParseError, type ImportResult, type SourceCandidate } from './contracts';

/** AI supplies only paths. Values and URLs are always recovered from the original parse, never model text. */
export function resolveSourceCandidates(result: ImportResult, paths: (string | number)[][]): SourceCandidate[] {
  return paths.map(path => {
    const candidate = result.candidates.find(c => JSON.stringify(c.sourcePath) === JSON.stringify(path));
    if (!candidate) throw new ImportParseError('malformed', 'Mapping does not identify an original string');
    return candidate;
  });
}
