// MoneyWiz CSV parser tests (SPEC §7.1, §10): detection, exact row values,
// category path and tag splitting, transfer rows, warnings.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMoneyWizCsv, parseMoneyWizCsv } from '../src/import/moneywiz';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const MW_HEADERS = [
  'Account', 'Transfers', 'Description', 'Payee', 'Category', 'Date', 'Time',
  'Memo', 'Amount', 'Currency', 'Check #', 'Tags', 'Balance',
];

describe('isMoneyWizCsv', () => {
  it('accepts the standard MoneyWiz header set (case-insensitive)', () => {
    expect(isMoneyWizCsv(MW_HEADERS)).toBe(true);
    expect(isMoneyWizCsv(MW_HEADERS.map((h) => h.toUpperCase()))).toBe(true);
  });
  it('accepts a minimal account+date+amount+payee set', () => {
    expect(isMoneyWizCsv(['Account', 'Payee', 'Date', 'Amount'])).toBe(true);
  });
  it('rejects a generic bank export (no Account/Amount columns)', () => {
    expect(isMoneyWizCsv(['Date', 'Description', 'Paid Out', 'Paid In', 'Balance'])).toBe(false);
  });
  it('rejects when none of payee/description/category exist', () => {
    expect(isMoneyWizCsv(['Account', 'Date', 'Amount', 'Balance'])).toBe(false);
  });
});

describe('parseMoneyWizCsv over the fixture', () => {
  const result = parseMoneyWizCsv(fixture('moneywiz.csv'));

  it('parses every data row', () => {
    expect(result.rows).toHaveLength(27);
    expect(result.headers).toEqual(MW_HEADERS);
    expect(result.rows.every((r) => r.error === null)).toBe(true);
  });

  it('spot-checks row 1 exactly (dd/mm/yyyy + quoted thousands)', () => {
    // Hand-calc: "2,650.00" GBP ⇒ 2650×100 = 265000 minor units.
    expect(result.rows[0]).toEqual({
      index: 1,
      date: '2026-06-25', // 25/06/2026, DMY detected over the whole column
      amountMinor: 265000,
      currency: 'GBP',
      accountName: 'Current Account',
      payeeName: 'Acme Ltd',
      description: 'June salary',
      categoryPath: ['Salary'],
      tags: ['work'],
      notes: null,
      transferAccountName: null,
      error: null,
    });
  });

  it('splits multi-level category paths on >', () => {
    // Row 2: 'Housing > Rent', hand-calc "-1,200.00" ⇒ -120000 minor.
    expect(result.rows[1].categoryPath).toEqual(['Housing', 'Rent']);
    expect(result.rows[1].amountMinor).toBe(-120000);
    expect(result.rows[1].notes).toBe('July rent'); // Memo → notes
  });

  it('keeps quoted commas inside fields and splits tags on ;', () => {
    // Row 3: description has a real comma; tags 'food;weekly'.
    expect(result.rows[2].description).toBe('Weekly shop, fruit & veg');
    expect(result.rows[2].amountMinor).toBe(-5420);
    expect(result.rows[2].tags).toEqual(['food', 'weekly']);
  });

  it('marks transfer rows via the Transfers column', () => {
    // Row 7: Current Account → Savings, -300.00 ⇒ -30000 minor.
    expect(result.rows[6].transferAccountName).toBe('Savings');
    expect(result.rows[6].accountName).toBe('Current Account');
    expect(result.rows[6].amountMinor).toBe(-30000);
    expect(result.rows[6].payeeName).toBeNull();
    expect(result.rows[6].categoryPath).toEqual([]);
    // Row 8: the opposite leg.
    expect(result.rows[7].transferAccountName).toBe('Current Account');
    expect(result.rows[7].amountMinor).toBe(30000);
  });

  it('keeps per-row currency (EUR rows)', () => {
    // Row 11: -234.50 EUR ⇒ -23450 minor.
    expect(result.rows[10].currency).toBe('EUR');
    expect(result.rows[10].amountMinor).toBe(-23450);
    expect(result.rows[10].accountName).toBe('Euro Account');
  });

  it('a refund is simply a positive amount in an expense category path', () => {
    // Row 13: +55.00 ⇒ +5500 minor, category Shopping > Clothing.
    expect(result.rows[12].amountMinor).toBe(5500);
    expect(result.rows[12].categoryPath).toEqual(['Shopping', 'Clothing']);
  });

  it('warns about mixed currencies within one account name', () => {
    const mixed = parseMoneyWizCsv(
      'Account,Payee,Date,Amount,Currency\n' +
        'Wallet,A,01/07/2026,-10.00,GBP\n' +
        'Wallet,B,02/07/2026,-10.00,EUR\n',
    );
    expect(mixed.warnings.some((w) => w.includes('Wallet') && w.includes('mixed'))).toBe(true);
  });

  it('warns about unrecognised extra columns', () => {
    const odd = parseMoneyWizCsv(
      'Account,Payee,Date,Amount,Wibble\nCurrent,A,01/07/2026,-10.00,x\n',
    );
    expect(odd.warnings.some((w) => w.includes('Wibble'))).toBe(true);
    expect(odd.rows).toHaveLength(1);
    expect(odd.rows[0].amountMinor).toBe(-1000);
  });
});

describe('category path fallback', () => {
  it("splits on '/' ONLY when no '>' appears anywhere in the column", () => {
    const slashOnly = parseMoneyWizCsv(
      'Account,Payee,Category,Date,Amount\n' +
        'Current,A,Food/Groceries,01/07/2026,-10.00\n' +
        'Current,B,Transport,02/07/2026,-5.00\n',
    );
    expect(slashOnly.rows[0].categoryPath).toEqual(['Food', 'Groceries']);
    expect(slashOnly.rows[1].categoryPath).toEqual(['Transport']);

    // When '>' appears anywhere, '/' is literal (part of a name).
    const gtPresent = parseMoneyWizCsv(
      'Account,Payee,Category,Date,Amount\n' +
        'Current,A,Food > Groceries,01/07/2026,-10.00\n' +
        'Current,B,Taxi/Ride,02/07/2026,-5.00\n',
    );
    expect(gtPresent.rows[0].categoryPath).toEqual(['Food', 'Groceries']);
    expect(gtPresent.rows[1].categoryPath).toEqual(['Taxi/Ride']);
  });

  it('splits tags on commas too', () => {
    const r = parseMoneyWizCsv(
      'Account,Payee,Date,Amount,Tags\nCurrent,A,01/07/2026,-10.00,"work, travel"\n',
    );
    expect(r.rows[0].tags).toEqual(['work', 'travel']);
  });
});

describe('rows with bad values carry errors', () => {
  it('flags unparseable dates and amounts but still returns the rows', () => {
    const r = parseMoneyWizCsv(
      'Account,Payee,Date,Amount\n' +
        'Current,A,31/02/2026,-10.00\n' +
        'Current,B,01/07/2026,ten pounds\n' +
        'Current,C,02/07/2026,-10.00\n',
    );
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0].error).toMatch(/date/i);
    expect(r.rows[1].error).toMatch(/amount/i);
    expect(r.rows[2].error).toBeNull();
  });
});
