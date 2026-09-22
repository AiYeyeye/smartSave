import { createElement, useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { Select } from '../ui/Select';
import { ThemeProvider, THEME_OVERLAY_ID } from '../ui/ThemeProvider';

function Harness({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState('');
  return createElement(ThemeProvider, null, createElement('label', null, '目标目录',
    createElement(Select, { value, disabled, onChange: event => setValue(event.currentTarget.value) },
      createElement('option', { value: '' }, '请选择目录'),
      createElement('option', { value: 'a' }, 'Alpha'),
      createElement('option', { value: 'b' }, 'Beta'),
      createElement('option', { value: 'c', disabled: true }, 'Closed'),
    )));
}

it('keeps native labeled select contracts for change and value', async () => {
  const user = userEvent.setup();
  render(createElement(Harness));
  const select = screen.getByLabelText('目标目录');
  expect(select).toHaveValue('');
  await user.selectOptions(select, 'b');
  expect(select).toHaveValue('b');
});

it('opens an in-document listbox adjacent to the trigger instead of a native picker', () => {
  render(createElement(Harness));
  const select = screen.getByLabelText('目标目录');
  const event = fireEvent.mouseDown(select);
  expect(event).toBe(false);
  const list = screen.getByRole('listbox');
  expect(list.className).toContain('in-panel-select-list');
  expect(list.style.position).toBe('fixed');
  expect(list.parentElement?.id).toBe(THEME_OVERLAY_ID);
  fireEvent.click(within(list).getByRole('option', { name: 'Alpha' }));
  expect(select).toHaveValue('a');
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('supports arrows, Home, End, typeahead, Escape and Tab while open', async () => {
  const user = userEvent.setup();
  render(createElement(Harness));
  const select = screen.getByLabelText('目标目录');
  select.focus();
  fireEvent.keyDown(select, { key: 'ArrowDown' });
  const list = screen.getByRole('listbox');
  expect(list).toBeVisible();
  fireEvent.keyDown(select, { key: 'End' });
  expect(within(list).getByRole('option', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(select, { key: 'Home' });
  expect(within(list).getByRole('option', { name: '请选择目录' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(select, { key: 'b' });
  expect(within(list).getByRole('option', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(select, { key: 'Enter' });
  expect(select).toHaveValue('b');
  fireEvent.mouseDown(select);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('listbox')).toBeNull();
  fireEvent.mouseDown(select);
  fireEvent.keyDown(select, { key: 'Tab' });
  expect(screen.queryByRole('listbox')).toBeNull();
});

it('does not open when disabled', () => {
  render(createElement(Harness, { disabled: true }));
  fireEvent.mouseDown(screen.getByLabelText('目标目录'));
  expect(screen.queryByRole('listbox')).toBeNull();
});
