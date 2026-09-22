import { useEffect, useRef, useState } from 'react';
import { summarizeRecovery } from '../domain/recovery-summary';
import {
  classifyRecoveryRecords,
  describeCommand,
  describeOperation,
  describeResultStatus,
  describeStep,
  formatOperationTime,
  proposalOperations,
} from '../domain/recovery-view';
import type { NodeRef } from '../domain/node-reference';
import { recoveryResponseSchema, type RecoveryResponse } from '../schemas/recovery';
import { mutationResultSchema, type ConfirmMutation } from '../schemas/messages';
import type { OperationRecord } from '../persistence/operations';
import { StateMessage } from '../ui/StateMessage';
import { Select } from '../ui/Select';

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
  const { kind, steps, receipts, when } = describeOperation(record);
  return (
    <>
      <div className="recovery-item-title">
        <strong>{kind}</strong>
        <span className="hint">{formatOperationTime(when)}</span>
      </div>
      <p className="hint">
        {status} · {receipts}/{steps} 步有回执 · 请求 {record.requestId}
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
  const [status, setStatus] = useState('恢复资料仅保存在本地，含私人标题与网址；不含模型密钥、正文或摘要。');
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
        const summary = summarizeRecovery(
          result,
          recovery ?? records.find(r => r.requestId === requestId)?.request.recovery,
        );
        setStatus(summary.text);
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
    <section ref={root} className="surface" aria-label="备份与恢复" aria-busy={busy}>
      <h2>备份与恢复</h2>
      <p className="hint">
        收藏、整理与导入都会先写入书签，再在这里留下记录。撤销前先预览影响；结果未知的操作不会自动重试。
      </p>
      <p className="hint">{capacity}</p>
      <StateMessage kind={error ? 'error' : busy ? 'loading' : 'empty'} title="恢复状态">
        {status}
      </StateMessage>
      {pendingRequest && (
        <div role="status">
          正在核对请求 {pendingRequest}
          <button
            onClick={() => {
              void send({ version: 1, type: 'cancelMutation', requestId: pendingRequest }).catch(() =>
                setStatus(`取消未获确认，请求 ${pendingRequest} 结果仍待核对。`),
              );
            }}
          >
            停止尚未发起步骤
          </button>
        </div>
      )}
      <div className="tools">
        <button disabled={busy} onClick={() => void refresh()}>
          刷新恢复记录
        </button>
      </div>
      <section className="recovery-group" aria-label="撤销最近操作">
        <h3>撤销最近操作</h3>
        <p className="hint">
          最近 {UNDO_LIMIT}{' '}
          次已完成的收藏、编辑、移动、删除与整理批次。撤销只回退有回执的步骤；之后被改动过的项目会被跳过并保留现状。
        </p>
        {undoable.length ? (
          <ul className="recovery-list">
            {undoable.map(record => (
              <li key={record.requestId}>
                <RecordHeader record={record} status={describeResultStatus(record)} />
                <div className="actions">
                  <button disabled={busy} onClick={() => requestPreview('undo', record.requestId)}>
                    预览撤销
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">暂无可撤销的操作。</p>
        )}
      </section>
      <section className="recovery-group" aria-label="需要你处理">
        <h3>需要你处理</h3>
        <p className="hint">
          这些操作没有拿到完整回执，扩展不知道浏览器里最终写成了什么。先在书签管理器核对，再决定核对、停止或隔离；隔离只是登记，不代表完成或失败。
        </p>
        {groups.attention.length ? (
          <ul className="recovery-list">
            {groups.attention.map(record => (
              <li key={record.requestId}>
                <RecordHeader record={record} status="结果未知，需人工核对" />
                {record.result?.reason && <p className="hint">原因：{record.result.reason}</p>}
                <div className="actions">
                  <button
                    disabled={busy}
                    onClick={() => void mutate({ version: 1, type: 'reconcileMutation', requestId: record.requestId })}
                  >
                    核对当前状态（不重放）
                  </button>
                  {!record.result && (
                    <button
                      disabled={busy}
                      onClick={() => void mutate({ version: 1, type: 'cancelMutation', requestId: record.requestId })}
                    >
                      停止未发起步骤
                    </button>
                  )}
                  <button disabled={busy} onClick={() => openRisk('quarantineMutation', record.requestId)}>
                    人工核对后隔离
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">没有需要处理的异常。</p>
        )}
      </section>
      {preview && (
        <section aria-label="恢复预览">
          <h3>{previewCopy[mode].heading}</h3>
          <p>{preview.warning}</p>
          {preview.proposal ? (
            <ul className="recovery-steps">
              {proposalOperations(preview.proposal).map(operation => (
                <li key={operation.id}>{describeCommand(operation.command)}</li>
              ))}
            </ul>
          ) : (
            <p className="hint">没有可安全应用的项目；当前数据保持不变。</p>
          )}
          {preview.conflicts.length > 0 && (
            <ul className="recovery-steps">
              {preview.conflicts.map((c, i) => (
                <li key={i}>
                  保留 / 跳过 {c.nativeId}：{c.reason}
                </li>
              ))}
            </ul>
          )}
          <label className="check">
            <input type="checkbox" checked={previewConfirmed} onChange={e => setPreviewConfirmed(e.target.checked)} />
            确认以上影响范围
          </label>
          <div className="actions">
            <button
              disabled={busy || !previewConfirmed || !preview.proposal}
              onClick={() => preview.proposal && apply(preview.proposal)}
            >
              {previewCopy[mode].apply}
            </button>
            <button onClick={discard}>取消预览</button>
          </div>
        </section>
      )}
      {risk && (
        <section aria-label="恢复风险确认">
          <p>
            {risk.type === 'quarantineMutation'
              ? '请先在浏览器书签管理器人工核对。隔离不证明完成、失败或没有重复项；不认领或删除任何候选，永不重放此请求及剩余步骤。仅允许重新扫描、预览并确认独立新操作。未知证据继续保留。'
              : '清理将失去本批次撤销与备份恢复能力。未知及被引用记录不可清理。'}
          </p>
          <label className="check">
            <input type="checkbox" checked={riskConfirmed} onChange={e => setRiskConfirmed(e.target.checked)} />
            我已核对并理解风险
          </label>
          <div className="actions">
            <button disabled={!riskConfirmed || busy} onClick={confirmRisk}>
              确认
            </button>
            <button onClick={() => setRisk(undefined)}>取消</button>
          </div>
        </section>
      )}
      <details className="recovery-advanced">
        <summary>高级：合并恢复、副本恢复、清理快照与完整记录</summary>
        <section aria-label="完整恢复记录">
          <p className="hint">
            合并恢复只补回当前缺失且可证明位置的内容；新副本可能产生重复，不会认领原身份；清理快照后本批次不能再撤销或恢复。
          </p>
          {everything.length ? (
            <ul className="recovery-list">
              {everything.map(record => (
                <li key={record.requestId}>
                  <RecordHeader record={record} status={describeResultStatus(record)} />
                  {record.result && record.request.recovery && (
                    <p className="hint">{summarizeRecovery(record.result, record.request.recovery).text}</p>
                  )}
                  <ol className="recovery-steps">
                    {record.steps.map((s, i) => (
                      <li key={i}>{describeStep(s)}</li>
                    ))}
                  </ol>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate({ version: 1, type: 'reconcileMutation', requestId: record.requestId })
                      }
                    >
                      核对当前状态（不重放）
                    </button>
                    <button disabled={busy} onClick={() => requestPreview('merge', record.requestId)}>
                      独立预览合并恢复
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setCopySource(record.requestId);
                        setCopySelection([]);
                        setDestination('');
                      }}
                    >
                      恢复为新副本（可能重复）
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
                      清理恢复快照
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint">尚无恢复记录。</p>
          )}
        </section>
        {copySource && (
          <section aria-label="副本恢复选择">
            <h3>恢复为新副本（可能重复）</h3>
            <p>不证明这些节点缺失；不会按路径、标题或网址认领现有节点。源备份只读保留。</p>
            <label className="field">
              当前目标目录
              <Select value={destination} onChange={e => setDestination(e.target.value)}>
                <option value="">请选择</option>
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
                  {n.title} · {n.ref.nativeId}（目录包含子树）
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
                预览新副本
              </button>
              <button onClick={() => setCopySource(undefined)}>取消</button>
            </div>
          </section>
        )}
      </details>
    </section>
  );
}
