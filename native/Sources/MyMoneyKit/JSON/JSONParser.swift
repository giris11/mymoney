// A strict RFC 8259 parser, working on UTF-8 bytes.
//
// Strict on purpose: a backup file is the owner's entire financial history,
// and a parser that is generous about what it accepts is a parser that will
// one day accept a corrupt file and hand back plausible rows. No comments, no
// trailing commas, no NaN, no leading zeros, no single quotes. Anything the
// browser could not have written is refused with a byte offset.
import Foundation

public struct JSONParseError: Error, Equatable, Sendable, CustomStringConvertible {
    public let message: String
    /// Byte offset into the UTF-8 input, so a 3 MB file's problem can be found.
    public let offset: Int

    public var description: String { "\(message) (at byte \(offset))" }
}

public enum JSONParser {
    /// Depth beyond which nesting is refused.
    ///
    /// A backup is three levels deep (file → tables → rows) plus splits, so
    /// 128 is roughly forty times more than the format can legitimately use.
    /// The limit is here because this parser recurses: a hand-crafted file of
    /// 100,000 open brackets would otherwise overflow the stack, and a crash
    /// while reading a file is indistinguishable to the user from losing it.
    public static let maxDepth = 128

    public static func parse(_ text: String) throws -> JSONValue {
        try parse(Array(text.utf8))
    }

    public static func parse(_ data: Data) throws -> JSONValue {
        try parse([UInt8](data))
    }

    public static func parse(_ bytes: [UInt8]) throws -> JSONValue {
        var scanner = Scanner(bytes: bytes)
        scanner.skipWhitespace()
        let value = try scanner.parseValue(depth: 0)
        scanner.skipWhitespace()
        guard scanner.isAtEnd else {
            throw JSONParseError(message: "Unexpected trailing content", offset: scanner.index)
        }
        return value
    }

    private struct Scanner {
        let bytes: [UInt8]
        var index = 0

        init(bytes: [UInt8]) { self.bytes = bytes }

        var isAtEnd: Bool { index >= bytes.count }

        func fail(_ message: String) -> JSONParseError {
            JSONParseError(message: message, offset: index)
        }

        mutating func skipWhitespace() {
            // RFC 8259 whitespace only: space, tab, LF, CR. Not JS `\s` —
            // this is the wire format, not user input.
            while index < bytes.count {
                switch bytes[index] {
                case 0x20, 0x09, 0x0A, 0x0D: index += 1
                default: return
                }
            }
        }

        mutating func parseValue(depth: Int) throws -> JSONValue {
            guard depth <= JSONParser.maxDepth else {
                throw fail("Nested too deeply (limit \(JSONParser.maxDepth))")
            }
            guard index < bytes.count else { throw fail("Unexpected end of input") }
            switch bytes[index] {
            case UInt8(ascii: "{"): return try parseObject(depth: depth)
            case UInt8(ascii: "["): return try parseArray(depth: depth)
            case UInt8(ascii: "\""): return .string(try parseString())
            case UInt8(ascii: "t"):
                try expect("true")
                return .bool(true)
            case UInt8(ascii: "f"):
                try expect("false")
                return .bool(false)
            case UInt8(ascii: "n"):
                try expect("null")
                return .null
            default: return try parseNumber()
            }
        }

        mutating func expect(_ literal: String) throws {
            let want = Array(literal.utf8)
            guard index + want.count <= bytes.count,
                  Array(bytes[index..<(index + want.count)]) == want
            else { throw fail("Expected \(literal)") }
            index += want.count
        }

        mutating func parseObject(depth: Int) throws -> JSONValue {
            index += 1 // {
            var result: [String: JSONValue] = [:]
            skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(result)
            }
            while true {
                skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else {
                    throw fail("Expected a quoted object key")
                }
                let key = try parseString()
                skipWhitespace()
                guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else {
                    throw fail("Expected ':' after object key")
                }
                index += 1
                skipWhitespace()
                let value = try parseValue(depth: depth + 1)
                // A duplicate key is corruption, not a preference. JS keeps
                // the last one silently; here it is refused, because the two
                // implementations would otherwise disagree about which of two
                // balances the file states.
                if result.updateValue(value, forKey: key) != nil {
                    throw fail("Duplicate object key \"\(key)\"")
                }
                skipWhitespace()
                guard index < bytes.count else { throw fail("Unexpected end of input in object") }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "}") {
                    index += 1
                    return .object(result)
                }
                throw fail("Expected ',' or '}' in object")
            }
        }

        mutating func parseArray(depth: Int) throws -> JSONValue {
            index += 1 // [
            var result: [JSONValue] = []
            skipWhitespace()
            if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(result)
            }
            while true {
                skipWhitespace()
                result.append(try parseValue(depth: depth + 1))
                skipWhitespace()
                guard index < bytes.count else { throw fail("Unexpected end of input in array") }
                if bytes[index] == UInt8(ascii: ",") {
                    index += 1
                    continue
                }
                if bytes[index] == UInt8(ascii: "]") {
                    index += 1
                    return .array(result)
                }
                throw fail("Expected ',' or ']' in array")
            }
        }

        mutating func parseString() throws -> String {
            index += 1 // opening quote
            var scalars = String.UnicodeScalarView()
            while true {
                guard index < bytes.count else { throw fail("Unterminated string") }
                let byte = bytes[index]
                if byte == UInt8(ascii: "\"") {
                    index += 1
                    return String(scalars)
                }
                if byte == UInt8(ascii: "\\") {
                    index += 1
                    guard index < bytes.count else { throw fail("Unterminated escape") }
                    let esc = bytes[index]
                    index += 1
                    switch esc {
                    case UInt8(ascii: "\""): scalars.append("\"")
                    case UInt8(ascii: "\\"): scalars.append("\\")
                    case UInt8(ascii: "/"): scalars.append("/")
                    case UInt8(ascii: "b"): scalars.append("\u{08}")
                    case UInt8(ascii: "f"): scalars.append("\u{0C}")
                    case UInt8(ascii: "n"): scalars.append("\n")
                    case UInt8(ascii: "r"): scalars.append("\r")
                    case UInt8(ascii: "t"): scalars.append("\t")
                    case UInt8(ascii: "u"):
                        scalars.append(try parseUnicodeEscape())
                    default: throw fail("Invalid escape \\\(Character(UnicodeScalar(esc)))")
                    }
                    continue
                }
                if byte < 0x20 { throw fail("Unescaped control character in string") }
                // Multi-byte UTF-8 is copied through untouched: decoding and
                // re-encoding it would be a second chance to change the bytes
                // the hash is taken over.
                let length = utf8SequenceLength(byte)
                guard length > 0, index + length <= bytes.count else {
                    throw fail("Malformed UTF-8 in string")
                }
                guard let scalar = decodeUTF8(Array(bytes[index..<(index + length)])) else {
                    throw fail("Malformed UTF-8 in string")
                }
                scalars.append(scalar)
                index += length
            }
        }

        /// \uXXXX, including surrogate pairs.
        ///
        /// A LONE SURROGATE IS REFUSED. JavaScript strings can hold one, and
        /// JSON.stringify escapes it back out again (the well-formed-stringify
        /// rule), so a browser could in principle write one. Swift's String
        /// cannot hold it at all — the nearest thing is U+FFFD, which would
        /// silently change the bytes and therefore the canonical hash. Failing
        /// loudly on a file that cannot be represented is the only honest
        /// option; substituting a replacement character would make the hash
        /// comparison lie.
        mutating func parseUnicodeEscape() throws -> UnicodeScalar {
            let first = try parseHex4()
            if first >= 0xD800 && first <= 0xDBFF {
                guard index + 1 < bytes.count,
                      bytes[index] == UInt8(ascii: "\\"),
                      bytes[index + 1] == UInt8(ascii: "u")
                else { throw fail("Lone high surrogate in string") }
                index += 2
                let second = try parseHex4()
                guard second >= 0xDC00 && second <= 0xDFFF else {
                    throw fail("High surrogate not followed by a low surrogate")
                }
                let combined = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                guard let scalar = UnicodeScalar(UInt32(combined)) else {
                    throw fail("Invalid surrogate pair")
                }
                return scalar
            }
            if first >= 0xDC00 && first <= 0xDFFF { throw fail("Lone low surrogate in string") }
            guard let scalar = UnicodeScalar(UInt32(first)) else {
                throw fail("Invalid \\u escape")
            }
            return scalar
        }

        mutating func parseHex4() throws -> Int {
            guard index + 4 <= bytes.count else { throw fail("Truncated \\u escape") }
            var value = 0
            for _ in 0..<4 {
                let b = bytes[index]
                let digit: Int
                switch b {
                case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = Int(b - UInt8(ascii: "0"))
                case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = Int(b - UInt8(ascii: "a")) + 10
                case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = Int(b - UInt8(ascii: "A")) + 10
                default: throw fail("Invalid hex digit in \\u escape")
                }
                value = value * 16 + digit
                index += 1
            }
            return value
        }

        /// RFC 8259 number grammar, with the integer/fraction distinction kept.
        mutating func parseNumber() throws -> JSONValue {
            let start = index
            if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
            let intStart = index
            guard index < bytes.count, isDigit(bytes[index]) else { throw fail("Invalid number") }
            if bytes[index] == UInt8(ascii: "0") {
                index += 1
                // Leading zeros are not JSON. "007" is refused rather than
                // read as 7: a file containing it was not written by anything
                // this app trusts.
                if index < bytes.count, isDigit(bytes[index]) {
                    throw fail("Leading zeros are not allowed in a number")
                }
            } else {
                while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            }
            let intEnd = index

            var isInteger = true
            if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
                isInteger = false
                index += 1
                guard index < bytes.count, isDigit(bytes[index]) else {
                    throw fail("Expected a digit after the decimal point")
                }
                while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
                isInteger = false
                index += 1
                if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
                    index += 1
                }
                guard index < bytes.count, isDigit(bytes[index]) else {
                    throw fail("Expected a digit in the exponent")
                }
                while index < bytes.count, isDigit(bytes[index]) { index += 1 }
            }

            let text = String(decoding: bytes[start..<index], as: UTF8.self)
            if isInteger {
                // The digits, straight to Int64. This is the line that makes
                // the port able to hold an amount a JS number cannot.
                if let exact = Int64(text) { return .int(exact) }
                // Too big for Int64 — which is also past the point where the
                // browser was holding it exactly, so a Double here loses
                // nothing the file had not already lost. Refusing instead
                // would make a file the web app can restore unreadable here.
                _ = intStart
                _ = intEnd
            }
            guard let d = Double(text) else { throw fail("Invalid number") }
            return .double(d)
        }

        func isDigit(_ b: UInt8) -> Bool {
            b >= UInt8(ascii: "0") && b <= UInt8(ascii: "9")
        }
    }
}

private func utf8SequenceLength(_ first: UInt8) -> Int {
    if first < 0x80 { return 1 }
    if first >= 0xC2 && first <= 0xDF { return 2 }
    if first >= 0xE0 && first <= 0xEF { return 3 }
    if first >= 0xF0 && first <= 0xF4 { return 4 }
    return 0
}

private func decodeUTF8(_ bytes: [UInt8]) -> UnicodeScalar? {
    var iterator = bytes.makeIterator()
    var decoder = UTF8()
    guard case .scalarValue(let scalar) = decoder.decode(&iterator) else { return nil }
    // Exactly one scalar, no more: a partial sequence would have decoded to
    // a replacement character and quietly changed the string.
    guard case .emptyInput = decoder.decode(&iterator) else { return nil }
    return scalar
}
