// Every way the store refuses, each one saying what to do about it.
//
// The rule these follow is the same one BackupImport.swift follows: a message
// an owner reads at the worst moment must say what happened, what was NOT
// changed, and what to try. "Store error 19" is what turns a five-minute fix
// into an evening.
import Foundation

public enum StoreError: Error, Sendable, CustomStringConvertible {
    /// The libsqlite3 on this machine predates STRICT tables, so the schema
    /// cannot enforce that money is an integer.
    case unsupportedSQLite(found: String, needed: String)

    /// The database file was written by a newer build of this app.
    ///
    /// Refused rather than opened, for the same reason BackupReader refuses a
    /// backup with a higher schemaVersion: a newer build may have changed what
    /// a row MEANS, and reading it under old assumptions produces plausible
    /// wrong numbers instead of an error.
    case storeIsNewer(found: Int, supported: Int)

    /// A migration is missing from the chain, so the store cannot be brought
    /// forward without guessing.
    case migrationGap(from: Int, to: Int)

    /// A restore was asked to write into a store that already holds a book,
    /// without being told that replacing it is intended.
    case storeNotEmpty(accounts: Int, transactions: Int)

    /// A fresh book was asked for on a device that already has one.
    ///
    /// UNCONDITIONAL, unlike `storeNotEmpty`, which a caller can override by
    /// saying that replacing the book is what it meant. There is no equivalent
    /// override here and there must not be: a restore is asked for by somebody
    /// holding the file they want back, while "start fresh" is a button that
    /// can be tapped by somebody who has not realised their imported ledger is
    /// behind it.
    case bookAlreadyExists(accounts: Int, transactions: Int)

    /// A column held something other than what it is declared to hold. In a
    /// STRICT schema this is unreachable through this package's own writers;
    /// it is what a store edited by another tool looks like.
    case columnTypeMismatch(statement: String, column: String, expected: String, found: String)

    /// The money audit found a stored amount that is not an integer.
    case moneyIsNotAnInteger(table: String, column: String, id: String, found: String)

    /// The store's own content contradicts itself.
    case corrupt(String)

    /// A transaction failed AND the rollback failed. The connection is refused
    /// from here on rather than left in an unknown state.
    case rollbackFailed(original: String, rollback: String)

    /// Use of a connection whose rollback failed.
    case connectionPoisoned

    /// Use of a store that has been closed.
    case connectionClosed

    public var description: String {
        switch self {
        case .unsupportedSQLite(let found, let needed):
            return "This device's SQLite is \(found); MyMoney needs \(needed)."
        case .storeIsNewer(let found, let supported):
            return
                "This ledger was created by a newer version of MyMoney (store schema \(found); "
                + "this build supports up to \(supported)). Update the app, then open it. "
                + "Nothing was changed."
        case .migrationGap(let from, let to):
            return
                "The ledger is at store schema \(from) and this build can only go on from \(to). "
                + "Nothing was changed."
        case .storeNotEmpty(let accounts, let transactions):
            return
                "Refusing to restore over a ledger that already holds \(accounts) account(s) and "
                + "\(transactions) transaction(s). Nothing was changed. Restore into an empty "
                + "ledger, or say explicitly that the existing one is to be replaced."
        case .bookAlreadyExists(let accounts, let transactions):
            return
                "This device already holds a book (\(accounts) account(s), \(transactions) "
                + "transaction(s)), so a new one was not started over it. Nothing was changed. "
                + "Open the book that is here, or import a backup if you meant to replace it."
        case .columnTypeMismatch(let statement, let column, let expected, let found):
            return
                "Corrupt ledger: \(column) holds \(found) where \(expected) was expected "
                + "[\(statement.prefix(120))]"
        case .moneyIsNotAnInteger(let table, let column, let id, let found):
            return
                "Corrupt ledger: \(table).\(column) for row \"\(id)\" is stored as \(found), not as "
                + "whole minor units. An amount held as a floating-point number is not money."
        case .corrupt(let detail):
            return "Corrupt ledger: \(detail)"
        case .rollbackFailed(let original, let rollback):
            return
                "A write failed and could not be rolled back, so the ledger's state is unknown "
                + "and this connection will not be used again. Close the app and reopen it; the "
                + "database's own journal will recover the last committed state. "
                + "(failure: \(original); rollback: \(rollback))"
        case .connectionPoisoned:
            return
                "This ledger connection was abandoned after a failed rollback and will not be "
                + "used again. Reopen the store."
        case .connectionClosed:
            return "This ledger has been closed. Reopen the store before using it."
        }
    }
}
