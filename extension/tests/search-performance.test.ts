import { expect, it } from 'vitest';
import { SearchIndex } from '../domain/search-index';
import { searchTree } from './fixtures/search-tree';
import { cpus, platform, release } from 'node:os';
it.each([1000, 5000])('measures separate synthetic index build and 100 hot queries for %i bookmarks', count => {
  const tree = searchTree(count); const start = performance.now(); const index = new SearchIndex(tree); const build = performance.now() - start;
  const queries = ['example', 'bookmark', '重庆', 'chongqing', 'cqdx', '/guide/25', '学习资料', 'bookmrk', 'not-found'];
  for (const query of queries) index.query(query);
  const times = Array.from({ length: 100 }, (_, i) => { const start = performance.now(); index.query(queries[i % queries.length]!); return performance.now() - start; }).sort((a, b) => a - b);
  console.info(JSON.stringify({ synthetic: true, device: `${platform()} ${release()} ${cpus()[0]?.model}`, count, buildMs: build, hotQueries: 100, medianMs: times[50], p95Ms: times[95], maxMs: times[99] }));
  // Median is the regression signal; p95/max are recorded only because a loaded CI/dev machine makes single outliers meaningless.
  expect(times[50]).toBeLessThan(count === 1000 ? 50 : 150);
}, 30000);
