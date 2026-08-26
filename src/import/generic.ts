// Generic CSV import with column mapping (SPEC §7.2). CONTRACT — implemented
// by the import build agent.
//
// Semantics pinned here:
//  * All parsing is per-FILE deterministic: date format and decimal style are
//    detected ONCE over the whole column (never per-row), so one file can
//    never mix interpretations.
//  * Two-digit years: <50 ⇒ 20xx, else 19xx (so '49' → 2049, '50' → 1950) —
//    the common CSV pivot convention.
//  * Amount parsing never uses float arithmetic — the string is normalised and
//    handed to parseAmountToMinor (BigInt string maths). Amounts with more
//    precision than the currency (e.g. '12.345' GBP forced dot) come back as
//    null so the row is surfaced as an error, never silently rounded.
import Papa from 'papaparse';
import { parseAmountToMinor } from '../money/money';
import type { ColumnMapping, ParsedRow } from './types';

/** Parse CSV text into rows of cells (PapaParse under the hood). */
export function parseCsv(text: string): { data: string[][]; errors: string[] } {
  // Strip a UTF-8 BOM so the first header cell matches synonyms cleanly.
  const clean = text.replace(/^﻿/, '');
  const result = Papa.parse<string[]>(clean, {
    skipEmptyLines: 'greedy', // drops blank lines AND whitespace-only lines
    // delimiter omitted → PapaParse auto-detects (',', ';', '\t', '|', …)
  });
  const errors = result.errors
    // "UndetectableDelimiter" fires on single-column files where the default
    // comma is fine — not a row problem the user can act on.
    .filter((e) => e.code !== 'UndetectableDelimiter')
    .map((e) => (e.row !== undefined ? `Row ${e.row + 1}: ${e.message}` : e.message));
  return { data: result.data, errors };
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/** Explicit month-name table — dayjs's name parsing is locale-fragile. */
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
};

const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const daysInMonth = (year: number, month: number): number =>
  [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/** Validate + format; 2-digit years pivot at 50 (<50 ⇒ 20xx, else 19xx). */
function buildDate(yearRaw: string, month: number | undefined, dayRaw: string): string | null {
  if (!month || month < 1 || month > 12) return null;
  if (!/^\d+$/.test(yearRaw) || !/^\d+$/.test(dayRaw)) return null;
  let year = Number(yearRaw);
  if (yearRaw.length <= 2) year = year < 50 ? 2000 + year : 1900 + year;
  else if (yearRaw.length === 3) return null;
  const day = Number(dayRaw);
  if (day < 1 || day > daysInMonth(year, month)) return null; // rejects 31/02, etc.
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Column-level date-format detection, shared with the MoneyWiz parser. */
export function detectDateFormat(values: string[]): 'DMY' | 'MDY' | 'YMD' {
  const numeric: number[][] = [];
  for (const raw of values) {
    const first = (raw ?? '').trim().split(/\s+/)[0] ?? '';
    const segs = first.split(/[/.\-]/);
    if (segs.length !== 3 || !segs.every((s) => /^\d{1,4}$/.test(s))) continue;
    if (segs[0].length === 4) return 'YMD'; // 4-digit lead in ANY value ⇒ YMD
    numeric.push(segs.map(Number));
  }
  if (numeric.some((p) => p[0] > 12)) return 'DMY'; // day in first position
  if (numeric.some((p) => p[1] > 12)) return 'MDY'; // day in second position
  return 'DMY'; // ambiguous ⇒ en-GB default (D20)
}

/** Parse one date string with a given/auto format to 'YYYY-MM-DD' or null. */
export function parseDateString(
  value: string,
  format: 'auto' | 'DMY' | 'MDY' | 'YMD',
): string | null {
  const v = (value ?? '').trim();
  if (!v) return null;
  // Month-name forms: 'DD MMM YYYY' and 'MMM DD, YYYY' (2- or 4-digit year).
  let m = v.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{2}|\d{4})$/);
  if (m) return buildDate(m[3], MONTH_NAMES[m[2].toLowerCase()], m[1]);
  m = v.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/);
  if (m) return buildDate(m[3], MONTH_NAMES[m[1].toLowerCase()], m[2]);
  // Numeric forms — drop a trailing time component ('25/06/2026 14:30').
  const first = v.split(/\s+/)[0];
  const segs = first.split(/[/.\-]/);
  if (segs.length !== 3 || !segs.every((s) => /^\d{1,4}$/.test(s))) return null;
  let fmt: 'DMY' | 'MDY' | 'YMD';
  if (format === 'auto') {
    if (segs[0].length === 4) fmt = 'YMD';
    else if (Number(segs[0]) > 12) fmt = 'DMY';
    else if (Number(segs[1]) > 12) fmt = 'MDY';
    else fmt = 'DMY'; // ambiguous ⇒ en-GB default
  } else {
    fmt = format;
  }
  const [a, b, c] = segs;
  if (fmt === 'YMD') return buildDate(a, Number(b), c);
  if (fmt === 'DMY') return buildDate(c, Number(b), a);
  return buildDate(c, Number(a), b); // MDY
}

// ---------------------------------------------------------------------------
// Amount parsing
// ---------------------------------------------------------------------------

const countOf = (s: string, ch: string): number => s.split(ch).length - 1;

/**
 * Detect '1,234.56' vs '1.234,56' style from a column of samples.
 *
 * `decimals` is how many decimal places the target currency actually has,
 * because that decides what a trailing group can be: "12.345" is thousands-
 * grouped in a 2-decimal currency but a plain amount in a 3-decimal one (KWD),
 * and a 0-decimal currency (JPY) can have no decimal separator at all — every
 * separator it shows is grouping.
 */
export function detectDecimalStyle(values: string[], decimals = 2): 'dot' | 'comma' {
  let comma = 0;
  let dot = 0;
  const isDecimalTail = (s: string, sep: '.' | ','): boolean =>
    decimals > 0 &&
    countOf(s, sep) === 1 &&
    new RegExp(`\\d\\${sep}\\d{1,${decimals}}$`).test(s);
  for (const raw of values) {
    const s = (raw ?? '').replace(/[^\d.,]/g, '');
    if (!s) continue;
    const hasC = s.includes(',');
    const hasD = s.includes('.');
    if (hasC && hasD) {
      // Both separators in one value: the LAST one is the decimal.
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) comma++;
      else dot++;
    } else if (hasC) {
      // ',' + 1–2 trailing digits ⇒ decimal comma ('45,67'); ',' + 3 digits or
      // repeated commas ⇒ thousands grouping ('1,234', '1,234,567') ⇒ dot.
      if (isDecimalTail(s, ',')) comma++;
      else dot++;
    } else if (hasD) {
      if (isDecimalTail(s, '.')) dot++;
      else comma++; // dot-thousands like '1.234' ⇒ comma-style file
    }
  }
  return comma > dot ? 'comma' : 'dot'; // default 'dot'
}

/** Flexible import-amount parser (symbols, separators, parens) → minor units. */
export function parseImportAmount(
  value: string,
  currency: string,
  decimal: 'auto' | 'dot' | 'comma',
): number | null {
  let s = (value ?? '').trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true; // parentheses = negative ('(45.00)')
    s = s.slice(1, -1);
  }
  // Strip currency symbols, letter codes ('GBP'), and all whitespace/NBSP.
  s = s.replace(/[^\d.,+-]/g, '');
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  if (!s || /[+-]/.test(s)) return null; // stray signs inside the number
  let style: 'dot' | 'comma';
  if (decimal !== 'auto') {
    style = decimal; // forced style: the separator IS the decimal
  } else {
    const hasC = s.includes(',');
    const hasD = s.includes('.');
    if (hasC && hasD) {
      // Both present: the LAST separator is the decimal.
      style = s.lastIndexOf(',') > s.lastIndexOf('.') ? 'comma' : 'dot';
    } else if (hasC) {
      // A single separator with exactly 3 trailing digits (and no other
      // separator) is a THOUSANDS separator: '1,234' ⇒ 1234.
      style = countOf(s, ',') === 1 && /,\d{1,2}$/.test(s) ? 'comma' : 'dot';
    } else if (hasD) {
      style = countOf(s, '.') === 1 && /\.\d{1,2}$/.test(s) ? 'dot' : 'comma';
    } else {
      style = 'dot';
    }
  }
  // parseAmountToMinor is BigInt string maths; it returns null for amounts
  // with more precision than the currency — exactly the "reject as row error"
  // behaviour imports need (never round someone's money silently).
  const minor = parseAmountToMinor(s, currency, style);
  if (minor === null) return null;
  return negative && minor !== 0 ? -minor : minor;
}

// ---------------------------------------------------------------------------
// Column-mapping guess
// ---------------------------------------------------------------------------

export function emptyMapping(): ColumnMapping {
  return {
    date: -1, amount: -1, debit: -1, credit: -1, payee: -1, description: -1,
    category: -1, account: -1, currency: -1, tags: -1, notes: -1,
    dateFormat: 'auto', decimal: 'auto', negate: false, headerRow: true,
  };
}

/** Does a cell look like data (a date or an amount) rather than a header? */
function looksLikeDataCell(cell: string): boolean {
  const t = (cell ?? '').trim();
  if (!t) return false;
  if (parseDateString(t, 'auto') !== null) return true;
  return parseImportAmount(t, 'GBP', 'auto') !== null;
}

/**
 * Best-guess column mapping from headers + sample rows (header-name synonyms
 * like "transaction date", "debit", "amount (GBP)", "merchant"…).
 *
 * 'description' counts as a payee synonym only when no separate description
 * column ends up chosen: payee matching runs first, so a lone Description
 * column becomes the payee (the primary label), while Payee+Description files
 * map each to its own slot.
 */
export function guessMapping(headers: string[], sampleRows: string[][]): ColumnMapping {
  const map = emptyMapping();
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const used = new Set<number>();
  const pick = (syns: string[]): number => {
    for (const syn of syns) {
      const i = norm.findIndex((h, idx) => !used.has(idx) && h === syn);
      if (i >= 0) {
        used.add(i);
        return i;
      }
    }
    return -1;
  };

  map.account = pick(['account', 'account name']);
  map.date = pick([
    'date', 'transaction date', 'posted', 'posting date', 'booking date',
    'date posted', 'value date',
  ]);
  map.debit = pick(['debit', 'paid out', 'money out', 'withdrawal', 'withdrawals', 'debit amount', 'out']);
  map.credit = pick(['credit', 'paid in', 'money in', 'deposit', 'deposits', 'credit amount', 'in']);
  map.amount = pick(['amount', 'value', 'transaction amount', 'amount (gbp)', 'net amount']);
  if (map.amount === -1) {
    // 'Amount (EUR)', 'Amount GBP', … — any unused header starting with 'amount'
    const i = norm.findIndex((h, idx) => !used.has(idx) && h.startsWith('amount'));
    if (i >= 0) {
      used.add(i);
      map.amount = i;
    }
  }
  map.payee = pick(['payee', 'payee name', 'merchant', 'name', 'description']);
  map.description = pick(['description', 'details', 'narrative', 'reference', 'transaction description', 'memo']);
  map.category = pick(['category']);
  map.currency = pick(['currency', 'currency code', 'ccy']);
  map.tags = pick(['tags', 'tag']);
  map.notes = pick(['notes', 'note', 'memo']);
  if (map.date === -1) {
    const i = norm.findIndex((h, idx) => !used.has(idx) && /\bdate\b/.test(h));
    if (i >= 0) {
      used.add(i);
      map.date = i;
    }
  }

  // Header row when the first row looks like headers: non-empty, and no cell
  // parses as a date or an amount.
  map.headerRow = norm.some((h) => h !== '') && !headers.some(looksLikeDataCell);

  if (!map.headerRow) {
    // The "headers" are really data — guess by column content instead.
    const rows = [headers, ...sampleRows];
    const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const dateHits: number[] = [];
    const amountHits: number[] = [];
    const nonEmpty: number[] = [];
    for (let c = 0; c < colCount; c++) {
      let d = 0, a = 0, n = 0;
      for (const r of rows) {
        const cell = (r[c] ?? '').trim();
        if (!cell) continue;
        n++;
        if (parseDateString(cell, 'auto') !== null) d++;
        else if (parseImportAmount(cell, 'GBP', 'auto') !== null) a++;
      }
      dateHits.push(d);
      amountHits.push(a);
      nonEmpty.push(n);
    }
    const good = (hits: number[], c: number) => nonEmpty[c] > 0 && hits[c] >= Math.ceil(nonEmpty[c] / 2);
    map.date = dateHits.findIndex((_, c) => good(dateHits, c));
    map.amount = amountHits.findIndex((_, c) => c !== map.date && good(amountHits, c));
    for (let c = 0; c < colCount; c++) {
      if (c !== map.date && c !== map.amount && nonEmpty[c] > 0 && amountHits[c] < nonEmpty[c]) {
        map.payee = c;
        break;
      }
    }
  }
  return map;
}

/**
 * Stable signature of a file — key for saved mappings (SPEC §7.2).
 *
 * With a header row the headers ARE the signature. A headerless export has no
 * such key: `headers` is then the first DATA row, and keying on it would mint
 * a new signature every month (different dates, payees, amounts), so a saved
 * mapping could never be reused. Fall back to the column count — the one
 * property of a bank's headerless layout that doesn't vary row to row.
 * Per-column "shape" (date-ish/amount-ish) is deliberately NOT used: a debit/
 * credit file leaves one of the two cells empty on any given row, so the shape
 * flips between exports of the same file format.
 */
export function fileSignature(headers: string[], headerRow = true): string {
  if (!headerRow) return `nohdr:${headers.length}`;
  return headers.map((h) => h.trim().toLowerCase()).join('|');
}

// ---------------------------------------------------------------------------
// Applying a mapping
// ---------------------------------------------------------------------------

/** Category cell → path: split on '>' when present, else a single segment. */
function splitGenericCategory(v: string): string[] {
  if (!v) return [];
  const parts = v.includes('>') ? v.split(/\s*>\s*/) : [v];
  return parts.map((p) => p.trim()).filter(Boolean);
}

const splitTags = (v: string): string[] =>
  v ? v.split(/[;,]/).map((t) => t.trim()).filter(Boolean) : [];

/**
 * Apply a mapping to raw rows → ParsedRow[]. Handles debit/credit column
 * pairs, decimal commas, several date formats, quoted fields (already handled
 * by the CSV parse). `fixedCurrency` fills rows with no currency column.
 *
 * Rows with an unparseable date or amount are still returned, with `error`
 * set, so the preview can show an error count (SPEC §7.4).
 */
export function parseWithMapping(
  data: string[][],
  mapping: ColumnMapping,
  fixedCurrency: string,
): ParsedRow[] {
  const rows = (mapping.headerRow ? data.slice(1) : data).filter((r) =>
    r.some((c) => (c ?? '').trim() !== ''),
  );
  const cell = (r: string[], i: number): string =>
    i >= 0 && i < r.length ? (r[i] ?? '').trim() : '';

  // Detect formats ONCE for the whole file (per-column, never per-row).
  let dateFmt: 'DMY' | 'MDY' | 'YMD' =
    mapping.dateFormat === 'auto'
      ? detectDateFormat(rows.map((r) => cell(r, mapping.date)))
      : mapping.dateFormat;
  const amountSamples = rows.flatMap((r) =>
    [cell(r, mapping.amount), cell(r, mapping.debit), cell(r, mapping.credit)].filter(Boolean),
  );
  const decimal: 'dot' | 'comma' =
    mapping.decimal === 'auto' ? detectDecimalStyle(amountSamples) : mapping.decimal;

  return rows.map((r, i): ParsedRow => {
    let error: string | null = null;
    const currencyRaw = cell(r, mapping.currency);
    const currency = /^[A-Za-z]{3}$/.test(currencyRaw)
      ? currencyRaw.toUpperCase()
      : fixedCurrency || null;
    const minorCurrency = currency ?? 'GBP';

    const dateRaw = cell(r, mapping.date);
    const date = mapping.date >= 0 ? parseDateString(dateRaw, dateFmt) : null;
    if (date === null) error = mapping.date >= 0 ? `Unrecognised date “${dateRaw}”` : 'No date column mapped';

    let amountMinor: number | null = null;
    // The raw cell + how it was signed, so buildImportPlan can re-derive the
    // amount at the account's real currency (minorCurrency is a guess here —
    // the account isn't known during parsing).
    let amountText: string | null = null;
    let amountRule: ParsedRow['amountRule'] = 'as-written';
    if (mapping.debit >= 0 || mapping.credit >= 0) {
      const debitRaw = cell(r, mapping.debit);
      const creditRaw = cell(r, mapping.credit);
      // Only a single cell can be re-derived later; when BOTH are filled the
      // amount is a combination of two cells, so leave amountText null.
      if (debitRaw && !creditRaw) {
        amountText = debitRaw;
        amountRule = 'debit';
      } else if (creditRaw && !debitRaw) {
        amountText = creditRaw;
      }
      const debit = debitRaw ? parseImportAmount(debitRaw, minorCurrency, decimal) : 0;
      const credit = creditRaw ? parseImportAmount(creditRaw, minorCurrency, decimal) : 0;
      if (debit === null || credit === null) {
        error ??= `Unrecognised amount “${debit === null ? debitRaw : creditRaw}”`;
      } else if (!debitRaw && !creditRaw) {
        error ??= 'No amount';
      } else {
        amountMinor = credit - Math.abs(debit); // debit stored negative
      }
    } else if (mapping.amount >= 0) {
      const amountRaw = cell(r, mapping.amount);
      amountText = amountRaw || null;
      amountRule = mapping.negate ? 'flip' : 'as-written';
      const parsed = amountRaw ? parseImportAmount(amountRaw, minorCurrency, decimal) : null;
      if (parsed === null) error ??= `Unrecognised amount “${amountRaw}”`;
      else amountMinor = mapping.negate ? -parsed : parsed; // negate: single-column only
    } else {
      error ??= 'No amount column mapped';
    }

    return {
      index: i + 1,
      date,
      amountMinor,
      currency,
      accountName: cell(r, mapping.account) || null,
      payeeName: cell(r, mapping.payee) || null,
      description: cell(r, mapping.description) || null,
      categoryPath: splitGenericCategory(cell(r, mapping.category)),
      tags: splitTags(cell(r, mapping.tags)),
      notes: cell(r, mapping.notes) || null,
      transferAccountName: null, // generic CSVs have no transfers column
      amountText,
      amountRule,
      error,
    };
  });
}
