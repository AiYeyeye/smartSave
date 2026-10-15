import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Ajv from 'ajv';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportTreeSelector } from '../options/ExportTreeSelector';
import { createExportProjection, type ExportScope } from '../domain/export-projection';
import { exportSelection, toggleExportSelection } from '../domain/export-selection';
import { fileOutputAncestry } from '../domain/file-output-scope';
import { serializeExportJSON, serializeExportHTML, serializeExportMarkdown } from '../export/serializers';
import schema from '../export/json-schema.json';
import { organizerTree } from './fixtures/organizer-tree';
import { FileOutputStore } from '../persistence/file-output';
import { IDBFactory } from 'fake-indexeddb';
import { parseImport } from '../import/parsers';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';

const empty: ExportScope = { roots: [], excludedFolders: [] };
afterEach(() => vi.restoreAllMocks());
it('selects individual leaves, preserves folder hierarchy and exports only the chosen content in all formats', () => {
  const tree = organizerTree();
  let scope = toggleExportSelection(tree, empty, 'bar', true);
  scope = toggleExportSelection(tree, scope, 'b', false);
  const projection = createExportProjection(tree, scope, '2026-10-12T12:00:00Z');
  expect(scope.excludedBookmarks?.map(ref => ref.nativeId)).toContain('b');
  expect(new Ajv().compile(schema)(projection.document)).toBe(true);
  expect(exportSelection(tree, scope).has('a')).toBe(true);
  expect(exportSelection(tree, scope).has('b')).toBe(false);
  const exported = JSON.stringify(projection.document);
  expect(exported).toContain('"title":"a"');
  expect(exported).not.toContain('"title":"b"');
  for (const [format, serializer] of [
    ['json', serializeExportJSON],
    ['html', serializeExportHTML],
    ['markdown', serializeExportMarkdown],
  ] as const) {
    expect(parseImport(new TextEncoder().encode(serializer(projection)), format).items.map(item => item.title)).toEqual(
      ['a'],
    );
  }
  scope = toggleExportSelection(tree, scope, 'left', false);
  scope = toggleExportSelection(tree, scope, 'a', true);
  expect(exportSelection(tree, scope).has('a')).toBe(true);
  expect(exportSelection(tree, scope).has('b')).toBe(false);
  expect(new Ajv().compile(schema)(createExportProjection(tree, scope, '2026-10-12T12:00:00Z').document)).toBe(true);
  expect(toggleExportSelection(tree, scope, 'bar', false).roots).toEqual([]);
});

it('tree expansion and mixed parent checks retain choices across hidden navigation', () => {
  const tree = organizerTree();
  let last = empty;
  function Harness({ visible }: { visible: boolean }) {
    const [scope, setScope] = useState<ExportScope>(empty);
    return (
      <section hidden={!visible}>
        <ExportTreeSelector
          tree={tree}
          scope={scope}
          disabled={false}
          onChange={value => {
            last = value;
            setScope(value);
          }}
        />
      </section>
    );
  }
  const view = render(<Harness visible />);
  fireEvent.click(screen.getByRole('checkbox', { name: '导出 a' }));
  expect(screen.getByRole('checkbox', { name: '导出 a' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: '导出 left' })).toBePartiallyChecked();
  fireEvent.click(screen.getByRole('button', { name: '收起 left' }));
  expect(screen.queryByRole('checkbox', { name: '导出 a' })).toBeNull();
  view.rerender(<Harness visible={false} />);
  view.rerender(<Harness visible />);
  fireEvent.click(screen.getByRole('button', { name: '展开 left' }));
  expect(screen.getByRole('checkbox', { name: '导出 a' })).toBeChecked();
  expect([...exportSelection(tree, last)]).toEqual(['a']);
});

it('preserves native names, mixed selection and collapsed folders across language changes', () => {
  const tree = organizerTree();
  tree.nodes.find(node => node.ref.nativeId === 'a')!.title = '导出书签 {title}';
  function Harness() {
    const [scope, setScope] = useState<ExportScope>(empty);
    return (
      <LocaleProvider>
        <LanguagePicker />
        <ExportTreeSelector tree={tree} scope={scope} disabled={false} onChange={setScope} />
      </LocaleProvider>
    );
  }
  render(<Harness />);
  const selected = screen.getByRole('checkbox', { name: '导出 导出书签 {title}' });
  fireEvent.click(selected);
  fireEvent.click(screen.getByRole('button', { name: '收起 left' }));
  fireEvent.change(screen.getByRole('combobox', { name: '语言' }), { target: { value: 'en' } });
  expect(screen.getByRole('checkbox', { name: 'Export left' })).toBePartiallyChecked();
  expect(screen.queryByRole('checkbox', { name: 'Export 导出书签 {title}' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Expand left' }));
  expect(screen.getByRole('checkbox', { name: 'Export 导出书签 {title}' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Export b' })).not.toBeChecked();
});

it('persistent output accepts leaf exclusions and fences their deletion while legacy folder scopes still work', async () => {
  const tree = organizerTree();
  let scope = toggleExportSelection(tree, empty, 'bar', true);
  scope = toggleExportSelection(tree, scope, 'b', false);
  const ancestry = fileOutputAncestry(tree, scope);
  const store = new FileOutputStore(new IDBFactory(), 'leaf-scope');
  const clone = structuredClone;
  const handle = {
    kind: 'file' as const,
    queryPermission: async (): Promise<PermissionState> => 'granted',
    createWritable: async () => ({ write: async () => {}, close: async () => {}, abort: async () => {} }),
  };
  // Only the browser handle clone boundary is synthetic; metadata persists through real fake-IDB transactions.
  vi.spyOn(globalThis, 'structuredClone').mockImplementation(value => {
    if (value && typeof value === 'object' && 'handle' in value) {
      const { handle: storedHandle, ...metadata } = value;
      return { ...clone(metadata), handle: storedHandle };
    }
    return clone(value);
  });
  await store.configure(handle, scope, ancestry, await store.issueLease());
  expect((await store.read())?.scope).toEqual(scope);
  const legacy = { roots: scope.roots, excludedFolders: [] };
  await store.configure(handle, legacy, fileOutputAncestry(tree, legacy), await store.issueLease());
  expect((await store.read())?.scope).toEqual(legacy);
  tree.nodes = tree.nodes.filter(node => node.ref.nativeId !== 'b');
  tree.nodes.find(node => node.ref.nativeId === 'left')!.childrenIds = ['a'];
  expect(() => fileOutputAncestry(tree, scope)).toThrow('export-scope-invalid-or-stale');
});
