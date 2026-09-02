// Account and account-group domain (SPEC §8.1.1: full CRUD, groups, colours,
// archive). Owned by the Settings area but domain-grade: no DOM, all writes in
// Dexie transactions, ValidationError for user mistakes (caught + toasted by
// the UI).
//
// Semantics:
//  * openingBalanceMinor is a signed integer in the ACCOUNT's currency minor
//    units (SPEC §6) — positive for assets, negative for debt.
//  * currency is IMMUTABLE once the account has transactions: every stored
//    transaction amount is in the account's currency, so changing it would
//    silently re-denominate history (SPEC §6 "protect the data").
//  * deleteAccount refuses while transactions reference the account —
//    archiving is the supported way to retire an account with history.
//  * deleteGroup refuses while any account references the group; deleting a
//    group never touches accounts.
//  * setAccountExcluded / setGroupExcluded (bottom of this file) write ONLY
//    Account.excludeFromNetWorth — visibility, balances and transactions are
//    untouched; the flag changes what a TOTAL counts and nothing else.
//  * The MoneyWiz-style grouping section at the BOTTOM of this file is
//    ORGANISATIONAL ONLY: it writes groupId, type and sortOrder and nothing
//    else, so no balance, amount, transaction or net-worth figure can move.
import { db, getSettings } from '../db/db';
import type { Account, AccountGroup, AccountType } from '../db/types';
import { nameKey, uid } from '../lib/util';
import { ValidationError } from './transactions';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'current',
  'savings',
  'credit_card',
  'cash',
  'loan',
  'investment',
] as const;

export interface SaveAccountInput {
  id?: string; // present = update
  name: string;
  type: AccountType;
  currency: string; // 3-letter ISO code
  openingBalanceMinor: number;
  colour: string; // hex, e.g. '#2563eb'
  groupId: string | null;
  sortOrder?: number; // omitted: keep existing / append at the end
  archived?: boolean; // omitted: keep existing / false
}

/** Create or update an account. Throws ValidationError on bad input. */
export async function saveAccount(input: SaveAccountInput): Promise<Account> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new ValidationError('Account name cannot be empty');
  if (!ACCOUNT_TYPES.includes(input.type)) {
    throw new ValidationError(`Unknown account type “${input.type}”`);
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('Currency must be a 3-letter ISO code (e.g. GBP)');
  }
  if (!Number.isSafeInteger(input.openingBalanceMinor)) {
    throw new ValidationError('Opening balance must be a whole number of minor units');
  }
  const colour = input.colour.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(colour)) {
    throw new ValidationError('Colour must be a hex value like #2563eb');
  }

  return db.transaction('rw', db.accounts, db.accountGroups, db.transactions, async () => {
    const existing = input.id ? await db.accounts.get(input.id) : undefined;
    if (input.id && !existing) throw new ValidationError('Account not found');

    const groupId = input.groupId ?? null;
    if (groupId && !(await db.accountGroups.get(groupId))) {
      throw new ValidationError('Account group not found');
    }

    // Currency is immutable once transactions exist (see file header).
    if (existing && currency !== existing.currency) {
      const txCount = await db.transactions.where('accountId').equals(existing.id).count();
      if (txCount > 0) {
        throw new ValidationError(
          `Currency can't be changed: this account has ${txCount} transaction${
            txCount === 1 ? '' : 's'
          } recorded in ${existing.currency}. Create a new ${currency} account instead.`,
        );
      }
    }

    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const all = await db.accounts.toArray();
      sortOrder = all.reduce((m, a) => Math.max(m, a.sortOrder), -1) + 1;
    }

    const account: Account = {
      // Preserves fields this form does not edit: the optional loan fields and
      // excludeFromNetWorth. Renaming an account must never silently pull an
      // excluded property back into net worth.
      ...existing,
      id: existing?.id ?? uid(),
      name,
      type: input.type,
      currency,
      openingBalanceMinor: input.openingBalanceMinor,
      colour,
      groupId,
      sortOrder,
      archived: input.archived ?? existing?.archived ?? false,
    };
    await db.accounts.put(account);
    return account;
  });
}

/** Archive/unarchive without touching any other field. */
export async function setAccountArchived(id: string, archived: boolean): Promise<void> {
  const updated = await db.accounts.update(id, { archived });
  if (updated === 0) throw new ValidationError('Account not found');
}

/**
 * Delete an account. Blocked ({ok:false, reason}) while any transaction
 * references it — archive instead. Deleting an already-missing id is a no-op.
 */
export async function deleteAccount(id: string): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction('rw', db.accounts, db.transactions, async () => {
    const account = await db.accounts.get(id);
    if (!account) return { ok: true };
    const txCount = await db.transactions.where('accountId').equals(id).count();
    if (txCount > 0) {
      return {
        ok: false,
        reason: `it has ${txCount} transaction${txCount === 1 ? '' : 's'} — archive it instead`,
      };
    }
    await db.accounts.delete(id);
    return { ok: true };
  });
}

/**
 * Swap an account one place up/down among the accounts of the SAME group
 * (sidebar order). Sort orders of the whole sibling list are normalised to
 * 0..n-1 so duplicates from imports can't make reordering a no-op.
 */
export async function reorderAccount(id: string, direction: 'up' | 'down'): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    const account = await db.accounts.get(id);
    if (!account) throw new ValidationError('Account not found');
    // groupId can be null — IndexedDB indexes never contain null, so filter().
    const siblings = (await db.accounts.toArray())
      .filter((a) => a.groupId === account.groupId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const i = siblings.findIndex((a) => a.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= siblings.length) return; // already at the edge
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    for (let k = 0; k < siblings.length; k++) {
      if (siblings[k].sortOrder !== k) await db.accounts.update(siblings[k].id, { sortOrder: k });
    }
  });
}

export interface SaveGroupInput {
  id?: string; // present = rename
  name: string;
  sortOrder?: number;
}

/** Create or rename an account group. Throws ValidationError on bad input. */
export async function saveGroup(input: SaveGroupInput): Promise<AccountGroup> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new ValidationError('Group name cannot be empty');
  return db.transaction('rw', db.accountGroups, async () => {
    const existing = input.id ? await db.accountGroups.get(input.id) : undefined;
    if (input.id && !existing) throw new ValidationError('Group not found');
    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const all = await db.accountGroups.toArray();
      sortOrder = all.reduce((m, g) => Math.max(m, g.sortOrder), -1) + 1;
    }
    const group: AccountGroup = { id: existing?.id ?? uid(), name, sortOrder };
    await db.accountGroups.put(group);
    return group;
  });
}

/**
 * Delete a group — only when no account references it ({ok:false, reason}
 * otherwise). Accounts are never deleted or moved by this call.
 */
export async function deleteGroup(id: string): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction('rw', db.accountGroups, db.accounts, async () => {
    const used = await db.accounts.where('groupId').equals(id).count();
    if (used > 0) {
      return {
        ok: false,
        reason: `it still contains ${used} account${used === 1 ? '' : 's'}`,
      };
    }
    await db.accountGroups.delete(id);
    return { ok: true };
  });
}

// ===========================================================================
// MoneyWiz-style grouping (SPEC §4 sidebar "account groups", §8.1.1)
//
// WHY THIS EXISTS: MoneyWiz's Report CSV export carries no account type and no
// grouping, so a real 58-account import lands as one flat list of type
// 'current'. Everything below only ever writes `groupId`, `type` and
// `sortOrder` — three ORGANISATIONAL fields.
//
// THE RULE THAT OUTRANKS EVERYTHING HERE: grouping and typing must never
// change a balance, an amount, a transaction or net worth, and must be
// reversible from the UI. That holds structurally, not by promise:
//   * `openingBalanceMinor`, `currency`, `name` and the transactions table are
//     never touched by any function in this section (asserted in
//     tests/accounts-grouping.test.ts).
//   * `type` is display-only in this app — balances (src/domain/balances.ts)
//     and every report aggregate ignore it; it drives labels and the default
//     colour, nothing arithmetic.
//   * Every write is a single field the user can set back by hand in the
//     account editor / group list.
//
// The classifier is a name matcher, not an oracle. When a signal is weak it
// says so (`confident: false`) so the UI can ask rather than assert something
// about someone's money that it cannot know from a string.
// ===========================================================================

/**
 * The canonical group names, in sidebar order: money you can spend first,
 * obligations and oddments last — how MoneyWiz's sidebar reads. New groups
 * created by autoGroupAccounts() get their sortOrder from this sequence.
 * Exported so the UI uses the same strings the classifier emits.
 */
export const ACCOUNT_GROUP_ORDER: readonly string[] = [
  'Cash',
  'Bank Accounts',
  'Savings',
  'Credit Cards',
  'Loans',
  'Investments & Assets',
  'Foreign Currency',
  'Gift Cards & Vouchers',
  'Money Lent & Owed',
  'Other Accounts',
];

export interface GroupingSuggestion {
  accountId: string;
  name: string;
  currentType: AccountType;
  suggestedType: AccountType;
  suggestedGroup: string;
  /** false ⇒ only a weak/ambiguous signal matched: show it for review. */
  confident: boolean;
}

/**
 * Normalise a name to ' word word word ' — lowercased, every run of
 * non-alphanumerics collapsed to a single space, padded with spaces at both
 * ends. The padding is what makes `includes(' isa ')` a WHOLE-WORD test, so
 * "Lisa" and "Visa" can never be mistaken for an ISA, and "Flowers" can never
 * look like "owe". Punctuation folding also makes "Priya's" → "priya s" and
 * "Cash (Notes)" → "cash notes".
 */
const norm = (name: string): string =>
  ` ${name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Whole-word (or whole-phrase) test against a normalised name. */
const has = (n: string, words: readonly string[]): boolean =>
  words.some((w) => n.includes(` ${w} `));

// --- signal vocabularies ---------------------------------------------------
// Each list is matched whole-word. Order of the CHECKS (not of these lists) is
// what disambiguates; see inferTypeFrom below.
//
// The example names quoted in the comments below are SYNTHETIC — this repo is
// public, so no real account name goes in it (see DECISIONS.md D38). They keep
// the SHAPE of the real names these rules were tuned against, which is the part
// that explains why each rule exists; invent the same shape if you add one.

/** Stored-value cards. Checked before credit so "Amazon Gift card" is not a credit card. */
const GIFT = ['gift', 'gifts', 'giftcard', 'voucher', 'vouchers', 'itunes', 'eneba'] as const;

/** Personal lending ledgers — an IOU in either direction. */
const LENDING = [
  'borrowed',
  'borrow',
  'borrowing',
  'lent',
  'lend',
  'loaned',
  'owe',
  'owed',
  'owes',
  'owing',
  'iou',
  'need to give',
  'give back',
  'to be repaid',
  'repay',
] as const;

/** Unambiguous credit products (brands included: these are cards, full stop). */
const CREDIT_STRONG = [
  'credit',
  'creditcard',
  'amex',
  'american express',
  'mbna',
  'aqua',
  'barclaycard',
  'vanquis',
  'capital one',
] as const;

/**
 * Weak credit hints. 'card' alone can be a debit or prepaid card; 'rewards'
 * alone is the whole reason this tier exists (see the rewards note below).
 */
const CREDIT_WEAK = ['card', 'cards', 'reward', 'rewards', 'visa', 'mastercard', 'cashback'] as const;

/**
 * Savings signals. 'server' is deliberate: in the source book it was a
 * consistent typo for "saver" ("NATWEST REWARDS SERVER", "Flexible Server"),
 * and no personal-finance account is ever a web server.
 */
const SAVINGS = [
  'saver',
  'savers',
  'server',
  'saving',
  'savings',
  'isa',
  'bonus',
  'bonous',
  'vault',
  'interest',
  'deposit',
  'deposits',
  'rainy day',
  'instant access',
  'easy access',
  'fixed rate',
  'nest egg',
  'emergency fund',
] as const;

const LOAN = ['loan', 'loans', 'mortgage', 'mortgages', 'finance', 'financing', 'hire purchase'] as const;

/** Unambiguous investment signals. */
const INVESTMENT_STRONG = [
  'trading',
  'invest',
  'invests',
  'invested',
  'investment',
  'investments',
  'stocks',
  'shares',
  'equities',
  'portfolio',
  'brokerage',
  'etf',
  'crypto',
  'bitcoin',
] as const;

/**
 * Weak investment signals: a commodity word alone. "Gold" might be bullion, an
 * Amex Gold card or a bank's "Gold" account tier — the honest answer is to
 * suggest Investments & Assets and flag it for review.
 */
const INVESTMENT_WEAK = ['gold', 'silver', 'bullion', 'platinum'] as const;

const CASH = [
  'cash',
  'coins',
  'coin',
  'notes',
  'wallet',
  'purse',
  'locker',
  'suitcase',
  'petty cash',
  'pocket money',
] as const;

/** Banks and e-money brands — evidence that a 'current' account is a BANK account. */
const BANK_BRANDS = [
  'hsbc',
  'barclays',
  'barclay',
  'halifax',
  'lloyds',
  'natwest',
  'rbs',
  'santander',
  'nationwide',
  'tsb',
  'metro',
  'revolut',
  'wise',
  'transferwise',
  'monzo',
  'starling',
  'paypal',
  'first direct',
  'firstdirect',
  'chase',
  'monese',
  'n26',
  'curve',
  'skrill',
  'payoneer',
  'bank of scotland',
  'virgin money',
  'marcus',
  'kroo',
  'zopa',
  'atom',
  'tandem',
  'triodos',
  'clydesdale',
  'yorkshire',
  'ulster',
  'danske',
  'hnb',
  'boc',
  'sampath',
  'icici',
  'sbi',
  'hdfc',
] as const;

/** Generic banking words — enough to file an account under Bank Accounts. */
const BANK_WORDS = [
  'account',
  'accounts',
  'bank',
  'banking',
  'current',
  'checking',
  'chequing',
  'cheque',
  'giro',
  'debit',
  'everyday',
  'joint',
  'salary',
] as const;

const STREET_WORDS = [
  'road',
  'rd',
  'street',
  'st',
  'drive',
  'avenue',
  'ave',
  'lane',
  'close',
  'court',
  'crescent',
  'way',
  'gardens',
  'terrace',
  'place',
  'grove',
  'mews',
  'square',
  'villas',
  'villa',
  'house',
  'flat',
  'apartment',
  'property',
  'plot',
] as const;

/**
 * A house number followed by a street word ("14 Alder Grove") — a
 * property held as an asset. Both halves are required: the number alone would
 * catch "1st Account", the street word alone would catch far too much.
 */
const looksLikeProperty = (n: string): boolean => /^ \d+[a-z]? /.test(n) && has(n, STREET_WORDS);

/**
 * Type from a normalised name, with a confidence flag.
 *
 * ORDER IS THE ALGORITHM — most specific wins, and the checks below are
 * arranged so that the interesting collisions in real data resolve correctly:
 *
 *  1. Gift cards before credit, or "Amazon Gift card" becomes a credit card
 *     purely because it contains the word "card".
 *  2. Lending before everything else, because "…Borrowed" describes what the
 *     account IS, whatever product words trail after it.
 *  3. STRONG credit before savings, so "Lloyds Premier Credit" is a card even
 *     though nothing else in the name says so; and so "American Express
 *     Platinum" is a card, not bullion.
 *  4. Savings before WEAK credit — this is the rewards case. "NATWEST REWARDS
 *     SERVER" (server = saver) is a savings account, while "Lloyds rewards" and
 *     "Natwest Blue Rewards" are credit products. A bare 'rewards' therefore
 *     never decides a type on its own: it only lands at step 9, after every
 *     strong signal has had its say, and when it does decide it reports
 *     confident:false so the UI asks.
 *  5. Savings before cash, so "TSB VARIABLE RATE CASH ISA" is savings.
 *  6. Savings before investment, so a stocks-and-shares ISA is filed as
 *     savings — 'isa' is genuinely ambiguous and savings is the safer guess.
 *
 * Anything with no signal at all is 'current' (the app's neutral default) with
 * confident:false — "unsure" must never masquerade as "current account".
 */
function inferTypeFrom(n: string): { type: AccountType; confident: boolean } {
  if (has(n, GIFT)) return { type: 'current', confident: false }; // 1
  if (has(n, LENDING)) return { type: 'current', confident: false }; // 2
  if (has(n, CREDIT_STRONG)) return { type: 'credit_card', confident: true }; // 3
  if (has(n, SAVINGS)) return { type: 'savings', confident: true }; // 4,5,6
  if (has(n, LOAN)) return { type: 'loan', confident: true };
  if (has(n, INVESTMENT_STRONG)) return { type: 'investment', confident: true };
  if (has(n, CASH)) return { type: 'cash', confident: true };
  if (has(n, INVESTMENT_WEAK) || looksLikeProperty(n)) return { type: 'investment', confident: false };
  if (has(n, CREDIT_WEAK)) return { type: 'credit_card', confident: false }; // 9
  if (has(n, BANK_BRANDS) || has(n, BANK_WORDS)) return { type: 'current', confident: true };
  return { type: 'current', confident: false };
}

/**
 * Group from a normalised name + type + currency, with a confidence flag.
 *
 * PRECEDENCE, most specific first — purpose beats currency, currency beats
 * type:
 *  1. Gift-card signals → 'Gift Cards & Vouchers'. Beats currency because an
 *     iTunes balance in TRY is a gift card the owner thinks of as a gift card,
 *     not as "foreign money".
 *  2. Lending signals → 'Money Lent & Owed'. Same reasoning: "Priya's Sister
 *     Borrowed (LKR)" is an IOU first and a rupee balance second.
 *  3. currency ≠ base currency → 'Foreign Currency'. This is the fallback for
 *     accounts whose only distinguishing feature is the money they hold
 *     ("STARLING INDIAN CURRENCY"), so it outranks the type map.
 *  4. Otherwise the type decides — except that a 'current' account only earns
 *     'Bank Accounts' if the name actually names a bank or says "account".
 *     Everything else falls to 'Other Accounts', flagged for review, because
 *     "Work Float" or "Lost In A Venture" are not bank accounts and pretending
 *     otherwise buries them in the wrong part of the sidebar.
 */
function groupFrom(
  n: string,
  type: AccountType,
  currency: string,
  baseCurrency: string,
): { group: string; confident: boolean } {
  if (has(n, GIFT)) return { group: 'Gift Cards & Vouchers', confident: true };
  if (has(n, LENDING)) return { group: 'Money Lent & Owed', confident: true };
  const cur = currency.trim().toUpperCase();
  const base = baseCurrency.trim().toUpperCase();
  if (cur && base && cur !== base) return { group: 'Foreign Currency', confident: true };
  switch (type) {
    case 'cash':
      return { group: 'Cash', confident: true };
    case 'savings':
      return { group: 'Savings', confident: true };
    case 'credit_card':
      return { group: 'Credit Cards', confident: true };
    case 'loan':
      return { group: 'Loans', confident: true };
    case 'investment':
      return { group: 'Investments & Assets', confident: true };
    case 'current':
      return has(n, BANK_BRANDS) || has(n, BANK_WORDS)
        ? { group: 'Bank Accounts', confident: true }
        : { group: 'Other Accounts', confident: false };
  }
}

/** Pure. Best-guess account type from its name. Conservative: returns 'current' when unsure. */
export function inferAccountType(name: string): AccountType {
  return inferTypeFrom(norm(name)).type;
}

/** Pure. Which MoneyWiz-style group an account belongs in, from its name, inferred type and currency. */
export function suggestGroupFor(
  name: string,
  type: AccountType,
  currency: string,
  baseCurrency: string,
): string {
  return groupFrom(norm(name), type, currency, baseCurrency).group;
}

/**
 * The one plan both preview and apply use, so what the user is shown is
 * exactly what happens.
 *
 * A stored type other than 'current' is treated as a deliberate statement and
 * is never contradicted: 'current' is both the app's default and what a
 * MoneyWiz Report import falls back to, so it is the only value we read as
 * "nobody has said yet".
 */
function planFor(
  account: Account,
  baseCurrency: string,
): { type: AccountType; group: string; confident: boolean } {
  const n = norm(account.name);
  const t =
    account.type === 'current'
      ? inferTypeFrom(n)
      : { type: account.type, confident: true as const };
  const g = groupFrom(n, t.type, account.currency, baseCurrency);
  return { type: t.type, group: g.group, confident: t.confident && g.confident };
}

/**
 * Read-only: what autoGroupAccounts would do. Never writes.
 *
 * Returns one entry per account — INCLUDING accounts that already sit in a
 * group — so the UI can render the whole plan and offer "regroup everything".
 * `autoGroupAccounts()` with its default `onlyUngrouped: true` acts only on the
 * entries whose account currently has `groupId === null`; the caller has the
 * accounts to hand and can filter on that.
 *
 * Sorted by canonical group order, then name — directly renderable as the
 * grouped sidebar the user is about to get.
 */
export async function previewAutoGrouping(): Promise<GroupingSuggestion[]> {
  const { baseCurrency } = await getSettings();
  const accounts = await db.accounts.toArray();
  return accounts
    .map((a) => {
      const plan = planFor(a, baseCurrency);
      return {
        accountId: a.id,
        name: a.name,
        currentType: a.type,
        suggestedType: plan.type,
        suggestedGroup: plan.group,
        confident: plan.confident,
      };
    })
    .sort(
      (x, y) =>
        ACCOUNT_GROUP_ORDER.indexOf(x.suggestedGroup) -
          ACCOUNT_GROUP_ORDER.indexOf(y.suggestedGroup) || x.name.localeCompare(y.name),
    );
}

/**
 * Applies grouping. Creates missing groups, assigns groupId, and optionally
 * corrects types. All writes happen in ONE transaction.
 *
 *  * `onlyUngrouped` (DEFAULT true) — only touch accounts with no group. A
 *    file the user has already made is a deliberate choice; never re-file it.
 *  * `applyTypes` (default false) — also write the suggested type, but only
 *    where the stored type is still 'current' (see planFor): an explicitly
 *    chosen type is never overwritten, so preview and apply always agree.
 *  * IDEMPOTENT: a second run reports { 0, 0, 0 } under either option, because
 *    counters only count writes that actually change a value.
 *  * An existing group whose name matches a canonical one (case/whitespace
 *    insensitively) is REUSED — never duplicated — and its sortOrder is left
 *    alone so a manual moveGroup() ordering survives.
 *  * openingBalanceMinor, currency, name, colour, archived, account sortOrder
 *    and every transaction are untouched.
 */
export async function autoGroupAccounts(
  opts: { applyTypes?: boolean; onlyUngrouped?: boolean } = {},
): Promise<{ groupsCreated: number; accountsGrouped: number; typesChanged: number }> {
  const applyTypes = opts.applyTypes ?? false;
  const onlyUngrouped = opts.onlyUngrouped ?? true;
  // Read settings before opening the write transaction: db.settings is then
  // not part of its scope, which keeps the transaction to the two tables it
  // is allowed to write.
  const { baseCurrency } = await getSettings();

  return db.transaction('rw', db.accounts, db.accountGroups, async () => {
    const all = await db.accounts.toArray();
    const scope = onlyUngrouped ? all.filter((a) => (a.groupId ?? null) === null) : all;
    const plans = scope.map((a) => ({ account: a, ...planFor(a, baseCurrency) }));

    const existing = await db.accountGroups.toArray();
    const byName = new Map(existing.map((g) => [nameKey(g.name), g]));
    // New groups are appended after whatever already exists (so an existing
    // arrangement keeps its place) but in canonical order among themselves —
    // on a flat import with no groups at all that is exactly 0..9.
    const base = existing.reduce((m, g) => Math.max(m, g.sortOrder), -1) + 1;

    const wanted = new Set(plans.map((p) => p.group));
    const idByName = new Map<string, string>();
    let groupsCreated = 0;
    for (const name of ACCOUNT_GROUP_ORDER) {
      if (!wanted.has(name)) continue;
      const found = byName.get(nameKey(name));
      if (found) {
        idByName.set(name, found.id);
        continue;
      }
      const group: AccountGroup = {
        id: uid(),
        name,
        sortOrder: base + ACCOUNT_GROUP_ORDER.indexOf(name),
      };
      await db.accountGroups.add(group);
      idByName.set(name, group.id);
      groupsCreated += 1;
    }

    let accountsGrouped = 0;
    let typesChanged = 0;
    for (const plan of plans) {
      const groupId = idByName.get(plan.group);
      if (!groupId) continue; // unreachable: every wanted group was resolved above
      const patch: Partial<Account> = {};
      if ((plan.account.groupId ?? null) !== groupId) {
        patch.groupId = groupId;
        accountsGrouped += 1;
      }
      if (applyTypes && plan.type !== plan.account.type) {
        patch.type = plan.type;
        typesChanged += 1;
      }
      if (Object.keys(patch).length > 0) await db.accounts.update(plan.account.id, patch);
    }
    return { groupsCreated, accountsGrouped, typesChanged };
  });
}

/**
 * Move one account to a group (or null for ungrouped). The account lands at
 * the BOTTOM of the destination group (sortOrder = last + 1) so the move is
 * visible and predictable; nothing else about the account changes. Already in
 * that group ⇒ no write at all.
 */
export async function setAccountGroup(accountId: string, groupId: string | null): Promise<void> {
  await db.transaction('rw', db.accounts, db.accountGroups, async () => {
    const account = await db.accounts.get(accountId);
    if (!account) throw new ValidationError('Account not found');
    const target = groupId ?? null;
    if (target && !(await db.accountGroups.get(target))) {
      throw new ValidationError('Account group not found');
    }
    if ((account.groupId ?? null) === target) return; // no-op: keeps this idempotent
    // groupId can be null — IndexedDB indexes never contain null, so filter().
    const siblings = (await db.accounts.toArray()).filter(
      (a) => a.id !== accountId && (a.groupId ?? null) === target,
    );
    const sortOrder = siblings.reduce((m, a) => Math.max(m, a.sortOrder), -1) + 1;
    await db.accounts.update(accountId, { groupId: target, sortOrder });
  });
}

/**
 * Reorder a group among its peers: swap sortOrder with the neighbour above or
 * below, then normalise every group to 0..n-1 so duplicate sortOrders (from an
 * import, or from two groups created at 90/91) can't make a move a no-op.
 * A move off either end does nothing.
 */
export async function moveGroup(groupId: string, direction: 'up' | 'down'): Promise<void> {
  await db.transaction('rw', db.accountGroups, async () => {
    const groups = (await db.accountGroups.toArray()).sort(
      (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
    const i = groups.findIndex((g) => g.id === groupId);
    if (i < 0) throw new ValidationError('Group not found');
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= groups.length) return; // already at the edge
    [groups[i], groups[j]] = [groups[j], groups[i]];
    for (let k = 0; k < groups.length; k++) {
      if (groups[k].sortOrder !== k) await db.accountGroups.update(groups[k].id, { sortOrder: k });
    }
  });
}

// ===========================================================================
// Exclude from net worth (SPEC §6 — "changes what a total counts, nothing else")
// ===========================================================================
//
// The flag lives on the ACCOUNT (Account.excludeFromNetWorth in db/types.ts,
// where the full reasoning is written down) and is the single source of truth.
// Both writers below touch that ONE field and nothing else: no balance, no
// amount, no transaction, no archived state, no sort order can move as a
// result of calling them — which is what makes "exclude" one-click reversible.
// Netting them out of the totals happens at read time in
// domain/balances.ts (netWorth) and reports/aggregate.ts (netWorthSeries).

/**
 * Exclude/include ONE account. Idempotent: setting the value it already has
 * writes nothing. Unknown id ⇒ ValidationError.
 */
export async function setAccountExcluded(accountId: string, excluded: boolean): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    const account = await db.accounts.get(accountId);
    if (!account) throw new ValidationError('Account not found');
    if ((account.excludeFromNetWorth ?? false) === excluded) return;
    await db.accounts.update(accountId, { excludeFromNetWorth: excluded });
  });
}

/**
 * BULK ACTION: set the flag on every account CURRENTLY in this group, and
 * report how many accounts actually changed (accounts already in the requested
 * state are left untouched and not counted).
 *
 * This is a snapshot, not a standing rule — there is no group-level flag to
 * keep in sync, so an account moved into the group afterwards keeps whatever
 * setting it had. That is the deliberate design: one source of truth per
 * account, and "un-exclude this one account inside an excluded group" has an
 * obvious meaning. Archived members are flagged too: they are already out of
 * the total, and flagging them keeps the group consistent if one is later
 * un-archived. Undoing is the same call with `excluded` inverted.
 */
export async function setGroupExcluded(
  groupId: string,
  excluded: boolean,
): Promise<{ accountsChanged: number }> {
  return db.transaction('rw', db.accountGroups, db.accounts, async () => {
    const group = await db.accountGroups.get(groupId);
    if (!group) throw new ValidationError('Account group not found');
    const members = await db.accounts.where('groupId').equals(groupId).toArray();
    let accountsChanged = 0;
    for (const a of members) {
      if ((a.excludeFromNetWorth ?? false) === excluded) continue;
      await db.accounts.update(a.id, { excludeFromNetWorth: excluded });
      accountsChanged += 1;
    }
    return { accountsChanged };
  });
}
