// Money nobody has touched.
//
// EVERY DATE IS HAND-CALCULATED against a fixed today of 2 September 2026:
//
//   2025-07-29 is 400 days before   (365 to 2026-07-29, then 2 + 31 + 2 = 35)
//   2025-09-02 is 365 days before
//   2026-02-14 is 200 days before   (16 to 2 March, then 184 to 2 September)
//
// All names, balances and currencies are invented.
import Testing

@testable import MyMoneyKit

struct DormantMoneyTests {
    static let today = "2026-09-02"

    private func find(_ builder: BookBuilder) throws -> DormantFindings {
        try DormantMoney.find(book: builder.book(), today: Self.today)
    }

    @Test("an account with money and no activity for over a year, hand-calculated")
    func aDormantAccount() throws {
        var book = BookBuilder()
        book.account("a1", opening: 50_000, name: "Old Current Account")
        book.pay("Somewhere", 10_000, on: ["2025-07-29"], account: "a1")

        let found = try find(book)
        #expect(found.accounts.count == 1)
        let row = try #require(found.accounts.first)
        #expect(row.account.name == "Old Current Account")
        // £500 opening less the £100 payment.
        #expect(row.balanceMinor == 40_000)
        #expect(row.lastActivityDate == "2025-07-29")
        #expect(row.daysSinceActivity == 400)
        #expect(row.transactionCount == 1)
        #expect(row.isOwed == false)
        #expect(found.totalBaseMinor == 40_000)
    }

    @Test("a year and a day, not a year less a day")
    func theBoundary() throws {
        var quiet = BookBuilder()
        quiet.account("a1", opening: 50_000)
        quiet.pay("Somewhere", 100, on: ["2025-09-02"], account: "a1")  // exactly 365 days
        #expect(try find(quiet).accounts.count == 1)

        var busy = BookBuilder()
        busy.account("a1", opening: 50_000)
        busy.pay("Somewhere", 100, on: ["2026-02-14"], account: "a1")  // 200 days
        // Six months of quiet on a savings account is a savings account, not a
        // forgotten one.
        #expect(try find(busy).accounts.isEmpty)
    }

    @Test("an account with an opening balance and nothing else has no 'how long'")
    func neverUsed() throws {
        var book = BookBuilder()
        book.account("a1", opening: 25_000, name: "Opened And Forgotten")

        let row = try #require(try find(book).accounts.first)
        #expect(row.lastActivityDate == nil)
        // NOT ZERO, and not "today": how long since something that never
        // happened has no answer, and this app does not invent one.
        #expect(row.daysSinceActivity == nil)
        #expect(row.transactionCount == 0)
    }

    @Test("a pound is the floor; small change is not forgotten money")
    func tinyBalances() throws {
        var book = BookBuilder()
        book.account("a1", opening: 50)  // 50p
        book.account("a2", opening: 100)  // £1.00 exactly
        book.account("a3", opening: 99)  // 99p
        let found = try find(book)
        #expect(found.accounts.map(\.account.id) == ["a2"])
    }

    @Test("a dormant credit card with money still owing is worth just as much attention")
    func moneyOwed() throws {
        var book = BookBuilder()
        book.account("a1", opening: 0, type: .creditCard, name: "Old Card")
        book.pay("Somewhere", 8_000, on: ["2025-07-29"], account: "a1")

        let row = try #require(try find(book).accounts.first)
        #expect(row.balanceMinor == -8_000)
        #expect(row.isOwed)
        // It counts INTO the total the way it counts into net worth: as a
        // negative. The screen says "owed" rather than showing a minus and
        // hoping.
        #expect(try find(book).totalBaseMinor == -8_000)
    }

    @Test("a future-dated payment means the account is anything but forgotten")
    func futureDated() throws {
        var book = BookBuilder()
        book.account("a1", opening: 50_000)
        book.pay("Somewhere", 100, on: ["2026-12-25"], account: "a1")
        #expect(try find(book).accounts.isEmpty)
    }

    @Test("archived accounts are listed separately, not mixed in and not dropped")
    func archived() throws {
        var book = BookBuilder()
        book.account("a1", opening: 50_000, archived: true, name: "Retired Account")
        book.account("a2", opening: 30_000, name: "Live Account")

        let found = try find(book)
        #expect(found.accounts.map(\.account.name) == ["Live Account"])
        #expect(found.archived.map(\.account.name) == ["Retired Account"])
        // The archived one is NOT in the total: the owner already said they
        // were done with it.
        #expect(found.totalBaseMinor == 30_000)
    }

    @Test("an account excluded from net worth still holds real money")
    func excludedFromNetWorth() throws {
        var book = BookBuilder()
        book.account("a1", opening: 50_000, excluded: true)
        let row = try #require(try find(book).accounts.first)
        #expect(row.excludedFromNetWorth)
        #expect(row.balanceMinor == 50_000)
    }

    @Test("longest quiet first, and never-used first of all")
    func order() throws {
        var book = BookBuilder()
        book.account("a1", opening: 10_000, name: "Quiet for 400 days")
        book.pay("Somewhere", 1, on: ["2025-07-29"], account: "a1")
        book.account("a2", opening: 10_000, name: "Quiet for 365 days")
        book.pay("Somewhere", 1, on: ["2025-09-02"], account: "a2")
        book.account("a3", opening: 10_000, name: "Never used")

        #expect(
            try find(book).accounts.map(\.account.name)
                == ["Never used", "Quiet for 400 days", "Quiet for 365 days"]
        )
    }

    // MARK: - Currency

    @Test("balances are converted once, at the total, and never on the row")
    func conversion() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP", opening: 40_000)
        book.account("a2", currency: "EUR", opening: 20_000)
        book.rate("EUR", "GBP", 0.85)

        let found = try find(book)
        #expect(found.accounts.count == 2)
        // The EUR row keeps its own money in its own currency...
        let euro = try #require(found.accounts.first { $0.account.currency == "EUR" })
        #expect(euro.balanceMinor == 20_000)
        // ...and carries the converted figure separately: 20000 × 0.85 = 17000.
        #expect(euro.baseMinor == 17_000)
        #expect(found.totalBaseMinor == 57_000)
        #expect(found.missingRateCurrencies.isEmpty)
    }

    @Test("A MISSING RATE IS SAID OUT LOUD, never quietly dropped from the total")
    func missingRate() throws {
        var book = BookBuilder()
        book.account("a1", currency: "GBP", opening: 40_000)
        book.account("a2", currency: "JPY", opening: 500_000)

        let found = try find(book)
        // Both accounts are still listed -- you must never be unable to find
        // your own money...
        #expect(found.accounts.count == 2)
        let yen = try #require(found.accounts.first { $0.account.currency == "JPY" })
        #expect(yen.balanceMinor == 500_000)
        #expect(yen.baseMinor == nil)
        // ...and the total covers what it can, says how many accounts that is,
        // and NAMES the currency it could not include -- the same rule
        // `Balances.netWorth` follows for the headline figure.
        #expect(found.totalBaseMinor == 40_000)
        #expect(found.accountsCounted == 1)
        #expect(found.accountsWithoutRate == 1)
        #expect(found.missingRateCurrencies == ["JPY"])
    }
}
