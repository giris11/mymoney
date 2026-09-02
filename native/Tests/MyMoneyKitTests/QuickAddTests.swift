// The fast path: what has to already be right for a coffee to take three
// seconds.
//
// The ranking half of this is a PURE FUNCTION over a list, and it is tested as
// one -- no database, no store, no fixture. That is deliberate: the interesting
// question ("which of these two payees does an owner mean when they type 's'?")
// is a question about ordering, and a test that had to build a ledger to ask it
// would be a test nobody adds a case to.
import Foundation
import Testing

@testable import MyMoneyKit

struct PayeeIndexTests {

    private func index(_ entries: [(String, Int, String?)]) -> PayeeIndex {
        PayeeIndex(
            payees: entries.enumerated().map { offset, entry in
                PayeeSuggestion(
                    id: "p\(offset)", name: entry.0, defaultCategoryId: nil,
                    useCount: entry.1, lastUsedDate: entry.2
                )
            }
        )
    }

    @Test("PREFIX MATCHES COME FIRST, then anything that merely contains the query")
    func prefixBeatsSubstring() {
        let payees = index([("Corner Shop", 1, "2026-01-01"), ("Shop Direct", 1, "2026-01-01")])
        #expect(payees.suggestions(matching: "shop").map(\.name) == ["Shop Direct", "Corner Shop"])
    }

    @Test("WITHIN A BAND, THE HABIT WINS: most used, then most recent, then alphabetical")
    func rankingUsesHistory() {
        let payees = index([
            ("Sandwich Place", 1, "2019-04-02"),
            ("Supermarket", 40, "2026-08-30"),
            ("Station Cafe", 12, "2026-08-29"),
        ])
        #expect(
            payees.suggestions(matching: "s").map(\.name)
                == ["Supermarket", "Station Cafe", "Sandwich Place"]
        )
        // A shop visited once in 2019 must not be offered ahead of the one used
        // every week. This is the deliberate improvement on the web app's
        // alphabetical ordering, and it is safe because the order of a MENU is
        // not data -- both apps resolve the chosen row to the same payee id.
    }

    @Test("equal use falls back to the most recent, then to the name")
    func tieBreaks() {
        let payees = index([
            ("Beta", 3, "2026-01-01"), ("Alpha", 3, "2026-05-01"), ("Gamma", 3, "2026-05-01"),
        ])
        #expect(payees.suggestions(matching: "").map(\.name) == ["Alpha", "Gamma", "Beta"])
    }

    @Test("matching ignores case, stray spaces and the difference between them")
    func matchingIsForgiving() {
        let payees = index([("The  Corner   Shop", 1, nil)])
        #expect(payees.suggestions(matching: "the corner shop").count == 1)
        #expect(payees.suggestions(matching: "  THE CORNER  ").count == 1)
        #expect(payees.exactMatch("the corner shop")?.id == "p0")
        #expect(payees.exactMatch("corner")  == nil)
    }

    @Test("an empty query offers the most-used payees, because the answer usually is one")
    func emptyQuery() {
        let payees = index([("Rare", 1, nil), ("Often", 90, nil)])
        #expect(payees.suggestions(matching: "  ").map(\.name) == ["Often", "Rare"])
    }

    @Test("the list is capped, and the cap keeps the best rather than the first")
    func limit() {
        let payees = index((1...20).map { ("Payee \($0)", $0, nil) })
        let top = payees.suggestions(matching: "payee", limit: 3)
        #expect(top.map(\.name) == ["Payee 20", "Payee 19", "Payee 18"])
    }

    @Test("no match is an empty list, not a wrong guess")
    func noMatch() {
        #expect(index([("Corner Shop", 1, nil)]).suggestions(matching: "zzz").isEmpty)
    }
}

struct QuickAddContextTests {

    @Test("QUICK ADD OPENS ON THE ACCOUNT LAST WRITTEN TO")
    func defaultsToLastUsed() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(try store.quickAddContext().defaultAccountId == "w-a")

        try store.saveTransaction(EditFixture.expense(account: "w-b", category: nil))
        #expect(try store.quickAddContext().defaultAccountId == "w-b")
        #expect(try store.quickAddContext().defaultAccount?.currency == "EUR")
    }

    @Test("it falls back rather than defaulting into an account that has been archived")
    func fallsBack() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.setAccountArchived(id: "w-a", archived: true)
        let context = try store.quickAddContext()
        // w-a is remembered but archived, so the default moves to the first
        // account that is not.
        #expect(context.defaultAccountId == "w-b")
        // ...and w-a is still IN the list, at the end, because an archived
        // account must remain correctable.
        #expect(context.accounts.map(\.id) == ["w-b", "w-a", "w-c"])
    }

    @Test("the category picker carries resolved paths and depths, ready to indent")
    func categoryChoices() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let choices = try store.categoryChoices()
        #expect(choices.map(\.path) == ["Food", "Food \u{203A} Groceries"])
        #expect(choices.map(\.depth) == [0, 1])
        #expect(choices.allSatisfy { $0.kind == .expense })
    }

    @Test("THE QUICK-PICK ROW IS WHAT THIS BOOK ACTUALLY USES, most-used first")
    func frequentCategories() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Three under Groceries, one under Food.
        for day in 1...3 {
            try store.saveTransaction(
                EditFixture.expense(category: "c-sub", date: "2026-09-0\(day)")
            )
        }
        try store.saveTransaction(EditFixture.expense(category: "c-food", date: "2026-09-04"))
        // t1's split adds one more Food vote.
        #expect(try store.frequentCategoryIds() == ["c-sub", "c-food"])
    }

    @Test("frequency is measured from the BOOK's newest date, not from the device clock")
    func recencyIsRelativeToTheBook() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // The fixture's newest transaction is 2026-08-22. A window measured
        // from a real "today" years later would return nothing at all, and a
        // row of quick-pick buttons that is empty on an old backup and full on
        // a new one is worse than one that is always full.
        // Only t1 (3 August) is inside a 30-day window ending at the book's
        // own newest row, and it contributes its split's one category. t2 is a
        // transfer leg and has no category to contribute.
        #expect(try store.frequentCategoryIds(withinDays: 30) == ["c-food"])
        // An empty book has nothing to offer, and says so without throwing.
        let empty = try scratch.store("empty.sqlite")
        #expect(try empty.frequentCategoryIds().isEmpty)
    }

    @Test("choosing a payee brings its learned category with it -- the second tap disappears")
    func payeeCarriesItsCategory() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveTransaction(EditFixture.expense(payee: "Kiosk", category: "c-sub"))

        let context = try store.quickAddContext()
        let suggestion = try #require(context.payees.suggestions(matching: "kio").first)
        #expect(suggestion.name == "Kiosk")
        #expect(suggestion.defaultCategoryId == "c-sub")
        #expect(suggestion.useCount == 1)
        #expect(suggestion.lastUsedDate == "2026-09-01")
    }

    @Test("a payee with no transactions is still offered -- somebody typed it for a reason")
    func unusedPayeesAreStillOffered() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // "Corner Shop" (p1) is only on t2. Delete t2 and it has none left.
        try store.deleteTransaction(id: "t2")
        let index = try store.payeeIndex()
        #expect(index.payee(id: "p1")?.useCount == 0)
        #expect(index.suggestions(matching: "corner").map(\.name) == ["Corner Shop"])
    }
}
