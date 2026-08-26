// All persisted record shapes (Dexie tables). SPEC §5.
// Monetary amounts are ALWAYS integers in the currency's minor units (SPEC §6).

export type AccountType = 'current' | 'savings' | 'credit_card' | 'cash' | 'loan' | 'investment';
export type TxStatus = 'cleared' | 'pending';
export type CategoryKind = 'income' | 'expense';
export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string; // ISO code, e.g. 'GBP'
  openingBalanceMinor: number;
  colour: string; // hex
  groupId: string | null;
  sortOrder: number;
  archived: boolean;
  /**
   * Show the account, but leave it OUT of net-worth totals.
   *
   * What it does and does not do: it changes what a TOTAL counts, and nothing
   * else. The account keeps its own balance, every transaction is untouched,
   * and no amount anywhere is re-computed. Category-based reports (spending,
   * income, cash flow, payee, tag) group by CATEGORY, not by account, and are
   * deliberately unaffected — a gift card you spend is still spending.
   * The account stays VISIBLE with its balance shown: "not counted" is not
   * "hidden", and the user must never be unable to find their money.
   * It composes with `archived` (archived OR excluded ⇒ not counted); the two
   * are independent — archiving retires an account, excluding only re-scopes
   * the headline figure.
   *
   * THE FLAG LIVES ON THE ACCOUNT, and this is the single source of truth.
   * A group-level control is a BULK ACTION that writes this field on every
   * account currently in that group (setGroupExcluded in domain/accounts.ts) —
   * it is a snapshot, not a rule, so an account moved into the group later is
   * unaffected. A second, group-level flag was considered and REJECTED: with
   * two independent flags, un-excluding one account inside an excluded group
   * has no obvious correct answer (does the account win, or the group?), and a
   * finance app must never leave the user guessing which of two switches is
   * deciding their net worth.
   *
   * OPTIONAL ON PURPOSE — undefined means false. Every account row written by
   * an earlier build, and every account row inside an older backup file, lacks
   * this key entirely; treating undefined as false makes those rows already
   * correct, so no Dexie migration and no SCHEMA_VERSION bump is needed. That
   * holds only because the field is NOT INDEXED: the accounts store is
   * declared `'id, groupId, archived'` in src/db/db.ts, and IndexedDB only
   * cares about a schema change when the set of indexes changes. Backups keep
   * round-tripping too, since they store whole rows (src/backup/backup.ts).
   * If this ever needs an index, that IS a migration — bump the version.
   */
  excludeFromNetWorth?: boolean;
  // Loan fields (Phase 2 amortisation view)
  loanPrincipalMinor?: number;
  loanRatePct?: number;
  loanTermMonths?: number;
}

export interface AccountGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Split {
  categoryId: string | null;
  amountMinor: number; // signed, same convention as parent
  notes?: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string; // 'YYYY-MM-DD' (calendar date, timezone-proof)
  amountMinor: number; // signed: expenses negative, income positive
  currency: string; // == account currency
  payeeId: string | null;
  categoryId: string | null; // null for transfers and uncategorised
  tagIds: string[];
  notes: string;
  status: TxStatus;
  splits: Split[]; // non-empty ⇒ must sum exactly to amountMinor
  transferGroupId: string | null; // two legs share one id
  importBatchId: string | null;
  dedupeHash: string; // normalised accountId|date|amount|payee-or-desc (D10)
  createdAt: string; // ISO timestamp
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  icon?: string;
  colour?: string;
  archived: boolean;
  sortOrder: number;
}

export interface Payee {
  id: string;
  name: string;
  nameLower: string; // for case-insensitive lookup/index
  defaultCategoryId: string | null; // learned (SPEC §7.4)
}

export interface Tag {
  id: string;
  name: string;
  nameLower: string;
}

export interface Budget {
  id: string;
  name: string;
  categoryIds: string[]; // descendants included when computing spend (D16)
  amountMinor: number; // in base currency (D22)
  period: BudgetPeriod;
  startDate: string; // 'YYYY-MM-DD' anchor for period windows
  rollover: boolean; // Phase 2; stored now for forward-compat
  archived: boolean;
}

// {base, quote, rate}: 1 unit of `base` = `rate` units of `quote` (D11).
export interface FxRate {
  id: string; // `${base}:${quote}`
  base: string;
  quote: string;
  rate: number;
  asOf: string; // ISO timestamp
  source: 'manual' | 'auto';
}

export interface ImportBatch {
  id: string;
  source: 'moneywiz' | 'csv' | 'sample';
  fileName: string;
  rowCount: number;
  importedAt: string;
  // recorded so undo can also remove entities the import created (D18)
  createdAccountIds: string[];
  createdCategoryIds: string[];
  createdPayeeIds: string[];
  createdTagIds: string[];
  createdGroupIds: string[];
  // only the sample-data batch creates these (D19)
  createdBudgetIds?: string[];
  createdFxRateIds?: string[];
}

// Saved generic-CSV column mapping, persisted per file signature (SPEC §7.2)
export interface ColumnMapping {
  // column indices into the CSV row; -1 = not present
  date: number;
  amount: number; // used when debit/credit are -1
  debit: number; // money out (stored negative)
  credit: number; // money in (stored positive)
  payee: number;
  description: number;
  category: number;
  account: number;
  currency: number;
  tags: number;
  notes: number;
  dateFormat: 'auto' | 'DMY' | 'MDY' | 'YMD';
  decimal: 'auto' | 'dot' | 'comma';
  negate: boolean; // flip the sign of single-column amounts
  headerRow: boolean;
}

export interface Settings {
  id: 'app';
  schemaVersion: number;
  baseCurrency: string;
  theme: ThemeChoice;
  lastBackupAt: string | null;
  onboarded: boolean;
  lastUsedAccountId: string | null;
  savedMappings: Record<string, ColumnMapping>; // key = file signature
  createdAt: string;
  /**
   * Live FX rates (D34). SPEC §8.2 lists auto rates as Phase 2; pulled forward
   * at Girish's request. When enabled the app makes ONE outbound request to a
   * free, no-key rates source — the single network call SPEC §2.3 permits.
   * Manual rates are never overwritten by it.
   */
  autoFxEnabled: boolean;
  lastFxSyncAt: string | null;
  /** Human-readable name of the source that last supplied rates. */
  lastFxSyncSource: string | null;
}
