// What each new screen is handed, already decided.
//
// EVERY TYPE HERE IS A `Sendable` VALUE AND NONE OF THEM HOLDS A DATABASE.
// They cross from `LedgerService`'s actor to the main one, which is the same
// rule `LedgerSummary` follows and for the same reason: a view that ended up
// holding the store could touch it from the main thread while an import was
// running on another.
//
// AND THERE IS NO ARITHMETIC IN ANY OF THEM. Every figure below was produced by
// something the oracle holds to account -- `Dashboard.summary`,
// `Budgets.progress`, the six `Reports` functions -- and is carried here
// unchanged. A computed property that added two amounts would be a second
// implementation of money, in the layer least able to test it.
import Foundation
import MyMoneyKit

/// The dashboard: the composed summary, plus the register's own first page.
struct DashboardScreen: Sendable {
    let summary: DashboardSummary
    /// The most recent transactions, in the register's words. Read through
    /// `registerPage` so a transfer here is named exactly as it is named in the
    /// register itself.
    let recent: [RegisterRow]
    let transactionCount: Int
}

/// The budgets list.
struct BudgetsScreen: Sendable {
    let lines: [BudgetLine]
    /// Archived budgets, listed under their own heading rather than dropped.
    let archived: [Budget]
    let baseCurrency: String
    /// The category tree, flattened and path-named, for the editor's picker.
    /// Carried with the screen so the picker cannot offer a category the list
    /// was not built from -- and built by the same `categoryChoices()` every
    /// other picker in this app uses, so the indentation and the archived
    /// marks are the same everywhere.
    let categories: [CategoryChoice]

    var isEmpty: Bool { lines.isEmpty && archived.isEmpty }
}

/// One transaction behind a budget's figure.
///
/// `countedMinor` is what THIS BUDGET counted, which is not the transaction's
/// amount when the transaction is split: a £50 shop with £8 of it filed under
/// Coffee contributes £8, and a list that showed £50 would not add up to the
/// total above it.
struct BudgetContribution: Sendable, Identifiable {
    let id: String
    let date: String
    let title: String
    let titleIsPlaceholder: Bool
    let categoryText: String
    /// The transaction's own amount, in its own currency.
    let amountMinor: Int64
    /// What this transaction contributed, in its own currency, BEFORE
    /// conversion to base. Shown in the transaction's currency for exactly
    /// that reason: it is the figure the owner would recognise.
    let countedMinor: Int64
    let currency: String
    let isPartOfASplit: Bool
}

/// One budget, in one window of its own period grid.
struct BudgetDetailScreen: Sendable {
    let budget: Budget
    /// Periods away from the one containing today. 0 is the current one.
    let offset: Int
    let isCurrentPeriod: Bool
    let progress: BudgetProgress
    /// "Food › Groceries" for each category the budget names, resolved through
    /// the tree so a subcategory reads as one.
    let categoryNames: [String]
    let rows: [BudgetContribution]
    let baseCurrency: String
}

/// The six reports, with the web app's own keys and labels so the two apps
/// name the same thing the same way.
enum ReportKind: String, Sendable, Hashable, CaseIterable, Identifiable {
    case netWorth = "net-worth"
    case byCategory = "by-category"
    case incomeExpense = "income-expense"
    case cashFlow = "cash-flow"
    case byPayee = "by-payee"
    case byTag = "by-tag"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .netWorth: return "Net worth"
        case .byCategory: return "By category"
        case .incomeExpense: return "Income vs expense"
        case .cashFlow: return "Cash flow"
        case .byPayee: return "By payee"
        case .byTag: return "By tag"
        }
    }

    var symbol: String {
        switch self {
        case .netWorth: return "chart.line.uptrend.xyaxis"
        case .byCategory: return "square.grid.2x2"
        case .incomeExpense: return "arrow.up.arrow.down"
        case .cashFlow: return "water.waves"
        case .byPayee: return "storefront"
        case .byTag: return "tag"
        }
    }

    /// Only one report drills, and the drill level belongs to it alone --
    /// switching reports must not carry a category id across to a screen that
    /// has no meaning for it.
    var drillable: Bool { self == .byCategory }
}

/// One report's rows. An enum rather than six optionals: exactly one report is
/// on screen, and the compiler should know it.
enum ReportData: Sendable {
    case netWorth(series: NetWorthSeries, headline: NetWorth)
    case category(report: CategorySpendReport, trail: [CategoryCrumb])
    case incomeExpense(MonthlyReport<MonthlyIncomeExpense>)
    case cashFlow(MonthlyReport<MonthlyCashFlow>)
    case payee(PayeeSpendReport)
    case tag(TagSpendReport)
}

struct ReportScreen: Sendable {
    let kind: ReportKind
    let range: DateRange
    let data: ReportData
    let baseCurrency: String

    /// How many transactions this report left out for want of an exchange
    /// rate, and which currencies the net-worth series left out. SPEC §6:
    /// surfaced, never guessed -- so every report carries the note and no
    /// screen has to remember to ask.
    var missingRateCount: Int {
        switch data {
        case .netWorth: return 0
        case .category(let report, _): return report.missingRateCount
        case .incomeExpense(let report): return report.missingRateCount
        case .cashFlow(let report): return report.missingRateCount
        case .payee(let report): return report.missingRateCount
        case .tag(let report): return report.missingRateCount
        }
    }

    var missingRateCurrencies: [String] {
        if case .netWorth(let series, _) = data { return series.missingRateCurrencies }
        return []
    }
}

/// The insights screen.
///
/// ONE VALUE, ALREADY DECIDED, exactly like every other payload here: the whole
/// report comes out of `Insights.report`, which is where the rules are and
/// where the tests are. The view below it does not decide what is recurring,
/// what a rise is, or what is a duplicate -- it decides what to SAY about each
/// of those, which is the only thing a view is any good at.
struct InsightsScreen: Sendable {
    let report: InsightsReport
    /// How many transactions the book holds, so the coverage note can say
    /// "3,476 of 5,127 payments were looked at" rather than a bare figure.
    let transactionCount: Int
}
