// Duplicate detection, ported from src/import/dedupe.ts (SPEC §7.4).
//
// THE DEDUPE KEY IS A READABLE STRING, NOT A DIGEST (D10):
//
//     accountId|date|amountMinor|normalised payee-or-description
//
// A SHA of those four fields would be shorter and would look more like a
// "hash". It would also be unreadable in a debugger, in a backup file, and in
// a support conversation with the one person who uses this app — and it would
// buy nothing, because the key is not a security boundary and collisions are
// not the risk. Two different transactions that agree on all four fields are
// genuinely indistinguishable to a re-import; that is a property of the data,
// not of the encoding.
//
// TWO KINDS OF DUPLICATE, AND ONLY ONE IS AUTOMATIC. An EXACT duplicate
// (identical key) is auto-skipped and counted. A NEAR duplicate (same account,
// same amount, within a day, similar payee) is ALWAYS a human decision — it is
// never silently dropped and never silently doubled, because both mistakes
// corrupt a ledger and neither is visible afterwards.
import Foundation

public struct DuplicateCheck: Sendable, Hashable {
    public let exact: Bool
    /// The existing transaction this one nearly duplicates. Never acted on
    /// automatically.
    public let nearDuplicateOf: Transaction?
}

public enum Dedupe {
    /// Lowercase, strip punctuation and symbols, collapse whitespace, trim.
    ///
    /// The character test is Unicode general category, matching the
    /// TypeScript's `/[^\p{L}\p{N}\s]/gu` exactly: LETTERS and NUMBERS survive,
    /// everything else that is not whitespace is removed. "Café Paris" keeps
    /// its é — a port that stripped to ASCII would make it "caf paris" and stop
    /// matching the same payee written the same way, which is the one job this
    /// function has.
    public static func normalizeForHash(_ s: String) -> String {
        var kept = String.UnicodeScalarView()
        for scalar in s.lowercased().unicodeScalars {
            if isLetterOrNumber(scalar) || isJSWhitespace(scalar) {
                kept.append(scalar)
            }
        }
        // Collapse runs of whitespace to one space, and trim — `.replace(/\s+/g,
        // ' ').trim()` in one pass.
        var out = ""
        var pendingSpace = false
        for scalar in kept {
            if isJSWhitespace(scalar) {
                if !out.isEmpty { pendingSpace = true }
                continue
            }
            if pendingSpace {
                out.append(" ")
                pendingSpace = false
            }
            out.unicodeScalars.append(scalar)
        }
        return out
    }

    private static func isLetterOrNumber(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .uppercaseLetter, .lowercaseLetter, .titlecaseLetter,
             .modifierLetter, .otherLetter:
            return true  // \p{L}
        case .decimalNumber, .letterNumber, .otherNumber:
            return true  // \p{N}
        default:
            return false
        }
    }

    private static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        Money.jsWhitespace.contains(Character(scalar))
    }

    public static func makeDedupeHash(
        accountId: String, date: String, amountMinor: Int64, payeeOrDescription: String
    ) -> String {
        "\(accountId)|\(date)|\(amountMinor)|\(normalizeForHash(payeeOrDescription))"
    }

    /// Levenshtein distance, two-row DP.
    ///
    /// Measured in UTF-16 CODE UNITS, not Characters, because the TypeScript
    /// indexes with `a[i-1]` and lengths with `.length` — both UTF-16 in
    /// JavaScript. Swift's `Character` is a grapheme cluster, so "e" plus a
    /// combining acute would count as one there and two here, and the two
    /// implementations would disagree about how similar two payee names are.
    /// The threshold in `similarPayee` is a fraction of a length, so the unit
    /// has to match or the decisions drift.
    public static func levenshtein(_ a: String, _ b: String) -> Int {
        if a == b { return 0 }
        let x = Array(a.utf16)
        let y = Array(b.utf16)
        if x.isEmpty { return y.count }
        if y.isEmpty { return x.count }
        var prev = Array(0...y.count)
        var curr = [Int](repeating: 0, count: y.count + 1)
        for i in 1...x.count {
            curr[0] = i
            for j in 1...y.count {
                let cost = x[i - 1] == y[j - 1] ? 0 : 1
                curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
            }
            swap(&prev, &curr)
        }
        return prev[y.count]
    }

    /// Payee similarity for near-duplicate flagging: normalised equality,
    /// containment (of a name at least 3 long), or Levenshtein within
    /// max(1, 25% of the longer name).
    ///
    /// The 3-character floor on containment is why "AB" and "AB Store" are NOT
    /// similar: two-letter fragments are inside far too many real payee names,
    /// and a false near-duplicate costs the owner a decision on every import.
    public static func similarPayee(_ a: String, _ b: String) -> Bool {
        similarNormalized(normalizeForHash(a), normalizeForHash(b))
    }

    /// The same test, for callers that already hold the normalised forms.
    ///
    /// It exists for one reason: `Recurrence` compares every payee in the book
    /// with every other one when it looks for a renamed payee, and normalising
    /// two strings that were normalised when the group was built is the most
    /// expensive thing in that loop. The keys it passes are
    /// `normalizeForHash`'s own output, and this function is what
    /// `similarPayee` does after normalising, so the two cannot answer
    /// differently.
    public static func similarNormalized(_ na: String, _ nb: String) -> Bool {
        if na == nb { return true }  // covers both-empty
        if na.isEmpty || nb.isEmpty { return false }
        let x = Array(na.utf16)
        let y = Array(nb.utf16)
        let shorter = x.count <= y.count ? x : y
        let longer = x.count <= y.count ? y : x
        if shorter.count >= 3, contains(longer, shorter) { return true }
        let threshold = max(1, Int((Double(longer.count) * 0.25).rounded(.down)))
        // An edit distance is never less than the difference in length, so a
        // pair this far apart cannot pass and the table need not be built.
        // Exact, not a heuristic: it removes work, never an answer. (Added for
        // `Recurrence`, which asks this of every pair of payees in the book.)
        if longer.count - shorter.count > threshold { return false }
        return levenshtein(na, nb) <= threshold
    }

    /// `String.prototype.includes` — a UTF-16 code-unit search, for the same
    /// reason `levenshtein` counts code units. Swift's `String.contains` works
    /// on grapheme clusters and would answer differently for a name written
    /// with combining marks.
    private static func contains(_ haystack: [UInt16], _ needle: [UInt16]) -> Bool {
        if needle.isEmpty { return true }
        if needle.count > haystack.count { return false }
        for start in 0...(haystack.count - needle.count) {
            var matched = true
            for offset in 0..<needle.count where haystack[start + offset] != needle[offset] {
                matched = false
                break
            }
            if matched { return true }
        }
        return false
    }

    public struct Candidate: Sendable, Hashable {
        public let accountId: String
        public let date: String
        public let amountMinor: Int64
        public let payeeOrDescription: String

        public init(accountId: String, date: String, amountMinor: Int64, payeeOrDescription: String) {
            self.accountId = accountId
            self.date = date
            self.amountMinor = amountMinor
            self.payeeOrDescription = payeeOrDescription
        }
    }

    /// Check one candidate against the existing transactions of the same
    /// account. Pure: the caller prefetches, so this can be tested with a
    /// handful of rows and no storage at all.
    ///
    /// Near-duplicate matches PREFER a same-date row over a ±1-day one, so the
    /// row the owner is shown is the most likely partner rather than whichever
    /// happened to come first out of the database.
    public static func checkDuplicate(
        _ candidate: Candidate,
        existingByAccount: [Transaction],
        payeeNameOf: (Transaction) -> String
    ) -> DuplicateCheck {
        let hash = makeDedupeHash(
            accountId: candidate.accountId, date: candidate.date,
            amountMinor: candidate.amountMinor, payeeOrDescription: candidate.payeeOrDescription
        )
        var near: Transaction? = nil
        var nearDistance = Int.max
        for tx in existingByAccount {
            if tx.accountId != candidate.accountId { continue }
            if tx.dedupeHash == hash { return DuplicateCheck(exact: true, nearDuplicateOf: nil) }
            if tx.amountMinor != candidate.amountMinor { continue }
            guard let a = CalendarDate(iso: tx.date), let b = CalendarDate(iso: candidate.date) else { continue }
            let distance = abs(a.daysSince(b))
            if distance > 1 { continue }
            if !similarPayee(candidate.payeeOrDescription, payeeNameOf(tx)) { continue }
            if distance < nearDistance {
                near = tx
                nearDistance = distance
            }
        }
        return DuplicateCheck(exact: false, nearDuplicateOf: near)
    }
}
