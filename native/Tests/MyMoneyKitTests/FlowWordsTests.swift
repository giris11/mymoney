// One fact, one word, one direction -- across four screens.
//
// WHY THIS SUITE EXISTS. A period whose refunds beat its spending is a single
// condition, and the app used to describe it three ways: a "net refund" chip in
// the by-category and by-tag reports, silence and a blank grey bar in "Income vs
// expense", and a RED figure on the dashboard underneath a sentence saying the
// money came back. The blank bar reads as missing data; the red figure argues
// with the sentence beside it.
//
// The word and the direction now come from `FlowWords`, so the only way the four
// screens can disagree again is for one of them to stop asking. These tests pin
// the words themselves, because the words ARE the fix -- a test that only
// checked "some string is returned" would pass while the app said nothing
// useful.
//
// Every figure below is invented.
import Testing

@testable import MyMoneyKit

struct FlowWordsTests {

    // MARK: - The word

    @Test("a negative spend is labelled, a positive one is not, and zero is not")
    func spendChip() {
        #expect(FlowWords.spendChip(-1) == "net refund")
        #expect(FlowWords.spendChip(-543_808) == "net refund")
        // Zero draws no bar either, but zero spending is not a refund -- a row
        // of exactly nothing is dropped by the reports before it reaches a
        // screen, and calling it a refund here would be a claim about money
        // that did not move.
        #expect(FlowWords.spendChip(0) == nil)
        #expect(FlowWords.spendChip(1) == nil)
        #expect(FlowWords.spendChip(543_808) == nil)
    }

    @Test("negative income gets its own word rather than the refund one")
    func incomeChip() {
        // Not "net refund": nothing was refunded. Money that had arrived was
        // taken back out, which is a different event and gets a different word.
        #expect(FlowWords.incomeChip(-1) == "taken back")
        #expect(FlowWords.incomeChip(0) == nil)
        #expect(FlowWords.incomeChip(250_000) == nil)
    }

    // MARK: - The direction

    @Test("COLOUR FOLLOWS THE MONEY, NOT THE HEADING")
    func movementFollowsTheSign() {
        // The ordinary month: out is outward, in is inward.
        #expect(FlowWords.movement(ofOut: 543_808) == .outward)
        #expect(FlowWords.movement(ofIn: 250_000) == .inward)

        // The month this whole file is about. "Out −£5,438.08" under a sentence
        // saying the money came back: the money moved INWARD, and the figure
        // must not be drawn in the colour of a departure.
        #expect(FlowWords.movement(ofOut: -543_808) == .inward)

        // And the mirror image, which is just as real: more taken back out of
        // income in a month than came into it.
        #expect(FlowWords.movement(ofIn: -250_000) == .outward)
    }

    @Test("zero is not a direction")
    func zeroIsStill() {
        // A month with nothing out of it has not sent money anywhere. Drawing it
        // in the colour of a departure would be emphasis on an event that did
        // not happen.
        #expect(FlowWords.movement(ofOut: 0) == .still)
        #expect(FlowWords.movement(ofIn: 0) == .still)
    }

    // MARK: - The two report rows agree about the condition

    @Test("a month row and the dashboard's month name the same condition the same way")
    func theTwoMonthTypesAgree() {
        // The dashboard's current month and a row of the Income vs expense
        // report carry the same two figures. Until this pass only the first
        // could say what a negative one meant.
        let refundMonth = MonthlyIncomeExpense(
            month: "2026-04", incomeMinor: 250_000, expenseMinor: -543_808
        )
        let dashboardRefundMonth = MonthFlow(
            month: "2026-04", incomeMinor: 250_000, expenseMinor: -543_808,
            netMinor: 250_000 + 543_808, missingRateCount: 0
        )
        #expect(refundMonth.refundsExceededSpending)
        #expect(dashboardRefundMonth.refundsExceededSpending)
        #expect(refundMonth.refundsExceededSpending == dashboardRefundMonth.refundsExceededSpending)
        #expect(!refundMonth.clawbacksExceededIncome)
        #expect(FlowWords.spendChip(refundMonth.expenseMinor) == "net refund")

        let clawbackMonth = MonthlyIncomeExpense(
            month: "2026-05", incomeMinor: -12_000, expenseMinor: 80_000
        )
        #expect(clawbackMonth.clawbacksExceededIncome)
        #expect(!clawbackMonth.refundsExceededSpending)
        #expect(FlowWords.incomeChip(clawbackMonth.incomeMinor) == "taken back")

        let ordinary = MonthlyIncomeExpense(
            month: "2026-06", incomeMinor: 250_000, expenseMinor: 180_000
        )
        #expect(!ordinary.refundsExceededSpending)
        #expect(!ordinary.clawbacksExceededIncome)
        #expect(FlowWords.spendChip(ordinary.expenseMinor) == nil)
        #expect(FlowWords.incomeChip(ordinary.incomeMinor) == nil)
    }
}
