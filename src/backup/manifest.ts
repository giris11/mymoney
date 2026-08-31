// The manifest: a backup that states what it contains, so it can be checked
// rather than trusted.
//
// WHY. Every figure in this app is derived — a balance is an opening balance
// plus a stream of signed integers, net worth is those balances converted at
// display time. A backup file that carries only the rows is a promise that
// those derivations will come out the same way when they are read back, and
// nothing in the file can test that promise. So the file also carries the
// ANSWERS: per-table row counts, every account's closing balance in minor
// units with its currency, and the net worth in a named base currency together
// with the exact rates used to reach it. On restore every one of them is
// recomputed from the rows that actually landed, and a disagreement stops the
// restore and names what disagreed. A backup that cannot prove itself is not
// a backup.
//
// It is also the ORACLE for the planned Swift/SQLite port: an independently
// checkable statement of what the data is and what the arithmetic should
// produce, so the second implementation can be proved correct against these
// numbers instead of against its own opinion.
//
// TWO RULES THIS FILE IS BUILT AROUND:
//
//  * COMPUTED FROM THE ROWS BEING WRITTEN. Everything here is derived from row
//    arrays (or from a streamed read of the very rows just written) — never
//    from a second query. `db.accounts.count()` taken next to a row array is a
//    statement about a DIFFERENT MOMENT, and a manifest that describes a
//    different moment is worse than no manifest at all.
//  * ONE IMPLEMENTATION FOR BOTH ENDS. The export side and the verify side call
//    the same `computeManifest`, over the same shape, so they cannot drift into
//    disagreeing about what "closing balance" means. The net-worth arithmetic
//    reuses countsTowardNetWorth() and convertMinor() from the app itself, so
//    the manifest states the number the app actually shows — not a second
//    opinion that happens to look similar.
import { ALL_TABLES } from '../db/db';
import type { Account, FxRate, Settings } from '../db/types';
import { countsTowardNetWorth } from '../domain/balances';
import { convertMinor, formatMinor, makeRateLookup } from '../money/money';

/**
 * Manifest format version — independent of the database SCHEMA_VERSION,
 * because the manifest can gain a claim without any row changing shape.
 *
 * A file whose manifestVersion is not this one is not checked (and says so):
 * an older build must still be able to restore a file a newer build wrote, and
 * the rows themselves are fully validated either way. Refusing would turn a
 * forward-compatible file into an unrestorable one, which is a worse failure
 * than an unverified restore that admits it is unverified.
 */
export const MANIFEST_VERSION = 1;

/** What one account was worth when the backup was taken. */
export interface ManifestAccount {
  id: string;
  /** Carried so a mismatch can be reported in the owner's terms, not by id. */
  name: string;
  currency: string;
  /** openingBalanceMinor + Σ of the account's transactions, in MINOR UNITS. */
  closingBalanceMinor: number;
  txCount: number;
  /** Did it count toward net worth (not archived, not excluded)? */
  counted: boolean;
}

/** One conversion actually used to reach the net-worth figure: 1 from = rate to. */
export interface ManifestRate {
  from: string;
  to: string;
  rate: number;
}

export interface ManifestNetWorth {
  /** Named, never assumed — the figure means nothing without it. */
  baseCurrency: string;
  totalMinor: number;
  /** Every rate the total depended on, so it can be recomputed by hand. */
  rates: ManifestRate[];
  /**
   * Currencies left OUT of the total because no rate to base exists. Surfaced,
   * never guessed (SPEC §6): the honest total is the one that says what is
   * missing from it.
   */
  missingRateCurrencies: string[];
}

export interface BackupManifest {
  manifestVersion: number;
  schemaVersion: number;
  /** Same instant as the file's own `exportedAt`; validateBackup ties them. */
  exportedAt: string;
  /** Table name → rows written. Every table in ALL_TABLES, always. */
  rowCounts: Record<string, number>;
  /** Every account, sorted by id — archived and excluded ones included. */
  accounts: ManifestAccount[];
  netWorth: ManifestNetWorth;
}

/**
 * Per-account transaction totals. A Map rather than an array of transactions so
 * the verify side can STREAM a 100,000-row table past this (SPEC §9 scale)
 * instead of materialising it twice — once to write, once to check.
 */
export type TxTotals = Map<string, { sumMinor: number; count: number }>;

/** Everything a manifest is computed from, however the caller got hold of it. */
export interface ManifestSource {
  rowCounts: Record<string, number>;
  accounts: Account[];
  fxRates: FxRate[];
  txByAccount: TxTotals;
}

export function addTxToTotals(totals: TxTotals, accountId: string, amountMinor: number): void {
  const t = totals.get(accountId);
  if (t) {
    t.sumMinor += amountMinor;
    t.count += 1;
  } else {
    totals.set(accountId, { sumMinor: amountMinor, count: 1 });
  }
}

const isRow = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * A ManifestSource straight from the row arrays about to be written — the
 * export path. Every number here comes from those arrays and nothing else.
 */
export function manifestSourceFromTables(tables: Record<string, unknown[]>): ManifestSource {
  const rowCounts: Record<string, number> = {};
  for (const name of ALL_TABLES) {
    const rows = tables[name];
    rowCounts[name] = Array.isArray(rows) ? rows.length : 0;
  }
  const txByAccount: TxTotals = new Map();
  for (const row of tables.transactions ?? []) {
    if (!isRow(row)) continue;
    const accountId = typeof row.accountId === 'string' ? row.accountId : '';
    const amount = typeof row.amountMinor === 'number' ? row.amountMinor : 0;
    addTxToTotals(txByAccount, accountId, amount);
  }
  return {
    rowCounts,
    accounts: (tables.accounts ?? []).filter(isRow) as unknown as Account[],
    fxRates: (tables.fxRates ?? []).filter(isRow) as unknown as FxRate[],
    txByAccount,
  };
}

/** The base currency the book is denominated in, read from the rows themselves. */
export function baseCurrencyFromRows(
  tables: Record<string, unknown[]>,
  fallback: string,
): string {
  const row = (tables.settings ?? [])[0];
  if (isRow(row) && typeof row.baseCurrency === 'string' && row.baseCurrency !== '') {
    return row.baseCurrency as Settings['baseCurrency'];
  }
  return fallback;
}

export interface ManifestOptions {
  schemaVersion: number;
  exportedAt: string;
  /**
   * Explicit, never inferred inside here. On export it comes from the settings
   * row being written; on verification it comes from the settings row that
   * landed. Making the caller say it is what lets the verify side notice that
   * the two disagree instead of silently using a different divisor.
   */
  baseCurrency: string;
}

/**
 * The manifest for a set of rows.
 *
 * The net-worth arithmetic is deliberately the same as domain/balances.ts
 * netWorth(): archived or excluded accounts are out of the total (but keep
 * their real closing balance here, because that is a fact about the account),
 * conversion happens once per account through convertMinor — integer minor
 * units in, integer minor units out, rounded half away from zero exactly once —
 * and a currency with no rate to base is named rather than guessed at.
 */
export function computeManifest(src: ManifestSource, opts: ManifestOptions): BackupManifest {
  const lookup = makeRateLookup(src.fxRates);
  const accounts: ManifestAccount[] = [];
  const rates = new Map<string, ManifestRate>();
  const missing = new Set<string>();
  let totalMinor = 0;

  // Sorted by id so the manifest is byte-stable regardless of how the rows
  // arrived (canonical.ts fixes key order; row order is fixed here and in the
  // exporter).
  const ordered = [...src.accounts].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const account of ordered) {
    const totals = src.txByAccount.get(account.id);
    const closingBalanceMinor = account.openingBalanceMinor + (totals?.sumMinor ?? 0);
    const counted = countsTowardNetWorth(account);
    accounts.push({
      id: account.id,
      name: account.name,
      currency: account.currency,
      closingBalanceMinor,
      txCount: totals?.count ?? 0,
      counted,
    });
    if (!counted) continue;
    const converted = convertMinor(
      closingBalanceMinor,
      account.currency,
      opts.baseCurrency,
      lookup,
    );
    if (converted === null) {
      missing.add(account.currency);
      continue;
    }
    totalMinor += converted;
    if (account.currency !== opts.baseCurrency && !rates.has(account.currency)) {
      // The rate as USED, which may be the reciprocal of the stored row
      // (makeRateLookup inverts when only the other direction exists). Writing
      // down what was applied — not what was stored — is what makes the figure
      // recomputable by hand.
      const rate = lookup(account.currency, opts.baseCurrency);
      if (rate !== null) {
        rates.set(account.currency, { from: account.currency, to: opts.baseCurrency, rate });
      }
    }
  }

  return {
    manifestVersion: MANIFEST_VERSION,
    schemaVersion: opts.schemaVersion,
    exportedAt: opts.exportedAt,
    rowCounts: { ...src.rowCounts },
    accounts,
    netWorth: {
      baseCurrency: opts.baseCurrency,
      totalMinor,
      rates: [...rates.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)),
      missingRateCurrencies: [...missing].sort(),
    },
  };
}

// ===========================================================================
// Checking a claim against a recomputation
// ===========================================================================

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown): x is number => isNumber(x) && Number.isInteger(x);
const isString = (x: unknown): x is string => typeof x === 'string';

/**
 * Shape-check a manifest found in a file, WITHOUT trusting any of its figures.
 * Returns an error message, or null when the manifest is either well-formed or
 * a version this build does not check (see MANIFEST_VERSION).
 *
 * `file` ties the manifest to the file around it: a manifest claiming a
 * different schema version or a different export time than its own file is
 * describing something else, and that is corruption however plausible the rest
 * of it looks.
 */
export function validateManifestShape(
  manifest: unknown,
  file: { schemaVersion: number; exportedAt: string },
): string | null {
  if (!isRow(manifest)) return 'Invalid backup: "manifest" must be an object';
  if (!isInt(manifest.manifestVersion) || manifest.manifestVersion < 1) {
    return 'Invalid backup: the manifest has no version number';
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) return null; // not ours to judge

  if (manifest.schemaVersion !== file.schemaVersion) {
    return `Invalid backup: the manifest describes schema ${String(
      manifest.schemaVersion,
    )} but the file says ${file.schemaVersion}`;
  }
  if (manifest.exportedAt !== file.exportedAt) {
    return 'Invalid backup: the manifest was taken at a different time from the file it is in';
  }
  if (!isRow(manifest.rowCounts)) return 'Invalid backup: the manifest has no row counts';
  for (const name of ALL_TABLES) {
    const n = manifest.rowCounts[name];
    if (!isInt(n) || n < 0) {
      return `Invalid backup: the manifest's row count for "${name}" is not a whole number`;
    }
  }
  if (!Array.isArray(manifest.accounts)) {
    return 'Invalid backup: the manifest has no account list';
  }
  for (let i = 0; i < manifest.accounts.length; i++) {
    const a: unknown = manifest.accounts[i];
    if (
      !isRow(a) ||
      !isString(a.id) ||
      a.id === '' ||
      !isString(a.name) ||
      !isString(a.currency) ||
      !isInt(a.closingBalanceMinor) ||
      !isInt(a.txCount) ||
      typeof a.counted !== 'boolean'
    ) {
      return `Invalid backup: the manifest's account entry ${i} is incomplete`;
    }
  }
  const nw: unknown = manifest.netWorth;
  if (
    !isRow(nw) ||
    !isString(nw.baseCurrency) ||
    nw.baseCurrency === '' ||
    !isInt(nw.totalMinor) ||
    !Array.isArray(nw.rates) ||
    !Array.isArray(nw.missingRateCurrencies)
  ) {
    return 'Invalid backup: the manifest has no usable net-worth figure';
  }
  for (const r of nw.rates as unknown[]) {
    if (!isRow(r) || !isString(r.from) || !isString(r.to) || !isNumber(r.rate) || !(r.rate > 0)) {
      return 'Invalid backup: the manifest lists an unusable exchange rate';
    }
  }
  if ((nw.missingRateCurrencies as unknown[]).some((c) => !isString(c))) {
    return 'Invalid backup: the manifest lists an unusable currency code';
  }
  return null;
}

/** Is this a manifest this build knows how to check? */
export function isCheckableManifest(manifest: unknown): manifest is BackupManifest {
  return isRow(manifest) && manifest.manifestVersion === MANIFEST_VERSION;
}

const count = (n: number): string => n.toLocaleString('en-GB');

export interface CompareOptions {
  /**
   * The restore minted this device's own settings row because the file carried
   * none (see pinDeviceLocalSettings, C8). The settings row count then MUST
   * differ from the claim by exactly that row, and refusing over it would make
   * a legitimate restore impossible.
   */
  settingsRowMintedLocally?: boolean;
}

/**
 * Every way `recomputed` fails to match what `claimed` says, in plain English,
 * naming the table or the account — never "verification failed".
 *
 * Deliberately NOT compared: manifestVersion, schemaVersion and exportedAt.
 * Those are claims about the FILE, tied to it by validateManifestShape before
 * a single row is written; here we are only asking whether the rows produce
 * the arithmetic the file says they produce.
 */
export function compareManifests(
  claimed: BackupManifest,
  recomputed: BackupManifest,
  opts: CompareOptions = {},
): string[] {
  const problems: string[] = [];

  for (const name of ALL_TABLES) {
    if (name === 'settings' && opts.settingsRowMintedLocally) continue;
    const want = claimed.rowCounts[name] ?? 0;
    const got = recomputed.rowCounts[name] ?? 0;
    if (want !== got) {
      problems.push(`table “${name}”: ${count(got)} rows, but the backup says ${count(want)}`);
    }
  }

  const seen = new Set<string>();
  const byId = new Map(recomputed.accounts.map((a) => [a.id, a]));
  for (const want of claimed.accounts) {
    seen.add(want.id);
    const got = byId.get(want.id);
    const who = `${want.name || want.id}`;
    if (!got) {
      problems.push(`account “${who}” is in the backup’s manifest but not in the restored data`);
      continue;
    }
    if (got.currency !== want.currency) {
      problems.push(`account “${who}”: currency is ${got.currency}, but the backup says ${want.currency}`);
      // Different currencies make the balance comparison meaningless; the
      // currency mismatch is the finding worth reporting.
      continue;
    }
    if (got.closingBalanceMinor !== want.closingBalanceMinor) {
      problems.push(
        `account “${who}”: closing balance is ${formatMinor(got.closingBalanceMinor, got.currency)}` +
          `, but the backup says ${formatMinor(want.closingBalanceMinor, want.currency)}`,
      );
    }
    if (got.txCount !== want.txCount) {
      problems.push(
        `account “${who}”: ${count(got.txCount)} transactions, but the backup says ${count(want.txCount)}`,
      );
    }
    if (got.name !== want.name) {
      problems.push(`account “${who}” is named “${got.name}” in the restored data`);
    }
    if (got.counted !== want.counted) {
      problems.push(
        got.counted
          ? `account “${who}” now counts toward net worth, but the backup says it did not`
          : `account “${who}” no longer counts toward net worth, but the backup says it did`,
      );
    }
  }
  for (const got of recomputed.accounts) {
    if (!seen.has(got.id)) {
      problems.push(`account “${got.name || got.id}” is in the restored data but not in the backup’s manifest`);
    }
  }

  const wantNw = claimed.netWorth;
  const gotNw = recomputed.netWorth;
  if (gotNw.baseCurrency !== wantNw.baseCurrency) {
    problems.push(
      `base currency is ${gotNw.baseCurrency}, but the backup says ${wantNw.baseCurrency}`,
    );
  } else if (gotNw.totalMinor !== wantNw.totalMinor) {
    // Only when the currencies agree: two totals in different currencies are
    // not a disagreement about arithmetic, and saying so twice hides the cause.
    problems.push(
      `net worth is ${formatMinor(gotNw.totalMinor, gotNw.baseCurrency)}` +
        `, but the backup says ${formatMinor(wantNw.totalMinor, wantNw.baseCurrency)}`,
    );
  }
  const wantRates = wantNw.rates.map((r) => `${r.from}→${r.to} @ ${r.rate}`).join(', ');
  const gotRates = gotNw.rates.map((r) => `${r.from}→${r.to} @ ${r.rate}`).join(', ');
  if (wantRates !== gotRates) {
    problems.push(
      `exchange rates used: ${gotRates || 'none'}, but the backup says ${wantRates || 'none'}`,
    );
  }
  const wantMissing = wantNw.missingRateCurrencies.join(', ');
  const gotMissing = gotNw.missingRateCurrencies.join(', ');
  if (wantMissing !== gotMissing) {
    problems.push(
      `currencies with no rate: ${gotMissing || 'none'}, but the backup says ${wantMissing || 'none'}`,
    );
  }
  return problems;
}

const plural = (n: number, one: string, many: string): string =>
  `${count(n)} ${n === 1 ? one : many}`;

/**
 * The figures in the owner's own terms: "58 accounts, 5,127 transactions, net
 * worth £429,327.86". A sentence, not a table, because it has to be readable
 * in a toast and in a confirmation dialog — and because the point is that he
 * recognises the numbers.
 *
 * A currency the total could not include is SAID, never left out silently.
 */
export function summariseManifest(m: BackupManifest): string {
  const head = `${plural(m.rowCounts.accounts ?? 0, 'account', 'accounts')}, ${plural(
    m.rowCounts.transactions ?? 0,
    'transaction',
    'transactions',
  )}, net worth ${formatMinor(m.netWorth.totalMinor, m.netWorth.baseCurrency)}`;
  const missing = m.netWorth.missingRateCurrencies;
  if (missing.length === 0) return head;
  return `${head} (${missing.join(', ')} not counted — no exchange rate)`;
}
