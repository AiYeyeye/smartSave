import { useEffect, useState } from 'react';

const HOST = 'zhilan.host.geometry';

export function SidebarPosition() {
  const [side, setSide] = useState<'left' | 'right'>('right');
  const [width, setWidth] = useState(320);
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: HOST, action: 'status' }, (response: unknown) => {
      if (!response || typeof response !== 'object') return;
      if ('side' in response && (response.side === 'left' || response.side === 'right')) setSide(response.side);
      if ('width' in response && typeof response.width === 'number') setWidth(response.width);
    });
  }, []);
  function apply(next: { side?: 'left' | 'right'; width?: number; close?: boolean }) {
    if (next.side) setSide(next.side);
    if (next.width) setWidth(next.width);
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: HOST, action: 'set', ...next });
  }
  return <section aria-label="侧栏位置"><h3>侧栏位置</h3>
    <p role="status">当前位置：{side === 'left' ? '左侧' : '右侧'} · {width}px</p>
    <div className="actions">
      <button type="button" onClick={() => apply({ side: 'left' })}>左侧</button>
      <button type="button" onClick={() => apply({ side: 'right' })}>右侧</button>
      <button type="button" onClick={() => apply({ width: 320 })}>窄</button>
      <button type="button" onClick={() => apply({ width: 380 })}>中</button>
      <button type="button" onClick={() => apply({ width: 480 })}>宽</button>
      <button type="button" onClick={() => apply({ close: true })}>关闭侧栏</button>
    </div>
    <p className="hint">位置由智栏控制，不使用浏览器原生侧栏。关闭会移除此页上的侧栏。</p>
  </section>;
}
