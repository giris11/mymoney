// ALL OR NOTHING, PROVED BY BREAKING IT ON PURPOSE.
//
// D21 says an import is all-or-nothing. Every test here injects a real failure
// -- partway through the write, with rows already inserted -- and then asks the
// only question that matters: what does the store contain now?
//
// Three different observers, because "it rolled back" can be true of one and
// false of another:
//
//   1. THE SAME CONNECTION, after the throw. The obvious one.
//   2. A SECOND CONNECTION, WHILE THE IMPORT IS STILL RUNNING. A reader must
//      never see a half-applied book, not for a moment. This is the one a
//      transaction is actually for.
//   3. THE FILES ON DISK, COPIED MID-TRANSACTION -- which is what a power cut
//      leaves behind. Opening that copy afterwards must show the OLD book.
//
// The fixtures are the two fabricated books this suite already has. No real
// figure appears here.
import Foundation
import Testing

@testable import MyMoneyKit

struct StoreAtomicityTests {

    /// A failure with a recognisable name, injected mid-write.
    struct InjectedFailure: Error {
        let afterTable: String
    }

    // MARK: - 1. The failure rolls back

    @Test("A FAILURE PARTWAY THROUGH AN IMPORT LEAVES THE STORE COMPLETELY EMPTY")
    func failedImportIntoAnEmptyStoreLeavesNothing() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let imported = try StoreFixture.imported()

        var written: [String] = []
        #expect(throws: InjectedFailure.self) {
            try store.importBackup(
                imported: imported,
                replacingExistingBook: false,
                requiringExactRoundTrip: false,
                afterEachTable: { table in
                    written.append(table)
                    // Fail late enough that a great deal has been inserted --
                    // accounts, categories, payees -- so a rollback that did
                    // not work would be obvious rather than subtle.
                    if table == "budgets" { throw InjectedFailure(afterTable: table) }
                }
            )
        }
        // The failure happened where it was meant to, after real work: six
        // whole tables were already in before the seventh threw.
        #expect(written == Array(StoreSchema.tombstonedTables.prefix(7)))
        #expect(written.last == "budgets")

        // And NOTHING survived it. Every table, tombstones included, and the
        // child tables where a partial write would show first.
        #expect(try store.isEmpty())
        for table in StoreSchema.allTables where table != "schema_migrations" {
            #expect(
                try store.connection.scalarInt("SELECT count(*) FROM \(table)") == 0,
                "\(table) kept rows from a failed import"
            )
        }
        #expect(try store.provenance().isEmpty)
    }

    @Test("A FAILURE WHILE REPLACING A BOOK LEAVES THE PREVIOUS BOOK EXACTLY AS IT WAS")
    func failedReplaceKeepsTheOldBook() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()

        // The book that must survive.
        let firstText = try StoreFixture.v1BackupText()
        let first = try store.importBackup(text: firstText)
        let hashBefore = first.sourceContentHash

        // A replacement that dies after the transactions have been written --
        // the biggest table, and the last one before settings.
        #expect(throws: InjectedFailure.self) {
            try store.importBackup(
                imported: try StoreFixture.imported(),
                replacingExistingBook: true,
                requiringExactRoundTrip: false,
                afterEachTable: { table in
                    if table == "transactions" { throw InjectedFailure(afterTable: table) }
                }
            )
        }

        // Byte for byte the file it started as. Not "the right number of rows"
        // -- the same file.
        #expect(try store.exportReproducingSourceText() + "\n" == firstText)
        #expect(try store.exportReproducingSourceHash() == hashBefore)
        #expect(try store.provenance().contentHash == hashBefore)
        #expect(try store.integrityCheck() == "ok")
    }

    @Test("the rollback survives closing the database and opening it again")
    func rollbackSurvivesAReopen() throws {
        let scratch = try ScratchDirectory()
        let path = scratch.file("ledger.sqlite").path
        let firstText = try StoreFixture.v1BackupText()
        do {
            let store = try LedgerStore.open(path: path)
            try store.importBackup(text: firstText)
            #expect(throws: InjectedFailure.self) {
                try store.importBackup(
                    imported: try StoreFixture.imported(),
                    replacingExistingBook: true,
                    requiringExactRoundTrip: false,
                    afterEachTable: { if $0 == "accounts" { throw InjectedFailure(afterTable: $0) } }
                )
            }
            store.close()
        }
        // A fresh process would see this.
        let reopened = try LedgerStore.open(path: path)
        #expect(try reopened.exportReproducingSourceText() + "\n" == firstText)
    }

    // MARK: - 2. Nobody ever sees a half-applied book

    @Test("A CONCURRENT READER NEVER SEES A HALF-WRITTEN IMPORT, NOT EVEN FOR A MOMENT")
    func aReaderNeverSeesAPartialImport() throws {
        let scratch = try ScratchDirectory()
        let path = scratch.file("ledger.sqlite").path
        let store = try LedgerStore.open(path: path)
        try store.importBackup(text: try StoreFixture.v1BackupText())
        let accountsBefore = try store.liveCount("accounts")
        let transactionsBefore = try store.liveCount("transactions")

        // A SECOND connection, read-only, opened DURING the write. In WAL mode
        // a reader sees the last committed snapshot and the writer does not
        // block it -- so if the import were visible early, this would see it.
        var observations: [(String, Int64, Int64)] = []
        try store.importBackup(
            imported: try StoreFixture.imported(),
            replacingExistingBook: true,
            requiringExactRoundTrip: false,
            afterEachTable: { table in
                let reader = try SQLiteConnection(path: path, readOnly: true)
                observations.append(
                    (
                        table,
                        try reader.scalarInt("SELECT count(*) FROM accounts") ?? -1,
                        try reader.scalarInt("SELECT count(*) FROM transactions") ?? -1
                    )
                )
            }
        )

        // Every table, in the order the schema declares them -- which pins the
        // write order to StoreSchema.tombstonedTables rather than to a list
        // repeated here that could drift away from it.
        #expect(observations.map(\.0) == StoreSchema.tombstonedTables + ["settings"])
        for (table, accounts, transactions) in observations {
            // The OLD book, unchanged, at every single step -- including after
            // the point where the new accounts and the new transactions had
            // already been inserted.
            #expect(accounts == Int64(accountsBefore), "accounts visible early, after \(table)")
            #expect(transactions == Int64(transactionsBefore), "transactions visible early, after \(table)")
        }

        // And once it commits, the new book appears all at once.
        #expect(try store.liveCount("accounts") == 3)
    }

    // MARK: - 3. The power cut

    @Test("A COPY OF THE FILES TAKEN MID-IMPORT OPENS AS THE OLD BOOK")
    func aCrashMidImportLosesNothing() throws {
        let scratch = try ScratchDirectory()
        let path = scratch.file("ledger.sqlite").path
        let snapshotDirectory = scratch.url.appendingPathComponent("snapshot")
        try FileManager.default.createDirectory(at: snapshotDirectory, withIntermediateDirectories: true)
        let snapshot = snapshotDirectory.appendingPathComponent("ledger.sqlite").path

        let store = try LedgerStore.open(path: path)
        let firstText = try StoreFixture.v1BackupText()
        try store.importBackup(text: firstText)

        // Import a different book, and partway through -- after the accounts
        // and the transactions are in, but before COMMIT -- copy the database
        // and its write-ahead log somewhere else. That copy is, byte for byte,
        // what the machine would have on disk if the power went at that
        // instant: frames in the WAL with no commit frame after them.
        try store.importBackup(
            imported: try StoreFixture.imported(),
            replacingExistingBook: true,
            requiringExactRoundTrip: false,
            afterEachTable: { table in
                guard table == "transactions" else { return }
                for suffix in ["", "-wal", "-shm"] {
                    let from = path + suffix
                    guard FileManager.default.fileExists(atPath: from) else { continue }
                    try FileManager.default.copyItem(atPath: from, toPath: snapshot + suffix)
                }
            }
        )

        // The live store went on to commit the new book.
        #expect(try store.liveCount("accounts") == 3)

        // THE SNAPSHOT DID NOT. Opening it runs SQLite's own recovery, and what
        // comes back is the last committed state -- the whole of the first
        // book, and none of the second.
        let recovered = try LedgerStore.open(path: snapshot)
        #expect(try recovered.integrityCheck() == "ok")
        #expect(try recovered.exportReproducingSourceText() + "\n" == firstText)
        #expect(try recovered.auditMoneyColumns().isEmpty)
    }

    // MARK: - Refusing before writing at all

    @Test("a file that does not add up never reaches the database")
    func aBadFileIsRefusedBeforeAnyWrite() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: try StoreFixture.v1BackupText())
        let before = try store.exportReproducingSourceHash()

        // A manifest that disagrees with its own rows: one account's closing
        // balance moved by a penny. The importer must refuse this OUTRIGHT,
        // before the store is opened for writing at all.
        let doctored = StoreFixture.backupText.replacingOccurrences(
            of: "\"closingBalanceMinor\":97500", with: "\"closingBalanceMinor\":97501"
        )
        #expect(doctored != StoreFixture.backupText, "the doctoring must actually change the text")
        #expect(throws: BackupImportError.self) {
            try store.importBackup(text: doctored, replacingExistingBook: true)
        }
        #expect(try store.exportReproducingSourceHash() == before)

        // Same for a file that is not a backup at all.
        #expect(throws: BackupImportError.self) {
            try store.importBackup(text: "{\"app\":\"Something Else\"}", replacingExistingBook: true)
        }
        #expect(throws: BackupImportError.self) {
            try store.importBackup(text: "not json", replacingExistingBook: true)
        }
        #expect(try store.exportReproducingSourceHash() == before)
    }

    @Test("a restore refuses to overwrite an existing book unless told to")
    func restoreWillNotSilentlyReplace() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let firstText = try StoreFixture.v1BackupText()
        try store.importBackup(text: firstText)

        do {
            try store.importBackup(text: StoreFixture.backupText)
            Issue.record("a second restore must not go through unasked")
        } catch let error as StoreError {
            let message = String(describing: error)
            // The message says what is there, so the owner can decide.
            #expect(message.contains("already holds"))
            #expect(message.contains("Nothing was changed"))
        }
        #expect(try store.exportReproducingSourceText() + "\n" == firstText)
    }

    // MARK: - Strict round-trip mode

    @Test("requiringExactRoundTrip rolls back a file the store cannot reproduce")
    func strictRoundTripRefusesAndRollsBack() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let firstText = try StoreFixture.v1BackupText()
        try store.importBackup(text: firstText)

        // A row carrying a key no record type models. The file is PERFECTLY
        // VALID -- it imports, its manifest checks out, its balances are right
        // -- and this package cannot write it back out, because it does not
        // model `favourite`. That is a real limitation, stated by BackupWriter,
        // and it is exactly what the strict mode is for.
        let extended = StoreFixture.backupText.replacingOccurrences(
            of: "{\"id\":\"w-a\",\"name\":\"Alpha\"",
            with: "{\"id\":\"w-a\",\"favourite\":true,\"name\":\"Alpha\""
        )
        #expect(extended != StoreFixture.backupText)

        // Lenient (the default): it goes in, and says so out loud.
        let lenient = try store.importBackup(text: extended, replacingExistingBook: true)
        #expect(!lenient.reproducesSource)
        #expect(lenient.warnings.contains { $0.contains("re-exports to a different file") })
        #expect(lenient.warnings.contains { $0.contains("accounts differs") })

        // Strict: refused, and the book that was there is still there.
        try store.importBackup(text: firstText, replacingExistingBook: true)
        #expect(throws: StoreError.self) {
            try store.importBackup(
                text: extended, replacingExistingBook: true, requiringExactRoundTrip: true
            )
        }
        #expect(try store.exportReproducingSourceText() + "\n" == firstText)
    }

    @Test("strict mode refuses a file it cannot check, rather than calling it verified")
    func strictRoundTripRefusesAnUncheckableFile() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let firstText = try StoreFixture.v1BackupText()
        try store.importBackup(text: firstText)

        // A backup with NO manifest. Perfectly legal -- every file written
        // before the manifest existed looks like this, and so does every sync
        // snapshot -- and there is nothing in it for a round trip to be checked
        // against, because re-exporting it would ADD a manifest.
        let parsed = try JSONParser.parse(StoreFixture.backupText)
        var members = try #require(parsed.objectValue)
        members.removeValue(forKey: "manifest")
        let unmanifested = CanonicalJSON.text(.object(members), indent: 0)

        // Lenient: accepted, and it says out loud that it could not check.
        let lenient = try store.importBackup(text: unmanifested, replacingExistingBook: true)
        #expect(lenient.roundTripContentHash == nil)
        #expect(!lenient.reproducesSource)
        #expect(lenient.warnings.contains { $0.contains("no manifest this build can reproduce") })

        // Strict: refused. "Could not be checked" must never be reported as
        // "checked and fine".
        try store.importBackup(text: firstText, replacingExistingBook: true)
        #expect(throws: StoreError.self) {
            try store.importBackup(
                text: unmanifested, replacingExistingBook: true, requiringExactRoundTrip: true
            )
        }
        #expect(try store.exportReproducingSourceText() + "\n" == firstText)
    }

    @Test("a closed store throws instead of using a freed handle")
    func aClosedStoreRefusesToBeUsed() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        store.close()
        #expect(throws: StoreError.self) { _ = try store.book() }
        #expect(throws: StoreError.self) { _ = try store.liveCount("accounts") }
        // Idempotent: closing twice is not a double free.
        store.close()
    }
}
