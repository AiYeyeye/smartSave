import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { ConnectedService, FeatureAssignment } from './mock-data';
import { modelCtx } from './mock-data';

export function ModelPicker({
  feature,
  services,
  onSelect,
}: {
  feature: FeatureAssignment;
  services: ConnectedService[];
  onSelect: (connId: string, modelId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const conn = services.find(c => c.id === feature.connId);
  const ctx = modelCtx(services, feature.connId, feature.modelId);
  const main = feature.modelId ? `${feature.modelId}${ctx ? ` · ${ctx}` : ''}` : '选择模型';
  const sub = conn ? conn.name : '未绑定连接';

  useEffect(() => {
    if (!open || !triggerRef.current || !popRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const popW = popRef.current.offsetWidth || 340;
    const popH = Math.min(420, window.innerHeight * 0.7);
    let left = rect.right - popW;
    let top = rect.bottom + 6;
    if (left < 8) left = 8;
    if (top + popH > window.innerHeight - 8) top = Math.max(8, rect.top - popH - 6);
    setPos({ left, top });
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
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
    <>
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
        <ChevronDown aria-hidden="true" />
      </button>
      {open && (
        <div ref={popRef} className="ai-svc-picker-pop" style={{ left: pos.left, top: pos.top }} role="listbox">
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
                没有匹配的模型
                <br />
                <span style={{ fontSize: 12 }}>请先在「编辑 AI 服务」中启用模型</span>
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
                        className="ai-svc-picker-option"
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
    </>
  );
}
