// Changing the base currency after the first run, and the four things that
// must survive it.
//
// A FIRST-RUN CHOICE THAT CANNOT BE UNDONE IS A TRAP, which is the reason
// `setBaseCurrency` exists at all. This suite is about what it must NOT do
// while undoing it:
//
//   1. NOT TOUCH A SINGLE AMOUNT. Every account keeps its own currency, every
//      transaction keeps the currency it was entered in, and every stored
//      integer is the integer it was. Only the currency the TOTAL is reported
//      in moves.
//   2. NOT DROP THE `sync*` KEYS. The settings row carries a device-local half
//      this package deliberately does not model; a rewrite that lost it would
//      change the file a book exports and break the hash the import checks
//      itself against.
//   3. NOT LEAVE A GAP. There is exactly one settings row and it says what
//      currency the book's totals are in; the write is an upsert, so it is
//      never absent, not even inside the transaction.
//   4. NOT MISCOUNT. On an imported book this is one more change the web app
//      does not have; on a created book it is not a countable thing at all,
//      and asking for the currency the book already has is not a change of
//      anything.
//
// EVERY NAME AND FIGURE HERE IS INVENTED.
import Foundation
import Testing

@testable import MyMoneyKit

struct BaseCurrencyTests {

    static let now = "2026-09-02T09:00:00.000Z"

    static func createdStore(_ scratch: ScratchDirectory, currency: String = "GBP") throws
        -> LedgerStore
    {
        let store = try scratch.store("ledger.sqlite")
        store.environment = .fixed(now: now, idPrefix: "n")
        try store.createBook(baseCurrency: currency)
        return store
    }

    // MARK: - The change itself

    @Test("the base currency can be changed after the book exists")
    func changesIt() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.createdStore(scratch)
        #expect(try store.baseCurrency() == "GBP")

        let updated = try store.setBaseCurrency("EUR")

        #expect(updated.baseCurrency == "EUR")
        #expect(try store.baseCurrency() == "EUR")
        #expect(try store.book().baseCurrency == "EUR")
        // The row that comes back is the row that was STORED: its `raw` says
        // the new currency too, so a caller comparing the two halves of the
        // record does not find them disagreeing.
        #expect(updated.raw["baseCurrency"]?.stringValue == "EUR")
    }

    @Test("it is normalised and validated exactly as an account's currency is")
    func normalisesAndValidates() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.createdStore(scratch)

        #expect(try store.setBaseCurrency("  eur ").baseCurrency == "EUR")

        // Anything that is not three letters is refused, and the book is left
        // exactly as it was rather than half-changed.
        for bad in ["", "E", "EURO", "12", "E U", "\u{20AC}"] {
            #expect(throws: EditError.badCurrency(bad)) { try store.setBaseCurrency(bad) }
        }
        #expect(try store.baseCurrency() == "EUR")
    }

    @Test("NOTHING ELSE ON THE SETTINGS ROW MOVES, including the sync keys it does not model")
    func carriesEveryOtherField() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store("ledger.sqlite")
        store.environment = .fixed(now: Self.now, idPrefix: "n")
        // The fixture's settings row is the one in this suite that carries the
        // device-local `sync*` half.
        try store.importBackup(text: StoreFixture.backupText)
        let before = try #require(try store.readSettings())
        let unmodelled = BackupWriter.unmodelledSettingsKeys(before)
        #expect(!unmodelled.isEmpty, "the fixture is meant to carry sync keys")

        let after = try store.setBaseCurrency("JPY")

        #expect(after.baseCurrency == "JPY")
        #expect(after.id == before.id)
        #expect(after.schemaVersion == before.schemaVersion)
        #expect(after.theme == before.theme)
        #expect(after.lastBackupAt == before.lastBackupAt)
        #expect(after.onboarded == before.onboarded)
        #expect(after.lastUsedAccountId == before.lastUsedAccountId)
        #expect(after.savedMappings == before.savedMappings)
        #expect(after.createdAt == before.createdAt)
        #expect(after.autoFxEnabled == before.autoFxEnabled)
        #expect(after.lastFxSyncAt == before.lastFxSyncAt)
        #expect(after.lastFxSyncSource == before.lastFxSyncSource)
        // The half this package does not model, still there, still saying what
        // it said.
        #expect(BackupWriter.unmodelledSettingsKeys(after) == unmodelled)
        for key in unmodelled {
            #expect(after.raw[key] == before.raw[key], "sync key \(key)")
        }
    }

    @Test("NOT ONE STORED AMOUNT CHANGES, and no account is re-denominated")
    func touchesNoMoney() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store("ledger.sqlite")
        store.environment = .fixed(now: Self.now, idPrefix: "n")
        try store.importBackup(text: StoreFixture.backupText)
        let before = try store.book()

        try store.setBaseCurrency("JPY")
        let after = try store.book()

        #expect(after.accounts == before.accounts)
        #expect(after.transactions == before.transactions)
        #expect(after.fxRates == before.fxRates)
        #expect(after.budgets == before.budgets)
        // The ONE difference, and it is the label on the total rather than any
        // figure underneath it.
        #expect(after.baseCurrency == "JPY")
        #expect(before.baseCurrency != "JPY")
        // A store whose money columns had stopped being integers would be
        // caught here rather than by a wrong headline weeks later.
        #expect(try store.auditMoneyColumns().isEmpty)
    }

    @Test("the settings row is never absent, and there is never a second one")
    func staysASingleRow() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.createdStore(scratch)
        try store.setBaseCurrency("USD")
        try store.setBaseCurrency("INR")

        let statement = try store.connection.prepare("SELECT count(*) FROM settings")
        defer { statement.finalize() }
        #expect(try statement.step())
        #expect(try statement.int(0) == 1)
        #expect(try store.baseCurrency() == "INR")
    }

    @Test("it survives closing and reopening the store")
    func survivesAReopen() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.createdStore(scratch)
        try store.setBaseCurrency("LKR")
        store.close()

        let reopened = try scratch.store("ledger.sqlite")
        #expect(try reopened.baseCurrency() == "LKR")
    }

    // MARK: - What it counts

    @Test("ON AN IMPORTED BOOK it is one more change the web app does not have")
    func countsOnAnImportedBook() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store("ledger.sqlite")
        store.environment = .fixed(now: Self.now, idPrefix: "n")
        try store.importBackup(text: StoreFixture.backupText)
        #expect(try store.localEdits().count == 0)

        try store.setBaseCurrency("AUD")

        let edits = try store.localEdits()
        #expect(edits.count == 1)
        #expect(edits.origin == .imported)
        #expect(edits.firstAt == Self.now)
        #expect(edits.countLine == "1 change not in your web app")
    }

    @Test("ON A CREATED BOOK it counts nothing, because there is nothing to count against")
    func countsNothingOnACreatedBook() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.createdStore(scratch)

        try store.setBaseCurrency("AUD")

        let edits = try store.localEdits()
        #expect(edits.count == 0)
        #expect(edits.origin == .created)
        #expect(edits.countLine == nil)
        #expect(edits.summary == nil)
    }

    @Test("SETTING THE CURRENCY IT ALREADY HAS IS NOT A CHANGE, so nothing is counted")
    func askingForWhatItAlreadyHasCountsNothing() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store("ledger.sqlite")
        store.environment = .fixed(now: Self.now, idPrefix: "n")
        try store.importBackup(text: StoreFixture.backupText)
        let current = try #require(try store.baseCurrency())

        // Including the un-normalised spelling of it: what matters is the value
        // the book ends up with, not the characters that were typed.
        try store.setBaseCurrency(current.lowercased())

        #expect(try store.localEdits().count == 0)
        #expect(try store.baseCurrency() == current)
    }

    // MARK: - Nothing to change

    @Test("on a device with no book it refuses, and says what to do instead")
    func refusesWithNoBook() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store("ledger.sqlite")
        #expect(try store.isEmpty())

        #expect(throws: EditError.noBook) { try store.setBaseCurrency("GBP") }

        #expect(try store.isEmpty())
        #expect(try store.baseCurrency() == nil)
        // Both sentences, as every refusal in this package owes.
        #expect(EditError.noBook.problem.contains("no book on this device"))
        #expect(EditError.noBook.unchanged == "Nothing was changed.")
    }

    // MARK: - The file it exports

    @Test("A BOOK WHOSE BASE CURRENCY WAS CHANGED STILL EXPORTS A FILE THIS APP CAN READ BACK")
    func roundTripsAfterTheChange() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.createdStore(scratch, currency: "GBP")
        try store.setBaseCurrency("EUR")
        let text = try store.exportBackupText(exportedAt: Self.now)

        let second = try scratch.store("second.sqlite")
        second.environment = .fixed(now: Self.now, idPrefix: "m")
        // `requiringExactRoundTrip` makes the store prove it re-exports the
        // bytes it read: a settings row rewritten by this file that had lost a
        // field, or gained one, would fail here rather than quietly.
        try second.importBackup(text: text, requiringExactRoundTrip: true)

        #expect(try second.baseCurrency() == "EUR")
        expectSameBook(try second.book(), try store.book(), "after a base currency change")
    }
}
