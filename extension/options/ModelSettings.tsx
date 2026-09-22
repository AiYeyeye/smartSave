import { useEffect, useRef, useState } from 'react';
import { SettingsStore, type ModelConfig } from '../persistence/settings';
import { ModelTransport, parseModelEndpoint } from '../adapters/model-transport';
import type { TreeState } from '../domain/node-reference';
import { connectTree } from '../panel/tree-client';
import { browserModelAuthority } from '../adapters/model-authority';
import { Select } from '../ui/Select';
import type { AiPrivacy } from '../domain/ai-payload';
import { modelPresets } from '../domain/model-presets';
function browserStore() {
  return new SettingsStore(chrome.storage.local);
}
export function ModelSettings({
  store: supplied,
  fields = 'all',
  showHeading = true,
}: {
  store?: SettingsStore;
  fields?: 'all' | 'model' | 'privacy';
  showHeading?: boolean;
}) {
  const [store] = useState(
    () => supplied ?? (typeof chrome !== 'undefined' && chrome.storage?.local ? browserStore() : undefined),
  );
  const [adapter, setAdapter] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [timeout, setTimeoutValue] = useState('');
  const [presetId, setPresetId] = useState('custom');
  const preset = modelPresets.find(item => item.id === presetId);
  function choosePreset(id: string) {
    cancel();
    setKey('');
    setRemember(false);
    setPresetId(id);
    const next = modelPresets.find(item => item.id === id);
    if (next) {
      setAdapter(next.adapter);
      setBaseUrl(next.baseUrl);
      setModel(next.models[0] ?? '');
      if (!timeout) setTimeoutValue('60000');
    }
    setStatus('配置草稿已更改；尚未保存、授权或调用模型。');
  }
  const [key, setKey] = useState('');
  const [remember, setRemember] = useState(false);
  const [privacy, setPrivacy] = useState<AiPrivacy>({ fullUrl: true, bodyEnabled: false, excludedFolders: [] });
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const transport = useRef<ModelTransport | undefined>(undefined);
  const cancel = () => {
    transport.current?.cancel();
  };
  useEffect(() => {
    let live = true;
    if (store)
      void store
        .load()
        .then(value => {
          if (!live) return;
          if (store.legacyCredentialDiscarded) setStatus('旧密钥未绑定服务，已移除；请重新输入。');
          setPrivacy(value.privacy);
          setKey(store.credential());
          if (value.config) {
            setAdapter(value.config.adapter);
            setBaseUrl(value.config.baseUrl);
            setModel(value.config.model);
            setTimeoutValue(String(value.config.timeoutMs));
          }
        })
        .catch(() => {
          if (live) {
            setError(true);
            setStatus('配置或存储不可用，请重新打开设置重试。');
          }
        });
    if (store && typeof chrome !== 'undefined' && chrome.permissions)
      transport.current = new ModelTransport(
        { fetch: globalThis.fetch.bind(globalThis), contains: request => chrome.permissions.contains(request) },
        browserModelAuthority(store),
      );
    const changed = () => {
      transport.current?.cancel();
    };
    const stop =
      typeof chrome !== 'undefined' && chrome.runtime
        ? connectTree(chrome.runtime, value => {
            changed();
            if (live) setTree(value);
          })
        : undefined;
    chromeSafeListeners(changed, true);
    window.addEventListener('pagehide', changed);
    return () => {
      live = false;
      changed();
      transport.current?.dispose();
      stop?.();
      if (!supplied) store?.dispose();
      chromeSafeListeners(changed, false);
      window.removeEventListener('pagehide', changed);
    };
  }, [store, supplied]);
  function configuration(): ModelConfig {
    const config = { adapter: adapter as ModelConfig['adapter'], baseUrl, model, timeoutMs: Number(timeout) };
    parseModelEndpoint(config);
    return config;
  }
  async function run(action: 'save' | 'authorize' | 'test' | 'delete') {
    cancel();
    setError(false);
    setBusy(true);
    try {
      if (!store) throw Error();
      if (action === 'delete') {
        await store.clearCredential();
        setKey('');
        setRemember(false);
        setStatus('已删除保存的密钥。');
        return;
      }
      if (action === 'save' && fields === 'privacy') {
        await store.savePrivacy(privacy);
        setStatus('隐私设置已保存；未配置模型不影响浏览。');
        return;
      }
      const config = configuration();
      if (action === 'save') {
        await store.save(config, privacy, key, remember);
        setStatus('模型设置已保存；尚未证明服务能力。');
      }
      if (action === 'authorize') {
        const granted = await chrome.permissions.request({ origins: [parseModelEndpoint(config).permission] });
        setError(!granted);
        setStatus(granted ? '已授权此主机；端口和路径由应用层限制。' : '模型主机权限被拒绝。');
      }
      if (action === 'test') {
        if (!transport.current || tree.status !== 'ready') throw Error();
        await store.save(config, privacy, key, remember);
        const result = await transport.current.run({
          config,
          key,
          privacy,
          tree: tree.snapshot,
          request: {
            task: 'search',
            query: 'Synthetic connection test: return an empty rankedIds array.',
            itemIds: [],
            folderIds: [],
          },
        });
        setError(result.status !== 'completed');
        setStatus(
          result.status === 'completed'
            ? '合成连接测试通过；不代表全部模型任务已验收。'
            : `模型请求未完成：${result.reason}。401检查密钥；403检查服务鉴权/Origin；429稍后手动重试；timeout调整超时；schema检查模型结构化输出；permission重新授权。`,
        );
      }
    } catch {
      setError(true);
      setStatus('配置或存储不可用：请选择协议、模型和超时；远程地址须HTTPS，HTTP仅限回环地址。');
    } finally {
      setBusy(false);
    }
  }
  const showModel = fields !== 'privacy';
  const showPrivacy = fields !== 'model';
  return (
    <section
      className="surface"
      aria-label={fields === 'privacy' ? '隐私' : fields === 'model' ? 'AI 模型' : '模型与隐私'}
    >
      {showHeading && <h2>{fields === 'privacy' ? '隐私' : fields === 'model' ? 'AI 模型' : '模型与隐私'}</h2>}
      {showModel && (
        <>
          <details className="settings-help">
            <summary>数据发送与密钥安全</summary>
            <p>
              请求发送到您配置的服务；本地不会自动切换云端。完整网址参数可能包含凭证。未排除的内网书签信息也可能发送。
            </p>
            <p>密钥默认仅当前页面会话使用。记住密钥存于本地扩展存储；不进入同步、日志、备份或导出。</p>
          </details>
          <label className="field">
            模型服务
            <Select aria-label="模型服务" value={presetId} onChange={e => choosePreset(e.target.value)}>
              <option value="custom">自定义兼容服务 / 已有配置</option>
              {modelPresets.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </label>
          {preset && preset.models.length > 0 && (
            <label className="field">
              预设模型
              <Select
                aria-label="预设模型"
                value={preset.models.includes(model) ? model : ''}
                onChange={e => {
                  cancel();
                  setModel(e.target.value);
                }}
              >
                <option value="">自定义模型 ID</option>
                {preset.models.map(id => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <details className="settings-help">
            <summary>如何选择模型</summary>
            <p className="hint">
              预设只是填写起点，不保证型号仍可用或支持全部任务。可随时填写自定义模型
              ID；本地请填写已安装模型。不会自动获取模型列表。
            </p>
          </details>
          <label className="field">
            接口协议
            <Select
              aria-label="接口协议"
              value={adapter}
              onChange={e => {
                cancel();
                setKey('');
                setRemember(false);
                setPresetId('custom');
                setAdapter(e.target.value);
              }}
            >
              <option value="">请选择</option>
              <option value="openai-compatible">OpenAI-compatible（JSON模式）</option>
              <option value="ollama">Ollama native</option>
              <option value="lm-studio">LM Studio structured</option>
            </Select>
          </label>
          <label className="field">
            服务基础地址
            <input
              value={baseUrl}
              onChange={e => {
                cancel();
                setKey('');
                setRemember(false);
                setPresetId('custom');
                setBaseUrl(e.target.value);
              }}
            />
          </label>
          <details className="settings-help">
            <summary>地址填写与本地服务</summary>
            <p className="hint">
              填写服务根/代理前缀（可以以 /v1 结尾，不会重复拼接），不含 /chat/completions 或
              /api/chat。主机权限不能精确限定端口/路径。Ollama需允许当前扩展Origin；不要通配放开服务。
            </p>
          </details>
          <label className="field">
            模型名称
            <input
              value={model}
              onChange={e => {
                cancel();
                setModel(e.target.value);
              }}
            />
          </label>
          <label className="field">
            超时（毫秒）
            <input
              type="number"
              min="1"
              value={timeout}
              onChange={e => {
                cancel();
                setTimeoutValue(e.target.value);
              }}
            />
          </label>
          <label className="field">
            API Key
            <input
              type="password"
              autoComplete="off"
              value={key}
              onChange={e => {
                cancel();
                setKey(e.target.value);
              }}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            明确记住密钥（本地明文存储）
          </label>
          <p className="hint">记住的密钥不是操作系统保险库保护的数据。</p>
        </>
      )}
      {showPrivacy && (
        <>
          <p>控制发送到模型服务的内容。排除目录不改变导出范围。</p>
          <label className="check">
            <input
              type="checkbox"
              checked={privacy.fullUrl}
              onChange={e => {
                cancel();
                setPrivacy({ ...privacy, fullUrl: e.target.checked });
              }}
            />
            发送完整网址（含查询参数和片段）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={privacy.bodyEnabled}
              onChange={e => {
                cancel();
                setPrivacy({ ...privacy, bodyEnabled: e.target.checked });
              }}
            />
            正文辅助（仅主动收藏）
          </label>
          <fieldset>
            <legend>AI排除目录（包括子目录；不改变导出范围）</legend>
            {tree.status !== 'ready' ? (
              <p>目录未就绪；现有排除配置保留。</p>
            ) : (
              tree.snapshot.nodes
                .filter(n => n.ref.kind === 'folder')
                .map(n => (
                  <label className="check" key={n.ref.nativeId}>
                    <input
                      type="checkbox"
                      checked={privacy.excludedFolders.some(
                        r => r.installationId === n.ref.installationId && r.nativeId === n.ref.nativeId,
                      )}
                      onChange={e => {
                        cancel();
                        setPrivacy({
                          ...privacy,
                          excludedFolders: e.target.checked
                            ? [...privacy.excludedFolders, n.ref]
                            : privacy.excludedFolders.filter(
                                r => r.installationId !== n.ref.installationId || r.nativeId !== n.ref.nativeId,
                              ),
                        });
                      }}
                    />
                    {n.title || '根目录'}（{n.ref.nativeId}）
                  </label>
                ))
            )}
          </fieldset>
        </>
      )}
      <div hidden={!status} role={error ? 'alert' : 'status'}>
        {status}
      </div>
      <div className="actions">
        <button disabled={busy} onClick={() => void run('save')}>
          {fields === 'privacy' ? '保存隐私设置' : '保存模型设置'}
        </button>
        {showModel && (
          <>
            <button disabled={busy} onClick={() => void run('authorize')}>
              授权模型主机
            </button>
            <button disabled={busy} onClick={() => void run('test')}>
              使用合成数据测试连接
            </button>
            <button
              onClick={() => {
                cancel();
                setStatus('已取消；不会自动重试。');
              }}
            >
              取消请求
            </button>
            <button disabled={busy} onClick={() => void run('delete')}>
              删除密钥
            </button>
          </>
        )}
      </div>
      {showModel && (
        <details className="settings-help">
          <summary>测试范围与请求生命周期</summary>
          <p>连接测试不代表全部任务已验证。关闭页面会取消请求，不自动重试。</p>
        </details>
      )}
    </section>
  );
}
function chromeSafeListeners(listener: () => void, add: boolean) {
  if (typeof chrome === 'undefined') return;
  for (const event of [chrome.permissions?.onRemoved]) {
    if (add) event?.addListener(listener);
    else event?.removeListener(listener);
  }
}
