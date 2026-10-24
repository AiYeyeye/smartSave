import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';
import { FolderTreePicker } from '../panel/FolderTreePicker';
import type { TreeSnapshot } from '../domain/node-reference';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';

const entries = [
  ['r', '', undefined, false, ['bar', 'other']],
  ['bar', 'Bookmarks bar', 'r', true, ['tech', 'book']],
  ['tech', 'Technology', 'bar', true, ['project']],
  ['project', 'Projects', 'tech', true, []],
  ['other', 'Other bookmarks', 'r', true, ['managed']],
  ['managed', 'Managed', 'other', false, []],
] as const;
const tree: TreeSnapshot = {
  installationId: 'i',
  epoch: 'e',
  observedRevision: 1,
  roots: ['r'],
  nodes: entries.map(([id, title, parentId, writable, childrenIds], index) => ({
    ref: { installationId: 'i', nativeId: id, kind: 'folder' },
    title,
    parentId,
    index,
    childrenWritable: writable,
    readOnly: id === 'bar' || !writable,
    childrenIds: [...childrenIds],
    observedRevision: 1,
  })),
};
tree.nodes.push({
  ref: { installationId: 'i', nativeId: 'book', kind: 'bookmark' },
  title: 'Bookmark excluded',
  url: 'https://example.test/',
  parentId: 'bar',
  index: 1,
  readOnly: false,
  childrenIds: [],
  observedRevision: 1,
});
function Picker({ change = vi.fn(), disabled = false }) {
  const [value, setValue] = useState('project');
  return (
    <LocaleProvider>
      <LanguagePicker />
      <FolderTreePicker
        tree={tree}
        label="Destination"
        value={value}
        disabled={disabled}
        onChange={id => {
          setValue(id);
          change(id);
        }}
      />
    </LocaleProvider>
  );
}
it('opens the selected ancestors in native order and expands without changing the draft', () => {
  const change = vi.fn();
  render(<Picker change={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Destination' }));
  expect(screen.getAllByRole('treeitem').map(row => row.getAttribute('aria-label'))).toEqual([
    'Bookmarks bar',
    'Technology',
    'Projects',
    'Other bookmarks',
  ]);
  expect(screen.queryByRole('treeitem', { name: 'Bookmark excluded' })).not.toBeInTheDocument();
  expect(screen.queryByRole('treeitem', { name: '根目录' })).not.toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: 'Projects' })).not.toHaveAttribute('aria-expanded');
  fireEvent.click(screen.getByRole('button', { name: '收起目录：Bookmarks bar' }));
  expect(screen.queryByRole('treeitem', { name: 'Projects' })).not.toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Projects');
  fireEvent.click(screen.getByRole('button', { name: '展开目录：Other bookmarks' }));
  fireEvent.click(screen.getByRole('treeitem', { name: 'Managed' }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('treeitem', { name: 'Bookmarks bar' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('bar');
  expect(screen.queryByRole('tree')).not.toBeInTheDocument();
});
it('supports roving keyboard navigation and preserves the selected folder across locale changes', () => {
  const change = vi.fn();
  render(<Picker change={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Destination' }));
  const selected = screen.getByRole('treeitem', { name: 'Projects' });
  expect(selected).toHaveAttribute('tabindex', '0');
  fireEvent.keyDown(selected, { key: 'ArrowLeft' });
  expect(screen.getByRole('treeitem', { name: 'Technology' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Technology' }), { key: 'ArrowLeft' });
  expect(screen.queryByRole('treeitem', { name: 'Projects' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('treeitem', { name: 'Technology' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByRole('button', { name: 'Destination' })).toHaveTextContent('Projects');
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Technology' }), { key: 'Home' });
  expect(screen.getByRole('treeitem', { name: 'Bookmarks bar' })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Bookmarks bar' }), { key: 'Enter' });
  expect(change).toHaveBeenCalledExactlyOnceWith('bar');
});
it('Escape closes the picker only and busy mode prevents selection', () => {
  const change = vi.fn();
  const view = render(<Picker change={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Destination' }));
  fireEvent.keyDown(screen.getByRole('treeitem', { name: 'Projects' }), { key: 'Escape' });
  expect(screen.queryByRole('tree')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Destination' })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Destination' }));
  view.rerender(<Picker change={change} disabled />);
  fireEvent.click(screen.getByRole('treeitem', { name: 'Bookmarks bar' }));
  expect(change).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Destination' })).toBeDisabled();
});
