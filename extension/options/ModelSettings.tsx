import { useEffect, useRef, useState } from 'react';
import { SettingsStore, type ModelConfig } from '../persistence/settings';
import { ModelTransport, parseModelEndpoint } from '../adapters/model-transport';
import type { TreeState } from '../domain/node-reference';
import { connectTree } from '../panel/tree-client';
import { browserModelAuthority } from '../adapters/model-authority';
import type { AiPrivacy } from '../domain/ai-payload';
function browserStore() { return new SettingsStore(chrome.storage.local); }
export function ModelSettings({ store: supplied }: { store?: SettingsStore }) {
  const [store] = useState(() => supplied ?? (typeof chrome !== 'undefined' ? browserStore() : undefined));
  const [adapter, setAdapter] = useState(''); const [baseUrl, setBaseUrl] = useState(''); const [model, setModel] = useState(''); const [timeout, setTimeoutValue] = useState('');
  const [key, setKey] = useState(''); const [remember, setRemember] = useState(false);
  const [privacy, setPrivacy] = useState<AiPrivacy>({ fullUrl: true, bodyEnabled: false, excludedFolders: [] });
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const [status, setStatus] = useState('未配置模型不影响基础功能。'); const [error, setError] = useState(false); const [busy, setBusy] = useState(false);
  const transport = useRef<ModelTransport | undefined>(undefined);
  const cancel = () => { transport.current?.cancel(); };
  useEffect(() => {
    let live = true;
    if (store) void store.load().then(value => { if (!live) return; if (store.legacyCredentialDiscarded) setStatus('旧密钥未绑定服务，已移除；请重新输入。'); setPrivacy(value.privacy); setKey(store.credential()); if (value.config) { setAdapter(value.config.adapter); setBaseUrl(value.config.baseUrl); setModel(value.config.model); setTimeoutValue(String(value.config.timeoutMs)); } }).catch(() => { if (live) { setError(true); setStatus('配置或存储不可用，请重新打开设置重试。'); } });
    if (store && typeof chrome !== 'undefined' && chrome.permissions) transport.current = new ModelTransport({ fetch: globalThis.fetch.bind(globalThis), contains: request => chrome.permissions.contains(request) }, browserModelAuthority(store));
    const changed = () => { transport.current?.cancel(); };
    const stop = typeof chrome !== 'undefined' && chrome.runtime ? connectTree(chrome.runtime, value => { changed(); if (live) setTree(value); }) : undefined;
    chromeSafeListeners(changed, true); window.addEventListener('pagehide', changed);
    return () => { live = false; changed(); transport.current?.dispose(); stop?.(); if (!supplied) store?.dispose(); chromeSafeListeners(changed, false); window.removeEventListener('pagehide', changed); };
  }, [store, supplied]);
  function configuration(): ModelConfig {
    const config = { adapter: adapter as ModelConfig['adapter'], baseUrl, model, timeoutMs: Number(timeout) }; parseModelEndpoint(config); return config;
  }
  async function run(action: 'save' | 'authorize' | 'test' | 'delete') {
    cancel(); setError(false); setBusy(true);
    try {
      if (!store) throw Error();
      if (action === 'delete') { await store.clearCredential(); setKey(''); setRemember(false); setStatus('已删除保存的密钥。'); return; }
      const config = configuration();
      if (action === 'save') { await store.save(config, privacy, key, remember); setStatus('模型设置已保存；尚未证明服务能力。'); }
      if (action === 'authorize') {
        const granted = await chrome.permissions.request({ origins: [parseModelEndpoint(config).permission] });
        setError(!granted); setStatus(granted ? '已授权此主机；端口和路径由应用层限制。' : '模型主机权限被拒绝。');
      }
      if (action === 'test') {
        if (!transport.current || tree.status !== 'ready') throw Error();
        await store.save(config, privacy, key, remember);
        const result = await transport.current.run({ config, key, privacy, tree: tree.snapshot, request: { task: 'search', query: 'Synthetic connection test: return an empty rankedIds array.', itemIds: [], folderIds: [] } });
        setError(result.status !== 'completed'); setStatus(result.status === 'completed' ? '合成连接测试通过；不代表全部模型任务已验收。' : `模型请求未完成：${result.reason}。401检查密钥；403检查服务鉴权/Origin；429稍后手动重试；timeout调整超时；schema检查模型结构化输出；permission重新授权。`);
      }
    } catch { setError(true); setStatus('配置或存储不可用：请选择协议、模型和超时；远程地址须HTTPS，HTTP仅限回环地址。'); }
    finally { setBusy(false); }
  }
  return <section className="surface" aria-label="模型与隐私"><h2>模型与隐私</h2>
    <p>请求发送到您配置的服务；本地不会自动切换云端。完整网址参数可能包含凭证。未排除的内网书签信息也可能发送。</p>
    <p>密钥默认仅当前页面会话使用。记住密钥存于本地扩展存储，不是操作系统保险库；不进入同步、日志、备份或导出。</p>
    <label className="field">接口协议<select aria-label="接口协议" value={adapter} onChange={e => { cancel(); setKey(''); setAdapter(e.target.value); }}><option value="">请选择</option><option value="openai-compatible">OpenAI-compatible（JSON模式）</option><option value="ollama">Ollama native</option><option value="lm-studio">LM Studio structured</option></select></label>
    <label className="field">服务基础地址<input value={baseUrl} onChange={e => { cancel(); setKey(''); setBaseUrl(e.target.value); }} /></label>
    <p className="hint">填写服务根/代理前缀，不含 /v1/chat/completions 或 /api/chat。主机权限不能精确限定端口/路径。Ollama需允许当前扩展Origin；不要通配放开服务。</p>
    <label className="field">模型名称<input value={model} onChange={e => { cancel(); setModel(e.target.value); }} /></label>
    <label className="field">超时（毫秒）<input type="number" min="1" value={timeout} onChange={e => { cancel(); setTimeoutValue(e.target.value); }} /></label>
    <label className="field">API Key<input type="password" autoComplete="off" value={key} onChange={e => { cancel(); setKey(e.target.value); }} /></label>
    <label className="check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />明确记住密钥（本地明文存储）</label>
    <label className="check"><input type="checkbox" checked={privacy.fullUrl} onChange={e => { cancel(); setPrivacy({ ...privacy, fullUrl: e.target.checked }); }} />发送完整网址（含查询参数和片段）</label>
    <label className="check"><input type="checkbox" checked={privacy.bodyEnabled} onChange={e => { cancel(); setPrivacy({ ...privacy, bodyEnabled: e.target.checked }); }} />正文辅助（仅主动收藏）</label>
    <fieldset><legend>AI排除目录（包括子目录；不改变导出范围）</legend>
      {tree.status !== 'ready' ? <p>目录未就绪；现有排除配置保留。</p> : tree.snapshot.nodes.filter(n => n.ref.kind === 'folder').map(n => <label className="check" key={n.ref.nativeId}><input type="checkbox" checked={privacy.excludedFolders.some(r => r.installationId === n.ref.installationId && r.nativeId === n.ref.nativeId)} onChange={e => { cancel(); setPrivacy({ ...privacy, excludedFolders: e.target.checked ? [...privacy.excludedFolders, n.ref] : privacy.excludedFolders.filter(r => r.installationId !== n.ref.installationId || r.nativeId !== n.ref.nativeId) }); }} />{n.title || '根目录'}（{n.ref.nativeId}）</label>)}
    </fieldset>
    <div role={error ? 'alert' : 'status'}>{status}</div><div className="actions">
      <button disabled={busy} onClick={() => void run('save')}>保存模型设置</button><button disabled={busy} onClick={() => void run('authorize')}>授权模型主机</button><button disabled={busy} onClick={() => void run('test')}>使用合成数据测试连接</button><button onClick={() => { cancel(); setStatus('已取消；不会自动重试。'); }}>取消请求</button><button disabled={busy} onClick={() => void run('delete')}>删除密钥</button>
    </div><p>真实provider/server/model能力矩阵尚未验证。慢请求由此可见页承载；关闭页面不保活、不自动重试。</p>
  </section>;
}
function chromeSafeListeners(listener: () => void, add: boolean) {
  if (typeof chrome === 'undefined') return;
  for (const event of [chrome.permissions?.onRemoved]) {
    if (add) event?.addListener(listener); else event?.removeListener(listener);
  }
}
