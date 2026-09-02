// Searching the register, in SQL.
//
// The rules are in `RegisterSearch.swift`; this file is the half that touches
// the database, and it has exactly two jobs: build the WHERE clause the rules
// describe, and leave everything else about a register read alone.
//
// EVERYTHING ELSE ABOUT A REGISTER READ IS LEFT ALONE, and that is the design.
// A search is the SAME query as an ordinary page with an extra predicate: the
// same `ORDER BY`, the same keyset cursor, the same `limit + 1` probe for "is
// there more", the same row construction through `Register.title` and
// `Register.categoryLine`. A separate search query would be a second place that
// decides what a transfer is called, and the two would drift the first time
// either was touched.
//
// THE CLAUSE IS BUILT SO THE CHEAP TESTS COME FIRST. SQLite evaluates an OR
// left to right and stops at the first true one, so each term reads:
//
//     account id ∈ … OR payee id ∈ … OR category id ∈ … OR amount ∈ …
//     OR date LIKE … OR note LIKE … OR (a tag) OR (a split)
//
// -- integer and short-string equalities, then the text scan, then the two
// subqueries. On a book where the term names a payee, the note is never
// examined at all.
//
// AND AN EMPTY SET CONTRIBUTES NOTHING. A term matching no payee does not
// produce `payee_id IN ()`; it produces no clause. That is not tidiness: `IN ()`
// is a syntax error in SQLite, and a clause of `IN (NULL)` would be neither
// true nor false and would quietly poison the OR.
import Foundation

/// A `WHERE` fragment and the values it wants bound, kept together.
///
/// The pair exists because the two cannot be built apart: the number of
/// placeholders in the SQL and the number of binds have to agree, and a
/// function that returned only the string would leave its caller counting.
struct SearchPredicate {
    let sql: String
    /// In placeholder order. Text and integers are bound differently, so the
    /// type has to travel with the value.
    let bindings: [Binding]

    enum Binding {
        case text(String)
        case integer(Int64)
    }

    static let matchesEverything = SearchPredicate(sql: "", bindings: [])
    var isEmpty: Bool { sql.isEmpty }
}

extension LedgerStore {

    /// The currencies this book actually uses.
    ///
    /// Taken from the ACCOUNTS, because a transaction's currency is its
    /// account's by construction (see `Drafts.swift`: a transaction whose
    /// currency disagrees with its account's is a row whose amount means
    /// something other than what it says). Reading it from `live_accounts` is
    /// dozens of rows; reading `DISTINCT currency` from the transactions is a
    /// scan of the whole book to learn the same three letters.
    func bookCurrencies(from lookups: RegisterLookups) -> Set<String> {
        Set(lookups.accountsById.values.map(\.currency))
    }

    /// The predicate for a search, or an empty one when there is nothing to
    /// search for.
    func searchPredicate(
        _ search: RegisterSearch, lookups: RegisterLookups, alias: String = "t"
    ) -> SearchPredicate {
        guard !search.isEmpty else { return .matchesEverything }
        let terms = search.resolve(against: lookups, currencies: bookCurrencies(from: lookups))

        var clauses: [String] = []
        var bindings: [SearchPredicate.Binding] = []

        for term in terms {
            var any: [String] = []

            func inList(_ column: String, _ ids: Set<String>) {
                guard !ids.isEmpty else { return }
                // SORTED, so the same search produces the same statement text
                // twice running and SQLite's prepared-statement cache can do
                // its job. A `Set`'s order is not stable between runs.
                let ordered = ids.sorted()
                let placeholders = Array(repeating: "?", count: ordered.count)
                    .joined(separator: ", ")
                any.append("\(alias).\(column) IN (\(placeholders))")
                bindings.append(contentsOf: ordered.map { .text($0) })
            }

            inList("account_id", term.accountIds)
            inList("payee_id", term.payeeIds)
            inList("category_id", term.categoryIds)

            if !term.amountsMinor.isEmpty {
                let ordered = term.amountsMinor.sorted()
                let placeholders = Array(repeating: "?", count: ordered.count)
                    .joined(separator: ", ")
                any.append("\(alias).amount_minor IN (\(placeholders))")
                bindings.append(contentsOf: ordered.map { .integer($0) })
            }

            if let datePattern = term.datePattern {
                // The date column is plain ASCII "YYYY-MM-DD", so the built-in
                // LIKE is exactly right for it and `mm_lower` would be a
                // function call per row for nothing.
                any.append("\(alias).date LIKE ? ESCAPE '\\'")
                bindings.append(.text(datePattern))
            }

            any.append("mm_lower(\(alias).notes) LIKE ? ESCAPE '\\'")
            bindings.append(.text(term.notePattern))

            if !term.tagIds.isEmpty {
                let ordered = term.tagIds.sorted()
                let placeholders = Array(repeating: "?", count: ordered.count)
                    .joined(separator: ", ")
                any.append(
                    """
                    EXISTS (SELECT 1 FROM transaction_tags tt \
                    WHERE tt.transaction_id = \(alias).id AND tt.tag_id IN (\(placeholders)))
                    """
                )
                bindings.append(contentsOf: ordered.map { .text($0) })
            }

            // THE SPLITS ARE SEARCHED TOO, and they have to be. A £50 shop with
            // £8 of it filed under Coffee has no category of its own -- its
            // `category_id` is null and the categories live on the split rows.
            // Without this clause, searching "coffee" would miss exactly the
            // transactions a person splits things in order to record.
            var splitTests: [String] = []
            var splitBindings: [SearchPredicate.Binding] = []
            if !term.categoryIds.isEmpty {
                let ordered = term.categoryIds.sorted()
                let placeholders = Array(repeating: "?", count: ordered.count)
                    .joined(separator: ", ")
                splitTests.append("s.category_id IN (\(placeholders))")
                splitBindings.append(contentsOf: ordered.map { .text($0) })
            }
            splitTests.append("mm_lower(coalesce(s.notes, '')) LIKE ? ESCAPE '\\'")
            splitBindings.append(.text(term.notePattern))
            any.append(
                """
                EXISTS (SELECT 1 FROM transaction_splits s \
                WHERE s.transaction_id = \(alias).id AND (\(splitTests.joined(separator: " OR "))))
                """
            )
            bindings.append(contentsOf: splitBindings)

            clauses.append("(" + any.joined(separator: " OR ") + ")")
        }

        // EVERY term, not any: adding a word narrows.
        return SearchPredicate(sql: clauses.joined(separator: " AND "), bindings: bindings)
    }
}

extension SQLiteStatement {
    /// Bind a run of search values starting at `slot`, and answer with the next
    /// free slot. Returning the cursor rather than mutating a caller's variable
    /// makes it impossible to bind the right values into the wrong places.
    func bind(_ bindings: [SearchPredicate.Binding], from slot: Int32) -> Int32 {
        var next = slot
        for binding in bindings {
            switch binding {
            case .text(let value): bind(next, text: value)
            case .integer(let value): bind(next, integer: value)
            }
            next += 1
        }
        return next
    }
}
