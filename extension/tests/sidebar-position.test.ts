import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SidebarPosition } from '../ui/SidebarPosition';
it('reports unsupported layout without a fake position control', async () => {
  render(createElement(SidebarPosition));
  expect(await screen.findByText(/无法读取位置/)).toBeVisible();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '刷新位置' })).toBeEnabled();
});

it('handles returned positions, unknown and rejection on refresh', async () => {
  const { vi } = await import('vitest');
  const user = (await import('@testing-library/user-event')).default.setup();
  const getLayout = vi.fn().mockResolvedValueOnce({ side: 'left' }).mockResolvedValueOnce({ side: 'right' }).mockResolvedValueOnce({ side: 'other' }).mockRejectedValueOnce(Error());
  vi.stubGlobal('chrome', { sidePanel: { getLayout } });
  render(createElement(SidebarPosition));
  expect(await screen.findByText('当前位置：左侧')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '刷新位置' }));
  expect(await screen.findByText('当前位置：右侧')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '刷新位置' }));
  expect(await screen.findByText(/未知布局/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: '刷新位置' }));
  expect(await screen.findByText(/拒绝了读取/)).toBeVisible();
  vi.unstubAllGlobals();
});
