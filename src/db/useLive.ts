// Tiny React binding for Dexie's liveQuery — avoids an extra dependency (D4).
import { useEffect, useState, type DependencyList } from 'react';
import { liveQuery } from 'dexie';

/**
 * Re-runs `querier` whenever the Dexie tables it touched change.
 * Returns undefined until the first result arrives.
 */
export function useLive<T>(querier: () => Promise<T> | T, deps: DependencyList = []): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    const sub = liveQuery(querier).subscribe({
      next: (v) => setValue(v as T),
      error: (err) => console.error('liveQuery error', err),
    });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return value;
}
