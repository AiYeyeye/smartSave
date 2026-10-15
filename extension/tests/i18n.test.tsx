import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { LANGUAGE_KEY, LanguagePicker, LocaleProvider, translate, translateKnown, useI18n } from '../ui/i18n';
import { english } from '../ui/i18n/catalog';
import { searchStatusText } from '../panel/search-status-text';
import { serviceStatusText } from '../options/ai-services/status-text';
import { saveStatusText } from '../panel/save-status-text';
import { organizeStatusText, organizePreviewText } from '../panel/organize-status-text';
import { OverlayStatus } from '../panel/OverlayStatus';

it('localizes the pre-authorization overlay status and preserves its explicit close-only action', () => {
  localStorage.setItem(LANGUAGE_KEY, 'en');
  const close = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  const view = render(<OverlayStatus />);
  expect(screen.getByText('Connecting to Zhilan…')).toBeVisible();
  view.rerender(<OverlayStatus failed />);
  expect(screen.getByRole('alert')).toHaveTextContent('Could not start the sidebar');
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
  expect(close).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledWith({ type: 'zhilan-overlay-close' }, '*');
  close.mockRestore();
});

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

it('organizer statuses adapt owned progress and errors while preserving diagnostic codes and native preview content', () => {
  expect(organizeStatusText('en', '正在生成第 2 / 3 批建议（100 条书签）…')).toBe(
    'Generating batch 2 / 3 (100 bookmarks)…',
  );
  expect(organizeStatusText('en', '服务繁忙，4 秒后重试（2/3），可随时暂停。')).toContain('Retrying in 4s (2/3)');
  expect(organizeStatusText('en', '等待连接、后续流数据或完整非流式响应超过 180 秒，请重试。 未修改书签。')).toContain(
    '180s. Retry. No bookmarks were changed.',
  );
  expect(
    organizeStatusText('en', '模型服务密钥无效，请检查 AI 服务配置。 已保留 3 批结果，可继续未完成批次。未修改书签。'),
  ).toBe(
    'The provider key is invalid. Check AI service settings. Retained results from 3 batches. You can continue unfinished batches. No bookmarks were changed.',
  );
  expect(organizeStatusText('en', '全部 3 批已完成，已核对 200 条书签。没有需要应用的操作。')).toBe(
    'All 3 batches are complete; 200 bookmarks checked. No changes to apply.',
  );
  expect(
    organizeStatusText('en', 'unknown：已完成 1 步，未完成 2 步。结果未知，请在备份与恢复中核对；不自动重放。'),
  ).toContain('unknown: completed 1 steps, remaining 2. The outcome is unknown.');
  expect(organizeStatusText('en', 'unrecognized diagnostic: 书签')).toBe('unrecognized diagnostic: 书签');
  expect(organizePreviewText('en', '新建目录：移动 / 重命名 <&> {action}')).toBe(
    'New folder: 移动 / 重命名 <&> {action}',
  );
  expect(organizePreviewText('zh-CN', '新建目录：移动')).toBe('新建目录：移动');
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
it('service notifications translate status while preserving embedded model identifiers verbatim', () => {
  expect(serviceStatusText('en', '已导入 3 个服务（不含密钥，请重新填写）')).toContain('Imported 3 services');
  expect(serviceStatusText('en', '合成分类测试通过：已连接<&>')).toBe(
    'Synthetic classification test passed: 已连接<&>',
  );
  expect(serviceStatusText('en', '未能获取模型列表：permission。仍可手填模型 ID。')).toContain(
    'permission. You can still enter a model ID',
  );
  expect(serviceStatusText('en', '配置完成：收藏会用 保存服务 自动归类')).toContain('保存服务');
});
it('save status translates only UI text and preserves failure details literally', () => {
  expect(saveStatusText('en', 'AI未完成：收藏标题<&>；可手动收藏。')).toBe(
    'AI did not complete: 收藏标题<&>. You can save manually.',
  );
  expect(saveStatusText('zh-CN', 'AI未完成：timeout；可检查配置后重试。')).toBe(
    'AI未完成：timeout；可检查配置后重试。',
  );
  expect(saveStatusText('en', 'unknown diagnostic')).toBe('unknown diagnostic');
});
