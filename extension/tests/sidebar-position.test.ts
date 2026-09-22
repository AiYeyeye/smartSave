import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SidebarPosition } from '../ui/SidebarPosition';

it('exposes injected side and width controls without native sidePanel layout', async () => {
  render(createElement(SidebarPosition));
  expect(screen.getByRole('button', { name: '左侧' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '关闭侧栏' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: '刷新位置' })).toBeNull();
});
