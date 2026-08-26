// Duplicating a transaction (register row + editor footer → a prefilled CREATE).
//
// The copy logic is pure by design — the app has no DOM test environment, so
// the component wiring is thin and everything that decides what a copy CONTAINS
// lives in src/ui/tx/duplicate.ts and is tested here directly (the pattern used
// for `categoryAfterPayeePick` and `accountsStepError`).
//
// The last two blocks go through the real domain writers as the editor does, so
// "a copy never touches the original" and "a copied transfer becomes a whole new
// pair" are proved end to end, not just asserted about a draft object.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../src/db/db';
import type { Account, Category, Payee, Tag, Transaction } from '../src/db/types';
import { uid } from '../src/lib/util';
import {
  getTransferPair,
  saveTransaction,
  saveTransfer,
  validateSplits,
} from '../src/domain/transactions';
import {
  duplicateContextFrom,
  duplicateDraftFrom,
  draftSign,
  draftToSaveInput,
  type DuplicateContext,
} from '../src/ui/tx/duplicate';
import { transferDraftToInput } from '../src/ui/tx/TransferFields';

const TODAY = '2026-08-26';

// ---------------------------------------------------------------- fixtures
function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'tx-1',
    accountId: 'acc-current',
    date: '2026-07-04',
    amountMinor: -1250,
    currency: 'GBP',
    payeeId: 'payee-tesco',
    categoryId: 'cat-groceries',
    tagIds: ['tag-food', 'tag-weekly'],
    notes: 'weekly shop',
    status: 'cleared',
    splits: [],
    transferGroupId: null,
    importBatchId: 'batch-moneywiz',
    dedupeHash: 'hash-1',
    createdAt: '2026-07-04T09:00:00.000Z',
    updatedAt: '2026-07-05T09:00:00.000Z',
    ...over,
  };
}

const ctx = (over: Partial<DuplicateContext> = {}): DuplicateContext => ({
  payeeName: 'Tesco',
  tagNames: ['food', 'weekly'],
  categoryKind: 'expense',
  transferPair: null,
  ...over,
});

/** Freeze a transaction and everything hanging off it, so any write throws. */
function deepFreeze(t: Transaction): Transaction {
  Object.freeze(t.tagIds);
  t.splits.forEach((s) => Object.freeze(s));
  Object.freeze(t.splits);
  return Object.freeze(t);
}

// ---------------------------------------------------------------- the copy
describe('duplicateDraftFrom', () => {
  it('carries every field the user typed', () => {
    const source = tx({ status: 'pending' });
    expect(duplicateDraftFrom(source, ctx(), TODAY)).toEqual({
      mode: 'expense',
      amountMinor: 1250, // positive magnitude; sign comes from mode/refund
      refund: false,
      categoryId: 'cat-groceries',
      payeeName: 'Tesco',
      accountId: 'acc-current',
      date: TODAY,
      tagNames: ['food', 'weekly'],
      notes: 'weekly shop',
      pending: true,
      splits: [],
      transfer: null,
      sourceDate: '2026-07-04',
    });
  });

  it('carries nothing that identifies the original — no id, batch, group or timestamps', () => {
    const draft = duplicateDraftFrom(tx({ importBatchId: 'batch-moneywiz' }), ctx(), TODAY);
    for (const field of [
      'id',
      'importBatchId',
      'transferGroupId',
      'createdAt',
      'updatedAt',
      'dedupeHash',
      'currency',
    ]) {
      expect(draft).not.toHaveProperty(field);
    }
    // and the thing that turns a save into an update is absent too
    expect(draftToSaveInput(draft)).not.toHaveProperty('id');
  });

  it('dates the copy today, and names the original date so the change is visible', () => {
    const draft = duplicateDraftFrom(tx({ date: '2025-11-30' }), ctx(), TODAY);
    expect(draft.date).toBe(TODAY);
    expect(draft.sourceDate).toBe('2025-11-30');
  });

  it('has no date note to show when the original is already today', () => {
    const draft = duplicateDraftFrom(tx({ date: TODAY }), ctx(), TODAY);
    expect(draft.date).toBe(TODAY);
    expect(draft.sourceDate).toBe(null);
  });

  it('copies income as income', () => {
    const draft = duplicateDraftFrom(
      tx({ amountMinor: 250000, categoryId: 'cat-salary' }),
      ctx({ categoryKind: 'income' }),
      TODAY,
    );
    expect(draft.mode).toBe('income');
    expect(draft.refund).toBe(false);
    expect(draft.amountMinor).toBe(250000);
    expect(draftSign(draft.mode, draft.refund) * draft.amountMinor!).toBe(250000);
  });

  it('copies a refund as a refund — a positive amount in an expense category (D14)', () => {
    const draft = duplicateDraftFrom(
      tx({ amountMinor: 1250 }),
      ctx({ categoryKind: 'expense' }),
      TODAY,
    );
    expect(draft.mode).toBe('expense');
    expect(draft.refund).toBe(true);
    // and it saves back out positive, still in the expense category
    const input = draftToSaveInput(draft);
    expect(input.amountMinor).toBe(1250);
    expect(input.categoryId).toBe('cat-groceries');
  });

  it('copies splits as new rows that still sum exactly to the amount', () => {
    const source = tx({
      amountMinor: -4599,
      categoryId: null,
      splits: [
        { categoryId: 'cat-groceries', amountMinor: -1500, notes: 'food' },
        { categoryId: 'cat-household', amountMinor: -3099 },
      ],
    });
    const draft = duplicateDraftFrom(source, ctx(), TODAY);
    expect(draft.splits).toEqual([
      { key: 0, categoryId: 'cat-groceries', amountMinor: 1500, notes: 'food' },
      { key: 1, categoryId: 'cat-household', amountMinor: 3099, notes: '' },
    ]);
    // the editor's own rule: magnitudes must add up to the drafted amount
    const total = draft.splits.reduce((n, s) => n + (s.amountMinor ?? 0), 0);
    expect(total).toBe(draft.amountMinor);

    // and signed on the way out they satisfy the domain's exact-sum rule
    const input = draftToSaveInput(draft);
    expect(input.amountMinor).toBe(-4599);
    expect(input.splits).toEqual([
      { categoryId: 'cat-groceries', amountMinor: -1500, notes: 'food' },
      { categoryId: 'cat-household', amountMinor: -3099 },
    ]);
    expect(validateSplits(input.amountMinor, input.splits!)).toBe(null);
    // splits own the categories; the parent category is dropped
    expect(input.categoryId).toBe(null);
  });

  it('keeps a positive split set summing when the parent is a refund', () => {
    const source = tx({
      amountMinor: 4599,
      categoryId: null,
      splits: [
        { categoryId: 'cat-groceries', amountMinor: 1500 },
        { categoryId: 'cat-household', amountMinor: 3099 },
      ],
    });
    const input = draftToSaveInput(duplicateDraftFrom(source, ctx(), TODAY));
    expect(input.amountMinor).toBe(4599);
    expect(validateSplits(input.amountMinor, input.splits!)).toBe(null);
  });

  it('copies a transfer leg as a whole pair, both amounts explicit', () => {
    const group = 'grp-1';
    const fromLeg = tx({
      id: 'leg-from',
      accountId: 'acc-current',
      amountMinor: -20000,
      currency: 'GBP',
      categoryId: null,
      payeeId: null,
      tagIds: [],
      splits: [],
      transferGroupId: group,
      notes: 'holiday money',
    });
    const toLeg = tx({
      id: 'leg-to',
      accountId: 'acc-euro',
      amountMinor: 23150,
      currency: 'EUR',
      categoryId: null,
      payeeId: null,
      tagIds: [],
      splits: [],
      transferGroupId: group,
      notes: 'holiday money',
    });
    // duplicating from EITHER leg produces the same, correctly-directed pair
    for (const leg of [fromLeg, toLeg]) {
      const draft = duplicateDraftFrom(
        leg,
        ctx({ payeeName: '', tagNames: [], categoryKind: null, transferPair: [fromLeg, toLeg] }),
        TODAY,
      );
      expect(draft.mode).toBe('transfer');
      expect(draft.transfer).toEqual({
        fromAccountId: 'acc-current',
        toAccountId: 'acc-euro',
        amountFromMinor: 20000, // sent, in GBP
        amountToMinor: 23150, // received, in EUR — never derived from a rate
      });
      expect(draft.notes).toBe('holiday money');
      expect(draft.date).toBe(TODAY);
      expect(draft.categoryId).toBe(null);
      expect(draft.splits).toEqual([]);
    }
  });

  it('never touches the transaction it copies', () => {
    const source = deepFreeze(
      tx({
        amountMinor: -4599,
        splits: [
          { categoryId: 'cat-groceries', amountMinor: -1500, notes: 'food' },
          { categoryId: 'cat-household', amountMinor: -3099 },
        ],
      }),
    );
    const before = structuredClone(source);
    const draft = duplicateDraftFrom(source, ctx(), TODAY);

    // editing the copy must not reach back into the original
    draft.splits[0]!.amountMinor = 1;
    draft.splits.pop();
    draft.tagNames.push('nonsense');
    expect(source).toEqual(before);
    expect(source.splits).toHaveLength(2);
  });
});

// ------------------------------------------------------- looking things up
describe('duplicateContextFrom', () => {
  const payee: Payee = {
    id: 'payee-tesco',
    name: 'Tesco',
    nameLower: 'tesco',
    defaultCategoryId: null,
  };
  const cat = (id: string, kind: Category['kind']): Category => ({
    id,
    name: id,
    parentId: null,
    kind,
    archived: false,
    sortOrder: 0,
  });
  const tag = (id: string, name: string): Tag => ({ id, name, nameLower: name });
  const maps = {
    payeesById: new Map([[payee.id, payee]]),
    tagsById: new Map([
      ['tag-food', tag('tag-food', 'food')],
      ['tag-weekly', tag('tag-weekly', 'weekly')],
    ]),
    categoriesById: new Map([
      ['cat-groceries', cat('cat-groceries', 'expense')],
      ['cat-salary', cat('cat-salary', 'income')],
    ]),
  };

  it('resolves the payee name, tag names and category kind', () => {
    expect(duplicateContextFrom(tx(), maps, null)).toEqual({
      payeeName: 'Tesco',
      tagNames: ['food', 'weekly'],
      categoryKind: 'expense',
      transferPair: null,
    });
  });

  it('falls back to the first split category for the kind', () => {
    const c = duplicateContextFrom(
      tx({
        categoryId: null,
        splits: [
          { categoryId: null, amountMinor: -100 },
          { categoryId: 'cat-salary', amountMinor: -1150 },
        ],
      }),
      maps,
      null,
    );
    expect(c.categoryKind).toBe('income');
  });

  it('copes with a transaction that has no payee, tags or category', () => {
    expect(
      duplicateContextFrom(tx({ payeeId: null, tagIds: [], categoryId: null }), maps, null),
    ).toEqual({ payeeName: '', tagNames: [], categoryKind: null, transferPair: null });
  });
});

// --------------------------------------------------------- through the domain
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

async function makeCategory(name: string, kind: Category['kind'] = 'expense'): Promise<Category> {
  const c: Category = { id: uid(), name, parentId: null, kind, archived: false, sortOrder: 0 };
  await db.categories.put(c);
  return c;
}

/** The lookups the register hands `duplicateContextFrom`, straight from the db. */
async function liveMaps() {
  const [payees, tags, categories] = await Promise.all([
    db.payees.toArray(),
    db.tags.toArray(),
    db.categories.toArray(),
  ]);
  return {
    payeesById: new Map(payees.map((p) => [p.id, p])),
    tagsById: new Map(tags.map((t) => [t.id, t])),
    categoriesById: new Map(categories.map((c) => [c.id, c])),
  };
}

describe('saving a duplicate', () => {
  beforeEach(clearAll);

  it('inserts a new transaction and leaves the original untouched', async () => {
    const acc = await makeAccount();
    const cat = await makeCategory('Groceries');
    const original = await saveTransaction({
      accountId: acc.id,
      date: '2026-07-04',
      amountMinor: -1250,
      payeeName: 'Tesco',
      categoryId: cat.id,
      tagNames: ['food'],
      notes: 'weekly shop',
      status: 'pending',
      importBatchId: 'batch-moneywiz',
    });
    const before = await db.transactions.get(original.id);

    const draft = duplicateDraftFrom(
      original,
      duplicateContextFrom(original, await liveMaps(), null),
      TODAY,
    );
    const copy = await saveTransaction(draftToSaveInput(draft));

    // the original is byte-identical — the copy could not have updated it
    expect(await db.transactions.get(original.id)).toEqual(before);
    expect(await db.transactions.count()).toBe(2);

    expect(copy.id).not.toBe(original.id);
    expect(copy.importBatchId).toBe(null); // a copy is a manual entry, not imported
    expect(copy.transferGroupId).toBe(null);
    expect(copy.date).toBe(TODAY);
    // everything the user typed came across
    expect(copy.amountMinor).toBe(-1250);
    expect(copy.currency).toBe('GBP');
    expect(copy.accountId).toBe(acc.id);
    expect(copy.categoryId).toBe(cat.id);
    expect(copy.payeeId).toBe(original.payeeId);
    expect(copy.tagIds).toEqual(original.tagIds);
    expect(copy.notes).toBe('weekly shop');
    expect(copy.status).toBe('pending');
    // a different date means a different dedupe hash — the copy is not a dupe
    expect(copy.dedupeHash).not.toBe(original.dedupeHash);
  });

  it('inserts a split copy whose splits still sum exactly to the parent', async () => {
    const acc = await makeAccount();
    const food = await makeCategory('Groceries');
    const home = await makeCategory('Household');
    const original = await saveTransaction({
      accountId: acc.id,
      date: '2026-07-04',
      amountMinor: -4599,
      payeeName: 'Tesco',
      splits: [
        { categoryId: food.id, amountMinor: -1500, notes: 'food' },
        { categoryId: home.id, amountMinor: -3099 },
      ],
    });

    const draft = duplicateDraftFrom(
      original,
      duplicateContextFrom(original, await liveMaps(), null),
      TODAY,
    );
    const copy = await saveTransaction(draftToSaveInput(draft));

    expect(copy.splits.reduce((n, s) => n + s.amountMinor, 0)).toBe(copy.amountMinor);
    expect(copy.splits).toEqual([
      { categoryId: food.id, amountMinor: -1500, notes: 'food' },
      { categoryId: home.id, amountMinor: -3099 },
    ]);
    expect(copy.categoryId).toBe(null);
    expect((await db.transactions.get(original.id))!.splits).toHaveLength(2);
  });

  it('copies a cross-currency transfer as a NEW pair, never an orphan leg', async () => {
    const gbp = await makeAccount({ name: 'Current', currency: 'GBP' });
    const eur = await makeAccount({ name: 'Euro', currency: 'EUR', sortOrder: 1 });
    const [origFrom, origTo] = await saveTransfer({
      fromAccountId: gbp.id,
      toAccountId: eur.id,
      date: '2026-05-04',
      amountFromMinor: 20000,
      amountToMinor: 23150,
      notes: 'holiday money',
    });
    const pair = await getTransferPair(origFrom.transferGroupId!);
    expect(pair).not.toBe(null);

    // duplicate from the leg the user clicked — the RECEIVING one
    const draft = duplicateDraftFrom(
      origTo,
      duplicateContextFrom(origTo, await liveMaps(), pair),
      TODAY,
    );
    // exactly what TxEditor does on save: no transferGroupId ⇒ a new pair
    const [newFrom, newTo] = await saveTransfer(
      transferDraftToInput(
        await db.accounts.toArray(),
        draft.transfer!,
        draft.date,
        draft.notes,
        draft.pending ? 'pending' : 'cleared',
        undefined,
      ),
    );

    expect(await db.transactions.count()).toBe(4);
    expect(newFrom.transferGroupId).not.toBe(origFrom.transferGroupId);
    expect(newTo.transferGroupId).toBe(newFrom.transferGroupId);
    // both legs, both accounts, both explicit amounts, both currencies
    expect(newFrom.accountId).toBe(gbp.id);
    expect(newFrom.amountMinor).toBe(-20000);
    expect(newFrom.currency).toBe('GBP');
    expect(newTo.accountId).toBe(eur.id);
    expect(newTo.amountMinor).toBe(23150);
    expect(newTo.currency).toBe('EUR');
    expect(newFrom.date).toBe(TODAY);
    expect(newTo.notes).toBe('holiday money');

    // the transfer that was copied is exactly as it was
    expect(await db.transactions.get(origFrom.id)).toEqual(origFrom);
    expect(await db.transactions.get(origTo.id)).toEqual(origTo);
  });
});
