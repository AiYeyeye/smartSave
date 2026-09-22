import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
// The toolbar popup is a native extension document: no handshake, only the fixed Popup viewport.
document.body.classList.add('popup');
createRoot(root).render(
  <StrictMode>
    <App page="panel" />
  </StrictMode>,
);
