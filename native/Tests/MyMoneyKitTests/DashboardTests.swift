// The dashboard, figure by figure.
//
// EVERY EXPECTATION IN THIS FILE IS HAND-CALCULATED from the fabricated book
// below. The oracle covers the reports the dashboard is BUILT FROM -- 29 cases
// over `spendingByCategory`, `incomeVsExpenseByMonth`, `netWorthSeries` and the
// rest, and 45 over budget windows and budget spend -- but it has no case for
// the composition, because the composition is a UI decision the web app made in
// five React components and this file is where that decision is pinned.
//
// So the sums below are arithmetic anybody can check with a pencil, and they
// are written out in the comments so that a failure tells you which figure
// moved rather than only that one did.
//
// EVERY NAME, ID AND AMOUNT IS INVENTED.
import Testing

@testable import MyMoneyKit

private func account(
    _ id: String, _ currency: String = "GBP", opening: Int64 = 0, sortOrder: Int = 0,
    archived: Bool = false, excluded: Bool = false
) -> Account {
    Account(
        id: id, name: id, type: .current, currency: currency, openingBalanceMinor: opening,
        sortOrder: sortOrder, archived: archived, excludeFromNetWorth: excluded
    )
}

private func tx(
    _ id: String, _ date: String, _ amountMinor: Int64, category: String? = nil,
    account accountId: String = "a", currency: String = "GBP", payee: String? = nil,
    tags: [String] = [], splits: [Split] = [], transferGroupId: String? = nil
) -> Transaction {
    Transaction(
        id: id, accountId: accountId, date: date, amountMinor: amountMinor, currency: currency,
        payeeId: payee, categoryId: category, tagIds: tags, splits: splits,
        transferGroupId: transferGroupId
    )
}

/// The book every test in this file reads, and the sums it is built to make
/// checkable.
///
///   accounts   a: GBP, opening £1,000.00 (100000)
///              b: EUR, opening   €200.00  (20000), rate EUR→GBP 0.85
///   categories food (expense) ── coffee (expense, child of food)
///              rent (expense)
///              salary (income)
enum DashboardFixture {
    static let today = "2026-09-15"

    static let categories = [
        Category(id: "food", name: "Food", kind: .expense, colour: "#aabbcc"),
        Category(id: "coffee", name: "Coffee", parentId: "food", kind: .expense),
        Category(id: "rent", name: "Rent", kind: .expense),
        Category(id: "salary", name: "Salary", kind: .income),
    ]

    static let transactions = [
        tx("t1", "2026-04-10", -10_000, category: "food"),
        tx("t2", "2026-06-05", 200_000, category: "salary"),
        tx("t3", "2026-09-03", -5_000, category: "food"),
        tx("t4", "2026-09-07", -2_500, category: "coffee"),
        // A REFUND: a positive amount in an expense category. It subtracts from
        // spending rather than appearing as income (D14).
        tx("t5", "2026-09-09", 1_000, category: "food"),
        tx("t6", "2026-09-11", -7_000, category: "rent"),
        tx("t7", "2026-09-12", 300_000, category: "salary"),
        tx("t8", "2026-09-13", -4_000, category: "food", account: "b", currency: "EUR"),
    ]

    static let budgets = [
        Budget(
            id: "b-food", name: "Groceries", categoryIds: ["food"], amountMinor: 10_000,
            period: .monthly, startDate: "2026-09-01"
        ),
        Budget(
            id: "b-rent", name: "Rent", categoryIds: ["rent"], amountMinor: 5_000,
            period: .monthly, startDate: "2026-09-01"
        ),
        Budget(
            id: "b-old", name: "Aardvarks", categoryIds: ["coffee"], amountMinor: 100,
            period: .monthly, startDate: "2026-09-01", archived: true
        ),
    ]

    static func book(
        transactions: [Transaction] = DashboardFixture.transactions,
        budgets: [Budget] = DashboardFixture.budgets,
        accounts: [Account] = [account("a", opening: 100_000), account("b", "EUR", opening: 20_000, sortOrder: 1)],
        rates: [FxRate] = [FxRate(base: "EUR", quote: "GBP", rate: 0.85)]
    ) -> Book {
        Book(
            accounts: accounts, accountGroups: [], transactions: transactions,
            categories: categories, payees: [], tags: [], budgets: budgets, fxRates: rates,
            importBatches: [], settings: nil, baseCurrency: "GBP"
        )
    }

    static func summary() throws -> DashboardSummary {
        try Dashboard.summary(book: book(), today: today)
    }
}

struct DashboardNetWorthTests {

    /// a: 100000 + (−10000 + 200000 − 5000 − 2500 + 1000 − 7000 + 300000)
    ///     = 100000 + 476500 = 576500
    /// b: 20000 − 4000 = 16000 EUR → ×0.85 = 13600
    /// total 590100
    @Test("the headline is the accounts' own arithmetic -- hand-calculated")
    func headline() throws {
        let summary = try DashboardFixture.summary()
        #expect(summary.netWorth.totalBaseMinor == 590_100)
        #expect(summary.baseCurrency == "GBP")
        #expect(summary.netWorth.missingRateCurrencies.isEmpty)
    }

    /// Six months back from 15 September 2026 is 1 April, so the samples are
    /// the five month-ends April…August plus the range end, 15 September.
    ///
    ///   30 Apr   a 90000  + b 20000 EUR → 17000 = 107000
    ///   31 May   unchanged                      = 107000
    ///   30 Jun   a 290000 + 17000               = 307000
    ///   31 Jul   unchanged                      = 307000
    ///   31 Aug   unchanged                      = 307000
    ///   15 Sep   a 576500 + 16000 EUR → 13600   = 590100
    @Test("the sparkline samples every month-end and today -- hand-calculated")
    func sparkline() throws {
        let summary = try DashboardFixture.summary()
        #expect(
            summary.sparkline.map(\.date) == [
                "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-15",
            ]
        )
        #expect(
            summary.sparkline.map(\.totalBaseMinor) == [
                107_000, 107_000, 307_000, 307_000, 307_000, 590_100,
            ]
        )
    }

    /// The last sample IS the headline. If these two ever disagree the screen
    /// is showing a chart that ends somewhere other than the number above it.
    @Test("the chart ends exactly where the headline is")
    func chartEndsAtTheHeadline() throws {
        let summary = try DashboardFixture.summary()
        #expect(summary.sparkline.last?.totalBaseMinor == summary.netWorth.totalBaseMinor)
    }

    /// INFERRED, not ported -- the web app states no trend figure. 590100 −
    /// 107000 = 483100, across 30 April → 15 September.
    @Test("the trend is the change across the sampled window, with both its dates")
    func trend() throws {
        let trend = try #require(try DashboardFixture.summary().trend)
        #expect(trend.fromDate == "2026-04-30")
        #expect(trend.toDate == "2026-09-15")
        #expect(trend.fromMinor == 107_000)
        #expect(trend.toMinor == 590_100)
        #expect(trend.changeMinor == 483_100)
    }

    /// THE HEADLINE COUNTS EVERYTHING; THE CHART RUNS TO TODAY. A transaction
    /// the owner has already entered for next week is in one and not the other,
    /// and both figures are on the same card -- so the difference has to be
    /// stated rather than left looking like a bug.
    ///
    /// Found on a real screen: the demo book has 108 transactions dated ahead,
    /// and the headline sat £9,968.47 above the labelled end of its own line
    /// with nothing to explain it.
    ///
    /// Hand-calculated: today is 15 September; the £40,000 below is dated the
    /// 20th, so it is in the headline and off the end of the chart.
    @Test("money dated later than today is named, not left to look like a mistake")
    func laterDatedMoneyIsExplained() throws {
        let book = DashboardFixture.book(
            transactions: DashboardFixture.transactions + [
                tx("future", "2026-09-20", 40_000, category: "salary")
            ]
        )
        let summary = try Dashboard.summary(book: book, today: DashboardFixture.today)
        // The chart is unchanged -- it stops at today.
        #expect(summary.sparkline.last?.totalBaseMinor == 590_100)
        // The headline is not.
        #expect(summary.netWorth.totalBaseMinor == 630_100)
        #expect(summary.laterDatedMinor == 40_000)
    }

    /// The ordinary case: nothing dated ahead, so the two agree and the note is
    /// a zero the screen does not print.
    @Test("with nothing dated ahead the headline and the chart agree exactly")
    func nothingDatedLater() throws {
        #expect(try DashboardFixture.summary().laterDatedMinor == 0)
    }

    /// A trend needs two points. One point with a change beside it would be a
    /// number this app invented, which is the one thing it must not do.
    @Test("no trend is stated when there is nothing to compare")
    func trendNeedsTwoPoints() {
        #expect(Dashboard.trend(across: []) == nil)
        #expect(Dashboard.trend(across: [NetWorthPoint(date: "2026-09-15", totalBaseMinor: 5)]) == nil)
    }

    @Test("a currency with no rate is named, not quietly dropped")
    func missingRateIsSurfaced() throws {
        let book = DashboardFixture.book(
            accounts: [
                account("a", opening: 100_000),
                account("z", "CHF", opening: 50_000, sortOrder: 9),
            ],
            rates: []  // no EUR rate either, but no EUR account here
        )
        let summary = try Dashboard.summary(book: book, today: DashboardFixture.today)
        #expect(summary.netWorth.missingRateCurrencies == ["CHF"])
        // …and the figure that IS shown is the one currency that could be
        // converted, not a total pretending to include the other. Account "b"
        // is not in this book, so its EUR row moves no balance: "a" alone is
        // 100000 + 476500 = 576500, and the CHF 50000 is named rather than
        // added at a guessed rate.
        #expect(summary.netWorth.totalBaseMinor == 576_500)
    }
}

struct DashboardThisMonthTests {

    /// September's contributions:
    ///   income  salary 300000
    ///   expense food 5000 + coffee 2500 − refund 1000 + rent 7000
    ///           + EUR 4000 → 3400  = 16900
    ///   net     300000 − 16900     = 283100
    @Test("income, spend and net for the calendar month -- hand-calculated")
    func thisMonth() throws {
        let month = try DashboardFixture.summary().thisMonth
        #expect(month.month == "2026-09")
        #expect(month.incomeMinor == 300_000)
        #expect(month.expenseMinor == 16_900)
        #expect(month.netMinor == 283_100)
        #expect(month.missingRateCount == 0)
        #expect(!month.isEmpty)
    }

    /// The card's two-colour bar. 300000 / 316900 -- a PROPORTION, and the one
    /// Double on the screen. Never an amount.
    @Test("income's share of the month's flow is a proportion, not an amount")
    func incomeShare() throws {
        let month = try DashboardFixture.summary().thisMonth
        let share = try #require(month.incomeShare)
        #expect(abs(share - 300_000.0 / 316_900.0) < 1e-12)
        #expect(!month.refundsExceededSpending)
        #expect(!month.clawbacksExceededIncome)
    }

    /// A MONTH WHOSE REFUNDS BEAT ITS SPENDING. Found on a real screen: the
    /// demo book has one, `expenseMinor` came out negative, and the two-colour
    /// bar rendered 100% red -- a picture of a month of pure spending, which is
    /// the opposite of what happened.
    ///
    /// The figure itself is reported as-is, because the money really did come
    /// back. What must not happen is a bar drawn from it.
    @Test("a month of net refunds has no share to draw, and says so -- hand-calculated")
    func refundsExceedingSpending() throws {
        // September: one £50 purchase and a £200 refund, both in `food`, and
        // nothing else. −5000 + 20000 = +15000, so spend is −15000.
        let book = DashboardFixture.book(
            transactions: [
                tx("r1", "2026-09-03", -5_000, category: "food"),
                tx("r2", "2026-09-04", 20_000, category: "food"),
            ],
            budgets: []
        )
        let month = try Dashboard.summary(book: book, today: DashboardFixture.today).thisMonth
        #expect(month.expenseMinor == -15_000)
        #expect(month.incomeMinor == 0)
        #expect(month.netMinor == 15_000)
        #expect(month.refundsExceededSpending)
        // nil, NOT zero. Zero drew the wrong picture; nil makes the caller
        // decide what to show instead.
        #expect(month.incomeShare == nil)
        #expect(!month.isEmpty)
    }

    /// The mirror image: more taken back from income than came in.
    @Test("a month of net clawbacks has no share to draw either -- hand-calculated")
    func clawbacksExceedingIncome() throws {
        let book = DashboardFixture.book(
            transactions: [
                tx("c1", "2026-09-03", 10_000, category: "salary"),
                tx("c2", "2026-09-04", -25_000, category: "salary"),
            ],
            budgets: []
        )
        let month = try Dashboard.summary(book: book, today: DashboardFixture.today).thisMonth
        #expect(month.incomeMinor == -15_000)
        #expect(month.expenseMinor == 0)
        #expect(month.clawbacksExceededIncome)
        #expect(month.incomeShare == nil)
    }

    @Test("a month with nothing in it has no share either")
    func emptyMonthHasNoShare() throws {
        let summary = try Dashboard.summary(
            book: DashboardFixture.book(transactions: []), today: DashboardFixture.today
        )
        #expect(summary.thisMonth.incomeShare == nil)
    }

    /// A month with nothing in it says so rather than drawing a bar of two
    /// zeroes, and its share is 0 rather than a division by zero.
    @Test("an empty month is empty, not a chart of zeroes")
    func emptyMonth() throws {
        let summary = try Dashboard.summary(
            book: DashboardFixture.book(transactions: []), today: DashboardFixture.today
        )
        #expect(summary.thisMonth.isEmpty)
        #expect(summary.thisMonth.incomeShare == nil)
        #expect(summary.thisMonth.month == "2026-09")
    }

    /// The month runs to the END of September, so a transaction the owner has
    /// already logged for the 28th counts -- the picker's "this month" (which
    /// ends today) would leave it out.
    @Test("a transaction later this month still counts as this month")
    func laterThisMonthCounts() throws {
        let book = DashboardFixture.book(
            transactions: DashboardFixture.transactions + [
                tx("t9", "2026-09-28", -1_500, category: "rent")
            ]
        )
        let summary = try Dashboard.summary(book: book, today: DashboardFixture.today)
        #expect(summary.thisMonth.expenseMinor == 16_900 + 1_500)
    }
}

struct DashboardCategoryTests {

    /// Top level, so `food` rolls up its child `coffee`:
    ///   food subtree  5000 + 2500 − 1000 + 3400 = 9900
    ///   rent                                    = 7000
    ///   total                                   = 16900
    @Test("top categories roll up their subtrees -- hand-calculated")
    func topCategories() throws {
        let summary = try DashboardFixture.summary()
        #expect(summary.topCategories.map(\.name) == ["Food", "Rent"])
        #expect(summary.topCategories.map(\.spentMinor) == [9_900, 7_000])
        #expect(summary.categoryTotalMinor == 16_900)
        // Food has a child, so the row is drillable; Rent does not.
        #expect(summary.topCategories.map(\.hasChildren) == [true, false])
        #expect(summary.topCategories.first?.colour == "#aabbcc")
    }

    /// The card shows five. A sixth category exists in this book and must not
    /// be on the card -- but the TOTAL must still include it, or the
    /// percentages beside the rows would be shares of a total that is not the
    /// month's.
    @Test("the card shows five rows and the total counts all of them")
    func fiveRowsButTheWholeTotal() throws {
        let extras = (1...5).map { n in
            Category(id: "x\(n)", name: "Extra \(n)", kind: .expense)
        }
        let extraTx = (1...5).map { n in
            tx("x\(n)", "2026-09-05", Int64(-100 * n), category: "x\(n)")
        }
        let book = Book(
            accounts: [account("a", opening: 0)], accountGroups: [],
            transactions: DashboardFixture.transactions.filter { $0.accountId == "a" } + extraTx,
            categories: DashboardFixture.categories + extras, payees: [], tags: [],
            budgets: [], fxRates: [], importBatches: [], settings: nil, baseCurrency: "GBP"
        )
        let summary = try Dashboard.summary(book: book, today: DashboardFixture.today)
        #expect(summary.topCategories.count == Dashboard.categoryRows)
        // 5000 + 2500 − 1000 = 6500 food, 7000 rent, then 500, 400, 300, 200,
        // 100 for the extras. Total 6500 + 7000 + 1500 = 15000.
        #expect(summary.categoryTotalMinor == 15_000)
        #expect(summary.topCategories.map(\.spentMinor) == [7_000, 6_500, 500, 400, 300])
    }
}

struct DashboardBudgetTests {

    /// Groceries covers `food` AND its descendant `coffee` (D16):
    ///   5000 + 2500 − 1000 + 3400 = 9900 of 10000 → 100 left, not over
    /// Rent:
    ///   7000 of 5000 → 2000 over
    @Test("budget progress includes descendant categories -- hand-calculated")
    func budgetProgress() throws {
        let summary = try DashboardFixture.summary()
        let byName = Dictionary(uniqueKeysWithValues: summary.budgets.map { ($0.budget.name, $0) })

        let groceries = try #require(byName["Groceries"]).progress
        #expect(groceries.spentMinor == 9_900)
        #expect(groceries.limitMinor == 10_000)
        #expect(groceries.remainingMinor == 100)
        #expect(!groceries.over)
        #expect(groceries.window == PeriodWindow(start: "2026-09-01", end: "2026-09-30"))

        let rent = try #require(byName["Rent"]).progress
        #expect(rent.spentMinor == 7_000)
        #expect(rent.remainingMinor == -2_000)
        #expect(rent.over)
    }

    /// Most-used first: Rent at 7000/5000 = 1.4, Groceries at 9900/10000 =
    /// 0.99. And the archived one is not among them at any position.
    @Test("the card shows the budgets nearest their limit, archived ones excluded")
    func mostUsedFirst() throws {
        let summary = try DashboardFixture.summary()
        #expect(summary.budgets.map(\.budget.name) == ["Rent", "Groceries"])
        #expect(summary.budgetCount == 2)
        #expect(!summary.budgets.contains { $0.budget.archived })
    }

    /// Four rows, and a count that says how many there really are -- so the
    /// card cannot imply the owner has four budgets when they have nine.
    @Test("the card shows four, and says how many there are")
    func fourRowsAndAnHonestCount() throws {
        let many = (1...9).map { n in
            Budget(
                id: "b\(n)", name: "Budget \(n)", categoryIds: ["rent"],
                amountMinor: Int64(n) * 1_000, period: .monthly, startDate: "2026-09-01"
            )
        }
        let summary = try Dashboard.summary(
            book: DashboardFixture.book(budgets: many), today: DashboardFixture.today
        )
        #expect(summary.budgets.count == Dashboard.budgetRows)
        #expect(summary.budgetCount == 9)
        // All nine cover `rent` and spend 7000; pct is 7000/limit, so the
        // SMALLEST limit is the most used. 7000/1000 = 7.0 down to 7000/4000.
        #expect(summary.budgets.map(\.budget.name) == ["Budget 1", "Budget 2", "Budget 3", "Budget 4"])
    }

    /// Ties on percentage are broken by NAME, not left to the sort. Swift's
    /// `sorted(by:)` is not stable, so without the tiebreak these four could
    /// come back in a different order on a different run and the card would
    /// reshuffle itself under the owner's thumb.
    @Test("budgets tied on percentage come back in name order, every time")
    func tiesAreBrokenByName() throws {
        let tied = ["Zebra", "Apple", "Mango", "Beetle"].enumerated().map { index, name in
            Budget(
                id: "t\(index)", name: name, categoryIds: ["salary"], amountMinor: 1_000,
                period: .monthly, startDate: "2026-09-01"
            )
        }
        // None of them covers an expense category, so all four sit at 0%.
        for _ in 0..<8 {
            let summary = try Dashboard.summary(
                book: DashboardFixture.book(budgets: tied), today: DashboardFixture.today
            )
            #expect(summary.budgets.map(\.budget.name) == ["Apple", "Beetle", "Mango", "Zebra"])
        }
    }

    /// The excluded-transaction count is over EVERY live budget, not only the
    /// four on the card: a figure missing from a budget the card happens not to
    /// show is still a figure the owner is not seeing.
    @Test("the missing-rate count covers every budget, not just the shown ones")
    func missingRateCountCoversAllBudgets() throws {
        let chf = tx("c1", "2026-09-04", -9_999, category: "rent", account: "z", currency: "CHF")
        let many = (1...6).map { n in
            Budget(
                id: "b\(n)", name: "Budget \(n)", categoryIds: ["rent"],
                amountMinor: Int64(n) * 1_000, period: .monthly, startDate: "2026-09-01"
            )
        }
        let book = DashboardFixture.book(
            transactions: DashboardFixture.transactions + [chf],
            budgets: many,
            accounts: [
                account("a", opening: 100_000),
                account("b", "EUR", opening: 20_000, sortOrder: 1),
                account("z", "CHF", sortOrder: 2),
            ]
        )
        let summary = try Dashboard.summary(book: book, today: DashboardFixture.today)
        #expect(summary.budgets.count == 4)
        // One unconvertible transaction, counted once by each of the six live
        // budgets that cover its category.
        #expect(summary.budgetMissingRateCount == 6)
    }

    @Test("a book with no budgets says so rather than showing an empty bar")
    func noBudgets() throws {
        let summary = try Dashboard.summary(
            book: DashboardFixture.book(budgets: []), today: DashboardFixture.today
        )
        #expect(summary.budgets.isEmpty)
        #expect(summary.budgetCount == 0)
        #expect(summary.budgetMissingRateCount == 0)
    }
}

struct DashboardConsistencyTests {

    /// The four cards must be describing the SAME DAY. A dashboard that read
    /// the clock once per card could put a month's income against the next
    /// month's budget window if it were built across midnight.
    @Test("every card is built from one date, passed in")
    func oneDateForEveryCard() throws {
        let summary = try DashboardFixture.summary()
        #expect(summary.today == DashboardFixture.today)
        #expect(summary.thisMonth.month == String(DashboardFixture.today.prefix(7)))
        #expect(summary.sparkline.last?.date == DashboardFixture.today)
        for line in summary.budgets {
            #expect(line.progress.window.contains(DashboardFixture.today))
        }
    }

    /// Transfers are not flow (D13): moving money between the owner's own
    /// accounts must not appear as either income or spending, and must not
    /// change net worth either (a same-currency pair cancels).
    @Test("a transfer changes no figure on this screen")
    func transfersAreNotFlow() throws {
        let legs = [
            tx("x1", "2026-09-08", -50_000, account: "a", transferGroupId: "g"),
            tx("x2", "2026-09-08", 50_000, account: "a2", transferGroupId: "g"),
        ]
        let plain = try DashboardFixture.summary()
        let withTransfer = try Dashboard.summary(
            book: DashboardFixture.book(
                transactions: DashboardFixture.transactions + legs,
                accounts: [
                    account("a", opening: 100_000),
                    account("b", "EUR", opening: 20_000, sortOrder: 1),
                    account("a2", sortOrder: 2),
                ]
            ),
            today: DashboardFixture.today
        )
        #expect(withTransfer.thisMonth == plain.thisMonth)
        #expect(withTransfer.topCategories == plain.topCategories)
        #expect(withTransfer.netWorth.totalBaseMinor == plain.netWorth.totalBaseMinor)
    }

    /// `excludeFromNetWorth` re-scopes a TOTAL, never a transaction. Money
    /// spent from an excluded account is still money spent, so only the
    /// net-worth half of this screen may move.
    @Test("excluding an account changes the net worth and nothing else")
    func exclusionTouchesOnlyNetWorth() throws {
        let plain = try DashboardFixture.summary()
        let excluded = try Dashboard.summary(
            book: DashboardFixture.book(
                accounts: [
                    account("a", opening: 100_000),
                    account("b", "EUR", opening: 20_000, sortOrder: 1, excluded: true),
                ]
            ),
            today: DashboardFixture.today
        )
        #expect(excluded.thisMonth == plain.thisMonth)
        #expect(excluded.topCategories == plain.topCategories)
        #expect(excluded.budgets.map(\.progress) == plain.budgets.map(\.progress))
        #expect(excluded.netWorth.totalBaseMinor == 576_500)
    }
}
