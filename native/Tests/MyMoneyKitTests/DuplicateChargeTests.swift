// What matched, and nothing more.
//
// EVERY EXPECTATION IS HAND-CALCULATED and every name and figure is invented.
//
// The tests are in two halves. The first proves the matching is EXACT -- same
// account, same payee, same amount, same or adjacent day, and no fuzziness
// anywhere, because a wrong "you were charged twice" costs an afternoon on hold.
// The second proves the app collects the evidence that says WHERE the two rows
// came from, and never turns that evidence into a verdict.
import Testing

@testable import MyMoneyKit

struct DuplicateChargeTests {

    private func find(_ builder: BookBuilder) -> DuplicateFindings {
        DuplicateCharges.find(book: builder.book())
    }

    // MARK: - What matches

    @Test("two identical payments on one day match")
    func sameDay() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03", "2026-08-03"])

        let found = find(book)
        #expect(found.unusual.count == 1)
        let match = try #require(found.unusual.first)
        #expect(match.count == 2)
        #expect(match.spanDays == 0)
        #expect(match.amountMinor == 14_999)
        #expect(match.routineForThisPayee == false)
        // Both transactions are carried, so the screen can show them rather
        // than describe them.
        #expect(match.transactions.count == 2)
        #expect(match.transactions.map(\.date) == ["2026-08-03", "2026-08-03"])
    }

    @Test("the next day counts; the day after does not")
    func adjacency() throws {
        var adjacent = BookBuilder()
        adjacent.account("a1")
        adjacent.pay("Kitchen Supplies", 14_999, on: ["2026-08-03", "2026-08-04"])
        #expect(find(adjacent).unusual.first?.spanDays == 1)

        var apart = BookBuilder()
        apart.account("a1")
        apart.pay("Kitchen Supplies", 14_999, on: ["2026-08-03", "2026-08-05"])
        // Two days apart is two payments. A wider window would sweep up every
        // pair of identical weekly charges in the book.
        #expect(find(apart).unusual.isEmpty)
    }

    @Test("three on one day is one row, not two")
    func threeInACluster() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03", "2026-08-03", "2026-08-03"])
        let match = try #require(find(book).unusual.first)
        #expect(match.count == 3)
        #expect(find(book).unusual.count == 1)
    }

    @Test("a penny apart is not the same payment")
    func amountsMustBeIdentical() {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", amounts: [14_999, 15_000], on: ["2026-08-03", "2026-08-03"])
        #expect(find(book).unusual.isEmpty)
    }

    @Test("the same amount to the same payee from two different accounts is not a duplicate")
    func accountsMustMatch() {
        var book = BookBuilder()
        book.account("a1")
        book.account("a2")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], account: "a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], account: "a2")
        // Paying the same bill from two accounts on one day is a thing people
        // do on purpose, and the app has no way to tell it from a mistake.
        #expect(find(book).unusual.isEmpty)
    }

    @Test("transfer legs are never a duplicate charge")
    func transfersAreNotPayments() {
        var book = BookBuilder()
        book.account("a1")
        book.account("a2")
        book.transfer(50_000, from: "a1", to: "a2", on: ["2026-08-03", "2026-08-03"])
        #expect(find(book).unusual.isEmpty)
        #expect(find(book).routine.isEmpty)
    }

    @Test("two identical refunds on one day are not a duplicate CHARGE")
    func moneyInIsNotACharge() {
        var book = BookBuilder()
        book.account("a1")
        book.receive("Kitchen Supplies", 14_999, on: ["2026-08-03", "2026-08-03"])
        #expect(find(book).unusual.isEmpty)
    }

    // MARK: - Two coffees

    @Test("TWO COFFEES IN A DAY ARE ROUTINE, AND THE DATA IS WHAT SAYS SO")
    func twoCoffees() throws {
        var book = BookBuilder()
        book.account("a1")
        // Five days across the year with two identical coffees on each. There
        // is no price threshold anywhere in this file: what makes these routine
        // is that this payee has done it four other times.
        for day in ["2026-02-11", "2026-04-03", "2026-05-19", "2026-07-08", "2026-08-27"] {
            book.pay("Bramble Coffee", 280, on: [day, day])
        }

        let found = find(book)
        #expect(found.unusual.isEmpty)
        #expect(found.routine.count == 5)
        #expect(found.routine.allSatisfy { $0.otherOccasionsForThisPayee == 4 })
        // Listed, not hidden: the screen shows them under their own heading.
        #expect(found.routine.allSatisfy { $0.routineForThisPayee })
    }

    @Test("a payee that has done it twice before is still unusual")
    func belowTheRoutineThreshold() {
        var book = BookBuilder()
        book.account("a1")
        for day in ["2026-04-03", "2026-07-08"] {
            book.pay("Bramble Coffee", 280, on: [day, day])
        }
        // Two occasions in total: one other for each. Under the threshold of
        // three, so nothing is called normal yet.
        #expect(find(book).unusual.count == 2)
        #expect(find(book).routine.isEmpty)
    }

    // MARK: - Where the rows came from

    @Test("two imports of the same statement look like two imports")
    func differentImportBatches() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], batch: "import-1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], batch: "import-2")

        let match = try #require(find(book).unusual.first)
        #expect(match.differentImportBatches)
        #expect(match.sameImportBatch == false)
        #expect(match.someEnteredByHand == false)
    }

    @Test("one file that contained both is evidence AGAINST a double import")
    func sameImportBatch() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03", "2026-08-03"], batch: "import-1")

        let match = try #require(find(book).unusual.first)
        #expect(match.sameImportBatch)
        #expect(match.differentImportBatches == false)
    }

    @Test("a hand-entered copy of an imported row says so")
    func enteredByHand() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], batch: "import-1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"])  // no batch

        let match = try #require(find(book).unusual.first)
        #expect(match.someEnteredByHand)
        #expect(match.differentImportBatches == false)
    }

    @Test("rows the importer cannot tell apart are flagged as such")
    func sameDedupeKey() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], hash: "a1|2026-08-03|-1499900|k")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], hash: "a1|2026-08-03|-1499900|k")

        let match = try #require(find(book).unusual.first)
        #expect(match.sameDedupeKey)
    }

    @Test("a book with no dedupe keys at all is not a book full of duplicates")
    func emptyDedupeKeysDoNotMatch() throws {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], hash: "")
        book.pay("Kitchen Supplies", 14_999, on: ["2026-08-03"], hash: "")

        let match = try #require(find(book).unusual.first)
        // Two rows that never carried a key are not two rows with the same key.
        #expect(match.sameDedupeKey == false)
    }

    // MARK: - Order

    @Test("the biggest match is at the top, because that is what costs an afternoon")
    func ranking() {
        var book = BookBuilder()
        book.account("a1")
        book.pay("Small Shop", 450, on: ["2026-08-03", "2026-08-03"])
        book.pay("Big Shop", 89_900, on: ["2026-01-11", "2026-01-11"])
        book.pay("Middle Shop", 4_500, on: ["2026-06-06", "2026-06-06"])

        #expect(find(book).unusual.map(\.payeeName) == ["Big Shop", "Middle Shop", "Small Shop"])
    }

    @Test("payments with no payee are counted rather than matched on nothing")
    func noPayee() {
        var book = BookBuilder()
        book.account("a1")
        book.add(payee: nil, amount: -14_999, date: "2026-08-03")
        book.add(payee: nil, amount: -14_999, date: "2026-08-03")
        let found = find(book)
        // Without a payee there is no identity to match on, and matching on
        // amount alone would call every pair of £20 cash withdrawals a
        // duplicate. Counted so the screen can say what it did not look at.
        #expect(found.unusual.isEmpty)
        #expect(found.withoutPayeeSkipped == 2)
    }
}
