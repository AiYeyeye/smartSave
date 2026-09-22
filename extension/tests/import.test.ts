// @vitest-environment node
import { expect, it } from 'vitest';
import { parseImport } from '../import/parsers';
it('extracts original query and fragment', () => {
  const result = parseImport(new TextEncoder().encode('中文 https://example.test/a?q=1#片段'), 'txt');
  expect(result.items[0]?.rawURL).toBe('https://example.test/a?q=1#片段');
});
import { readFileSync } from 'node:fs';
import { IMPORT_RESOURCE_BUDGET, resolveSourceCandidates } from '../import/parsers';
const parse = (text: string, format: Parameters<typeof parseImport>[1]) =>
  parseImport(new TextEncoder().encode(text), format);
it('reads technical export-v1 fixture without splitting folder slash', () => {
  const r = parse(readFileSync('import/fixtures/export-v1.json', 'utf8'), 'json');
  expect(r.items[0]).toMatchObject({
    title: '示例',
    oldPath: ['资料/参考'],
    rawURL: 'https://example.test/article?id=1#part',
  });
  expect(JSON.parse(r.text.slice(r.items[0]!.provenance.urlSpan.start, r.items[0]!.provenance.urlSpan.end))).toBe(
    r.items[0]!.rawURL,
  );
});
it('strict JSON rejects malformed, comments, duplicate keys and future export versions', () => {
  for (const s of [
    '{"url":}',
    '{"url":"a","url":"b"}',
    '{/*x*/"url":"a"}',
    '{"format":"markora.bookmarks","schemaVersion":2}',
    '{"url":4}',
  ])
    expect(() => parse(s, 'json')).toThrow();
});
it('unknown JSON mappings recover only original paths including escaped property names', () => {
  const r = parse('{"陌生/字段":{"a~b":"https://e.test/?a=1#二"}}', 'json');
  expect(r.items).toEqual([]);
  expect(resolveSourceCandidates(r, [['陌生/字段', 'a~b']])[0]?.value).toBe('https://e.test/?a=1#二');
  expect(() => resolveSourceCandidates(r, [['https://invented.test']])).toThrow();
});
it('RFC4180 multiline quotes, commas and literal path preserve source', () => {
  const r = parse('url,title,path\r\n"https://e.test/?a=1,2#x","中\r\n""文""",a/b\r\n', 'csv');
  expect(r.items[0]).toMatchObject({ title: '中\r\n"文"', oldPath: ['a/b'], rawURL: 'https://e.test/?a=1,2#x' });
  expect(r.text.slice(r.items[0]!.provenance.urlSpan.start, r.items[0]!.provenance.urlSpan.end)).toBe(
    '"https://e.test/?a=1,2#x"',
  );
  for (const s of ['url\r\n"oops', 'url\nhttps://e.test', 'url,title\r\nx', 'url\r\n"x"garbage'])
    expect(() => parse(s, 'csv')).toThrow();
});
it('CSV unfamiliar fields expose source candidates', () => {
  expect(parse('地址,名称\r\nhttps://e.test,中文', 'csv').candidates).toHaveLength(2);
});
it('inert hostile HTML extracts anchors only, decodes entities without loading or executing', () => {
  const r = parse(
    '<script>throw 1</script><img src="https://evil.test"><iframe src="https://evil.test"></iframe><a href="https://e.test/?a=1&amp;b=2#中" onclick="throw 1">中文</a><a href="javascript:alert(1)">bad</a>',
    'html',
  );
  expect(r.items).toHaveLength(2);
  expect(r.items[0]?.rawURL).toBe('https://e.test/?a=1&b=2#中');
  expect(r.items[1]?.diagnostic).toBe('unsupported-protocol');
});
it('Markdown AST references, nested labels, code exclusion, bare URLs and source definitions', () => {
  const r = parse(
    '[中 **文**][id]\n\n[id]: https://e.test/?q=1#中\n\n`https://code.test`\n\n```\nhttps://fence.test\n```\n\nhttps://bare.test/a?x=1#y',
    'markdown',
  );
  expect(r.items.map(i => i.rawURL)).toEqual(['https://e.test/?q=1#中', 'https://bare.test/a?x=1#y']);
  expect(r.items[0]?.title).toBe('中 文');
  expect(r.text.slice(r.items[0]!.provenance.urlSpan.start, r.items[0]!.provenance.urlSpan.end)).toContain('[id]:');
});
it('per-item unsupported and invalid diagnostics preserve ordinal and originals', () => {
  const r = parse('[{"url":"ftp://e.test"},{"url":"nope"},{"url":"https://e.test/?x=1#f"}]', 'json');
  expect(r.items.map(i => i.diagnostic)).toEqual(['unsupported-protocol', 'invalid-url', undefined]);
  expect(r.items.map(i => i.sourceOrdinal)).toEqual([0, 1, 2]);
});
it('whole-file encoding and byte/depth failure never returns partial output', () => {
  expect(() => parseImport(new Uint8Array([255]), 'txt')).toThrow(/encoding/i);
  expect(() => parseImport(new Uint8Array(IMPORT_RESOURCE_BUDGET.bytes + 1), 'txt')).toThrow(/budget/);
  expect(() => parse('['.repeat(300) + '0' + ']'.repeat(300), 'json')).toThrow(/depth/);
  expect(() => parse('<div>'.repeat(300) + '<a href="https://e.test">x</a>' + '</div>'.repeat(300), 'html')).toThrow(
    /depth/,
  );
  expect(() => parse('> '.repeat(300) + 'https://e.test', 'markdown')).toThrow(/depth/);
});
it('synthetic byte/AST expansion measurements retain every item without count truncation', () => {
  for (const format of ['html', 'markdown', 'json', 'csv', 'txt'] as const) {
    const row =
      format === 'html'
        ? '<a href="https://e.test/?q=1#中">中</a>'
        : format === 'markdown'
          ? '[中](https://e.test/?q=1#中)\n\n'
          : format === 'json'
            ? '{"url":"https://e.test/?q=1#中","title":"中"}'
            : format === 'csv'
              ? 'https://e.test/?q=1#中,中文\r\n'
              : 'https://e.test/?q=1#中\n';
    const text =
      format === 'json'
        ? '[' + Array(20000).fill(row).join(',') + ']'
        : format === 'csv'
          ? 'url,title\r\n' + row.repeat(20000)
          : row.repeat(20000);
    const start = performance.now();
    const result = parse(text, format);
    console.info(
      'parser measurement',
      format,
      new TextEncoder().encode(text).length,
      Math.round(performance.now() - start),
    );
    expect(result.items).toHaveLength(20000);
  }
}, 30000);
it('source-named fixtures cover all text formats and Netscape folder provenance', () => {
  const html = parse(readFileSync('import/fixtures/bookmarks.html', 'utf8'), 'html');
  expect(html.items[0]?.oldPath).toEqual(['资料/参考']);
  for (const [file, format] of [
    ['bookmarks.csv', 'csv'],
    ['links.txt', 'txt'],
    ['links.md', 'markdown'],
  ] as const)
    expect(parse(readFileSync('import/fixtures/' + file, 'utf8'), format).items).toHaveLength(1);
});
it('measures admitted 32MiB simple text without silently dropping the trailing URL', () => {
  const bytes = new Uint8Array(IMPORT_RESOURCE_BUDGET.bytes);
  bytes.fill(32);
  const tail = new TextEncoder().encode('https://tail.test/?a=1#中');
  bytes.set(tail, bytes.length - tail.length);
  const start = performance.now();
  const result = parseImport(bytes, 'txt');
  console.info('32MiB TXT milliseconds', Math.round(performance.now() - start));
  expect(result.items[0]?.rawURL).toBe('https://tail.test/?a=1#中');
}, 30000);
