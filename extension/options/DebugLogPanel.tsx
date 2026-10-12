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

function time(t: number) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function detailText(entry: DebugEntry) {
  if (!entry.detail) return '';
  return Object.entries(entry.detail)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
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
  const receipts = useSaveReceipts();
  return (
    <section className="surface" aria-label="收藏记录">
      <h2>最近的原生收藏</h2>
      <p className="hint">在浏览器里点星标或 Ctrl+D 收藏后，智栏的处理结果会记录在这里（最多 30 条，仅保存在本机）。</p>
      {receipts.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          还没有记录。收藏一个网页试试。
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
    <section className="surface" aria-label="Debug 日志">
      <div className="debug-head">
        <div>
          <h2>Debug 日志</h2>
          <p>记录每次 AI 调用的路由、耗时、状态码和后台收藏分类的每一步；不记录密钥、请求正文或网页内容。</p>
        </div>
        <label className="switch" title={enabled ? '已开启' : '已关闭'}>
          <input
            type="checkbox"
            role="switch"
            aria-label="开启 Debug 日志"
            checked={enabled}
            onChange={event => {
              setEnabled(event.target.checked);
              void writeDebugSettings({ enabled: event.target.checked });
            }}
          />
          <span />
        </label>
      </div>
      <div className="actions">
        <button type="button" onClick={() => void readDebugTrail().then(setEntries)}>
          <RefreshCw aria-hidden="true" />
          刷新
        </button>
        <button type="button" onClick={() => void copy()} disabled={!entries.length}>
          <Copy aria-hidden="true" />
          {copied ? '已复制' : '复制全部'}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => void clearDebugTrail().then(() => setEntries([]))}
          disabled={!entries.length}
        >
          <Trash2 aria-hidden="true" />
          清空
        </button>
      </div>
      {newestFirst.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          {enabled
            ? '已开启，暂无记录。收藏一个网页或测试一次连接试试。'
            : '默认关闭。开启后，新的调用会出现在这里（最多 400 条）。'}
        </p>
      ) : (
        <ol className="debug-list" aria-label="调用轨迹">
          {newestFirst.map((entry, index) => (
            <li key={`${entry.t}-${index}`}>
              <time>{time(entry.t)}</time>
              <span className="debug-src">{entry.src}</span>
              <span className={`debug-event${tone(entry)}`}>{entry.event}</span>
              <span className="debug-detail">{detailText(entry)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
