// When a recurring amount STEPPED, and how to tell a step from a wobble.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TEST A STEP HAS TO PASS, in one sentence:
//
//     EVERY payment after the change is on one side of EVERY payment before
//     it, AND the jump is bigger than the biggest wobble either level shows on
//     its own, AND it is bigger than 2% and than a quarter of a major unit.
//
// The first clause is what makes a variable bill safe. A gas bill that runs
// £38, £71, £44, £66 has a wobble of £33; nothing inside it can pass the
// separation test, because no split leaves every later payment above every
// earlier one. The same bill after a tariff rise -- £38, £71, £44, £66, then
// £112, £119, £108 -- passes cleanly: the two ranges do not touch, and the £52
// jump is larger than the £33 wobble.
//
// The rejected alternative was a percentage threshold ("flag any change over
// 10%"). On the same gas bill that fires on £38 → £71 and says the price went
// up 87%, which is not what happened and would send somebody to argue with
// their energy supplier about a cold month.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEDIAN IS A PAYMENT THAT ACTUALLY HAPPENED. For an even number of
// payments this takes the LOWER of the two middle ones rather than averaging
// them. An average would put a figure on the screen that the owner never paid
// -- £10.99 and £11.99 becoming "£11.49 a month" -- and every figure this app
// prints has to be one it can point at.
//
// A LEVEL IS NOT AN AVERAGE EITHER. It carries its own low and high, so a
// variable bill is shown as the range it is instead of as a single number with
// a hidden spread.
import Foundation

/// One stretch of a recurring payment at one price.
public struct PriceLevel: Sendable, Hashable {
    /// The typical payment at this level: the median, which is a payment that
    /// really happened. MAGNITUDE (money out is positive here).
    public let amountMinor: Int64
    public let lowMinor: Int64
    public let highMinor: Int64
    public let fromDate: String
    public let toDate: String
    public let count: Int

    /// True when this level is one payment that has not yet repeated -- a
    /// change that may be a rise, or may be one odd month.
    public var isProvisional: Bool { count == 1 }

    /// How much this level moves around, as a fraction of its typical payment.
    /// A CLASSIFICATION, never money: nothing is computed from it except which
    /// of three words to print.
    public var spread: Double {
        guard amountMinor > 0 else { return 0 }
        return Double(highMinor - lowMinor) / Double(amountMinor)
    }
}

/// A step from one level to the next.
public struct PriceChange: Sendable, Hashable, Identifiable {
    public let id: String
    /// The last payment at the old price.
    public let previousDate: String
    /// The first payment at the new price -- the date the change was SEEN, not
    /// the date it was decided. Worth saying that way round on the screen.
    public let onDate: String
    public let fromMinor: Int64
    public let toMinor: Int64
    /// to − from. Positive is a rise.
    public let changeMinor: Int64
    public let currency: String
    /// How many payments have been made at the new price. ONE is not a
    /// confirmed rise, and this is what says so.
    public let paymentsAtNewLevel: Int

    public var isRise: Bool { changeMinor > 0 }
    /// Two payments at the new price, so it is a price and not an odd month.
    public var confirmed: Bool { paymentsAtNewLevel >= 2 }

    /// The change as a fraction of the old price, for a "+18%" label. nil when
    /// the old price was zero, which no real recurring payment is but a
    /// fixture can be. Display only.
    public var fraction: Double? {
        guard fromMinor != 0 else { return nil }
        return Double(changeMinor) / Double(abs(fromMinor))
    }
}

/// The thresholds, in one place, every one of them named.
public struct PriceStepRules: Sendable, Hashable {
    /// Payments needed on the EARLIER side of a split. Two, always: one payment
    /// is not a price.
    public var minimumBefore: Int = 2
    /// The smallest relative jump worth reporting. Below this the owner cannot
    /// act on it and the screen is just noise.
    public var minimumFraction: Double = 0.02
    /// The smallest absolute jump worth reporting, as a fraction of one major
    /// unit: a quarter of a pound, a quarter of a dollar. In a currency with no
    /// minor unit (JPY) this floors at 1.
    public var minimumMajorUnitQuarters: Int = 1

    public static let standard = PriceStepRules()

    /// The absolute floor in this currency's minor units.
    public func minimumAbsolute(currency: String) -> Int64 {
        let quarter = Money.minorFactor(for: currency) / 4
        return max(1, quarter * Int64(minimumMajorUnitQuarters))
    }
}

public enum PriceSteps {
    /// One payment, as this file needs it: a date and a magnitude.
    public struct Point: Sendable, Hashable {
        public let date: String
        /// Money out as a POSITIVE number. A "rise" then means what the word
        /// means; on the signed amounts a rise would be a fall.
        public let magnitudeMinor: Int64

        public init(date: String, magnitudeMinor: Int64) {
            self.date = date
            self.magnitudeMinor = magnitudeMinor
        }
    }

    /// The median: the LOWER middle value, so the answer is always a payment
    /// that happened. Empty is 0, which no caller passes.
    public static func median(_ values: [Int64]) -> Int64 {
        if values.isEmpty { return 0 }
        let sorted = values.sorted()
        return sorted[(sorted.count - 1) / 2]
    }

    /// Split a series' payments into levels, newest last.
    ///
    /// BINARY SEGMENTATION: find the single best split that passes the test in
    /// the file header, then look inside each half for another. A decade of a
    /// subscription that rose three times comes back as four levels, in order,
    /// each with its own dates.
    ///
    /// The one asymmetry is at the END. A split whose later side holds a SINGLE
    /// payment is allowed only when that payment is the most recent one in the
    /// series -- because "the price went up last month" is the most useful
    /// thing this app can say, and waiting for a second payment to say it would
    /// mean saying it a month late. It comes back as a level of one, which
    /// `isProvisional` and `PriceChange.confirmed` both refuse to hide.
    public static func levels(
        _ points: [Point], currency: String, rules: PriceStepRules = .standard
    ) -> [PriceLevel] {
        guard !points.isEmpty else { return [] }
        let ranges = segment(
            points, lower: 0, upper: points.count, trailing: true,
            currency: currency, rules: rules
        )
        return ranges.map { range in
            let slice = Array(points[range])
            let amounts = slice.map(\.magnitudeMinor)
            return PriceLevel(
                amountMinor: median(amounts),
                lowMinor: amounts.min() ?? 0,
                highMinor: amounts.max() ?? 0,
                fromDate: slice.first!.date,
                toDate: slice.last!.date,
                count: slice.count
            )
        }
    }

    /// The changes between consecutive levels. `id` is built by the caller's
    /// prefix so a change can be addressed from a list.
    public static func changes(
        between levels: [PriceLevel], currency: String, idPrefix: String
    ) -> [PriceChange] {
        guard levels.count >= 2 else { return [] }
        var out: [PriceChange] = []
        for index in 1..<levels.count {
            let before = levels[index - 1]
            let after = levels[index]
            out.append(
                PriceChange(
                    id: "\(idPrefix)|\(after.fromDate)",
                    previousDate: before.toDate,
                    onDate: after.fromDate,
                    fromMinor: before.amountMinor,
                    toMinor: after.amountMinor,
                    changeMinor: after.amountMinor - before.amountMinor,
                    currency: currency,
                    paymentsAtNewLevel: after.count
                )
            )
        }
        return out
    }

    // MARK: - The segmentation itself

    private static func segment(
        _ points: [Point], lower: Int, upper: Int, trailing: Bool,
        currency: String, rules: PriceStepRules
    ) -> [Range<Int>] {
        let count = upper - lower
        // The smallest splittable window: two before, and one after only when
        // this window runs to the end of the series.
        let minimumAfter = trailing ? 1 : rules.minimumBefore
        guard count >= rules.minimumBefore + minimumAfter else { return [lower..<upper] }

        var bestSplit: Int? = nil
        var bestJump: Int64 = 0
        for split in (lower + rules.minimumBefore)...(upper - minimumAfter) {
            let before = points[lower..<split].map(\.magnitudeMinor)
            let after = points[split..<upper].map(\.magnitudeMinor)
            // A single later payment is only ever allowed as the very last
            // payment of the whole series. Anywhere else it is one odd month.
            if after.count < rules.minimumBefore && !(trailing && split == upper - 1) { continue }
            guard let jump = jumpIfGenuine(before, after, currency: currency, rules: rules) else {
                continue
            }
            if jump > bestJump {
                bestJump = jump
                bestSplit = split
            }
        }

        guard let split = bestSplit else { return [lower..<upper] }
        return segment(
            points, lower: lower, upper: split, trailing: false, currency: currency, rules: rules
        )
            + segment(
                points, lower: split, upper: upper, trailing: trailing, currency: currency,
                rules: rules
            )
    }

    /// The size of the jump when this split is a genuine step, nil when it is
    /// not. Every clause is the file header's sentence, in order.
    private static func jumpIfGenuine(
        _ before: [Int64], _ after: [Int64], currency: String, rules: PriceStepRules
    ) -> Int64? {
        guard let beforeLow = before.min(), let beforeHigh = before.max(),
            let afterLow = after.min(), let afterHigh = after.max()
        else { return nil }

        // 1. Every payment after is on one side of every payment before.
        let rose = afterLow > beforeHigh
        let fell = afterHigh < beforeLow
        guard rose || fell else { return nil }

        let beforeMedian = median(before)
        let afterMedian = median(after)
        let jump = abs(afterMedian - beforeMedian)

        // 2. Bigger than the biggest wobble either level shows on its own.
        let wobble = max(beforeHigh - beforeLow, afterHigh - afterLow)
        guard jump > wobble else { return nil }

        // 3. Big enough to be worth a sentence on a screen.
        guard jump >= rules.minimumAbsolute(currency: currency) else { return nil }
        guard beforeMedian > 0 else { return nil }
        guard Double(jump) / Double(beforeMedian) >= rules.minimumFraction else { return nil }

        return jump
    }
}
