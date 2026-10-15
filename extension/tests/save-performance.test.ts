import { expect, it } from 'vitest';
import { summarizeSaveTimings } from '../domain/save-performance';

it('separates models, failures, legacy timing and real phase sample counts', () => {
  const samples = [100, 200, 300, 1000].map(totalMs => ({
    model: 'A',
    status: 'moved',
    timing: {
      totalMs,
      prepareMs: 10,
      applyMs: 5,
      model: { ms: totalMs - 15, attempts: 1, streaming: true, firstTokenMs: 20, generationMs: 30, validationMs: 2 },
    },
  }));
  const result = summarizeSaveTimings([
    ...samples,
    { model: 'A', status: 'failed', ms: 100000 },
    { model: 'A', status: 'classifying', ms: 0 },
    { model: 'A', status: 'kept', ms: 40 },
    {
      model: 'A',
      status: 'kept',
      timing: {
        totalMs: 500,
        prepareMs: 10,
        applyMs: 5,
        model: { ms: 485, attempts: 1, streaming: false, responseMs: 480, validationMs: 5 },
      },
    },
    { model: 'B', status: 'failed', ms: 2 },
    { status: 'skipped', ms: 1 },
  ]);
  expect(result[0]).toMatchObject({
    model: 'A',
    completed: 6,
    failed: 1,
    total: { count: 5, median: 300, p90: 1000 },
    legacy: { count: 1, median: 40 },
    firstToken: { count: 4, median: 20 },
    generation: { count: 4, median: 30 },
    validationApply: { count: 5, median: 7 },
  });
  expect(result[1]).toMatchObject({ model: 'B', completed: 0, failed: 1, total: undefined });
});

it('does not turn missing or malformed measurements into zero-time successes', () => {
  const rows = summarizeSaveTimings([NaN, Infinity, -1].map(ms => ({ model: 'A', status: 'kept', ms })));
  expect(rows[0]?.legacy).toBeUndefined();
  expect(rows[0]?.firstToken).toBeUndefined();
});
