// Duplicating a transaction — "same thing again", in two clicks.
//
// Everything that decides what a copy CONTAINS lives here as pure functions,
// with no React and no Dexie: the app has no DOM test environment, so the only
// way to cover this properly is to keep the logic out of the component and test
// it directly (same pattern as `categoryAfterPayeePick` in QuickAddSheet and
// `accountsStepError` in AccountsStep). `TxEditor` and the register row are
// then thin wiring around these functions.
//
// What a copy is: a brand-new MANUAL transaction. It carries every field the
// user typed — amount, type, category, payee, account, tags, notes, status,
// splits — and none of the identity/provenance fields (`id`, `importBatchId`,
// `transferGroupId`, `createdAt`/`updatedAt`). Those simply do not exist on a
// draft, so saving a copy can only ever INSERT: `saveTransaction` updates a row
// when it is handed an `id`, and `draftToSaveInput` only sets one when the
// editor is editing (see TxEditor's Save).
import type { Category, CategoryKind, Payee, Tag, Transaction, TxStatus } from '../../db/types';
import type { SaveTransactionInput } from '../../domain/transactions';
import type { TransferDraft } from './TransferFields';
import type { TxKind } from './txShared';

/** One row of the editor's splits table. `key` is the React list key only. */
export interface SplitDraft {
  key: number;
  categoryId: string | null;
  /** Positive magnitude; the parent's sign is applied on save. */
  amountMinor: number | null;
  notes: string;
}

/**
 * The part of the editor's form state that a normal (non-transfer) save reads.
 * Amounts are positive magnitudes here — sign comes from `mode`/`refund` — which
 * is exactly how the editor's inputs behave.
 */
export interface TxSaveDraft {
  mode: TxKind;
  amountMinor: number | null;
  refund: boolean;
  categoryId: string | null;
  payeeName: string;
  accountId: string;
  date: string; // 'YYYY-MM-DD'
  tagNames: string[];
  notes: string;
  pending: boolean;
  splits: SplitDraft[];
}

/** A whole prefilled editor form. */
export interface TxDraft extends TxSaveDraft {
  /** Set for a transfer copy; null lets the editor seed an empty transfer draft. */
  transfer: TransferDraft | null;
  /**
   * The original's date, when the copy is NOT dated the same day; null when
   * they match.
   *
   * DATE POLICY: a copy is dated TODAY, not the original's date. The reason to
   * duplicate is "I bought that again", so today is right in the overwhelming
   * majority of cases and typing the date is the thing the owner wants to stop
   * doing. The risk it creates is the opposite one — a copy of an old row
   * quietly saved under today's date — so the copy is never silent about it:
   * the editor opens for review, is titled "New transaction (copy)", and shows
   * this original date next to the date field with one click to adopt it.
   */
  sourceDate: string | null;
}

/** The looked-up bits of the original a copy needs but the row itself lacks. */
export interface DuplicateContext {
  /** The original's payee name; '' when it had none. */
  payeeName: string;
  /** The original's tag names, in the transaction's own order. */
  tagNames: string[];
  /**
   * Kind of the original's category — or of its first categorised split, for a
   * split transaction. It is what separates income from a refund: a POSITIVE
   * amount in an EXPENSE category is a refund (D14), and only the category
   * knows which it was.
   */
  categoryKind: CategoryKind | null;
  /** Both legs (from = the negative one) when the original is a transfer leg. */
  transferPair: [from: Transaction, to: Transaction] | null;
}

/** Sign the editor applies to its magnitudes on save: income and refunds are +. */
export function draftSign(mode: TxKind, refund: boolean): 1 | -1 {
  return mode === 'income' || refund ? 1 : -1;
}

/**
 * The category a copy takes its income/refund cue from: the transaction's own,
 * or the first categorised split when it is a split transaction.
 */
export function copyCategoryId(tx: Transaction): string | null {
  return tx.categoryId ?? tx.splits.find((s) => s.categoryId)?.categoryId ?? null;
}

/**
 * Resolve the names/kind a copy needs from the maps the register already holds.
 * `transferPair` is passed in because it is a database read, not a lookup.
 */
export function duplicateContextFrom(
  tx: Transaction,
  maps: {
    payeesById: Map<string, Payee>;
    tagsById: Map<string, Tag>;
    categoriesById: Map<string, Category>;
  },
  transferPair: [Transaction, Transaction] | null,
): DuplicateContext {
  const catId = copyCategoryId(tx);
  return {
    payeeName: (tx.payeeId !== null ? maps.payeesById.get(tx.payeeId)?.name : '') ?? '',
    tagNames: tx.tagIds
      .map((id) => maps.tagsById.get(id)?.name)
      .filter((n): n is string => n !== undefined),
    categoryKind: (catId !== null ? maps.categoriesById.get(catId)?.kind : null) ?? null,
    transferPair,
  };
}

/**
 * Build the editor draft for a copy of `tx`, dated `today`.
 *
 * Pure, and it never touches `tx`: every array and object in the result is
 * freshly built, so the copy cannot alias the original's splits or tags.
 *
 * Split amounts are copied as positive magnitudes (`|amount|`), the editor's
 * convention, so they still sum EXACTLY to the drafted amount and go back out
 * with the parent's sign on save (SPEC §6). That mirrors what the editor does
 * when it loads a transaction for editing; splits whose sign opposes their
 * parent are not representable in this editor either way.
 */
export function duplicateDraftFrom(
  tx: Transaction,
  ctx: DuplicateContext,
  today: string,
): TxDraft {
  const common = {
    date: today,
    sourceDate: tx.date === today ? null : tx.date,
    notes: tx.notes,
    pending: tx.status === 'pending',
  };

  // A transfer leg copies as a whole PAIR: both accounts and both amounts, so
  // saveTransfer writes two new legs under a new transferGroupId rather than
  // leaving an orphan leg behind. Cross-currency keeps both explicit amounts
  // as typed — no rate is ever applied (SPEC §5).
  if (ctx.transferPair) {
    const [from, to] = ctx.transferPair;
    return {
      ...common,
      mode: 'transfer',
      amountMinor: null,
      refund: false,
      categoryId: null,
      payeeName: '',
      accountId: from.accountId,
      tagNames: [],
      splits: [],
      transfer: {
        fromAccountId: from.accountId,
        toAccountId: to.accountId,
        amountFromMinor: Math.abs(from.amountMinor),
        amountToMinor: Math.abs(to.amountMinor),
      },
    };
  }

  const refund = tx.amountMinor > 0 && ctx.categoryKind === 'expense';
  return {
    ...common,
    mode: tx.amountMinor > 0 && !refund ? 'income' : 'expense',
    amountMinor: Math.abs(tx.amountMinor),
    refund,
    categoryId: tx.categoryId,
    payeeName: ctx.payeeName,
    accountId: tx.accountId,
    tagNames: [...ctx.tagNames],
    splits: tx.splits.map((sp, i) => ({
      key: i,
      categoryId: sp.categoryId,
      amountMinor: Math.abs(sp.amountMinor),
      notes: sp.notes ?? '',
    })),
    transfer: null,
  };
}

/**
 * Editor form → `saveTransaction` input. `id` is the ONLY thing that makes a
 * save an update; a copy passes none, so it can only insert.
 */
export function draftToSaveInput(d: TxSaveDraft, id?: string): SaveTransactionInput {
  if (d.amountMinor === null || !Number.isSafeInteger(d.amountMinor) || d.amountMinor === 0) {
    throw new Error('Enter an amount');
  }
  const sign = draftSign(d.mode, d.refund);
  const status: TxStatus = d.pending ? 'pending' : 'cleared';
  const input: SaveTransactionInput = {
    accountId: d.accountId,
    date: d.date,
    amountMinor: sign * Math.abs(d.amountMinor),
    payeeName: d.payeeName || null,
    // A split transaction's categories live on its splits, never on the parent.
    categoryId: d.splits.length > 0 ? null : d.categoryId,
    tagNames: d.tagNames,
    notes: d.notes,
    status,
    splits: d.splits.map((s) => ({
      categoryId: s.categoryId,
      amountMinor: sign * Math.abs(s.amountMinor ?? 0),
      ...(s.notes ? { notes: s.notes } : {}),
    })),
  };
  if (id !== undefined) input.id = id;
  return input;
}
