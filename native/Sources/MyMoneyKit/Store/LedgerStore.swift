// The store: an SQLite database that holds the owner's book, and refuses to
// hold it inexactly.
//
// WHAT THIS IS FOR, AND WHAT IT IS NOT. The web app is the system of record.
// This is a SHADOW COPY that reads a backup file. It must never write to,
// replace, or be presented as the owner's real ledger, and nothing in this file
// talks to anything but a local database file it was handed.
//
// THE PROPERTY THE WHOLE LAYER IS BUILT AROUND is in StoreBackup.swift: a
// backup imported into the store and exported back out again produces the SAME
// CANONICAL CONTENT HASH. That is the only statement that covers both halves of
// the risk at once -- the store does not LOSE anything (or a field would go
// missing) and does not INVENT anything (or a field would appear). A balance
// that agrees proves the arithmetic; only the bytes prove the data.
//
// CONCURRENCY. `LedgerStore` is deliberately not Sendable: one owner, one
// thread. A later phase that needs it from several tasks should put an actor in
// front of it. Marking it `@unchecked Sendable` because SQLite is compiled
// serialised would be a promise about the C library that this class's own
// Swift-side state does not keep.
import Foundation
import SQLite3

public final class LedgerStore {
    let connection: SQLiteConnection

    /// The store schema version actually on disk after opening.
    public private(set) var storeVersion: Int

    /// Where the database lives. ":memory:" for a scratch store.
    public var path: String { connection.path }

    private init(connection: SQLiteConnection, storeVersion: Int) {
        self.connection = connection
        self.storeVersion = storeVersion
    }

    // MARK: - Opening

    /// Open (creating if needed) and bring the schema up to date.
    public static func open(at url: URL) throws -> LedgerStore {
        try open(path: url.path)
    }

    /// A store with no file behind it. For tests and for computing something
    /// without leaving a trace; a crash-safety claim cannot be made about it,
    /// because there is nothing to survive a crash.
    public static func openInMemory() throws -> LedgerStore {
        try open(path: ":memory:")
    }

    static func open(path: String, upTo target: Int = StoreSchema.version) throws -> LedgerStore {
        let connection = try SQLiteConnection(path: path)

        // ── Durability, chosen rather than defaulted ────────────────────────
        //
        // WAL: readers do not block the writer and the writer does not block
        // readers, which is what lets a screen keep drawing while an import
        // runs. It also changes what a crash leaves behind -- an uncommitted
        // transaction's frames sit in the -wal with no commit frame, and the
        // next open discards them. That is the behaviour the crash test in
        // StoreCrashTests relies on, and it is asserted there rather than
        // assumed here.
        //
        // synchronous = FULL, not WAL's default of NORMAL. NORMAL is fast
        // because it does not fsync the WAL on every commit, and the documented
        // consequence is that a POWER LOSS (not a process crash) can lose the
        // most recent transactions -- while leaving the database consistent.
        // "Consistent but missing last week's transactions" is exactly the
        // failure this project says is unacceptable, and the cost of FULL is
        // one fsync per commit on a database written a handful of times a day.
        //
        // foreign_keys = ON, because it is OFF by default in SQLite and a
        // schema whose REFERENCES clauses do nothing is worse than one with
        // none: it reads as a guarantee.
        if path != ":memory:" {
            // An in-memory database cannot be WAL and says so by returning
            // "memory"; asking is harmless, insisting would be wrong.
            _ = try connection.scalarText("PRAGMA journal_mode = WAL")
        }
        try connection.execute("PRAGMA synchronous = FULL")
        try connection.execute("PRAGMA foreign_keys = ON")

        let version = try migrate(connection, upTo: target)
        return LedgerStore(connection: connection, storeVersion: version)
    }

    /// Close now rather than whenever the last reference goes away.
    ///
    /// Optional -- the handle closes itself at deinit -- but explicit where it
    /// matters: after this returns, the WAL has been checkpointed and the file
    /// on disk stands on its own, which is what a caller about to copy, move or
    /// hand over the database needs. Every later call on this store throws.
    public func close() {
        connection.close()
    }

    // MARK: - Migrations

    /// Bring `connection` up to `target`, one migration per transaction.
    ///
    /// Each step commits WITH the row that records it. A migration that throws
    /// halfway leaves the store at the version it was already at -- there is no
    /// state in which the tables have changed but `schema_migrations` has not,
    /// because both are in the same transaction.
    @discardableResult
    static func migrate(_ connection: SQLiteConnection, upTo target: Int) throws -> Int {
        try connection.execute(
            """
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INTEGER NOT NULL PRIMARY KEY,
                name       TEXT    NOT NULL,
                applied_at TEXT    NOT NULL
            ) STRICT
            """
        )
        var current = Int(try connection.scalarInt(
            "SELECT coalesce(max(version), 0) FROM schema_migrations"
        ) ?? 0)

        // A store from the FUTURE is refused, not opened. Same reasoning as
        // BackupReader refusing a newer backup schemaVersion: a newer build may
        // have changed what a row means, and reading it under this build's
        // assumptions produces plausible wrong numbers instead of an error.
        guard current <= StoreSchema.version else {
            throw StoreError.storeIsNewer(found: current, supported: StoreSchema.version)
        }

        let pending = StoreSchema.all
            .filter { $0.version > current && $0.version <= target }
            .sorted { $0.version < $1.version }
        for migration in pending {
            guard migration.version == current + 1 else {
                throw StoreError.migrationGap(from: current, to: migration.version)
            }
            try connection.transaction {
                for statement in migration.statements {
                    try connection.execute(statement)
                }
                let insert = try connection.prepare(
                    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
                )
                defer { insert.finalize() }
                insert.bind(1, integer: migration.version)
                insert.bind(2, text: migration.name)
                insert.bind(3, text: Self.timestampNow())
                try insert.run()
            }
            current = migration.version
        }
        return current
    }

    /// What has been applied, oldest first. So a store can say what it is
    /// rather than being asked to prove it by behaviour.
    public func appliedMigrations() throws -> [(version: Int, name: String, appliedAt: String)] {
        let statement = try connection.prepare(
            "SELECT version, name, applied_at FROM schema_migrations ORDER BY version"
        )
        defer { statement.finalize() }
        var rows: [(Int, String, String)] = []
        while try statement.step() {
            rows.append((try statement.int(0), try statement.text(1), try statement.text(2)))
        }
        return rows
    }

    // MARK: - store_meta

    func meta(_ key: String) throws -> String? {
        guard storeVersion >= 2 else { return nil }
        let statement = try connection.prepare("SELECT value FROM store_meta WHERE key = ?")
        defer { statement.finalize() }
        statement.bind(1, text: key)
        guard try statement.step() else { return nil }
        return try statement.text(0)
    }

    func setMeta(_ key: String, _ value: String?) throws {
        guard storeVersion >= 2 else { return }
        if let value {
            let statement = try connection.prepare(
                "INSERT INTO store_meta (key, value) VALUES (?, ?) "
                    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )
            defer { statement.finalize() }
            statement.bind(1, text: key)
            statement.bind(2, text: value)
            try statement.run()
        } else {
            let statement = try connection.prepare("DELETE FROM store_meta WHERE key = ?")
            defer { statement.finalize() }
            statement.bind(1, text: key)
            try statement.run()
        }
    }

    // MARK: - Counting

    /// Live rows in a table -- tombstones excluded, because the count goes
    /// through the view.
    ///
    /// The name is CHECKED against the schema's own list before it is
    /// interpolated. SQLite has no way to bind a table name, so the only safe
    /// version of this function is one that will not accept a name the schema
    /// does not already know.
    public func liveCount(_ table: String) throws -> Int {
        try requireKnownTable(table)
        let source = StoreSchema.tombstonedTables.contains(table) ? "live_\(table)" : table
        return Int(try connection.scalarInt("SELECT count(*) FROM \(source)") ?? 0)
    }

    public func deletedCount(_ table: String) throws -> Int {
        guard StoreSchema.tombstonedTables.contains(table) else { return 0 }
        return Int(try connection.scalarInt(
            "SELECT count(*) FROM \(table) WHERE deleted_at IS NOT NULL"
        ) ?? 0)
    }

    private func requireKnownTable(_ table: String) throws {
        guard StoreSchema.allTables.contains(table) else {
            throw StoreError.corrupt("\"\(table)\" is not a table in this schema")
        }
    }

    /// Does this store already hold a book? Asked before a restore is allowed
    /// to replace one.
    public func isEmpty() throws -> Bool {
        for table in StoreSchema.tombstonedTables {
            if try connection.scalarInt("SELECT count(*) FROM \(table)") ?? 0 > 0 { return false }
        }
        return try connection.scalarInt("SELECT count(*) FROM settings") ?? 0 == 0
    }

    // MARK: - Soft delete
    //
    // THE ONLY DELETE THIS PACKAGE OFFERS FOR A LEDGER ROW. There is no
    // `hardDelete`, and its absence is the design (StoreSchema.swift carries
    // the finding it came from: a CloudKit delete carries no change tag, gets
    // no conflict protection, and loses an offline device's edit with no error
    // at all). Deleting is a SAVE of a tombstone, so that when sync does
    // arrive, a deletion is an ordinary conflict-protected record change.

    /// Tombstone a row. Idempotent: an already-deleted row keeps its ORIGINAL
    /// timestamp, because when it was deleted is a fact and re-stamping it
    /// would quietly move it.
    @discardableResult
    public func softDelete(table: String, id: String, at timestamp: String) throws -> Bool {
        try requireTombstoned(table)
        let statement = try connection.prepare(
            "UPDATE \(table) SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL"
        )
        defer { statement.finalize() }
        statement.bind(1, text: timestamp)
        statement.bind(2, text: id)
        try statement.run()
        return sqlite3_changes(connection.handle) > 0
    }

    /// Bring a tombstoned row back. The other half of why tombstones are kept:
    /// an undo is possible precisely because nothing was destroyed.
    @discardableResult
    public func undelete(table: String, id: String) throws -> Bool {
        try requireTombstoned(table)
        let statement = try connection.prepare(
            "UPDATE \(table) SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL"
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        try statement.run()
        return sqlite3_changes(connection.handle) > 0
    }

    /// The tombstoned ids in a table, with when each was deleted.
    public func tombstones(table: String) throws -> [(id: String, deletedAt: String)] {
        try requireTombstoned(table)
        let statement = try connection.prepare(
            "SELECT id, deleted_at FROM \(table) WHERE deleted_at IS NOT NULL ORDER BY id"
        )
        defer { statement.finalize() }
        var rows: [(String, String)] = []
        while try statement.step() {
            rows.append((try statement.text(0), try statement.text(1)))
        }
        return rows
    }

    private func requireTombstoned(_ table: String) throws {
        guard StoreSchema.tombstonedTables.contains(table) else {
            throw StoreError.corrupt(
                "\"\(table)\" is not a table with tombstones; deletable tables are "
                    + StoreSchema.tombstonedTables.joined(separator: ", ")
            )
        }
    }

    // MARK: - The money audit

    /// Walk every money column and report anything that is not stored as an
    /// integer.
    ///
    /// EXPECTED TO BE EMPTY, ALWAYS, and that is the point of having it. With
    /// `ANY` + a typeof CHECK in a STRICT table there is no SQL that can put a
    /// float in one of these columns -- so this is a check on the ASSUMPTIONS,
    /// not on the writers. It is what would catch a table rebuilt by a future
    /// migration that dropped the CHECK, a store handed over by another tool, or
    /// a route nobody has thought of yet. Cheap enough to run inside every
    /// import, which is where it runs.
    ///
    /// `columns` is a seam for the tests, which point it at a deliberately
    /// unprotected table to prove the audit can actually SEE a float -- a check
    /// that never fires and has never been shown to fire is not a check.
    public func auditMoneyColumns(
        _ columns: [(table: String, column: String)] = StoreSchema.moneyColumns
    ) throws -> [StoreError] {
        var problems: [StoreError] = []
        for (table, column) in columns {
            // Row identity: `id` where there is one, and the parent plus the
            // position where the row IS its position in its parent.
            let hasId = try connection.scalarInt(
                "SELECT count(*) FROM pragma_table_info('\(table)') WHERE name = 'id'"
            ) ?? 0
            let identity = hasId > 0
                ? "id"
                : (table == "transaction_splits" ? "transaction_id || '#' || position" : "rowid")
            let statement = try connection.prepare(
                "SELECT \(identity), typeof(\(column)) FROM \(table) "
                    + "WHERE \(column) IS NOT NULL AND typeof(\(column)) <> 'integer'"
            )
            defer { statement.finalize() }
            while try statement.step() {
                problems.append(
                    .moneyIsNotAnInteger(
                        table: table, column: column,
                        id: try statement.text(0), found: try statement.text(1)
                    )
                )
            }
        }
        return problems
    }

    /// `PRAGMA integrity_check`, verbatim. "ok" means SQLite believes the file.
    public func integrityCheck() throws -> String {
        try connection.scalarText("PRAGMA integrity_check") ?? "unknown"
    }
}
