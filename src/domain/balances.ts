// Account balances and net worth (SPEC §6: balance = openingBalance + sum of
// its transactions; pending included, D15). CONTRACT — implemented by the
// domain build agent; stub returns empties so the shell renders pre-integration.
import type { Account } from '../db/types';

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

/** Balances for ALL accounts (archived included — callers filter). */
export async function accountBalances(): Promise<AccountBalance[]> {
  return []; // stub — implemented by domain agent
}

export async function netWorth(): Promise<NetWorth> {
  return { totalBaseMinor: 0, baseCurrency: 'GBP', missingRateCurrencies: [] }; // stub
}
