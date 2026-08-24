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
import type { Budget, BudgetPeriod } from '../db/types';

export interface PeriodWindow {
  start: string; // 'YYYY-MM-DD' inclusive
  end: string; // 'YYYY-MM-DD' inclusive
}

/** Pure, unit-tested. Window of the budget's period containing `date`. */
export function windowContaining(
  budget: Pick<Budget, 'period' | 'startDate'>,
  date: string,
): PeriodWindow {
  void budget;
  void date;
  throw new Error('not implemented');
}

/** Pure. Shift a window by n periods (n may be negative). */
export function shiftWindow(
  budget: Pick<Budget, 'period' | 'startDate'>,
  window: PeriodWindow,
  n: number,
): PeriodWindow {
  void budget;
  void window;
  void n;
  throw new Error('not implemented');
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

export async function budgetProgress(budget: Budget, refDate?: string): Promise<BudgetProgress> {
  void budget;
  void refDate;
  throw new Error('not implemented');
}

/** Progress for all non-archived budgets, sorted by name. */
export async function allBudgetProgress(refDate?: string): Promise<BudgetProgress[]> {
  void refDate;
  throw new Error('not implemented');
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

export async function saveBudget(input: SaveBudgetInput): Promise<Budget> {
  void input;
  throw new Error('not implemented');
}

export async function deleteBudget(id: string): Promise<void> {
  void id;
  throw new Error('not implemented');
}
