// The count of things this copy knows that the web app does not.
//
// WHY THIS IS TESTED AS HARD AS THE ARITHMETIC. The native app edits an
// IMPORTED COPY and never writes back to the web app, which is the system of
// record. That is safe only while the owner can tell, at a glance, which of
// their two apps has the newer truth. A banner saying "this is a copy" says the
// same thing before the first edit and after the hundredth; a COUNT does not.
//
// So: every mutation counts exactly once, a refused mutation counts zero, and
// an import -- which makes the copy and the file the same book again -- resets
// it. Each of those is a separate test below, because each of them failing
// would be invisible until the day it mattered.
import Foundation
import Testing

@testable import MyMoneyKit

struct LocalEditTests {

    @Test("A FRESHLY IMPORTED COPY HAS DIVERGED BY NOTHING, and says so")
    func freshImport() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let edits = try store.localEdits()
        #expect(edits.count == 0)
        #expect(!edits.hasDiverged)
        #expect(edits.firstAt == nil)
        #expect(edits.summary.contains("matches the backup"))
        #expect(edits.summary.contains("web app still holds the real ledger"))
    }

    @Test("THE COUNT SURVIVES THE COMPACT BANNER, at every count")
    func countLineAlwaysCarriesTheNumber() {
        // The banner is compact by default now, because at the largest
        // accessibility text size the two-sentence version took about 80% of the
        // viewport and left the account list a sliver. The explanation moved
        // behind a disclosure; the COUNT did not, and must not.
        //
        // So this asserts the line's shape rather than its prose: the number
        // first, in the same place every time, so a reader glancing at it is
        // checking one character rather than reading a sentence to find it.
        #expect(LocalEdits(count: 0, firstAt: nil, lastAt: nil).countLine
            == "0 changes not in your web app")
        #expect(LocalEdits(count: 1, firstAt: "t", lastAt: "t").countLine
            == "1 change not in your web app")
        #expect(LocalEdits(count: 2, firstAt: "t", lastAt: "t").countLine
            == "2 changes not in your web app")
        #expect(LocalEdits(count: 143, firstAt: "t", lastAt: "t").countLine
            == "143 changes not in your web app")

        // And the full sentence is still there for the disclosure to show. The
        // compact form replaces what is permanently on screen, not what the app
        // is willing to say.
        #expect(LocalEdits(count: 3, firstAt: "t", lastAt: "t").summary
            .contains("only on this device"))
    }

    @Test("the compact line and the sentence quote the SAME number")
    func theTwoFormsCannotDisagree() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        _ = try store.saveTransaction(EditFixture.expense())
        let edits = try store.localEdits()
        #expect(edits.count == 1)
        // Both are derived from `count`, and a screen showing one above the
        // other must never be able to show two different figures.
        #expect(edits.countLine.hasPrefix("1 change "))
        #expect(edits.summary.hasPrefix("1 change made here"))
    }

    @Test("EVERY KIND OF CHANGE COUNTS, exactly once")
    func everyMutationCounts() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        var expected = 0
        func step(_ label: String, _ body: () throws -> Void) throws {
            try body()
            expected += 1
            #expect(try store.localEdits().count == expected, "\(label)")
        }

        let saved = try { () throws -> Transaction in
            let tx = try store.saveTransaction(EditFixture.expense())
            expected += 1
            return tx
        }()
        #expect(try store.localEdits().count == expected)

        try step("edit a transaction") {
            var draft = try #require(try store.transactionDraft(forId: saved.id))
            draft.notes = "x"
            try store.saveTransaction(draft)
        }
        var receipt: DeletedTransactions!
        try step("delete a transaction") { receipt = try store.deleteTransaction(id: saved.id) }
        try step("undo that delete") { _ = try store.undoDelete(receipt) }
        try step("create a transfer") {
            try store.saveTransfer(
                TransferDraft(
                    fromAccountId: "w-a", toAccountId: "w-c", date: "2026-09-01",
                    amountFromMinor: 100, amountToMinor: 100
                )
            )
        }
        try step("create an account") {
            try store.saveAccount(AccountDraft(name: "New", type: .cash, currency: "GBP"))
        }
        try step("archive an account") { try store.setAccountArchived(id: "w-b", archived: true) }
        try step("exclude an account") { try store.setAccountExcluded(id: "w-b", excluded: true) }
        try step("create a group") {
            try store.saveAccountGroup(AccountGroupDraft(name: "Group Two"))
        }
        try step("move an account") { try store.moveAccount(id: "w-b", toGroup: "g1") }
        try step("reorder an account") { try store.reorderAccount(id: "w-b", .up) }
        try step("exclude a whole group") {
            _ = try store.setGroupExcluded(groupId: "g1", excluded: true)
        }

        let edits = try store.localEdits()
        #expect(edits.hasDiverged)
        #expect(edits.firstAt == EditFixture.now)
        #expect(edits.lastAt == EditFixture.now)
        #expect(edits.summary.contains("\(expected) changes made here"))
        #expect(edits.summary.contains("only on this device"))
    }

    @Test("DELETING A TRANSFER IS ONE CHANGE, not two, because it is one thing the owner did")
    func transferDeleteCountsOnce() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let pair = try store.saveTransfer(
            TransferDraft(
                fromAccountId: "w-a", toAccountId: "w-c", date: "2026-09-01",
                amountFromMinor: 100, amountToMinor: 100
            )
        )
        let before = try store.localEdits().count
        try store.deleteTransaction(id: pair.from.id)
        #expect(try store.localEdits().count == before + 1)
    }

    @Test("A REFUSED CHANGE IS NOT A CHANGE -- the counter rolls back with the write")
    func refusalsDoNotCount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        var unbalanced = EditFixture.expense(amountMinor: -2500)
        unbalanced.splits = [Split(categoryId: "c-food", amountMinor: -1)]

        #expect(editError { try store.saveTransaction(unbalanced) } != nil)
        #expect(editError { try store.deleteAccount(id: "w-a") } != nil)
        #expect(editError { try store.saveAccount(AccountDraft(name: " ", type: .cash, currency: "GBP")) } != nil)
        #expect(try store.localEdits().count == 0)
        #expect(try store.localEdits().firstAt == nil)
    }

    @Test("a tap that changes nothing does not count as a change")
    func noOpsDoNotCount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.setAccountArchived(id: "w-c", archived: true)  // already true
        try store.setAccountExcluded(id: "w-c", excluded: true)  // already true
        try store.moveAccount(id: "w-a", toGroup: "g1")  // already there
        try store.reorderAccount(id: "w-a", .up)  // already at the top of g1
        #expect(try store.localEdits().count == 0)
    }

    @Test("the first and last times are kept apart, so the sentence can name a date")
    func timestamps() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveTransaction(EditFixture.expense())
        store.environment = .fixed(now: EditFixture.later, idPrefix: "e")
        try store.saveTransaction(EditFixture.expense(date: "2026-09-02"))

        let edits = try store.localEdits()
        #expect(edits.firstAt == EditFixture.now)
        #expect(edits.lastAt == EditFixture.later)
    }

    @Test("AN IMPORT RESETS THE COUNT, because the copy has just become the file again")
    func importResets() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveTransaction(EditFixture.expense())
        #expect(try store.localEdits().hasDiverged)

        try store.importBackup(text: StoreFixture.backupText, replacingExistingBook: true)
        let edits = try store.localEdits()
        #expect(edits.count == 0)
        #expect(edits.firstAt == nil)
        #expect(edits.lastAt == nil)
        // And the edit really is gone -- the file replaced the book wholesale.
        #expect(try store.registerCount(scope: .allAccounts) == 2)
    }

    @Test("the count is store bookkeeping and never reaches a backup file")
    func countIsNotPartOfTheBook() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveAccountGroup(AccountGroupDraft(name: "Group Two"))
        #expect(try store.localEdits().count == 1)

        let text = try store.exportBackupText(exportedAt: "2026-09-02T10:00:00.000Z")
        #expect(!text.contains("editCount"))
        #expect(!text.contains("local."))
    }

    @Test("the count survives closing and reopening the store")
    func countPersists() throws {
        let scratch = try ScratchDirectory()
        do {
            let store = try EditFixture.store(scratch)
            try store.saveTransaction(EditFixture.expense())
            store.close()
        }
        let reopened = try scratch.store()
        #expect(try reopened.localEdits().count == 1)
        #expect(try reopened.localEdits().firstAt == EditFixture.now)
    }
}
