// SPEC §12 golden test: one realistic month, every number verified against a
// hand calculation written out below. If this file fails, the app is lying to
// the user — fix the engine, never the expectations, unless the arithmetic
// comment itself is wrong.
//
// Scenario (August 2026, base GBP):
//   Accounts: Current (opens £1,000.00), Savings (opens £500.00),
//             Holiday in EUR (opens €200.00). Manual rate 1 EUR = 0.85 GBP.
//   01/08 salary            +£2,500.00  Current   [Salary]        Acme Ltd
//   03/08 groceries            -£45.67  Current   [Groceries]     Tesco
//   10/08 groceries            -£54.33  Current   [Groceries]     Tesco
//   12/08 split               -£100.00  Current                   Big Shop
//                                        └ Groceries -£60.00, Transport -£40.00
//   15/08 refund               +£10.00  Current   [Groceries]     Tesco
//   20/08 transfer   Current → Savings  £200.00   (no category — never spend)
//   22/08 holiday spend        -€20.00  Holiday   [Transport]     Café Paris
//   25/08 PENDING              -£30.00  Current   [Transport]     Uber
//
// Hand calculations (minor units):
//   Current  = 100000 +250000 -4567 -5433 -10000 +1000 -20000 -3000 = 308000
//   Savings  = 50000 +20000                                         =  70000
//   Holiday  = 20000 -2000 = 18000 EUR → ×0.85                      =  15300 GBP
//   Net worth = 308000 + 70000 + 15300                              = 393300
//   Food spend (Groceries ⊂ Food): 4567 +5433 +6000 -1000(refund)   =  15000
//   Transport spend: 4000(split) +1700(€20×0.85) +3000(pending)     =   8700
//   August income = 250000; August expense = 15000 + 8700           =  23700
//   Cash flow net = 250000 - 23700                                  = 226300
//   Payees: Tesco 4567+5433-1000 = 9000 · Big Shop 10000 ·
//           Uber 3000 · Café Paris 1700
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { db, updateSettings } from '../src/db/db';
import { saveCategory } from '../src/domain/categories';
import { saveTransaction, saveTransfer, queryTransactions } from '../src/domain/transactions';
import { accountBalances, netWorth } from '../src/domain/balances';
import { budgetProgress, saveBudget } from '../src/domain/budgets';
import { setManualRate } from '../src/domain/fx';
import {
  cashFlowByMonth,
  incomeVsExpenseByMonth,
  netWorthSeries,
  spendingByCategory,
  spendingByPayee,
} from '../src/reports/aggregate';
import type { Account } from '../src/db/types';

const acc = (over: Partial<Account> & Pick<Account, 'id' | 'name' | 'currency'>): Account => ({
  type: 'current',
  openingBalanceMinor: 0,
  colour: '#2563eb',
  groupId: null,
  sortOrder: 0,
  archived: false,
  ...over,
});

const AUG: { from: string; to: string } = { from: '2026-08-01', to: '2026-08-31' };

let foodId = '';
let transportId = '';

beforeAll(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await updateSettings({ baseCurrency: 'GBP', onboarded: true });
  await db.accounts.bulkAdd([
    acc({ id: 'cur', name: 'Current', currency: 'GBP', openingBalanceMinor: 100_000 }),
    acc({ id: 'sav', name: 'Savings', currency: 'GBP', openingBalanceMinor: 50_000, sortOrder: 1 }),
    acc({ id: 'hol', name: 'Holiday', currency: 'EUR', openingBalanceMinor: 20_000, sortOrder: 2 }),
  ]);
  await setManualRate('EUR', 'GBP', 0.85);

  const food = await saveCategory({ name: 'Food', kind: 'expense' });
  foodId = food.id;
  const groceries = await saveCategory({ name: 'Groceries', kind: 'expense', parentId: food.id });
  const transport = await saveCategory({ name: 'Transport', kind: 'expense' });
  transportId = transport.id;
  const salary = await saveCategory({ name: 'Salary', kind: 'income' });

  await saveTransaction({ accountId: 'cur', date: '2026-08-01', amountMinor: 250_000, categoryId: salary.id, payeeName: 'Acme Ltd' });
  await saveTransaction({ accountId: 'cur', date: '2026-08-03', amountMinor: -4_567, categoryId: groceries.id, payeeName: 'Tesco' });
  await saveTransaction({ accountId: 'cur', date: '2026-08-10', amountMinor: -5_433, categoryId: groceries.id, payeeName: 'Tesco' });
  await saveTransaction({
    accountId: 'cur', date: '2026-08-12', amountMinor: -10_000, payeeName: 'Big Shop',
    splits: [
      { categoryId: groceries.id, amountMinor: -6_000 },
      { categoryId: transport.id, amountMinor: -4_000 },
    ],
  });
  // refund: POSITIVE amount in an EXPENSE category (D14)
  await saveTransaction({ accountId: 'cur', date: '2026-08-15', amountMinor: 1_000, categoryId: groceries.id, payeeName: 'Tesco' });
  await saveTransfer({ fromAccountId: 'cur', toAccountId: 'sav', date: '2026-08-20', amountFromMinor: 20_000, amountToMinor: 20_000 });
  await saveTransaction({ accountId: 'hol', date: '2026-08-22', amountMinor: -2_000, categoryId: transport.id, payeeName: 'Café Paris' });
  await saveTransaction({ accountId: 'cur', date: '2026-08-25', amountMinor: -3_000, categoryId: transport.id, payeeName: 'Uber', status: 'pending' });
});

describe('golden month — balances & net worth', () => {
  it('account balances match the hand calculation', async () => {
    const byId = new Map((await accountBalances()).map((b) => [b.account.id, b]));
    expect(byId.get('cur')!.balanceMinor).toBe(308_000);
    expect(byId.get('sav')!.balanceMinor).toBe(70_000);
    expect(byId.get('hol')!.balanceMinor).toBe(18_000); // €180.00, own currency
    // cleared balance excludes the £30.00 pending: 308000 + 3000
    expect(byId.get('cur')!.clearedMinor).toBe(311_000);
  });
  it('net worth converts EUR at 0.85 and totals £3,933.00', async () => {
    const nw = await netWorth();
    expect(nw.totalBaseMinor).toBe(393_300);
    expect(nw.missingRateCurrencies).toEqual([]);
  });
  it('net worth series ends August at the same figure', async () => {
    const { points, missingRateCurrencies } = await netWorthSeries(AUG);
    expect(missingRateCurrencies).toEqual([]);
    expect(points[points.length - 1]).toEqual({ date: '2026-08-31', totalBaseMinor: 393_300 });
  });
});

describe('golden month — budgets', () => {
  it('Food budget (£150, incl. subcategories) lands exactly at its limit', async () => {
    const b = await saveBudget({ name: 'Food', categoryIds: [foodId], amountMinor: 15_000, period: 'monthly', startDate: '2026-08-01' });
    const p = await budgetProgress(b, '2026-08-15');
    expect(p.window).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(p.spentMinor).toBe(15_000); // 4567+5433+6000-1000
    expect(p.remainingMinor).toBe(0);
    expect(p.over).toBe(false); // exactly at the limit is not over
    expect(p.missingRateCount).toBe(0);
  });
  it('Transport budget counts the split part, the converted EUR spend and the pending tx', async () => {
    const b = await saveBudget({ name: 'Transport', categoryIds: [transportId], amountMinor: 10_000, period: 'monthly', startDate: '2026-08-01' });
    const p = await budgetProgress(b, '2026-08-15');
    expect(p.spentMinor).toBe(8_700); // 4000 + 1700 + 3000
    expect(p.remainingMinor).toBe(1_300);
    expect(p.over).toBe(false);
  });
});

describe('golden month — reports', () => {
  it('spending by category (top level): Food £150.00, Transport £87.00', async () => {
    const { rows, totalMinor, missingRateCount } = await spendingByCategory(AUG, null);
    const byName = new Map(rows.map((r) => [r.name, r.spentMinor]));
    expect(byName.get('Food')).toBe(15_000);
    expect(byName.get('Transport')).toBe(8_700);
    expect(totalMinor).toBe(23_700);
    expect(missingRateCount).toBe(0);
    expect(rows.find((r) => r.name === 'Food')?.hasChildren).toBe(true);
  });
  it('income vs expense for August: £2,500.00 in, £237.00 out; transfer invisible', async () => {
    const { rows } = await incomeVsExpenseByMonth(AUG);
    expect(rows).toEqual([{ month: '2026-08', incomeMinor: 250_000, expenseMinor: 23_700 }]);
  });
  it('cash flow: net +£2,263.00, cumulative equals net in a one-month range', async () => {
    const { rows } = await cashFlowByMonth(AUG);
    expect(rows).toEqual([{ month: '2026-08', netMinor: 226_300, cumulativeMinor: 226_300 }]);
  });
  it('spending by payee nets Tesco refunds and attributes split spend to Big Shop', async () => {
    const { rows } = await spendingByPayee(AUG);
    const byName = new Map(rows.map((r) => [r.name, r.spentMinor]));
    expect(byName.get('Tesco')).toBe(9_000); // 4567+5433-1000
    expect(byName.get('Big Shop')).toBe(10_000);
    expect(byName.get('Uber')).toBe(3_000);
    expect(byName.get('Café Paris')).toBe(1_700); // converted once
  });
});

describe('golden month — register queries', () => {
  it('filtering by the Food parent includes subcategory and split transactions', async () => {
    const txs = await queryTransactions({ categoryIds: [foodId], dateFrom: AUG.from, dateTo: AUG.to });
    // 03/08, 10/08, 12/08 (split touches Groceries), 15/08 refund
    expect(txs.map((t) => t.date).sort()).toEqual(['2026-08-03', '2026-08-10', '2026-08-12', '2026-08-15']);
  });
  it('text search finds by payee name', async () => {
    const txs = await queryTransactions({ text: 'tesco' });
    expect(txs).toHaveLength(3);
  });
});
