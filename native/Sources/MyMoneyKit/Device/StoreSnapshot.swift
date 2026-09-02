// Turning the book into the handful of figures a widget may hold.
//
// ONE CALL, ONE BOOK. The `Book` is passed in rather than read here because the
// app already has one -- `LedgerService` keeps the last one, invalidated by
// SQLite's own count of rows changed -- and reading the whole ledger a second
// time to publish a summary of it would double the cost of every edit. It also
// makes the guarantee that matters explicit: the widget's net worth and the
// dashboard's net worth are the same call over the same book, not two reads a
// moment apart.
import Foundation

extension LedgerStore {

    /// Everything the widget needs, or nil when this device holds no book.
    ///
    /// `asOf` is passed in rather than taken from the clock here, for the same
    /// reason `today` is: a snapshot whose figures are for one instant and
    /// whose stamp is for another is exactly the discrepancy the stamp exists
    /// to rule out. The app passes `Date()` once.
    public func ledgerSnapshot(book: Book, today: String, asOf: String) throws -> LedgerSnapshot? {
        if try isEmpty() { return nil }
        return LedgerSnapshot.of(
            try Dashboard.summary(book: book, today: today),
            // EVERY live budget, not the dashboard card's first four. See
            // `LedgerSnapshot.of`.
            budgets: try book.allBudgetProgress(refDate: today),
            localEditCount: try localEdits().count,
            sourceExportedAt: try provenance().exportedAt,
            transactionCount: try registerCount(scope: .allAccounts),
            accountCount: try liveCount("accounts"),
            asOf: asOf
        )
    }

    /// The same thing when the caller has no book in hand. Reads one.
    public func ledgerSnapshot(today: String, asOf: String) throws -> LedgerSnapshot? {
        if try isEmpty() { return nil }
        return try ledgerSnapshot(book: try book(), today: today, asOf: asOf)
    }
}
