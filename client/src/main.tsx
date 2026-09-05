import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { IS_STATIC } from './api';
import { Boot } from './static/Boot';
import './styles.css';

/**
 * Fastify serves this from the root; GitHub Pages serves it from a repository
 * path. Vite knows which, so the router follows it rather than being told twice.
 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={basename}>
      {IS_STATIC ? (
        <Boot>
          <App />
        </Boot>
      ) : (
        <App />
      )}
    </BrowserRouter>
  </StrictMode>,
);

// Only the published build is offline-capable — a service worker needs HTTPS,
// which is exactly what the LAN server can't offer and Pages gives for free.
if (IS_STATIC && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
