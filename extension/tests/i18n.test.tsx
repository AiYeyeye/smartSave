import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { LANGUAGE_KEY, LanguagePicker, LocaleProvider, translate, translateKnown, useI18n } from '../ui/i18n';
import { english } from '../ui/i18n/catalog';
import { searchStatusText } from '../panel/search-status-text';

it('every translation preserves its parameters and interpolates values as literal text', () => {
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const [key, value] of Object.entries(english)) {
    expect(value.trim(), key).not.toBe('');
    expect(placeholders(value), key).toEqual(placeholders(key));
  }
  expect(translate('en', '{count} 条结果 · {action}', { count: 2, action: '<script>{count}$&</script>' })).toBe(
    'Results: 2 · <script>{count}$&</script>',
  );
  expect(translateKnown('en', '用户自己的标题')).toBe('用户自己的标题');
});
it('language changes retain mounted owners and drafts, persist locally, and update document metadata', () => {
  const mount = vi.fn();
  const unmount = vi.fn();
  function Draft() {
    const { t } = useI18n();
    const [draft, setDraft] = useState('原生目录名');
    useEffect(() => {
      mount();
      return unmount;
    }, []);
    return (
      <>
        <h1>{t('搜索书签')}</h1>
        <input aria-label="draft" value={draft} onChange={event => setDraft(event.target.value)} />
      </>
    );
  }
  render(
    <LocaleProvider>
      <LanguagePicker />
      <Draft />
    </LocaleProvider>,
  );
  const input = screen.getByLabelText('draft');
  fireEvent.change(input, { target: { value: '未保存的输入 <>&' } });
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByRole('heading', { name: 'Search bookmarks' })).toBeVisible();
  expect(screen.getByLabelText('draft')).toBe(input);
  expect(input).toHaveValue('未保存的输入 <>&');
  expect(mount).toHaveBeenCalledOnce();
  expect(unmount).not.toHaveBeenCalled();
  expect(localStorage.getItem(LANGUAGE_KEY)).toBe('en');
  expect(document.documentElement.lang).toBe('en');
  expect(document.title).toBe('Zhilan · Bookmark assistant');
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'zh-CN' })));
  expect(screen.getByRole('heading', { name: '搜索书签' })).toBeVisible();
  expect(input).toHaveValue('未保存的输入 <>&');
});
it('invalid stored language falls back to Chinese; storage failure retains the selected language with feedback', () => {
  localStorage.setItem(LANGUAGE_KEY, 'invalid');
  render(
    <LocaleProvider>
      <LanguagePicker />
    </LocaleProvider>,
  );
  expect(screen.getByLabelText('语言')).toHaveValue('zh-CN');
  const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw Error('quota');
  });
  fireEvent.change(screen.getByLabelText('语言'), { target: { value: 'en' } });
  expect(screen.getByLabelText('Language')).toHaveValue('en');
  expect(screen.getByRole('status')).toHaveTextContent('could not be saved');
  save.mockRestore();
});
it('search status adapts numeric progress and known errors without translating arbitrary strings', () => {
  expect(searchStatusText('en', '服务繁忙，4 秒后重试（2/3），可随时取消。')).toContain('Retrying in 4s (2/3)');
  expect(searchStatusText('en', '深度搜索：已检查 80 / 200 条，正在比较相关结果…')).toContain('80 / 200');
  expect(searchStatusText('en', 'AI 搜索未完成，保留本地结果。模型返回的搜索结果无效，请重试。')).toContain(
    'invalid search results',
  );
  expect(searchStatusText('en', '书签服务不可用。 仍可搜索上次读取的数据。')).toContain('previously loaded data');
  expect(searchStatusText('en', '书签用户标题 80')).toBe('书签用户标题 80');
});
