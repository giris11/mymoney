// Balances + net worth tests (SPEC §6, §10): pure balance maths, per-account
// balances with pending vs cleared and opening balances, multi-currency net
// worth with and without missing rates — all against hand-calculated values.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, updateSettings } from '../src/db/db';
import type { Account, Transaction, TxStatus } from '../src/db/types';
import { uid } from '../src/lib/util';
import { accountBalances, balanceFromAmounts, netWorth } from '../src/domain/balances';
import { setManualRate } from '../src/domain/fx';

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

async function makeAccount(over: Partial<Account> = {}): Promise<Account> {
  const acc: Account = {
    id: uid(),
    name: 'Account',
    type: 'current',
    currency: 'GBP',
    openingBalanceMinor: 0,
    colour: '#336699',
    groupId: null,
    sortOrder: 0,
    archived: false,
    ...over,
  };
  await db.accounts.put(acc);
  return acc;
}

let seq = 0;
async function rawTx(
  accountId: string,
  amountMinor: number,
  status: TxStatus = 'cleared',
  currency = 'GBP',
): Promise<Transaction> {
  seq += 1;
  const tx: Transaction = {
    id: uid(),
    accountId,
    date: '2026-01-15',
    amountMinor,
    currency,
    payeeId: null,
    categoryId: null,
    tagIds: [],
    notes: '',
    status,
    splits: [],
    transferGroupId: null,
    importBatchId: null,
    dedupeHash: `raw-${seq}`,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
  await db.transactions.put(tx);
  return tx;
}

beforeEach(async () => {
  await clearAll();
  seq = 0;
});

// ---------------------------------------------------------- balanceFromAmounts
describe('balanceFromAmounts (pure)', () => {
  it('no transactions → opening balance', () => {
    expect(balanceFromAmounts(12345, [])).toBe(12345);
  });

  it('opening + Σ amounts, hand-calculated', () => {
    // 10000 − 2350 − 1500 + 250000 = 256150
    expect(balanceFromAmounts(10000, [-2350, -1500, 250000])).toBe(256150);
  });

  it('amounts can cancel to exactly the opening', () => {
    expect(balanceFromAmounts(0, [5, -5])).toBe(0);
  });

  it('negative opening (credit card): −5000 − 4999 = −9999', () => {
    expect(balanceFromAmounts(-5000, [-4999])).toBe(-9999);
  });
});

// -------------------------------------------------------------- accountBalances
describe('accountBalances', () => {
  it('opening + all txs; clearedMinor counts only cleared; pending included in balance (D15)', async () => {
    // Account A: opening £100.00 = 10000p
    //   −2350 cleared (£23.50), −1500 pending (£15.00), +250000 cleared (£2500)
    //   balance = 10000 − 2350 − 1500 + 250000 = 256150   (£2561.50)
    //   cleared = 10000 − 2350 + 250000          = 257650  (£2576.50)
    // Account B (credit card): opening −5000, one pending −4999
    //   balance = −5000 − 4999 = −9999 ; cleared = −5000
    // Account C: opening 777, no transactions → 777/777, txCount 0
    const a = await makeAccount({ name: 'A', openingBalanceMinor: 10000, sortOrder: 0 });
    const b = await makeAccount({
      name: 'B',
      type: 'credit_card',
      openingBalanceMinor: -5000,
      sortOrder: 1,
    });
    const c = await makeAccount({ name: 'C', openingBalanceMinor: 777, sortOrder: 2 });
    await rawTx(a.id, -2350, 'cleared');
    await rawTx(a.id, -1500, 'pending');
    await rawTx(a.id, 250000, 'cleared');
    await rawTx(b.id, -4999, 'pending');

    const balances = await accountBalances();
    expect(balances).toHaveLength(3);
    const byId = new Map(balances.map((x) => [x.account.id, x]));

    expect(byId.get(a.id)).toMatchObject({ balanceMinor: 256150, clearedMinor: 257650, txCount: 3 });
    expect(byId.get(b.id)).toMatchObject({ balanceMinor: -9999, clearedMinor: -5000, txCount: 1 });
    expect(byId.get(c.id)).toMatchObject({ balanceMinor: 777, clearedMinor: 777, txCount: 0 });
  });

  it('includes archived accounts (callers filter)', async () => {
    const arch = await makeAccount({ name: 'Old', archived: true, openingBalanceMinor: 42 });
    const balances = await accountBalances();
    expect(balances).toHaveLength(1);
    expect(balances[0].account.id).toBe(arch.id);
    expect(balances[0].balanceMinor).toBe(42);
  });

  it('an account with no excludeFromNetWorth key reads as not excluded', async () => {
    // Rows written by earlier builds have no such key at all — undefined must
    // resolve to false here, not leak out as undefined.
    const a = await makeAccount({ name: 'Legacy', openingBalanceMinor: 100 });
    expect(a).not.toHaveProperty('excludeFromNetWorth');
    const [row] = await accountBalances();
    expect(row.excludedFromNetWorth).toBe(false);
  });
});

// ------------------------------------------------------------------- netWorth
describe('netWorth', () => {
  // The headline figure and the chart must agree, and until this test they did
  // not. netWorth() converted once per ACCOUNT; netWorthSeries() sums per
  // currency and converts once per currency per point. Two accounts sharing a
  // non-base currency therefore produced two different net worths for one book.
  //
  // 705 + 705 = 1410 minor units at 0.85:
  //     per account  → round(599.25) + round(599.25) = 599 + 599 = 1198
  //     per currency → round(1198.5)                            = 1199
  // Both are defensible alone. Showing both, for the same book, is not.
  it('sums per currency before converting, so two accounts in one currency round once', async () => {
    await updateSettings({ baseCurrency: 'GBP' });
    await setManualRate('EUR', 'GBP', 0.85);
    await makeAccount({ currency: 'EUR', openingBalanceMinor: 705 });
    await makeAccount({ currency: 'EUR', openingBalanceMinor: 705 });

    const nw = await netWorth();

    // 1198 is the old per-account answer and is what fails without the fix.
    expect(nw.totalBaseMinor).toBe(1199);
    expect(nw.missingRateCurrencies).toEqual([]);
  });

  // Same rounding rule has to hold for the "not counted" total, which is shown
  // beside the headline: an excluded pair must not drift from it either.
  it('applies the same one-rounding-per-currency rule to the excluded total', async () => {
    await updateSettings({ baseCurrency: 'GBP' });
    await setManualRate('EUR', 'GBP', 0.85);
    await makeAccount({ currency: 'EUR', openingBalanceMinor: 705, excludeFromNetWorth: true });
    await makeAccount({ currency: 'EUR', openingBalanceMinor: 705, excludeFromNetWorth: true });

    const nw = await netWorth();

    expect(nw.totalBaseMinor).toBe(0);
    expect(nw.excludedCount).toBe(2);
    expect(nw.excludedBaseMinor).toBe(1199);
  });

  it('empty database → zero in default base currency GBP', async () => {
    // excludedCount/excludedBaseMinor: nothing to exclude, and 0 (not null) —
    // null means "an excluded account could not be converted" (SPEC §6).
    expect(await netWorth()).toEqual({
      totalBaseMinor: 0,
      baseCurrency: 'GBP',
      missingRateCurrencies: [],
      excludedCount: 0,
      excludedBaseMinor: 0,
    });
  });

  it('multi-currency, all rates present — hand-calculated', async () => {
    // Base GBP (default settings).
    // GBP account: opening 10000, −2500 cleared, −500 pending
    //   balance = 10000 − 2500 − 500 = 7000p (pending counts, D15); GBP→GBP = 7000
    // EUR account: opening 1111 (€11.11), rate 1 EUR = 0.85 GBP
    //   convert: 1111 × 0.85 × 100/100 = 944.35 → half-away-from-zero → 944p
    // JPY account: opening 5000 (¥5000, 0-decimal), rate 1 JPY = 0.0055 GBP
    //   convert: 5000 × 0.0055 × 100/1 = 2750p (£27.50)
    // Archived GBP account with 999999 → EXCLUDED from net worth.
    // Total = 7000 + 944 + 2750 = 10694p (£106.94)
    const gbp = await makeAccount({ name: 'Current', currency: 'GBP', openingBalanceMinor: 10000 });
    await makeAccount({ name: 'EU', currency: 'EUR', openingBalanceMinor: 1111 });
    await makeAccount({ name: 'JP', currency: 'JPY', openingBalanceMinor: 5000 });
    await makeAccount({
      name: 'Closed',
      currency: 'GBP',
      openingBalanceMinor: 999999,
      archived: true,
    });
    await rawTx(gbp.id, -2500, 'cleared');
    await rawTx(gbp.id, -500, 'pending');
    await setManualRate('EUR', 'GBP', 0.85);
    await setManualRate('JPY', 'GBP', 0.0055);

    const nw = await netWorth();
    expect(nw.baseCurrency).toBe('GBP');
    expect(nw.totalBaseMinor).toBe(10694);
    expect(nw.missingRateCurrencies).toEqual([]);
  });

  it('uses the inverse of a stored reverse-direction rate', async () => {
    // Stored: 1 GBP = 1.25 USD ⇒ USD→GBP uses 1/1.25 = 0.8.
    // USD account balance 1000 (=$10.00): 1000 × 0.8 × 100/100 = 800p (£8.00)
    // GBP account 500p converts 1:1.  Total = 500 + 800 = 1300p
    await makeAccount({ name: 'UK', currency: 'GBP', openingBalanceMinor: 500 });
    await makeAccount({ name: 'US', currency: 'USD', openingBalanceMinor: 1000 });
    await setManualRate('GBP', 'USD', 1.25);
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(1300);
    expect(nw.missingRateCurrencies).toEqual([]);
  });

  it('missing rate: currency EXCLUDED from total and listed once', async () => {
    // GBP 7500p included. Two USD accounts (100, 200) have NO rate:
    // both excluded, 'USD' appears exactly once. Total stays 7500p.
    // EUR 1000 with rate 0.85 → 1000 × 0.85 = 850p included.
    // Total = 7500 + 850 = 8350p
    await makeAccount({ name: 'UK', currency: 'GBP', openingBalanceMinor: 7500 });
    await makeAccount({ name: 'US-1', currency: 'USD', openingBalanceMinor: 100 });
    await makeAccount({ name: 'US-2', currency: 'USD', openingBalanceMinor: 200 });
    await makeAccount({ name: 'EU', currency: 'EUR', openingBalanceMinor: 1000 });
    await setManualRate('EUR', 'GBP', 0.85);

    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(8350);
    expect(nw.missingRateCurrencies).toEqual(['USD']);
  });

  it('respects a non-GBP base currency from settings', async () => {
    // Base EUR. GBP account 7500p; stored rate 1 EUR = 0.85 GBP
    // ⇒ GBP→EUR = 1/0.85. 7500 × (1/0.85) = 8823.529… → 8824 (half away from zero)
    await updateSettings({ baseCurrency: 'EUR' });
    await makeAccount({ name: 'UK', currency: 'GBP', openingBalanceMinor: 7500 });
    await setManualRate('EUR', 'GBP', 0.85);

    const nw = await netWorth();
    expect(nw.baseCurrency).toBe('EUR');
    expect(nw.totalBaseMinor).toBe(8824);
  });
});
