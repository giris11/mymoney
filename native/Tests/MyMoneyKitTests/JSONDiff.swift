// A structural diff between two JSON documents, for the one question a hash
// cannot answer: WHICH field diverged.
//
// A content hash is a good gate and a terrible diagnostic -- it says "these two
// files are not the same" and nothing else, and a 3 MB backup has around
// 100,000 places it could be wrong. This walks both documents in step and
// reports the first differences by PATH ("tables.transactions[4127].notes"),
// which is the difference between a five-minute fix and an evening.
//
// Bounded on purpose: a writer that got one rule wrong produces a difference
// in every row, and printing 5,127 identical complaints buries the one line
// that matters. The count is always reported even when the list is truncated,
// because "one field is wrong" and "every row is wrong" are different bugs.
@testable import MyMoneyKit

enum JSONDiff {
    struct Difference {
        let path: String
        let detail: String
    }

    /// Every way `got` differs from `want`, by path. Keys missing on either
    /// side are differences in their own right -- absent and null are not the
    /// same claim, and neither is absent and present-but-equal.
    static func differences(want: JSONValue, got: JSONValue, limit: Int = 20) -> [Difference] {
        var found: [Difference] = []
        walk(path: "", want: want, got: got, limit: limit, into: &found)
        return found
    }

    private static func walk(
        path: String, want: JSONValue, got: JSONValue, limit: Int, into found: inout [Difference]
    ) {
        if found.count >= limit { return }
        switch (want, got) {
        case (.object(let a), .object(let b)):
            for key in Set(a.keys).union(b.keys).sorted(by: jsStringLess) {
                let child = path.isEmpty ? key : "\(path).\(key)"
                switch (a[key], b[key]) {
                case (let x?, let y?):
                    walk(path: child, want: x, got: y, limit: limit, into: &found)
                case (_?, nil):
                    found.append(Difference(path: child, detail: "missing from the export"))
                case (nil, _?):
                    found.append(Difference(path: child, detail: "the export invented this key"))
                case (nil, nil):
                    break
                }
                if found.count >= limit { return }
            }
        case (.array(let a), .array(let b)):
            if a.count != b.count {
                found.append(
                    Difference(path: path, detail: "\(b.count) entries, expected \(a.count)")
                )
                return
            }
            for index in a.indices {
                walk(path: "\(path)[\(index)]", want: a[index], got: b[index], limit: limit, into: &found)
                if found.count >= limit { return }
            }
        default:
            // Compared as they would be WRITTEN, not as Swift values.
            //
            // JSON has one number type. A rate stored as `2` parses to
            // `.int(2)` and comes back out of a `Double`-typed field as
            // `.double(2.0)`, and both are the two bytes `2` in the file --
            // the same JSON number, held in different Swift cases. This diff
            // exists to explain a hash that did not match, so its idea of
            // "different" has to be the hash's: different bytes. (Nothing is
            // lost by it. `"2"` and `2` still differ, because the quotes are
            // part of the text, and so do `null` and `false`.)
            if CanonicalJSON.text(want, indent: 0) != CanonicalJSON.text(got, indent: 0) {
                found.append(
                    Difference(path: path, detail: "\(describe(got)), expected \(describe(want))")
                )
            }
        }
    }

    /// Scalars are printed as they would be written, so a difference that is
    /// invisible in prose ("5" versus "5.0", a trailing space in a string) is
    /// visible here.
    private static func describe(_ value: JSONValue) -> String {
        switch value {
        case .object(let members): return "an object with \(members.count) keys"
        case .array(let items): return "an array of \(items.count)"
        default: return CanonicalJSON.text(value, indent: 0)
        }
    }

    static func report(_ differences: [Difference], limit: Int = 20) -> String {
        guard !differences.isEmpty else { return "no differences" }
        var lines = differences.prefix(limit).map { "  \($0.path): \($0.detail)" }
        if differences.count > limit {
            lines.append("  ...and more (listing stopped at \(limit))")
        }
        return lines.joined(separator: "\n")
    }
}
