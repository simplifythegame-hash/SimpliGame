import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

// PWA: register the service worker in production only — never on
// localhost dev (a stale worker would serve old bundles while coding).
if (
  import.meta.env.PROD &&
  'serviceWorker' in navigator &&
  window.location.hostname !== 'localhost' &&
  window.location.hostname !== '127.0.0.1'
) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Offline support is a nice-to-have; a failed registration must
      // never break the app itself.
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
