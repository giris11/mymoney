// What a typed search means, before any SQL is written.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF THE PROBLEM, AND WHY IT IS SOLVED IN TWO HALVES
//
// "Search the register" is five different searches wearing one box: a payee, a
// word in a note, an amount, a category, an account. Four of those are lookups
// against small tables the app has already read -- there are hundreds of payees
// and dozens of accounts, and the app holds both in `RegisterLookups` before it
// draws a single row. The fifth, notes, is the only one that lives on the
// 5,127-row table.
//
// So this file RESOLVES the first four in Swift, to sets of ids, and hands the
// database `payee_id IN (…)` -- an index probe over integers-as-text -- instead
// of a join and a LIKE across four tables per row. `LedgerStore+Search.swift`
// then does exactly one thing the database is better at: walk the transactions
// once, testing cheap equalities first and the note text last.
//
// THE ROWS NEVER LEAVE SQLITE UNLESS THEY MATCH. That is the whole performance
// claim, and it is what "use SQL, not an in-memory filter" means here: the
// filter is a WHERE clause, paging is still keyset, and memory is the size of
// one page whether the book has five thousand rows or five hundred thousand.
//
// WHY NOT FTS5. It would be faster, and it would be a SECOND COPY OF THE BOOK
// kept in step by triggers. A full-text index that silently drifts does not
// look like a broken index; it looks like a transaction that is not there. This
// app's whole design is "one source, no second path", and a search box is not
// worth breaking that for -- particularly when a scan of this book measures in
// single-digit milliseconds (`RegisterSearchTests.speed`).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MATCHING RULES, STATED ONCE
//
//   * The query is split on whitespace into TERMS. EVERY term must match --
//     "tesco march" finds rows matching both, not either. That is what people
//     mean when they add a word: they are narrowing.
//   * A term matches a row if it matches ANY of: the payee's name, the account's
//     name, the category's full path, any tag's name, the note (the split's
//     note too), the amount, or the date.
//   * Matching is CONTAINS, not prefix: "sains" finds "Sainsburys", and "burys"
//     finds it too. A ledger search that could only match from the start of a
//     word would fail on "Amazon Marketplace" typed as "marketplace".
//   * Case folds through `Names.key`, which is the same full-Unicode fold the
//     rest of this package uses to decide that two typed names are one name.
import Foundation

/// A search box's contents, reduced to the terms it means.
public struct RegisterSearch: Sendable, Hashable {
    /// Exactly what was typed. Kept so a screen can echo it back.
    public let raw: String
    /// Case-folded, whitespace-collapsed words. Empty for an empty search.
    public let terms: [String]

    public init(_ raw: String) {
        self.raw = raw
        // `Names.clean` collapses every run of JavaScript whitespace -- which
        // includes the non-breaking spaces that arrive from a paste out of a
        // bank statement -- to one ordinary space, so splitting on that space
        // is enough afterwards.
        let cleaned = Names.key(raw)
        self.terms = cleaned.isEmpty ? [] : cleaned.split(separator: " ").map(String.init)
    }

    public static let none = RegisterSearch("")

    public var isEmpty: Bool { terms.isEmpty }
}

/// One term, resolved against the book's small tables.
///
/// Sets rather than arrays: they are used for membership and for building an
/// `IN` list, and a duplicate id in either would be a longer statement for the
/// same answer.
public struct SearchTerm: Sendable, Hashable {
    public let text: String
    public let payeeIds: Set<String>
    public let accountIds: Set<String>
    public let categoryIds: Set<String>
    public let tagIds: Set<String>
    /// Every signed minor-unit value this term could be an amount for, across
    /// the currencies the book actually uses. Both signs, because a person
    /// searching "4.20" is not thinking about which way the money went.
    public let amountsMinor: Set<Int64>
    /// The `LIKE` pattern for a date column, when the term looks like part of
    /// a date. nil when it does not -- see `datePattern`.
    public let datePattern: String?

    /// The `LIKE` pattern for the note columns: the term, with LIKE's own
    /// wildcards neutralised.
    public var notePattern: String { RegisterSearch.likeContains(text) }
}

extension RegisterSearch {

    /// LIKE's escape character. Backslash, declared with `ESCAPE '\'` on every
    /// pattern this file produces.
    public static let likeEscape: Character = "\\"

    /// `%term%`, with `%`, `_` and the escape itself escaped.
    ///
    /// WITHOUT THIS, A SEARCH FOR "50%" MATCHES EVERYTHING. `%` is LIKE's
    /// "any run of characters" and `_` is its "any single character", and both
    /// turn up in real notes -- "50% off", "REF_2261". Neither is a security
    /// hole (the pattern is bound, never interpolated) and both are wrong
    /// answers, which is the kind of bug nobody reports because it looks like
    /// the search is just bad.
    public static func likeContains(_ text: String) -> String {
        var out = "%"
        for character in text {
            if character == likeEscape || character == "%" || character == "_" {
                out.append(likeEscape)
            }
            out.append(character)
        }
        out.append("%")
        return out
    }

    /// Resolve every term against the book's lookups.
    ///
    /// `currencies` is the set the book actually uses -- taken from its
    /// accounts, since a transaction's currency is its account's by
    /// construction. Parsing "4.20" once per currency is what makes the amount
    /// search right in a book with two of them: 420 in GBP is not 420 in JPY,
    /// which has no minor units at all.
    public func resolve(
        against lookups: RegisterLookups, currencies: Set<String>
    ) -> [SearchTerm] {
        terms.map { term in
            SearchTerm(
                text: term,
                payeeIds: Set(
                    lookups.payeeNamesById
                        .filter { Names.key($0.value).contains(term) }
                        .map(\.key)
                ),
                accountIds: Set(
                    lookups.accountsById
                        .filter { Names.key($0.value.name).contains(term) }
                        .map(\.key)
                ),
                // MATCHED ON THE FULL PATH, not the leaf name, and that is the
                // behaviour rather than a shortcut: "food" then matches
                // "Food \u{203A} Dining \u{203A} Coffee" and every other child of
                // Food, because their paths contain the parent's name. A search
                // for a top-level category finds the things filed underneath
                // it, which is what somebody typing it wants, and it costs no
                // tree walk here because the path is already resolved.
                categoryIds: Set(
                    lookups.categoriesById.keys.filter { id in
                        guard let path = lookups.categoryPath(id) else { return false }
                        return Names.key(path).contains(term)
                    }
                ),
                tagIds: Set(
                    lookups.tagNamesById
                        .filter { Names.key($0.value).contains(term) }
                        .map(\.key)
                ),
                amountsMinor: Self.amounts(term, currencies: currencies),
                datePattern: Self.datePattern(term)
            )
        }
    }

    /// Every value this term could be, as money, in each currency the book
    /// uses -- and its negation.
    ///
    /// `Money.parseToMinor` is the SAME parser every amount field in the app
    /// uses, so "1,234.56", "£12", "(4.20)" and "5.00 GBP" all mean here what
    /// they mean when typed into the editor. It returns nil rather than
    /// guessing, so a word is simply not an amount and contributes nothing.
    static func amounts(_ term: String, currencies: Set<String>) -> Set<Int64> {
        // A term with no digit is never an amount, and skipping the parse
        // avoids "GBP" (three letters, stripped as a currency code) arriving at
        // the digit check as an empty string in some future edit of the parser.
        guard term.contains(where: { $0.isNumber }) else { return [] }
        var out: Set<Int64> = []
        for currency in currencies {
            guard let minor = Money.parseToMinor(term, currency: currency) else { continue }
            out.insert(minor)
            // Guarded rather than written `-minor`: `Int64.min` has no positive
            // counterpart and negating it TRAPS. No real amount is anywhere
            // near it, but a search box is exactly the place somebody pastes
            // something absurd, and a crash there would be this feature's
            // fault rather than theirs.
            if minor != Int64.min { out.insert(-minor) }
        }
        return out
    }

    /// A `LIKE` pattern for the date column, when the term plausibly IS part of
    /// a date, and nil otherwise.
    ///
    /// THE RULE IS DELIBERATELY NARROW: at least four characters, and nothing
    /// but digits and hyphens. Dates are stored "YYYY-MM-DD", so that admits
    /// "2026", "2026-09" and "09-02" and excludes "5" -- which would otherwise
    /// match every date with a 5 anywhere in it and drown the amount search
    /// that "5" was almost certainly meant to be.
    static func datePattern(_ term: String) -> String? {
        guard term.count >= 4,
            term.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == "-") }),
            term.contains(where: \.isNumber)
        else { return nil }
        return likeContains(term)
    }
}
