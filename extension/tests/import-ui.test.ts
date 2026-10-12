import { createElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { App } from '../ui/App';
import { ImportCheckpointStore } from '../persistence/import-checkpoints';
import { openOperationsDatabase } from '../persistence/operations-database';
import { parseImport } from '../import/parsers';
import { APPEARANCES } from './appearance';

afterEach(() => {
  vi.unstubAllGlobals();
  location.hash = '';
});
/** The import workbench lives in the options page; other settings pages are one side-nav click away. */
function openImportPage() {
  location.hash = '#import';
  render(createElement(App, { page: 'options' }));
  expect(screen.getByRole('region', { name: '导入工作台' })).toBeVisible();
}
async function toAppearance(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: '外观' }));
}
it('production App keeps five-format Worker parsing and source diagnostics across themes and navigation without model calls', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('indexedDB', new IDBFactory());
  const terminate = vi.fn();
  const posted = vi.fn();
  class WorkerBoundary {
    onmessage?: (event: { data: unknown }) => void;
    terminate = terminate;
    postMessage(request: { bytes: ArrayBuffer; format: 'txt' }) {
      posted(request);
      queueMicrotask(() =>
        this.onmessage?.({ data: { ok: true, result: parseImport(new Uint8Array(request.bytes), request.format) } }),
      );
    }
  }
  vi.stubGlobal('Worker', WorkerBoundary);
  const user = userEvent.setup();
  openImportPage();
  const format = screen.getByLabelText('导入格式');
  expect(format.querySelectorAll('option')).toHaveLength(5);
  await user.selectOptions(format, 'txt');
  const file = new File(['https://example.test/?a=1#中\nftp://example.test/x'], 'synthetic.txt');
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () =>
      new TextEncoder().encode(
        await new Promise<string>(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(file);
        }),
      ).buffer,
  });
  fireEvent.change(screen.getByLabelText('导入文件'), { target: { files: [file] } });
  await waitFor(() => expect(screen.getByText(/解析完成/)).toBeVisible());
  expect(screen.getByText(/unsupported-protocol/)).toBeVisible();
  expect(posted).toHaveBeenCalledOnce();
  expect(terminate).toHaveBeenCalledOnce();
  await toAppearance(user);
  for (const name of APPEARANCES) {
    await user.click(screen.getByRole('radio', { name }));
    expect(format).toHaveValue('txt');
    expect(screen.getByText(/unsupported-protocol/)).toBeInTheDocument();
  }
  expect(fetch).not.toHaveBeenCalled();
});
it('checkpoint cursor isolates unknown versions; only selected by-ID restore validates full evidence', async () => {
  const factory = new IDBFactory();
  const store = new ImportCheckpointStore(factory);
  await store.put(
    {
      schemaVersion: 1,
      id: 'known',
      revision: 0,
      installationId: 'i',
      root: { installationId: 'i', nativeId: 'r', kind: 'folder' },
      items: [],
      diagnostics: [],
      classified: [],
      newFolders: [],
      phase: 'paused',
    },
    null,
  );
  const db = await openOperationsDatabase(factory, 'zhilan-operations');
  await new Promise<void>(resolve => {
    const tx = db.transaction('importCheckpoints', 'readwrite');
    tx.objectStore('importCheckpoints').put({ schemaVersion: 999, id: 'future', source: 'retained' });
    tx.oncomplete = () => resolve();
  });
  db.close();
  expect(await store.list()).toEqual([
    { id: 'future', phase: 'unknown', status: 'unknown' },
    { id: 'known', phase: 'paused', status: 'readable' },
  ]);
  expect((await store.get('known'))?.id).toBe('known');
  await expect(store.get('future')).rejects.toThrow('unsupported');
  expect(await store.list()).toHaveLength(2);
});
it('production same-task load retains deselect-all and explicit title edits across themes/navigation', async () => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  const items = parseImport(new TextEncoder().encode('https://example.test/'), 'txt').items;
  await new ImportCheckpointStore().put(
    {
      schemaVersion: 1,
      id: 'draft-task',
      revision: 0,
      installationId: 'i',
      root: { installationId: 'i', nativeId: 'r', kind: 'folder' },
      items: items.map(item => ({ item, titleLocked: false })),
      diagnostics: [],
      classified: items.map(item => ({ sourceOrdinal: item.sourceOrdinal, title: 'Proposed title', folderId: 'r' })),
      newFolders: [],
      phase: 'classified',
    },
    null,
  );
  const user = userEvent.setup();
  openImportPage();
  await user.click(screen.getByRole('button', { name: '读取导入任务列表' }));
  await user.click(await screen.findByRole('button', { name: '加载任务' }));
  const row = await screen.findByRole('checkbox', { name: 'https://example.test/' });
  expect(screen.getByLabelText('明确编辑标题 0')).toHaveValue('Proposed title');
  await user.click(row);
  await user.clear(screen.getByLabelText('明确编辑标题 0'));
  await user.type(screen.getByLabelText('明确编辑标题 0'), 'Edited');
  await user.click(screen.getByRole('button', { name: '加载任务' }));
  await waitFor(() => expect(row).not.toBeChecked());
  await toAppearance(user);
  for (const name of APPEARANCES) {
    await user.click(screen.getByRole('radio', { name }));
    expect(row).not.toBeChecked();
    expect(screen.getByLabelText('明确编辑标题 0')).toHaveValue('Edited');
  }
});
