import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { APP_NAME } from './config';
import { seedCategoriesIfEmpty } from './db/seed';
import { getSettings } from './db/db';
import { requestPersistence } from './lib/storage';

document.title = APP_NAME;

// Offline support (no-op in dev; active in built app).
if ('serviceWorker' in navigator) {
  import('virtual:pwa-register')
    .then(({ registerSW }) => registerSW({ immediate: true }))
    .catch(() => {
      /* file:// or blocked SW — the app still works, just without offline cache */
    });
}

// Idempotent seed + storage durability request (SPEC §9).
void (async () => {
  try {
    await seedCategoriesIfEmpty();
    const settings = await getSettings();
    if (settings.onboarded) await requestPersistence();
  } catch (e) {
    console.error('startup init failed', e);
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
