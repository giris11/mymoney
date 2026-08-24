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
import {
  detectDateFormat,
  detectDecimalStyle,
  parseCsv,
  parseDateString,
  parseImportAmount,
} from './generic';
import type { ParsedRow } from './types';

export interface MoneyWizParseResult {
  rows: ParsedRow[];
  headers: string[];
  warnings: string[];
}

type MwField =
  | 'account' | 'transfers' | 'description' | 'payee' | 'category' | 'date'
  | 'time' | 'memo' | 'amount' | 'currency' | 'check' | 'tags' | 'balance';

/** Case-insensitive header synonyms. 'time', 'check' and 'balance' are
 * recognised so they don't trigger unknown-column warnings, then ignored. */
const MW_SYNONYMS: Record<MwField, string[]> = {
  account: ['account', 'account name'],
  transfers: ['transfers', 'transfer'],
  description: ['description'],
  payee: ['payee'],
  category: ['category'],
  date: ['date'],
  time: ['time'],
  memo: ['memo', 'notes'],
  amount: ['amount'],
  currency: ['currency'],
  check: ['check #', 'check number', 'check no.', 'check no', 'cheque', 'cheque #'],
  tags: ['tags', 'tag'],
  balance: ['balance'],
};

function resolveColumns(headers: string[]): {
  cols: Record<MwField, number>;
  unknown: string[];
} {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const used = new Set<number>();
  const cols = {} as Record<MwField, number>;
  for (const field of Object.keys(MW_SYNONYMS) as MwField[]) {
    cols[field] = -1;
    for (const syn of MW_SYNONYMS[field]) {
      const i = norm.findIndex((h, idx) => !used.has(idx) && h === syn);
      if (i >= 0) {
        used.add(i);
        cols[field] = i;
        break;
      }
    }
  }
  const unknown = headers.filter((h, i) => !used.has(i) && h.trim() !== '');
  return { cols, unknown };
}

/** Case-insensitive header check — is this file a MoneyWiz export? */
export function isMoneyWizCsv(headers: string[]): boolean {
  const { cols } = resolveColumns(headers);
  return (
    cols.amount >= 0 &&
    cols.date >= 0 &&
    cols.account >= 0 &&
    (cols.payee >= 0 || cols.description >= 0 || cols.category >= 0)
  );
}

const splitTags = (v: string): string[] =>
  v ? v.split(/[;,]/).map((t) => t.trim()).filter(Boolean) : [];

export function parseMoneyWizCsv(text: string): MoneyWizParseResult {
  const { data, errors } = parseCsv(text);
  const warnings: string[] = [...errors];
  const headers = (data[0] ?? []).map((h) => h.trim());
  const { cols, unknown } = resolveColumns(headers);
  for (const u of unknown) warnings.push(`Ignoring unrecognised column “${u}”`);

  const raw = data.slice(1).filter((r) => r.some((c) => (c ?? '').trim() !== ''));
  const cell = (r: string[], i: number): string =>
    i >= 0 && i < r.length ? (r[i] ?? '').trim() : '';

  // Column-level detection, ONCE per file.
  const dateFmt = detectDateFormat(raw.map((r) => cell(r, cols.date)));
  const decimal = detectDecimalStyle(raw.map((r) => cell(r, cols.amount)));
  // ' > ' is the MoneyWiz path separator; '/' fallback ONLY when no '>' occurs
  // anywhere in the column (a file using '/' paths never contains '>').
  const columnHasGt = raw.some((r) => cell(r, cols.category).includes('>'));

  const rows: ParsedRow[] = raw.map((r, i): ParsedRow => {
    const currencyRaw = cell(r, cols.currency);
    const currency = /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : null;
    const dateRaw = cell(r, cols.date);
    const date = dateRaw ? parseDateString(dateRaw, dateFmt) : null;
    const amountRaw = cell(r, cols.amount);
    // Minor-unit scale needs a currency; rows without one use the 2-decimal
    // default (GBP) — the importer later assigns account/default currency.
    const amountMinor = amountRaw ? parseImportAmount(amountRaw, currency ?? 'GBP', decimal) : null;
    let error: string | null = null;
    if (date === null) error = `Unrecognised date “${dateRaw}”`;
    else if (amountMinor === null) error = `Unrecognised amount “${amountRaw}”`;

    const catRaw = cell(r, cols.category);
    const categoryPath = !catRaw
      ? []
      : (columnHasGt ? catRaw.split(/\s*>\s*/) : catRaw.split('/'))
          .map((p) => p.trim())
          .filter(Boolean);

    return {
      index: i + 1,
      date,
      amountMinor,
      currency,
      accountName: cell(r, cols.account) || null,
      payeeName: cell(r, cols.payee) || null,
      description: cell(r, cols.description) || null,
      categoryPath,
      tags: splitTags(cell(r, cols.tags)),
      notes: cell(r, cols.memo) || null,
      transferAccountName: cell(r, cols.transfers) || null,
      error,
    };
  });

  // Anything odd worth surfacing: mixed currencies within one account name.
  const currenciesByAccount = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.accountName || !row.currency) continue;
    const set = currenciesByAccount.get(row.accountName) ?? new Set<string>();
    set.add(row.currency);
    currenciesByAccount.set(row.accountName, set);
  }
  for (const [account, curs] of currenciesByAccount) {
    if (curs.size > 1) {
      warnings.push(
        `Account “${account}” has rows in mixed currencies (${[...curs].join(', ')})`,
      );
    }
  }
  if (cols.currency === -1) {
    warnings.push('No Currency column — amounts assume the account/base currency');
  }

  return { rows, headers, warnings };
}
