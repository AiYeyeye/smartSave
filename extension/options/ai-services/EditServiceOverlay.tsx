import { useI18n } from '../../ui/i18n';
import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { ApiMode, ConnectedService, ModelMeta } from './mock-data';
import { API_MODE_OPTIONS } from '../../domain/ai-providers';
import { maxOutputTokensSchema, REASONING_EFFORTS, type ReasoningEffort } from '../../domain/model-route';
import { reasoningEffortOf } from '../../domain/model-thinking';
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
  reasoningEffort: ReasoningEffort;
  maxOutputTokens: string;
};
const EFFORT_LABELS = {
  low: '低（推荐）',
  none: '关闭思考',
  medium: '中等',
  high: '高（更慢）',
  default: '模型默认',
} as const satisfies Record<ReasoningEffort, string>;

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
  const { t, message } = useI18n();
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
    reasoningEffort: reasoningEffortOf(service),
    maxOutputTokens: service.maxOutputTokens === undefined ? '' : String(service.maxOutputTokens),
  }));
  const [keyValue, setKeyValue] = useState(initialKey);
  const outputLimitValid =
    !draft.maxOutputTokens.trim() || maxOutputTokensSchema.safeParse(Number(draft.maxOutputTokens)).success;
  const outputLimit = draft.maxOutputTokens.trim() ? Number(draft.maxOutputTokens) : undefined;
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
          // The effort replaces the old fast-mode switch.
          fastMode: undefined,
          reasoningEffort: draft.reasoningEffort,
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
          enabled,
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
        reasoningEffort: draft.reasoningEffort,
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
            <h2 id="ai-edit-title">{t('编辑 AI 服务')}</h2>
            <p>
              {message(draft.serviceType)} · {draft.kind === 'sub' ? t('订阅登录') : 'API Key'} ·{' '}
              {t('已启用 {count} 个模型', { count: draft.enabled.length })}
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
            {t('更换服务')}
          </button>
          <button type="button" className="ai-svc-dialog-close" aria-label={t('关闭')} onClick={close}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="ai-svc-edit-body" onChangeCapture={invalidate}>
          <div className="ai-svc-edit-fields">
            <div className="ai-svc-edit-row two">
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-name">{t('名称')}</label>
                <input
                  id="ai-edit-name"
                  type="text"
                  value={draft.name}
                  onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                  autoComplete="off"
                />
              </div>
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-base">{t('接口地址')}</label>
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
                <label htmlFor="ai-edit-key">{t('API 密钥')}</label>
                <input
                  id="ai-edit-key"
                  type="password"
                  value={keyValue}
                  onChange={e => setKeyValue(e.target.value)}
                  autoComplete="off"
                  placeholder={initialKey ? undefined : t('输入 API Key')}
                />
              </div>
              <div className="ai-svc-field">
                <label htmlFor="ai-edit-mode">{t('接口模式')}</label>
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
              <label htmlFor="ai-edit-timeout">{t('请求超时（毫秒）')}</label>
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
                <label htmlFor="ai-edit-output-limit">{t('最大输出 tokens')}</label>
                <input
                  id="ai-edit-output-limit"
                  type="number"
                  min={1}
                  max={Number.MAX_SAFE_INTEGER}
                  step={1}
                  value={draft.maxOutputTokens}
                  aria-invalid={!outputLimitValid}
                  title={t(
                    '留空使用服务默认上限；Anthropic 使用兼容上限。自定义值须在模型支持范围内，思考可能占用输出额度。',
                  )}
                  onChange={e => setDraft(d => ({ ...d, maxOutputTokens: e.target.value }))}
                />
                <p>
                  {t(
                    '留空使用服务默认上限；Anthropic 使用兼容上限。自定义值须在模型支持范围内，思考可能占用输出额度。',
                  )}
                </p>
                {!outputLimitValid && <p role="alert">{t('输出上限请输入大于或等于 1 的有效整数。')}</p>}
              </div>
            }
            <div className="ai-svc-field">
              <label htmlFor="ai-test-model">{t('测试模型')}</label>
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
                <strong>{t('流式响应')}</strong>
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
                <strong>{t('记住密钥')}</strong>
              </span>
              <span className="switch">
                <input type="checkbox" role="switch" checked={remember} onChange={e => setRemember(e.target.checked)} />
                <span />
              </span>
            </label>
            <div className="ai-svc-field">
              <label htmlFor="ai-edit-reasoning">{t('思考强度')}</label>
              <select
                id="ai-edit-reasoning"
                value={draft.reasoningEffort}
                title={t('推理模型想得越多越慢，思考内容也计入输出上限。不支持的模型会自动忽略。')}
                onChange={e => {
                  invalidate();
                  setDraft(d => ({ ...d, reasoningEffort: e.target.value as ReasoningEffort }));
                }}
              >
                {REASONING_EFFORTS.map(effort => (
                  <option key={effort} value={effort}>
                    {t(EFFORT_LABELS[effort])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="ai-svc-models-split">
            <div className="ai-svc-models-pane">
              <div className="ai-svc-models-head">
                <h3>{t('该服务的模型')}</h3>
                <button
                  type="button"
                  className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm"
                  disabled={listing}
                  onClick={() => void refreshList()}
                >
                  {listing ? t('获取中…') : t('获取列表')}
                </button>
                <div className="ai-svc-mini-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    placeholder={t('搜索模型 ID...')}
                    aria-label={t('搜索模型 ID')}
                    value={catalogQ}
                    onChange={e => setCatalogQ(e.target.value)}
                  />
                </div>
              </div>
              <div className="ai-svc-models-body">
                {catalogFiltered.length === 0 ? (
                  <div className="ai-svc-picker-empty">{t('没有匹配的模型')}</div>
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
                      <span className="ai-svc-ctx">{message(m.ctx)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="ai-svc-models-pane">
              <div className="ai-svc-models-head">
                <h3>{t('模型设置')}</h3>
                <span className="count">{draft.enabled.length}</span>
                <div className="ai-svc-mini-search">
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    placeholder={t('搜索已添加模型...')}
                    aria-label={t('搜索已添加模型')}
                    value={addedQ}
                    onChange={e => setAddedQ(e.target.value)}
                  />
                </div>
              </div>
              <div className="ai-svc-models-body">
                {enabledFiltered.length === 0 ? (
                  <div className="ai-svc-picker-empty">{t('尚未添加模型，可在左侧勾选或自定义添加')}</div>
                ) : (
                  enabledFiltered.map(id => {
                    const meta = draft.catalog.find(m => m.id === id);
                    return (
                      <div key={id} className="ai-svc-added-item">
                        <span className="ai-svc-drag" aria-hidden="true">
                          ⠿
                        </span>
                        <span className="ai-svc-mid">{id}</span>
                        <span className="ai-svc-ctx">{meta?.ctx ? message(meta.ctx) : t('自定义')}</span>
                        <button
                          type="button"
                          className="ai-svc-icon-x"
                          aria-label={t('移除')}
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
                  placeholder={t('输入模型 ID，如 my-model-v2')}
                  value={customId}
                  onChange={e => setCustomId(e.target.value)}
                  autoComplete="off"
                />
                <button type="button" className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm" onClick={addCustom}>
                  {t('+ 添加自定义模型')}
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
                {t('测试中…')}
              </>
            ) : (
              t('测试连接')
            )}
          </button>
          <span className="ai-svc-dialog-hint" />
          <button type="button" className="ai-svc-act ai-svc-act-ghost" onClick={close}>
            {t('取消')}
          </button>
          <button
            type="button"
            className="ai-svc-act ai-svc-act-primary"
            disabled={saving || !outputLimitValid}
            onClick={() => void save()}
          >
            {saving ? t('保存中…') : t('保存服务')}
          </button>
        </footer>
      </div>
    </DialogPortal>
  );
}
