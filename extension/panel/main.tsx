import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
// The browser side panel hosts this document at full height; width follows the user's panel width.
document.body.classList.add('sidepanel');
createRoot(root).render(
  <StrictMode>
    <App page="panel" />
  </StrictMode>,
);
