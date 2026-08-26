// Dark/light theme (SPEC §8.1.11): follows system, manual override in Settings.
import { useEffect } from 'react';
import { getSettings } from '../db/db';
import { useLive } from '../db/useLive';
import type { ThemeChoice } from '../db/types';

/**
 * localStorage key holding a DISPLAY HINT — never a record (SPEC §3, D29).
 * IndexedDB stays the source of truth for the theme setting; this single
 * string exists only so the inline script in index.html can stamp
 * <html data-theme> before the first paint (IndexedDB is async, so without it
 * a dark-theme user sees a light flash on every cold start). A missing or
 * stale hint costs one corrected frame, nothing more.
 */
export const THEME_HINT_KEY = 'mymoney.theme';

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return choice;
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
}

/** Persist the pre-paint hint. Storage can be unavailable (private mode,
 *  file://) — the app must work regardless, so failures are ignored. */
export function writeThemeHint(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_HINT_KEY, choice);
  } catch {
    /* no hint next boot — the inline script falls back to prefers-color-scheme */
  }
}

/** The hint as the boot script reads it: an unknown/absent value means 'system'. */
export function readThemeHint(): ThemeChoice {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(THEME_HINT_KEY);
  } catch {
    /* unreadable storage behaves like no hint */
  }
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** Mounted once in App: keeps <html data-theme> in sync with settings + OS. */
export function useThemeSync(): ThemeChoice {
  const theme = useLive(async () => (await getSettings()).theme, []);
  useEffect(() => {
    // Until the real choice loads, leave the attribute the boot script stamped:
    // applying a default here would flash the wrong palette on every start.
    if (theme === undefined) return;
    applyTheme(theme);
    writeThemeHint(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
  return theme ?? 'system';
}
