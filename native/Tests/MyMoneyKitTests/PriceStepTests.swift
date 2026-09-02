// Telling a price rise from a cold month.
//
// EVERY EXPECTATION IN THIS FILE IS HAND-CALCULATED, with the medians written
// out in the comments. The amounts are invented and are in pence.
//
// The suite is arranged as a pair of arguments: the first half proves the
// obvious rises ARE found, and the second half proves the noisy bills are NOT
// reported -- which is the half that decides whether this feature is worth
// having. A price-rise detector that fires on a cold January is a detector that
// gets switched off.
import Testing

@testable import MyMoneyKit

struct PriceStepTests {

    private func points(_ amounts: [Int64], from start: String = "2025-01-05") -> [PriceSteps.Point]
    {
        let dates = Dates.monthly(from: start, count: amounts.count)
        return zip(dates, amounts).map { PriceSteps.Point(date: $0, magnitudeMinor: $1) }
    }

    // MARK: - The median is a payment that happened

    @Test("an even number of payments takes the lower middle, never the average")
    func medianIsAPaymentThatHappened() {
        // [1099, 1199]: the average is 1149, which nobody ever paid. The lower
        // middle is 1099, which somebody did.
        #expect(PriceSteps.median([1099, 1199]) == 1099)
        #expect(PriceSteps.median([1099]) == 1099)
        #expect(PriceSteps.median([300, 100, 200]) == 200)
        // Order does not matter.
        #expect(PriceSteps.median([1199, 1099]) == 1099)
    }

    // MARK: - Rises that are real

    @Test("£8.99 to £10.99, hand-calculated")
    func aPlainRise() {
        let levels = PriceSteps.levels(
            points([899, 899, 899, 899, 899, 1099, 1099, 1099, 1099]), currency: "GBP"
        )
        #expect(levels.count == 2)
        #expect(levels[0].amountMinor == 899)
        #expect(levels[0].count == 5)
        #expect(levels[1].amountMinor == 1099)
        #expect(levels[1].count == 4)
        #expect(levels[1].isProvisional == false)

        let changes = PriceSteps.changes(between: levels, currency: "GBP", idPrefix: "x")
        #expect(changes.count == 1)
        #expect(changes[0].fromMinor == 899)
        #expect(changes[0].toMinor == 1099)
        #expect(changes[0].changeMinor == 200)  // £2.00
        #expect(changes[0].isRise)
        #expect(changes[0].confirmed)
        // 200 / 899 = 0.2224... -- a display figure, never money.
        let fraction = changes[0].fraction ?? 0
        #expect(abs(fraction - 0.22246) < 0.0001)
    }

    @Test("three rises over a decade come back as four levels, hand-calculated")
    func severalRises() {
        let levels = PriceSteps.levels(
            points([599, 599, 599, 799, 799, 799, 999, 999, 999, 1299, 1299, 1299]),
            currency: "GBP"
        )
        #expect(levels.map(\.amountMinor) == [599, 799, 999, 1299])
        #expect(levels.map(\.count) == [3, 3, 3, 3])
        let changes = PriceSteps.changes(between: levels, currency: "GBP", idPrefix: "x")
        #expect(changes.map(\.changeMinor) == [200, 200, 300])
        #expect(changes.allSatisfy { $0.confirmed })
    }

    @Test("a price that went DOWN is a change too")
    func aFall() {
        let levels = PriceSteps.levels(points([1299, 1299, 1299, 999, 999, 999]), currency: "GBP")
        let changes = PriceSteps.changes(between: levels, currency: "GBP", idPrefix: "x")
        #expect(changes.count == 1)
        #expect(changes[0].changeMinor == -300)
        #expect(changes[0].isRise == false)
    }

    @Test("the rise that just happened is reported, and marked unconfirmed")
    func aSingleNewAmountAtTheEnd() {
        let levels = PriceSteps.levels(points([999, 999, 999, 999, 1299]), currency: "GBP")
        #expect(levels.count == 2)
        #expect(levels[1].count == 1)
        #expect(levels[1].isProvisional)

        let changes = PriceSteps.changes(between: levels, currency: "GBP", idPrefix: "x")
        #expect(changes.count == 1)
        #expect(changes[0].changeMinor == 300)
        // ONE payment at the new price. It may be a rise; it may be one odd
        // month. The screen has to say which, so the model does.
        #expect(changes[0].paymentsAtNewLevel == 1)
        #expect(changes[0].confirmed == false)
    }

    // MARK: - Rises that are not there

    @Test("one odd month in the middle is not a price rise")
    func oneOddMonth() {
        // A £45 charge in the middle of a £9.99 subscription -- an extra
        // purchase, a year's renewal, anything. It cannot be a level boundary
        // because the payments after it go back down, so no split leaves every
        // later payment above every earlier one.
        let levels = PriceSteps.levels(points([999, 999, 4500, 999, 999, 999]), currency: "GBP")
        #expect(levels.count == 1)
        #expect(levels[0].amountMinor == 999)
        // ...and the level says out loud that it has a £45 payment in it.
        #expect(levels[0].highMinor == 4500)
        #expect(PriceSteps.changes(between: levels, currency: "GBP", idPrefix: "x").isEmpty)
    }

    @Test("A VARIABLE UTILITY BILL IS NOT A SEQUENCE OF PRICE RISES")
    func aVariableBillIsNotASeriesOfRises() {
        // Invented gas bills through a year: cold months high, summer low.
        // Ranges overlap all the way through, so nothing can pass the
        // separation test. This is the test that decides whether the feature is
        // usable: a detector that fires on every cold month is noise.
        let levels = PriceSteps.levels(
            points([3800, 7100, 4400, 6600, 3900, 7200, 4100, 6900]), currency: "GBP"
        )
        #expect(levels.count == 1)
        #expect(levels[0].lowMinor == 3800)
        #expect(levels[0].highMinor == 7200)
    }

    @Test("...but a tariff rise on the same bill IS found, hand-calculated")
    func aTariffRiseOnAVariableBill() {
        let levels = PriceSteps.levels(
            points([3800, 7100, 4400, 6600, 11250, 11900, 10850]), currency: "GBP"
        )
        #expect(levels.count == 2)
        // Before: [3800, 4400, 6600, 7100] sorted -> lower middle is 4400.
        #expect(levels[0].amountMinor == 4400)
        // After: [10850, 11250, 11900] sorted -> middle is 11250.
        #expect(levels[1].amountMinor == 11250)

        let changes = PriceSteps.changes(between: levels, currency: "GBP", idPrefix: "x")
        #expect(changes.count == 1)
        // 11250 − 4400 = 6850, and the biggest wobble inside either level is
        // 7100 − 3800 = 3300. The jump clears it, which is exactly the test.
        #expect(changes[0].changeMinor == 6850)
    }

    @Test("a rise smaller than the bill's own wobble says nothing")
    func aRiseInsideTheNoise() {
        // The same variable bill, then three payments about £5 higher on
        // average. Every "after" payment is NOT above every "before" one, so
        // there is no step to report -- and that is the right answer even
        // though the average did go up: this app cannot tell that from a
        // slightly colder quarter.
        let levels = PriceSteps.levels(
            points([3800, 7100, 4400, 6600, 4300, 7300, 4900]), currency: "GBP"
        )
        #expect(levels.count == 1)
    }

    @Test("a penny is not news")
    func tinyChangesAreIgnored() {
        // 999 -> 1000. Separated, and bigger than the (zero) wobble, but one
        // penny is under both the 2% floor and the 25p floor.
        let levels = PriceSteps.levels(points([999, 999, 999, 1000, 1000, 1000]), currency: "GBP")
        #expect(levels.count == 1)
    }

    @Test("the absolute floor follows the currency's minor unit")
    func floorsPerCurrency() {
        let rules = PriceStepRules.standard
        #expect(rules.minimumAbsolute(currency: "GBP") == 25)  // 100 / 4
        #expect(rules.minimumAbsolute(currency: "USD") == 25)
        // JPY has no minor unit at all, so a quarter of one would be zero --
        // floored at 1 rather than admitting a change of nothing.
        #expect(rules.minimumAbsolute(currency: "JPY") == 1)
        // BHD has three decimal places: 1000 / 4.
        #expect(rules.minimumAbsolute(currency: "BHD") == 250)
    }

    @Test("two payments cannot show a rise")
    func tooFewToSplit() {
        // One before and one after is not a price change, it is two payments.
        #expect(PriceSteps.levels(points([999, 1299]), currency: "GBP").count == 1)
    }

    @Test("no payments, no levels")
    func empty() {
        #expect(PriceSteps.levels([], currency: "GBP").isEmpty)
        #expect(PriceSteps.changes(between: [], currency: "GBP", idPrefix: "x").isEmpty)
    }
}
