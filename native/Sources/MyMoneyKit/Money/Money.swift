// Money maths. The Swift statement of SPEC §6, held to the same fixtures as
// the TypeScript in ../../../../src/money/money.ts:
//
//  * every amount is an INTEGER in the currency's minor units (pence, cents);
//  * no float arithmetic on stored amounts — a Double appears ONLY transiently
//    inside a currency conversion (see FX.swift), and is rounded back to an
//    integer exactly once;
//  * rounding policy: HALF AWAY FROM ZERO (0.5 → 1, -0.5 → -1), applied once.
//
// WHY Int64 AND NOT THE TYPESCRIPT'S `number`. A JS number is a Double, so the
// web build cannot hold an exact integer past 2^53 − 1 (9,007,199,254,740,991
// minor units — about £90 trillion). That ceiling is a property of the language
// it was written in, not of the money, and it is not inherited here: CloudKit
// was verified to round-trip Int64 exactly, so the only remaining place a
// number could be silently corrupted would be this file, and it will not be.
// The one visible consequence is recorded in `parseToMinor` below.
//
// WHY NOT `Decimal`. Foundation's Decimal is base-10 and would make many of
// these operations exact, which sounds like an upgrade until you notice it
// makes "how many minor units is this?" a question with more than one answer.
// The whole system — the database column, the backup file, the CloudKit
// record, the oracle fixtures — is integer minor units. A second numeric type
// standing beside it is a conversion boundary, and conversion boundaries are
// where money goes missing. Decimal is used in exactly one place (locale
// formatting, at the very end of `format`) and never for arithmetic.
import Foundation

/// A refusal, never a wrong number.
public enum MoneyError: Error, Equatable, Sendable {
    /// An exact integer answer exists but does not fit in Int64. Surfaced so a
    /// caller can say so; never wrapped, never saturated.
    case overflow(String)
    /// A figure cannot be stated exactly as an Int64 -- because converting it
    /// would have to go through a Double that cannot hold it, or because the
    /// result is outside Int64. Unreachable below roughly 90 trillion pounds.
    /// It exists so that the only code path capable of producing a quietly
    /// wrong number has somewhere honest to go instead.
    case notRepresentable(String)
}

extension MoneyError: CustomStringConvertible {
    public var description: String {
        switch self {
        case .overflow(let what): return "\(what) overflowed Int64"
        case .notRepresentable(let what): return "\(what) cannot be stated exactly"
        }
    }
}

/// Which character separates the whole part from the fraction in typed input.
/// `dot` is the en-GB UI default; `comma` is what a European CSV carries.
public enum DecimalSeparator: Sendable, Hashable {
    case dot
    case comma
}

public enum Money {
    // MARK: - Currency precision

    /// Currencies whose minor unit is not 10^-2. Everything else defaults to 2.
    /// Deliberately the same table as src/money/money.ts, entry for entry: a
    /// port that quietly knew about a different set of currencies would give a
    /// different answer for the same file.
    static let currencyDecimals: [String: Int] = [
        "BIF": 0, "CLP": 0, "DJF": 0, "GNF": 0, "ISK": 0, "JPY": 0, "KMF": 0, "KRW": 0,
        "PYG": 0, "RWF": 0, "UGX": 0, "VND": 0, "VUV": 0, "XAF": 0, "XOF": 0, "XPF": 0,
        "BHD": 3, "IQD": 3, "JOD": 3, "KWD": 3, "LYD": 3, "OMR": 3, "TND": 3,
    ]

    /// How many decimal places this currency's minor unit represents.
    ///
    /// `uppercased()` with no locale argument, matching JS `toUpperCase()`:
    /// the Turkish locale maps "i" to "İ", and a currency table that depended
    /// on where the phone was bought would be a spectacular bug.
    public static func decimals(for currency: String) -> Int {
        currencyDecimals[currency.uppercased()] ?? 2
    }

    /// Minor units per major unit: 1 (JPY), 100 (GBP), 1000 (BHD).
    public static func minorFactor(for currency: String) -> Int64 {
        switch decimals(for: currency) {
        case 0: return 1
        case 3: return 1000
        default: return 100
        }
    }

    // MARK: - Rounding

    /// Round half away from zero: 2.5→3, -2.5→-3, 2.4→2, -2.4→-2.
    ///
    /// `.toNearestOrAwayFromZero` is the whole implementation, and the reason
    /// this function exists at all is to make the two WRONG spellings
    /// unwritable elsewhere:
    ///   * `x.rounded()` in Swift is already this — but `Int(x + 0.5)` is the
    ///     idiom people reach for, and it turns -2.5 into -2;
    ///   * `.toNearestOrEven` (banker's rounding) is the default in several
    ///     other money libraries and gives 2.5 → 2. SPEC §6 says away from
    ///     zero, and the oracle pins it.
    /// It returns a Double, exactly as the TypeScript returns a `number`, so
    /// that "did it round?" and "does it fit in Int64?" stay separate
    /// questions with separate answers.
    public static func roundHalfAwayFromZero(_ x: Double) -> Double {
        x.rounded(.toNearestOrAwayFromZero)
    }

    /// The rounded value as an exact Int64, or nil when no such Int64 exists.
    ///
    /// nil rather than a clamp or a trap: the caller is in a position to say
    /// "this figure cannot be represented", and a saturated Int64.max in a
    /// ledger is a wrong number wearing a plausible face.
    public static func roundHalfAwayFromZeroToInt64(_ x: Double) -> Int64? {
        guard x.isFinite else { return nil }
        return Int64(exactly: roundHalfAwayFromZero(x))
    }

    // MARK: - Parsing

    /// JS `\s` (String.prototype.trim and the `\s` character class strip
    /// exactly this set). Spelled out rather than using Swift's
    /// `.whitespacesAndNewlines`, which is a different set — it excludes
    /// U+FEFF and U+200B differs — and "the two implementations disagree about
    /// which spaces count" is precisely the kind of divergence this port is
    /// meant to make impossible.
    ///
    /// Internal rather than private because the import layer trims and splits
    /// on exactly this set too (`Import.parseDateString`, the CSV empty-line
    /// test). ONE definition, deliberately: two copies of "which characters are
    /// whitespace" is precisely the drift this comment is about.
    static let jsWhitespace: Set<Character> = [
        "\u{0009}", "\u{000A}", "\u{000B}", "\u{000C}", "\u{000D}", "\u{0020}",
        "\u{00A0}", "\u{1680}",
        "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}", "\u{2004}", "\u{2005}",
        "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}", "\u{200A}",
        "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
    ]

    /// Currency symbols stripped from typed input, matching the TypeScript's
    /// `[£$€¥₹]`. Not "any Unicode currency symbol": widening the set here
    /// would make an input the web app rejects into one the phone accepts.
    private static let strippedSymbols: Set<Character> = ["£", "$", "€", "¥", "₹"]

    private static func isASCIILetter(_ c: Character) -> Bool {
        ("a"..."z").contains(c) || ("A"..."Z").contains(c)
    }

    /// String.prototype.trim, not Foundation's `.trimmingCharacters(in:
    /// .whitespacesAndNewlines)` -- the two sets differ, and "the two
    /// implementations disagree about which spaces count" is the kind of
    /// divergence this port exists to make impossible.
    static func trimmingJSWhitespace(_ input: String) -> String {
        var start = input.startIndex
        var end = input.endIndex
        while start < end, jsWhitespace.contains(input[start]) {
            start = input.index(after: start)
        }
        while end > start, jsWhitespace.contains(input[input.index(before: end)]) {
            end = input.index(before: end)
        }
        return String(input[start..<end])
    }

    /// Parse a user-typed decimal amount ("12", "12.34", "1,234.56", "(45.67)",
    /// "£99.99", "5.00 GBP") into minor units, without float arithmetic.
    /// Returns nil for anything unparseable — never a best guess.
    ///
    /// A refusal is a feature. "1.2345" in GBP is nil rather than 123 (or 124):
    /// the user typed a number this currency cannot hold, and silently
    /// discarding the digits they typed is how a ledger acquires a figure
    /// nobody entered.
    ///
    /// THE ONE DELIBERATE DIVERGENCE FROM THE TYPESCRIPT, and it is in this
    /// function. src/money/money.ts refuses any result above
    /// Number.MAX_SAFE_INTEGER (2^53 − 1) because past that a JS number stops
    /// being an exact integer. Int64 has no such point, so the ceiling here is
    /// Int64.max instead. Inputs between the two are accepted here and refused
    /// there — see MoneyTests.parseAcceptsBeyondTheJavaScriptSafeInteger, which
    /// exists to make the difference visible rather than lurking. Nothing in
    /// the oracle sits in that window (the largest case is twenty nines, which
    /// overflows both), and no real amount comes near £90 trillion, but a port
    /// that widened a limit without saying so is exactly what this comment is
    /// for. Note the direction of the risk: a file written HERE with an amount
    /// in that window could not be read back by the web build without
    /// corruption, so `BackupValidation` names such amounts explicitly.
    public static func parseToMinor(
        _ input: String,
        currency: String,
        decimal: DecimalSeparator = .dot
    ) -> Int64? {
        var s = trimmingJSWhitespace(input)
        if s.isEmpty { return nil }

        var negative = false
        // JS `/^\(.*\)$/` — `.` does not match a line terminator, and `$`
        // without the `m` flag anchors to the very end, so a bracketed value
        // containing a newline is NOT treated as negative there and must not
        // be here either.
        if s.count >= 2, s.hasPrefix("("), s.hasSuffix(")"),
           !s.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\u{2028}" || $0 == "\u{2029}" }) {
            negative = true
            s = String(s.dropFirst().dropLast())
        }

        s.removeAll { strippedSymbols.contains($0) || jsWhitespace.contains($0) }

        // Trailing ISO code, THEN leading — the same order as the TypeScript,
        // and the order matters: "GBP" alone loses its last three letters to
        // the first rule and reaches the digit check as an empty-ish string
        // either way, but a four-letter input like "abcd" becomes "a" here and
        // "" if the rules were swapped. Both refuse; only one refuses for the
        // same reason in both languages.
        if s.count >= 3, s.suffix(3).allSatisfy(isASCIILetter) {
            s = String(s.dropLast(3))
        }
        if s.count >= 3, s.prefix(3).allSatisfy(isASCIILetter) {
            s = String(s.dropFirst(3))
        }

        if s.hasPrefix("-") {
            negative = true
            s = String(s.dropFirst())
        } else if s.hasPrefix("+") {
            s = String(s.dropFirst())
        }

        let decSep: Character = decimal == .dot ? "." : ","
        let groupSep: Character = decimal == .dot ? "," : "."
        s.removeAll { $0 == groupSep }
        if s.isEmpty { return nil }

        let parts = s.split(separator: decSep, omittingEmptySubsequences: false)
        if parts.count > 2 { return nil }
        let intPart = String(parts[0])
        let fracRaw = parts.count > 1 ? String(parts[1]) : ""

        guard intPart.allSatisfy({ $0.isASCII && $0.isNumber }),
              fracRaw.allSatisfy({ $0.isASCII && $0.isNumber })
        else { return nil }
        if intPart.isEmpty && fracRaw.isEmpty { return nil }

        let places = decimals(for: currency)
        // More precision than the currency has: refuse rather than round. The
        // user's number would change, and this function is not allowed to
        // change the user's number.
        if fracRaw.count > places { return nil }
        let frac = fracRaw + String(repeating: "0", count: places - fracRaw.count)

        // intPart * 10^places + frac is exactly the concatenation, because
        // `frac` is now exactly `places` digits wide. Built as a string and
        // parsed once so there is no intermediate multiply to overflow.
        let digits = (intPart.isEmpty ? "0" : intPart) + frac
        guard let magnitude = Int64(digits) else { return nil } // > Int64.max
        return negative ? -magnitude : magnitude
    }

    // MARK: - Formatting

    /// Exact plain string: "1234.56", "-0.01", "5" (JPY), "0.005" (BHD).
    ///
    /// String arithmetic on the digits, never `Double(minor) / factor`: the
    /// division is where a large balance would stop being itself, and this is
    /// the formatter every exactness test is written against. `format` below
    /// is the pretty one; this is the true one.
    public static func formatPlain(_ minor: Int64, currency: String) -> String {
        let places = decimals(for: currency)
        let negative = minor < 0
        // `.magnitude` is a UInt64, so Int64.min has an absolute value here.
        // `abs(Int64.min)` would trap.
        var digits = String(minor.magnitude)
        if digits.count < places + 1 {
            digits = String(repeating: "0", count: places + 1 - digits.count) + digits
        }
        let cut = digits.index(digits.endIndex, offsetBy: -places)
        let whole = String(digits[digits.startIndex..<cut])
        let frac = places > 0 ? "." + String(digits[cut...]) : ""
        return (negative ? "-" : "") + whole + frac
    }

    /// Display string in the user's terms: "£1,234.56", "-£45.67".
    ///
    /// ADVISORY, and the oracle marks it so: the glyphs belong to the platform
    /// (Foundation renders JPY as ICU tells it to, which is not always what a
    /// browser's Intl does). The NUMBER is the contract, and `formatPlain` is
    /// the one to hold an implementation to.
    ///
    /// The value handed to the formatter is a Decimal, not a Double: an exact
    /// base-10 quotient of two integers, so the formatter is never asked to
    /// render something that has already lost a penny. This is the only place
    /// in the package where a non-integer number type touches money, and it is
    /// downstream of every decision.
    public static func format(
        _ minor: Int64,
        currency: String,
        locale: Locale = Locale(identifier: "en_GB")
    ) -> String {
        let places = decimals(for: currency)
        let value = Decimal(minor) / Decimal(minorFactor(for: currency))
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.locale = locale
        formatter.currencyCode = currency
        formatter.minimumFractionDigits = places
        formatter.maximumFractionDigits = places
        guard let text = formatter.string(from: NSDecimalNumber(decimal: value)) else {
            // Unknown/invalid ISO code — never show a wrong number, fall back
            // to the exact plain form with the code spelled out.
            return "\(currency) \(formatPlain(minor, currency: currency))"
        }
        return text
    }

    // MARK: - Summing

    /// Σ, refusing rather than wrapping.
    ///
    /// `&+` was rejected outright. Two-complement wraparound turns a total of
    /// £92 quadrillion into a negative balance with no error anywhere, which
    /// is the single worst failure mode this package could have.
    public static func sum(_ values: [Int64], startingAt start: Int64 = 0) throws -> Int64 {
        var total = start
        for v in values {
            let (next, overflowed) = total.addingReportingOverflow(v)
            if overflowed { throw MoneyError.overflow("summing minor-unit amounts") }
            total = next
        }
        return total
    }

    /// Sum splits. A transaction that has splits is valid iff this equals its
    /// own amount — enforced by `Transaction.validateSplits()`.
    public static func sumSplits(_ splits: [Split]) throws -> Int64 {
        try sum(splits.map(\.amountMinor))
    }
}
