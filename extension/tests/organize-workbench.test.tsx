import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { OrganizeController } from '../panel/organize-controller';
import { organizerTree } from './fixtures/organizer-tree';
import { ThemeProvider, ThemePicker, themes } from '../ui/ThemeProvider';
it.each(themes.map(t => t.name))('retains unchecked selection across hidden navigation in %s', async theme => {
  const tree = organizerTree();
  let controller: OrganizeController;
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    controller = new OrganizeController(
      emit,
      {
        read: async () => ({
          tree,
          version: 1,
          revision: 'one',
          sessionRevision: 0,
          key: '',
          privacy: { fullUrl: true, bodyEnabled: false, excludedFolders: [] },
        }),
        subscribe: () => () => {},
      },
      undefined,
      async () => ({ token: 'lease', close: vi.fn() }),
    );
    controller.setTree({ status: 'ready', snapshot: tree });
    return controller;
  };
  const view = render(
    <ThemeProvider>
      <ThemePicker />
      <OrganizeWorkbench visible createController={create} />
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByLabelText(theme));
  fireEvent.change(screen.getByLabelText('整理范围'), { target: { value: 'bar' } });
  fireEvent.click(screen.getByText('本地扫描精确重复'));
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  fireEvent.change(screen.getByLabelText('b 保留或删除'), { target: { value: 'delete' } });
  fireEvent.click(screen.getByText('预览所选去重'));
  await waitFor(() => expect(screen.getByLabelText('选择 delete:b')).toBeChecked());
  fireEvent.click(screen.getByLabelText('选择 delete:b'));
  view.rerender(
    <ThemeProvider>
      <ThemePicker />
      <OrganizeWorkbench visible={false} createController={create} />
    </ThemeProvider>,
  );
  view.rerender(
    <ThemeProvider>
      <ThemePicker />
      <OrganizeWorkbench visible createController={create} />
    </ThemeProvider>,
  );
  expect(screen.getByLabelText('选择 delete:b')).not.toBeChecked();
  expect(screen.getByText('一次确认并应用所选操作')).toBeDisabled();
  expect(controller!).toBeDefined();
});
it('renders a sizable frozen preview and updates selection without replacing its snapshots', async () => {
  const tree = organizerTree();
  const sample = tree.nodes.find(n => n.ref.nativeId === 'a')!;
  for (let i = 0; i < 120; i++) {
    const id = `render-${i}`;
    tree.nodes.push({ ...sample, index: i + 2, ref: { ...sample.ref, nativeId: id }, title: id });
    tree.nodes.find(n => n.ref.nativeId === 'left')!.childrenIds.push(id);
  }
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    const controller = new OrganizeController(emit, undefined, undefined, async () => ({
      token: 'lease',
      close: vi.fn(),
    }));
    controller.setTree({ status: 'ready', snapshot: tree });
    return controller;
  };
  render(<OrganizeWorkbench visible createController={create} />);
  fireEvent.change(screen.getByLabelText('整理范围'), { target: { value: 'bar' } });
  fireEvent.click(screen.getByText('本地扫描精确重复'));
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  for (let i = 0; i < 120; i++)
    fireEvent.change(screen.getByLabelText(`render-${i} 保留或删除`), { target: { value: 'delete' } });
  fireEvent.click(screen.getByText('预览所选去重'));
  await waitFor(() => expect(screen.getByLabelText('选择 delete:render-119')).toBeChecked());
  fireEvent.click(screen.getByLabelText('选择 delete:render-119'));
  expect(screen.getByLabelText('选择 delete:render-119')).not.toBeChecked();
}, 60000); // 120 jsdom select changes without list virtualization: correctness test, not a timing budget.
