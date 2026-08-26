// MoneyWiz *Report* layout tests (SPEC §7.1, §10).
//
// The fixture (tests/fixtures/moneywiz-report.csv) is entirely INVENTED data
// that mirrors only the STRUCTURE of a real report export: a `sep=,` hint
// line, a quoted header row, then account groups — an ACCOUNT HEADER row
// ("Name" filled, "Account" holding the CURRENCY) followed by that account's
// TRANSACTION rows ("Name" empty, "Account" holding the account NAME).
//
// Hand-counts for the fixture (27 data rows: 9 account headers, 18 transactions):
//
//  Everyday Current      GBP  balance  1,350.75  Σ  1,250.75  ⇒ opening    100.00
//  Rainy Day Savings     GBP  balance  5,000.00  Σ  1,000.00  ⇒ opening  4,000.00
//  Platinum Credit Card  GBP  balance   -742.19  Σ    -42.19  ⇒ opening   -700.00
//  Startup Float         GBP  balance    100.00  Σ  1,475.00  ⇒ opening -1,375.00
//  Travel Wallet         TRY  balance 12,345.67  Σ    765.44  ⇒ opening 11,580.23
//  Overseas Savings      LKR  balance 250,000.00 Σ 50,000.00  ⇒ opening 200,000.00
//  Broken Ledger         GBP  balance    500.00  one unreadable amount ⇒ null
//  Dormant Pot           GBP  balance     42.00  no transactions        ⇒ 42.00
//  Faded Diary           GBP  balance     80.00  one impossible date    ⇒ null
//  (plus one transaction row for "Ghost Account", which no header row declares)
//
// The fixture's running "Balance" column is deliberately inconsistent with
// those openings — the real export's is too, among same-date rows — so any
// test that passes by reading it would be reading the wrong column.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db/db';
import { seedCategoriesIfEmpty } from '../src/db/seed';
import type { Account } from '../src/db/types';
import { accountBalances } from '../src/domain/balances';
import { uid } from '../src/lib/util';
import { parseCsv } from '../src/import/generic';
import { isMoneyWizCsv, parseMoneyWizCsv } from '../src/import/moneywiz';
import {
  isMoneyWizReportCsv,
  parseMoneyWizReportCsv,
  reportPlanOptions,
  type ReportAccount,
} from '../src/import/moneywizReport';
import { buildImportPlan, commitImport } from '../src/import/importer';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const REPORT_HEADERS = [
  'Name', 'Current balance', 'Account', 'Transfers', 'Description', 'Payee',
  'Category', 'Date', 'Memo', 'Amount', 'Currency', 'Cheque N°', 'Tags', 'Balance',
];

const text = fixture('moneywiz-report.csv');
const result = parseMoneyWizReportCsv(text);
const account = (name: string): ReportAccount =>
  result.accounts.find((a) => a.name === name)!;
const rowsOf = (name: string) => result.rows.filter((r) => r.accountName === name);
const warningsOf = (warnings: string[], needle: string): string | undefined =>
  warnings.find((w) => w.includes(needle));
const warning = (needle: string): string | undefined => warningsOf(result.warnings, needle);

const clearAll = async (): Promise<void> => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

const addAccount = async (
  name: string,
  currency = 'GBP',
  openingBalanceMinor = 0,
): Promise<Account> => {
  const acc: Account = {
    id: uid(), name, type: 'current', currency, openingBalanceMinor,
    colour: '#123456', groupId: null, sortOrder: 0, archived: false,
  };
  await db.accounts.add(acc);
  return acc;
};

const planOpts = {
  source: 'moneywiz' as const,
  fileName: 'moneywiz-report.csv',
  defaultCurrency: 'GBP',
};

const planForReport = () =>
  buildImportPlan(result.rows, { ...planOpts, ...reportPlanOptions(result.accounts) });

// --------------------------------------------------------------- detection
describe('isMoneyWizReportCsv', () => {
  it('accepts the report header set (case-insensitive)', () => {
    expect(isMoneyWizReportCsv(REPORT_HEADERS)).toBe(true);
    expect(isMoneyWizReportCsv(REPORT_HEADERS.map((h) => h.toUpperCase()))).toBe(true);
  });

  it('rejects the flat MoneyWiz layout, which has neither Name nor Current balance', () => {
    expect(
      isMoneyWizReportCsv([
        'Account', 'Transfers', 'Description', 'Payee', 'Category', 'Date',
        'Time', 'Memo', 'Amount', 'Currency', 'Check #', 'Tags', 'Balance',
      ]),
    ).toBe(false);
  });

  it('rejects a generic bank export', () => {
    expect(isMoneyWizReportCsv(['Date', 'Description', 'Paid Out', 'Paid In', 'Balance'])).toBe(
      false,
    );
  });

  it('needs BOTH Name and Current balance, not just one of them', () => {
    expect(isMoneyWizReportCsv(['Name', 'Account', 'Date', 'Amount'])).toBe(false);
    expect(isMoneyWizReportCsv(['Current balance', 'Account', 'Date', 'Amount'])).toBe(false);
    expect(isMoneyWizReportCsv(['Name', 'Current balance', 'Account', 'Date', 'Amount'])).toBe(true);
  });

  // PRECEDENCE. The flat check cannot tell the two layouts apart — it only
  // ever asked for Account/Date/Amount plus one label column, all of which a
  // report file has. It is not this cluster's file to change, so the rule is
  // that every caller tests the REPORT layout first. This test exists to fail
  // loudly if anyone ever assumes the two checks are mutually exclusive.
  it('overlaps with isMoneyWizCsv — callers MUST test the report layout first', () => {
    expect(isMoneyWizCsv(REPORT_HEADERS)).toBe(true);
    expect(isMoneyWizReportCsv(REPORT_HEADERS)).toBe(true);
  });

  it('shows what reading a report file as a flat export would do', () => {
    const flat = parseMoneyWizCsv(text);
    // Account header rows become dateless "transactions", and the currency
    // column is read as an account name — 'GBP' as an account.
    expect(flat.rows.some((r) => r.accountName === 'GBP')).toBe(true);
    expect(flat.rows.some((r) => r.error !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------- the sep= line
describe('the Excel separator hint', () => {
  it('is skipped, so the header row is row 1', () => {
    const { data } = parseCsv(text);
    expect(data[0]).toEqual(REPORT_HEADERS);
  });

  it('is skipped ahead of a UTF-8 BOM too', () => {
    const { data } = parseCsv(`﻿sep=,\nDate,Amount\n01/02/2026,-1.00\n`);
    expect(data[0]).toEqual(['Date', 'Amount']);
    expect(data).toHaveLength(2);
  });

  it('leaves a real first column called “sep=…” alone', () => {
    const { data } = parseCsv('sep=,Date,Amount\nx,01/02/2026,-1.00\n');
    expect(data[0]).toEqual(['sep=', 'Date', 'Amount']);
    expect(data).toHaveLength(2);
  });

  it('leaves a quoted “sep=,” header cell alone', () => {
    const { data } = parseCsv('"sep=,",Date,Amount\nx,01/02/2026,-1.00\n');
    expect(data[0]).toEqual(['sep=,', 'Date', 'Amount']);
  });

  it('only drops the hint when it is the FIRST line', () => {
    const { data } = parseCsv('Date,Amount\nsep=,\n');
    expect(data).toHaveLength(2);
  });

  it('drops a semicolon hint as well', () => {
    const { data } = parseCsv('sep=;\nDate;Amount\n01/02/2026;-1,00\n');
    expect(data[0]).toEqual(['Date', 'Amount']);
  });
});

// ------------------------------------------------------------ rows vs accounts
describe('parseMoneyWizReportCsv row/account split', () => {
  it('reads 9 accounts and 18 transactions from 27 data rows', () => {
    expect(result.accounts).toHaveLength(9);
    expect(result.rows).toHaveLength(18);
  });

  it('never imports an account header row as a transaction', () => {
    // Header rows carry no date and no amount; if one leaked in it would show
    // up as a dateless row (and, worse, as a transaction for account "GBP").
    expect(result.rows.every((r) => r.accountName !== 'GBP')).toBe(true);
    expect(result.rows.filter((r) => r.date === null)).toHaveLength(1); // 31/02 only
    expect(result.rows.map((r) => r.index)).not.toContain(1); // row 1 is a header
  });

  it('reads the Account column as the account NAME on transaction rows', () => {
    expect(rowsOf('Everyday Current')).toHaveLength(4);
    expect(rowsOf('Platinum Credit Card')).toHaveLength(3);
    expect(result.rows.map((r) => r.accountName)).not.toContain('TRY');
  });

  it('reads the Account column as the CURRENCY on account header rows', () => {
    expect(account('Everyday Current').currency).toBe('GBP');
    expect(account('Travel Wallet').currency).toBe('TRY');
    expect(account('Overseas Savings').currency).toBe('LKR');
  });

  it('numbers rows by their position in the file, header rows included', () => {
    // Row 1 is the first account header, so its first transaction is row 2.
    expect(result.rows[0].index).toBe(2);
    expect(result.rows[result.rows.length - 1].index).toBe(27);
    expect(new Set(result.rows.map((r) => r.index)).size).toBe(result.rows.length);
  });

  it('parses dd/mm/yyyy dates, thousands separators and the other columns', () => {
    expect(result.detectedDateFormat).toBe('DMY');
    const [salary] = rowsOf('Everyday Current');
    expect(salary).toMatchObject({
      date: '2026-03-15',
      amountMinor: 240_000,
      currency: 'GBP',
      payeeName: 'Northwind Payroll',
      description: 'March salary',
      categoryPath: ['Salary'],
      tags: ['work', 'monthly'],
      transferAccountName: null,
      error: null,
    });
    expect(rowsOf('Everyday Current')[2]).toMatchObject({
      transferAccountName: 'Rainy Day Savings',
      notes: 'monthly saving',
      amountMinor: -100_000,
    });
  });

  it('splits category paths on “►” and keeps a “/” inside a leaf name', () => {
    expect(rowsOf('Everyday Current')[1].categoryPath).toEqual([
      'Food & Drink',
      'Groceries/Market',
    ]);
    expect(rowsOf('Everyday Current')[3].categoryPath).toEqual([
      'Bills & Utilities',
      'Internet',
      'Fibre/Cable',
    ]);
    expect(result.warnings.some((w) => w.includes('split on'))).toBe(false);
  });

  it('still falls back to “/” when a file uses neither “►” nor “>”', () => {
    const slashOnly = parseMoneyWizReportCsv(
      'Name,Current balance,Account,Date,Amount,Category\n' +
        'Wallet,10.00,GBP,,,\n' +
        ',,Wallet,01/03/2026,-5.00,Kids/School\n',
    );
    expect(slashOnly.rows[0].categoryPath).toEqual(['Kids', 'School']);
    expect(warningsOf(slashOnly.warnings, 'split on')).toBeDefined();
  });
});

// -------------------------------------------------------------- the balances
describe('opening balances', () => {
  it('derives opening = stated balance − Σ(amounts), exactly', () => {
    for (const a of result.accounts) {
      if (a.openingBalanceMinor === null) continue;
      const sum = rowsOf(a.name).reduce((t, r) => t + (r.amountMinor ?? 0), 0);
      expect(a.openingBalanceMinor + sum).toBe(a.currentBalanceMinor);
    }
  });

  it('hits the hand-calculated figures', () => {
    expect(account('Everyday Current')).toMatchObject({
      currentBalanceMinor: 135_075,
      openingBalanceMinor: 10_000,
    });
    expect(account('Rainy Day Savings').openingBalanceMinor).toBe(400_000);
  });

  it('handles an account whose final balance is negative (a credit card)', () => {
    expect(account('Platinum Credit Card')).toMatchObject({
      currentBalanceMinor: -74_219,
      openingBalanceMinor: -70_000, // −742.19 − (−42.19)
    });
  });

  it('handles an account whose transactions sum to more than its balance', () => {
    // £100.00 left after £1,475.00 of net inflow ⇒ it started £1,375.00 down.
    expect(account('Startup Float')).toMatchObject({
      currentBalanceMinor: 10_000,
      openingBalanceMinor: -137_500,
    });
  });

  it('keeps each account in its own currency, at its own scale', () => {
    expect(account('Travel Wallet')).toMatchObject({
      currency: 'TRY',
      currentBalanceMinor: 1_234_567,
      openingBalanceMinor: 1_158_023,
    });
    expect(account('Overseas Savings')).toMatchObject({
      currency: 'LKR',
      currentBalanceMinor: 25_000_000,
      openingBalanceMinor: 20_000_000,
    });
  });

  it('gives an account with a balance but no transactions its balance as its opening', () => {
    expect(account('Dormant Pot')).toMatchObject({
      currentBalanceMinor: 4_200,
      openingBalanceMinor: 4_200,
    });
    expect(rowsOf('Dormant Pot')).toHaveLength(0);
    expect(warning('balance but no transactions')).toContain('Dormant Pot');
  });

  it('refuses an opening balance when a row of that account will not import', () => {
    // An unreadable AMOUNT: the sum is missing that row, so balance − Σ is not
    // the opening balance — it is the opening balance plus the missing row.
    expect(account('Broken Ledger')).toMatchObject({
      currentBalanceMinor: 50_000,
      openingBalanceMinor: null,
    });
    // An unreadable DATE poisons it just the same: the row is dropped at plan
    // time, so it will never be added back by the ledger either.
    expect(account('Faded Diary')).toMatchObject({
      currentBalanceMinor: 8_000,
      openingBalanceMinor: null,
    });
    const w = warning('No opening balance could be derived');
    expect(w).toContain('Broken Ledger');
    expect(w).toContain('Faded Diary');
  });

  it('never reads the running Balance column', () => {
    // The fixture's running column ends 100.00 below the stated balance for
    // Everyday Current; deriving from it would produce an opening of 0.
    expect(account('Everyday Current').openingBalanceMinor).not.toBe(0);
  });

  it('warns about an unreadable Current balance instead of inventing one', () => {
    const odd = parseMoneyWizReportCsv(
      'Name,Current balance,Account,Date,Amount\n' +
        'Wallet,about a tenner,GBP,,\n' +
        ',,Wallet,01/03/2026,-5.00\n',
    );
    expect(odd.accounts[0]).toMatchObject({
      currentBalanceMinor: null,
      openingBalanceMinor: null,
    });
    expect(warningsOf(odd.warnings, 'unreadable “Current balance”')).toContain('Wallet');
  });

  it('refuses an opening balance when the account states no currency', () => {
    // Without a currency there is no minor-unit scale: 10.00 read at 2
    // decimals is 1000 minor, but the account could land in a 0-decimal
    // currency where that figure is 100× too big. Better none than wrong.
    const noCurrency = parseMoneyWizReportCsv(
      'Name,Current balance,Account,Date,Amount\n' +
        'Wallet,10.00,,,\n' +
        ',,Wallet,01/03/2026,-5.00\n',
    );
    expect(noCurrency.accounts[0]).toMatchObject({ currency: '', openingBalanceMinor: null });
    expect(warningsOf(noCurrency.warnings, 'No currency could be read')).toContain('Wallet');
    // …and nothing about it reaches the planner either.
    const opts = reportPlanOptions(noCurrency.accounts);
    expect(opts.accountOpeningBalances.size).toBe(0);
    expect(opts.accountCurrencies.size).toBe(0);
  });

  it('falls back to the transaction rows when only the header row lacks a currency', () => {
    const fallback = parseMoneyWizReportCsv(
      'Name,Current balance,Account,Date,Amount,Currency\n' +
        'Wallet,10.00,,,,\n' +
        ',,Wallet,01/03/2026,-5.00,TRY\n',
    );
    expect(fallback.accounts[0]).toMatchObject({
      currency: 'TRY',
      currentBalanceMinor: 1_000,
      openingBalanceMinor: 1_500,
    });
  });

  it('counts the rows it had to drop, and names an undeclared account', () => {
    expect(warning('unreadable amount')).toContain('1 row');
    expect(warning('unreadable date')).toContain('1 row');
    expect(warning('never declared by an account row')).toContain('Ghost Account');
  });
});

// ------------------------------------------------------- through the planner
describe('buildImportPlan / commitImport with report balances', () => {
  beforeEach(async () => {
    await clearAll();
    await seedCategoriesIfEmpty();
  });

  it('carries each opening balance onto the account it creates', async () => {
    const plan = await planForReport();
    const na = (name: string) => plan.newAccounts.find((a) => a.name === name)!;
    expect(na('Everyday Current')).toMatchObject({
      currency: 'GBP',
      openingBalanceMinor: 10_000,
    });
    expect(na('Platinum Credit Card').openingBalanceMinor).toBe(-70_000);
    expect(na('Travel Wallet')).toMatchObject({
      currency: 'TRY',
      openingBalanceMinor: 1_158_023,
    });
    // Poisoned accounts get NO opening balance rather than a wrong one.
    expect(na('Broken Ledger').openingBalanceMinor).toBeUndefined();
    expect(na('Faded Diary').openingBalanceMinor).toBeUndefined();
    // An account the file declares but no row uses is still created.
    expect(na('Dormant Pot')).toMatchObject({ currency: 'GBP', openingBalanceMinor: 4_200 });
    // An account only a transaction row names has no balance to state.
    expect(na('Ghost Account').openingBalanceMinor).toBeUndefined();
  });

  it('commits balances that match the file, to the penny', async () => {
    const plan = await planForReport();
    await commitImport(plan);
    const balances = await accountBalances();
    const balanceOf = (name: string) =>
      balances.find((b) => b.account.name === name)!.balanceMinor;
    expect(balanceOf('Everyday Current')).toBe(135_075);
    expect(balanceOf('Rainy Day Savings')).toBe(500_000);
    expect(balanceOf('Platinum Credit Card')).toBe(-74_219);
    expect(balanceOf('Startup Float')).toBe(10_000);
    expect(balanceOf('Travel Wallet')).toBe(1_234_567);
    expect(balanceOf('Overseas Savings')).toBe(25_000_000);
    expect(balanceOf('Dormant Pot')).toBe(4_200);
    // The two poisoned accounts open at zero — visibly short of the file's
    // figure, which is exactly what the warning told the user would happen.
    expect(balanceOf('Broken Ledger')).toBe(-1_000);
    expect(balanceOf('Faded Diary')).toBe(-2_000);
  });

  it('still links the transfer pair (and it does not disturb the balances)', async () => {
    const plan = await planForReport();
    const legs = plan.rows.filter((r) => r.row.transferAccountName);
    expect(legs).toHaveLength(2);
    expect(legs[0].transferPairIndex).toBe(plan.rows.indexOf(legs[1]));
    expect(legs[1].transferPairIndex).toBe(plan.rows.indexOf(legs[0]));
    expect(plan.unpairedTransferCount).toBe(0);

    await commitImport(plan);
    const linked = (await db.transactions.toArray()).filter((t) => t.transferGroupId !== null);
    expect(linked).toHaveLength(2);
    expect(new Set(linked.map((t) => t.transferGroupId)).size).toBe(1);
    expect(linked.every((t) => t.categoryId === null)).toBe(true);
  });

  it('creates every account in the currency its header row declares', async () => {
    await commitImport(await planForReport());
    const byName = new Map((await db.accounts.toArray()).map((a) => [a.name, a]));
    expect(byName.get('Travel Wallet')!.currency).toBe('TRY');
    expect(byName.get('Overseas Savings')!.currency).toBe('LKR');
    expect(byName.get('Everyday Current')!.currency).toBe('GBP');
  });

  it('never rewrites an existing account’s opening balance, and says so', async () => {
    const existing = await addAccount('Everyday Current', 'GBP', 999_999);
    const plan = await planForReport();
    expect(plan.existingAccountsWithOpeningBalance).toContain('Everyday Current');
    expect(plan.newAccounts.some((a) => a.name === 'Everyday Current')).toBe(false);
    await commitImport(plan);
    expect((await db.accounts.get(existing.id))!.openingBalanceMinor).toBe(999_999);
  });

  it('leaves every other format on a zero opening balance', async () => {
    // No accountOpeningBalances passed ⇒ today's behaviour, unchanged.
    const plan = await buildImportPlan(result.rows, planOpts);
    expect(plan.newAccounts.every((a) => a.openingBalanceMinor === undefined)).toBe(true);
    expect(plan.existingAccountsWithOpeningBalance).toEqual([]);
    // …and an account with no rows cannot be conjured without its currency.
    expect(plan.newAccounts.some((a) => a.name === 'Dormant Pot')).toBe(false);
    await commitImport(plan);
    expect((await db.accounts.toArray()).every((a) => a.openingBalanceMinor === 0)).toBe(true);
  });
});
