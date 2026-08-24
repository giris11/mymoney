// Duplicate detection (SPEC §7.4).
//
//  * dedupeHash = `${accountId}|${date}|${amountMinor}|${normalised payee-or-
//    description}` — the normalised key string itself, collision-free and
//    debuggable (D10). Recomputed on every transaction save; the hash input is
//    the payee name when present, else the description/notes-line used at
//    import. Both manual saves and imports MUST follow that rule so re-imports
//    match manual entries.
//  * exact duplicate: identical dedupeHash → auto-skip with a shown count;
//  * near duplicate: same account, same amountMinor, date within ±1 day,
//    similar payee/description → flagged for user decision, never silently
//    dropped or doubled.
import type { Transaction } from '../db/types';

/** lowercase, strip punctuation/symbols, collapse whitespace, trim. */
export function normalizeForHash(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeDedupeHash(
  accountId: string,
  date: string,
  amountMinor: number,
  payeeOrDescription: string,
): string {
  return `${accountId}|${date}|${amountMinor}|${normalizeForHash(payeeOrDescription)}`;
}

/** Pure Levenshtein distance (two-row DP). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Payee similarity for near-duplicate flagging: normalised equality,
 * containment (min length 3), or Levenshtein ≤ max(1, 25% of longer length).
 */
export function similarPayee(a: string, b: string): boolean {
  const na = normalizeForHash(a);
  const nb = normalizeForHash(b);
  if (na === nb) return true; // covers both-empty
  if (!na || !nb) return false;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 3 && longer.includes(shorter)) return true;
  const threshold = Math.max(1, Math.floor(longer.length * 0.25));
  return levenshtein(na, nb) <= threshold;
}

const dayDiff = (a: string, b: string): number =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

export interface DupCheckResult {
  exact: boolean;
  nearDuplicateOf: Transaction | null;
}

/**
 * Check one candidate against existing transactions of the same account
 * (callers pass a prefetched array — no db access here; pure & testable).
 * Near-duplicate matches prefer same-date over ±1-day ones.
 */
export function checkDuplicate(
  candidate: { accountId: string; date: string; amountMinor: number; payeeOrDescription: string },
  existingByAccount: Transaction[],
  payeeNameOf: (t: Transaction) => string,
): DupCheckResult {
  const hash = makeDedupeHash(
    candidate.accountId,
    candidate.date,
    candidate.amountMinor,
    candidate.payeeOrDescription,
  );
  let near: Transaction | null = null;
  let nearDist = Infinity;
  for (const t of existingByAccount) {
    if (t.accountId !== candidate.accountId) continue;
    if (t.dedupeHash === hash) return { exact: true, nearDuplicateOf: null };
    if (t.amountMinor !== candidate.amountMinor) continue;
    const dd = dayDiff(t.date, candidate.date);
    if (dd > 1) continue;
    if (!similarPayee(candidate.payeeOrDescription, payeeNameOf(t))) continue;
    if (dd < nearDist) {
      near = t;
      nearDist = dd;
    }
  }
  return { exact: false, nearDuplicateOf: near };
}
