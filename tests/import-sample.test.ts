// Sample data tests (D19): one 'sample' ImportBatch, realistic content,
// one-tap removal returns the db to seeded-categories + settings only.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, getSettings, updateSettings } from '../src/db/db';
import { todayISO } from '../src/lib/util';
import { ACCOUNT_TEMPLATES, accountFromTemplate, seedCategoriesIfEmpty } from '../src/db/seed';
import { sumSplits } from '../src/money/money';
import { setManualRate } from '../src/domain/fx';
import {
  loadSampleData,
  removeSampleData,
  SAMPLE_PREFIX,
  sampleDataBatchId,
} from '../src/domain/sample';
import { backupNudgeState } from '../src/backup/backup';
import { visibleNotices } from '../src/ui/layout/BackupNudge';

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
    expect(groupNames).toEqual(['Sample · Everyday', 'Sample · Saving & Credit']);
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

  // E1: the first-five-minutes path — accept the four pre-ticked starter
  // accounts in onboarding, then tap "Load sample data". Before the fix that
  // produced eight accounts with three DUPLICATED names (Current Account,
  // Savings, Cash) and ~£12k of demo money hidden inside one net-worth figure.
  it('never collides with the onboarding starter accounts', async () => {
    const starters = ACCOUNT_TEMPLATES.map((t, i) => ({
      ...accountFromTemplate(t, 'GBP', i),
      openingBalanceMinor: 500_000, // real money, as in the audit's run
    }));
    await db.accounts.bulkAdd(starters);

    await loadSampleData();

    const accounts = await db.accounts.toArray();
    expect(accounts).toHaveLength(8);
    const names = accounts.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length); // no duplicated names at all

    // Every one of the user's own accounts is untouched…
    for (const starter of starters) {
      expect(await db.accounts.get(starter.id)).toEqual(starter);
    }
    // …and every sample account says what it is, wherever it is shown.
    const batchId = (await sampleDataBatchId())!;
    const batch = (await db.importBatches.get(batchId))!;
    expect(batch.createdAccountIds).toHaveLength(4);
    for (const id of batch.createdAccountIds) {
      expect((await db.accounts.get(id))!.name.startsWith(SAMPLE_PREFIX)).toBe(true);
    }
  });

  it('labels the sample groups and budgets too (SPEC §4)', async () => {
    await loadSampleData();
    for (const g of await db.accountGroups.toArray()) {
      expect(g.name.startsWith(SAMPLE_PREFIX)).toBe(true);
    }
    for (const b of await db.budgets.toArray()) {
      expect(b.name.startsWith(SAMPLE_PREFIX)).toBe(true);
    }
  });

  // E2: demo data is not worth backing up, and one tap removes it.
  it('does not make the backup nudge due, however old the install is', async () => {
    await updateSettings({ createdAt: '2020-01-01T00:00:00.000Z', lastBackupAt: null });
    await loadSampleData();
    const nudge = await backupNudgeState();
    expect(nudge.txCount).toBeGreaterThan(0);
    expect(nudge.realTxCount).toBe(0);
    expect(nudge.due).toBe(false);
  });

  it('is idempotent — a second load does not duplicate', async () => {
    await loadSampleData();
    const count = await db.transactions.count();
    await loadSampleData();
    expect(await db.transactions.count()).toBe(count);
    expect(await db.importBatches.count()).toBe(1);
  });
});

// E1(b): loaded sample data must be visible from ANYWHERE, not only from
// Settings → Imports — the demo money merges into one net-worth figure that
// cannot label itself. The banner shares App's notice slot with the backup
// nudge; this is the slot's policy (the markup around it needs a DOM the test
// suite does not have).
describe('sample-data notice', () => {
  const input = (over: Partial<Parameters<typeof visibleNotices>[0]> = {}) => ({
    sampleBatchId: null as string | null | undefined,
    sampleDismissed: false,
    backupDue: false as boolean | undefined,
    backupDismissed: false,
    ...over,
  });

  it('shows while a sample batch exists, and stops when it is removed', async () => {
    expect(visibleNotices(input({ sampleBatchId: await sampleDataBatchId() }))).toEqual([]);
    await loadSampleData();
    expect(visibleNotices(input({ sampleBatchId: await sampleDataBatchId() }))).toEqual(['sample']);
    await removeSampleData();
    expect(visibleNotices(input({ sampleBatchId: await sampleDataBatchId() }))).toEqual([]);
  });

  it('never hides the backup nudge — both notices can show at once', () => {
    expect(visibleNotices(input({ sampleBatchId: 'b1', backupDue: true }))).toEqual([
      'sample',
      'backup',
    ]);
    expect(visibleNotices(input({ sampleBatchId: 'b1', backupDue: true, sampleDismissed: true })))
      .toEqual(['backup']);
    expect(visibleNotices(input({ sampleBatchId: 'b1', backupDue: true, backupDismissed: true })))
      .toEqual(['sample']);
  });

  it('shows nothing while the queries are still loading', () => {
    expect(visibleNotices(input({ sampleBatchId: undefined, backupDue: undefined }))).toEqual([]);
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

  it('keeps the EUR:GBP rate once the user has edited it into their own', async () => {
    // fxRates rows have a fixed primary key, so editing the sample's rate
    // OVERWRITES that row — after which deleting it would drop the user's EUR
    // accounts out of net worth. Removing samples must never destroy it.
    await loadSampleData();
    expect((await db.fxRates.get('EUR:GBP'))!.rate).toBe(0.85);
    await setManualRate('EUR', 'GBP', 0.8712);

    await removeSampleData();

    const rate = await db.fxRates.get('EUR:GBP');
    expect(rate).toBeDefined();
    expect(rate!.rate).toBe(0.8712);
    // …everything else the sample created is still gone.
    expect(await db.accounts.count()).toBe(0);
    expect(await db.importBatches.count()).toBe(0);
  });

  it('is a no-op when no sample data is loaded', async () => {
    await removeSampleData();
    expect(await db.importBatches.count()).toBe(0);
  });
});
