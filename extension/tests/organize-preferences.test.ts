import { expect, it } from 'vitest';
import { organizePreference } from '../domain/organize-preferences';
it('keeps a different second-level scheme and drops one that repeats the first', () => {
  expect(organizePreference({ style: 'purpose', instructions: '', subStyle: 'topic' })).toEqual({
    style: 'purpose',
    instructions: '',
    subStyle: 'topic',
  });
  expect(organizePreference({ style: 'topic', instructions: '', subStyle: 'topic' })).toEqual({
    style: 'topic',
    instructions: '',
  });
  expect(() => organizePreference({ style: 'topic', instructions: '', subStyle: 'numbered' as never })).toThrow(
    'invalid-organize-preference',
  );
  expect(organizePreference({ style: 'project', instructions: '' })).toEqual({ style: 'project', instructions: '' });
});
