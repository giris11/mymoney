// After the app has been used, is the book still a book?
//
// THE EDIT LAYER IS THE FIRST THING IN THIS PACKAGE THAT WRITES ROWS NOBODY
// IMPORTED. Everything before it could lean on the property that the store only
// ever held what a verified file put there. These tests re-establish that
// property from the other end: take a book, edit it the way an owner would,
// and then hold the RESULT to exactly the standards an imported book is held
// to -- it exports, it re-imports, it proves itself against its own manifest,
// it comes back identical, and every amount in it is still an integer.
//
// If a mutation ever writes a malformed row -- a currency that disagrees with
// its account, a split that does not sum, an amount stored as text -- this is
// the suite that notices, because a backup file is the one artefact that
// carries every field.
import Foundation
import Testing

@testable import MyMoneyKit

struct EditFidelityTests {

    /// The fixture book, then a day's ordinary use of the app.
    private func edited(_ scratch: ScratchDirectory) throws -> LedgerStore {
        let store = try EditFixture.store(scratch)

        // A new account, in a new group, with a colour.
        let group = try store.saveAccountGroup(AccountGroupDraft(name: "Pockets"))
        let cash = try store.saveAccount(
            AccountDraft(
                name: "Wallet", type: .cash, currency: "GBP", openingBalanceMinor: 4000,
                colour: "#2563eb", groupId: group.id
            )
        )
        // A plain expense with a new payee and two tags.
        var coffee = EditFixture.expense(account: cash.id, amountMinor: -320, payee: "Kiosk")
        coffee.tagNames = ["Treats", "holiday"]
        try store.saveTransaction(coffee)
        // A split.
        try store.saveTransaction(
            TransactionDraft(
                accountId: cash.id, date: "2026-09-02", amountMinor: -5000,
                payeeName: "Supermarket", notes: "weekly shop",
                splits: [
                    Split(categoryId: "c-sub", amountMinor: -3500, notes: "food"),
                    Split(categoryId: "c-food", amountMinor: -1500),
                ]
            )
        )
        // A transfer, then an edit to it from the far leg.
        let pair = try store.saveTransfer(
            TransferDraft(
                fromAccountId: "w-a", toAccountId: cash.id, date: "2026-09-02",
                amountFromMinor: 2000, amountToMinor: 2000
            )
        )
        var topUp = try #require(try store.transferDraft(forLegId: pair.to.id))
        topUp.amountFromMinor = 3000
        topUp.amountToMinor = 3000
        try store.saveTransfer(topUp)
        // A deletion that stays deleted, and one that is taken back.
        let gone = try store.saveTransaction(EditFixture.expense(account: cash.id, payee: "Typo"))
        try store.deleteTransaction(id: gone.id)
        let restored = try store.saveTransaction(
            EditFixture.expense(account: cash.id, payee: "Kiosk", date: "2026-09-03")
        )
        try store.undoDelete(try store.deleteTransaction(id: restored.id))
        // Organisational changes.
        try store.setAccountExcluded(id: "w-b", excluded: true)
        try store.moveAccount(id: "w-b", toGroup: group.id)
        try store.reorderAccount(id: cash.id, .up)
        return store
    }

    @Test("AN EDITED BOOK STILL EXPORTS AND RE-IMPORTS TO AN IDENTICAL BOOK")
    func roundTripsAfterEditing() throws {
        let scratch = try ScratchDirectory()
        let store = try edited(scratch)

        let text = try store.exportBackupText(exportedAt: "2026-09-02T12:00:00.000Z")
        let reread = try BackupImporter.load(text: text)
        // The file proves itself against its own manifest -- row counts,
        // per-account closing balances and net worth, all recomputed from the
        // rows the edits produced.
        #expect(reread.verified)
        #expect(reread.warnings.isEmpty)
        expectSameBook(reread.book.sortedById(), try store.book().sortedById())

        // And into a fresh store, which is the path a restore takes.
        let second = try scratch.store("restored.sqlite")
        try second.importBackup(text: text)
        expectSameBook(try second.book(), try store.book())
        let hashHere = try store.exportContentHash(exportedAt: "2026-09-02T12:00:00.000Z")
        let hashThere = try second.exportContentHash(exportedAt: "2026-09-02T12:00:00.000Z")
        #expect(hashHere == hashThere)
    }

    @Test("every amount an EDIT wrote is stored as a whole number of minor units")
    func moneyStaysInteger() throws {
        let scratch = try ScratchDirectory()
        let store = try edited(scratch)
        #expect(try store.auditMoneyColumns().isEmpty)
        #expect(try store.integrityCheck() == "ok")
    }

    @Test("the register's cheap balance path and the whole-book path still agree, to the penny")
    func balancePathsAgree() throws {
        let scratch = try ScratchDirectory()
        let store = try edited(scratch)
        let fromRegister = try store.accountBalances()
        let fromBook = try store.book().accountBalances()
        #expect(fromRegister == fromBook)
        // Two accounts in GBP and one excluded EUR account: the net-worth rule
        // is per currency, and both readers reach the same figure.
        let headline = try store.accountsSnapshot().netWorth
        let fromWholeBook = try store.book().netWorth()
        #expect(headline == fromWholeBook)
    }

    @Test("SPLITS, TAGS AND HASHES SURVIVE THE ROUND TRIP in the order they were entered")
    func childRowsSurvive() throws {
        let scratch = try ScratchDirectory()
        let store = try edited(scratch)
        let book = try store.book()
        let shop = try #require(book.transactions.first { $0.notes == "weekly shop" })
        #expect(shop.splits.map(\.amountMinor) == [-3500, -1500])
        #expect(shop.splits[0].notes == "food")
        #expect(shop.splits[1].notes == nil, "an absent note stays absent")
        #expect(try shop.validateSplits())

        let coffee = try #require(book.transactions.first { $0.amountMinor == -320 })
        #expect(try store.tagNames(ids: coffee.tagIds) == ["Treats", "Holiday"])

        let text = try store.exportBackupText(exportedAt: "2026-09-02T12:00:00.000Z")
        let reread = try BackupImporter.load(text: text).book
        #expect(reread.transactions.first { $0.id == shop.id }?.splits == shop.splits)
        #expect(reread.transactions.first { $0.id == coffee.id }?.tagIds == coffee.tagIds)
    }

    @Test("TOMBSTONES STAY IN THE STORE AND NEVER REACH THE FILE")
    func tombstonesAreNotExported() throws {
        let scratch = try ScratchDirectory()
        let store = try edited(scratch)
        #expect(try store.deletedCount("transactions") == 1)

        let buried = try #require(try store.tombstones(table: "transactions").first)

        let text = try store.exportBackupText(exportedAt: "2026-09-02T12:00:00.000Z")
        // The format has no way to say "deleted", which is exactly why the
        // store keeps tombstones and the file does not: the file describes what
        // the book IS, the store also remembers what it WAS.
        let reread = try BackupImporter.load(text: text).book
        let live = try store.liveCount("transactions")
        #expect(reread.transactions.count == live)
        #expect(!reread.transactions.contains { $0.id == buried.id })
        // The PAYEE that mistake created is still in the file, and that is
        // right: deleting a transaction does not delete the payee it named,
        // any more than it deletes the account. Tidying payees is a separate,
        // deliberate act.
        #expect(reread.payees.contains { $0.name == "Typo" })
    }

    @Test("AN EDITED COPY NO LONGER MATCHES THE FILE IT CAME FROM, and does not pretend to")
    func divergenceIsVisible() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let provenance = try store.provenance()
        let sourceHash = try #require(provenance.contentHash)
        // Before any edit, the store re-exports to the file it read.
        #expect(try store.exportReproducingSourceHash() == sourceHash)

        try store.saveTransaction(EditFixture.expense())

        // Afterwards it does not -- and the provenance still records where the
        // book CAME FROM, unchanged, so the two facts can be shown side by
        // side rather than one quietly overwriting the other.
        #expect(try store.exportReproducingSourceHash() != sourceHash)
        #expect(try store.provenance().contentHash == sourceHash)
        #expect(try store.provenance().exportedAt == provenance.exportedAt)
        #expect(try store.localEdits().count == 1)
    }
}
