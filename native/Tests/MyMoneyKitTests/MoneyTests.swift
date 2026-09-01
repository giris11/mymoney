// Money maths, beyond what the oracle pins.
//
// The oracle cases are the contract shared with the TypeScript. These are the
// cases that only exist BECAUSE this is Swift: the Int64 range the web build
// cannot reach, the rounding spellings Swift makes it easy to get wrong, and
// the overflow behaviour a language with fixed-width integers has to decide.
import Foundation
import Testing

@testable import MyMoneyKit

struct MoneyTests {

    // MARK: - Rounding, and the two ways to get it wrong

    @Test("half away from zero is not banker's rounding and is not Int(x + 0.5)")
    func roundingIsNotTheEasyMistakes() {
        // The oracle already pins the answers. What this pins is that the two
        // idioms a Swift developer reaches for FIRST both disagree with them,
        // so nobody can "simplify" Money.roundHalfAwayFromZero into either.
        #expect(Money.roundHalfAwayFromZero(-2.5) == -3)
        #expect((-2.5).rounded(.toNearestOrEven) == -2)   // banker's: wrong here
        #expect(Double(Int(-2.5 + 0.5)) == -2)            // the classic: wrong here
        #expect(Money.roundHalfAwayFromZero(2.5) == 3)
        #expect((2.5).rounded(.toNearestOrEven) == 2)     // banker's: wrong here
    }

    @Test("a value a hair under a half rounds down, in both signs")
    func justUnderHalf() {
        // 0.49999999999999994 + 0.5 == 1.0 in IEEE 754, so `floor(x + 0.5)`
        // returns 1 for a number that is unambiguously below a half. This is
        // the single most famous rounding bug there is, and the oracle carries
        // it as a case; asserted again here next to the reason.
        #expect(Money.roundHalfAwayFromZero(0.49999999999999994) == 0)
        #expect(Money.roundHalfAwayFromZero(-0.49999999999999994) == 0)
        #expect((0.49999999999999994 + 0.5).rounded(.down) == 1) // the trap itself
    }

    @Test("rounding refuses rather than saturating when no Int64 exists")
    func roundingRefusesOutOfRange() {
        #expect(Money.roundHalfAwayFromZeroToInt64(1e30) == nil)
        #expect(Money.roundHalfAwayFromZeroToInt64(-1e30) == nil)
        #expect(Money.roundHalfAwayFromZeroToInt64(.nan) == nil)
        #expect(Money.roundHalfAwayFromZeroToInt64(.infinity) == nil)
        // The boundary itself is representable and must come back exactly.
        #expect(Money.roundHalfAwayFromZeroToInt64(Double(Int64.max) - 1024) != nil)
    }

    // MARK: - Int64, past where a JS number stops being exact

    @Test("amounts beyond 2^53 survive formatting and summing exactly")
    func exactBeyondTheDoubleRange() throws {
        // 2^53 + 1 is the smallest positive integer a Double cannot hold. A JS
        // number would render this as ...992; the whole reason the port exists
        // is that Int64 renders it as itself.
        let beyond: Int64 = 9_007_199_254_740_993
        #expect(Money.formatPlain(beyond, currency: "GBP") == "90071992547409.93")
        // The corruption this avoids, demonstrated: routed through a Double --
        // which is all a JavaScript number is -- the value comes back as its
        // neighbour, with no error and no warning.
        #expect(Int64(Double(beyond)) == 9_007_199_254_740_992)
        #expect(Double(exactly: beyond) == nil)
        #expect(try Money.sum([beyond, 1]) == 9_007_199_254_740_994)
        #expect(Money.formatPlain(Int64.max, currency: "GBP") == "92233720368547758.07")
        // Int64.min has no positive counterpart, so `abs()` would trap on it.
        #expect(Money.formatPlain(Int64.min, currency: "GBP") == "-92233720368547758.08")
    }

    @Test("parse accepts what Int64 can hold, beyond the JavaScript safe integer")
    func parseAcceptsBeyondTheJavaScriptSafeInteger() {
        // THE ONE DELIBERATE DIVERGENCE from src/money/money.ts, made visible.
        // The TypeScript refuses anything above Number.MAX_SAFE_INTEGER
        // (9007199254740991 minor units); this refuses only what Int64 cannot
        // hold. A file written here containing such an amount is flagged by
        // BackupImporter.warnings rather than silently handed to a browser that
        // would corrupt it.
        #expect(Money.parseToMinor("90071992547409.93", currency: "GBP") == 9_007_199_254_740_993)
        #expect(Money.parseToMinor("92233720368547758.07", currency: "GBP") == Int64.max)
        // One penny past Int64.max is refused, not wrapped.
        #expect(Money.parseToMinor("92233720368547758.08", currency: "GBP") == nil)
        // The oracle's own huge case still refuses, in both languages.
        #expect(Money.parseToMinor("99999999999999999999", currency: "GBP") == nil)
    }

    // MARK: - Parsing details the oracle does not reach

    @Test("parse strips the currency symbols and codes the UI actually produces")
    func parseStripsDecoration() {
        #expect(Money.parseToMinor("$1,000.00", currency: "USD") == 100_000)
        #expect(Money.parseToMinor("€12,34", currency: "EUR", decimal: .comma) == 1234)
        #expect(Money.parseToMinor("  12.34  ", currency: "GBP") == 1234)
        // A non-breaking space is what a copy-paste from a bank statement
        // carries; JS `\s` includes U+00A0 and so must this.
        #expect(Money.parseToMinor("1\u{00A0}234.56", currency: "GBP") == 123_456)
        #expect(Money.parseToMinor("(\u{00A3}45.67)", currency: "GBP") == -4567)
        // A minus INSIDE brackets is still one negative, not two.
        #expect(Money.parseToMinor("(-45.67)", currency: "GBP") == -4567)
    }

    @Test("parse refuses precision the currency does not have, rather than rounding")
    func parseRefusesExcessPrecision() {
        // Silently dropping the digit would put a number in the ledger that the
        // owner did not type. Refusal makes them decide.
        #expect(Money.parseToMinor("1.239", currency: "GBP") == nil)
        #expect(Money.parseToMinor("1.2", currency: "JPY") == nil)
        #expect(Money.parseToMinor("1.2345", currency: "BHD") == nil)
        // And it accepts exactly as many as the currency has.
        #expect(Money.parseToMinor("1.234", currency: "BHD") == 1234)
        #expect(Money.parseToMinor("1", currency: "JPY") == 1)
    }

    @Test("parse refuses text that is not a number")
    func parseRefusesRubbish() {
        for input in ["abc", "1.2.3", "--5", "1e5", "5 - 3", "\u{00A3}", "()", "+-1"] {
            #expect(Money.parseToMinor(input, currency: "GBP") == nil, "\(input) should be refused")
        }
    }

    @Test("group separators are removed wherever they fall, however many there are")
    func groupSeparatorsAreJustRemoved() {
        // Recorded because it surprises people, and because BOTH
        // implementations do it: every group separator is deleted before the
        // number is read, so their placement carries no meaning at all.
        // "1,,2.00" is twelve pounds here and twelve pounds in the browser, and
        // a port that "tightened this up" would start refusing input the web
        // app accepts.
        #expect(Money.parseToMinor("1,,2.00", currency: "GBP") == 1200)
        #expect(Money.parseToMinor("1,2,3,4.56", currency: "GBP") == 123_456)
        #expect(Money.parseToMinor(",1234.56", currency: "GBP") == 123_456)
    }

    @Test("the group separator and the decimal separator swap together")
    func decimalStyles() {
        #expect(Money.parseToMinor("1.234,56", currency: "EUR", decimal: .comma) == 123_456)
        #expect(Money.parseToMinor("1,234.56", currency: "EUR", decimal: .dot) == 123_456)
        // Reading a decimal-comma string with the dot style must NOT quietly
        // produce a thousand-times-wrong number: "1.234,56" read as dot-decimal
        // has two separators and is refused.
        #expect(Money.parseToMinor("1.234,56", currency: "EUR", decimal: .dot) == nil)
    }

    // MARK: - Currency precision

    @Test("currency decimals: default 2, the zero-decimal set, the three-decimal set")
    func currencyDecimals() {
        #expect(Money.decimals(for: "GBP") == 2)
        #expect(Money.decimals(for: "gbp") == 2)     // case-insensitive
        #expect(Money.decimals(for: "ZZZ") == 2)     // unknown defaults to 2
        for zero in ["JPY", "KRW", "ISK", "VND", "XAF", "CLP"] {
            #expect(Money.decimals(for: zero) == 0, "\(zero)")
            #expect(Money.minorFactor(for: zero) == 1, "\(zero)")
        }
        for three in ["BHD", "KWD", "OMR", "TND", "JOD", "IQD", "LYD"] {
            #expect(Money.decimals(for: three) == 3, "\(three)")
            #expect(Money.minorFactor(for: three) == 1000, "\(three)")
        }
    }

    @Test("plain formatting is exact string arithmetic in every currency shape")
    func plainFormatting() {
        #expect(Money.formatPlain(0, currency: "GBP") == "0.00")
        #expect(Money.formatPlain(1, currency: "GBP") == "0.01")
        #expect(Money.formatPlain(-1, currency: "GBP") == "-0.01")
        #expect(Money.formatPlain(0, currency: "JPY") == "0")
        #expect(Money.formatPlain(-5, currency: "JPY") == "-5")
        #expect(Money.formatPlain(5, currency: "BHD") == "0.005")
        #expect(Money.formatPlain(-1, currency: "BHD") == "-0.001")
        // No grouping separators, ever: this is the exact form, not the pretty
        // one, and a comma here would be a character somebody would try to
        // parse back.
        #expect(Money.formatPlain(123_456_789, currency: "GBP") == "1234567.89")
    }

    @Test("locale formatting states the right number even for an unknown code")
    func localeFormattingFallsBackWithoutLying() {
        let text = Money.format(1234, currency: "ZZZ")
        // Whatever glyphs the platform chooses, the digits must be the money.
        #expect(text.contains("12.34"))
        #expect(Money.format(-4567, currency: "GBP").contains("45.67"))
    }

    // MARK: - Summing and splits

    @Test("summing refuses to wrap")
    func sumRefusesToWrap() {
        #expect(throws: MoneyError.self) {
            _ = try Money.sum([Int64.max, 1])
        }
        #expect(throws: MoneyError.self) {
            _ = try Money.sum([Int64.min, -1])
        }
        // `&+` would have returned Int64.min here -- a large positive balance
        // silently becoming a large negative one, with no error anywhere.
        #expect(Int64.max &+ 1 == Int64.min)
    }

    @Test("splits must sum EXACTLY to the parent, with no tolerance")
    func splitsMustSumExactly() throws {
        let parent = Transaction(
            id: "t1", accountId: "a1", date: "2026-08-12", amountMinor: -10000, currency: "GBP",
            splits: [
                Split(categoryId: "groceries", amountMinor: -6000),
                Split(categoryId: "transport", amountMinor: -4000),
            ]
        )
        #expect(try parent.validateSplits())

        let offByAPenny = Transaction(
            id: "t2", accountId: "a1", date: "2026-08-12", amountMinor: -10000, currency: "GBP",
            splits: [
                Split(categoryId: "groceries", amountMinor: -6000),
                Split(categoryId: "transport", amountMinor: -3999),
            ]
        )
        #expect(try offByAPenny.validateSplits() == false)

        // No splits at all is valid -- the rule is about splits that exist.
        let unsplit = Transaction(
            id: "t3", accountId: "a1", date: "2026-08-12", amountMinor: -10000, currency: "GBP"
        )
        #expect(try unsplit.validateSplits())

        // A split set that sums to the parent while containing a sign flip is
        // still valid: a refund line inside a purchase is a real thing.
        let withRefund = Transaction(
            id: "t4", accountId: "a1", date: "2026-08-12", amountMinor: -9000, currency: "GBP",
            splits: [
                Split(categoryId: "groceries", amountMinor: -6000),
                Split(categoryId: "transport", amountMinor: -4000),
                Split(categoryId: "groceries", amountMinor: 1000),
            ]
        )
        #expect(try withRefund.validateSplits())
    }
}
