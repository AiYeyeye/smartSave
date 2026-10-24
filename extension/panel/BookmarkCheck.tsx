import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleHelp, ExternalLink, House } from 'lucide-react';
import { useI18n, type MessageKey } from '../ui/i18n';
import { Select } from '../ui/Select';
import { ImpactConfirmDialog } from '../ui/ImpactConfirmDialog';
import { connectTree } from './tree-client';
import { DuplicateReview } from './DuplicateReview';
import { MutationFeedback } from './BookmarkActions';
import { submitMutation, type SendMutation } from './mutation-client';
import { sendBookmarkCheck, requestCheckPermission, type CheckClient } from './bookmark-check-client';
import {
  checkedDuplicateDeletions,
  checkScopeNodes,
  compileCheckDeletion,
  currentCheckResults,
  linkCategory,
  type LinkCategory,
  type BookmarkCheckState,
  type BookmarkCheckMessage,
  type LinkResult,
} from '../domain/bookmark-check';
import { groupDuplicateNodes } from '../domain/suspected-duplicates';
import type { DuplicateChoice } from '../domain/exact-duplicates';
import type { TreeSnapshot } from '../domain/node-reference';
import { organizePaths } from '../domain/organize-review';
import { preflight, sameNode } from '../domain/preflight';
import { canOpenUrl, openBookmarkUrl } from '../domain/open-url';
import type { ConfirmMutation, MutationResult } from '../schemas/messages';

const errors: Record<string, MessageKey> = {
  'permission-required': '请先允许访问网站，再开始检查。',
  'storage-unavailable': '无法保存检查进度，已停止。',
  'invalid-scope': '目录已不存在，请重新选择范围。',
  'scope-too-large': '书签数量过多，请选择较小的目录。',
  'already-running': '已有检查正在运行。',
  'installation-changed': '检查的浏览器身份已变化，请重新选择范围。',
  'schedule-unavailable': '无法设置自动检查，请重试。',
  'keep-required': '请先为每组选择至少一项保留。',
  'stale-selection': '书签有变化，请清除选择后重新核对。',
};
const resultLabels = { ok: '可访问', broken: '页面未找到', review: '未能判断', skipped: '已跳过' } as const;
const categoryLabels = {
  site: '网站无法连接',
  missing: '页面未找到',
  restricted: '登录或访问限制',
  redirect: '链接跳转',
  temporary: '临时异常',
  unknown: '未能判断',
  ok: '可访问',
  skipped: '已跳过',
} as const;
const pageCategories: LinkCategory[] = ['missing', 'restricted', 'redirect', 'temporary'];
const reasonLabels = {
  network: '连接失败',
  timeout: '请求超时',
  redirect: '网页已跳转',
  unsupported: '不支持的网址',
  restricted: '本机或内网地址',
  changed: '书签已变化',
  manual: '已手动确认',
} as const;
function resultReason(value: LinkResult): MessageKey {
  if (value.reason !== 'http') return reasonLabels[value.reason];
  if (value.code === 401) return '需要登录';
  if (value.code === 403) return '拒绝检测';
  if (value.code === 429) return '访问限流';
  if (value.code && value.code >= 500) return '服务暂不可用';
  return resultLabels[value.status];
}
type Filter = 'all' | LinkCategory;

export function BookmarkCheck({
  visible = true,
  client = sendBookmarkCheck,
  permission = requestCheckPermission,
  send,
  onRecovery,
}: {
  visible?: boolean;
  client?: CheckClient;
  permission?: () => Promise<boolean>;
  send?: SendMutation;
  onRecovery: () => void;
}) {
  const { t, language } = useI18n();
  const [tree, setTree] = useState<TreeSnapshot>();
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState<BookmarkCheckState>();
  const [tab, setTab] = useState<'links' | 'duplicates'>('links');
  const [group, setGroup] = useState<'site' | 'pages' | 'all'>('site');
  const [filter, setFilter] = useState<Filter>('all');
  const [limit, setLimit] = useState(50);
  const [busy, setBusy] = useState(false);
  const [weeklyDraft, setWeeklyDraft] = useState<boolean>();
  const [error, setError] = useState<MessageKey>();
  const [choices, setChoices] = useState<Record<string, DuplicateChoice>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const baselines = useRef(new Map<string, TreeSnapshot['nodes'][number]>());
  const [preview, setPreview] = useState<ConfirmMutation>();
  const [result, setResult] = useState<MutationResult>();
  const [deleting, setDeleting] = useState(false);
  const lock = useRef(false);
  const commandLock = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const accept = useCallback((next: BookmarkCheckState) => {
    if (live.current) setState(old => (!old || next.revision >= old.revision ? next : old));
  }, []);
  useEffect(
    () =>
      connectTree(chrome.runtime, next => {
        setConnected(next.status === 'ready');
        if (next.status === 'ready') setTree(next.snapshot);
      }),
    [],
  );
  useEffect(() => {
    if (!visible) return;
    let active = true,
      pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      void client({ type: 'bookmarkCheck', action: 'get' })
        .then(next => {
          if (active) {
            accept(next);
            setError(old => (old === '检查暂不可用，请重试。' ? undefined : old));
          }
        })
        .catch(() => {
          if (active) setError('检查暂不可用，请重试。');
        })
        .finally(() => {
          pending = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [visible, client, accept]);
  const scopeId = state?.scopeId ?? null;
  const paths = useMemo(() => (tree ? organizePaths(tree) : new Map<string, string>()), [tree]);
  const nodes = useMemo(() => {
    try {
      return tree ? checkScopeNodes(tree, scopeId) : [];
    } catch {
      return [];
    }
  }, [tree, scopeId]);
  const groups = useMemo(() => groupDuplicateNodes(nodes), [nodes]);
  const checked = useMemo(
    () => (tree && state ? currentCheckResults(tree, state) : new Map<string, LinkResult>()),
    [tree, state],
  );
  const rows = useMemo(
    () =>
      nodes
        .filter(node => {
          const value = checked.get(node.ref.nativeId);
          if (!value) return false;
          const category = linkCategory(value);
          return (
            (group === 'all' || (group === 'site' ? category === 'site' : pageCategories.includes(category))) &&
            (filter === 'all' || category === filter)
          );
        })
        .sort((a, b) => {
          const order = {
            site: 0,
            missing: 1,
            restricted: 2,
            redirect: 3,
            temporary: 4,
            unknown: 5,
            skipped: 6,
            ok: 7,
          };
          return order[linkCategory(checked.get(a.ref.nativeId)!)] - order[linkCategory(checked.get(b.ref.nativeId)!)];
        }),
    [nodes, checked, filter, group],
  );
  const counts = { site: 0, pages: 0, all: 0, unknown: 0 };
  for (const node of nodes) {
    const value = checked.get(node.ref.nativeId);
    if (!value) continue;
    counts.all++;
    const category = linkCategory(value);
    if (category === 'site') counts.site++;
    else if (pageCategories.includes(category)) counts.pages++;
    else if (category === 'unknown') counts.unknown++;
  }
  const running = state?.job?.status === 'running';
  const uncertain =
    !!result && result.status !== 'completed' && (result.needsReconcile || result.status !== 'rejected');
  const disabled = busy || deleting || !!preview || uncertain || !connected;
  const selectedCount =
    tab === 'links' ? selected.size : Object.values(choices).filter(choice => choice === 'delete').length;
  function clearSelection() {
    setSelected(new Set());
    setChoices({});
    baselines.current.clear();
    setError(undefined);
  }
  async function command(message: BookmarkCheckMessage, grant?: Promise<boolean>) {
    if (commandLock.current) return;
    commandLock.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (grant && !(await grant)) throw Error('permission-required');
      const next = await client(message);
      accept(next);
      if (message.action === 'verify')
        setSelected(old => {
          const next = new Set(old);
          next.delete(message.nativeId);
          return next;
        });
      if (message.action === 'configure' && scopeId !== message.scopeId) clearSelection();
    } catch (error) {
      if (live.current) setError(errors[error instanceof Error ? error.message : ''] ?? '检查暂不可用，请重试。');
    } finally {
      commandLock.current = false;
      if (live.current) setBusy(false);
    }
  }
  function remember(id: string) {
    const node = tree?.nodes.find(node => node.ref.nativeId === id);
    if (node) baselines.current.set(id, structuredClone(node));
  }
  function chooseLink(id: string, value: boolean) {
    remember(id);
    setSelected(old => {
      const next = new Set(old);
      if (value) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function prepareDelete() {
    if (!tree || disabled || lock.current) return;
    setError(undefined);
    setResult(undefined);
    try {
      const ids = tab === 'links' ? [...selected] : checkedDuplicateDeletions(nodes, choices);
      if (ids.length > 500) {
        setError('一次最多删除 500 项，请减少选择。');
        return;
      }
      const reviewed = tab === 'links' ? ids : Object.keys(choices).filter(id => choices[id] !== 'unselected');
      if (
        reviewed.some(id => {
          const before = baselines.current.get(id),
            current = tree.nodes.find(node => node.ref.nativeId === id);
          return !before || !current || !sameNode(before, current);
        }) ||
        (tab === 'links' && ids.some(id => !['broken', 'review'].includes(checked.get(id)?.status ?? '')))
      )
        throw Error('stale-selection');
      setPreview(compileCheckDeletion(tree, scopeId, ids));
    } catch (error) {
      setError(errors[error instanceof Error ? error.message : ''] ?? '书签有变化，请清除选择后重新核对。');
    }
  }
  let stale = false;
  if (preview && tree) {
    try {
      preflight(preview, tree);
    } catch {
      stale = true;
    }
  }
  async function confirmDelete() {
    if (!preview || !tree || stale || !connected || lock.current) return;
    lock.current = true;
    setDeleting(true);
    const outcome = await submitMutation(preview, send);
    if (!live.current) return;
    setPreview(undefined);
    setDeleting(false);
    setResult(outcome.status === 'completed' ? undefined : outcome);
    if (outcome.status === 'completed' || (outcome.status === 'rejected' && !outcome.needsReconcile)) {
      lock.current = false;
      clearSelection();
    }
  }
  const job = state?.job;
  const done = job?.items.filter(item => item.result).length ?? 0;
  const date = (value: number) =>
    new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short' }).format(value);
  const scopeOptions = tree?.nodes.filter(node => node.ref.kind === 'folder' && node.parentId !== undefined) ?? [];
  const notice = error ?? (state?.notice ? (errors[state.notice] ?? '检查暂不可用，请重试。') : undefined);
  return (
    <section className="bookmark-check" aria-label={t('书签检查')}>
      <div className="check-toolbar">
        <label className="check-scope">
          {t('检查范围')}
          <Select
            aria-label={t('检查范围')}
            value={scopeId ?? ''}
            disabled={disabled || running || !state || !tree}
            onChange={event => {
              if (tree && state)
                void command({
                  type: 'bookmarkCheck',
                  action: 'configure',
                  installationId: tree.installationId,
                  scopeId: event.target.value || null,
                  weekly: state.weekly,
                });
            }}
          >
            <option value="">{t('全部书签')}</option>
            {scopeOptions.map(node => (
              <option key={node.ref.nativeId} value={node.ref.nativeId}>
                {paths.get(node.ref.nativeId) || node.title}
              </option>
            ))}
          </Select>
        </label>
        <label className="check-weekly">
          <input
            type="checkbox"
            checked={weeklyDraft ?? state?.weekly ?? false}
            disabled={disabled || !tree || !state}
            onChange={event => {
              if (tree) {
                setWeeklyDraft(event.target.checked);
                void command(
                  {
                    type: 'bookmarkCheck',
                    action: 'configure',
                    installationId: tree.installationId,
                    scopeId,
                    weekly: event.target.checked,
                  },
                  event.target.checked ? permission() : undefined,
                ).finally(() => setWeeklyDraft(undefined));
              }
            }}
          />
          {t('每周自动检查')}
        </label>
        <details className="check-help">
          <summary title={t('帮助')} aria-label={t('帮助')}>
            <CircleHelp aria-hidden="true" />
          </summary>
          <div>
            <p>{t('优先检查整个网站是否有响应。收藏页异常单独分类，404、登录限制和跳转不代表网站失效。')}</p>
            <p>{t('网站无法连接仍可能是临时网络问题；无法自动确认永久关闭或迁站。只读响应状态，不读取正文。')}</p>
            <p>{t('能正常打开的链接可手动确认，后续检查会跳过；可在全部结果中恢复检查。')}</p>
            <p>{t('每周检查所选范围；浏览器重新运行后补查。不会自动删除收藏。')}</p>
            <p>{t('重复收藏在本机比较。疑似重复需核对原始链接，每组至少保留一项。')}</p>
          </div>
        </details>
      </div>
      <div className="check-tabs" role="tablist" aria-label={t('书签检查')}>
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'links'}
          onClick={() => {
            setTab('links');
            setLimit(50);
          }}
        >
          {t('失效链接')}
        </button>
        <button
          role="tab"
          type="button"
          aria-selected={tab === 'duplicates'}
          onClick={() => {
            setTab('duplicates');
            setLimit(50);
          }}
        >
          {t('重复收藏')}
          <span>{groups.length}</span>
        </button>
      </div>
      {notice && (
        <p className="check-error" role="alert">
          {t(notice)}
        </p>
      )}
      <div role="tabpanel" aria-label={t(tab === 'links' ? '失效链接' : '重复收藏')}>
        {tab === 'links' && (
          <>
            <div className="check-categories" role="group" aria-label={t('结果分类')}>
              {(['site', 'pages', 'all'] as const).map(key => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={group === key}
                  onClick={() => {
                    setGroup(key);
                    setFilter('all');
                    setLimit(50);
                  }}
                >
                  {t(key === 'site' ? '网站无法连接' : key === 'pages' ? '收藏页异常' : '全部结果')}
                  <span>{counts[key]}</span>
                </button>
              ))}
            </div>
            <div className="check-runbar">
              {group !== 'site' && (
                <Select
                  aria-label={t('检查结果')}
                  value={filter}
                  onChange={event => {
                    setFilter(event.target.value as Filter);
                    setLimit(50);
                  }}
                >
                  <option value="all">{t(group === 'pages' ? '全部页面异常' : '全部结果')}</option>
                  {Object.entries(categoryLabels)
                    .filter(([value]) => group === 'all' || pageCategories.includes(value as LinkCategory))
                    .map(([value, label]) => (
                      <option key={value} value={value}>
                        {t(label)}
                      </option>
                    ))}
                </Select>
              )}
              {running ? (
                <button disabled={busy} onClick={() => void command({ type: 'bookmarkCheck', action: 'pause' })}>
                  {t('暂停检查')}
                </button>
              ) : job && ['paused', 'error'].includes(job.status) ? (
                <button
                  className="primary"
                  disabled={disabled || !state}
                  onClick={() => void command({ type: 'bookmarkCheck', action: 'resume' }, permission())}
                >
                  {t('继续检查')}
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={disabled || !tree || !state}
                  onClick={() => {
                    if (tree)
                      void command(
                        { type: 'bookmarkCheck', action: 'start', installationId: tree.installationId, scopeId },
                        permission(),
                      );
                  }}
                >
                  {t(job ? '重新检查' : '立即检查')}
                </button>
              )}
            </div>
            {job && (
              <div className="check-progress">
                <span role="status">
                  {job.status === 'paused'
                    ? t('检查已暂停')
                    : t('已检查 {done} / {total}', { done, total: job.items.length })}
                </span>
                {running && <progress aria-label={t('检查')} max={job.items.length || 1} value={done} />}
              </div>
            )}
            <div className="check-results">
              {rows.slice(0, limit).map(node => {
                const value = checked.get(node.ref.nativeId)!;
                const category = linkCategory(value);
                const detail = value.reason === 'http' ? `HTTP ${value.code}` : t(reasonLabels[value.reason]);
                return (
                  <article className="check-row" key={node.ref.nativeId}>
                    <input
                      type="checkbox"
                      aria-label={t('选择收藏：{title}', { title: node.title })}
                      checked={selected.has(node.ref.nativeId)}
                      disabled={disabled || node.readOnly || !['broken', 'review'].includes(value.status)}
                      onChange={event => chooseLink(node.ref.nativeId, event.target.checked)}
                    />
                    <div className="check-link">
                      <strong title={node.title}>{node.title || node.url}</strong>
                      <small title={node.url}>{node.url}</small>
                      <small title={paths.get(node.ref.nativeId)}>{paths.get(node.ref.nativeId)}</small>
                    </div>
                    <div className="check-verdict">
                      <span className={`check-status is-${category}`} title={`${detail} · ${date(value.at)}`}>
                        {t(
                          category === 'site'
                            ? '网站无法连接'
                            : category === 'unknown'
                              ? '未能判断'
                              : value.status === 'review' || value.reason === 'manual'
                                ? resultReason(value)
                                : resultLabels[value.status],
                        )}
                        {value.status === 'broken' && <small>HTTP {value.code}</small>}
                      </span>
                      {(['broken', 'review'].includes(value.status) || value.reason === 'manual') && (
                        <button
                          className="check-verify"
                          disabled={disabled}
                          onClick={() => {
                            if (tree)
                              void command({
                                type: 'bookmarkCheck',
                                action: 'verify',
                                installationId: tree.installationId,
                                nativeId: node.ref.nativeId,
                                url: node.url!,
                                available: value.reason !== 'manual',
                              });
                          }}
                        >
                          {t(value.reason === 'manual' ? '恢复检查' : '我能打开')}
                        </button>
                      )}
                    </div>
                    <div className="check-open-actions">
                      <button
                        className="check-open"
                        aria-label={t('打开 {title}', { title: node.title })}
                        title={t('打开')}
                        disabled={!canOpenUrl(node.url)}
                        onClick={() => {
                          if (node.url)
                            void openBookmarkUrl(node.url, 'tab').catch(() => setError('检查暂不可用，请重试。'));
                        }}
                      >
                        <ExternalLink aria-hidden="true" />
                      </button>
                      {['broken', 'review'].includes(value.status) && (
                        <button
                          className="check-open"
                          title={t('打开网站首页')}
                          aria-label={t('打开网站首页：{title}', { title: node.title })}
                          onClick={() => {
                            if (node.url)
                              void openBookmarkUrl(new URL('/', node.url).href, 'tab').catch(() =>
                                setError('检查暂不可用，请重试。'),
                              );
                          }}
                        >
                          <House aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
            {!rows.length && (
              <p className="check-empty">
                {t(
                  !job
                    ? '尚未检查'
                    : group === 'site'
                      ? counts.unknown
                        ? '部分结果尚未核对网站，请重新检查。'
                        : '暂无无法连接的网站'
                      : '没有匹配的检查结果',
                )}
              </p>
            )}
            {rows.length > limit && <button onClick={() => setLimit(value => value + 50)}>{t('显示更多结果')}</button>}
          </>
        )}
        {tab === 'duplicates' && (
          <>
            <DuplicateReview
              compact
              groups={groups.slice(0, limit)}
              choices={choices}
              paths={paths}
              disabled={disabled}
              onChoice={(id, choice) => {
                remember(id);
                setChoices(old => ({ ...old, [id]: choice }));
                setError(undefined);
              }}
            />
            {!groups.length && <p className="check-empty">{t('未发现重复收藏')}</p>}
            {groups.length > limit && (
              <button onClick={() => setLimit(value => value + 50)}>{t('显示更多结果')}</button>
            )}
          </>
        )}
      </div>
      <div className="check-actions">
        {tab === 'links' &&
          rows.some(
            node => !node.readOnly && ['broken', 'review'].includes(checked.get(node.ref.nativeId)!.status),
          ) && (
            <button
              disabled={disabled}
              onClick={() => {
                for (const node of rows.slice(0, limit))
                  if (!node.readOnly && ['broken', 'review'].includes(checked.get(node.ref.nativeId)!.status))
                    chooseLink(node.ref.nativeId, true);
              }}
            >
              {t('选择本页')}
            </button>
          )}
        {(selectedCount > 0 || Object.values(choices).some(value => value !== 'unselected')) && (
          <button disabled={deleting} onClick={clearSelection}>
            {t('清除选择')}
          </button>
        )}
        {selectedCount > 0 && (
          <button className="danger" disabled={disabled} onClick={prepareDelete}>
            {t('删除所选 {count} 项', { count: selectedCount })}
          </button>
        )}
      </div>
      {result && (
        <div className="check-error">
          <MutationFeedback result={result} />
          {uncertain && <button onClick={onRecovery}>{t('查看恢复记录')}</button>}
        </div>
      )}
      {(state?.nextRun || job?.status === 'completed') && (
        <small className="check-date">
          {state?.nextRun
            ? t('下次检查：{date}', { date: date(state.nextRun) })
            : job && t('上次检查：{date}', { date: date(job.updatedAt) })}
        </small>
      )}
      {preview && (
        <ImpactConfirmDialog
          onCancel={() => setPreview(undefined)}
          onConfirm={() => void confirmDelete()}
          disabled={stale || !connected}
          busy={deleting}
        >
          <p>
            {t('将删除 {count} 条收藏', {
              count: preview.command.type === 'batch' ? preview.command.operations.length : 0,
            })}
          </p>
          <ul className="check-delete-list">
            {preview.command.type === 'batch' &&
              preview.command.operations.map(operation => {
                const id = 'target' in operation.command ? operation.command.target.nativeId : '';
                return <li key={id}>{preview.before.find(node => node.ref.nativeId === id)?.title}</li>;
              })}
          </ul>
          {stale && <p role="alert">{t('书签有变化，请清除选择后重新核对。')}</p>}
        </ImpactConfirmDialog>
      )}
    </section>
  );
}
