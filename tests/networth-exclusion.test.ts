// "Show it, don't count it" — Account.excludeFromNetWorth (SPEC §6).
//
// The whole feature is one rule: excluding changes what a TOTAL counts, and
// nothing else. So most of this file is about what must NOT move — balances,
// transactions, amounts, and every category-based report — while net worth
// moves by exactly the excluded account's converted balance.
//
// Every expectation below is hand-calculated in the comment above it.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, updateSettings } from '../src/db/db';
import type { Account, AccountGroup, Category, Transaction, TxStatus } from '../src/db/types';
import { uid } from '../src/lib/util';
import { accountBalances, netWorth } from '../src/domain/balances';
import { saveAccount, setAccountExcluded, setGroupExcluded } from '../src/domain/accounts';
import { ValidationError } from '../src/domain/transactions';
import { setManualRate } from '../src/domain/fx';
import { exportBackup, restoreBackup, type BackupFile } from '../src/backup/backup';
import {
  cashFlowByMonth,
  incomeVsExpenseByMonth,
  netWorthSeries,
  spendingByCategory,
  spendingByPayee,
  spendingByTag,
  type DateRange,
} from '../src/reports/aggregate';

// ---------------------------------------------------------------- fixture

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

async function makeAccount(over: Partial<Account> & { id?: string } = {}): Promise<Account> {
  const acc: Account = {
    id: over.id ?? uid(),
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

async function makeGroup(id: string, name: string): Promise<AccountGroup> {
  const group: AccountGroup = { id, name, sortOrder: 0 };
  await db.accountGroups.put(group);
  return group;
}

let seq = 0;
async function rawTx(
  accountId: string,
  amountMinor: number,
  over: Partial<Transaction> = {},
): Promise<Transaction> {
  seq += 1;
  const tx: Transaction = {
    id: uid(),
    accountId,
    date: '2026-01-15',
    amountMinor,
    currency: 'GBP',
    payeeId: null,
    categoryId: null,
    tagIds: [],
    notes: '',
    status: 'cleared' as TxStatus,
    splits: [],
    transferGroupId: null,
    importBatchId: null,
    dedupeHash: `raw-${seq}`,
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...over,
  };
  await db.transactions.put(tx);
  return tx;
}

const RANGE: DateRange = { from: '2026-01-01', to: '2026-12-31' };

/**
 * The owner's actual problem, in miniature. Base GBP, 1 EUR = 0.85 GBP.
 *
 *   cur   GBP current    100000 − 20000 cleared − 5000 pending =   75000
 *   sav   GBP savings                                          =  250000
 *   eur   EUR holiday    20000 − 2000 = 18000 EUR ×0.85        =   15300
 *   prop  GBP "House"                                          = 9000000
 *   gift  GBP gift card                                        =    2500
 *   lent  GBP lent out (group 'ledgers')                       =   12000
 *   owed  GBP owed       (group 'ledgers')                     =   −8000
 *   TOTAL, nothing excluded                                    = 9346800
 */
const TOTAL_ALL_COUNTED = 9_346_800;
const PROP_MINOR = 9_000_000;
const EUR_BASE_MINOR = 15_300; // 18000 EUR converted once, half away from zero

async function seed(): Promise<void> {
  await makeGroup('ledgers', 'Money lent & owed');
  await makeAccount({ id: 'cur', name: 'Current', openingBalanceMinor: 100_000, sortOrder: 0 });
  await makeAccount({
    id: 'sav',
    name: 'Savings',
    type: 'savings',
    openingBalanceMinor: 250_000,
    sortOrder: 1,
  });
  await makeAccount({
    id: 'eur',
    name: 'Holiday euros',
    currency: 'EUR',
    openingBalanceMinor: 20_000,
    sortOrder: 2,
  });
  await makeAccount({
    id: 'prop',
    name: 'House',
    type: 'investment',
    openingBalanceMinor: PROP_MINOR,
    sortOrder: 3,
  });
  await makeAccount({ id: 'gift', name: 'Gift card', type: 'cash', openingBalanceMinor: 2_500, sortOrder: 4 });
  await makeAccount({ id: 'lent', name: 'Lent to Sam', openingBalanceMinor: 12_000, groupId: 'ledgers', sortOrder: 5 });
  await makeAccount({ id: 'owed', name: 'Owed to Ana', openingBalanceMinor: -8_000, groupId: 'ledgers', sortOrder: 6 });

  const groceries: Category = {
    id: 'cGroc',
    name: 'Groceries',
    parentId: null,
    kind: 'expense',
    archived: false,
    sortOrder: 0,
  };
  await db.categories.put(groceries);
  await db.payees.put({ id: 'pShop', name: 'Corner Shop', nameLower: 'corner shop', defaultCategoryId: null });
  await db.tags.put({ id: 'tFood', name: 'food', nameLower: 'food' });

  await rawTx('cur', -20_000, { categoryId: 'cGroc', payeeId: 'pShop', tagIds: ['tFood'] });
  await rawTx('cur', -5_000, { status: 'pending', categoryId: 'cGroc' });
  await rawTx('eur', -2_000, { currency: 'EUR', categoryId: 'cGroc', payeeId: 'pShop', tagIds: ['tFood'] });

  await setManualRate('EUR', 'GBP', 0.85);
}

/** Every account's own numbers, as a stable comparable snapshot. */
async function balanceFingerprint(): Promise<string> {
  const rows = (await accountBalances())
    .map((b) => ({
      id: b.account.id,
      currency: b.account.currency,
      balanceMinor: b.balanceMinor,
      clearedMinor: b.clearedMinor,
      txCount: b.txCount,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(rows);
}

/** Every category-based report, as one comparable blob. */
async function reportFingerprint(): Promise<string> {
  return JSON.stringify({
    byCategory: await spendingByCategory(RANGE, null),
    byCategoryDrill: await spendingByCategory(RANGE, 'cGroc'),
    incomeVsExpense: await incomeVsExpenseByMonth(RANGE),
    cashFlow: await cashFlowByMonth(RANGE),
    byPayee: await spendingByPayee(RANGE),
    byTag: await spendingByTag(RANGE),
  });
}

beforeEach(async () => {
  await clearAll();
  seq = 0;
  await seed();
});

// ------------------------------------------------------- the total, and only the total

describe('netWorth with an excluded account', () => {
  it('drops by exactly the excluded balance — and nothing else moves', async () => {
    const before = await netWorth();
    expect(before).toEqual({
      totalBaseMinor: TOTAL_ALL_COUNTED,
      baseCurrency: 'GBP',
      missingRateCurrencies: [],
      excludedCount: 0,
      excludedBaseMinor: 0,
    });
    const balancesBefore = await balanceFingerprint();
    const txsBefore = JSON.stringify(await db.transactions.orderBy('id').toArray());

    // £90,000 property out: 9346800 − 9000000 = 346800.
    await setAccountExcluded('prop', true);

    expect(await netWorth()).toEqual({
      totalBaseMinor: TOTAL_ALL_COUNTED - PROP_MINOR, // 346800
      baseCurrency: 'GBP',
      missingRateCurrencies: [],
      excludedCount: 1,
      excludedBaseMinor: PROP_MINOR,
    });
    // Balances, transactions and amounts: byte-identical.
    expect(await balanceFingerprint()).toBe(balancesBefore);
    expect(JSON.stringify(await db.transactions.orderBy('id').toArray())).toBe(txsBefore);
  });

  it('the excluded account stays VISIBLE with its real balance', async () => {
    await setAccountExcluded('prop', true);
    const rows = await accountBalances();
    const prop = rows.find((r) => r.account.id === 'prop');
    expect(prop).toBeDefined();
    expect(prop!.balanceMinor).toBe(PROP_MINOR); // still £90,000, still on screen
    expect(prop!.excludedFromNetWorth).toBe(true);
    // …and every other row still reads as counted.
    expect(rows.filter((r) => r.excludedFromNetWorth).map((r) => r.account.id)).toEqual(['prop']);
  });

  it('a FOREIGN excluded account is netted out at its converted value', async () => {
    // EUR balance 18000 → 15300 GBP. Total 9346800 − 15300 = 9331500,
    // and the "not counted" figure is the CONVERTED 15300, never the raw 18000.
    await setAccountExcluded('eur', true);
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(TOTAL_ALL_COUNTED - EUR_BASE_MINOR); // 9331500
    expect(nw.excludedCount).toBe(1);
    expect(nw.excludedBaseMinor).toBe(EUR_BASE_MINOR); // 15300
  });

  it('several excluded accounts sum into one "not counted" figure', async () => {
    // prop 9000000 + gift 2500 = 9002500 out; total 9346800 − 9002500 = 344300.
    await setAccountExcluded('prop', true);
    await setAccountExcluded('gift', true);
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(344_300);
    expect(nw.excludedCount).toBe(2);
    expect(nw.excludedBaseMinor).toBe(9_002_500);
  });

  it('is reversible in one call — the figure returns exactly', async () => {
    const before = await netWorth();
    await setAccountExcluded('prop', true);
    expect((await netWorth()).totalBaseMinor).not.toBe(before.totalBaseMinor);
    await setAccountExcluded('prop', false);
    expect(await netWorth()).toEqual(before);
  });

  it('rows with no excludeFromNetWorth key at all count normally', async () => {
    // Written by an earlier build / restored from an older backup: the key is
    // absent, not false. undefined must behave as included.
    const stored = await db.accounts.toArray();
    expect(stored.every((a) => !('excludeFromNetWorth' in a))).toBe(true);
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(TOTAL_ALL_COUNTED);
    expect(nw.excludedCount).toBe(0);
  });
});

// ------------------------------------------------------------------ missing rates

describe('excluded accounts and missing FX rates (SPEC §6 — never guess)', () => {
  it('an excluded account with no rate ⇒ excludedBaseMinor null, still counted in excludedCount', async () => {
    // CHF has no rate to GBP. Flagged excluded, so it is out of the total
    // anyway — but we cannot say WHAT is not counted, and a partial "not
    // counted" total would be a wrong number. null is the honest answer.
    await makeAccount({ id: 'chf', name: 'Ski fund', currency: 'CHF', openingBalanceMinor: 30_000 });
    await setAccountExcluded('chf', true);

    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(TOTAL_ALL_COUNTED); // the total is untouched
    expect(nw.excludedCount).toBe(1); // exactly the one CHF account
    expect(nw.excludedBaseMinor).toBeNull();
    // Not listed as a rate gap in the TOTAL: it was never going to be in it.
    expect(nw.missingRateCurrencies).toEqual([]);
    // The money is still findable, in its own currency.
    const chf = (await accountBalances()).find((b) => b.account.id === 'chf')!;
    expect(chf.balanceMinor).toBe(30_000);
    expect(chf.account.currency).toBe('CHF');
  });

  it('one unconvertible excluded account nulls the figure without hiding the others', async () => {
    // prop (9000000, convertible) + chf (no rate): excludedCount 2, but the
    // sum is null — we never report "£90,000 not counted" while silently
    // dropping the Swiss francs.
    await makeAccount({ id: 'chf', name: 'Ski fund', currency: 'CHF', openingBalanceMinor: 30_000 });
    await setAccountExcluded('prop', true);
    await setAccountExcluded('chf', true);
    const nw = await netWorth();
    expect(nw.excludedCount).toBe(2);
    expect(nw.excludedBaseMinor).toBeNull();
    expect(nw.totalBaseMinor).toBe(TOTAL_ALL_COUNTED - PROP_MINOR);
  });

  it('a COUNTED account with no rate is still reported in missingRateCurrencies', async () => {
    // The exclusion path must not swallow the existing honest warning.
    await makeAccount({ id: 'chf', name: 'Ski fund', currency: 'CHF', openingBalanceMinor: 30_000 });
    const nw = await netWorth();
    expect(nw.missingRateCurrencies).toEqual(['CHF']);
    expect(nw.excludedCount).toBe(0);
    expect(nw.totalBaseMinor).toBe(TOTAL_ALL_COUNTED);
  });
});

// ------------------------------------------------------------------ archived ∘ excluded

describe('archived and excluded compose (independent concepts)', () => {
  it('archived OR excluded ⇒ not counted; both ⇒ subtracted once, reported once', async () => {
    // Archive sav (250000) and exclude prop (9000000):
    //   9346800 − 250000 − 9000000 = 96800
    await db.accounts.update('sav', { archived: true });
    await setAccountExcluded('prop', true);
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(96_800);
    // Archived-only accounts are NOT part of the "not counted" figure — they
    // are out for an older, separate reason and are not on screen beside it.
    expect(nw.excludedCount).toBe(1);
    expect(nw.excludedBaseMinor).toBe(PROP_MINOR);
  });

  it('an account that is BOTH archived and excluded is subtracted once', async () => {
    // gift (2500) archived AND excluded: 9346800 − 2500 = 9344300, counted
    // once, and not double-reported in the excluded figure.
    await db.accounts.update('gift', { archived: true });
    await setAccountExcluded('gift', true);
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(9_344_300);
    expect(nw.excludedCount).toBe(0);
    expect(nw.excludedBaseMinor).toBe(0);
  });

  it('un-archiving an excluded account leaves it excluded (flags are independent)', async () => {
    await db.accounts.update('prop', { archived: true });
    await setAccountExcluded('prop', true);
    await db.accounts.update('prop', { archived: false });
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(TOTAL_ALL_COUNTED - PROP_MINOR);
    expect(nw.excludedCount).toBe(1);
  });
});

// ------------------------------------------------------------------ chart vs headline

describe('netWorthSeries agrees with netWorth', () => {
  it('the final point equals the headline figure, with and without exclusions', async () => {
    // Every transaction is dated 2026-01-15, so the series end (2026-12-31)
    // is the same "all time" cut netWorth() takes.
    const beforeSeries = await netWorthSeries(RANGE);
    const beforeLast = beforeSeries.points[beforeSeries.points.length - 1];
    expect(beforeLast.totalBaseMinor).toBe(TOTAL_ALL_COUNTED);

    await setAccountExcluded('prop', true);

    const nw = await netWorth();
    const after = await netWorthSeries(RANGE);
    const afterLast = after.points[after.points.length - 1];
    expect(afterLast.date).toBe('2026-12-31');
    expect(afterLast.totalBaseMinor).toBe(nw.totalBaseMinor); // chart == headline
    // …and it moved by exactly the excluded account's balance, no more.
    expect(beforeLast.totalBaseMinor - afterLast.totalBaseMinor).toBe(PROP_MINOR);
  });

  it('every point drops by the excluded balance — the whole line, not just the end', async () => {
    const before = await netWorthSeries(RANGE);
    await setAccountExcluded('prop', true);
    const after = await netWorthSeries(RANGE);
    expect(after.points.map((p) => p.date)).toEqual(before.points.map((p) => p.date));
    for (let i = 0; i < before.points.length; i++) {
      expect(before.points[i].totalBaseMinor - after.points[i].totalBaseMinor).toBe(PROP_MINOR);
    }
  });
});

// ------------------------------------------------------------------ reports untouched

describe('category-based reports are untouched by exclusions', () => {
  it('spending by category / payee / tag, income vs expense and cash flow are identical', async () => {
    // These group by CATEGORY, not by account: money spent from a gift card is
    // still spending. Excluding an account must not remove a single penny.
    const before = await reportFingerprint();
    await setAccountExcluded('prop', true);
    await setAccountExcluded('gift', true);
    await setAccountExcluded('eur', true); // even the foreign one
    await setGroupExcluded('ledgers', true);
    const after = await reportFingerprint();
    expect(after).toBe(before);
    // Not vacuous: the fixture really does produce spending rows, including
    // from the excluded EUR account (2000 EUR ×0.85 = 1700 of the total).
    const spend = await spendingByCategory(RANGE, null);
    expect(spend.rows).toHaveLength(1);
    expect(spend.rows[0].spentMinor).toBe(26_700); // 20000 + 5000 pending + 1700
    expect(spend.totalMinor).toBe(26_700);
    // …and net worth really did change, so the two are genuinely independent.
    expect((await netWorth()).excludedCount).toBe(5);
  });
});

// ------------------------------------------------------------------ writers

describe('setAccountExcluded', () => {
  it('writes ONLY excludeFromNetWorth', async () => {
    const before = await db.accounts.get('prop');
    await setAccountExcluded('prop', true);
    const after = await db.accounts.get('prop');
    expect(after!.excludeFromNetWorth).toBe(true);
    const strip = (a: Account | undefined) => {
      const { excludeFromNetWorth: _drop, ...rest } = a!;
      return JSON.stringify(rest);
    };
    expect(strip(after)).toBe(strip(before));
  });

  it('is idempotent and reversible', async () => {
    await setAccountExcluded('prop', true);
    await setAccountExcluded('prop', true);
    expect((await db.accounts.get('prop'))!.excludeFromNetWorth).toBe(true);
    await setAccountExcluded('prop', false);
    expect((await db.accounts.get('prop'))!.excludeFromNetWorth).toBe(false);
    expect((await netWorth()).totalBaseMinor).toBe(TOTAL_ALL_COUNTED);
  });

  it('un-excluding an account that never had the flag is a safe no-op', async () => {
    await setAccountExcluded('cur', false);
    expect((await netWorth()).totalBaseMinor).toBe(TOTAL_ALL_COUNTED);
  });

  it('throws ValidationError for an unknown account id', async () => {
    await expect(setAccountExcluded('nope', true)).rejects.toBeInstanceOf(ValidationError);
    // and nothing was written
    expect((await netWorth()).excludedCount).toBe(0);
  });

  it('survives an ordinary account edit (saveAccount must not drop the flag)', async () => {
    // Regression guard: the account form does not edit this field, so it has
    // to be carried through — renaming the house must not silently pull
    // £90,000 back into net worth.
    await setAccountExcluded('prop', true);
    const prop = (await db.accounts.get('prop'))!;
    await saveAccount({
      id: 'prop',
      name: 'House (Bristol)',
      type: prop.type,
      currency: prop.currency,
      openingBalanceMinor: prop.openingBalanceMinor,
      colour: prop.colour,
      groupId: prop.groupId,
    });
    expect((await db.accounts.get('prop'))!.name).toBe('House (Bristol)');
    expect((await db.accounts.get('prop'))!.excludeFromNetWorth).toBe(true);
    expect((await netWorth()).totalBaseMinor).toBe(TOTAL_ALL_COUNTED - PROP_MINOR);
  });
});

describe('setGroupExcluded (bulk action over the group’s accounts)', () => {
  it('flips every account in the group and reports the count', async () => {
    // 'ledgers' holds lent (12000) and owed (−8000): net 4000 leaves the total.
    // 9346800 − 4000 = 9342800.
    const res = await setGroupExcluded('ledgers', true);
    expect(res).toEqual({ accountsChanged: 2 });
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(9_342_800);
    expect(nw.excludedCount).toBe(2);
    expect(nw.excludedBaseMinor).toBe(4_000);
    // Accounts outside the group are untouched.
    const outside = await db.accounts.where('groupId').equals('ledgers').primaryKeys();
    expect(new Set(outside)).toEqual(new Set(['lent', 'owed']));
    for (const id of ['cur', 'sav', 'eur', 'prop', 'gift']) {
      expect((await db.accounts.get(id))!.excludeFromNetWorth).toBeUndefined();
    }
  });

  it('counts only accounts that actually changed', async () => {
    await setAccountExcluded('lent', true); // one member already excluded
    const res = await setGroupExcluded('ledgers', true);
    expect(res).toEqual({ accountsChanged: 1 }); // only 'owed' moved
    const again = await setGroupExcluded('ledgers', true);
    expect(again).toEqual({ accountsChanged: 0 }); // nothing left to do
  });

  it('un-excludes the whole group the same way (reversible)', async () => {
    await setGroupExcluded('ledgers', true);
    const undo = await setGroupExcluded('ledgers', false);
    expect(undo).toEqual({ accountsChanged: 2 });
    expect((await netWorth()).totalBaseMinor).toBe(TOTAL_ALL_COUNTED);
  });

  it('is a snapshot, not a standing rule: accounts added later are unaffected', async () => {
    await setGroupExcluded('ledgers', true);
    await makeAccount({ id: 'lent2', name: 'Lent to Kim', openingBalanceMinor: 5_000, groupId: 'ledgers' });
    const nw = await netWorth();
    // The new account counts: 9346800 − 4000 + 5000 = 9347800.
    expect(nw.totalBaseMinor).toBe(9_347_800);
    expect(nw.excludedCount).toBe(2);
  });

  it('an empty group reports zero changes', async () => {
    await makeGroup('empty', 'Nothing here');
    expect(await setGroupExcluded('empty', true)).toEqual({ accountsChanged: 0 });
  });

  it('throws ValidationError for an unknown group id', async () => {
    await expect(setGroupExcluded('nope', true)).rejects.toBeInstanceOf(ValidationError);
    expect((await netWorth()).excludedCount).toBe(0);
  });
});

// ------------------------------------------------------------------ backup round-trip

describe('backup', () => {
  it('round-trips the flag (whole rows are stored, so nothing extra to do)', async () => {
    await setAccountExcluded('prop', true);
    await setGroupExcluded('ledgers', true);
    const before = await netWorth();

    const file = await exportBackup();
    await clearAll();
    expect((await netWorth()).totalBaseMinor).toBe(0); // really wiped
    await restoreBackup(file);

    expect(await netWorth()).toEqual(before);
    expect((await db.accounts.get('prop'))!.excludeFromNetWorth).toBe(true);
    expect((await db.accounts.get('lent'))!.excludeFromNetWorth).toBe(true);
    expect((await db.accounts.get('cur'))!.excludeFromNetWorth).toBeUndefined();
  });

  it('a backup written WITHOUT the field restores cleanly, exclusions off', async () => {
    // Simulates a file exported by a build that predates the feature: the
    // account rows have no excludeFromNetWorth key at all.
    await setAccountExcluded('prop', true);
    const file = await exportBackup();
    const legacy: BackupFile = {
      ...file,
      tables: {
        ...file.tables,
        accounts: file.tables.accounts.map((row) => {
          const { excludeFromNetWorth: _drop, ...rest } = row as Account;
          return rest;
        }),
      },
    };
    expect(
      (legacy.tables.accounts as Account[]).every((a) => !('excludeFromNetWorth' in a)),
    ).toBe(true);

    await clearAll();
    await restoreBackup(legacy);

    // Everything counts again, and nothing reads as undefined downstream.
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(TOTAL_ALL_COUNTED);
    expect(nw.excludedCount).toBe(0);
    expect(nw.excludedBaseMinor).toBe(0);
    expect((await accountBalances()).every((b) => b.excludedFromNetWorth === false)).toBe(true);
  });
});

// ------------------------------------------------------------------ non-GBP base

describe('a non-GBP base currency', () => {
  it('excludes at the converted value in that base too', async () => {
    // Base EUR, stored rate 1 EUR = 0.85 GBP ⇒ GBP→EUR = 1/0.85.
    // Excluding prop (9000000 GBP) removes 9000000/0.85 = 10588235.29…
    // → 10588235 (half away from zero), converted ONCE.
    await updateSettings({ baseCurrency: 'EUR' });
    const before = await netWorth();
    await setAccountExcluded('prop', true);
    const after = await netWorth();
    expect(after.baseCurrency).toBe('EUR');
    expect(after.excludedBaseMinor).toBe(10_588_235);
    expect(before.totalBaseMinor - after.totalBaseMinor).toBe(10_588_235);
  });
});
