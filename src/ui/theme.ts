// Dark/light theme (SPEC §8.1.11): follows system, manual override in Settings.
import { useEffect } from 'react';
import { getSettings } from '../db/db';
import { useLive } from '../db/useLive';
import type { ThemeChoice } from '../db/types';

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return choice;
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = resolveTheme(choice);
}

/** Mounted once in App: keeps <html data-theme> in sync with settings + OS. */
export function useThemeSync(): ThemeChoice {
  const theme = useLive(async () => (await getSettings()).theme, []) ?? 'system';
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);
  return theme;
}
