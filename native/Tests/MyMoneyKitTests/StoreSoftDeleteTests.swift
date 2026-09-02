// Deleting is a SAVE, and the row is still there afterwards.
//
// WHY, because it is not obvious and the temptation to "clean up" will be
// strong: a CloudKit delete carries no change tag, gets no conflict protection,
// and loses an offline device's edit with no error at all. That was measured in
// the native project's Phase 1 against a real container. A row that is SAVED
// with a tombstone is an ordinary conflict-protected record change instead.
// Sync is not in this phase; the schema is shaped for it now because
// retrofitting tombstones over a hard-delete schema comes too late for every
// row deleted before the retrofit.
//
// So these tests are not about a feature. They are about the store still
// holding what it was told to forget.
import Foundation
import Testing

@testable import MyMoneyKit

struct StoreSoftDeleteTests {

    static let deletedAt = "2026-09-02T09:30:00.000Z"

    private func loaded() throws -> (ScratchDirectory, LedgerStore) {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        return (scratch, store)
    }

    @Test("DELETING A ROW DOES NOT REMOVE IT -- it stamps it and hides it")
    func deleteKeepsTheRow() throws {
        let (scratch, store) = try loaded()
        _ = scratch

        #expect(try store.softDelete(table: "accounts", id: "w-b", at: Self.deletedAt))

        // Hidden from every ordinary read...
        #expect(try store.liveCount("accounts") == 2)
        #expect(try store.book().accounts.map(\.id) == ["w-a", "w-c"])
        // ...and still, entirely, on disk.
        #expect(try store.connection.scalarInt("SELECT count(*) FROM accounts") == 3)
        #expect(try store.deletedCount("accounts") == 1)
        #expect(try store.connection.scalarText("SELECT deleted_at FROM accounts WHERE id = 'w-b'") == Self.deletedAt)
        // Including everything it was worth. A tombstone is not a redaction.
        #expect(try store.connection.scalarInt("SELECT opening_balance_minor FROM accounts WHERE id = 'w-b'") == 20000)
        #expect(try store.book(includingDeleted: true).accounts.map(\.id) == ["w-a", "w-b", "w-c"])
    }

    @Test("every deletable table can be tombstoned, and every one of them keeps the row")
    func everyTableRoundTrips() throws {
        let (scratch, store) = try loaded()
        _ = scratch

        let ids: [String: String] = [
            "account_groups": "g1",
            "accounts": "w-a",
            "categories": "c-food",
            "payees": "p1",
            "tags": "tg1",
            "import_batches": "ib1",
            "budgets": "b1",
            "fx_rates": "EUR:GBP",
            "transactions": "t1",
        ]
        #expect(Set(ids.keys) == Set(StoreSchema.tombstonedTables))

        for (table, id) in ids {
            let before = try store.connection.scalarInt("SELECT count(*) FROM \(table)")
            #expect(try store.softDelete(table: table, id: id, at: Self.deletedAt), "\(table)")
            #expect(try store.connection.scalarInt("SELECT count(*) FROM \(table)") == before, "\(table) lost a row")
            #expect(try store.liveCount(table) == Int((before ?? 0) - 1), "\(table) still shows it")
            #expect(try store.tombstones(table: table).map(\.id) == [id], "\(table)")
        }

        // And back again, all of them.
        for (table, id) in ids {
            #expect(try store.undelete(table: table, id: id), "\(table)")
        }
        expectSameBook(try store.book(), try StoreFixture.imported().book.sortedById())
    }

    @Test("deleting twice keeps the ORIGINAL timestamp, because when it happened is a fact")
    func deleteIsIdempotent() throws {
        let (scratch, store) = try loaded()
        _ = scratch

        #expect(try store.softDelete(table: "tags", id: "tg1", at: Self.deletedAt))
        // The second call changes nothing and says so.
        #expect(try store.softDelete(table: "tags", id: "tg1", at: "2027-01-01T00:00:00.000Z") == false)
        #expect(try store.connection.scalarText("SELECT deleted_at FROM tags WHERE id = 'tg1'") == Self.deletedAt)

        // Undeleting something that is not deleted likewise does nothing.
        #expect(try store.undelete(table: "tags", id: "tg1"))
        #expect(try store.undelete(table: "tags", id: "tg1") == false)
        // And an id that does not exist is not an error, it is a no-op.
        #expect(try store.softDelete(table: "tags", id: "nope", at: Self.deletedAt) == false)
    }

    @Test("a deleted transaction keeps its splits and its tags, in order")
    func childrenSurviveTheirParentsTombstone() throws {
        let (scratch, store) = try loaded()
        _ = scratch

        try store.softDelete(table: "transactions", id: "t1", at: Self.deletedAt)
        // The children are not tombstoned -- they are parts of a row, not rows
        // -- so they are simply still there, attached to a hidden parent.
        #expect(try store.connection.scalarInt("SELECT count(*) FROM transaction_splits WHERE transaction_id = 't1'") == 2)
        #expect(try store.connection.scalarInt("SELECT count(*) FROM transaction_tags WHERE transaction_id = 't1'") == 1)

        try store.undelete(table: "transactions", id: "t1")
        let tx = try #require(try store.book().transactions.first { $0.id == "t1" })
        #expect(tx.splits.map(\.amountMinor) == [-1000, -1500])
        #expect(tx.splits.map(\.notes) == ["half", nil])
        #expect(tx.tagIds == ["tg1"])
    }

    @Test("a tombstoned account leaves the balances, and comes back with its money intact")
    func tombstonesChangeTheArithmetic() throws {
        let (scratch, store) = try loaded()
        _ = scratch

        let before = try store.book().netWorth()
        // w-b is the counted EUR account: 17000 EUR at 0.85 = 14450 of the
        // 111950 total, so removing it must move the figure by exactly that.
        try store.softDelete(table: "accounts", id: "w-b", at: Self.deletedAt)
        let after = try store.book().netWorth()
        #expect(before.totalBaseMinor - after.totalBaseMinor == 14450)

        try store.undelete(table: "accounts", id: "w-b")
        #expect(try store.book().netWorth().totalBaseMinor == before.totalBaseMinor)
    }

    @Test("a table with no tombstones refuses the request rather than pretending")
    func nonDeletableTablesRefuse() throws {
        let (scratch, store) = try loaded()
        _ = scratch

        for table in ["settings", "transaction_splits", "schema_migrations", "nonsense"] {
            #expect(throws: StoreError.self, "\(table)") {
                try store.softDelete(table: table, id: "x", at: Self.deletedAt)
            }
        }
        do {
            try store.softDelete(table: "settings", id: "app", at: Self.deletedAt)
        } catch let error as StoreError {
            // The message lists what IS deletable, so the caller can fix it.
            #expect(String(describing: error).contains("transactions"))
        }
    }

    @Test("the live views are what does the filtering, not the call sites")
    func theViewsCarryTheClause() throws {
        let (scratch, store) = try loaded()
        _ = scratch

        try store.softDelete(table: "payees", id: "p1", at: Self.deletedAt)
        // Nothing in the reading code says `deleted_at IS NULL`; the view does.
        // A query written next year against `live_payees` cannot forget it.
        #expect(try store.connection.scalarInt("SELECT count(*) FROM live_payees") == 0)
        #expect(try store.connection.scalarInt("SELECT count(*) FROM payees") == 1)
    }
}
