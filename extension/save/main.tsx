import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../ui/App';

const root = document.getElementById('root');
if (!root) throw Error('Missing application root');
if (window.top === window)
  createRoot(root).render(
    <StrictMode>
      <App page="save" />
    </StrictMode>,
  );
