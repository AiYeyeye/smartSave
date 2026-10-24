import { useI18n } from '../ui/i18n';
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, CornerUpLeft, Loader, Minus, X } from 'lucide-react';
import { readSaveReceipts, receiptReasonText, SAVE_RECEIPTS_KEY, type SaveReceipt } from '../persistence/save-receipts';
import { SaveCorrection } from './SaveCorrection';

const SEEN_KEY = 'nativeSaveReceiptSeen';
/** Only recent saves surface in the popup; older ones live in the options page history. */
const FRESH_MS = 30 * 60 * 1000;

function localArea() {
  return typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : undefined;
}

/** Live list of native-save receipts (newest first). */
export function useSaveReceipts() {
  const [receipts, setReceipts] = useState<SaveReceipt[]>([]);
  useEffect(() => {
    const storage = localArea();
    if (!storage) return;
    let live = true;
    let revision = 0;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !Object.hasOwn(changes, SAVE_RECEIPTS_KEY)) return;
      revision++;
      const next = changes[SAVE_RECEIPTS_KEY]?.newValue;
      setReceipts(Array.isArray(next) ? (next as SaveReceipt[]) : []);
    };
    const changes = chrome.storage.onChanged;
    changes.addListener(onChanged);
    const initialRevision = revision;
    void readSaveReceipts(storage).then(list => {
      if (live && revision === initialRevision) setReceipts(list);
    });
    return () => {
      live = false;
      changes.removeListener(onChanged);
    };
  }, []);
  return receipts;
}

function ago(at: number, language: 'zh-CN' | 'en') {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return language === 'en' ? 'Just now' : '刚刚';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60)
    return language === 'en' ? new Intl.RelativeTimeFormat('en').format(-minutes, 'minute') : `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24)
    return language === 'en' ? new Intl.RelativeTimeFormat('en').format(-hours, 'hour') : `${hours} 小时前`;
  return new Date(at).toLocaleDateString(language);
}

const CONFIG_REASONS = new Set(['save-feature-unconfigured', 'service-missing', 'no-key', 'http-401', 'http-403']);

export function ReceiptView({
  receipt,
  onDismiss,
  onOpen,
  onInteract,
  compact = false,
}: {
  receipt: SaveReceipt;
  onDismiss?: () => void;
  onOpen?: (route: string) => void;
  onInteract?: () => void;
  compact?: boolean;
}) {
  const { t, message: localize, language } = useI18n();
  const [undoState, setUndoState] = useState<'idle' | 'busy' | string>('idle');
  const [correcting, setCorrecting] = useState(false);
  const tone =
    receipt.status === 'moved' || receipt.status === 'kept'
      ? 'ok'
      : receipt.status === 'classifying'
        ? 'busy'
        : receipt.status === 'undone'
          ? 'neutral'
          : 'warn';
  const Icon = tone === 'ok' ? Check : tone === 'busy' ? Loader : tone === 'neutral' ? Minus : AlertTriangle;
  const reason = localize(receiptReasonText(receipt.reason));

  function undo() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    setUndoState('busy');
    chrome.runtime.sendMessage({ type: 'nativeSaveUndo', receiptId: receipt.id }, (response: unknown) => {
      if (chrome.runtime.lastError) {
        setUndoState('撤销失败，请重试');
        return;
      }
      const status = response && typeof response === 'object' && 'status' in response ? response.status : undefined;
      if (status === 'undone') setUndoState('idle');
      else
        setUndoState(
          response && typeof response === 'object' && 'reason' in response && response.reason === 'moved-since'
            ? '书签之后又被移动过，未撤销'
            : '无法撤销',
        );
    });
  }

  let title: string;
  let sub: React.ReactNode;
  switch (receipt.status) {
    case 'classifying':
      title = receipt.source === 'rule' || receipt.source === 'domain' ? '正在按本地规则归类…' : 'AI 正在选择目录…';
      sub = receipt.title;
      break;
    case 'moved':
      title = receipt.source === 'rule' || receipt.source === 'domain' ? '已按本地规则归类' : '已自动归类';
      sub = (
        <>
          {t('收进')} <span className="receipt-path">{receipt.toPath || t('新目录')}</span>
        </>
      );
      break;
    case 'kept':
      title = receipt.source === 'rule' || receipt.source === 'domain' ? '本地规则保留原位置' : 'AI 认为原位置合适';
      sub = (
        <>
          {t('保留在')} <span className="receipt-path">{receipt.fromPath}</span>
        </>
      );
      break;
    case 'undone':
      title = '已撤销自动归类';
      sub = (
        <>
          {t('回到')} <span className="receipt-path">{receipt.fromPath}</span>
        </>
      );
      break;
    case 'skipped':
      title = receipt.reason === 'missing-bookmark' ? '书签已删除' : '收藏成功，但没有调用 AI';
      sub = reason;
      break;
    default:
      title = receipt.reason === 'worker-interrupted' ? '自动归类已中断' : 'AI 归类未完成';
      sub = reason;
  }

  if (receipt.correction) {
    title = receipt.correction.status === 'completed' ? '已手动纠正目录' : '手动纠正记录';
    sub =
      receipt.correction.status === 'pending'
        ? t('结果待核实，请查看恢复记录')
        : t('操作编号：{id}', { id: receipt.correction.requestId });
  }
  return (
    <div className={`receipt is-${tone}`} role="status" aria-live="polite" onFocusCapture={onInteract}>
      <span className="receipt-icon" aria-hidden="true">
        <Icon />
      </span>
      <div className="receipt-body">
        <span className="receipt-title">{localize(title)}</span>
        <span className="receipt-sub" title={receipt.title}>
          {sub}
        </span>
        <span className="receipt-meta">
          {receipt.status === 'classifying' ? null : `${receipt.title} · `}
          {ago(receipt.at, language)}
          {receipt.model
            ? ` · ${receipt.source === 'rule' ? t('本地网站规则') : receipt.source === 'domain' ? t('本地同站点归类') : receipt.model}`
            : ''}
          {receipt.ms && receipt.status !== 'skipped' ? ` · ${(receipt.ms / 1000).toFixed(1)}s` : ''}
        </span>
        {receipt.nameStatus === 'pending' && <span className="receipt-meta">{t('正在生成名称建议…')}</span>}
        {receipt.nameStatus === 'unchanged' && <span className="receipt-meta">{t('未建议改名，保留原名')}</span>}
        {receipt.nameStatus === 'uncertain' && <span className="receipt-meta">{t('信息不足，保留原名')}</span>}
        {receipt.nameStatus === 'failed' && <span className="receipt-meta">{t('名称建议未完成')}</span>}
        {receipt.nameReview === 'applied' && <span className="receipt-meta">{t('书签名称已更新')}</span>}
        {undoState !== 'idle' && undoState !== 'busy' ? (
          <span className="receipt-meta">{localize(undoState)}</span>
        ) : null}
      </div>
      {onDismiss ? (
        <button type="button" className="receipt-close" aria-label={t('关闭提示')} onClick={onDismiss}>
          <X />
        </button>
      ) : (
        <span />
      )}
      {!compact && receipt.status !== 'classifying' ? (
        <div className="receipt-actions">
          {receipt.status === 'moved' && !receipt.correction ? (
            <button type="button" onClick={undo} disabled={undoState === 'busy'}>
              <CornerUpLeft aria-hidden="true" />
              {t('撤销')}
            </button>
          ) : null}
          <button type="button" disabled={undoState === 'busy' || correcting} onClick={() => setCorrecting(true)}>
            {t('改一下')}
          </button>
          {!receipt.correction && receipt.status !== 'moved' && CONFIG_REASONS.has(receipt.reason ?? '') && onOpen ? (
            <button
              type="button"
              className="primary"
              onClick={() =>
                onOpen(receipt.reason === 'save-feature-unconfigured' ? 'ai-services/features' : 'ai-services')
              }
            >
              {receipt.reason === 'save-feature-unconfigured' ? t('给「智能收藏」选模型') : t('检查 AI 连接')}
            </button>
          ) : null}
          {receipt.status === 'failed' && onOpen ? (
            <button type="button" onClick={() => onOpen('debug')}>
              {t('查看调用日志')}
            </button>
          ) : null}
        </div>
      ) : null}
      {correcting && <SaveCorrection receiptId={receipt.id} onClose={() => setCorrecting(false)} />}
      {!compact &&
        !correcting &&
        receipt.suggestedTitle &&
        !receipt.nameReview &&
        ['moved', 'kept'].includes(receipt.status) && (
          <SaveCorrection receiptId={receipt.id} nameOnly onClose={() => onDismiss?.()} />
        )}
    </div>
  );
}

/** Popup card for the latest native save. Dismissal is remembered per receipt. */
export function SaveReceiptCard({ onOpen }: { onOpen: (route: string) => void }) {
  const { t } = useI18n();
  const receipts = useSaveReceipts();
  const [seen, setSeen] = useState<string | undefined>();
  useEffect(() => {
    const storage = localArea();
    if (!storage) return;
    void storage.get(SEEN_KEY).then(data => {
      const value = data[SEEN_KEY];
      if (typeof value === 'string') setSeen(value);
    });
  }, []);
  const [selected, setSelected] = useState('');
  const pending = receipts.filter(
    receipt => receipt.suggestedTitle && !receipt.nameReview && ['moved', 'kept'].includes(receipt.status),
  );
  const latest =
    pending.find(receipt => receipt.id === selected) ?? pending.find(receipt => receipt.id !== seen) ?? receipts[0];
  if (!latest || (!pending.includes(latest) && (latest.id === seen || Date.now() - latest.at > FRESH_MS))) return null;
  if (latest.id === seen) return <button onClick={() => setSeen(undefined)}>{t('待确认名称')}</button>;
  // A finished, successful move stays visible but can be dismissed; failures keep their call to action.
  return (
    <>
      {pending.length > 1 && (
        <label className="field">
          {t('待确认名称')}
          <select
            value={latest.id}
            onChange={event => {
              setSelected(event.target.value);
              setSeen(undefined);
            }}
          >
            {pending.map(receipt => (
              <option key={receipt.id} value={receipt.id}>
                {receipt.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <ReceiptView
        key={latest.id}
        receipt={latest}
        onOpen={onOpen}
        onInteract={() => setSelected(latest.id)}
        onDismiss={() => {
          setSelected('');
          setSeen(latest.id);
          void localArea()?.set({ [SEEN_KEY]: latest.id });
        }}
      />
    </>
  );
}
