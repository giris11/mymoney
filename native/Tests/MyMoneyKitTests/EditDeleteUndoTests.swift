// Deleting, and taking it back.
//
// THE POINT OF THESE TESTS IS THAT UNDO IS EXACT RATHER THAN RECONSTRUCTED.
// The row was never destroyed -- a delete stamps `deleted_at` and nothing else
// -- so restoring it cannot lose a split, reorder a tag, or re-stamp a
// timestamp, and each of those is asserted below rather than assumed.
//
// The rule that makes it possible is in StoreSchema.swift and was bought with a
// real CloudKit experiment: a delete that removes a row carries no change tag
// and can lose an offline device's edit with no error at all. Everything here
// is downstream of that finding.
import Foundation
import Testing

@testable import MyMoneyKit

struct EditDeleteUndoTests {

    @Test("DELETING HIDES THE ROW AND KEEPS EVERY PENNY OF IT")
    func deleteKeepsTheRow() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)

        let receipt = try store.deleteTransaction(id: "t1")

        // Gone from every ordinary read...
        #expect(try store.registerCount(scope: .allAccounts) == 1)
        #expect(try store.transaction(id: "t1") == nil)
        #expect(try store.balance(of: "w-a") == 100_000, "the -25.00 no longer counts")
        // ...and entirely, still, on disk -- amount, splits and tags included.
        #expect(try store.connection.scalarInt("SELECT count(*) FROM transactions") == 2)
        #expect(
            try store.connection.scalarInt("SELECT amount_minor FROM transactions WHERE id='t1'")
                == -2500
        )
        #expect(try store.splits(ofTransaction: "t1").count == 2)
        #expect(try store.tagIds(ofTransaction: "t1") == ["tg1"])
        #expect(receipt.ids == ["t1"])
        #expect(receipt.deletedAt == EditFixture.now)
        #expect(!receipt.isTransfer)
    }

    @Test("UNDO PUTS BACK EXACTLY THE ROW -- splits, tags, notes, dates and all")
    func undoIsExact() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try #require(try store.transaction(id: "t1"))
        let balanceBefore = try #require(try store.balance(of: "w-a"))

        let receipt = try store.deleteTransaction(id: "t1")
        #expect(try store.undoDelete(receipt) == 1)

        #expect(try store.transaction(id: "t1") == before, "not equivalent -- identical")
        #expect(try store.balance(of: "w-a") == balanceBefore)
        #expect(try store.registerCount(scope: .allAccounts) == 2)
        #expect(try store.deletedCount("transactions") == 0)
    }

    @Test("DELETING ONE LEG OF A TRANSFER DELETES BOTH, and undo brings both back")
    func transfersDeleteAsAPair() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let pair = try store.saveTransfer(
            TransferDraft(
                fromAccountId: "w-a", toAccountId: "w-c", date: "2026-09-01",
                amountFromMinor: 5000, amountToMinor: 5000
            )
        )
        let fromBalance = try #require(try store.balance(of: "w-a"))
        let toBalance = try #require(try store.balance(of: "w-c"))

        // Deleted from the RECEIVING side, to prove either leg works.
        let receipt = try store.deleteTransaction(id: pair.to.id)
        #expect(receipt.isTransfer)
        #expect(Set(receipt.ids) == Set([pair.from.id, pair.to.id]))
        #expect(try store.transaction(id: pair.from.id) == nil, "half a transfer is money lost")
        #expect(try store.balance(of: "w-a") == fromBalance + 5000)
        #expect(try store.balance(of: "w-c") == toBalance - 5000)

        #expect(try store.undoDelete(receipt) == 2)
        #expect(try store.balance(of: "w-a") == fromBalance)
        #expect(try store.balance(of: "w-c") == toBalance)
        #expect(try store.transferPair(groupId: #require(pair.transferGroupId)) != nil)
    }

    @Test("a receipt cannot resurrect a row that something else deleted afterwards")
    func staleReceiptsAreRefused() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try store.deleteTransaction(id: "t1")
        try store.undoDelete(receipt)

        // Deleted again, at a different moment, by a different action.
        store.environment = .fixed(now: EditFixture.later, idPrefix: "e")
        try store.deleteTransaction(id: "t1")

        // The OLD receipt must not undo the NEW delete: the owner's last
        // instruction was to delete it, and an undo button left on screen from
        // ten minutes ago must not quietly countermand it.
        let error = editError { try store.undoDelete(receipt) }
        #expect(error == .nothingToRestore(what: "transaction"))
        #expect(try store.transaction(id: "t1") == nil)
    }

    @Test("undoing twice refuses the second time rather than reporting a success")
    func undoIsNotIdempotentlySilent() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try store.deleteTransaction(id: "t1")
        #expect(try store.undoDelete(receipt) == 1)
        #expect(editError { try store.undoDelete(receipt) } == .nothingToRestore(what: "transaction"))
    }

    @Test("deleting something that is not there is refused by name")
    func deletingNothing() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(
            editError { try store.deleteTransaction(id: "ghost") } == .unknownTransaction("ghost")
        )
    }

    @Test("a deleted transaction stops teaching its payee, and teaches again when restored")
    func deletionUpdatesLearning() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveTransaction(
            EditFixture.expense(payee: "Kiosk", category: "c-food")
        )
        let payeeId = try #require(saved.payeeId)
        #expect(try store.payeeIndex().payee(id: payeeId)?.defaultCategoryId == "c-food")

        let receipt = try store.deleteTransaction(id: saved.id)
        #expect(try store.payeeIndex().payee(id: payeeId)?.defaultCategoryId == nil)
        #expect(try store.payeeIndex().payee(id: payeeId)?.useCount == 0)

        try store.undoDelete(receipt)
        #expect(try store.payeeIndex().payee(id: payeeId)?.defaultCategoryId == "c-food")
    }

    @Test("the receipt says enough for an undo prompt to name the transaction")
    func receiptCarriesTheWords() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let saved = try store.saveTransaction(EditFixture.expense(payee: "Kiosk"))
        let receipt = try store.deleteTransaction(id: saved.id)
        #expect(receipt.title == "Kiosk")
        #expect(receipt.amountMinor == -350)
        #expect(receipt.currency == "GBP")
        #expect(receipt.count == 1)

        // A row with no payee falls back to its note, exactly as the register
        // titles it -- one rule, not two.
        var draft = EditFixture.expense(payee: "")
        draft.notes = "Bus fare\nsecond line"
        let noted = try store.saveTransaction(draft)
        #expect(try store.deleteTransaction(id: noted.id).title == "Bus fare")
    }
}
