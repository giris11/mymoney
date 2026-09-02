// Adding and changing a transaction, against a real database.
//
// WHAT EACH TEST IS FOR is written on it, because "saveTransaction works" is
// not a claim anybody can act on. The ones that matter most are the REFUSALS:
// a save that is rejected must leave the book untouched, and every assertion
// below that ends "...and nothing else moved" is checking exactly that.
import Foundation
import Testing

@testable import MyMoneyKit

struct EditTransactionTests {

    // MARK: - Adding

    @Test("ADDING A TRANSACTION moves the account's balance by exactly its amount")
    func addingMovesTheBalance() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try #require(try store.balance(of: "w-a"))

        let saved = try store.saveTransaction(EditFixture.expense(amountMinor: -350))

        #expect(try store.balance(of: "w-a") == before - 350)
        #expect(try store.registerCount(scope: .account("w-a")) == 2)
        // ...and no other account moved.
        #expect(try store.balance(of: "w-b") == 17000)
        #expect(try store.balance(of: "w-c") == 500_000)
        #expect(saved.id == "e-2")  // e-1 was the payee this save created
    }

    @Test("THE CURRENCY COMES FROM THE ACCOUNT -- a form cannot state one")
    func currencyIsTheAccountsOwn() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let gbp = try store.saveTransaction(EditFixture.expense(account: "w-a"))
        let eur = try store.saveTransaction(
            EditFixture.expense(account: "w-b", category: nil)
        )
        #expect(gbp.currency == "GBP")
        #expect(eur.currency == "EUR")
        // On disk, not merely in the value returned.
        #expect(try store.transaction(id: eur.id)?.currency == "EUR")
    }

    @Test("the amount is stored as an INTEGER, and the money audit stays clean")
    func moneyStaysAnInteger() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveTransaction(
            EditFixture.expense(amountMinor: -123_456_789)
        )
        #expect(
            try store.rawText(
                "SELECT typeof(amount_minor) FROM transactions WHERE id = ?", saved.id
            ) == "integer"
        )
        #expect(try store.auditMoneyColumns().isEmpty)
    }

    // MARK: - Payees

    @Test("A PAYEE TYPED FOR THE FIRST TIME is created once; the same name in another case reuses it")
    func payeesCollapseOnCase() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(try store.liveCount("payees") == 1)

        let first = try store.saveTransaction(EditFixture.expense(payee: "Kiosk"))
        let again = try store.saveTransaction(EditFixture.expense(payee: "  kIOSK  "))
        #expect(try store.liveCount("payees") == 2, "one new payee, not two")
        #expect(first.payeeId == again.payeeId)
        // The FIRST spelling is the one kept -- a later capitalisation reuses
        // the row rather than quietly renaming it under the owner.
        #expect(try store.payeeName(id: #require(first.payeeId)) == "Kiosk")

        // And an existing payee from the imported book is matched too.
        let existing = try store.saveTransaction(EditFixture.expense(payee: "corner shop"))
        #expect(existing.payeeId == "p1")
        #expect(try store.liveCount("payees") == 2)
    }

    @Test("a blank payee is no payee, not a payee called nothing")
    func blankPayee() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveTransaction(EditFixture.expense(payee: "   "))
        #expect(saved.payeeId == nil)
        #expect(try store.liveCount("payees") == 1)
    }

    @Test("SAVING LEARNS what a payee is usually filed under, splits included")
    func payeeLearnsItsCategory() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let first = try store.saveTransaction(
            EditFixture.expense(payee: "Kiosk", category: "c-food")
        )
        let payeeId = try #require(first.payeeId)
        #expect(try store.payeeIndex().payee(id: payeeId)?.defaultCategoryId == "c-food")

        // Two more under Groceries makes Groceries the habit.
        for date in ["2026-09-02", "2026-09-03"] {
            try store.saveTransaction(
                EditFixture.expense(payee: "Kiosk", category: "c-sub", date: date)
            )
        }
        #expect(try store.payeeIndex().payee(id: payeeId)?.defaultCategoryId == "c-sub")

        // A SPLIT teaches each of its categories, not the (absent) parent one.
        try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-09-04", amountMinor: -1000,
                payeeName: "Kiosk",
                splits: [
                    Split(categoryId: "c-food", amountMinor: -600),
                    Split(categoryId: "c-food", amountMinor: -400),
                ]
            )
        )
        // c-food now has 1 + 2 = 3 votes against c-sub's 2.
        #expect(try store.payeeIndex().payee(id: payeeId)?.defaultCategoryId == "c-food")
    }

    @Test("moving a transaction to a different payee re-teaches the payee it left")
    func learningFollowsTheMove() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveTransaction(
            EditFixture.expense(payee: "Kiosk", category: "c-food")
        )
        let kiosk = try #require(saved.payeeId)
        #expect(try store.payeeIndex().payee(id: kiosk)?.defaultCategoryId == "c-food")

        var moved = try #require(try store.transactionDraft(forId: saved.id))
        moved.payeeName = "Somewhere Else"
        try store.saveTransaction(moved)

        // The old payee no longer has a vote from a transaction it no longer
        // has, so its learned category is cleared rather than left stale.
        #expect(try store.payeeIndex().payee(id: kiosk)?.defaultCategoryId == nil)
    }

    // MARK: - Tags

    @Test("tags are created, deduped case-insensitively, blanks dropped, ORDER KEPT")
    func tagHandling() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        var draft = EditFixture.expense()
        draft.tagNames = ["Zebra", "  ", "holiday", "HOLIDAY", "Apple"]

        let saved = try store.saveTransaction(draft)
        // Zebra, Holiday (the existing tg1), Apple -- in the order given.
        #expect(saved.tagIds.count == 3)
        #expect(saved.tagIds[1] == "tg1", "the existing tag was matched, not duplicated")
        #expect(try store.tagNames(ids: saved.tagIds) == ["Zebra", "Holiday", "Apple"])
        #expect(try store.liveCount("tags") == 3)
        // Position is stored, so the order survives a re-read.
        #expect(try store.transaction(id: saved.id)?.tagIds == saved.tagIds)
    }

    // MARK: - Editing

    @Test("EDITING keeps createdAt and the import batch, and moves updatedAt")
    func editingPreservesProvenance() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // A transaction that ARRIVED IN AN IMPORT. Editing it must not orphan
        // it from that batch: an import is undoable as a unit, and a row that
        // has quietly left its batch is a row the undo cannot take back.
        // (The fixture's own imported row, t2, is a transfer leg and so is not
        // editable through this door -- hence attaching t1 to the batch here.)
        try store.connection.execute(
            "UPDATE transactions SET import_batch_id = 'ib1' WHERE id = 't1'"
        )
        var draft = try #require(try store.transactionDraft(forId: "t1"))
        draft.notes = "corrected"
        store.environment = .fixed(now: EditFixture.later, idPrefix: "e")

        let saved = try store.saveTransaction(draft)
        #expect(saved.id == "t1")
        #expect(saved.createdAt == "2026-08-03T00:00:00.000Z", "createdAt is a fact, not a stamp")
        #expect(saved.updatedAt == EditFixture.later)
        #expect(saved.importBatchId == "ib1", "an edit does not orphan a row from its import")
        #expect(saved.notes == "corrected")
        #expect(try store.registerCount(scope: .allAccounts) == 2, "an edit is not an insert")
    }

    @Test("THE DEDUPE HASH IS RECOMPUTED on every save, so a re-import still matches")
    func dedupeHashFollowsTheData() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveTransaction(
            EditFixture.expense(amountMinor: -350, payee: "Kiosk", date: "2026-09-01")
        )
        #expect(
            saved.dedupeHash
                == Dedupe.makeDedupeHash(
                    accountId: "w-a", date: "2026-09-01", amountMinor: -350,
                    payeeOrDescription: "Kiosk"
                )
        )
        // Change the amount and the hash follows it -- a stale hash would make
        // the SAME row look like a new one to the next import, and doubling a
        // transaction is exactly the failure dedupe exists to prevent.
        var draft = try #require(try store.transactionDraft(forId: saved.id))
        draft.amountMinor = -400
        let again = try store.saveTransaction(draft)
        #expect(again.dedupeHash.hasSuffix("|-400|kiosk"))

        // With no payee the notes are hashed instead, matching the importer.
        var noPayee = draft
        noPayee.payeeName = ""
        noPayee.notes = "Bus fare"
        #expect(try store.saveTransaction(noPayee).dedupeHash.hasSuffix("|bus fare"))
    }

    @Test("SAVING REMEMBERS THE ACCOUNT, so the next quick add opens on it")
    func lastUsedAccountIsRemembered() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(try store.readSettings()?.lastUsedAccountId == "w-a")

        try store.saveTransaction(EditFixture.expense(account: "w-b", category: nil))
        #expect(try store.readSettings()?.lastUsedAccountId == "w-b")
        #expect(try store.quickAddContext().defaultAccountId == "w-b")

        // The device-local half of the settings row is carried through
        // untouched -- dropping a key this package does not model would change
        // the book's fingerprint for a reason that has nothing to do with the
        // book.
        let raw = try #require(try store.readSettings()?.raw.objectValue)
        #expect(raw["syncDeviceId"] == .string("dev-1"))
        #expect(raw["syncLocalRevision"] == .int(3))
    }

    // MARK: - Splits, through the store

    @Test("SPLITS THAT DO NOT ADD UP ARE REFUSED, and the sentence says by how much")
    func unbalancedSplitsAreRefused() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try #require(try store.balance(of: "w-a"))

        var draft = EditFixture.expense(amountMinor: -2500)
        draft.splits = [
            Split(categoryId: "c-food", amountMinor: -1000),
            Split(categoryId: "c-sub", amountMinor: -499),
        ]
        let error = try #require(editError { try store.saveTransaction(draft) })
        #expect(error.problem.contains("-\u{00A3}14.99"))
        #expect(error.problem.contains("\u{00A3}25.00"))
        #expect(error.problem.contains("short by \u{00A3}10.01"))
        #expect(error.unchanged == "Nothing was saved \u{2014} the transaction is still as it was.")

        // NOTHING WAS SAVED: no transaction, and no payee left behind from the
        // get-or-create that ran before the refusal.
        #expect(try store.balance(of: "w-a") == before)
        #expect(try store.registerCount(scope: .allAccounts) == 2)
        #expect(try store.liveCount("payees") == 1)
    }

    @Test("a balanced split saves, and reads back line for line, in order")
    func balancedSplitsSave() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        var draft = EditFixture.expense(amountMinor: -2500, category: nil)
        draft.splits = [
            Split(categoryId: "c-sub", amountMinor: -1000, notes: "shopping"),
            Split(categoryId: "c-food", amountMinor: -1500),
        ]
        let saved = try store.saveTransaction(draft)
        let read = try #require(try store.transaction(id: saved.id))
        #expect(read.splits == draft.splits)
        #expect(try read.validateSplits())
        #expect(try store.balance(of: "w-a") == 100_000 - 2500 - 2500)
    }

    @Test("removing the splits from a transaction removes the CHILD ROWS too")
    func splitsAreReplacedWholesale() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // t1 has two split lines and one tag.
        #expect(try store.splits(ofTransaction: "t1").count == 2)

        var draft = try #require(try store.transactionDraft(forId: "t1"))
        draft.splits = []
        draft.tagNames = []
        draft.categoryId = "c-food"
        try store.saveTransaction(draft)

        #expect(try store.splits(ofTransaction: "t1").isEmpty)
        #expect(try store.tagIds(ofTransaction: "t1").isEmpty)
        #expect(
            try store.connection.scalarInt(
                "SELECT count(*) FROM transaction_splits WHERE transaction_id = 't1'"
            ) == 0,
            "a stale child row would reappear in the next export"
        )
    }

    // MARK: - Refusals

    @Test("EVERY REFUSAL NAMES WHAT WAS WRONG and says nothing was changed")
    func refusalsAreComplete() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let badDate = try #require(
            editError { try store.saveTransaction(EditFixture.expense(date: "2026-02-30")) }
        )
        #expect(badDate == .badDate("2026-02-30"))
        #expect(badDate.problem.contains("2026-02-30"))

        let noAccount = try #require(
            editError { try store.saveTransaction(EditFixture.expense(account: "nope")) }
        )
        #expect(noAccount == .unknownAccount("nope"))

        let noCategory = try #require(
            editError { try store.saveTransaction(EditFixture.expense(category: "gone")) }
        )
        #expect(noCategory == .unknownCategory("gone"))

        var missing = EditFixture.expense()
        missing.id = "not-a-row"
        let noTransaction = try #require(editError { try store.saveTransaction(missing) })
        #expect(noTransaction == .unknownTransaction("not-a-row"))

        for error in [badDate, noAccount, noCategory, noTransaction] {
            #expect(error.unchanged.contains("Nothing was"), "\(error)")
            #expect(error.description == "\(error.problem) \(error.unchanged)")
        }
        // The book is exactly as it was after all four.
        #expect(try store.registerCount(scope: .allAccounts) == 2)
        #expect(try store.liveCount("payees") == 1)
        #expect(try store.liveCount("tags") == 1)
    }

    @Test("a split naming a category that is not there is refused before anything is written")
    func splitCategoryIsChecked() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        var draft = EditFixture.expense(amountMinor: -1000, category: nil)
        draft.splits = [
            Split(categoryId: "c-food", amountMinor: -500),
            Split(categoryId: "vanished", amountMinor: -500),
        ]
        #expect(editError { try store.saveTransaction(draft) } == .unknownCategory("vanished"))
        #expect(try store.registerCount(scope: .allAccounts) == 2)
    }

    @Test("A REFUSED SAVE LEAVES NO TRACE -- not even the payee it had to create first")
    func refusalIsAtomic() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        var draft = EditFixture.expense(amountMinor: -900, payee: "Brand New Shop")
        draft.tagNames = ["brand-new-tag"]
        draft.categoryId = "no-such-category"

        #expect(editError { try store.saveTransaction(draft) } != nil)
        // The payee and the tag were created inside the transaction that then
        // rolled back. Without the rollback they would sit in the autocomplete
        // for ever, attached to nothing.
        #expect(try store.liveCount("payees") == 1)
        #expect(try store.liveCount("tags") == 1)
        #expect(try store.liveCount("transactions") == 2)
        #expect(try store.localEdits().count == 0, "a refusal is not a change")
    }

    @Test("WHEN THE ROW WRITE ITSELF FAILS, the payee created a moment earlier goes with it")
    func rollbackUndoesEarlierWrites() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // THE CASE THE TRANSACTION WRAPPER EXISTS FOR, and it takes contriving
        // to reach: every VALIDATION refusal happens before a single row is
        // touched, which is the right order and also means those refusals would
        // pass this file's other atomicity assertions even with no transaction
        // at all. So this one makes the WRITE fail -- with an id generator that
        // collides with a row already in the book -- after the payee and the
        // tag have already been inserted. A real v4 UUID does not collide; a
        // failing disk, a constraint added in a later migration, or a bug in a
        // future writer all land in exactly the same place.
        store.environment = StoreEnvironment(now: { EditFixture.now }, newId: { "t1" })
        var draft = EditFixture.expense(payee: "Brand New Shop")
        draft.tagNames = ["brand-new-tag"]

        #expect(throws: (any Error).self) { try store.saveTransaction(draft) }

        #expect(try store.liveCount("payees") == 1, "the payee went back with the write")
        #expect(try store.liveCount("tags") == 1, "and so did the tag")
        #expect(try store.liveCount("transactions") == 2)
        #expect(try store.transaction(id: "t1")?.notes == "", "and t1 is untouched")
        #expect(try store.transaction(id: "t1")?.amountMinor == -2500)
        #expect(try store.localEdits().count == 0)
    }
}
