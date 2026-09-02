// The things this screen must NOT say.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS THE SUITE THAT DECIDES WHETHER THE FEATURE SHIPS. A recurring-payment
// finder that also finds your salary, your rent-as-a-subscription, your weekly
// shop and your second coffee is not a feature -- it is a screen the owner
// learns to distrust, and once distrusted the true rows on it are worthless too.
//
// Each test below is a thing a real ledger contains that LOOKS like a
// subscription to a naive detector, and each one names the rule that stops it.
// Every name and figure is invented.
import Testing

@testable import MyMoneyKit

struct InsightsFalsePositiveTests {
    static let today = "2026-09-02"

    private func detect(_ builder: BookBuilder) throws -> RecurrenceResult {
        try Recurrence.detect(book: builder.book(), today: Self.today)
    }

    // MARK: - Money in

    @Test("A MONTHLY SALARY IS NOT A RECURRING PAYMENT")
    func salary() throws {
        var book = BookBuilder()
        book.account("a1")
        // Two years of pay on the 28th: the most regular thing in most books,
        // identical to the penny, and not something you pay.
        book.receive("Employer Ltd", 250_000, on: Dates.monthly(from: "2024-09-28", count: 24))

        let found = try detect(book)
        #expect(found.series.isEmpty)
        #expect(found.pairs.isEmpty)
        // Excluded by a RULE, not by a threshold: no salary can ever reach the
        // pattern search, however regular it is.
        #expect(found.coverage.moneyInSkipped == 24)
        #expect(found.coverage.paymentsConsidered == 0)
    }

    @Test("a refund inside a subscription is not a payment")
    func refundsAreNotPayments() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        book.receive("Streamly", 999, on: ["2026-03-20"])  // a month refunded

        let found = try detect(book)
        let series = try #require(found.series.first)
        // The refund is not an extra payment and not a missed one: it is not a
        // payment at all, and the pattern is untouched by it.
        #expect(series.evidence.matched == 12)
        #expect(series.evidence.extras == 0)
        #expect(found.coverage.moneyInSkipped == 1)
    }

    // MARK: - Rent

    @Test("RENT IS RECURRING, AND IS NOT CALLED A SUBSCRIPTION")
    func rent() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Landlord", 120_000, on: Dates.monthly(from: "2025-09-01", count: 12))

        let series = try #require(try detect(book).series.first)
        // It IS a recurring payment and pretending otherwise would be a
        // different kind of dishonesty -- £1,200 a month is the biggest
        // repeating thing in most people's records and belongs on this screen.
        #expect(series.cadence == .monthly)
        #expect(series.confidence == .high)
        // £1,200 × 12 = £14,400.
        #expect(series.annualCostMinor == 1_440_000)
        // What the app does NOT do is claim to know what kind of arrangement
        // this is. There is no "subscription" anywhere in the model: a series
        // has a payee, a rhythm and an amount, and the reader decides what it
        // is. This test is the record of that decision.
    }

    // MARK: - The weekly shop

    @Test("A WEEKLY SHOP AT THE SAME SUPERMARKET IS NOT A RECURRING PAYMENT")
    func theWeeklyShop() throws {
        var book = BookBuilder()
        book.account("a1")
        // Nine months of shopping: mostly weekly-ish, sometimes twice in a
        // week, sometimes a fortnight away, and never twice for the same money.
        // Invented, and deliberately written out so the shape is visible.
        let dates = [
            "2025-12-06", "2025-12-13", "2025-12-15", "2025-12-21", "2025-12-24",
            "2026-01-03", "2026-01-09", "2026-01-17", "2026-01-19", "2026-01-26",
            "2026-02-02", "2026-02-08", "2026-02-14", "2026-02-21", "2026-02-25",
            "2026-03-04", "2026-03-11", "2026-03-13", "2026-03-20", "2026-03-29",
            "2026-04-04", "2026-04-11", "2026-04-18", "2026-04-20", "2026-04-27",
            "2026-05-05", "2026-05-12", "2026-05-16", "2026-05-23", "2026-05-31",
            "2026-06-06", "2026-06-13", "2026-06-19", "2026-06-27", "2026-07-04",
            "2026-07-11", "2026-07-14", "2026-07-22", "2026-07-29", "2026-08-05",
            "2026-08-12", "2026-08-19", "2026-08-26",
        ]
        let amounts: [Int64] = [
            4_312, 8_907, 1_240, 12_455, 3_388, 6_710, 2_945, 9_120, 810, 5_530,
            7_215, 3_060, 11_480, 4_925, 1_675, 8_340, 2_210, 6_890, 3_745, 10_120,
            5_060, 2_480, 9_935, 1_120, 7_650, 4_405, 12_010, 3_215, 6_140, 8_820,
            2_730, 5_915, 10_460, 1_890, 7_030, 3_570, 9_245, 4_680, 6_305, 2_150,
            8_115, 5_240, 11_070,
        ]
        book.pay("Greengrocer", amounts: amounts, on: dates)

        let found = try detect(book)
        // Nothing is claimed. Two independent rules refuse it: the dates do not
        // sit on any grid (there are always payments a grid has no slot for),
        // and the amounts are not a price.
        #expect(found.series.isEmpty, "claimed: \(found.series.map { "\($0.cadence) \($0.confidence)" })")
        #expect(found.coverage.payeesWithNoPattern == 1)
    }

    @Test("two coffees on one day are not a rhythm")
    func twoCoffeesInADay() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Bramble Coffee", 280, on: ["2026-08-11", "2026-08-11"])

        let found = try detect(book)
        #expect(found.series.isEmpty)
        // Not even a pair: a gap of nothing is not a cadence.
        #expect(found.pairs.isEmpty)
    }

    // MARK: - Transfers

    @Test("A MONTHLY TRANSFER TO SAVINGS IS NOT A PAYMENT TO ANYONE")
    func standingTransfer() throws {
        var book = BookBuilder()
        book.account("a1")
        book.account("a2", type: .savings)
        book.transfer(50_000, from: "a1", to: "a2", on: Dates.monthly(from: "2025-09-02", count: 12))

        let found = try detect(book)
        #expect(found.series.isEmpty)
        #expect(found.pairs.isEmpty)
        // Both legs of all twelve.
        #expect(found.coverage.transfersSkipped == 24)
        #expect(found.coverage.paymentsConsidered == 0)
    }

    // MARK: - What cannot be looked at

    @Test("payments with no payee are counted, not quietly ignored")
    func noPayee() throws {
        var book = BookBuilder()
        book.account("a1")
        for date in Dates.monthly(from: "2025-09-05", count: 12) {
            book.add(payee: nil, amount: -999, date: date)
        }

        let found = try detect(book)
        #expect(found.series.isEmpty)
        // THE HONEST PART: the screen is told how many payments it could not
        // group, so it can say "12 payments had no payee and were not
        // considered" instead of implying it looked at everything.
        #expect(found.coverage.withoutPayeeSkipped == 12)
        #expect(found.coverage.paymentsConsidered == 0)
    }

    @Test("one payment to a payee is not a pattern and is counted as such")
    func onePayment() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("One-off Shop", 4_500, on: ["2026-05-05"])
        let found = try detect(book)
        #expect(found.series.isEmpty)
        #expect(found.coverage.payeesWithOnePayment == 1)
        #expect(found.coverage.payeesSeen == 1)
    }

    // MARK: - Everything at once

    @Test("a book full of temptations produces exactly the two real patterns")
    func aBookOfEverything() throws {
        var book = BookBuilder()
        book.account("a1")
        book.account("a2", type: .savings)

        // Real: a subscription and a rent.
        book.pay("Streamly", 999, on: Dates.monthly(from: "2025-09-05", count: 12))
        book.pay("Landlord", 120_000, on: Dates.monthly(from: "2025-09-01", count: 12))
        // Not real: salary, standing transfer, the weekly shop, one coffee
        // twice in a day, and a single big purchase.
        book.receive("Employer Ltd", 250_000, on: Dates.monthly(from: "2025-09-28", count: 12))
        book.transfer(50_000, from: "a1", to: "a2", on: Dates.monthly(from: "2025-09-02", count: 12))
        book.pay(
            "Greengrocer",
            amounts: [4_312, 8_907, 1_240, 12_455, 3_388, 6_710, 2_945, 9_120, 810, 5_530],
            on: [
                "2026-01-03", "2026-01-09", "2026-01-17", "2026-01-19", "2026-01-26",
                "2026-02-02", "2026-02-08", "2026-02-14", "2026-02-21", "2026-02-25",
            ]
        )
        book.pay("Bramble Coffee", 280, on: ["2026-08-11", "2026-08-11"])
        book.pay("Furniture Barn", 89_900, on: ["2026-04-02"])

        let found = try detect(book)
        #expect(Set(found.series.map(\.payeeName)) == ["Streamly", "Landlord"])
        #expect(found.pairs.isEmpty)
    }
}
