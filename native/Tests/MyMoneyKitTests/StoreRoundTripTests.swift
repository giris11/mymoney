// THE PROPERTY THE STORE IS JUDGED ON: a backup goes in, the same backup comes
// out.
//
// Not "an equivalent backup" -- the SAME ONE, to the canonical content hash.
// That single statement covers both halves of the risk at once: the store lost
// nothing (or a field would be missing) and invented nothing (or a field would
// have appeared). Two books can agree about every balance and disagree about a
// field, and it is the field that gets lost in a migration.
//
// The fixture is BackupWriterTests', reused deliberately: it was built to hold
// one of everything a writer can quietly get wrong, and those are the same
// things a store can quietly get wrong. Every figure in it is invented.
import Foundation
import Testing

@testable import MyMoneyKit

struct StoreRoundTripTests {

    // MARK: - The property

    @Test("A BACKUP IMPORTED AND RE-EXPORTED HAS THE SAME CONTENT HASH")
    func roundTripReproducesTheHash() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let result = try store.importBackup(text: StoreFixture.backupText)

        #expect(result.reproducesSource, "warnings: \(result.warnings)")
        #expect(result.roundTripContentHash == result.sourceContentHash)
        #expect(try store.reproducesSourceFile())

        // And to the byte, not merely to the hash -- a hash comparison that
        // passed on two different strings would be a much more interesting bug.
        #expect(try store.exportReproducingSourceText() == BackupWriter.serialise(
            try BackupWriter.file(
                try StoreFixture.imported().book,
                exportedAt: BackupWriterTests.exportedAt,
                schemaVersion: 1
            )
        ))
    }

    @Test("the property survives closing the database and opening it again")
    func roundTripSurvivesAReopen() throws {
        let scratch = try ScratchDirectory()
        let hash: String
        do {
            let store = try scratch.store()
            hash = try store.importBackup(text: StoreFixture.backupText).sourceContentHash
            store.close()
        }
        // A different process would see this. Nothing is carried over in memory.
        let reopened = try scratch.store()
        #expect(try reopened.exportReproducingSourceHash() == hash)
        #expect(try reopened.provenance().contentHash == hash)
    }

    @Test("the book read back out is the book that went in, record for record")
    func theBookIsUnchanged() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let source = try StoreFixture.imported().book
        try store.importBackup(text: StoreFixture.backupText)
        expectSameBook(try store.book(), source.sortedById())
    }

    @Test("balances recomputed FROM THE STORE agree with the file's own manifest")
    func balancesFromTheStore() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let result = try store.importBackup(text: StoreFixture.backupText)
        let claimed = try #require(result.imported.claimedManifest)

        // Through Balances, the app's own code, on rows that came out of SQLite
        // rather than out of the JSON -- which is what makes this a statement
        // about the STORE and not about the parser.
        var byId: [String: Int64] = [:]
        for balance in try store.book().accountBalances() {
            byId[balance.account.id] = balance.balanceMinor
        }
        for account in claimed.accounts {
            #expect(byId[account.id] == account.closingBalanceMinor, "\(account.id)")
        }
        #expect(try store.book().netWorth().totalBaseMinor == claimed.netWorth.totalMinor)
    }

    // MARK: - The three things a store loses if nobody is looking

    @Test("excludeFromNetWorth keeps all THREE of its states: absent, false, true")
    func triStateFlagSurvives() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)

        let accounts = try store.book().accounts
        // The fixture states one of each on purpose.
        #expect(accounts.first { $0.id == "w-a" }?.excludeFromNetWorth == nil)
        #expect(accounts.first { $0.id == "w-b" }?.excludeFromNetWorth == false)
        #expect(accounts.first { $0.id == "w-c" }?.excludeFromNetWorth == true)

        // In the column itself: NULL, 0, 1 -- not two states and a default.
        #expect(try store.connection.scalarText("SELECT typeof(exclude_from_net_worth) FROM accounts WHERE id = 'w-a'") == "null")
        #expect(try store.connection.scalarInt("SELECT exclude_from_net_worth FROM accounts WHERE id = 'w-b'") == 0)
        #expect(try store.connection.scalarInt("SELECT exclude_from_net_worth FROM accounts WHERE id = 'w-c'") == 1)

        // And on the way out, the row that omitted the key still omits it,
        // while the row that said `false` still says `false`. Collapsing those
        // two would change the content hash of a book nobody edited.
        let tables = try #require(try store.exportReproducingSource()["tables"]?["accounts"]?.arrayValue)
        let rows = Dictionary(uniqueKeysWithValues: tables.map { ($0["id"]?.stringValue ?? "", $0) })
        #expect(rows["w-a"]?["excludeFromNetWorth"] == nil)
        #expect(rows["w-b"]?["excludeFromNetWorth"] == .bool(false))
        #expect(rows["w-c"]?["excludeFromNetWorth"] == .bool(true))
    }

    @Test("an ABSENT id list stays absent and an EMPTY one stays empty")
    func absentAndEmptyArraysAreDifferent() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)

        let batches = try store.book().importBatches
        let csv = try #require(batches.first { $0.id == "ib1" })
        let sample = try #require(batches.first { $0.id == "ib2" })

        // ib1 is an ordinary CSV import: the two sample-only lists are ABSENT.
        #expect(csv.createdBudgetIds == nil)
        #expect(csv.createdFxRateIds == nil)
        // ...and its five required lists are PRESENT and mostly empty.
        #expect(csv.createdAccountIds == [])
        #expect(csv.createdPayeeIds == ["p1"])
        // ib2 is the sample batch, and states both.
        #expect(sample.createdBudgetIds == ["b1"])
        #expect(sample.createdFxRateIds == ["EUR:GBP"])

        // The column distinguishes them: NULL versus the text '[]'.
        #expect(try store.connection.scalarText("SELECT typeof(created_budget_ids) FROM import_batches WHERE id = 'ib1'") == "null")
        #expect(try store.connection.scalarText("SELECT created_account_ids FROM import_batches WHERE id = 'ib1'") == "[]")
    }

    @Test("the device-local half of the settings row survives untouched")
    func unmodelledSettingsKeysSurvive() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)

        let settings = try #require(try store.book().settings)
        // This package models none of these -- they belong to the device, not
        // to the book -- and a backup's hash covers all of them.
        let carried = BackupWriter.unmodelledSettingsKeys(settings)
        #expect(carried.contains("syncDeviceId"))
        #expect(carried.contains("syncLocalRevision"))
        #expect(settings.raw["syncDeviceName"] == .string("Laptop"))
        #expect(settings.raw["syncLocalRevision"] == .int(3))

        // The savedMappings map, which src/backup/canonical.ts singles out
        // because an all-digits key is where a naive key sort goes wrong.
        #expect(settings.savedMappings.keys.sorted() == ["12345", "abc"])
        #expect(settings.savedMappings["12345"]?.dateFormat == "DMY")

        // The typed columns beside `row_json` are an index, not a second truth
        // -- but a stale index is a lie even when nothing reads it.
        #expect(try store.connection.scalarText("SELECT base_currency FROM settings") == settings.baseCurrency)
        #expect(try store.connection.scalarText("SELECT theme FROM settings") == settings.theme.rawValue)
        #expect(try store.connection.scalarInt("SELECT onboarded FROM settings") == 1)
    }

    @Test("split and tag ORDER is preserved, because order is data")
    func childOrderIsPreserved() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        let tx = try #require(try store.book().transactions.first { $0.id == "t1" })

        // The fixture's t1 has two splits: -1000 with notes, then -1500 without.
        // Reversed, the book means the same and the FILE does not.
        #expect(tx.splits.map(\.amountMinor) == [-1000, -1500])
        #expect(tx.splits.map(\.notes) == ["half", nil])
        #expect(tx.splits.map(\.categoryId) == ["c-food", nil])
        #expect(tx.tagIds == ["tg1"])
        // And they sum exactly to the parent, which is SPEC 6 and is checked
        // here on rows that came back out of SQLite.
        #expect(try tx.validateSplits())
    }

    // MARK: - The manifest version, which is the penny

    @Test("A v1 FILE COMES BACK AS A v1 FILE, BYTE FOR BYTE")
    func v1ManifestIsReproducedNotUpgraded() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let text = try StoreFixture.v1BackupText()
        let result = try store.importBackup(text: text)

        #expect(result.reproducesSource, "warnings: \(result.warnings)")
        #expect(try store.provenance().manifestVersion == 1)

        // The file on disk carries one trailing newline that the serialiser
        // does not write; everything before it must match exactly.
        #expect(try store.exportReproducingSourceText() + "\n" == text)

        // The figure the two rules disagree about: 1198 per account, 1199 per
        // currency. The store re-exports the file's own answer.
        let reproduced = try store.exportReproducingSource()
        #expect(reproduced["manifest"]?["manifestVersion"] == .int(1))
        #expect(reproduced["manifest"]?["netWorth"]?["totalMinor"]
            == .int(ManifestVersionTests.perAccountTotal))
    }

    @Test("...while what THIS BUILD would write today is the v2 answer, deliberately")
    func todaysExportUsesTodaysRule() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: try StoreFixture.v1BackupText())

        let today = try store.exportBackupFile(exportedAt: "2026-09-02T00:00:00.000Z")
        #expect(today["manifest"]?["manifestVersion"] == .int(Int64(Manifest.version)))
        #expect(today["manifest"]?["netWorth"]?["totalMinor"]
            == .int(ManifestVersionTests.perCurrencyTotal))
        // Every row is identical between the two exports; only the manifest --
        // and only that one integer in it -- moved. A headline figure that
        // moves across a round trip looks exactly like corruption, which is why
        // the version sits beside it saying which of the two it is.
        #expect(today["tables"] == (try store.exportReproducingSource())["tables"])

        // And the file it just wrote is one an importer accepts, checked
        // against the v2 rule this time because that is what it now says it is.
        let again = try BackupImporter.load(text: BackupWriter.serialise(today))
        #expect(again.verified)
        #expect(again.recomputedManifest?.netWorth.totalMinor == ManifestVersionTests.perCurrencyTotal)
    }

    @Test("a store loaded twice ends up with the second file, not a mixture")
    func reimportReplacesRatherThanMerges() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        let v1 = try StoreFixture.v1BackupText()
        try store.importBackup(text: v1, replacingExistingBook: true)

        #expect(try store.exportReproducingSourceText() + "\n" == v1)
        // No row of the first book is left behind anywhere -- including in the
        // child tables, which is where a partial replace would show first.
        #expect(try store.connection.scalarInt("SELECT count(*) FROM transaction_splits") == 0)
        #expect(try store.connection.scalarInt("SELECT count(*) FROM accounts WHERE id LIKE 'w-%'") == 0)
    }

    // MARK: - Tombstones and the file

    @Test("a soft-deleted row leaves the export and stays in the store")
    func tombstonesAreNotExported() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let before = try store.importBackup(text: StoreFixture.backupText).sourceContentHash

        try store.softDelete(table: "transactions", id: "t2", at: "2026-09-02T09:00:00.000Z")

        // Gone from the book, gone from the file...
        #expect(try store.book().transactions.map(\.id) == ["t1"])
        #expect(try store.exportReproducingSourceHash() != before)
        #expect(try !store.reproducesSourceFile())

        // ...and still in the database, which is the entire point. The backup
        // format has no way to say "deleted", so the file describes what the
        // book IS and the store additionally remembers what it WAS.
        #expect(try store.connection.scalarInt("SELECT count(*) FROM transactions WHERE id = 't2'") == 1)
        #expect(try store.book(includingDeleted: true).transactions.count == 2)

        // Undo puts it back, and the file is the file again.
        #expect(try store.undelete(table: "transactions", id: "t2"))
        #expect(try store.exportReproducingSourceHash() == before)
    }
}
