// The whole screen, composed -- and the one thing none of the four detectors
// can do on their own, which is add up across currencies.
//
// EVERY EXPECTATION IS HAND-CALCULATED with the sum in the comment beside it.
// Every name, rate and figure is invented.
import Testing

@testable import MyMoneyKit

struct InsightsTests {
    static let today = "2026-09-02"

    private func report(_ builder: BookBuilder) throws -> InsightsReport {
        try Insights.report(book: builder.book(), today: Self.today)
    }

    // MARK: - Adding up across currencies

    @Test("a year of recurring payments, converted once each, hand-calculated")
    func annualTotal() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP")
        book.account("a2", currency: "EUR")
        book.rate("EUR", "GBP", 0.85)
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        book.pay(
            "Euro Hosting", 1_000, on: Dates.monthly(from: "2025-09-12", count: 12), account: "a2",
            currency: "EUR"
        )

        let insights = try report(book)
        #expect(insights.recurring.count == 2)
        // 999 × 12 = 11,988 pence. 1000 × 12 = 12,000 cents, converted ONCE at
        // 0.85 = 10,200 pence. Total 22,188 pence = £221.88.
        #expect(insights.annual.totalMinor == 22_188)
        #expect(insights.annual.seriesCounted == 2)
        #expect(insights.annual.missingRateCurrencies.isEmpty)
        #expect(insights.annual.containsEstimates == false)
    }

    @Test("every series carries its yearly cost in base currency, or nothing at all")
    func perSeriesConversion() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP")
        book.account("a2", currency: "EUR")
        book.account("a3", currency: "JPY")
        book.rate("EUR", "GBP", 0.85)
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        book.pay(
            "Euro Hosting", 1_000, on: Dates.monthly(from: "2025-09-12", count: 12), account: "a2",
            currency: "EUR"
        )
        book.pay(
            "Tokyo Hosting", 800, on: Dates.monthly(from: "2025-09-19", count: 12), account: "a3",
            currency: "JPY"
        )

        let insights = try report(book)
        let euro = try #require(insights.series(payee: "Euro Hosting"))
        let sterling = try #require(insights.series(payee: "Streamly"))
        let yen = try #require(insights.series(payee: "Tokyo Hosting"))

        // 1000 × 12 = 12,000 cents, converted once at 0.85 = 10,200 pence.
        #expect(insights.annualCostInBase[euro.id] == 10_200)
        // A sterling series in a sterling book converts to itself, exactly.
        #expect(insights.annualCostInBase[sterling.id] == 11_988)
        // And one with no rate is ABSENT rather than zero: there is no figure
        // to give, and a zero on that row would be a lie.
        #expect(insights.annualCostInBase[yen.id] == nil)
    }

    @Test("A SERIES WITH NO RATE IS NAMED, NOT DROPPED")
    func missingRate() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP")
        book.account("a3", currency: "JPY")
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        book.pay(
            "Tokyo Hosting", 800, on: Dates.monthly(from: "2025-09-12", count: 12), account: "a3",
            currency: "JPY"
        )

        let insights = try report(book)
        // Both are found and both are on the screen...
        #expect(insights.recurring.count == 2)
        // ...the total covers the one it can...
        #expect(insights.annual.totalMinor == 11_988)
        #expect(insights.annual.seriesCounted == 1)
        // ...and says exactly what is missing from it.
        #expect(insights.annual.seriesWithoutRate == 1)
        #expect(insights.annual.missingRateCurrencies == ["JPY"])
        // The unconvertible one sorts last rather than vanishing: it cannot be
        // ranked against the others, and it is still the owner's money.
        #expect(insights.recurring.last?.currency == "JPY")
    }

    @Test("a series that looks cancelled is shown but is not in the yearly figure")
    func lapsedSeriesAreNotInTheTotal() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        book.pay("Old Gym", 3_400, on: Dates.monthly(from: "2024-09-05", count: 6))

        let insights = try report(book)
        #expect(insights.recurring.count == 2)
        #expect(insights.live.count == 1)
        #expect(insights.lapsed.count == 1)
        // Only the live one. Adding a gym you stopped paying for in 2025 to
        // "what your recurring payments cost you in a year" would make that
        // figure a description of the past.
        #expect(insights.annual.totalMinor == 11_988)
        #expect(insights.annual.seriesCounted == 1)
        #expect(insights.annual.seriesLapsed == 1)
    }

    @Test("an estimate says it is one")
    func estimates() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay(
            "Cardinal Energy",
            amounts: [3_800, 7_100, 4_400, 6_600, 3_900, 7_200, 4_100, 6_900],
            on: Dates.monthly(from: "2026-01-03", count: 8)
        )
        let insights = try report(book)
        #expect(insights.annual.containsEstimates)
        // 4,400 (the median payment, which is a payment that happened) × 12.
        #expect(insights.annual.totalMinor == 52_800)
    }

    // MARK: - Price changes

    @Test("THE ANNUALISED RISE DEPENDS ON THE CADENCE, hand-calculated")
    func annualisedChangesUseTheRightMultiplier() throws {
        var book = BookBuilder()
        book.account("a1")
        // The SAME £5 rise, on two different rhythms.
        let fortnightly = Dates.everyDays(14, from: "2025-09-05", count: 16)
        book.pay(
            "Fortnight Club", amounts: Array(repeating: 1_000, count: 10)
                + Array(repeating: 1_500, count: 6), on: fortnightly
        )
        let fourWeekly = Dates.everyDays(28, from: "2025-01-08", count: 16)
        book.pay(
            "Fourweek Club", amounts: Array(repeating: 1_000, count: 10)
                + Array(repeating: 1_500, count: 6), on: fourWeekly
        )

        let insights = try report(book)
        let fortnightlyChange = try #require(
            insights.priceChanges.first { $0.payeeName == "Fortnight Club" }
        )
        let fourWeeklyChange = try #require(
            insights.priceChanges.first { $0.payeeName == "Fourweek Club" }
        )

        #expect(fortnightlyChange.change.changeMinor == 500)
        #expect(fourWeeklyChange.change.changeMinor == 500)
        // 500 × 26 = 13,000 pence = £130 a year.
        #expect(fortnightlyChange.annualisedChangeMinor == 13_000)
        // 500 × 13 = 6,500 pence = £65 a year. THE SAME RISE, half the money,
        // and the only difference is the multiplier.
        #expect(fourWeeklyChange.annualisedChangeMinor == 6_500)
    }

    @Test("the most recent change is at the top")
    func changesAreNewestFirst() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay(
            "Older Rise", amounts: Array(repeating: 500, count: 6) + Array(repeating: 900, count: 6),
            on: Dates.monthly(from: "2024-01-10", count: 12)
        )
        book.pay(
            "Newer Rise", amounts: Array(repeating: 500, count: 6) + Array(repeating: 900, count: 6),
            on: Dates.monthly(from: "2025-09-10", count: 12)
        )
        let insights = try report(book)
        #expect(insights.priceChanges.map(\.payeeName) == ["Newer Rise", "Older Rise"])
    }

    @Test("a price change carries the series it belongs to, so it can be opened")
    func changesAreInspectable() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay(
            "Streamly", amounts: Array(repeating: 899, count: 8) + Array(repeating: 1_099, count: 6),
            on: Dates.monthly(from: "2025-07-05", count: 14)
        )
        let insights = try report(book)
        let change = try #require(insights.priceChanges.first)
        let series = try #require(insights.recurring.first { $0.id == change.seriesId })
        #expect(series.payeeName == "Streamly")
        #expect(series.levels.count == 2)
        // The date the change was SEEN -- the first payment at the new price --
        // is one of the transactions on the series, so a tap can reach it.
        #expect(series.occurrences.contains { $0.date == change.change.onDate })
    }

    // MARK: - Order

    @Test("the most expensive year is at the top, across currencies")
    func rankedByAnnualCost() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP")
        book.account("a2", currency: "EUR")
        book.rate("EUR", "GBP", 0.85)
        // £9.99 a month = £119.88 a year.
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        // €20 a month = €240 = £204 a year, so it outranks the pounds figure
        // even though the number beside it is smaller in its own currency.
        book.pay(
            "Euro Hosting", 2_000, on: Dates.monthly(from: "2025-09-12", count: 12), account: "a2",
            currency: "EUR"
        )
        // £4 a month = £48 a year.
        book.pay("Small Thing", 400, on: Dates.monthly(from: "2025-09-20", count: 12))

        let insights = try report(book)
        #expect(insights.recurring.map(\.payeeName) == ["Euro Hosting", "Streamly", "Small Thing"])
    }

    // MARK: - The whole screen

    @Test("everything at once, and every claim traceable to a transaction")
    func theWholeReport() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP", opening: 0)
        book.account("a2", currency: "GBP", opening: 42_000, name: "Forgotten Savings")

        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        book.pay("Landlord", 120_000, on: Dates.monthly(from: "2025-09-01", count: 12))
        book.receive("Employer Ltd", 250_000, on: Dates.monthly(from: "2025-09-28", count: 12))
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03", "2026-08-03"])
        book.pay("Dentist", 8_500, on: ["2026-06-15", "2026-07-15"])

        let insights = try report(book)
        #expect(insights.isEmpty == false)
        #expect(Set(insights.recurring.map(\.payeeName)) == ["Streamly", "Landlord"])
        #expect(insights.pairs.map(\.payeeName) == ["Dentist"])
        #expect(insights.duplicates.unusual.count == 1)
        #expect(insights.dormant.accounts.map(\.account.name) == ["Forgotten Savings"])

        // EVERY ROW ON THE SCREEN POINTS AT REAL TRANSACTIONS. This is the rule
        // the whole feature is built on: nothing is asserted that cannot be
        // opened up and checked.
        let ids = Set(book.book().transactions.map(\.id))
        for series in insights.recurring + insights.pairs {
            #expect(!series.occurrences.isEmpty)
            #expect(series.occurrences.allSatisfy { ids.contains($0.id) })
        }
        for match in insights.duplicates.unusual + insights.duplicates.routine {
            #expect(match.transactions.count >= 2)
            #expect(match.transactions.allSatisfy { ids.contains($0.id) })
        }

        // And the coverage figures add up to the book: 24 payments out (12
        // subscription + 12 rent) plus 2 duplicates plus 2 dentist = 28, and 12
        // payments in that were never candidates.
        #expect(insights.coverage.paymentsConsidered == 28)
        #expect(insights.coverage.moneyInSkipped == 12)
    }

    @Test("THE OBSERVED COUNT SAYS IT IS OBSERVED, so it cannot read as a rate")
    func observedPhraseIsNotARate() throws {
        // Two years of a monthly payment: 24 seen, 12 a year. The row printed
        // "24 payments \u{00B7} about £528.00 a year", where the first number sat
        // next to "a year" and looked like the rate behind the second. It is
        // not -- 24 × the typical payment is twice the annual figure -- and a
        // reader who checked the arithmetic that way would conclude the app was
        // wrong about their money.
        var book = BookBuilder()
        book.account("a1")
        book.pay("Redstart Broadband", 4_400, on: Dates.monthly(from: "2024-09-05", count: 24))

        let insights = try report(book)
        let series = try #require(insights.recurring.first)
        #expect(series.evidence.matched == 24)
        #expect(series.cadence.occurrencesPerYear == 12)
        #expect(series.annualCostMinor == 52_800)  // 4,400 × 12, not × 24

        // The two numbers now describe themselves.
        #expect(series.evidence.observedPhrase == "24 payments so far")
        #expect(series.cadence.perYearPhrase == "12 payments a year")
    }

    @Test("one payment is one payment, not one payments")
    func observedPhraseSingular() {
        let one = SeriesEvidence(
            matched: 1, missed: 0, extras: 0, missedDates: [], toleranceDays: 4,
            typicalSlipDays: 0, worstSlipDays: 0, earlierPayments: 0, otherPaymentsInRun: 0
        )
        #expect(one.observedPhrase == "1 payment so far")
        let none = SeriesEvidence(
            matched: 0, missed: 0, extras: 0, missedDates: [], toleranceDays: 4,
            typicalSlipDays: 0, worstSlipDays: 0, earlierPayments: 0, otherPaymentsInRun: 0
        )
        #expect(none.observedPhrase == "0 payments so far")
    }

    @Test("an empty book says nothing at all")
    func emptyBook() throws {
        var book = BookBuilder()
        book.account("a1")
        let insights = try report(book)
        #expect(insights.isEmpty)
        #expect(insights.annual.totalMinor == 0)
        #expect(insights.annual.seriesCounted == 0)
        #expect(insights.coverage.paymentsConsidered == 0)
    }
}
