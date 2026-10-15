import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganizeWorkbench } from '../panel/OrganizeWorkbench';
import { OrganizeController } from '../panel/organize-controller';
import { organizerTree } from './fixtures/organizer-tree';
import { LanguagePicker, LocaleProvider } from '../ui/i18n';

afterEach(cleanup);
it('displays original variant URLs, defaults to unselected and requires a keep before previewing a suspected deletion', async () => {
  const tree = organizerTree();
  const urls = ['http://www.x.test/a/?utm_source=mail#section', 'https://x.test/a#section'];
  tree.nodes.find(node => node.ref.nativeId === 'a')!.url = urls[0];
  tree.nodes.find(node => node.ref.nativeId === 'b')!.url = urls[1];
  const send = vi.fn();
  const create = (emit: ConstructorParameters<typeof OrganizeController>[0]) => {
    const controller = new OrganizeController(
      emit,
      undefined,
      undefined,
      async () => ({ token: 'lease', close: vi.fn() }),
      send,
    );
    controller.setTree({ status: 'ready', snapshot: tree });
    return controller;
  };
  render(
    <LocaleProvider>
      <LanguagePicker />
      <OrganizeWorkbench visible createController={create} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '下一步：查找重复书签' }));
  expect(screen.getByRole('heading', { name: '疑似重复 · 2 条' })).toBeVisible();
  for (const url of urls) expect(screen.getByText(url!, { exact: true })).toBeVisible();
  expect(screen.getByLabelText('a 保留或删除')).toHaveValue('unselected');
  expect(screen.getByLabelText('b 保留或删除')).toHaveValue('unselected');
  fireEvent.change(screen.getByLabelText('b 保留或删除'), { target: { value: 'delete' } });
  expect(screen.getByRole('button', { name: '生成去重预览' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('a 保留或删除'), { target: { value: 'keep' } });
  const choice = screen.getByLabelText('b 保留或删除');
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('heading', { name: 'Possible duplicates · 2' })).toBeVisible();
  expect(screen.getByLabelText('Keep or delete b')).toBe(choice);
  expect(choice).toHaveValue('delete');
  expect(screen.getByLabelText('Keep or delete a')).toHaveValue('keep');
  for (const url of urls) expect(screen.getByText(url!, { exact: true })).toBeVisible();
  expect(send).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'zh-CN' } });
  expect(screen.getByLabelText('b 保留或删除')).toBe(choice);
  expect(choice).toHaveValue('delete');
  fireEvent.click(screen.getByRole('button', { name: '生成去重预览' }));
  await waitFor(() => expect(screen.getByLabelText('选择 delete:b')).toBeChecked());
  expect(screen.queryByLabelText('选择 delete:a')).not.toBeInTheDocument();
  expect(send).not.toHaveBeenCalled();
});
