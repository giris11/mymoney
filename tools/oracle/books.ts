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

/**
 * SEVERAL COUNTED ACCOUNTS SHARING ONE CURRENCY — the shape every book above
 * is missing, and the only shape in which the two defensible net-worth
 * rounding rules give different answers:
 *
 *   per ACCOUNT  — convert each account's balance to base, then add;
 *   per CURRENCY — add the balances in their own currency, then convert once.
 *
 * With at most one counted account per currency those are the same
 * arithmetic. Every other book here has at most one, so 279 green fixtures in
 * two languages could not tell the rules apart — while the app's headline
 * figure (netWorth) and the right-hand end of its net-worth chart
 * (netWorthSeries) genuinely disagreed, because one rounded each way.
 * PER CURRENCY IS THE RULE (SPEC §6 rounds once, at the end); this book exists
 * so that a port which rounds per account cannot pass.
 *
 * EVERY RATE HERE IS A DYADIC RATIONAL — 0.75 = 3/4, 0.0078125 = 1/128,
 * 2.25 = 9/4 — so each is exact as a binary Double and so is every product
 * below. That is deliberate and not decoration: these cases live or die at the
 * .5 boundary, and a rate like 0.85 (really 0.84999999999999998 in a Double)
 * would make the halves an artefact of floating point rather than a fact about
 * the money. Every counted EUR balance ends in .50 for the same reason: n×0.75
 * lands exactly on a half whenever n ≡ 2 (mod 4), which every minor amount
 * ending in 50 is.
 *
 * ACCOUNTS (balance = opening + its transactions, pending included, D15):
 *
 *   COUNTED                       opening      txs          balance
 *   s-cur     Current      GBP    150000   -5000p, -20000    125000
 *   s-sav     Savings      GBP     50000   +20000             70000
 *   s-eur-a   Euro Current EUR     53050   -5000, -3000p      45050
 *   s-eur-b   Euro Savings EUR     12050   —                  12050
 *   s-eur-c   Euro Cash    EUR      9050   -1000               8050
 *   s-jpy-a   Yen Card     JPY         0   -18000            -18000
 *   s-jpy-b   Yen Loan     JPY    -50000   —                 -50000
 *   s-bhd-a   Dinar Curr.  BHD     13500   -1000              12500
 *   s-bhd-b   Dinar Sav.   BHD     11500   —                  11500
 *   s-chf-a   Franc Curr.  CHF     20000   —                  20000
 *   s-chf-b   Franc Sav.   CHF      5000   —                   5000
 *   NOT COUNTED — flagged excludeFromNetWorth, still real money on screen
 *   s-eur-x1  Euro Voucher EUR      6500   -450                6050
 *   s-eur-x2  Euro Deposit EUR      3050   —                   3050
 *   s-gbp-x   Gift Cards   GBP      2500   —                   2500
 *   NOT COUNTED — archived, out for an older and separate reason
 *   s-eur-old Euro (closed)EUR     10000   -1000               9000
 *
 * NET WORTH, per currency, converting each subtotal exactly ONCE:
 *   GBP  125000 + 70000            =  195000   base, no conversion  →  195000
 *   EUR   45050 + 12050 + 8050     =   65150   × 0.75 = 48862.5     →   48863
 *   JPY  -18000 + -50000           =  -68000   × 0.78125 = -53125   →  -53125
 *   BHD   12500 + 11500            =   24000   × 0.225 = 5400       →    5400
 *   CHF   20000 +  5000            =   25000   NO RATE: named, left out
 *                                                     TOTAL         →  196138
 *
 * Per ACCOUNT the same book gives 196139 — EUR 33788+9038+6038 = 48864,
 * JPY -14063 + -39063 = -53126, BHD 2813+2588 = 5401 — and that one penny is
 * the entire reason this book exists.
 *
 * NOT COUNTED, by the same rule: EUR 6050 + 3050 = 9100 × 0.75 = 6825 exactly,
 * plus GBP 2500 = 9325. Per account it would be 4538 + 2288 + 2500 = 9326.
 * That figure sits on screen beside the headline, so it is rounded the same
 * way — two totals on one screen rounded two different ways is the defect.
 *
 * The archived EUR account is in NEITHER total and is not in excludedCount.
 * The two CHF accounts name CHF ONCE, not twice, and contribute nothing.
 */
export const SHARED_CURRENCY_BOOK: BookSource = {
  baseCurrency: 'GBP',
  fxRates: [
    { base: 'EUR', quote: 'GBP', rate: 0.75 },
    { base: 'JPY', quote: 'GBP', rate: 0.0078125 }, // 1 GBP = 128 JPY, exactly
    { base: 'BHD', quote: 'GBP', rate: 2.25 },
    // No CHF rate, on purpose, alongside three currencies that have one.
  ],
  accounts: [
    { id: 's-cur', name: 'Current', currency: 'GBP', openingBalanceMinor: 150_000, sortOrder: 0 },
    { id: 's-sav', name: 'Savings', currency: 'GBP', openingBalanceMinor: 50_000, type: 'savings', sortOrder: 1 },
    // Three counted accounts in ONE non-base currency: the shape the oracle lacked.
    { id: 's-eur-a', name: 'Euro Current', currency: 'EUR', openingBalanceMinor: 53_050, sortOrder: 2 },
    { id: 's-eur-b', name: 'Euro Savings', currency: 'EUR', openingBalanceMinor: 12_050, type: 'savings', sortOrder: 3 },
    { id: 's-eur-c', name: 'Euro Cash', currency: 'EUR', openingBalanceMinor: 9_050, type: 'cash', sortOrder: 4 },
    // Excluded accounts SHARING that currency with the counted ones: they must
    // be partitioned out BEFORE the per-currency subtotal, not after.
    { id: 's-eur-x1', name: 'Euro Voucher', currency: 'EUR', openingBalanceMinor: 6_500, type: 'cash', excludeFromNetWorth: true, sortOrder: 5 },
    { id: 's-eur-x2', name: 'Euro Deposit Held', currency: 'EUR', openingBalanceMinor: 3_050, type: 'cash', excludeFromNetWorth: true, sortOrder: 6 },
    // And an archived one in the same currency again.
    { id: 's-eur-old', name: 'Euro Account (closed)', currency: 'EUR', openingBalanceMinor: 10_000, type: 'savings', archived: true, sortOrder: 7 },
    // A ZERO-DECIMAL currency, both balances NEGATIVE: half away from zero
    // rounds each away, so per-account is MORE negative than per-currency.
    { id: 's-jpy-a', name: 'Yen Card', currency: 'JPY', openingBalanceMinor: 0, type: 'credit_card', sortOrder: 8 },
    { id: 's-jpy-b', name: 'Yen Loan', currency: 'JPY', openingBalanceMinor: -50_000, type: 'loan', sortOrder: 9 },
    // A THREE-DECIMAL currency: minorFactor(to)/minorFactor(from) is 100/1000.
    { id: 's-bhd-a', name: 'Dinar Current', currency: 'BHD', openingBalanceMinor: 13_500, sortOrder: 10 },
    { id: 's-bhd-b', name: 'Dinar Savings', currency: 'BHD', openingBalanceMinor: 11_500, type: 'savings', sortOrder: 11 },
    // TWO counted accounts in a currency with NO RATE AT ALL: named once.
    { id: 's-chf-a', name: 'Franc Current', currency: 'CHF', openingBalanceMinor: 20_000, sortOrder: 12 },
    { id: 's-chf-b', name: 'Franc Savings', currency: 'CHF', openingBalanceMinor: 5_000, type: 'savings', sortOrder: 13 },
    { id: 's-gbp-x', name: 'Gift Cards', currency: 'GBP', openingBalanceMinor: 2_500, type: 'cash', excludeFromNetWorth: true, sortOrder: 14 },
  ],
  categories: [{ id: 'sc-shopping', name: 'Shopping', kind: 'expense', sortOrder: 0 }],
  transactions: [
    // May: a pending charge, a transfer, and one spend in each of two currencies.
    { id: 'sc1', accountId: 's-cur', date: '2026-05-10', amountMinor: -5_000, categoryId: 'sc-shopping', status: 'pending' },
    { id: 'sc2', accountId: 's-cur', date: '2026-05-15', amountMinor: -20_000, transferGroupId: 'sc-tg1' },
    { id: 'sc3', accountId: 's-sav', date: '2026-05-15', amountMinor: 20_000, transferGroupId: 'sc-tg1' },
    { id: 'sc4', accountId: 's-eur-a', date: '2026-05-20', amountMinor: -5_000, categoryId: 'sc-shopping' },
    { id: 'sc5', accountId: 's-bhd-a', date: '2026-05-22', amountMinor: -1_000, categoryId: 'sc-shopping' },
    // June: a pending foreign charge, and the yen card's only movement.
    { id: 'sc6', accountId: 's-eur-a', date: '2026-06-05', amountMinor: -3_000, categoryId: 'sc-shopping', status: 'pending' },
    { id: 'sc7', accountId: 's-eur-c', date: '2026-06-10', amountMinor: -1_000, categoryId: 'sc-shopping' },
    { id: 'sc8', accountId: 's-jpy-a', date: '2026-06-12', amountMinor: -18_000, categoryId: 'sc-shopping' },
    // An ARCHIVED account still moves: its balance is real, its money is not
    // in any total, and the net-worth series must not pick this up either.
    { id: 'sc9', accountId: 's-eur-old', date: '2026-06-15', amountMinor: -1_000, categoryId: 'sc-shopping' },
    // Spending FROM an excluded account is still spending, and still changes
    // that account's own balance.
    { id: 'sc10', accountId: 's-eur-x1', date: '2026-06-18', amountMinor: -450, categoryId: 'sc-shopping' },
  ],
};

/**
 * The same rule, minimal: TWO counted accounts of €7.05 in one book, at 0.85.
 *
 * This is the example written out in src/domain/balances.ts and in the commit
 * that fixed the defect, restated as data so the oracle states it rather than
 * merely describing it:
 *
 *   per ACCOUNT : 705 × 0.85 = 599.25 → 599, twice          = 1198
 *   per CURRENCY: 1410 × 0.85 = 1198.5 → 1199 (half away)   = 1199
 *
 * Two quarters that each round DOWN alone and add up to a half that rounds UP.
 * Nothing else is in the book — no transactions, no exclusions, no second
 * foreign currency — so a failure here says exactly one thing, and 1198 is the
 * signature of rounding per account.
 */
export const ROUNDING_PAIR_BOOK: BookSource = {
  baseCurrency: 'GBP',
  fxRates: [{ base: 'EUR', quote: 'GBP', rate: 0.85 }],
  accounts: [
    { id: 'rp-cur', name: 'Current', currency: 'GBP', openingBalanceMinor: 0, sortOrder: 0 },
    { id: 'rp-eur-1', name: 'Euro One', currency: 'EUR', openingBalanceMinor: 705, sortOrder: 1 },
    { id: 'rp-eur-2', name: 'Euro Two', currency: 'EUR', openingBalanceMinor: 705, sortOrder: 2 },
  ],
};
