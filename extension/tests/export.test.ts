import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import schema from '../export/json-schema.json';
import { EXPORT_RESOURCE_LIMITS, boundExportText } from '../domain/export-projection';
import { expect, it } from 'vitest';
import { createExportProjection, assertExportProjectionCurrent } from '../domain/export-projection';
import { serializeExportJSON, serializeExportHTML, serializeExportMarkdown } from '../export/serializers';
import { parseImport } from '../import/parsers';
import type { TreeSnapshot } from '../domain/node-reference';

function tree(): TreeSnapshot {
  const rows: [string, string | undefined, string, string[], string?][] = [
    ['0', undefined, '', ['bar', 'other']],
    ['bar', '0', '资料/"参考', ['empty', 'link', 'private']],
    ['empty', 'bar', '', []],
    ['link', 'bar', '<img src=x onerror="alert(1)"> [x] & 中文', [], 'https://example.test/a?x="&y=1#part'],
    ['private', 'bar', 'Excluded', ['hidden']],
    ['hidden', 'private', 'hidden', [], 'https://secret.test/'],
    ['other', '0', 'Other', []],
  ];
  return {
    installationId: 'install',
    epoch: 'epoch',
    observedRevision: 1,
    roots: ['0'],
    nodes: rows.map(([id, parentId, title, childrenIds, url]) => ({
      ref: { installationId: 'install', nativeId: id, kind: url === undefined ? 'folder' : 'bookmark' },
      parentId,
      title,
      childrenIds,
      ...(url === undefined ? {} : { url }),
      index: 0,
      readOnly: false,
      observedRevision: 1,
    })),
  };
}
const scope = (t: TreeSnapshot, roots = ['bar'], excluded = ['private']) => ({
  roots: roots.map(id => t.nodes.find(n => n.ref.nativeId === id)!.ref),
  excludedFolders: excluded.map(id => t.nodes.find(n => n.ref.nativeId === id)!.ref),
});
const project = (t = tree()) => createExportProjection(t, scope(t), '2026-09-09T00:00:00Z');
const parse = (text: string, format: 'json' | 'html' | 'markdown') =>
  parseImport(new TextEncoder().encode(text), format);

it('deduplicates overlapping explicit roots, excludes subtrees and retains empty folders and raw URLs', () => {
  const t = tree();
  const p = createExportProjection(t, scope(t, ['empty', 'bar', 'bar', 'other']), '2026-09-09T00:00:00Z');
  expect(p.document.roots.map(n => n.title)).toEqual(['资料/"参考', 'Other']);
  expect(JSON.stringify(p.document)).not.toContain('secret.test');
  expect(p.document.roots[0]).toMatchObject({ children: [{ title: '', children: [] }, { url: t.nodes[3]!.url }] });
  expect(p.document.roots[0]!.path).toEqual(['资料/"参考']);
  expect(Object.isFrozen(p.document.roots)).toBe(true);
  const text = serializeExportJSON(p);
  t.nodes[3]!.title = 'later';
  expect(serializeExportJSON(p)).toBe(text);
});
it('fails closed for absent, foreign, bookmark or virtual roots and stale snapshots without whole-tree fallback', () => {
  const t = tree();
  const p = project(t);
  expect(() => createExportProjection(t, scope(t, []), '2026-09-09T00:00:00Z')).toThrow();
  for (const id of ['0', 'link'])
    expect(() => createExportProjection(t, scope(t, [id]), '2026-09-09T00:00:00Z')).toThrow();
  const s = scope(t);
  s.roots[0]!.installationId = 'foreign';
  expect(() => createExportProjection(t, s, '2026-09-09T00:00:00Z')).toThrow();
  for (const change of [
    (x: TreeSnapshot) => {
      x.nodes = x.nodes.filter(n => n.ref.nativeId !== 'bar');
    },
    (x: TreeSnapshot) => {
      x.nodes[1]!.title = 'changed';
    },
    (x: TreeSnapshot) => {
      x.epoch = 'restart';
    },
    (x: TreeSnapshot) => {
      x.observedRevision++;
    },
  ]) {
    const current = tree();
    change(current);
    expect(() => assertExportProjectionCurrent(p, current)).toThrow();
  }
});
it('excluded ancestry wins over an explicitly selected descendant; exclusion policy is not AI privacy', () => {
  const t = tree();
  const p = createExportProjection(t, scope(t, ['empty'], ['bar']), '2026-09-09T00:00:00Z');
  expect(p.document.roots).toEqual([]);
  const all = createExportProjection(t, scope(t, ['bar'], []), '2026-09-09T00:00:00Z');
  expect(serializeExportJSON(all)).toContain('secret.test');
});
it.each(['json', 'html', 'markdown'] as const)(
  'roundtrips safe URL and hostile title through actual task10 %s parser',
  format => {
    const p = project();
    const text = { json: serializeExportJSON, html: serializeExportHTML, markdown: serializeExportMarkdown }[format](p);
    const result = parse(text, format);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ rawURL: tree().nodes[3]!.url, title: tree().nodes[3]!.title });
    if (format !== 'markdown') expect(result.items[0]!.oldPath).toEqual(['资料/"参考']);
    if (format !== 'json') expect(text).not.toContain('<img src=x');
  },
);
it('keeps hostile protocols as inert data, never active HTML/Markdown destinations', () => {
  for (const url of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///private',
    'https://x.test/\n" onclick="evil',
  ]) {
    const t = tree();
    t.nodes[3]!.url = url;
    const p = project(t);
    expect(parse(serializeExportJSON(p), 'json').items[0]!.rawURL).toBe(url);
    expect(parse(serializeExportHTML(p), 'html').items).toEqual([]);
    expect(parse(serializeExportMarkdown(p), 'markdown').items).toEqual([]);
  }
});
it('rejects unknown export versions through actual task10 consumer', () => {
  const data = JSON.parse(serializeExportJSON(project()));
  data.schemaVersion = 2;
  expect(() => parse(JSON.stringify(data), 'json')).toThrow('Unsupported export schemaVersion');
});

it('validates emitted JSON and original technical fixture with independent MIT AJV draft07', () => {
  const validate = new Ajv().compile(schema);
  const data = JSON.parse(serializeExportJSON(project()));
  expect(validate(data)).toBe(true);
  expect(
    validate(
      JSON.parse(
        readFileSync(
          'tests/fixtures/export-v1-compatibility.json',
          'utf8',
        ),
      ),
    ),
  ).toBe(true);
  for (const invalid of [
    { ...data, schemaVersion: 2 },
    { ...data, model: {} },
    { ...data, roots: [{ type: 'folder', id: 'x', title: 'x' }] },
  ])
    expect(validate(invalid)).toBe(false);
  const ids: string[] = [];
  interface IdNode {
    id: string;
    children?: IdNode[];
  }
  const walk = (nodes: IdNode[]) => {
    for (const node of nodes) {
      ids.push(node.id);
      if (node.children) walk(node.children);
    }
  };
  walk(data.roots);
  expect(new Set(ids).size).toBe(ids.length);
});
it('bounds full-tree depth even when only an unrelated small root is selected', () => {
  const t = tree();
  let parent = t.nodes[6]!;
  for (let i = 2; i <= EXPORT_RESOURCE_LIMITS.depth; i++) {
    const id = `depth-${i}`;
    parent.childrenIds.push(id);
    const child = { ...parent, ref: { ...parent.ref, nativeId: id }, parentId: parent.ref.nativeId, childrenIds: [] };
    t.nodes.push(child);
    parent = child;
  }
  expect(() => project(t)).not.toThrow();
  parent.childrenIds.push('over');
  t.nodes.push({ ...parent, ref: { ...parent.ref, nativeId: 'over' }, parentId: parent.ref.nativeId, childrenIds: [] });
  expect(() => project(t)).toThrow('export-resource');
});
it('enforces node and UTF-8 output boundaries without partial output', () => {
  const t = tree();
  const parent = t.nodes[6]!;
  while (t.nodes.length < EXPORT_RESOURCE_LIMITS.nodes) {
    const id = `wide-${t.nodes.length}`;
    parent.childrenIds.push(id);
    t.nodes.push({ ...parent, ref: { ...parent.ref, nativeId: id }, parentId: parent.ref.nativeId, childrenIds: [] });
  }
  expect(() => project(t)).not.toThrow();
  t.nodes.push({ ...parent, ref: { ...parent.ref, nativeId: 'over' }, childrenIds: [] });
  expect(() => project(t)).toThrow('export-resource');
  expect(boundExportText('x'.repeat(EXPORT_RESOURCE_LIMITS.bytes))).toHaveLength(EXPORT_RESOURCE_LIMITS.bytes);
  expect(() => boundExportText('x'.repeat(EXPORT_RESOURCE_LIMITS.bytes) + 'x')).toThrow('export-resource');
});
it('rejects malformed topology, missing exclusions and invalid timestamps', () => {
  const t = tree();
  const s = scope(t);
  s.excludedFolders[0]!.nativeId = 'gone';
  expect(() => createExportProjection(t, s, '2026-09-09T00:00:00Z')).toThrow();
  expect(() => createExportProjection(tree(), scope(tree()), 'yesterday')).toThrow();
  const cycle = tree();
  cycle.nodes[2]!.childrenIds.push('bar');
  expect(() => project(cycle)).toThrow();
  const duplicate = tree();
  duplicate.nodes.push(duplicate.nodes[1]!);
  expect(() => project(duplicate)).toThrow();
});
it('roundtrips the maximum selected depth through task10 JSON and protects source/output byte limits', () => {
  const t = tree();
  let parent = t.nodes[6]!;
  for (let i = 2; i <= EXPORT_RESOURCE_LIMITS.depth; i++) {
    const id = `deep-${i}`;
    parent.childrenIds.push(id);
    const child = { ...parent, ref: { ...parent.ref, nativeId: id }, parentId: parent.ref.nativeId, childrenIds: [] };
    t.nodes.push(child);
    parent = child;
  }
  parent.ref.kind = 'bookmark';
  parent.url = 'https://depth.test/';
  const p = createExportProjection(t, scope(t, ['other'], []), '2026-09-09T00:00:00Z');
  expect(parse(serializeExportJSON(p), 'json').items[0]!.rawURL).toBe('https://depth.test/');
  const oversized = tree();
  oversized.nodes[3]!.url = 'x'.repeat(EXPORT_RESOURCE_LIMITS.bytes + 1);
  expect(() => project(oversized)).toThrow('export-resource');
  const expanded = tree();
  expanded.nodes[3]!.title = 'x'.repeat(3 * 1024 * 1024);
  expect(() => serializeExportMarkdown(project(expanded))).toThrow('export-resource');
});
it('does not export extension metadata or accept a forged serializer projection', () => {
  const t = Object.assign(tree(), { model: { key: 'secret-key' }, body: 'body-secret', rules: [], logs: [] });
  const text = serializeExportJSON(project(t));
  for (const name of ['secret-key', 'body-secret', 'installationId', 'observedRevision', 'rules', 'logs'])
    expect(text).not.toContain(name);
  expect(() => serializeExportJSON({ ...project() })).toThrow('export-scope-invalid-or-stale');
  expect(() => assertExportProjectionCurrent(project(), tree())).not.toThrow();
});
