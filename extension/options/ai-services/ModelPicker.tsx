import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { ConnectedService, FeatureAssignment } from './mock-data';
import { modelCtx } from './mock-data';

/**
 * In-place model picker: expands below the trigger inside the card/sidebar.
 * Must NOT use position:fixed — keeps within ≈380px sidebar bounds (redesign SoT).
 */
export function ModelPicker({
  feature,
  services,
  onSelect,
  compact = false,
}: {
  feature: FeatureAssignment;
  services: ConnectedService[];
  onSelect: (connId: string, modelId: string) => void;
  /** Sidebar summary uses slightly denser trigger. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const conn = services.find(c => c.id === feature.connId);
  const ctx = modelCtx(services, feature.connId, feature.modelId);
  const main = feature.modelId ? `${feature.modelId}${ctx ? ` · ${ctx}` : ''}` : '选择模型';
  const sub = conn ? conn.name : '未绑定连接';

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const groups = services
    .map(c => {
      const models = (c.enabled || [])
        .map(id => c.catalog.find(m => m.id === id) || { id, ctx: '' })
        .filter(m => !q || m.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
      return { conn: c, models };
    })
    .filter(g => g.models.length > 0);

  return (
    <div ref={rootRef} className={`ai-svc-picker${compact ? ' is-compact' : ''}${open ? ' is-open' : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="ai-svc-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQuery('');
          setOpen(v => !v);
        }}
      >
        <span className="label">
          <span className="main">{main}</span>
          <span className="sub">{sub}</span>
        </span>
        <ChevronDown className="chev" aria-hidden="true" />
      </button>
      {open && (
        <div className="ai-svc-picker-inline" role="listbox">
          <div className="ai-svc-picker-search">
            <Search aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索模型"
              aria-label="搜索模型"
              value={query}
              autoFocus
              onChange={e => setQuery(e.target.value)}
            />
          </div>
          <div className="ai-svc-picker-list">
            {groups.length === 0 ? (
              <div className="ai-svc-picker-empty">
                {services.length === 0 ? '请先连接 AI 服务' : '没有匹配的模型'}
                <br />
                <span style={{ fontSize: 11 }}>请先在「编辑 AI 服务」中启用模型</span>
              </div>
            ) : (
              groups.map(g => (
                <div key={g.conn.id}>
                  <div className="ai-svc-picker-group">{g.conn.name}</div>
                  {g.models.map(m => {
                    const sel = feature.connId === g.conn.id && feature.modelId === m.id;
                    return (
                      <button
                        key={`${g.conn.id}:${m.id}`}
                        type="button"
                        className={`ai-svc-picker-option${sel ? ' is-current' : ''}`}
                        role="option"
                        aria-selected={sel}
                        onClick={() => {
                          onSelect(g.conn.id, m.id);
                          setOpen(false);
                        }}
                      >
                        <span className="name">{m.id}</span>
                        <span className="ctx">{m.ctx || ''}</span>
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
