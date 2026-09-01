// Oracle: report aggregation (src/reports/aggregate.ts) and the category
// rollup it depends on (src/domain/categories.ts).
//
// THE GOLDEN MONTH IS THE POINT OF THIS FILE. tests/golden.test.ts is SPEC
// §12's acceptance test: one realistic month with every figure worked out by
// hand in a comment block, on the principle that if it fails the app is lying
// to the user. Those figures are carried through here as 'hand-calculated' and
// the generator refuses to emit unless the implementation still agrees with
// them — so a Swift port is being measured against the arithmetic, not against
// this codebase's opinion of the arithmetic.
//
// Four classification rules decide every number below, and each has a case
// that fails loudly if a port gets it backwards:
//  * TRANSFERS ARE NOT FLOW (D13). Two legs of one transfer are real balance
//    changes and invisible income/spending. A port that forgets invents income.
//  * SIDE IS BY CATEGORY KIND, NOT BY SIGN (D14). A refund is a POSITIVE
//    amount in an EXPENSE category and must SUBTRACT from spending, not add to
//    income. Only uncategorised amounts are classified by their sign.
//  * SPLITS ARE ATTRIBUTED PER SPLIT, under the parent's payee, tags and date.
//  * A ROLLUP INCLUDES DESCENDANTS. Spending "on Food" includes Groceries and
//    Coffee three levels down.
import { categoryPathName, descendantIds } from '../../../src/domain/categories';
import {
  cashFlowByMonth,
  incomeVsExpenseByMonth,
  netWorthSeries,
  spendingByCategory,
  spendingByPayee,
  spendingByTag,
} from '../../../src/reports/aggregate';
import type { Category } from '../../../src/db/types';
import { loadBook, materialiseBook, type Book } from '../book';
import { GOLDEN_BOOK, ROLLUP_BOOK, ROUNDING_PAIR_BOOK, SHARED_CURRENCY_BOOK } from '../books';
import { Cases, ORACLE_VERSION, type OracleFile } from '../oracle';

const AUG = { from: '2026-08-01', to: '2026-08-31' };
const JUNE = { from: '2026-06-01', to: '2026-06-30' };
const JUNE_JULY = { from: '2026-06-01', to: '2026-07-31' };

export async function reportsSuite(): Promise<OracleFile> {
  const c = new Cases();
  const books: Record<string, Book> = {
    golden: materialiseBook(GOLDEN_BOOK),
    rollup: materialiseBook(ROLLUP_BOOK),
    'rounding-pair': materialiseBook(ROUNDING_PAIR_BOOK),
    'shared-currency': materialiseBook(SHARED_CURRENCY_BOOK),
  };

  // ====================================================== category rollup
  // Pure, and the primitive every rollup figure rests on. The returned set has
  // no meaningful order, so the fixture sorts it — a harness should compare it
  // as a set, or sort before comparing.
  const catsOf = (b: Book): Category[] =>
    b.categories.map((x) => ({
      id: x.id, name: x.name, parentId: x.parentId, kind: x.kind,
      archived: x.archived, sortOrder: x.sortOrder,
    }));
  const rollupCats = catsOf(books.rollup);
  const desc = (roots: string[]): string[] => [...descendantIds(rollupCats, roots)].sort();

  c.hand(
    'categories.descendants.three-deep',
    'a rollup is RECURSIVE: asking for Food returns Food, its children and its grandchildren',
    'categories.descendantIds',
    { categories: rollupCats.map((x) => ({ id: x.id, parentId: x.parentId })), rootIds: ['c-food'] },
    { ids: desc(['c-food']) },
    { ids: ['c-coffee', 'c-dining', 'c-food', 'c-groceries'] },
  );
  c.hand(
    'categories.descendants.leaf',
    'a leaf returns just itself',
    'categories.descendantIds',
    { categories: rollupCats.map((x) => ({ id: x.id, parentId: x.parentId })), rootIds: ['c-coffee'] },
    { ids: desc(['c-coffee']) },
    { ids: ['c-coffee'] },
  );
  c.hand(
    'categories.descendants.two-roots',
    'several roots union, and a subtree is not double-counted',
    'categories.descendantIds',
    { categories: rollupCats.map((x) => ({ id: x.id, parentId: x.parentId })), rootIds: ['c-dining', 'c-transport'] },
    { ids: desc(['c-dining', 'c-transport']) },
    { ids: ['c-coffee', 'c-dining', 'c-transport'] },
  );
  c.hand(
    'categories.descendants.unknown-id',
    'an id no category has still comes back — the set is "these ids and everything under them", and dropping it would silently widen a budget',
    'categories.descendantIds',
    { categories: rollupCats.map((x) => ({ id: x.id, parentId: x.parentId })), rootIds: ['no-such-category'] },
    { ids: desc(['no-such-category']) },
    { ids: ['no-such-category'] },
  );
  c.hand(
    'categories.descendants.empty',
    'no roots means no categories',
    'categories.descendantIds',
    { categories: rollupCats.map((x) => ({ id: x.id, parentId: x.parentId })), rootIds: [] },
    { ids: desc([]) },
    { ids: [] },
  );

  const byId = new Map(rollupCats.map((x) => [x.id, x] as const));
  c.hand(
    'categories.path.three-deep',
    'a category path names every ancestor, top down, joined by “ › ”',
    'categories.categoryPathName',
    { categories: rollupCats.map((x) => ({ id: x.id, name: x.name, parentId: x.parentId })), id: 'c-coffee' },
    { text: categoryPathName(byId, 'c-coffee') },
    { text: 'Food › Dining › Coffee' },
  );
  c.hand(
    'categories.path.root',
    'a root category’s path is just its own name',
    'categories.categoryPathName',
    { categories: rollupCats.map((x) => ({ id: x.id, name: x.name, parentId: x.parentId })), id: 'c-transport' },
    { text: categoryPathName(byId, 'c-transport') },
    { text: 'Transport' },
  );

  // ========================================================= golden month
  await loadBook(books.golden);

  // Hand calculation (from tests/golden.test.ts):
  //   Food spend (Groceries ⊂ Food): 4567 + 5433 + 6000 − 1000 (refund) = 15000
  //   Transport spend: 4000 (split) + 1700 (€20 × 0.85) + 3000 (pending) = 8700
  c.hand(
    'reports.golden.category-top',
    'the golden month by top-level category: Food £150.00 (the Groceries child rolled up, net of a £10.00 refund) and Transport £87.00 (a split leg, a converted euro spend and a PENDING transaction)',
    'reports.spendingByCategory',
    { book: 'golden', from: AUG.from, to: AUG.to, parentId: null },
    await spendingByCategory(AUG, null),
    {
      rows: [
        { categoryId: 'food', name: 'Food', spentMinor: 15_000, hasChildren: true },
        { categoryId: 'transport', name: 'Transport', spentMinor: 8_700, hasChildren: false },
      ],
      totalMinor: 23_700,
      missingRateCount: 0,
    },
    { carriedFrom: 'tests/golden.test.ts', note: 'Rows sort by spentMinor descending, then by name. A row with no colour set simply has no colour key.' },
  );
  c.hand(
    'reports.golden.category-drill',
    'drilling into Food shows the Groceries subtree only — £150.00, the same figure the parent row rolled up',
    'reports.spendingByCategory',
    { book: 'golden', from: AUG.from, to: AUG.to, parentId: 'food' },
    await spendingByCategory(AUG, 'food'),
    {
      rows: [{ categoryId: 'groceries', name: 'Groceries', spentMinor: 15_000, hasChildren: false }],
      totalMinor: 15_000,
      missingRateCount: 0,
    },
    { carriedFrom: 'tests/golden.test.ts' },
  );
  c.hand(
    'reports.golden.income-expense',
    'August: £2,500.00 in, £237.00 out — and the £200.00 transfer is INVISIBLE to both sides',
    'reports.incomeVsExpenseByMonth',
    { book: 'golden', from: AUG.from, to: AUG.to },
    await incomeVsExpenseByMonth(AUG),
    {
      rows: [{ month: '2026-08', incomeMinor: 250_000, expenseMinor: 23_700 }],
      missingRateCount: 0,
    },
    { carriedFrom: 'tests/golden.test.ts' },
  );
  c.hand(
    'reports.golden.cash-flow',
    'cash flow: net +£2,263.00, and over a single-month range the cumulative equals the net',
    'reports.cashFlowByMonth',
    { book: 'golden', from: AUG.from, to: AUG.to },
    await cashFlowByMonth(AUG),
    {
      rows: [{ month: '2026-08', netMinor: 226_300, cumulativeMinor: 226_300 }],
      missingRateCount: 0,
    },
    { carriedFrom: 'tests/golden.test.ts' },
  );
  c.hand(
    'reports.golden.payee',
    'by payee: Tesco nets its £10.00 refund to £90.00 over three transactions, and the whole £100.00 split is attributed to Big Shop, not divided among its categories’ payees',
    'reports.spendingByPayee',
    { book: 'golden', from: AUG.from, to: AUG.to },
    await spendingByPayee(AUG),
    {
      rows: [
        { payeeId: 'p-bigshop', name: 'Big Shop', spentMinor: 10_000, txCount: 1 },
        { payeeId: 'p-tesco', name: 'Tesco', spentMinor: 9_000, txCount: 3 },
        { payeeId: 'p-uber', name: 'Uber', spentMinor: 3_000, txCount: 1 },
        { payeeId: 'p-cafe', name: 'Café Paris', spentMinor: 1_700, txCount: 1 },
      ],
      missingRateCount: 0,
    },
    { carriedFrom: 'tests/golden.test.ts', note: 'txCount counts DISTINCT transactions: the two-split Big Shop purchase is one, not two.' },
  );
  c.hand(
    'reports.golden.transfers-invisible',
    'a range containing NOTHING but the two legs of a transfer produces no spending at all — a port that treats the outgoing leg as an expense invents £200.00 of spending here',
    'reports.spendingByCategory',
    { book: 'golden', from: '2026-08-20', to: '2026-08-20', parentId: null },
    await spendingByCategory({ from: '2026-08-20', to: '2026-08-20' }, null),
    { rows: [], totalMinor: 0, missingRateCount: 0 },
  );
  c.hand(
    'reports.golden.net-worth-series',
    'net worth sampled at each month end is CUMULATIVE FROM THE BEGINNING OF TIME, not from the range start: July is the three opening balances (£1,000 + £500 + €200×0.85), August adds the month, September is unchanged',
    'reports.netWorthSeries',
    { book: 'golden', from: '2026-07-01', to: '2026-09-30' },
    await netWorthSeries({ from: '2026-07-01', to: '2026-09-30' }),
    {
      points: [
        { date: '2026-07-31', totalBaseMinor: 167_000 },
        { date: '2026-08-31', totalBaseMinor: 393_300 },
        { date: '2026-09-30', totalBaseMinor: 393_300 },
      ],
      missingRateCurrencies: [],
    },
    { note: 'Sample dates are every month end inside the range, plus the range end itself, deduplicated and ascending.' },
  );
  c.hand(
    'reports.golden.single-month-series',
    'over exactly one month the only sample is that month’s end, at the golden month’s £3,933.00',
    'reports.netWorthSeries',
    { book: 'golden', from: AUG.from, to: AUG.to },
    await netWorthSeries(AUG),
    {
      points: [{ date: '2026-08-31', totalBaseMinor: 393_300 }],
      missingRateCurrencies: [],
    },
    { carriedFrom: 'tests/golden.test.ts' },
  );

  // ======================================================= deeper rollup
  await loadBook(books.rollup);

  // Hand calculation over June 2026 (base GBP, 1 EUR = 0.85 GBP, no CHF rate):
  //   Food    = coffee 350 + dining 2400 + groceries (8000 − 1500 + 3000) = 12250
  //   Transport = split leg 2000 + €40.00 × 0.85 = 3400                   =  5400
  //   Uncategorised = the £11.00 outflow only (the £9.00 inflow is income) =  1100
  //   total                                                               = 18750
  //   the CHF transaction has no rate: excluded, counted once
  c.hand(
    'reports.rollup.category-top',
    'a three-level tree rolls all the way up to its root, an uncategorised OUTFLOW gets its own row while an uncategorised inflow does not, and the unconvertible transaction is excluded and counted',
    'reports.spendingByCategory',
    { book: 'rollup', from: JUNE.from, to: JUNE.to, parentId: null },
    await spendingByCategory(JUNE, null),
    {
      rows: [
        { categoryId: 'c-food', name: 'Food', spentMinor: 12_250, hasChildren: true },
        { categoryId: 'c-transport', name: 'Transport', spentMinor: 5_400, hasChildren: false },
        { categoryId: null, name: 'Uncategorised', spentMinor: 1_100, hasChildren: false },
      ],
      totalMinor: 18_750,
      missingRateCount: 1,
    },
  );
  c.hand(
    'reports.rollup.category-drill-food',
    'drilling into Food buckets by DIRECT CHILD, each carrying its own subtree: Dining brings Coffee with it',
    'reports.spendingByCategory',
    { book: 'rollup', from: JUNE.from, to: JUNE.to, parentId: 'c-food' },
    await spendingByCategory(JUNE, 'c-food'),
    {
      rows: [
        { categoryId: 'c-groceries', name: 'Groceries', spentMinor: 9_500, hasChildren: false },
        { categoryId: 'c-dining', name: 'Dining', spentMinor: 2_750, hasChildren: true },
      ],
      totalMinor: 12_250,
      missingRateCount: 1,
    },
  );
  c.hand(
    'reports.rollup.category-drill-dining',
    'drilling into Dining separates money logged ON Dining itself from its Coffee child — the “itself” row keeps the parent’s own id',
    'reports.spendingByCategory',
    { book: 'rollup', from: JUNE.from, to: JUNE.to, parentId: 'c-dining' },
    await spendingByCategory(JUNE, 'c-dining'),
    {
      rows: [
        { categoryId: 'c-dining', name: 'Dining', spentMinor: 2_400, hasChildren: false },
        { categoryId: 'c-coffee', name: 'Coffee', spentMinor: 350, hasChildren: false },
      ],
      totalMinor: 2_750,
      missingRateCount: 1,
    },
    { note: 'The “itself” row reports hasChildren false: there is nothing further to drill into from it.' },
  );
  c.hand(
    'reports.rollup.income-expense',
    'a NEGATIVE amount in an INCOME category is a clawback and nets within income (£3,000 − £100 = £2,900); an uncategorised inflow is income by sign; only uncategorised amounts are classified by sign at all',
    'reports.incomeVsExpenseByMonth',
    { book: 'rollup', from: JUNE_JULY.from, to: JUNE_JULY.to },
    await incomeVsExpenseByMonth(JUNE_JULY),
    {
      rows: [
        { month: '2026-06', incomeMinor: 290_900, expenseMinor: 18_750 },
        { month: '2026-07', incomeMinor: 300_000, expenseMinor: 12_000 },
      ],
      missingRateCount: 1,
    },
    { note: 'Every month in the range gets a row, zero-filled — a month with no activity is a zero row, not a missing one.' },
  );
  c.hand(
    'reports.rollup.cash-flow',
    'cumulative cash flow runs across the requested range only and starts at zero',
    'reports.cashFlowByMonth',
    { book: 'rollup', from: JUNE_JULY.from, to: JUNE_JULY.to },
    await cashFlowByMonth(JUNE_JULY),
    {
      rows: [
        { month: '2026-06', netMinor: 272_150, cumulativeMinor: 272_150 },
        { month: '2026-07', netMinor: 288_000, cumulativeMinor: 560_150 },
      ],
      missingRateCount: 1,
    },
  );
  c.hand(
    'reports.rollup.payee',
    'a split transaction is attributed WHOLE to the parent’s payee across all its splits, and an expense with no payee gets its own bucket',
    'reports.spendingByPayee',
    { book: 'rollup', from: JUNE.from, to: JUNE.to },
    await spendingByPayee(JUNE),
    {
      rows: [
        { payeeId: 'r-p-shop', name: 'Corner Shop', spentMinor: 11_500, txCount: 3 },
        { payeeId: 'r-p-rail', name: 'Rail Co', spentMinor: 3_400, txCount: 1 },
        { payeeId: 'r-p-cafe', name: 'Corner Cafe', spentMinor: 2_750, txCount: 2 },
        { payeeId: null, name: 'No payee', spentMinor: 1_100, txCount: 1 },
      ],
      missingRateCount: 1,
    },
  );
  c.derived(
    'reports.rollup.payee-limited',
    'a limit slices the sorted rows and changes nothing else',
    'reports.spendingByPayee',
    { book: 'rollup', from: JUNE.from, to: JUNE.to, limit: 2 },
    await spendingByPayee(JUNE, 2),
  );
  c.hand(
    'reports.rollup.tag',
    'a transaction with two tags counts FULLY under each — tag totals deliberately overlap and do not sum to the spend total; the split’s tags come from its parent',
    'reports.spendingByTag',
    { book: 'rollup', from: JUNE.from, to: JUNE.to },
    await spendingByTag(JUNE),
    {
      rows: [
        { tagId: 'g-work', name: 'work', spentMinor: 8_400, txCount: 2 },
        { tagId: 'g-treat', name: 'treat', spentMinor: 5_350, txCount: 2 },
      ],
      missingRateCount: 1,
    },
  );
  c.hand(
    'reports.rollup.net-worth-series',
    'net worth over two months with an unconvertible account: CHF is named once and contributes nothing to any point, while both legs of the transfer cancel inside the GBP subtotal',
    'reports.netWorthSeries',
    { book: 'rollup', from: JUNE_JULY.from, to: JUNE_JULY.to },
    await netWorthSeries(JUNE_JULY),
    {
      points: [
        { date: '2026-06-30', totalBaseMinor: 480_650 },
        { date: '2026-07-31', totalBaseMinor: 768_650 },
      ],
      missingRateCurrencies: ['CHF'],
    },
    { note: 'Per-currency running totals are kept in integer minor units and converted to base ONCE per currency per sample point.' },
  );

  // Empty / inverted ranges — the boring cases a port skips and then crashes on.
  c.hand(
    'reports.rollup.inverted-range',
    'a range whose end precedes its start yields nothing rather than an error or a full-table scan',
    'reports.spendingByCategory',
    { book: 'rollup', from: '2026-07-31', to: '2026-06-01', parentId: null },
    await spendingByCategory({ from: '2026-07-31', to: '2026-06-01' }, null),
    { rows: [], totalMinor: 0, missingRateCount: 0 },
  );
  c.hand(
    'reports.rollup.inverted-range-series',
    'and the net-worth series over an inverted range is empty, not a single mystery point',
    'reports.netWorthSeries',
    { book: 'rollup', from: '2026-07-31', to: '2026-06-01' },
    await netWorthSeries({ from: '2026-07-31', to: '2026-06-01' }),
    { points: [], missingRateCurrencies: [] },
  );
  c.hand(
    'reports.rollup.quiet-month',
    'a month inside the range with no transactions still gets a zero-filled row',
    'reports.incomeVsExpenseByMonth',
    { book: 'rollup', from: '2026-08-01', to: '2026-09-30' },
    await incomeVsExpenseByMonth({ from: '2026-08-01', to: '2026-09-30' }),
    {
      rows: [
        { month: '2026-08', incomeMinor: 0, expenseMinor: 0 },
        { month: '2026-09', incomeMinor: 0, expenseMinor: 0 },
      ],
      missingRateCount: 0,
    },
  );

  // ============================ the chart must agree with the headline
  // These two cases are the other half of balances.rounding-pair.net-worth and
  // balances.shared-currency.net-worth: the SAME books, the SAME totals, read
  // by the OTHER function. netWorth() draws the headline and netWorthSeries()
  // draws the chart, and the defect that hid behind 279 green cases was that
  // they rounded differently — one per account, one per currency — so the two
  // figures on one screen, for one book, disagreed by a penny. Stating the
  // same integer in both files is what makes that unable to happen quietly.
  await loadBook(books['rounding-pair']);
  c.hand(
    'reports.rounding-pair.net-worth-series',
    'the chart over two counted €7.05 accounts ends at £11.99 — the SAME integer balances.rounding-pair.net-worth states for the headline over the same book, because both round the €14.10 subtotal once',
    'reports.netWorthSeries',
    { book: 'rounding-pair', from: '2026-01-01', to: '2026-01-31' },
    await netWorthSeries({ from: '2026-01-01', to: '2026-01-31' }),
    {
      points: [{ date: '2026-01-31', totalBaseMinor: 1_199 }],
      missingRateCurrencies: [],
    },
    {
      note: 'Hand-calculated: (705 + 705) × 0.85 = 1198.5 → 1199, half away from zero, once. A port that converts per account gets 599 + 599 = 1198 here or in balances.rounding-pair.net-worth — and if it gets 1198 in only ONE of them it has reproduced the original defect exactly: a headline and a chart that disagree about the same book.',
    },
  );

  await loadBook(books['shared-currency']);
  c.hand(
    'reports.shared-currency.net-worth-series',
    'five currencies and eleven counted accounts sampled at three month ends: £2,132.00 at May end, £1,961.38 at June end — the same figure balances.shared-currency.net-worth states — and July unchanged because nothing happened',
    'reports.netWorthSeries',
    { book: 'shared-currency', from: '2026-05-01', to: '2026-07-31' },
    await netWorthSeries({ from: '2026-05-01', to: '2026-07-31' }),
    {
      points: [
        { date: '2026-05-31', totalBaseMinor: 213_200 },
        { date: '2026-06-30', totalBaseMinor: 196_138 },
        { date: '2026-07-31', totalBaseMinor: 196_138 },
      ],
      missingRateCurrencies: ['CHF'],
    },
    {
      note: 'Hand-calculated. Running totals are kept PER CURRENCY in integer minor units and converted once per currency per point. Seeded from the counted, rated openings: GBP 150000 + 50000 = 200000; EUR 53050 + 12050 + 9050 = 74150; JPY 0 + −50000 = −50000; BHD 13500 + 11500 = 25000; CHF has no rate so its two accounts are dropped up front and CHF is named once. 31 MAY, after −5000 and −20000 and +20000 (GBP), −5000 (EUR), −1000 (BHD): GBP 195000; EUR 69150 → 51862.5 → 51863; JPY −50000 → −39062.5 → −39063; BHD 24000 → 5400; total 213200. 30 JUNE, after −3000 and −1000 (EUR) and −18000 (JPY): EUR 65150 → 48863; JPY −68000 → −53125; total 196138. 31 JULY: no further rows, unchanged. The archived account’s −1000 and the excluded account’s −450, both in June, move NEITHER point: they are real to those accounts and invisible to the total. The pending −5000 in May DOES move it (D15).',
    },
  );

  return {
    oracleVersion: ORACLE_VERSION,
    area: 'reports',
    title: 'Reports: the golden month, category rollup with descendants, and flow classification',
    generatedFrom: ['src/reports/aggregate.ts', 'src/domain/categories.ts'],
    notes: [
      'Date ranges are inclusive of both endpoints. An inverted range yields nothing.',
      'Every figure is in the BASE currency; each contribution is converted ONCE.',
      'netWorthSeries totals PER CURRENCY and converts each currency’s running subtotal once per sample point — the same rule as netWorth(), so the chart’s last point and the headline figure are the same integer for the same book (reports.rounding-pair.net-worth-series and balances.rounding-pair.net-worth state it twice on purpose).',
      'A transaction whose currency has no rate to base is excluded from the whole report and counted once in missingRateCount.',
      'Transfer legs (transferGroupId non-null) are excluded from every flow report but are real to balances and net worth (D13).',
      'A split transaction contributes each split under the SPLIT’s category, carrying the parent’s payee, tags, date and currency.',
      'Ledger side is decided by CATEGORY KIND when a contribution is categorised, and by SIGN only when it is not (D14) — so a refund subtracts from spending and a clawback subtracts from income.',
      'Spending figures are POSITIVE and net of refunds. Zero rows are dropped. Rows sort by amount descending, then by name.',
      'txCount is the number of DISTINCT transactions contributing; a multi-split transaction counts once.',
      'Tag rows deliberately overlap: a transaction with two tags counts fully under each, so tag totals do not sum to the spend total.',
      'categories.descendantIds returns a SET; the fixture sorts the ids for stability and the order carries no meaning.',
    ],
    books,
    cases: c.list,
  };
}
