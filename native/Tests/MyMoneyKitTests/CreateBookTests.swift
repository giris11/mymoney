// Starting a book here, and knowing afterwards that it started here.
//
// THE TWO PROPERTIES THIS SUITE EXISTS FOR, and neither is about a screen:
//
//   1. A BOOK CAN EXIST WITHOUT AN IMPORT, and when it does it is a whole book
//      -- a settings row, the same sixty-one categories the browser seeds, and
//      whatever accounts the owner accepted -- written in ONE commit, so there
//      is no half-created state to open the app into.
//
//   2. THE BOOK REMEMBERS WHERE IT CAME FROM, across relaunches, and the
//      local-copy wording is derived from that rather than decided by a view.
//      An imported book has a counterpart the web app still owns and its drift
//      is worth counting; a created book has no counterpart, so there is no
//      count and nothing to warn about. Telling somebody their web app holds
//      the real version of a book it has never seen would be a lie in the one
//      place this app promises not to tell one.
//
// EVERY NAME AND FIGURE HERE IS INVENTED. The seeded names are dictionary words
// out of the shared category tree; no real account, payee or amount appears.
import Foundation
import Testing

@testable import MyMoneyKit

struct CreateBookTests {

    static let now = "2026-09-02T09:00:00.000Z"

    /// An empty store with a pinned clock and counted ids.
    static func emptyStore(_ scratch: ScratchDirectory, name: String = "ledger.sqlite") throws
        -> LedgerStore
    {
        let store = try scratch.store(name)
        store.environment = .fixed(now: now, idPrefix: "n")
        return store
    }

    // MARK: - The book itself

    @Test("A BOOK CAN BE CREATED WITHOUT A BACKUP, and it is a whole book")
    func createsABook() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        #expect(try store.isEmpty())

        let created = try store.createBook(baseCurrency: "GBP")

        // The app's "do I have a book?" question now answers yes without an
        // import ever having run.
        #expect(!(try store.isEmpty()))
        #expect(created.baseCurrency == "GBP")
        #expect(created.categories.count == 61)

        // A settings row in the chosen currency, dated by the store's clock,
        // and already onboarded -- the whole of setting up was this one call.
        let settings = try #require(try store.readSettings())
        #expect(settings.id == "app")
        #expect(settings.baseCurrency == "GBP")
        #expect(settings.schemaVersion == Schema.version)
        #expect(settings.theme == .system)
        #expect(settings.onboarded)
        #expect(settings.createdAt == Self.now)
        #expect(settings.autoFxEnabled)
        #expect(settings.lastBackupAt == nil)
        #expect(settings.lastUsedAccountId == nil)
        #expect(settings.savedMappings.isEmpty)

        // AND NOTHING ELSE. A fresh book is a seed and a settings row: no
        // accounts, no transactions, no payees, no budgets, no invented
        // opening balance sitting under a total.
        #expect(try store.liveCount("categories") == 61)
        #expect(try store.liveCount("accounts") == 0)
        #expect(try store.liveCount("transactions") == 0)
        #expect(try store.liveCount("payees") == 0)
        #expect(try store.liveCount("budgets") == 0)
        #expect(try store.liveCount("account_groups") == 0)
        #expect(try store.liveCount("fx_rates") == 0)
        #expect(try store.liveCount("import_batches") == 0)
        #expect(try store.liveCount("tags") == 0)

        // Net worth on an empty book is zero in the currency that was chosen,
        // rather than zero in nothing.
        let book = try store.book()
        #expect(book.baseCurrency == "GBP")
        #expect(try book.netWorth().totalBaseMinor == 0)
    }

    @Test("the seeded tree lands in the STORE with its parent links intact")
    func theSeedLandsInTheStore() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        try store.createBook(baseCurrency: "EUR")

        let categories = try store.book().categories
        #expect(categories.count == 61)
        let ids = Set(categories.map(\.id))
        #expect(categories.allSatisfy { $0.parentId == nil || ids.contains($0.parentId!) })

        // A round trip through SQLite keeps the kind, the colour and the order,
        // which is what a report row and a chart slice are made of.
        let byName = Dictionary(uniqueKeysWithValues: categories.map { ($0.name, $0) })
        let food = try #require(byName["Food & Drink"])
        let groceries = try #require(byName["Groceries"])
        #expect(groceries.parentId == food.id)
        #expect(groceries.kind == .expense)
        #expect(groceries.colour == food.colour)
        #expect(byName["Salary"]?.kind == .income)
        #expect(Categories.descendantIds(categories, rootIds: [food.id]).count == 5)
    }

    @Test("CREATING IS ATOMIC: a refused account leaves no half-built book")
    func creationIsAtomic() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)

        // The second draft is refused (a name of nothing but spaces). The
        // settings row, the sixty-one categories and the FIRST account are all
        // already written by then -- and none of them may survive, because a
        // book with a settings row and a partial set of accounts is a book the
        // app would open and be quietly wrong about.
        let refusal = editError {
            try store.createBook(
                baseCurrency: "GBP",
                startingAccounts: [
                    StarterBook.accountTemplates[0].draft(currency: "GBP"),
                    AccountDraft(name: "   ", type: .cash, currency: "GBP"),
                    StarterBook.accountTemplates[1].draft(currency: "GBP"),
                ]
            )
        }
        #expect(refusal == .blankName(what: "account"))

        #expect(try store.isEmpty())
        #expect(try store.liveCount("categories") == 0)
        #expect(try store.liveCount("accounts") == 0)
        #expect(try store.readSettings() == nil)
        // Including the bookkeeping: an origin left behind by a rolled-back
        // create would make the next honest question ("where did this book come
        // from?") answer about a book that was never written.
        #expect(try store.meta(LedgerStore.BookKey.origin) == nil)
    }

    @Test("STARTING ACCOUNTS ARE PART OF THE SAME COMMIT, through the ordinary editor")
    func startingAccounts() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)

        let created = try store.createBook(
            baseCurrency: "GBP",
            startingAccounts: StarterBook.accountTemplates.map { $0.draft(currency: "GBP") }
        )

        #expect(created.accounts.count == 4)
        #expect(created.accounts.map(\.name)
            == ["Current Account", "Savings", "Credit Card", "Cash"])
        #expect(created.accounts.map(\.type) == [.current, .savings, .creditCard, .cash])
        // Ordered as they were offered, coloured as the web app colours them,
        // in the book's currency, and holding no money nobody has typed.
        #expect(created.accounts.map(\.sortOrder) == [0, 1, 2, 3])
        #expect(created.accounts.map(\.colour)
            == StarterBook.accountTemplates.map(\.colour))
        #expect(created.accounts.allSatisfy { $0.currency == "GBP" })
        #expect(created.accounts.allSatisfy { $0.openingBalanceMinor == 0 })

        #expect(try store.liveCount("accounts") == 4)
        #expect(try store.accountBalances().allSatisfy { $0.balanceMinor == 0 })

        // An opening balance the caller DID state is kept exactly as an
        // integer of minor units -- the amount is the caller's, the account is
        // the template's.
        let second = try Self.emptyStore(scratch, name: "second.sqlite")
        var draft = StarterBook.accountTemplates[3].draft(currency: "GBP")
        draft.openingBalanceMinor = 2500
        try second.createBook(baseCurrency: "GBP", startingAccounts: [draft])
        #expect(try second.balance(of: try #require(second.book().accounts.first).id) == 2500)
        #expect(try second.auditMoneyColumns().isEmpty)
    }

    // MARK: - Provenance

    @Test("A CREATED BOOK KNOWS IT WAS CREATED, and still knows after a relaunch")
    func originSurvivesRelaunch() throws {
        let scratch = try ScratchDirectory()
        do {
            let store = try Self.emptyStore(scratch)
            try store.createBook(baseCurrency: "GBP")
            #expect(try store.bookOrigin() == .created)
            #expect(try store.provenance().origin == .created)
            // No file facts, because there was no file.
            #expect(try store.provenance().isEmpty)
            store.close()
        }
        // A second open of the same database file -- the app being launched
        // again, which is when a fact held only in memory would be lost.
        let reopened = try scratch.store()
        #expect(try reopened.bookOrigin() == .created)
        #expect(try reopened.provenance().origin == .created)
        #expect(try reopened.liveCount("categories") == 61)
        #expect(try reopened.readSettings()?.baseCurrency == "GBP")
    }

    @Test("AN IMPORTED BOOK KNOWS IT WAS IMPORTED, including one from an older build")
    func importedBooksAreImported() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(try store.bookOrigin() == .imported)
        #expect(try store.provenance().origin == .imported)
        #expect(!(try store.provenance().isEmpty))

        // A STORE WRITTEN BEFORE THIS KEY EXISTED. Every book that could be in
        // one arrived by import -- it was the only way in -- so an absent
        // origin means imported. Getting this backwards would silence the
        // divergence count on the one book that needs it: the owner's real
        // ledger, already on his phone.
        try store.setMeta(LedgerStore.BookKey.origin, nil)
        #expect(try store.bookOrigin() == .imported)
        #expect(try store.localEdits().countLine != nil)

        // And a value from some future build is treated the same way rather
        // than throwing: being locked out of your own ledger by an unrecognised
        // word is not an improvement on being over-warned.
        try store.setMeta(LedgerStore.BookKey.origin, "synced-from-somewhere")
        #expect(try store.bookOrigin() == .imported)
    }

    @Test("CREATE IS REFUSED OVER AN EXISTING BOOK, imported or created, with no override")
    func createNeverDestroys() throws {
        let scratch = try ScratchDirectory()

        // Over the imported fixture: the case that would cost the owner his
        // real ledger.
        let imported = try EditFixture.store(scratch)
        let before = try imported.book().sortedById()
        let error = storeError { try imported.createBook(baseCurrency: "USD") }
        guard case .bookAlreadyExists(let accounts, let transactions) = try #require(error) else {
            Issue.record("expected bookAlreadyExists, got \(String(describing: error))")
            return
        }
        #expect(accounts == 3)
        #expect(transactions == 2)
        #expect(error?.description.contains("Nothing was changed") == true)
        // Untouched: the same book, the same origin, the same currency.
        expectSameBook(try imported.book().sortedById(), before, "after a refused create")
        #expect(try imported.bookOrigin() == .imported)

        // And over a book created here, for the same reason.
        let created = try Self.emptyStore(scratch, name: "created.sqlite")
        try created.createBook(baseCurrency: "GBP")
        let second = storeError { try created.createBook(baseCurrency: "USD") }
        #expect(second != nil)
        #expect(try created.readSettings()?.baseCurrency == "GBP")
        #expect(try created.liveCount("categories") == 61)
    }

    @Test("RESTORING A BACKUP OVER A CREATED BOOK MAKES IT AN IMPORTED ONE")
    func restoreOverACreatedBook() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        try store.createBook(
            baseCurrency: "GBP",
            startingAccounts: [StarterBook.accountTemplates[0].draft(currency: "GBP")]
        )
        #expect(try store.bookOrigin() == .created)

        // Explicit, because `importBackup` refuses to replace a book unless
        // told to -- the caller had to mean it.
        try store.importBackup(text: StoreFixture.backupText, replacingExistingBook: true)

        // What is here now came out of a file, and the file's book lives
        // somewhere else. So the wording comes back, from zero.
        #expect(try store.bookOrigin() == .imported)
        #expect(try store.provenance().origin == .imported)
        #expect(try store.provenance().contentHash != nil)
        let edits = try store.localEdits()
        #expect(edits.count == 0)
        #expect(edits.countLine == "0 changes not in your web app")

        // And the count starts working again, because now there is something
        // for it to be a count OF.
        store.environment = .fixed(now: EditFixture.now, idPrefix: "e")
        _ = try store.saveTransaction(EditFixture.expense())
        #expect(try store.localEdits().count == 1)
        #expect(try store.localEdits().countLine == "1 change not in your web app")
    }

    // MARK: - The count that must not be shown

    @Test("A CREATED BOOK HAS NO DRIFT TO REPORT, and cannot be made to say it has")
    func createdBooksCountNothing() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        try store.createBook(
            baseCurrency: "GBP",
            startingAccounts: [StarterBook.accountTemplates[0].draft(currency: "GBP")]
        )
        let account = try #require(try store.book().accounts.first).id

        // Ordinary use: an account, some transactions, an edit, a delete.
        _ = try store.saveTransaction(
            TransactionDraft(accountId: account, date: "2026-09-01", amountMinor: -1250,
                             payeeName: "Kiosk")
        )
        let second = try store.saveTransaction(
            TransactionDraft(accountId: account, date: "2026-09-02", amountMinor: -400)
        )
        _ = try store.deleteTransaction(id: second.id)
        var rename = StarterBook.accountTemplates[0].draft(currency: "GBP")
        rename.id = account
        rename.name = "Everyday"
        _ = try store.saveAccount(rename)

        // THE COUNT IS NOT KEPT AT ALL. "Changes this copy has that the other
        // copy does not" is not zero for a book with no other copy, it is
        // undefined -- and a number stored for it is a number somebody
        // eventually displays.
        let edits = try store.localEdits()
        #expect(edits.count == 0)
        #expect(!edits.hasDiverged)
        #expect(edits.firstAt == nil)
        #expect(edits.lastAt == nil)
        #expect(try store.meta(LedgerStore.LocalEditKey.count) == nil)

        // AND THERE IS NO SENTENCE TO PRINT. Not a different sentence -- none.
        // "0 changes not in your web app" names a second copy that does not
        // exist and an authority that was never involved.
        #expect(edits.origin == .created)
        #expect(!edits.isWorthSaying)
        #expect(edits.countLine == nil)
        #expect(edits.summary == nil)

        // The edits themselves are perfectly real, which is the other half of
        // the claim: nothing was skipped, only the counter.
        #expect(try store.liveCount("transactions") == 1)
        #expect(try store.book().accounts.first?.name == "Everyday")
    }

    @Test("an IMPORTED book still counts every change, and still says so")
    func importedBooksStillCount() throws {
        // The contrast case, in the same suite as the one above, so that a
        // change which silenced the count everywhere cannot pass by making the
        // created-book test greener.
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        _ = try store.saveTransaction(EditFixture.expense())
        let edits = try store.localEdits()
        #expect(edits.origin == .imported)
        #expect(edits.isWorthSaying)
        #expect(edits.count == 1)
        #expect(edits.countLine == "1 change not in your web app")
        #expect(edits.summary?.contains("your web app does not have") == true)
    }

    @Test("the widget's snapshot of a created book claims no drift either")
    func snapshotSaysNothingAboutDrift() throws {
        // The snapshot is what the widget and the Siri answer read, and both of
        // them print the count when it is above zero. They need no special case
        // for a created book because there is no count to print.
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        try store.createBook(
            baseCurrency: "GBP",
            startingAccounts: [StarterBook.accountTemplates[0].draft(currency: "GBP")]
        )
        let account = try #require(try store.book().accounts.first).id
        _ = try store.saveTransaction(
            TransactionDraft(accountId: account, date: "2026-09-01", amountMinor: -999)
        )

        let snapshot = try #require(
            try store.ledgerSnapshot(today: "2026-09-02", asOf: Self.now)
        )
        #expect(snapshot.localEditCount == 0)
        #expect(snapshot.sourceExportedAt == nil)
        #expect(snapshot.accountCount == 1)
        #expect(snapshot.transactionCount == 1)
    }

    // MARK: - The currency, and the file

    @Test("the base currency is validated and normalised, or nothing is written")
    func baseCurrencyIsValidated() throws {
        let scratch = try ScratchDirectory()

        // Typed in lower case: stored as a code, because every total in the
        // book is denominated by this string and "gbp" is not one.
        let lower = try Self.emptyStore(scratch, name: "lower.sqlite")
        try lower.createBook(baseCurrency: " gbp ")
        #expect(try lower.readSettings()?.baseCurrency == "GBP")

        // Not a code at all: refused, and the store is untouched -- no settings
        // row, no categories, no origin.
        let bad = try Self.emptyStore(scratch, name: "bad.sqlite")
        #expect(editError { try bad.createBook(baseCurrency: "pounds") }
            == .badCurrency("pounds"))
        #expect(try bad.isEmpty())
        #expect(try bad.liveCount("categories") == 0)
        #expect(try bad.meta(LedgerStore.BookKey.origin) == nil)
    }

    @Test("A CREATED BOOK EXPORTS TO A FILE THE WEB APP CAN READ, and reads back identically")
    func createdBooksExportAndRoundTrip() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        try store.createBook(
            baseCurrency: "GBP",
            startingAccounts: [StarterBook.accountTemplates[0].draft(currency: "GBP")]
        )
        let account = try #require(try store.book().accounts.first).id
        _ = try store.saveTransaction(
            TransactionDraft(accountId: account, date: "2026-09-01", amountMinor: -1500,
                             payeeName: "Kiosk")
        )

        let text = try store.exportBackupText(exportedAt: "2026-09-02T12:00:00.000Z")
        let loaded = try BackupImporter.load(text: text)
        #expect(loaded.book.categories.count == 61)
        #expect(loaded.book.baseCurrency == "GBP")
        #expect(loaded.book.settings?.onboarded == true)
        // The manifest this build wrote was recomputed from the rows and
        // agreed, which is what makes the file restorable rather than merely
        // parseable.
        #expect(loaded.recomputedManifest != nil)

        // THE ROUND TRIP, DEMANDED RATHER THAN REPORTED. A second store reads
        // the file and re-exports it to the same canonical bytes -- so the
        // settings row this app fabricates for a new book is one the format
        // can carry without losing or inventing a key.
        let second = try scratch.store("second.sqlite")
        let result = try second.importBackup(text: text, requiringExactRoundTrip: true)
        #expect(result.reproducesSource)
        #expect(result.rowCounts["categories"] == 61)
        #expect(result.rowCounts["accounts"] == 1)
        #expect(try second.bookOrigin() == .imported)
    }

    @Test("the settings row is the one the browser would have written")
    func theSettingsRowIsOrdinary() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        try store.createBook(baseCurrency: "INR")
        let settings = try #require(try store.readSettings())

        // Exactly the keys src/db/db.ts's defaultSettings() writes that mean
        // anything here -- and NOT the `sync*` half, which is device-local
        // bookkeeping for an engine this app does not have. Writing
        // `syncDeviceId: ""` would be this device claiming a sync identity it
        // has never had, and it would travel in every backup.
        let keys = Set((settings.raw.objectValue ?? [:]).keys)
        #expect(keys == [
            "id", "schemaVersion", "baseCurrency", "theme", "lastBackupAt", "onboarded",
            "lastUsedAccountId", "savedMappings", "createdAt", "autoFxEnabled",
            "lastFxSyncAt", "lastFxSyncSource",
        ])
        #expect(BackupWriter.unmodelledSettingsKeys(settings).isEmpty)
        #expect(settings.raw["onboarded"]?.boolValue == true)
        #expect(settings.raw["lastBackupAt"]?.isNull == true)
        #expect(settings.raw["savedMappings"]?.objectValue?.isEmpty == true)

        // `raw` IS what is on disk, not a reconstruction of it: the typed
        // columns beside it are an index over the same row, and the JSON the
        // store kept is what a backup will be written from.
        let stored = try store.rawText("SELECT row_json FROM settings WHERE id = ?", "app")
        #expect(stored == CanonicalJSON.text(BackupWriter.settingsRow(settings), indent: 0))
        #expect(stored == CanonicalJSON.text(settings.raw, indent: 0))
    }
}

/// The `StoreError` an expression threw, or nil. The sibling of `editError` in
/// EditTestSupport: `#expect(throws:)` proves the type, and these tests also
/// have to read the sentence.
func storeError(_ body: () throws -> some Any) -> StoreError? {
    do {
        _ = try body()
        return nil
    } catch let error as StoreError {
        return error
    } catch {
        return nil
    }
}
