import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { ApiMode, ConnectedService, ModelMeta } from './mock-data';
import { API_MODE_OPTIONS } from '../../domain/ai-providers';
import { DEFAULT_MAX_OUTPUT_TOKENS, maxOutputTokensSchema } from '../../domain/model-route';
import { discoverModels, modelsToCatalog, requestHostPermission, testConnection } from '../../adapters/ai-connection';
import type { SettingsStore } from '../../persistence/settings';
import { Avatar } from './Avatar';
import { DialogPortal } from './portal';
import { useToast } from './toast';

type Draft = {
  name: string;
  baseUrl: string;
  mode: ApiMode;
  serviceType: string;
  kind: ConnectedService['kind'];
  letter: string;
  avatarClass: string;
  catalog: ModelMeta[];
  enabled: string[];
  timeoutMs: number;
  streaming: boolean;
  maxOutputTokens: string;
};

export function EditServiceOverlay({
  service,
  initialKey,
  settings,
  onClose,
  onSave,
  onChangeService,
}: {
  service: ConnectedService;
  initialKey: string;
  settings?: SettingsStore;
  onClose: () => void;
  onSave: (next: ConnectedService, key: string, remember: boolean) => Promise<void> | void;
  onChangeService: () => void;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft>(() => ({
    name: service.name,
    baseUrl: service.baseUrl || service.detail,
    mode: service.mode || 'openai',
    serviceType: service.serviceType || service.name,
    kind: service.kind,
    letter: service.letter,
    avatarClass: service.avatarClass,
    catalog: service.catalog.map(m => ({ ...m })),
    enabled: [...service.enabled],
    timeoutMs: service.timeoutMs ?? 60000,
    streaming: service.streaming ?? true,
    maxOutputTokens: String(service.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
  }));
  const [keyValue, setKeyValue] = useState(initialKey);
  const outputLimitValid = maxOutputTokensSchema.safeParse(Number(draft.maxOutputTokens)).success;
  const outputLimit = Number(draft.maxOutputTokens);
  const [remember, setRemember] = useState(Boolean(initialKey));
  const [catalogQ, setCatalogQ] = useState('');
  const [addedQ, setAddedQ] = useState('');
  const [customId, setCustomId] = useState('');
  const [testing, setTesting] = useState(false);
  const [listing, setListing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testModel, setTestModel] = useState(service.enabled[0] ?? service.catalog[0]?.id ?? '');
  const listAbort = useRef<AbortController | undefined>(undefined);
  const testAbort = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(true);
  const invalidate = () => {
    generation.current++;
    listAbort.current?.abort();
    testAbort.current?.abort();
    setListing(false);
    setTesting(false);
  };
  const close = () => {
    invalidate();
    onClose();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      listAbort.current?.abort();
      testAbort.current?.abort();
    };
  }, []);

  const catalogFiltered = draft.catalog.filter(
    m => !catalogQ.trim() || m.id.toLowerCase().includes(catalogQ.trim().toLowerCase()),
  );
  const enabledFiltered = draft.enabled.filter(
    id => !addedQ.trim() || id.toLowerCase().includes(addedQ.trim().toLowerCase()),
  );

  function toggleModel(id: string, checked: boolean) {
    invalidate();
    setDraft(d => ({
      ...d,
      enabled: checked ? (d.enabled.includes(id) ? d.enabled : [...d.enabled, id]) : d.enabled.filter(x => x !== id),
    }));
  }

  function addCustom() {
    const id = customId.trim();
    if (!id) {
      toast('请输入模型 ID');
      return;
    }
    invalidate();
    setDraft(d => {
      const catalog = d.catalog.some(m => m.id === id) ? d.catalog : [...d.catalog, { id, ctx: '自定义' }];
      const enabled = d.enabled.includes(id) ? d.enabled : [...d.enabled, id];
      return { ...d, catalog, enabled };
    });
    setCustomId('');
    toast('已添加自定义模型');
  }

  async function save() {
    if (!outputLimitValid) return;
    const baseUrl = draft.baseUrl.trim() || service.baseUrl;
    if (!baseUrl) {
      toast('请填写接口地址');
      return;
    }
    invalidate();
    setSaving(true);
    try {
      await onSave(
        {
          ...service,
          name: draft.name.trim() || service.name,
          baseUrl,
          detail: baseUrl.replace(/^https?:\/\//, ''),
          mode: draft.mode,
          catalog: draft.catalog,
          enabled: draft.enabled,
          timeoutMs: draft.timeoutMs,
          streaming: draft.streaming,
          maxOutputTokens: outputLimit,
          status: service.status,
        },
        keyValue,
        remember,
      );
      toast('已保存服务');
      onClose();
    } catch {
      toast('保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function refreshList() {
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      toast('请先填写接口地址');
      return;
    }
    invalidate();
    const operation = generation.current;
    const controller = new AbortController();
    listAbort.current = controller;
    const current = () => mounted.current && generation.current === operation && !controller.signal.aborted;
    setListing(true);
    try {
      const draftConn = {
        mode: draft.mode,
        baseUrl,
        key: keyValue,
        vendorId: service.vendorId,
        timeoutMs: draft.timeoutMs,
      };
      const granted = await requestHostPermission(draftConn);
      if (!current()) return;
      if (!granted) {
        toast('模型主机权限被拒绝');
        return;
      }
      const result = await discoverModels(draftConn, { signal: controller.signal });
      if (!current()) return;
      if (result.status !== 'completed') {
        toast(`未能获取模型列表：${result.reason}`);
        return;
      }
      const catalog = modelsToCatalog(result.models);
      setDraft(d => {
        const enabled = d.enabled.filter(
          id => catalog.some(m => m.id === id) || d.catalog.some(m => m.id === id && m.ctx === '自定义'),
        );
        const custom = d.catalog.filter(m => m.ctx === '自定义' && !catalog.some(c => c.id === m.id));
        return {
          ...d,
          catalog: [...catalog, ...custom],
          enabled: enabled.length ? enabled : catalog.slice(0, 3).map(m => m.id),
        };
      });
      toast(
        result.source === 'curated'
          ? '列表接口不可用，已填入常用模型；尚未验证生成能力'
          : `已获取 ${result.models.length} 个模型；尚未验证生成能力`,
      );
    } catch {
      if (current()) toast('获取列表失败');
    } finally {
      if (current()) {
        setListing(false);
        listAbort.current = undefined;
      }
    }
  }

  async function test() {
    if (!outputLimitValid) return;
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      toast('请先填写接口地址');
      return;
    }
    const candidates = [...new Set([...draft.enabled, ...draft.catalog.map(m => m.id)])];
    const model = candidates.includes(testModel) ? testModel : candidates[0];
    if (!model) {
      toast('请先添加并选择测试模型');
      return;
    }
    invalidate();
    const operation = generation.current;
    const controller = new AbortController();
    testAbort.current = controller;
    const current = () => mounted.current && generation.current === operation && !controller.signal.aborted;
    setTesting(true);
    try {
      const draftConn = {
        mode: draft.mode,
        baseUrl,
        key: keyValue,
        vendorId: service.vendorId,
        timeoutMs: draft.timeoutMs,
        streaming: draft.streaming,
        maxOutputTokens: outputLimit,
        model,
      };
      const granted = await requestHostPermission(draftConn);
      if (!current()) return;
      if (!granted) {
        toast('模型主机权限被拒绝');
        return;
      }
      const result = await testConnection({ draft: draftConn, settings, signal: controller.signal });
      if (!current()) return;
      toast(result.status === 'completed' ? `合成分类测试通过：${model}` : `分类测试失败：${result.reason}`);
    } catch {
      if (current()) toast('分类测试失败');
    } finally {
      if (current()) {
        setTesting(false);
        testAbort.current = undefined;
      }
    }
  }

  return (
    <DialogPortal>
      <div className="ai-svc-backdrop" aria-hidden="true" onClick={close} />
      <div
        className="ai-svc-edit-overlay ai-svc-dialog is-large"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-edit-title"
      >
        <header className="ai-svc-dialog-head">
          <Avatar letter={draft.letter} avatarClass={draft.avatarClass} size="lg" />
          <div>
            <h2 id="ai-edit-title">编辑 AI 服务</h2>
            <p>
              {draft.serviceType} · {draft.kind === 'sub' ? '订阅登录' : 'API Key'} · 已启用 {draft.enabled.length}{' '}
              个模型
            </p>
          </div>
          <button
            type="button"
            className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm"
            onClick={() => {
              invalidate();
              onChangeService();
            }}
          >
            更换服务
          </button>
          <button type="button" className="ai-svc-dialog-close" aria-label="关闭" onClick={close}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="ai-svc-edit-body" onChangeCapture={invalidate}>
          <div className="ai-svc-edit-fields">
            <div className="ai-svc-edit-row two">
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-name">名称</label>
                <input
                  id="ai-edit-name"
                  type="text"
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  autoComplete="off"
                />
              </div>
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-base">接口地址</label>
                <input
                  id="ai-edit-base"
                  type="url"
                  value={draft.baseUrl}
                  onChange={e => setDraft(d => ({ ...d, baseUrl: e.target.value }))}
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="ai-svc-edit-row two">
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-key">API 密钥</label>
                <input
                  id="ai-edit-key"
                  type="password"
                  value={keyValue}
                  onChange={e => setKeyValue(e.target.value)}
                  autoComplete="off"
                  placeholder={initialKey ? undefined : '输入 API Key'}
                />
              </div>
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-mode">接口模式</label>
                <select
                  id="ai-edit-mode"
                  value={draft.mode}
                  onChange={e => setDraft(d => ({ ...d, mode: e.target.value as ApiMode }))}
                >
                  {API_MODE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="ai-svc-field">
              <label htmlFor="ai-edit-timeout">请求超时（毫秒）</label>
              <small>流式响应按连续无事件或心跳的时间计时；持续收到数据会继续等待。非流式响应按总时间计时。</small>
              <input
                id="ai-edit-timeout"
                type="number"
                min="1"
                max="2147483647"
                value={draft.timeoutMs}
                onChange={e => setDraft(d => ({ ...d, timeoutMs: Number(e.target.value) }))}
              />
            </div>
            {
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-output-limit">最大输出 tokens</label>
                <input
                  id="ai-edit-output-limit"
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  value={draft.maxOutputTokens}
                  aria-invalid={!outputLimitValid}
                  aria-describedby="ai-edit-output-limit-help"
                  onChange={e => setDraft(d => ({ ...d, maxOutputTokens: e.target.value }))}
                />
                <p id="ai-edit-output-limit-help" className="hint">
                  默认 128,000，包含推理和正文。请填写所选模型支持的输出额度。
                </p>
                {!outputLimitValid && <p role="alert">输出上限请输入大于或等于 1 的有效整数。</p>}
              </div>
            }
            <div className="ai-svc-field">
              <label htmlFor="ai-test-model">测试模型</label>
              <select
                id="ai-test-model"
                value={
                  [...draft.enabled, ...draft.catalog.map(m => m.id)].includes(testModel)
                    ? testModel
                    : (draft.enabled[0] ?? draft.catalog[0]?.id ?? '')
                }
                onChange={e => setTestModel(e.target.value)}
              >
                {[...new Set([...draft.enabled, ...draft.catalog.map(m => m.id)])].map(id => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
            <label className="ai-svc-toggle-row">
              <span>
                <strong>流式响应</strong>
                <small>使用所选协议的原生流式接口；关闭后使用 JSON 响应。</small>
              </span>
              <span className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={draft.streaming}
                  onChange={e => setDraft(d => ({ ...d, streaming: e.target.checked }))}
                />
                <span />
              </span>
            </label>
            <label className="ai-svc-toggle-row">
              <span>
                <strong>记住密钥</strong>
                <small>后台自动归类收藏需要它；保存在本机扩展存储，不上传。</small>
              </span>
              <span className="switch">
                <input type="checkbox" role="switch" checked={remember} onChange={e => setRemember(e.target.checked)} />
                <span />
              </span>
            </label>
          </div>
          <div className="ai-svc-models-split">
            <div className="ai-svc-models-pane">
              <div className="ai-svc-models-head">
                <h3>该服务的模型</h3>
                <button
                  type="button"
                  className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm"
                  disabled={listing}
                  onClick={() => void refreshList()}
                >
                  {listing ? '获取中…' : '获取列表'}
                </button>
                <div className="ai-svc-mini-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="搜索模型 ID..."
                    aria-label="搜索模型 ID"
                    value={catalogQ}
                    onChange={e => setCatalogQ(e.target.value)}
                  />
                </div>
              </div>
              <div className="ai-svc-models-body">
                {catalogFiltered.length === 0 ? (
                  <div className="ai-svc-picker-empty">没有匹配的模型</div>
                ) : (
                  catalogFiltered.map(m => (
                    <div key={m.id} className="ai-svc-catalog-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={draft.enabled.includes(m.id)}
                          onChange={e => toggleModel(m.id, e.target.checked)}
                        />
                        <span className="ai-svc-mid">{m.id}</span>
                      </label>
                      <span className="ai-svc-ctx">{m.ctx}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="ai-svc-models-pane">
              <div className="ai-svc-models-head">
                <h3>模型设置</h3>
                <span className="count">{draft.enabled.length}</span>
                <div className="ai-svc-mini-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    placeholder="搜索已添加模型..."
                    aria-label="搜索已添加模型"
                    value={addedQ}
                    onChange={e => setAddedQ(e.target.value)}
                  />
                </div>
              </div>
              <div className="ai-svc-models-body">
                {enabledFiltered.length === 0 ? (
                  <div className="ai-svc-picker-empty">尚未添加模型，可在左侧勾选或自定义添加</div>
                ) : (
                  enabledFiltered.map(id => {
                    const meta = draft.catalog.find(m => m.id === id);
                    return (
                      <div key={id} className="ai-svc-added-item">
                        <span className="ai-svc-drag" aria-hidden="true">
                          ⠿
                        </span>
                        <span className="ai-svc-mid">{id}</span>
                        <span className="ai-svc-ctx">{meta?.ctx ?? '自定义'}</span>
                        <button
                          type="button"
                          className="ai-svc-icon-x"
                          aria-label="移除"
                          onClick={() => toggleModel(id, false)}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="ai-svc-custom-add">
                <input
                  type="text"
                  placeholder="输入模型 ID，如 my-model-v2"
                  value={customId}
                  onChange={e => setCustomId(e.target.value)}
                  autoComplete="off"
                />
                <button type="button" className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm" onClick={addCustom}>
                  + 添加自定义模型
                </button>
              </div>
            </div>
          </div>
        </div>
        <footer className="ai-svc-dialog-foot">
          <button
            type="button"
            className="ai-svc-act ai-svc-act-ghost"
            disabled={testing || !outputLimitValid}
            onClick={() => void test()}
          >
            {testing ? (
              <>
                <span className="ai-svc-spinner" />
                测试中…
              </>
            ) : (
              '测试连接'
            )}
          </button>
          <span className="ai-svc-dialog-hint" />
          <button type="button" className="ai-svc-act ai-svc-act-ghost" onClick={close}>
            取消
          </button>
          <button
            type="button"
            className="ai-svc-act ai-svc-act-primary"
            disabled={saving || !outputLimitValid}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存服务'}
          </button>
        </footer>
      </div>
    </DialogPortal>
  );
}
