// Money as a person HEARS it, beside `Money.format`, which is money as a person
// sees it.
//
// WHY A SEPARATE SPELLING AT ALL. `Money.format` produces "-£45.67". A screen
// reader is left to decide what the leading hyphen is: VoiceOver in en-GB
// usually says "minus", but that is a property of a speech synthesiser and of
// the user's punctuation-verbosity setting, not a property of the app, and a
// negative balance read out as "45 pounds 67" is a wrong number spoken aloud.
// So the word is put in the string, where nothing can decide not to say it.
//
// THE DIGITS STILL COME FROM ONE PLACE. Everything below formats the MAGNITUDE
// through `Money.format` and then writes English around it. There is no second
// NumberFormatter, no second rounding, no second currency table -- if there
// were, an app could show one figure and speak another, which is the worst
// version of this bug rather than a fix for it.
import Foundation

extension Money {
    /// "£45.67" for the magnitude of any amount, sign discarded.
    ///
    /// `.magnitude` is a UInt64 so `Int64.min` has an absolute value here;
    /// `abs(Int64.min)` traps. It cannot arise from a real balance and is
    /// handled anyway, because "cannot arise" is not a guarantee about a file.
    public static func formatMagnitude(
        _ minor: Int64, currency: String, locale: Locale = Locale(identifier: "en_GB")
    ) -> String {
        guard let positive = Int64(exactly: minor.magnitude) else {
            // Int64.min only. Its magnitude has no Int64, so the exact plain
            // form is used rather than a figure one off.
            return "\(currency) \(formatPlain(minor, currency: currency).dropFirst())"
        }
        return format(positive, currency: currency, locale: locale)
    }

    /// What a screen reader should say for an amount: "£45.67", "minus £45.67".
    public static func spoken(
        _ minor: Int64, currency: String, locale: Locale = Locale(identifier: "en_GB")
    ) -> String {
        let magnitude = formatMagnitude(minor, currency: currency, locale: locale)
        return minor < 0 ? "minus \(magnitude)" : magnitude
    }

    /// What a screen reader should say for a REGISTER amount, where the sign is
    /// a direction rather than a quantity: "£45.67 out", "£1,200.00 in".
    ///
    /// Zero is neither, and says so: "£0.00" with no direction, because a
    /// zero-amount row is a correction or a placeholder and calling it money in
    /// would be a claim the row does not make.
    public static func spokenFlow(
        _ minor: Int64, currency: String, locale: Locale = Locale(identifier: "en_GB")
    ) -> String {
        let magnitude = formatMagnitude(minor, currency: currency, locale: locale)
        if minor < 0 { return "\(magnitude) out" }
        if minor > 0 { return "\(magnitude) in" }
        return magnitude
    }
}
