// A spoken entry, and the boundary where a Double becomes money.
//
// This is the only place in the package where a Double gets near an amount --
// an App Intent parameter is typed by the system and `Double` is the type the
// system hands over for a number somebody said out loud. The rule at that
// boundary is the same rule as everywhere else: convert exactly, or refuse.
// Every case below is a way that could go wrong quietly.
import Testing

@testable import MyMoneyKit

struct QuickEntryTests {

    @Test("A SPOKEN AMOUNT CONVERTS EXACTLY OR NOT AT ALL")
    func spokenAmounts() {
        #expect(QuickEntry.minorUnits(spokenAmount: 4, currency: "GBP") == 400)
        #expect(QuickEntry.minorUnits(spokenAmount: 4.0, currency: "GBP") == 400)
        #expect(QuickEntry.minorUnits(spokenAmount: 4.2, currency: "GBP") == 420)
        #expect(QuickEntry.minorUnits(spokenAmount: 4.25, currency: "GBP") == 425)
        #expect(QuickEntry.minorUnits(spokenAmount: 1234.56, currency: "GBP") == 123_456)
        #expect(QuickEntry.minorUnits(spokenAmount: 0.01, currency: "GBP") == 1)

        // A magnitude: the sign belongs to `expenseDraft`, not to the parameter.
        #expect(QuickEntry.minorUnits(spokenAmount: -4.2, currency: "GBP") == 420)
    }

    @Test("A DOUBLE THAT IS NOT REALLY AN AMOUNT IS REFUSED, not rounded")
    func refusals() {
        // The canonical example. 0.1 + 0.2 as a Double is not 0.3, and its
        // shortest decimal text says so: "0.30000000000000004". Rounding it to
        // 30 would be inventing a number nobody said.
        #expect(QuickEntry.minorUnits(spokenAmount: 0.1 + 0.2, currency: "GBP") == nil)
        // More precision than the currency holds.
        #expect(QuickEntry.minorUnits(spokenAmount: 4.125, currency: "GBP") == nil)
        // A currency with no minor units has no such amount as 4.20.
        #expect(QuickEntry.minorUnits(spokenAmount: 4.2, currency: "JPY") == nil)
        #expect(QuickEntry.minorUnits(spokenAmount: 420, currency: "JPY") == 420)
        // Nonsense.
        #expect(QuickEntry.minorUnits(spokenAmount: .nan, currency: "GBP") == nil)
        #expect(QuickEntry.minorUnits(spokenAmount: .infinity, currency: "GBP") == nil)
        #expect(QuickEntry.minorUnits(spokenAmount: 1e15, currency: "GBP") == nil)
    }

    @Test("the refusal says which rule was broken")
    func refusalWording() {
        #expect(QuickEntry.amountRefusal(4.125, currency: "GBP").contains("2 decimal places"))
        #expect(QuickEntry.amountRefusal(4.2, currency: "JPY").contains("no pennies"))
        #expect(QuickEntry.amountRefusal(.nan, currency: "GBP").contains("not an amount"))
    }

    @Test("SPENDING IS NEGATIVE, decided in one place")
    func sign() {
        let draft = QuickEntry.expenseDraft(
            accountId: "a", date: "2026-09-02", amountMinor: 400, payeeName: "Bramble Coffee"
        )
        #expect(draft.amountMinor == -400)
        // A magnitude that already arrived negative does not become positive.
        #expect(
            QuickEntry.expenseDraft(accountId: "a", date: "d", amountMinor: -400).amountMinor
                == -400
        )
        // And the extreme value does not trap.
        #expect(
            QuickEntry.expenseDraft(accountId: "a", date: "d", amountMinor: Int64.min).amountMinor
                == Int64.min
        )
        // Nothing else is decided here: the store validates the rest.
        #expect(draft.payeeName == "Bramble Coffee")
        #expect(draft.categoryId == nil)
        #expect(draft.splits.isEmpty)
    }

    // MARK: - Naming a category out loud

    private let choices: [CategoryChoice] = [
        CategoryChoice(id: "f", name: "Food", path: "Food", kind: .expense, depth: 0, archived: false),
        CategoryChoice(
            id: "fe", name: "Eating out", path: "Food \u{203A} Eating out", kind: .expense,
            depth: 1, archived: false
        ),
        CategoryChoice(
            id: "fg", name: "Groceries", path: "Food \u{203A} Groceries", kind: .expense,
            depth: 1, archived: false
        ),
        CategoryChoice(
            id: "tr", name: "Rail", path: "Transport \u{203A} Rail", kind: .expense,
            depth: 1, archived: false
        ),
        CategoryChoice(
            id: "trc", name: "Railcards", path: "Transport \u{203A} Railcards", kind: .expense,
            depth: 1, archived: false
        ),
        CategoryChoice(
            id: "old", name: "Coffee", path: "Food \u{203A} Coffee", kind: .expense,
            depth: 1, archived: true
        ),
    ]

    @Test("an exact name wins over a name that merely contains it")
    func exactFirst() {
        // "Rail" must not become "Railcards" in a book that has both.
        #expect(QuickEntry.category(named: "Rail", in: choices)?.id == "tr")
        #expect(QuickEntry.category(named: "rail", in: choices)?.id == "tr")
        #expect(QuickEntry.category(named: "Railcards", in: choices)?.id == "trc")
        // The full path is accepted too, for the Shortcuts user who typed it.
        #expect(QuickEntry.category(named: "Food \u{203A} Groceries", in: choices)?.id == "fg")
        // And a partial name resolves when it is unambiguous.
        #expect(QuickEntry.category(named: "eating", in: choices)?.id == "fe")
        #expect(QuickEntry.category(named: "grocer", in: choices)?.id == "fg")
    }

    @Test("AMBIGUITY BECOMES NO CATEGORY, never a guess")
    func ambiguityResolvesToNothing() {
        // "rai" matches both Rail and Railcards. A coffee quietly filed under
        // the wrong one is worse than a coffee with no category, which the
        // owner can see and fix.
        #expect(QuickEntry.category(named: "rai", in: choices) == nil)
        #expect(QuickEntry.category(named: "zzz", in: choices) == nil)
        #expect(QuickEntry.category(named: "", in: choices) == nil)
        #expect(QuickEntry.category(named: "   ", in: choices) == nil)
        // An archived category is not revived by a new entry.
        #expect(QuickEntry.category(named: "Coffee", in: choices) == nil)
    }

    @Test("WHAT SIRI SAYS BACK NAMES THE ACCOUNT, and says when there is no category")
    func confirmation() {
        // The failure a spoken entry has that a typed one does not: landing in
        // the wrong account with nobody looking at a screen.
        let full = QuickEntry.spokenConfirmation(
            amountMinor: -400, currency: "GBP", payeeName: "Bramble Coffee",
            accountName: "Everyday", categoryPath: "Food \u{203A} Eating out"
        )
        #expect(full.contains("Everyday"))
        #expect(full.contains("Bramble Coffee"))
        #expect(full.contains("Food \u{203A} Eating out"))
        // The magnitude, spoken as an amount rather than as a negative.
        #expect(full.contains(Money.format(400, currency: "GBP")))
        #expect(!full.contains("-"))

        // Silence about the category would read as "filed correctly".
        let bare = QuickEntry.spokenConfirmation(
            amountMinor: -400, currency: "GBP", payeeName: "", accountName: "Everyday",
            categoryPath: nil
        )
        #expect(bare.contains("no category"))
        #expect(bare == "Added \(Money.format(400, currency: "GBP")) to Everyday, with no category.")
    }
}
