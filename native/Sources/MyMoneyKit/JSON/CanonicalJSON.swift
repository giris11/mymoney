// Canonical serialisation: one book, one set of bytes.
//
// The Swift half of the contract src/backup/canonical.ts defines. Its comment
// is the authority; the rules it fixes are:
//
//   1. OBJECT KEYS ARE SORTED, ascending by UTF-16 CODE UNIT -- JavaScript's
//      `Array.prototype.sort()` with no comparator. Swift's `String <` is not
//      that (it compares by Unicode canonical ordering, which differs for
//      non-ASCII), so the comparison is spelled out in `jsStringLess`. Every
//      key the FORMAT uses is ASCII, where the two agree -- but
//      `settings.savedMappings` is keyed by arbitrary CSV file signatures, and
//      one non-ASCII key would be enough to make two implementations produce
//      different bytes for the same book.
//   2. ARRAY ORDER IS DATA and is left exactly as given. Row order is decided
//      once, by the exporter (sorted by primary key), never here.
//   3. Otherwise the output is byte-for-byte what JSON.stringify emits: the
//      same escaping, the same number formatting (JSNumber.swift), the same
//      indentation rules.
//
// There is no "undefined" in this value type, so JSON.stringify's rule about
// dropping undefined members has nothing to act on -- a parsed file cannot
// contain one, and a Swift-built value cannot express one.
import Foundation

/// Compare two strings the way `Array.prototype.sort()` does: lexicographically
/// by UTF-16 code unit.
func jsStringLess(_ a: String, _ b: String) -> Bool {
    var lhs = a.utf16.makeIterator()
    var rhs = b.utf16.makeIterator()
    while true {
        switch (lhs.next(), rhs.next()) {
        case (nil, nil): return false
        case (nil, _): return true
        case (_, nil): return false
        case (let x?, let y?):
            if x != y { return x < y }
        }
    }
}

public enum CanonicalJSON {
    /// JSON with deterministic key order.
    ///
    /// `indent` matches JSON.stringify's third argument: 0 is the compact form
    /// (and the ONLY form the content hash is ever taken over), 2 is the
    /// pretty form small backups are written in.
    public static func text(_ value: JSONValue, indent: Int = 0) -> String {
        var out = ""
        // A 3 MB export is tens of thousands of rows; growing a String without
        // reserving is a measurable stall on a phone and costs nothing to
        // avoid.
        out.reserveCapacity(1 << 16)
        emit(value, indent: indent, depth: 0, into: &out)
        return out
    }

    private static func emit(_ value: JSONValue, indent: Int, depth: Int, into out: inout String) {
        switch value {
        case .null:
            out += "null"
        case .bool(let b):
            out += b ? "true" : "false"
        case .int(let i):
            out += String(i)
        case .double(let d):
            // Non-finite numbers become `null`, exactly as JSON.stringify does.
            // They cannot occur in a backup (money is integer minor units) and
            // turning one into null rather than throwing keeps this total.
            out += d.isFinite ? JSNumber.string(d) : "null"
        case .string(let s):
            appendQuoted(s, to: &out)
        case .array(let items):
            if items.isEmpty {
                out += "[]"
                return
            }
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                appendPad(indent: indent, depth: depth + 1, to: &out)
                emit(item, indent: indent, depth: depth + 1, into: &out)
            }
            appendPad(indent: indent, depth: depth, to: &out)
            out += "]"
        case .object(let members):
            if members.isEmpty {
                out += "{}"
                return
            }
            out += "{"
            let keys = members.keys.sorted(by: jsStringLess)
            for (i, key) in keys.enumerated() {
                if i > 0 { out += "," }
                appendPad(indent: indent, depth: depth + 1, to: &out)
                appendQuoted(key, to: &out)
                out += indent > 0 ? ": " : ":"
                emit(members[key]!, indent: indent, depth: depth + 1, into: &out)
            }
            appendPad(indent: indent, depth: depth, to: &out)
            out += "}"
        }
    }

    private static func appendPad(indent: Int, depth: Int, to out: inout String) {
        guard indent > 0 else { return }
        out += "\n"
        out += String(repeating: " ", count: indent * depth)
    }

    /// JSON.stringify's QuoteJSONString, to the letter.
    ///
    /// Only the seven short escapes and C0 controls are escaped; every other
    /// character goes out as itself, in UTF-8. Escaping non-ASCII (which some
    /// JSON writers do by default) would produce a different byte stream for
    /// the same data -- and "Cafe Paris" is a payee name whose accent is real.
    ///
    /// Lone surrogates would be escaped as a \u sequence by JavaScript. A Swift
    /// String cannot hold one, and JSONParser refuses a file containing one
    /// rather than substituting U+FFFD, so there is nothing to do here.
    private static func appendQuoted(_ s: String, to out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    // Four lowercase hex digits, matching JS exactly.
                    out += "\\u" + String(format: "%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}
