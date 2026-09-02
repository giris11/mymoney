// The two reads the report screens need that no other screen does, and the
// one number that makes caching the book safe.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A CACHE TOKEN AND NOT A CACHE.
//
// Every report in `Reports` takes a whole `Book`, because that is the shape the
// arithmetic was proved in and re-expressing six reports as SQL would be six
// new places for a rounding rule to drift. A `Book` for a real ledger is a few
// thousand rows: cheap to build, not free, and the reports screen builds one
// every time a date changes. So the caller wants to keep the last one.
//
// A cache is only ever as good as the thing that says when it is stale, and
// "remember to invalidate it" is exactly the kind of rule that survives until
// the next feature. `writeToken()` removes the remembering: SQLite counts the
// rows changed on this connection since it opened, and that count is
// monotonic. Same token, same rows -- not "probably", but because a write that
// changed anything necessarily moved it. A future mutation nobody thought about
// here cannot get past it.
//
// It is a token, not a version: nothing may store it, compare it across
// processes, or infer anything from the difference between two of them.
import Foundation
import SQLite3

extension LedgerStore {
    /// A number that changes whenever any row is written through this
    /// connection, and does not change when nothing is.
    ///
    /// `sqlite3_total_changes64` rather than the 32-bit form: the counter is
    /// cumulative for the life of the connection, and an app that imports a
    /// 5,000-row book a few thousand times would wrap the 32-bit one. A wrapped
    /// counter could land back on a value a cache is holding, and the cache
    /// would then serve a book from before an import.
    public func writeToken() -> Int64 {
        sqlite3_total_changes64(connection.handle)
    }

    /// The date of the earliest transaction in the book, or nil when there are
    /// none. The only input the "All time" range has that is not arithmetic.
    ///
    /// Read as a single indexed MIN rather than by loading the book: this is
    /// asked to decide what a date PICKER should offer, often before anything
    /// has been aggregated, and it must not cost a full read to answer.
    public func earliestTransactionDate() throws -> String? {
        let statement = try connection.prepare("SELECT MIN(date) FROM live_transactions")
        defer { statement.finalize() }
        guard try statement.step() else { return nil }
        // MIN over no rows is SQL NULL, which is a legitimate answer here and
        // not a corrupt column: an empty book has no earliest date.
        return try statement.optionalText(0)
    }
}
