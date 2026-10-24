import { useEffect, useRef, useState } from 'react';
import { summarizeRecovery } from '../domain/recovery-summary';
import { classifyRecoveryRecords, describeOperation, proposalOperations } from '../domain/recovery-view';
import type { NodeRef } from '../domain/node-reference';
import { recoveryResponseSchema, type RecoveryResponse } from '../schemas/recovery';
import { mutationResultSchema, type ConfirmMutation, type MutationResult } from '../schemas/messages';
import type { OperationRecord } from '../persistence/operations';
import { StateMessage } from '../ui/StateMessage';
import { Select } from '../ui/Select';
import { useI18n } from '../ui/i18n';
import {
  recoveryCommandText,
  recoveryResultText,
  recoveryStepText,
  recoverySummaryText,
  recoveryStatusText,
  recoveryTimeText,
} from './recovery-text';

export async function sendRecovery(message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) =>
    chrome.runtime.sendMessage(message, (response: unknown) => {
      if (chrome.runtime.lastError) reject(Error('transport-unavailable'));
      else resolve(response);
    }),
  );
}

type RecoveryMode = NonNullable<ConfirmMutation['recovery']>['mode'];
type RunOptions = { mutation?: boolean; recovery?: ConfirmMutation['recovery']; quiet?: boolean };
/** The undo list is a shortlist; older settled batches stay reachable in the advanced record list. */
const UNDO_LIMIT = 10;
const previewCopy: Record<RecoveryMode, { heading: string; apply: string }> = {
  undo: { heading: '撤销影响预览', apply: '应用撤销' },
  merge: { heading: '合并恢复影响预览', apply: '应用合并恢复' },
  copy: { heading: '新副本影响预览', apply: '应用新副本' },
};

function RecordHeader({ record, status }: { record: OperationRecord; status: string }) {
  const { t, message, language } = useI18n();
  const { kind, steps, receipts, when } = describeOperation(record);
  return (
    <>
      <div className="recovery-item-title">
        <strong>{t(kind)}</strong>
        <span className="hint">{recoveryTimeText(language, when)}</span>
      </div>
      <p className="hint">
        {t('{status} · {receipts}/{steps} 步有回执 · 请求 {id}', {
          status: message(status),
          receipts,
          steps,
          id: record.requestId,
        })}
      </p>
    </>
  );
}

export function RecoveryWorkbench({
  send = sendRecovery,
  visible = true,
}: {
  send?: typeof sendRecovery;
  /** First visibility loads the journal once; later visibility changes never re-send. Defaults to true for hosts that mount it already visible. */
  visible?: boolean;
}) {
  const { t, message, language } = useI18n();
  const [destinations, setDestinations] = useState<{ ref: NodeRef; title: string }[]>([]);
  const [destination, setDestination] = useState('');
  const [copySelection, setCopySelection] = useState<string[]>([]);
  const [copySource, setCopySource] = useState<string>();
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [preview, setPreview] = useState<Extract<RecoveryResponse, { status: 'preview' }>>();
  const [previewMode, setPreviewMode] = useState<RecoveryMode>('undo');
  const inFlight = useRef(false);
  const loaded = useRef(false);
  const root = useRef<HTMLElement>(null);
  const [pendingRequest, setPendingRequest] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | { result: MutationResult; recovery?: ConfirmMutation['recovery'] }>(
    '恢复资料仅保存在本地，含私人标题与网址；不含模型密钥、正文或摘要。',
  );
  const [error, setError] = useState(false);
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [risk, setRisk] = useState<{ type: 'quarantineMutation' | 'recoveryCleanup'; id: string }>();
  const [capacity, setCapacity] = useState('容量尚未读取；估算不保证写入成功。');
  /** Single-flight transport with response correlation; resolves true only when a correlated, well-formed response arrived. */
  const run = async (message: unknown, { mutation = false, recovery, quiet = false }: RunOptions = {}) => {
    if (inFlight.current) return false;
    inFlight.current = true;
    const requestId = message && typeof message === 'object' && 'requestId' in message ? String(message.requestId) : '';
    if (mutation) setPendingRequest(requestId);
    setBusy(true);
    if (!quiet) setError(false);
    try {
      const response = await send(message);
      if (mutation) {
        const result = mutationResultSchema.parse(response);
        if (result.requestId !== requestId) throw Error('mismatched-response');
        const coverage = recovery ?? records.find(r => r.requestId === requestId)?.request.recovery;
        const summary = summarizeRecovery(result, coverage);
        setStatus({ result, recovery: coverage });
        setError(summary.incomplete);
        return true;
      }
      const result = recoveryResponseSchema.parse(response);
      if (result.requestId !== requestId) throw Error('mismatched-response');
      if (result.status === 'ready') {
        setRecords(result.records);
        setDestinations(result.destinations);
        setCapacity(
          `估算使用 ${result.usage ?? '未知'} / 配额 ${result.quota ?? '未知'} 字节；实际备份事务成功后才可写入。`,
        );
      }
      if (result.status === 'preview') {
        setPreview(result);
        setPreviewConfirmed(false);
      }
      if (result.status === 'cleaned') {
        setStatus('已清理恢复快照；保留请求去重记录。');
        setPreview(undefined);
      }
      if (result.status === 'error') {
        if (!quiet) {
          setError(true);
          setStatus(result.reason);
        }
        return false;
      }
      return true;
    } catch {
      if (!quiet) {
        setError(true);
        setStatus(`传输或响应不可用；写入结果可能未知。请求编号 ${requestId}；刷新并核对日志，不自动重试。`);
      }
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
      setPendingRequest(undefined);
    }
  };
  const refresh = (quiet = false) =>
    run({ version: 1, type: 'recoveryList', requestId: crypto.randomUUID() }, { quiet });
  /** Writes are told, not re-asked: after any correlated mutation result the journal is re-read quietly so the groups reflect it. */
  const mutate = async (message: unknown, recovery?: ConfirmMutation['recovery']) => {
    if (await run(message, { mutation: true, recovery })) await refresh(true);
  };
  const requestPreview = (
    mode: RecoveryMode,
    sourceRequestId: string,
    copy?: { destination: NodeRef | undefined; selectedNativeIds: string[] },
  ) => {
    setPreviewMode(mode);
    void run({ version: 1, type: 'recoveryPreview', requestId: crypto.randomUUID(), sourceRequestId, mode, ...copy });
  };
  const discard = () => {
    if (preview?.proposal)
      void send({
        version: 1,
        type: 'recoveryDiscard',
        requestId: crypto.randomUUID(),
        proposalRequestId: preview.proposal.requestId,
      }).catch(() => {});
    setPreview(undefined);
  };
  const apply = (proposal: ConfirmMutation) => {
    setPreview(undefined);
    void mutate(proposal, proposal.recovery);
  };
  const openRisk = (type: 'quarantineMutation' | 'recoveryCleanup', id: string) => {
    setRisk({ type, id });
    setRiskConfirmed(false);
  };
  const confirmRisk = () => {
    if (!risk) return;
    if (risk.type === 'quarantineMutation')
      void mutate({ version: 1, type: risk.type, requestId: risk.id, confirmed: true });
    else
      void run({
        version: 1,
        type: risk.type,
        requestId: crypto.randomUUID(),
        sourceRequestId: risk.id,
        confirmed: true,
      }).then(ok => ok && refresh(true));
    setRisk(undefined);
  };
  /**
   * Load once, the first time the workbench is actually shown. Hosts mount it inside `hidden` containers long before the
   * user opens it, so besides the `visible` prop the DOM is checked for a hidden ancestor; the host's re-render when it
   * unhides re-runs this effect. Later visibility changes never re-send; the refresh button does.
   */
  useEffect(() => {
    if (loaded.current || !visible || root.current?.closest('[hidden]')) return;
    loaded.current = true;
    void refresh();
  });
  const groups = classifyRecoveryRecords(records);
  const undoable = groups.undoable.slice(0, UNDO_LIMIT);
  const everything = [...groups.attention, ...groups.undoable, ...groups.history];
  const mode = preview?.proposal?.recovery?.mode ?? previewMode;
  return (
    <section ref={root} className="surface" aria-label={t('备份与恢复')} aria-busy={busy}>
      <h2>{t('备份与恢复')}</h2>
      <p className="hint">{recoveryStatusText(language, capacity)}</p>
      <StateMessage kind={error ? 'error' : busy ? 'loading' : 'empty'} title={t('恢复状态')}>
        {typeof status === 'string'
          ? recoveryStatusText(language, status)
          : recoverySummaryText(language, status.result, status.recovery)}
      </StateMessage>
      {pendingRequest && (
        <div role="status">
          {t('正在核对请求 {id}', { id: pendingRequest })}
          <button
            onClick={() => {
              void send({ version: 1, type: 'cancelMutation', requestId: pendingRequest }).catch(() =>
                setStatus(`取消未获确认，请求 ${pendingRequest} 结果仍待核对。`),
              );
            }}
          >
            {t('停止尚未发起步骤')}
          </button>
        </div>
      )}
      <div className="tools">
        <button disabled={busy} onClick={() => void refresh()}>
          {t('刷新恢复记录')}
        </button>
      </div>
      <section className="recovery-group" aria-label={t('撤销最近操作')}>
        <h3 title={t('撤销只回退有回执的步骤；之后被改动过的项目会跳过并保留现状。')}>{t('撤销最近操作')}</h3>
        {undoable.length ? (
          <ul className="recovery-list">
            {undoable.map(record => (
              <li key={record.requestId}>
                <RecordHeader record={record} status={recoveryResultText(language, record)} />
                <div className="actions">
                  <button disabled={busy} onClick={() => requestPreview('undo', record.requestId)}>
                    {t('预览撤销')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{t('暂无可撤销的操作。')}</p>
        )}
      </section>
      <section className="recovery-group" aria-label={t('需要你处理')}>
        <h3 title={t('这些操作没有完整回执，请先在书签管理器核对再处理。')}>{t('需要你处理')}</h3>
        {groups.attention.length ? (
          <ul className="recovery-list">
            {groups.attention.map(record => (
              <li key={record.requestId}>
                <RecordHeader record={record} status={t('结果未知，需人工核对')} />
                {record.result?.reason && (
                  <p className="hint">{t('原因：{reason}', { reason: record.result.reason })}</p>
                )}
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => void mutate({ version: 1, type: 'reconcileMutation', requestId: record.requestId })}
                  >
                    {t('核对当前状态（不重放）')}
                  </button>
                  {!record.result && (
                    <button
                      disabled={busy}
                      onClick={() => void mutate({ version: 1, type: 'cancelMutation', requestId: record.requestId })}
                    >
                      {t('停止未发起步骤')}
                    </button>
                  )}
                  <button disabled={busy} onClick={() => openRisk('quarantineMutation', record.requestId)}>
                    {t('人工核对后隔离')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">{t('没有需要处理的异常。')}</p>
        )}
      </section>
      {preview && (
        <section aria-label={t('恢复预览')}>
          <h3>{message(previewCopy[mode].heading)}</h3>
          <p>{message(preview.warning)}</p>
          {preview.proposal &&
            proposalOperations(preview.proposal).some(operation => operation.command.type === 'create') && (
              <p className="hint">{t('新建的恢复节点会追加到目标目录末尾；不保证还原原来的排列顺序。')}</p>
            )}
          {preview.proposal ? (
            <ul className="recovery-steps">
              {proposalOperations(preview.proposal).map(operation => (
                <li key={operation.id}>{recoveryCommandText(language, operation.command)}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">{t('没有可安全应用的项目；当前数据保持不变。')}</p>
          )}
          {preview.conflicts.length > 0 && (
            <ul className="recovery-steps">
              {preview.conflicts.map((c, i) => (
                <li key={i}>{t('保留 / 跳过 {id}：{reason}', { id: c.nativeId, reason: c.reason })}</li>
              ))}
            </ul>
          )}
          <label className="check">
            <input type="checkbox" checked={previewConfirmed} onChange={e => setPreviewConfirmed(e.target.checked)} />
            {t('确认以上影响范围')}
          </label>
          <div className="actions">
            <button
              disabled={busy || !previewConfirmed || !preview.proposal}
              onClick={() => preview.proposal && apply(preview.proposal)}
            >
              {message(previewCopy[mode].apply)}
            </button>
            <button onClick={discard}>{t('取消预览')}</button>
          </div>
        </section>
      )}
      {risk && (
        <section aria-label={t('恢复风险确认')}>
          <p>
            {risk.type === 'quarantineMutation'
              ? t(
                  '请先在浏览器书签管理器人工核对。隔离不证明完成、失败或没有重复项；不认领或删除任何候选，永不重放此请求及剩余步骤。仅允许重新扫描、预览并确认独立新操作。未知证据继续保留。',
                )
              : t('清理将失去本批次撤销与备份恢复能力。未知及被引用记录不可清理。')}
          </p>
          <label className="check">
            <input type="checkbox" checked={riskConfirmed} onChange={e => setRiskConfirmed(e.target.checked)} />
            {t('我已核对并理解风险')}
          </label>
          <div className="actions">
            <button disabled={!riskConfirmed || busy} onClick={confirmRisk}>
              {t('确认')}
            </button>
            <button onClick={() => setRisk(undefined)}>{t('取消')}</button>
          </div>
        </section>
      )}
      <details className="recovery-advanced">
        <summary>{t('高级：合并恢复、副本恢复、清理快照与完整记录')}</summary>
        <section aria-label={t('完整恢复记录')}>
          {everything.length ? (
            <ul className="recovery-list">
              {everything.map(record => (
                <li key={record.requestId}>
                  <RecordHeader record={record} status={recoveryResultText(language, record)} />
                  {record.result && record.request.recovery && (
                    <p className="hint">{recoverySummaryText(language, record.result, record.request.recovery)}</p>
                  )}
                  <ol className="recovery-steps">
                    {record.steps.map((s, i) => (
                      <li key={i}>{recoveryStepText(language, s)}</li>
                    ))}
                  </ol>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate({ version: 1, type: 'reconcileMutation', requestId: record.requestId })
                      }
                    >
                      {t('核对当前状态（不重放）')}
                    </button>
                    <button disabled={busy} onClick={() => requestPreview('merge', record.requestId)}>
                      {t('独立预览合并恢复')}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setCopySource(record.requestId);
                        setCopySelection([]);
                        setDestination('');
                      }}
                    >
                      {t('恢复为新副本（可能重复）')}
                    </button>
                    <button
                      disabled={
                        busy ||
                        !record.result ||
                        record.result.needsReconcile ||
                        !!record.quarantine ||
                        !!record.request.recovery ||
                        records.some(r => r.request.recovery?.sourceRequestId === record.requestId)
                      }
                      onClick={() => openRisk('recoveryCleanup', record.requestId)}
                    >
                      {t('清理恢复快照')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">{t('尚无恢复记录。')}</p>
          )}
        </section>
        {copySource && (
          <section aria-label={t('副本恢复选择')}>
            <h3>{t('恢复为新副本（可能重复）')}</h3>
            <label className="field">
              {t('当前目标目录')}
              <Select value={destination} onChange={e => setDestination(e.target.value)}>
                <option value="">{t('请选择')}</option>
                {destinations.map(n => (
                  <option key={n.ref.nativeId} value={n.ref.nativeId}>
                    {n.title} · {n.ref.nativeId}
                  </option>
                ))}
              </Select>
            </label>
            {(records.find(r => r.requestId === copySource)?.backup?.nodes ?? [])
              .filter(n => !n.readOnly)
              .map(n => (
                <label className="check" key={n.ref.nativeId}>
                  <input
                    type="checkbox"
                    checked={copySelection.includes(n.ref.nativeId)}
                    onChange={e =>
                      setCopySelection(
                        e.target.checked
                          ? [...copySelection, n.ref.nativeId]
                          : copySelection.filter(id => id !== n.ref.nativeId),
                      )
                    }
                  />
                  {t('{title} · {id}（目录包含子树）', { title: n.title, id: n.ref.nativeId })}
                </label>
              ))}
            <div className="actions">
              <button
                disabled={busy || !destination || !copySelection.length}
                onClick={() =>
                  requestPreview('copy', copySource, {
                    destination: destinations.find(n => n.ref.nativeId === destination)?.ref,
                    selectedNativeIds: copySelection,
                  })
                }
              >
                {t('预览新副本')}
              </button>
              <button onClick={() => setCopySource(undefined)}>{t('取消')}</button>
            </div>
          </section>
        )}
      </details>
    </section>
  );
}
