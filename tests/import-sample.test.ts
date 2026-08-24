// Sample data tests (D19): one 'sample' ImportBatch, realistic content,
// one-tap removal returns the db to seeded-categories + settings only.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, getSettings, updateSettings } from '../src/db/db';
import { todayISO } from '../src/lib/util';
import { seedCategoriesIfEmpty } from '../src/db/seed';
import { sumSplits } from '../src/money/money';
import {
  loadSampleData,
  removeSampleData,
  sampleDataBatchId,
} from '../src/domain/sample';

const clearAll = async (): Promise<void> => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

beforeEach(async () => {
  await clearAll();
  await seedCategoriesIfEmpty();
});

describe('loadSampleData', () => {
  it('creates one sample batch with all created ids recorded', async () => {
    await loadSampleData();
    const batchId = await sampleDataBatchId();
    expect(batchId).not.toBeNull();
    const batch = (await db.importBatches.get(batchId!))!;
    expect(batch.source).toBe('sample');
    expect(batch.fileName).toBe('Sample data');

    // 2 groups, 4 accounts (one EUR), 2 budgets, EUR:GBP manual rate.
    expect(await db.accountGroups.count()).toBe(2);
    expect(await db.accounts.count()).toBe(4);
    expect(await db.budgets.count()).toBe(2);
    const rate = await db.fxRates.get('EUR:GBP');
    expect(rate).toMatchObject({ rate: 0.85, source: 'manual' });

    // Every created entity id is recorded on the batch (D18/D19).
    expect(batch.createdGroupIds).toHaveLength(2);
    expect(batch.createdAccountIds).toHaveLength(4);
    expect(batch.createdBudgetIds).toHaveLength(2);
    expect(batch.createdFxRateIds).toEqual(['EUR:GBP']);
    expect(batch.createdPayeeIds.length).toBe(await db.payees.count());
    expect(batch.createdTagIds.length).toBe(await db.tags.count());
    expect(batch.createdCategoryIds).toEqual([]); // reused the seeded tree
    expect(batch.rowCount).toBe(await db.transactions.count());

    const groupNames = (await db.accountGroups.toArray()).map((g) => g.name).sort();
    expect(groupNames).toEqual(['Everyday', 'Saving & Credit']);
    const eur = (await db.accounts.toArray()).filter((a) => a.currency === 'EUR');
    expect(eur).toHaveLength(1);
  });

  it('generates ~6 months of realistic transactions', async () => {
    await loadSampleData();
    const txs = await db.transactions.toArray();
    expect(txs.length).toBeGreaterThan(80); // salary+rent+weekly spending etc.

    // Exactly one PENDING recent transaction.
    expect(txs.filter((t) => t.status === 'pending')).toHaveLength(1);

    // One SPLIT transaction whose splits sum exactly to the parent (SPEC §6).
    const splits = txs.filter((t) => t.splits.length > 0);
    expect(splits).toHaveLength(1);
    expect(splits[0].splits).toHaveLength(2);
    expect(sumSplits(splits[0].splits)).toBe(splits[0].amountMinor); // -5000 + -3648 = -8648
    expect(splits[0].amountMinor).toBe(-8648);

    // A REFUND: positive amount in an EXPENSE category (D14).
    const refund = txs.find((t) => t.amountMinor === 2500)!;
    expect(refund).toBeDefined();
    const refundCat = (await db.categories.get(refund.categoryId!))!;
    expect(refundCat.kind).toBe('expense');

    // Monthly Current→Savings transfer PAIRS: legs share a group id and
    // net to zero; categoryId is null on every leg.
    const legs = txs.filter((t) => t.transferGroupId !== null);
    expect(legs.length).toBeGreaterThanOrEqual(10); // ~6 monthly pairs
    expect(legs.length % 2).toBe(0);
    const byGroup = new Map<string, number[]>();
    for (const l of legs) {
      expect(l.categoryId).toBeNull();
      const list = byGroup.get(l.transferGroupId!) ?? [];
      list.push(l.amountMinor);
      byGroup.set(l.transferGroupId!, list);
    }
    for (const amounts of byGroup.values()) {
      expect(amounts).toHaveLength(2);
      expect(amounts[0] + amounts[1]).toBe(0); // -30000 + 30000
    }

    // EUR transactions exist on the EUR account, in EUR.
    const eurTxs = txs.filter((t) => t.currency === 'EUR');
    expect(eurTxs.length).toBeGreaterThanOrEqual(2);

    // All dates within the last ~6 months, none after the device-local today
    // (dates are 'YYYY-MM-DD' calendar dates in the device timezone).
    const today = todayISO();
    expect(txs.every((t) => t.date <= today)).toBe(true);
  });

  it('is idempotent — a second load does not duplicate', async () => {
    await loadSampleData();
    const count = await db.transactions.count();
    await loadSampleData();
    expect(await db.transactions.count()).toBe(count);
    expect(await db.importBatches.count()).toBe(1);
  });
});

describe('removeSampleData', () => {
  it('leaves only the seeded categories and settings', async () => {
    const seedCount = await db.categories.count();
    await updateSettings({ onboarded: true });

    await loadSampleData();
    expect(await db.transactions.count()).toBeGreaterThan(0);

    await removeSampleData();

    expect(await db.transactions.count()).toBe(0);
    expect(await db.accounts.count()).toBe(0);
    expect(await db.accountGroups.count()).toBe(0);
    expect(await db.payees.count()).toBe(0);
    expect(await db.tags.count()).toBe(0);
    expect(await db.budgets.count()).toBe(0);
    expect(await db.fxRates.count()).toBe(0);
    expect(await db.importBatches.count()).toBe(0);
    expect(await db.categories.count()).toBe(seedCount); // seeded tree intact
    expect((await getSettings()).onboarded).toBe(true); // settings survive
    expect(await sampleDataBatchId()).toBeNull();
  });

  it('leaves a pre-existing user EUR:GBP rate alone', async () => {
    await db.fxRates.put({
      id: 'EUR:GBP', base: 'EUR', quote: 'GBP', rate: 0.9,
      asOf: '2026-01-01T00:00:00.000Z', source: 'manual',
    });
    await loadSampleData();
    // sample must not have overwritten the user's rate…
    expect((await db.fxRates.get('EUR:GBP'))!.rate).toBe(0.9);
    await removeSampleData();
    // …and must not remove it on undo.
    expect((await db.fxRates.get('EUR:GBP'))!.rate).toBe(0.9);
  });

  it('is a no-op when no sample data is loaded', async () => {
    await removeSampleData();
    expect(await db.importBatches.count()).toBe(0);
  });
});
