import { useEffect, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import type { ApiMode, ConnectedService, ModelMeta } from './mock-data';
import { API_MODE_OPTIONS } from '../../domain/ai-providers';
import { discoverModels, modelsToCatalog, requestHostPermission, testConnection } from '../../adapters/ai-connection';
import { ModelTransport } from '../../adapters/model-transport';
import { browserModelAuthority } from '../../adapters/model-authority';
import type { SettingsStore } from '../../persistence/settings';
import { connectTree } from '../../panel/tree-client';
import type { TreeState } from '../../domain/node-reference';
import type { AiPrivacy } from '../../domain/ai-payload';
import { Avatar } from './Avatar';
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
  }));
  const [keyValue, setKeyValue] = useState(initialKey);
  const [remember, setRemember] = useState(Boolean(initialKey));
  const [catalogQ, setCatalogQ] = useState('');
  const [addedQ, setAddedQ] = useState('');
  const [customId, setCustomId] = useState('');
  const [testing, setTesting] = useState(false);
  const [listing, setListing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tree, setTree] = useState<TreeState>({ status: 'loading' });
  const transport = useRef<ModelTransport | undefined>(undefined);
  const listAbort = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let live = true;
    if (settings && typeof chrome !== 'undefined' && chrome.permissions) {
      transport.current = new ModelTransport(
        { fetch: globalThis.fetch.bind(globalThis), contains: request => chrome.permissions.contains(request) },
        browserModelAuthority(settings),
      );
    }
    const stop =
      typeof chrome !== 'undefined' && chrome.runtime
        ? connectTree(chrome.runtime, value => {
            if (live) setTree(value);
          })
        : undefined;
    return () => {
      live = false;
      listAbort.current?.abort();
      transport.current?.dispose();
      stop?.();
    };
  }, [settings]);

  const catalogFiltered = draft.catalog.filter(
    m => !catalogQ.trim() || m.id.toLowerCase().includes(catalogQ.trim().toLowerCase()),
  );
  const enabledFiltered = draft.enabled.filter(
    id => !addedQ.trim() || id.toLowerCase().includes(addedQ.trim().toLowerCase()),
  );

  function toggleModel(id: string, checked: boolean) {
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
    setDraft(d => {
      const catalog = d.catalog.some(m => m.id === id) ? d.catalog : [...d.catalog, { id, ctx: '自定义' }];
      const enabled = d.enabled.includes(id) ? d.enabled : [...d.enabled, id];
      return { ...d, catalog, enabled };
    });
    setCustomId('');
    toast('已添加自定义模型');
  }

  async function save() {
    const baseUrl = draft.baseUrl.trim() || service.baseUrl;
    if (!baseUrl) {
      toast('请填写接口地址');
      return;
    }
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
    setListing(true);
    listAbort.current?.abort();
    listAbort.current = new AbortController();
    try {
      const draftConn = {
        mode: draft.mode,
        baseUrl,
        key: keyValue,
        vendorId: service.vendorId,
        timeoutMs: draft.timeoutMs,
      };
      const granted = await requestHostPermission(draftConn);
      if (!granted) {
        toast('模型主机权限被拒绝');
        return;
      }
      const result = await discoverModels(draftConn, { signal: listAbort.current.signal });
      if (result.status !== 'completed') {
        toast(`未能获取模型列表：${result.reason}`);
        return;
      }
      const catalog = modelsToCatalog(result.models);
      setDraft(d => {
        const enabled = d.enabled.filter(id => catalog.some(m => m.id === id) || d.catalog.some(m => m.id === id && m.ctx === '自定义'));
        const custom = d.catalog.filter(m => m.ctx === '自定义' && !catalog.some(c => c.id === m.id));
        return { ...d, catalog: [...catalog, ...custom], enabled: enabled.length ? enabled : catalog.slice(0, 3).map(m => m.id) };
      });
      toast(
        result.source === 'curated'
          ? '列表接口不可用，已填入常用模型'
          : `已获取 ${result.models.length} 个模型`,
      );
    } catch {
      toast('获取列表失败');
    } finally {
      setListing(false);
    }
  }

  async function test() {
    const baseUrl = draft.baseUrl.trim();
    if (!baseUrl) {
      toast('请先填写接口地址');
      return;
    }
    setTesting(true);
    try {
      const model = draft.enabled[0] || draft.catalog[0]?.id;
      const draftConn = {
        mode: draft.mode,
        baseUrl,
        key: keyValue,
        vendorId: service.vendorId,
        timeoutMs: draft.timeoutMs,
        model,
      };
      const granted = await requestHostPermission(draftConn);
      if (!granted) {
        toast('模型主机权限被拒绝');
        return;
      }
      let privacy: AiPrivacy = { fullUrl: true, bodyEnabled: false, excludedFolders: [] };
      if (settings) {
        try {
          privacy = (await settings.snapshot()).privacy;
        } catch {
          /* use defaults */
        }
      }
      const result = await testConnection({
        draft: draftConn,
        transport: transport.current,
        tree: tree.status === 'ready' ? tree.snapshot : undefined,
        privacy,
      });
      if (result.status === 'completed') {
        toast(result.via === 'synthetic' ? '合成连接测试通过' : '连接测试通过（模型列表可达）');
      } else {
        toast(`连接失败：${result.reason}`);
      }
    } catch {
      toast('连接测试失败');
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="ai-svc-edit-overlay" role="dialog" aria-modal="true" aria-labelledby="ai-edit-title">
      <div className="ai-svc-edit-topbar">
        <h2 id="ai-edit-title">编辑 AI 服务</h2>
        <div className="actions">
          <button
            type="button"
            className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm"
            onClick={() => toast('高级设置：超时等请在接口模式旁调整；更多项后续开放')}
          >
            高级设置
          </button>
          <button type="button" className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm" disabled={testing} onClick={() => void test()}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <button type="button" className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm" onClick={onClose}>
            取消
          </button>
          <button type="button" className="ai-svc-act ai-svc-act-primary ai-svc-act-sm" disabled={saving} onClick={() => void save()}>
            {saving ? '保存中…' : '保存服务'}
          </button>
        </div>
      </div>
      <div className="ai-svc-edit-body">
        <div className="ai-svc-edit-fields">
          <div className="ai-svc-field">
            <label>服务</label>
            <div className="ai-svc-type-row">
              <Avatar letter={draft.letter} avatarClass={draft.avatarClass} size="sm" />
              <div className="type-meta">
                <strong>{draft.serviceType}</strong>
                <span>{draft.kind === 'sub' ? '订阅登录' : 'API Key'}</span>
              </div>
              <button type="button" className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm" onClick={onChangeService}>
                更换
              </button>
            </div>
          </div>
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
          <label className="ai-svc-check">
            <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
            记住密钥（本地扩展存储）
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
                      <button type="button" className="ai-svc-icon-x" aria-label="移除" onClick={() => toggleModel(id, false)}>
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
    </div>
  );
}
