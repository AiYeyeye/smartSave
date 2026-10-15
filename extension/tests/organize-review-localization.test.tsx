import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganizeTreePreview } from '../panel/OrganizeTreePreview';
import { OrganizeFlowDetails } from '../panel/OrganizeFlowDetails';
import { OrganizeTiming } from '../panel/OrganizeTiming';
import { OrganizeTargetReview } from '../panel/OrganizeTargetReview';
import { LANGUAGE_KEY, LanguagePicker, LocaleProvider } from '../ui/i18n';
import type { OrganizeProposal } from '../domain/organize-proposal';
import type { OrganizeState } from '../domain/organize-state';
import { organizerTree } from './fixtures/organizer-tree';
import { useState } from 'react';
import { organizeActionReason } from '../panel/organize-action-text';
import { organizeProposal } from '../domain/organize-proposal';
import { duplicateProposal } from '../domain/exact-duplicates';

afterEach(() => vi.useRealTimers());
const switchLanguage = (language: string) =>
  act(() => window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: language })));

function fixture() {
  const tree = organizerTree();
  tree.nodes.find(n => n.ref.nativeId === 'left')!.title = '移动';
  tree.nodes.find(n => n.ref.nativeId === 'right')!.title = '重命名';
  tree.nodes.find(n => n.ref.nativeId === 'a')!.title = '新增';
  const actions = ['a', 'b'].map(id => ({
    id: `move:${id}`,
    kind: 'move' as const,
    sourceId: id,
    title: id === 'a' ? '新增' : 'b',
    targetId: 'right',
    children: [],
    reason: '不再建议 <&> {count}',
  }));
  const proposal: OrganizeProposal = {
    tree,
    scope: tree.nodes.find(n => n.ref.nativeId === 'bar')!.ref,
    actions,
    targetIds: ['left', 'right'],
  };
  return proposal;
}

it('keeps optional model reasons distinct from localized defaults when constructing a plan', () => {
  const tree = organizerTree();
  const raw = { newFolders: [], merges: [], moves: [{ itemId: 'a', folderId: 'right' }], unchangedIds: ['b'] };
  const privacy = { fullUrl: false, bodyEnabled: false, excludedFolders: [] };
  const plan = organizeProposal(tree, 'bar', raw, privacy, { cleanupEmpty: false });
  const move = plan.actions.find(action => action.id === 'move:a')!;
  expect(move.reason).toBeUndefined();
  expect(organizeActionReason('en', move, plan)).toBe('Move to a folder that better matches the content.');
  const withReason = organizeProposal(
    tree,
    'bar',
    {
      ...raw,
      moves: [{ itemId: 'a', folderId: 'right', reason: '归入更符合内容主题的分类。' }],
    },
    privacy,
    { cleanupEmpty: false },
  );
  expect(organizeActionReason('en', withReason.actions[0]!, withReason)).toBe('归入更符合内容主题的分类。');
  expect(organizeActionReason('en', { ...move, kind: 'delete', sourceId: 'right' }, plan)).toContain(
    'This folder is empty.',
  );
  expect(organizeActionReason('en', { ...move, kind: 'delete', sourceId: 'left' }, plan)).toContain(
    'after its contents have moved out',
  );
  expect(organizeActionReason('en', { ...move, kind: 'delete', sourceId: 'a' }, plan)).toContain('identical URLs');
  const duplicates = duplicateProposal(tree, 'bar', { a: 'keep', b: 'delete' });
  expect(organizeActionReason('en', duplicates.actions[0]!, duplicates)).toBe(
    'Remove bookmarks with identical URLs, keeping the explicitly chosen copies.',
  );
});

it('preserves mixed group selection, open details and native content across language switches', () => {
  const proposal = fixture();
  const reject = vi.fn();
  function Review() {
    const [selected, select] = useState(['move:a']);
    const [targets, target] = useState<Record<string, string>>({});
    return (
      <OrganizeTargetReview
        proposal={proposal}
        actions={proposal.actions}
        selected={selected}
        targets={targets}
        targetLabels={
          new Map([
            ['left', '移动'],
            ['right', '重命名'],
          ])
        }
        targetOptions={
          <>
            <option value="left">移动</option>
            <option value="right">重命名</option>
          </>
        }
        disabled={false}
        rejectDisabled={false}
        reject={reject}
        toggle={(id, on) => select(old => (on ? [...old, id] : old.filter(i => i !== id)))}
        toggleMany={(ids, on) =>
          select(old => (on ? [...new Set([...old, ...ids])] : old.filter(i => !ids.includes(i))))
        }
        target={(id, value) => target(old => ({ ...old, [id]: value }))}
      />
    );
  }
  render(
    <LocaleProvider>
      <LanguagePicker />
      <Review />
    </LocaleProvider>,
  );
  const group = screen.getByRole('checkbox', { name: '采纳 重命名' });
  expect(group).toBePartiallyChecked();
  fireEvent.click(screen.getByText('查看并调整 2 条书签'));
  const item = screen.getByLabelText('选择 move:a');
  const details = item.closest('details')!;
  expect(details.open).toBe(true);
  switchLanguage('en');
  expect(screen.getByRole('checkbox', { name: 'Accept: 重命名' })).toBe(group);
  expect(group).toBePartiallyChecked();
  expect(screen.getByLabelText('Select move:a')).toBe(item);
  expect(item).toBeChecked();
  expect(details.open).toBe(true);
  expect(screen.getAllByText('Reason: 不再建议 <&> {count}')).toHaveLength(2);
  expect(screen.getByText('新增', { exact: true })).toBeVisible();
  fireEvent.change(screen.getByLabelText('Destination for move:a'), { target: { value: 'left' } });
  expect(screen.getByRole('checkbox', { name: 'Accept: 移动' })).toBeChecked();
  switchLanguage('zh-CN');
  expect(screen.getByLabelText('move:a 目标')).toHaveValue('left');
  expect(screen.getByLabelText('选择 move:a')).toBeChecked();
  expect(reject).not.toHaveBeenCalled();
  switchLanguage('en');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Accept: 重命名' }));
  expect(screen.getByLabelText('Select move:b')).toBeChecked();
  const row = screen.getByLabelText('Select move:a').closest('.workflow-review-row')!;
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Stop suggesting' }));
  expect(reject).toHaveBeenCalledExactlyOnceWith(proposal.actions[0]);
});

it('retains before/after and collapsed tree state without translating native names', () => {
  const proposal = fixture();
  render(
    <LocaleProvider>
      <OrganizeTreePreview proposal={proposal} after={proposal.tree} selected={[]} />
    </LocaleProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '整理前' }));
  fireEvent.click(screen.getByRole('button', { name: '收起分类 bar' }));
  switchLanguage('en');
  expect(screen.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Expand folder bar' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText('移动', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Expand all folders' }));
  expect(screen.getByText('移动', { exact: true })).toBeVisible();
  expect(screen.getByText('重命名', { exact: true })).toBeVisible();
  fireEvent.click(screen.getByText('View bookmarks in this folder (2)'));
  expect(screen.getByText('新增', { exact: true })).toBeVisible();
  switchLanguage('zh-CN');
  expect(screen.getByRole('button', { name: '整理前' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText('新增', { exact: true })).toBeVisible();
});

it('distinguishes a literal destination named like the deletion label from removed bookmarks', () => {
  const proposal = fixture();
  proposal.tree.nodes = proposal.tree.nodes.filter(n => !['0', 'outside', 'c'].includes(n.ref.nativeId));
  proposal.tree.roots = ['bar'];
  const root = proposal.tree.nodes.find(n => n.ref.nativeId === 'bar')!;
  root.parentId = undefined;
  root.title = '删除重复书签';
  const after = structuredClone(proposal.tree);
  after.nodes = after.nodes.filter(n => n.ref.nativeId !== 'b');
  after.nodes.find(n => n.ref.nativeId === 'a')!.parentId = 'bar';
  after.nodes.find(n => n.ref.nativeId === 'bar')!.childrenIds.push('a');
  after.nodes.find(n => n.ref.nativeId === 'left')!.childrenIds = [];
  localStorage.setItem(LANGUAGE_KEY, 'en');
  render(
    <LocaleProvider>
      <OrganizeFlowDetails proposal={proposal} after={after} />
    </LocaleProvider>,
  );
  expect(screen.getByText('→ 删除重复书签 · Bookmarks: 1')).toBeVisible();
  expect(screen.getByText('→ Delete duplicate bookmarks · Bookmarks: 1')).toBeVisible();
  expect(screen.getByText('Split across 2 destinations', { exact: false })).toBeVisible();
  fireEvent.click(screen.getByText('→ 删除重复书签 · Bookmarks: 1'));
  expect(screen.getByText('新增', { exact: true })).toBeVisible();
  switchLanguage('zh-CN');
  expect(screen.getAllByText('→ 删除重复书签 · 1 条书签')).toHaveLength(2);
  expect(screen.getByText('新增', { exact: true })).toBeVisible();
});

it('changes timing units without restarting its active clock and freezes elapsed time on pause', () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const pipeline: NonNullable<OrganizeState['pipeline']> = {
    stage: 'bookmarks',
    status: 'running',
    total: 4,
    completed: 2,
    elapsedMs: 59_000,
    activeSince: 1_000,
    batchSize: 2,
    folderCount: 2,
    batchCount: 2,
    finished: [],
    lockedActionIds: [],
  };
  const view = (value: typeof pipeline) => (
    <LocaleProvider>
      <OrganizeTiming pipeline={value} />
    </LocaleProvider>
  );
  const page = render(view(pipeline));
  expect(screen.getByLabelText('整理用时')).toHaveTextContent('已用时 59 秒');
  const timerCount = vi.getTimerCount();
  switchLanguage('en');
  expect(vi.getTimerCount()).toBe(timerCount);
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByLabelText('Organization time')).toHaveTextContent(
    'Elapsed: 1 min 0 s · About 1 min 0 s remaining',
  );
  page.rerender(view({ ...pipeline, elapsedMs: 60_000, activeSince: undefined, status: 'paused' }));
  act(() => vi.advanceTimersByTime(30_000));
  expect(screen.getByLabelText('Organization time')).toHaveTextContent(/^Elapsed: 1 min 0 s$/);
  switchLanguage('zh-CN');
  expect(screen.getByLabelText('整理用时')).toHaveTextContent(/^已用时 1 分 0 秒$/);
});
