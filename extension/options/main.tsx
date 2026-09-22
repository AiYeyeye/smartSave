import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
import { bindUi } from '../panel/ui-bind';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
void bindUi().then(ok => {
  if (!ok) { root.textContent = '无法绑定设置页身份；请从扩展详情重新打开。'; return; }
  createRoot(root).render(<StrictMode><App page="options" /></StrictMode>);
});
