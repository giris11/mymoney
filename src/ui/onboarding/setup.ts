// The writes onboarding performs, kept out of the component so they can be
// tested in node (the suite has no DOM environment) and so each one is safe to
// run twice.
//
// Why that matters: onboarding is retryable BY DESIGN — `onboarded` is written
// last, so a reload, a closed tab, an abandoned import wizard or a crash
// anywhere before that flip drops the user back at step 1 with the earlier
// run's writes already on disk. The guard used to be a React ref, which dies
// with the page: a second run created a SECOND full set of starter accounts and
// silently doubled every opening balance in net worth.
import { db, updateSettings } from '../../db/db';
import { requestPersistence } from '../../lib/storage';
import { navigate } from '../router';
import { buildAccounts, type AccountRowState } from './AccountsStep';

export interface StarterAccountsResult {
  /** Accounts written by this call. */
  created: number;
  /** Accounts that already existed and were left exactly as they are. */
  adopted: number;
}

/**
 * Write the base currency and, only if this device has no accounts yet, the
 * ticked starter accounts. Durable and idempotent: the "do we already have
 * accounts?" question is answered from the database INSIDE the same read-write
 * transaction as the insert, so no reload, retry or second run can ever add a
 * duplicate set. Existing accounts are adopted, never touched (SPEC §6:
 * user-entered data is never destroyed).
 */
export async function createAccountsAndSettings(
  rows: AccountRowState[],
  baseCurrency: string,
): Promise<StarterAccountsResult> {
  return db.transaction('rw', db.accounts, db.settings, async () => {
    await updateSettings({ baseCurrency });
    const existing = await db.accounts.count();
    // Adopt: nothing is built, so stale row state can't even be looked at.
    if (existing > 0) return { created: 0, adopted: existing };
    // buildAccounts throws on an unreadable opening balance rather than
    // defaulting it to zero (SPEC §6); inside the transaction that aborts the
    // whole write, so a refused amount leaves the database untouched.
    const accounts = buildAccounts(rows, baseCurrency);
    if (accounts.length > 0) await db.accounts.bulkAdd(accounts);
    return { created: accounts.length, adopted: 0 };
  });
}

/**
 * What happens when a restore finishes. The restore path deliberately bypasses
 * finish() — the backup carries its own settings row, including `onboarded` —
 * but the persistent-storage request (SPEC §9) lives in finish(), so it has to
 * be made here too. Without it a fresh install that starts by restoring runs
 * its whole first session with storage the browser is free to evict, which on
 * iOS is exactly how data disappears.
 * Dependencies are parameters so the behaviour is testable without a DOM.
 */
export function completeRestore(
  persist: () => Promise<unknown> = requestPersistence,
  go: (path: string) => void = navigate,
): void {
  void persist(); // fire and forget — the result is surfaced in Settings
  go('/dashboard');
}
