// Budget period windows and spend against them, ported from
// src/domain/budgets.ts (SPEC §8.1.6, no rollover in Phase 1).
//
// THE WINDOW GRID IS THE WHOLE PROBLEM. A budget anchors at its `startDate`
// and its windows tile the timeline forwards AND backwards from there, with no
// gaps and no overlaps -- every date is in exactly one window, including dates
// before the anchor (negative window indices). Window n is
//
//     [ anchor + n periods , anchor + (n+1) periods − 1 day ]
//
// with BOTH ends computed from the same anchor. That detail is load-bearing:
// a monthly budget anchored on the 31st has its end clamped every February
// (31 Jan + 1 month = 28 Feb, so window 0 ends on the 27th... no: on the day
// before, 28 Feb), and because the next window's START is also computed from
// the anchor rather than from the clamped end, the clamping never accumulates.
// Deriving each window from the previous one instead -- the obvious
// implementation -- drifts a day earlier every short month until the budget no
// longer means "the 31st", and the oracle's `budgets.window.monthly.31st-*`
// cases exist to catch exactly that.
//
// SPEND IS POSITIVE, and net of refunds. Expenses are stored negative, so
// spend = −Σ; a refund is a positive amount in an expense category and it
// SUBTRACTS. A month whose refunds exceed its spending has a negative
// `spentMinor`, and that is reported as-is rather than floored at zero,
// because the money really did come back.
//
// A MISSING RATE IS COUNTED, NEVER GUESSED, and counted ONCE PER TRANSACTION
// however many of that transaction's splits the budget covers (D28). The UI
// says "N transactions excluded"; counting per split would over-report a split
// purchase and make the number mean something other than what it says.
import Foundation

public enum DomainError: Error, Equatable, Sendable, CustomStringConvertible {
    /// A date string that is not a real 'YYYY-MM-DD' calendar date. A refusal:
    /// the alternative is picking a nearby day, which moves someone's money
    /// into a period they did not spend it in.
    case invalidDate(String)

    public var description: String {
        switch self {
        case .invalidDate(let s): return "\"\(s)\" is not a YYYY-MM-DD calendar date"
        }
    }
}

/// A budget period window, INCLUSIVE of both ends.
public struct PeriodWindow: Sendable, Hashable {
    public let start: String  // 'YYYY-MM-DD'
    public let end: String    // 'YYYY-MM-DD'

    public init(start: String, end: String) {
        self.start = start
        self.end = end
    }

    /// True when `date` ('YYYY-MM-DD') falls inside. String comparison is date
    /// comparison for this format, which is why the format was chosen.
    public func contains(_ date: String) -> Bool { date >= start && date <= end }
}

/// The part of a budget the window grid and the spend calculation actually
/// use. Separate from `Budget` because the oracle's cases state exactly these
/// fields and nothing else -- a function that demanded an id and a name would
/// force the harness to invent two.
public struct BudgetSpec: Sendable, Hashable {
    public let categoryIds: [String]
    /// In BASE currency (D22).
    public let amountMinor: Int64
    public let period: BudgetPeriod
    public let startDate: String

    public init(categoryIds: [String], amountMinor: Int64, period: BudgetPeriod, startDate: String) {
        self.categoryIds = categoryIds
        self.amountMinor = amountMinor
        self.period = period
        self.startDate = startDate
    }
}

extension Budget {
    public var spec: BudgetSpec {
        BudgetSpec(
            categoryIds: categoryIds, amountMinor: amountMinor,
            period: period, startDate: startDate
        )
    }
}

public struct BudgetProgress: Sendable, Hashable {
    public let window: PeriodWindow
    /// Net spend as a POSITIVE number; negative when refunds exceeded spend.
    public let spentMinor: Int64
    public let limitMinor: Int64
    /// limit − spent; negative when over.
    public let remainingMinor: Int64
    /// spent / limit. Floored at 0, NOT capped at 1, and 0 when the limit is 0.
    /// The one Double in the money layer, and it is a ratio for a progress bar,
    /// never an amount.
    public let pct: Double
    /// spent > limit. Spending EXACTLY the limit is not over.
    public let over: Bool
    /// Transactions left out because their currency has no rate to base.
    public let missingRateCount: Int
}

public enum Budgets {
    // MARK: - The window grid

    /// Window `n` of the grid; `n` may be negative.
    static func window(_ period: BudgetPeriod, anchor: CalendarDate, index n: Int) -> PeriodWindow {
        switch period {
        case .weekly:
            let start = anchor.addingDays(n * 7)
            return PeriodWindow(start: start.iso, end: start.addingDays(6).iso)
        case .monthly:
            return PeriodWindow(
                start: anchor.addingMonths(n).iso,
                end: anchor.addingMonths(n + 1).addingDays(-1).iso
            )
        case .yearly:
            return PeriodWindow(
                start: anchor.addingYears(n).iso,
                end: anchor.addingYears(n + 1).addingDays(-1).iso
            )
        }
    }

    /// Index of the window containing `date`.
    ///
    /// For weeks it is exact arithmetic. For months and years the year/month
    /// difference is a GUESS that can be off by one around a clamped
    /// short-month end, so the guess is corrected by walking -- at most a step
    /// or two, because the windows tile contiguously. The walk is the
    /// TypeScript's, kept rather than replaced with something cleverer: a
    /// closed form for "which clamped anniversary window contains this date"
    /// is easy to get subtly wrong and impossible to read.
    static func windowIndex(
        _ period: BudgetPeriod, anchor: CalendarDate, date: CalendarDate
    ) -> Int {
        if period == .weekly {
            // Floored, not truncated: a date one day BEFORE the anchor is in
            // window −1, and Swift's `/` would put it in window 0.
            let diff = date.daysSince(anchor)
            return diff >= 0 ? diff / 7 : -(((-diff) + 6) / 7)
        }
        var n = period == .monthly
            ? (date.year - anchor.year) * 12 + (date.month - anchor.month)
            : date.year - anchor.year
        while date.iso < window(period, anchor: anchor, index: n).start { n -= 1 }
        while date.iso > window(period, anchor: anchor, index: n).end { n += 1 }
        return n
    }

    /// The window of this budget's period containing `date`.
    public static func windowContaining(
        period: BudgetPeriod, startDate: String, date: String
    ) throws -> PeriodWindow {
        guard let anchor = CalendarDate(iso: startDate) else { throw DomainError.invalidDate(startDate) }
        guard let d = CalendarDate(iso: date) else { throw DomainError.invalidDate(date) }
        return window(period, anchor: anchor, index: windowIndex(period, anchor: anchor, date: d))
    }

    /// Shift a window by `n` periods (`n` may be negative).
    ///
    /// The window's INDEX on the grid is recovered from its start date and the
    /// shift is applied to the index -- not to the dates. Adding n months to
    /// both ends of a clamped window drifts (28 Feb + 1 month = 28 Mar, but
    /// the real next window starts on the 31st), and the drift compounds.
    public static func shiftWindow(
        period: BudgetPeriod, startDate: String, window w: PeriodWindow, by n: Int
    ) throws -> PeriodWindow {
        guard let anchor = CalendarDate(iso: startDate) else { throw DomainError.invalidDate(startDate) }
        guard let start = CalendarDate(iso: w.start) else { throw DomainError.invalidDate(w.start) }
        return window(period, anchor: anchor, index: windowIndex(period, anchor: anchor, date: start) + n)
    }

    // MARK: - Spend against a window

    /// The signed contributions of one transaction to a budget covering `cats`:
    ///  * a transfer leg contributes nothing (D13) -- moving money between your
    ///    own accounts is not spending, and counting it would double every
    ///    savings transfer;
    ///  * a SPLIT transaction contributes only the splits whose category is
    ///    covered, and the parent's own categoryId is ignored entirely;
    ///  * otherwise the whole amount, when the transaction's category is
    ///    covered.
    ///
    /// Public because the budget DETAIL screen lists the transactions behind
    /// the figure, and that list has to be decided by the same predicate the
    /// total is -- otherwise the rows on screen would not add up to the number
    /// above them, which is the most alarming thing a budget screen can do.
    public static func contributions(of tx: Transaction, covering cats: Set<String>) -> [Int64] {
        if tx.transferGroupId != nil { return [] }
        if !tx.splits.isEmpty {
            return tx.splits.compactMap { split in
                guard let id = split.categoryId, cats.contains(id) else { return nil }
                return split.amountMinor
            }
        }
        guard let id = tx.categoryId, cats.contains(id) else { return [] }
        return [tx.amountMinor]
    }

    /// Progress for one budget as of `refDate`.
    ///
    /// Each contribution is converted and rounded INDIVIDUALLY, matching how
    /// reports attribute split lines to their own categories -- and matching
    /// `fx.convertEach`, which pins that converting three amounts and adding
    /// them is not the same as adding and converting once.
    public static func progress(
        _ budget: BudgetSpec,
        categories: [Category],
        transactions: [Transaction],
        baseCurrency: String,
        rates: RateTable,
        refDate: String
    ) throws -> BudgetProgress {
        let w = try windowContaining(
            period: budget.period, startDate: budget.startDate, date: refDate
        )
        let cats = Categories.descendantIds(categories, rootIds: budget.categoryIds)

        var sumMinor: Int64 = 0  // signed Σ of converted contributions (spend negative)
        var missingRateCount = 0
        for tx in transactions where w.contains(tx.date) {
            let parts = contributions(of: tx, covering: cats)
            if parts.isEmpty { continue }
            // Convertibility is a property of the TRANSACTION's currency, so an
            // unconvertible transaction is excluded -- and counted -- exactly
            // once however many of its splits this budget covers (D28).
            if rates.rate(from: tx.currency, to: baseCurrency) == nil {
                missingRateCount += 1
                continue
            }
            for amount in parts {
                switch Money.convert(minor: amount, from: tx.currency, to: baseCurrency, using: rates) {
                case .converted(let value):
                    let (next, overflowed) = sumMinor.addingReportingOverflow(value)
                    if overflowed { throw MoneyError.overflow("budget spend total") }
                    sumMinor = next
                case .missingRate:
                    // Unreachable: the rate was checked above. Left as a case
                    // rather than a `try!` so a future change cannot make it a
                    // silent zero.
                    missingRateCount += 1
                case .notRepresentable:
                    throw MoneyError.notRepresentable("a contribution to this budget")
                }
            }
        }

        // Expenses are negative, so spend is the negation. Checked, not `-x`:
        // the one input that traps is Int64.min, and a trap in a budget screen
        // is a crash where a refusal belongs.
        let (spent, negated) = (0 as Int64).subtractingReportingOverflow(sumMinor)
        if negated { throw MoneyError.overflow("budget spend total") }
        let limit = budget.amountMinor
        let (remaining, remainingOverflowed) = limit.subtractingReportingOverflow(spent)
        if remainingOverflowed { throw MoneyError.overflow("budget remaining") }
        return BudgetProgress(
            window: w,
            spentMinor: spent,
            limitMinor: limit,
            remainingMinor: remaining,
            pct: limit > 0 ? max(0, Double(spent) / Double(limit)) : 0,
            over: spent > limit,
            missingRateCount: missingRateCount
        )
    }
}

extension Book {
    /// Progress for a budget against this book.
    public func budgetProgress(_ budget: BudgetSpec, refDate: String) throws -> BudgetProgress {
        try Budgets.progress(
            budget,
            categories: categories,
            transactions: transactions,
            baseCurrency: baseCurrency,
            rates: rateTable,
            refDate: refDate
        )
    }
}
