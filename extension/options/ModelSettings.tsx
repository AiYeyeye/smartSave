import { useEffect, useRef, useState } from 'react';
import { SettingsStore, type ModelConfig } from '../persistence/settings';
import { parseModelEndpoint } from '../adapters/model-transport';
import { listModels } from '../adapters/model-discovery';
import type { TreeState } from '../domain/node-reference';
import { connectTree } from '../panel/tree-client';
import { testConnection } from '../adapters/ai-connection';
import { adapterToApiMode } from '../domain/ai-providers';
import { DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokensSchema, modelStreaming } from '../domain/model-route';
import { Select } from '../ui/Select';
import type { AiPrivacy } from '../domain/ai-payload';
import { modelPresets } from '../domain/model-presets';
import { useI18n } from '../ui/i18n';
import { modelSettingsNoticeText, type ModelSettingsNotice } from './model-settings-text';
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
  const { t, language, message } = useI18n();
  const [store] = useState(
    () => supplied ?? (typeof chrome !== 'undefined' && chrome.storage?.local ? browserStore() : undefined),
  );
  const [adapter, setAdapter] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [timeout, setTimeoutValue] = useState('');
  const [streaming, setStreaming] = useState<boolean | undefined>(undefined);
  const [fastMode, setFastMode] = useState<boolean | undefined>(undefined);
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(DEFAULT_MAX_OUTPUT_TOKENS));
  const outputLimitValid =
    !['openai-compatible', 'openai-responses', 'anthropic', 'google-generative-ai'].includes(adapter) ||
    maxOutputTokensSchema.safeParse(Number(maxOutputTokens)).success;
  const [presetId, setPresetId] = useState('custom');
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [listSource, setListSource] = useState<'remote' | 'curated' | ''>('');
  const preset = modelPresets.find(item => item.id === presetId);
  const modelChoices = discoveredModels.length
    ? discoveredModels
    : preset && preset.models.length > 0
      ? [...preset.models]
      : [];
  function choosePreset(id: string) {
    cancel();
    setKey('');
    setRemember(false);
    setDiscoveredModels([]);
    setListSource('');
    setPresetId(id);
    setStreaming(undefined);
    setFastMode(undefined);
    setMaxOutputTokens(String(DEFAULT_MAX_OUTPUT_TOKENS));
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
  const [status, setStatus] = useState<ModelSettingsNotice>('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const testAbort = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(true);
  const listAbort = useRef<AbortController | undefined>(undefined);
  const cancel = () => {
    generation.current++;
    testAbort.current?.abort();
    listAbort.current?.abort();
    setBusy(false);
  };
  useEffect(() => {
    let live = true;
    mounted.current = true;
    const loadGeneration = generation.current;
    if (store)
      void store
        .load()
        .then(value => {
          if (!live || generation.current !== loadGeneration) return;
          if (store.legacyCredentialDiscarded) setStatus('旧密钥未绑定服务，已移除；请重新输入。');
          setPrivacy(value.privacy);
          setKey(store.credential());
          if (value.presetId) setPresetId(value.presetId);
          if (value.config) {
            setAdapter(value.config.adapter);
            setBaseUrl(value.config.baseUrl);
            setModel(value.config.model);
            setTimeoutValue(String(value.config.timeoutMs));
            setStreaming(value.config.streaming);
            setFastMode(value.config.fastMode);
            setMaxOutputTokens(String(value.config.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS));
            if (!value.presetId) {
              const matched = modelPresets.find(
                item => item.adapter === value.config!.adapter && item.baseUrl === value.config!.baseUrl,
              );
              setPresetId(matched?.id ?? 'custom');
            }
          }
        })
        .catch(() => {
          if (live) {
            setError(true);
            setStatus('配置或存储不可用，请重新打开设置重试。');
          }
        });
    const changed = () => {
      generation.current++;
      testAbort.current?.abort();
      listAbort.current?.abort();
      if (mounted.current) setBusy(false);
    };
    const stop =
      typeof chrome !== 'undefined' && chrome.runtime
        ? connectTree(chrome.runtime, value => {
            if (live) setTree(value);
          })
        : undefined;
    chromeSafeListeners(changed, true);
    window.addEventListener('pagehide', changed);
    return () => {
      live = false;
      mounted.current = false;
      changed();
      listAbort.current?.abort();
      stop?.();
      if (!supplied) store?.dispose();
      chromeSafeListeners(changed, false);
      window.removeEventListener('pagehide', changed);
    };
  }, [store, supplied]);
  function draftRoute(): Pick<ModelConfig, 'adapter' | 'baseUrl' | 'timeoutMs'> {
    if (!adapter) throw Error();
    const timeoutMs = Number(timeout || '60000');
    const config = {
      adapter: adapter as ModelConfig['adapter'],
      baseUrl,
      model: model || 'pending',
      timeoutMs,
    };
    parseModelEndpoint(config);
    return { adapter: config.adapter, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
  }
  function configuration(): ModelConfig {
    const config = {
      adapter: adapter as ModelConfig['adapter'],
      baseUrl,
      model,
      timeoutMs: Number(timeout),
      ...(streaming === undefined ? {} : { streaming }),
      ...(fastMode === undefined ? {} : { fastMode }),
      ...(['openai-compatible', 'openai-responses', 'anthropic', 'google-generative-ai'].includes(adapter)
        ? { maxOutputTokens: Number(maxOutputTokens) }
        : {}),
    };
    parseModelEndpoint(config);
    return config;
  }
  async function run(action: 'save' | 'authorize-list' | 'test' | 'delete') {
    cancel();
    const operation = generation.current;
    const current = () => mounted.current && generation.current === operation;
    const updateStatus = (text: ModelSettingsNotice) => {
      if (current()) setStatus(text);
    };
    const updateError = (value: boolean) => {
      if (current()) setError(value);
    };
    setError(false);
    setBusy(true);
    try {
      if (!store) throw Error();
      if (action === 'delete') {
        await store.clearCredential();
        setKey('');
        setRemember(false);
        updateStatus('已删除保存的密钥。');
        return;
      }
      if (action === 'save' && fields === 'privacy') {
        await store.savePrivacy(privacy);
        updateStatus('隐私设置已保存；未配置模型不影响浏览。');
        return;
      }
      if (action === 'authorize-list') {
        const route = draftRoute();
        const permission = parseModelEndpoint({ ...route, model: model || 'pending' }).permission;
        const granted =
          typeof chrome !== 'undefined' && chrome.permissions
            ? await chrome.permissions.request({ origins: [permission] })
            : false;
        if (!granted) {
          updateError(true);
          updateStatus('模型主机权限被拒绝。');
          return;
        }
        if (!current()) return;
        listAbort.current = new AbortController();
        const result = await listModels({
          ...route,
          key,
          fetch: globalThis.fetch.bind(globalThis),
          contains: request => chrome.permissions.contains(request),
          signal: listAbort.current.signal,
          presetId,
        });
        if (!current()) return;
        if (result.status !== 'completed') {
          updateError(true);
          setDiscoveredModels([]);
          setListSource('');
          updateStatus({ kind: 'list-failed', reason: result.reason });
          return;
        }
        setDiscoveredModels(result.models);
        setListSource(result.source);
        if (result.models.length && !result.models.includes(model)) setModel(result.models[0]!);
        updateStatus(
          result.source === 'curated'
            ? '已授权；列表接口不可用，已填入常用模型，仍可手填自定义 ID。'
            : { kind: 'listed', count: result.models.length },
        );
        return;
      }
      const config = configuration();
      if (action === 'save') {
        await store.save(config, privacy, key, remember, presetId);
        updateStatus('模型设置已保存；尚未证明服务能力。');
      }
      if (action === 'test') {
        const controller = new AbortController();
        testAbort.current = controller;
        const result = await testConnection({
          draft: {
            mode: adapterToApiMode(config.adapter),
            adapter: config.adapter,
            baseUrl: config.baseUrl,
            model: config.model,
            timeoutMs: config.timeoutMs,
            streaming: config.streaming,
            fastMode: config.fastMode,
            maxOutputTokens: config.maxOutputTokens,
            key,
          },
          settings: store,
          signal: controller.signal,
          privacy,
        });
        updateError(result.status !== 'completed');
        updateStatus(
          result.status === 'completed'
            ? '合成分类测试通过；草稿未保存。'
            : { kind: 'test-failed', reason: result.reason },
        );
      }
    } catch {
      updateError(true);
      updateStatus('配置或存储不可用：请选择服务商或协议、模型和超时；远程地址须HTTPS，HTTP仅限回环地址。');
    } finally {
      if (current()) setBusy(false);
    }
  }
  const showModel = fields !== 'privacy';
  const showPrivacy = fields !== 'model';
  return (
    <section
      className="surface"
      aria-label={fields === 'privacy' ? t('隐私') : fields === 'model' ? t('AI 模型') : t('模型与隐私')}
    >
      {showHeading && <h2>{fields === 'privacy' ? t('隐私') : fields === 'model' ? t('AI 模型') : t('模型与隐私')}</h2>}
      {showModel && (
        <>
          <details className="settings-help">
            <summary>{t('数据发送与密钥安全')}</summary>
            <p>
              {t(
                '请求发送到您配置的服务；本地不会自动切换云端。完整网址参数可能包含凭证。未排除的内网书签信息也可能发送。',
              )}
            </p>
            <p>{t('密钥默认仅当前页面会话使用。记住密钥存于本地扩展存储；不进入同步、日志、备份或导出。')}</p>
          </details>
          <label className="field">
            {t('模型服务')}
            <Select aria-label={t('模型服务')} value={presetId} onChange={e => choosePreset(e.target.value)}>
              <option value="custom">{t('自定义')}</option>
              {modelPresets.map(item => (
                <option key={item.id} value={item.id}>
                  {message(item.name)}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            API Key
            <input
              type="password"
              autoComplete="off"
              aria-label="API Key"
              value={key}
              onChange={e => {
                cancel();
                setKey(e.target.value);
              }}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            {t('明确记住密钥（本地明文存储）')}
          </label>
          <p className="hint">{t('记住的密钥不是操作系统保险库保护的数据。')}</p>
          <label className="field">
            {t('模型')}
            <Select
              aria-label={t('模型')}
              value={modelChoices.includes(model) ? model : ''}
              onChange={e => {
                cancel();
                if (e.target.value) setModel(e.target.value);
              }}
            >
              <option value="">{t('手填模型 ID')}</option>
              {modelChoices.map(id => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            {t('模型名称')}
            <input
              aria-label={t('模型名称')}
              value={model}
              onChange={e => {
                cancel();
                setModel(e.target.value);
              }}
            />
          </label>
          {listSource === 'curated' && <p className="hint">{t('当前列表为常用模型兜底，不是实时发现结果。')}</p>}
          <label className="field">
            <input
              type="checkbox"
              aria-label={t('流式响应')}
              checked={modelStreaming({ adapter: adapter as ModelConfig['adapter'], streaming })}
              disabled={adapter === 'ollama'}
              onChange={e => {
                cancel();
                setStreaming(e.target.checked);
              }}
            />
            {t('流式响应（关闭后使用 JSON）')}
          </label>
          <label className="field">
            <input
              type="checkbox"
              aria-label={t('优先快速响应')}
              checked={fastMode ?? true}
              onChange={e => {
                cancel();
                setFastMode(e.target.checked);
              }}
            />
            {t('优先快速响应（对已支持的模型降低思考量）')}
          </label>
          <details className="settings-help">
            <summary>{t('高级：协议、地址与超时')}</summary>
            {['openai-compatible', 'openai-responses', 'anthropic', 'google-generative-ai'].includes(adapter) && (
              <label className="field">
                {t('最大输出 tokens')}
                <input
                  aria-label={t('最大输出 tokens')}
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  value={maxOutputTokens}
                  aria-invalid={!outputLimitValid}
                  onChange={e => {
                    cancel();
                    setMaxOutputTokens(e.target.value);
                  }}
                />
                <span className="hint">{t('默认 128,000，包含推理和正文。请填写所选模型支持的输出额度。')}</span>
                {!outputLimitValid && <span role="alert">{t('输出上限请输入大于或等于 1 的有效整数。')}</span>}
              </label>
            )}
            <label className="field">
              {t('接口协议')}
              <Select
                aria-label={t('接口协议')}
                value={adapter}
                onChange={e => {
                  cancel();
                  setKey('');
                  setRemember(false);
                  setDiscoveredModels([]);
                  setListSource('');
                  setPresetId('custom');
                  setAdapter(e.target.value);
                }}
              >
                <option value="">{t('请选择')}</option>
                <option value="openai-compatible">OpenAI Chat Completions</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic">Anthropic Messages</option>
                <option value="google-generative-ai">Google Generative AI</option>
                <option value="ollama">Ollama native</option>
                <option value="lm-studio">LM Studio structured</option>
              </Select>
            </label>
            <label className="field">
              {t('服务基础地址')}
              <input
                aria-label={t('服务基础地址')}
                value={baseUrl}
                onChange={e => {
                  cancel();
                  setKey('');
                  setRemember(false);
                  setDiscoveredModels([]);
                  setListSource('');
                  setPresetId('custom');
                  setBaseUrl(e.target.value);
                }}
              />
            </label>
            <p className="hint">
              {t(
                '填写服务根/代理前缀（可以以 /v1 结尾，不会重复拼接）。Anthropic 使用 /v1/messages；兼容协议使用 /v1/chat/completions；Ollama 使用 /api/chat。主机权限不能精确限定端口/路径。',
              )}
            </p>
            <label className="field">
              {t('超时（毫秒）')}
              <input
                type="number"
                min="1"
                aria-label={t('超时（毫秒）')}
                value={timeout}
                onChange={e => {
                  cancel();
                  setTimeoutValue(e.target.value);
                }}
              />
            </label>
            <p className="hint">
              {t('流式响应按连续无事件或心跳的时间计时；持续收到数据会继续等待。非流式响应按总时间计时。')}
            </p>
          </details>
        </>
      )}
      {showPrivacy && (
        <>
          <p>{t('控制发送到模型服务的内容。排除目录不改变导出范围。')}</p>
          <label className="check">
            <input
              type="checkbox"
              checked={privacy.fullUrl}
              onChange={e => {
                cancel();
                setPrivacy({ ...privacy, fullUrl: e.target.checked });
              }}
            />
            {t('发送完整网址（含查询参数和片段）')}
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
            {t('正文辅助（仅主动收藏）')}
          </label>
          <fieldset>
            <legend>{t('AI排除目录（包括子目录；不改变导出范围）')}</legend>
            {tree.status !== 'ready' ? (
              <p>{t('目录未就绪；现有排除配置保留。')}</p>
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
                    {n.title || t('根目录')}（{n.ref.nativeId}）
                  </label>
                ))
            )}
          </fieldset>
        </>
      )}
      <div hidden={!status} role={error ? 'alert' : 'status'}>
        {modelSettingsNoticeText(language, status)}
      </div>
      <div className="actions">
        <button disabled={busy || !outputLimitValid} onClick={() => void run('save')}>
          {fields === 'privacy' ? t('保存隐私设置') : t('保存模型设置')}
        </button>
        {showModel && (
          <>
            <button disabled={busy} onClick={() => void run('authorize-list')}>
              {t('授权并获取模型')}
            </button>
            <button disabled={busy || !outputLimitValid} onClick={() => void run('test')}>
              {t('使用合成数据测试连接')}
            </button>
            <button
              onClick={() => {
                cancel();
                setStatus('已取消；不会自动重试。');
              }}
            >
              {t('取消请求')}
            </button>
            <button disabled={busy} onClick={() => void run('delete')}>
              {t('删除密钥')}
            </button>
          </>
        )}
      </div>
      {showModel && (
        <details className="settings-help">
          <summary>{t('测试范围与请求生命周期')}</summary>
          <p>{t('连接测试不代表全部任务已验证。关闭页面会取消请求，不自动重试。')}</p>
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
