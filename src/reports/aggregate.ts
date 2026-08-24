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
import dayjs from 'dayjs';
import { db, getSettings } from '../db/db';
import { rateLookup } from '../domain/fx';
import { convertMinor } from '../money/money';
import type { Category, Transaction } from '../db/types';

export interface DateRange {
  from: string; // 'YYYY-MM-DD' inclusive
  to: string; // inclusive
}

// ---------------------------------------------------------------------------
// Internal helpers (exported nothing extra beyond the contract surface)
// ---------------------------------------------------------------------------

/** One report-relevant amount: a whole transaction, or one split of one. */
interface Contribution {
  txId: string;
  month: string; // 'YYYY-MM' of the parent transaction's date
  categoryId: string | null; // the split's category for split transactions
  payeeId: string | null; // parent's payee
  tagIds: string[]; // parent's tags
  /** signed, original currency — used only for sign classification */
  amountMinor: number;
  /** signed, converted to base currency (rounded once, half away from zero) */
  amountBaseMinor: number;
}

interface FlowData {
  contributions: Contribution[];
  missingRateCount: number;
  categories: Map<string, Category>;
  /** category ids that have at least one child category */
  hasChild: Set<string>;
}

/**
 * Shared loader for the five flow reports: fetches the range's transactions
 * once via the date index (inclusive both ends), skips transfer legs (D13),
 * explodes split transactions into per-split contributions (split category +
 * split amount under the parent's payee/tags/date/currency) and converts each
 * contribution to the base currency — one rounding per contribution.
 * A transaction whose currency has no rate to base is skipped entirely and
 * counted once in missingRateCount — surfaced, never guessed (SPEC §6).
 * Pending transactions count like cleared ones (D15).
 */
async function loadFlowData(range: DateRange): Promise<FlowData> {
  const [settings, lookup, cats, txs] = await Promise.all([
    getSettings(),
    rateLookup(),
    db.categories.toArray(),
    range.from <= range.to
      ? db.transactions.where('date').between(range.from, range.to, true, true).toArray()
      : Promise.resolve([] as Transaction[]),
  ]);
  const base = settings.baseCurrency;
  const categories = new Map(cats.map((c) => [c.id, c] as const));
  const hasChild = new Set<string>();
  for (const c of cats) if (c.parentId) hasChild.add(c.parentId);

  const contributions: Contribution[] = [];
  let missingRateCount = 0;
  for (const t of txs) {
    if (t.transferGroupId !== null) continue; // transfers are not income/spend (D13)
    if (lookup(t.currency, base) === null) {
      missingRateCount += 1;
      continue;
    }
    const parts =
      t.splits.length > 0
        ? t.splits.map((s) => ({ categoryId: s.categoryId, amountMinor: s.amountMinor }))
        : [{ categoryId: t.categoryId, amountMinor: t.amountMinor }];
    for (const p of parts) {
      const conv = convertMinor(p.amountMinor, t.currency, base, lookup);
      if (conv === null) continue; // unreachable — rate existence checked above
      contributions.push({
        txId: t.id,
        month: t.date.slice(0, 7),
        categoryId: p.categoryId,
        payeeId: t.payeeId,
        tagIds: t.tagIds,
        amountMinor: p.amountMinor,
        amountBaseMinor: conv,
      });
    }
  }
  return { contributions, missingRateCount, categories, hasChild };
}

/**
 * Ledger side of a contribution: by CATEGORY KIND when categorised (so
 * refunds — positive amounts in expense categories — net within the expense
 * side, D14, and negative amounts in income categories net within income),
 * by SIGN when uncategorised (or the category record is missing).
 */
function sideOf(
  c: Contribution,
  categories: Map<string, Category>,
): 'income' | 'expense' | null {
  if (c.categoryId !== null) {
    const cat = categories.get(c.categoryId);
    if (cat) return cat.kind;
  }
  if (c.amountMinor < 0) return 'expense';
  if (c.amountMinor > 0) return 'income';
  return null; // a zero uncategorised amount belongs to neither side
}

/** Every 'YYYY-MM' month from from's month to to's month, ascending. */
function monthsInRange(range: DateRange): string[] {
  if (range.from > range.to) return [];
  const out: string[] = [];
  let cur = dayjs(range.from).startOf('month');
  const last = dayjs(range.to).startOf('month');
  while (!cur.isAfter(last)) {
    out.push(cur.format('YYYY-MM'));
    cur = cur.add(1, 'month');
  }
  return out;
}

/** Walk up to the top-level ancestor; orphans/cycles surface as their own root. */
function rootOf(cat: Category, categories: Map<string, Category>): Category {
  let cur = cat;
  const seen = new Set<string>([cat.id]);
  while (cur.parentId) {
    const parent = categories.get(cur.parentId);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    cur = parent;
  }
  return cur;
}

/**
 * Drill-down bucketing: 'self' when cat IS the parent; otherwise the direct
 * child of parentId on cat's ancestor path (the subtree each drill row rolls
 * up); null when cat is outside the parent's subtree.
 */
function bucketWithin(
  cat: Category,
  parentId: string,
  categories: Map<string, Category>,
): Category | 'self' | null {
  if (cat.id === parentId) return 'self';
  let cur: Category | undefined = cat;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    if (cur.parentId === parentId) return cur;
    cur = cur.parentId ? categories.get(cur.parentId) : undefined;
  }
  return null;
}

const byDateAsc = (a: Transaction, b: Transaction): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : 0;

// ---------------------------------------------------------------------------
// Net worth over time
// ---------------------------------------------------------------------------

export interface NetWorthPoint {
  date: string; // sample date ('YYYY-MM-DD', end of each month + range end)
  totalBaseMinor: number;
}

/**
 * Net worth (all non-archived accounts) sampled at each month-end in range.
 *
 * Net worth is CUMULATIVE from the beginning of time: openingBalanceMinor plus
 * every transaction dated on or before the sample date — not just range
 * activity. Pending transactions count (D15). Transfer legs are real balance
 * changes on both accounts and are NOT special-cased (same-currency pairs
 * naturally cancel in the total). Per-currency running totals are kept in
 * integer minor units; each currency subtotal is converted to base at CURRENT
 * rates (D12) with exactly one rounding per currency per sample point.
 * Currencies with no rate to base are excluded from every point and reported
 * once in missingRateCurrencies (SPEC §6 — never guess).
 */
export async function netWorthSeries(
  range: DateRange,
): Promise<{ points: NetWorthPoint[]; missingRateCurrencies: string[] }> {
  if (range.from > range.to) return { points: [], missingRateCurrencies: [] };
  const [settings, lookup, accounts, txs] = await Promise.all([
    getSettings(),
    rateLookup(),
    db.accounts.filter((a) => !a.archived).toArray(),
    db.transactions.where('date').belowOrEqual(range.to).toArray(),
  ]);
  const base = settings.baseCurrency;
  const currencyOfAccount = new Map(accounts.map((a) => [a.id, a.currency] as const));

  // Opening balances seed the per-currency totals; currencies lacking a rate
  // are excluded up front so no point ever contains a guessed number.
  const missing = new Set<string>();
  const totals = new Map<string, number>(); // currency → cumulative minor units
  for (const a of accounts) {
    if (lookup(a.currency, base) === null) {
      missing.add(a.currency);
      continue;
    }
    totals.set(a.currency, (totals.get(a.currency) ?? 0) + a.openingBalanceMinor);
  }

  // Only non-archived accounts' transactions matter for net worth.
  const relevant = txs.filter((t) => currencyOfAccount.has(t.accountId)).sort(byDateAsc);

  // Sample dates: every month-end that falls inside the range, plus the range
  // end itself, deduplicated, ascending.
  const sampleSet = new Set<string>();
  let cur = dayjs(range.from).startOf('month');
  const last = dayjs(range.to).startOf('month');
  while (!cur.isAfter(last)) {
    const end = cur.endOf('month').format('YYYY-MM-DD');
    if (end >= range.from && end <= range.to) sampleSet.add(end);
    cur = cur.add(1, 'month');
  }
  sampleSet.add(range.to);
  const sampleDates = [...sampleSet].sort();

  const points: NetWorthPoint[] = [];
  let i = 0;
  for (const date of sampleDates) {
    while (i < relevant.length && relevant[i].date <= date) {
      const t = relevant[i];
      const ccy = currencyOfAccount.get(t.accountId)!;
      if (!missing.has(ccy)) totals.set(ccy, (totals.get(ccy) ?? 0) + t.amountMinor);
      i += 1;
    }
    let totalBaseMinor = 0;
    for (const [ccy, minor] of totals) {
      const conv = convertMinor(minor, ccy, base, lookup); // one rounding per ccy per point
      if (conv !== null) totalBaseMinor += conv;
    }
    points.push({ date, totalBaseMinor });
  }
  return { points, missingRateCurrencies: [...missing].sort() };
}

// ---------------------------------------------------------------------------
// Spending by category
// ---------------------------------------------------------------------------

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
 *
 * Only expense-kind categories count; uncategorised contributions count only
 * when expense-signed (negative) and land in the 'Uncategorised' row at top
 * level. Refunds (positive amounts in expense categories, D14) subtract.
 * Zero rows are dropped; rows sort by spentMinor descending;
 * totalMinor = Σ rows.
 */
export async function spendingByCategory(
  range: DateRange,
  parentId: string | null,
): Promise<{ rows: CategorySpendRow[]; totalMinor: number; missingRateCount: number }> {
  const { contributions, missingRateCount, categories, hasChild } = await loadFlowData(range);

  const buckets = new Map<string, CategorySpendRow>();
  const add = (key: string, make: () => Omit<CategorySpendRow, 'spentMinor'>, amountBaseMinor: number) => {
    let b = buckets.get(key);
    if (!b) {
      b = { ...make(), spentMinor: 0 };
      buckets.set(key, b);
    }
    b.spentMinor += -amountBaseMinor; // expenses are negative → spend positive; refunds subtract
  };

  for (const c of contributions) {
    const cat = c.categoryId !== null ? categories.get(c.categoryId) : undefined;
    if (parentId === null) {
      if (!cat) {
        // Uncategorised (or dangling category id): expense-signed only.
        if (c.amountMinor < 0) {
          add(
            ' uncategorised',
            () => ({ categoryId: null, name: 'Uncategorised', hasChildren: false }),
            c.amountBaseMinor,
          );
        }
        continue;
      }
      if (cat.kind !== 'expense') continue; // income categories are never "spending"
      const root = rootOf(cat, categories);
      add(
        root.id,
        () => ({
          categoryId: root.id,
          name: root.name,
          colour: root.colour,
          hasChildren: hasChild.has(root.id),
        }),
        c.amountBaseMinor,
      );
    } else {
      if (!cat || cat.kind !== 'expense') continue;
      const bucket = bucketWithin(cat, parentId, categories);
      if (bucket === null) continue; // outside the parent's subtree
      if (bucket === 'self') {
        // amounts logged directly on the parent get their own row
        const parent = categories.get(parentId);
        add(
          parentId,
          () => ({
            categoryId: parentId,
            name: parent?.name ?? 'Unknown category',
            colour: parent?.colour,
            hasChildren: false,
          }),
          c.amountBaseMinor,
        );
      } else {
        add(
          bucket.id,
          () => ({
            categoryId: bucket.id,
            name: bucket.name,
            colour: bucket.colour,
            hasChildren: hasChild.has(bucket.id),
          }),
          c.amountBaseMinor,
        );
      }
    }
  }

  const rows = [...buckets.values()]
    .filter((r) => r.spentMinor !== 0)
    .sort((a, b) => b.spentMinor - a.spentMinor || a.name.localeCompare(b.name));
  const totalMinor = rows.reduce((acc, r) => acc + r.spentMinor, 0);
  return { rows, totalMinor, missingRateCount };
}

// ---------------------------------------------------------------------------
// Income vs expense by month
// ---------------------------------------------------------------------------

export interface MonthlyIncomeExpense {
  month: string; // 'YYYY-MM'
  incomeMinor: number; // positive
  expenseMinor: number; // positive (net of refunds)
}

/**
 * One row for EVERY month in the range (zero-filled), ascending. Each
 * contribution is classified by category kind when categorised, by sign when
 * uncategorised (see sideOf); both figures are reported positive with refunds
 * netting within their own side.
 */
export async function incomeVsExpenseByMonth(
  range: DateRange,
): Promise<{ rows: MonthlyIncomeExpense[]; missingRateCount: number }> {
  const { contributions, missingRateCount, categories } = await loadFlowData(range);
  const rows: MonthlyIncomeExpense[] = monthsInRange(range).map((month) => ({
    month,
    incomeMinor: 0,
    expenseMinor: 0,
  }));
  const byMonth = new Map(rows.map((r) => [r.month, r] as const));
  for (const c of contributions) {
    const row = byMonth.get(c.month);
    if (!row) continue;
    const side = sideOf(c, categories);
    if (side === 'income') row.incomeMinor += c.amountBaseMinor;
    else if (side === 'expense') row.expenseMinor += -c.amountBaseMinor;
  }
  return { rows, missingRateCount };
}

// ---------------------------------------------------------------------------
// Cash flow by month
// ---------------------------------------------------------------------------

export interface MonthlyCashFlow {
  month: string;
  netMinor: number; // income - expense (signed)
  cumulativeMinor: number; // running total across the range
}

/**
 * netMinor = incomeMinor - expenseMinor per month (same classification as
 * incomeVsExpenseByMonth); cumulativeMinor runs across the requested range
 * only (starts at zero). Zero-filled months included.
 */
export async function cashFlowByMonth(
  range: DateRange,
): Promise<{ rows: MonthlyCashFlow[]; missingRateCount: number }> {
  const { rows: ie, missingRateCount } = await incomeVsExpenseByMonth(range);
  let cumulativeMinor = 0;
  const rows: MonthlyCashFlow[] = ie.map((r) => {
    const netMinor = r.incomeMinor - r.expenseMinor;
    cumulativeMinor += netMinor;
    return { month: r.month, netMinor, cumulativeMinor };
  });
  return { rows, missingRateCount };
}

// ---------------------------------------------------------------------------
// Spending by payee
// ---------------------------------------------------------------------------

export interface PayeeSpendRow {
  payeeId: string | null; // null = no payee
  name: string;
  spentMinor: number; // positive
  txCount: number;
}

/**
 * Net expense-side spend grouped by payee (null bucket → 'No payee'). Same
 * expense classification as spendingByCategory; txCount = number of DISTINCT
 * transactions contributing (a multi-split transaction counts once). Zero
 * rows dropped, sorted descending, sliced to `limit` when given.
 */
export async function spendingByPayee(
  range: DateRange,
  limit?: number,
): Promise<{ rows: PayeeSpendRow[]; missingRateCount: number }> {
  const { contributions, missingRateCount, categories } = await loadFlowData(range);
  const payees = new Map((await db.payees.toArray()).map((p) => [p.id, p] as const));
  const buckets = new Map<string | null, { spentMinor: number; txIds: Set<string> }>();
  for (const c of contributions) {
    if (sideOf(c, categories) !== 'expense') continue;
    let b = buckets.get(c.payeeId);
    if (!b) {
      b = { spentMinor: 0, txIds: new Set() };
      buckets.set(c.payeeId, b);
    }
    b.spentMinor += -c.amountBaseMinor;
    b.txIds.add(c.txId);
  }
  const rows: PayeeSpendRow[] = [...buckets.entries()]
    .map(([payeeId, b]) => ({
      payeeId,
      name: payeeId === null ? 'No payee' : payees.get(payeeId)?.name ?? 'Unknown payee',
      spentMinor: b.spentMinor,
      txCount: b.txIds.size,
    }))
    .filter((r) => r.spentMinor !== 0)
    .sort((a, b) => b.spentMinor - a.spentMinor || a.name.localeCompare(b.name));
  return { rows: limit !== undefined ? rows.slice(0, limit) : rows, missingRateCount };
}

// ---------------------------------------------------------------------------
// Spending by tag
// ---------------------------------------------------------------------------

export interface TagSpendRow {
  tagId: string;
  name: string;
  spentMinor: number; // positive
  txCount: number;
}

/**
 * Net expense-side spend grouped by each tag on the contribution (a
 * contribution with several tags counts fully under each). Split
 * contributions carry the parent transaction's tags. txCount = distinct
 * transactions contributing per tag. Zero rows dropped, sorted descending.
 */
export async function spendingByTag(
  range: DateRange,
): Promise<{ rows: TagSpendRow[]; missingRateCount: number }> {
  const { contributions, missingRateCount, categories } = await loadFlowData(range);
  const tags = new Map((await db.tags.toArray()).map((t) => [t.id, t] as const));
  const buckets = new Map<string, { spentMinor: number; txIds: Set<string> }>();
  for (const c of contributions) {
    if (sideOf(c, categories) !== 'expense') continue;
    for (const tagId of c.tagIds) {
      let b = buckets.get(tagId);
      if (!b) {
        b = { spentMinor: 0, txIds: new Set() };
        buckets.set(tagId, b);
      }
      b.spentMinor += -c.amountBaseMinor;
      b.txIds.add(c.txId);
    }
  }
  const rows: TagSpendRow[] = [...buckets.entries()]
    .map(([tagId, b]) => ({
      tagId,
      name: tags.get(tagId)?.name ?? 'Unknown tag',
      spentMinor: b.spentMinor,
      txCount: b.txIds.size,
    }))
    .filter((r) => r.spentMinor !== 0)
    .sort((a, b) => b.spentMinor - a.spentMinor || a.name.localeCompare(b.name));
  return { rows, missingRateCount };
}
