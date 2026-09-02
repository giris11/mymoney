// What the detector says about data that means nothing.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SUITE EXISTS. Every other test in this feature hands the detector a
// shape and asks whether it recognises it. This one hands it NOISE -- hundreds
// of invented payees with unrelated amounts on unrelated days -- and asks how
// much it invents. That is the question a decade of somebody's real spending
// actually poses: not "can you find the twelve subscriptions" but "how many
// things will you claim about the four hundred payees that are not
// subscriptions".
//
// Every finding in this file was a bug first. The three tests below are the
// three things a run of this shape caught:
//
//   1. numbered payees ("Payee number 3", "Payee number 30") merging into each
//      other, which was also six seconds of a screen that should take half of
//      one;
//   2. a level of ONE payment being read as an exact price, which produced
//      eight confident-looking series out of pure randomness;
//   3. the twelve real patterns hidden in the same noise still being found.
//
// The book is generated from a fixed seed, so it is the same book every run.
// Every payee name and amount in it is fiction.
import Testing

@testable import MyMoneyKit

struct InsightsNoiseTests {
    static let today = "2026-09-02"

    /// A deterministic xorshift, so this file has no dependency on the
    /// platform's random number generator and no run-to-run variation.
    struct Noise {
        private var state: UInt64 = 0x1234_5678_9ABC_DEF0
        mutating func next(_ bound: Int) -> Int {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            return Int(state % UInt64(bound))
        }
    }

    /// 200 payees of unrelated payments, plus 6 real monthly patterns.
    static func noisyBook() -> Book {
        var noise = Noise()
        var book = BookBuilder()
        book.account("a1")

        for payee in 0..<200 {
            let count = 1 + noise.next(24)
            var day = CalendarDate(iso: "2016-01-04")!.addingDays(noise.next(3000))
            var dates: [String] = []
            var amounts: [Int64] = []
            for _ in 0..<count {
                day = day.addingDays(1 + noise.next(40))
                dates.append(day.iso)
                amounts.append(Int64(100 + noise.next(20_000)))
            }
            book.pay("Payee number \(payee)", amounts: amounts, on: dates)
        }

        for real in 0..<6 {
            book.pay(
                "Subscription \(real)", Int64(499 + real * 100),
                on: Dates.monthly(from: "2019-03-0\(real + 1)", count: 90)
            )
        }
        return book.book()
    }

    // MARK: - How much it invents

    @Test("NOISE PRODUCES ALMOST NOTHING, and what it produces is marked 'possible'")
    func noiseIsMostlyRefused() throws {
        let report = try Insights.report(book: Self.noisyBook(), today: Self.today)

        let invented = report.recurring.filter { $0.payeeName.hasPrefix("Payee number") }
        // Two hundred payees of pure randomness. Some of them really will have
        // three payments a month apart -- that is what randomness does -- and
        // the app cannot tell those from a real quarterly bill, so a handful is
        // the HONEST answer rather than zero. What matters is that there are
        // few of them and that none is presented as certain.
        #expect(invented.count <= 4, "invented: \(invented.map { "\($0.payeeName) \($0.confidence)" })")
        #expect(
            invented.allSatisfy { $0.confidence <= .medium },
            "nothing from noise may ever be called clear"
        )
        // ...and every one of them carries the transactions behind it, so the
        // reader can see in one tap that it is three payments and a coincidence.
        #expect(invented.allSatisfy { $0.occurrences.count >= 3 })
    }

    @Test("the real patterns are still found in the middle of all that")
    func realPatternsSurviveTheNoise() throws {
        let report = try Insights.report(book: Self.noisyBook(), today: Self.today)
        let real = report.recurring.filter { $0.payeeName.hasPrefix("Subscription") }
        #expect(real.count == 6)
        #expect(real.allSatisfy { $0.cadence == .monthly })
        #expect(real.allSatisfy { $0.confidence == .high })
        #expect(real.allSatisfy { $0.evidence.matched == 90 })
        #expect(real.allSatisfy { $0.evidence.fit == 1.0 })
    }

    // MARK: - The two bugs it found

    @Test("NUMBERED PAYEES ARE NEVER A RENAME")
    func numberedPayeesDoNotMerge() throws {
        // "Payee number 3" is a prefix of "Payee number 30", so every string
        // similarity test in the codebase calls them alike. They are two
        // payees. Real ledgers are full of the same shape -- a trip number, an
        // invoice number, a card number in a description -- and merging any of
        // them puts unrelated payments in one series.
        #expect(Recurrence.looksLikeARename("payee number 3", "payee number 30") == false)
        #expect(Recurrence.looksLikeARename("uber trip 4821", "uber trip 4822") == false)
        #expect(Recurrence.looksLikeARename("invoice 1001", "invoice 1002") == false)
        // The exception is narrow: it fires only when the DIGITS are the whole
        // difference. A real rename is still a rename.
        #expect(Recurrence.looksLikeARename("spotify", "spotify ab"))
        #expect(Recurrence.looksLikeARename("netflix com", "netflix"))
        // And a name that differs by digits AND letters is still considered.
        #expect(Recurrence.looksLikeARename("acme 2 ltd", "acme 2"))

        // End to end: two numbered payees whose dates do not overlap and whose
        // amounts agree are still two payees.
        var book = BookBuilder()
        book.account("a1")
        book.pay("Locker 12", 2_000, on: Dates.monthly(from: "2025-01-06", count: 4))
        book.pay("Locker 120", 2_000, on: Dates.monthly(from: "2025-06-06", count: 4))
        let found = try Recurrence.detect(book: book.book(), today: Self.today)
        #expect(found.series.count == 2)
        #expect(found.series.allSatisfy { $0.alsoKnownAs.isEmpty })
    }

    @Test("ONE PAYMENT IS NOT A PRICE")
    func aSinglePaymentIsNotAPrice() throws {
        var book = BookBuilder()
        book.account("a1")
        // Four unrelated amounts, on a perfect monthly grid, where the last one
        // is on its own. Reading the price off the most recent level would call
        // this "exact" -- a level of one payment always has a spread of zero.
        book.pay(
            "Random Ltd", amounts: [3_945, 3_945, 12_869, 12_869, 40_000],
            on: Dates.monthly(from: "2026-04-08", count: 5)
        )
        let found = try Recurrence.detect(book: book.book(), today: Self.today)
        // The whole run is looked at instead, and it is not a price at all.
        #expect(found.series.isEmpty)
    }

    @Test("a subscription whose price rose LAST MONTH says exactly that")
    func aFreshRiseIsUnsettledRatherThanExact() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay(
            "Streamly", amounts: Array(repeating: 899, count: 11) + [1_099],
            on: Dates.monthly(from: "2025-09-05", count: 12)
        )
        let series = try #require(
            try Recurrence.detect(book: book.book(), today: Self.today).series.first
        )
        // The amount is exact to the penny -- and it has been paid once, which
        // is a different claim from "this is what it costs".
        #expect(series.stability == .unsettled)
        #expect(series.stability.isSettled == false)
        #expect(series.typicalAmountMinor == 1_099)
        // Held to the strict standard, and never called clear...
        #expect(series.confidence == .medium)
        // ...but the rise itself is reported, with its own honest caveat.
        let change = try #require(series.latestChange)
        #expect(change.changeMinor == 200)
        #expect(change.confirmed == false)
        #expect(change.paymentsAtNewLevel == 1)
    }
}
