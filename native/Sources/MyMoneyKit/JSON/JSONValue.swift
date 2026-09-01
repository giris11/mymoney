// A JSON value that keeps integers exact.
//
// WHY NOT `JSONDecoder`. Two reasons, and the first is the whole point of the
// port. (1) A backup's money is Int64 minor units, and every JSON path that
// goes through a Double on the way in has already decided that amounts past
// 2^53 do not exist. This type parses an integer token as an Int64 from its
// digits, so nothing is lost before the model sees it. (2) The canonical form
// (CanonicalJSON.swift) has to reproduce, byte for byte, what a browser's
// JSON.stringify wrote — which means this layer must be able to say whether a
// number was an integer, and must never round-trip a value through a
// representation the browser did not use.
//
// Object keys are held in a Dictionary, so insertion order is thrown away on
// purpose. Key order is NOT data in this format (src/backup/canonical.ts says
// so at length); anything that depended on it would be depending on an
// accident of how a row was built.

/// One JSON value.
public enum JSONValue: Sendable, Hashable {
    case null
    case bool(Bool)
    /// An integer token that fits Int64 exactly.
    case int(Int64)
    /// Everything else numeric: fractions, exponents, and integer tokens too
    /// large for Int64 (which is also what a browser would have done to them).
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

public extension JSONValue {
    var isNull: Bool { if case .null = self { return true }; return false }

    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    /// An exact Int64, or nil.
    ///
    /// A `.double` is accepted only when it is exactly an integer that fits —
    /// a browser writes every amount as a JSON integer, but `1234.0` is the
    /// same JSON number as `1234` and refusing it would reject a file that is
    /// not actually wrong. `1234.5` as an `amountMinor` is not a rounding
    /// problem, it is a corrupt file, and it returns nil here so the caller
    /// can name the field.
    var intValue: Int64? {
        switch self {
        case .int(let i): return i
        case .double(let d): return Int64(exactly: d)
        default: return nil
        }
    }

    var doubleValue: Double? {
        switch self {
        case .int(let i): return Double(i)
        case .double(let d): return d
        default: return nil
        }
    }

    var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// Member lookup. `nil` (absent) and `.some(.null)` are DIFFERENT answers
    /// and both are preserved — the oracle's rule 5: "Absent keys are
    /// meaningful. `null` and absent are different claims."
    subscript(key: String) -> JSONValue? {
        guard case .object(let o) = self else { return nil }
        return o[key]
    }

    subscript(index: Int) -> JSONValue? {
        guard case .array(let a) = self, a.indices.contains(index) else { return nil }
        return a[index]
    }

    /// A short description of the value's kind, for error messages that have
    /// to say what was there instead.
    var kindName: String {
        switch self {
        case .null: return "null"
        case .bool: return "a boolean"
        case .int, .double: return "a number"
        case .string: return "a string"
        case .array: return "an array"
        case .object: return "an object"
        }
    }
}
