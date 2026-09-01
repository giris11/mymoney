// Conversion, beyond the oracle's twenty-five cases.
//
// Every rule here is a rule about what conversion REFUSES to do. That is not
// squeamishness: the failure this package exists to prevent is a number that
// looks like an answer and is not one, and conversion is where such a number
// would be born.
import Testing

@testable import MyMoneyKit

struct FXTests {

    static let rates = RateTable([
        FXRateRow(base: "EUR", quote: "GBP", rate: 0.85),
        FXRateRow(base: "USD", quote: "GBP", rate: 0.79),
        FXRateRow(base: "GBP", quote: "JPY", rate: 190.5),
    ])

    @Test("a missing rate is never triangulated through a currency that does happen to join them")
    func noTriangulation() {
        // EUR->GBP and USD->GBP are both known, so a cross rate is arithmetically
        // available. It is still refused: the owner entered two rates, possibly
        // months apart, and would be shown a third they never agreed to.
        #expect(Money.convert(minor: 20000, from: "EUR", to: "USD", using: Self.rates) == .missingRate)
        #expect(Money.convert(minor: 20000, from: "USD", to: "EUR", using: Self.rates) == .missingRate)
        #expect(Money.convert(minor: 1000, from: "CHF", to: "GBP", using: Self.rates) == .missingRate)
    }

    @Test("a non-positive rate is ignored, and does not displace a good one")
    func nonPositiveRatesAreIgnored() {
        // A zero rate is not "convert to nothing"; it is not a rate. And
        // because such rows are skipped rather than stored, a later bad row
        // cannot overwrite an earlier good one.
        #expect(
            Money.convert(minor: 1000, from: "AAA", to: "GBP",
                          using: RateTable([FXRateRow(base: "AAA", quote: "GBP", rate: 0)]))
                == .missingRate
        )
        #expect(
            Money.convert(minor: 1000, from: "AAA", to: "GBP",
                          using: RateTable([FXRateRow(base: "AAA", quote: "GBP", rate: -2)]))
                == .missingRate
        )
        #expect(
            Money.convert(minor: 1000, from: "AAA", to: "GBP",
                          using: RateTable([FXRateRow(base: "AAA", quote: "GBP", rate: .nan)]))
                == .missingRate
        )
        let goodThenBad = RateTable([
            FXRateRow(base: "AAA", quote: "GBP", rate: 0.5),
            FXRateRow(base: "AAA", quote: "GBP", rate: 0),
        ])
        #expect(Money.convert(minor: 1000, from: "AAA", to: "GBP", using: goodThenBad) == .converted(500))
    }

    @Test("identity is exact at any magnitude, because it consults no rate at all")
    func identityIsExact() {
        // The short-circuit is not an optimisation. Routing a large balance
        // through `x * 1.0` would push it through a Double, and past 2^53 that
        // is where the money would quietly change.
        let huge: Int64 = 9_007_199_254_740_993
        #expect(Money.convert(minor: huge, from: "GBP", to: "GBP", using: .empty) == .converted(huge))
        #expect(Money.convert(minor: Int64.max, from: "ZZZ", to: "ZZZ", using: .empty) == .converted(Int64.max))
        #expect(Money.convert(minor: Int64.min, from: "GBP", to: "GBP", using: Self.rates) == .converted(Int64.min))
    }

    @Test("an amount too large to survive the Double is refused, not silently rounded")
    func inputBeyondDoublePrecisionIsRefused() {
        // There IS a rate; the problem is the amount. Returning a
        // slightly-wrong converted figure would be the exact failure this
        // package exists to prevent, so the outcome says so instead.
        let beyond: Int64 = 9_007_199_254_740_993
        #expect(Money.convert(minor: beyond, from: "EUR", to: "GBP", using: Self.rates) == .notRepresentable)
        // One below the boundary is fine and is converted normally.
        let atBoundary: Int64 = 9_007_199_254_740_992
        #expect(Money.convert(minor: atBoundary, from: "EUR", to: "GBP", using: Self.rates).minor != nil)
    }

    @Test("a result too large for Int64 is refused, not saturated")
    func resultBeyondInt64IsRefused() {
        let absurd = RateTable([FXRateRow(base: "AAA", quote: "GBP", rate: 1e18)])
        #expect(Money.convert(minor: 1_000_000, from: "AAA", to: "GBP", using: absurd) == .notRepresentable)
    }

    @Test("case matters: currency codes are compared exactly")
    func codesAreCaseSensitive() {
        // `decimalsFor` upper-cases (a currency's precision is a property of
        // the currency), but a LOOKUP is an exact key match, in both
        // implementations. A port that started upper-casing here would resolve
        // rates the browser does not.
        #expect(Money.convert(minor: 100, from: "eur", to: "GBP", using: Self.rates) == .missingRate)
        #expect(Money.convert(minor: 100, from: "EUR", to: "gbp", using: Self.rates) == .missingRate)
        // ...and same-currency identity is an exact match too, so "eur"->"eur"
        // still works and needs no rate.
        #expect(Money.convert(minor: 100, from: "eur", to: "eur", using: .empty) == .converted(100))
    }

    @Test("rounding happens once per conversion, on the whole amount")
    func roundingOncePerConversion() {
        // Converting a balance is one rounding. Converting each of its
        // transactions and adding them is many, and drifts. The manifest and
        // the live figure both convert the BALANCE, which is why they agree.
        let amounts: [Int64] = [7, 7, 7]
        let each = amounts.map { Money.convert(minor: $0, from: "USD", to: "GBP", using: Self.rates).minor! }
        #expect(each == [6, 6, 6])          // 5.53p rounds up, three times
        #expect(each.reduce(0, +) == 18)
        let together = Money.convert(minor: 21, from: "USD", to: "GBP", using: Self.rates)
        #expect(together == .converted(17))  // 16.59p rounds up, once
        // The two differ by a penny, and that is not a bug -- it is why the
        // rule has to be written down and pinned rather than left to taste.
    }

    @Test("the minor-unit factors of BOTH currencies are applied")
    func differentMinorUnits() {
        // GBP 10.00 at 190.5 is JPY 1905 -- 1905 minor units, because yen has
        // none. Getting this wrong by a factor of 100 is the classic
        // multi-currency bug and it is silent.
        #expect(Money.convert(minor: 1000, from: "GBP", to: "JPY", using: Self.rates) == .converted(1905))
        #expect(Money.convert(minor: 1905, from: "JPY", to: "GBP", using: Self.rates) == .converted(1000))
        let bhd = RateTable([FXRateRow(base: "GBP", quote: "BHD", rate: 2)])
        #expect(Money.convert(minor: 100, from: "GBP", to: "BHD", using: bhd) == .converted(2000))
    }

    @Test("zero converts to zero without consulting anything")
    func zeroIsZero() {
        #expect(Money.convert(minor: 0, from: "EUR", to: "GBP", using: Self.rates) == .converted(0))
        // But zero in a currency with NO rate is still a missing rate, not
        // zero: the honest answer is "this cannot be included", and an account
        // that happens to be empty today will not be tomorrow.
        #expect(Money.convert(minor: 0, from: "CHF", to: "GBP", using: Self.rates) == .missingRate)
    }
}
