// MoneyWiz CSV parsing (SPEC §7.1, D20). CONTRACT — implemented by the import
// build agent.
//
//  * Detection is header-synonym based, not positional: a file is MoneyWiz-ish
//    when it has an Amount column, a Date column, an Account column and at
//    least one of Payee/Description/Category (case-insensitive).
//  * Category paths split on ' > ' (fallback '/' only when no '>' appears
//    anywhere in the column); tags split on ';' or ','.
//  * Amounts tolerate currency symbols, thousands separators, parentheses
//    negatives, and decimal commas (auto-detected per file).
//  * Date format auto-detected by scanning the WHOLE column (any first
//    component >12 ⇒ DMY, any middle >12 ⇒ MDY, 4-digit lead ⇒ YMD; ambiguous
//    ⇒ DMY per en-GB).
//  * Rows whose Transfers column names another account are transfer legs;
//    the importer pairs them by (date, ±amount, account↔account).
import type { ParsedRow } from './types';

export interface MoneyWizParseResult {
  rows: ParsedRow[];
  headers: string[];
  warnings: string[];
}

/** Case-insensitive header check — is this file a MoneyWiz export? */
export function isMoneyWizCsv(headers: string[]): boolean {
  void headers;
  throw new Error('not implemented');
}

export function parseMoneyWizCsv(text: string): MoneyWizParseResult {
  void text;
  throw new Error('not implemented');
}
