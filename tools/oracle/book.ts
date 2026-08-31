// A "book": the portable, fully-explicit statement of a set of records that a
// balance / budget / report case is computed over.
//
// The books in the emitted JSON are the INPUT half of those fixtures — a Swift
// harness loads one into its own store and then runs the case's op against it.
// So a book carries only fields that mean something to the money rules
// (SPEC §5/§6). Everything the TypeScript store needs on top — colours, dedupe
// hashes, created/updated timestamps, payee lowercase keys — is filled in
// HERE, deterministically, and never emitted: a Swift port has no obligation
// to have those columns, and putting them in the fixture would make it look
// like it did.
//
// Ids are written out by hand in every book, never minted with uid(). A
// fixture whose ids change on every generation could not be committed, and a
// failure that says "account acc-usd" is one a human can act on where "account
// 9f3c…" is not.
import { db, defaultSettings } from '../../src/db/db';
import { makeDedupeHash } from '../../src/import/dedupe';
import type {
  Account,
  AccountType,
  Category,
  CategoryKind,
  FxRate,
  Payee,
  Split,
  Tag,
  Transaction,
  TxStatus,
} from '../../src/db/types';

/** Every timestamp in a book. Fixed so regeneration is byte-identical. */
const FIXED_TIME = '2026-01-01T00:00:00.000Z';

export interface BookAccount {
  id: string;
  name: string;
  currency: string;
  openingBalanceMinor: number;
  type?: AccountType;
  archived?: boolean;
  excludeFromNetWorth?: boolean;
  sortOrder?: number;
}

export interface BookCategory {
  id: string;
  name: string;
  kind: CategoryKind;
  parentId?: string | null;
  archived?: boolean;
  sortOrder?: number;
}

export interface BookSplit {
  categoryId: string | null;
  amountMinor: number;
}

export interface BookTransaction {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  /** Omitted ⇒ the account's currency (SPEC §6: they are always equal). */
  currency?: string;
  payeeId?: string | null;
  categoryId?: string | null;
  tagIds?: string[];
  status?: TxStatus;
  splits?: BookSplit[];
  transferGroupId?: string | null;
  notes?: string;
}

export interface BookRate {
  base: string;
  quote: string;
  rate: number;
}

/** As written by a suite — most fields optional. */
export interface BookSource {
  baseCurrency: string;
  accounts: BookAccount[];
  categories?: BookCategory[];
  payees?: { id: string; name: string }[];
  tags?: { id: string; name: string }[];
  fxRates?: BookRate[];
  transactions?: BookTransaction[];
}

/** As emitted and as loaded — every field present and explicit. */
export interface Book {
  baseCurrency: string;
  fxRates: BookRate[];
  accounts: Required<BookAccount>[];
  categories: Required<BookCategory>[];
  payees: { id: string; name: string }[];
  tags: { id: string; name: string }[];
  transactions: BookTransactionFull[];
}

/** A transaction with every optional resolved — what the JSON book states. */
export interface BookTransactionFull {
  id: string;
  accountId: string;
  date: string;
  amountMinor: number;
  currency: string;
  payeeId: string | null;
  categoryId: string | null;
  tagIds: string[];
  status: TxStatus;
  splits: BookSplit[];
  transferGroupId: string | null;
  notes: string;
}

/**
 * Fill in every default so the emitted book states the whole input. A
 * transaction's currency is derived from its account when the source omits it
 * — that IS the rule (a transaction is denominated in its account's currency),
 * and deriving it once here keeps every book honest about it.
 */
export function materialiseBook(src: BookSource): Book {
  const currencyOf = new Map(src.accounts.map((a) => [a.id, a.currency] as const));
  return {
    baseCurrency: src.baseCurrency,
    fxRates: (src.fxRates ?? []).map((r) => ({ base: r.base, quote: r.quote, rate: r.rate })),
    accounts: src.accounts.map((a, i) => ({
      id: a.id,
      name: a.name,
      type: a.type ?? 'current',
      currency: a.currency,
      openingBalanceMinor: a.openingBalanceMinor,
      archived: a.archived ?? false,
      excludeFromNetWorth: a.excludeFromNetWorth ?? false,
      sortOrder: a.sortOrder ?? i,
    })),
    categories: (src.categories ?? []).map((c, i) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      parentId: c.parentId ?? null,
      archived: c.archived ?? false,
      sortOrder: c.sortOrder ?? i,
    })),
    payees: (src.payees ?? []).map((p) => ({ id: p.id, name: p.name })),
    tags: (src.tags ?? []).map((t) => ({ id: t.id, name: t.name })),
    transactions: (src.transactions ?? []).map((t) => {
      const currency = t.currency ?? currencyOf.get(t.accountId);
      if (!currency) throw new Error(`Book transaction ${t.id} names unknown account ${t.accountId}`);
      return {
        id: t.id,
        accountId: t.accountId,
        date: t.date,
        amountMinor: t.amountMinor,
        currency,
        payeeId: t.payeeId ?? null,
        categoryId: t.categoryId ?? null,
        tagIds: t.tagIds ?? [],
        status: t.status ?? 'cleared',
        splits: (t.splits ?? []).map((s) => ({ categoryId: s.categoryId, amountMinor: s.amountMinor })),
        transferGroupId: t.transferGroupId ?? null,
        notes: t.notes ?? '',
      };
    }),
  };
}

/** Replace the whole database with this book. */
export async function loadBook(book: Book): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
  await db.settings.put({
    ...defaultSettings(),
    baseCurrency: book.baseCurrency,
    onboarded: true,
    createdAt: FIXED_TIME,
  });
  const payeeName = new Map(book.payees.map((p) => [p.id, p.name] as const));

  const accounts: Account[] = book.accounts.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    currency: a.currency,
    openingBalanceMinor: a.openingBalanceMinor,
    colour: '#2563eb',
    groupId: null,
    sortOrder: a.sortOrder,
    archived: a.archived,
    excludeFromNetWorth: a.excludeFromNetWorth,
  }));
  const categories: Category[] = book.categories.map((c) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    kind: c.kind,
    archived: c.archived,
    sortOrder: c.sortOrder,
  }));
  const payees: Payee[] = book.payees.map((p) => ({
    id: p.id,
    name: p.name,
    nameLower: p.name.toLowerCase(),
    defaultCategoryId: null,
  }));
  const tags: Tag[] = book.tags.map((t) => ({ id: t.id, name: t.name, nameLower: t.name.toLowerCase() }));
  const fxRates: FxRate[] = book.fxRates.map((r) => ({
    id: `${r.base}:${r.quote}`,
    base: r.base,
    quote: r.quote,
    rate: r.rate,
    asOf: FIXED_TIME,
    source: 'manual',
  }));
  const transactions: Transaction[] = book.transactions.map((t) => ({
    id: t.id,
    accountId: t.accountId,
    date: t.date,
    amountMinor: t.amountMinor,
    currency: t.currency,
    payeeId: t.payeeId,
    categoryId: t.categoryId,
    tagIds: t.tagIds,
    notes: t.notes,
    status: t.status,
    splits: t.splits as Split[],
    transferGroupId: t.transferGroupId,
    importBatchId: null,
    dedupeHash: makeDedupeHash(
      t.accountId,
      t.date,
      t.amountMinor,
      (t.payeeId !== null ? payeeName.get(t.payeeId) : undefined) ?? t.notes,
    ),
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  }));

  await db.accounts.bulkAdd(accounts);
  if (categories.length) await db.categories.bulkAdd(categories);
  if (payees.length) await db.payees.bulkAdd(payees);
  if (tags.length) await db.tags.bulkAdd(tags);
  if (fxRates.length) await db.fxRates.bulkAdd(fxRates);
  if (transactions.length) await db.transactions.bulkAdd(transactions);
}
