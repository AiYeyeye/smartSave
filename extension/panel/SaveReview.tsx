import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { BookmarkCheck, ChevronDown, Folder, X } from 'lucide-react';
import { useI18n } from '../ui/i18n';
import { FolderTree, folderAncestors, useFolderLabel } from './FolderTreePicker';
import {
  pendingSaveReceipts,
  readSaveReceipts,
  receiptReasonText,
  SAVE_RECEIPTS_KEY,
  type SaveReceipt,
} from '../persistence/save-receipts';
import {
  draftKey,
  parseDraft,
  parseQueue,
  SAVE_CONFIRM_QUEUE_KEY,
  type SaveConfirmDraft,
} from '../persistence/save-confirm';
import { correctionError, type CorrectionResponse } from '../domain/save-correction';
import type { TreeSnapshot } from '../domain/node-reference';
import { sendCorrection } from './SaveCorrection';
import { MutationFeedback } from './BookmarkActions';
import { canRetrySave } from '../domain/save-retry';
import { retrySave } from './save-retry-client';

export { pendingSaveReceipts } from '../persistence/save-receipts';

type Ready = Extract<CorrectionResponse, { status: 'ready' }>;
/** Only the displayed bookmark and folder paths matter; worker epochs and unrelated edits do not. */
function reviewContext(ready: Ready, folderId: string) {
  const { tree, bookmarkId } = ready;
  const nodes = new Map(tree.nodes.map(node => [node.ref.nativeId, node]));
  const ids = new Set([bookmarkId, folderId, ...folderAncestors(tree, bookmarkId), ...folderAncestors(tree, folderId)]);
  return JSON.stringify({
    installationId: tree.installationId,
    bookmarkId,
    nodes: [...ids].sort().map(id => {
      const node = nodes.get(id);
      return node
        ? {
            ref: node.ref,
            title: node.title,
            url: node.url,
            parentId: node.parentId,
            readOnly: node.readOnly,
            childrenWritable: node.childrenWritable,
          }
        : { missing: id };
    }),
  });
}

// These failures occur before a write. An unavailable/unknown response is never safe to repeat.
const UNWRITTEN_ERRORS = new Set(['session-expired', 'stale-correction', 'invalid-title']);
const CONFIG_REASONS = new Set(['save-feature-unconfigured', 'service-missing', 'no-key', 'http-401', 'http-403']);

const sessionArea = () =>
  typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : undefined;
const localArea = () => (typeof chrome !== 'undefined' && chrome.storage?.local ? chrome.storage.local : undefined);

/** The sidebar has only a launcher; receipt details and editors belong to the toolbar popup. */
export function SaveReviewLauncher() {
  const { t } = useI18n();
  const { receipts } = useLiveReceipts();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const count = pendingSaveReceipts(receipts).length;
  if (!count) return null;
  function open() {
    setBusy(true);
    setError(false);
    void chrome.runtime
      .sendMessage({ type: 'openSaveDialog' })
      .then(
        result => {
          setError(result?.status !== 'opened');
        },
        () => setError(true),
      )
      .finally(() => setBusy(false));
  }
  return (
    <div className="save-review-launcher">
      <button type="button" disabled={busy} onClick={open}>
        {t('待确认 {count} 项', { count })}
      </button>
      {error && <span role="alert">{t('收藏确认未能打开，请重试。')}</span>}
    </div>
  );
}

/** Live receipts plus whether storage answered yet, so an empty first render never prunes the queue. */
function useLiveReceipts() {
  const [state, setState] = useState<{ receipts: SaveReceipt[]; loaded: boolean }>(() => ({
    receipts: [],
    loaded: !localArea(),
  }));
  useEffect(() => {
    const storage = localArea();
    if (!storage) return;
    let live = true;
    let revision = 0;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !Object.hasOwn(changes, SAVE_RECEIPTS_KEY)) return;
      revision++;
      const next = changes[SAVE_RECEIPTS_KEY]?.newValue;
      setState({ receipts: Array.isArray(next) ? (next as SaveReceipt[]) : [], loaded: true });
    };
    const changes = chrome.storage.onChanged;
    changes.addListener(onChanged);
    const initial = revision;
    void readSaveReceipts(storage).then(list => {
      if (live && revision === initial) setState({ receipts: list, loaded: true });
    });
    return () => {
      live = false;
      changes.removeListener(onChanged);
    };
  }, []);
  return state;
}

/** Worker-owned popup queue; undefined until session storage answered. */
export function useSaveConfirmQueue() {
  const [queue, setQueue] = useState<string[] | undefined>(() => (sessionArea() ? undefined : []));
  useEffect(() => {
    const area = sessionArea();
    if (!area) return;
    let live = true;
    let revision = 0;
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, name: string) => {
      if (name !== 'session' || !Object.hasOwn(changes, SAVE_CONFIRM_QUEUE_KEY)) return;
      revision++;
      setQueue(parseQueue(changes[SAVE_CONFIRM_QUEUE_KEY]?.newValue));
    };
    const events = chrome.storage.onChanged;
    events.addListener(onChanged);
    const initial = revision;
    void Promise.resolve(area.get(SAVE_CONFIRM_QUEUE_KEY)).then(
      data => {
        if (live && revision === initial) setQueue(parseQueue(data?.[SAVE_CONFIRM_QUEUE_KEY]));
      },
      () => {
        if (live && revision === initial) setQueue([]);
      },
    );
    return () => {
      live = false;
      events.removeListener(onChanged);
    };
  }, []);
  return queue;
}

/** Popup-owned draft for one receipt, written on every change so a popup closed by blur loses nothing. */
function useSaveConfirmDraft(receiptId: string) {
  const [draft, setDraft] = useState<SaveConfirmDraft | undefined>(() => (sessionArea() ? undefined : {}));
  const current = useRef<SaveConfirmDraft>({});
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    const area = sessionArea();
    if (!area) return;
    let live = true;
    const key = draftKey(receiptId);
    void Promise.resolve(area.get(key)).then(
      data => {
        if (!live) return;
        current.current = parseDraft(data?.[key]);
        setDraft(current.current);
      },
      () => {
        if (live) setDraft({});
      },
    );
    return () => {
      live = false;
    };
  }, [receiptId]);
  const update = useCallback(
    (patch: SaveConfirmDraft) => {
      const next = { ...current.current, ...patch };
      current.current = next;
      setDraft(next);
      const area = sessionArea();
      if (area) writes.current = writes.current.then(() => area.set({ [draftKey(receiptId)]: next })).catch(() => {});
    },
    [receiptId],
  );
  return [draft, update] as const;
}

function statusText(receipt: SaveReceipt) {
  if (receipt.aiRetry?.status === 'pending') return '已收藏 · AI 正在识别…';
  if (receipt.aiRetry?.status === 'ready') return '已收藏 · AI 建议已就绪';
  if (receipt.status === 'classifying' || receipt.nameStatus === 'pending') return '已收藏 · AI 正在归类…';
  if (receipt.status === 'moved')
    return receipt.source === 'rule' || receipt.source === 'domain'
      ? '已收藏 · 已按本地规则归类'
      : '已收藏 · AI 已归类';
  if (receipt.status === 'kept') return '已收藏 · 保持原位置';
  return '已收藏 · 未自动归类';
}

function FolderButton({
  tree,
  value,
  open,
  controls,
  disabled,
  onToggle,
}: {
  tree: TreeSnapshot;
  value: string;
  open: boolean;
  controls: string;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const { title, path } = useFolderLabel(tree, value);
  const parent = path.includes(' / ') ? path.slice(0, path.lastIndexOf(' / ')) : '';
  return (
    <button
      type="button"
      className="save-pop-folder"
      aria-label={t('文件夹：{path}', { path: path || t('请明确选择目录') })}
      aria-expanded={open}
      aria-controls={controls}
      disabled={disabled}
      title={path}
      onClick={onToggle}
    >
      <Folder aria-hidden="true" />
      <span>
        <strong>{title || t('请明确选择目录')}</strong>
        {parent && <small>{parent}</small>}
      </span>
      <ChevronDown aria-hidden="true" className={open ? 'is-open' : undefined} />
    </button>
  );
}

function SaveDetails({
  receipt,
  original,
  shown,
  onUseOriginal,
  onOpen,
}: {
  receipt: SaveReceipt;
  original?: string;
  shown: string;
  onUseOriginal: () => void;
  onOpen: (route: string) => void;
}) {
  const { t, message } = useI18n();
  const [undo, setUndo] = useState<'idle' | 'busy' | 'failed' | 'moved-since'>('idle');
  let host = '';
  try {
    host = new URL(receipt.url).hostname;
  } catch {
    /* Legacy invalid receipt remains reviewable through the worker. */
  }
  const via =
    receipt.source === 'rule' ? t('本地网站规则') : receipt.source === 'domain' ? t('本地同站点归类') : receipt.model;
  function revert() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    setUndo('busy');
    chrome.runtime.sendMessage({ type: 'nativeSaveUndo', receiptId: receipt.id }, (response: unknown) => {
      if (chrome.runtime.lastError) return setUndo('failed');
      const value = response && typeof response === 'object' ? (response as Record<string, unknown>) : {};
      setUndo(value.status === 'undone' ? 'idle' : value.reason === 'moved-since' ? 'moved-since' : 'failed');
    });
  }
  return (
    <details className="save-pop-details">
      <summary>{t('详情')}</summary>
      <dl>
        {host && (
          <>
            <dt>{t('网址')}</dt>
            <dd title={receipt.url}>{host}</dd>
          </>
        )}
        {original !== undefined && original !== shown && (
          <>
            <dt>{t('原名称')}</dt>
            <dd>
              <span>{original}</span>{' '}
              <button type="button" className="save-pop-link" onClick={onUseOriginal}>
                {t('用原名')}
              </button>
            </dd>
          </>
        )}
        {receipt.status === 'moved' ? (
          <>
            <dt>{t('原位置')}</dt>
            <dd>{receipt.fromPath}</dd>
            <dt>{t('归类到')}</dt>
            <dd>{receipt.toPath || t('新目录')}</dd>
          </>
        ) : null}
        {via && receipt.status !== 'skipped' ? (
          <>
            <dt>{t('归类方式')}</dt>
            <dd>
              {via}
              {receipt.ms ? ` · ${(receipt.ms / 1000).toFixed(1)}s` : ''}
            </dd>
          </>
        ) : null}
        {(receipt.status === 'failed' || receipt.status === 'skipped') && receipt.aiRetry?.status !== 'ready' ? (
          <>
            <dt>{t('未归类原因')}</dt>
            <dd>{message(receiptReasonText(receipt.aiRetry?.reason ?? receipt.reason))}</dd>
          </>
        ) : null}
      </dl>
      <div className="save-pop-detail-actions">
        {receipt.status === 'moved' && !receipt.correction && (
          <button type="button" disabled={undo === 'busy'} onClick={revert}>
            {t('撤销归类')}
          </button>
        )}
        {(CONFIG_REASONS.has(receipt.reason ?? '') || canRetrySave(receipt)) && receipt.status !== 'moved' && (
          <button type="button" onClick={() => onOpen('ai-services')}>
            {t('AI 设置')}
          </button>
        )}
        <button type="button" onClick={() => onOpen('debug')}>
          {t('收藏记录')}
        </button>
      </div>
      {undo === 'failed' && <p role="alert">{t('无法撤销')}</p>}
      {undo === 'moved-since' && <p role="alert">{t('书签之后又被移动过，未撤销')}</p>}
    </details>
  );
}

/** One native save: the name and the folder are reviewed together and written in one request. */
export function SaveReviewForm({
  receipt,
  onComplete,
  onLater,
  onDismiss,
  onOpen,
  send = sendCorrection,
  retry = retrySave,
}: {
  receipt: SaveReceipt;
  onComplete: () => void;
  onLater: () => void;
  onDismiss: () => Promise<void>;
  onOpen: (route: string) => void;
  send?: typeof sendCorrection;
  retry?: typeof retrySave;
}) {
  const { t, message } = useI18n();
  const ids = useId();
  const [draft, updateDraft] = useSaveConfirmDraft(receipt.id);
  const [ready, setReady] = useState<Ready>();
  const [failure, setFailure] = useState<string>();
  const [result, setResult] = useState<CorrectionResponse>();
  const [busy, setBusy] = useState(false);
  const [dismissError, setDismissError] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const retryLock = useRef(false);
  const [locked, setLocked] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const token = useRef<string | undefined>(undefined);
  const lock = useRef(false);
  const live = useRef(true);
  // A newer worker result (classification, name advice, correction) refreshes the session, never the draft.
  const resultKey = JSON.stringify([
    receipt.status,
    receipt.toId,
    receipt.suggestedTitle,
    receipt.nameStatus,
    receipt.nameReview,
    receipt.correction?.requestId,
    receipt.correction?.status,
    receipt.reviewRequestId,
    receipt.suggestedFolderId,
    receipt.aiRetry?.status,
    receipt.aiRetry?.id,
  ]);
  const release = useCallback(() => {
    const value = token.current;
    token.current = undefined;
    if (value) void send({ type: 'nativeSaveCorrection', action: 'close', token: value });
  }, [send]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      release();
    };
  }, [release]);
  useEffect(() => {
    if (lock.current) return;
    let active = true;
    void send({ type: 'nativeSaveCorrection', action: 'begin', receiptId: receipt.id }).then(response => {
      if (!active || lock.current || !live.current) {
        if (response.status === 'ready')
          void send({ type: 'nativeSaveCorrection', action: 'close', token: response.token });
        return;
      }
      if (response.status !== 'ready') {
        // A refresh racing a receipt update keeps the session already on screen.
        if (!token.current) setFailure(response.status === 'error' ? response.reason : 'correction-unavailable');
        return;
      }
      release();
      token.current = response.token;
      setReady(response);
      setFailure(undefined);
    });
    return () => {
      active = false;
    };
  }, [receipt.id, resultKey, attempt, send, release]);

  const node = ready?.tree.nodes.find(entry => entry.ref.nativeId === ready.bookmarkId);
  const suggested = ready?.suggestedTitle;
  const baseTitle = suggested ?? node?.title ?? receipt.title;
  const writable = (key: string | undefined) =>
    !!key &&
    !!ready?.tree.nodes.some(
      entry => entry.ref.nativeId === key && entry.ref.kind === 'folder' && entry.childrenWritable,
    );
  const title = draft?.titleEdited && draft.title !== undefined ? draft.title : baseTitle;
  const folder = draft?.folderEdited ? (draft.folderId ?? '') : (ready?.suggestedFolderId ?? node?.parentId ?? '');
  const expandedList = draft?.expanded;
  const expanded = useMemo(
    () => new Set(expandedList ?? (ready && folder ? folderAncestors(ready.tree, folder) : [])),
    [expandedList, ready, folder],
  );
  const finalTitle = title === node?.title ? title : title.trim();
  const renamed = !!node && finalTitle !== node.title;
  const moved = !!node && folder !== node.parentId;
  const invalid = !writable(folder) || !finalTitle || (renamed && finalTitle.length > 200);
  const treeOpen = !!draft?.treeOpen;
  const recognizing = retryBusy || receipt.aiRetry?.status === 'pending';
  const controlsLocked = locked || recognizing;

  async function recognize() {
    if (lock.current || retryLock.current || !canRetrySave(receipt) || recognizing) return;
    retryLock.current = true;
    setRetryBusy(true);
    setRetryError(false);
    try {
      await retry(receipt.id);
    } catch {
      if (live.current) setRetryError(true);
    } finally {
      retryLock.current = false;
      if (live.current) setRetryBusy(false);
    }
  }

  async function confirm() {
    if (!ready || !token.current || lock.current || retryLock.current || recognizing || invalid) return;
    lock.current = true;
    setBusy(true);
    setLocked(true);
    setResult(undefined);
    // Opening the popup is not a lease on the worker's lifetime. Renew on this explicit click before writing.
    const fresh = await send({ type: 'nativeSaveCorrection', action: 'begin', receiptId: receipt.id });
    if (!live.current) {
      if (fresh.status === 'ready') void send({ type: 'nativeSaveCorrection', action: 'close', token: fresh.token });
      return;
    }
    if (fresh.status !== 'ready') {
      setBusy(false);
      setResult(fresh);
      lock.current = false;
      setLocked(false);
      return; // begin only reads/reconciles; this click has not submitted a write.
    }
    release();
    token.current = fresh.token;
    if (reviewContext(ready, folder) !== reviewContext(fresh, folder)) {
      // Preserve what the user chose, including a deleted destination (which requires another selection).
      updateDraft({ title, titleEdited: true, folderId: folder, folderEdited: true });
      setReady(fresh);
      setBusy(false);
      lock.current = false;
      setLocked(false);
      setResult({ status: 'error', reason: 'review-changed' });
      return;
    }
    const response = await send({
      type: 'nativeSaveCorrection',
      action: 'review',
      token: token.current,
      title: finalTitle,
      targetId: folder,
    });
    if (!live.current) return;
    setBusy(false);
    setResult(response);
    if (
      response.status === 'closed' ||
      (response.status === 'result' && response.result.status === 'completed' && !response.result.needsReconcile)
    ) {
      onComplete();
      return;
    }
    // Nothing was written: keep the draft and start a fresh session for another try.
    if (
      (response.status === 'error' && UNWRITTEN_ERRORS.has(response.reason)) ||
      (response.status === 'result' && response.result.status === 'rejected' && !response.result.needsReconcile)
    ) {
      lock.current = false;
      setLocked(false);
      release();
      setAttempt(value => value + 1);
    }
  }

  // The draft loads with the session so the name field mounts enabled and keeps its autofocus.
  if (!ready || draft === undefined)
    return (
      <section className="save-pop-form" aria-label={t('确认本条收藏')}>
        {failure && !ready ? (
          <>
            <p className="save-pop-note" role="alert">
              {message(correctionError(failure))}
            </p>
            <div className="save-pop-actions">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => {
                  if (lock.current) return;
                  lock.current = true;
                  setBusy(true);
                  setDismissError(false);
                  void onDismiss()
                    .catch(() => {
                      if (live.current) setDismissError(true);
                    })
                    .finally(() => {
                      lock.current = false;
                      if (live.current) setBusy(false);
                    });
                }}
              >
                {t('移出列表')}
              </button>
            </div>
            {dismissError && (
              <p className="save-pop-note" role="alert">
                {t('未能移出，请重试。')}
              </p>
            )}
          </>
        ) : (
          <p className="save-pop-note" role="status">
            {t('正在读取收藏…')}
          </p>
        )}
      </section>
    );
  return (
    <section className="save-pop-form" aria-label={t('确认本条收藏')}>
      <div className="save-pop-fields">
        <label htmlFor={`${ids}-name`} className="save-pop-label">
          {t('名称')}
          {suggested && !draft?.titleEdited && (
            <span className="save-pop-ai" aria-hidden="true" title={t('AI 建议')}>
              AI
            </span>
          )}
        </label>
        <input
          id={`${ids}-name`}
          className="save-pop-input"
          autoFocus
          aria-description={suggested && !draft?.titleEdited ? t('AI 建议') : undefined}
          value={title}
          disabled={controlsLocked}
          spellCheck={false}
          onChange={event => updateDraft({ title: event.target.value, titleEdited: true })}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void confirm();
            }
          }}
        />
        <span id={`${ids}-folder`} className="save-pop-label">
          {t('文件夹')}
          {((receipt.status === 'moved' && receipt.source === 'ai') || ready?.suggestedFolderId) &&
            !draft?.folderEdited && (
              <span className="save-pop-ai" aria-hidden="true" title={t('AI 建议')}>
                AI
              </span>
            )}
        </span>
        <FolderButton
          tree={ready.tree}
          value={folder}
          open={treeOpen}
          controls={`${ids}-tree`}
          disabled={controlsLocked}
          onToggle={() => updateDraft({ treeOpen: !treeOpen })}
        />
        {treeOpen && (
          <div className="save-pop-tree">
            <FolderTree
              compact
              id={`${ids}-tree`}
              labelledBy={`${ids}-folder`}
              tree={ready.tree}
              value={folder}
              disabled={controlsLocked}
              expanded={expanded}
              onExpandedChange={next => updateDraft({ expanded: [...next] })}
              onChoose={key => updateDraft({ folderId: key, folderEdited: true, expanded: [...expanded] })}
            />
          </div>
        )}
      </div>
      {receipt.status === 'failed' && !recognizing && receipt.aiRetry?.status !== 'ready' && (
        <p className="save-pop-note is-warn" role="status">
          {message(receiptReasonText(receipt.aiRetry?.reason ?? receipt.reason))}
        </p>
      )}
      {recognizing && (
        <p className="save-pop-note" role="status">
          {t('AI 正在重新识别…')}
        </p>
      )}
      {retryError && (
        <p className="save-pop-note is-warn" role="alert">
          {t('未能开始识别，请重试。')}
        </p>
      )}
      {busy && (
        <p className="save-pop-note" role="status">
          {t('正在保存并核对结果…')}
        </p>
      )}
      {result?.status === 'error' && (
        <div className="save-pop-note is-warn">
          <p role="alert">{message(correctionError(result.reason))}</p>
          {locked && !busy && (
            <button type="button" className="save-pop-link" onClick={() => onOpen('recovery')}>
              {t('查看恢复记录')}
            </button>
          )}
        </div>
      )}
      {result?.status === 'result' && result.result.status !== 'completed' && (
        <div className="save-pop-note">
          <MutationFeedback result={result.result} />
          {result.result.completedSteps >= 1 && renamed && moved && (
            <p role="alert">{t('名称已修改，目录修改尚未确认。请查看恢复记录。')}</p>
          )}
          {result.result.needsReconcile && (
            <button type="button" className="save-pop-link" onClick={() => onOpen('recovery')}>
              {t('查看恢复记录')}
            </button>
          )}
        </div>
      )}
      <div className="save-pop-actions">
        {canRetrySave(receipt) && (
          <button type="button" className="save-pop-retry" disabled={controlsLocked} onClick={() => void recognize()}>
            {t('重新 AI 识别')}
          </button>
        )}
        <button type="button" className="ghost" disabled={busy} onClick={onLater}>
          {t('稍后处理')}
        </button>
        <button type="button" className="primary" disabled={controlsLocked || invalid} onClick={() => void confirm()}>
          {t(renamed || moved ? '保存修改' : '完成')}
        </button>
      </div>
      <SaveDetails
        receipt={receipt}
        original={node?.title}
        shown={title}
        onOpen={onOpen}
        onUseOriginal={() => node && updateDraft({ title: node.title, titleEdited: true })}
      />
    </section>
  );
}

/** Settles once the worker answered, so a popup closing right after its last entry cannot drop the message. */
function notifyDone(receiptId: string): Promise<unknown> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return Promise.resolve();
  return Promise.resolve(chrome.runtime.sendMessage({ type: 'saveConfirmDone', receiptId })).catch(() => {});
}

/**
 * The popup body: the head of the worker queue, one entry at a time. New entries only bump "1/N"; they never
 * replace the entry being edited. Confirm and "later" both advance; closing keeps the queue and drafts.
 */
export function SaveReviewQueue({
  onOpen,
  onClose = () => {},
  send,
}: {
  onOpen: (route: string) => void;
  onClose?: () => void;
  send?: typeof sendCorrection;
}) {
  const { t } = useI18n();
  const { receipts, loaded } = useLiveReceipts();
  const queue = useSaveConfirmQueue();
  const [finished, setFinished] = useState<string[]>([]);
  const [acted, setActed] = useState(false);
  const deliveries = useRef(new Set<Promise<unknown>>());
  const byId = useMemo(() => new Map(receipts.map(receipt => [receipt.id, receipt])), [receipts]);
  const pending = useMemo(() => new Set(pendingSaveReceipts(receipts).map(receipt => receipt.id)), [receipts]);
  const entries = (queue ?? []).filter(id => !finished.includes(id) && pending.has(id));
  const stale = loaded && queue ? queue.filter(id => !pending.has(id) && !finished.includes(id)) : [];
  const finish = useCallback((id: string, byUser = true, notify = true) => {
    setFinished(previous => (previous.includes(id) ? previous : [...previous, id]));
    if (byUser) setActed(true);
    const delivery = notify ? notifyDone(id) : Promise.resolve();
    deliveries.current.add(delivery);
    void delivery.finally(() => deliveries.current.delete(delivery));
  }, []);
  const staleKey = stale.join('\n');
  useEffect(() => {
    // Reviewed elsewhere, undone or deleted: drop it from the worker queue without closing the popup.
    for (const id of staleKey ? staleKey.split('\n') : []) finish(id, false);
  }, [staleKey, finish]);
  // Only the user's own last confirm/later closes the popup, and only after the worker received it.
  const emptied = loaded && queue !== undefined && !entries.length && acted;
  useEffect(() => {
    if (!emptied) return;
    let live = true;
    void Promise.allSettled([...deliveries.current]).then(() => {
      if (live) onClose();
    });
    return () => {
      live = false;
    };
  }, [emptied, onClose]);
  const current = entries[0] ? byId.get(entries[0]) : undefined;
  const waiting =
    current &&
    (current.status === 'classifying' || current.nameStatus === 'pending' || current.aiRetry?.status === 'pending');
  return (
    <>
      <header className="save-pop-head">
        <BookmarkCheck aria-hidden="true" className="save-pop-mark" />
        <h1 className="save-pop-status">{t(current ? statusText(current) : '收藏确认')}</h1>
        {entries.length > 1 && (
          <span className="save-pop-count" title={t('待确认 {count} 项', { count: entries.length })}>
            1/{entries.length}
          </span>
        )}
        <button type="button" className="save-pop-close" aria-label={t('关闭')} title={t('关闭')} onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {current && waiting && (
        <section className="save-pop-form">
          <p className="save-pop-note" role="status">
            {t(current.aiRetry?.status === 'pending' ? 'AI 正在重新识别…' : '正在自动归类，完成后可确认名称和目录。')}
          </p>
          <div className="save-pop-actions">
            <button type="button" className="ghost" onClick={() => finish(current.id)}>
              {t('稍后处理')}
            </button>
          </div>
        </section>
      )}
      {current && !waiting && (
        <SaveReviewForm
          key={current.id}
          receipt={current}
          onComplete={() => finish(current.id)}
          onLater={() => finish(current.id)}
          onDismiss={async () => {
            const response: unknown = await chrome.runtime.sendMessage({
              type: 'saveConfirmDismiss',
              receiptId: current.id,
            });
            if (!response || typeof response !== 'object' || !('status' in response) || response.status !== 'done')
              throw Error('dismiss-failed');
            finish(current.id, true, false);
          }}
          onOpen={onOpen}
          {...(send ? { send } : {})}
        />
      )}
      {!current && loaded && queue !== undefined && (
        <p className="save-pop-note" role="status">
          {t('没有待确认的收藏。')}
        </p>
      )}
    </>
  );
}
