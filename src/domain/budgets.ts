// Budgets (SPEC §8.1.6, no rollover in Phase 1). CONTRACT — implemented by
// the domain build agent.
//
// Semantics:
//  * a budget covers its categoryIds PLUS all their descendants (D16);
//  * spend counts expense outflows net of refunds: spentMinor =
//    -(Σ amounts in those categories within the window), floored at
//    whatever the maths says (can go negative if refunds exceed spend);
//  * split transactions contribute each split by the SPLIT's category;
//  * transfers never count (their categoryId is null);
//  * amounts are converted to the base currency at current rates; transactions
//    with no available rate are counted in missingRateCount, never guessed
//    (SPEC §6, D22);
//  * period windows anchor at startDate: weekly = consecutive 7-day windows,
//    monthly = calendar-ish months anchored at startDate's day (clamped to
//    short months), yearly = anniversary years. Windows are [start, end]
//    inclusive of both dates.
import dayjs from 'dayjs';
import { db, getSettings } from '../db/db';
import type { Budget, BudgetPeriod, Transaction } from '../db/types';
import { todayISO, uid } from '../lib/util';
import { convertMinor } from '../money/money';
import { descendantIds } from './categories';
import { rateLookup } from './fx';
import { ValidationError } from './transactions';

export interface PeriodWindow {
  start: string; // 'YYYY-MM-DD' inclusive
  end: string; // 'YYYY-MM-DD' inclusive
}

const DAY_MS = 86_400_000;
const ISO_FMT = 'YYYY-MM-DD';

/** Exact whole-day timestamp for a 'YYYY-MM-DD' string (UTC → no DST drift). */
const utcMs = (isoDate: string): number => Date.parse(`${isoDate}T00:00:00Z`);

/**
 * The n-th window of a budget's period grid (n 0 = the window starting at
 * startDate; n may be negative). Monthly/yearly windows are
 * [anchor.add(n, unit), anchor.add(n+1, unit) - 1 day] — dayjs clamps a
 * short month's end (31 Jan + 1 month = 28/29 Feb), and because both ends
 * derive from the SAME anchor the clamping never accumulates and windows tile
 * the timeline contiguously with no gaps or overlaps.
 */
function windowAt(budget: Pick<Budget, 'period' | 'startDate'>, n: number): PeriodWindow {
  const anchor = dayjs(budget.startDate);
  if (budget.period === 'weekly') {
    const s = anchor.add(n * 7, 'day');
    return { start: s.format(ISO_FMT), end: s.add(6, 'day').format(ISO_FMT) };
  }
  const unit = budget.period === 'monthly' ? 'month' : 'year';
  return {
    start: anchor.add(n, unit).format(ISO_FMT),
    end: anchor
      .add(n + 1, unit)
      .subtract(1, 'day')
      .format(ISO_FMT),
  };
}

/** Index n of the window containing `date` (negative before startDate). */
function windowIndexOf(budget: Pick<Budget, 'period' | 'startDate'>, date: string): number {
  if (budget.period === 'weekly') {
    // floor() handles dates before startDate: -1 day → window -1, etc.
    return Math.floor((utcMs(date) - utcMs(budget.startDate)) / (7 * DAY_MS));
  }
  const [sy, sm] = budget.startDate.split('-').map(Number);
  const [dy, dm] = date.split('-').map(Number);
  let n = budget.period === 'monthly' ? (dy - sy) * 12 + (dm - sm) : dy - sy;
  // The year/month guess can be off by one around clamped short-month ends;
  // windows tile contiguously, so walk (at most a step or two) to the one
  // containing `date`. 'YYYY-MM-DD' strings compare correctly lexicographically.
  while (date < windowAt(budget, n).start) n -= 1;
  while (date > windowAt(budget, n).end) n += 1;
  return n;
}

/** Pure, unit-tested. Window of the budget's period containing `date`. */
export function windowContaining(
  budget: Pick<Budget, 'period' | 'startDate'>,
  date: string,
): PeriodWindow {
  return windowAt(budget, windowIndexOf(budget, date));
}

/**
 * Pure. Shift a window by n periods (n may be negative). The window's index on
 * the budget's grid is recovered from its start date, so shifting stays exact
 * even where clamping makes naive start/end ± n arithmetic drift
 * (e.g. monthly anchored on the 31st crossing February).
 */
export function shiftWindow(
  budget: Pick<Budget, 'period' | 'startDate'>,
  window: PeriodWindow,
  n: number,
): PeriodWindow {
  return windowAt(budget, windowIndexOf(budget, window.start) + n);
}

export interface BudgetProgress {
  budget: Budget;
  window: PeriodWindow;
  spentMinor: number; // net spend as a positive number (refunds subtract)
  limitMinor: number;
  remainingMinor: number; // limit - spent; negative when over
  pct: number; // spent / limit; may exceed 1; 0 when limit is 0
  over: boolean;
  missingRateCount: number;
}

/**
 * The signed minor-unit contributions of one transaction to a budget whose
 * covered-category set is `cats`:
 *  * transfer legs contribute nothing (D13);
 *  * a split transaction contributes ONLY its splits whose category is
 *    covered (the parent categoryId is ignored when splits exist);
 *  * otherwise the whole amount when the transaction's category is covered.
 * Each contribution is converted (and rounded) individually, matching how
 * reports attribute split lines to their own categories.
 */
function contributionsOf(t: Transaction, cats: Set<string>): number[] {
  if (t.transferGroupId !== null) return [];
  if (t.splits.length > 0) {
    return t.splits
      .filter((s) => s.categoryId !== null && cats.has(s.categoryId))
      .map((s) => s.amountMinor);
  }
  return t.categoryId !== null && cats.has(t.categoryId) ? [t.amountMinor] : [];
}

export async function budgetProgress(budget: Budget, refDate?: string): Promise<BudgetProgress> {
  const window = windowContaining(budget, refDate ?? todayISO());
  const [allCats, settings, lookup, txs] = await Promise.all([
    db.categories.toArray(),
    getSettings(),
    rateLookup(),
    db.transactions.where('date').between(window.start, window.end, true, true).toArray(),
  ]);
  const cats = descendantIds(allCats, budget.categoryIds);

  let sumMinor = 0; // signed Σ of converted contributions (spend negative)
  let missingRateCount = 0;
  for (const t of txs) {
    for (const amountMinor of contributionsOf(t, cats)) {
      const converted = convertMinor(amountMinor, t.currency, settings.baseCurrency, lookup);
      if (converted === null) missingRateCount += 1; // never guess (SPEC §6)
      else sumMinor += converted;
    }
  }

  // Expenses are negative → spend is positive. Guard against IEEE -0 so a
  // zero-spend window can never display as "-£0.00".
  const spentMinor = sumMinor === 0 ? 0 : -sumMinor;
  const limitMinor = budget.amountMinor;
  return {
    budget,
    window,
    spentMinor,
    limitMinor,
    remainingMinor: limitMinor - spentMinor,
    pct: limitMinor > 0 ? Math.max(0, spentMinor / limitMinor) : 0,
    over: spentMinor > limitMinor,
    missingRateCount,
  };
}

/** Progress for all non-archived budgets, sorted by name. */
export async function allBudgetProgress(refDate?: string): Promise<BudgetProgress[]> {
  // NB: `archived` is a boolean — booleans are not valid IndexedDB keys, so
  // the `archived` index cannot be queried with equals(); filter in memory.
  const budgets = (await db.budgets.toArray())
    .filter((b) => !b.archived)
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(budgets.map((b) => budgetProgress(b, refDate)));
}

export interface SaveBudgetInput {
  id?: string;
  name: string;
  categoryIds: string[];
  amountMinor: number; // base currency (D22)
  period: BudgetPeriod;
  startDate: string;
  archived?: boolean;
}

const PERIODS: readonly BudgetPeriod[] = ['weekly', 'monthly', 'yearly'];

/** True for a real 'YYYY-MM-DD' calendar date (rejects e.g. 2025-02-30). */
function isValidISODate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && dayjs(s).format(ISO_FMT) === s;
}

export async function saveBudget(input: SaveBudgetInput): Promise<Budget> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new ValidationError('Budget name cannot be empty');
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ValidationError('Budget amount must be a positive amount');
  }
  const categoryIds = [...new Set(input.categoryIds)].filter(Boolean);
  if (categoryIds.length === 0) {
    throw new ValidationError('Choose at least one category');
  }
  if (!PERIODS.includes(input.period)) {
    throw new ValidationError('Budget period must be weekly, monthly or yearly');
  }
  if (!isValidISODate(input.startDate)) {
    throw new ValidationError('Start date must be a valid YYYY-MM-DD date');
  }
  return db.transaction('rw', db.budgets, async () => {
    const existing = input.id ? await db.budgets.get(input.id) : undefined;
    if (input.id && !existing) throw new ValidationError('Budget not found');
    const budget: Budget = {
      id: existing?.id ?? uid(),
      name,
      categoryIds,
      amountMinor: input.amountMinor,
      period: input.period,
      startDate: input.startDate,
      rollover: existing?.rollover ?? false, // Phase 2; preserved, not editable yet
      archived: input.archived ?? existing?.archived ?? false,
    };
    await db.budgets.put(budget);
    return budget;
  });
}

export async function deleteBudget(id: string): Promise<void> {
  // Nothing references budgets, so a hard delete is safe.
  await db.budgets.delete(id);
}
