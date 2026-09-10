import { useEffect, useState } from 'react';

export function SidebarPosition() {
  const [refresh, setRefresh] = useState(0);
  const [status, setStatus] = useState('正在读取位置…');
  useEffect(() => {
    let current = true;
    const panel = typeof chrome === 'undefined' ? undefined : chrome.sidePanel as unknown as { getLayout?: () => Promise<unknown> };
    async function read() {
      if (typeof panel?.getLayout !== 'function') {
        setStatus('无法读取位置：浏览器未提供此接口（Chrome 140+ 支持读取）。');
        return;
      }
      setStatus('正在读取位置…');
      try {
        const result = await panel.getLayout();
        if (!current) return;
        const side = result && typeof result === 'object' && 'side' in result ? result.side : undefined;
        setStatus(side === 'left' ? '当前位置：左侧' : side === 'right' ? '当前位置：右侧' : '无法读取位置：浏览器返回了未知布局。');
      } catch {
        if (current) setStatus('无法读取位置：浏览器拒绝了读取，请重试。');
      }
    }
    void read();
    return () => { current = false; };
  }, [refresh]);
  const edge = /Edg\//.test(navigator.userAgent);
  const chromeBrowser = /Chrome\//.test(navigator.userAgent) && !edge;
  return <section aria-label="侧栏位置"><h3>侧栏位置</h3>
    <p role="status">{status}</p><button onClick={() => setRefresh(value => value + 1)}>刷新位置</button>
    <p className="hint">位置由浏览器控制，智栏只能读取，不能更改。</p>
    {chromeBrowser ? <p className="hint">Chrome：打开浏览器设置 → 外观，查找侧边栏位置选项。更改后点击“刷新位置”；具体选项以当前版本为准。</p>
      : edge ? <p className="hint">Edge：请在浏览器设置中查看侧栏相关选项。官方文档未确认可切换左右位置，智栏不保证存在该选项。</p>
        : <p className="hint">请查看浏览器的侧栏设置；不同浏览器和版本提供的选项不同。</p>}
  </section>;
}
