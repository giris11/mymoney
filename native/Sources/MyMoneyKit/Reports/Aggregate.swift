// Report aggregation, ported from src/reports/aggregate.ts (SPEC §8.1.8).
//
// Six reports, one shared loader, and the same five rules under all of them:
//
//  1. Date ranges are INCLUSIVE of both ends. An inverted range yields
//     nothing -- not everything, and not an error.
//  2. Every figure is in the BASE currency, and each contribution is converted
//     and rounded EXACTLY ONCE. Not once per report, not once per total: once
//     per contribution, because that is what `fx.convertEach` pins and because
//     a split line is attributed to its own category and must carry its own
//     rounding.
//  3. A transaction whose currency has no rate to base is excluded from the
//     whole report and counted once in `missingRateCount`. Never converted at
//     a guessed rate, never counted as zero (SPEC §6).
//  4. TRANSFER LEGS ARE NOT FLOW (D13). Moving £500 from current to savings is
//     not £500 of spending and not £500 of income; both legs are excluded from
//     every report here. They remain entirely real to balances and net worth,
//     which is why `netWorthSeries` below does NOT skip them.
//  5. Ledger side is decided by CATEGORY KIND when a contribution is
//     categorised, and only by SIGN when it is not (D14). That is what makes a
//     refund subtract from spending instead of appearing as income, and a
//     salary clawback subtract from income instead of appearing as spending.
//
// AND ONE RULE ABOUT WHAT `excludeFromNetWorth` DOES NOT DO. It affects
// `netWorthSeries` and nothing else. Every other report here groups by
// CATEGORY, not by account: money spent from a gift card or a lent-money
// ledger is still money spent, and hiding it would make the spend reports lie
// about the owner's life. Excluding an account re-scopes a TOTAL, never a
// transaction.
import Foundation

public struct DateRange: Sendable, Hashable {
    public let from: String  // 'YYYY-MM-DD' inclusive
    public let to: String    // inclusive

    public init(from: String, to: String) {
        self.from = from
        self.to = to
    }

    /// An inverted range is empty, not an error: the UI lets the two date
    /// pickers cross, and "no rows" is the honest answer to "spending between
    /// July and June".
    public var isEmpty: Bool { from > to }

    public func contains(_ date: String) -> Bool { date >= from && date <= to }
}

// MARK: - Row types

public struct CategorySpendRow: Sendable, Hashable {
    /// nil is the uncategorised bucket.
    public let categoryId: String?
    public let name: String
    /// Absent, not empty-string, when the category has no colour: the oracle's
    /// rule 5 -- absent and null are different claims.
    public let colour: String?
    public let spentMinor: Int64  // positive
    public let hasChildren: Bool
}

public struct MonthlyIncomeExpense: Sendable, Hashable {
    public let month: String  // 'YYYY-MM'
    public let incomeMinor: Int64   // positive
    public let expenseMinor: Int64  // positive, net of refunds
}

public struct MonthlyCashFlow: Sendable, Hashable {
    public let month: String
    public let netMinor: Int64         // income − expense, signed
    public let cumulativeMinor: Int64  // running total ACROSS THE RANGE ONLY
}

public struct PayeeSpendRow: Sendable, Hashable {
    public let payeeId: String?  // nil = no payee
    public let name: String
    public let spentMinor: Int64  // positive
    /// DISTINCT transactions contributing; a multi-split transaction counts
    /// once, which is what makes "3 transactions at Tesco" true.
    public let txCount: Int
}

public struct TagSpendRow: Sendable, Hashable {
    public let tagId: String
    public let name: String
    public let spentMinor: Int64
    public let txCount: Int
}

public struct NetWorthPoint: Sendable, Hashable {
    public let date: String  // 'YYYY-MM-DD'
    public let totalBaseMinor: Int64
}

public struct CategorySpendReport: Sendable, Hashable {
    public let rows: [CategorySpendRow]
    public let totalMinor: Int64
    public let missingRateCount: Int
}

public struct MonthlyReport<Row: Sendable & Hashable>: Sendable, Hashable {
    public let rows: [Row]
    public let missingRateCount: Int
}

public struct PayeeSpendReport: Sendable, Hashable {
    public let rows: [PayeeSpendRow]
    public let missingRateCount: Int
}

public struct TagSpendReport: Sendable, Hashable {
    public let rows: [TagSpendRow]
    public let missingRateCount: Int
}

public struct NetWorthSeries: Sendable, Hashable {
    public let points: [NetWorthPoint]
    /// Currencies excluded from EVERY point because no rate to base exists.
    /// Sorted, matching the TypeScript's `.sort()` -- note that `netWorth()`
    /// in Balances.swift reports the same kind of list in INSERTION order,
    /// because the TypeScript does that there. The inconsistency is the
    /// original's and is reproduced rather than tidied away.
    public let missingRateCurrencies: [String]
}

// MARK: - The engine

public enum Reports {
    /// One report-relevant amount: a whole transaction, or one split of one.
    struct Contribution {
        let txId: String
        let month: String           // 'YYYY-MM' of the PARENT transaction's date
        let categoryId: String?     // the SPLIT's category on a split transaction
        let payeeId: String?        // the parent's payee
        let tagIds: [String]        // the parent's tags
        /// Signed, ORIGINAL currency -- used only to classify the ledger side
        /// when there is no category to classify by.
        let amountMinor: Int64
        /// Signed, converted to base, rounded once.
        let amountBaseMinor: Int64
    }

    struct FlowData {
        let contributions: [Contribution]
        let missingRateCount: Int
        let categories: [String: Category]
        /// Category ids with at least one child.
        let hasChild: Set<String>
    }

    /// Shared loader for the five flow reports.
    static func loadFlow(
        range: DateRange,
        book: Book
    ) throws -> FlowData {
        var byId: [String: Category] = [:]
        var hasChild = Set<String>()
        for c in book.categories {
            byId[c.id] = c
            if let p = c.parentId, !p.isEmpty { hasChild.insert(p) }
        }
        if range.isEmpty {
            return FlowData(contributions: [], missingRateCount: 0, categories: byId, hasChild: hasChild)
        }

        let base = book.baseCurrency
        let rates = book.rateTable
        var contributions: [Contribution] = []
        var missingRateCount = 0
        for tx in book.transactions where range.contains(tx.date) {
            if tx.transferGroupId != nil { continue }  // D13
            if rates.rate(from: tx.currency, to: base) == nil {
                missingRateCount += 1
                continue
            }
            let parts: [(categoryId: String?, amountMinor: Int64)] =
                tx.splits.isEmpty
                ? [(tx.categoryId, tx.amountMinor)]
                : tx.splits.map { ($0.categoryId, $0.amountMinor) }
            for part in parts {
                switch Money.convert(minor: part.amountMinor, from: tx.currency, to: base, using: rates) {
                case .converted(let value):
                    contributions.append(
                        Contribution(
                            txId: tx.id,
                            month: String(tx.date.prefix(7)),
                            categoryId: part.categoryId,
                            payeeId: tx.payeeId,
                            tagIds: tx.tagIds,
                            amountMinor: part.amountMinor,
                            amountBaseMinor: value
                        )
                    )
                case .missingRate:
                    continue  // unreachable: the rate was checked above
                case .notRepresentable:
                    throw MoneyError.notRepresentable("a contribution to this report")
                }
            }
        }
        return FlowData(
            contributions: contributions, missingRateCount: missingRateCount,
            categories: byId, hasChild: hasChild
        )
    }

    enum Side { case income, expense }

    /// Category kind when categorised, sign when not (D14). A zero
    /// uncategorised amount belongs to neither side.
    static func side(of c: Contribution, categories: [String: Category]) -> Side? {
        if let id = c.categoryId, let cat = categories[id] {
            return cat.kind == .income ? .income : .expense
        }
        if c.amountMinor < 0 { return .expense }
        if c.amountMinor > 0 { return .income }
        return nil
    }

    /// Every 'YYYY-MM' from `from`'s month to `to`'s month, ascending.
    static func months(in range: DateRange) throws -> [String] {
        if range.isEmpty { return [] }
        guard let fromDate = CalendarDate(iso: range.from) else { throw DomainError.invalidDate(range.from) }
        guard let toDate = CalendarDate(iso: range.to) else { throw DomainError.invalidDate(range.to) }
        var out: [String] = []
        var cur = fromDate.startOfMonth
        let last = toDate.startOfMonth
        while cur <= last {
            out.append(cur.monthKey)
            cur = cur.addingMonths(1)
        }
        return out
    }

    /// The row order every spend report uses: amount DESCENDING, then name,
    /// then first-seen position.
    ///
    /// The third key has no counterpart in the TypeScript and is not optional
    /// here. JavaScript's `Array.prototype.sort` has been required to be
    /// stable since ES2019, so two rows equal on amount AND name come back in
    /// the order they were inserted into the Map; Swift's `sorted(by:)` is not
    /// stable and would return them in whatever order the sort happened to
    /// leave them. Without this the same book could produce two different
    /// (equally defensible) report row orders on two runs, which is the kind
    /// of thing that makes an owner doubt the whole screen.
    ///
    /// The name comparison is `localeCompare`'s -- locale-aware -- pinned to
    /// en_GB by `DisplayOrder` (Domain/BudgetList.swift), which is the one
    /// place that judgement is made so the report rows and the budgets list
    /// cannot come to order names differently. The TypeScript passes no locale
    /// and gets the browser's. Nothing in the oracle exercises a name tie, so
    /// this is a judgement, and it is recorded as one.
    static func rankedByAmount<Row>(
        _ rows: [(index: Int, row: Row)],
        amount: (Row) -> Int64,
        name: (Row) -> String
    ) -> [Row] {
        rows.sorted { lhs, rhs in
            let a = amount(lhs.row), b = amount(rhs.row)
            if a != b { return a > b }
            let byName = DisplayOrder.compareNames(name(lhs.row), name(rhs.row))
            if byName != .orderedSame { return byName == .orderedAscending }
            return lhs.index < rhs.index
        }.map(\.row)
    }

    // MARK: Spending by category

    /// Spending grouped by category.
    ///
    /// `parentId == nil` gives the top-level rows, each rolling up its WHOLE
    /// subtree. A category id gives its direct children (drill-down) plus a row
    /// for amounts logged directly on the parent itself -- without that row,
    /// drilling into a category would show less than the row you drilled from
    /// and the difference would be invisible.
    ///
    /// Only expense-kind categories count; an uncategorised contribution counts
    /// only when it is expense-signed, and lands in 'Uncategorised' at top
    /// level. Refunds (D14) subtract. Zero rows are dropped.
    public static func spendingByCategory(
        _ range: DateRange, parentId: String?, book: Book
    ) throws -> CategorySpendReport {
        let flow = try loadFlow(range: range, book: book)

        // Insertion-ordered buckets: a Swift Dictionary has no order at all,
        // and the sort's final tiebreak needs "first seen" to mean something.
        var order: [String] = []
        var buckets: [String: (row: CategorySpendRow, index: Int)] = [:]
        func add(_ key: String, _ make: () -> CategorySpendRow, _ amountBaseMinor: Int64) throws {
            if buckets[key] == nil {
                buckets[key] = (make(), order.count)
                order.append(key)
            }
            let existing = buckets[key]!
            // Expenses are negative -> spend positive; refunds subtract.
            let (spent, overflowed) = existing.row.spentMinor.subtractingReportingOverflow(amountBaseMinor)
            if overflowed { throw MoneyError.overflow("spending in category \(key)") }
            buckets[key] = (
                CategorySpendRow(
                    categoryId: existing.row.categoryId, name: existing.row.name,
                    colour: existing.row.colour, spentMinor: spent,
                    hasChildren: existing.row.hasChildren
                ),
                existing.index
            )
        }

        for c in flow.contributions {
            let cat = c.categoryId.flatMap { flow.categories[$0] }
            if parentId == nil {
                guard let cat else {
                    // Uncategorised, or a dangling category id: expense-signed
                    // only. A leading space keys it apart from every real id.
                    if c.amountMinor < 0 {
                        try add(" uncategorised", {
                            CategorySpendRow(
                                categoryId: nil, name: "Uncategorised", colour: nil,
                                spentMinor: 0, hasChildren: false
                            )
                        }, c.amountBaseMinor)
                    }
                    continue
                }
                if cat.kind != .expense { continue }  // income is never "spending"
                let root = Categories.root(of: cat, in: flow.categories)
                try add(root.id, {
                    CategorySpendRow(
                        categoryId: root.id, name: root.name, colour: root.colour,
                        spentMinor: 0, hasChildren: flow.hasChild.contains(root.id)
                    )
                }, c.amountBaseMinor)
            } else {
                guard let cat, cat.kind == .expense else { continue }
                guard let bucket = Categories.bucket(of: cat, within: parentId!, in: flow.categories)
                else { continue }  // outside the parent's subtree
                switch bucket {
                case .itself:
                    let parent = flow.categories[parentId!]
                    try add(parentId!, {
                        CategorySpendRow(
                            categoryId: parentId, name: parent?.name ?? "Unknown category",
                            colour: parent?.colour, spentMinor: 0, hasChildren: false
                        )
                    }, c.amountBaseMinor)
                case .child(let child):
                    try add(child.id, {
                        CategorySpendRow(
                            categoryId: child.id, name: child.name, colour: child.colour,
                            spentMinor: 0, hasChildren: flow.hasChild.contains(child.id)
                        )
                    }, c.amountBaseMinor)
                }
            }
        }

        let kept = order.compactMap { buckets[$0] }.filter { $0.row.spentMinor != 0 }
        let rows = rankedByAmount(
            kept.map { (index: $0.index, row: $0.row) },
            amount: \.spentMinor, name: \.name
        )
        let total = try Money.sum(rows.map(\.spentMinor))
        return CategorySpendReport(rows: rows, totalMinor: total, missingRateCount: flow.missingRateCount)
    }

    // MARK: Income vs expense by month

    /// One row for EVERY month in the range, zero-filled, ascending. A month
    /// with no activity is a fact worth showing; dropping it would make a chart
    /// draw a straight line through a gap that was really a flat month.
    public static func incomeVsExpenseByMonth(
        _ range: DateRange, book: Book
    ) throws -> MonthlyReport<MonthlyIncomeExpense> {
        let flow = try loadFlow(range: range, book: book)
        let order = try months(in: range)
        var income: [String: Int64] = [:]
        var expense: [String: Int64] = [:]
        for m in order {
            income[m] = 0
            expense[m] = 0
        }
        for c in flow.contributions {
            guard income[c.month] != nil else { continue }
            switch side(of: c, categories: flow.categories) {
            case .income:
                let (next, overflowed) = income[c.month]!.addingReportingOverflow(c.amountBaseMinor)
                if overflowed { throw MoneyError.overflow("income in \(c.month)") }
                income[c.month] = next
            case .expense:
                let (next, overflowed) = expense[c.month]!.subtractingReportingOverflow(c.amountBaseMinor)
                if overflowed { throw MoneyError.overflow("expense in \(c.month)") }
                expense[c.month] = next
            case nil:
                continue
            }
        }
        let rows = order.map {
            MonthlyIncomeExpense(month: $0, incomeMinor: income[$0]!, expenseMinor: expense[$0]!)
        }
        return MonthlyReport(rows: rows, missingRateCount: flow.missingRateCount)
    }

    // MARK: Cash flow by month

    /// `cumulativeMinor` runs across the REQUESTED RANGE ONLY and starts at
    /// zero -- it is "what this period did", not a running net worth. The two
    /// are different questions and `netWorthSeries` answers the other one.
    public static func cashFlowByMonth(
        _ range: DateRange, book: Book
    ) throws -> MonthlyReport<MonthlyCashFlow> {
        let ie = try incomeVsExpenseByMonth(range, book: book)
        var cumulative: Int64 = 0
        var rows: [MonthlyCashFlow] = []
        for row in ie.rows {
            let (net, netOverflowed) = row.incomeMinor.subtractingReportingOverflow(row.expenseMinor)
            if netOverflowed { throw MoneyError.overflow("net flow in \(row.month)") }
            let (next, cumOverflowed) = cumulative.addingReportingOverflow(net)
            if cumOverflowed { throw MoneyError.overflow("cumulative flow at \(row.month)") }
            cumulative = next
            rows.append(MonthlyCashFlow(month: row.month, netMinor: net, cumulativeMinor: cumulative))
        }
        return MonthlyReport(rows: rows, missingRateCount: ie.missingRateCount)
    }

    // MARK: Spending by payee

    public static func spendingByPayee(
        _ range: DateRange, limit: Int? = nil, book: Book
    ) throws -> PayeeSpendReport {
        let flow = try loadFlow(range: range, book: book)
        var names: [String: String] = [:]
        for p in book.payees { names[p.id] = p.name }

        var order: [String?] = []
        var totals: [String?: (spent: Int64, txIds: Set<String>, index: Int)] = [:]
        for c in flow.contributions {
            guard side(of: c, categories: flow.categories) == .expense else { continue }
            if totals[c.payeeId] == nil {
                totals[c.payeeId] = (0, [], order.count)
                order.append(c.payeeId)
            }
            var entry = totals[c.payeeId]!
            let (spent, overflowed) = entry.spent.subtractingReportingOverflow(c.amountBaseMinor)
            if overflowed { throw MoneyError.overflow("spending at a payee") }
            entry.spent = spent
            entry.txIds.insert(c.txId)
            totals[c.payeeId] = entry
        }

        let kept = order.compactMap { id -> (index: Int, row: PayeeSpendRow)? in
            guard let entry = totals[id], entry.spent != 0 else { return nil }
            let name = id == nil ? "No payee" : (names[id!] ?? "Unknown payee")
            return (
                entry.index,
                PayeeSpendRow(payeeId: id, name: name, spentMinor: entry.spent, txCount: entry.txIds.count)
            )
        }
        var rows = rankedByAmount(kept, amount: \.spentMinor, name: \.name)
        if let limit { rows = Array(rows.prefix(limit)) }
        return PayeeSpendReport(rows: rows, missingRateCount: flow.missingRateCount)
    }

    // MARK: Spending by tag

    /// Tag rows DELIBERATELY OVERLAP: a transaction carrying two tags counts in
    /// full under each, so tag totals do not sum to the spend total. That is
    /// the question being asked ("how much did 'work' cost me"), not a bug.
    public static func spendingByTag(
        _ range: DateRange, book: Book
    ) throws -> TagSpendReport {
        let flow = try loadFlow(range: range, book: book)
        var names: [String: String] = [:]
        for t in book.tags { names[t.id] = t.name }

        var order: [String] = []
        var totals: [String: (spent: Int64, txIds: Set<String>, index: Int)] = [:]
        for c in flow.contributions {
            guard side(of: c, categories: flow.categories) == .expense else { continue }
            for tagId in c.tagIds {
                if totals[tagId] == nil {
                    totals[tagId] = (0, [], order.count)
                    order.append(tagId)
                }
                var entry = totals[tagId]!
                let (spent, overflowed) = entry.spent.subtractingReportingOverflow(c.amountBaseMinor)
                if overflowed { throw MoneyError.overflow("spending under a tag") }
                entry.spent = spent
                entry.txIds.insert(c.txId)
                totals[tagId] = entry
            }
        }

        let kept = order.compactMap { id -> (index: Int, row: TagSpendRow)? in
            guard let entry = totals[id], entry.spent != 0 else { return nil }
            return (
                entry.index,
                TagSpendRow(
                    tagId: id, name: names[id] ?? "Unknown tag",
                    spentMinor: entry.spent, txCount: entry.txIds.count
                )
            )
        }
        return TagSpendReport(
            rows: rankedByAmount(kept, amount: \.spentMinor, name: \.name),
            missingRateCount: flow.missingRateCount
        )
    }

    // MARK: Net worth over time

    /// Net worth sampled at each month-end in range, plus the range end.
    ///
    /// CUMULATIVE FROM THE BEGINNING OF TIME: opening balances plus every
    /// transaction dated on or before the sample date, not just the range's
    /// activity. Only accounts that COUNT are included, using the same
    /// `countsTowardNetWorth` predicate as the headline figure -- imported from
    /// Balances rather than re-spelled here, so a chart and the number above it
    /// can never disagree about which accounts are in the total.
    ///
    /// Transfer legs are NOT special-cased. They are real balance changes on
    /// both accounts, and a same-currency pair cancels in the total by itself.
    /// Per-currency running totals stay integer minor units and each currency
    /// subtotal is converted once per sample point (D12).
    public static func netWorthSeries(
        _ range: DateRange, book: Book
    ) throws -> NetWorthSeries {
        if range.isEmpty { return NetWorthSeries(points: [], missingRateCurrencies: []) }
        guard let fromDate = CalendarDate(iso: range.from) else { throw DomainError.invalidDate(range.from) }
        guard let toDate = CalendarDate(iso: range.to) else { throw DomainError.invalidDate(range.to) }

        let base = book.baseCurrency
        let rates = book.rateTable
        let accounts = book.accounts.filter(Balances.countsTowardNetWorth)
        var currencyOfAccount: [String: String] = [:]
        for a in accounts { currencyOfAccount[a.id] = a.currency }

        // Opening balances seed the per-currency totals; a currency with no
        // rate is excluded UP FRONT, so no point ever contains a guessed
        // number and no point is silently missing one either.
        var missing = Set<String>()
        var currencyOrder: [String] = []
        var totals: [String: Int64] = [:]
        for a in accounts {
            if rates.rate(from: a.currency, to: base) == nil {
                missing.insert(a.currency)
                continue
            }
            if totals[a.currency] == nil {
                totals[a.currency] = 0
                currencyOrder.append(a.currency)
            }
            let (next, overflowed) = totals[a.currency]!.addingReportingOverflow(a.openingBalanceMinor)
            if overflowed { throw MoneyError.overflow("opening balances in \(a.currency)") }
            totals[a.currency] = next
        }

        // Only the counting accounts' rows matter: an archived or excluded
        // account never entered `currencyOfAccount`, so its rows drop out here.
        // Sorted by date, with the input position as a stable tiebreak.
        let relevant = book.transactions
            .enumerated()
            .filter { $0.element.date <= range.to && currencyOfAccount[$0.element.accountId] != nil }
            .sorted { lhs, rhs in
                if lhs.element.date != rhs.element.date { return lhs.element.date < rhs.element.date }
                return lhs.offset < rhs.offset
            }
            .map(\.element)

        // Sample dates: every month-end inside the range, plus the range end.
        var sampleSet = Set<String>()
        var cur = fromDate.startOfMonth
        let last = toDate.startOfMonth
        while cur <= last {
            let end = cur.endOfMonth.iso
            if end >= range.from && end <= range.to { sampleSet.insert(end) }
            cur = cur.addingMonths(1)
        }
        sampleSet.insert(range.to)
        let sampleDates = sampleSet.sorted(by: jsStringLess)

        var points: [NetWorthPoint] = []
        var i = 0
        for date in sampleDates {
            while i < relevant.count && relevant[i].date <= date {
                let tx = relevant[i]
                let ccy = currencyOfAccount[tx.accountId]!
                if !missing.contains(ccy) {
                    let (next, overflowed) = (totals[ccy] ?? 0).addingReportingOverflow(tx.amountMinor)
                    if overflowed { throw MoneyError.overflow("running total in \(ccy)") }
                    totals[ccy] = next
                }
                i += 1
            }
            var total: Int64 = 0
            for ccy in currencyOrder {
                switch Money.convert(minor: totals[ccy]!, from: ccy, to: base, using: rates) {
                case .converted(let value):
                    let (next, overflowed) = total.addingReportingOverflow(value)
                    if overflowed { throw MoneyError.overflow("net worth at \(date)") }
                    total = next
                case .missingRate:
                    continue  // unreachable: currencies without a rate never entered `totals`
                case .notRepresentable:
                    throw MoneyError.notRepresentable("the \(ccy) subtotal at \(date)")
                }
            }
            points.append(NetWorthPoint(date: date, totalBaseMinor: total))
        }
        return NetWorthSeries(points: points, missingRateCurrencies: missing.sorted(by: jsStringLess))
    }
}
