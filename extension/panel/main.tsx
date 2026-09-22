import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
import { bindUi } from './ui-bind';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
void bindUi().then(ok => {
  if (!ok) {
    root.textContent = '无法绑定侧栏身份；请重新打开智栏。';
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <App page="panel" />
    </StrictMode>,
  );
});
