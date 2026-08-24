// Transaction domain logic (SPEC §8.1.2). CONTRACT — implemented by the
// domain build agent; signatures and documented semantics are fixed.
//
// Semantics:
//  * amounts: signed integer minor units; expenses negative, income positive;
//    refunds are POSITIVE amounts in an EXPENSE category (D14).
//  * splits: when non-empty they MUST sum exactly to amountMinor — reject saves
//    that violate this (SPEC §6).
//  * transfers: two legs share transferGroupId; from-leg negative, to-leg
//    positive, each in its own account's currency; categoryId null on both.
//    Editing a transfer syncs both legs; cross-currency amounts are BOTH
//    explicit, never derived from a rate (SPEC §5).
//  * dedupeHash is recomputed on every save (see src/import/dedupe.ts).
//  * saving with a payee learns/updates payee.defaultCategoryId (D17).
import type { Split, Transaction, TxStatus } from '../db/types';

export class ValidationError extends Error {}

export interface SaveTransactionInput {
  id?: string; // present = update
  accountId: string;
  date: string; // 'YYYY-MM-DD'
  amountMinor: number;
  payeeName?: string | null; // looked up/created case-insensitively; null/'' = none
  categoryId?: string | null;
  tagNames?: string[]; // looked up/created case-insensitively
  notes?: string;
  status?: TxStatus; // default 'cleared'
  splits?: Split[];
  importBatchId?: string | null;
}

/** Returns an error message, or null when valid. */
export function validateSplits(amountMinor: number, splits: Split[]): string | null {
  void amountMinor;
  void splits;
  throw new Error('not implemented');
}

/** Create or update a normal (non-transfer) transaction. Throws ValidationError. */
export async function saveTransaction(input: SaveTransactionInput): Promise<Transaction> {
  void input;
  throw new Error('not implemented');
}

/** Delete a transaction; a transfer leg deletes BOTH legs. */
export async function deleteTransaction(id: string): Promise<void> {
  void id;
  throw new Error('not implemented');
}

export interface SaveTransferInput {
  transferGroupId?: string; // present = update existing transfer
  fromAccountId: string;
  toAccountId: string;
  date: string;
  /** Positive magnitude leaving `from`, in the from-account's currency. */
  amountFromMinor: number;
  /** Positive magnitude arriving in `to`, in the to-account's currency. */
  amountToMinor: number;
  notes?: string;
  status?: TxStatus;
}

/** Create or update a transfer pair. Returns [fromLeg, toLeg]. */
export async function saveTransfer(input: SaveTransferInput): Promise<[Transaction, Transaction]> {
  void input;
  throw new Error('not implemented');
}

export async function getTransferPair(
  transferGroupId: string,
): Promise<[Transaction, Transaction] | null> {
  void transferGroupId;
  throw new Error('not implemented');
}

export interface TxFilter {
  accountIds?: string[];
  /** Selecting a category includes all its descendants. */
  categoryIds?: string[];
  payeeIds?: string[];
  tagIds?: string[];
  dateFrom?: string; // inclusive
  dateTo?: string; // inclusive
  /** Applied to |amountMinor|, in the transaction's own currency. */
  amountMinMinor?: number;
  amountMaxMinor?: number;
  status?: TxStatus;
  /** Case-insensitive match on payee name, notes, and category name. */
  text?: string;
  limit?: number;
}

/**
 * Query transactions sorted date DESC then createdAt DESC.
 * Uses Dexie indexes for the most selective criterion, filters the rest.
 */
export async function queryTransactions(filter?: TxFilter): Promise<Transaction[]> {
  void filter;
  throw new Error('not implemented');
}
