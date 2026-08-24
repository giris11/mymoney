// Duplicate detection (SPEC §7.4). CONTRACT — implemented by the import build
// agent.
//
//  * dedupeHash = `${accountId}|${date}|${amountMinor}|${normalised payee-or-
//    description}` — the normalised key string itself, collision-free and
//    debuggable (D10). Recomputed on every transaction save.
//  * exact duplicate: identical dedupeHash → auto-skip with a shown count;
//  * near duplicate: same account, same amountMinor, date within ±1 day,
//    similar payee/description → flagged for user decision, never silently
//    dropped or doubled.
import type { Transaction } from '../db/types';

/** lowercase, trim, collapse whitespace, strip punctuation. */
export function normalizeForHash(s: string): string {
  void s;
  throw new Error('not implemented');
}

export function makeDedupeHash(
  accountId: string,
  date: string,
  amountMinor: number,
  payeeOrDescription: string,
): string {
  void accountId;
  void date;
  void amountMinor;
  void payeeOrDescription;
  throw new Error('not implemented');
}

/**
 * Payee similarity for near-duplicate flagging: normalised equality,
 * containment, or Levenshtein distance ≤ 25% of the longer length.
 */
export function similarPayee(a: string, b: string): boolean {
  void a;
  void b;
  throw new Error('not implemented');
}

/** Pure Levenshtein distance (exported for tests). */
export function levenshtein(a: string, b: string): number {
  void a;
  void b;
  throw new Error('not implemented');
}

export interface DupCheckResult {
  exact: boolean;
  nearDuplicateOf: Transaction | null;
}

/**
 * Check one candidate against existing transactions of the same account
 * (callers pass a prefetched map/array — no db access here; pure & testable).
 */
export function checkDuplicate(
  candidate: { accountId: string; date: string; amountMinor: number; payeeOrDescription: string },
  existingByAccount: Transaction[],
  payeeNameOf: (t: Transaction) => string,
): DupCheckResult {
  void candidate;
  void existingByAccount;
  void payeeNameOf;
  throw new Error('not implemented');
}
