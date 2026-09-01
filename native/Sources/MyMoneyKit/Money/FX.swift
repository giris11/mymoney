// Currency conversion — the display-time-only half of SPEC §6.
//
// THREE RULES, and all three are about what this file REFUSES to do:
//
//  1. Conversion happens at display/report time and nowhere else. Nothing here
//     writes anything. A stored amount is in its account's currency for ever;
//     a balance is never converted, only a TOTAL is.
//  2. A missing rate is an OUTCOME, not a fallback. Not zero, not the
//     unconverted amount, not a cross rate triangulated through the base
//     currency. If EUR→GBP and USD→GBP are known, EUR→USD is still missing:
//     the user entered two rates and would be shown a third they never agreed
//     to, computed from two figures that may be months apart.
//  3. Rounding happens ONCE, at the end of one conversion. Converting three
//     amounts and adding them is not the same as adding them and converting
//     once, and the oracle pins the difference
//     (fx.rounding.per-contribution-differs-from-total): 7 + 7 + 7 US cents at
//     0.79 is 18 pence converted one at a time and 17 converted together.
//     Neither is "more correct"; what matters is that both implementations
//     make the same choice, which is per contribution.
import Foundation

/// One row of the rates table: 1 unit of `base` = `rate` units of `quote` (D11).
public struct FXRateRow: Sendable, Hashable {
    public let base: String
    public let quote: String
    public let rate: Double

    public init(base: String, quote: String, rate: Double) {
        self.base = base
        self.quote = quote
        self.rate = rate
    }
}

/// What a conversion produced. An enum rather than `Int64?` because "no rate"
/// and "does not fit" are different things the caller must say differently,
/// and because an Optional invites `?? 0` — which is the exact mistake
/// SPEC §6 forbids.
public enum ConversionOutcome: Sendable, Hashable {
    case converted(Int64)
    /// No rate joins these two currencies. Show the original currency with a
    /// "no rate" marker; never substitute a number.
    case missingRate
    /// A rate exists, but the answer cannot be stated exactly as an Int64 —
    /// either the input is too large to survive the Double the multiplication
    /// runs in, or the result is outside Int64. Unreachable for any real
    /// balance (it needs figures past £90 trillion) and unreachable for every
    /// oracle case; it exists so that the one code path capable of corrupting
    /// money has somewhere honest to go instead.
    case notRepresentable

    public var minor: Int64? {
        if case .converted(let m) = self { return m }
        return nil
    }
}

/// The rates table, resolved once and then asked many times.
public struct RateTable: Sendable {
    private let direct: [String: Double]

    /// Build from rows. Two behaviours are carried over deliberately and both
    /// are pinned by the oracle:
    ///
    ///  * a row whose rate is not strictly positive is IGNORED rather than
    ///    stored — and, because it is ignored rather than stored, it does not
    ///    displace a good earlier row for the same pair. `fx.missing.
    ///    zero-rate-ignored` and `fx.lookup.last-row-wins` are the two halves
    ///    of that;
    ///  * among positive rows for the same pair, the LAST one wins. The rows
    ///    arrive in the order the store returns them, which is by id, and the
    ///    id is `base:quote` — so duplicates cannot normally exist. This is
    ///    what happens if one ever does, not a feature.
    public init(_ rows: [FXRateRow]) {
        var direct: [String: Double] = [:]
        for row in rows where row.rate > 0 {
            direct["\(row.base):\(row.quote)"] = row.rate
        }
        self.direct = direct
    }

    /// Labelled, not another unlabelled overload: `RateTable([])` would
    /// otherwise be ambiguous, and an empty rates table is exactly the case a
    /// test reaches for most.
    public init(rates: [FxRate]) {
        self.init(rates.map { FXRateRow(base: $0.base, quote: $0.quote, rate: $0.rate) })
    }

    /// A book with no rates at all. Every cross-currency total is then a
    /// missing-rate outcome, which is the correct answer, not a degenerate one.
    public static let empty = RateTable([FXRateRow]())

    /// The rate to multiply a `from` amount by to get `to`, or nil.
    /// A direct row beats the inverse of the opposite row (`fx.lookup.
    /// direct-beats-inverse`): the user typed the direct one.
    public func rate(from: String, to: String) -> Double? {
        if from == to { return 1 }
        if let d = direct["\(from):\(to)"] { return d }
        if let inverse = direct["\(to):\(from)"] { return 1 / inverse }
        return nil
    }

    public var isEmpty: Bool { direct.isEmpty }
}

extension Money {
    /// Convert an amount between currencies, rounding half away from zero
    /// exactly once.
    ///
    /// THE ARITHMETIC IS ORDERED, NOT REARRANGED. It is written
    /// `(minor * rate * factorTo) / factorFrom` because that is the order
    /// src/money/money.ts uses, and floating-point multiplication is not
    /// associative: `(a*b)*c` and `a*(b*c)` differ in the last bit often
    /// enough to move a rounding decision at the .5 boundary. Reordering this
    /// expression to look tidier would be a silent behaviour change, so it is
    /// left exactly as it is.
    ///
    /// The Double is transient by construction: an Int64 goes in, an Int64
    /// comes out, and nothing in between is stored. Its precision is checked
    /// on the way in — an input past 2^53 cannot be turned into a Double
    /// without changing it, and that is `.notRepresentable`, not a guess.
    public static func convert(
        minor: Int64,
        from: String,
        to: String,
        using table: RateTable
    ) -> ConversionOutcome {
        // Identity first, and exactly: no rate is consulted and no Double is
        // created, so a GBP balance converted to GBP is itself down to the
        // penny however large it grows. `x * 1.0` would look equivalent and
        // would quietly stop being so past 2^53.
        if from == to { return .converted(minor) }
        guard let rate = table.rate(from: from, to: to) else { return .missingRate }
        guard let exactInput = Double(exactly: minor) else { return .notRepresentable }

        let scaled = (exactInput * rate * Double(minorFactor(for: to))) / Double(minorFactor(for: from))
        guard let result = roundHalfAwayFromZeroToInt64(scaled) else { return .notRepresentable }
        return .converted(result)
    }
}
