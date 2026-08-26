// MoneyWiz *Report* layout — the wizard's side of it (SPEC §7).
//
// MoneyWiz exports two completely different shapes. The flat one (one row per
// transaction, parseMoneyWizCsv) is what the importer was built for. The
// Report one interleaves ACCOUNT rows with TRANSACTION rows:
//
//   line 1   an Excel separator hint, literally `sep=,`, above the header row
//   header   Name,Current balance,Account,Transfers,Description,Payee,
//            Category,Date,Memo,Amount,Currency,Cheque N°,Tags,Balance
//   rows     an ACCOUNT row carries a Name (the account), its Current balance
//            and — confusingly — its CURRENCY in the "Account" column;
//            a TRANSACTION row leaves Name empty and puts the ACCOUNT NAME in
//            the "Account" column, with the running balance in "Balance".
//
// src/import/moneywizReport.ts does the reading and derives each account's
// opening balance as
//
//     opening = stated closing balance − Σ(that account's amounts)
//
// which is ORDER-INDEPENDENT, and so is exactly SPEC §6's model of a balance
// (opening + Σ amounts) rearranged. The file's running "Balance" column is
// deliberately not used to derive anything — it disagrees with row order among
// same-date rows, which is intra-day ordering, not a discrepancy.
//
// THIS FILE is the wizard's only point of contact with that module and with
// the report-format additions to BuildPlanOptions/ImportPlan, so a contract
// change lands in one place rather than across the UI.
import type { BuildPlanOptions } from '../../import/importer';
import {
  isMoneyWizReportCsv,
  parseMoneyWizReportCsv,
  reportPlanOptions,
  type MoneyWizReportResult,
  type ReportAccount,
} from '../../import/moneywizReport';
import type { ImportPlan, NewAccountPlan } from '../../import/types';
import { nameKey } from '../../lib/util';
import { willImportRow } from './wizardLogic';

export { isMoneyWizReportCsv, parseMoneyWizReportCsv };
export type { MoneyWizReportResult, ReportAccount };

// Excel's `sep=,` hint line, which a report export starts with, is dropped by
// parseCsv itself (src/import/generic.ts), so the headers the wizard tests,
// the rows it shows and the parsers it calls already agree on where the header
// row is. The wizard deliberately does NOT strip it a second time: two
// implementations of "what counts as a separator hint" is one too many.

/**
 * Plan options for a report import: the ordinary ones plus the two maps the
 * engine needs for the balances to survive — opening balances, and the
 * file-declared currency that lets an account with no transactions still be
 * created. `reportPlanOptions` is the engine's own helper, used rather than
 * rebuilt so the two halves cannot be half-wired.
 */
export function reportBuildOptions(
  base: BuildPlanOptions,
  accounts: ReportAccount[],
): BuildPlanOptions {
  return { ...base, ...reportPlanOptions(accounts) };
}

/**
 * The opening balance the parser derived, normalised to `number | null`.
 * null means "could not be worked out safely" — an unreadable closing balance,
 * or a row of this account that will not import. We never substitute a zero:
 * a guessed opening balance is indistinguishable from a real one once it is in
 * the ledger, and it would quietly poison every balance, budget and report for
 * that account for ever.
 */
export function openingOf(account: ReportAccount): number | null {
  return account.openingBalanceMinor ?? null;
}

/** `NewAccountPlan.openingBalanceMinor` normalised the same way — this is the
 *  engine's final word (it knows the account's real currency, and so the real
 *  minor-unit scale), so it wins over the parser's figure where both exist. */
export function plannedOpeningMinor(na: NewAccountPlan): number | null {
  return na.openingBalanceMinor ?? null;
}

// ---------------------------------------------------------------------------
// The accounts panel's data
// ---------------------------------------------------------------------------

export type ReportAccountStatus =
  /** Will be created, with the opening balance derived from the file. */
  | 'new'
  /** Already in the database — its opening balance is left alone. */
  | 'existing'
  /** New, but the user unticked it in the preview. */
  | 'not-created'
  /** The file names it, but nothing in the plan creates it. */
  | 'not-planned';

export interface ReportAccountLine {
  name: string;
  /** The currency the account will actually be created in: the engine's
   *  choice where it made one, else the file's, else the base currency. */
  currency: string;
  status: ReportAccountStatus;
  /** Opening balance derived from the file (shown whatever the status). */
  fileOpeningMinor: number | null;
  /** True when that opening balance will actually be written. */
  openingApplied: boolean;
  /** Σ of the amounts of this account's rows that WILL be written. */
  importedNetMinor: number;
  importedCount: number;
  /** Rows for this account the plan will not write (duplicates, errors). */
  skippedCount: number;
  /** opening + net — the balance the account ends up with. null when either
   *  half is unknown (no opening derived, or an account we are not touching). */
  finalMinor: number | null;
  /** The "Current balance" the file states for this account. */
  fileBalanceMinor: number | null;
  /** finalMinor − fileBalanceMinor, when both are known. */
  differenceMinor: number | null;
}

/** True when this account will end up exactly where the file says it should. */
export function linesUp(line: ReportAccountLine): boolean {
  return line.differenceMinor === 0;
}

/** True when the line is worth a second look before committing. */
export function needsAttention(line: ReportAccountLine): boolean {
  return !linesUp(line);
}

/**
 * One row per account in the file, in the file's own order — which is the
 * order MoneyWiz lists them, so the panel and his MoneyWiz sidebar can be read
 * side by side.
 *
 * The net is summed over exactly the rows `willImportRow` says will be
 * written, including BOTH legs of a transfer (commitImport writes a
 * transaction per leg, each in its own account). So the final balance shown is
 * the balance the account will really have — not the one the file claims.
 */
export function reportAccountLines(
  accounts: readonly ReportAccount[],
  plan: ImportPlan,
  existingAccountKeys: ReadonlySet<string>,
  fallbackCurrency: string,
): ReportAccountLine[] {
  const totals = new Map<string, { net: number; imported: number; skipped: number }>();
  for (const pr of plan.rows) {
    const key = nameKey(pr.row.accountName ?? '');
    if (!key) continue;
    let t = totals.get(key);
    if (!t) {
      t = { net: 0, imported: 0, skipped: 0 };
      totals.set(key, t);
    }
    if (willImportRow(plan, pr)) {
      t.net += pr.row.amountMinor ?? 0;
      t.imported += 1;
    } else {
      t.skipped += 1;
    }
  }
  const plannedByKey = new Map(plan.newAccounts.map((na) => [nameKey(na.name), na]));

  return accounts.map((a): ReportAccountLine => {
    const key = nameKey(a.name);
    const na = plannedByKey.get(key);
    const t = totals.get(key) ?? { net: 0, imported: 0, skipped: 0 };
    const status: ReportAccountStatus = existingAccountKeys.has(key)
      ? 'existing'
      : na
        ? na.create
          ? 'new'
          : 'not-created'
        : 'not-planned';
    const currency = na?.currency || a.currency || fallbackCurrency;
    const fileOpeningMinor = (na ? plannedOpeningMinor(na) : null) ?? openingOf(a);
    const openingApplied = status === 'new' && fileOpeningMinor !== null;
    const finalMinor = openingApplied ? fileOpeningMinor + t.net : null;
    const fileBalanceMinor = a.currentBalanceMinor ?? null;
    return {
      name: a.name,
      currency,
      status,
      fileOpeningMinor,
      openingApplied,
      importedNetMinor: t.net,
      importedCount: t.imported,
      skippedCount: t.skipped,
      finalMinor,
      fileBalanceMinor,
      differenceMinor:
        finalMinor !== null && fileBalanceMinor !== null ? finalMinor - fileBalanceMinor : null,
    };
  });
}

/** Headline counts for the panel — how much of the file lands as stated. */
export function reportAccountSummary(lines: readonly ReportAccountLine[]): {
  total: number;
  creating: number;
  matching: number;
  attention: number;
  missingOpening: number;
} {
  return {
    total: lines.length,
    creating: lines.filter((l) => l.status === 'new').length,
    matching: lines.filter(linesUp).length,
    attention: lines.filter(needsAttention).length,
    missingOpening: lines.filter((l) => l.status === 'new' && l.fileOpeningMinor === null).length,
  };
}

/**
 * The plain-English line for accounts that already exist here (SPEC §7.4 — the
 * preview lets no surprise through silently). Their opening balance is
 * deliberately left alone, because rewriting a balance the user set would move
 * money they never touched; the cost is that their totals can disagree with
 * the file, and that has to be said rather than discovered.
 */
export function existingAccountsNote(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const list = names.join(', ');
  return names.length === 1
    ? `${list} already exists here, so its opening balance was left exactly as it is — the ` +
        'one in the file was NOT applied, and this account’s total may not match the file. ' +
        'Only its transactions are being added.'
    : `${names.length} of these accounts already exist here (${list}), so their opening ` +
        'balances were left exactly as they are — the ones in the file were NOT applied, and ' +
        'their totals may not match the file. Only their transactions are being added.';
}
