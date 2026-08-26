// The preview's ACCOUNT BALANCES panel for MoneyWiz *Report* imports
// (SPEC §7.4, §6). The panel itself needs a DOM the suite does not have, so
// the part that actually matters — the arithmetic it displays — lives in
// src/ui/import/reportFormat.ts and is tested here directly.
//
// What is being protected: the panel promises "this account will read X after
// importing". If that number is not exactly opening + Σ(the rows that really
// get written), the preview lies on the one screen whose entire job is
// checking balances. Every fixture below is invented.
import { describe, expect, it } from 'vitest';
import type { ImportPlan, ImportPlanRow, NewAccountPlan, ParsedRow } from '../src/import/types';
import {
  existingAccountsNote,
  linesUp,
  needsAttention,
  plannedOpeningMinor,
  reportAccountLines,
  reportAccountSummary,
  type ReportAccount,
} from '../src/ui/import/reportFormat';
import { willImportRow } from '../src/ui/import/wizardLogic';
import { parseCsv } from '../src/import/generic';
import { isMoneyWizCsv } from '../src/import/moneywiz';
import { isMoneyWizReportCsv, parseMoneyWizReportCsv } from '../src/ui/import/reportFormat';

const account = (
  name: string,
  currentBalanceMinor: number | null,
  openingBalanceMinor: number | null,
  currency = 'GBP',
): ReportAccount => ({ name, currency, currentBalanceMinor, openingBalanceMinor });

const parsed = (over: Partial<ParsedRow> = {}): ParsedRow => ({
  index: 1,
  date: '2026-03-04',
  amountMinor: -1000,
  currency: 'GBP',
  accountName: 'Everyday',
  payeeName: null,
  description: null,
  categoryPath: [],
  tags: [],
  notes: null,
  transferAccountName: null,
  amountText: null,
  error: null,
  ...over,
});

const planRow = (row: Partial<ParsedRow>, over: Partial<ImportPlanRow> = {}): ImportPlanRow => ({
  row: parsed(row),
  action: 'import',
  ...over,
});

const newAccount = (over: Partial<NewAccountPlan> & { name: string }): NewAccountPlan => ({
  currency: 'GBP',
  create: true,
  ...over,
});

const plan = (over: Partial<ImportPlan> = {}): ImportPlan => ({
  source: 'moneywiz',
  fileName: 'report.csv',
  rows: [],
  newAccounts: [],
  newCategoryPaths: [],
  newPayees: [],
  newTags: [],
  exactDuplicateCount: 0,
  nearDuplicateCount: 0,
  errorCount: 0,
  currencyMismatchCount: 0,
  unpairedTransferCount: 0,
  importableCount: 0,
  existingAccountsWithOpeningBalance: [],
  ...over,
});

const noExisting = new Set<string>();

describe('report-format account balance lines', () => {
  it('lands the account exactly on the balance the file states', () => {
    // £1,234.50 closing, two rows totalling −£15.00 ⇒ opening £1,249.50.
    const p = plan({
      rows: [
        planRow({ index: 1, amountMinor: -2000 }),
        planRow({ index: 2, amountMinor: 500 }),
      ],
      newAccounts: [newAccount({ name: 'Everyday', openingBalanceMinor: 124950 })],
    });
    const [line] = reportAccountLines([account('Everyday', 123450, 124950)], p, noExisting, 'GBP');

    expect(line.status).toBe('new');
    expect(line.openingApplied).toBe(true);
    expect(line.importedCount).toBe(2);
    expect(line.importedNetMinor).toBe(-1500);
    expect(line.finalMinor).toBe(123450);
    expect(line.fileBalanceMinor).toBe(123450);
    expect(line.differenceMinor).toBe(0);
    expect(linesUp(line)).toBe(true);
    expect(needsAttention(line)).toBe(false);
  });

  it('reports the shortfall when a row is skipped, to the penny', () => {
    // The £5.00 row is an exact duplicate of something already here, so it is
    // not written — and the account therefore ends £5.00 away from the file.
    const p = plan({
      rows: [
        planRow({ index: 1, amountMinor: -2000 }),
        planRow({ index: 2, amountMinor: 500 }, { action: 'skip_exact_duplicate' }),
      ],
      newAccounts: [newAccount({ name: 'Everyday', openingBalanceMinor: 124950 })],
    });
    const [line] = reportAccountLines([account('Everyday', 123450, 124950)], p, noExisting, 'GBP');

    expect(line.importedCount).toBe(1);
    expect(line.skippedCount).toBe(1);
    expect(line.finalMinor).toBe(122950);
    expect(line.differenceMinor).toBe(-500);
    expect(needsAttention(line)).toBe(true);
  });

  it('follows a near-duplicate decision, so the panel moves when he does', () => {
    const rows = [planRow({ index: 1, amountMinor: -2000 }, { action: 'needs_decision' })];
    const p = plan({
      rows,
      newAccounts: [newAccount({ name: 'Everyday', openingBalanceMinor: 124950 })],
    });
    const accounts = [account('Everyday', 122950, 124950)];

    // Default is skip ⇒ the account stays at its opening balance.
    expect(reportAccountLines(accounts, p, noExisting, 'GBP')[0].finalMinor).toBe(124950);

    rows[0].decision = 'import';
    const after = reportAccountLines(accounts, p, noExisting, 'GBP')[0];
    expect(after.finalMinor).toBe(122950);
    expect(after.differenceMinor).toBe(0);
  });

  it('counts both legs of a transfer, each against its own account', () => {
    const p = plan({
      rows: [
        planRow(
          { index: 1, accountName: 'Everyday', amountMinor: -50000, transferAccountName: 'Savings' },
          { transferPairIndex: 1 },
        ),
        planRow(
          { index: 2, accountName: 'Savings', amountMinor: 50000, transferAccountName: 'Everyday' },
          { transferPairIndex: 0 },
        ),
      ],
      newAccounts: [
        newAccount({ name: 'Everyday', openingBalanceMinor: 60000 }),
        newAccount({ name: 'Savings', openingBalanceMinor: 0 }),
      ],
    });
    const lines = reportAccountLines(
      [account('Everyday', 10000, 60000), account('Savings', 50000, 0)],
      p,
      noExisting,
      'GBP',
    );
    expect(lines.map((l) => l.finalMinor)).toEqual([10000, 50000]);
    expect(lines.every(linesUp)).toBe(true);
  });

  it('never invents an opening balance the engine could not work out', () => {
    const p = plan({
      rows: [planRow({ index: 1, amountMinor: -2000 })],
      newAccounts: [newAccount({ name: 'Everyday' })], // no openingBalanceMinor
    });
    const [line] = reportAccountLines([account('Everyday', null, null)], p, noExisting, 'GBP');

    expect(line.fileOpeningMinor).toBeNull();
    expect(line.openingApplied).toBe(false);
    expect(line.finalMinor).toBeNull();
    expect(line.differenceMinor).toBeNull();
    expect(needsAttention(line)).toBe(true); // flagged, not quietly zeroed
    expect(reportAccountSummary([line]).missingOpening).toBe(1);
  });

  it('leaves an existing account’s opening balance alone and says so', () => {
    const p = plan({
      rows: [planRow({ index: 1, amountMinor: -2000 }, { accountId: 'acc-1' })],
      existingAccountsWithOpeningBalance: ['Everyday'],
    });
    const [line] = reportAccountLines(
      [account('Everyday', 123450, 124950)],
      p,
      new Set(['everyday']),
      'GBP',
    );

    expect(line.status).toBe('existing');
    expect(line.openingApplied).toBe(false);
    expect(line.finalMinor).toBeNull(); // we do not claim a balance we can't know
    expect(line.fileOpeningMinor).toBe(124950); // still shown, marked not applied
    expect(existingAccountsNote(p.existingAccountsWithOpeningBalance)).toContain('Everyday');
    expect(existingAccountsNote([])).toBeNull();
  });

  it('distinguishes an unticked account from one with no transactions', () => {
    const p = plan({
      rows: [planRow({ index: 1, accountName: 'Unticked', amountMinor: -2000 })],
      newAccounts: [
        newAccount({ name: 'Unticked', create: false, openingBalanceMinor: 5000 }),
      ],
    });
    const lines = reportAccountLines(
      [account('Unticked', 3000, 5000), account('Dormant', 999, 999)],
      p,
      noExisting,
      'GBP',
    );

    expect(lines[0].status).toBe('not-created');
    expect(lines[0].importedCount).toBe(0);
    expect(lines[0].skippedCount).toBe(1);
    expect(lines[0].finalMinor).toBeNull();

    // Named by the file but never planned (no currency, no rows to infer one
    // from) ⇒ nothing creates it, and the panel has to say so.
    expect(lines[1].status).toBe('not-planned');
    expect(lines[1].finalMinor).toBeNull();
  });

  it('matches accounts by name the way the engine does, not by exact spelling', () => {
    const p = plan({
      rows: [planRow({ index: 1, accountName: '  everyday  ', amountMinor: -2000 })],
      newAccounts: [newAccount({ name: 'Everyday', openingBalanceMinor: 5000 })],
    });
    const [line] = reportAccountLines([account('Everyday', 3000, 5000)], p, noExisting, 'GBP');
    expect(line.importedCount).toBe(1);
    expect(line.finalMinor).toBe(3000);
  });

  it('summarises the file the way the panel headline reads', () => {
    const p = plan({
      rows: [
        planRow({ index: 1, accountName: 'A', amountMinor: -2000 }),
        planRow({ index: 2, accountName: 'B', amountMinor: -1000 }, { action: 'error' }),
      ],
      newAccounts: [
        newAccount({ name: 'A', openingBalanceMinor: 5000 }),
        newAccount({ name: 'B', openingBalanceMinor: 5000 }),
      ],
    });
    const lines = reportAccountLines(
      [account('A', 3000, 5000), account('B', 4000, 5000), account('C', 100, 100)],
      p,
      noExisting,
      'GBP',
    );
    expect(reportAccountSummary(lines)).toEqual({
      total: 3,
      creating: 2,
      matching: 1, // only A lands where the file says
      attention: 2, // B (errored row) and C (never created)
      missingOpening: 0,
    });
  });

  it('prefers the plan’s opening balance over the parser’s', () => {
    // The engine gets the last word: it knows the account's real currency and
    // so the real minor-unit scale.
    expect(plannedOpeningMinor(newAccount({ name: 'A', openingBalanceMinor: 7 }))).toBe(7);
    expect(plannedOpeningMinor(newAccount({ name: 'A' }))).toBeNull();
  });
});

describe('willImportRow mirrors the engine', () => {
  const base = plan({ newAccounts: [newAccount({ name: 'Everyday' })] });

  it('excludes errors, exact duplicates and undecided near-duplicates', () => {
    expect(willImportRow(base, planRow({}, { action: 'error' }))).toBe(false);
    expect(willImportRow(base, planRow({}, { action: 'skip_exact_duplicate' }))).toBe(false);
    expect(willImportRow(base, planRow({}, { action: 'needs_decision' }))).toBe(false);
    expect(
      willImportRow(base, planRow({}, { action: 'needs_decision', decision: 'import' })),
    ).toBe(true);
  });

  it('follows the account tick, and always imports into an existing account', () => {
    expect(willImportRow(base, planRow({}))).toBe(true);
    const unticked = plan({ newAccounts: [newAccount({ name: 'Everyday', create: false })] });
    expect(willImportRow(unticked, planRow({}))).toBe(false);
    expect(willImportRow(unticked, planRow({}, { accountId: 'acc-1' }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Which parser the wizard hands the file to (ImportWizard.handleFile).
// Entirely invented data in the real layout's shape.
// ---------------------------------------------------------------------------

const REPORT_CSV = [
  'sep=,',
  'Name,Current balance,Account,Transfers,Description,Payee,Category,Date,Memo,Amount,Currency,Cheque N°,Tags,Balance',
  'Pocket Money,"1,234.50",GBP,,,,,,,,,,,',
  ',,Pocket Money,,Coffee,Bean Cart,Food/Coffee,04/03/2026,,"-20.00",GBP,,,"1,229.50"',
  ',,Pocket Money,,Refund,Bean Cart,Food/Coffee,05/03/2026,,"5.00",GBP,,,"1,234.50"',
  'Rainy Day,"500.00",GBP,,,,,,,,,,,',
].join('\n');

const FLAT_CSV = [
  'Account,Date,Payee,Category,Amount,Currency,Description,Tags',
  'Pocket Money,04/03/2026,Bean Cart,Food > Coffee,-20.00,GBP,Coffee,',
].join('\n');

const headersOf = (text: string): string[] =>
  (parseCsv(text).data[0] ?? []).map((h) => h.trim());

describe('routing a file to the right MoneyWiz parser', () => {
  it('recognises the report layout through the Excel sep= hint', () => {
    // parseCsv drops the hint, so the wizard tests the REAL header row.
    expect(headersOf(REPORT_CSV)[0]).toBe('Name');
    expect(isMoneyWizReportCsv(headersOf(REPORT_CSV))).toBe(true);
  });

  it('is why the report test must run FIRST', () => {
    // The report header also satisfies the flat test (Account/Date/Amount/
    // Payee are all present) — but read as a flat export its account rows
    // become transactions and its "Account" column is a currency code. If
    // this assertion ever goes false, the order in handleFile stops
    // mattering; while it is true, reordering those branches is a bug.
    expect(isMoneyWizCsv(headersOf(REPORT_CSV))).toBe(true);
  });

  it('leaves a flat MoneyWiz export on the flat path', () => {
    expect(isMoneyWizReportCsv(headersOf(FLAT_CSV))).toBe(false);
    expect(isMoneyWizCsv(headersOf(FLAT_CSV))).toBe(true);
  });

  it('derives opening balances the panel can then reconcile', () => {
    const r = parseMoneyWizReportCsv(REPORT_CSV);
    expect(r.rows).toHaveLength(2); // account rows are not transactions
    expect(r.accounts.map((a) => a.name)).toEqual(['Pocket Money', 'Rainy Day']);

    const [pocket, rainy] = r.accounts;
    // 1234.50 closing − (−20.00 + 5.00) = 1249.50 opening.
    expect(pocket.openingBalanceMinor).toBe(124950);
    expect(pocket.currentBalanceMinor).toBe(123450);
    expect(pocket.currency).toBe('GBP');
    // No transactions: the account is pure opening balance.
    expect(rainy.openingBalanceMinor).toBe(50000);

    // And the panel's arithmetic closes the loop back onto the file.
    const p = plan({
      rows: [
        planRow({ index: 1, accountName: 'Pocket Money', amountMinor: -2000 }),
        planRow({ index: 2, accountName: 'Pocket Money', amountMinor: 500 }),
      ],
      newAccounts: [
        newAccount({ name: 'Pocket Money', openingBalanceMinor: 124950 }),
        newAccount({ name: 'Rainy Day', openingBalanceMinor: 50000 }),
      ],
    });
    const lines = reportAccountLines(r.accounts, p, noExisting, 'GBP');
    expect(lines.map((l) => l.finalMinor)).toEqual([123450, 50000]);
    expect(lines.every(linesUp)).toBe(true);
    expect(reportAccountSummary(lines).matching).toBe(2);
  });
});
