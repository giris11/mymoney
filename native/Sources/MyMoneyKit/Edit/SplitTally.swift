// The remainder, computed as the owner types.
//
// WHY THIS IS A TYPE AND NOT A LINE OF ARITHMETIC IN A VIEW. The rule is that
// splits sum EXACTLY to the parent (SPEC 6), and the store enforces it -- but a
// rule enforced only at Save is a rule the owner meets as a rejection after
// they have finished. The way an unbalanced split becomes impossible to save by
// accident is that the remainder is on screen the whole time, updating on every
// keystroke, and the split's last line can be filled with it in one tap.
//
// So the arithmetic lives here, where a test can drive it with a hundred
// combinations in a millisecond, and the view binds to it. Two consequences
// that are the point rather than a side effect:
//
//   * the live figure and the saved check are THE SAME CALCULATION. A view that
//     computed its own preview would eventually round, clamp or short-circuit
//     somewhere the store does not, and the owner would see "balanced" and be
//     told "not balanced".
//   * it is total. There is no input -- no empty list, no line of Int64.max --
//     for which this throws or traps; a half-typed split is the normal state of
//     the screen, not an error.
import Foundation

/// Where a split stands right now.
public struct SplitTally: Sendable, Hashable {
    /// What the transaction is for. The figure the lines have to reach.
    public let amountMinor: Int64
    public let currency: String
    public let lineCount: Int
    /// The lines added up. nil ONLY when adding them overflows Int64, which no
    /// real book reaches and a fuzzed text field can.
    public let splitTotalMinor: Int64?
    /// What is still unallocated: `amount - total`. nil for the same reason.
    /// Positive means the lines are short of the transaction; negative means
    /// they have gone past it.
    public let remainderMinor: Int64?
    public let status: Status

    public enum Status: Sendable, Hashable {
        /// No lines at all. A perfectly valid transaction -- it just is not
        /// split.
        case notSplit
        /// One line, and it balances.
        ///
        /// SAVABLE, and deliberately so. A one-line split is very nearly always
        /// a half-finished one, and the message below says so -- but the web
        /// app permits it (`validateSplits` in src/domain/transactions.ts checks
        /// only the sum), so books already contain them. Refusing it here would
        /// mean an owner who opened such a row on the phone to fix a typo could
        /// not save the fix, and "the app will not let me keep my own data" is
        /// a worse failure than a redundant split line.
        case oneLine
        case balanced
        /// The lines have not reached the transaction's amount yet.
        /// The payload is the SIGNED remainder -- what a further line would
        /// have to say to finish the split.
        case short(Int64)
        /// The lines have gone past the transaction's amount. The payload is
        /// again the signed remainder, so adding it would bring them back.
        case over(Int64)
        /// The lines do not fit in Int64. Not money; a typo.
        case unrepresentable
    }

    public var isBalanced: Bool { status == .balanced }

    /// May this be SAVED? Everything except lines that do not add up.
    public var isSavable: Bool {
        switch status {
        case .notSplit, .balanced, .oneLine: return true
        case .short, .over, .unrepresentable: return false
        }
    }

    /// What a new line should be pre-filled with, so that finishing a split is
    /// one tap rather than a subtraction the owner does in their head.
    /// nil when there is nothing left to allocate.
    ///
    /// AND NIL FOR THE FIRST LINE, WHICH IS NOT AN OVERSIGHT. With no lines yet
    /// the remainder is the whole transaction, and pre-filling line one with the
    /// full amount taxed the common case to help a case that does not exist:
    /// nobody splits £50 into a single £50 line. Every two-line split began by
    /// clearing a field the app had just filled in, and the second line then
    /// pre-filled with £0.00 because the first had already claimed everything.
    ///
    /// So the pre-fill starts on the SECOND line. Type what one part cost, and
    /// the next line arrives holding exactly what is left -- which is the tap
    /// this property was written for, now landing where the arithmetic is
    /// actually hard. `remainderMinor` still reports the whole amount for a
    /// split of nothing, because that is what is unallocated; this is a
    /// statement about what to type into a box, not about the money.
    public var suggestedNextLineMinor: Int64? {
        guard status != .notSplit else { return nil }
        guard let remainder = remainderMinor, remainder != 0 else { return nil }
        return remainder
    }

    /// The sentence beside the lines. Present at every moment, including when
    /// everything is fine -- "£0.00 left" said quietly is what makes the figure
    /// trustworthy when it is not zero.
    public var message: String? {
        switch status {
        case .notSplit:
            return nil
        case .oneLine:
            return "Balanced, but a split of one line is just the transaction \u{2014} add "
                + "another line, or remove the split."
        case .balanced:
            return "Balanced \u{2014} nothing left to allocate."
        case .short(let remainder):
            return "\(Money.format(abs(remainder), currency: currency)) left to allocate."
        case .over(let remainder):
            return "\(Money.format(abs(remainder), currency: currency)) too much allocated."
        case .unrepresentable:
            return "These figures are too large to be money."
        }
    }

    /// The tally for a set of lines against a parent amount.
    public static func of(
        amountMinor: Int64, splits: [Split], currency: String
    ) -> SplitTally {
        guard !splits.isEmpty else {
            return SplitTally(
                amountMinor: amountMinor, currency: currency, lineCount: 0,
                splitTotalMinor: 0, remainderMinor: amountMinor, status: .notSplit
            )
        }
        var total: Int64 = 0
        for split in splits {
            let (sum, overflowed) = total.addingReportingOverflow(split.amountMinor)
            if overflowed {
                return SplitTally(
                    amountMinor: amountMinor, currency: currency, lineCount: splits.count,
                    splitTotalMinor: nil, remainderMinor: nil, status: .unrepresentable
                )
            }
            total = sum
        }
        let (remainder, remainderOverflowed) = amountMinor.subtractingReportingOverflow(total)
        if remainderOverflowed {
            return SplitTally(
                amountMinor: amountMinor, currency: currency, lineCount: splits.count,
                splitTotalMinor: total, remainderMinor: nil, status: .unrepresentable
            )
        }
        let status: Status
        if remainder != 0 {
            // SHORT AND OVER ARE ABOUT MAGNITUDE, NOT SIGN, and getting that
            // backwards is the easy mistake: nearly every split in a real book
            // is an EXPENSE, so the parent is negative and so is the remainder.
            // Lines totalling -14.99 against a -25.00 expense have -10.01 still
            // to allocate -- they are SHORT, even though the number is
            // negative. So the test is whether what is left points the same way
            // as the transaction does; when it points the other way, the lines
            // have overshot. A parent of zero is overshot by anything at all.
            let sameDirection = amountMinor != 0 && (remainder > 0) == (amountMinor > 0)
            status = sameDirection ? .short(remainder) : .over(remainder)
        } else if splits.count == 1 {
            // Order matters: a single line that happens to balance is still a
            // single line, but a single line that does NOT balance is more
            // usefully described by its remainder.
            status = .oneLine
        } else {
            status = .balanced
        }
        return SplitTally(
            amountMinor: amountMinor, currency: currency, lineCount: splits.count,
            splitTotalMinor: total, remainderMinor: remainder, status: status
        )
    }

    /// The refusal this tally implies, or nil when it may be saved. The store
    /// asks exactly this, so the screen and the save cannot disagree.
    public var refusal: EditError? {
        switch status {
        case .notSplit, .balanced, .oneLine:
            return nil
        case .short, .over:
            return .splitsDoNotBalance(
                splitTotalMinor: splitTotalMinor ?? 0, amountMinor: amountMinor,
                currency: currency
            )
        case .unrepresentable:
            return .splitsUnrepresentable
        }
    }
}
