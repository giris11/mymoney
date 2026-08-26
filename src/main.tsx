import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';
import { APP_NAME } from './config';
import { seedCategoriesIfEmpty } from './db/seed';
import { getSettings } from './db/db';
import { requestPersistence } from './lib/storage';
import { refreshLiveRatesIfStale } from './domain/fxAuto';

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
    if (settings.onboarded) {
      await requestPersistence();
      // Live FX rates (D34) — the only outbound request this app ever makes,
      // and only once the user is past onboarding. Deliberately not awaited:
      // it must not extend this chain, it resolves an outcome instead of
      // throwing, and if it never finishes the app is unaffected. It refreshes
      // only when the feature is on and the last sync has aged out.
      void refreshLiveRatesIfStale();
    }
  } catch (e) {
    console.error('startup init failed', e);
  }
})();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
