// Generic CSV import with column mapping (SPEC §7.2). CONTRACT — implemented
// by the import build agent.
import type { ColumnMapping, ParsedRow } from './types';

/** Parse CSV text into rows of cells (PapaParse under the hood). */
export function parseCsv(text: string): { data: string[][]; errors: string[] } {
  void text;
  throw new Error('not implemented');
}

/**
 * Best-guess column mapping from headers + sample rows (header-name synonyms
 * like "transaction date", "debit", "amount (GBP)", "merchant"…).
 */
export function guessMapping(headers: string[], sampleRows: string[][]): ColumnMapping {
  void headers;
  void sampleRows;
  throw new Error('not implemented');
}

export function emptyMapping(): ColumnMapping {
  return {
    date: -1, amount: -1, debit: -1, credit: -1, payee: -1, description: -1,
    category: -1, account: -1, currency: -1, tags: -1, notes: -1,
    dateFormat: 'auto', decimal: 'auto', negate: false, headerRow: true,
  };
}

/**
 * Apply a mapping to raw rows → ParsedRow[]. Handles debit/credit column
 * pairs, decimal commas, several date formats, quoted fields (already handled
 * by the CSV parse). `fixedCurrency` fills rows with no currency column.
 */
export function parseWithMapping(
  data: string[][],
  mapping: ColumnMapping,
  fixedCurrency: string,
): ParsedRow[] {
  void data;
  void mapping;
  void fixedCurrency;
  throw new Error('not implemented');
}

/** Stable signature of a header row — key for saved mappings (SPEC §7.2). */
export function fileSignature(headers: string[]): string {
  void headers;
  throw new Error('not implemented');
}

/** Column-level date-format detection, shared with the MoneyWiz parser. */
export function detectDateFormat(values: string[]): 'DMY' | 'MDY' | 'YMD' {
  void values;
  throw new Error('not implemented');
}

/** Parse one date string with a given/auto format to 'YYYY-MM-DD' or null. */
export function parseDateString(value: string, format: 'auto' | 'DMY' | 'MDY' | 'YMD'): string | null {
  void value;
  void format;
  throw new Error('not implemented');
}

/** Detect '1,234.56' vs '1.234,56' style from a column of samples. */
export function detectDecimalStyle(values: string[]): 'dot' | 'comma' {
  void values;
  throw new Error('not implemented');
}

/** Flexible import-amount parser (symbols, separators, parens) → minor units. */
export function parseImportAmount(
  value: string,
  currency: string,
  decimal: 'auto' | 'dot' | 'comma',
): number | null {
  void value;
  void currency;
  void decimal;
  throw new Error('not implemented');
}
