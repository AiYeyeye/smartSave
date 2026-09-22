import { expect, it } from 'vitest';
import { ImportParseError, type ImportResult } from '../import/contracts';
import { resolveSourceCandidates } from '../import/source-candidates';

it('recovers exact original candidates in requested order without normalizing paths or values', () => {
  const source: ImportResult = {
    text: '',
    encoding: 'utf-8',
    items: [],
    candidates: [
      { sourcePath: [0, 'a/b'], value: 'https://e.test/?x=1#中', sourceSpan: { start: 2, end: 30 } },
      { sourcePath: ['0', 'a/b'], value: ' 标题 ', sourceSpan: { start: 31, end: 37 } },
    ],
  };
  const before = structuredClone(source);
  const resolved = resolveSourceCandidates(source, [
    ['0', 'a/b'],
    [0, 'a/b'],
    [0, 'a/b'],
  ]);
  expect(resolved).toEqual([source.candidates[1], source.candidates[0], source.candidates[0]]);
  expect(resolved[1]).toBe(source.candidates[0]);
  expect(source).toEqual(before);
  expect(resolveSourceCandidates(source, [])).toEqual([]);
});

it('rejects invented source paths with the shared malformed error contract', () => {
  const lookup = () =>
    resolveSourceCandidates({ text: '', encoding: 'utf-8', items: [], candidates: [] }, [['invented']]);
  expect(lookup).toThrow(ImportParseError);
  expect(lookup).toThrow('Mapping does not identify an original string');
  try {
    lookup();
  } catch (error) {
    expect(error).toMatchObject({ code: 'malformed' });
  }
});
