// Import planning, commit and undo (SPEC §7.4). CONTRACT — implemented by the
// import build agent.
//
//  * buildImportPlan WRITES NOTHING — it resolves rows against the current db
//    (existing accounts/categories/payees/tags, duplicates, suggestions) and
//    returns the full plan for the mandatory preview screen.
//  * commitImport applies a plan in ONE Dexie rw-transaction: creates the
//    ImportBatch row first (with created-entity ids, D18), then entities, then
//    transactions (importBatchId set, dedupeHash computed, transfer pairs
//    linked via a shared transferGroupId).
//  * undoImport deletes the batch's transactions AND any created entities that
//    are no longer referenced by anything else (D18).
//
// Dedupe policy (SPEC §7.4): duplicates are only ever detected against the
// EXISTING database, and each existing transaction can explain at most ONE
// file row. Rows that are identical WITHIN the one file are left as plain
// 'import' — two identical same-day coffees in one export are legitimate, and
// auto-skipping them would silently lose real spending.
//
// Currency: an imported transaction is ALWAYS denominated in its account's
// currency; a currency named in the file is metadata about the purchase and is
// counted (plan.currencyMismatchCount) and noted, never converted (SPEC §6).
import dayjs from 'dayjs';
import { db } from '../db/db';
import type { Account, Category, CategoryKind, ImportBatch, Payee, Transaction } from '../db/types';
import { findOrCreateByPath } from '../domain/categories';
import { getOrCreatePayee, learnPayeeCategory } from '../domain/payees';
import { getOrCreateTags } from '../domain/tags';
import { nameKey, nowISO, uid } from '../lib/util';
import { decimalsFor } from '../money/money';
import { checkDuplicate, makeDedupeHash } from './dedupe';
import { detectDecimalStyle, parseImportAmount } from './generic';
import type { ImportPlan, ImportPlanRow, NewAccountPlan, ParsedRow } from './types';

export interface BuildPlanOptions {
  source: 'moneywiz' | 'csv';
  fileName: string;
  /** Generic imports may pin every row to one chosen account. */
  fixedAccountId?: string;
  /** Currency for rows without one (usually the base currency). */
  defaultCurrency: string;
}

/** Colour rotation for accounts created by an import. */
const ACCOUNT_PALETTE = ['#2563eb', '#059669', '#db2777', '#b45309', '#7c3aed', '#0e7490'];

const pathKey = (path: string[]): string => path.map(nameKey).join('>');

/**
 * The parsers must scale amounts at a GUESSED currency (the account isn't
 * known yet) and detect the decimal style at 2 decimals, so their amountMinor
 * is only final when the guess and the real currency both use 2 decimals.
 * Otherwise it is 100× out (¥500 read as ¥50,000) or wrongly rejected
 * (a valid 3-decimal "12.345" has more precision than GBP allows).
 */
function needsRescale(row: ParsedRow, currency: string): boolean {
  return (
    row.amountText !== null &&
    (decimalsFor(currency) !== 2 || decimalsFor(row.currency ?? 'GBP') !== 2)
  );
}

/**
 * Decimal style stays a per-FILE decision (D27) but depends on the currency's
 * decimals, so it is detected once per distinct scale — never per row.
 */
function decimalStyleDetector(rows: ParsedRow[]): (currency: string) => 'dot' | 'comma' {
  const texts = rows.map((r) => r.amountText).filter((t): t is string => t !== null);
  const byDecimals = new Map<number, 'dot' | 'comma'>();
  return (currency) => {
    const decimals = decimalsFor(currency);
    let style = byDecimals.get(decimals);
    if (style === undefined) {
      style = detectDecimalStyle(texts, decimals);
      byDecimals.set(decimals, style);
    }
    return style;
  };
}

/**
 * Re-derive a row's signed amount at `currency` from the raw cell text.
 * Returns null when the text genuinely doesn't parse at this currency either —
 * then it IS a row error.
 */
function amountAtCurrency(
  row: ParsedRow,
  currency: string,
  decimal: 'dot' | 'comma',
): number | null {
  if (row.amountText === null) return null;
  const parsed = parseImportAmount(row.amountText, currency, decimal);
  if (parsed === null) return null;
  const signed =
    row.amountRule === 'debit'
      ? -Math.abs(parsed)
      : row.amountRule === 'flip'
        ? -parsed
        : parsed;
  return signed === 0 ? 0 : signed; // never store -0
}

/** Is this plan row going to be written if committed right now? */
function isEffectiveImport(plan: ImportPlan, pr: ImportPlanRow): boolean {
  if (pr.action === 'error' || pr.action === 'skip_exact_duplicate') return false;
  if (pr.action === 'needs_decision' && pr.decision !== 'import') return false;
  if (pr.accountId) return true;
  const na = plan.newAccounts.find((n) => nameKey(n.name) === nameKey(pr.row.accountName ?? ''));
  return na?.create === true;
}

/** Recompute the counters after preview edits (decisions, untick account). */
export function refreshPlanCounts(plan: ImportPlan): void {
  plan.exactDuplicateCount = plan.rows.filter((r) => r.action === 'skip_exact_duplicate').length;
  plan.nearDuplicateCount = plan.rows.filter((r) => r.action === 'needs_decision').length;
  plan.errorCount = plan.rows.filter((r) => r.action === 'error').length;
  plan.importableCount = plan.rows.filter((r) => isEffectiveImport(plan, r)).length;
  // Only rows that will actually be written can mislead the user about currency.
  plan.currencyMismatchCount = plan.rows.filter(
    (r) => r.currencyMismatch && isEffectiveImport(plan, r),
  ).length;
}

export async function buildImportPlan(
  rows: ParsedRow[],
  opts: BuildPlanOptions,
): Promise<ImportPlan> {
  const [accounts, categories, payees, tags] = await Promise.all([
    db.accounts.toArray(),
    db.categories.toArray(),
    db.payees.toArray(),
    db.tags.toArray(),
  ]);
  const accountByKey = new Map(accounts.map((a) => [nameKey(a.name), a]));
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const payeeByKey = new Map(payees.map((p) => [p.nameLower, p]));
  const tagKeys = new Set(tags.map((t) => t.nameLower));
  const fixedAccount = opts.fixedAccountId ? accountById.get(opts.fixedAccountId) : undefined;

  const planRows: ImportPlanRow[] = rows.map((row) => ({ row, action: 'import' }));
  const newAccounts: NewAccountPlan[] = [];
  const newAccountByKey = new Map<string, NewAccountPlan>();
  const decimalStyleFor = decimalStyleDetector(rows);

  // ---- 1. account resolution, amount scale, errors -----------------------
  // Order matters: the ACCOUNT fixes the currency, the currency fixes the
  // minor-unit scale, and only then can an amount be judged. The parsers had
  // to guess a currency before the account was known, so a "500" bound for a
  // JPY account is still 100× too big here, and a 3-decimal "12.345" was
  // rejected outright at GBP's 2 decimals.
  for (const pr of planRows) {
    const { row } = pr;
    if (row.date === null) {
      pr.action = 'error';
      row.error ??= 'Unparseable row';
      continue;
    }
    const key = row.accountName ? nameKey(row.accountName) : '';
    const existing = fixedAccount ?? (row.accountName ? accountByKey.get(key) : undefined);
    if (!existing && !row.accountName) {
      pr.action = 'error';
      row.error ??= 'No account for this row';
      continue;
    }
    // A transaction is ALWAYS denominated in its account's currency (SPEC §6,
    // and saveTransaction enforces the same). A new account takes the row's
    // declared currency; an existing one dictates it.
    const currency =
      existing?.currency ??
      newAccountByKey.get(key)?.currency ??
      row.currency ??
      opts.defaultCurrency;
    if (needsRescale(row, currency)) {
      const rescaled = amountAtCurrency(row, currency, decimalStyleFor(currency));
      row.amountMinor = rescaled;
      // With a valid date, the only error a parser can still be carrying is
      // about the amount — and it was reached at the wrong scale.
      row.error = rescaled === null ? `Unrecognised amount “${row.amountText}”` : null;
    }
    if (row.amountMinor === null || row.error) {
      pr.action = 'error';
      row.error ??= 'Unparseable row';
      continue; // error rows must not conjure accounts nobody will use
    }
    if (existing) {
      pr.accountId = existing.id;
    } else if (!newAccountByKey.has(key)) {
      const na: NewAccountPlan = {
        name: row.accountName!.trim().replace(/\s+/g, ' '),
        currency,
        create: true,
      };
      newAccounts.push(na);
      newAccountByKey.set(key, na);
    }
    // rows for a new account keep action 'import'; accountId resolves at commit
    pr.currencyMismatch = row.currency !== null && row.currency !== currency;
  }

  /** The currency a row will be STORED in — its account's, never the file's. */
  const accountCurrency = (pr: ImportPlanRow): string =>
    (pr.accountId
      ? accountById.get(pr.accountId)?.currency
      : newAccountByKey.get(nameKey(pr.row.accountName ?? ''))?.currency) ??
    opts.defaultCurrency;

  // ---- 2. transfer pairing (each row at most once) -----------------------
  // Scanning in file order and taking the first still-unpaired opposite leg
  // makes this "the k-th outgoing leg pairs with the k-th incoming leg" for a
  // given (account pair, date) — i.e. FILE ORDER decides. That is the only
  // signal available across currencies: SPEC §5 stores both legs' amounts
  // explicitly and rates may never be guessed (SPEC §6), so -€100 and +£85
  // cannot be matched by magnitude. Its limit: two same-day transfers between
  // the same two accounts are mis-linked if the export lists the incoming legs
  // in a different order from the outgoing ones — nothing in the file could
  // tell us. Where the magnitudes CAN be compared (both accounts hold the same
  // currency) they must match exactly, and that test uses each row's ACCOUNT
  // currency, never the currency the file declares: a row's declared currency
  // describes the purchase, while the ledger is always the account's (A1).
  for (let i = 0; i < planRows.length; i++) {
    const a = planRows[i];
    if (a.action === 'error' || a.transferPairIndex !== undefined || !a.row.transferAccountName) continue;
    for (let j = i + 1; j < planRows.length; j++) {
      const b = planRows[j];
      if (b.action === 'error' || b.transferPairIndex !== undefined || !b.row.transferAccountName) continue;
      if (nameKey(a.row.transferAccountName) !== nameKey(b.row.accountName ?? '')) continue;
      if (nameKey(b.row.transferAccountName) !== nameKey(a.row.accountName ?? '')) continue;
      if (a.row.date !== b.row.date) continue;
      const amountA = a.row.amountMinor!;
      const amountB = b.row.amountMinor!;
      if (!((amountA < 0 && amountB > 0) || (amountA > 0 && amountB < 0))) continue;
      if (accountCurrency(a) === accountCurrency(b) && Math.abs(amountA) !== Math.abs(amountB)) {
        continue;
      }
      a.transferPairIndex = j;
      b.transferPairIndex = i;
      break;
    }
  }

  // ---- 3. category paths --------------------------------------------------
  const roots = categories.filter((c) => c.parentId === null);
  const childrenByParent = new Map<string, Category[]>();
  for (const c of categories) {
    if (!c.parentId) continue;
    const list = childrenByParent.get(c.parentId) ?? [];
    list.push(c);
    childrenByParent.set(c.parentId, list);
  }
  const resolvePath = (path: string[], preferKind: CategoryKind): string | null => {
    let parent: Category | null = null;
    let current: Category | null = null;
    for (const seg of path) {
      const key = nameKey(seg);
      const pool: Category[] = parent ? (childrenByParent.get(parent.id) ?? []) : roots;
      const matches = pool.filter((c: Category) => nameKey(c.name) === key);
      if (matches.length === 0) return null;
      current = matches.find((c) => c.kind === preferKind) ?? matches[0];
      parent = current;
    }
    return current?.id ?? null;
  };

  const newPathByKey = new Map<string, string[]>();
  for (const pr of planRows) {
    if (pr.action === 'error') continue;
    if (pr.transferPairIndex !== undefined) continue; // paired legs get no category
    if (pr.row.categoryPath.length === 0) continue;
    const preferKind: CategoryKind = pr.row.amountMinor! < 0 ? 'expense' : 'income';
    const resolved = resolvePath(pr.row.categoryPath, preferKind);
    if (resolved) {
      pr.chosenCategoryId = resolved;
    } else {
      const key = pathKey(pr.row.categoryPath);
      if (!newPathByKey.has(key)) {
        newPathByKey.set(
          key,
          pr.row.categoryPath.map((p) => p.trim().replace(/\s+/g, ' ')),
        );
      }
    }
  }

  // ---- 4. payees + auto-categorisation suggestions -----------------------
  const newPayeeByKey = new Map<string, string>();
  for (const pr of planRows) {
    if (pr.action === 'error' || !pr.row.payeeName) continue;
    const clean = pr.row.payeeName.trim().replace(/\s+/g, ' ');
    const key = nameKey(clean);
    const existing = payeeByKey.get(key);
    if (!existing) {
      if (!newPayeeByKey.has(key)) newPayeeByKey.set(key, clean);
      continue;
    }
    // Suggest the learned category only when the row brings NO category path.
    if (
      existing.defaultCategoryId &&
      pr.row.categoryPath.length === 0 &&
      pr.transferPairIndex === undefined
    ) {
      pr.suggestedCategoryId = existing.defaultCategoryId;
    }
  }
  // chosenCategoryId = resolved path id, else the suggestion, else null.
  for (const pr of planRows) {
    if (pr.action === 'error') continue;
    if (pr.chosenCategoryId === undefined) pr.chosenCategoryId = pr.suggestedCategoryId ?? null;
  }

  // ---- 5. tags ------------------------------------------------------------
  const newTagByKey = new Map<string, string>();
  for (const pr of planRows) {
    if (pr.action === 'error') continue;
    for (const raw of pr.row.tags) {
      const clean = raw.trim().replace(/\s+/g, ' ');
      if (!clean) continue;
      const key = nameKey(clean);
      if (!tagKeys.has(key) && !newTagByKey.has(key)) newTagByKey.set(key, clean);
    }
  }

  // ---- 6. dedupe against the EXISTING db (SPEC §7.4) ---------------------
  // In-file repeats are deliberately NOT flagged — see file header comment.
  const dedupeRows = planRows.filter((pr) => pr.action !== 'error' && pr.accountId);
  if (dedupeRows.length > 0) {
    const dates = dedupeRows.map((pr) => pr.row.date!);
    const minDate = dates.reduce((a, b) => (a < b ? a : b));
    const maxDate = dates.reduce((a, b) => (a > b ? a : b));
    const from = dayjs(minDate).subtract(1, 'day').format('YYYY-MM-DD'); // ±1 day
    const to = dayjs(maxDate).add(1, 'day').format('YYYY-MM-DD');
    const accountIds = [...new Set(dedupeRows.map((pr) => pr.accountId!))];
    const lists = await Promise.all(
      accountIds.map((id) =>
        db.transactions
          .where('[accountId+date]')
          .between([id, from], [id, to], true, true)
          .toArray(),
      ),
    );
    const existingByAccount = new Map(accountIds.map((id, i) => [id, lists[i]]));
    const payeeNameById = new Map(payees.map((p) => [p.id, p.name]));
    const payeeNameOf = (t: Transaction): string =>
      t.payeeId ? (payeeNameById.get(t.payeeId) ?? '') : t.notes;
    const labelOf = (pr: ImportPlanRow): string => pr.row.payeeName ?? pr.row.description ?? '';

    // Each existing transaction may absorb at most ONE file row: a match is
    // CONSUMED (spliced out of its account's candidate list). Without that,
    // two legitimate identical rows in one file both match the single
    // transaction already in the db and both get skipped — real money silently
    // dropped. Re-importing the same file still skips everything, because N
    // file rows then face N existing transactions.
    // Exact matches run first so a near-duplicate can never steal the
    // transaction an exact re-import needs.
    const needsNearCheck: ImportPlanRow[] = [];
    for (const pr of dedupeRows) {
      const candidates = existingByAccount.get(pr.accountId!) ?? [];
      const hash = makeDedupeHash(pr.accountId!, pr.row.date!, pr.row.amountMinor!, labelOf(pr));
      const i = candidates.findIndex((t) => t.dedupeHash === hash);
      if (i >= 0) {
        pr.action = 'skip_exact_duplicate';
        candidates.splice(i, 1);
      } else {
        needsNearCheck.push(pr);
      }
    }
    for (const pr of needsNearCheck) {
      const candidates = existingByAccount.get(pr.accountId!) ?? [];
      const result = checkDuplicate(
        {
          accountId: pr.accountId!,
          date: pr.row.date!,
          amountMinor: pr.row.amountMinor!,
          payeeOrDescription: labelOf(pr),
        },
        candidates,
        payeeNameOf,
      );
      if (result.nearDuplicateOf) {
        pr.action = 'needs_decision';
        pr.nearDuplicateOf = result.nearDuplicateOf;
        pr.decision = 'skip'; // never silently doubled — user must opt in
        const j = candidates.indexOf(result.nearDuplicateOf);
        if (j >= 0) candidates.splice(j, 1);
      }
    }
  }

  const plan: ImportPlan = {
    source: opts.source,
    fileName: opts.fileName,
    rows: planRows,
    newAccounts,
    newCategoryPaths: [...newPathByKey.values()],
    newPayees: [...newPayeeByKey.values()],
    newTags: [...newTagByKey.values()],
    exactDuplicateCount: 0,
    nearDuplicateCount: 0,
    errorCount: 0,
    currencyMismatchCount: 0,
    importableCount: 0,
  };
  refreshPlanCounts(plan);
  return plan;
}

export async function commitImport(plan: ImportPlan): Promise<ImportBatch> {
  const batch: ImportBatch = {
    id: uid(),
    source: plan.source,
    fileName: plan.fileName,
    rowCount: 0, // set to the number of transactions actually written
    importedAt: nowISO(),
    createdAccountIds: [],
    createdCategoryIds: [],
    createdPayeeIds: [],
    createdTagIds: [],
    createdGroupIds: [],
  };
  const payeesTouched = new Set<string>();
  const decimalStyleFor = decimalStyleDetector(plan.rows.map((pr) => pr.row));

  await db.transaction('rw', db.tables, async () => {
    // The batch row goes in FIRST so a crash mid-import is still undoable.
    await db.importBatches.add(batch);

    // Snapshot existing ids so created-entity arrays can be computed exactly.
    const categoryIdsBefore = new Set(await db.categories.toCollection().primaryKeys());
    const payeeIdsBefore = new Set(await db.payees.toCollection().primaryKeys());
    const tagIdsBefore = new Set(await db.tags.toCollection().primaryKeys());

    // ---- accounts ---------------------------------------------------------
    const accountsNow = await db.accounts.toArray();
    const accountByKey = new Map(accountsNow.map((a) => [nameKey(a.name), a]));
    let sortOrder = accountsNow.reduce((m, a) => Math.max(m, a.sortOrder), -1) + 1;
    for (const na of plan.newAccounts) {
      if (!na.create || accountByKey.has(nameKey(na.name))) continue;
      const account: Account = {
        id: uid(),
        name: na.name,
        type: 'current',
        currency: na.currency,
        openingBalanceMinor: 0,
        colour: ACCOUNT_PALETTE[batch.createdAccountIds.length % ACCOUNT_PALETTE.length],
        groupId: null,
        sortOrder: sortOrder++,
        archived: false,
      };
      await db.accounts.add(account);
      accountByKey.set(nameKey(account.name), account);
      batch.createdAccountIds.push(account.id);
    }

    const effective = (pr: ImportPlanRow): boolean => isEffectiveImport(plan, pr);

    // ---- new category paths ------------------------------------------------
    // Kind inference: reuse an existing root's kind when the path starts at a
    // known root (so a refund row can't fork a duplicate tree of the wrong
    // kind); otherwise expense when the first row using the path is negative,
    // else income.
    const rootCats = await db.categories.filter((c) => c.parentId === null).toArray();
    const leafByPathKey = new Map<string, string>();
    for (const path of plan.newCategoryPaths) {
      const key = pathKey(path);
      const usedBy = plan.rows.find(
        (pr) => effective(pr) && pathKey(pr.row.categoryPath) === key,
      );
      if (!usedBy) continue; // every row using it was skipped — don't create
      const signKind: CategoryKind = usedBy.row.amountMinor! < 0 ? 'expense' : 'income';
      const rootMatches = rootCats.filter((c) => nameKey(c.name) === nameKey(path[0]));
      const kind = (rootMatches.find((c) => c.kind === signKind) ?? rootMatches[0])?.kind ?? signKind;
      const leaf = await findOrCreateByPath(path, kind);
      leafByPathKey.set(key, leaf.id);
    }

    // ---- transactions ------------------------------------------------------
    const transferGroupByPair = new Map<string, string>();
    const payeeCache = new Map<string, Payee>();
    let written = 0;
    for (let i = 0; i < plan.rows.length; i++) {
      const pr = plan.rows[i];
      if (!effective(pr)) continue;
      const row = pr.row;
      const account = pr.accountId
        ? (await db.accounts.get(pr.accountId))!
        : accountByKey.get(nameKey(row.accountName ?? ''));
      if (!account) continue; // new account was unticked — row errors out

      // A transfer pair only links when BOTH legs are actually imported;
      // a surviving single leg imports as a normal transaction.
      const partner = pr.transferPairIndex !== undefined ? plan.rows[pr.transferPairIndex] : null;
      const paired = partner !== null && effective(partner);
      let transferGroupId: string | null = null;
      if (paired) {
        const key = [Math.min(i, pr.transferPairIndex!), Math.max(i, pr.transferPairIndex!)].join(':');
        transferGroupId = transferGroupByPair.get(key) ?? uid();
        transferGroupByPair.set(key, transferGroupId);
      }

      let payeeId: string | null = null;
      if (row.payeeName) {
        const key = nameKey(row.payeeName);
        let payee = payeeCache.get(key);
        if (!payee) {
          payee = await getOrCreatePayee(row.payeeName);
          payeeCache.set(key, payee);
        }
        payeeId = payee.id;
        payeesTouched.add(payee.id);
      }

      let categoryId: string | null = null;
      if (!paired) {
        categoryId = pr.chosenCategoryId ?? null;
        if (categoryId === null && row.categoryPath.length > 0) {
          categoryId = leafByPathKey.get(pathKey(row.categoryPath)) ?? null;
        }
      }

      const tagIds = row.tags.length > 0 ? (await getOrCreateTags(row.tags)).map((t) => t.id) : [];

      // A transaction's amount is ALWAYS denominated in its ACCOUNT's currency
      // — saveTransaction enforces it and balances/net worth sum amountMinor
      // per account with no currency check, so a EUR row banked in a GBP
      // account would silently corrupt every total. A different currency in
      // the file describes the purchase, not the ledger (MoneyWiz exports the
      // account-currency figure in Amount); record it in the notes and never
      // guess a conversion (SPEC §6).
      const currency = account.currency;
      const mismatchedCurrency = row.currency !== null && row.currency !== currency;

      // The account is authoritative for SCALE too: re-derive the amount at
      // its currency whenever the parser's guess can't be trusted (the preview
      // can also have changed a new account's currency since the plan was
      // built). Idempotent — re-deriving an already-correct row is a no-op.
      let amountMinor = row.amountMinor!;
      if (needsRescale(row, currency)) {
        amountMinor = amountAtCurrency(row, currency, decimalStyleFor(currency)) ?? amountMinor;
      }

      // notes := join(description-if-different-from-payee, row.notes, ' — ');
      // an UNPAIRED transfer leg additionally gets '(transfer)' appended.
      const noteParts: string[] = [];
      if (row.description && (!row.payeeName || nameKey(row.description) !== nameKey(row.payeeName))) {
        noteParts.push(row.description);
      }
      if (row.notes) noteParts.push(row.notes);
      if (row.transferAccountName && !paired) noteParts.push('(transfer)');
      if (mismatchedCurrency) noteParts.push(`originally ${row.currency}`);

      const timestamp = nowISO();
      const tx: Transaction = {
        id: uid(),
        accountId: account.id,
        date: row.date!,
        amountMinor,
        currency,
        payeeId,
        categoryId,
        tagIds,
        notes: noteParts.join(' — '),
        status: 'cleared',
        splits: [],
        transferGroupId,
        importBatchId: batch.id,
        // Same payee-if-present-else-description rule as the plan's dedupe
        // check, so re-imports of this file match these rows exactly (D10).
        dedupeHash: makeDedupeHash(
          account.id,
          row.date!,
          amountMinor,
          row.payeeName ?? row.description ?? '',
        ),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await db.transactions.add(tx);
      written++;
    }

    batch.rowCount = written;
    batch.createdCategoryIds = (await db.categories.toCollection().primaryKeys()).filter(
      (id) => !categoryIdsBefore.has(id),
    );
    batch.createdPayeeIds = (await db.payees.toCollection().primaryKeys()).filter(
      (id) => !payeeIdsBefore.has(id),
    );
    batch.createdTagIds = (await db.tags.toCollection().primaryKeys()).filter(
      (id) => !tagIdsBefore.has(id),
    );
    await db.importBatches.put(batch);
  });

  // Learn payee → category AFTER the transaction commits (D17).
  for (const payeeId of payeesTouched) await learnPayeeCategory(payeeId);
  return batch;
}

export async function undoImport(batchId: string): Promise<void> {
  const payeesTouched = new Set<string>();

  await db.transaction('rw', db.tables, async () => {
    const batch = await db.importBatches.get(batchId);
    if (!batch) return;

    // 1. the batch's transactions
    const doomed = await db.transactions.where('importBatchId').equals(batchId).toArray();
    for (const t of doomed) if (t.payeeId) payeesTouched.add(t.payeeId);
    await db.transactions.where('importBatchId').equals(batchId).delete();

    // 2. created accounts with no remaining transactions
    for (const id of batch.createdAccountIds) {
      const remaining = await db.transactions.where('accountId').equals(id).count();
      if (remaining === 0) await db.accounts.delete(id);
    }

    // 3. created categories: no transactions (direct or in splits), no
    //    children, no budget references. Loop to a fixpoint so leaves are
    //    removed before their (also-created) parents.
    const pendingCategories = new Set(batch.createdCategoryIds);
    let progress = true;
    while (progress && pendingCategories.size > 0) {
      progress = false;
      for (const id of [...pendingCategories]) {
        const children = await db.categories.where('parentId').equals(id).count();
        if (children > 0) continue; // try again after children are removed
        const direct = await db.transactions.where('categoryId').equals(id).count();
        const inSplits = direct > 0
          ? 1
          : await db.transactions.filter((t) => t.splits.some((s) => s.categoryId === id)).count();
        const inBudgets = await db.budgets.filter((b) => b.categoryIds.includes(id)).count();
        if (direct > 0 || inSplits > 0 || inBudgets > 0) {
          pendingCategories.delete(id); // still in use — keep it
          continue;
        }
        // payee defaults never block deletion — clear them (D18)
        const referencing = await db.payees.filter((p) => p.defaultCategoryId === id).toArray();
        for (const p of referencing) await db.payees.update(p.id, { defaultCategoryId: null });
        await db.categories.delete(id);
        pendingCategories.delete(id);
        progress = true;
      }
    }

    // 4. created payees with no transactions
    for (const id of batch.createdPayeeIds) {
      const used = await db.transactions.where('payeeId').equals(id).count();
      if (used === 0) await db.payees.delete(id);
    }

    // 5. created tags not on any transaction
    for (const id of batch.createdTagIds) {
      const used = await db.transactions.where('tagIds').equals(id).count();
      if (used === 0) await db.tags.delete(id);
    }

    // 6. sample-batch extras (D19), then groups no account references
    for (const id of batch.createdBudgetIds ?? []) await db.budgets.delete(id);
    // An fxRates row has a fixed primary key (`EUR:GBP`), so editing the rate
    // the sample wrote OVERWRITES it rather than adding a row — after which it
    // is the user's own rate and deleting it would drop their EUR accounts out
    // of net worth. Batch-created rates are stamped with the batch's timestamp
    // (see domain/sample.ts); any later edit moves asOf, which is the proof
    // that the row is no longer the one this batch created.
    for (const id of batch.createdFxRateIds ?? []) {
      const rate = await db.fxRates.get(id);
      if (rate && rate.asOf === batch.importedAt) await db.fxRates.delete(id);
    }
    for (const id of batch.createdGroupIds) {
      // groupId is nullable — index lookups can't see null, filter() can
      const used = await db.accounts.filter((a) => a.groupId === id).count();
      if (used === 0) await db.accountGroups.delete(id);
    }

    // 7. finally the batch row itself
    await db.importBatches.delete(batchId);
  });

  // commitImport learned payee → category from what it wrote (D17); undoing it
  // must un-learn, or a badly categorised import that the user REJECTED keeps
  // dictating suggestions from transactions that no longer exist.
  for (const payeeId of payeesTouched) {
    if (await db.payees.get(payeeId)) await learnPayeeCategory(payeeId);
  }
}

export async function listImportBatches(): Promise<ImportBatch[]> {
  return db.importBatches.orderBy('importedAt').reverse().toArray();
}
