// Shared state/types/helpers for the Transactions area (register, editor,
// quick add). UI-only — all domain logic stays in src/domain/*.
import type { Transaction, TxStatus } from '../../db/types';
import type { TxFilter } from '../../domain/transactions';
import type { DateRangeValue } from '../kit/DateRangePicker';

export type TxKind = 'expense' | 'income' | 'transfer';
export type StatusFilter = 'all' | TxStatus;

/** Register filter state; '' / null mean "not filtering on this". */
export interface FilterState {
  text: string; // debounced search text (already applied)
  accountId: string;
  categoryId: string | null;
  payeeId: string | null;
  payeeText: string; // what the payee combobox displays
  tagId: string;
  range: DateRangeValue | null; // null = all dates
  minMinor: number | null; // absolute amounts
  maxMinor: number | null;
  status: StatusFilter;
}

export function emptyFilters(): FilterState {
  return {
    text: '',
    accountId: '',
    categoryId: null,
    payeeId: null,
    payeeText: '',
    tagId: '',
    range: null,
    minMinor: null,
    maxMinor: null,
    status: 'all',
  };
}

/** Count of non-search filters in effect (drives the mobile badge). */
export function countActiveFilters(f: FilterState): number {
  let n = 0;
  if (f.accountId) n += 1;
  if (f.categoryId) n += 1;
  if (f.payeeId) n += 1;
  if (f.tagId) n += 1;
  if (f.range && (f.range.from || f.range.to)) n += 1;
  if (f.minMinor !== null) n += 1;
  if (f.maxMinor !== null) n += 1;
  if (f.status !== 'all') n += 1;
  return n;
}

export function hasAnyFilter(f: FilterState): boolean {
  return countActiveFilters(f) > 0 || f.text.trim() !== '';
}

/** Translate UI filter state into the domain query filter. */
export function toTxFilter(f: FilterState): TxFilter {
  const out: TxFilter = {};
  if (f.accountId) out.accountIds = [f.accountId];
  if (f.categoryId) out.categoryIds = [f.categoryId];
  if (f.payeeId) out.payeeIds = [f.payeeId];
  if (f.tagId) out.tagIds = [f.tagId];
  if (f.range?.from) out.dateFrom = f.range.from;
  if (f.range?.to) out.dateTo = f.range.to;
  if (f.minMinor !== null) out.amountMinMinor = Math.abs(f.minMinor);
  if (f.maxMinor !== null) out.amountMaxMinor = Math.abs(f.maxMinor);
  if (f.status !== 'all') out.status = f.status;
  const text = f.text.trim();
  if (text) out.text = text;
  return out;
}

/** Net total per currency for the summary line (no conversion — SPEC §6). */
export function sumByCurrency(rows: Transaction[]): [currency: string, totalMinor: number][] {
  const m = new Map<string, number>();
  for (const t of rows) m.set(t.currency, (m.get(t.currency) ?? 0) + t.amountMinor);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Error → toast-able message (ValidationError and friends carry .message). */
export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : 'Something went wrong';

/**
 * Register grid template — shared between the sticky header row and TxRow so
 * the columns always line up: date | payee | category | account | tags | amount.
 */
export const REGISTER_GRID =
  'lg:grid-cols-[5.5rem_minmax(0,1.3fr)_minmax(0,1.1fr)_9rem_8rem_7rem]';
