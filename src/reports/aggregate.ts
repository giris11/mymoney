// Report aggregation (SPEC §8.1.8). CONTRACT — implemented by the reports
// build agent.
//
// Shared semantics for ALL report functions:
//  * date ranges are inclusive of both endpoints;
//  * results are in the BASE currency; transactions whose currency has no
//    rate are excluded and counted in missingRateCount / listed in
//    missingRateCurrencies — never silently converted wrongly (SPEC §6);
//  * transfers (transferGroupId != null) are excluded from income/spend
//    reports (D13) but ARE part of account balances / net worth;
//  * split transactions contribute each split under the split's category;
//  * "spending" figures are net of refunds (positive amounts in expense
//    categories subtract) and reported as POSITIVE numbers;
//  * months are 'YYYY-MM' strings.
export interface DateRange {
  from: string; // 'YYYY-MM-DD' inclusive
  to: string; // inclusive
}

export interface NetWorthPoint {
  date: string; // sample date ('YYYY-MM-DD', end of each month + range end)
  totalBaseMinor: number;
}

/** Net worth (all non-archived accounts) sampled at each month-end in range. */
export async function netWorthSeries(
  range: DateRange,
): Promise<{ points: NetWorthPoint[]; missingRateCurrencies: string[] }> {
  void range;
  throw new Error('not implemented');
}

export interface CategorySpendRow {
  /** null = uncategorised bucket */
  categoryId: string | null;
  name: string;
  colour?: string;
  spentMinor: number; // positive
  /** true when this row has subcategories to drill into */
  hasChildren: boolean;
}

/**
 * Spending grouped by category. parentId null = top-level categories (each
 * including all its descendants); a category id = its direct children
 * (drill-down), plus an "(itself)" row for amounts logged on the parent.
 */
export async function spendingByCategory(
  range: DateRange,
  parentId: string | null,
): Promise<{ rows: CategorySpendRow[]; totalMinor: number; missingRateCount: number }> {
  void range;
  void parentId;
  throw new Error('not implemented');
}

export interface MonthlyIncomeExpense {
  month: string; // 'YYYY-MM'
  incomeMinor: number; // positive
  expenseMinor: number; // positive (net of refunds)
}

export async function incomeVsExpenseByMonth(
  range: DateRange,
): Promise<{ rows: MonthlyIncomeExpense[]; missingRateCount: number }> {
  void range;
  throw new Error('not implemented');
}

export interface MonthlyCashFlow {
  month: string;
  netMinor: number; // income - expense (signed)
  cumulativeMinor: number; // running total across the range
}

export async function cashFlowByMonth(
  range: DateRange,
): Promise<{ rows: MonthlyCashFlow[]; missingRateCount: number }> {
  void range;
  throw new Error('not implemented');
}

export interface PayeeSpendRow {
  payeeId: string | null; // null = no payee
  name: string;
  spentMinor: number; // positive
  txCount: number;
}

export async function spendingByPayee(
  range: DateRange,
  limit?: number,
): Promise<{ rows: PayeeSpendRow[]; missingRateCount: number }> {
  void range;
  void limit;
  throw new Error('not implemented');
}

export interface TagSpendRow {
  tagId: string;
  name: string;
  spentMinor: number; // positive
  txCount: number;
}

export async function spendingByTag(
  range: DateRange,
): Promise<{ rows: TagSpendRow[]; missingRateCount: number }> {
  void range;
  throw new Error('not implemented');
}
