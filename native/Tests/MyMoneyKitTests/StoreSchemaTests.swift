// What the schema promises, asserted against the schema SQLite actually built.
//
// Every check here reads the LIVE database rather than the DDL string, because
// the failure worth catching is the one where the two have drifted -- a table
// added to a migration without STRICT, a money column added without being
// listed, a view left behind by an ALTER.
import Foundation
import Testing

@testable import MyMoneyKit

struct StoreSchemaTests {

    // MARK: - STRICT everywhere

    @Test("every table is STRICT, because affinity is a preference and STRICT is a rule")
    func everyTableIsStrict() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let statement = try store.connection.prepare(
            "SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND type = 'table' "
                + "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        defer { statement.finalize() }
        var checked = 0
        while try statement.step() {
            let name = try statement.text(0)
            #expect(
                try statement.flag(1),
                "\(name) is not STRICT: an INTEGER column there would accept the string '100' and store it silently as 100"
            )
            checked += 1
        }
        // Every table the schema declares, and no others.
        #expect(checked == StoreSchema.allTables.count)
    }

    @Test("every money column is ANY with a typeof CHECK, which is the strict form")
    func moneyColumnsAreIntegers() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()

        for (table, column) in StoreSchema.moneyColumns {
            let statement = try store.connection.prepare(
                "SELECT type FROM pragma_table_info('\(table)') WHERE name = '\(column)'"
            )
            defer { statement.finalize() }
            #expect(try statement.step(), "\(table).\(column) does not exist")
            // ANY, not INTEGER, and StoreSchema's header says why at length: in
            // a STRICT table ANY is the only column type that applies no
            // affinity conversion, which is what lets the CHECK below see what
            // was actually passed rather than what affinity already made of it.
            #expect(
                try statement.text(0) == "ANY",
                "\(table).\(column) is not ANY -- an INTEGER column silently accepts the float 100.0"
            )
            let ddl = try store.connection.scalarText(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '\(table)'"
            )
            #expect(
                ddl?.contains("typeof(\(column)) = 'integer'") == true,
                "\(table).\(column) is ANY with no typeof CHECK, which really would be untyped"
            )
        }

        // The other half of the promise: a money column added to the schema
        // without being added to `moneyColumns` is a column the audit does not
        // walk. The naming convention is what makes that checkable.
        let listed = Set(StoreSchema.moneyColumns.map { "\($0.table).\($0.column)" })
        let statement = try store.connection.prepare(
            "SELECT m.name, i.name FROM pragma_table_list m "
                + "JOIN pragma_table_info(m.name) i "
                + "WHERE m.schema = 'main' AND m.type = 'table' AND i.name LIKE '%\\_minor' ESCAPE '\\'"
        )
        defer { statement.finalize() }
        var found: Set<String> = []
        while try statement.step() {
            found.insert("\(try statement.text(0)).\(try statement.text(1))")
        }
        #expect(found == listed, "a *_minor column exists that StoreSchema.moneyColumns omits")
    }

    @Test("the only REAL columns are the two that are not money")
    func realColumnsAreNamed() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let statement = try store.connection.prepare(
            "SELECT m.name, i.name FROM pragma_table_list m "
                + "JOIN pragma_table_info(m.name) i "
                + "WHERE m.schema = 'main' AND m.type = 'table' AND i.type = 'REAL' "
                + "ORDER BY m.name, i.name"
        )
        defer { statement.finalize() }
        var found: [String] = []
        while try statement.step() {
            found.append("\(try statement.text(0)).\(try statement.text(1))")
        }
        #expect(
            found.sorted() == StoreSchema.realColumns.map { "\($0.table).\($0.column)" }.sorted(),
            "a REAL column appeared that StoreSchema.realColumns does not account for. If it holds money, it is a bug; if it does not, name it there and say why."
        )
    }

    // MARK: - Tombstones and the live views

    @Test("every deletable table has a tombstone column and a live_ view that filters it")
    func tombstonesAndViews() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        for table in StoreSchema.tombstonedTables {
            let column = try store.connection.scalarInt(
                "SELECT count(*) FROM pragma_table_info('\(table)') WHERE name = 'deleted_at'"
            )
            #expect(column == 1, "\(table) has no deleted_at")

            let view = try store.connection.scalarText(
                "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'live_\(table)'"
            )
            #expect(view != nil, "live_\(table) does not exist")
            #expect(
                view?.contains("deleted_at IS NULL") == true,
                "live_\(table) does not filter tombstones, which is the only reason it exists"
            )
        }
    }

    @Test("the child tables carry no tombstone, because they are parts and not rows")
    func childTablesHaveNoTombstone() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        for table in StoreSchema.childTables {
            let column = try store.connection.scalarInt(
                "SELECT count(*) FROM pragma_table_info('\(table)') WHERE name = 'deleted_at'"
            )
            #expect(
                column == 0,
                "\(table) grew a tombstone. Removing a split is an EDIT of its transaction; the transaction is what carries the tombstone."
            )
        }
    }

    // MARK: - Migrations

    @Test("a fresh store is at the current version and records every step it applied")
    func freshStoreRecordsItsMigrations() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        #expect(store.storeVersion == StoreSchema.version)
        let applied = try store.appliedMigrations()
        #expect(applied.map(\.version) == StoreSchema.all.map(\.version))
        #expect(applied.map(\.name) == StoreSchema.all.map(\.name))
        for row in applied { #expect(!row.appliedAt.isEmpty) }
    }

    @Test("A STORE AT THE OLDER SCHEMA OPENS, UPGRADES, AND KEEPS ITS MONEY EXACT")
    func olderSchemaOpensAndUpgrades() throws {
        let scratch = try ScratchDirectory()
        let path = scratch.file("old.sqlite").path

        // ── Build a store the way the PREVIOUS version of this build would
        //    have: migration 1 only. It has the ledger tables and the
        //    tombstones, and it has neither store_meta nor any of the indexes.
        let book: Book
        do {
            let old = try LedgerStore.open(path: path, upTo: 1)
            #expect(old.storeVersion == 1)
            #expect(
                try old.connection.scalarInt(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_meta'"
                ) == 0,
                "migration 1 must not already have store_meta, or there is nothing to upgrade"
            )
            #expect(
                try old.connection.scalarInt(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'index' "
                        + "AND name = 'idx_transactions_dedupe'"
                ) == 0
            )
            book = try StoreFixture.imported().book
            try old.writeBook(book)
            old.close()
        }

        // ── Now open it the way THIS build does.
        let upgraded = try LedgerStore.open(path: path)
        #expect(upgraded.storeVersion == StoreSchema.version)

        // The upgrade is recorded, and only the missing step ran.
        let applied = try upgraded.appliedMigrations()
        #expect(applied.map(\.version) == StoreSchema.all.map(\.version))

        // The things migration 2 exists to add are there.
        #expect(
            try upgraded.connection.scalarInt(
                "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_meta'"
            ) == 1
        )
        #expect(
            try upgraded.connection.scalarInt(
                "SELECT count(*) FROM sqlite_master WHERE type = 'index' "
                    + "AND name = 'idx_transactions_dedupe'"
            ) == 1
        )

        // AND THE BOOK IS UNTOUCHED. Not "still there" -- identical, record for
        // record, which is the only version of that claim worth making.
        expectSameBook(try upgraded.book(), book.sortedById(), "after upgrade:")

        // Including every amount, read back through the accessor that refuses
        // anything that is not an integer.
        #expect(try upgraded.auditMoneyColumns().isEmpty)

        // And an import into the upgraded store now records provenance, which
        // is the capability the upgrade was for.
        try upgraded.importBackup(text: StoreFixture.backupText, replacingExistingBook: true)
        #expect(try upgraded.provenance().contentHash != nil)
        #expect(try upgraded.reproducesSourceFile())
    }

    @Test("a store from a NEWER build is refused, not opened and misread")
    func newerStoreIsRefused() throws {
        let scratch = try ScratchDirectory()
        let path = scratch.file("future.sqlite").path
        do {
            let store = try scratch.store("future.sqlite")
            try store.connection.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) "
                    + "VALUES (\(StoreSchema.version + 1), 'from the future', '2027-01-01T00:00:00.000Z')"
            )
            store.close()
        }
        #expect(throws: StoreError.self) { _ = try LedgerStore.open(path: path) }
        // And the message says what to do rather than what went wrong.
        do {
            _ = try LedgerStore.open(path: path)
            Issue.record("opening a newer store must throw")
        } catch let error as StoreError {
            #expect(String(describing: error).contains("Update the app"))
            #expect(String(describing: error).contains("Nothing was changed"))
        }
    }

    @Test("integrity_check is clean on a store that has just taken a book")
    func integrityIsClean() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        #expect(try store.integrityCheck() == "ok")
    }
}
