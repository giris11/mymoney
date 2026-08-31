// The books the balance/budget/report fixtures are computed over.
//
// GOLDEN_BOOK is tests/golden.test.ts's scenario restated as data. That test
// is SPEC §12's golden month: one realistic month whose every figure is worked
// out by hand in a comment block at the top of the file. Restating it here as
// explicit rows (rather than replaying saveTransaction/saveTransfer, which
// mint random ids and timestamps) is what makes it emittable — and the
// hand-calculated figures in suites/balances.ts and suites/reports.ts are
// copied from that comment block, not from any function's output.
import type { BookSource } from './book';

/**
 * August 2026, base GBP. Current (opens £1,000.00), Savings (opens £500.00),
 * Holiday in EUR (opens €200.00), manual rate 1 EUR = 0.85 GBP.
 *
 *   01/08 salary            +£2,500.00  Current   [Salary]      Acme Ltd
 *   03/08 groceries            -£45.67  Current   [Groceries]   Tesco
 *   10/08 groceries            -£54.33  Current   [Groceries]   Tesco
 *   12/08 split               -£100.00  Current                 Big Shop
 *                                        └ Groceries -£60.00, Transport -£40.00
 *   15/08 refund               +£10.00  Current   [Groceries]   Tesco
 *   20/08 transfer   Current → Savings  £200.00   (no category)
 *   22/08 holiday spend        -€20.00  Holiday   [Transport]   Café Paris
 *   25/08 PENDING              -£30.00  Current   [Transport]   Uber
 */
export const GOLDEN_BOOK: BookSource = {
  baseCurrency: 'GBP',
  fxRates: [{ base: 'EUR', quote: 'GBP', rate: 0.85 }],
  accounts: [
    { id: 'cur', name: 'Current', currency: 'GBP', openingBalanceMinor: 100_000, sortOrder: 0 },
    { id: 'sav', name: 'Savings', currency: 'GBP', openingBalanceMinor: 50_000, type: 'savings', sortOrder: 1 },
    { id: 'hol', name: 'Holiday', currency: 'EUR', openingBalanceMinor: 20_000, sortOrder: 2 },
  ],
  categories: [
    { id: 'food', name: 'Food', kind: 'expense', sortOrder: 0 },
    { id: 'groceries', name: 'Groceries', kind: 'expense', parentId: 'food', sortOrder: 0 },
    { id: 'transport', name: 'Transport', kind: 'expense', sortOrder: 1 },
    { id: 'salary', name: 'Salary', kind: 'income', sortOrder: 2 },
  ],
  payees: [
    { id: 'p-acme', name: 'Acme Ltd' },
    { id: 'p-tesco', name: 'Tesco' },
    { id: 'p-bigshop', name: 'Big Shop' },
    { id: 'p-uber', name: 'Uber' },
    { id: 'p-cafe', name: 'Café Paris' },
  ],
  transactions: [
    { id: 't1', accountId: 'cur', date: '2026-08-01', amountMinor: 250_000, categoryId: 'salary', payeeId: 'p-acme' },
    { id: 't2', accountId: 'cur', date: '2026-08-03', amountMinor: -4_567, categoryId: 'groceries', payeeId: 'p-tesco' },
    { id: 't3', accountId: 'cur', date: '2026-08-10', amountMinor: -5_433, categoryId: 'groceries', payeeId: 'p-tesco' },
    {
      id: 't4', accountId: 'cur', date: '2026-08-12', amountMinor: -10_000, payeeId: 'p-bigshop',
      splits: [
        { categoryId: 'groceries', amountMinor: -6_000 },
        { categoryId: 'transport', amountMinor: -4_000 },
      ],
    },
    // A refund: a POSITIVE amount in an EXPENSE category (D14).
    { id: 't5', accountId: 'cur', date: '2026-08-15', amountMinor: 1_000, categoryId: 'groceries', payeeId: 'p-tesco' },
    // The two legs of one transfer share a transferGroupId and have no category.
    { id: 't6', accountId: 'cur', date: '2026-08-20', amountMinor: -20_000, transferGroupId: 'tg1' },
    { id: 't7', accountId: 'sav', date: '2026-08-20', amountMinor: 20_000, transferGroupId: 'tg1' },
    { id: 't8', accountId: 'hol', date: '2026-08-22', amountMinor: -2_000, categoryId: 'transport', payeeId: 'p-cafe' },
    { id: 't9', accountId: 'cur', date: '2026-08-25', amountMinor: -3_000, categoryId: 'transport', payeeId: 'p-uber', status: 'pending' },
  ],
};

/**
 * Every reason an account can be left out of a total, in one book: archived,
 * user-excluded, and unconvertible — plus an account that is BOTH excluded and
 * unconvertible, which is the only way to reach the "we cannot total what is
 * not counted either" answer (excludedBaseMinor: null).
 */
export const EXCLUSIONS_BOOK: BookSource = {
  baseCurrency: 'GBP',
  fxRates: [{ base: 'USD', quote: 'GBP', rate: 0.79 }],
  accounts: [
    { id: 'a-main', name: 'Main', currency: 'GBP', openingBalanceMinor: 100_000, sortOrder: 0 },
    { id: 'a-arch', name: 'Old ISA', currency: 'GBP', openingBalanceMinor: 500_000, archived: true, sortOrder: 1 },
    { id: 'a-excl', name: 'Gift Cards', currency: 'GBP', openingBalanceMinor: 25_000, excludeFromNetWorth: true, sortOrder: 2 },
    { id: 'a-usd', name: 'Dollar Pot', currency: 'USD', openingBalanceMinor: 10_000, sortOrder: 3 },
    { id: 'a-chf', name: 'Swiss Pot', currency: 'CHF', openingBalanceMinor: 20_000, sortOrder: 4 },
    { id: 'a-excl-chf', name: 'Lent to Ana', currency: 'CHF', openingBalanceMinor: 5_000, excludeFromNetWorth: true, sortOrder: 5 },
  ],
  categories: [{ id: 'shopping', name: 'Shopping', kind: 'expense', sortOrder: 0 }],
  transactions: [
    // Spending FROM an excluded account is still spending, and the excluded
    // account still has its own real balance: 25000 - 4000 = 21000.
    { id: 'x1', accountId: 'a-excl', date: '2026-05-04', amountMinor: -4_000, categoryId: 'shopping' },
    { id: 'x2', accountId: 'a-arch', date: '2026-05-04', amountMinor: -1_000, categoryId: 'shopping' },
    { id: 'x3', accountId: 'a-main', date: '2026-05-05', amountMinor: -2_500, categoryId: 'shopping', status: 'pending' },
  ],
};

/** The same book with the unconvertible accounts removed, so the "not counted"
 *  total is a number rather than a refusal. */
export const EXCLUSIONS_SIMPLE_BOOK: BookSource = {
  baseCurrency: 'GBP',
  accounts: [
    { id: 'a-main', name: 'Main', currency: 'GBP', openingBalanceMinor: 100_000, sortOrder: 0 },
    { id: 'a-arch', name: 'Old ISA', currency: 'GBP', openingBalanceMinor: 500_000, archived: true, sortOrder: 1 },
    { id: 'a-excl', name: 'Gift Cards', currency: 'GBP', openingBalanceMinor: 25_000, excludeFromNetWorth: true, sortOrder: 2 },
  ],
};

/**
 * A three-deep category tree with tags, a refund, an uncategorised expense, an
 * uncategorised RECEIPT, a transfer pair, and one transaction in a currency
 * with no rate — everything the flow reports have to classify differently.
 *
 *   Food ─┬─ Dining ── Coffee
 *         └─ Groceries
 *   Transport
 *   Salary (income)
 */
export const ROLLUP_BOOK: BookSource = {
  baseCurrency: 'GBP',
  fxRates: [{ base: 'EUR', quote: 'GBP', rate: 0.85 }],
  accounts: [
    { id: 'r-cur', name: 'Current', currency: 'GBP', openingBalanceMinor: 200_000, sortOrder: 0 },
    { id: 'r-sav', name: 'Savings', currency: 'GBP', openingBalanceMinor: 0, type: 'savings', sortOrder: 1 },
    { id: 'r-eur', name: 'Euro Pot', currency: 'EUR', openingBalanceMinor: 10_000, sortOrder: 2 },
    { id: 'r-chf', name: 'Swiss Pot', currency: 'CHF', openingBalanceMinor: 0, sortOrder: 3 },
  ],
  categories: [
    { id: 'c-food', name: 'Food', kind: 'expense', sortOrder: 0 },
    { id: 'c-dining', name: 'Dining', kind: 'expense', parentId: 'c-food', sortOrder: 0 },
    { id: 'c-coffee', name: 'Coffee', kind: 'expense', parentId: 'c-dining', sortOrder: 0 },
    { id: 'c-groceries', name: 'Groceries', kind: 'expense', parentId: 'c-food', sortOrder: 1 },
    { id: 'c-transport', name: 'Transport', kind: 'expense', sortOrder: 1 },
    { id: 'c-salary', name: 'Salary', kind: 'income', sortOrder: 2 },
  ],
  payees: [
    { id: 'r-p-cafe', name: 'Corner Cafe' },
    { id: 'r-p-shop', name: 'Corner Shop' },
    { id: 'r-p-rail', name: 'Rail Co' },
    { id: 'r-p-work', name: 'Work Ltd' },
  ],
  tags: [
    { id: 'g-work', name: 'work' },
    { id: 'g-treat', name: 'treat' },
  ],
  transactions: [
    // June: income, a three-level spend chain, a refund, a tagged split.
    { id: 'r1', accountId: 'r-cur', date: '2026-06-01', amountMinor: 300_000, categoryId: 'c-salary', payeeId: 'r-p-work' },
    { id: 'r2', accountId: 'r-cur', date: '2026-06-02', amountMinor: -350, categoryId: 'c-coffee', payeeId: 'r-p-cafe', tagIds: ['g-treat'] },
    { id: 'r3', accountId: 'r-cur', date: '2026-06-03', amountMinor: -2_400, categoryId: 'c-dining', payeeId: 'r-p-cafe' },
    { id: 'r4', accountId: 'r-cur', date: '2026-06-04', amountMinor: -8_000, categoryId: 'c-groceries', payeeId: 'r-p-shop' },
    { id: 'r5', accountId: 'r-cur', date: '2026-06-05', amountMinor: 1_500, categoryId: 'c-groceries', payeeId: 'r-p-shop' },
    {
      id: 'r6', accountId: 'r-cur', date: '2026-06-06', amountMinor: -5_000, payeeId: 'r-p-shop',
      tagIds: ['g-work', 'g-treat'],
      splits: [
        { categoryId: 'c-groceries', amountMinor: -3_000 },
        { categoryId: 'c-transport', amountMinor: -2_000 },
      ],
    },
    // Uncategorised: one outflow (counts as spending, by SIGN) and one inflow.
    { id: 'r7', accountId: 'r-cur', date: '2026-06-07', amountMinor: -1_100, payeeId: null },
    { id: 'r8', accountId: 'r-cur', date: '2026-06-08', amountMinor: 900 },
    // A NEGATIVE amount in an INCOME category — classified as income (a
    // clawback), not as spending.
    { id: 'r9', accountId: 'r-cur', date: '2026-06-09', amountMinor: -10_000, categoryId: 'c-salary', payeeId: 'r-p-work' },
    // A transfer pair: invisible to every flow report, real to both balances.
    { id: 'r10', accountId: 'r-cur', date: '2026-06-10', amountMinor: -50_000, transferGroupId: 'r-tg1' },
    { id: 'r11', accountId: 'r-sav', date: '2026-06-10', amountMinor: 50_000, transferGroupId: 'r-tg1' },
    // Foreign spend, converted once, tagged.
    { id: 'r12', accountId: 'r-eur', date: '2026-06-11', amountMinor: -4_000, categoryId: 'c-transport', payeeId: 'r-p-rail', tagIds: ['g-work'] },
    // No CHF rate exists: this transaction is EXCLUDED and COUNTED, never guessed.
    { id: 'r13', accountId: 'r-chf', date: '2026-06-12', amountMinor: -7_000, categoryId: 'c-groceries', payeeId: 'r-p-shop' },
    // July, so month-by-month reports have a second row with different figures.
    { id: 'r14', accountId: 'r-cur', date: '2026-07-01', amountMinor: 300_000, categoryId: 'c-salary', payeeId: 'r-p-work' },
    { id: 'r15', accountId: 'r-cur', date: '2026-07-15', amountMinor: -12_000, categoryId: 'c-groceries', payeeId: 'r-p-shop' },
  ],
};

/**
 * Budget spend book: one category tree, one window's worth of transactions
 * either side of the boundary, a split, a transfer, a foreign amount and an
 * unconvertible one — so a budget's spend, its window edges and its
 * missing-rate count can all be pinned at once.
 */
export const BUDGET_BOOK: BookSource = {
  baseCurrency: 'GBP',
  fxRates: [{ base: 'EUR', quote: 'GBP', rate: 0.85 }],
  accounts: [
    { id: 'b-cur', name: 'Current', currency: 'GBP', openingBalanceMinor: 0, sortOrder: 0 },
    { id: 'b-eur', name: 'Euro Pot', currency: 'EUR', openingBalanceMinor: 0, sortOrder: 1 },
    { id: 'b-chf', name: 'Swiss Pot', currency: 'CHF', openingBalanceMinor: 0, sortOrder: 2 },
    { id: 'b-sav', name: 'Savings', currency: 'GBP', openingBalanceMinor: 0, type: 'savings', sortOrder: 3 },
  ],
  categories: [
    { id: 'k-food', name: 'Food', kind: 'expense', sortOrder: 0 },
    { id: 'k-groceries', name: 'Groceries', kind: 'expense', parentId: 'k-food', sortOrder: 0 },
    { id: 'k-dining', name: 'Dining', kind: 'expense', parentId: 'k-food', sortOrder: 1 },
    { id: 'k-coffee', name: 'Coffee', kind: 'expense', parentId: 'k-dining', sortOrder: 0 },
    { id: 'k-travel', name: 'Travel', kind: 'expense', sortOrder: 1 },
  ],
  transactions: [
    // The day BEFORE the window opens — must not count.
    { id: 'k0', accountId: 'b-cur', date: '2026-02-28', amountMinor: -9_999, categoryId: 'k-groceries' },
    // First and last day of the window [2026-03-01, 2026-03-31] — both count.
    { id: 'k1', accountId: 'b-cur', date: '2026-03-01', amountMinor: -12_345, categoryId: 'k-groceries' },
    { id: 'k2', accountId: 'b-cur', date: '2026-03-31', amountMinor: -1_000, categoryId: 'k-coffee' },
    // A grandchild category is inside the budget (descendants are recursive).
    { id: 'k3', accountId: 'b-cur', date: '2026-03-10', amountMinor: -2_500, categoryId: 'k-dining' },
    // A refund inside the window subtracts from spend.
    { id: 'k4', accountId: 'b-cur', date: '2026-03-12', amountMinor: 500, categoryId: 'k-groceries' },
    // Only the covered leg of a split counts.
    {
      id: 'k5', accountId: 'b-cur', date: '2026-03-14', amountMinor: -6_000,
      splits: [
        { categoryId: 'k-groceries', amountMinor: -4_000 },
        { categoryId: 'k-travel', amountMinor: -2_000 },
      ],
    },
    // A transfer never counts, whatever its category says.
    { id: 'k6', accountId: 'b-cur', date: '2026-03-15', amountMinor: -20_000, transferGroupId: 'k-tg1' },
    { id: 'k7', accountId: 'b-sav', date: '2026-03-15', amountMinor: 20_000, transferGroupId: 'k-tg1' },
    // Foreign spend inside the budget: €20.00 → £17.00.
    { id: 'k8', accountId: 'b-eur', date: '2026-03-18', amountMinor: -2_000, categoryId: 'k-groceries' },
    // No CHF rate: excluded from the spend and counted once, even though this
    // transaction touches the budget through TWO of its splits.
    {
      id: 'k9', accountId: 'b-chf', date: '2026-03-20', amountMinor: -8_000,
      splits: [
        { categoryId: 'k-groceries', amountMinor: -5_000 },
        { categoryId: 'k-coffee', amountMinor: -3_000 },
      ],
    },
    // The day AFTER the window closes — must not count.
    { id: 'k10', accountId: 'b-cur', date: '2026-04-01', amountMinor: -7_777, categoryId: 'k-groceries' },
    // April is a REFUND-HEAVY month on purpose: 9000 back against 7777 spent,
    // so a budget window over April has NEGATIVE spend. Nothing may clamp it.
    { id: 'k11', accountId: 'b-cur', date: '2026-04-05', amountMinor: 9_000, categoryId: 'k-groceries' },
  ],
};
