// Account balances and net worth (SPEC §6: balance = openingBalance + sum of
// its transactions; pending included, D15). Conversion happens only here, at
// report time, via rateLookup() — a missing rate excludes the account from the
// converted total and is surfaced, never guessed (SPEC §6).
//
// WHAT COUNTS: an account balance is always the account's own real balance.
// Whether it lands in the NET WORTH total is a separate question, answered by
// countsTowardNetWorth() below — archived (retired) or flagged
// excludeFromNetWorth ("show it, don't count it") keep an account out of the
// total while leaving its balance, its transactions and its visibility
// completely untouched.
//
// SCALE (SPEC §9): the sidebar is mounted on every page and re-runs this on
// every write, so the aggregation STREAMS the transactions table in batches
// and accumulates into a small per-account map. It never materialises an array
// of 100k transaction objects just to read one integer field from each. The
// work is still O(rows) — see balanceSnapshot() for how callers avoid paying
// it twice over for balances and net worth.
import { db, getSettings } from '../db/db';
import { convertMinor } from '../money/money';
import type { Account, Transaction } from '../db/types';
import { rateLookup } from './fx';

export interface AccountBalance {
  account: Account;
  balanceMinor: number; // opening + all transactions
  clearedMinor: number; // opening + cleared transactions only
  txCount: number;
  /**
   * Mirror of account.excludeFromNetWorth, resolved (undefined → false) so
   * every consumer can render "not counted" without a second lookup. The
   * balance above is the real balance either way — excluding an account never
   * changes its own figure, only what the TOTAL counts.
   */
  excludedFromNetWorth: boolean;
}

export interface NetWorth {
  /**
   * Sum of the account balances that COUNT — not archived, not excluded from
   * net worth — converted to base currency.
   */
  totalBaseMinor: number;
  baseCurrency: string;
  /** Currencies excluded from the total because no rate exists (SPEC §6). */
  missingRateCurrencies: string[];
  /**
   * How many visible (non-archived) accounts the user has flagged as
   * not-counted, so the UI can say "N accounts not counted" honestly.
   * Archived accounts are NOT counted here even when flagged: they are already
   * out of the total for an older, separate reason and are not on screen next
   * to the headline figure, so counting them again would overstate what the
   * user can actually see.
   */
  excludedCount: number;
  /**
   * What those excluded accounts are worth, in base currency — the "£X not
   * counted" figure. NULL when any of them is in a currency with no rate to
   * base: the honest answer is then "we cannot total this", never a guess that
   * silently omits an account (SPEC §6). The excluded accounts' currencies are
   * deliberately NOT added to missingRateCurrencies — that list means
   * "your total is missing this currency", and an excluded account was never
   * going to be in the total.
   */
  excludedBaseMinor: number | null;
}

/**
 * Has the user flagged this account out of net-worth totals? Single reader of
 * the optional flag, so undefined (rows from older builds/backups) resolves to
 * false in exactly one place.
 */
export function isExcludedFromNetWorth(account: Account): boolean {
  return account.excludeFromNetWorth === true;
}

/**
 * Does this account contribute to the net-worth total? The two reasons NOT to
 * count compose: archived (retired) OR excluded (visible but not counted).
 * Shared by netWorth() here and netWorthSeries() in reports/aggregate.ts so
 * the headline figure and the chart can never disagree about which accounts
 * count.
 */
export function countsTowardNetWorth(account: Account): boolean {
  return !account.archived && !isExcludedFromNetWorth(account);
}

/** Pure core, unit-tested: opening + Σ amounts. */
export function balanceFromAmounts(openingMinor: number, amounts: number[]): number {
  return amounts.reduce((acc, a) => acc + a, openingMinor);
}

interface Agg {
  sum: number;
  cleared: number;
  count: number;
}

/**
 * Rows read per batch by aggregateByAccount(). Big enough that a 100k ledger
 * costs ~40 batched reads rather than 100k cursor steps, small enough that the
 * peak live set is a couple of thousand rows (~2MB) instead of the whole table.
 */
export const SCAN_BATCH = 2_500;

/**
 * accountId → totals, streamed rather than materialised.
 *
 * `toArray()` here used to hand back every transaction at once — at 100k rows
 * that is a ~100MB array of objects, all of it garbage the moment three fields
 * have been read off each one, and on an iPhone that peak is exactly what gets
 * the tab evicted. Instead we page through the primary-key index: each batch
 * is fetched with one `getAll` (so we keep the speed of a bulk read rather
 * than paying a cursor round trip per row), summed, and dropped, leaving only
 * a handful of numbers per account alive.
 *
 * The whole scan runs in ONE readonly transaction so the batches are a
 * consistent snapshot — a write landing mid-scan can never be counted twice or
 * missed. Paging is keyed on the last id seen (never `offset()`, which makes
 * the database re-walk the rows it just skipped).
 */
async function aggregateByAccount(): Promise<Map<string, Agg>> {
  const agg = new Map<string, Agg>();
  const add = (t: Transaction) => {
    let a = agg.get(t.accountId);
    if (!a) {
      a = { sum: 0, cleared: 0, count: 0 };
      agg.set(t.accountId, a);
    }
    a.sum += t.amountMinor;
    if (t.status === 'cleared') a.cleared += t.amountMinor;
    a.count += 1;
  };

  await db.transaction('r', db.transactions, async () => {
    let after: string | null = null;
    for (;;) {
      const batch: Transaction[] =
        after === null
          ? await db.transactions.orderBy('id').limit(SCAN_BATCH).toArray()
          : await db.transactions.where('id').above(after).limit(SCAN_BATCH).toArray();
      for (const t of batch) add(t);
      // A short batch means the index is exhausted — `above()` is strict, so
      // resuming from the last id seen never re-reads or skips a row.
      if (batch.length < SCAN_BATCH) break;
      after = batch[batch.length - 1]!.id;
    }
  });
  return agg;
}

function toBalances(accounts: Account[], agg: Map<string, Agg>): AccountBalance[] {
  return accounts
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((account) => {
      const a = agg.get(account.id) ?? { sum: 0, cleared: 0, count: 0 };
      return {
        account,
        balanceMinor: account.openingBalanceMinor + a.sum,
        clearedMinor: account.openingBalanceMinor + a.cleared,
        txCount: a.count,
        excludedFromNetWorth: isExcludedFromNetWorth(account),
      };
    });
}

/**
 * Balances for ALL accounts (archived AND net-worth-excluded included —
 * callers filter; an excluded account must stay visible with its real
 * balance, it is "not counted", not hidden).
 * One streamed pass over the transactions table, grouped in JS — never a query
 * per account, and never a materialised copy of the table (SPEC §9 scale).
 */
export async function accountBalances(): Promise<AccountBalance[]> {
  const [accounts, agg] = await Promise.all([db.accounts.toArray(), aggregateByAccount()]);
  return toBalances(accounts, agg);
}

/**
 * Net worth in base currency.
 *
 * Two independent reasons an account is left out of the total, composed here
 * (archived OR excluded ⇒ not counted):
 *  * `archived` — retired; already the behaviour before exclusions existed and
 *    unchanged by them;
 *  * `excludeFromNetWorth` — the user's "show it, don't count it" flag (a
 *    property valuation, gift cards, money-lent ledgers).
 * Excluding never touches a balance or an amount: the excluded accounts are
 * totalled separately into excludedCount/excludedBaseMinor so the UI can say
 * exactly how much is sitting outside the figure.
 *
 * Pass the balances in when you already have them — net worth is derived from
 * them, and re-deriving means a second full pass over the transactions table.
 */
export async function netWorth(balances?: AccountBalance[]): Promise<NetWorth> {
  const [resolved, settings, lookup] = await Promise.all([
    balances ? Promise.resolve(balances) : accountBalances(),
    getSettings(),
    rateLookup(),
  ]);
  const base = settings.baseCurrency;
  let total = 0;
  const missing = new Set<string>();
  let excludedCount = 0;
  // Starts at 0 and latches to null the moment one excluded account cannot be
  // converted — a partial "not counted" total would be a wrong number, and a
  // wrong number is worse than an honest gap (SPEC §6).
  let excludedBaseMinor: number | null = 0;
  for (const b of resolved) {
    if (b.account.archived) continue;
    const converted = convertMinor(b.balanceMinor, b.account.currency, base, lookup);
    if (b.excludedFromNetWorth) {
      excludedCount += 1;
      if (converted === null) excludedBaseMinor = null;
      else if (excludedBaseMinor !== null) excludedBaseMinor += converted;
      continue;
    }
    if (converted === null) missing.add(b.account.currency);
    else total += converted;
  }
  return {
    totalBaseMinor: total,
    baseCurrency: base,
    missingRateCurrencies: [...missing],
    excludedCount,
    excludedBaseMinor,
  };
}

export interface BalanceSnapshot {
  balances: AccountBalance[];
  netWorth: NetWorth;
}

/**
 * Both figures from ONE pass over the transactions table.
 *
 * The sidebar shows the net-worth header AND every account balance, so
 * subscribing to `accountBalances()` and `netWorth()` separately reads the
 * whole table twice on every single write. Use this instead when you need
 * both (SPEC §9).
 */
export async function balanceSnapshot(): Promise<BalanceSnapshot> {
  const balances = await accountBalances();
  return { balances, netWorth: await netWorth(balances) };
}
