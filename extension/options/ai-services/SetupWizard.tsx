import { useMemo, useState } from 'react';
import { Check, Search, Sparkles, X, Zap } from 'lucide-react';
import type { ConnectedService, FeatureAssignment } from './mock-data';
import { Avatar } from './Avatar';
import { DialogPortal } from './portal';

/** Small / fast model ids: good for per-bookmark work that should feel instant and cost little. */
const FAST = /(mini|flash|haiku|lite|nano|small|turbo|instant|air|8b|7b|3b|1\.5b)/i;
/** Ids that are clearly not chat models even when a provider lists them. */
const NOT_CHAT =
  /(embed|embedding|tts|whisper|audio|image|dall-e|vision-preview|moderation|rerank|transcribe|realtime)/i;

/** Per-bookmark tasks want a fast model; whole-tree tasks benefit from a stronger one. */
const FAST_FEATURES = new Set(['save', 'search', 'classify']);

export function recommendModels(ids: string[]): { fast?: string; strong?: string; picked: string[] } {
  const chat = ids.filter(id => !NOT_CHAT.test(id));
  const pool = chat.length ? chat : ids;
  const fast = pool.find(id => FAST.test(id)) ?? pool[0];
  const strong = pool.find(id => !FAST.test(id)) ?? fast;
  const picked = [...new Set([fast, strong].filter((id): id is string => !!id))];
  // A few more so the user sees a sensible default selection, never the whole catalog.
  for (const id of pool) {
    if (picked.length >= 3) break;
    if (!picked.includes(id)) picked.push(id);
  }
  return { fast, strong, picked };
}

export function recommendAssignments(
  features: FeatureAssignment[],
  serviceId: string,
  enabled: string[],
): Record<string, string> {
  const { fast, strong } = recommendModels(enabled);
  const out: Record<string, string> = {};
  for (const feature of features) {
    // Keep what the user already chose on another connection; fill everything that is empty.
    if (feature.connId && feature.modelId && feature.connId !== serviceId) {
      out[feature.id] = KEEP;
      continue;
    }
    const pick = FAST_FEATURES.has(feature.id) ? fast : strong;
    out[feature.id] = pick && enabled.includes(pick) ? pick : (enabled[0] ?? NONE);
  }
  return out;
}

const KEEP = '__keep__';
const NONE = '__none__';

type Step = 'models' | 'features';

/**
 * After connecting a service: pick which of its models to use, then which model each feature uses.
 * Every step can be skipped; nothing here is required to finish connecting.
 */
export function SetupWizard({
  service,
  services,
  features,
  initialStep = 'models',
  onSaveModels,
  onAssign,
  onClose,
}: {
  service: ConnectedService;
  services: ConnectedService[];
  features: FeatureAssignment[];
  initialStep?: Step;
  onSaveModels: (enabled: string[], catalog: ConnectedService['catalog']) => Promise<void>;
  onAssign: (changes: { featureId: string; connId: string; modelId: string }[]) => Promise<void>;
  onClose: (summary?: string) => void;
}) {
  const [step, setStep] = useState<Step>(initialStep);
  const [catalog, setCatalog] = useState(service.catalog);
  const [enabled, setEnabled] = useState<string[]>(() =>
    service.enabled.length ? service.enabled : recommendModels(service.catalog.map(m => m.id)).picked,
  );
  const [query, setQuery] = useState('');
  const [customId, setCustomId] = useState('');
  const [busy, setBusy] = useState(false);
  const rec = useMemo(() => recommendModels(catalog.map(m => m.id)), [catalog]);
  const [choice, setChoice] = useState<Record<string, string>>(() =>
    recommendAssignments(features, service.id, enabled),
  );

  const q = query.trim().toLowerCase();
  // Embedding / speech / image models cannot classify bookmarks: keep them listed but at the bottom.
  const visible = catalog
    .filter(m => !q || m.id.toLowerCase().includes(q))
    .sort((a, b) => Number(NOT_CHAT.test(a.id)) - Number(NOT_CHAT.test(b.id)));
  const ordered = useMemo(
    () => [
      ...enabled.filter(id => catalog.some(m => m.id === id)),
      ...enabled.filter(id => !catalog.some(m => m.id === id)),
    ],
    [enabled, catalog],
  );

  function toggle(id: string, on: boolean) {
    setEnabled(previous => (on ? [...new Set([...previous, id])] : previous.filter(item => item !== id)));
  }

  function addCustom() {
    const id = customId.trim();
    if (!id) return;
    if (!catalog.some(m => m.id === id)) setCatalog(previous => [...previous, { id, ctx: '自定义' }]);
    toggle(id, true);
    setCustomId('');
  }

  async function nextFromModels() {
    if (!enabled.length) return;
    setBusy(true);
    try {
      await onSaveModels(enabled, catalog);
      // Re-derive defaults against the final selection, keeping anything the user already changed here.
      setChoice(recommendAssignments(features, service.id, enabled));
      setStep('features');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    try {
      const changes = features
        .filter(f => choice[f.id] !== KEEP)
        .map(f => {
          const value = choice[f.id];
          return value && value !== NONE
            ? { featureId: f.id, connId: service.id, modelId: value }
            : { featureId: f.id, connId: '', modelId: '' };
        });
      await onAssign(changes);
      const save = changes.find(c => c.featureId === 'save');
      onClose(save?.modelId ? `配置完成：收藏会用 ${save.modelId} 自动归类` : '配置完成');
    } finally {
      setBusy(false);
    }
  }

  function setAll(value: string) {
    setChoice(previous =>
      Object.fromEntries(features.map(f => [f.id, previous[f.id] === KEEP && value === '' ? KEEP : value])),
    );
  }

  const keepLabel = (feature: FeatureAssignment) => {
    const other = services.find(s => s.id === feature.connId);
    return `保持现有：${feature.modelId}${other ? ` · ${other.name}` : ''}`;
  };

  return (
    <DialogPortal>
      <div className="ai-svc-backdrop" aria-hidden="true" />
      <div className="ai-svc-dialog ai-svc-wizard" role="dialog" aria-modal="true" aria-labelledby="ai-wizard-title">
        <header className="ai-svc-dialog-head">
          <Avatar letter={service.letter} avatarClass={service.avatarClass} size="lg" />
          <div>
            <h2 id="ai-wizard-title">设置 {service.name}</h2>
            <p>两步就能用上 AI：选模型，再决定每个功能用哪个。都可以跳过，之后在「AI 服务」里改。</p>
          </div>
          <button type="button" className="ai-svc-dialog-close" aria-label="关闭" onClick={() => onClose()}>
            <X aria-hidden="true" />
          </button>
        </header>

        <ol className="ai-svc-steps" aria-label="设置步骤">
          <li className="is-done">
            <span>
              <Check aria-hidden="true" />
            </span>
            已连接
          </li>
          <li
            className={step === 'models' ? 'is-current' : 'is-done'}
            aria-current={step === 'models' ? 'step' : undefined}
          >
            <span>{step === 'models' ? '2' : <Check aria-hidden="true" />}</span>
            选择模型
          </li>
          <li
            className={step === 'features' ? 'is-current' : ''}
            aria-current={step === 'features' ? 'step' : undefined}
          >
            <span>3</span>
            分配给功能
          </li>
        </ol>

        {step === 'models' ? (
          <div className="ai-svc-dialog-body ai-svc-wizard-body" key="models">
            <div className="ai-svc-wizard-tools">
              <div className="ai-svc-mini-search">
                <Search aria-hidden="true" />
                <input
                  type="search"
                  placeholder={`在 ${catalog.length} 个模型中搜索…`}
                  aria-label="搜索模型"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm"
                onClick={() => setEnabled(rec.picked)}
              >
                <Sparkles aria-hidden="true" />
                推荐
              </button>
              <button
                type="button"
                className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm"
                onClick={() => setEnabled([])}
              >
                清空
              </button>
            </div>
            {catalog.length === 0 ? (
              <p className="ai-svc-empty-hint">没有拿到模型列表。可以在下方手动输入模型 ID。</p>
            ) : (
              <ul className="ai-svc-wizard-models" aria-label="可选模型">
                {visible.map(m => {
                  const on = enabled.includes(m.id);
                  return (
                    <li key={m.id}>
                      <label className={on ? 'is-on' : undefined}>
                        <input type="checkbox" checked={on} onChange={e => toggle(m.id, e.target.checked)} />
                        <span className="ai-svc-mid">{m.id}</span>
                        {m.id === rec.fast ? (
                          <em className="tag is-fast">
                            <Zap aria-hidden="true" />快
                          </em>
                        ) : m.id === rec.strong ? (
                          <em className="tag">强</em>
                        ) : NOT_CHAT.test(m.id) ? (
                          <em className="tag is-muted">非对话</em>
                        ) : null}
                        <span className="ai-svc-ctx">{m.ctx}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
            <div className="ai-svc-custom-add">
              <input
                type="text"
                placeholder="不在列表里？输入模型 ID 添加"
                value={customId}
                onChange={e => setCustomId(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addCustom();
                  }
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="button" className="ai-svc-act ai-svc-act-ghost ai-svc-act-sm" onClick={addCustom}>
                添加
              </button>
            </div>
            <footer className="ai-svc-dialog-foot">
              <span className="ai-svc-dialog-hint">已选 {enabled.length} 个</span>
              <button type="button" className="ai-svc-act ai-svc-act-ghost" onClick={() => onClose()} disabled={busy}>
                跳过，稍后配置
              </button>
              <button
                type="button"
                className="ai-svc-act ai-svc-act-primary"
                onClick={() => void nextFromModels()}
                disabled={busy || !enabled.length}
              >
                下一步
              </button>
            </footer>
          </div>
        ) : (
          <div className="ai-svc-dialog-body ai-svc-wizard-body" key="features">
            <p className="ai-svc-wizard-intro">
              推荐：<b>轻量模型</b>负责收藏、搜索、页面分类（快、便宜），<b>较强的模型</b>负责导入和整理。
            </p>
            <div className="ai-svc-wizard-all">
              <span>全部使用</span>
              <select aria-label="全部功能使用" value="" onChange={e => e.target.value && setAll(e.target.value)}>
                <option value="">选择一个模型…</option>
                {ordered.map(id => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
            <ul className="ai-svc-wizard-features">
              {features.map(f => (
                <li key={f.id}>
                  <div>
                    <strong>{f.name}</strong>
                    <small>{f.desc}</small>
                  </div>
                  <select
                    aria-label={`${f.name}使用的模型`}
                    value={choice[f.id] ?? NONE}
                    onChange={e => setChoice(previous => ({ ...previous, [f.id]: e.target.value }))}
                  >
                    {f.connId && f.modelId && f.connId !== service.id ? (
                      <option value={KEEP}>{keepLabel(f)}</option>
                    ) : null}
                    {ordered.map(id => (
                      <option key={id} value={id}>
                        {id}
                        {id === rec.fast && FAST_FEATURES.has(f.id) ? '（推荐）' : ''}
                        {id === rec.strong && !FAST_FEATURES.has(f.id) ? '（推荐）' : ''}
                      </option>
                    ))}
                    <option value={NONE}>暂不使用 AI</option>
                  </select>
                </li>
              ))}
            </ul>
            <footer className="ai-svc-dialog-foot">
              <button
                type="button"
                className="ai-svc-act ai-svc-act-ghost"
                onClick={() => setStep('models')}
                disabled={busy}
                hidden={initialStep === 'features'}
              >
                上一步
              </button>
              <span className="ai-svc-dialog-hint" />
              <button type="button" className="ai-svc-act ai-svc-act-ghost" onClick={() => onClose()} disabled={busy}>
                跳过
              </button>
              <button
                type="button"
                className="ai-svc-act ai-svc-act-primary"
                onClick={() => void finish()}
                disabled={busy}
              >
                完成
              </button>
            </footer>
          </div>
        )}
      </div>
    </DialogPortal>
  );
}
