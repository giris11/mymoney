// Shared state/types/helpers for the Transactions area (register, editor,
// quick add). UI-only — all domain logic stays in src/domain/*.
import dayjs from 'dayjs';
import type { Transaction, TxStatus } from '../../db/types';
import type { TxFilter } from '../../domain/transactions';
import { formatDate, todayISO } from '../../lib/util';
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

/**
 * How much history the register shows before you ask for more (SPEC §9).
 *
 * With no date range at all, `queryTransactions` has nothing to narrow on and
 * reads the ENTIRE transactions table, sorting it in JS — measured at 185ms
 * for a 50k ledger against 10ms for a one-month window, on every keystroke and
 * after every write. So the register opens on a window, and the window uses
 * the `date` index.
 *
 * 90 days, not "this month" or "this year": it covers the current month plus
 * the two before it whatever the calendar says, which is enough to reconcile a
 * statement, chase a refund or find "that thing I bought recently" — the daily
 * work the register exists for. A month-based default would collapse to a few
 * rows on the 1st of the month; a year-based one would silently grow to twelve
 * months of history by December.
 *
 * It is a visible, labelled state, not a hidden filter: the register prints
 * which window it is on (see `rangeSummary`) and offers one click to widen to
 * all dates — see Transactions.tsx.
 */
export const DEFAULT_RANGE_DAYS = 90;

/**
 * The register's opening window: the last DEFAULT_RANGE_DAYS days, open-ended
 * at the top.
 *
 * The `to` end is deliberately left empty rather than pinned to today —
 * a future-dated transaction (a cheque post-dated, a pending card charge) must
 * not disappear from the register the moment it is saved.
 */
export function defaultRegisterRange(today: string = todayISO()): DateRangeValue {
  return {
    from: dayjs(today)
      .subtract(DEFAULT_RANGE_DAYS - 1, 'day')
      .format('YYYY-MM-DD'),
    to: '',
  };
}

/** The default filter state — everything off EXCEPT the default date window. */
export function emptyFilters(): FilterState {
  return {
    text: '',
    accountId: '',
    categoryId: null,
    payeeId: null,
    payeeText: '',
    tagId: '',
    range: defaultRegisterRange(),
    minMinor: null,
    maxMinor: null,
    status: 'all',
  };
}

/** True when `range` is exactly the default window (i.e. nobody narrowed it). */
export function isDefaultRange(range: DateRangeValue | null): boolean {
  if (!range) return false;
  const d = defaultRegisterRange();
  return range.from === d.from && range.to === d.to;
}

/**
 * Count of non-search filters in effect (drives the mobile badge).
 * The default date window is not counted — it is the register's resting state,
 * shown in its own labelled line, not something the user switched on.
 */
export function countActiveFilters(f: FilterState): number {
  let n = 0;
  if (f.accountId) n += 1;
  if (f.categoryId) n += 1;
  if (f.payeeId) n += 1;
  if (f.tagId) n += 1;
  if (f.range && (f.range.from || f.range.to) && !isDefaultRange(f.range)) n += 1;
  if (f.minMinor !== null) n += 1;
  if (f.maxMinor !== null) n += 1;
  if (f.status !== 'all') n += 1;
  return n;
}

export function hasAnyFilter(f: FilterState): boolean {
  return countActiveFilters(f) > 0 || f.text.trim() !== '';
}

/**
 * True when something OTHER than the date window is narrowing the list — it
 * decides whether an empty register says "nothing in this date window" or
 * "nothing matches your filters".
 */
export function hasNonDateFilter(f: FilterState): boolean {
  return (
    f.accountId !== '' ||
    f.categoryId !== null ||
    f.payeeId !== null ||
    f.tagId !== '' ||
    f.minMinor !== null ||
    f.maxMinor !== null ||
    f.status !== 'all' ||
    f.text.trim() !== ''
  );
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

/**
 * Plain-English description of the window the register is showing, for the
 * status line above the list. The register is never on a date window without
 * saying so — an empty list must read as "nothing in this window", never be
 * mistaken for "you have no transactions".
 */
export function rangeSummary(range: DateRangeValue | null): string {
  if (!range || (!range.from && !range.to)) return 'all dates';
  if (isDefaultRange(range)) {
    return `the last ${DEFAULT_RANGE_DAYS} days (since ${formatDate(range.from)})`;
  }
  if (range.from && range.to) return `${formatDate(range.from)} – ${formatDate(range.to)}`;
  if (range.from) return `${formatDate(range.from)} onwards`;
  return `up to ${formatDate(range.to)}`;
}

/**
 * A transaction has to move money, so a typed zero is refused just as an empty
 * amount is (D4). Quick Add already refused zero on save; before this the full
 * editor's Save button stayed live on "0" and wrote a £0.00 row into the
 * register. Both entry points now share this rule.
 */
export function isSaveableAmount(minor: number | null): minor is number {
  return minor !== null && Number.isSafeInteger(minor) && minor !== 0;
}

/** Everything the editor's Save button depends on. */
export interface TxSaveGate {
  mode: TxKind;
  saving: boolean;
  /** Positive magnitude in the amount field; null = empty. Sign is applied on save. */
  amountMinor: number | null;
  accountId: string;
  splitCount: number;
  /** Message from validateSplits(), or null when the splits are fine. */
  splitIssue: string | null;
  transfer: {
    hasFromAccount: boolean;
    hasToAccount: boolean;
    amountFromMinor: number | null;
    amountToMinor: number | null;
    crossCurrency: boolean;
  };
}

/**
 * Whether the editor's Save button is disabled. Extracted from the component so
 * it can be tested — the app has no DOM test environment.
 *
 * A negative amount is deliberately NOT blocked here: the domain rejects it
 * with a message the user can read, which beats a dead button with no
 * explanation. Zero is blocked because there is nothing to explain — a
 * zero-amount transaction is never meaningful.
 */
export function txSaveDisabled(g: TxSaveGate): boolean {
  if (g.saving) return true;
  if (g.mode === 'transfer') {
    const t = g.transfer;
    if (!t.hasFromAccount || !t.hasToAccount) return true;
    if (!isSaveableAmount(t.amountFromMinor)) return true;
    return t.crossCurrency && !isSaveableAmount(t.amountToMinor);
  }
  if (!isSaveableAmount(g.amountMinor)) return true;
  if (!g.accountId) return true;
  return g.splitCount > 0 && g.splitIssue !== null;
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
