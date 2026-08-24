// Budget domain tests (SPEC §8.1.6, §10 "budget period maths"), with
// hand-calculated expected values in comments.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, defaultSettings } from '../src/db/db';
import type { Budget, Category, Transaction } from '../src/db/types';
import { nowISO, todayISO, uid } from '../src/lib/util';
import { makeDedupeHash } from '../src/import/dedupe';
import { setManualRate } from '../src/domain/fx';
import { ValidationError } from '../src/domain/transactions';
import {
  allBudgetProgress,
  budgetProgress,
  deleteBudget,
  saveBudget,
  shiftWindow,
  windowContaining,
  type PeriodWindow,
} from '../src/domain/budgets';

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

// ------------------------------------------------------------- test builders

const cat = (id: string, parentId: string | null = null): Category => ({
  id,
  name: id,
  parentId,
  kind: 'expense',
  archived: false,
  sortOrder: 0,
});

/** Full Transaction record with sensible defaults, inserted straight into db. */
const tx = (
  partial: Partial<Transaction> & Pick<Transaction, 'date' | 'amountMinor'>,
): Transaction => {
  const accountId = partial.accountId ?? 'acc1';
  return {
    id: uid(),
    accountId,
    currency: 'GBP',
    payeeId: null,
    categoryId: null,
    tagIds: [],
    notes: '',
    status: 'cleared',
    splits: [],
    transferGroupId: null,
    importBatchId: null,
    dedupeHash: makeDedupeHash(accountId, partial.date, partial.amountMinor, partial.notes ?? ''),
    createdAt: nowISO(),
    updatedAt: nowISO(),
    ...partial,
  };
};

const mkBudget = (over: Partial<Budget> = {}): Budget => ({
  id: uid(),
  name: 'Food',
  categoryIds: ['food'],
  amountMinor: 50000, // £500.00
  period: 'monthly',
  startDate: '2025-03-01',
  rollover: false,
  archived: false,
  ...over,
});

// Category tree used by the progress tests:
//   food ─┬─ groceries
//         └─ dining ── coffee     (grandchild — descendants are recursive)
//   travel                        (separate root, NOT in the food budget)
const seedCategories = () =>
  db.categories.bulkAdd([
    cat('food'),
    cat('groceries', 'food'),
    cat('dining', 'food'),
    cat('coffee', 'dining'),
    cat('travel'),
  ]);

// ===========================================================================
// windowContaining — pure period maths
// ===========================================================================

describe('windowContaining — weekly', () => {
  const b = { period: 'weekly', startDate: '2025-01-06' } as const; // a Monday

  it('first window covers startDate through startDate+6, boundaries inclusive', () => {
    const w0: PeriodWindow = { start: '2025-01-06', end: '2025-01-12' };
    expect(windowContaining(b, '2025-01-06')).toEqual(w0); // exactly on start
    expect(windowContaining(b, '2025-01-09')).toEqual(w0); // middle
    expect(windowContaining(b, '2025-01-12')).toEqual(w0); // exactly on end
  });

  it('day after a window end starts the next window', () => {
    expect(windowContaining(b, '2025-01-13')).toEqual({ start: '2025-01-13', end: '2025-01-19' });
  });

  it('crosses a month boundary as a plain 7-day window', () => {
    // start 2025-01-06 + 3*7 days = 2025-01-27; +6 = 2025-02-02
    const w3: PeriodWindow = { start: '2025-01-27', end: '2025-02-02' };
    expect(windowContaining(b, '2025-01-27')).toEqual(w3);
    expect(windowContaining(b, '2025-01-31')).toEqual(w3);
    expect(windowContaining(b, '2025-02-01')).toEqual(w3);
    expect(windowContaining(b, '2025-02-02')).toEqual(w3);
    expect(windowContaining(b, '2025-02-03')).toEqual({ start: '2025-02-03', end: '2025-02-09' });
  });

  it('dates before startDate fall in negative windows', () => {
    // window -1 = [2024-12-30, 2025-01-05], window -2 = [2024-12-23, 2024-12-29]
    expect(windowContaining(b, '2025-01-05')).toEqual({ start: '2024-12-30', end: '2025-01-05' });
    expect(windowContaining(b, '2024-12-30')).toEqual({ start: '2024-12-30', end: '2025-01-05' });
    expect(windowContaining(b, '2024-12-29')).toEqual({ start: '2024-12-23', end: '2024-12-29' });
  });

  it('far-away date: window still aligned to the 7-day grid and contains it', () => {
    const w = windowContaining(b, '2027-06-15');
    // grid alignment: whole days from anchor to window start divide by 7
    const days =
      (Date.parse(`${w.start}T00:00:00Z`) - Date.parse('2025-01-06T00:00:00Z')) / 86_400_000;
    expect(days % 7).toBe(0);
    expect(w.start <= '2027-06-15' && '2027-06-15' <= w.end).toBe(true);
    // 7-day span: end - start = 6 days
    expect(
      (Date.parse(`${w.end}T00:00:00Z`) - Date.parse(`${w.start}T00:00:00Z`)) / 86_400_000,
    ).toBe(6);
  });
});

describe('windowContaining — monthly anchored on the 31st', () => {
  it('leap year (2024): Feb window ends 28th, next starts 29th', () => {
    const b = { period: 'monthly', startDate: '2024-01-31' } as const;
    // window 0 = [2024-01-31, 2024-01-31+1mo=2024-02-29 (clamped) minus 1d = 2024-02-28]
    const w0: PeriodWindow = { start: '2024-01-31', end: '2024-02-28' };
    expect(windowContaining(b, '2024-01-31')).toEqual(w0);
    expect(windowContaining(b, '2024-02-01')).toEqual(w0);
    expect(windowContaining(b, '2024-02-28')).toEqual(w0);
    // window 1 = [2024-02-29, 2024-03-31 minus 1d = 2024-03-30]
    const w1: PeriodWindow = { start: '2024-02-29', end: '2024-03-30' };
    expect(windowContaining(b, '2024-02-29')).toEqual(w1);
    expect(windowContaining(b, '2024-03-30')).toEqual(w1);
    // window 2 = [2024-03-31, 2024-04-30 minus 1d = 2024-04-29]
    expect(windowContaining(b, '2024-03-31')).toEqual({ start: '2024-03-31', end: '2024-04-29' });
  });

  it('non-leap year (2023): Feb window ends 27th, next starts 28th', () => {
    const b = { period: 'monthly', startDate: '2023-01-31' } as const;
    // window 0 = [2023-01-31, 2023-01-31+1mo=2023-02-28 (clamped) minus 1d = 2023-02-27]
    const w0: PeriodWindow = { start: '2023-01-31', end: '2023-02-27' };
    expect(windowContaining(b, '2023-02-27')).toEqual(w0);
    // window 1 = [2023-02-28, 2023-03-31 minus 1d = 2023-03-30]
    expect(windowContaining(b, '2023-02-28')).toEqual({ start: '2023-02-28', end: '2023-03-30' });
  });

  it('dates before startDate: negative windows, clamping still per-anchor', () => {
    const b = { period: 'monthly', startDate: '2024-03-31' } as const;
    // window -1 = [2024-03-31 -1mo = 2024-02-29 (clamped), 2024-03-31 minus 1d = 2024-03-30]
    expect(windowContaining(b, '2024-02-29')).toEqual({ start: '2024-02-29', end: '2024-03-30' });
    expect(windowContaining(b, '2024-03-30')).toEqual({ start: '2024-02-29', end: '2024-03-30' });
    // window -2 = [2024-03-31 -2mo = 2024-01-31, 2024-02-29 minus 1d = 2024-02-28]
    expect(windowContaining(b, '2024-02-28')).toEqual({ start: '2024-01-31', end: '2024-02-28' });
  });

  it('far future: 2030 (non-leap) February window from a 2024 anchor', () => {
    const b = { period: 'monthly', startDate: '2024-01-31' } as const;
    // window 72 = [2024-01-31 +72mo = 2030-01-31, +73mo = 2030-02-28 (clamped) minus 1d = 2030-02-27]
    expect(windowContaining(b, '2030-02-14')).toEqual({ start: '2030-01-31', end: '2030-02-27' });
    // window 73 = [2030-02-28, 2030-03-31 minus 1d = 2030-03-30]
    expect(windowContaining(b, '2030-02-28')).toEqual({ start: '2030-02-28', end: '2030-03-30' });
  });
});

describe('windowContaining — yearly anchored on 29 Feb', () => {
  const b = { period: 'yearly', startDate: '2024-02-29' } as const;

  it('window 0 = [2024-02-29, 2025-02-27]', () => {
    // 2024-02-29 +1y = 2025-02-28 (clamped), minus 1d = 2025-02-27
    const w0: PeriodWindow = { start: '2024-02-29', end: '2025-02-27' };
    expect(windowContaining(b, '2024-02-29')).toEqual(w0);
    expect(windowContaining(b, '2024-12-31')).toEqual(w0);
    expect(windowContaining(b, '2025-02-27')).toEqual(w0);
  });

  it('window 1 = [2025-02-28, 2026-02-27]', () => {
    expect(windowContaining(b, '2025-02-28')).toEqual({ start: '2025-02-28', end: '2026-02-27' });
  });

  it('next leap year: window 3 ends 2028-02-28, window 4 starts 2028-02-29', () => {
    // window 3 = [2024-02-29 +3y = 2027-02-28 (clamped), +4y = 2028-02-29 minus 1d = 2028-02-28]
    expect(windowContaining(b, '2028-02-28')).toEqual({ start: '2027-02-28', end: '2028-02-28' });
    // window 4 = [2028-02-29, +5y = 2029-02-28 minus 1d = 2029-02-27]
    expect(windowContaining(b, '2028-02-29')).toEqual({ start: '2028-02-29', end: '2029-02-27' });
  });

  it('date before startDate: window -1 = [2023-02-28, 2024-02-28]', () => {
    // 2024-02-29 -1y = 2023-02-28 (clamped); end = anchor minus 1d = 2024-02-28
    expect(windowContaining(b, '2024-02-28')).toEqual({ start: '2023-02-28', end: '2024-02-28' });
    expect(windowContaining(b, '2023-02-28')).toEqual({ start: '2023-02-28', end: '2024-02-28' });
  });
});

// ===========================================================================
// shiftWindow
// ===========================================================================

describe('shiftWindow', () => {
  it('weekly: shifts by exact 7-day steps, both directions', () => {
    const b = { period: 'weekly', startDate: '2025-01-06' } as const;
    const w0: PeriodWindow = { start: '2025-01-06', end: '2025-01-12' };
    expect(shiftWindow(b, w0, 2)).toEqual({ start: '2025-01-20', end: '2025-01-26' });
    expect(shiftWindow(b, w0, -1)).toEqual({ start: '2024-12-30', end: '2025-01-05' });
    expect(shiftWindow(b, w0, 0)).toEqual(w0);
  });

  it('monthly anchored 31st: shifting re-derives from the anchor (no clamp drift)', () => {
    const b = { period: 'monthly', startDate: '2024-01-31' } as const;
    const w0: PeriodWindow = { start: '2024-01-31', end: '2024-02-28' };
    // +1 → [2024-02-29, 2024-03-30]; naive "add 1 month to both ends" would
    // wrongly give [2024-02-29, 2024-03-28]
    expect(shiftWindow(b, w0, 1)).toEqual({ start: '2024-02-29', end: '2024-03-30' });
    // +2 → the anchor day (31st) resurfaces: [2024-03-31, 2024-04-29]
    expect(shiftWindow(b, w0, 2)).toEqual({ start: '2024-03-31', end: '2024-04-29' });
    // -1 → [2023-12-31, 2024-01-30]
    expect(shiftWindow(b, w0, -1)).toEqual({ start: '2023-12-31', end: '2024-01-30' });
  });

  it('yearly anchored 29 Feb: +4 lands back on a real 29 Feb', () => {
    const b = { period: 'yearly', startDate: '2024-02-29' } as const;
    const w0: PeriodWindow = { start: '2024-02-29', end: '2025-02-27' };
    expect(shiftWindow(b, w0, 4)).toEqual({ start: '2028-02-29', end: '2029-02-27' });
  });

  it('round-trips: +3 then -3 returns the original window', () => {
    const b = { period: 'monthly', startDate: '2024-01-31' } as const;
    const w: PeriodWindow = { start: '2024-02-29', end: '2024-03-30' };
    expect(shiftWindow(b, shiftWindow(b, w, 3), -3)).toEqual(w);
  });
});

// ===========================================================================
// budgetProgress — db-backed
// ===========================================================================

describe('budgetProgress', () => {
  beforeEach(async () => {
    await clearAll();
    await db.settings.put(defaultSettings()); // base currency GBP
    await seedCategories();
  });

  it('computes the full mixed scenario with hand-calculated totals', async () => {
    // EUR:GBP manual rate — 1 EUR = 0.85 GBP
    await setManualRate('EUR', 'GBP', 0.85);
    await db.transactions.bulkAdd([
      // counted (all inside window [2025-03-01, 2025-03-31]):
      tx({ date: '2025-03-05', amountMinor: -12345, categoryId: 'groceries' }), //   -12345 (child)
      tx({ date: '2025-03-10', amountMinor: -6789, categoryId: 'dining' }), //        -6789 (child)
      tx({ date: '2025-03-12', amountMinor: -1000, categoryId: 'food' }), //          -1000 (parent itself)
      tx({ date: '2025-03-18', amountMinor: -500, categoryId: 'coffee' }), //          -500 (grandchild)
      tx({ date: '2025-03-20', amountMinor: 2000, categoryId: 'groceries' }), //      +2000 (refund, D14)
      // split: only the groceries split counts (travel + uncategorised don't):
      tx({
        date: '2025-03-08',
        amountMinor: -9000,
        splits: [
          { categoryId: 'groceries', amountMinor: -5000 },
          { categoryId: 'travel', amountMinor: -3000 },
          { categoryId: null, amountMinor: -1000 },
        ],
      }), //                                                                          -5000
      // EUR: -1000 minor (= €10.00) × 0.85 → -850 GBP minor:                          -850
      tx({ date: '2025-03-22', amountMinor: -1000, currency: 'EUR', categoryId: 'food' }),
      // NOT counted:
      tx({ date: '2025-03-23', amountMinor: -5000, currency: 'USD', categoryId: 'food' }), // no USD rate → missingRateCount
      tx({ date: '2025-03-15', amountMinor: -50000, transferGroupId: 'tg1' }), // transfer leg (D13)
      tx({ date: '2025-02-28', amountMinor: -99999, categoryId: 'food' }), // before window
      tx({ date: '2025-04-01', amountMinor: -88888, categoryId: 'food' }), // after window
      tx({ date: '2025-03-17', amountMinor: -7777, categoryId: 'travel' }), // other category root
      tx({ date: '2025-03-16', amountMinor: -3333 }), // uncategorised
      // splits present → parent categoryId ('food') is IGNORED; the only split
      // is travel, so nothing counts:
      tx({
        date: '2025-03-19',
        amountMinor: -4000,
        categoryId: 'food',
        splits: [{ categoryId: 'travel', amountMinor: -4000 }],
      }),
    ]);

    const p = await budgetProgress(mkBudget(), '2025-03-15');
    // Hand calculation (signed GBP minor):
    //   -12345 - 6789 - 1000 - 500 + 2000 - 5000 - 850 = -24484
    //   spent      = 24484  (£244.84)
    //   remaining  = 50000 - 24484 = 25516
    //   pct        = 24484 / 50000 = 0.48968
    expect(p.window).toEqual({ start: '2025-03-01', end: '2025-03-31' });
    expect(p.spentMinor).toBe(24484);
    expect(p.limitMinor).toBe(50000);
    expect(p.remainingMinor).toBe(25516);
    expect(p.pct).toBeCloseTo(0.48968, 10);
    expect(p.over).toBe(false);
    expect(p.missingRateCount).toBe(1);
  });

  it('window boundary dates are inclusive on both ends', async () => {
    await db.transactions.bulkAdd([
      tx({ date: '2025-03-01', amountMinor: -100, categoryId: 'food' }), // on start → counts
      tx({ date: '2025-03-31', amountMinor: -200, categoryId: 'food' }), // on end → counts
      tx({ date: '2025-02-28', amountMinor: -400, categoryId: 'food' }), // day before → no
      tx({ date: '2025-04-01', amountMinor: -800, categoryId: 'food' }), // day after → no
    ]);
    const p = await budgetProgress(mkBudget(), '2025-03-15');
    // spent = 100 + 200 = 300
    expect(p.spentMinor).toBe(300);
  });

  it('weekly budget across a month boundary, and a refDate before startDate', async () => {
    const b = mkBudget({ period: 'weekly', startDate: '2025-01-06', amountMinor: 10000 });
    await db.transactions.bulkAdd([
      tx({ date: '2025-01-27', amountMinor: -1500, categoryId: 'food' }), // window 3 start
      tx({ date: '2025-02-02', amountMinor: -2500, categoryId: 'food' }), // window 3 end (Feb!)
      tx({ date: '2025-02-03', amountMinor: -9999, categoryId: 'food' }), // window 4 → out
      tx({ date: '2025-01-05', amountMinor: -400, categoryId: 'food' }), // window -1
    ]);
    // window 3 = [2025-01-27, 2025-02-02]: spent = 1500 + 2500 = 4000
    const p = await budgetProgress(b, '2025-01-30');
    expect(p.window).toEqual({ start: '2025-01-27', end: '2025-02-02' });
    expect(p.spentMinor).toBe(4000);
    // refDate before startDate → negative window [2024-12-30, 2025-01-05]: spent = 400
    const pBefore = await budgetProgress(b, '2025-01-04');
    expect(pBefore.window).toEqual({ start: '2024-12-30', end: '2025-01-05' });
    expect(pBefore.spentMinor).toBe(400);
  });

  it('over budget: remaining negative, pct > 1, over = true', async () => {
    await db.transactions.add(tx({ date: '2025-03-10', amountMinor: -2500, categoryId: 'travel' }));
    const p = await budgetProgress(mkBudget({ categoryIds: ['travel'], amountMinor: 1000 }), '2025-03-15');
    // spent 2500 vs limit 1000: remaining = 1000 - 2500 = -1500; pct = 2.5
    expect(p.spentMinor).toBe(2500);
    expect(p.remainingMinor).toBe(-1500);
    expect(p.pct).toBeCloseTo(2.5, 10);
    expect(p.over).toBe(true);
  });

  it('spent exactly at the limit is NOT over', async () => {
    await db.transactions.add(tx({ date: '2025-03-10', amountMinor: -1000, categoryId: 'food' }));
    const p = await budgetProgress(mkBudget({ amountMinor: 1000 }), '2025-03-15');
    expect(p.spentMinor).toBe(1000);
    expect(p.remainingMinor).toBe(0);
    expect(p.pct).toBeCloseTo(1, 10);
    expect(p.over).toBe(false);
  });

  it('refunds exceeding spend push spentMinor negative; pct clamps at 0', async () => {
    await db.transactions.bulkAdd([
      tx({ date: '2025-03-05', amountMinor: 3000, categoryId: 'dining' }), // refund
      tx({ date: '2025-03-06', amountMinor: -1000, categoryId: 'dining' }),
    ]);
    const p = await budgetProgress(mkBudget({ categoryIds: ['dining'], amountMinor: 5000 }), '2025-03-15');
    // signed sum = +3000 - 1000 = +2000 → spent = -2000 (net refund; correct)
    expect(p.spentMinor).toBe(-2000);
    expect(p.remainingMinor).toBe(7000); // 5000 - (-2000)
    expect(p.pct).toBe(0); // never negative
    expect(p.over).toBe(false);
  });

  it('no-rate split transaction: each covered split counts in missingRateCount', async () => {
    await db.transactions.bulkAdd([
      tx({
        date: '2025-03-07',
        amountMinor: -3000,
        currency: 'CHF', // no CHF rate exists
        splits: [
          { categoryId: 'groceries', amountMinor: -2000 },
          { categoryId: 'dining', amountMinor: -1000 },
        ],
      }),
      tx({ date: '2025-03-08', amountMinor: -1234, categoryId: 'food' }), // GBP, fine
    ]);
    const p = await budgetProgress(mkBudget(), '2025-03-15');
    // Both covered CHF splits are inconvertible contributions → 2; excluded
    // from spend, so spent = 1234 (GBP tx only).
    expect(p.missingRateCount).toBe(2);
    expect(p.spentMinor).toBe(1234);
  });

  it('FX conversion rounds half-away-from-zero once per contribution', async () => {
    await setManualRate('EUR', 'GBP', 0.8567);
    await db.transactions.bulkAdd([
      // -999 EUR minor × 0.8567 = -855.8433 → rounds to -856
      tx({ date: '2025-03-03', amountMinor: -999, currency: 'EUR', categoryId: 'food' }),
      // -111 EUR minor × 0.8567 = -95.0937 → rounds to -95
      tx({ date: '2025-03-04', amountMinor: -111, currency: 'EUR', categoryId: 'food' }),
    ]);
    const p = await budgetProgress(mkBudget(), '2025-03-15');
    // spent = 856 + 95 = 951
    expect(p.spentMinor).toBe(951);
    expect(p.missingRateCount).toBe(0);
  });

  it('uses the inverse of a stored rate when only the opposite direction exists', async () => {
    // Only GBP:EUR stored: 1 GBP = 1.25 EUR ⇒ EUR→GBP = 1/1.25 = 0.8
    await setManualRate('GBP', 'EUR', 1.25);
    await db.transactions.add(
      tx({ date: '2025-03-05', amountMinor: -1200, currency: 'EUR', categoryId: 'food' }),
    );
    const p = await budgetProgress(mkBudget(), '2025-03-15');
    // -1200 × 0.8 = -960 → spent 960
    expect(p.spentMinor).toBe(960);
    expect(p.missingRateCount).toBe(0);
  });

  it('empty window → zero everything, no missing rates', async () => {
    const p = await budgetProgress(mkBudget(), '2025-03-15');
    expect(p.spentMinor).toBe(0);
    expect(p.remainingMinor).toBe(50000);
    expect(p.pct).toBe(0);
    expect(p.over).toBe(false);
    expect(p.missingRateCount).toBe(0);
  });

  it('defaults refDate to today', async () => {
    const b = mkBudget({ startDate: '2000-01-01' });
    const p = await budgetProgress(b);
    expect(p.window).toEqual(windowContaining(b, todayISO()));
  });
});

// ===========================================================================
// allBudgetProgress
// ===========================================================================

describe('allBudgetProgress', () => {
  beforeEach(async () => {
    await clearAll();
    await db.settings.put(defaultSettings());
    await seedCategories();
  });

  it('returns non-archived budgets sorted by name with correct numbers', async () => {
    await db.budgets.bulkAdd([
      mkBudget({ name: 'Zebra', categoryIds: ['travel'], amountMinor: 1000 }),
      mkBudget({ name: 'Alpha', categoryIds: ['food'], amountMinor: 50000 }),
      mkBudget({ name: 'Hidden', archived: true }),
    ]);
    await db.transactions.bulkAdd([
      tx({ date: '2025-03-10', amountMinor: -2500, categoryId: 'travel' }),
      tx({ date: '2025-03-11', amountMinor: -1000, categoryId: 'groceries' }),
    ]);
    const all = await allBudgetProgress('2025-03-15');
    expect(all.map((p) => p.budget.name)).toEqual(['Alpha', 'Zebra']);
    expect(all[0].spentMinor).toBe(1000); // groceries ∈ food's descendants
    expect(all[1].spentMinor).toBe(2500);
    expect(all[1].over).toBe(true); // 2500 > 1000
  });

  it('returns [] when there are no budgets', async () => {
    expect(await allBudgetProgress('2025-03-15')).toEqual([]);
  });
});

// ===========================================================================
// saveBudget / deleteBudget
// ===========================================================================

describe('saveBudget', () => {
  beforeEach(async () => {
    await clearAll();
    await seedCategories();
  });

  const valid = {
    name: 'Groceries',
    categoryIds: ['groceries'],
    amountMinor: 30000,
    period: 'monthly' as const,
    startDate: '2025-01-01',
  };

  it('creates a budget with defaults (rollover false, archived false)', async () => {
    const b = await saveBudget(valid);
    expect(b.id).toBeTruthy();
    expect(b.rollover).toBe(false);
    expect(b.archived).toBe(false);
    expect(await db.budgets.get(b.id)).toEqual(b);
  });

  it('trims and collapses whitespace in the name', async () => {
    const b = await saveBudget({ ...valid, name: '  Food   Budget  ' });
    expect(b.name).toBe('Food Budget');
  });

  it('dedupes categoryIds', async () => {
    const b = await saveBudget({ ...valid, categoryIds: ['groceries', 'dining', 'groceries'] });
    expect(b.categoryIds).toEqual(['groceries', 'dining']);
  });

  it('updates in place, preserving id and rollover', async () => {
    const created = await saveBudget(valid);
    await db.budgets.update(created.id, { rollover: true });
    const updated = await saveBudget({ ...valid, id: created.id, name: 'Renamed', amountMinor: 999 });
    expect(updated.id).toBe(created.id);
    expect(updated.name).toBe('Renamed');
    expect(updated.amountMinor).toBe(999);
    expect(updated.rollover).toBe(true); // preserved across the update
    expect(await db.budgets.count()).toBe(1);
  });

  it('can archive and unarchive', async () => {
    const created = await saveBudget(valid);
    const archived = await saveBudget({ ...valid, id: created.id, archived: true });
    expect(archived.archived).toBe(true);
    const back = await saveBudget({ ...valid, id: created.id, archived: false });
    expect(back.archived).toBe(false);
  });

  it.each([
    ['empty name', { ...valid, name: '   ' }],
    ['zero amount', { ...valid, amountMinor: 0 }],
    ['negative amount', { ...valid, amountMinor: -100 }],
    ['fractional amount', { ...valid, amountMinor: 100.5 }],
    ['unsafe-integer amount', { ...valid, amountMinor: 2 ** 53 }],
    ['NaN amount', { ...valid, amountMinor: NaN }],
    ['no categories', { ...valid, categoryIds: [] }],
    ['bad period', { ...valid, period: 'daily' as never }],
    ['malformed date', { ...valid, startDate: '2025-1-01' }],
    ['impossible date', { ...valid, startDate: '2025-02-30' }],
    ['non-date', { ...valid, startDate: 'not-a-date' }],
    ['unknown id', { ...valid, id: 'nope' }],
  ])('rejects %s with ValidationError', async (_label, input) => {
    await expect(saveBudget(input)).rejects.toBeInstanceOf(ValidationError);
  });

  it('deleteBudget removes the budget; deleting a missing id is a no-op', async () => {
    const b = await saveBudget(valid);
    await deleteBudget(b.id);
    expect(await db.budgets.get(b.id)).toBeUndefined();
    await expect(deleteBudget('missing')).resolves.toBeUndefined();
  });
});
