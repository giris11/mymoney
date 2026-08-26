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
import type { Collection } from 'dexie';
import { db, updateSettings } from '../db/db';
import type { Split, Transaction, TxStatus } from '../db/types';
import { makeDedupeHash } from '../import/dedupe';
import { nowISO, uid } from '../lib/util';
import { formatMinor, sumSplits } from '../money/money';
import { descendantIds } from './categories';
import { getOrCreatePayee, learnPayeeCategory } from './payees';
import { getOrCreateTags } from './tags';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True iff `date` is a real calendar date in 'YYYY-MM-DD' form. */
export function isValidDateString(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  // round-trip guard against lenient engines (e.g. 2026-02-30)
  return new Date(parsed).toISOString().slice(0, 10) === date;
}

/**
 * Returns an error message, or null when valid. `currency` is optional only so
 * existing callers keep working — pass it wherever the message reaches a user,
 * so the numbers read as money ("£60.00") rather than raw minor units.
 */
export function validateSplits(
  amountMinor: number,
  splits: Split[],
  currency?: string,
): string | null {
  if (splits.length === 0) return null;
  for (const s of splits) {
    if (!Number.isSafeInteger(s.amountMinor)) {
      return 'Each split amount must be a whole number';
    }
  }
  const total = sumSplits(splits);
  if (total !== amountMinor) {
    const show = (v: number) => (currency ? formatMinor(v, currency) : String(v));
    return `Splits must add up to the transaction amount exactly — they come to ${show(
      total,
    )}, but the transaction is ${show(amountMinor)}`;
  }
  return null;
}

/** Create or update a normal (non-transfer) transaction. Throws ValidationError. */
export async function saveTransaction(input: SaveTransactionInput): Promise<Transaction> {
  if (!isValidDateString(input.date)) {
    throw new ValidationError(`Invalid date “${input.date}” — expected YYYY-MM-DD`);
  }
  if (!Number.isSafeInteger(input.amountMinor)) {
    throw new ValidationError('Amount must be a whole number of minor units (pence/cents)');
  }
  const splits = input.splits ?? [];
  const splitError = validateSplits(input.amountMinor, splits);
  if (splitError) throw new ValidationError(splitError);

  return db.transaction(
    'rw',
    db.transactions,
    db.accounts,
    db.payees,
    db.tags,
    db.settings,
    async () => {
      const account = await db.accounts.get(input.accountId);
      if (!account) throw new ValidationError('Account not found');

      const existing = input.id ? await db.transactions.get(input.id) : undefined;
      if (input.id && !existing) throw new ValidationError('Transaction not found');
      if (existing && existing.transferGroupId !== null) {
        throw new ValidationError(
          'This transaction is one leg of a transfer — edit it in the transfer editor instead',
        );
      }

      const payeeName = (input.payeeName ?? '').trim().replace(/\s+/g, ' ');
      const payee = payeeName ? await getOrCreatePayee(payeeName) : null;
      const tags = await getOrCreateTags(input.tagNames ?? []);
      const notes = input.notes ?? '';
      // Hash input: payee name when present, else notes/description, else ''
      // — same rule the importer follows, so re-imports match manual entries.
      const hashSource = payee ? payee.name : notes;
      const now = nowISO();

      const tx: Transaction = {
        id: existing?.id ?? uid(),
        accountId: input.accountId,
        date: input.date,
        amountMinor: input.amountMinor,
        currency: account.currency,
        payeeId: payee?.id ?? null,
        categoryId: input.categoryId ?? null,
        tagIds: tags.map((t) => t.id),
        notes,
        status: input.status ?? 'cleared',
        splits,
        transferGroupId: null,
        importBatchId:
          input.importBatchId !== undefined ? input.importBatchId : (existing?.importBatchId ?? null),
        dedupeHash: makeDedupeHash(input.accountId, input.date, input.amountMinor, hashSource),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await db.transactions.put(tx);
      if (payee) await learnPayeeCategory(payee.id);
      await updateSettings({ lastUsedAccountId: input.accountId });
      return tx;
    },
  );
}

/** Delete a transaction; a transfer leg deletes BOTH legs. */
export async function deleteTransaction(id: string): Promise<void> {
  await db.transaction('rw', db.transactions, async () => {
    const tx = await db.transactions.get(id);
    if (!tx) return;
    if (tx.transferGroupId !== null) {
      await db.transactions.where('transferGroupId').equals(tx.transferGroupId).delete();
    } else {
      await db.transactions.delete(id);
    }
  });
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
  if (!isValidDateString(input.date)) {
    throw new ValidationError(`Invalid date “${input.date}” — expected YYYY-MM-DD`);
  }
  if (input.fromAccountId === input.toAccountId) {
    throw new ValidationError('A transfer needs two different accounts');
  }
  if (!Number.isSafeInteger(input.amountFromMinor) || input.amountFromMinor <= 0) {
    throw new ValidationError('The amount sent must be a positive whole number of minor units');
  }
  if (!Number.isSafeInteger(input.amountToMinor) || input.amountToMinor <= 0) {
    throw new ValidationError('The amount received must be a positive whole number of minor units');
  }

  return db.transaction('rw', db.transactions, db.accounts, async () => {
    const [fromAccount, toAccount] = await Promise.all([
      db.accounts.get(input.fromAccountId),
      db.accounts.get(input.toAccountId),
    ]);
    if (!fromAccount) throw new ValidationError('From account not found');
    if (!toAccount) throw new ValidationError('To account not found');

    let fromExisting: Transaction | undefined;
    let toExisting: Transaction | undefined;
    let groupId = input.transferGroupId;
    if (groupId) {
      const legs = await db.transactions.where('transferGroupId').equals(groupId).toArray();
      if (legs.length !== 2) throw new ValidationError('Transfer not found');
      fromExisting = legs.find((l) => l.amountMinor < 0);
      toExisting = legs.find((l) => l.amountMinor > 0);
      if (!fromExisting || !toExisting) throw new ValidationError('Transfer legs are inconsistent');
    } else {
      groupId = uid();
    }

    const now = nowISO();
    const notes = input.notes ?? '';
    const status: TxStatus = input.status ?? 'cleared';

    const fromLeg: Transaction = {
      id: fromExisting?.id ?? uid(),
      accountId: input.fromAccountId,
      date: input.date,
      amountMinor: -input.amountFromMinor,
      currency: fromAccount.currency,
      payeeId: null,
      categoryId: null,
      tagIds: [],
      notes,
      status,
      splits: [],
      transferGroupId: groupId,
      importBatchId: fromExisting?.importBatchId ?? null,
      dedupeHash: makeDedupeHash(
        input.fromAccountId,
        input.date,
        -input.amountFromMinor,
        `Transfer to ${toAccount.name}`,
      ),
      createdAt: fromExisting?.createdAt ?? now,
      updatedAt: now,
    };
    const toLeg: Transaction = {
      id: toExisting?.id ?? uid(),
      accountId: input.toAccountId,
      date: input.date,
      amountMinor: input.amountToMinor,
      currency: toAccount.currency,
      payeeId: null,
      categoryId: null,
      tagIds: [],
      notes,
      status,
      splits: [],
      transferGroupId: groupId,
      importBatchId: toExisting?.importBatchId ?? null,
      dedupeHash: makeDedupeHash(
        input.toAccountId,
        input.date,
        input.amountToMinor,
        `Transfer from ${fromAccount.name}`,
      ),
      createdAt: toExisting?.createdAt ?? now,
      updatedAt: now,
    };
    await db.transactions.bulkPut([fromLeg, toLeg]);
    return [fromLeg, toLeg];
  });
}

export async function getTransferPair(
  transferGroupId: string,
): Promise<[Transaction, Transaction] | null> {
  const legs = await db.transactions.where('transferGroupId').equals(transferGroupId).toArray();
  if (legs.length !== 2) return null;
  const from = legs.find((l) => l.amountMinor < 0);
  const to = legs.find((l) => l.amountMinor > 0);
  if (!from || !to) return null;
  return [from, to];
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
 * `where(index)` narrowed to `ids` — `.equals()` for a single id, `.anyOf()`
 * for several.
 *
 * `anyOf()` has to merge N key ranges and walk them in sorted order even when
 * N is 1; `.equals()` is one plain range and is never the slower of the two.
 * Single-id lookups are the common case (clicking one account in the sidebar,
 * drilling into one payee or tag from a report), so they get the cheap path.
 */
function equalsOrAnyOf(index: string, ids: string[]): Collection<Transaction, string> {
  const where = db.transactions.where(index);
  return ids.length === 1 ? where.equals(ids[0]!) : where.anyOf(ids);
}

/**
 * Query transactions sorted date DESC then createdAt DESC.
 * Uses Dexie indexes for the most selective criterion, filters the rest:
 *  * account filter + date range → [accountId+date] compound range per account;
 *  * date range alone → `date` index range;
 *  * account filter alone → `accountId` index;
 *  * payee / tag filter alone → their indexes;
 *  * otherwise full scan (unavoidable: category/text/amount need row data).
 *
 * SCALE (SPEC §9): every branch but the last narrows IN THE INDEX, so the cost
 * is proportional to the matches rather than to the table. That is why the
 * register always sends a date range (see `defaultRegisterRange()` in
 * `src/ui/tx/txShared.ts`) — an unfiltered call really does read all 100k rows.
 */
export async function queryTransactions(filter?: TxFilter): Promise<Transaction[]> {
  const f = filter ?? {};
  const hasAccounts = !!f.accountIds && f.accountIds.length > 0;
  const hasDate = f.dateFrom !== undefined || f.dateTo !== undefined;
  const lo = f.dateFrom ?? '';
  const hi = f.dateTo ?? '\uffff';

  let rows: Transaction[];
  let dateApplied = false;
  let accountApplied = false;

  if (hasAccounts && hasDate) {
    const ids = f.accountIds!;
    if (ids.length === 1) {
      // One account — the sidebar click. A single compound range: no
      // per-chunk promises and no flattening copy of the result array.
      const acc = ids[0]!;
      rows = await db.transactions
        .where('[accountId+date]')
        .between([acc, lo], [acc, hi], true, true)
        .toArray();
    } else {
      const chunks = await Promise.all(
        ids.map((acc) =>
          db.transactions
            .where('[accountId+date]')
            .between([acc, lo], [acc, hi], true, true)
            .toArray(),
        ),
      );
      rows = chunks.flat();
    }
    dateApplied = true;
    accountApplied = true;
  } else if (hasDate) {
    rows = await db.transactions.where('date').between(lo, hi, true, true).toArray();
    dateApplied = true;
  } else if (hasAccounts) {
    rows = await equalsOrAnyOf('accountId', f.accountIds!).toArray();
    accountApplied = true;
  } else if (f.payeeIds && f.payeeIds.length > 0) {
    // payeeId index never contains null — fine, null payees can't match anyway
    rows = await equalsOrAnyOf('payeeId', f.payeeIds).toArray();
  } else if (f.tagIds && f.tagIds.length > 0) {
    // multiEntry index: distinct() in both shapes, so a row that somehow
    // carries the same tag twice is still returned once.
    rows = await equalsOrAnyOf('tagIds', f.tagIds).distinct().toArray();
  } else {
    rows = await db.transactions.toArray();
  }

  // Category filter expands to all descendants (D16); a transaction matches if
  // its own categoryId OR any split's categoryId is in the expanded set.
  let catSet: Set<string> | null = null;
  if (f.categoryIds && f.categoryIds.length > 0) {
    catSet = descendantIds(await db.categories.toArray(), f.categoryIds);
  }

  // Text search: resolve matching payee/category id-sets once, then filter.
  let needle = '';
  let textPayeeIds: Set<string> | null = null;
  let textCatIds: Set<string> | null = null;
  if (f.text && f.text.trim()) {
    needle = f.text.trim().toLowerCase();
    const [payees, cats] = await Promise.all([db.payees.toArray(), db.categories.toArray()]);
    textPayeeIds = new Set(payees.filter((p) => p.nameLower.includes(needle)).map((p) => p.id));
    textCatIds = new Set(
      cats.filter((c) => c.name.toLowerCase().includes(needle)).map((c) => c.id),
    );
  }

  const payeeSet = f.payeeIds && f.payeeIds.length > 0 ? new Set(f.payeeIds) : null;
  const tagSet = f.tagIds && f.tagIds.length > 0 ? new Set(f.tagIds) : null;
  const accountSet = hasAccounts ? new Set(f.accountIds) : null;

  rows = rows.filter((t) => {
    if (!accountApplied && accountSet && !accountSet.has(t.accountId)) return false;
    if (!dateApplied && hasDate && (t.date < lo || t.date > hi)) return false;
    if (catSet) {
      const own = t.categoryId !== null && catSet.has(t.categoryId);
      const inSplit = t.splits.some((s) => s.categoryId !== null && catSet.has(s.categoryId));
      if (!own && !inSplit) return false;
    }
    if (payeeSet && (t.payeeId === null || !payeeSet.has(t.payeeId))) return false;
    if (tagSet && !t.tagIds.some((id) => tagSet.has(id))) return false;
    if (f.status && t.status !== f.status) return false;
    const abs = Math.abs(t.amountMinor);
    if (f.amountMinMinor !== undefined && abs < f.amountMinMinor) return false;
    if (f.amountMaxMinor !== undefined && abs > f.amountMaxMinor) return false;
    if (needle) {
      const inNotes = t.notes.toLowerCase().includes(needle);
      const inPayee = t.payeeId !== null && textPayeeIds!.has(t.payeeId);
      const inCat =
        (t.categoryId !== null && textCatIds!.has(t.categoryId)) ||
        t.splits.some((s) => s.categoryId !== null && textCatIds!.has(s.categoryId));
      if (!inNotes && !inPayee && !inCat) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return 0;
  });

  return f.limit !== undefined ? rows.slice(0, Math.max(0, f.limit)) : rows;
}
