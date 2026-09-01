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
 * A file whose manifestVersion this build does not KNOW is not checked (and
 * says so): an older build must still be able to restore a file a newer build
 * wrote, and the rows themselves are fully validated either way. Refusing
 * would turn a forward-compatible file into an unrestorable one, which is a
 * worse failure than an unverified restore that admits it is unverified.
 *
 * EVERY VERSION THIS BUILD KNOWS IS STILL CHECKED — EACH BY ITS OWN RULE.
 * The version is not "how new is this file"; it is WHICH ARITHMETIC PRODUCED
 * THE NET-WORTH FIGURE INSIDE IT (see NetWorthRule). v1 files are recomputed
 * the v1 way, forever.
 */
export const MANIFEST_VERSION = 2;

/**
 * HOW A MANIFEST'S NET-WORTH TOTAL WAS ARRIVED AT.
 *
 * Two counted accounts in the same non-base currency can be totalled two ways,
 * and the two do not always agree, because conversion rounds:
 *
 *     705 + 705 EUR at 0.85 → per account:  round(599.25) + round(599.25) = 1198
 *                             per currency: round(1410 x 0.85 = 1198.5)   = 1199
 *
 *  * 'per-account'  — convert each counted account's closing balance, then
 *    add. This is what MANIFEST_VERSION 1 means. Every backup file already in
 *    existence says it, and that meaning is now FROZEN. A v1 manifest is a
 *    record of arithmetic that was already performed, by a build that no
 *    longer exists; reinterpreting it would not make the old file wrong, it
 *    would make it UNRESTORABLE — restoreBackup recomputes every figure and
 *    refuses the restore on a disagreement, so "recompute it the new way"
 *    means "refuse every backup Girish is holding". Fixing a rounding
 *    cosmetic by making the safety net reject the files it exists to accept is
 *    not a fix.
 *  * 'per-currency' — add each currency's counted balances up IN that
 *    currency, then convert each subtotal exactly once. MANIFEST_VERSION 2,
 *    and what this build exports.
 *
 * WHY PER-CURRENCY IS THE RULE GOING FORWARD: it rounds once per currency
 * instead of once per account, so the error cannot grow with the number of
 * accounts; it is the ordinary accounting treatment (total in the source
 * currency, then convert); and it is what reports/aggregate.ts netWorthSeries()
 * has always done, so adopting it leaves the chart's history truthful instead
 * of retroactively re-rounding it. domain/balances.ts netWorth() — the
 * headline figure — now does the same. This manifest is the THIRD place that
 * number is computed, and a file whose stated net worth disagrees with the
 * screen is a file that cannot be used to check anything.
 *
 * A v1 FILE IS NEVER SILENTLY UPGRADED. Restore a v1 backup and export again
 * and the new file carries a v2 manifest whose totalMinor may differ from the
 * v1 one by a penny or two. That is correct and expected — one book, stated
 * under a better rule — and it is NOT corruption, however much a figure that
 * moves across a round trip looks like it. The version beside it is what says
 * which of the two it is.
 */
export type NetWorthRule = 'per-account' | 'per-currency';

/** The rule new exports are written under. Pairs with MANIFEST_VERSION. */
export const CURRENT_NET_WORTH_RULE: NetWorthRule = 'per-currency';

/**
 * The rule a manifest of this version was computed under — null when this
 * build has never heard of the version, the one case where a manifest cannot
 * be checked at all (isCheckableManifest).
 *
 * APPEND-ONLY. Changing what an existing number means would un-restore every
 * file already carrying it.
 */
export function netWorthRuleForManifestVersion(version: number): NetWorthRule | null {
  if (version === 1) return 'per-account';
  if (version === 2) return 'per-currency';
  return null;
}

/** The other direction: a manifest computed under this rule states this version. */
export function manifestVersionForNetWorthRule(rule: NetWorthRule): number {
  return rule === 'per-account' ? 1 : 2;
}

/**
 * The rule a manifest that is about to be CHECKED was computed under.
 *
 * Separate from netWorthRuleForManifestVersion so that no caller on the
 * verifying path has to write `!` over a nullable rule. An `undefined` that
 * slipped through would compare unequal to 'per-currency', fall through to the
 * per-account arithmetic, and verify the file under the WRONG rule — silently,
 * with a plausible answer. That is precisely the failure this whole change
 * exists to remove, so it throws instead: inside restoreBackup's transaction a
 * throw aborts and changes nothing, which is the right answer to "I do not know
 * how to check this".
 */
export function netWorthRuleOfManifest(manifest: BackupManifest): NetWorthRule {
  const rule = netWorthRuleForManifestVersion(manifest.manifestVersion);
  if (rule === null) {
    throw new Error(
      `This backup states manifest version ${manifest.manifestVersion}, which this build ` +
        'does not know how to check.',
    );
  }
  return rule;
}

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
  /**
   * Which net-worth arithmetic to use — and therefore which manifestVersion
   * the result is stamped with. Explicit and required, never defaulted:
   * exporting passes CURRENT_NET_WORTH_RULE, and every VERIFYING caller passes
   * the rule THE MANIFEST IT IS CHECKING declares, via
   * netWorthRuleForManifestVersion(). A default here would quietly hold an old
   * file to a rule it was never computed under, and the restore would refuse
   * a backup that is perfectly sound.
   */
  netWorthRule: NetWorthRule;
}

/**
 * The manifest for a set of rows, computed under the rule the caller names.
 *
 * The net-worth arithmetic is deliberately the same as domain/balances.ts
 * netWorth(): archived or excluded accounts are out of the total (but keep
 * their real closing balance here, because that is a fact about the account),
 * conversion goes through convertMinor — integer minor units in, integer minor
 * units out, rounded half away from zero exactly once — and a currency with no
 * rate to base is named rather than guessed at.
 *
 * WHAT opts.netWorthRule CHANGES, AND WHAT IT CANNOT. It chooses only WHEN the
 * rounding happens: once per counted account ('per-account', v1) or once per
 * currency ('per-currency', v2). Everything else in this manifest is a fact
 * about the rows and is identical either way — the per-account closing
 * balances (a per-account figure legitimately rounds per account: it IS one
 * account), the row counts, the rates that were applied, and the currencies
 * that had none. So a v1 file and a v2 file of the same book differ in exactly
 * one integer, and only when two counted accounts share a non-base currency.
 *
 * The stamped manifestVersion comes FROM the rule, never from a parameter of
 * its own: a manifest that said v1 while holding a per-currency total would be
 * a file that lies about its own arithmetic, and every later verification of
 * it would be checked the wrong way round.
 */
export function computeManifest(src: ManifestSource, opts: ManifestOptions): BackupManifest {
  const lookup = makeRateLookup(src.fxRates);
  const accounts: ManifestAccount[] = [];
  const rates = new Map<string, ManifestRate>();
  const missing = new Set<string>();
  // Both totals are accumulated in one pass over the accounts, and the rule
  // picks which one is stated. They are gathered together rather than in two
  // branches so that the rates applied and the currencies with no rate — facts
  // about the book, not about the rule — cannot come out differently for a v1
  // file and a v2 file of the same rows.
  let perAccountTotal = 0;
  const countedByCurrency = new Map<string, number>();

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
    countedByCurrency.set(
      account.currency,
      (countedByCurrency.get(account.currency) ?? 0) + closingBalanceMinor,
    );
    const converted = convertMinor(
      closingBalanceMinor,
      account.currency,
      opts.baseCurrency,
      lookup,
    );
    if (converted === null) {
      // A currency with no rate to base cannot be converted at either
      // granularity — convertMinor returns null on the missing RATE, not on
      // the amount — so this list is the same under both rules.
      missing.add(account.currency);
      continue;
    }
    perAccountTotal += converted;
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

  let totalMinor = perAccountTotal;
  if (opts.netWorthRule === 'per-currency') {
    // Sum in the source currency, convert the subtotal once. The nulls are the
    // currencies already named in `missing` above; skipping them here keeps
    // the total honest about what it does not include (SPEC §6).
    totalMinor = 0;
    for (const [currency, minor] of countedByCurrency) {
      const converted = convertMinor(minor, currency, opts.baseCurrency, lookup);
      if (converted !== null) totalMinor += converted;
    }
  }

  return {
    manifestVersion: manifestVersionForNetWorthRule(opts.netWorthRule),
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
  // Not ours to judge — a version whose net-worth RULE this build does not
  // know (a future one). Every version it does know is shape-checked here and
  // arithmetic-checked later against its own rule; v1 and v2 have the same
  // shape, and only the meaning of netWorth.totalMinor differs.
  if (netWorthRuleForManifestVersion(manifest.manifestVersion) === null) return null;

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

/**
 * Is this a manifest this build knows how to check?
 *
 * "Knows how to check" means "knows which net-worth rule produced it", which
 * is every version in netWorthRuleForManifestVersion — NOT only the current
 * one. Narrowing this to MANIFEST_VERSION would silently drop the self-check
 * on every backup written before the rule changed, which is most of the files
 * that exist: they would still restore, but unverified, and the whole point of
 * the manifest is that a restore is held to the file's own figures.
 */
export function isCheckableManifest(manifest: unknown): manifest is BackupManifest {
  return (
    isRow(manifest) &&
    typeof manifest.manifestVersion === 'number' &&
    netWorthRuleForManifestVersion(manifest.manifestVersion) !== null
  );
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
