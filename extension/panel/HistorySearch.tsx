import { useEffect, useMemo, useRef, useState } from 'react';
import { browserHistoryBoundary, HistoryReader } from '../adapters/browser-history';
import { browserModelAuthority } from '../adapters/model-authority';
import { searchModelAuthority } from '../adapters/search-model-authority';
import { ModelTransport } from '../adapters/model-transport';
import type { SettingsStore } from '../persistence/settings';
import type { AiServicesStore } from '../persistence/ai-services';
import { SiteRulesStore } from '../persistence/site-rules';
import { HistoryController, type HistorySearchState } from './history-controller';
import {
  HISTORY_DISPLAY_PAGE,
  historyRange,
  localDate,
  type HistoryPeriod,
  type HistoryRecord,
} from '../domain/history-search';
import { connectTree } from './tree-client';
import type { TreeSnapshot } from '../domain/node-reference';
import { SaveCard } from './SaveCard';
import { useI18n, type MessageKey } from '../ui/i18n';
import { BusyIndicator } from '../ui/BusyIndicator';
import { Select } from '../ui/Select';
import { AppWindow, BookmarkPlus, Copy, ExternalLink, RefreshCw, VenetianMask } from 'lucide-react';
import { BookmarkFavicon } from '../ui/BookmarkFavicon';
import { CommandMenu, type CommandMenuItem } from '../ui/CommandMenu';
import { openBookmarkUrl, type BookmarkOpenTarget } from '../domain/open-url';
import './search-results.css';
import './history-search.css';

const ERRORS: Record<string, MessageKey> = {
  'history-permission': '未授权历史访问，书签搜索仍可使用。',
  'history-denied': '未授权历史访问，书签搜索仍可使用。',
  'history-unavailable': '历史服务不可用，请重新打开智栏后重试。',
  'history-changed': '历史记录或权限已变化，结果已清空。请重新查询。',
  'history-timeout': '历史读取超时，请缩小时间范围后重试。',
  'invalid-date': '请选择有效的开始和结束日期。',
  'empty-range': '描述中的日期不在所选范围内，请调整时间范围。',
  'history-no-candidates': '未找到候选记录，请调整描述或时间范围。',
};
const INITIAL: HistorySearchState = {
  permission: false,
  loading: false,
  searching: false,
  consent: false,
  records: [],
  hits: [],
  limited: false,
  error: '',
};
export function HistorySearch({
  query,
  active,
  settings,
  services,
}: {
  query: string;
  active: boolean;
  settings?: SettingsStore;
  services?: AiServicesStore;
}) {
  const { t, language } = useI18n();
  const [state, setState] = useState(INITIAL);
  const [available, setAvailable] = useState(true);
  const [period, setPeriod] = useState<HistoryPeriod>('30');
  const [start, setStart] = useState(() => localDate(Date.now() - 30 * 86400000));
  const [end, setEnd] = useState(() => localDate(Date.now()));
  const [now, setNow] = useState(Date.now);
  const [shown, setShown] = useState(HISTORY_DISPLAY_PAGE);
  const [notice, setNotice] = useState<MessageKey>();
  const [snapshot, setSnapshot] = useState<TreeSnapshot>();
  const [connected, setConnected] = useState(false);
  const [saving, setSaving] = useState<HistoryRecord>();
  const [menuId, setMenuId] = useState<string>();
  const actionGeneration = useRef(0);
  const owner = useRef<HistoryController | undefined>(undefined);
  const [rules] = useState(() =>
    typeof chrome !== 'undefined' && chrome.storage?.local ? new SiteRulesStore(chrome.storage.local) : undefined,
  );
  const range = useMemo(() => {
    try {
      return historyRange(period, start, end, now);
    } catch {
      return undefined;
    }
  }, [period, start, end, now]);
  useEffect(() => {
    if (active) setNow(Date.now());
  }, [active, query]);
  useEffect(() => {
    const boundary = browserHistoryBoundary();
    if (!boundary) {
      setAvailable(false);
      return;
    }
    const reader = new HistoryReader(boundary);
    const base = settings ? searchModelAuthority(browserModelAuthority(settings), services) : undefined;
    const controller = new HistoryController(reader, setState, base);
    if (controller.authority)
      controller.attach(
        new ModelTransport(
          { fetch: (...args) => fetch(...args), contains: request => chrome.permissions.contains(request) },
          controller.authority,
        ),
      );
    owner.current = controller;
    const stopTree =
      typeof chrome.runtime?.connect === 'function'
        ? connectTree(chrome.runtime, tree => {
            setConnected(tree.status === 'ready');
            if (tree.status === 'ready') setSnapshot(tree.snapshot);
          })
        : undefined;
    return () => {
      actionGeneration.current++;
      stopTree?.();
      controller.dispose();
      owner.current = undefined;
    };
  }, [settings, services]);
  useEffect(() => {
    setShown(HISTORY_DISPLAY_PAGE);
    setNotice(undefined);
    setMenuId(undefined);
    actionGeneration.current++;
    if (range) owner.current?.configure(query, range, active);
    else owner.current?.configure(query, { startTime: 0, endTime: now + 1 }, false);
  }, [active, query, range, now, settings, services]);
  const duplicates = new Set(snapshot?.nodes.flatMap(node => (node.url ? [node.url] : [])));
  const hits = state.hits;
  async function act(record: HistoryRecord, action: BookmarkOpenTarget | 'copy' | 'save') {
    const generation = ++actionGeneration.current;
    setNotice(undefined);
    if (action === 'save' && saving) {
      setNotice('先完成或取消当前收藏草稿。');
      return;
    }
    if (!(await owner.current?.verify(record))) {
      if (generation === actionGeneration.current) setNotice('此记录已不存在或访问权限已撤销，请重新查询。');
      return;
    }
    if (generation !== actionGeneration.current) return;
    try {
      if (action === 'tab' || action === 'window' || action === 'incognito') await openBookmarkUrl(record.url, action);
      if (action === 'copy') {
        await navigator.clipboard.writeText(record.url);
        setNotice('已复制链接');
      }
      if (action === 'save') {
        if (connected && snapshot && rules) setSaving(record);
        else setNotice('书签连接恢复后可以收藏此网页。');
      }
    } catch {
      setNotice(
        action === 'copy'
          ? '链接复制失败，请重试。'
          : action === 'incognito'
            ? '无法打开无痕窗口，请检查浏览器的无痕设置或管理策略。'
            : action === 'window'
              ? '无法打开新窗口，请稍后重试。'
              : '无法打开新标签页，请稍后重试。',
      );
    }
  }
  return (
    <>
      <section
        hidden={!active}
        className="surface search-results history-search"
        aria-label={t('历史记录')}
        aria-busy={state.loading || state.searching}
      >
        <h2>{t('历史记录')}</h2>
        {!available ? (
          <p role="alert">{t('历史服务不可用，请重新打开智栏后重试。')}</p>
        ) : !state.permission ? (
          <>
            <button type="button" onClick={() => owner.current?.enable()}>
              {t('启用历史查询')}
            </button>
          </>
        ) : (
          <>
            <div className="history-toolbar">
              <Select
                aria-label={t('时间范围')}
                value={period}
                onChange={event => {
                  setPeriod(event.target.value as HistoryPeriod);
                  setNow(Date.now());
                }}
              >
                <option value="7">{t('近 7 天')}</option>
                <option value="30">{t('近 30 天')}</option>
                <option value="custom">{t('自定义日期')}</option>
                <option value="all">{t('全部可用历史')}</option>
              </Select>
              <button
                type="button"
                className="history-refresh"
                aria-label={t('查询历史')}
                title={t('查询历史')}
                disabled={!range || state.loading || state.searching}
                onClick={() => setNow(Date.now())}
              >
                <RefreshCw aria-hidden="true" />
              </button>
              <CommandMenu
                label={t('历史查询选项')}
                open={active && menuId === 'options'}
                onOpenChange={open => setMenuId(open ? 'options' : undefined)}
                items={[{ id: 'disable', label: t('关闭历史访问'), onSelect: () => owner.current?.disable() }]}
              />
            </div>
            {period === 'custom' && (
              <div className="history-filters">
                <label className="field">
                  {t('开始日期')}
                  <input
                    aria-label={t('开始日期')}
                    type="date"
                    value={start}
                    onChange={event => setStart(event.target.value)}
                  />
                </label>
                <label className="field">
                  {t('结束日期')}
                  <input
                    aria-label={t('结束日期')}
                    type="date"
                    value={end}
                    onChange={event => setEnd(event.target.value)}
                  />
                </label>
              </div>
            )}
            {!range && <p role="alert">{t('请选择有效的开始和结束日期。')}</p>}
            {query.trim() && (
              <div className="history-ai">
                <button
                  type="button"
                  disabled={!settings || !range || state.loading || state.searching || !connected}
                  onClick={() => {
                    owner.current?.consent(true);
                    void owner.current?.search();
                  }}
                >
                  {t('AI 查历史')}
                </button>
                {state.searching && (
                  <button type="button" onClick={() => owner.current?.cancel()}>
                    {t('取消 AI 搜索')}
                  </button>
                )}
              </div>
            )}
            {state.loading && <BusyIndicator label={t('正在读取历史…')} />}
            {state.searching && <BusyIndicator label={t('正在搜索历史…')} />}
            {state.aiCount !== undefined && (
              <p role="status">{t('已比较 {count} 条候选记录', { count: state.aiCount })}</p>
            )}
            {state.aiRange && (
              <p className="hint">
                {t('查询范围：{start} 至 {end}', {
                  start: localDate(state.aiRange.startTime),
                  end: localDate(state.aiRange.endTime - 1),
                })}
              </p>
            )}
            {!state.loading && !hits.length && <p role="status">{t('当前范围没有匹配记录。')}</p>}
            <ul className="bookmark-tree search-hit-list history-list">
              {hits.slice(0, shown).map(hit => {
                const title = hit.title || new URL(hit.url).hostname;
                const bookmarked = duplicates.has(hit.url);
                const description = `${new URL(hit.url).hostname} · ${new Date(hit.lastVisitTime).toLocaleString(language)}${bookmarked ? ` · ${t('已收藏')}` : ''}`;
                const commands: CommandMenuItem[] = [
                  {
                    id: 'tab',
                    label: t('在新标签页打开'),
                    icon: <ExternalLink aria-hidden="true" />,
                    onSelect: () => void act(hit, 'tab'),
                  },
                  {
                    id: 'window',
                    label: t('在新窗口中打开'),
                    icon: <AppWindow aria-hidden="true" />,
                    onSelect: () => void act(hit, 'window'),
                  },
                  {
                    id: 'incognito',
                    label: t('在无痕窗口中打开'),
                    icon: <VenetianMask aria-hidden="true" />,
                    onSelect: () => void act(hit, 'incognito'),
                  },
                  {
                    id: 'copy',
                    label: t('复制链接'),
                    icon: <Copy aria-hidden="true" />,
                    separatorBefore: true,
                    onSelect: () => void act(hit, 'copy'),
                  },
                  {
                    id: 'save',
                    label: t(bookmarked ? '已收藏' : '收藏此网页'),
                    icon: <BookmarkPlus aria-hidden="true" />,
                    disabled: bookmarked || !connected || !!saving,
                    disabledReason: bookmarked
                      ? t('已收藏')
                      : saving
                        ? t('先完成或取消当前收藏草稿。')
                        : t('书签连接恢复后可以收藏此网页。'),
                    onSelect: () => void act(hit, 'save'),
                  },
                ];
                return (
                  <li
                    key={hit.url}
                    className="bookmark-row is-bookmark"
                    onContextMenu={event => {
                      event.preventDefault();
                      setMenuId(hit.id);
                    }}
                    onKeyDown={event => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        setMenuId(hit.id);
                      }
                    }}
                  >
                    <button
                      type="button"
                      className="search-hit-open"
                      onClick={() => void act(hit, 'tab')}
                      title={`${title}\n${description}`}
                    >
                      <BookmarkFavicon url={hit.url} />
                      <span>{title}</span>
                    </button>
                    <CommandMenu
                      label={t('{title} 操作', { title })}
                      items={commands}
                      description={description}
                      open={active && menuId === hit.id}
                      onOpenChange={open =>
                        setMenuId(current => (open ? hit.id : current === hit.id ? undefined : current))
                      }
                    />
                  </li>
                );
              })}
            </ul>
            {hits.length > shown && (
              <button type="button" onClick={() => setShown(value => value + HISTORY_DISPLAY_PAGE)}>
                {t('显示更多结果')}
              </button>
            )}
            {state.limited && (
              <>
                <button
                  type="button"
                  disabled={state.loading || state.searching}
                  onClick={() => void owner.current?.load(true)}
                >
                  {t('继续读取历史')}
                </button>
              </>
            )}
          </>
        )}
        {state.error && (
          <p role="alert">{t(ERRORS[state.error] ?? 'AI 历史查询未完成，已保留本地结果。请检查模型配置后重试。')}</p>
        )}
        {notice && <p role="status">{t(notice)}</p>}
      </section>
      {saving && snapshot && rules && (
        <SaveCard
          source="history"
          page={saving}
          snapshot={snapshot}
          connectionReady={connected}
          settings={settings}
          aiServices={services}
          rulesStore={rules}
          onClose={() => setSaving(undefined)}
        />
      )}
    </>
  );
}
