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
}: {
  receiptId: string;
  onClose: () => void;
  send?: typeof sendCorrection;
}) {
  const [ready, setReady] = useState<Extract<CorrectionResponse, { status: 'ready' }>>();
  const [outcome, setOutcome] = useState<CorrectionResponse>();
  const [target, setTarget] = useState('');
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
      if (response.status === 'ready') setReady(response);
      else setOutcome(response);
    });
    return () => {
      active = false;
      live.current = false;
      if (token) void send({ type: 'nativeSaveCorrection', action: 'close', token });
    };
  }, [receiptId, send]);

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
  const paths = organizePaths(ready?.tree);
  const moved = outcome?.status === 'moved' ? outcome : undefined;
  return (
    <section className="save-correction" aria-label="纠正本条收藏">
      <h3>纠正本条收藏</h3>
      {!ready && !outcome && <p role="status">正在核对书签当前位置…</p>}
      {ready && !submitted && (
        <>
          <p>{source?.title}</p>
          <p>当前目录：{paths.get(source?.parentId ?? '') || '根目录'}</p>
          <label className="field">
            改到目录
            <Select
              aria-label="改到目录"
              value={target}
              onChange={event => setTarget(event.target.value)}
              disabled={busy}
            >
              <option value="">选择目标目录</option>
              {ready.tree.nodes
                .filter(
                  node => node.ref.kind === 'folder' && node.childrenWritable && node.ref.nativeId !== source?.parentId,
                )
                .map(node => (
                  <option key={node.ref.nativeId} value={node.ref.nativeId}>
                    {paths.get(node.ref.nativeId)}
                  </option>
                ))}
            </Select>
          </label>
          <button type="button" disabled={!target || busy} onClick={() => void act('move')}>
            改到这个目录
          </button>
        </>
      )}
      {busy && <p role="status">{moved ? '正在保存网站规则…' : '正在纠正并核对结果…'}</p>}
      {outcome?.status === 'error' && <p role="alert">{correctionError(outcome.reason)}</p>}
      {outcome?.status === 'result' && <MutationFeedback result={outcome.result} />}
      {moved && (
        <>
          <p>
            本次已改到「{moved.targetTitle}」。以后 {moved.host} 都默认放到这里吗？
          </p>
          {moved.previousRule && (
            <p>
              将替换此网站已有规则（{paths.get(moved.previousRule.folder.nativeId) || '原目录已不可用'}
              {moved.previousRule.includeSubdomains ? '，含子域名' : '，仅此域名'}）。
            </p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={includeSubdomains}
              disabled={busy}
              onChange={event => setIncludeSubdomains(event.target.checked)}
            />
            也包含此域名的子域名
          </label>
          <button type="button" disabled={busy} onClick={() => void act('rule')}>
            {error ? '重试保存规则' : '以后都放这里'}
          </button>
          <small>移动记录：{moved.requestId}；撤销本次移动请使用恢复记录。</small>
        </>
      )}
      {error && <p role="alert">本次纠正不重复执行。{error}</p>}
      {outcome?.status === 'rule-saved' && <p role="status">网站规则已保存，可在隐私与规则中修改。</p>}
      <button type="button" disabled={busy} onClick={onClose}>
        {moved ? '仅这一次，关闭' : '关闭纠正'}
      </button>
    </section>
  );
}
