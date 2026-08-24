// Report aggregation engine tests (SPEC §8.1.8, §10) — every expectation is
// hand-calculated; the arithmetic is written out in comments next to each
// assertion block.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, defaultSettings } from '../src/db/db';
import { setManualRate } from '../src/domain/fx';
import { makeDedupeHash } from '../src/import/dedupe';
import {
  cashFlowByMonth,
  incomeVsExpenseByMonth,
  netWorthSeries,
  spendingByCategory,
  spendingByPayee,
  spendingByTag,
  type DateRange,
} from '../src/reports/aggregate';
import type { Account, Category, Payee, Tag, Transaction } from '../src/db/types';

// ---------------------------------------------------------------- fixture

const acc = (
  id: string,
  name: string,
  currency: string,
  openingBalanceMinor: number,
  archived = false,
): Account => ({
  id,
  name,
  type: 'current',
  currency,
  openingBalanceMinor,
  colour: '#336699',
  groupId: null,
  sortOrder: 0,
  archived,
});

const cat = (
  id: string,
  name: string,
  kind: 'income' | 'expense',
  parentId: string | null = null,
  colour?: string,
): Category => ({ id, name, parentId, kind, colour, archived: false, sortOrder: 0 });

const payee = (id: string, name: string): Payee => ({
  id,
  name,
  nameLower: name.toLowerCase(),
  defaultCategoryId: null,
});

const tag = (id: string, name: string): Tag => ({ id, name, nameLower: name.toLowerCase() });

const tx = (
  over: Pick<Transaction, 'id' | 'accountId' | 'date' | 'amountMinor' | 'currency'> &
    Partial<Transaction>,
): Transaction => ({
  payeeId: null,
  categoryId: null,
  tagIds: [],
  notes: '',
  status: 'cleared',
  splits: [],
  transferGroupId: null,
  importBatchId: null,
  dedupeHash: makeDedupeHash(over.accountId, over.date, over.amountMinor, over.id),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

// Base currency GBP. Manual rate: 1 EUR = 0.85 GBP. CHF has NO rate.
//
// Accounts (opening balances in minor units):
//   a1 Current  GBP 100000          a2 Savings GBP 500000
//   a3 Euro     EUR  20000          a4 Swiss   CHF  30000  (no rate)
//   a5 Old      GBP 999999  ARCHIVED (must never appear in net worth)
//
// Categories: Salary (income root); Food (expense root, colour #cc0000) with
// children Groceries + Dining; Travel (expense root, childless).
//
// Transactions (chronological):
//   pre        a1 2025-12-15  -20000 GBP Groceries Tesco       (before range)
//   archTx     a5 2025-11-01  -50000 GBP Dining               (archived acct)
//   salary     a1 2026-01-01 +250000 GBP Salary    Acme  [work]  (= range.from)
//   groc       a1 2026-01-05  -12000 GBP Groceries Tesco
//   split      a1 2026-01-10   -9000 GBP splits{Groc -6000, Dining -3000}
//                                        Tesco [holiday]
//   tfr1out/in a1→a2 2026-01-15 ∓30000 GBP transfer tg1 (same-ccy: cancels)
//   refund     a1 2026-01-20   +2000 GBP Groceries Tesco   (refund, D14)
//   tfr2out/in a1→a3 2026-01-25 -9000 GBP / +10000 EUR transfer tg2
//              (cross-ccy, both amounts explicit; at the 0.85 display rate the
//               EUR leg is worth 8500, so base net worth shifts by -500)
//   dining     a1 2026-03-05   -4500 GBP Dining    Pizza [work]
//   eur        a3 2026-03-10   -2000 EUR Travel    Airline [holiday]
//              → -2000 × 0.85 = -1700 GBP minor
//   chf        a4 2026-03-12   -5000 CHF Travel    Airline [holiday]
//              → NO rate: excluded + counted
//   uncatNeg   a1 2026-03-15   -2500 GBP uncategorised, no payee
//   uncatPos   a2 2026-03-20   +1500 GBP uncategorised, no payee (income side)
//   foodDirect a1 2026-03-25    -800 GBP Food (directly on the parent)
//   pending    a1 2026-03-31   -1000 GBP Groceries Tesco, status PENDING
//                                        (= range.to; counts per D15)
//   post       a1 2026-04-02   -7000 GBP Groceries Tesco       (after range)
//
// February 2026 has NO transactions at all — the zero-fill month.

const RANGE: DateRange = { from: '2026-01-01', to: '2026-03-31' };

async function seed(): Promise<void> {
  await db.settings.put({ ...defaultSettings(), baseCurrency: 'GBP' });
  await db.accounts.bulkAdd([
    acc('a1', 'Current', 'GBP', 100000),
    acc('a2', 'Savings', 'GBP', 500000),
    acc('a3', 'Euro', 'EUR', 20000),
    acc('a4', 'Swiss', 'CHF', 30000),
    acc('a5', 'Old', 'GBP', 999999, true),
  ]);
  await db.categories.bulkAdd([
    cat('cSalary', 'Salary', 'income'),
    cat('cFood', 'Food', 'expense', null, '#cc0000'),
    cat('cGroc', 'Groceries', 'expense', 'cFood'),
    cat('cDining', 'Dining', 'expense', 'cFood'),
    cat('cTravel', 'Travel', 'expense'),
  ]);
  await db.payees.bulkAdd([
    payee('pAcme', 'Acme Corp'),
    payee('pTesco', 'Tesco'),
    payee('pPizza', 'Pizza Place'),
    payee('pAir', 'Airline'),
  ]);
  await db.tags.bulkAdd([tag('tHoliday', 'holiday'), tag('tWork', 'work')]);
  await setManualRate('EUR', 'GBP', 0.85); // no CHF rate on purpose
  await db.transactions.bulkAdd([
    tx({ id: 'pre', accountId: 'a1', date: '2025-12-15', amountMinor: -20000, currency: 'GBP', categoryId: 'cGroc', payeeId: 'pTesco' }),
    tx({ id: 'archTx', accountId: 'a5', date: '2025-11-01', amountMinor: -50000, currency: 'GBP', categoryId: 'cDining' }),
    tx({ id: 'salary', accountId: 'a1', date: '2026-01-01', amountMinor: 250000, currency: 'GBP', categoryId: 'cSalary', payeeId: 'pAcme', tagIds: ['tWork'] }),
    tx({ id: 'groc', accountId: 'a1', date: '2026-01-05', amountMinor: -12000, currency: 'GBP', categoryId: 'cGroc', payeeId: 'pTesco' }),
    tx({
      id: 'split', accountId: 'a1', date: '2026-01-10', amountMinor: -9000, currency: 'GBP',
      payeeId: 'pTesco', tagIds: ['tHoliday'],
      splits: [
        { categoryId: 'cGroc', amountMinor: -6000 },
        { categoryId: 'cDining', amountMinor: -3000 },
      ],
    }),
    tx({ id: 'tfr1out', accountId: 'a1', date: '2026-01-15', amountMinor: -30000, currency: 'GBP', transferGroupId: 'tg1' }),
    tx({ id: 'tfr1in', accountId: 'a2', date: '2026-01-15', amountMinor: 30000, currency: 'GBP', transferGroupId: 'tg1' }),
    tx({ id: 'refund', accountId: 'a1', date: '2026-01-20', amountMinor: 2000, currency: 'GBP', categoryId: 'cGroc', payeeId: 'pTesco' }),
    tx({ id: 'tfr2out', accountId: 'a1', date: '2026-01-25', amountMinor: -9000, currency: 'GBP', transferGroupId: 'tg2' }),
    tx({ id: 'tfr2in', accountId: 'a3', date: '2026-01-25', amountMinor: 10000, currency: 'EUR', transferGroupId: 'tg2' }),
    tx({ id: 'dining', accountId: 'a1', date: '2026-03-05', amountMinor: -4500, currency: 'GBP', categoryId: 'cDining', payeeId: 'pPizza', tagIds: ['tWork'] }),
    tx({ id: 'eur', accountId: 'a3', date: '2026-03-10', amountMinor: -2000, currency: 'EUR', categoryId: 'cTravel', payeeId: 'pAir', tagIds: ['tHoliday'] }),
    tx({ id: 'chf', accountId: 'a4', date: '2026-03-12', amountMinor: -5000, currency: 'CHF', categoryId: 'cTravel', payeeId: 'pAir', tagIds: ['tHoliday'] }),
    tx({ id: 'uncatNeg', accountId: 'a1', date: '2026-03-15', amountMinor: -2500, currency: 'GBP' }),
    tx({ id: 'uncatPos', accountId: 'a2', date: '2026-03-20', amountMinor: 1500, currency: 'GBP' }),
    tx({ id: 'foodDirect', accountId: 'a1', date: '2026-03-25', amountMinor: -800, currency: 'GBP', categoryId: 'cFood' }),
    tx({ id: 'pending', accountId: 'a1', date: '2026-03-31', amountMinor: -1000, currency: 'GBP', categoryId: 'cGroc', payeeId: 'pTesco', status: 'pending' }),
    tx({ id: 'post', accountId: 'a1', date: '2026-04-02', amountMinor: -7000, currency: 'GBP', categoryId: 'cGroc', payeeId: 'pTesco' }),
  ]);
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await seed();
});

// ---------------------------------------------------------------- net worth

describe('netWorthSeries', () => {
  it('cumulative month-end samples, converted per currency, CHF excluded once', async () => {
    // GBP opening: a1 100000 + a2 500000 = 600000 (a5 is archived → excluded).
    // Everything dated ≤ 2026-01-31 on non-archived GBP accounts:
    //   600000 - 20000 (pre) + 250000 (salary) - 12000 (groc) - 9000 (split)
    //   - 30000 (tfr1out) + 30000 (tfr1in) + 2000 (refund) - 9000 (tfr2out)
    //   = 802000
    // EUR: opening 20000 + 10000 (tfr2in) = 30000 → 30000 × 0.85 = 25500 GBP.
    // Point 2026-01-31 = 802000 + 25500 = 827500.
    // February has no transactions → 2026-02-28 identical: 827500.
    // March adds (GBP): -4500 (dining) - 2500 (uncatNeg) + 1500 (uncatPos)
    //   - 800 (foodDirect) - 1000 (pending, PENDING counts per D15)
    //   → 802000 - 7300 = 794700
    // EUR: 30000 - 2000 (eur) = 28000 → 28000 × 0.85 = 23800.
    // Point 2026-03-31 = 794700 + 23800 = 818500.
    // CHF (a4, opening 30000 + chf tx) has no rate → excluded from every
    // point and listed once. 'post' (2026-04-02) is beyond every sample.
    const res = await netWorthSeries(RANGE);
    expect(res.points).toEqual([
      { date: '2026-01-31', totalBaseMinor: 827500 },
      { date: '2026-02-28', totalBaseMinor: 827500 },
      { date: '2026-03-31', totalBaseMinor: 818500 },
    ]);
    expect(res.missingRateCurrencies).toEqual(['CHF']);
  });

  it('range end that is not a month-end becomes the last sample point', async () => {
    // Samples: 2026-01-31, 2026-02-28, then the raw range end 2026-03-15.
    // ≤ 03-15 the March activity is dining (03-05), eur (03-10) and uncatNeg
    // (03-15 — ON the sample date, inclusive):
    //   GBP 802000 - 4500 - 2500 = 795000
    //   EUR 30000 - 2000 = 28000 → 23800
    //   total = 795000 + 23800 = 818800
    const res = await netWorthSeries({ from: '2026-01-01', to: '2026-03-15' });
    expect(res.points.map((p) => p.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-15']);
    expect(res.points[2].totalBaseMinor).toBe(818800);
  });

  it('cross-currency transfer legs are both real balance changes', async () => {
    // tfr2: -9000 GBP out, +10000 EUR in. At the display rate the EUR leg is
    // 10000 × 0.85 = 8500, so the pair shifts base net worth by
    // -9000 + 8500 = -500 (both legs explicit, never derived — SPEC §5).
    // If transfers were wrongly skipped in net worth, 2026-01-31 would be
    // 827500 + 500 = 828000 instead. (Checked via the exact totals above;
    // here we re-assert the point right after the transfer date.)
    const res = await netWorthSeries({ from: '2026-01-25', to: '2026-01-25' });
    // ≤ 01-25: GBP 802000; EUR 30000 → 25500 ⇒ 827500.
    expect(res.points).toEqual([{ date: '2026-01-25', totalBaseMinor: 827500 }]);
  });
});

// ---------------------------------------------------------------- by category

describe('spendingByCategory', () => {
  it('top level: subtree rollup, Uncategorised bucket, refund netting, sorted desc', async () => {
    // Food subtree (Groceries + Dining + Food itself):
    //   groc 12000 + split.Groc 6000 + split.Dining 3000 - refund 2000
    //   + dining 4500 + pending 1000 + foodDirect 800 = 25300
    // Uncategorised: uncatNeg 2500 (uncatPos is income-signed → excluded).
    // Travel: eur -2000 EUR × 0.85 = -1700 → 1700 spend. chf: no rate →
    // excluded, missingRateCount 1.
    // Transfers skipped; Salary is income-kind → never a spending row.
    // Sorted desc: Food 25300, Uncategorised 2500, Travel 1700.
    // total = 25300 + 2500 + 1700 = 29500.
    const res = await spendingByCategory(RANGE, null);
    expect(res.rows).toEqual([
      { categoryId: 'cFood', name: 'Food', colour: '#cc0000', spentMinor: 25300, hasChildren: true },
      { categoryId: null, name: 'Uncategorised', spentMinor: 2500, hasChildren: false },
      { categoryId: 'cTravel', name: 'Travel', colour: undefined, spentMinor: 1700, hasChildren: false },
    ]);
    expect(res.totalMinor).toBe(29500);
    expect(res.missingRateCount).toBe(1);
  });

  it('drill into Food: direct children + a row for the parent itself', async () => {
    // Groceries subtree: groc 12000 + split.Groc 6000 - refund 2000
    //   + pending 1000 = 17000
    // Dining subtree: split.Dining 3000 + dining 4500 = 7500
    // Directly on Food: foodDirect 800 → own row, categoryId = cFood,
    //   name = the category's own name, hasChildren false.
    // total = 17000 + 7500 + 800 = 25300 (matches the top-level Food row).
    const res = await spendingByCategory(RANGE, 'cFood');
    expect(res.rows).toEqual([
      { categoryId: 'cGroc', name: 'Groceries', colour: undefined, spentMinor: 17000, hasChildren: false },
      { categoryId: 'cDining', name: 'Dining', colour: undefined, spentMinor: 7500, hasChildren: false },
      { categoryId: 'cFood', name: 'Food', colour: '#cc0000', spentMinor: 800, hasChildren: false },
    ]);
    expect(res.totalMinor).toBe(25300);
    expect(res.missingRateCount).toBe(1);
  });

  it('converts each contribution once, rounding half away from zero', async () => {
    // Fresh minimal dataset to pin the rounding rule.
    await Promise.all(db.tables.map((t) => t.clear()));
    await db.settings.put({ ...defaultSettings(), baseCurrency: 'GBP' });
    await db.accounts.add(acc('aE', 'Euro', 'EUR', 0));
    await db.categories.bulkAdd([cat('cX', 'X', 'expense'), cat('cY', 'Y', 'expense')]);
    await setManualRate('EUR', 'GBP', 0.85);
    await db.transactions.bulkAdd([
      // -1110 × 0.85 = -943.5 → half away from zero → -944 (spend 944)
      tx({ id: 'r1', accountId: 'aE', date: '2026-01-10', amountMinor: -1110, currency: 'EUR', categoryId: 'cX' }),
      // split converts PER CONTRIBUTION:
      //   -501 × 0.85 = -425.85 → -426 (X);  -500 × 0.85 = -425 (Y)
      tx({
        id: 'r2', accountId: 'aE', date: '2026-01-11', amountMinor: -1001, currency: 'EUR',
        splits: [
          { categoryId: 'cX', amountMinor: -501 },
          { categoryId: 'cY', amountMinor: -500 },
        ],
      }),
    ]);
    const res = await spendingByCategory({ from: '2026-01-01', to: '2026-01-31' }, null);
    // X: 944 + 426 = 1370; Y: 425; total 1795.
    expect(res.rows).toEqual([
      { categoryId: 'cX', name: 'X', colour: undefined, spentMinor: 1370, hasChildren: false },
      { categoryId: 'cY', name: 'Y', colour: undefined, spentMinor: 425, hasChildren: false },
    ]);
    expect(res.totalMinor).toBe(1795);
    expect(res.missingRateCount).toBe(0);
  });
});

// ------------------------------------------------------- income vs expense

describe('incomeVsExpenseByMonth', () => {
  it('classifies by category kind / sign, zero-fills the empty middle month', async () => {
    // 2026-01: income = salary 250000 (income-kind category).
    //          expense = groc 12000 + split 6000+3000 - refund 2000 = 19000
    //          (refund is a positive amount in an expense category → nets
    //          within the expense side, D14). Transfers excluded (D13).
    // 2026-02: no transactions → zero-filled row must still exist.
    // 2026-03: income = uncatPos 1500 (uncategorised, positive → by sign).
    //          expense = dining 4500 + eur 1700 + uncatNeg 2500
    //                  + foodDirect 800 + pending 1000 = 10500.
    //          chf → missingRateCount 1.
    const res = await incomeVsExpenseByMonth(RANGE);
    expect(res.rows).toEqual([
      { month: '2026-01', incomeMinor: 250000, expenseMinor: 19000 },
      { month: '2026-02', incomeMinor: 0, expenseMinor: 0 },
      { month: '2026-03', incomeMinor: 1500, expenseMinor: 10500 },
    ]);
    expect(res.missingRateCount).toBe(1);
  });

  it('inclusive boundaries: a transaction exactly on `from` counts', async () => {
    // Only salary (2026-01-01) is on the single-day range.
    const res = await incomeVsExpenseByMonth({ from: '2026-01-01', to: '2026-01-01' });
    expect(res.rows).toEqual([{ month: '2026-01', incomeMinor: 250000, expenseMinor: 0 }]);
    expect(res.missingRateCount).toBe(0);
  });

  it('a `from` one day later excludes the boundary transaction', async () => {
    // 2026-01-02..2026-01-31: salary now excluded; expense unchanged:
    // 12000 + 9000 - 2000 = 19000.
    const res = await incomeVsExpenseByMonth({ from: '2026-01-02', to: '2026-01-31' });
    expect(res.rows).toEqual([{ month: '2026-01', incomeMinor: 0, expenseMinor: 19000 }]);
  });
});

// ---------------------------------------------------------------- cash flow

describe('cashFlowByMonth', () => {
  it('net per month with a cumulative running across the range only', async () => {
    // Jan net = 250000 - 19000 = 231000; cumulative 231000.
    // Feb net = 0; cumulative stays 231000.
    // Mar net = 1500 - 10500 = -9000; cumulative 231000 - 9000 = 222000.
    const res = await cashFlowByMonth(RANGE);
    expect(res.rows).toEqual([
      { month: '2026-01', netMinor: 231000, cumulativeMinor: 231000 },
      { month: '2026-02', netMinor: 0, cumulativeMinor: 231000 },
      { month: '2026-03', netMinor: -9000, cumulativeMinor: 222000 },
    ]);
    expect(res.missingRateCount).toBe(1);
  });
});

// ---------------------------------------------------------------- by payee

describe('spendingByPayee', () => {
  it('nets refunds, buckets missing payee, counts distinct transactions', async () => {
    // Tesco: groc 12000 + split 9000 (both splits, one tx) - refund 2000
    //        + pending 1000 = 20000; txCount = groc, split, refund, pending = 4.
    // Pizza Place: dining 4500, txCount 1.
    // No payee: uncatNeg 2500 + foodDirect 800 = 3300, txCount 2
    //           (transfer legs also have no payee but are excluded, D13;
    //            uncatPos is income-side → excluded).
    // Airline: eur 1700, txCount 1 (chf has no rate → excluded + counted).
    // Acme is income-only → no row. Sorted desc.
    const res = await spendingByPayee(RANGE);
    expect(res.rows).toEqual([
      { payeeId: 'pTesco', name: 'Tesco', spentMinor: 20000, txCount: 4 },
      { payeeId: 'pPizza', name: 'Pizza Place', spentMinor: 4500, txCount: 1 },
      { payeeId: null, name: 'No payee', spentMinor: 3300, txCount: 2 },
      { payeeId: 'pAir', name: 'Airline', spentMinor: 1700, txCount: 1 },
    ]);
    expect(res.missingRateCount).toBe(1);
  });

  it('limit keeps the top N rows', async () => {
    const res = await spendingByPayee(RANGE, 2);
    expect(res.rows.map((r) => r.name)).toEqual(['Tesco', 'Pizza Place']);
  });
});

// ---------------------------------------------------------------- by tag

describe('spendingByTag', () => {
  it('groups by each tag; split tx counts once; income-side tags excluded', async () => {
    // holiday: split contributions 6000 + 3000 = 9000 (ONE distinct tx)
    //          + eur 1700 = 10700; txCount 2 (split, eur — chf excluded).
    // work: dining 4500, txCount 1 (salary carries [work] but is income-side
    //       → contributes nothing to spending).
    const res = await spendingByTag(RANGE);
    expect(res.rows).toEqual([
      { tagId: 'tHoliday', name: 'holiday', spentMinor: 10700, txCount: 2 },
      { tagId: 'tWork', name: 'work', spentMinor: 4500, txCount: 1 },
    ]);
    expect(res.missingRateCount).toBe(1);
  });
});

// -------------------------------------------------- empty month / edge cases

describe('empty ranges and edges', () => {
  it('a range covering only the empty month yields zero-filled/empty results', async () => {
    const feb: DateRange = { from: '2026-02-01', to: '2026-02-28' };
    expect((await incomeVsExpenseByMonth(feb)).rows).toEqual([
      { month: '2026-02', incomeMinor: 0, expenseMinor: 0 },
    ]);
    expect((await cashFlowByMonth(feb)).rows).toEqual([
      { month: '2026-02', netMinor: 0, cumulativeMinor: 0 },
    ]);
    const byCat = await spendingByCategory(feb, null);
    expect(byCat.rows).toEqual([]);
    expect(byCat.totalMinor).toBe(0);
    expect(byCat.missingRateCount).toBe(0); // chf is outside this range
    expect((await spendingByPayee(feb)).rows).toEqual([]);
    expect((await spendingByTag(feb)).rows).toEqual([]);
    // Net worth is still cumulative history at the Feb month-end: 827500
    // (identical arithmetic to the Jan-end point — nothing happened in Feb).
    const nw = await netWorthSeries(feb);
    expect(nw.points).toEqual([{ date: '2026-02-28', totalBaseMinor: 827500 }]);
    expect(nw.missingRateCurrencies).toEqual(['CHF']);
  });

  it('a pending transaction exactly on `to` counts (inclusive + D15)', async () => {
    // Single-day range 2026-03-31: only `pending` (-1000, Groceries) is in
    // range; it rolls up to its top-level parent Food.
    const res = await spendingByCategory({ from: '2026-03-31', to: '2026-03-31' }, null);
    expect(res.rows).toEqual([
      { categoryId: 'cFood', name: 'Food', colour: '#cc0000', spentMinor: 1000, hasChildren: true },
    ]);
    expect(res.totalMinor).toBe(1000);
    expect(res.missingRateCount).toBe(0);
  });
});
