// Generic CSV parsing unit tests (SPEC §7.2, §10): date/decimal detection,
// flexible amount parsing, mapping guess, and parseWithMapping over fixtures.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  detectDateFormat,
  detectDecimalStyle,
  emptyMapping,
  fileSignature,
  guessMapping,
  parseCsv,
  parseDateString,
  parseImportAmount,
  parseWithMapping,
} from '../src/import/generic';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

// ---------------------------------------------------------------- parseCsv
describe('parseCsv', () => {
  it('handles quoted commas and greedy empty lines', () => {
    const { data, errors } = parseCsv('a,b\n"hello, world",2\n\n   \n"x",3\n');
    expect(errors).toEqual([]);
    expect(data).toEqual([
      ['a', 'b'],
      ['hello, world', '2'],
      ['x', '3'],
    ]);
  });

  it('auto-detects a semicolon delimiter', () => {
    const { data } = parseCsv('a;b;c\n1;2;3\n');
    expect(data).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('strips a UTF-8 BOM from the first header', () => {
    const { data } = parseCsv('﻿Date,Amount\n1,2\n');
    expect(data[0][0]).toBe('Date');
  });
});

// -------------------------------------------------------- detectDateFormat
describe('detectDateFormat', () => {
  it('4-digit first component ⇒ YMD', () => {
    expect(detectDateFormat(['2026-07-01', '2026-07-02'])).toBe('YMD');
  });
  it('any first component >12 ⇒ DMY', () => {
    expect(detectDateFormat(['03/07/2026', '25/06/2026'])).toBe('DMY');
  });
  it('any second component >12 ⇒ MDY', () => {
    expect(detectDateFormat(['06/25/2026', '07/01/2026'])).toBe('MDY');
  });
  it('fully ambiguous ⇒ DMY (en-GB default)', () => {
    expect(detectDateFormat(['03/04/2026', '05/06/2026'])).toBe('DMY');
  });
  it('works with dots as separators', () => {
    expect(detectDateFormat(['15.06.2026', '03.06.2026'])).toBe('DMY');
  });
});

// --------------------------------------------------------- parseDateString
describe('parseDateString', () => {
  it('parses the three numeric orders', () => {
    expect(parseDateString('25/06/2026', 'DMY')).toBe('2026-06-25');
    expect(parseDateString('06/25/2026', 'MDY')).toBe('2026-06-25');
    expect(parseDateString('2026-06-25', 'YMD')).toBe('2026-06-25');
  });
  it('auto mode disambiguates per value', () => {
    expect(parseDateString('25/06/2026', 'auto')).toBe('2026-06-25'); // 25>12 ⇒ DMY
    expect(parseDateString('06/25/2026', 'auto')).toBe('2026-06-25'); // 2nd >12 ⇒ MDY
    expect(parseDateString('2026-06-25', 'auto')).toBe('2026-06-25'); // 4-digit ⇒ YMD
    expect(parseDateString('03/04/2026', 'auto')).toBe('2026-04-03'); // ambiguous ⇒ DMY
  });
  it('accepts 1-digit day/month and dots', () => {
    expect(parseDateString('3.6.2026', 'DMY')).toBe('2026-06-03');
  });
  it('two-digit years pivot at 50 (<50 ⇒ 20xx, else 19xx)', () => {
    expect(parseDateString('25/06/26', 'DMY')).toBe('2026-06-25');
    expect(parseDateString('25/06/99', 'DMY')).toBe('1999-06-25');
    expect(parseDateString('01/02/49', 'DMY')).toBe('2049-02-01');
    expect(parseDateString('01/02/50', 'DMY')).toBe('1950-02-01');
  });
  it('month-name forms via the explicit table', () => {
    expect(parseDateString('5 Jan 2024', 'auto')).toBe('2024-01-05');
    expect(parseDateString('05 January 2024', 'auto')).toBe('2024-01-05');
    expect(parseDateString('Jan 5, 2024', 'auto')).toBe('2024-01-05');
    expect(parseDateString('Sep 30, 2025', 'auto')).toBe('2025-09-30');
  });
  it('rejects impossible dates', () => {
    expect(parseDateString('31/02/2026', 'DMY')).toBeNull(); // Feb 31
    expect(parseDateString('13/13/2026', 'auto')).toBeNull(); // month 13
    expect(parseDateString('29/02/2023', 'DMY')).toBeNull(); // not a leap year
    expect(parseDateString('29/02/2024', 'DMY')).toBe('2024-02-29'); // leap year
    expect(parseDateString('00/01/2026', 'DMY')).toBeNull();
    expect(parseDateString('', 'auto')).toBeNull();
    expect(parseDateString('not a date', 'auto')).toBeNull();
  });
  it('ignores a trailing time component', () => {
    expect(parseDateString('25/06/2026 14:30', 'DMY')).toBe('2026-06-25');
  });
});

// ------------------------------------------------------- detectDecimalStyle
describe('detectDecimalStyle', () => {
  it('en-GB columns are dot', () => {
    expect(detectDecimalStyle(['2,650.00', '-54.20', '500'])).toBe('dot');
  });
  it('European columns are comma', () => {
    expect(detectDecimalStyle(['-45,67', '-1.234,56', '2.500,00'])).toBe('comma');
  });
  it('when both separators appear, the LAST one is the decimal', () => {
    expect(detectDecimalStyle(['1.234,56'])).toBe('comma');
    expect(detectDecimalStyle(['1,234.56'])).toBe('dot');
  });
  it('comma + 3 trailing digits is thousands grouping, not decimal', () => {
    expect(detectDecimalStyle(['1,234', '5,678'])).toBe('dot');
  });
  it('defaults to dot when there is no evidence', () => {
    expect(detectDecimalStyle(['500', '1200'])).toBe('dot');
    expect(detectDecimalStyle([])).toBe('dot');
  });
});

// -------------------------------------------------------- parseImportAmount
describe('parseImportAmount', () => {
  // Hand-calc: '1,234.56' = 1234.56 GBP = 1234×100 + 56 = 123456 minor units.
  it("parses '1,234.56' (dot thousands)", () => {
    expect(parseImportAmount('1,234.56', 'GBP', 'auto')).toBe(123456);
  });
  // Hand-calc: '1.234,56' = 1234.56 = 123456 minor (last separator = decimal).
  it("parses '1.234,56' (comma decimal)", () => {
    expect(parseImportAmount('1.234,56', 'GBP', 'auto')).toBe(123456);
  });
  // Hand-calc: (45.00) = -45.00 = -4500 minor.
  it('parentheses mean negative', () => {
    expect(parseImportAmount('(45.00)', 'GBP', 'auto')).toBe(-4500);
  });
  // Hand-calc: £12.34 = 12×100 + 34 = 1234 minor.
  it('strips currency symbols and codes', () => {
    expect(parseImportAmount('£12.34', 'GBP', 'auto')).toBe(1234);
    expect(parseImportAmount('GBP 45.00', 'GBP', 'auto')).toBe(4500);
    expect(parseImportAmount('-€1.234,56', 'EUR', 'auto')).toBe(-123456);
  });
  // Hand-calc: bare '500' = £500.00 = 50000 minor.
  it("bare '500' is 500 whole units", () => {
    expect(parseImportAmount('500', 'GBP', 'auto')).toBe(50000);
  });
  // A single separator with exactly 3 trailing digits ⇒ THOUSANDS separator:
  // '1,234' = 1234.00 = 123400 minor; '1.234' likewise.
  it('single separator + 3 trailing digits is a thousands separator', () => {
    expect(parseImportAmount('1,234', 'GBP', 'auto')).toBe(123400);
    expect(parseImportAmount('1.234', 'GBP', 'auto')).toBe(123400);
  });
  it('…unless the style forces it to be a decimal (⇒ excess precision ⇒ null)', () => {
    expect(parseImportAmount('1.234', 'GBP', 'dot')).toBeNull(); // 3 dp > GBP's 2
    expect(parseImportAmount('1,234', 'GBP', 'comma')).toBeNull();
  });
  // Hand-calc: '45,5' comma decimal = 45.5 = 4550 minor.
  it('handles 1-digit decimals', () => {
    expect(parseImportAmount('45,5', 'GBP', 'auto')).toBe(4550);
  });
  it('zero-decimal currencies (JPY)', () => {
    expect(parseImportAmount('¥500', 'JPY', 'auto')).toBe(500);
    expect(parseImportAmount('500.25', 'JPY', 'auto')).toBeNull(); // excess precision
  });
  it('signs', () => {
    expect(parseImportAmount('-300.00', 'GBP', 'auto')).toBe(-30000);
    expect(parseImportAmount('+300.00', 'GBP', 'auto')).toBe(30000);
  });
  it('rejects garbage', () => {
    expect(parseImportAmount('', 'GBP', 'auto')).toBeNull();
    expect(parseImportAmount('abc', 'GBP', 'auto')).toBeNull();
    expect(parseImportAmount('12.34.56.78', 'GBP', 'dot')).toBeNull();
    expect(parseImportAmount('1-2', 'GBP', 'auto')).toBeNull();
  });
});

// ------------------------------------------------- guessMapping + signature
describe('guessMapping', () => {
  it('maps a debit/credit bank export by header synonyms', () => {
    const { data } = parseCsv(fixture('generic-bank.csv'));
    const map = guessMapping(data[0], data.slice(1, 4));
    expect(map.date).toBe(0);
    expect(map.payee).toBe(1); // lone Description column becomes the payee
    expect(map.description).toBe(-1);
    expect(map.debit).toBe(2); // 'Paid Out'
    expect(map.credit).toBe(3); // 'Paid In'
    expect(map.amount).toBe(-1);
    expect(map.headerRow).toBe(true);
    expect(map.dateFormat).toBe('auto');
    expect(map.decimal).toBe('auto');
  });

  it('keeps Payee and Description separate when both exist', () => {
    const map = guessMapping(['Date', 'Payee', 'Description', 'Amount'], []);
    expect(map.payee).toBe(1);
    expect(map.description).toBe(2);
    expect(map.amount).toBe(3);
  });

  it("recognises 'Amount (GBP)' and 'Transaction Date'", () => {
    const map = guessMapping(['Transaction Date', 'Merchant', 'Amount (GBP)'], []);
    expect(map.date).toBe(0);
    expect(map.payee).toBe(1);
    expect(map.amount).toBe(2);
  });

  it('detects a data first row (no header)', () => {
    const map = guessMapping(['01/07/2026', 'TESCO', '-45.60'], [['02/07/2026', 'BOOTS', '-8.99']]);
    expect(map.headerRow).toBe(false);
    expect(map.date).toBe(0);
    expect(map.amount).toBe(2);
    expect(map.payee).toBe(1);
  });
});

describe('fileSignature', () => {
  it('is the lowercased trimmed headers joined with |', () => {
    expect(fileSignature([' Date', 'Description ', 'Paid Out', 'Paid In', 'Balance'])).toBe(
      'date|description|paid out|paid in|balance',
    );
  });

  it('a HEADERLESS file keys on its shape, never on data values', () => {
    // Two exports of the same headerless bank format, a month apart: the first
    // row is data, so a value-based signature would never match again.
    const july = ['01/07/2026', 'TESCO', '-45.60', ''];
    const august = ['03/08/2026', 'BOOTS', '', '12.00'];
    expect(fileSignature(july, false)).toBe(fileSignature(august, false));
    // …and it can't be confused with a real header row of the same width.
    expect(fileSignature(july, false)).not.toBe(fileSignature(july, true));
    expect(fileSignature(['Date', 'Payee', 'Out', 'In'], true)).not.toBe(
      fileSignature(july, false),
    );
    // Column count still separates unrelated headerless layouts.
    expect(fileSignature(['01/07/2026', 'TESCO', '-45.60'], false)).not.toBe(
      fileSignature(july, false),
    );
  });

  it('defaults to header behaviour (existing callers unchanged)', () => {
    expect(fileSignature(['Date', 'Amount'])).toBe(fileSignature(['Date', 'Amount'], true));
  });
});

// -------------------------------------------------------- parseWithMapping
describe('parseWithMapping', () => {
  it('debit/credit pair: amount = credit - debit, YMD dates', () => {
    const { data } = parseCsv(fixture('generic-bank.csv'));
    const map = guessMapping(data[0], data.slice(1));
    const rows = parseWithMapping(data, map, 'GBP');
    expect(rows).toHaveLength(6);
    // Hand-calc row 1: Paid Out 45.60 ⇒ 0 - 4560 = -4560 minor.
    expect(rows[0]).toMatchObject({
      index: 1,
      date: '2026-07-01',
      amountMinor: -4560,
      payeeName: 'TESCO STORES 3297',
      currency: 'GBP',
      error: null,
    });
    // Hand-calc row 2: Paid In '2,650.00' ⇒ 265000 - 0 = +265000 minor.
    expect(rows[1].amountMinor).toBe(265000);
    // Quoted comma preserved by the CSV parser.
    expect(rows[2].payeeName).toBe('COSTA COFFEE, LEEDS');
    expect(rows[2].amountMinor).toBe(-320);
    // Refund arrives as a credit ⇒ positive.
    expect(rows[5].amountMinor).toBe(5500);
  });

  it('decimal-comma file with D.M.Y dates (whole-file detection, once)', () => {
    const { data } = parseCsv(fixture('generic-decimal-comma.csv'));
    const map = guessMapping(data[0], data.slice(1));
    expect(map.date).toBe(0);
    expect(map.payee).toBe(1);
    expect(map.amount).toBe(2);
    const rows = parseWithMapping(data, map, 'EUR');
    // Hand-calc: -45,67 ⇒ -4567; -1.234,56 ⇒ -123456; 2.500,00 ⇒ +250000; -8,90 ⇒ -890.
    expect(rows.map((r) => r.amountMinor)).toEqual([-4567, -123456, 250000, -890]);
    expect(rows.map((r) => r.date)).toEqual([
      '2026-06-03',
      '2026-06-15',
      '2026-06-20',
      '2026-06-28',
    ]);
    expect(rows.every((r) => r.error === null)).toBe(true);
  });

  it("'negate' flips single-column amounts (statements listing spend as positive)", () => {
    const data = [
      ['Date', 'Description', 'Amount'],
      ['2026-07-01', 'TESCO', '45.60'],
      ['2026-07-02', 'REFUND', '-10.00'],
    ];
    const map = { ...emptyMapping(), date: 0, payee: 1, amount: 2, negate: true };
    const rows = parseWithMapping(data, map, 'GBP');
    expect(rows[0].amountMinor).toBe(-4560);
    expect(rows[1].amountMinor).toBe(1000);
  });

  it('rows with bad dates/amounts are returned with error set (not dropped)', () => {
    const data = [
      ['Date', 'Description', 'Amount'],
      ['31/02/2026', 'BAD DATE', '10.00'],
      ['01/03/2026', 'BAD AMOUNT', 'oops'],
      ['02/03/2026', 'GOOD', '10.00'],
    ];
    const map = { ...emptyMapping(), date: 0, payee: 1, amount: 2 };
    const rows = parseWithMapping(data, map, 'GBP');
    expect(rows).toHaveLength(3);
    expect(rows[0].error).toMatch(/date/i);
    expect(rows[1].error).toMatch(/amount/i);
    expect(rows[2].error).toBeNull();
  });

  it('keeps the raw amount cell (and how it was signed) for re-derivation', () => {
    // The account — and so the real currency and minor-unit scale — is not
    // known during parsing, so the plan re-derives from this text.
    const data = [
      ['Date', 'Description', 'Paid Out', 'Paid In'],
      ['2026-07-01', 'TESCO', '45.60', ''],
      ['2026-07-02', 'SALARY', '', '2,650.00'],
      ['2026-07-03', 'ODD', '10.00', '5.00'],
    ];
    const map = { ...emptyMapping(), date: 0, payee: 1, debit: 2, credit: 3 };
    const rows = parseWithMapping(data, map, 'GBP');
    expect(rows[0]).toMatchObject({ amountText: '45.60', amountRule: 'debit', amountMinor: -4560 });
    expect(rows[1]).toMatchObject({ amountText: '2,650.00', amountRule: 'as-written' });
    // Both columns filled ⇒ the amount is a combination, so no single cell
    // can stand in for it.
    expect(rows[2].amountText).toBeNull();

    const single = parseWithMapping(
      [['Date', 'Description', 'Amount'], ['2026-07-01', 'TESCO', '45.60']],
      { ...emptyMapping(), date: 0, payee: 1, amount: 2, negate: true },
      'GBP',
    );
    expect(single[0]).toMatchObject({ amountText: '45.60', amountRule: 'flip', amountMinor: -4560 });
  });

  it('decimal-style detection follows the currency it will be read at', () => {
    // "12.345" is thousands-grouped in a 2-decimal currency but a plain amount
    // in a 3-decimal one (KWD) — the same column, two honest readings.
    expect(detectDecimalStyle(['12.345', '9.500'])).toBe('comma');
    expect(detectDecimalStyle(['12.345', '9.500'], 3)).toBe('dot');
    // A 0-decimal currency (JPY) can have no decimal separator at all, so any
    // separator it shows is grouping — and must not blow up the regex.
    expect(detectDecimalStyle(['1.000', '2.500'], 0)).toBe('comma');
    expect(detectDecimalStyle(['1,000', '2,500'], 0)).toBe('dot');
  });

  it('fixedCurrency fills rows and a currency column overrides it', () => {
    const data = [
      ['Date', 'Description', 'Amount', 'Currency'],
      ['2026-07-01', 'A', '10.00', 'EUR'],
      ['2026-07-02', 'B', '10.00', ''],
    ];
    const map = { ...emptyMapping(), date: 0, payee: 1, amount: 2, currency: 3 };
    const rows = parseWithMapping(data, map, 'GBP');
    expect(rows[0].currency).toBe('EUR');
    expect(rows[1].currency).toBe('GBP');
  });
});
