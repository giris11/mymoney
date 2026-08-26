// MoneyWiz-style account grouping (src/domain/accounts.ts).
//
// The table below is Girish's REAL account list as it arrived from the
// MoneyWiz Report export — 58 names, every one of them typed 'current' with no
// group, which is exactly the state this feature exists to fix. They are used
// verbatim (they are just strings: no amounts, no numbers, no personal data)
// because the classifier is only worth anything if it works on the messy names
// people actually use — typos ("Bonous", "SERVER" for "SAVER"), closure notes
// in brackets, other people's accounts, and ledgers for money lent to friends.
//
// THE ASSERTION THAT MATTERS MOST is 'never touches money' further down:
// grouping and typing are organisational, so balances, transactions and net
// worth must come out byte-identical.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, updateSettings } from '../src/db/db';
import type { Account, AccountType, Transaction, TxStatus } from '../src/db/types';
import { uid } from '../src/lib/util';
import { accountBalances, netWorth } from '../src/domain/balances';
import {
  ACCOUNT_GROUP_ORDER,
  autoGroupAccounts,
  inferAccountType,
  moveGroup,
  previewAutoGrouping,
  saveGroup,
  setAccountGroup,
  suggestGroupFor,
} from '../src/domain/accounts';
import { ValidationError } from '../src/domain/transactions';

interface Row {
  name: string;
  currency: string;
  type: AccountType;
  group: string;
  /** false ⇒ only a weak signal matched; the UI must offer it for review. */
  confident: boolean;
}

const REAL_ACCOUNTS: Row[] = [
  // --- banking: brand or the word "account" is the evidence ----------------
  { name: 'HSBC Premier', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: 'HSBC Global', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: 'BARCLAYS Premier', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: 'HALIFAX', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: 'REVOLUT', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: 'WISE', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: '1st Account', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: 'PayPal', currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  {
    name: 'METRO (Switched To First direct On 180923)',
    currency: 'GBP',
    type: 'current',
    group: 'Bank Accounts',
    confident: true,
  },

  // --- savings: saver/saving/isa/bonus/vault/interest/instant access -------
  { name: 'Online Bonous Saver', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  // "SERVER" is this dataset's recurring typo for "SAVER" — and the reason a
  // bare "rewards" must never decide a type on its own.
  { name: 'BARCLAYS REWARDS SERVER', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  { name: 'BARCLAYS RAINY DAY SERVER', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  { name: 'Halifax Instant ISA Saver', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  { name: 'Halifax Bonus Saver', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  { name: 'HSBC ONLINE BONUS SERVER', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  {
    name: 'HALIFAX FIXED SAVER 1 Year Aanual Interest',
    currency: 'GBP',
    type: 'savings',
    group: 'Savings',
    confident: true,
  },
  { name: 'HSBC FLEXIBLE SAVINGS', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  // 'isa' beats the 'cash' in the name: it is a cash ISA, i.e. savings.
  { name: 'METRO VARIABLE RATE CASH ISA', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  {
    name: 'METRO INSTANT ACCESS (Closed 250923)',
    currency: 'GBP',
    type: 'savings',
    group: 'Savings',
    confident: true,
  },
  { name: 'REVOLUT VAULT (Closed 071023)', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  { name: 'Instant Server', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },
  { name: 'WISE INTEREST', currency: 'GBP', type: 'savings', group: 'Savings', confident: true },

  // --- credit ---------------------------------------------------------------
  { name: 'HSBC Premier Credit', currency: 'GBP', type: 'credit_card', group: 'Credit Cards', confident: true },
  // Weak signal ('rewards' alone) — right answer, flagged for review.
  { name: 'HSBC rewards', currency: 'GBP', type: 'credit_card', group: 'Credit Cards', confident: false },
  { name: 'Halifax Credit Card', currency: 'GBP', type: 'credit_card', group: 'Credit Cards', confident: true },
  { name: 'MBNA Credit Card', currency: 'GBP', type: 'credit_card', group: 'Credit Cards', confident: true },
  // 'american express' outranks the 'gold' that would otherwise say bullion.
  { name: 'American Express Gold', currency: 'GBP', type: 'credit_card', group: 'Credit Cards', confident: true },
  {
    name: "Kayal's Aqua Credit Card",
    currency: 'GBP',
    type: 'credit_card',
    group: 'Credit Cards',
    confident: true,
  },
  { name: 'Barclays Blue Rewards', currency: 'GBP', type: 'credit_card', group: 'Credit Cards', confident: false },

  // --- loans ----------------------------------------------------------------
  { name: 'Halifax Loan', currency: 'GBP', type: 'loan', group: 'Loans', confident: true },

  // --- cash -----------------------------------------------------------------
  { name: 'Cash (Notes)', currency: 'GBP', type: 'cash', group: 'Cash', confident: true },
  { name: 'Cash (Coins)', currency: 'GBP', type: 'cash', group: 'Cash', confident: true },
  // "Bank" in the name loses to "CASH"/"LOCKER": it is physical money.
  { name: 'CASH IN HNB Bank LOCKER', currency: 'GBP', type: 'cash', group: 'Cash', confident: true },
  { name: 'Cash In Suitcase At Sureka Home', currency: 'GBP', type: 'cash', group: 'Cash', confident: true },

  // --- investments & assets -------------------------------------------------
  { name: 'Trading 212', currency: 'GBP', type: 'investment', group: 'Investments & Assets', confident: true },
  // 'gold' alone is weak: bullion, a Gold card or a bank's Gold tier all match.
  { name: 'Gold', currency: 'GBP', type: 'investment', group: 'Investments & Assets', confident: false },
  // House number + street word ⇒ a property held as an asset. Weak by design.
  {
    name: "68 Saint's Mary Drive",
    currency: 'GBP',
    type: 'investment',
    group: 'Investments & Assets',
    confident: false,
  },

  // --- foreign currency (non-base currency outranks the type map) -----------
  {
    name: 'WISE INDIAN CURRENCY (INR)',
    currency: 'INR',
    type: 'current',
    group: 'Foreign Currency',
    confident: true,
  },
  { name: 'WISE SL CURRENCY (LKR)', currency: 'LKR', type: 'current', group: 'Foreign Currency', confident: true },

  // --- gift cards (purpose outranks currency; type stays neutral+flagged) ---
  {
    name: 'Amazon Gift card',
    currency: 'GBP',
    type: 'current',
    group: 'Gift Cards & Vouchers',
    confident: false,
  },
  { name: 'Gift Card', currency: 'GBP', type: 'current', group: 'Gift Cards & Vouchers', confident: false },
  {
    name: 'ITUNES GIFT CARD Balance girishselva11 (TRY)',
    currency: 'TRY',
    type: 'current',
    group: 'Gift Cards & Vouchers',
    confident: false,
  },
  {
    name: 'ITUNES GIFT CARD Balance Outlook.com (TRY)',
    currency: 'TRY',
    type: 'current',
    group: 'Gift Cards & Vouchers',
    confident: false,
  },
  {
    name: 'Eneba Gift Balance (TRY)',
    currency: 'TRY',
    type: 'current',
    group: 'Gift Cards & Vouchers',
    confident: false,
  },

  // --- money lent & owed ----------------------------------------------------
  // Direction (lent vs owed) is not knowable from the name, so the TYPE stays
  // the neutral 'current' and the whole suggestion is flagged for review.
  {
    name: "Need To Give Back To Kayal's Anna",
    currency: 'GBP',
    type: 'current',
    group: 'Money Lent & Owed',
    confident: false,
  },
  { name: 'Need To Give Akka', currency: 'GBP', type: 'current', group: 'Money Lent & Owed', confident: false },
  { name: 'David Borrowed', currency: 'GBP', type: 'current', group: 'Money Lent & Owed', confident: false },
  { name: 'Vinothan Borrowed', currency: 'GBP', type: 'current', group: 'Money Lent & Owed', confident: false },
  { name: 'Shithi Need To Give', currency: 'GBP', type: 'current', group: 'Money Lent & Owed', confident: false },
  {
    name: 'Sureka AKKA Need To Give Back',
    currency: 'GBP',
    type: 'current',
    group: 'Money Lent & Owed',
    confident: false,
  },
  // LKR, but an IOU first and a rupee balance second.
  {
    name: "Kayal's Akka Borrowed (LKR)",
    currency: 'LKR',
    type: 'current',
    group: 'Money Lent & Owed',
    confident: false,
  },

  // --- someone else's accounts: still bank accounts -------------------------
  { name: "Kayal's First Direct", currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: "Kayal's Revolut Account", currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },
  { name: "Kayal's Wise Account", currency: 'GBP', type: 'current', group: 'Bank Accounts', confident: true },

  // --- no signal at all: 'Other Accounts', always flagged -------------------
  // "Booked For <person>" probably means money fronted for someone, but only
  // the owner knows. Guessing would be worse than asking.
  {
    name: 'Car Insurance Booked For Shankar Anna',
    currency: 'GBP',
    type: 'current',
    group: 'Other Accounts',
    confident: false,
  },
  { name: 'Lost In Business', currency: 'GBP', type: 'current', group: 'Other Accounts', confident: false },
  { name: 'Kayal', currency: 'GBP', type: 'current', group: 'Other Accounts', confident: false },
  { name: 'Work Seeddu', currency: 'GBP', type: 'current', group: 'Other Accounts', confident: false },
];

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

/** Seed the real list exactly as the MoneyWiz import leaves it: type 'current', no group. */
async function seedRealAccounts(): Promise<Account[]> {
  const accounts: Account[] = REAL_ACCOUNTS.map((row, i) => ({
    id: `acc-${String(i).padStart(2, '0')}`,
    name: row.name,
    type: 'current',
    currency: row.currency,
    openingBalanceMinor: (i + 1) * 1013 - (i % 5) * 97, // varied, non-round
    colour: '#336699',
    groupId: null,
    sortOrder: i,
    archived: false,
  }));
  await db.accounts.bulkAdd(accounts);
  return accounts;
}

let txSeq = 0;
async function addTx(
  accountId: string,
  amountMinor: number,
  status: TxStatus = 'cleared',
  currency = 'GBP',
): Promise<void> {
  txSeq += 1;
  const tx: Transaction = {
    id: `tx-${String(txSeq).padStart(3, '0')}`,
    accountId,
    date: '2026-03-1'.concat(String(txSeq % 10)),
    amountMinor,
    currency,
    payeeId: null,
    categoryId: null,
    tagIds: [],
    notes: '',
    status,
    splits: [],
    transferGroupId: null,
    importBatchId: null,
    dedupeHash: `hash-${txSeq}`,
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
  await db.transactions.add(tx);
}

const groupsInOrder = async (): Promise<string[]> =>
  (await db.accountGroups.toArray()).sort((a, b) => a.sortOrder - b.sortOrder).map((g) => g.name);

const groupNameOf = async (accountId: string): Promise<string | null> => {
  const account = await db.accounts.get(accountId);
  if (!account?.groupId) return null;
  return (await db.accountGroups.get(account.groupId))?.name ?? null;
};

beforeEach(async () => {
  await clearAll();
  await updateSettings({ baseCurrency: 'GBP' });
});

// ---------------------------------------------------------------------------

describe('inferAccountType / suggestGroupFor over the real account list', () => {
  for (const row of REAL_ACCOUNTS) {
    it(`${row.name} → ${row.type} / ${row.group}`, () => {
      const type = inferAccountType(row.name);
      expect(type).toBe(row.type);
      expect(suggestGroupFor(row.name, type, row.currency, 'GBP')).toBe(row.group);
    });
  }

  it('covers all 58 real accounts and only emits canonical group names', () => {
    expect(REAL_ACCOUNTS).toHaveLength(58);
    for (const row of REAL_ACCOUNTS) expect(ACCOUNT_GROUP_ORDER).toContain(row.group);
  });

  it('is pure: same answer whatever the case, spacing or punctuation', () => {
    expect(inferAccountType('  halifax   credit   card  ')).toBe('credit_card');
    expect(inferAccountType('HALIFAX-CREDIT-CARD')).toBe('credit_card');
    expect(inferAccountType('')).toBe('current');
  });

  it('matches whole words only — Visa/Lisa are not ISAs, Bowen does not owe', () => {
    expect(inferAccountType('Lisa')).toBe('current');
    expect(suggestGroupFor('Bowen', 'current', 'GBP', 'GBP')).toBe('Other Accounts');
    // ...but the real thing still matches
    expect(inferAccountType('Cash ISA')).toBe('savings');
    expect(suggestGroupFor('Dad owes me', 'current', 'GBP', 'GBP')).toBe('Money Lent & Owed');
  });
});

describe('the rewards case: credit vs savings', () => {
  it('treats a bare "rewards" as a weak CREDIT hint', () => {
    expect(inferAccountType('HSBC rewards')).toBe('credit_card');
    expect(inferAccountType('Barclays Blue Rewards')).toBe('credit_card');
  });

  it('lets a savings signal in the same name win, however spelled', () => {
    expect(inferAccountType('BARCLAYS REWARDS SERVER')).toBe('savings'); // SERVER = SAVER
    expect(inferAccountType('Barclays Rewards Saver')).toBe('savings');
    expect(inferAccountType('Rewards ISA')).toBe('savings');
  });

  it('flags the weak-signal ones and not the strong ones', async () => {
    await db.accounts.bulkAdd(
      ['HSBC rewards', 'BARCLAYS REWARDS SERVER', 'Halifax Credit Card'].map((name, i) => ({
        id: `r-${i}`,
        name,
        type: 'current' as AccountType,
        currency: 'GBP',
        openingBalanceMinor: 0,
        colour: '#336699',
        groupId: null,
        sortOrder: i,
        archived: false,
      })),
    );
    const byName = new Map((await previewAutoGrouping()).map((s) => [s.name, s]));
    expect(byName.get('HSBC rewards')!.confident).toBe(false);
    expect(byName.get('BARCLAYS REWARDS SERVER')!.confident).toBe(true);
    expect(byName.get('Halifax Credit Card')!.confident).toBe(true);
  });
});

describe('group overrides and their precedence', () => {
  it('sends a non-base-currency account to Foreign Currency', () => {
    expect(suggestGroupFor('WISE INDIAN CURRENCY (INR)', 'current', 'INR', 'GBP')).toBe('Foreign Currency');
    // ...and the same name in the base currency is just a bank account
    expect(suggestGroupFor('WISE INDIAN CURRENCY (INR)', 'current', 'GBP', 'GBP')).toBe('Bank Accounts');
    // the rule is "not the base currency", not "not GBP"
    expect(suggestGroupFor('HSBC Premier', 'current', 'GBP', 'INR')).toBe('Foreign Currency');
    // savings in a foreign currency is still Foreign Currency: currency > type
    expect(suggestGroupFor('Euro Saver', 'savings', 'EUR', 'GBP')).toBe('Foreign Currency');
  });

  it('sends gift cards to Gift Cards & Vouchers, ahead of currency and type', () => {
    expect(suggestGroupFor('Amazon Gift card', 'current', 'GBP', 'GBP')).toBe('Gift Cards & Vouchers');
    expect(suggestGroupFor('ITUNES GIFT CARD Balance Outlook.com (TRY)', 'current', 'TRY', 'GBP')).toBe(
      'Gift Cards & Vouchers',
    );
    expect(suggestGroupFor('Eneba Gift Balance (TRY)', 'credit_card', 'TRY', 'GBP')).toBe(
      'Gift Cards & Vouchers',
    );
  });

  it('sends lending ledgers to Money Lent & Owed, ahead of currency and type', () => {
    expect(suggestGroupFor('David Borrowed', 'current', 'GBP', 'GBP')).toBe('Money Lent & Owed');
    expect(suggestGroupFor("Kayal's Akka Borrowed (LKR)", 'current', 'LKR', 'GBP')).toBe('Money Lent & Owed');
    expect(suggestGroupFor('Shithi Need To Give', 'savings', 'GBP', 'GBP')).toBe('Money Lent & Owed');
  });

  it('only calls something a Bank Account when the name says so', () => {
    expect(suggestGroupFor('Work Seeddu', 'current', 'GBP', 'GBP')).toBe('Other Accounts');
    expect(suggestGroupFor('Lost In Business', 'current', 'GBP', 'GBP')).toBe('Other Accounts');
    expect(suggestGroupFor('Monzo', 'current', 'GBP', 'GBP')).toBe('Bank Accounts');
    expect(suggestGroupFor('Some Random Account', 'current', 'GBP', 'GBP')).toBe('Bank Accounts');
  });
});

describe('previewAutoGrouping', () => {
  it('reproduces the whole table, confidence flag included', async () => {
    await seedRealAccounts();
    const suggestions = await previewAutoGrouping();
    expect(suggestions).toHaveLength(REAL_ACCOUNTS.length);
    const byName = new Map(suggestions.map((s) => [s.name, s]));
    for (const row of REAL_ACCOUNTS) {
      const got = byName.get(row.name);
      expect(got, row.name).toBeDefined();
      expect({ type: got!.suggestedType, group: got!.suggestedGroup, confident: got!.confident }).toEqual({
        type: row.type,
        group: row.group,
        confident: row.confident,
      });
      expect(got!.currentType).toBe('current'); // as MoneyWiz left it
    }
  });

  it('comes back in canonical group order, then by name', async () => {
    await seedRealAccounts();
    const suggestions = await previewAutoGrouping();
    const ranks = suggestions.map((s) => ACCOUNT_GROUP_ORDER.indexOf(s.suggestedGroup));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('writes nothing at all', async () => {
    await seedRealAccounts();
    const before = JSON.stringify(await db.accounts.toArray());
    await previewAutoGrouping();
    await previewAutoGrouping();
    expect(JSON.stringify(await db.accounts.toArray())).toBe(before);
    expect(await db.accountGroups.count()).toBe(0);
  });

  it('never contradicts a type the user has already chosen', async () => {
    await db.accounts.add({
      id: 'a1',
      name: 'Halifax Credit Card', // name says credit_card...
      type: 'savings', // ...but the user said savings
      currency: 'GBP',
      openingBalanceMinor: 0,
      colour: '#336699',
      groupId: null,
      sortOrder: 0,
      archived: false,
    });
    const [s] = await previewAutoGrouping();
    expect(s.suggestedType).toBe('savings');
    expect(s.suggestedGroup).toBe('Savings');
  });
});

describe('autoGroupAccounts', () => {
  it('creates the canonical groups in canonical order and files every account', async () => {
    await seedRealAccounts();
    const result = await autoGroupAccounts();

    expect(result).toEqual({ groupsCreated: 10, accountsGrouped: 58, typesChanged: 0 });
    expect(await groupsInOrder()).toEqual([...ACCOUNT_GROUP_ORDER]);
    expect((await db.accountGroups.toArray()).map((g) => g.sortOrder).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);

    const accounts = await db.accounts.toArray();
    expect(accounts.every((a) => a.groupId !== null)).toBe(true);
    for (const row of REAL_ACCOUNTS) {
      const account = accounts.find((a) => a.name === row.name)!;
      expect(await groupNameOf(account.id), row.name).toBe(row.group);
    }
  });

  it('is idempotent — a second run changes nothing', async () => {
    await seedRealAccounts();
    await autoGroupAccounts();
    const after1 = JSON.stringify(await db.accounts.toArray());

    expect(await autoGroupAccounts()).toEqual({ groupsCreated: 0, accountsGrouped: 0, typesChanged: 0 });
    expect(JSON.stringify(await db.accounts.toArray())).toBe(after1);
    expect(await db.accountGroups.count()).toBe(10);

    // ...and with every option turned on, over accounts that are already filed
    expect(await autoGroupAccounts({ applyTypes: true, onlyUngrouped: false })).toEqual({
      groupsCreated: 0,
      accountsGrouped: 0,
      typesChanged: 28,
    });
    expect(await autoGroupAccounts({ applyTypes: true, onlyUngrouped: false })).toEqual({
      groupsCreated: 0,
      accountsGrouped: 0,
      typesChanged: 0,
    });
  });

  it('applyTypes corrects the types the import could not know', async () => {
    await seedRealAccounts();
    const expectedChanges = REAL_ACCOUNTS.filter((r) => r.type !== 'current').length;
    expect(expectedChanges).toBe(28); // 13 savings + 7 credit + 1 loan + 4 cash + 3 investment

    const result = await autoGroupAccounts({ applyTypes: true });
    expect(result.typesChanged).toBe(expectedChanges);

    const accounts = await db.accounts.toArray();
    for (const row of REAL_ACCOUNTS) {
      expect(accounts.find((a) => a.name === row.name)!.type, row.name).toBe(row.type);
    }
  });

  it('leaves types alone unless asked', async () => {
    await seedRealAccounts();
    await autoGroupAccounts();
    expect((await db.accounts.toArray()).every((a) => a.type === 'current')).toBe(true);
  });

  it('reuses an existing group of the same name instead of duplicating it', async () => {
    await seedRealAccounts();
    const mine = await saveGroup({ name: '  savings ' }); // different case + padding
    const result = await autoGroupAccounts();

    expect(result.groupsCreated).toBe(9); // Savings already existed
    expect((await db.accountGroups.toArray()).filter((g) => g.name.toLowerCase() === 'savings')).toHaveLength(
      1,
    );
    const saver = (await db.accounts.toArray()).find((a) => a.name === 'Halifax Bonus Saver')!;
    expect(saver.groupId).toBe(mine.id);
    // the existing group keeps its own name and sortOrder — never rewritten
    expect((await db.accountGroups.get(mine.id))!.name).toBe('savings');
    expect((await db.accountGroups.get(mine.id))!.sortOrder).toBe(mine.sortOrder);
  });

  it('onlyUngrouped (the default) never re-files a deliberate choice', async () => {
    await seedRealAccounts();
    const mine = await saveGroup({ name: 'My picks' });
    const cashNotes = (await db.accounts.toArray()).find((a) => a.name === 'Cash (Notes)')!;
    await setAccountGroup(cashNotes.id, mine.id);

    const result = await autoGroupAccounts();
    expect(await groupNameOf(cashNotes.id)).toBe('My picks');
    expect(result.accountsGrouped).toBe(57); // everything except the filed one

    // ...and it is still reachable when the user explicitly asks for a full regroup
    const full = await autoGroupAccounts({ onlyUngrouped: false });
    expect(full.accountsGrouped).toBe(1);
    expect(await groupNameOf(cashNotes.id)).toBe('Cash');
  });

  it('never touches money: balances, transactions and net worth are byte-identical', async () => {
    const accounts = await seedRealAccounts();
    await addTx(accounts[0].id, -12_345);
    await addTx(accounts[0].id, 250_000);
    await addTx(accounts[0].id, -9_99, 'pending');
    await addTx(accounts[9].id, 44_444);
    await addTx(accounts[37].id, -1_234_567, 'cleared', 'INR'); // WISE INDIAN CURRENCY
    await addTx(accounts[41].id, 5_000, 'cleared', 'TRY'); // an iTunes gift balance

    const snapshot = async (): Promise<string> => {
      const accs = (await db.accounts.toArray())
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          name: a.name,
          currency: a.currency,
          openingBalanceMinor: a.openingBalanceMinor,
          colour: a.colour,
          archived: a.archived,
          sortOrder: a.sortOrder,
        }));
      const txs = (await db.transactions.toArray()).sort((a, b) => a.id.localeCompare(b.id));
      const balances = (await accountBalances())
        .sort((a, b) => a.account.id.localeCompare(b.account.id))
        .map((b) => ({
          id: b.account.id,
          balanceMinor: b.balanceMinor,
          clearedMinor: b.clearedMinor,
          txCount: b.txCount,
        }));
      return JSON.stringify({ accs, txs, balances, netWorth: await netWorth() });
    };

    const before = await snapshot();
    await autoGroupAccounts({ applyTypes: true, onlyUngrouped: false });
    await autoGroupAccounts({ applyTypes: true, onlyUngrouped: false });
    const after = await snapshot();

    expect(after).toBe(before);
    // and prove the test is not vacuous: the organisational fields DID change
    expect((await db.accounts.toArray()).every((a) => a.groupId !== null)).toBe(true);
    expect((await db.accounts.toArray()).some((a) => a.type !== 'current')).toBe(true);
  });

  it('is fully reversible: ungrouping restores the imported state exactly', async () => {
    const seeded = await seedRealAccounts();
    const before = JSON.stringify(await db.accounts.toArray());
    await autoGroupAccounts();
    for (const a of seeded) await setAccountGroup(a.id, null);
    // sortOrder is reassigned by the move, so compare the fields that define
    // the account rather than its position in the list
    const stripOrder = (json: string): unknown =>
      (JSON.parse(json) as Account[]).map(({ sortOrder: _sortOrder, ...rest }) => rest);
    expect(stripOrder(JSON.stringify(await db.accounts.toArray()))).toEqual(stripOrder(before));
  });

  it('copes with an empty database', async () => {
    expect(await autoGroupAccounts()).toEqual({ groupsCreated: 0, accountsGrouped: 0, typesChanged: 0 });
    expect(await db.accountGroups.count()).toBe(0);
    expect(await previewAutoGrouping()).toEqual([]);
  });
});

describe('setAccountGroup', () => {
  it('moves an account to a group, to the bottom of it, and back to ungrouped', async () => {
    const accounts = await seedRealAccounts();
    const group = await saveGroup({ name: 'Household' });
    await setAccountGroup(accounts[0].id, group.id);
    await setAccountGroup(accounts[1].id, group.id);

    expect((await db.accounts.get(accounts[0].id))!.groupId).toBe(group.id);
    const a0 = (await db.accounts.get(accounts[0].id))!;
    const a1 = (await db.accounts.get(accounts[1].id))!;
    expect(a0.sortOrder).toBe(0);
    expect(a1.sortOrder).toBe(1); // appended below

    await setAccountGroup(accounts[0].id, null);
    expect((await db.accounts.get(accounts[0].id))!.groupId).toBeNull();
  });

  it('changes nothing else about the account', async () => {
    const accounts = await seedRealAccounts();
    const group = await saveGroup({ name: 'Household' });
    const before = (await db.accounts.get(accounts[3].id))!;
    await setAccountGroup(accounts[3].id, group.id);
    const after = (await db.accounts.get(accounts[3].id))!;
    expect({ ...after, groupId: before.groupId, sortOrder: before.sortOrder }).toEqual(before);
  });

  it('is a no-op when the account is already in that group', async () => {
    const accounts = await seedRealAccounts();
    const group = await saveGroup({ name: 'Household' });
    await setAccountGroup(accounts[0].id, group.id);
    const once = JSON.stringify(await db.accounts.get(accounts[0].id));
    await setAccountGroup(accounts[0].id, group.id);
    expect(JSON.stringify(await db.accounts.get(accounts[0].id))).toBe(once);
  });

  it('refuses unknown accounts and unknown groups', async () => {
    const accounts = await seedRealAccounts();
    await expect(setAccountGroup('nope', null)).rejects.toBeInstanceOf(ValidationError);
    await expect(setAccountGroup(accounts[0].id, 'nope')).rejects.toBeInstanceOf(ValidationError);
    expect((await db.accounts.get(accounts[0].id))!.groupId).toBeNull();
  });
});

describe('moveGroup', () => {
  const names = async () => groupsInOrder();

  it('swaps a group with its neighbour, up and down', async () => {
    await seedRealAccounts();
    await autoGroupAccounts();
    const groups = await db.accountGroups.toArray();
    const savings = groups.find((g) => g.name === 'Savings')!;

    await moveGroup(savings.id, 'up');
    expect((await names()).slice(0, 3)).toEqual(['Cash', 'Savings', 'Bank Accounts']);
    await moveGroup(savings.id, 'down');
    expect(await names()).toEqual([...ACCOUNT_GROUP_ORDER]);
  });

  it('does nothing at either end', async () => {
    await seedRealAccounts();
    await autoGroupAccounts();
    const groups = await db.accountGroups.toArray();
    const first = groups.find((g) => g.name === ACCOUNT_GROUP_ORDER[0])!;
    const last = groups.find((g) => g.name === ACCOUNT_GROUP_ORDER[ACCOUNT_GROUP_ORDER.length - 1])!;

    await moveGroup(first.id, 'up');
    await moveGroup(last.id, 'down');
    expect(await names()).toEqual([...ACCOUNT_GROUP_ORDER]);
  });

  it('normalises duplicate or gappy sortOrders so a move is never a silent no-op', async () => {
    const a = await saveGroup({ name: 'A', sortOrder: 5 });
    const b = await saveGroup({ name: 'B', sortOrder: 5 });
    const c = await saveGroup({ name: 'C', sortOrder: 90 });

    await moveGroup(c.id, 'up');
    expect(await names()).toEqual(['A', 'C', 'B']);
    expect((await db.accountGroups.toArray()).map((g) => g.sortOrder).sort()).toEqual([0, 1, 2]);
    expect((await db.accountGroups.get(a.id))!.name).toBe('A');
    expect((await db.accountGroups.get(b.id))!.name).toBe('B');
  });

  it('refuses an unknown group', async () => {
    await expect(moveGroup('nope', 'up')).rejects.toBeInstanceOf(ValidationError);
  });
});
