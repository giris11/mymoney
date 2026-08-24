// Tests for the shared foundation modules: dedupe hashing/similarity,
// category tree domain, payees, tags. (SPEC §10)
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkDuplicate,
  levenshtein,
  makeDedupeHash,
  normalizeForHash,
  similarPayee,
} from '../src/import/dedupe';
import { db } from '../src/db/db';
import {
  buildTree,
  categoryPathName,
  categoryTree,
  deleteCategory,
  descendantIds,
  findOrCreateByPath,
  saveCategory,
} from '../src/domain/categories';
import { getOrCreatePayee, learnPayeeCategory, searchPayees, deletePayee } from '../src/domain/payees';
import { deleteTag, getOrCreateTags } from '../src/domain/tags';
import type { Category, Transaction } from '../src/db/types';

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

// ---------------------------------------------------------------- dedupe
describe('normalizeForHash', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeForHash("  TESCO Stores,  Ltd. ")).toBe('tesco stores ltd');
    expect(normalizeForHash("Sainsbury's #1234")).toBe('sainsburys 1234');
    expect(normalizeForHash('')).toBe('');
  });
});

describe('makeDedupeHash', () => {
  it('is the normalised key string (D10)', () => {
    expect(makeDedupeHash('acc1', '2026-03-01', -4567, 'Tesco!')).toBe(
      'acc1|2026-03-01|-4567|tesco',
    );
  });
});

describe('levenshtein / similarPayee', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });
  it('accepts equal/contained/close names', () => {
    expect(similarPayee('Tesco', 'TESCO ')).toBe(true);
    expect(similarPayee('Tesco Stores 3412', 'Tesco')).toBe(true);
    expect(similarPayee('Amazon.co.uk', 'Amazon co uk')).toBe(true);
    expect(similarPayee('Starbucks', 'Starbcuks')).toBe(true); // transposition-ish
  });
  it('rejects clearly different names', () => {
    expect(similarPayee('Tesco', 'Netflix')).toBe(false);
    expect(similarPayee('Shell', '')).toBe(false);
  });
});

const fakeTx = (over: Partial<Transaction>): Transaction => ({
  id: over.id ?? 'tx',
  accountId: 'acc1',
  date: '2026-03-01',
  amountMinor: -4567,
  currency: 'GBP',
  payeeId: null,
  categoryId: null,
  tagIds: [],
  notes: '',
  status: 'cleared',
  splits: [],
  transferGroupId: null,
  importBatchId: null,
  dedupeHash: makeDedupeHash('acc1', over.date ?? '2026-03-01', over.amountMinor ?? -4567, over.notes ?? 'Tesco'),
  createdAt: '',
  updatedAt: '',
  ...over,
});

describe('checkDuplicate', () => {
  const payeeName = () => 'Tesco';
  it('flags exact duplicates by hash', () => {
    const existing = [fakeTx({})];
    const res = checkDuplicate(
      { accountId: 'acc1', date: '2026-03-01', amountMinor: -4567, payeeOrDescription: 'Tesco' },
      existing,
      payeeName,
    );
    expect(res.exact).toBe(true);
  });
  it('flags near duplicates: same amount, ±1 day, similar payee', () => {
    const existing = [fakeTx({ date: '2026-03-02' })];
    const res = checkDuplicate(
      { accountId: 'acc1', date: '2026-03-01', amountMinor: -4567, payeeOrDescription: 'Tesco Stores' },
      existing,
      payeeName,
    );
    expect(res.exact).toBe(false);
    expect(res.nearDuplicateOf).not.toBeNull();
  });
  it('does not flag different amounts or far dates', () => {
    const cand = { accountId: 'acc1', date: '2026-03-01', amountMinor: -4567, payeeOrDescription: 'Tesco' };
    expect(checkDuplicate(cand, [fakeTx({ amountMinor: -4568 })], payeeName).nearDuplicateOf).toBeNull();
    expect(
      checkDuplicate(cand, [fakeTx({ date: '2026-03-03', dedupeHash: 'x' })], payeeName).nearDuplicateOf,
    ).toBeNull();
  });
  it('prefers the same-date candidate', () => {
    const sameDay = fakeTx({ id: 'same', dedupeHash: 'different-so-not-exact' });
    const nextDay = fakeTx({ id: 'next', date: '2026-03-02' });
    const res = checkDuplicate(
      { accountId: 'acc1', date: '2026-03-01', amountMinor: -4567, payeeOrDescription: 'Tesco Store' },
      [nextDay, sameDay],
      payeeName,
    );
    expect(res.nearDuplicateOf?.id).toBe('same');
  });
});

// ---------------------------------------------------------------- categories
const cat = (id: string, name: string, parentId: string | null, sortOrder = 0): Category => ({
  id, name, parentId, kind: 'expense', archived: false, sortOrder,
});

describe('category tree (pure)', () => {
  const cats = [
    cat('food', 'Food', null, 1),
    cat('groc', 'Groceries', 'food'),
    cat('rest', 'Restaurants', 'food', 1),
    cat('bills', 'Bills', null, 0),
    cat('orphan', 'Orphan', 'missing-parent'),
  ];
  it('builds a sorted tree, orphans as roots', () => {
    const tree = buildTree(cats);
    // sorted by sortOrder first (Bills 0, Orphan 0, Food 1), then name
    expect(tree.map((n) => n.name)).toEqual(['Bills', 'Orphan', 'Food']);
    expect(tree[1].children.map((n) => n.name)).toEqual(['Groceries', 'Restaurants']);
  });
  it('descendantIds includes roots and all descendants', () => {
    expect(descendantIds(cats, ['food'])).toEqual(new Set(['food', 'groc', 'rest']));
    expect(descendantIds(cats, ['groc'])).toEqual(new Set(['groc']));
  });
  it('categoryPathName walks up the chain', () => {
    const byId = new Map(cats.map((c) => [c.id, c]));
    expect(categoryPathName(byId, 'groc')).toBe('Food › Groceries');
    expect(categoryPathName(byId, 'bills')).toBe('Bills');
  });
});

describe('category domain (db)', () => {
  beforeEach(clearAll);
  it('saveCategory creates roots and children; findOrCreateByPath reuses case-insensitively', async () => {
    const root = await saveCategory({ name: 'Food & Drink', kind: 'expense' });
    const leaf = await findOrCreateByPath(['food & drink', 'Groceries'], 'expense');
    expect(leaf.parentId).toBe(root.id);
    const again = await findOrCreateByPath(['Food & Drink', 'groceries'], 'expense');
    expect(again.id).toBe(leaf.id);
    expect(await db.categories.count()).toBe(2);
  });
  it('rejects cycles and cross-kind parents', async () => {
    const a = await saveCategory({ name: 'A', kind: 'expense' });
    const b = await saveCategory({ name: 'B', kind: 'expense', parentId: a.id });
    await expect(saveCategory({ id: a.id, name: 'A', kind: 'expense', parentId: b.id })).rejects.toThrow();
    await expect(saveCategory({ name: 'C', kind: 'income', parentId: a.id })).rejects.toThrow();
  });
  it('deleteCategory blocks when used, clears payee defaults when not', async () => {
    const a = await saveCategory({ name: 'A', kind: 'expense' });
    const b = await saveCategory({ name: 'B', kind: 'expense', parentId: a.id });
    expect((await deleteCategory(a.id)).ok).toBe(false); // has child
    const p = await getOrCreatePayee('Tesco');
    await db.payees.update(p.id, { defaultCategoryId: b.id });
    expect((await deleteCategory(b.id)).ok).toBe(true);
    expect((await db.payees.get(p.id))?.defaultCategoryId).toBe(null);
  });
  it('categoryTree prunes archived subtrees', async () => {
    const a = await saveCategory({ name: 'A', kind: 'expense' });
    await saveCategory({ name: 'B', kind: 'expense', parentId: a.id });
    await saveCategory({ id: a.id, name: 'A', kind: 'expense', archived: true });
    expect(await categoryTree('expense')).toEqual([]);
    expect((await categoryTree('expense', true)).length).toBe(1);
  });
});

// ---------------------------------------------------------------- payees/tags
describe('payees', () => {
  beforeEach(clearAll);
  it('getOrCreate is case/whitespace-insensitive', async () => {
    const a = await getOrCreatePayee('Tesco  Stores');
    const b = await getOrCreatePayee(' tesco stores ');
    expect(b.id).toBe(a.id);
    expect(a.name).toBe('Tesco Stores');
  });
  it('search ranks prefix before substring', async () => {
    await getOrCreatePayee('Tesco');
    await getOrCreatePayee('Costa Coffee');
    await getOrCreatePayee('Te Amo Cafe');
    const res = await searchPayees('te');
    expect(res.map((p) => p.name)).toEqual(['Te Amo Cafe', 'Tesco']); // prefix matches only
    const res2 = await searchPayees('co');
    expect(res2[0].name).toBe('Costa Coffee'); // prefix beats substring ('Tesco')
    expect(res2.map((p) => p.name)).toContain('Tesco');
  });
  it('learns the most frequent category, ties → most recent', async () => {
    const p = await getOrCreatePayee('Tesco');
    const groc = await saveCategory({ name: 'Groceries', kind: 'expense' });
    const fuel = await saveCategory({ name: 'Fuel', kind: 'expense' });
    const mk = (id: string, categoryId: string, date: string) =>
      fakeTx({ id, payeeId: p.id, categoryId, date, accountId: 'a1' });
    await db.transactions.bulkAdd([
      mk('1', groc.id, '2026-01-01'),
      mk('2', groc.id, '2026-01-02'),
      mk('3', fuel.id, '2026-01-03'),
    ]);
    await learnPayeeCategory(p.id);
    expect((await db.payees.get(p.id))?.defaultCategoryId).toBe(groc.id);
  });
  it('refuses to delete a used payee', async () => {
    const p = await getOrCreatePayee('Tesco');
    await db.transactions.add(fakeTx({ id: 't1', payeeId: p.id }));
    expect((await deletePayee(p.id)).ok).toBe(false);
    await db.transactions.delete('t1');
    expect((await deletePayee(p.id)).ok).toBe(true);
  });
});

describe('tags', () => {
  beforeEach(clearAll);
  it('creates/dedupes case-insensitively and skips blanks', async () => {
    const tags = await getOrCreateTags(['work', 'Work', ' ', 'holiday']);
    expect(tags.map((t) => t.name)).toEqual(['work', 'holiday']);
    expect(await db.tags.count()).toBe(2);
  });
  it('deleteTag removes the tag from transactions', async () => {
    const [tag] = await getOrCreateTags(['work']);
    await db.transactions.add(fakeTx({ id: 't1', tagIds: [tag.id] }));
    await deleteTag(tag.id);
    expect((await db.transactions.get('t1'))?.tagIds).toEqual([]);
    expect(await db.tags.count()).toBe(0);
  });
});
