import { expect, it, vi } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { isExportLinkClickable } from '../export/link-policy';
import { createExportProjection } from '../domain/export-projection';
import { serializeExportHTML, serializeExportJSON, serializeExportMarkdown } from '../export/serializers';
import type { TreeSnapshot } from '../domain/node-reference';

// Simulate a future broader import allowlist without modifying import production policy.
vi.mock('../domain/import-url', () => ({ importURLDiagnostic: () => undefined }));

it.each([
  'javascript:alert("<x>&")',
  'JaVaScRiPt:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'mailto:a@example.test',
  'custom://host/`[x](https://evil.test)`',
  'file:///private',
  'vbscript:msgbox(1)',
  'https://x.test/\n" onclick="evil',
  ' https://example.test',
  'not a URL',
])('keeps %s inert despite permissive import policy, preserving original JSON and escaped text', url => {
  const ref = (nativeId: string, kind: 'folder' | 'bookmark') => ({ installationId: 'i', nativeId, kind });
  const tree: TreeSnapshot = {
    installationId: 'i',
    epoch: 'e',
    observedRevision: 1,
    roots: ['0'],
    nodes: [
      { ref: ref('0', 'folder'), title: '', childrenIds: ['f'], index: 0, readOnly: true, observedRevision: 1 },
      {
        ref: ref('f', 'folder'),
        parentId: '0',
        title: 'Folder',
        childrenIds: ['b'],
        index: 0,
        readOnly: false,
        observedRevision: 1,
      },
      {
        ref: ref('b', 'bookmark'),
        parentId: 'f',
        title: '<img src=x> [title]',
        url,
        childrenIds: [],
        index: 0,
        readOnly: false,
        observedRevision: 1,
      },
    ],
  };
  const p = createExportProjection(tree, { roots: [ref('f', 'folder')], excludedFolders: [] }, '2026-09-09T00:00:00Z');
  expect(isExportLinkClickable(url)).toBe(false);
  expect(JSON.parse(serializeExportJSON(p)).roots[0].children[0].url).toBe(url);
  const html = new DOMParser().parseFromString(serializeExportHTML(p), 'text/html');
  expect(html.querySelectorAll('a,script,img')).toHaveLength(0);
  expect(html.querySelector('code')!.textContent).toBe(url);
  const md = serializeExportMarkdown(p);
  const code = md.match(/<code>(.*?)<\/code>/s)![1]!;
  expect(new DOMParser().parseFromString(`<code>${code}</code>`, 'text/html').querySelector('code')!.textContent).toBe(
    url,
  );
  const ast = JSON.stringify(fromMarkdown(md));
  for (const type of ['link', 'linkReference', 'image', 'definition']) expect(ast).not.toContain(`"type":"${type}"`);
});

it.each(['http://example.test/a?x=1&y=2#f', 'HTTPS://example.test/"<>', 'https://例子.test/中文'])(
  'allows only independently validated HTTP(S): %s',
  url => {
    expect(isExportLinkClickable(url)).toBe(true);
  },
);
