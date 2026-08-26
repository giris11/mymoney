// Account balances and net worth (SPEC §6: balance = openingBalance + sum of
// its transactions; pending included, D15). Conversion happens only here, at
// report time, via rateLookup() — a missing rate excludes the account from the
// converted total and is surfaced, never guessed (SPEC §6).
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
}

export interface NetWorth {
  /** Sum of all non-archived account balances converted to base currency. */
  totalBaseMinor: number;
  baseCurrency: string;
  /** Currencies excluded from the total because no rate exists (SPEC §6). */
  missingRateCurrencies: string[];
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
      };
    });
}

/**
 * Balances for ALL accounts (archived included — callers filter).
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
  for (const b of resolved) {
    if (b.account.archived) continue;
    const converted = convertMinor(b.balanceMinor, b.account.currency, base, lookup);
    if (converted === null) missing.add(b.account.currency);
    else total += converted;
  }
  return { totalBaseMinor: total, baseCurrency: base, missingRateCurrencies: [...missing] };
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
