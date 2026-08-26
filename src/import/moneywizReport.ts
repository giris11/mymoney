// MoneyWiz *Report* CSV parsing (SPEC §7.1) — the layout MoneyWiz's "Report"
// export produces, which is structurally different from the flat transaction
// export handled by `moneywiz.ts`:
//
//   Name,Current balance,Account,Transfers,Description,Payee,Category,Date,
//   Memo,Amount,Currency,Cheque N°,Tags,Balance
//
//  * The file is a sequence of GROUPS. Each group starts with an ACCOUNT
//    HEADER row — "Name" non-empty — carrying the account's name, its final
//    balance in "Current balance", and (the trap) its CURRENCY in the
//    "Account" column. Every other cell on that row is empty.
//  * The rows that follow are TRANSACTION rows with an empty "Name", where the
//    "Account" column holds the ACCOUNT NAME instead. Grouping is not relied
//    on: a transaction row is attributed by its own Account cell, so a
//    re-sorted or filtered export still reads correctly.
//  * An Excel `sep=,` hint line precedes the header row; `parseCsv` drops it.
//
// DETECTION PRECEDENCE — READ THIS. `isMoneyWizCsv` (the flat parser) ALSO
// returns true for these headers: they contain Account, Date, Amount and
// Payee, which is all it asks for. Nothing in that function can tell the two
// apart, and it is not this cluster's file to change. So every caller MUST
// test `isMoneyWizReportCsv(headers)` FIRST and only fall through to
// `isMoneyWizCsv` when it is false. `tests/import-moneywiz-report.test.ts`
// pins that overlap so the requirement cannot quietly rot. Reading a Report
// file with the flat parser is not a cosmetic failure: every account header
// row becomes a transaction with no date, the "Account" column reads GBP/TRY
// as an account NAME, and no opening balance is ever derived.
//
// BALANCES — the point of this parser. For every account:
//     openingBalanceMinor = currentBalanceMinor − Σ(that account's amounts)
// which is ORDER-INDEPENDENT, and therefore immune to the one thing the
// export gets wrong: its running "Balance" column disagrees with row order
// among same-date rows. That column is never used to derive anything.
import { nameKey } from '../lib/util';
import {
  detectDateFormat,
  detectDecimalStyle,
  parseCsv,
  parseDateString,
  parseImportAmount,
} from './generic';
import type { ParsedRow } from './types';

/** One account as the file's header rows describe it. */
export interface ReportAccount {
  name: string;
  /** ISO code from the header row's "Account" cell, or '' when unreadable. */
  currency: string;
  /** The file's stated final balance, in minor units; null = unreadable. */
  currentBalanceMinor: number | null;
  /**
   * currentBalanceMinor − Σ(amounts). **null when it cannot be trusted** —
   * an unreadable current balance, or any row of this account that will not
   * import (bad amount or bad date). A guessed opening balance silently
   * poisons every balance, budget and report for that account for ever, so a
   * partial answer is refused and named in `warnings` instead.
   */
  openingBalanceMinor: number | null;
}

export interface MoneyWizReportResult {
  rows: ParsedRow[];
  accounts: ReportAccount[];
  warnings: string[];
  /** What auto-detection made of the Date column, reported even when the
   *  caller forced a format, so the UI can show what it would have picked. */
  detectedDateFormat: 'DMY' | 'MDY' | 'YMD';
}

type RpField =
  | 'name' | 'currentBalance' | 'account' | 'transfers' | 'description'
  | 'payee' | 'category' | 'date' | 'time' | 'memo' | 'amount' | 'currency'
  | 'cheque' | 'tags' | 'balance';

/** Case-insensitive header synonyms. 'time', 'cheque' and 'balance' are
 *  recognised so they don't trigger unknown-column warnings, then ignored. */
const RP_SYNONYMS: Record<RpField, string[]> = {
  name: ['name'],
  currentBalance: ['current balance', 'currentbalance'],
  account: ['account', 'account name'],
  transfers: ['transfers', 'transfer'],
  description: ['description'],
  payee: ['payee'],
  category: ['category'],
  date: ['date'],
  time: ['time'],
  memo: ['memo', 'notes', 'note'],
  amount: ['amount'],
  currency: ['currency'],
  cheque: [
    'cheque n°', 'cheque no', 'cheque no.', 'cheque #', 'cheque number', 'cheque',
    'check n°', 'check no', 'check no.', 'check #', 'check number',
  ],
  tags: ['tags', 'tag'],
  balance: ['balance'],
};

function resolveColumns(headers: string[]): {
  cols: Record<RpField, number>;
  unknown: string[];
} {
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const used = new Set<number>();
  const cols = {} as Record<RpField, number>;
  // 'currentBalance' is resolved before 'balance' so a "Current balance"
  // header can never be consumed by the plain "Balance" slot.
  for (const field of Object.keys(RP_SYNONYMS) as RpField[]) {
    cols[field] = -1;
    for (const syn of RP_SYNONYMS[field]) {
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

/**
 * Is this the MoneyWiz *Report* layout?
 *
 * Deliberately stricter than `isMoneyWizCsv`: it demands the two columns that
 * only this layout has — "Name" (the account header column) and "Current
 * balance" — alongside Account/Date/Amount. A flat MoneyWiz export has neither,
 * so this can never steal a file the flat parser handles. The reverse is NOT
 * true; see the precedence note at the top of this file.
 */
export function isMoneyWizReportCsv(headers: string[]): boolean {
  const { cols } = resolveColumns(headers);
  return (
    cols.name >= 0 &&
    cols.currentBalance >= 0 &&
    cols.account >= 0 &&
    cols.date >= 0 &&
    cols.amount >= 0
  );
}

/**
 * Tags: ';' when the cell contains one, else ','. Same rule as the flat
 * parser — a comma inside a semicolon-separated cell is part of the tag name.
 */
const splitTags = (v: string): string[] =>
  v ? v.split(v.includes(';') ? ';' : ',').map((t) => t.trim()).filter(Boolean) : [];

/** '►' is what MoneyWiz's Report export uses; '>' is the flat export's.
 *  One character class, two uses: does the column use paths at all, and
 *  where do its levels break. */
const PATH_SEP = /[>►]/;
const PATH_SPLIT = /\s*[>►]\s*/;

/** At most `max` names, then "and N more" — a warning about a file with
 *  dozens of accounts has to stay readable. */
function nameList(names: string[], max = 5): string {
  const quoted = names.slice(0, max).map((n) => `“${n}”`);
  const rest = names.length - quoted.length;
  return rest > 0 ? `${quoted.join(', ')} and ${rest} more` : quoted.join(', ');
}

interface AccountBuild {
  name: string;
  currency: string;
  balanceText: string;
  sumMinor: number;
  /** Rows of this account that will NOT import (bad date or bad amount). */
  unusableRows: number;
  txRows: number;
  /** Distinct currencies this account's rows declare (for the mixed warning). */
  declaredCurrencies: Set<string>;
}

/**
 * `dateFormat` overrides the auto-detection, exactly as the flat parser's does
 * (D20): an all-ambiguous column cannot be told apart from a US MM/DD export,
 * so the caller must be able to correct it.
 */
export function parseMoneyWizReportCsv(
  text: string,
  dateFormat: 'auto' | 'DMY' | 'MDY' | 'YMD' = 'auto',
): MoneyWizReportResult {
  const { data, errors } = parseCsv(text);
  const warnings: string[] = [...errors];
  const headers = (data[0] ?? []).map((h) => h.trim());
  const { cols, unknown } = resolveColumns(headers);
  for (const u of unknown) warnings.push(`Ignoring unrecognised column “${u}”`);

  const cell = (r: string[], i: number): string =>
    i >= 0 && i < r.length ? (r[i] ?? '').trim() : '';
  const raw = data.slice(1).filter((r) => r.some((c) => (c ?? '').trim() !== ''));
  // An account header row is the one with a non-empty "Name"; everything else
  // is a transaction. `index` counts every data row so it still points at a
  // line of the file the user can find.
  const isAccountHeader = (r: string[]): boolean => cell(r, cols.name) !== '';
  const txRaw = raw
    .map((r, i) => ({ r, index: i + 1 }))
    .filter(({ r }) => !isAccountHeader(r));

  // ---- account header rows ------------------------------------------------
  const accounts = new Map<string, AccountBuild>();
  const duplicateNames: string[] = [];
  for (const r of raw) {
    if (!isAccountHeader(r)) continue;
    const name = cell(r, cols.name);
    const key = nameKey(name);
    if (accounts.has(key)) {
      duplicateNames.push(name);
      continue; // first header wins; its balance is the one we reconcile to
    }
    const currencyRaw = cell(r, cols.account);
    accounts.set(key, {
      name,
      // The "Account" column on a header row is the account's CURRENCY.
      currency: /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : '',
      balanceText: cell(r, cols.currentBalance),
      sumMinor: 0, // the balance itself is parsed later, once the currency is settled
      unusableRows: 0,
      txRows: 0,
      declaredCurrencies: new Set<string>(),
    });
  }
  if (duplicateNames.length > 0) {
    warnings.push(
      `${duplicateNames.length} account ${duplicateNames.length === 1 ? 'row is' : 'rows are'} ` +
        `repeated in this file (${nameList([...new Set(duplicateNames)])}); the first balance is used.`,
    );
  }

  // A header row with an unreadable currency falls back to what its own
  // transactions declare, so the minor-unit scale is still right.
  for (const { r } of txRaw) {
    const acc = accounts.get(nameKey(cell(r, cols.account)));
    if (!acc || acc.currency) continue;
    const c = cell(r, cols.currency);
    if (/^[A-Za-z]{3}$/.test(c)) acc.currency = c.toUpperCase();
  }

  // ---- per-FILE detection (never per row) ---------------------------------
  const detectedDateFormat = detectDateFormat(txRaw.map(({ r }) => cell(r, cols.date)));
  const dateFmt = dateFormat === 'auto' ? detectedDateFormat : dateFormat;
  // Both money columns feed the decimal-style vote: the balances are written
  // in the same style as the amounts, and they add one more sample per account
  // — which matters for an export whose amounts are all small and unseparated.
  const decimal = detectDecimalStyle([
    ...txRaw.map(({ r }) => cell(r, cols.amount)),
    ...[...accounts.values()].map((a) => a.balanceText),
  ]);
  // Category paths: ' > ' and ' ► ' are both MoneyWiz path separators (the
  // Report export uses '►'), and '/' stays the D20 fallback — used ONLY when
  // neither separator appears anywhere in the column, since a file that uses
  // one of them never means '/' as a level break.
  //
  // This is not cosmetic. Applying the flat parser's rule ("no '>' anywhere ⇒
  // split on '/'") to a '►' file cuts every path at the wrong character: a
  // leaf whose NAME contains a slash mints a top-level category called
  // "Parent ► Child" with an invented child of its own, and every transaction
  // under it is filed there.
  const columnHasPathSep = txRaw.some(({ r }) => PATH_SEP.test(cell(r, cols.category)));
  /** Distinct category cells the '/' fallback turned into multi-level paths. */
  const slashPaths = new Set<string>();

  // ---- transaction rows ---------------------------------------------------
  const unknownAccounts = new Set<string>();
  let badDates = 0;
  let badAmounts = 0;

  const rows: ParsedRow[] = txRaw.map(({ r, index }): ParsedRow => {
    const accountName = cell(r, cols.account) || null;
    const acc = accountName ? accounts.get(nameKey(accountName)) : undefined;
    if (accountName && !acc) unknownAccounts.add(accountName);

    const currencyRaw = cell(r, cols.currency);
    const currency = /^[A-Za-z]{3}$/.test(currencyRaw) ? currencyRaw.toUpperCase() : null;
    const dateRaw = cell(r, cols.date);
    const date = dateRaw ? parseDateString(dateRaw, dateFmt) : null;
    const amountRaw = cell(r, cols.amount);
    // Scale at the ACCOUNT's currency first: this layout states it outright,
    // and a transaction is always denominated in its account's currency
    // (SPEC §6). The row's own Currency column is the fallback, then GBP's 2
    // decimals — and `buildImportPlan` re-derives from `amountText` anyway
    // once the real account is known, which is a no-op when they agree.
    const scaleCurrency = acc?.currency || currency || 'GBP';
    const amountMinor = amountRaw ? parseImportAmount(amountRaw, scaleCurrency, decimal) : null;

    let error: string | null = null;
    if (date === null) {
      error = `Unrecognised date “${dateRaw}”`;
      badDates++;
    } else if (amountMinor === null) {
      error = `Unrecognised amount “${amountRaw}”`;
      badAmounts++;
    }

    if (acc) {
      acc.txRows++;
      if (currency) acc.declaredCurrencies.add(currency);
      if (error !== null) acc.unusableRows++;
      else acc.sumMinor += amountMinor!;
    }

    const catRaw = cell(r, cols.category);
    const categoryPath = !catRaw
      ? []
      : (columnHasPathSep ? catRaw.split(PATH_SPLIT) : catRaw.split('/'))
          .map((p) => p.trim())
          .filter(Boolean);
    if (!columnHasPathSep && categoryPath.length > 1) slashPaths.add(catRaw);

    return {
      index,
      date,
      amountMinor,
      currency,
      accountName,
      payeeName: cell(r, cols.payee) || null,
      description: cell(r, cols.description) || null,
      categoryPath,
      tags: splitTags(cell(r, cols.tags)),
      notes: cell(r, cols.memo) || null,
      transferAccountName: cell(r, cols.transfers) || null,
      amountText: amountRaw || null,
      amountRule: 'as-written',
      error,
    };
  });

  // ---- balances -----------------------------------------------------------
  const unreadableBalances: string[] = [];
  const unknownCurrency: string[] = [];
  const poisoned: string[] = [];
  const balanceOnly: string[] = [];
  const out: ReportAccount[] = [...accounts.values()].map((a) => {
    const currentBalanceMinor = a.balanceText
      ? parseImportAmount(a.balanceText, a.currency || 'GBP', decimal)
      : null;
    let openingBalanceMinor: number | null = null;
    if (currentBalanceMinor === null) {
      unreadableBalances.push(a.name);
    } else if (!a.currency) {
      // No currency ⇒ no minor-unit SCALE, and the figures above were read at
      // the 2-decimal fallback. If the account then lands in a 0- or
      // 3-decimal currency, an opening balance carried over from here is out
      // by a factor of 100 or 1000 — invisibly. Refuse it.
      unknownCurrency.push(a.name);
    } else if (a.unusableRows > 0) {
      // Every row that fails to import moves the account's balance by its own
      // amount, so `balance − Σ(the rows that DID parse)` is not this
      // account's opening balance — it is that number plus the missing rows.
      poisoned.push(a.name);
    } else {
      const opening = currentBalanceMinor - a.sumMinor;
      openingBalanceMinor = Number.isSafeInteger(opening) ? opening : null;
    }
    if (a.txRows === 0) balanceOnly.push(a.name);
    return {
      name: a.name,
      currency: a.currency,
      currentBalanceMinor,
      openingBalanceMinor,
    };
  });

  // ---- warnings -----------------------------------------------------------
  if (unreadableBalances.length > 0) {
    warnings.push(
      `${unreadableBalances.length} ${unreadableBalances.length === 1 ? 'account has' : 'accounts have'} ` +
        `an unreadable “Current balance” (${nameList(unreadableBalances)}); ` +
        'they will be created with a zero opening balance, so their totals will not match the file.',
    );
  }
  if (unknownCurrency.length > 0) {
    warnings.push(
      `No currency could be read for ${nameList(unknownCurrency)} — the account row should ` +
        'carry an ISO code (GBP, TRY…) in its “Account” column. ' +
        `${unknownCurrency.length === 1 ? 'It is' : 'They are'} imported without an opening ` +
        'balance, because a balance read at the wrong number of decimals is out by a factor of 100.',
    );
  }
  if (poisoned.length > 0) {
    warnings.push(
      `No opening balance could be derived for ${nameList(poisoned)} — ` +
        `${poisoned.length === 1 ? 'it has' : 'they have'} rows that cannot be imported, ` +
        'and guessing from the rest would leave every balance and report for ' +
        `${poisoned.length === 1 ? 'that account' : 'those accounts'} quietly wrong. ` +
        'Fix the rows flagged below and re-import.',
    );
  }
  if (unknownAccounts.size > 0) {
    warnings.push(
      `${unknownAccounts.size} account ${unknownAccounts.size === 1 ? 'name is' : 'names are'} ` +
        `used by transactions but never declared by an account row (${nameList([...unknownAccounts])}); ` +
        'those transactions import, but with no opening balance.',
    );
  }
  if (badDates > 0) {
    warnings.push(
      `${badDates} row${badDates === 1 ? '' : 's'} have an unreadable date and cannot be imported.`,
    );
  }
  if (badAmounts > 0) {
    warnings.push(
      `${badAmounts} row${badAmounts === 1 ? '' : 's'} have an unreadable amount and cannot be imported.`,
    );
  }
  if (balanceOnly.length > 0) {
    warnings.push(
      `${balanceOnly.length} account${balanceOnly.length === 1 ? '' : 's'} ` +
        `have a balance but no transactions in this file (${nameList(balanceOnly)}).`,
    );
  }
  // Mixed currencies inside one account — the same check the flat parser
  // makes, measured against the header row's own declaration. Collected during
  // the row pass rather than re-scanned per account: 200 accounts × 20k rows
  // is four million name comparisons for a warning nobody usually sees.
  for (const a of accounts.values()) {
    if (!a.currency) continue;
    const declared = new Set(a.declaredCurrencies);
    declared.delete(a.currency);
    if (declared.size > 0) {
      warnings.push(
        `Account “${a.name}” is ${a.currency} but has rows in ${[...declared].join(', ')}; ` +
          'those amounts are imported as stated, in the account\'s currency, never converted.',
      );
    }
  }
  if (cols.currency === -1) {
    warnings.push('No Currency column — amounts assume the account currency');
  }
  if (slashPaths.size > 0) {
    const [example] = slashPaths;
    warnings.push(
      `${slashPaths.size} category ${slashPaths.size === 1 ? 'path was' : 'paths were'} split on ` +
        `“/” because the file contains no “>” or “►” — “${example}” becomes ` +
        `“${example.split('/').map((p) => p.trim()).filter(Boolean).join(' › ')}”. ` +
        'Rename them after importing if they should stay one category.',
    );
  }

  return { rows, accounts: out, warnings, detectedDateFormat };
}

/**
 * The plan options a Report import must pass to `buildImportPlan` for the
 * balances to survive: opening balances for the accounts it creates, and the
 * currencies that let an account the file declares but no row uses still be
 * created (three of those in the owner's own export carry real money — they
 * would otherwise vanish from net worth without a word).
 *
 * Spread it into the options object; passing the two maps separately is the
 * same thing, this exists so the two halves cannot be half-wired:
 *
 *   const r = parseMoneyWizReportCsv(text);
 *   const plan = await buildImportPlan(r.rows, {
 *     source: 'moneywiz', fileName, defaultCurrency, ...reportPlanOptions(r.accounts),
 *   });
 */
export function reportPlanOptions(accounts: ReportAccount[]): {
  accountOpeningBalances: Map<string, number>;
  accountCurrencies: Map<string, string>;
} {
  const accountOpeningBalances = new Map<string, number>();
  const accountCurrencies = new Map<string, string>();
  for (const a of accounts) {
    // The two travel together on purpose: an opening balance is a number of
    // minor units, which only means something at the scale it was read at.
    // The parser already refuses one for a currency-less account; this keeps
    // that invariant true even if someone hands us a hand-built list.
    if (!a.currency) continue;
    accountCurrencies.set(a.name, a.currency);
    if (a.openingBalanceMinor !== null) accountOpeningBalances.set(a.name, a.openingBalanceMinor);
  }
  return { accountOpeningBalances, accountCurrencies };
}
