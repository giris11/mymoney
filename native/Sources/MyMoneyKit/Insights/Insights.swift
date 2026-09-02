// The insights screen, composed.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE ABOVE ALL OTHERS: NOTHING HERE STATES A CONCLUSION THE DATA DOES NOT
// SUPPORT, and everything it does state can be opened up and checked. Every row
// this file produces carries the transactions behind it (`RecurringSeries.
// occurrences`, `DuplicateSuspicion.transactions`), the counts that produced its
// confidence (`SeriesEvidence`), and the dates those cover. A screen that said
// "you spend £2,400 a year on subscriptions" and could not show its working
// would be asking to be trusted about somebody's money on no evidence at all.
//
// WHAT THIS FILE ADDS TO THE FOUR DETECTORS: the one thing none of them can do
// on their own, which is ADD UP ACROSS CURRENCIES. Each series lives in one
// currency and its annual figure is computed there, in integers. Only the TOTAL
// crosses currencies, and it does so under SPEC §6's rules:
//
//   * each series' annual cost is converted ONCE and rounded once (D12's "per
//     contribution", the same choice `Reports` makes);
//   * a series whose currency has no rate to base is NOT dropped and NOT
//     converted at a guess -- it is counted, its currency is named, and the
//     total says it is short.
//
// AND WHAT GOES IN THE TOTAL IS ONLY WHAT IS STILL RUNNING. A subscription that
// stopped two years ago is still worth showing -- it is how you notice one you
// forgot you had -- but adding it to "what your recurring payments cost you in
// a year" would make that figure a description of your past.
import Foundation

/// What the recurring payments come to in a year, and what is missing from it.
public struct AnnualRecurringCost: Sendable, Hashable {
    public let baseCurrency: String
    /// Σ of the still-running series, each converted once. nil when the sum
    /// itself could not be stated.
    public let totalMinor: Int64?
    public let seriesCounted: Int
    /// Series left out because their currency has no rate to base.
    public let seriesWithoutRate: Int
    public let missingRateCurrencies: [String]
    /// Series left out because they look stopped. Not a gap in the figure --
    /// a deliberate exclusion the screen states.
    public let seriesLapsed: Int
    /// True when at least one counted series has an amount that varies, so the
    /// total is an estimate rather than a multiplication of known prices.
    public let containsEstimates: Bool
}

/// Everything the insights screen shows, decided.
public struct InsightsReport: Sendable {
    public let today: String
    public let baseCurrency: String

    /// Patterns, most expensive per year first (converted for ranking only).
    public let recurring: [RecurringSeries]
    /// Two payments that rhyme. Never mixed with the above.
    public let pairs: [RecurringSeries]
    /// Every price step found in the patterns, most recent first.
    public let priceChanges: [SeriesPriceChange]
    public let duplicates: DuplicateFindings
    public let dormant: DormantFindings
    public let annual: AnnualRecurringCost
    /// Each series' yearly cost in BASE currency, by series id -- converted
    /// once, the same way and at the same moment as the total above it.
    ///
    /// It exists so that a screen showing a euro subscription beside a sterling
    /// total can say how the one reaches the other, instead of leaving the
    /// reader to wonder whether "€144.00 a year" is in the "£3,677.76 a year"
    /// above it. A series whose currency has no rate is simply absent from this
    /// map -- there is no figure to give, and a zero would be a lie.
    public let annualCostInBase: [String: Int64]
    public let coverage: RecurrenceCoverage

    /// The still-running ones, which is what most of the screen is about.
    public var live: [RecurringSeries] { recurring.filter { $0.status.isLive } }
    /// The ones that look stopped.
    public var lapsed: [RecurringSeries] { recurring.filter { !$0.status.isLive } }

    public var isEmpty: Bool {
        recurring.isEmpty && pairs.isEmpty && duplicates.unusual.isEmpty
            && duplicates.routine.isEmpty && dormant.accounts.isEmpty && dormant.archived.isEmpty
    }
}

/// A price step with enough of its series attached to stand on its own in a
/// list. The change itself is `PriceSteps`'; this is that plus who it was to.
public struct SeriesPriceChange: Sendable, Hashable, Identifiable {
    public var id: String { change.id }
    public let change: PriceChange
    public let seriesId: String
    public let payeeName: String
    public let cadence: Cadence
    public let confidence: SeriesConfidence
    public let status: SeriesStatus
    /// changeMinor × payments a year, in the series' own currency. THE reason
    /// 26 and 13 have to be right: this is the number that says whether a rise
    /// matters.
    public let annualisedChangeMinor: Int64
}

public enum Insights {

    /// Everything, from one book, as of one day.
    public static func report(
        book: Book,
        today: String,
        recurrenceRules: RecurrenceRules = .standard,
        duplicateRules: DuplicateRules = .standard,
        dormantRules: DormantRules = .standard
    ) throws -> InsightsReport {
        let found = try Recurrence.detect(book: book, today: today, rules: recurrenceRules)
        let duplicates = DuplicateCharges.find(book: book, rules: duplicateRules)
        let dormant = try DormantMoney.find(book: book, today: today, rules: dormantRules)

        let rates = book.rateTable
        let base = book.baseCurrency

        // Ranked by what they cost in a year, in ONE currency so the ranking
        // means something. A series that cannot be converted is not dropped
        // from the list -- it goes to the end, where it is still visible, still
        // in its own currency, and still says why it could not be ranked.
        let ranked = found.series.sorted { lhs, rhs in
            let left = annualInBase(lhs, base: base, rates: rates)
            let right = annualInBase(rhs, base: base, rates: rates)
            switch (left, right) {
            case let (l?, r?):
                if l != r { return l > r }
            case (nil, _?): return false
            case (_?, nil): return true
            case (nil, nil): break
            }
            if lhs.confidence != rhs.confidence { return lhs.confidence > rhs.confidence }
            return DisplayOrder.nameLess(lhs.payeeName, rhs.payeeName)
        }

        var changes: [SeriesPriceChange] = []
        for series in ranked {
            for change in series.changes {
                let (annualised, overflowed) = change.changeMinor.multipliedReportingOverflow(
                    by: Int64(series.cadence.occurrencesPerYear)
                )
                if overflowed { throw MoneyError.overflow("a year of a price change") }
                changes.append(
                    SeriesPriceChange(
                        change: change,
                        seriesId: series.id,
                        payeeName: series.payeeName,
                        cadence: series.cadence,
                        confidence: series.confidence,
                        status: series.status,
                        annualisedChangeMinor: annualised
                    )
                )
            }
        }
        // Most recent first: a rise from three years ago is history, and one
        // from last month is a decision. Ties broken by size, then by id.
        changes.sort { lhs, rhs in
            if lhs.change.onDate != rhs.change.onDate { return lhs.change.onDate > rhs.change.onDate }
            if abs(lhs.annualisedChangeMinor) != abs(rhs.annualisedChangeMinor) {
                return abs(lhs.annualisedChangeMinor) > abs(rhs.annualisedChangeMinor)
            }
            return lhs.id < rhs.id
        }

        var inBase: [String: Int64] = [:]
        for series in ranked {
            if let value = annualInBase(series, base: base, rates: rates) {
                inBase[series.id] = value
            }
        }

        return InsightsReport(
            today: today,
            baseCurrency: base,
            recurring: ranked,
            pairs: found.pairs,
            priceChanges: changes,
            duplicates: duplicates,
            dormant: dormant,
            annual: annualCost(ranked, base: base, rates: rates),
            annualCostInBase: inBase,
            coverage: found.coverage
        )
    }

    /// One series' yearly cost in base currency, converted and rounded exactly
    /// once. nil when no rate joins the two currencies.
    public static func annualInBase(
        _ series: RecurringSeries, base: String, rates: RateTable
    ) -> Int64? {
        Money.convert(
            minor: series.annualCostMinor, from: series.currency, to: base, using: rates
        ).minor
    }

    static func annualCost(
        _ series: [RecurringSeries], base: String, rates: RateTable
    ) -> AnnualRecurringCost {
        var total: Int64? = 0
        var counted = 0
        var withoutRate = 0
        var lapsed = 0
        var estimates = false
        var missing = Set<String>()

        for one in series {
            // Only what is still running. See the file header.
            guard one.status.isLive else {
                lapsed += 1
                continue
            }
            guard let value = annualInBase(one, base: base, rates: rates) else {
                withoutRate += 1
                missing.insert(one.currency)
                continue
            }
            counted += 1
            if one.annualCostIsEstimate { estimates = true }
            guard let running = total else { continue }
            let (next, overflowed) = running.addingReportingOverflow(value)
            total = overflowed ? nil : next
        }

        return AnnualRecurringCost(
            baseCurrency: base,
            totalMinor: total,
            seriesCounted: counted,
            seriesWithoutRate: withoutRate,
            missingRateCurrencies: missing.sorted(by: jsStringLess),
            seriesLapsed: lapsed,
            containsEstimates: estimates
        )
    }
}
