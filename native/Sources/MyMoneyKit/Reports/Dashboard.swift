// "How am I doing?" in one value.
//
// Every figure on the dashboard comes from a function the oracle already holds
// to account -- `netWorth`, `netWorthSeries`, `incomeVsExpenseByMonth`,
// `spendingByCategory`, `Budgets.progress`. Nothing here re-derives money. What
// this file adds is the COMPOSITION: which ranges, which slices, how many rows,
// and which of those choices came from the web app rather than from here.
//
// PORTED, card for card, from src/ui/dashboard/*:
//   * the headline and its six-month sparkline  (NetWorthCard.tsx)
//   * income and spend for the calendar month   (ThisMonthCard.tsx)
//   * the four budgets nearest their limit      (BudgetsCard.tsx)
//   * the five biggest spending categories      (TopCategoriesCard.tsx)
//
// INFERRED, and marked as such wherever it appears:
//   * THE TREND. The web app draws the sparkline and states no change figure at
//     all; the phone has far less room for a chart and far more need for a
//     single sentence, so `NetWorthTrend` below states the change across the
//     sampled window. Its two dates are carried WITH it and the UI must print
//     them, because "up £412" is meaningless -- and quietly alarming -- unless
//     the reader is told over what.
//
// WHAT IS NOT HERE: the recent-transactions list. It is the register's own
// first page, read through `LedgerStore.registerPage`, because the rules about
// what a row is CALLED (payee, else note, else "Transfer", else "No payee") are
// already stated once in `Register.swift` and a dashboard that restated them
// would be a second answer to "what is this row".
import Foundation

/// The change in net worth across a sampled window.
///
/// INFERRED, not ported -- see the file header. It is stated as two dated
/// endpoints and their difference rather than as a percentage: a percentage of
/// a net worth that crossed zero is either infinite or a lie, and both of those
/// are things this app must not print.
public struct NetWorthTrend: Sendable, Hashable {
    public let fromDate: String
    public let toDate: String
    public let fromMinor: Int64
    public let toMinor: Int64
    /// to − from. Signed: negative is a fall.
    public let changeMinor: Int64
}

/// This month's flow, and the one arithmetic the card does on top of the
/// report: net.
public struct MonthFlow: Sendable, Hashable {
    /// The month the figures cover, 'YYYY-MM'.
    public let month: String
    public let incomeMinor: Int64   // positive
    public let expenseMinor: Int64  // positive, net of refunds
    /// income − expense, signed.
    public let netMinor: Int64
    /// Transactions left out because their currency has no rate to base.
    public let missingRateCount: Int

    /// True when nothing at all was logged -- so the card can say "nothing
    /// logged this month yet" instead of drawing a bar chart of two zeroes.
    public var isEmpty: Bool { incomeMinor == 0 && expenseMinor == 0 }

    /// A month in which refunds came to MORE than the spending.
    ///
    /// `expenseMinor` is net of refunds and is reported as-is rather than
    /// floored at zero, because the money really did come back (see
    /// `Budgets.progress`, which makes the same choice). A big return, an
    /// insurance payout booked against the category it repays, or a
    /// mis-signed import all produce one, and the screen has to say so rather
    /// than print "Out -£6,465.83" and leave the reader to work it out.
    public var refundsExceededSpending: Bool { expenseMinor < 0 }

    /// The same, on the income side: a clawback larger than the month's pay.
    public var clawbacksExceededIncome: Bool { incomeMinor < 0 }

    /// Income's share of the month's total FLOW (income + expense), 0...1.
    ///
    /// A PROPORTION FOR A TWO-COLOUR BAR, never an amount -- and nil, not
    /// zero, whenever the two figures cannot be split that way:
    ///
    ///   * nothing was logged, so there is no flow to divide;
    ///   * one side is NEGATIVE, which makes the "share" either greater than
    ///     one or negative, and a bar drawn from it would be a picture of
    ///     something that did not happen.
    ///
    /// The first version of this returned 0 in the negative case, which drew a
    /// bar that was entirely one colour -- a month of net refunds rendered as
    /// a month of pure spending. nil is the honest answer, and it makes the
    /// caller decide what to show instead of quietly showing the wrong thing.
    public var incomeShare: Double? {
        guard incomeMinor >= 0, expenseMinor >= 0 else { return nil }
        let (total, overflowed) = incomeMinor.addingReportingOverflow(expenseMinor)
        guard !overflowed, total > 0 else { return nil }
        return Double(incomeMinor) / Double(total)
    }
}

/// Everything the dashboard draws, decided.
public struct DashboardSummary: Sendable {
    public let today: String
    public let baseCurrency: String

    // Net worth
    public let netWorth: NetWorth
    /// Month-end samples over the last six calendar months, plus today.
    public let sparkline: [NetWorthPoint]
    /// nil when the window holds fewer than two samples -- a "change" needs
    /// two points, and one point with a change beside it would be invented.
    public let trend: NetWorthTrend?
    /// THE HEADLINE AND THE CHART DO NOT MEASURE THE SAME MOMENT, and this is
    /// the difference between them.
    ///
    /// `netWorth` counts every transaction in the book. The chart runs to
    /// TODAY. So a transaction the owner has already entered with next week's
    /// date is in the figure and not in the line, and the two disagree -- by
    /// exactly this much, because nothing else differs between them (same
    /// accounts, same predicate, same rates).
    ///
    /// Left as a fact for the screen to state rather than fixed by moving one
    /// of them: both are right, and which one somebody wants depends on
    /// whether they are asking "what have I got" or "how has it been going".
    /// nil when there is no chart to compare with, or when the subtraction
    /// itself would overflow.
    public let laterDatedMinor: Int64?

    // This month
    public let thisMonth: MonthFlow

    // Budgets
    /// The four nearest their limit, most-used first.
    public let budgets: [BudgetLine]
    /// How many live budgets there are in total, so the card can say "4 of 9"
    /// rather than implying the owner has four.
    public let budgetCount: Int
    /// Σ of every LIVE budget's excluded-transaction count, not just the four
    /// shown: a figure excluded from a budget the card happens not to display
    /// is still a figure the owner is not seeing.
    public let budgetMissingRateCount: Int

    // Top categories
    public let topCategories: [CategorySpendRow]
    /// The total across ALL categories this month, which is what the shown
    /// rows are a share of.
    public let categoryTotalMinor: Int64
    public let categoryMissingRateCount: Int
}

public enum Dashboard {
    /// How many budgets the card shows (BudgetsCard.tsx: `.slice(0, 4)`).
    public static let budgetRows = 4
    /// How many category rows the card shows (TopCategoriesCard.tsx:
    /// `.slice(0, 5)`).
    public static let categoryRows = 5

    /// Build the whole dashboard from one book, in one pass over each report.
    ///
    /// `today` is a parameter and not `todayISO()` because a screen that reads
    /// the clock itself cannot be tested, and because every figure here has to
    /// agree about which day it is: a card that fetched the date a millisecond
    /// after midnight while another had it a millisecond before would show a
    /// month's income against the next month's budget window.
    public static func summary(book: Book, today: String) throws -> DashboardSummary {
        let month = try DateRange.thisCalendarMonth(today: today)
        let sixMonths = try DateRange.lastSixMonths(today: today)

        let netWorth = try book.netWorth()
        let series = try Reports.netWorthSeries(sixMonths, book: book)

        let flow = try Reports.incomeVsExpenseByMonth(month, book: book)
        // The range spans exactly one month, so exactly one zero-filled row --
        // and the fallback is a real month key rather than "", because a
        // heading reading "" would be worse than one reading the month with no
        // figures in it.
        let row =
            flow.rows.first
            ?? MonthlyIncomeExpense(
                month: String(month.from.prefix(7)), incomeMinor: 0, expenseMinor: 0
            )
        let (net, netOverflowed) = row.incomeMinor.subtractingReportingOverflow(row.expenseMinor)
        if netOverflowed { throw MoneyError.overflow("this month's net flow") }

        let allBudgets = try book.allBudgetProgress(refDate: today)
        let spend = try Reports.spendingByCategory(month, parentId: nil, book: book)

        return DashboardSummary(
            today: today,
            baseCurrency: book.baseCurrency,
            netWorth: netWorth,
            sparkline: series.points,
            trend: trend(across: series.points),
            laterDatedMinor: laterDated(
                headline: netWorth.totalBaseMinor, chartEndsAt: series.points.last
            ),
            thisMonth: MonthFlow(
                month: row.month,
                incomeMinor: row.incomeMinor,
                expenseMinor: row.expenseMinor,
                netMinor: net,
                missingRateCount: flow.missingRateCount
            ),
            budgets: mostUsed(allBudgets),
            budgetCount: allBudgets.count,
            budgetMissingRateCount: allBudgets.reduce(0) { $0 + $1.progress.missingRateCount },
            topCategories: Array(spend.rows.prefix(categoryRows)),
            categoryTotalMinor: spend.totalMinor,
            categoryMissingRateCount: spend.missingRateCount
        )
    }

    /// The change across the sampled window, or nil when there is nothing to
    /// compare. INFERRED -- see the file header.
    static func trend(across points: [NetWorthPoint]) -> NetWorthTrend? {
        guard let first = points.first, let last = points.last, points.count >= 2 else {
            return nil
        }
        let (change, overflowed) = last.totalBaseMinor.subtractingReportingOverflow(
            first.totalBaseMinor
        )
        // Two net-worth figures that cannot be subtracted from one another is
        // not a number this app will invent a substitute for; the trend simply
        // is not shown, and the headline beside it is untouched.
        if overflowed { return nil }
        return NetWorthTrend(
            fromDate: first.date, toDate: last.date,
            fromMinor: first.totalBaseMinor, toMinor: last.totalBaseMinor,
            changeMinor: change
        )
    }

    /// What the headline has that the chart's last point does not: transactions
    /// dated after today. See `DashboardSummary.laterDatedMinor`.
    static func laterDated(headline: Int64, chartEndsAt last: NetWorthPoint?) -> Int64? {
        guard let last else { return nil }
        let (difference, overflowed) = headline.subtractingReportingOverflow(last.totalBaseMinor)
        return overflowed ? nil : difference
    }

    /// The budgets nearest their limit, most-used first (BudgetsCard.tsx sorts
    /// by `pct` descending and takes four).
    ///
    /// The tiebreak on NAME is this port's, and it is not optional. JavaScript's
    /// sort has been stable since ES2019, so two budgets on the same percentage
    /// come back in the order `allBudgetProgress` produced them -- which is name
    /// order. Swift's `sorted(by:)` is not stable, so without the second key two
    /// budgets both at 0% could swap places between one look at the dashboard
    /// and the next.
    static func mostUsed(_ lines: [BudgetLine]) -> [BudgetLine] {
        Array(
            lines.sorted { lhs, rhs in
                if lhs.progress.pct != rhs.progress.pct { return lhs.progress.pct > rhs.progress.pct }
                return DisplayOrder.nameLess(lhs.budget.name, rhs.budget.name)
            }
            .prefix(budgetRows)
        )
    }
}
