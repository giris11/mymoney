// The remainder, which is what makes an unbalanced split impossible to save by
// accident.
//
// Pure arithmetic over integers, so these cases are the cheap half of the split
// rule and they are the half that runs on every keystroke. The expensive half
// -- that the store refuses what this type calls unsavable -- is asserted in
// EditTransactionTests against a real database, using THIS type, so the two can
// never drift into disagreeing.
import Testing

@testable import MyMoneyKit

struct SplitTallyTests {

    private func split(_ amount: Int64, _ category: String? = "c-food") -> Split {
        Split(categoryId: category, amountMinor: amount)
    }

    @Test("no splits is not a split, and is perfectly savable")
    func noSplits() {
        let tally = SplitTally.of(amountMinor: -2500, splits: [], currency: "GBP")
        #expect(tally.status == .notSplit)
        #expect(tally.isSavable)
        #expect(tally.refusal == nil)
        #expect(tally.message == nil)
        // The whole amount IS unallocated, and the tally still says so.
        #expect(tally.remainderMinor == -2500)
        // ...but it is NOT what the first line should be pre-filled with. See
        // `firstLineIsNotPreFilled` below.
        #expect(tally.suggestedNextLineMinor == nil)
    }

    @Test("THE FIRST LINE IS NOT PRE-FILLED; THE SECOND ONE IS")
    func firstLineIsNotPreFilled() {
        // A £25.00 expense about to be split in two.
        //
        // Pre-filling line one with the whole £25.00 helped a case that does not
        // exist -- nobody splits £25 into a single £25 line -- and taxed the one
        // that does: every two-line split started by clearing a field the app
        // had just filled in, and line two then offered £0.00 because line one
        // had already claimed everything.
        let nothingYet = SplitTally.of(amountMinor: -2500, splits: [], currency: "GBP")
        #expect(nothingYet.suggestedNextLineMinor == nil)

        // Type the part you know...
        let oneLine = SplitTally.of(amountMinor: -2500, splits: [split(-1200)], currency: "GBP")
        // ...and the next line arrives holding exactly what is left, which is
        // the subtraction worth doing for somebody.
        #expect(oneLine.suggestedNextLineMinor == -1300)

        let finished = SplitTally.of(
            amountMinor: -2500, splits: [split(-1200), split(-1300)], currency: "GBP"
        )
        #expect(finished.isBalanced)
        #expect(finished.suggestedNextLineMinor == nil)
    }

    @Test("an income split pre-fills the right way round too")
    func positiveParentPreFill() {
        // The signs are the easy thing to get backwards, and a pre-fill that
        // arrived negative inside a positive transaction would be a split that
        // could never balance.
        let oneLine = SplitTally.of(amountMinor: 9_000, splits: [split(2_500)], currency: "GBP")
        #expect(oneLine.status == .short(6_500))
        #expect(oneLine.suggestedNextLineMinor == 6_500)
    }

    @Test("THE REMAINDER IS EXACT, and it is what the next line should say")
    func remainderIsExact() {
        let tally = SplitTally.of(
            amountMinor: -2500, splits: [split(-1000), split(-499)], currency: "GBP"
        )
        #expect(tally.splitTotalMinor == -1499)
        #expect(tally.remainderMinor == -1001)
        #expect(tally.status == .short(-1001))
        #expect(!tally.isSavable)
        // Filling the next line with exactly this finishes the split, which is
        // the whole point of publishing it.
        #expect(tally.suggestedNextLineMinor == -1001)
        let finished = SplitTally.of(
            amountMinor: -2500, splits: [split(-1000), split(-499), split(-1001)],
            currency: "GBP"
        )
        #expect(finished.isBalanced)
        #expect(finished.suggestedNextLineMinor == nil)
    }

    @Test("a penny out is out -- there is no tolerance, in either direction")
    func aPennyIsAPenny() {
        let short = SplitTally.of(
            amountMinor: -2500, splits: [split(-1200), split(-1299)], currency: "GBP"
        )
        let over = SplitTally.of(
            amountMinor: -2500, splits: [split(-1200), split(-1301)], currency: "GBP"
        )
        #expect(short.status == .short(-1))
        #expect(over.status == .over(1))
        #expect(!short.isSavable)
        #expect(!over.isSavable)
        // And the refusal says which way and by how much, in money.
        #expect(short.refusal?.problem.contains("\u{00A3}0.01") == true)
        #expect(over.refusal?.problem.contains("\u{00A3}0.01") == true)
    }

    @Test("the message names the amount left, in the transaction's currency")
    func messageIsMoney() {
        let gbp = SplitTally.of(amountMinor: -2500, splits: [split(-1000)], currency: "GBP")
        #expect(gbp.message == "\u{00A3}15.00 left to allocate.")
        let eur = SplitTally.of(amountMinor: -2500, splits: [split(-1000)], currency: "EUR")
        #expect(eur.message?.contains("\u{20AC}15.00") == true)
        // A currency with no minor units is not given two decimal places by a
        // formatter that assumed them.
        let jpy = SplitTally.of(amountMinor: -250, splits: [split(-100)], currency: "JPY")
        #expect(jpy.message == "JP\u{00A5}150 left to allocate.")
    }

    @Test("a balanced split of ONE line saves, because books already contain them")
    func oneLineBalances() {
        // The web app permits it (`validateSplits` checks only the sum), so a
        // row imported from a real backup can be one. Refusing it here would
        // mean an owner could not save a typo fix on their own data.
        let tally = SplitTally.of(amountMinor: -2500, splits: [split(-2500)], currency: "GBP")
        #expect(tally.status == .oneLine)
        #expect(tally.isSavable)
        #expect(tally.refusal == nil)
        #expect(tally.message?.contains("add") == true)
    }

    @Test("income splits work the same way -- the sign is not special-cased")
    func positiveAmounts() {
        let tally = SplitTally.of(
            amountMinor: 10_000, splits: [split(6000), split(4000)], currency: "GBP"
        )
        #expect(tally.isBalanced)
        #expect(tally.remainderMinor == 0)
    }

    @Test("a mixed-sign split still has to reach the total exactly")
    func mixedSigns() {
        // A refund line inside an expense: -60 spent, +10 back, so the parent
        // is -50. Arithmetic, not a special case.
        let tally = SplitTally.of(
            amountMinor: -5000, splits: [split(-6000), split(1000)], currency: "GBP"
        )
        #expect(tally.isBalanced)
    }

    @Test("figures too large to add up are refused, not wrapped around")
    func overflowIsNotMoney() {
        let tally = SplitTally.of(
            amountMinor: 0,
            splits: [split(Int64.max), split(Int64.max)],
            currency: "GBP"
        )
        #expect(tally.status == .unrepresentable)
        #expect(tally.splitTotalMinor == nil)
        #expect(tally.remainderMinor == nil)
        #expect(!tally.isSavable)
        #expect(tally.refusal == .splitsUnrepresentable)
    }

    @Test("every refusal says what was wrong AND that nothing was saved")
    func refusalsSayNothingWasSaved() {
        let cases: [SplitTally] = [
            .of(amountMinor: -2500, splits: [Split(categoryId: nil, amountMinor: -1)], currency: "GBP"),
            .of(amountMinor: 0, splits: [split(Int64.max), split(Int64.max)], currency: "GBP"),
        ]
        for tally in cases {
            let refusal = try? #require(tally.refusal)
            #expect(refusal?.unchanged.contains("Nothing was saved") == true)
            #expect(refusal?.description.hasPrefix(refusal?.problem ?? "") == true)
        }
    }
}
