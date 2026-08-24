// Transactions domain tests (SPEC §10): CRUD round-trips, split enforcement,
// refunds, transfers (create/edit/delete/cross-currency), query filters,
// dedupeHash recomputation.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, getSettings } from '../src/db/db';
import type { Account, Category, CategoryKind, Payee, Tag, Transaction } from '../src/db/types';
import { uid } from '../src/lib/util';
import {
  deleteTransaction,
  getTransferPair,
  isValidDateString,
  queryTransactions,
  saveTransaction,
  saveTransfer,
  validateSplits,
  ValidationError,
} from '../src/domain/transactions';

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

async function makeAccount(over: Partial<Account> = {}): Promise<Account> {
  const acc: Account = {
    id: uid(),
    name: 'Current',
    type: 'current',
    currency: 'GBP',
    openingBalanceMinor: 0,
    colour: '#336699',
    groupId: null,
    sortOrder: 0,
    archived: false,
    ...over,
  };
  await db.accounts.put(acc);
  return acc;
}

async function makeCategory(
  name: string,
  kind: CategoryKind = 'expense',
  parentId: string | null = null,
): Promise<Category> {
  const cat: Category = { id: uid(), name, parentId, kind, archived: false, sortOrder: 0 };
  await db.categories.put(cat);
  return cat;
}

async function makePayee(name: string): Promise<Payee> {
  const p: Payee = { id: uid(), name, nameLower: name.toLowerCase(), defaultCategoryId: null };
  await db.payees.put(p);
  return p;
}

async function makeTag(name: string): Promise<Tag> {
  const t: Tag = { id: uid(), name, nameLower: name.toLowerCase() };
  await db.tags.put(t);
  return t;
}

// Raw row builder for query tests — full control over dates/createdAt.
let seq = 0;
async function rawTx(
  over: Partial<Transaction> & { accountId: string; date: string; amountMinor: number },
): Promise<Transaction> {
  seq += 1;
  const tx: Transaction = {
    id: uid(),
    currency: 'GBP',
    payeeId: null,
    categoryId: null,
    tagIds: [],
    notes: '',
    status: 'cleared',
    splits: [],
    transferGroupId: null,
    importBatchId: null,
    dedupeHash: `raw-${seq}`,
    createdAt: `2026-01-01T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
  await db.transactions.put(tx);
  return tx;
}

beforeEach(async () => {
  await clearAll();
  seq = 0;
});

// ------------------------------------------------------------ validateSplits
describe('validateSplits', () => {
  it('accepts an empty split list', () => {
    expect(validateSplits(-1234, [])).toBeNull();
  });

  it('accepts splits summing exactly to the amount', () => {
    // -3000 + -2000 = -5000 ✔
    expect(
      validateSplits(-5000, [
        { categoryId: null, amountMinor: -3000 },
        { categoryId: null, amountMinor: -2000 },
      ]),
    ).toBeNull();
  });

  it('rejects an off-by-one sum', () => {
    // -3000 + -1999 = -4999 ≠ -5000
    expect(
      validateSplits(-5000, [
        { categoryId: null, amountMinor: -3000 },
        { categoryId: null, amountMinor: -1999 },
      ]),
    ).toMatch(/sum|add up/i);
  });

  it('rejects non-integer split amounts', () => {
    expect(validateSplits(-10, [{ categoryId: null, amountMinor: -10.5 }])).toMatch(/whole/i);
  });
});

// -------------------------------------------------------- isValidDateString
describe('isValidDateString', () => {
  it('accepts real YYYY-MM-DD dates', () => {
    expect(isValidDateString('2026-01-31')).toBe(true);
    expect(isValidDateString('2024-02-29')).toBe(true); // leap year
  });
  it('rejects malformed or impossible dates', () => {
    expect(isValidDateString('31/01/2026')).toBe(false);
    expect(isValidDateString('2026-1-5')).toBe(false);
    expect(isValidDateString('2026-13-01')).toBe(false);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('2025-02-29')).toBe(false); // not a leap year
  });
});

// ------------------------------------------------------------ saveTransaction
describe('saveTransaction', () => {
  it('creates a transaction: currency from account, payee/tags created, hash + timestamps set', async () => {
    const acc = await makeAccount({ currency: 'GBP' });
    const groceries = await makeCategory('Groceries');
    const tx = await saveTransaction({
      accountId: acc.id,
      date: '2026-01-05',
      amountMinor: -1234,
      payeeName: 'Tesco',
      categoryId: groceries.id,
      tagNames: ['Weekly', ' food '],
      notes: 'big shop',
      status: 'cleared',
    });

    expect(tx.currency).toBe('GBP');
    expect(tx.amountMinor).toBe(-1234);
    expect(tx.transferGroupId).toBeNull();
    // dedupeHash is the raw normalised key (D10): accountId|date|amount|payee
    expect(tx.dedupeHash).toBe(`${acc.id}|2026-01-05|-1234|tesco`);
    expect(tx.createdAt).toBeTruthy();
    expect(tx.updatedAt).toBeTruthy();

    // round-trip: row in db equals the returned object
    expect(await db.transactions.get(tx.id)).toEqual(tx);

    // payee created case-insensitively
    const payee = await db.payees.where('nameLower').equals('tesco').first();
    expect(payee).toBeTruthy();
    expect(tx.payeeId).toBe(payee!.id);
    // payee default category learned from this save (D17)
    expect(payee!.defaultCategoryId).toBe(groceries.id);

    // tags created (2 distinct), attached
    expect(tx.tagIds).toHaveLength(2);
    expect(await db.tags.count()).toBe(2);

    // settings remember the last used account
    expect((await getSettings()).lastUsedAccountId).toBe(acc.id);
  });

  it('uses notes for the dedupe hash when there is no payee, and empty string when neither', async () => {
    const acc = await makeAccount();
    const withNotes = await saveTransaction({
      accountId: acc.id,
      date: '2026-01-06',
      amountMinor: -300,
      notes: 'Coffee at Blank St.',
    });
    // normalised notes: lowercase, punctuation stripped, whitespace collapsed
    expect(withNotes.dedupeHash).toBe(`${acc.id}|2026-01-06|-300|coffee at blank st`);

    const bare = await saveTransaction({ accountId: acc.id, date: '2026-01-06', amountMinor: -300 });
    expect(bare.dedupeHash).toBe(`${acc.id}|2026-01-06|-300|`);
  });

  it('rejects an unknown account, bad dates, and unsafe amounts', async () => {
    const acc = await makeAccount();
    await expect(
      saveTransaction({ accountId: 'nope', date: '2026-01-05', amountMinor: -100 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      saveTransaction({ accountId: acc.id, date: '05/01/2026', amountMinor: -100 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      saveTransaction({ accountId: acc.id, date: '2026-02-30', amountMinor: -100 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      saveTransaction({ accountId: acc.id, date: '2026-01-05', amountMinor: -100.5 }),
    ).rejects.toThrow(ValidationError);
    await expect(
      saveTransaction({ accountId: acc.id, date: '2026-01-05', amountMinor: NaN }),
    ).rejects.toThrow(ValidationError);
    // nothing was written by any failed attempt
    expect(await db.transactions.count()).toBe(0);
  });

  it('enforces split sum on create: exact accepted, off-by-one rejected', async () => {
    const acc = await makeAccount();
    const a = await makeCategory('A');
    const b = await makeCategory('B');
    const ok = await saveTransaction({
      accountId: acc.id,
      date: '2026-01-10',
      amountMinor: -5000,
      splits: [
        { categoryId: a.id, amountMinor: -3000 },
        { categoryId: b.id, amountMinor: -2000 },
      ],
    });
    expect(ok.splits).toHaveLength(2);

    await expect(
      saveTransaction({
        accountId: acc.id,
        date: '2026-01-10',
        amountMinor: -5000,
        splits: [
          { categoryId: a.id, amountMinor: -3000 },
          { categoryId: b.id, amountMinor: -1999 }, // sums to -4999
        ],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a bad split sum on UPDATE and leaves the stored row untouched', async () => {
    const acc = await makeAccount();
    const a = await makeCategory('A');
    const tx = await saveTransaction({
      accountId: acc.id,
      date: '2026-01-10',
      amountMinor: -5000,
      splits: [
        { categoryId: a.id, amountMinor: -3000 },
        { categoryId: null, amountMinor: -2000 },
      ],
    });
    await expect(
      saveTransaction({
        id: tx.id,
        accountId: acc.id,
        date: '2026-01-10',
        amountMinor: -5000,
        splits: [{ categoryId: a.id, amountMinor: -4999 }],
      }),
    ).rejects.toThrow(ValidationError);
    const stored = await db.transactions.get(tx.id);
    expect(stored!.splits).toEqual(tx.splits);
  });

  it('accepts a refund: positive amount in an expense category (D14)', async () => {
    const acc = await makeAccount();
    const clothes = await makeCategory('Clothing', 'expense');
    const tx = await saveTransaction({
      accountId: acc.id,
      date: '2026-01-12',
      amountMinor: 2599, // £25.99 refunded
      payeeName: 'ASOS',
      categoryId: clothes.id,
    });
    expect(tx.amountMinor).toBe(2599);
    expect(tx.categoryId).toBe(clothes.id);
  });

  it('updates in place: keeps id + createdAt, recomputes dedupeHash', async () => {
    const acc = await makeAccount();
    const created = await saveTransaction({
      accountId: acc.id,
      date: '2026-01-05',
      amountMinor: -1234,
      payeeName: 'Tesco',
    });
    const updated = await saveTransaction({
      id: created.id,
      accountId: acc.id,
      date: '2026-01-07',
      amountMinor: -1500,
      payeeName: 'Sainsburys',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);
    // hash recomputed from the new account/date/amount/payee
    expect(updated.dedupeHash).toBe(`${acc.id}|2026-01-07|-1500|sainsburys`);
    expect(await db.transactions.count()).toBe(1);
    expect((await db.transactions.get(created.id))!.amountMinor).toBe(-1500);
  });

  it('rejects updating a missing id', async () => {
    const acc = await makeAccount();
    await expect(
      saveTransaction({ id: 'ghost', accountId: acc.id, date: '2026-01-05', amountMinor: -1 }),
    ).rejects.toThrow(ValidationError);
  });

  it('refuses to edit a transfer leg — points at the transfer editor', async () => {
    const from = await makeAccount({ name: 'Current' });
    const to = await makeAccount({ name: 'Savings', type: 'savings' });
    const [fromLeg] = await saveTransfer({
      fromAccountId: from.id,
      toAccountId: to.id,
      date: '2026-01-05',
      amountFromMinor: 10000,
      amountToMinor: 10000,
    });
    await expect(
      saveTransaction({
        id: fromLeg.id,
        accountId: from.id,
        date: '2026-01-05',
        amountMinor: -9000,
      }),
    ).rejects.toThrow(/transfer/i);
  });
});

// ---------------------------------------------------------- deleteTransaction
describe('deleteTransaction', () => {
  it('deletes a normal transaction', async () => {
    const acc = await makeAccount();
    const tx = await saveTransaction({ accountId: acc.id, date: '2026-01-05', amountMinor: -100 });
    await deleteTransaction(tx.id);
    expect(await db.transactions.count()).toBe(0);
  });

  it('deleting either transfer leg deletes BOTH legs', async () => {
    const from = await makeAccount({ name: 'Current' });
    const to = await makeAccount({ name: 'Savings' });
    const [fromLeg, toLeg] = await saveTransfer({
      fromAccountId: from.id,
      toAccountId: to.id,
      date: '2026-01-05',
      amountFromMinor: 10000,
      amountToMinor: 10000,
    });
    await deleteTransaction(toLeg.id); // delete via the OTHER leg
    expect(await db.transactions.count()).toBe(0);
    expect(await db.transactions.get(fromLeg.id)).toBeUndefined();
  });

  it('is a no-op for an unknown id', async () => {
    await expect(deleteTransaction('nope')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------- transfers
describe('saveTransfer', () => {
  it('creates two linked legs with correct signs, currencies and hashes', async () => {
    const from = await makeAccount({ name: 'Current', currency: 'GBP' });
    const to = await makeAccount({ name: 'Savings', currency: 'GBP', type: 'savings' });
    const [fromLeg, toLeg] = await saveTransfer({
      fromAccountId: from.id,
      toAccountId: to.id,
      date: '2026-03-01',
      amountFromMinor: 50000,
      amountToMinor: 50000,
      notes: 'monthly move',
      status: 'cleared',
    });

    expect(fromLeg.amountMinor).toBe(-50000);
    expect(toLeg.amountMinor).toBe(50000);
    expect(fromLeg.transferGroupId).toBe(toLeg.transferGroupId);
    expect(fromLeg.transferGroupId).not.toBeNull();
    for (const leg of [fromLeg, toLeg]) {
      expect(leg.categoryId).toBeNull();
      expect(leg.payeeId).toBeNull();
      expect(leg.tagIds).toEqual([]);
      expect(leg.splits).toEqual([]);
      expect(leg.date).toBe('2026-03-01');
      expect(leg.notes).toBe('monthly move');
      expect(leg.status).toBe('cleared');
    }
    expect(fromLeg.currency).toBe('GBP');
    expect(toLeg.currency).toBe('GBP');
    // hash descriptions: 'Transfer to <to>' / 'Transfer from <from>' (normalised)
    expect(fromLeg.dedupeHash).toBe(`${from.id}|2026-03-01|-50000|transfer to savings`);
    expect(toLeg.dedupeHash).toBe(`${to.id}|2026-03-01|50000|transfer from current`);
    expect(await db.transactions.count()).toBe(2);
  });

  it('cross-currency: BOTH explicit amounts stored, never derived', async () => {
    const gbp = await makeAccount({ name: 'UK Current', currency: 'GBP' });
    const eur = await makeAccount({ name: 'EU Savings', currency: 'EUR' });
    const [fromLeg, toLeg] = await saveTransfer({
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2026-03-02',
      amountFromMinor: 10000, // £100.00 leaves
      amountToMinor: 11700, // €117.00 arrives — explicit, not rate-derived
    });
    expect(fromLeg.amountMinor).toBe(-10000);
    expect(fromLeg.currency).toBe('GBP');
    expect(toLeg.amountMinor).toBe(11700);
    expect(toLeg.currency).toBe('EUR');
  });

  it('editing a transfer syncs BOTH legs and preserves their ids', async () => {
    const from = await makeAccount({ name: 'Current' });
    const to = await makeAccount({ name: 'Savings' });
    const [f1, t1] = await saveTransfer({
      fromAccountId: from.id,
      toAccountId: to.id,
      date: '2026-03-01',
      amountFromMinor: 50000,
      amountToMinor: 50000,
    });
    const [f2, t2] = await saveTransfer({
      transferGroupId: f1.transferGroupId!,
      fromAccountId: from.id,
      toAccountId: to.id,
      date: '2026-03-05',
      amountFromMinor: 60000,
      amountToMinor: 60000,
      notes: 'edited',
      status: 'pending',
    });
    expect(f2.id).toBe(f1.id);
    expect(t2.id).toBe(t1.id);
    expect(f2.transferGroupId).toBe(f1.transferGroupId);
    expect(f2.amountMinor).toBe(-60000);
    expect(t2.amountMinor).toBe(60000);
    for (const leg of [f2, t2]) {
      expect(leg.date).toBe('2026-03-05');
      expect(leg.notes).toBe('edited');
      expect(leg.status).toBe('pending');
    }
    expect(await db.transactions.count()).toBe(2);
    // hash recomputed on edit
    expect(f2.dedupeHash).toBe(`${from.id}|2026-03-05|-60000|transfer to savings`);
  });

  it('editing can move a leg to a different account (rewrites accountId + currency + hashes)', async () => {
    const from = await makeAccount({ name: 'Current', currency: 'GBP' });
    const to = await makeAccount({ name: 'Savings', currency: 'GBP' });
    const other = await makeAccount({ name: 'ISA', currency: 'GBP' });
    const [f1] = await saveTransfer({
      fromAccountId: from.id,
      toAccountId: to.id,
      date: '2026-03-01',
      amountFromMinor: 50000,
      amountToMinor: 50000,
    });
    const [f2, t2] = await saveTransfer({
      transferGroupId: f1.transferGroupId!,
      fromAccountId: from.id,
      toAccountId: other.id, // destination changed
      date: '2026-03-01',
      amountFromMinor: 50000,
      amountToMinor: 50000,
    });
    expect(t2.accountId).toBe(other.id);
    expect(f2.dedupeHash).toBe(`${from.id}|2026-03-01|-50000|transfer to isa`);
    expect(t2.dedupeHash).toBe(`${other.id}|2026-03-01|50000|transfer from current`);
  });

  it('validates accounts and magnitudes', async () => {
    const a = await makeAccount({ name: 'A' });
    const b = await makeAccount({ name: 'B' });
    const base = {
      fromAccountId: a.id,
      toAccountId: b.id,
      date: '2026-03-01',
      amountFromMinor: 100,
      amountToMinor: 100,
    };
    await expect(saveTransfer({ ...base, toAccountId: a.id })).rejects.toThrow(ValidationError);
    await expect(saveTransfer({ ...base, fromAccountId: 'nope' })).rejects.toThrow(ValidationError);
    await expect(saveTransfer({ ...base, toAccountId: 'nope' })).rejects.toThrow(ValidationError);
    await expect(saveTransfer({ ...base, amountFromMinor: 0 })).rejects.toThrow(ValidationError);
    await expect(saveTransfer({ ...base, amountToMinor: -100 })).rejects.toThrow(ValidationError);
    await expect(saveTransfer({ ...base, amountFromMinor: 100.5 })).rejects.toThrow(ValidationError);
    await expect(saveTransfer({ ...base, date: '2026-02-30' })).rejects.toThrow(ValidationError);
    await expect(saveTransfer({ ...base, transferGroupId: 'ghost' })).rejects.toThrow(
      ValidationError,
    );
    expect(await db.transactions.count()).toBe(0);
  });

  it('getTransferPair returns [fromLeg, toLeg], or null when unknown', async () => {
    const a = await makeAccount({ name: 'A' });
    const b = await makeAccount({ name: 'B' });
    const [fromLeg, toLeg] = await saveTransfer({
      fromAccountId: a.id,
      toAccountId: b.id,
      date: '2026-03-01',
      amountFromMinor: 100,
      amountToMinor: 100,
    });
    const pair = await getTransferPair(fromLeg.transferGroupId!);
    expect(pair).not.toBeNull();
    expect(pair![0].id).toBe(fromLeg.id); // negative leg first
    expect(pair![1].id).toBe(toLeg.id);
    expect(await getTransferPair('ghost')).toBeNull();
  });
});

// ---------------------------------------------------------- queryTransactions
describe('queryTransactions', () => {
  // Shared register fixture (seeded per test):
  //   accA                            accB
  //   t1 2026-01-01 -1000  groceries, Tesco, "weekly shop", cleared
  //   t2 2026-01-15 -2000  dining, tag travel, "lunch out", pending
  //   t3 2026-01-31 +300000 salary, Acme Corp, "January pay", cleared
  //                                   t4 2026-02-01 -5000 split[groceries -3000, dining -2000], "mixed shop", cleared
  //                                   t5 2026-01-20 -999  no category, "Cash withdrawal", cleared
  let accA: Account, accB: Account;
  let food: Category, groceries: Category, dining: Category, salary: Category;
  let tesco: Payee, acme: Payee;
  let travel: Tag;
  let t1: Transaction, t2: Transaction, t3: Transaction, t4: Transaction, t5: Transaction;

  async function seedRegister() {
    accA = await makeAccount({ name: 'A' });
    accB = await makeAccount({ name: 'B' });
    food = await makeCategory('Food & Drink', 'expense');
    groceries = await makeCategory('Groceries', 'expense', food.id);
    dining = await makeCategory('Dining', 'expense', food.id);
    salary = await makeCategory('Salary', 'income');
    tesco = await makePayee('Tesco');
    acme = await makePayee('Acme Corp');
    travel = await makeTag('travel');
    t1 = await rawTx({
      accountId: accA.id,
      date: '2026-01-01',
      amountMinor: -1000,
      categoryId: groceries.id,
      payeeId: tesco.id,
      notes: 'weekly shop',
    });
    t2 = await rawTx({
      accountId: accA.id,
      date: '2026-01-15',
      amountMinor: -2000,
      categoryId: dining.id,
      tagIds: [travel.id],
      notes: 'lunch out',
      status: 'pending',
    });
    t3 = await rawTx({
      accountId: accA.id,
      date: '2026-01-31',
      amountMinor: 300000,
      categoryId: salary.id,
      payeeId: acme.id,
      notes: 'January pay',
    });
    t4 = await rawTx({
      accountId: accB.id,
      date: '2026-02-01',
      amountMinor: -5000,
      splits: [
        { categoryId: groceries.id, amountMinor: -3000 },
        { categoryId: dining.id, amountMinor: -2000 },
      ],
      notes: 'mixed shop',
    });
    t5 = await rawTx({
      accountId: accB.id,
      date: '2026-01-20',
      amountMinor: -999,
      notes: 'Cash withdrawal',
    });
  }

  const ids = (rows: Transaction[]) => rows.map((r) => r.id);

  it('no filter: everything, sorted date DESC', async () => {
    await seedRegister();
    const rows = await queryTransactions();
    expect(ids(rows)).toEqual([t4.id, t3.id, t5.id, t2.id, t1.id]);
  });

  it('same-date rows sort by createdAt DESC', async () => {
    const acc = await makeAccount();
    const older = await rawTx({
      accountId: acc.id,
      date: '2026-01-10',
      amountMinor: -1,
      createdAt: '2026-01-10T08:00:00.000Z',
    });
    const newer = await rawTx({
      accountId: acc.id,
      date: '2026-01-10',
      amountMinor: -2,
      createdAt: '2026-01-10T09:00:00.000Z',
    });
    expect(ids(await queryTransactions())).toEqual([newer.id, older.id]);
  });

  it('account filter alone', async () => {
    await seedRegister();
    expect(ids(await queryTransactions({ accountIds: [accA.id] }))).toEqual([t3.id, t2.id, t1.id]);
  });

  it('date range alone — boundaries inclusive', async () => {
    await seedRegister();
    const rows = await queryTransactions({ dateFrom: '2026-01-01', dateTo: '2026-01-31' });
    // t1 sits exactly on dateFrom, t3 exactly on dateTo; t4 (Feb) excluded
    expect(ids(rows)).toEqual([t3.id, t5.id, t2.id, t1.id]);
  });

  it('open-ended date range (dateFrom only)', async () => {
    await seedRegister();
    const rows = await queryTransactions({ dateFrom: '2026-01-16' });
    expect(ids(rows)).toEqual([t4.id, t3.id, t5.id]);
  });

  it('account + date range combined (compound-index path), boundaries inclusive', async () => {
    await seedRegister();
    const rows = await queryTransactions({
      accountIds: [accA.id],
      dateFrom: '2026-01-01',
      dateTo: '2026-01-15',
    });
    expect(ids(rows)).toEqual([t2.id, t1.id]);
  });

  it('category filter expands to descendants and matches split categories', async () => {
    await seedRegister();
    // 'Food & Drink' ⊇ {groceries, dining}: t1 (groceries), t2 (dining),
    // t4 (via its splits) — t3/t5 excluded.
    expect(ids(await queryTransactions({ categoryIds: [food.id] }))).toEqual([
      t4.id,
      t2.id,
      t1.id,
    ]);
    // leaf category also finds split usage
    expect(ids(await queryTransactions({ categoryIds: [groceries.id] }))).toEqual([t4.id, t1.id]);
  });

  it('payee filter alone', async () => {
    await seedRegister();
    expect(ids(await queryTransactions({ payeeIds: [tesco.id] }))).toEqual([t1.id]);
  });

  it('tag filter alone', async () => {
    await seedRegister();
    expect(ids(await queryTransactions({ tagIds: [travel.id] }))).toEqual([t2.id]);
  });

  it('status filter alone', async () => {
    await seedRegister();
    expect(ids(await queryTransactions({ status: 'pending' }))).toEqual([t2.id]);
  });

  it('amount range applies to |amountMinor|, boundaries inclusive', async () => {
    await seedRegister();
    // |t1|=1000 |t2|=2000 |t3|=300000 |t4|=5000 |t5|=999
    // min 1000, max 5000 → t1, t2, t4 (t5 too small, t3 too big)
    const rows = await queryTransactions({ amountMinMinor: 1000, amountMaxMinor: 5000 });
    expect(ids(rows)).toEqual([t4.id, t2.id, t1.id]);
  });

  it('text search is case-insensitive across payee name, notes and category name', async () => {
    await seedRegister();
    // payee name hit
    expect(ids(await queryTransactions({ text: 'TESCO' }))).toEqual([t1.id]);
    // notes hit
    expect(ids(await queryTransactions({ text: 'withdraw' }))).toEqual([t5.id]);
    // category-name hit — includes split categories (t4 has a Dining split)
    expect(ids(await queryTransactions({ text: 'dining' }))).toEqual([t4.id, t2.id]);
    // no match
    expect(await queryTransactions({ text: 'zzz-nothing' })).toEqual([]);
  });

  it('combined filters intersect', async () => {
    await seedRegister();
    const rows = await queryTransactions({
      accountIds: [accA.id],
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      categoryIds: [food.id],
    });
    expect(ids(rows)).toEqual([t2.id, t1.id]);
  });

  it('limit applies after sorting', async () => {
    await seedRegister();
    expect(ids(await queryTransactions({ limit: 2 }))).toEqual([t4.id, t3.id]);
    expect(await queryTransactions({ limit: 0 })).toEqual([]);
  });
});
