import { expect, it } from 'vitest';
import { importNoticeText, importSourceText } from '../panel/import-text';

it('localizes import notices without reinterpreting diagnostic values or placeholders', () => {
  expect(importNoticeText('en', { kind: 'read', count: 12 })).toContain('File read: 12 source items');
  expect(importNoticeText('en', { kind: 'paused', reason: '确认 {reason}' })).toBe(
    'Paused: 确认 {reason}. Only committed progress is retained.',
  );
  expect(importNoticeText('en', { kind: 'authority-error', reason: 'privacy-excluded' })).toContain(
    'privacy-excluded: check',
  );
  expect(importNoticeText('en', { kind: 'parse-error', code: 'malformed', reason: 'Unknown {code}' })).toBe(
    'malformed: Unknown {code}',
  );
  expect(importNoticeText('zh-CN', { kind: 'paused', reason: 'timeout' })).toBe(
    '已暂停：timeout。仅保留已提交的进度。',
  );
});
it('preserves raw source URLs, folder paths, diagnostics and provenance', () => {
  const text = importSourceText('en', {
    sourceOrdinal: 7,
    sourceSpan: { start: 0, end: 20 },
    title: '导入书签',
    rawURL: 'https://source.test/?a={path}',
    oldPath: ['确认', '带/斜杠'],
    diagnostic: 'unsupported-protocol',
    provenance: { format: 'json', sourcePath: ['原始{url}', 1], urlSpan: { start: 0, end: 20 } },
  });
  for (const literal of [
    'Source 7',
    'https://source.test/?a={path}',
    '["确认","带/斜杠"]',
    'unsupported-protocol',
    '原始{url}',
  ])
    expect(text).toContain(literal);
});
