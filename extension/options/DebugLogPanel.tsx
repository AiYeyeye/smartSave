import { useEffect, useState } from 'react';
import { Copy, RefreshCw, Trash2 } from 'lucide-react';
import {
  clearDebugTrail,
  DEBUG_SETTINGS_KEY,
  DEBUG_TRAIL_KEY,
  readDebugSettings,
  readDebugTrail,
  writeDebugSettings,
  type DebugEntry,
} from '../domain/debug-log';
import { ReceiptView, useSaveReceipts } from '../panel/SaveReceiptCard';
import { summarizeSaveTimings } from '../domain/save-performance';
import { useI18n } from '../ui/i18n';

function time(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function detailText(entry: DebugEntry, includeBody = true) {
  if (!entry.detail) return '';
  return Object.entries(entry.detail)
    .filter(([key, value]) => (includeBody || key !== 'body') && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('  ');
}

function tone(entry: DebugEntry) {
  const status = entry.detail?.status;
  if (status === 'failed' || entry.event.includes('fail') || entry.event === 'error') return ' is-fail';
  if (status === 'completed' || entry.event === 'completed') return ' is-ok';
  return '';
}

/** Recent native-save receipts: the answer to "did AI run, and where did it put my bookmark?". */
export function SaveHistory({ onOpen }: { onOpen: (route: string) => void }) {
  const { t } = useI18n();
  const receipts = useSaveReceipts();
  return (
    <section className="surface" aria-label={t('收藏记录')}>
      <h2>{t('最近的原生收藏')}</h2>
      <p className="hint">
        {t('在浏览器里点星标或 Ctrl+D 收藏后，智栏的处理结果会记录在这里（最多 30 条，仅保存在本机）。')}
      </p>
      {receipts.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          {t('还没有记录。收藏一个网页试试。')}
        </p>
      ) : (
        <ul className="receipt-table">
          {receipts.map((receipt, index) => (
            <li key={receipt.id}>
              <ReceiptView receipt={receipt} onOpen={onOpen} compact={index > 0 && receipt.status !== 'moved'} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Settings → Debug: opt-in call trail for AI requests and background classification. */
export function DebugLogPanel() {
  const { t } = useI18n();
  const timings = summarizeSaveTimings(useSaveReceipts());
  const [enabled, setEnabled] = useState(false);
  const [entries, setEntries] = useState<DebugEntry[]>([]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void readDebugSettings().then(value => setEnabled(value.enabled));
    void readDebugTrail().then(setEntries);
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (Object.hasOwn(changes, DEBUG_TRAIL_KEY)) {
        const next = changes[DEBUG_TRAIL_KEY]?.newValue;
        setEntries(Array.isArray(next) ? (next as DebugEntry[]) : []);
      }
      if (Object.hasOwn(changes, DEBUG_SETTINGS_KEY)) {
        const next = changes[DEBUG_SETTINGS_KEY]?.newValue as { enabled?: unknown } | undefined;
        setEnabled(next?.enabled === true);
      }
    };
    const changes = chrome.storage.onChanged;
    changes.addListener(onChanged);
    return () => changes.removeListener(onChanged);
  }, []);

  const newestFirst = [...entries].reverse();

  async function copy() {
    const text = entries
      .map(entry => `${new Date(entry.t).toISOString()} [${entry.src}] ${entry.event} ${detailText(entry)}`)
      .join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="surface" aria-label={t('Debug 日志')}>
      <div className="debug-head">
        <div>
          <h2>{t('Debug 日志')}</h2>
          <p>
            {t(
              '开启后记录 AI 请求、脱敏后的请求与响应正文、状态码和解析过程。仅保存在本机，不记录密钥；正文可能包含书签标题和网址，分享前请检查。单份正文最多 65536 字符，日志总量最多 1 MiB。',
            )}
          </p>
        </div>
        <label className="switch" title={enabled ? t('已开启') : t('已关闭')}>
          <input
            type="checkbox"
            role="switch"
            aria-label={t('开启 Debug 日志')}
            checked={enabled}
            onChange={event => {
              setEnabled(event.target.checked);
              void writeDebugSettings({ enabled: event.target.checked });
            }}
          />
          <span />
        </label>
      </div>
      <section aria-label={t('收藏耗时统计')}>
        <h3>{t('收藏耗时统计')}</h3>
        <p className="hint">
          {t(
            '最近 30 条本机记录，按连接和模型统计成功收藏；失败单独计数。总耗时包含收藏后的等待。非流式响应无法拆分首字与生成耗时。',
          )}
        </p>
        {timings.length === 0 && <p className="hint">{t('收藏网页后会显示耗时，不需要开启 Debug 日志。')}</p>}
        {timings.map(row => (
          <div key={row.model}>
            <strong>{row.model}</strong>
            <p>{t('成功 {completed} 条 · 失败 {failed} 条', { completed: row.completed, failed: row.failed })}</p>
            {(
              [
                ['总耗时', row.total],
                ['等首字', row.firstToken],
                ['生成', row.generation],
                ['校验与写入', row.validationApply],
                ['旧记录（不含前置等待）', row.legacy],
              ] as const
            ).map(
              ([label, value]) =>
                value && (
                  <p className="hint" key={label}>
                    {t('{label}：中位 {median} 秒 · P90 {p90} 秒（{count} 条）', {
                      label: t(label),
                      median: (value.median / 1000).toFixed(2),
                      p90: (value.p90 / 1000).toFixed(2),
                      count: value.count,
                    })}
                  </p>
                ),
            )}
          </div>
        ))}
      </section>
      <div className="actions">
        <button type="button" onClick={() => void readDebugTrail().then(setEntries)}>
          <RefreshCw aria-hidden="true" />
          {t('刷新')}
        </button>
        <button type="button" onClick={() => void copy()} disabled={!entries.length}>
          <Copy aria-hidden="true" />
          {copied ? t('已复制') : t('复制全部')}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void clearDebugTrail().then(() => setEntries([]))}
          disabled={!entries.length}
        >
          <Trash2 aria-hidden="true" />
          {t('清空')}
        </button>
      </div>
      {newestFirst.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          {enabled
            ? t('已开启，暂无记录。收藏一个网页或测试一次连接试试。')
            : t('默认关闭。开启后，新的调用会出现在这里（最多 400 条）。')}
        </p>
      ) : (
        <ol className="debug-list" aria-label={t('调用轨迹')}>
          {newestFirst.map((entry, index) => (
            <li key={`${entry.t}-${index}`}>
              <time>{time(entry.t)}</time>
              <span className="debug-src">{entry.src}</span>
              <span className={`debug-event${tone(entry)}`}>{entry.event}</span>
              <div className="debug-detail">
                <span>{detailText(entry, false)}</span>
                {typeof entry.detail?.body === 'string' && (
                  <details>
                    <summary>
                      {t(entry.event === 'request-body' ? '查看请求正文' : '查看响应正文')}
                      {entry.detail.truncated ? t('（已截断）') : ''}
                    </summary>
                    <pre>{entry.detail.body}</pre>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
