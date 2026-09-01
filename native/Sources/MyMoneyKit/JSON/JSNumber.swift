// Printing a Double exactly the way JavaScript prints it.
//
// WHY THIS FILE EXISTS. The canonical backup form is defined as "byte for byte
// what JSON.stringify would emit, with the keys sorted". For every string,
// every boolean and every integer that is easy. For a fractional number it is
// not, because JSON.stringify defers to ECMAScript's Number::toString, whose
// rules for when to use exponent notation are its own:
//
//     JS                       Swift's Double.description
//     1e-7   -> "1e-7"          -> "1e-07"
//     1e21   -> "1e+21"         -> "1e+21"
//     1e20   -> "100000000000000000000"  -> "1e+20"
//     1.0    -> "1"             -> "1.0"
//
// A backup carries FX rates as fractional numbers (0.007758418188252167 and
// friends), and the file's hash is taken over the canonical text. Get this
// wrong and a Swift-written export of the same book hashes differently from
// the browser's -- which would look exactly like data loss and would be
// impossible to tell apart from it.
//
// THE METHOD. ECMA-262 Number::toString is defined over the SHORTEST decimal
// digit string that round-trips to the same Double, plus a position for the
// decimal point. Swift's `Double.description` computes the same shortest digit
// string (both use a shortest-round-trip algorithm and both break the rare tie
// toward the closest, then even, value); it just formats it differently. So the
// digits are taken from Swift and only the LAYOUT is redone here, per the
// spec's five cases. Reimplementing the digit generation would be a second
// place for the two languages to disagree, and a worse one.

enum JSNumber {
    /// ECMA-262 6.1.6.1.20, Number::toString(x, 10).
    static func string(_ value: Double) -> String {
        // JSON has no NaN or Infinity; JSON.stringify writes `null` for them,
        // and CanonicalJSON does the same before ever reaching here. Handled
        // anyway so this function is total.
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        // Covers -0.0: JS prints it as "0".
        if value == 0 { return "0" }
        if value < 0 { return "-" + string(-value) }

        let (digits, n) = shortestDigits(of: value)
        let k = digits.count

        // The five cases, in the spec's own order.
        if k <= n && n <= 21 {
            return digits + String(repeating: "0", count: n - k)
        }
        if 0 < n && n <= 21 {
            let cut = digits.index(digits.startIndex, offsetBy: n)
            return String(digits[..<cut]) + "." + String(digits[cut...])
        }
        if -6 < n && n <= 0 {
            return "0." + String(repeating: "0", count: -n) + digits
        }
        let exponent = n - 1
        let sign = exponent >= 0 ? "+" : "-"
        let magnitude = String(abs(exponent))
        if k == 1 {
            return digits + "e" + sign + magnitude
        }
        let head = String(digits.prefix(1))
        let tail = String(digits.dropFirst())
        return head + "." + tail + "e" + sign + magnitude
    }

    /// The shortest round-tripping digits `s` and the exponent `n` for which
    /// value == s x 10^(n - s.count), with s carrying no leading or trailing
    /// zero. Exactly the (s, k, n) triple the spec's cases are written in
    /// terms of.
    private static func shortestDigits(of value: Double) -> (digits: String, n: Int) {
        // Swift prints one of "ddd.ddd", "d.ddde+NN" or "d.ddde-NN".
        let text = value.description
        var mantissa = text
        var exponent = 0
        if let eIndex = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = String(text[..<eIndex])
            exponent = Int(text[text.index(after: eIndex)...]) ?? 0
        }

        var whole = mantissa
        var fraction = ""
        if let dot = mantissa.firstIndex(of: ".") {
            whole = String(mantissa[..<dot])
            fraction = String(mantissa[mantissa.index(after: dot)...])
        }

        // value == Int(whole + fraction) x 10^(exponent - fraction.count)
        var digits = Array(whole + fraction)
        var scale = exponent - fraction.count

        var leading = 0
        while leading < digits.count - 1 && digits[leading] == "0" { leading += 1 }
        digits.removeFirst(leading)

        // Removing a trailing zero divides the digit string by ten, so the
        // scale goes up by one to keep the value the same.
        while digits.count > 1 && digits.last == "0" {
            digits.removeLast()
            scale += 1
        }
        if digits == ["0"] { return ("0", 1) }

        return (String(digits), scale + digits.count)
    }
}
