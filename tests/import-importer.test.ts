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
import { accountBalances } from '../src/domain/balances';
import { makeDedupeHash } from '../src/import/dedupe';
import { emptyMapping, parseWithMapping } from '../src/import/generic';
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
  amountText: null,
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
  categoryId: string | null = null,
): Promise<Transaction> => {
  const tx: Transaction = {
    id: uid(), accountId, date, amountMinor, currency: 'GBP', payeeId,
    categoryId, tagIds: [], notes: payeeId ? '' : payeeOrDescription,
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

  // Each existing transaction can only explain ONE file row. Without that,
  // two legitimate identical rows both match the single transaction already in
  // the db and both get skipped — real spending silently dropped.
  it('two identical file rows against ONE existing transaction import one', async () => {
    const account = await addAccount('Current');
    const payee = await addPayee('Pret A Manger');
    // The user quick-added one of the day's two £4.50 coffees themselves…
    await addTx(account.id, '2026-08-20', -450, payee.id, 'Pret A Manger');
    const coffee = (index: number) =>
      makeRow({ index, date: '2026-08-20', amountMinor: -450, payeeName: 'Pret A Manger', accountName: 'Current' });

    const plan = await buildImportPlan([coffee(1), coffee(2)], mwOpts);
    expect(plan.rows.map((r) => r.action)).toEqual(['skip_exact_duplicate', 'import']);
    expect(plan.exactDuplicateCount).toBe(1);
    expect(plan.importableCount).toBe(1);
    await commitImport(plan);
    expect(await db.transactions.count()).toBe(2); // …the bank knows about two
  });

  it('N+1 identical rows against N existing leaves exactly one importable', async () => {
    const account = await addAccount('Current');
    const payee = await addPayee('Cafe');
    await addTx(account.id, '2026-07-10', -350, payee.id, 'Cafe');
    await addTx(account.id, '2026-07-10', -350, payee.id, 'Cafe');
    const cafe = (index: number) =>
      makeRow({ index, date: '2026-07-10', amountMinor: -350, payeeName: 'Cafe', accountName: 'Current' });

    const plan = await buildImportPlan([cafe(1), cafe(2), cafe(3)], mwOpts);
    expect(plan.exactDuplicateCount).toBe(2);
    expect(plan.importableCount).toBe(1);
    await commitImport(plan);
    expect(await db.transactions.count()).toBe(3);
  });

  it('re-importing the whole file twice still skips every row (N vs N)', async () => {
    const first = parseMoneyWizCsv(fixture('moneywiz.csv'));
    await commitImport(await buildImportPlan(first.rows, mwOpts));
    expect(await db.transactions.count()).toBe(27);

    const again = parseMoneyWizCsv(fixture('moneywiz.csv'));
    const plan = await buildImportPlan(again.rows, mwOpts);
    expect(plan.exactDuplicateCount).toBe(27);
    expect(plan.importableCount).toBe(0);
    await commitImport(plan);
    expect(await db.transactions.count()).toBe(27);
  });

  it('one existing transaction cannot be the near-duplicate of two rows', async () => {
    const account = await addAccount('Current');
    const payee = await addPayee('Coffee Shop');
    await addTx(account.id, '2026-07-10', -450, payee.id, 'Coffee Shop');
    const row = (index: number) =>
      makeRow({ index, date: '2026-07-11', amountMinor: -450, payeeName: 'Coffee Shop', accountName: 'Current' });

    const plan = await buildImportPlan([row(1), row(2)], mwOpts);
    expect(plan.rows.map((r) => r.action)).toEqual(['needs_decision', 'import']);
    expect(plan.nearDuplicateCount).toBe(1);
  });

  it('an exact match claims its transaction before a near-duplicate can', async () => {
    const account = await addAccount('Current');
    const payee = await addPayee('Cafe');
    await addTx(account.id, '2026-07-10', -350, payee.id, 'Cafe');
    // The ±1-day row comes FIRST in the file; the identical row must still be
    // the one that matches, or a genuine re-import would double up.
    const plan = await buildImportPlan(
      [
        makeRow({ date: '2026-07-11', amountMinor: -350, payeeName: 'Cafe', accountName: 'Current' }),
        makeRow({ index: 2, date: '2026-07-10', amountMinor: -350, payeeName: 'Cafe', accountName: 'Current' }),
      ],
      mwOpts,
    );
    expect(plan.rows[1].action).toBe('skip_exact_duplicate');
    expect(plan.rows[0].action).toBe('import');
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

// ------------------------------------------------------------------ currency
// A transaction's amount is denominated in ITS ACCOUNT's currency — balances
// and net worth sum amountMinor per account without checking currency, so a
// EUR-denominated row banked in a GBP account would corrupt every total.
describe('imported transactions are stored in the ACCOUNT currency', () => {
  it('keeps the account currency, counts the mismatch and notes the original', async () => {
    const account = await addAccount('Holiday Card', 'GBP');
    const plan = await buildImportPlan(
      [
        // MoneyWiz exports the ACCOUNT-currency figure in Amount; the Currency
        // column describes what the purchase was made in.
        makeRow({
          date: '2026-07-10', accountName: 'Holiday Card', payeeName: 'Taberna Real',
          currency: 'EUR', amountMinor: -4550, amountText: '-45.50',
        }),
        makeRow({
          index: 2, date: '2026-07-11', accountName: 'Holiday Card', payeeName: 'Tesco',
          currency: 'GBP', amountMinor: -1000, amountText: '-10.00',
        }),
      ],
      mwOpts,
    );
    expect(plan.currencyMismatchCount).toBe(1);
    expect(plan.rows[0].currencyMismatch).toBe(true);
    expect(plan.rows[1].currencyMismatch).toBe(false);

    await commitImport(plan);
    const txs = (await db.transactions.toArray()).sort((a, b) => a.date.localeCompare(b.date));
    expect(txs.map((t) => t.currency)).toEqual(['GBP', 'GBP']); // never 'EUR'
    expect(txs[0].amountMinor).toBe(-4550); // the number is NOT converted
    expect(txs[0].notes).toContain('originally EUR');
    expect(txs[1].notes).not.toContain('originally');

    // The balance is therefore a real GBP number, not a mixed-currency sum.
    const balances = await accountBalances();
    expect(balances.find((b) => b.account.id === account.id)!.balanceMinor).toBe(-5550);
  });

  it('a same-day pair between two GBP accounts still needs matching magnitudes', async () => {
    // Both accounts are GBP, so the legs' magnitudes CAN be compared — the
    // currency the file declares must not switch that check off.
    await addAccount('Current', 'GBP');
    await addAccount('Savings', 'GBP');
    const plan = await buildImportPlan(
      [
        makeRow({
          date: '2026-07-05', accountName: 'Current', transferAccountName: 'Savings',
          currency: 'EUR', amountMinor: -30000, amountText: '-300.00',
        }),
        makeRow({
          index: 2, date: '2026-07-05', accountName: 'Savings', transferAccountName: 'Current',
          currency: 'GBP', amountMinor: 12000, amountText: '120.00',
        }),
      ],
      mwOpts,
    );
    expect(plan.rows[0].transferPairIndex).toBeUndefined();
    expect(plan.rows[1].transferPairIndex).toBeUndefined();
  });

  it('cross-currency legs pair on file order (magnitudes cannot be compared)', async () => {
    await addAccount('Euro Travel', 'EUR');
    await addAccount('Current', 'GBP');
    const leg = (index: number, accountName: string, other: string, amountMinor: number) =>
      makeRow({ index, date: '2026-07-05', accountName, transferAccountName: other, amountMinor });
    const plan = await buildImportPlan(
      [
        leg(1, 'Euro Travel', 'Current', -10000),
        leg(2, 'Euro Travel', 'Current', -5000),
        leg(3, 'Current', 'Euro Travel', 8500),
        leg(4, 'Current', 'Euro Travel', 4200),
      ],
      mwOpts,
    );
    expect(plan.rows.map((r) => r.transferPairIndex)).toEqual([2, 3, 0, 1]);
  });
});

// -------------------------------------------------------------- amount scale
describe('minor-unit scale follows the resolved account currency', () => {
  it('a 0-decimal (JPY) account is not inflated 100× by the 2-decimal guess', async () => {
    await addAccount('Tokyo', 'JPY');
    const { rows } = parseMoneyWizCsv(
      'Account,Payee,Date,Amount\n' +
        'Tokyo,Ramen Ichi,01/07/2026,-500\n' +
        'Tokyo,Hotel,02/07/2026,"-12,500"\n',
    );
    expect(rows[0].amountMinor).toBe(-50000); // the parser's GBP-scale guess

    const plan = await buildImportPlan(rows, mwOpts);
    expect(plan.errorCount).toBe(0);
    expect(plan.rows.map((r) => r.row.amountMinor)).toEqual([-500, -12500]);
    await commitImport(plan);
    const txs = (await db.transactions.toArray()).sort((a, b) => a.date.localeCompare(b.date));
    expect(txs.map((t) => t.amountMinor)).toEqual([-500, -12500]); // ¥500, ¥12,500
    expect(txs.every((t) => t.currency === 'JPY')).toBe(true);
  });

  it('a 3-decimal (KWD) account accepts an amount GBP would reject', async () => {
    await addAccount('Kuwait', 'KWD');
    const { rows } = parseMoneyWizCsv(
      'Account,Payee,Date,Amount\n' +
        'Kuwait,Souq,01/07/2026,-12.345\n' +
        'Kuwait,Tea Stall,02/07/2026,-9.50\n',
    );
    // At GBP's 2 decimals "12.345" has more precision than the currency has,
    // so the parser can only call it a bad row.
    expect(rows[0].amountMinor).toBeNull();
    expect(rows[0].error).toMatch(/amount/i);

    const plan = await buildImportPlan(rows, mwOpts);
    expect(plan.errorCount).toBe(0);
    expect(plan.rows[0].action).toBe('import');
    // 12.345 KWD = 12345 fils; 9.50 KWD = 9500 fils (not 950).
    expect(plan.rows.map((r) => r.row.amountMinor)).toEqual([-12345, -9500]);
    await commitImport(plan);
    const txs = (await db.transactions.toArray()).sort((a, b) => a.date.localeCompare(b.date));
    expect(txs.map((t) => t.amountMinor)).toEqual([-12345, -9500]);
    expect(txs.every((t) => t.currency === 'KWD')).toBe(true);
  });

  it('a NEW account scales to the currency its plan entry will be created with', async () => {
    const { rows } = parseMoneyWizCsv(
      'Account,Payee,Date,Amount\nTokyo,Ramen Ichi,01/07/2026,-500\n',
    );
    const plan = await buildImportPlan(rows, { ...mwOpts, defaultCurrency: 'JPY' });
    expect(plan.newAccounts).toEqual([{ name: 'Tokyo', currency: 'JPY', create: true }]);
    expect(plan.rows[0].row.amountMinor).toBe(-500);
    await commitImport(plan);
    expect((await db.transactions.toArray())[0].amountMinor).toBe(-500);
  });

  it('debit/credit columns rescale too, and a debit stays negative', async () => {
    await addAccount('Tokyo', 'JPY');
    const data = [
      ['Date', 'Account', 'Description', 'Paid Out', 'Paid In'],
      ['2026-07-01', 'Tokyo', 'RAMEN', '500', ''],
      ['2026-07-02', 'Tokyo', 'SALARY', '', '250000'],
    ];
    const rows = parseWithMapping(
      data,
      { ...emptyMapping(), date: 0, account: 1, payee: 2, debit: 3, credit: 4 },
      'GBP',
    );
    expect(rows.map((r) => r.amountMinor)).toEqual([-50000, 25000000]);
    const plan = await buildImportPlan(rows, { ...mwOpts, source: 'csv', fileName: 'bank.csv' });
    expect(plan.rows.map((r) => r.row.amountMinor)).toEqual([-500, 250000]);
  });

  it('an amount that parses at no currency is still a row error', async () => {
    await addAccount('Tokyo', 'JPY');
    const { rows } = parseMoneyWizCsv(
      'Account,Payee,Date,Amount\nTokyo,Ramen Ichi,01/07/2026,ten yen\n',
    );
    const plan = await buildImportPlan(rows, mwOpts);
    expect(plan.errorCount).toBe(1);
    expect(plan.rows[0].action).toBe('error');
    expect(plan.rows[0].row.error).toMatch(/amount/i);
    expect(plan.newAccounts).toEqual([]); // and it invents no account
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

  it('un-learns the payee defaults the batch taught (D17)', async () => {
    const groceries = (await db.categories.filter((c) => c.name === 'Groceries').first())!;
    const coffee = (await db.categories.filter((c) => c.name === 'Coffee & Snacks').first())!;
    const account = await addAccount('Current');
    // A payee the user already had, correctly learned as Coffee & Snacks.
    const amazon = await addPayee('Amazon', coffee.id);
    await addTx(account.id, '2026-01-05', -400, amazon.id, 'Amazon', coffee.id);

    // A badly categorised import teaches Amazon → Groceries…
    const rows = [1, 2, 3].map((n) =>
      makeRow({
        index: n, date: `2026-07-0${n}`, amountMinor: -1000 * n, payeeName: 'Amazon',
        accountName: 'Current', categoryPath: ['Food & Drink', 'Groceries'],
      }),
    );
    const batch = await commitImport(await buildImportPlan(rows, mwOpts));
    expect((await db.payees.get(amazon.id))!.defaultCategoryId).toBe(groceries.id);

    // …and undoing it must take the suggestion with it, or the user keeps
    // being offered Groceries with zero transactions supporting it.
    await undoImport(batch.id);
    expect((await db.payees.get(amazon.id))!.defaultCategoryId).toBe(coffee.id);
  });

  it('clears a learned default when the undo leaves the payee with nothing', async () => {
    await addAccount('Current');
    const amazon = await addPayee('Amazon'); // pre-existing payee, no history yet
    const rows = [1, 2].map((n) =>
      makeRow({
        index: n, date: `2026-07-0${n}`, amountMinor: -500 * n, payeeName: 'Amazon',
        accountName: 'Current', categoryPath: ['Food & Drink', 'Groceries'],
      }),
    );
    const batch = await commitImport(await buildImportPlan(rows, mwOpts));
    expect((await db.payees.get(amazon.id))!.defaultCategoryId).not.toBeNull();

    await undoImport(batch.id);
    // The payee predates the import so it survives — but with no transactions
    // left there is nothing to suggest from.
    expect((await db.payees.get(amazon.id))!.defaultCategoryId).toBeNull();
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
