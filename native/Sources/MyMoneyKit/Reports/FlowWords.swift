// The word, and the direction, a signed flow figure needs.
//
// ─────────────────────────────────────────────────────────────────────────────
// FOUR SCREENS PRINT THE SAME FACT AND USED TO PRINT IT THREE DIFFERENT WAYS.
//
// A category whose refunds beat its spending in the period got a "net refund"
// chip beside its blank bar. A tag got the same chip. But a MONTH in "Income vs
// expense" -- the identical condition, the identical blank bar -- got no word at
// all, and a blank grey bar beside a real figure reads as missing data rather
// than as a month where the money came back. Meanwhile the dashboard printed
// "Out −£5,438.08" in RED directly above a sentence saying the money came back:
// the colour and the words contradicted each other, and the reader had to
// decide which of the two the app meant.
//
// So both halves are decided here, once, where a test can pin them, and every
// screen asks rather than deciding for itself.
//
// THE DIRECTION IS THE SUBTLE HALF. "Out" is a heading that names a direction,
// and a NEGATIVE "Out" is money that moved the other way -- inward, whatever the
// heading above it says. Colour follows the money, not the heading. The
// alternative, keeping "Out" red because the column is called Out, is a red
// figure under a sentence saying it came back, and colour that argues with words
// is worse than no colour at all.
//
// COLOUR IS STILL NEVER THE ONLY SIGNAL. Every figure carries its own sign,
// every chip is a word, and every accessibility label says "in" or "out" out
// loud. This decides emphasis; it never carries meaning on its own.
import Foundation

/// The words and directions that a figure whose sign contradicts its heading
/// needs. No formatting and no money here: these are chips and enums, and the
/// figures beside them are rendered by `Money` as everywhere else.
public enum FlowWords {

    /// Which way money actually moved.
    ///
    /// Three cases rather than two, because zero is not a direction: a month
    /// with nothing out of it has not sent money anywhere, and drawing it in the
    /// colour of a departure would be emphasis on an event that did not happen.
    public enum Movement: Sendable, Hashable {
        case inward
        case outward
        case still
    }

    /// The direction of a figure printed under a heading that means money
    /// LEAVING -- "Out", "Spent", an expense total.
    ///
    /// Positive is what the heading says. Negative means more came back than
    /// went, so the money moved inward.
    public static func movement(ofOut minor: Int64) -> Movement {
        if minor > 0 { return .outward }
        if minor < 0 { return .inward }
        return .still
    }

    /// The direction of a figure printed under a heading that means money
    /// ARRIVING -- "In", income.
    ///
    /// The mirror image, and it is a real state: more taken back from income in
    /// a month than came in leaves a negative "In", and colouring that green
    /// because the column is called In would be the same lie in the other
    /// direction.
    public static func movement(ofIn minor: Int64) -> Movement {
        if minor > 0 { return .inward }
        if minor < 0 { return .outward }
        return .still
    }

    /// The word a NEGATIVE SPEND figure needs.
    ///
    /// `spendingByCategory` and its siblings drop zero rows and keep negative
    /// ones, because a category whose refunds beat its spending this period is a
    /// real thing that happened and hiding it would make the rows stop adding up
    /// to the total. But a negative row draws no bar -- there is no length to
    /// draw -- and a row with a figure and an empty bar reads as missing data.
    ///
    /// So it gets a word instead. Seen on a real screen: a month where a food
    /// category showed a large negative figure against a blank bar and nothing
    /// said why.
    public static func spendChip(_ spentMinor: Int64) -> String? {
        spentMinor < 0 ? "net refund" : nil
    }

    /// The same word for the other side: a period in which more was taken back
    /// out of income than came into it.
    ///
    /// Rarer than a net refund and just as real -- a reversed salary run, a
    /// mis-signed import, a clawback -- and it draws the identical blank bar, so
    /// it needs the identical treatment. "Taken back" rather than "net
    /// clawback": it is the same event described in words somebody would use.
    public static func incomeChip(_ incomeMinor: Int64) -> String? {
        incomeMinor < 0 ? "taken back" : nil
    }
}
