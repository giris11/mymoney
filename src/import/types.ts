// Shared types for the import pipeline (SPEC §7). Flow:
//   file text → ParsedRow[] (format-specific parser)
//             → ImportPlan (dedupe + entity resolution; NOTHING written yet)
//             → preview UI (user decisions)
//             → commitImport (one ImportBatch, undoable as a unit)
import type { ColumnMapping, Transaction } from '../db/types';

export type { ColumnMapping };

/** One normalised data row from any import format. */
export interface ParsedRow {
  /** 1-based data-row number in the source file (for error display). */
  index: number;
  date: string | null; // 'YYYY-MM-DD'; null = unparseable
  amountMinor: number | null; // signed; null = unparseable
  currency: string | null; // from file, or null → account/default currency
  accountName: string | null; // from file; null when a fixed account is chosen
  payeeName: string | null;
  description: string | null;
  categoryPath: string[]; // e.g. ['Food & Drink', 'Groceries']; [] = none
  tags: string[];
  notes: string | null;
  /** MoneyWiz "Transfers" column: the other account's name, else null. */
  transferAccountName: string | null;
  /**
   * The raw amount cell exactly as it appeared. A parser must pick a currency
   * BEFORE the row's account is known, so its minor-unit scale can be wrong
   * (a ¥500 row parsed at 2 decimals becomes ¥5.00, and a valid 3-decimal
   * "12.345" is rejected outright). buildImportPlan re-derives the amount from
   * this text once the account — and therefore the real currency — is known.
   * null ⇒ no single cell produced the amount (debit AND credit both filled,
   * or no amount column at all), so it cannot be re-derived.
   */
  amountText: string | null;
  /** How amountText becomes a signed amount: keep the sign it carries, flip it
   * (mapping.negate), or force a negative magnitude (a debit column). */
  amountRule?: 'as-written' | 'flip' | 'debit';
  /** Why this row can't be imported (bad date/amount), else null. */
  error: string | null;
}

export type RowAction = 'import' | 'skip_exact_duplicate' | 'needs_decision' | 'error';

export interface ImportPlanRow {
  row: ParsedRow;
  action: RowAction;
  /** Existing transaction this row nearly duplicates (when needs_decision). */
  nearDuplicateOf?: Transaction;
  /** User's choice for needs_decision rows; default 'skip' until decided. */
  decision?: 'import' | 'skip';
  /** Auto-categorisation suggestion (payee → learned category), if any. */
  suggestedCategoryId?: string | null;
  /** Category actually applied (user may override in preview). */
  chosenCategoryId?: string | null;
  /** Resolved account id, or undefined when the account is new (see plan.newAccounts). */
  accountId?: string;
  /** Index (into plan.rows) of the paired transfer leg, when detected. */
  transferPairIndex?: number;
  /** The file declared a currency other than the account's. The amount is
   * still stored in the ACCOUNT's currency (never a guessed conversion). */
  currencyMismatch?: boolean;
}

export interface NewAccountPlan {
  name: string;
  currency: string;
  /** User can untick creation in the preview; rows for it then error out. */
  create: boolean;
}

export interface ImportPlan {
  source: 'moneywiz' | 'csv';
  fileName: string;
  rows: ImportPlanRow[];
  newAccounts: NewAccountPlan[];
  newCategoryPaths: string[][];
  newPayees: string[];
  newTags: string[];
  exactDuplicateCount: number;
  nearDuplicateCount: number;
  errorCount: number;
  /** Importable rows whose file currency differs from their account's: the
   * amount is stored as the account's currency and the file's currency is
   * noted on the transaction, so the preview can say so honestly (SPEC §6). */
  currencyMismatchCount: number;
  /** Rows that will be written if committed now (respects decisions). */
  importableCount: number;
}
