// Oracle: budget period windows and budget progress (src/domain/budgets.ts,
// SPEC §8.1.6, §10 "budget period maths").
//
// WINDOWS ARE WHERE CALENDAR CODE GOES WRONG, and always in the same place:
// a monthly budget anchored on the 31st. "Add one month" has to CLAMP
// (31 Jan + 1 month = 28/29 Feb), and the moment it does, the naive
// "start += 1 month, end += 1 month" loses a day every February and never
// gets it back. The implementation derives BOTH ends of window n from the
// SAME anchor — start = anchor+n, end = anchor+(n+1) − 1 day — so windows
// tile the timeline with no gaps, no overlaps and no accumulating drift, and
// the anchor day resurfaces the moment the calendar allows.
//
// Every window case below is hand-calculated: the arithmetic is written out in
// tests/budgets.test.ts and is a statement about the calendar, not about the
// code. A Swift port using Calendar.date(byAdding:) gets the same clamping —
// which is exactly why these are worth pinning rather than assuming.
import { budgetProgress, shiftWindow, windowContaining, type PeriodWindow } from '../../../src/domain/budgets';
import type { Budget, BudgetPeriod } from '../../../src/db/types';
import { loadBook, materialiseBook, type Book } from '../book';
import { BUDGET_BOOK } from '../books';
import { Cases, ORACLE_VERSION, type OracleFile } from '../oracle';

export async function budgetsSuite(): Promise<OracleFile> {
  const c = new Cases();
  const books: Record<string, Book> = { budget: materialiseBook(BUDGET_BOOK) };

  // Cases whose expected windows are copied from the arithmetic written out in
  // tests/budgets.test.ts's comments. The rest are the same rule applied to
  // dates that file does not cover (a 30th anchor, an ordinary 1st-of-month
  // budget, a week spanning the March DST change).
  const CARRIED_WINDOW = new Set([
    'weekly.on-start', 'weekly.mid', 'weekly.on-end', 'weekly.next-day',
    'weekly.crosses-month', 'weekly.before-start', 'weekly.two-before-start',
    'monthly.31st-leap-feb', 'monthly.31st-leap-feb-inside', 'monthly.31st-leap-feb-end',
    'monthly.31st-leap-next', 'monthly.31st-anchor-returns', 'monthly.31st-nonleap-feb',
    'monthly.31st-nonleap-next', 'monthly.31st-before-start', 'monthly.31st-two-before-start',
    'monthly.31st-far-future', 'monthly.31st-far-future-next',
    'yearly.leap-anchor', 'yearly.leap-anchor-inside', 'yearly.leap-anchor-next',
    'yearly.leap-returns', 'yearly.leap-before-start',
  ]);
  const CARRIED_SHIFT = new Set([
    'weekly.forward', 'weekly.back', 'weekly.zero',
    'monthly.31st-forward', 'monthly.31st-forward-two', 'monthly.31st-back',
    'yearly.leap-forward',
  ]);
  const carried = (set: Set<string>, slug: string) =>
    set.has(slug) ? { carriedFrom: 'tests/budgets.test.ts' } : {};

  const win = (
    slug: string,
    describes: string,
    period: BudgetPeriod,
    startDate: string,
    date: string,
    expected: PeriodWindow,
  ): void => {
    c.hand(
      `budgets.window.${slug}`,
      describes,
      'budgets.windowContaining',
      { period, startDate, date },
      windowContaining({ period, startDate }, date),
      { ...expected },
      carried(CARRIED_WINDOW, slug),
    );
  };

  // -------------------------------------------------------------- weekly
  win('weekly.on-start', 'the first weekly window opens ON startDate and both ends are INCLUSIVE', 'weekly', '2025-01-06', '2025-01-06', { start: '2025-01-06', end: '2025-01-12' });
  win('weekly.mid', 'a date inside the window resolves to it', 'weekly', '2025-01-06', '2025-01-09', { start: '2025-01-06', end: '2025-01-12' });
  win('weekly.on-end', 'the last day belongs to the window, not to the next one', 'weekly', '2025-01-06', '2025-01-12', { start: '2025-01-06', end: '2025-01-12' });
  win('weekly.next-day', 'the day after an end starts the next window', 'weekly', '2025-01-06', '2025-01-13', { start: '2025-01-13', end: '2025-01-19' });
  win('weekly.crosses-month', 'a weekly window is 7 days, so it crosses month ends without noticing', 'weekly', '2025-01-06', '2025-02-01', { start: '2025-01-27', end: '2025-02-02' });
  win('weekly.before-start', 'dates before startDate fall in negative windows on the same 7-day grid', 'weekly', '2025-01-06', '2025-01-05', { start: '2024-12-30', end: '2025-01-05' });
  win('weekly.two-before-start', 'and the windows keep tiling backwards on the same grid', 'weekly', '2025-01-06', '2024-12-29', { start: '2024-12-23', end: '2024-12-29' });
  win('weekly.crosses-dst', 'a weekly window spanning a DST change is still exactly 7 calendar days — windows are date arithmetic, never elapsed hours', 'weekly', '2025-03-24', '2025-03-30', { start: '2025-03-24', end: '2025-03-30' });

  // ------------------------------------------------------------- monthly
  win('monthly.plain', 'the ordinary case: anchored on the 1st, the window is the calendar month', 'monthly', '2026-03-01', '2026-03-15', { start: '2026-03-01', end: '2026-03-31' });
  win('monthly.31st-leap-feb', 'anchored on the 31st in a LEAP year: 31 Jan + 1 month clamps to 29 Feb, so window 0 ends on the 28th', 'monthly', '2024-01-31', '2024-01-31', { start: '2024-01-31', end: '2024-02-28' });
  win('monthly.31st-leap-feb-inside', 'a February date still resolves into that window', 'monthly', '2024-01-31', '2024-02-01', { start: '2024-01-31', end: '2024-02-28' });
  win('monthly.31st-leap-feb-end', 'and its last day is 28 Feb', 'monthly', '2024-01-31', '2024-02-28', { start: '2024-01-31', end: '2024-02-28' });
  win('monthly.31st-leap-next', 'window 1 opens on 29 Feb — the clamped day — and runs to 30 March', 'monthly', '2024-01-31', '2024-02-29', { start: '2024-02-29', end: '2024-03-30' });
  win('monthly.31st-anchor-returns', 'window 2 opens on the 31st again: clamping never accumulates, because both ends come from the same anchor', 'monthly', '2024-01-31', '2024-03-31', { start: '2024-03-31', end: '2024-04-29' });
  win('monthly.31st-nonleap-feb', 'anchored on the 31st in a NON-leap year: window 0 ends 27 Feb', 'monthly', '2023-01-31', '2023-02-27', { start: '2023-01-31', end: '2023-02-27' });
  win('monthly.31st-nonleap-next', 'and the next window opens on 28 February, the day after that end', 'monthly', '2023-01-31', '2023-02-28', { start: '2023-02-28', end: '2023-03-30' });
  win('monthly.31st-before-start', 'window −1 of a 31 March anchor opens on the clamped 29 Feb', 'monthly', '2024-03-31', '2024-02-29', { start: '2024-02-29', end: '2024-03-30' });
  win('monthly.31st-two-before-start', 'window −2 opens on 31 January — the anchor day, recovered', 'monthly', '2024-03-31', '2024-02-28', { start: '2024-01-31', end: '2024-02-28' });
  win('monthly.31st-far-future', 'six years on, a 31st anchor still lands exactly: February 2030 sits in [31 Jan, 27 Feb]', 'monthly', '2024-01-31', '2030-02-14', { start: '2030-01-31', end: '2030-02-27' });
  win('monthly.31st-far-future-next', 'and the following window opens 28 Feb 2030', 'monthly', '2024-01-31', '2030-02-28', { start: '2030-02-28', end: '2030-03-30' });
  win('monthly.30th-february', 'a 30th anchor also clamps through February', 'monthly', '2025-01-30', '2025-02-15', { start: '2025-01-30', end: '2025-02-27' });
  win('monthly.29th-nonleap', 'a 29th anchor clamps only in non-leap Februarys', 'monthly', '2025-01-29', '2025-02-27', { start: '2025-01-29', end: '2025-02-27' });

  // -------------------------------------------------------------- yearly
  win('yearly.leap-anchor', 'a 29 Feb anchor: window 0 runs to 27 Feb the next year (29 Feb + 1 year clamps to 28 Feb, minus a day)', 'yearly', '2024-02-29', '2024-02-29', { start: '2024-02-29', end: '2025-02-27' });
  win('yearly.leap-anchor-inside', 'any date in between resolves to it', 'yearly', '2024-02-29', '2024-12-31', { start: '2024-02-29', end: '2025-02-27' });
  win('yearly.leap-anchor-next', 'window 1 opens on the clamped 28 Feb', 'yearly', '2024-02-29', '2025-02-28', { start: '2025-02-28', end: '2026-02-27' });
  win('yearly.leap-returns', 'four years on, the anchor day returns: window 4 opens on a real 29 Feb', 'yearly', '2024-02-29', '2028-02-29', { start: '2028-02-29', end: '2029-02-27' });
  win('yearly.leap-before-start', 'window −1 of a 29 Feb anchor opens on the clamped 28 Feb of the previous year', 'yearly', '2024-02-29', '2024-02-28', { start: '2023-02-28', end: '2024-02-28' });
  win('yearly.plain', 'an ordinary yearly window is the anniversary year, both ends inclusive', 'yearly', '2026-04-06', '2027-04-05', { start: '2026-04-06', end: '2027-04-05' });

  // A grid-alignment property rather than a single date, kept derived: it
  // states that far-future weekly windows are still exact multiples of 7 days
  // from the anchor, which is the invariant a "add 7 days repeatedly" port
  // breaks once a DST change is involved.
  {
    const w = windowContaining({ period: 'weekly', startDate: '2025-01-06' }, '2027-06-15');
    const days = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    c.derived(
      'budgets.window.weekly.far-future-grid',
      'a weekly window two and a half years out is still a whole number of weeks from the anchor and spans exactly 6 days end-to-start',
      'budgets.windowContaining',
      { period: 'weekly', startDate: '2025-01-06', date: '2027-06-15' },
      {
        start: w.start,
        end: w.end,
        wholeWeeksFromAnchor: (days(w.start) - days('2025-01-06')) / 7,
        spanDays: days(w.end) - days(w.start),
      },
      { note: 'wholeWeeksFromAnchor and spanDays are properties of the returned window, not extra return values.' },
    );
  }

  // ---------------------------------------------------------- shiftWindow
  const shift = (
    slug: string,
    describes: string,
    period: BudgetPeriod,
    startDate: string,
    window: PeriodWindow,
    n: number,
    expected: PeriodWindow,
  ): void => {
    c.hand(
      `budgets.shift.${slug}`,
      describes,
      'budgets.shiftWindow',
      { period, startDate, window, n },
      shiftWindow({ period, startDate }, window, n),
      { ...expected },
      carried(CARRIED_SHIFT, slug),
    );
  };
  shift('weekly.forward', 'shifting forward moves by whole weeks', 'weekly', '2025-01-06', { start: '2025-01-06', end: '2025-01-12' }, 2, { start: '2025-01-20', end: '2025-01-26' });
  shift('weekly.back', 'shifting backwards moves by whole weeks too', 'weekly', '2025-01-06', { start: '2025-01-06', end: '2025-01-12' }, -1, { start: '2024-12-30', end: '2025-01-05' });
  shift('weekly.zero', 'shifting by zero returns the same window', 'weekly', '2025-01-06', { start: '2025-01-06', end: '2025-01-12' }, 0, { start: '2025-01-06', end: '2025-01-12' });
  shift('monthly.31st-forward', 'shifting a clamped window re-derives from the ANCHOR: +1 from [31 Jan, 28 Feb] is [29 Feb, 30 Mar] — adding a month to both ends would wrongly say 28 Mar', 'monthly', '2024-01-31', { start: '2024-01-31', end: '2024-02-28' }, 1, { start: '2024-02-29', end: '2024-03-30' });
  shift('monthly.31st-forward-two', 'shifting two months on recovers the anchor day, the 31st', 'monthly', '2024-01-31', { start: '2024-01-31', end: '2024-02-28' }, 2, { start: '2024-03-31', end: '2024-04-29' });
  shift('monthly.31st-back', '−1 crosses into the previous December', 'monthly', '2024-01-31', { start: '2024-01-31', end: '2024-02-28' }, -1, { start: '2023-12-31', end: '2024-01-30' });
  shift('monthly.zero-on-clamped', 'shifting by zero is the identity even on a February-clamped window — the window index is recovered from its start date, not re-derived by arithmetic on its ends', 'monthly', '2024-01-31', { start: '2024-02-29', end: '2024-03-30' }, 0, { start: '2024-02-29', end: '2024-03-30' });
  shift('yearly.leap-forward', 'four yearly steps from a 29 Feb anchor land back on a real 29 Feb', 'yearly', '2024-02-29', { start: '2024-02-29', end: '2025-02-27' }, 4, { start: '2028-02-29', end: '2029-02-27' });

  // A shift that must be lossless in BOTH directions, stated as one case so a
  // port cannot pass by making + and − independently plausible.
  {
    const b = { period: 'monthly' as const, startDate: '2024-01-31' };
    const w: PeriodWindow = { start: '2024-02-29', end: '2024-03-30' };
    c.hand(
      'budgets.shift.monthly.round-trip-3',
      'shifting a February-clamped window forward three months and back three returns it unchanged',
      'budgets.shiftWindowRoundTrip',
      { period: 'monthly', startDate: '2024-01-31', window: w, n: 3 },
      { forward: shiftWindow(b, w, 3), backAgain: shiftWindow(b, shiftWindow(b, w, 3), -3) },
      { forward: { start: '2024-05-31', end: '2024-06-29' }, backAgain: { start: '2024-02-29', end: '2024-03-30' } },
      { carriedFrom: 'tests/budgets.test.ts' },
    );
  }

  // ------------------------------------------------------------- progress
  await loadBook(books.budget);
  const budget = (over: Partial<Budget>): Budget => ({
    id: 'oracle-budget', name: 'Budget', categoryIds: [], amountMinor: 0,
    period: 'monthly', startDate: '2026-03-01', rollover: false, archived: false, ...over,
  });
  const progress = async (b: Budget, refDate: string) => {
    const p = await budgetProgress(b, refDate);
    return {
      window: p.window,
      spentMinor: p.spentMinor,
      limitMinor: p.limitMinor,
      remainingMinor: p.remainingMinor,
      pct: p.pct,
      over: p.over,
      missingRateCount: p.missingRateCount,
    };
  };
  const progInput = (b: Budget, refDate: string) => ({
    book: 'budget',
    budget: { categoryIds: b.categoryIds, amountMinor: b.amountMinor, period: b.period, startDate: b.startDate },
    refDate,
  });

  // Hand calculation for the Food budget over [2026-03-01, 2026-03-31]:
  //   groceries -12345, coffee -1000, dining -2500, refund +500,
  //   the covered leg of the split -4000, €20.00 → -1700
  //   = -21045  ⇒ spent 21045, remaining 50000 - 21045 = 28955
  //   the CHF transaction has no rate: excluded, counted ONCE (it touches the
  //   budget through two splits), so missingRateCount = 1
  //   the 28 Feb and 1 Apr rows are outside the window; the transfer never counts
  {
    const b = budget({ name: 'Food', categoryIds: ['k-food'], amountMinor: 50_000 });
    c.hand(
      'budgets.progress.food-month',
      'a monthly budget over a parent category: descendants count, the covered split leg counts, a refund subtracts, a foreign amount converts once, the transfer is invisible, and the unconvertible transaction is excluded and counted once',
      'budgets.progress',
      progInput(b, '2026-03-15'),
      await progress(b, '2026-03-15'),
      {
        window: { start: '2026-03-01', end: '2026-03-31' },
        spentMinor: 21_045,
        limitMinor: 50_000,
        remainingMinor: 28_955,
        pct: 21_045 / 50_000,
        over: false,
        missingRateCount: 1,
      },
      { note: 'pct is a ratio (a Double), not a percentage: 0.4209 here. Compare it with a small epsilon.' },
    );
  }
  {
    const b = budget({ name: 'Travel', categoryIds: ['k-travel'], amountMinor: 1_000 });
    c.hand(
      'budgets.progress.over-limit',
      'only the travel leg of the split falls in this budget — £20.00 against a £10.00 limit, so remaining goes negative and over is true',
      'budgets.progress',
      progInput(b, '2026-03-15'),
      await progress(b, '2026-03-15'),
      {
        window: { start: '2026-03-01', end: '2026-03-31' },
        spentMinor: 2_000,
        limitMinor: 1_000,
        remainingMinor: -1_000,
        pct: 2,
        over: true,
        missingRateCount: 0,
      },
    );
  }
  {
    const b = budget({ name: 'Coffee', categoryIds: ['k-coffee'], amountMinor: 1_000 });
    c.hand(
      'budgets.progress.exactly-at-limit',
      'spending exactly the limit is NOT over — remaining is zero and over is false',
      'budgets.progress',
      progInput(b, '2026-03-15'),
      await progress(b, '2026-03-15'),
      {
        window: { start: '2026-03-01', end: '2026-03-31' },
        spentMinor: 1_000,
        limitMinor: 1_000,
        remainingMinor: 0,
        pct: 1,
        over: false,
        missingRateCount: 1,
      },
      { note: 'missingRateCount is 1 because the unconvertible CHF transaction has a Coffee split — the count is of TRANSACTIONS, not of splits.' },
    );
  }
  {
    const b = budget({ name: 'Food weekly', categoryIds: ['k-food'], amountMinor: 5_000, period: 'weekly' });
    c.hand(
      'budgets.progress.weekly-window',
      'the same book seen through a weekly budget: only the £17.00 converted euro spend falls in [15 Mar, 21 Mar]',
      'budgets.progress',
      progInput(b, '2026-03-15'),
      await progress(b, '2026-03-15'),
      {
        window: { start: '2026-03-15', end: '2026-03-21' },
        spentMinor: 1_700,
        limitMinor: 5_000,
        remainingMinor: 3_300,
        pct: 1_700 / 5_000,
        over: false,
        missingRateCount: 1,
      },
    );
  }
  {
    const b = budget({ name: 'Food', categoryIds: ['k-food'], amountMinor: 50_000 });
    c.hand(
      'budgets.progress.refunds-exceed-spend',
      'April is refund-heavy: £90.00 back against £77.77 spent, so spend is NEGATIVE (−£12.23), remaining exceeds the limit, and pct floors at zero rather than going negative',
      'budgets.progress',
      progInput(b, '2026-04-15'),
      await progress(b, '2026-04-15'),
      {
        window: { start: '2026-04-01', end: '2026-04-30' },
        spentMinor: -1_223,
        limitMinor: 50_000,
        remainingMinor: 51_223,
        pct: 0,
        over: false,
        missingRateCount: 0,
      },
    );
  }
  {
    const b = budget({ name: 'Travel', categoryIds: ['k-travel'], amountMinor: 10_000 });
    c.hand(
      'budgets.progress.empty-window',
      'a window with no matching transactions spends exactly zero — never −0, which would display as “-£0.00”',
      'budgets.progress',
      progInput(b, '2026-05-15'),
      await progress(b, '2026-05-15'),
      {
        window: { start: '2026-05-01', end: '2026-05-31' },
        spentMinor: 0,
        limitMinor: 10_000,
        remainingMinor: 10_000,
        pct: 0,
        over: false,
        missingRateCount: 0,
      },
    );
  }
  {
    const b = budget({ name: 'Food+Travel', categoryIds: ['k-food', 'k-travel'], amountMinor: 50_000 });
    c.hand(
      'budgets.progress.two-roots',
      'a budget over two roots covers both subtrees: the whole £60.00 split now counts, so spend is the Food total plus the £20.00 travel leg',
      'budgets.progress',
      progInput(b, '2026-03-15'),
      await progress(b, '2026-03-15'),
      {
        window: { start: '2026-03-01', end: '2026-03-31' },
        spentMinor: 23_045,
        limitMinor: 50_000,
        remainingMinor: 26_955,
        pct: 23_045 / 50_000,
        over: false,
        missingRateCount: 1,
      },
    );
  }

  return {
    oracleVersion: ORACLE_VERSION,
    area: 'budgets',
    title: 'Budgets: period windows (including month-end clamping) and spend against them',
    generatedFrom: ['src/domain/budgets.ts'],
    notes: [
      'A window is [start, end] with BOTH ends inclusive, and windows tile the timeline with no gaps or overlaps.',
      'Window n = [anchor + n periods, anchor + (n+1) periods − 1 day]. Both ends derive from the anchor, so month-end clamping never accumulates.',
      'n may be negative: dates before startDate fall in negative windows on the same grid.',
      'A budget covers its categoryIds PLUS all their descendants (D16).',
      'Spend is reported POSITIVE (expenses are negative amounts, so spend = −Σ). Refunds subtract and spend may go negative.',
      'pct = spent / limit, floored at 0 and NOT capped at 1; it is 0 when the limit is 0. It is a ratio, so compare with an epsilon.',
      'over is spent > limit — spending exactly the limit is not over.',
      'Transfer legs never count. Split transactions contribute only the splits whose category the budget covers.',
      'A transaction whose currency has no rate to base is excluded and counted ONCE in missingRateCount, however many of its splits the budget covers (D28).',
    ],
    books,
    cases: c.list,
  };
}
