// Oracle: account balances and net worth (src/domain/balances.ts, SPEC §6).
//
// Two separate questions, and conflating them is the classic bug:
//   1. WHAT IS THIS ACCOUNT WORTH?  — always opening + Σ its transactions.
//      Nothing ever changes this figure. Not archiving it, not excluding it.
//   2. WHAT GOES INTO THE TOTAL?    — countsTowardNetWorth(): not archived AND
//      not flagged excludeFromNetWorth.
// A port that implements exclusion by zeroing or hiding the balance passes
// every net-worth case here and fails every accountBalances one.
//
// Pending transactions COUNT in balanceMinor (D15) and are the difference
// between it and clearedMinor. A missing rate removes a currency from the
// TOTAL and is named in missingRateCurrencies — the money is never guessed at
// and never silently dropped.
import { accountBalances, balanceFromAmounts, countsTowardNetWorth, netWorth } from '../../../src/domain/balances';
import type { Account } from '../../../src/db/types';
import { loadBook, materialiseBook, type Book } from '../book';
import { EXCLUSIONS_BOOK, EXCLUSIONS_SIMPLE_BOOK, GOLDEN_BOOK, ROLLUP_BOOK } from '../books';
import { Cases, ORACLE_VERSION, type OracleFile } from '../oracle';

/**
 * Project AccountBalance onto the fields a re-implementation must reproduce.
 * The full record carries the whole Account row (colour, groupId, …), which is
 * storage detail, not arithmetic — putting it in the fixture would demand a
 * Swift port have columns it may not need.
 */
async function balanceRows(): Promise<unknown[]> {
  return (await accountBalances()).map((b) => ({
    accountId: b.account.id,
    name: b.account.name,
    currency: b.account.currency,
    balanceMinor: b.balanceMinor,
    clearedMinor: b.clearedMinor,
    txCount: b.txCount,
    excludedFromNetWorth: b.excludedFromNetWorth,
  }));
}

const netWorthShape = async (): Promise<unknown> => {
  const nw = await netWorth();
  return {
    totalBaseMinor: nw.totalBaseMinor,
    baseCurrency: nw.baseCurrency,
    missingRateCurrencies: nw.missingRateCurrencies,
    excludedCount: nw.excludedCount,
    excludedBaseMinor: nw.excludedBaseMinor,
  };
};

const account = (over: Partial<Account>): Account => ({
  id: 'a', name: 'A', type: 'current', currency: 'GBP', openingBalanceMinor: 0,
  colour: '#000', groupId: null, sortOrder: 0, archived: false, ...over,
});

export async function balancesSuite(): Promise<OracleFile> {
  const c = new Cases();
  const books: Record<string, Book> = {
    golden: materialiseBook(GOLDEN_BOOK),
    exclusions: materialiseBook(EXCLUSIONS_BOOK),
    'exclusions-simple': materialiseBook(EXCLUSIONS_SIMPLE_BOOK),
    rollup: materialiseBook(ROLLUP_BOOK),
  };

  // ------------------------------------------------------------ pure core
  const sums: [string, number, number[], number, string][] = [
    ['plain', 100_000, [-4_567, -5_433], 90_000, 'opening plus the signed amounts, nothing else'],
    ['empty', 50_000, [], 50_000, 'an account with no transactions is worth its opening balance'],
    ['negative', 0, [-1_000, -2_000], -3_000, 'a balance may be negative (a credit card)'],
    ['back-to-zero', 1_000, [-1_000], 0, 'exact cancellation is exactly zero'],
  ];
  for (const [slug, opening, amounts, expected, describes] of sums) {
    c.hand(
      `balances.sum.${slug}`, describes, 'balances.balanceFromAmounts',
      { openingMinor: opening, amounts },
      { value: balanceFromAmounts(opening, amounts) },
      { value: expected },
    );
  }

  const counts: [string, boolean, boolean, boolean, string][] = [
    ['plain', false, false, true, 'an ordinary account counts'],
    ['archived', true, false, false, 'an archived (retired) account does not'],
    ['excluded', false, true, false, 'a “show it, don’t count it” account does not'],
    ['both', true, true, false, 'the two reasons compose — either one is enough to leave it out'],
  ];
  for (const [slug, archived, excluded, expected, describes] of counts) {
    c.hand(
      `balances.counts.${slug}`, describes, 'balances.countsTowardNetWorth',
      { account: { archived, excludeFromNetWorth: excluded } },
      { value: countsTowardNetWorth(account({ archived, excludeFromNetWorth: excluded })) },
      { value: expected },
    );
  }
  c.hand(
    'balances.counts.flag-absent',
    'a row written before the exclusion flag existed (the key is simply absent) counts — undefined resolves to false',
    'balances.countsTowardNetWorth',
    { account: { archived: false } },
    { value: countsTowardNetWorth(account({})) },
    { value: true },
  );

  // -------------------------------------------------------- golden month
  // Hand calculation, from the comment block of tests/golden.test.ts:
  //   Current = 100000 +250000 -4567 -5433 -10000 +1000 -20000 -3000 = 308000
  //   Savings = 50000 +20000                                         =  70000
  //   Holiday = 20000 -2000                                          =  18000 (EUR)
  //   Net worth = 308000 + 70000 + (18000 × 0.85 = 15300)            = 393300
  await loadBook(books.golden);
  c.hand(
    'balances.golden.accounts',
    'the golden month’s three account balances, hand-calculated: £3,080.00 current (the £30 pending included), £700.00 savings, €180.00 holiday in its OWN currency',
    'balances.accountBalances',
    { book: 'golden' },
    { rows: await balanceRows() },
    {
      rows: [
        { accountId: 'cur', name: 'Current', currency: 'GBP', balanceMinor: 308_000, clearedMinor: 311_000, txCount: 7, excludedFromNetWorth: false },
        { accountId: 'sav', name: 'Savings', currency: 'GBP', balanceMinor: 70_000, clearedMinor: 70_000, txCount: 1, excludedFromNetWorth: false },
        { accountId: 'hol', name: 'Holiday', currency: 'EUR', balanceMinor: 18_000, clearedMinor: 18_000, txCount: 1, excludedFromNetWorth: false },
      ],
    },
    { carriedFrom: 'tests/golden.test.ts', note: 'clearedMinor excludes the £30.00 pending Uber: 308000 + 3000 = 311000. A balance is NEVER converted — the holiday account is €180.00.' },
  );
  c.hand(
    'balances.golden.net-worth',
    'net worth converts the EUR account once, at 0.85, and totals £3,933.00',
    'balances.netWorth',
    { book: 'golden' },
    await netWorthShape(),
    {
      totalBaseMinor: 393_300,
      baseCurrency: 'GBP',
      missingRateCurrencies: [],
      excludedCount: 0,
      excludedBaseMinor: 0,
    },
    { carriedFrom: 'tests/golden.test.ts' },
  );

  // ---------------------------------------------------------- exclusions
  await loadBook(books.exclusions);
  c.hand(
    'balances.exclusions.accounts',
    'every account keeps its own real balance — archiving and excluding change what the TOTAL counts, never what an account is worth',
    'balances.accountBalances',
    { book: 'exclusions' },
    { rows: await balanceRows() },
    {
      rows: [
        { accountId: 'a-main', name: 'Main', currency: 'GBP', balanceMinor: 97_500, clearedMinor: 100_000, txCount: 1, excludedFromNetWorth: false },
        { accountId: 'a-arch', name: 'Old ISA', currency: 'GBP', balanceMinor: 499_000, clearedMinor: 499_000, txCount: 1, excludedFromNetWorth: false },
        { accountId: 'a-excl', name: 'Gift Cards', currency: 'GBP', balanceMinor: 21_000, clearedMinor: 21_000, txCount: 1, excludedFromNetWorth: true },
        { accountId: 'a-usd', name: 'Dollar Pot', currency: 'USD', balanceMinor: 10_000, clearedMinor: 10_000, txCount: 0, excludedFromNetWorth: false },
        { accountId: 'a-chf', name: 'Swiss Pot', currency: 'CHF', balanceMinor: 20_000, clearedMinor: 20_000, txCount: 0, excludedFromNetWorth: false },
        { accountId: 'a-excl-chf', name: 'Lent to Ana', currency: 'CHF', balanceMinor: 5_000, clearedMinor: 5_000, txCount: 0, excludedFromNetWorth: true },
      ],
    },
    { note: 'Rows come back in sortOrder, then name. Main is £1,000.00 minus a £25.00 PENDING charge, so balanceMinor and clearedMinor differ.' },
  );
  c.hand(
    'balances.exclusions.net-worth',
    'the total is £975.00 + $100.00×0.79 = £1,054.00; CHF is named as missing rather than dropped in silence, and the “not counted” total REFUSES to be a number because one excluded account cannot be converted',
    'balances.netWorth',
    { book: 'exclusions' },
    await netWorthShape(),
    {
      totalBaseMinor: 105_400,
      baseCurrency: 'GBP',
      missingRateCurrencies: ['CHF'],
      excludedCount: 2,
      excludedBaseMinor: null,
    },
    { note: 'excludedBaseMinor null is the honest answer, not an error: a partial “not counted” figure would silently omit an account. Archived accounts are not in excludedCount even when flagged — they are already out for an older reason.' },
  );

  await loadBook(books['exclusions-simple']);
  c.hand(
    'balances.exclusions-simple.net-worth',
    'with every excluded account convertible, the “not counted” figure is a real number: £250.00 sitting outside a £1,000.00 total',
    'balances.netWorth',
    { book: 'exclusions-simple' },
    await netWorthShape(),
    {
      totalBaseMinor: 100_000,
      baseCurrency: 'GBP',
      missingRateCurrencies: [],
      excludedCount: 1,
      excludedBaseMinor: 25_000,
    },
  );

  // ------------------------------------------------------- wider scenario
  await loadBook(books.rollup);
  c.derived(
    'balances.rollup.accounts',
    'the reports book’s balances: both legs of a transfer move real money, and a transaction in an unrated currency still changes its own account’s balance',
    'balances.accountBalances',
    { book: 'rollup' },
    { rows: await balanceRows() },
  );
  c.derived(
    'balances.rollup.net-worth',
    'net worth over that book: the CHF account has no rate, so CHF is named and its money is left out of the total entirely',
    'balances.netWorth',
    { book: 'rollup' },
    await netWorthShape(),
  );

  return {
    oracleVersion: ORACLE_VERSION,
    area: 'balances',
    title: 'Balances: per-account, cleared vs pending, and net worth with exclusions',
    generatedFrom: ['src/domain/balances.ts'],
    notes: [
      'balanceMinor = openingBalanceMinor + Σ(all that account’s transactions), pending included (D15).',
      'clearedMinor is the same sum over cleared transactions only.',
      'An account balance is always in the ACCOUNT’s currency and is never converted.',
      'Net worth counts an account iff it is neither archived nor flagged excludeFromNetWorth; each counted account is converted to base ONCE.',
      'A currency with no rate to base is named in missingRateCurrencies and contributes nothing — it is never approximated.',
      'excludedBaseMinor is null when any excluded account cannot be converted: an incomplete “not counted” total would be a wrong number.',
      'balances.accountBalances rows are ordered by sortOrder, then by name.',
    ],
    books,
    cases: c.list,
  };
}
