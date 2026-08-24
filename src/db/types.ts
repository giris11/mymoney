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
}
