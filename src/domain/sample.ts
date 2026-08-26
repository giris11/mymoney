// Demo/sample data (SPEC §4: clearly labelled, one-tap removal). CONTRACT —
// implemented by the import build agent (it reuses the import-batch machinery:
// sample data is one batch with source 'sample', so removal IS undoImport, D19).
//
// The generated set: 2 account groups, 4 accounts (incl. one EUR account for
// multi-currency), ~6 months of realistic transactions incl. transfers, a
// split, a refund and a pending one, 2 budgets, and a EUR→GBP manual rate.
//
// Everything is written in ONE Dexie rw-transaction as ONE ImportBatch with
// every created id recorded, so removeSampleData() === undoImport(batch).
// Amounts come from a small seeded PRNG (deterministic); dates are relative
// to today (dayjs), so the data always looks current.
import dayjs, { type Dayjs } from 'dayjs';
import { db } from '../db/db';
import type {
  Account,
  AccountGroup,
  AccountType,
  Budget,
  CategoryKind,
  ImportBatch,
  Split,
  Transaction,
  TxStatus,
} from '../db/types';
import { nowISO, todayISO, uid } from '../lib/util';
import { makeDedupeHash } from '../import/dedupe';
import { undoImport } from '../import/importer';
import { findOrCreateByPath } from './categories';
import { getOrCreatePayee, learnPayeeCategory } from './payees';
import { getOrCreateTags } from './tags';

/** Small deterministic PRNG (mulberry32) — same data on every load. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const D = 'YYYY-MM-DD';

/**
 * Every sample row a user meets by NAME carries this prefix (SPEC §4: sample
 * data must be clearly labelled). Groups alone were not enough: the onboarding
 * starter templates offer "Current Account", "Savings" and "Cash", so
 * un-prefixed demo accounts appeared as a second set of accounts with those
 * exact names, and their ~£12k of demo money vanished into one undifferentiated
 * net-worth figure. Prefixed names make every sample row self-identifying
 * wherever it shows up — sidebar, register, budgets, reports, exports.
 */
export const SAMPLE_PREFIX = 'Sample · ';

export async function loadSampleData(): Promise<void> {
  if ((await sampleDataBatchId()) !== null) return; // already loaded — one set only
  const rand = mulberry32(20260101);
  const today = dayjs(todayISO());
  const payeesTouched = new Set<string>();

  await db.transaction('rw', db.tables, async () => {
    const batch: ImportBatch = {
      id: uid(),
      source: 'sample',
      fileName: 'Sample data',
      rowCount: 0,
      importedAt: nowISO(),
      createdAccountIds: [],
      createdCategoryIds: [],
      createdPayeeIds: [],
      createdTagIds: [],
      createdGroupIds: [],
      createdBudgetIds: [],
      createdFxRateIds: [],
    };
    await db.importBatches.add(batch); // batch row FIRST — crash-safe undo

    const categoryIdsBefore = new Set(await db.categories.toCollection().primaryKeys());
    const payeeIdsBefore = new Set(await db.payees.toCollection().primaryKeys());
    const tagIdsBefore = new Set(await db.tags.toCollection().primaryKeys());

    // ---- groups + accounts ------------------------------------------------
    // Group names carry the "Sample" label (SPEC §4: clearly labelled) so the
    // demo accounts can't be confused with accounts the user created.
    const everyday: AccountGroup = { id: uid(), name: `${SAMPLE_PREFIX}Everyday`, sortOrder: 90 };
    const savingCredit: AccountGroup = { id: uid(), name: `${SAMPLE_PREFIX}Saving & Credit`, sortOrder: 91 };
    await db.accountGroups.bulkAdd([everyday, savingCredit]);
    batch.createdGroupIds.push(everyday.id, savingCredit.id);

    const mkAccount = async (
      name: string,
      type: AccountType,
      currency: string,
      openingBalanceMinor: number,
      colour: string,
      groupId: string,
      sortOrder: number,
    ): Promise<Account> => {
      const account: Account = {
        // Prefixed here, once, so no sample account can ever be mistaken for
        // one of the user's own (SPEC §4).
        id: uid(), name: `${SAMPLE_PREFIX}${name}`, type, currency, openingBalanceMinor, colour,
        groupId, sortOrder, archived: false,
      };
      await db.accounts.add(account);
      batch.createdAccountIds.push(account.id);
      return account;
    };
    const current = await mkAccount('Current Account', 'current', 'GBP', 185000, '#2563eb', everyday.id, 0);
    const cash = await mkAccount('Cash', 'cash', 'GBP', 6500, '#b45309', everyday.id, 1);
    const euro = await mkAccount('Euro Travel', 'current', 'EUR', 25000, '#7c3aed', everyday.id, 2);
    const savings = await mkAccount('Savings', 'savings', 'GBP', 420000, '#059669', savingCredit.id, 3);

    // ---- manual EUR:GBP rate (only if the user hasn't already set one) ----
    // Written directly rather than via setManualRate so `asOf` is the batch's
    // own timestamp: an fxRates row has a fixed primary key, so if the user
    // later edits this rate into their real one, setManualRate overwrites this
    // very row. undoImport deletes it only while asOf still matches the batch,
    // which is how "Remove sample data" avoids destroying that edit (A6).
    if (!(await db.fxRates.get('EUR:GBP'))) {
      await db.fxRates.put({
        id: 'EUR:GBP', base: 'EUR', quote: 'GBP', rate: 0.85,
        asOf: batch.importedAt, source: 'manual',
      });
      batch.createdFxRateIds!.push('EUR:GBP');
    }

    // ---- categories (paths match src/db/seed.ts → reused, not duplicated) -
    const cat = async (path: string[], kind: CategoryKind = 'expense'): Promise<string> =>
      (await findOrCreateByPath(path, kind)).id;
    const salaryCat = await cat(['Salary'], 'income');
    const rentCat = await cat(['Housing', 'Rent']);
    const groceriesCat = await cat(['Food & Drink', 'Groceries']);
    const restaurantsCat = await cat(['Food & Drink', 'Restaurants']);
    const coffeeCat = await cat(['Food & Drink', 'Coffee & Snacks']);
    const streamingCat = await cat(['Entertainment', 'Streaming & Subscriptions']);
    const mobileCat = await cat(['Bills & Utilities', 'Mobile']);
    const publicTransportCat = await cat(['Transport', 'Public Transport']);
    const fuelCat = await cat(['Transport', 'Fuel']);
    const householdCat = await cat(['Shopping', 'Household']);
    const electronicsCat = await cat(['Shopping', 'Electronics']);
    const clothingCat = await cat(['Shopping', 'Clothing']);
    const accommodationCat = await cat(['Travel', 'Accommodation']);

    // ---- payees + tags ----------------------------------------------------
    const payee = async (name: string): Promise<string> => {
      const p = await getOrCreatePayee(name);
      payeesTouched.add(p.id);
      return p.id;
    };
    const acme = await payee('Acme Ltd');
    const landlord = await payee('Hartley Lettings');
    const tesco = await payee('Tesco');
    const sainsburys = await payee("Sainsbury's");
    const netflix = await payee('Netflix');
    const spotify = await payee('Spotify');
    const vodafone = await payee('Vodafone');
    const tfl = await payee('TfL');
    const shell = await payee('Shell');
    const pret = await payee('Pret A Manger');
    const pizzaExpress = await payee('Pizza Express');
    const caffeNero = await payee('Caffe Nero');
    const amazon = await payee('Amazon');
    const marketStall = await payee('Borough Market');
    const hotelLisboa = await payee('Hotel Lisboa');
    const taberna = await payee('Taberna Real');
    const [holidayTag, workTag] = await getOrCreateTags(['holiday', 'work']);

    // ---- transaction writer ----------------------------------------------
    let written = 0;
    const addTx = async (o: {
      account: Account;
      date: Dayjs;
      amountMinor: number;
      payeeId?: string | null;
      payeeName?: string; // for the dedupe hash text
      categoryId?: string | null;
      tagIds?: string[];
      notes?: string;
      status?: TxStatus;
      splits?: Split[];
      transferGroupId?: string | null;
    }): Promise<void> => {
      const date = o.date.format(D);
      const timestamp = nowISO();
      const tx: Transaction = {
        id: uid(),
        accountId: o.account.id,
        date,
        amountMinor: o.amountMinor,
        currency: o.account.currency,
        payeeId: o.payeeId ?? null,
        categoryId: o.categoryId ?? null,
        tagIds: o.tagIds ?? [],
        notes: o.notes ?? '',
        status: o.status ?? 'cleared',
        splits: o.splits ?? [],
        transferGroupId: o.transferGroupId ?? null,
        importBatchId: batch.id,
        // same payee-if-present-else-description rule as real imports (D10)
        dedupeHash: makeDedupeHash(o.account.id, date, o.amountMinor, o.payeeName ?? o.notes ?? ''),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await db.transactions.add(tx);
      written++;
    };

    /** The last `n` monthly occurrences of day-of-month `dom`, oldest first. */
    const monthlyDates = (dom: number, n = 6): Dayjs[] => {
      const out: Dayjs[] = [];
      for (let i = 0; out.length < n && i < n + 2; i++) {
        const d = today.subtract(i, 'month').date(dom);
        if (!d.isAfter(today)) out.push(d);
      }
      return out.reverse();
    };

    // Salary: £2,650.00 on the 25th
    for (const d of monthlyDates(25)) {
      await addTx({
        account: current, date: d, amountMinor: 265000, payeeId: acme, payeeName: 'Acme Ltd',
        categoryId: salaryCat, tagIds: [workTag.id], notes: 'Monthly salary',
      });
    }
    // Rent: £1,200.00 on the 1st
    for (const d of monthlyDates(1)) {
      await addTx({
        account: current, date: d, amountMinor: -120000, payeeId: landlord,
        payeeName: 'Hartley Lettings', categoryId: rentCat, notes: 'Rent',
      });
    }
    // Monthly Current → Savings transfer pair: £300.00 on the 26th
    for (const d of monthlyDates(26)) {
      const groupId = uid();
      await addTx({
        account: current, date: d, amountMinor: -30000, transferGroupId: groupId,
        notes: `Transfer to ${savings.name}`,
      });
      await addTx({
        account: savings, date: d, amountMinor: 30000, transferGroupId: groupId,
        notes: `Transfer from ${current.name}`,
      });
    }
    // Weekly groceries: £42–£80, alternating Tesco / Sainsbury's
    for (let w = 1; w <= 25; w++) {
      const d = today.subtract(w, 'week');
      const amount = -(4200 + Math.floor(rand() * 3800));
      const p = w % 2 === 0 ? tesco : sainsburys;
      await addTx({
        account: current, date: d, amountMinor: amount, payeeId: p,
        payeeName: w % 2 === 0 ? 'Tesco' : "Sainsbury's", categoryId: groceriesCat,
        notes: 'Weekly shop',
      });
    }
    // Subscriptions
    for (const d of monthlyDates(3)) {
      await addTx({ account: current, date: d, amountMinor: -1099, payeeId: netflix, payeeName: 'Netflix', categoryId: streamingCat });
    }
    for (const d of monthlyDates(7)) {
      await addTx({ account: current, date: d, amountMinor: -1199, payeeId: spotify, payeeName: 'Spotify', categoryId: streamingCat });
    }
    for (const d of monthlyDates(15)) {
      await addTx({ account: current, date: d, amountMinor: -2500, payeeId: vodafone, payeeName: 'Vodafone', categoryId: mobileCat, notes: 'Phone bill' });
    }
    // Transport: weekly TfL top-ups + monthly fuel
    for (let w = 1; w <= 25; w++) {
      const d = today.subtract(w, 'week').subtract(2, 'day');
      await addTx({
        account: current, date: d, amountMinor: -(280 + Math.floor(rand() * 520)),
        payeeId: tfl, payeeName: 'TfL', categoryId: publicTransportCat,
      });
    }
    for (const d of monthlyDates(12)) {
      await addTx({
        account: current, date: d, amountMinor: -(5500 + Math.floor(rand() * 1500)),
        payeeId: shell, payeeName: 'Shell', categoryId: fuelCat, notes: 'Petrol',
      });
    }
    // Dining out + coffee (roughly weekly)
    for (let w = 1; w <= 25; w++) {
      if (rand() < 0.6) {
        const d = today.subtract(w, 'week').subtract(4, 'day');
        await addTx({
          account: current, date: d, amountMinor: -(1200 + Math.floor(rand() * 3600)),
          payeeId: w % 2 === 0 ? pizzaExpress : pret,
          payeeName: w % 2 === 0 ? 'Pizza Express' : 'Pret A Manger',
          categoryId: restaurantsCat,
        });
      }
      if (rand() < 0.7) {
        const d = today.subtract(w, 'week').subtract(1, 'day');
        await addTx({
          account: current, date: d, amountMinor: -(320 + Math.floor(rand() * 180)),
          payeeId: caffeNero, payeeName: 'Caffe Nero', categoryId: coffeeCat,
        });
      }
    }
    // A couple of cash transactions
    await addTx({
      account: cash, date: today.subtract(20, 'day'), amountMinor: -1250,
      payeeId: marketStall, payeeName: 'Borough Market', categoryId: groceriesCat,
      notes: 'Fruit and veg stall',
    });
    await addTx({
      account: cash, date: today.subtract(6, 'day'), amountMinor: -450,
      payeeId: caffeNero, payeeName: 'Caffe Nero', categoryId: coffeeCat,
    });
    // SPLIT: one Amazon order across two categories (sums exactly, SPEC §6)
    // -£86.48 = -£50.00 Household + -£36.48 Electronics
    await addTx({
      account: current, date: today.subtract(12, 'day'), amountMinor: -8648,
      payeeId: amazon, payeeName: 'Amazon', categoryId: null,
      notes: 'Kitchen scales and headphones',
      splits: [
        { categoryId: householdCat, amountMinor: -5000 },
        { categoryId: electronicsCat, amountMinor: -3648 },
      ],
    });
    // REFUND: positive amount in an EXPENSE category (D14)
    await addTx({
      account: current, date: today.subtract(8, 'day'), amountMinor: 2500,
      payeeId: amazon, payeeName: 'Amazon', categoryId: clothingCat,
      notes: 'Refund — returned jacket',
    });
    // PENDING recent transaction (counts in balances, D15)
    await addTx({
      account: current, date: today.subtract(1, 'day'), amountMinor: -1250,
      payeeId: pret, payeeName: 'Pret A Manger', categoryId: coffeeCat,
      status: 'pending', notes: 'Lunch',
    });
    // EUR transactions on the EUR account (converted only at display time)
    await addTx({
      account: euro, date: today.subtract(80, 'day'), amountMinor: -12000,
      payeeId: hotelLisboa, payeeName: 'Hotel Lisboa', categoryId: accommodationCat,
      tagIds: [holidayTag.id], notes: '2 nights in Lisbon',
    });
    await addTx({
      account: euro, date: today.subtract(79, 'day'), amountMinor: -4550,
      payeeId: taberna, payeeName: 'Taberna Real', categoryId: restaurantsCat,
      tagIds: [holidayTag.id], notes: 'Dinner',
    });
    await addTx({
      account: euro, date: today.subtract(78, 'day'), amountMinor: -350,
      payeeId: caffeNero, payeeName: 'Caffe Nero', categoryId: coffeeCat,
      tagIds: [holidayTag.id],
    });

    // ---- budgets (amounts in base currency GBP, D22) ----------------------
    const budgets: Budget[] = [
      {
        id: uid(), name: `${SAMPLE_PREFIX}Groceries`, categoryIds: [groceriesCat], amountMinor: 40000,
        period: 'monthly', startDate: today.startOf('month').format(D),
        rollover: false, archived: false,
      },
      {
        id: uid(), name: `${SAMPLE_PREFIX}Eating out`, categoryIds: [restaurantsCat, coffeeCat],
        amountMinor: 20000, period: 'monthly', startDate: today.startOf('month').format(D),
        rollover: false, archived: false,
      },
    ];
    await db.budgets.bulkAdd(budgets);
    batch.createdBudgetIds!.push(...budgets.map((b) => b.id));

    // ---- record every created id on the batch (D18/D19) -------------------
    batch.rowCount = written;
    batch.createdCategoryIds = (await db.categories.toCollection().primaryKeys()).filter(
      (id) => !categoryIdsBefore.has(id),
    );
    batch.createdPayeeIds = (await db.payees.toCollection().primaryKeys()).filter(
      (id) => !payeeIdsBefore.has(id),
    );
    batch.createdTagIds = (await db.tags.toCollection().primaryKeys()).filter(
      (id) => !tagIdsBefore.has(id),
    );
    await db.importBatches.put(batch);
  });

  // Learn payee → category defaults from the sample history (D17).
  for (const id of payeesTouched) await learnPayeeCategory(id);
}

export async function removeSampleData(): Promise<void> {
  const batchId = await sampleDataBatchId();
  if (batchId) await undoImport(batchId); // one-tap removal IS undo (D19)
}

/** The sample batch id when sample data is currently loaded, else null. */
export async function sampleDataBatchId(): Promise<string | null> {
  const batch = await db.importBatches.filter((b) => b.source === 'sample').first();
  return batch?.id ?? null;
}
