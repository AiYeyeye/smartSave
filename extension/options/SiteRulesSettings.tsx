import { useEffect, useState } from 'react';
import type { TreeState } from '../domain/node-reference';
import { ruleFolder, type SiteRule } from '../domain/site-rules';
import { SiteRulesStore } from '../persistence/site-rules';
import { connectTree } from '../panel/tree-client';
import { Select } from '../ui/Select';
export function SiteRulesSettings({
  store: supplied,
  tree: suppliedTree,
}: {
  store?: SiteRulesStore;
  tree?: TreeState;
}) {
  const [store] = useState(
    () =>
      supplied ??
      (typeof chrome !== 'undefined' && chrome.storage?.local ? new SiteRulesStore(chrome.storage.local) : undefined),
  );
  const [tree, setTree] = useState<TreeState>(suppliedTree ?? { status: 'loading' });
  const [rules, setRules] = useState<SiteRule[]>([]);
  const [draft, setDraft] = useState<{ host: string; folderId: string; includeSubdomains: boolean }>();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void store
      ?.load()
      .then(value => {
        if (live) setRules(value);
      })
      .catch(() => {
        if (live) setMessage('规则存储不可用，未覆盖任何数据。');
      });
    return () => {
      live = false;
    };
  }, [store]);
  useEffect(() => {
    if (suppliedTree) {
      setTree(suppliedTree);
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime) return connectTree(chrome.runtime, setTree);
  }, [suppliedTree]);
  async function apply(host: string, remove: boolean) {
    if (!store || busy) return;
    setBusy(true);
    setMessage('');
    try {
      if (remove) await store.remove(host);
      else {
        const folder =
          tree.status === 'ready'
            ? tree.snapshot.nodes.find(n => n.ref.nativeId === draft?.folderId && n.childrenWritable)
            : undefined;
        if (!folder || !draft) throw Error();
        await store.set({ host, folder: folder.ref, includeSubdomains: draft.includeSubdomains });
      }
      setRules(await store.load());
      setDraft(undefined);
      setMessage('规则已保存；不会自动收藏。');
    } catch {
      setMessage('规则操作未完成，请检查目录与存储后明确重试；不会自动选择其他目录。');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface" aria-label="网站目录规则">
      <h2>网站目录规则</h2>
      <p>仅明确确认收藏时创建规则；重命名和移动跟随原目录身份，删除后必须重新选择。</p>
      {!rules.length && <p>暂无规则。</p>}
      {rules.map(rule => {
        const folder = tree.status === 'ready' ? ruleFolder(rule, tree.snapshot) : undefined;
        return (
          <div key={rule.host}>
            <p>
              {rule.host}
              {rule.includeSubdomains ? '（包含子域名）' : '（精确主机）'} →{' '}
              {folder ? `${folder.title}（${folder.ref.nativeId}）` : '目录失效或尚未就绪，请重新选择'}
            </p>
            <button
              disabled={busy}
              onClick={() =>
                setDraft({
                  host: rule.host,
                  folderId: folder?.ref.nativeId ?? '',
                  includeSubdomains: rule.includeSubdomains,
                })
              }
            >
              修改 {rule.host}
            </button>
            <button disabled={busy} onClick={() => void apply(rule.host, true)}>
              删除 {rule.host}
            </button>
          </div>
        );
      })}
      {draft && (
        <form
          onSubmit={event => {
            event.preventDefault();
            void apply(draft.host, false);
          }}
        >
          <h3>修改 {draft.host}</h3>
          <label className="field">
            规则目标目录
            <Select
              value={draft.folderId}
              disabled={busy}
              onChange={event => setDraft({ ...draft, folderId: event.target.value })}
            >
              <option value="">请明确选择目录</option>
              {tree.status === 'ready' &&
                tree.snapshot.nodes
                  .filter(n => n.childrenWritable)
                  .map(n => (
                    <option key={n.ref.nativeId} value={n.ref.nativeId}>
                      {n.title || '根目录'}（{n.ref.nativeId}）
                    </option>
                  ))}
            </Select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={draft.includeSubdomains}
              disabled={busy}
              onChange={event => setDraft({ ...draft, includeSubdomains: event.target.checked })}
            />
            包含子域名
          </label>
          <button type="submit" disabled={busy || !draft.folderId}>
            确认修改规则
          </button>
          <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>
            取消修改规则
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
