// Import plan / commit / undo tests (SPEC §7.4, §10).
//
// Hand-counts for tests/fixtures/moneywiz.csv (27 data rows):
//  * accounts referenced: Current Account, Savings, Credit Card, Euro Account → 4 new
//  * distinct payees: Acme Ltd, Hartley Lettings, Tesco, Sainsbury's, Netflix,
//    TfL, Pizza Express, Caffe Nero, Hotel Arts, El Nacional, Sports Direct,
//    Pret A Manger, Amazon, Vodafone, Odeon, Shell, Zatu Games → 17 new
//  * distinct tags: work, food, weekly, commute, eating-out, holiday,
//    date-night, car → 8 new
//  * category paths: all exist in the seeded tree EXCEPT 'Hobbies > Board
//    Games' → 1 new path (2 new category records: root + child)
//  * transfer pairs: rows 7+8 (05/07/2026 ±300.00) and rows 22+23
//    (05/08/2026 ±300.00) → plan indexes (6,7) and (21,22)
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/db';
import { seedCategoriesIfEmpty } from '../src/db/seed';
import type { Account, Payee, Transaction } from '../src/db/types';
import { nameKey, uid } from '../src/lib/util';
import { makeDedupeHash } from '../src/import/dedupe';
import { parseMoneyWizCsv } from '../src/import/moneywiz';
import {
  buildImportPlan,
  commitImport,
  listImportBatches,
  refreshPlanCounts,
  undoImport,
} from '../src/import/importer';
import type { ParsedRow } from '../src/import/types';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const clearAll = async (): Promise<void> => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

const makeRow = (partial: Partial<ParsedRow>): ParsedRow => ({
  index: 1,
  date: '2026-07-10',
  amountMinor: -1000,
  currency: null,
  accountName: null,
  payeeName: null,
  description: null,
  categoryPath: [],
  tags: [],
  notes: null,
  transferAccountName: null,
  error: null,
  ...partial,
});

const addAccount = async (name: string, currency = 'GBP'): Promise<Account> => {
  const account: Account = {
    id: uid(), name, type: 'current', currency, openingBalanceMinor: 0,
    colour: '#123456', groupId: null, sortOrder: 0, archived: false,
  };
  await db.accounts.add(account);
  return account;
};

const addPayee = async (name: string, defaultCategoryId: string | null = null): Promise<Payee> => {
  const payee: Payee = { id: uid(), name, nameLower: nameKey(name), defaultCategoryId };
  await db.payees.add(payee);
  return payee;
};

const addTx = async (
  accountId: string,
  date: string,
  amountMinor: number,
  payeeId: string | null,
  payeeOrDescription: string,
): Promise<Transaction> => {
  const tx: Transaction = {
    id: uid(), accountId, date, amountMinor, currency: 'GBP', payeeId,
    categoryId: null, tagIds: [], notes: payeeId ? '' : payeeOrDescription,
    status: 'cleared', splits: [], transferGroupId: null, importBatchId: null,
    dedupeHash: makeDedupeHash(accountId, date, amountMinor, payeeOrDescription),
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await db.transactions.add(tx);
  return tx;
};

const mwOpts = { source: 'moneywiz' as const, fileName: 'moneywiz.csv', defaultCurrency: 'GBP' };

beforeEach(async () => {
  await clearAll();
  await seedCategoriesIfEmpty();
});

// ------------------------------------------------------------ buildImportPlan
describe('buildImportPlan (moneywiz fixture, seeded categories)', () => {
  it('resolves new entities and pairs transfers — hand-counted', async () => {
    const { rows } = parseMoneyWizCsv(fixture('moneywiz.csv'));
    const plan = await buildImportPlan(rows, mwOpts);

    expect(plan.rows).toHaveLength(27);
    expect(plan.errorCount).toBe(0);
    expect(plan.exactDuplicateCount).toBe(0);
    expect(plan.nearDuplicateCount).toBe(0);
    expect(plan.importableCount).toBe(27);

    // 4 new accounts, in first-appearance order; Euro Account picks up EUR.
    expect(plan.newAccounts.map((a) => a.name)).toEqual([
      'Current Account', 'Savings', 'Credit Card', 'Euro Account',
    ]);
    expect(plan.newAccounts.map((a) => a.currency)).toEqual(['GBP', 'GBP', 'GBP', 'EUR']);
    expect(plan.newAccounts.every((a) => a.create)).toBe(true);

    // The seeded tree covers every path except Hobbies > Board Games.
    expect(plan.newCategoryPaths).toEqual([['Hobbies', 'Board Games']]);

    expect(plan.newPayees).toHaveLength(17);
    expect(plan.newTags.sort()).toEqual(
      ['car', 'commute', 'date-night', 'eating-out', 'food', 'holiday', 'weekly', 'work'].sort(),
    );

    // Transfer pairing: rows 7/8 and 22/23 (0-based 6/7 and 21/22).
    expect(plan.rows[6].transferPairIndex).toBe(7);
    expect(plan.rows[7].transferPairIndex).toBe(6);
    expect(plan.rows[21].transferPairIndex).toBe(22);
    expect(plan.rows[22].transferPairIndex).toBe(21);
    expect(plan.rows.filter((r) => r.transferPairIndex !== undefined)).toHaveLength(4);

    // Resolved paths land on the SEEDED categories (reuse, not duplication):
    // the refund row (+55.00, Shopping > Clothing) must resolve to the seeded
    // expense category even though its amount is positive.
    const clothing = await db.categories.filter((c) => c.name === 'Clothing').first();
    expect(plan.rows[12].chosenCategoryId).toBe(clothing!.id);
    // Unresolved path rows stay null until commit creates the path.
    expect(plan.rows[26].chosenCategoryId).toBeNull();
  });

  it('suggests the learned payee category only for rows with no category path', async () => {
    const coffee = await db.categories.filter((c) => c.name === 'Coffee & Snacks').first();
    await addPayee('Pret A Manger', coffee!.id);
    const account = await addAccount('Current Account');

    const rows = [
      makeRow({ payeeName: 'Pret A Manger', accountName: 'Current Account' }),
      makeRow({
        index: 2,
        payeeName: 'Pret A Manger',
        accountName: 'Current Account',
        categoryPath: ['Food & Drink', 'Restaurants'],
        date: '2026-07-11',
      }),
    ];
    const plan = await buildImportPlan(rows, { ...mwOpts, fileName: 't.csv' });
    expect(plan.rows[0].suggestedCategoryId).toBe(coffee!.id);
    expect(plan.rows[0].chosenCategoryId).toBe(coffee!.id); // suggestion applied
    expect(plan.rows[1].suggestedCategoryId).toBeUndefined();
    const restaurants = await db.categories.filter((c) => c.name === 'Restaurants').first();
    expect(plan.rows[1].chosenCategoryId).toBe(restaurants!.id); // path wins
    expect(plan.newPayees).toEqual([]); // payee already existed
    expect(plan.rows[0].accountId).toBe(account.id);
  });

  it('fixedAccountId pins rows with no account column', async () => {
    const account = await addAccount('Chosen');
    const plan = await buildImportPlan([makeRow({})], {
      source: 'csv', fileName: 'g.csv', fixedAccountId: account.id, defaultCurrency: 'GBP',
    });
    expect(plan.rows[0].accountId).toBe(account.id);
    expect(plan.newAccounts).toEqual([]);
    expect(plan.importableCount).toBe(1);
  });

  it('rows with errors are counted and never importable', async () => {
    const plan = await buildImportPlan(
      [makeRow({ date: null, error: 'Unrecognised date “xx”', accountName: 'A' })],
      mwOpts,
    );
    expect(plan.errorCount).toBe(1);
    expect(plan.importableCount).toBe(0);
    expect(plan.rows[0].action).toBe('error');
  });
});

// --------------------------------------------------------------- commitImport
describe('commitImport (moneywiz fixture)', () => {
  it('writes transactions, entities and the batch created-id arrays', async () => {
    const seedCount = await db.categories.count();
    const { rows } = parseMoneyWizCsv(fixture('moneywiz.csv'));
    const plan = await buildImportPlan(rows, mwOpts);
    const batch = await commitImport(plan);

    expect(await db.transactions.count()).toBe(27);
    expect(batch.rowCount).toBe(27);
    expect(batch.createdAccountIds).toHaveLength(4);
    expect(batch.createdPayeeIds).toHaveLength(17);
    expect(batch.createdTagIds).toHaveLength(8);
    expect(batch.createdCategoryIds).toHaveLength(2); // Hobbies + Board Games
    expect(batch.createdGroupIds).toHaveLength(0);
    expect(await db.categories.count()).toBe(seedCount + 2);
    expect((await listImportBatches()).map((b) => b.id)).toEqual([batch.id]);

    // Accounts created with import defaults; Euro Account keeps EUR.
    const euro = await db.accounts.filter((a) => a.name === 'Euro Account').first();
    expect(euro).toMatchObject({ currency: 'EUR', type: 'current', openingBalanceMinor: 0, groupId: null });
    const euroTxs = await db.transactions.where('accountId').equals(euro!.id).toArray();
    expect(euroTxs.map((t) => t.currency)).toEqual(['EUR', 'EUR']);

    // Transfer linkage: the 05/07 legs share one fresh transferGroupId,
    // categoryId null on both, -30000 out of Current, +30000 into Savings.
    const current = (await db.accounts.filter((a) => a.name === 'Current Account').first())!;
    const savings = (await db.accounts.filter((a) => a.name === 'Savings').first())!;
    const legs = (await db.transactions.where('date').equals('2026-07-05').toArray())
      .sort((a, b) => a.amountMinor - b.amountMinor);
    expect(legs).toHaveLength(2);
    expect(legs[0].transferGroupId).not.toBeNull();
    expect(legs[0].transferGroupId).toBe(legs[1].transferGroupId);
    expect(legs.every((l) => l.categoryId === null)).toBe(true);
    expect(legs[0]).toMatchObject({ accountId: current.id, amountMinor: -30000 });
    expect(legs[1]).toMatchObject({ accountId: savings.id, amountMinor: 30000 });
    // The two monthly pairs get DIFFERENT group ids.
    const augustLegs = await db.transactions.where('date').equals('2026-08-05').toArray();
    expect(augustLegs[0].transferGroupId).not.toBe(legs[0].transferGroupId);

    // Salary row: hand-calc "2,650.00" ⇒ 265000; dedupeHash follows the
    // payee-if-present-else-description rule.
    const salary = (await db.transactions.where('date').equals('2026-06-25').first())!;
    expect(salary.amountMinor).toBe(265000);
    expect(salary.dedupeHash).toBe(makeDedupeHash(current.id, '2026-06-25', 265000, 'Acme Ltd'));
    expect(salary.importBatchId).toBe(batch.id);

    // notes = description-if-different-from-payee + ' — ' + memo.
    const lunch = (await db.transactions.where('date').equals('2026-08-08').first())!;
    expect(lunch.notes).toBe('Lunch meeting — client lunch');

    // Refund kept positive, in the SEEDED expense category.
    const refund = (await db.transactions.where('date').equals('2026-07-12').first())!;
    const clothing = await db.categories.filter((c) => c.name === 'Clothing').first();
    expect(refund.amountMinor).toBe(5500);
    expect(refund.categoryId).toBe(clothing!.id);

    // New category path created with sign-inferred kind (expense, -29.99).
    const hobbies = await db.categories.filter((c) => c.name === 'Hobbies').first();
    const boardGames = await db.categories.filter((c) => c.name === 'Board Games').first();
    expect(hobbies).toMatchObject({ kind: 'expense', parentId: null });
    expect(boardGames).toMatchObject({ kind: 'expense', parentId: hobbies!.id });

    // Payee → category learned AFTER commit (D17): Tesco is always Groceries.
    const tesco = await db.payees.where('nameLower').equals('tesco').first();
    const groceries = await db.categories.filter((c) => c.name === 'Groceries').first();
    expect(tesco!.defaultCategoryId).toBe(groceries!.id);

    // Tags attached: the 02/07 Tesco shop carries food + weekly.
    const shop = (await db.transactions.where('date').equals('2026-07-02').first())!;
    expect(shop.tagIds).toHaveLength(2);
  });
});

// ------------------------------------------------------------------ re-import
describe('re-import of an overlapping export (the point of the dedupe)', () => {
  it('flags every overlapping row as an exact duplicate; imports only new rows', async () => {
    const first = parseMoneyWizCsv(fixture('moneywiz.csv'));
    await commitImport(await buildImportPlan(first.rows, mwOpts));
    expect(await db.transactions.count()).toBe(27);

    // moneywiz-overlap.csv hand-count: 11 rows = 8 verbatim repeats of the
    // first file (incl. the 05/08 transfer PAIR) + 3 genuinely new rows
    // (Tesco 20/08, salary 25/08, Caffe Nero 21/08).
    const overlap = parseMoneyWizCsv(fixture('moneywiz-overlap.csv'));
    const plan = await buildImportPlan(overlap.rows, {
      ...mwOpts, fileName: 'moneywiz-overlap.csv',
    });
    expect(plan.rows).toHaveLength(11);
    expect(plan.exactDuplicateCount).toBe(8);
    expect(plan.nearDuplicateCount).toBe(0);
    expect(plan.errorCount).toBe(0);
    expect(plan.importableCount).toBe(3);
    // Everything already exists — nothing new to create.
    expect(plan.newAccounts).toEqual([]);
    expect(plan.newPayees).toEqual([]);
    expect(plan.newTags).toEqual([]);
    expect(plan.newCategoryPaths).toEqual([]); // Hobbies > Board Games now exists

    // Transfer legs are matched by their description-based hash too.
    expect(plan.rows[3].action).toBe('skip_exact_duplicate');
    expect(plan.rows[4].action).toBe('skip_exact_duplicate');

    const batch2 = await commitImport(plan);
    expect(await db.transactions.count()).toBe(30); // 27 + 3 new
    expect(batch2.rowCount).toBe(3);
    expect(batch2.createdAccountIds).toEqual([]);
    expect(batch2.createdPayeeIds).toEqual([]);
    expect(batch2.createdTagIds).toEqual([]);
    expect(batch2.createdCategoryIds).toEqual([]);
    // The 3 new ones really are the new rows.
    const newTxs = await db.transactions.where('importBatchId').equals(batch2.id).toArray();
    expect(newTxs.map((t) => t.date).sort()).toEqual(['2026-08-20', '2026-08-21', '2026-08-25']);
  });
});

// ------------------------------------------------------------ near-duplicates
describe('near-duplicate flow (same amount/payee, one day off)', () => {
  it('flags for decision; skip by default; import only on explicit decision', async () => {
    const account = await addAccount('Current');
    const payee = await addPayee('Coffee Shop');
    await addTx(account.id, '2026-07-10', -450, payee.id, 'Coffee Shop');

    const rows = [
      makeRow({ date: '2026-07-11', amountMinor: -450, payeeName: 'Coffee Shop', accountName: 'Current' }),
    ];
    const plan = await buildImportPlan(rows, { ...mwOpts, fileName: 'near.csv' });
    expect(plan.rows[0].action).toBe('needs_decision');
    expect(plan.rows[0].decision).toBe('skip'); // never silently doubled
    expect(plan.rows[0].nearDuplicateOf?.date).toBe('2026-07-10');
    expect(plan.nearDuplicateCount).toBe(1);
    expect(plan.importableCount).toBe(0);

    // decision 'skip' (default) ⇒ nothing written
    await commitImport(plan);
    expect(await db.transactions.count()).toBe(1);

    // decision 'import' ⇒ the row is written
    const plan2 = await buildImportPlan(rows, { ...mwOpts, fileName: 'near.csv' });
    plan2.rows[0].decision = 'import';
    refreshPlanCounts(plan2);
    expect(plan2.importableCount).toBe(1);
    await commitImport(plan2);
    expect(await db.transactions.count()).toBe(2);
  });

  it('an identical existing transaction is an exact duplicate, not a near one', async () => {
    const account = await addAccount('Current');
    const payee = await addPayee('Coffee Shop');
    await addTx(account.id, '2026-07-10', -450, payee.id, 'Coffee Shop');
    const plan = await buildImportPlan(
      [makeRow({ date: '2026-07-10', amountMinor: -450, payeeName: 'Coffee Shop', accountName: 'Current' })],
      mwOpts,
    );
    expect(plan.rows[0].action).toBe('skip_exact_duplicate');
    expect(plan.exactDuplicateCount).toBe(1);
  });

  it('rows identical WITHIN the file are all imported (not deduped)', async () => {
    await addAccount('Current');
    const twice = [
      makeRow({ date: '2026-07-10', amountMinor: -350, payeeName: 'Cafe', accountName: 'Current' }),
      makeRow({ index: 2, date: '2026-07-10', amountMinor: -350, payeeName: 'Cafe', accountName: 'Current' }),
    ];
    const plan = await buildImportPlan(twice, mwOpts);
    expect(plan.rows.map((r) => r.action)).toEqual(['import', 'import']);
    await commitImport(plan);
    expect(await db.transactions.count()).toBe(2); // two same-day coffees are real
  });
});

// ----------------------------------------------------------------- undoImport
describe('undoImport', () => {
  it('returns the db to the pre-import state and keeps pre-existing records', async () => {
    // Pre-existing user data that must survive the undo untouched.
    const myAccount = await addAccount('My Old Account');
    const myPayee = await addPayee('Existing Payee');
    const myTx = await addTx(myAccount.id, '2026-01-15', -999, myPayee.id, 'Existing Payee');
    const seedCount = await db.categories.count();

    const { rows } = parseMoneyWizCsv(fixture('moneywiz.csv'));
    const batch = await commitImport(await buildImportPlan(rows, mwOpts));
    expect(await db.transactions.count()).toBe(28); // 27 imported + 1 pre-existing
    expect(await db.accounts.count()).toBe(5);
    expect(await db.categories.count()).toBe(seedCount + 2);

    await undoImport(batch.id);

    expect(await db.transactions.count()).toBe(1);
    expect(await db.accounts.count()).toBe(1);
    expect(await db.payees.count()).toBe(1);
    expect(await db.tags.count()).toBe(0);
    expect(await db.categories.count()).toBe(seedCount); // Hobbies tree removed
    expect(await db.importBatches.count()).toBe(0);
    // Pre-existing records survived byte-for-byte relevant fields.
    expect(await db.accounts.get(myAccount.id)).toMatchObject({ name: 'My Old Account' });
    expect(await db.payees.get(myPayee.id)).toMatchObject({ name: 'Existing Payee' });
    expect(await db.transactions.get(myTx.id)).toMatchObject({ amountMinor: -999 });
  });

  it('keeps created entities that gained references outside the batch', async () => {
    const { rows } = parseMoneyWizCsv(fixture('moneywiz.csv'));
    const batch = await commitImport(await buildImportPlan(rows, mwOpts));
    // The user hand-adds a transaction to an account the import created…
    const current = (await db.accounts.filter((a) => a.name === 'Current Account').first())!;
    await addTx(current.id, '2026-08-20', -100, null, 'Manual entry');

    await undoImport(batch.id);

    // …so that account (and only it) must survive the undo.
    expect(await db.accounts.count()).toBe(1);
    expect((await db.accounts.toArray())[0].id).toBe(current.id);
    expect(await db.transactions.count()).toBe(1);
  });
});
