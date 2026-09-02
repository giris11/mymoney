// Every budget, with how it is doing -- ported from `allBudgetProgress` in
// src/domain/budgets.ts.
//
// `Budgets.progress` (the oracle-driven part, in Budgets.swift) deliberately
// takes a `BudgetSpec` and knows nothing about a budget's id, name or archived
// flag: the oracle's 45 cases state a period, a start date, an amount and a set
// of category ids, and a function that demanded a name would have forced the
// fixtures to invent one. This file is the other half -- WHICH budgets a screen
// shows and in WHAT ORDER -- and it is separate so that adding a screen can
// never edit a file the oracle is holding to account.
//
// TWO RULES, BOTH THE WEB APP'S:
//
//   * ARCHIVED BUDGETS ARE NOT SHOWN alongside live ones. They are not deleted
//     and not hidden either -- the budgets screen lists them under their own
//     heading, exactly as the browser does -- but they take no part in "how am
//     I doing this month".
//   * THE ORDER IS BY NAME, decided before any spend is calculated. Sorting by
//     "most over budget" would reorder the list under the owner's thumb every
//     time a transaction landed, and the budget you were about to tap would
//     move.
import Foundation

/// A budget and its progress, together.
///
/// A pair rather than a field on `BudgetProgress`, because `BudgetProgress` is
/// what the oracle compares and it states only arithmetic. The identity of the
/// budget is a UI concern and lives here.
public struct BudgetLine: Sendable, Hashable, Identifiable {
    public let budget: Budget
    public let progress: BudgetProgress

    public var id: String { budget.id }

    public init(budget: Budget, progress: BudgetProgress) {
        self.budget = budget
        self.progress = progress
    }
}

/// The one name ordering the display layer uses.
///
/// `localeCompare`'s, pinned to en_GB -- the TypeScript passes no locale and
/// gets the browser's, so this is a judgement, recorded as one in
/// `Reports.rankedByAmount` where it was first needed. It is here so that the
/// budgets list and the report rows cannot come to disagree about whether
/// "Ålesund" sorts before or after "Zoo".
enum DisplayOrder {
    static let locale = Locale(identifier: "en_GB")

    static func compareNames(_ lhs: String, _ rhs: String) -> ComparisonResult {
        lhs.compare(rhs, options: [], range: nil, locale: locale)
    }

    static func nameLess(_ lhs: String, _ rhs: String) -> Bool {
        compareNames(lhs, rhs) == .orderedAscending
    }
}

extension Budgets {
    /// Progress for every budget that is not archived, in name order.
    ///
    /// `refDate` picks the window: each budget's own period grid is asked which
    /// window contains that date, so a weekly and a monthly budget on the same
    /// screen are each showing their own current period rather than a shared
    /// one.
    public static func allProgress(
        _ budgets: [Budget],
        categories: [Category],
        transactions: [Transaction],
        baseCurrency: String,
        rates: RateTable,
        refDate: String
    ) throws -> [BudgetLine] {
        try budgets
            .filter { !$0.archived }
            .sorted { DisplayOrder.nameLess($0.name, $1.name) }
            .map { budget in
                BudgetLine(
                    budget: budget,
                    progress: try progress(
                        budget.spec, categories: categories, transactions: transactions,
                        baseCurrency: baseCurrency, rates: rates, refDate: refDate
                    )
                )
            }
    }

    /// The archived ones, in the same order. Listed, never silently dropped: a
    /// budget the owner archived is still a budget the owner made, and a
    /// screen that stopped mentioning it would look like it had been deleted.
    public static func archived(_ budgets: [Budget]) -> [Budget] {
        budgets.filter(\.archived).sorted { DisplayOrder.nameLess($0.name, $1.name) }
    }
}

extension Book {
    /// Progress for every live budget in this book.
    public func allBudgetProgress(refDate: String) throws -> [BudgetLine] {
        try Budgets.allProgress(
            budgets, categories: categories, transactions: transactions,
            baseCurrency: baseCurrency, rates: rateTable, refDate: refDate
        )
    }

    /// Progress for ONE budget in a window the caller has navigated to.
    ///
    /// The window is identified by its start date rather than passed as a
    /// window, because `Budgets.progress` re-derives the window from the grid:
    /// a caller cannot hand it a window that is not on the grid and get a
    /// figure for days that belong to two periods at once.
    public func budgetProgress(_ budget: Budget, inWindowStarting start: String) throws
        -> BudgetProgress
    {
        try budgetProgress(budget.spec, refDate: start)
    }
}
