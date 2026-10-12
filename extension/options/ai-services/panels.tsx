import { useRef, useState } from 'react';
import { Download, Search, Upload } from 'lucide-react';
import type { ConnectedService, FeatureAssignment, Vendor } from './mock-data';
import { KEY_VENDORS, SUB_VENDORS, catalogFromVendor } from './mock-data';
import { oauthFailureText, signInWithOpenRouter } from '../../adapters/openrouter-oauth';
import { adapterToApiMode, API_MODE_OPTIONS, type ApiMode } from '../../domain/ai-providers';
import { discoverModels, modelsToCatalog, requestHostPermission } from '../../adapters/ai-connection';
import { Avatar } from './Avatar';
import { ModelPicker } from './ModelPicker';
import { useToast } from './toast';

export function ConnectedPanel({
  services,
  onEdit,
  onDisconnect,
  onGoAdd,
}: {
  services: ConnectedService[];
  onEdit: (id: string) => void;
  onDisconnect: (id: string) => void;
  onGoAdd: () => void;
}) {
  if (!services.length) {
    return (
      <div>
        <h2 className="ai-svc-panel-title">已连接</h2>
        <p className="ai-svc-panel-desc">管理当前 AI 连接：编辑配置、查看状态或断开。</p>
        <div className="ai-svc-empty">
          <div>还没有已连接的 AI 服务</div>
          <button type="button" onClick={onGoAdd}>
            去添加服务
          </button>
        </div>
      </div>
    );
  }
  return (
    <div>
      <h2 className="ai-svc-panel-title">已连接</h2>
      <p className="ai-svc-panel-desc">管理当前 AI 连接：编辑配置、查看状态或断开。</p>
      <div className="ai-svc-connected-list">
        {services.map(s => (
          <div key={s.id} className="ai-svc-connected-row">
            <Avatar letter={s.letter} avatarClass={s.avatarClass} size="lg" />
            <div className="info">
              <strong>{s.name}</strong>
              <div className="sub">
                {s.detail} · {s.kind === 'sub' ? '订阅' : 'API Key'} · {s.enabled.length} 模型
              </div>
            </div>
            <span className={`ai-svc-status-pill${s.status === 'warn' ? ' warn' : ''}`}>
              {s.status === 'ok' ? '正常' : '需检查'}
            </span>
            <div className="ai-svc-row-actions">
              <button type="button" className="ai-svc-row-btn" onClick={() => onEdit(s.id)}>
                编辑
              </button>
              <button type="button" className="ai-svc-row-btn danger" onClick={() => onDisconnect(s.id)}>
                断开
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FeaturesPanel({
  features,
  services,
  onAssign,
}: {
  features: FeatureAssignment[];
  services: ConnectedService[];
  onAssign: (featureId: string, connId: string, modelId: string) => void;
}) {
  return (
    <div>
      <h2 className="ai-svc-panel-title">功能用模</h2>
      <p className="ai-svc-panel-desc">为各 AI 功能指定连接与模型。行内展开按连接分组，可搜索模型 ID。</p>
      <div className="ai-svc-feat-list">
        {features.map(f => (
          <div key={f.id} className="ai-svc-feat-row">
            <div className="feat-info">
              <strong>{f.name}</strong>
              <span>{f.desc}</span>
            </div>
            <ModelPicker
              feature={f}
              services={services}
              onSelect={(connId, modelId) => onAssign(f.id, connId, modelId)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export function ImportExportPanel({
  services,
  exportConfig,
  onImport,
}: {
  services: ConnectedService[];
  exportConfig: () => unknown;
  onImport: (payload: { services: ConnectedService[]; features?: FeatureAssignment[] }) => Promise<void> | void;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragover, setDragover] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {
        version?: number;
        services?: ConnectedService[];
        features?: FeatureAssignment[];
      };
      if (!parsed.services || !Array.isArray(parsed.services)) throw Error('invalid');
      await onImport({ services: parsed.services, features: parsed.features });
      toast(`已导入 ${parsed.services.length} 个服务（不含密钥，请重新填写）`);
    } catch {
      toast('导入失败：JSON 无效或不含 services');
    }
  }

  function exportJson() {
    const payload = JSON.stringify(exportConfig(), null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'smartsave-ai-services.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('已导出 JSON（不含密钥）');
  }

  async function copyJson() {
    const payload = JSON.stringify(exportConfig(), null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      toast('已复制到剪贴板（不含密钥）');
    } catch {
      toast('复制失败（剪贴板不可用）');
    }
  }

  return (
    <div>
      <h2 className="ai-svc-panel-title">导入导出</h2>
      <p className="ai-svc-panel-desc">备份或迁移 AI 服务配置（不含明文密钥）。</p>
      <div className="ai-svc-io-grid">
        <div className="ai-svc-io-card">
          <h3>导入</h3>
          <p>从 JSON 文件恢复已连接的 AI 服务配置（不含明文密钥；导入后请重新输入密钥）。</p>
          <div
            className={`ai-svc-dropzone${dragover ? ' dragover' : ''}`}
            tabIndex={0}
            role="button"
            aria-label="选择或拖放导入文件"
            onClick={() => inputRef.current?.click()}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={e => {
              e.preventDefault();
              setDragover(true);
            }}
            onDragLeave={() => setDragover(false)}
            onDrop={e => {
              e.preventDefault();
              setDragover(false);
              void handleFile(e.dataTransfer.files[0]);
            }}
          >
            <Upload aria-hidden="true" />
            <div>
              <strong>点击选择</strong> 或拖放文件到此处
            </div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>支持 .json · 密钥不会从导出文件恢复</div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={e => {
              void handleFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </div>
        <div className="ai-svc-io-card">
          <h3>导出</h3>
          <p>导出当前已连接服务列表为 JSON（脱敏，不含 API Key），便于备份或在另一台设备导入。</p>
          <div className="ai-svc-io-actions">
            <button type="button" className="ai-svc-act ai-svc-act-primary" onClick={exportJson}>
              <Download aria-hidden="true" />
              导出 JSON
            </button>
            <button type="button" className="ai-svc-act ai-svc-act-ghost" onClick={() => void copyJson()}>
              复制到剪贴板
            </button>
          </div>
          {!services.length ? <p style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>当前没有已连接服务。</p> : null}
        </div>
      </div>
    </div>
  );
}

function VendorCard({ vendor, onClick }: { vendor: Vendor; onClick: () => void }) {
  const badge =
    vendor.oauth === 'ready'
      ? { text: '可登录', tone: 'ok' }
      : vendor.oauth === 'blocked'
        ? { text: '官方禁止', tone: 'off' }
        : vendor.oauth
          ? { text: '暂无官方登录', tone: 'off' }
          : undefined;
  return (
    <button
      type="button"
      className={`ai-svc-vendor-card${badge?.tone === 'off' ? ' is-muted' : ''}`}
      role="listitem"
      onClick={onClick}
    >
      <Avatar letter={vendor.letter} avatarClass={vendor.avatarClass} size="lg" plus={vendor.isCustom} />
      <span className="ai-svc-card-text">
        <span className="ai-svc-card-name">{vendor.name}</span>
        <span className="ai-svc-card-sub">{vendor.subtitle}</span>
      </span>
      {badge ? <span className={`ai-svc-card-badge is-${badge.tone}`}>{badge.text}</span> : null}
    </button>
  );
}

export function AddServicePanel({
  onConnected,
}: {
  onConnected: (svc: ConnectedService, key: string, remember: boolean) => Promise<void> | void;
}) {
  const { toast } = useToast();
  const [query, setQuery] = useState('');
  const [subVendor, setSubVendor] = useState<Vendor | null>(null);
  const [keyVendor, setKeyVendor] = useState<Vendor | null>(null);
  const [busy, setBusy] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [protocol, setProtocol] = useState<ApiMode>('openai');
  const [apiKey, setApiKey] = useState('');
  const [remember, setRemember] = useState(true);

  const q = query.trim().toLowerCase();
  const subList = SUB_VENDORS.filter(
    v => !q || v.name.toLowerCase().includes(q) || v.subtitle.toLowerCase().includes(q),
  ).sort((a, b) => Number(b.oauth === 'ready') - Number(a.oauth === 'ready'));
  const keyList = KEY_VENDORS.filter(
    v => !q || v.name.toLowerCase().includes(q) || v.subtitle.toLowerCase().includes(q),
  );

  function openKey(v: Vendor) {
    setKeyVendor(v);
    setDisplayName('');
    setBaseUrl(v.baseUrl ?? '');
    setProtocol(
      v.adapter === 'anthropic' || v.name === 'Anthropic'
        ? 'anthropic'
        : v.adapter === 'google-generative-ai'
          ? 'google'
          : v.adapter === 'openai-responses'
            ? 'openai-responses'
            : 'openai',
    );
    setApiKey('');
    setRemember(true);
  }

  function closeOverlays() {
    if (busy) return;
    setSubVendor(null);
    setKeyVendor(null);
  }

  function buildService(
    v: Vendor,
    kind: 'api' | 'sub',
    opts?: { name?: string; base?: string; mode?: ApiMode; catalog?: ConnectedService['catalog'] },
  ): ConnectedService {
    const name = opts?.name ?? v.name;
    const base = opts?.base ?? v.baseUrl ?? '';
    const mode =
      opts?.mode ?? (v.adapter ? adapterToApiMode(v.adapter) : /anthropic/i.test(name) ? 'anthropic' : 'openai');
    const catalog = opts?.catalog ?? catalogFromVendor(v.id, name);
    return {
      id: `c${crypto.randomUUID?.() ?? Date.now()}`,
      name,
      serviceType: v.isCustom ? '自定义端点' : v.name,
      kind,
      detail: kind === 'sub' ? v.subtitle : base.replace(/^https?:\/\//, '') || v.subtitle,
      baseUrl: base,
      mode,
      status: 'ok',
      letter: v.letter === '+' ? '自' : v.letter,
      avatarClass: v.isCustom ? 'c-custom' : v.avatarClass,
      catalog,
      enabled: catalog.slice(0, Math.min(3, catalog.length)).map(m => m.id),
      vendorId: v.id,
      timeoutMs: 60000,
    };
  }

  async function connectKey() {
    if (!keyVendor || busy) return;
    const v = keyVendor;
    const name = v.isCustom ? displayName.trim() || '自定义端点' : v.name;
    const base = baseUrl.trim() || v.baseUrl || '';
    const mode = v.isCustom
      ? protocol
      : v.adapter === 'anthropic' || v.name === 'Anthropic'
        ? 'anthropic'
        : v.adapter === 'google-generative-ai'
          ? 'google'
          : v.adapter === 'openai-responses'
            ? 'openai-responses'
            : 'openai';
    if (!base) {
      toast('请填写 Base URL');
      return;
    }
    if (!apiKey.trim() && !v.isCustom) {
      toast('请输入 API Key');
      return;
    }
    setBusy(true);
    try {
      const draft = { mode, baseUrl: base, key: apiKey.trim(), vendorId: v.id, timeoutMs: 60000 };
      const granted = await requestHostPermission(draft);
      if (!granted) {
        toast('模型主机权限被拒绝，无法连接');
        return;
      }
      let catalog = catalogFromVendor(v.id, name);
      const listed = await discoverModels(draft);
      if (listed.status === 'completed') {
        catalog = modelsToCatalog(listed.models);
        if (listed.source === 'curated') toast('列表接口不可用，已填入常用模型');
      } else if (!catalog.length) {
        toast(`未能获取模型列表：${listed.reason}。仍可手填模型 ID。`);
      }
      const svc = buildService(v, 'api', { name, base, mode, catalog });
      if (listed.status !== 'completed') svc.status = 'warn';
      await onConnected(svc, apiKey.trim(), remember);
      setKeyVendor(null);
      toast(listed.status === 'completed' ? '已连接' : '已保存（连接需检查）');
    } catch {
      toast('连接失败：请检查 Base URL（HTTPS，或本地回环 HTTP）与协议');
    } finally {
      setBusy(false);
    }
  }

  async function continueSub() {
    if (!subVendor || busy) return;
    const v = subVendor;
    if (v.oauth !== 'ready') {
      // Never fake a subscription connection.
      setSubVendor(null);
      openKeyFallback(v);
      return;
    }
    setBusy(true);
    try {
      // The permission request must be the first await so it stays inside the click gesture.
      const result = await signInWithOpenRouter();
      if (result.status !== 'completed') {
        toast(oauthFailureText(result.reason));
        return;
      }
      const base = v.baseUrl ?? 'https://openrouter.ai/api/v1';
      const draft = {
        mode: 'openai' as ApiMode,
        baseUrl: base,
        key: result.key,
        vendorId: 'openrouter-key',
        timeoutMs: 60000,
      };
      let catalog = catalogFromVendor('openrouter-key', 'OpenRouter');
      const listed = await discoverModels(draft);
      if (listed.status === 'completed') catalog = modelsToCatalog(listed.models);
      const svc = buildService(v, 'sub', { name: 'OpenRouter', base, mode: 'openai', catalog });
      svc.detail = 'OAuth 登录';
      if (listed.status !== 'completed') svc.status = 'warn';
      await onConnected(svc, result.key, true);
      setSubVendor(null);
      toast('已通过 OpenRouter 登录并连接');
    } catch {
      toast('登录失败，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  /** Subscriptions without an official sign-in jump to the matching API-key form, when one exists. */
  function openKeyFallback(v: Vendor) {
    const target = KEY_VENDORS.find(k => !k.isCustom && (k.name === v.name || (v.baseUrl && k.baseUrl === v.baseUrl)));
    if (target) openKey(target);
  }

  return (
    <div>
      <h2 className="ai-svc-panel-title">添加服务</h2>
      <p className="ai-svc-panel-desc">用订阅登录或 API Key 连接。自定义端点排在 Key 区首位。</p>
      <div className="ai-svc-search-wrap">
        <Search aria-hidden="true" />
        <input
          type="search"
          className="ai-svc-search-input"
          placeholder="筛选服务"
          aria-label="筛选服务"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <section className="ai-svc-section" aria-labelledby="ai-title-sub">
        <h2 className="ai-svc-section-title" id="ai-title-sub">
          用订阅登录
        </h2>
        <p className="ai-svc-empty-hint" style={{ marginTop: 0 }}>
          目前只有 OpenRouter 提供面向扩展的官方登录；其他订阅厂商不开放或明确禁止第三方使用，点卡片查看原因并转到对应的
          API Key。
        </p>
        {subList.length === 0 ? <p className="ai-svc-empty-hint">没有匹配的服务</p> : null}
        {subList.length > 0 && (
          <div className="ai-svc-card-grid" role="list">
            {subList.map(v => (
              <VendorCard key={v.id} vendor={v} onClick={() => setSubVendor(v)} />
            ))}
          </div>
        )}
      </section>

      <section className="ai-svc-section" aria-labelledby="ai-title-key">
        <h2 className="ai-svc-section-title" id="ai-title-key">
          用 API KEY 连接
        </h2>
        {keyList.length === 0 ? <p className="ai-svc-empty-hint">没有匹配的服务</p> : null}
        {keyList.length > 0 && (
          <div className="ai-svc-card-grid" role="list">
            {keyList.map(v => (
              <VendorCard key={v.id} vendor={v} onClick={() => openKey(v)} />
            ))}
          </div>
        )}
      </section>

      {(subVendor || keyVendor) && <div className="ai-svc-backdrop" onClick={closeOverlays} aria-hidden="true" />}

      {subVendor && (
        <div className="ai-svc-modal" role="dialog" aria-modal="true" aria-labelledby="ai-sub-modal-title">
          <p id="ai-sub-modal-title">
            {subVendor.oauth === 'ready'
              ? `用 ${subVendor.name.replace(/ OAuth$/, '')} 登录`
              : `订阅登录 · ${subVendor.name}`}
          </p>
          <p className="ai-svc-modal-note">{subVendor.oauthNote ?? '该厂商没有面向扩展的官方登录。'}</p>
          <div className="ai-svc-modal-actions">
            <button type="button" className="ai-svc-act ai-svc-act-ghost" onClick={closeOverlays} disabled={busy}>
              取消
            </button>
            <button
              type="button"
              className="ai-svc-act ai-svc-act-primary"
              onClick={() => void continueSub()}
              disabled={busy}
            >
              {subVendor.oauth === 'ready' ? (busy ? '等待授权…' : '前往授权') : '改用 API Key'}
            </button>
          </div>
        </div>
      )}

      {keyVendor && (
        <aside className="ai-svc-slide-panel" role="dialog" aria-modal="true" aria-labelledby="ai-key-panel-title">
          <div className="ai-svc-panel-header">
            <h2 id="ai-key-panel-title">{keyVendor.name}</h2>
            <button type="button" className="ai-svc-icon-btn" aria-label="关闭" onClick={closeOverlays}>
              ×
            </button>
          </div>
          <div className="ai-svc-panel-body">
            {keyVendor.isCustom ? (
              <>
                <div className="ai-svc-field">
                  <label htmlFor="ai-f-display-name">显示名称</label>
                  <input
                    id="ai-f-display-name"
                    type="text"
                    placeholder="例如：我的代理"
                    value={displayName}
                    onChange={e => setDisplayName(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="ai-svc-field">
                  <label htmlFor="ai-f-base-url">Base URL</label>
                  <input
                    id="ai-f-base-url"
                    type="url"
                    placeholder="https://api.example.com/v1"
                    value={baseUrl}
                    onChange={e => setBaseUrl(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="ai-svc-field">
                  <label htmlFor="ai-f-protocol">兼容协议</label>
                  <select id="ai-f-protocol" value={protocol} onChange={e => setProtocol(e.target.value as ApiMode)}>
                    {API_MODE_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="ai-svc-field">
                  <label htmlFor="ai-f-api-key">API Key</label>
                  <input
                    id="ai-f-api-key"
                    type="password"
                    placeholder="输入 API Key"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="ai-svc-field">
                  <label htmlFor="ai-f-api-key">API Key</label>
                  <input
                    id="ai-f-api-key"
                    type="password"
                    placeholder="输入 API Key"
                    value={apiKey}
                    onChange={e => setApiKey(e.target.value)}
                    autoComplete="off"
                  />
                </div>
                <div className="ai-svc-field">
                  <label htmlFor="ai-f-base-url">
                    Base URL <span style={{ fontWeight: 400, opacity: 0.7 }}>（可自定义）</span>
                  </label>
                  <input
                    id="ai-f-base-url"
                    type="url"
                    value={baseUrl}
                    onChange={e => setBaseUrl(e.target.value)}
                    autoComplete="off"
                  />
                </div>
              </>
            )}
            <label className="ai-svc-check">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
              记住密钥（本地扩展存储，非系统保险库）
            </label>
          </div>
          <div className="ai-svc-panel-footer">
            <button type="button" className="ai-svc-act ai-svc-act-ghost" disabled={busy} onClick={closeOverlays}>
              取消
            </button>
            <button
              type="button"
              className="ai-svc-act ai-svc-act-primary"
              disabled={busy}
              onClick={() => void connectKey()}
            >
              {busy ? (
                <>
                  <span className="ai-svc-spinner" />
                  连接中…
                </>
              ) : (
                '连接'
              )}
            </button>
          </div>
        </aside>
      )}
    </div>
  );
}
