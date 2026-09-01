// What the oracle cannot reach about reports and budgets.
//
// The fixtures state figures for two named books. What they cannot state are
// the INVARIANTS between reports — that excluding an account from net worth
// changes the net-worth chart and nothing else, that the last point of the
// series is the headline figure, that an unconvertible transaction is counted
// once however many splits it has — and the refusals that only appear at
// figures no real ledger reaches.
import Testing

@testable import MyMoneyKit

private func account(
    _ id: String, _ currency: String = "GBP", opening: Int64 = 0,
    archived: Bool = false, excluded: Bool = false, sortOrder: Int = 0
) -> Account {
    Account(
        id: id, name: id, type: .current, currency: currency, openingBalanceMinor: opening,
        sortOrder: sortOrder, archived: archived, excludeFromNetWorth: excluded
    )
}

private func tx(
    _ id: String, account accountId: String, date: String, _ amountMinor: Int64,
    currency: String = "GBP", category: String? = nil, payee: String? = nil,
    tags: [String] = [], splits: [Split] = [], transferGroupId: String? = nil
) -> Transaction {
    Transaction(
        id: id, accountId: accountId, date: date, amountMinor: amountMinor, currency: currency,
        payeeId: payee, categoryId: category, tagIds: tags, splits: splits,
        transferGroupId: transferGroupId
    )
}

private func book(
    accounts: [Account], transactions: [Transaction], categories: [Category] = [],
    payees: [Payee] = [], tags: [MyMoneyKit.Tag] = [], rates: [FxRate] = [], base: String = "GBP"
) -> Book {
    Book(
        accounts: accounts, accountGroups: [], transactions: transactions,
        categories: categories, payees: payees, tags: tags, budgets: [], fxRates: rates,
        importBatches: [], settings: nil, baseCurrency: base
    )
}

struct ReportInvariantTests {
    private let categories = [
        Category(id: "food", name: "Food", kind: .expense),
        Category(id: "salary", name: "Salary", kind: .income),
    ]

    /// SPEC's rule, and the one most likely to be "tidied" into a bug:
    /// `excludeFromNetWorth` re-scopes a TOTAL, never a transaction. Money
    /// spent from a gift-card ledger is still money spent, and a spend report
    /// that quietly omitted it would make the owner's own spending invisible
    /// to him.
    @Test("excluding an account from net worth changes no flow report at all")
    func exclusionsDoNotTouchFlowReports() throws {
        let rows = [
            tx("t1", account: "a", date: "2026-05-02", -5000, category: "food", payee: "p"),
            tx("t2", account: "b", date: "2026-05-03", -2500, category: "food", payee: "p"),
            tx("t3", account: "a", date: "2026-05-04", 100_000, category: "salary", payee: "p"),
        ]
        let accounts = [account("a"), account("b", sortOrder: 1)]
        let excludedAccounts = [account("a"), account("b", excluded: true, sortOrder: 1)]
        let payees = [Payee(id: "p", name: "Shop")]
        let plain = book(accounts: accounts, transactions: rows, categories: categories, payees: payees)
        let excluded = book(
            accounts: excludedAccounts, transactions: rows, categories: categories, payees: payees
        )
        let range = DateRange(from: "2026-05-01", to: "2026-05-31")

        #expect(
            try Reports.spendingByCategory(range, parentId: nil, book: plain)
                == Reports.spendingByCategory(range, parentId: nil, book: excluded)
        )
        #expect(
            try Reports.incomeVsExpenseByMonth(range, book: plain)
                == Reports.incomeVsExpenseByMonth(range, book: excluded)
        )
        #expect(
            try Reports.spendingByPayee(range, book: plain)
                == Reports.spendingByPayee(range, book: excluded)
        )
        // …and the one report it DOES change.
        let plainSeries = try Reports.netWorthSeries(range, book: plain)
        let excludedSeries = try Reports.netWorthSeries(range, book: excluded)
        #expect(plainSeries != excludedSeries)
        #expect(plainSeries.points.last!.totalBaseMinor == 92500)
        #expect(excludedSeries.points.last!.totalBaseMinor == 95000)
    }

    /// The chart and the headline figure must never disagree about which
    /// accounts are in the total. They share `countsTowardNetWorth`; this is
    /// the test that says why that sharing matters.
    @Test("the last point of the series is the headline net worth")
    func seriesEndsAtTheHeadlineFigure() throws {
        let b = book(
            accounts: [
                account("a", opening: 100_000),
                account("b", "EUR", opening: 20000, sortOrder: 1),
                account("c", opening: 999_999, archived: true, sortOrder: 2),
                account("d", opening: 555_555, excluded: true, sortOrder: 3),
            ],
            transactions: [
                tx("t1", account: "a", date: "2026-05-02", -5000),
                tx("t2", account: "b", date: "2026-05-03", -1000, currency: "EUR"),
                tx("t3", account: "c", date: "2026-05-04", -777, currency: "GBP"),
            ],
            rates: [FxRate(base: "EUR", quote: "GBP", rate: 0.85)]
        )
        let series = try Reports.netWorthSeries(DateRange(from: "2026-05-01", to: "2026-05-31"), book: b)
        let headline = try b.netWorth().totalBaseMinor
        #expect(series.points.last!.totalBaseMinor == headline)
    }

    @Test("a transaction with no rate is counted once, however many splits it has")
    func missingRateCountedOncePerTransaction() throws {
        let b = book(
            accounts: [account("chf", "CHF")],
            transactions: [
                tx(
                    "t1", account: "chf", date: "2026-05-02", -8000, currency: "CHF",
                    splits: [
                        Split(categoryId: "food", amountMinor: -5000),
                        Split(categoryId: "food", amountMinor: -3000),
                    ]
                )
            ],
            categories: categories
        )
        let report = try Reports.spendingByCategory(
            DateRange(from: "2026-05-01", to: "2026-05-31"), parentId: nil, book: b
        )
        // Two splits, ONE excluded transaction: the UI says "N transactions
        // excluded", and counting per split would make that sentence false.
        #expect(report.missingRateCount == 1)
        #expect(report.rows.isEmpty)
        #expect(report.totalMinor == 0)
    }

    @Test("an inverted range is empty everywhere, and is not an error")
    func invertedRange() throws {
        let b = book(
            accounts: [account("a", opening: 1000)],
            transactions: [tx("t1", account: "a", date: "2026-05-02", -500, category: "food")],
            categories: categories
        )
        let inverted = DateRange(from: "2026-06-01", to: "2026-05-01")
        #expect(try Reports.spendingByCategory(inverted, parentId: nil, book: b).rows.isEmpty)
        #expect(try Reports.incomeVsExpenseByMonth(inverted, book: b).rows.isEmpty)
        #expect(try Reports.cashFlowByMonth(inverted, book: b).rows.isEmpty)
        #expect(try Reports.netWorthSeries(inverted, book: b).points.isEmpty)
    }

    @Test("a refund nets against spending rather than appearing as income")
    func refundsNetWithinTheirSide() throws {
        let b = book(
            accounts: [account("a")],
            transactions: [
                tx("t1", account: "a", date: "2026-05-02", -5000, category: "food"),
                // Positive, but in an EXPENSE category: a refund (D14). Classed
                // by category KIND, not by sign.
                tx("t2", account: "a", date: "2026-05-03", 2000, category: "food"),
                // Negative, but in an INCOME category: a clawback.
                tx("t3", account: "a", date: "2026-05-04", -1000, category: "salary"),
                tx("t4", account: "a", date: "2026-05-05", 100_000, category: "salary"),
            ],
            categories: categories
        )
        let range = DateRange(from: "2026-05-01", to: "2026-05-31")
        let months = try Reports.incomeVsExpenseByMonth(range, book: b)
        #expect(months.rows.count == 1)
        #expect(months.rows[0].expenseMinor == 3000)   // 5000 spent − 2000 refunded
        #expect(months.rows[0].incomeMinor == 99000)   // 100000 earned − 1000 clawed back
    }

    @Test("a month with no activity still gets a row, so a chart cannot draw through a gap")
    func zeroFilledMonths() throws {
        let b = book(accounts: [account("a")], transactions: [], categories: categories)
        let rows = try Reports.cashFlowByMonth(DateRange(from: "2026-01-15", to: "2026-04-02"), book: b).rows
        #expect(rows.map(\.month) == ["2026-01", "2026-02", "2026-03", "2026-04"])
        #expect(rows.allSatisfy { $0.netMinor == 0 && $0.cumulativeMinor == 0 })
    }

    @Test("a total that would overflow Int64 is refused, never wrapped")
    func overflowIsRefused() throws {
        let b = book(
            accounts: [account("a"), account("b", sortOrder: 1)],
            transactions: [
                tx("t1", account: "a", date: "2026-05-02", -Int64.max, category: "food"),
                tx("t2", account: "b", date: "2026-05-03", -Int64.max, category: "food"),
            ],
            categories: categories
        )
        // Wrapping would turn £92 quadrillion of spending into a NEGATIVE
        // total, with no error anywhere. A refusal is the only honest answer.
        #expect(throws: MoneyError.self) {
            try Reports.spendingByCategory(
                DateRange(from: "2026-05-01", to: "2026-05-31"), parentId: nil, book: b
            )
        }
    }
}

struct BudgetSpendTests {
    private let categories = [
        Category(id: "food", name: "Food", kind: .expense),
        Category(id: "groceries", name: "Groceries", parentId: "food", kind: .expense),
        Category(id: "coffee", name: "Coffee", parentId: "groceries", kind: .expense),
        Category(id: "travel", name: "Travel", kind: .expense),
    ]

    private func budgetBook(_ transactions: [Transaction], rates: [FxRate] = []) -> Book {
        book(
            accounts: [account("a"), account("chf", "CHF", sortOrder: 1)],
            transactions: transactions, categories: categories, rates: rates
        )
    }

    @Test("a budget covers its categories and every descendant, three levels down")
    func descendantsAreCovered() throws {
        let b = budgetBook([
            tx("t1", account: "a", date: "2026-03-05", -1000, category: "food"),
            tx("t2", account: "a", date: "2026-03-06", -2000, category: "groceries"),
            tx("t3", account: "a", date: "2026-03-07", -300, category: "coffee"),
            tx("t4", account: "a", date: "2026-03-08", -9999, category: "travel"),
        ])
        let progress = try b.budgetProgress(
            BudgetSpec(categoryIds: ["food"], amountMinor: 10000, period: .monthly, startDate: "2026-03-01"),
            refDate: "2026-03-15"
        )
        #expect(progress.spentMinor == 3300)
        #expect(!progress.over)
    }

    @Test("a transfer leg is never spending, however it is categorised")
    func transfersNeverCount() throws {
        let b = budgetBook([
            tx("t1", account: "a", date: "2026-03-05", -50000, category: "food", transferGroupId: "g1"),
        ])
        let progress = try b.budgetProgress(
            BudgetSpec(categoryIds: ["food"], amountMinor: 10000, period: .monthly, startDate: "2026-03-01"),
            refDate: "2026-03-15"
        )
        #expect(progress.spentMinor == 0)
        #expect(progress.pct == 0)
    }

    @Test("spending exactly the limit is not over, and a penny more is")
    func theBoundaryIsExact() throws {
        func spent(_ amount: Int64) throws -> BudgetProgress {
            try budgetBook([tx("t", account: "a", date: "2026-03-05", -amount, category: "food")])
                .budgetProgress(
                    BudgetSpec(
                        categoryIds: ["food"], amountMinor: 10000,
                        period: .monthly, startDate: "2026-03-01"
                    ),
                    refDate: "2026-03-15"
                )
        }
        #expect(try !spent(10000).over)
        #expect(try spent(10000).remainingMinor == 0)
        #expect(try spent(10001).over)
        #expect(try spent(10001).remainingMinor == -1)
    }

    @Test("a zero limit gives a zero ratio rather than a division by zero")
    func zeroLimit() throws {
        let progress = try budgetBook([
            tx("t", account: "a", date: "2026-03-05", -5000, category: "food")
        ]).budgetProgress(
            BudgetSpec(categoryIds: ["food"], amountMinor: 0, period: .monthly, startDate: "2026-03-01"),
            refDate: "2026-03-15"
        )
        #expect(progress.pct == 0)
        #expect(progress.spentMinor == 5000)
        #expect(progress.over)
    }

    @Test("only the splits the budget covers contribute, and the parent's own category is ignored")
    func splitsContributeIndividually() throws {
        let b = budgetBook([
            tx(
                "t1", account: "a", date: "2026-03-05", -6000,
                category: "travel",  // ignored outright: the row has splits
                splits: [
                    Split(categoryId: "groceries", amountMinor: -4000),
                    Split(categoryId: "travel", amountMinor: -2000),
                ]
            )
        ])
        let progress = try b.budgetProgress(
            BudgetSpec(categoryIds: ["food"], amountMinor: 10000, period: .monthly, startDate: "2026-03-01"),
            refDate: "2026-03-15"
        )
        #expect(progress.spentMinor == 4000)
    }
}
