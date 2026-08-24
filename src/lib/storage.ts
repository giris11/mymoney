// Durability helpers (SPEC §9): ask the browser to protect IndexedDB from
// eviction and surface the result honestly.
export type PersistState = 'persisted' | 'not-persisted' | 'unsupported';

export async function requestPersistence(): Promise<PersistState> {
  try {
    if (!navigator.storage?.persist) return 'unsupported';
    const granted = await navigator.storage.persist();
    return granted ? 'persisted' : 'not-persisted';
  } catch {
    return 'unsupported';
  }
}

export async function persistenceState(): Promise<PersistState> {
  try {
    if (!navigator.storage?.persisted) return 'unsupported';
    return (await navigator.storage.persisted()) ? 'persisted' : 'not-persisted';
  } catch {
    return 'unsupported';
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est) return null;
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  } catch {
    return null;
  }
}
