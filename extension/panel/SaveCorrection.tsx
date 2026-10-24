import { useI18n } from '../ui/i18n';
import { useEffect, useRef, useState } from 'react';
import {
  correctionError,
  correctionResponseSchema,
  type CorrectionMessage,
  type CorrectionResponse,
} from '../domain/save-correction';
import { MutationFeedback } from './BookmarkActions';
import { Select } from '../ui/Select';
import { organizePaths } from '../domain/organize-review';

export function sendCorrection(message: CorrectionMessage): Promise<CorrectionResponse> {
  return new Promise(resolve => {
    let done = false;
    const finish = (value: CorrectionResponse) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ status: 'error', reason: 'transport-unavailable' }), 35_000);
    try {
      chrome.runtime.sendMessage(message, (raw: unknown) => {
        const parsed = correctionResponseSchema.safeParse(raw);
        finish(
          chrome.runtime.lastError || !parsed.success
            ? { status: 'error', reason: 'transport-unavailable' }
            : parsed.data,
        );
      });
    } catch {
      finish({ status: 'error', reason: 'transport-unavailable' });
    }
  });
}

export function SaveCorrection({
  receiptId,
  onClose,
  send = sendCorrection,
  nameOnly = false,
}: {
  receiptId: string;
  onClose: () => void;
  send?: typeof sendCorrection;
  nameOnly?: boolean;
}) {
  const { t, message: localize } = useI18n();
  const [ready, setReady] = useState<Extract<CorrectionResponse, { status: 'ready' }>>();
  const [outcome, setOutcome] = useState<CorrectionResponse>();
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [includeSubdomains, setIncludeSubdomains] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    let active = true;
    let token: string | undefined;
    void send({ type: 'nativeSaveCorrection', action: 'begin', receiptId }).then(response => {
      if (response.status === 'ready') token = response.token;
      if (!active) {
        if (token) void send({ type: 'nativeSaveCorrection', action: 'close', token });
        return;
      }
      if (response.status === 'ready') {
        setReady(response);
        setName(
          response.suggestedTitle ??
            response.tree.nodes.find(node => node.ref.nativeId === response.bookmarkId)?.title ??
            '',
        );
      } else setOutcome(response);
    });
    return () => {
      active = false;
      live.current = false;
      if (token) void send({ type: 'nativeSaveCorrection', action: 'close', token });
    };
  }, [receiptId, send]);
  async function rename(keep = false) {
    if (!ready || lock.current || submitted) return;
    lock.current = true;
    setBusy(true);
    setSubmitted(true);
    const response = await send(
      keep
        ? { type: 'nativeSaveCorrection', action: 'keep-name', token: ready.token }
        : { type: 'nativeSaveCorrection', action: 'rename', token: ready.token, title: name },
    );
    if (live.current) {
      setOutcome(response);
      setBusy(false);
    }
    lock.current = false;
  }

  async function act(action: 'move' | 'rule') {
    if (!ready || lock.current || (action === 'move' && submitted)) return;
    lock.current = true;
    setBusy(true);
    setError('');
    if (action === 'move') setSubmitted(true);
    const response = await send(
      action === 'move'
        ? { type: 'nativeSaveCorrection', action, token: ready.token, targetId: target }
        : { type: 'nativeSaveCorrection', action, token: ready.token, includeSubdomains, confirmed: true },
    );
    if (live.current) {
      if (action === 'rule' && response.status === 'error') setError(correctionError(response.reason));
      else setOutcome(response);
      setBusy(false);
    }
    lock.current = false;
  }
  const source = ready?.tree.nodes.find(node => node.ref.nativeId === ready.bookmarkId);
  const paths = organizePaths(ready?.tree, t('根目录'));
  const moved = outcome?.status === 'moved' ? outcome : undefined;
  return (
    <section className="save-correction" aria-label={t('纠正本条收藏')}>
      <h3>{nameOnly ? t('AI 名称建议') : t('纠正本条收藏')}</h3>
      {!ready && !outcome && <p role="status">{t('正在核对书签当前位置…')}</p>}
      {ready && !submitted && (
        <>
          <div className="save-correction-group">
            {nameOnly && (
              <label className="field">
                {t('原名称')}
                <input value={source?.title ?? ''} readOnly />
              </label>
            )}
            <label className="field">
              {t('书签名称')}
              <input value={name} maxLength={200} disabled={busy} onChange={event => setName(event.target.value)} />
            </label>
            <div className="actions">
              <button
                type="button"
                disabled={busy || !name.trim() || name === source?.title}
                onClick={() => void rename()}
              >
                {t('采用名称')}
              </button>
              {nameOnly && (
                <button type="button" disabled={busy} onClick={() => void rename(true)}>
                  {t('保留原名')}
                </button>
              )}
            </div>
          </div>
          {!nameOnly && (
            <div className="save-correction-group">
              <label className="field">
                {t('改到目录')}
                <Select
                  aria-label={t('改到目录')}
                  value={target}
                  onChange={event => setTarget(event.target.value)}
                  disabled={busy}
                >
                  <option value="">{t('选择目标目录')}</option>
                  {ready.tree.nodes
                    .filter(
                      node =>
                        node.ref.kind === 'folder' && node.childrenWritable && node.ref.nativeId !== source?.parentId,
                    )
                    .map(node => (
                      <option key={node.ref.nativeId} value={node.ref.nativeId}>
                        {paths.get(node.ref.nativeId)}
                      </option>
                    ))}
                </Select>
              </label>
              <p className="hint">
                {t('当前目录：{path}', { path: paths.get(source?.parentId ?? '') || t('根目录') })}
              </p>
              <div className="actions">
                <button type="button" disabled={!target || busy} onClick={() => void act('move')}>
                  {t('改到这个目录')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {busy && <p role="status">{moved ? t('正在保存网站规则…') : t('正在纠正并核对结果…')}</p>}
      {outcome?.status === 'error' && <p role="alert">{localize(correctionError(outcome.reason))}</p>}
      {outcome?.status === 'result' && <MutationFeedback result={outcome.result} />}
      {outcome?.status === 'closed' && <p>{t('已保留原名')}</p>}
      {moved && (
        <>
          <p>
            {t('本次已改到「{folder}」。以后 {host} 都默认放到这里吗？', {
              folder: moved.targetTitle,
              host: moved.host,
            })}
          </p>
          {moved.previousRule && (
            <p>
              {t('将替换此网站已有规则（{folder}{scope}）。', {
                folder: paths.get(moved.previousRule.folder.nativeId) || t('原目录已不可用'),
                scope: moved.previousRule.includeSubdomains ? t('，含子域名') : t('，仅此域名'),
              })}
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={includeSubdomains}
              disabled={busy}
              onChange={event => setIncludeSubdomains(event.target.checked)}
            />
            {t('也包含此域名的子域名')}
          </label>
          <button type="button" disabled={busy} onClick={() => void act('rule')}>
            {error ? t('重试保存规则') : t('以后都放这里')}
          </button>
        </>
      )}
      {error && <p role="alert">{t('本次纠正不重复执行。{error}', { error: localize(error) })}</p>}
      {outcome?.status === 'rule-saved' && <p role="status">{t('网站规则已保存，可在隐私与规则中修改。')}</p>}
      <button type="button" disabled={busy} onClick={onClose}>
        {moved ? t('仅这一次，关闭') : t('关闭纠正')}
      </button>
    </section>
  );
}
