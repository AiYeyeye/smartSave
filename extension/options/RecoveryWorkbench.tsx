import { summarizeRecovery } from '../domain/recovery-summary';
import type { NodeRef } from '../domain/node-reference';
import { useRef, useState } from 'react';
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
export function RecoveryWorkbench({ send = sendRecovery }: { send?: typeof sendRecovery }) {
  const [destinations, setDestinations] = useState<{ ref: NodeRef; title: string }[]>([]);
  const [destination, setDestination] = useState('');
  const [copySelection, setCopySelection] = useState<string[]>([]);
  const [copySource, setCopySource] = useState<string>();
  const [records, setRecords] = useState<OperationRecord[]>([]);
  const [preview, setPreview] = useState<Extract<RecoveryResponse, { status: 'preview' }>>();
  const inFlight = useRef(false);
  const [pendingRequest, setPendingRequest] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('恢复资料仅保存在本地，含私人标题与网址；不含模型密钥、正文或摘要。');
  const [error, setError] = useState(false);
  const [previewConfirmed, setPreviewConfirmed] = useState(false);
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const [risk, setRisk] = useState<{ type: 'quarantineMutation' | 'recoveryCleanup'; id: string }>();
  const [capacity, setCapacity] = useState('容量尚未读取；估算不保证写入成功。');
  const run = async (message: unknown, mutation = false, recovery?: ConfirmMutation['recovery']) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const requestId = message && typeof message === 'object' && 'requestId' in message ? String(message.requestId) : '';
    if (mutation) setPendingRequest(requestId);
    setBusy(true);
    setError(false);
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
      } else {
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
          setError(true);
          setStatus(result.reason);
        }
      }
    } catch {
      setError(true);
      setStatus(`传输或响应不可用；写入结果可能未知。请求编号 ${requestId}；刷新并核对日志，不自动重试。`);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setPendingRequest(undefined);
    }
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
    void run(proposal, true, proposal.recovery);
  };
  return (
    <section className="surface" aria-label="备份与恢复">
      <h2>备份与恢复</h2>
      <p className="hint">{capacity}</p>
      <StateMessage kind={error ? 'error' : 'empty'} title="恢复状态">
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
      <button
        disabled={busy}
        onClick={() => void run({ version: 1, type: 'recoveryList', requestId: crypto.randomUUID() })}
      >
        读取恢复记录
      </button>
      {records.map(record => (
        <article key={record.requestId} className="surface">
          <h3>{record.requestId}</h3>
          {record.result && record.request.recovery && (
            <p>{summarizeRecovery(record.result, record.request.recovery).text}</p>
          )}
          <p>
            {record.createdAt ?? '旧版记录'} · {record.result?.status ?? '中断，需核对'} ·{' '}
            {record.steps.filter(s => s.state === 'receipt').length}/{record.steps.length} 步有回执
            {record.quarantine ? ' · 已人工隔离（仍未知）' : ''}
          </p>
          <ol>
            {record.steps.map((s, i) => (
              <li key={i}>
                {s.step.type}：{s.state} {s.returnedNativeId ? `ID ${s.returnedNativeId}` : ''}
              </li>
            ))}
          </ol>
          <div className="actions">
            <button
              disabled={busy}
              onClick={() => void run({ version: 1, type: 'reconcileMutation', requestId: record.requestId }, true)}
            >
              核对当前状态（不重放）
            </button>
            {(['undo', 'merge'] as const).map(mode => (
              <button
                key={mode}
                disabled={busy}
                onClick={() =>
                  void run({
                    version: 1,
                    type: 'recoveryPreview',
                    requestId: crypto.randomUUID(),
                    sourceRequestId: record.requestId,
                    mode,
                  })
                }
              >
                {mode === 'undo' ? '预览撤销本批次' : '独立预览合并恢复'}
              </button>
            ))}
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
              disabled={busy || !!record.quarantine || (record.result !== undefined && !record.result.needsReconcile)}
              onClick={() => {
                setRisk({ type: 'quarantineMutation', id: record.requestId });
                setRiskConfirmed(false);
              }}
            >
              人工核对后隔离未知尝试
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
              onClick={() => {
                setRisk({ type: 'recoveryCleanup', id: record.requestId });
                setRiskConfirmed(false);
              }}
            >
              清理恢复快照
            </button>
            <button
              disabled={busy}
              onClick={() => void run({ version: 1, type: 'cancelMutation', requestId: record.requestId }, true)}
            >
              停止未发起步骤
            </button>
          </div>
        </article>
      ))}
      {copySource && (
        <section aria-label="副本恢复选择">
          <h3>恢复为新副本（可能重复）</h3>
          <p>不证明这些节点缺失；不会按路径、标题或网址认领现有节点。源备份只读保留。</p>
          <label>
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
          <button
            disabled={busy || !destination || !copySelection.length}
            onClick={() =>
              void run({
                version: 1,
                type: 'recoveryPreview',
                requestId: crypto.randomUUID(),
                sourceRequestId: copySource,
                mode: 'copy',
                destination: destinations.find(n => n.ref.nativeId === destination)?.ref,
                selectedNativeIds: copySelection,
              })
            }
          >
            预览新副本
          </button>
          <button onClick={() => setCopySource(undefined)}>取消</button>
        </section>
      )}
      {risk && (
        <section aria-label="恢复风险确认">
          <p>
            {risk.type === 'quarantineMutation'
              ? '请先在浏览器书签管理器人工核对。隔离不证明完成、失败或没有重复项；不认领或删除任何候选，永不重放此请求及剩余步骤。仅允许重新扫描、预览并确认独立新操作。未知证据继续保留。'
              : '清理将失去本批次撤销与备份恢复能力。未知及被引用记录不可清理。'}
          </p>
          <label>
            <input type="checkbox" checked={riskConfirmed} onChange={e => setRiskConfirmed(e.target.checked)} />
            我已核对并理解风险
          </label>
          <button
            disabled={!riskConfirmed || busy}
            onClick={() => {
              void run(
                risk.type === 'quarantineMutation'
                  ? { version: 1, type: risk.type, requestId: risk.id, confirmed: true }
                  : {
                      version: 1,
                      type: risk.type,
                      requestId: crypto.randomUUID(),
                      sourceRequestId: risk.id,
                      confirmed: true,
                    },
                risk.type === 'quarantineMutation',
              );
              setRisk(undefined);
            }}
          >
            确认
          </button>
          <button onClick={() => setRisk(undefined)}>取消</button>
        </section>
      )}
      {preview && (
        <section aria-label="恢复预览">
          <h3>恢复影响预览</h3>
          <p>{preview.warning}</p>
          <ul>
            {preview.proposal?.command.type === 'batch' &&
              preview.proposal.command.operations.map(o => (
                <li key={o.id}>
                  {o.id} · {o.command.type} · {'title' in o.command ? o.command.title : ''} ·{' '}
                  {'target' in o.command ? `对象 ${o.command.target.nativeId}` : ''} ·{' '}
                  {'parent' in o.command ? `目标 ${o.command.parent.nativeId}` : ''} ·{' '}
                  {'url' in o.command ? o.command.url : ''} ·{' '}
                  {'changes' in o.command ? JSON.stringify(o.command.changes) : ''}
                </li>
              ))}
          </ul>
          <ul>
            {preview.conflicts.map((c, i) => (
              <li key={i}>
                保留 / 跳过 {c.nativeId}：{c.reason}
              </li>
            ))}
          </ul>
          <label>
            <input type="checkbox" checked={previewConfirmed} onChange={e => setPreviewConfirmed(e.target.checked)} />
            确认以上影响范围
          </label>
          <button
            disabled={busy || !previewConfirmed || !preview.proposal}
            onClick={() => preview.proposal && apply(preview.proposal)}
          >
            应用恢复预览
          </button>
          <button onClick={discard}>取消预览</button>
        </section>
      )}
    </section>
  );
}
