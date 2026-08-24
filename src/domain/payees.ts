// Payees with learned default categories (SPEC §7.4, D17). CONTRACT —
// implemented by the domain build agent.
import type { Payee } from '../db/types';

/** Case/whitespace-insensitive lookup by name; creates when missing. */
export async function getOrCreatePayee(name: string): Promise<Payee> {
  void name;
  throw new Error('not implemented');
}

/** Prefix-then-substring ranked matches for autocomplete. */
export async function searchPayees(query: string, limit = 8): Promise<Payee[]> {
  void query;
  void limit;
  throw new Error('not implemented');
}

/**
 * Recompute defaultCategoryId as the most frequent category across this
 * payee's transactions (ties → most recent). Called after saves/imports.
 */
export async function learnPayeeCategory(payeeId: string): Promise<void> {
  void payeeId;
  throw new Error('not implemented');
}

/** Manual override from the Settings rules list. */
export async function setPayeeDefaultCategory(
  payeeId: string,
  categoryId: string | null,
): Promise<void> {
  void payeeId;
  void categoryId;
  throw new Error('not implemented');
}

export async function renamePayee(payeeId: string, name: string): Promise<void> {
  void payeeId;
  void name;
  throw new Error('not implemented');
}

/** Delete only when unused; otherwise {ok:false, reason}. */
export async function deletePayee(payeeId: string): Promise<{ ok: boolean; reason?: string }> {
  void payeeId;
  throw new Error('not implemented');
}
