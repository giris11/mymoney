// Finding the pattern, and describing it exactly.
//
// EVERY EXPECTATION IN THIS FILE IS HAND-CALCULATED from the dates written in
// the test itself. Where a count is not obvious -- how many payments survive a
// two-month gap, how many months a lapsed series has missed -- the arithmetic
// is written out in the comment beside it.
//
// The suites are in the order the detector runs: which cadence, how it survives
// real-world mess, what it says about confidence, whether it is still running,
// and what it does with a payee that was renamed. The false positives have
// their own file, because they are the half that decides whether this screen
// can be trusted.
import Testing

@testable import MyMoneyKit

struct RecurrenceTests {
    static let today = "2026-09-02"

    private func detect(_ builder: BookBuilder, today: String = RecurrenceTests.today) throws
        -> RecurrenceResult
    {
        try Recurrence.detect(book: builder.book(), today: today)
    }

    // MARK: - Which cadence

    @Test("a clean monthly subscription, hand-calculated")
    func cleanMonthly() throws {
        var book = BookBuilder()
        book.account("a1")
        // 12 payments, 5 Sep 2025 to 5 Aug 2026.
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))

        let found = try detect(book)
        #expect(found.series.count == 1)
        let series = try #require(found.series.first)

        #expect(series.cadence == .monthly)
        #expect(series.evidence.matched == 12)
        #expect(series.evidence.missed == 0)
        #expect(series.evidence.extras == 0)
        #expect(series.evidence.fit == 1.0)
        #expect(series.confidence == .high)
        #expect(series.stability == .exact)
        #expect(series.typicalAmountMinor == 999)
        #expect(series.firstDate == "2025-09-05")
        #expect(series.lastDate == "2026-08-05")
        #expect(series.nextExpectedDate == "2026-09-05")
        #expect(series.status == .active)
        // 999 × 12 = 11,988 pence = £119.88.
        #expect(series.annualCostMinor == 11_988)
    }

    @Test("every cadence is recognised as itself, hand-calculated")
    func eachCadence() throws {
        // Each one is given six payments, which is enough for the top
        // confidence and few enough to write down.
        let cases: [(Cadence, [String])] = [
            (.weekly, Dates.everyDays(7, from: "2026-03-06", count: 6)),
            (.fortnightly, Dates.everyDays(14, from: "2026-01-09", count: 6)),
            (.fourWeekly, Dates.everyDays(28, from: "2025-11-07", count: 6)),
            (.monthly, Dates.monthly(from: "2026-03-10", count: 6)),
            (.quarterly, Dates.quarterly(from: "2025-03-14", count: 6)),
            (.annual, Dates.yearly(from: "2020-04-18", count: 6)),
        ]
        for (expected, dates) in cases {
            var book = BookBuilder()
            book.account("a1")
            book.pay("Payee \(expected.rawValue)", 12_000, on: dates)
            let found = try detect(book)
            let series = try #require(found.series.first, "\(expected)")
            #expect(series.cadence == expected, "\(expected) read as \(series.cadence)")
            #expect(series.evidence.matched == 6, "\(expected)")
            // £120 a payment. The annual figure is the multiplier and nothing
            // else, so this is where a wrong multiplier would show.
            #expect(
                series.annualCostMinor == 12_000 * Int64(expected.occurrencesPerYear),
                "\(expected)"
            )
        }
    }

    @Test("FOUR-WEEKLY IS NOT MONTHLY, on the dates themselves")
    func fourWeeklyIsNotReadAsMonthly() throws {
        var book = BookBuilder()
        book.account("a1")
        // 13 payments 28 days apart from 6 Sep 2025 -- the shape of a bill that
        // arrives every four weeks and walks backwards through the calendar.
        book.pay("Fourweek Energy", 12_000, on: Dates.everyDays(28, from: "2025-09-06", count: 13))

        let series = try #require(try detect(book).series.first)
        #expect(series.cadence == .fourWeekly)
        #expect(series.evidence.matched == 13)
        // 13 × £120 = £1,560. Called monthly it would read £1,440, and called
        // fortnightly £3,120.
        #expect(series.annualCostMinor == 156_000)
    }

    @Test("a fortnightly wage-day standing order is 26 a year")
    func fortnightlyAnnualisation() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Fortnight Club", 2_500, on: Dates.everyDays(14, from: "2025-10-03", count: 20))

        let series = try #require(try detect(book).series.first)
        #expect(series.cadence == .fortnightly)
        // £25 × 26 = £650.
        #expect(series.annualCostMinor == 65_000)
    }

    // MARK: - Real-world mess

    @Test("a bill that slips over a weekend is still the same bill")
    func weekendSlip() throws {
        var book = BookBuilder()
        book.account("a1")
        var dates = Dates.monthly(from: "2025-09-01", count: 12)
        dates = Dates.shifting(dates, index: 3, by: 2)  // taken on the Monday
        dates = Dates.shifting(dates, index: 7, by: 3)
        book.pay("Waterworks", 4_200, on: dates)

        let series = try #require(try detect(book).series.first)
        #expect(series.cadence == .monthly)
        #expect(series.evidence.matched == 12)
        #expect(series.evidence.missed == 0)
        // Ten payments on the day, one two days late, one three: the median
        // slip is 0 and the worst is 3.
        #expect(series.evidence.typicalSlipDays == 0)
        #expect(series.evidence.worstSlipDays == 3)
        #expect(series.confidence == .high)
    }

    @Test("SLIP DOES NOT ACCUMULATE: every slot is measured from the anchor")
    func slipDoesNotAccumulate() throws {
        // Six months where the payment is late every single time, by two days,
        // three days, two days... Gap arithmetic would let that drift; measuring
        // each slot from the anchor keeps every one of them inside tolerance.
        var book = BookBuilder()
        book.account("a1")
        var dates = Dates.monthly(from: "2025-10-01", count: 8)
        for index in [1, 2, 3, 4, 5, 6] {
            dates = Dates.shifting(dates, index: index, by: index % 2 == 0 ? 3 : 2)
        }
        book.pay("Slippy Ltd", 1_500, on: dates)

        let series = try #require(try detect(book).series.first)
        #expect(series.cadence == .monthly)
        #expect(series.evidence.matched == 8)
        #expect(series.evidence.missed == 0)
    }

    @Test("one missed month is a missed month, not the end of the series")
    func oneMissedMonth() throws {
        var book = BookBuilder()
        book.account("a1")
        var dates = Dates.monthly(from: "2025-09-12", count: 12)
        let missing = dates.remove(at: 5)  // 12 Feb 2026
        book.pay("Gymnasium", 3_400, on: dates)

        let series = try #require(try detect(book).series.first)
        #expect(series.evidence.matched == 11)
        #expect(series.evidence.missed == 1)
        #expect(series.evidence.missedDates == [missing])
        // 11 / 12 = 0.9166..., which still clears the bar for the top word.
        #expect(abs(series.evidence.coverage - 11.0 / 12.0) < 1e-9)
        #expect(series.confidence == .high)
    }

    @Test("two missed months end the run, and the older payments are still counted")
    func twoMissedMonthsEndTheRun() throws {
        var book = BookBuilder()
        book.account("a1")
        var dates = Dates.monthly(from: "2025-07-20", count: 14)
        dates.remove(at: 6)  // two consecutive months gone
        dates.remove(at: 5)
        book.pay("Boxes Monthly", 899, on: dates)

        let series = try #require(try detect(book).series.first)
        // 14 slots, two of them empty and adjacent. Walking back from the last
        // payment: seven land, then two empty slots in a row stop the walk.
        #expect(series.evidence.matched == 7)
        #expect(series.evidence.missed == 0)
        // The five payments from before the gap are not thrown away, and they
        // are not folded into the pattern either -- they are counted and shown.
        #expect(series.evidence.earlierPayments == 5)
        #expect(series.occurrences.filter { $0.role == .earlier }.count == 5)
        #expect(series.occurrences.count == 12)
    }

    @Test("a series that spans a new card is one series")
    func aReplacedCard() throws {
        var book = BookBuilder()
        book.account("a1")
        book.account("a2")
        let dates = Dates.monthly(from: "2025-09-14", count: 12)
        book.pay("Streamly", 999, on: Array(dates.prefix(6)), account: "a1")
        book.pay("Streamly", 999, on: Array(dates.suffix(6)), account: "a2")

        let series = try #require(try detect(book).series.first)
        #expect(series.evidence.matched == 12)
        // In first-seen order, so the older card is named first.
        #expect(series.accountIds == ["a1", "a2"])
    }

    @Test("the same payee in two currencies is two arrangements")
    func currencyIsPartOfTheIdentity() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP")
        book.account("a2", currency: "EUR")
        book.pay("Hosting Co", 999, on: Dates.monthly(from: "2025-09-08", count: 12), account: "a1")
        book.pay(
            "Hosting Co", 1_100, on: Dates.monthly(from: "2025-09-22", count: 12), account: "a2",
            currency: "EUR"
        )

        let found = try detect(book)
        #expect(found.series.count == 2)
        #expect(Set(found.series.map(\.currency)) == ["GBP", "EUR"])
        // Never added together here: the totalling happens once, in `Insights`,
        // where the rates are.
        #expect(found.series.map(\.annualCostMinor).sorted() == [11_988, 13_200])
    }

    // MARK: - Confidence

    @Test("three perfect payments are a pattern; the word for it is not the top one")
    func threePerfectPayments() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Trio Ltd", 1_250, on: Dates.monthly(from: "2026-06-11", count: 3))

        let series = try #require(try detect(book).series.first)
        #expect(series.evidence.matched == 3)
        #expect(series.confidence == .medium)
    }

    @Test("three payments with a hole in them are only 'possible'")
    func threeImperfectPayments() throws {
        var book = BookBuilder()
        book.account("a1")
        // Four slots, three payments: 11 Apr, 11 May, [nothing], 11 Jul.
        book.pay("Maybe Ltd", 1_250, on: ["2026-04-11", "2026-05-11", "2026-07-11"])

        let series = try #require(try detect(book).series.first)
        #expect(series.evidence.matched == 3)
        #expect(series.evidence.missed == 1)
        // 3 / 4 = 0.75 coverage, nothing unexplained, so a fit of 0.75.
        #expect(abs(series.evidence.fit - 0.75) < 1e-9)
        #expect(series.confidence == .low)
    }

    @Test("a varying amount never reaches the top word")
    func varyingAmountsAreNeverClear() throws {
        var book = BookBuilder()
        book.account("a1")
        // A utility: monthly to the day, amount all over the place. The DATES
        // are perfect, so the pattern is real -- but calling it "clear" would
        // suggest the £62 is a price, and it is not.
        book.pay(
            "Cardinal Energy",
            amounts: [3_800, 7_100, 4_400, 6_600, 3_900, 7_200, 4_100, 6_900],
            on: Dates.monthly(from: "2026-01-03", count: 8)
        )

        let series = try #require(try detect(book).series.first)
        #expect(series.evidence.matched == 8)
        #expect(series.stability == .varies)
        #expect(series.confidence == .medium)
        #expect(series.annualCostIsEstimate)
        // The level says what it really is: a range, not a price.
        let level = try #require(series.currentLevel)
        #expect(level.lowMinor == 3_800)
        #expect(level.highMinor == 7_200)
    }

    // MARK: - Still running?

    @Test("a series whose next payment is not due yet is active")
    func activeSeries() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Streamly", 999, on: Dates.monthly(from: "2026-03-05", count: 6))
        let series = try #require(try detect(book).series.first)
        // Last payment 5 Aug 2026, next expected 5 Sep 2026, today 2 Sep.
        #expect(series.status == .active)
        #expect(series.nextExpectedDate == "2026-09-05")
    }

    @Test("a payment eight days late is due, not cancelled")
    func dueSeries() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Punctual Ltd", 2_000, on: ["2026-05-25", "2026-06-25", "2026-07-25"])
        let series = try #require(try detect(book).series.first)
        // Next expected 25 Aug 2026; today is 2 Sep 2026, so eight days late.
        #expect(series.status == .due(daysLate: 8))
        #expect(series.status.isLive)
    }

    @Test("a series that stopped in February LOOKS cancelled, and is never called cancelled")
    func lapsedSeries() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Old Gym", 3_400, on: Dates.monthly(from: "2025-09-05", count: 6))
        let series = try #require(try detect(book).series.first)
        // Last payment 5 Feb 2026. Expected on 5 Mar, Apr, May, Jun, Jul and
        // Aug -- six payments that did not happen. 5 Feb to 2 Sep is 209 days:
        // 28 + 31 + 30 + 31 + 30 + 31 + 28 = 209.
        #expect(series.status == .lapsed(daysSinceLast: 209, missedPayments: 6))
        #expect(series.status.isLive == false)
    }

    // MARK: - A payee that was renamed

    @Test("one arrangement recorded under two names is one series")
    func renamedPayee() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("SPOTIFY", 1_099, on: Dates.monthly(from: "2024-01-10", count: 6))
        book.pay("Spotify AB", 1_099, on: Dates.monthly(from: "2024-07-10", count: 8))

        let found = try detect(book)
        #expect(found.series.count == 1)
        let series = try #require(found.series.first)
        #expect(series.evidence.matched == 14)
        #expect(series.payeeName == "Spotify AB")
        #expect(series.alsoKnownAs == ["SPOTIFY"])
        // The older payments are still labelled with the name they were
        // recorded under, so the detail screen can show the rename rather than
        // rewriting history.
        #expect(series.occurrences.first?.payeeName == "SPOTIFY")
    }

    @Test("TWO PAYEES YOU PAY IN THE SAME YEARS ARE TWO PAYEES, however alike the names")
    func similarNamesThatOverlapAreNotMerged() throws {
        var book = BookBuilder()
        book.account("a1")
        // "Tesco" contains "Tesco", so the name test alone would merge these.
        // They overlap in time, so they are not a rename -- they are a shop and
        // its petrol station.
        book.pay("Tesco", 6_000, on: Dates.monthly(from: "2025-09-04", count: 12))
        book.pay("Tesco Fuel", 6_000, on: Dates.monthly(from: "2025-09-18", count: 12))

        let found = try detect(book)
        #expect(found.series.count == 2)
        #expect(Set(found.series.map(\.payeeName)) == ["Tesco", "Tesco Fuel"])
        #expect(found.series.allSatisfy { $0.alsoKnownAs.isEmpty })
    }

    @Test("a rename is refused when the amounts do not agree")
    func renameNeedsTheAmountsToAgree() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Cablecom", 2_000, on: Dates.monthly(from: "2024-01-10", count: 6))
        // Same-ish name, no overlap, but four times the amount: not the same
        // arrangement continuing.
        book.pay("Cablecom Ltd", 8_000, on: Dates.monthly(from: "2024-07-10", count: 8))

        let found = try detect(book)
        #expect(found.series.count == 2)
        #expect(found.series.allSatisfy { $0.alsoKnownAs.isEmpty })
    }

    // MARK: - Two is not three

    @Test("two payments a month apart are a pair, and predict nothing")
    func aPair() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Dentist", 8_500, on: ["2026-06-15", "2026-07-15"])

        let found = try detect(book)
        #expect(found.series.isEmpty)
        #expect(found.pairs.count == 1)
        let pair = try #require(found.pairs.first)
        #expect(pair.confidence == .pair)
        #expect(pair.cadence == .monthly)
        #expect(pair.evidence.matched == 2)
        // THE POINT OF THE WHOLE PAIR TYPE: no third payment is predicted from
        // one gap.
        #expect(pair.nextExpectedDate == nil)
    }

    @Test("two payments of different amounts are just two payments")
    func twoDifferentAmounts() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Hardware Shop", amounts: [8_500, 2_140], on: ["2026-06-15", "2026-07-15"])
        let found = try detect(book)
        #expect(found.pairs.isEmpty)
        #expect(found.series.isEmpty)
    }

    @Test("two payments 19 days apart are not any cadence")
    func twoPaymentsNoCadence() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Hardware Shop", 8_500, on: ["2026-06-15", "2026-07-04"])
        #expect(try detect(book).pairs.isEmpty)
    }

    // MARK: - Found among other spending

    @Test("a monthly charge hidden among a shop's other payments")
    func aPatternPickedOutByAmount() throws {
        var book = BookBuilder()
        book.account("a1")
        // 14 monthly charges of £7.99...
        book.pay("Marketplace", 799, on: Dates.monthly(from: "2025-07-02", count: 14))
        // ...buried in two years of unrelated orders at unrelated amounts on
        // unrelated days. None of these is within 10% of £7.99.
        book.pay(
            "Marketplace",
            amounts: [
                2_340, 1_580, 9_900, 4_210, 12_750, 3_305, 6_640, 1_990, 8_120, 2_875, 5_460,
                14_300, 3_720, 990, 7_050, 2_150,
            ],
            on: [
                "2025-07-14", "2025-07-27", "2025-08-19", "2025-09-03", "2025-09-21", "2025-10-11",
                "2025-11-06", "2025-11-23", "2025-12-30", "2026-01-17", "2026-02-08", "2026-03-25",
                "2026-04-13", "2026-05-29", "2026-06-19", "2026-07-30",
            ]
        )

        let found = try detect(book)
        let series = try #require(found.series.first { $0.typicalAmountMinor == 799 })
        #expect(series.cadence == .monthly)
        #expect(series.evidence.matched == 14)
        #expect(series.foundAmongOtherSpending)
        // A weaker claim, so never the top word.
        #expect(series.confidence == .medium)
        // And the screen is told there is other spending here it is not talking
        // about, so it can say so.
        #expect(series.evidence.otherPaymentsInRun > 0)
    }

    // MARK: - Everything is inspectable

    @Test("every figure on a series can be opened up to the transactions behind it")
    func everySeriesCarriesItsEvidence() throws {
        var book = BookBuilder()
        book.account("a1")
        var dates = Dates.monthly(from: "2025-09-05", count: 12)
        dates.remove(at: 4)
        dates.append("2026-04-19")  // an unrelated payment to the same payee
        book.pay("Streamly", 999, on: dates.sorted())

        let built = book.book()
        let series = try #require(
            try Recurrence.detect(book: built, today: Self.today).series.first
        )
        let ids = Set(built.transactions.map(\.id))
        // Every occurrence names a transaction that is really in the book...
        #expect(series.occurrences.allSatisfy { ids.contains($0.id) })
        // ...and the three roles account for every payment to this payee.
        #expect(series.occurrences.count == 12)
        #expect(
            series.evidence.matched + series.evidence.extras + series.evidence.earlierPayments
                == series.occurrences.count
        )
        #expect(series.occurrences.contains { $0.role == .extra })
        // The missed slot is named by date, so the screen can say WHICH month.
        #expect(series.evidence.missedDates == ["2026-01-05"])
    }
}
