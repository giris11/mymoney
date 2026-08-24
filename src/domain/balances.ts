// Account balances and net worth (SPEC §6: balance = openingBalance + sum of
// its transactions; pending included, D15). Conversion happens only here, at
// report time, via rateLookup() — a missing rate excludes the account from the
// converted total and is surfaced, never guessed (SPEC §6).
import { db, getSettings } from '../db/db';
import { convertMinor } from '../money/money';
import type { Account } from '../db/types';
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

/**
 * Balances for ALL accounts (archived included — callers filter).
 * One pass over the transactions table, grouped in JS — never a query per
 * account (SPEC §9 scale).
 */
export async function accountBalances(): Promise<AccountBalance[]> {
  const [accounts, txs] = await Promise.all([db.accounts.toArray(), db.transactions.toArray()]);
  const agg = new Map<string, { sum: number; cleared: number; count: number }>();
  for (const t of txs) {
    let a = agg.get(t.accountId);
    if (!a) {
      a = { sum: 0, cleared: 0, count: 0 };
      agg.set(t.accountId, a);
    }
    a.sum += t.amountMinor;
    if (t.status === 'cleared') a.cleared += t.amountMinor;
    a.count += 1;
  }
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

export async function netWorth(): Promise<NetWorth> {
  const [balances, settings, lookup] = await Promise.all([
    accountBalances(),
    getSettings(),
    rateLookup(),
  ]);
  const base = settings.baseCurrency;
  let total = 0;
  const missing = new Set<string>();
  for (const b of balances) {
    if (b.account.archived) continue;
    const converted = convertMinor(b.balanceMinor, b.account.currency, base, lookup);
    if (converted === null) missing.add(b.account.currency);
    else total += converted;
  }
  return { totalBaseMinor: total, baseCurrency: base, missingRateCurrencies: [...missing] };
}
