// The handful of figures a widget is allowed to know, and how old they are.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A WIDGET CANNOT JUST READ THE LEDGER
//
// A widget is a separate process with a separate sandbox. It cannot open this
// app's SQLite file at all unless the two are put in a shared App Group
// container -- and even then it should not, for a reason that has nothing to do
// with permissions: a widget is given a few tens of megabytes and a couple of
// seconds, is woken by the system at moments nobody chose, and is killed
// without ceremony when it takes too long. Opening a database, running a
// migration check, decoding 5,127 transactions and computing a month's spend in
// that budget is how a widget becomes a blank rectangle on somebody's home
// screen.
//
// So the app does the work while it is running, where there is time and a
// screen to say what is happening, and leaves this behind: one small JSON file
// in the group container. The widget reads it, formats it, and stops. It has no
// database code, no store, no book, and no arithmetic -- every figure below was
// computed by something the oracle holds to account.
//
// ─────────────────────────────────────────────────────────────────────────────
// A SNAPSHOT IS ALWAYS OLD, AND MUST ALWAYS SAY SO
//
// The figures were true when the app last ran. Since then the owner may have
// spent money, and this file cannot know. That is not a defect to be hidden --
// it is the nature of the thing -- but a net-worth figure with no date on it is
// a LIE OF OMISSION on a home screen, because a home screen looks live.
//
// So `asOf` is not optional, every widget family draws it, and
// `SnapshotFreshness` decides the words. There is deliberately no way to build
// a `LedgerSnapshot` without a timestamp.
//
// AND THE LOCAL-EDIT COUNT TRAVELS WITH IT. The honesty machinery
// (`LedgerStore+LocalEdits.swift`) says the count must not leave the screen; a
// widget is a screen, and one that showed a net worth the web app does not
// agree with, without saying so, would be the worst place in the system to
// hide it.
import Foundation

/// The figures a widget draws. Small, flat, and Codable.
///
/// EVERY AMOUNT IS INTEGER MINOR UNITS, like everywhere else in this package,
/// and is formatted by `Money` in the widget. There is no pre-formatted string
/// in here on purpose: a snapshot that carried "£12,345.67" would be a second
/// formatter's output, frozen, and would keep showing the wrong grouping after
/// the owner changed a setting.
public struct LedgerSnapshot: Codable, Sendable, Hashable {

    /// THE SHAPE OF THIS FILE, versioned.
    ///
    /// The app and the widget are separate binaries that are usually -- but not
    /// always -- the same build. An older widget left running against a newer
    /// app's file must refuse it rather than decode what it recognises and draw
    /// the rest as zero, because "£0.00" is a figure and a refusal is not.
    public static let currentVersion = 1

    public let version: Int
    /// When these figures were computed. ISO-8601 instant, always present.
    public let asOf: String

    public let baseCurrency: String
    public let netWorthMinor: Int64
    /// Accounts deliberately left out of the total, and currencies left out for
    /// want of a rate -- carried so the widget can mark a total that is not the
    /// whole story, exactly as the app's own screens do.
    public let excludedAccountCount: Int
    public let missingRateCurrencies: [String]

    /// "2026-09". The month the spend figure is for.
    public let monthKey: String
    /// Money out this month, POSITIVE and net of refunds, in base currency --
    /// `MonthFlow.expenseMinor`, unchanged.
    public let monthSpentMinor: Int64
    public let monthIncomeMinor: Int64

    /// The biggest few budgets, largest limit first. Capped, because a widget
    /// has room for three lines and a file that carried forty would be forty
    /// times the size for no pixels.
    public let budgets: [BudgetSnapshot]
    /// How many live budgets there are in total, so "3 of 7" is possible.
    public let budgetCount: Int

    /// How far this copy has drifted from the backup it was imported from.
    public let localEditCount: Int
    /// When the backup this copy was made from was exported, if known.
    public let sourceExportedAt: String?
    public let transactionCount: Int
    public let accountCount: Int

    public init(
        asOf: String,
        baseCurrency: String,
        netWorthMinor: Int64,
        excludedAccountCount: Int,
        missingRateCurrencies: [String],
        monthKey: String,
        monthSpentMinor: Int64,
        monthIncomeMinor: Int64,
        budgets: [BudgetSnapshot],
        budgetCount: Int,
        localEditCount: Int,
        sourceExportedAt: String?,
        transactionCount: Int,
        accountCount: Int
    ) {
        self.version = Self.currentVersion
        self.asOf = asOf
        self.baseCurrency = baseCurrency
        self.netWorthMinor = netWorthMinor
        self.excludedAccountCount = excludedAccountCount
        self.missingRateCurrencies = missingRateCurrencies
        self.monthKey = monthKey
        self.monthSpentMinor = monthSpentMinor
        self.monthIncomeMinor = monthIncomeMinor
        self.budgets = budgets
        self.budgetCount = budgetCount
        self.localEditCount = localEditCount
        self.sourceExportedAt = sourceExportedAt
        self.transactionCount = transactionCount
        self.accountCount = accountCount
    }

    /// How many budgets a snapshot carries at most.
    public static let budgetLimit = 3

    /// Is this a file this build understands?
    public var isReadable: Bool { version == Self.currentVersion }

    /// Everything except `asOf`.
    ///
    /// Used to decide whether the widget needs waking: rewriting the file every
    /// time the app opens is right (the figures ARE newer), but asking WidgetKit
    /// to redraw when not a single number moved spends the widget's refresh
    /// budget on nothing.
    public func sameFigures(as other: LedgerSnapshot) -> Bool {
        var a = self
        var b = other
        a = a.withAsOf("")
        b = b.withAsOf("")
        return a == b
    }

    func withAsOf(_ stamp: String) -> LedgerSnapshot {
        LedgerSnapshot(
            asOf: stamp,
            baseCurrency: baseCurrency,
            netWorthMinor: netWorthMinor,
            excludedAccountCount: excludedAccountCount,
            missingRateCurrencies: missingRateCurrencies,
            monthKey: monthKey,
            monthSpentMinor: monthSpentMinor,
            monthIncomeMinor: monthIncomeMinor,
            budgets: budgets,
            budgetCount: budgetCount,
            localEditCount: localEditCount,
            sourceExportedAt: sourceExportedAt,
            transactionCount: transactionCount,
            accountCount: accountCount
        )
    }
}

/// One budget, as a widget shows it.
public struct BudgetSnapshot: Codable, Sendable, Hashable, Identifiable {
    public let id: String
    public let name: String
    /// In BASE currency, like every budget in this package (D22).
    public let limitMinor: Int64
    public let spentMinor: Int64
    public let remainingMinor: Int64
    public let over: Bool
    /// 0...1 and beyond -- `BudgetProgress.pct`, carried unchanged so the bar
    /// the widget draws is the bar the app draws.
    public let pct: Double
    /// The last day of the window these figures are for, "YYYY-MM-DD". On the
    /// widget because a budget's period is not always a month, and "£40 left"
    /// means something different with four days to go than with twenty.
    public let windowEnd: String

    public init(
        id: String, name: String, limitMinor: Int64, spentMinor: Int64, remainingMinor: Int64,
        over: Bool, pct: Double, windowEnd: String
    ) {
        self.id = id
        self.name = name
        self.limitMinor = limitMinor
        self.spentMinor = spentMinor
        self.remainingMinor = remainingMinor
        self.over = over
        self.pct = pct
        self.windowEnd = windowEnd
    }
}

extension LedgerSnapshot {
    /// Build one from the figures the app has already computed.
    ///
    /// NOTHING IS RECOMPUTED HERE. Every number is lifted out of
    /// `DashboardSummary`, which came out of `Dashboard.summary` -- the same
    /// call the dashboard screen draws from. A widget that disagreed with the
    /// screen behind it would be worse than no widget.
    ///
    /// WHICH BUDGETS. The largest limits first, ties broken by name so the
    /// order is the same on every publish. NOT "closest to breaching", which
    /// would reorder the widget under the owner's thumb every time a
    /// transaction landed -- the same reasoning that keeps the budgets LIST in
    /// name order (`BudgetList.swift`).
    ///
    /// `budgets` IS THE WHOLE LIST, and it is a separate argument for a reason
    /// found by a test rather than by reading: `DashboardSummary.budgets` is
    /// already cut to `Dashboard.budgetRows`, in NAME order, because that is
    /// what the dashboard card shows. Ranking that by size gives the three
    /// biggest of the first four alphabetically -- which on a book with six
    /// budgets silently omitted the largest one and looked entirely plausible.
    public static func of(
        _ dashboard: DashboardSummary,
        budgets: [BudgetLine],
        localEditCount: Int,
        sourceExportedAt: String?,
        transactionCount: Int,
        accountCount: Int,
        asOf: String
    ) -> LedgerSnapshot {
        let ranked = budgets
            .sorted {
                if $0.progress.limitMinor != $1.progress.limitMinor {
                    return $0.progress.limitMinor > $1.progress.limitMinor
                }
                return DisplayOrder.nameLess($0.budget.name, $1.budget.name)
            }
            .prefix(budgetLimit)
            .map { line in
                BudgetSnapshot(
                    id: line.budget.id,
                    name: line.budget.name,
                    limitMinor: line.progress.limitMinor,
                    spentMinor: line.progress.spentMinor,
                    remainingMinor: line.progress.remainingMinor,
                    over: line.progress.over,
                    pct: line.progress.pct,
                    windowEnd: line.progress.window.end
                )
            }

        return LedgerSnapshot(
            asOf: asOf,
            baseCurrency: dashboard.baseCurrency,
            netWorthMinor: dashboard.netWorth.totalBaseMinor,
            excludedAccountCount: dashboard.netWorth.excludedCount,
            missingRateCurrencies: dashboard.netWorth.missingRateCurrencies,
            monthKey: dashboard.thisMonth.month,
            monthSpentMinor: dashboard.thisMonth.expenseMinor,
            monthIncomeMinor: dashboard.thisMonth.incomeMinor,
            budgets: Array(ranked),
            budgetCount: dashboard.budgetCount,
            localEditCount: localEditCount,
            sourceExportedAt: sourceExportedAt,
            transactionCount: transactionCount,
            accountCount: accountCount
        )
    }
}
