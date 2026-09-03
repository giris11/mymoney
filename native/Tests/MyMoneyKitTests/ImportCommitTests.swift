// Writing an import plan into a real store, and taking it back out.
//
// THIS IS THE SUITE FOR THE CODE THAT PUTS MONEY IN THE BOOK, so almost nothing
// here asserts that a function returned something. It asserts what is IN THE
// DATABASE afterwards: the amount, the currency it is denominated in, the row
// it collided with or did not, the balance the account now shows, and -- for
// every failure path -- that the book is byte for byte the file it was before.
//
// The three money bugs each get an end-to-end test through the store rather
// than through the plan alone (ImportPlanTests already holds the plan to them):
//
//   D30 -- a row whose file says USD, landing in a EUR account, is stored in
//          EUR, unconverted, and says so.
//   D31 -- a row read as "500" at two decimals, landing in a nought-decimal
//          account, is stored as 500 and not as 50,000 -- and a preview built
//          before the account changed currency is REFUSED rather than written.
//   D32 -- two identical purchases in one file both survive, and re-importing
//          that file adds nothing.
//
// EVERY FIGURE, NAME AND FILE NAME BELOW IS INVENTED, and the book underneath
// is the same fabricated three-account fixture the rest of the suite uses.
import Foundation
import Testing

@testable import MyMoneyKit

// MARK: - Shared helpers

/// Build a plan against what a STORE currently holds. The snapshot comes out of
/// the store rather than being written by hand, so a test cannot accidentally
/// plan against a book that is not the one it is about to write into.
func planAgainst(
    _ store: LedgerStore,
    _ rows: [ParsedRow],
    fileName: String = "statement.csv",
    source: ImportSource = .csv,
    declared: [DeclaredAccount] = [],
    defaultCurrency: String = "GBP"
) throws -> ImportPlan {
    Import.buildPlan(
        rows: rows,
        ledger: ImportLedger(book: try store.book()),
        options: ImportPlanOptions(
            source: source, fileName: fileName, defaultCurrency: defaultCurrency,
            declaredAccounts: declared
        )
    )
}

extension LedgerStore {
    /// Every live transaction of one account, oldest first. The assertions here
    /// are about rows, so they read them.
    func rowsIn(account id: String) throws -> [Transaction] {
        try book().transactions
            .filter { $0.accountId == id }
            .sorted { ($0.date, $0.id) < ($1.date, $1.id) }
    }

    func liveTransaction(withNotes notes: String) throws -> Transaction? {
        try book().transactions.first { $0.notes == notes }
    }

    /// The raw `deleted_at` of a row, tombstones included -- the base table, not
    /// the live view.
    func deletedAt(_ table: String, _ id: String) throws -> String? {
        try rawText("SELECT deleted_at FROM \(table) WHERE id = ?", id)
    }

    /// A count of every live ledger table, for "nothing moved" assertions.
    func liveCounts() throws -> [String: Int] {
        var out: [String: Int] = [:]
        for table in StoreSchema.allTombstonedTables { out[table] = try liveCount(table) }
        return out
    }
}

/// A failure injected into a commit, with a recognisable name.
private struct StopHere: Error {
    let step: String
    let done: Int
}

// MARK: - What a commit actually writes

struct ImportCommitTests {

    @Test("A FILE LANDS ROW FOR ROW, IN THE ACCOUNT'S CURRENCY, AND MOVES THE BALANCE BY EXACTLY ITS TOTAL")
    func rowsLand() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Alpha (w-a): opening 100000, one existing row of -2500 ⇒ 97500.
        #expect(try store.balance(of: "w-a") == 97500)

        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -1250, account: "Alpha",
                        payee: "Kiosk", categoryPath: ["Food", "Groceries"]),
                planRow(2, date: "2026-09-02", amountMinor: 5000, account: "Alpha",
                        payee: "Refunds Ltd"),
            ]
        )
        #expect(plan.importableCount == 2)

        let receipt = try store.commitImport(plan)

        #expect(receipt.transactionCount == 2)
        #expect(receipt.transactionIds.count == 2)
        #expect(receipt.rowsRead == 2)
        // 97500 − 1250 + 5000 = 101250. Arithmetic a person can check.
        #expect(try store.balance(of: "w-a") == 101250)

        let written = try receipt.transactionIds.compactMap { try store.transaction(id: $0) }
        #expect(written.count == 2)
        for row in written {
            #expect(row.currency == "GBP")  // the ACCOUNT's, never the file's
            #expect(row.status == .cleared)
            #expect(row.importBatchId == receipt.batchId)
            #expect(row.splits.isEmpty)
            #expect(row.transferGroupId == nil)
        }
        #expect(written[0].amountMinor == -1250)
        #expect(written[0].date == "2026-09-01")
        // The existing "Food > Groceries" tree was reused, not forked.
        #expect(written[0].categoryId == "c-sub")
        #expect(written[1].amountMinor == 5000)
        #expect(written[1].categoryId == nil)

        // THE DEDUPE KEY IS THE PLAN'S KEY. If this is written any other way, a
        // re-import of the same file collides with nothing and doubles the book.
        #expect(
            written[0].dedupeHash
                == Dedupe.makeDedupeHash(
                    accountId: "w-a", date: "2026-09-01", amountMinor: -1250,
                    payeeOrDescription: "Kiosk"
                )
        )

        // ONE act by the owner, not two rows' worth of acts.
        #expect(try store.localEdits().count == 1)
        // And the batch is there to be undone.
        let batches = try store.importBatches()
        #expect(batches.first?.id == receipt.batchId)
        #expect(batches.first?.rowCount == 2)
        #expect(batches.first?.fileName == "statement.csv")
        #expect(try store.auditMoneyColumns().isEmpty)
        #expect(try store.integrityCheck() == "ok")
    }

    @Test("D30: A ROW THE FILE CALLS USD, LANDING IN A EUR ACCOUNT, IS STORED IN EUR AND SAYS SO")
    func currencyBelongsToTheAccount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Beta (w-b) is EUR: opening 20000, one row of −3000 ⇒ 17000.
        #expect(try store.balance(of: "w-b") == 17000)

        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -2000, currency: "USD",
                        account: "Beta", payee: "Bookshop")
            ]
        )
        let receipt = try store.commitImport(plan)
        #expect(receipt.currencyMismatchCount == 1)

        let row = try #require(try store.transaction(id: receipt.transactionIds[0]))
        // NOT CONVERTED, and not relabelled: the figure is the file's, the
        // denomination is the account's, and the disagreement is on the row.
        #expect(row.amountMinor == -2000)
        #expect(row.currency == "EUR")
        #expect(row.notes.contains("originally USD"))
        #expect(try store.balance(of: "w-b") == 15000)
    }

    @Test("D31: \u{201C}500\u{201D} READ AT TWO DECIMALS LANDS IN A NOUGHT-DECIMAL ACCOUNT AS 500, NOT 50,000")
    func scaleIsResolvedAtTheAccountsCurrency() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let yen = try store.saveAccount(
            AccountDraft(name: "Tokyo", type: .current, currency: "JPY", openingBalanceMinor: 0)
        )

        // What a parser produces before it knows where the row is going: the
        // text "500", read at GBP's two decimals, is 50,000 minor units.
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: 50000, currency: "GBP",
                        account: "Tokyo", payee: "Konbini", amountText: "500")
            ]
        )
        // The plan re-read it at JPY.
        #expect(plan.rows[0].amountMinor == 500)
        #expect(plan.rows[0].resolvedCurrency == "JPY")

        let receipt = try store.commitImport(plan)
        let row = try #require(try store.transaction(id: receipt.transactionIds[0]))
        #expect(row.amountMinor == 500)
        #expect(row.currency == "JPY")
        // A hundredfold error would show up here and nowhere else.
        #expect(try store.balance(of: yen.id) == 500)
    }

    @Test("a paired transfer is written as ONE transfer the editor can open")
    func transfersArePaired() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-05", amountMinor: -10000, account: "Alpha",
                        transferTo: "Beta"),
                planRow(2, date: "2026-09-05", amountMinor: 8500, currency: "EUR",
                        account: "Beta", transferTo: "Alpha"),
            ]
        )
        #expect(plan.unpairedTransferCount == 0)

        let receipt = try store.commitImport(plan)
        #expect(receipt.transferGroupIds.count == 1)
        #expect(receipt.unpairedTransferCount == 0)

        let group = try #require(receipt.transferGroupIds.first)
        // THE EDITOR CAN OPEN IT. An import that wrote a shape the transfer
        // editor cannot read would be a second kind of transfer in the book.
        let pair = try #require(try store.transferPair(groupId: group))
        #expect(pair.from.accountId == "w-a")
        #expect(pair.from.amountMinor == -10000)
        #expect(pair.from.currency == "GBP")
        #expect(pair.to.accountId == "w-b")
        #expect(pair.to.amountMinor == 8500)
        #expect(pair.to.currency == "EUR")
        #expect(pair.isCrossCurrency)
        // A move between two of the owner's own accounts is not spending.
        #expect(pair.from.categoryId == nil)
        #expect(pair.to.categoryId == nil)
        #expect(!pair.from.notes.contains("(transfer)"))
    }

    @Test("AN UNPAIRED TRANSFER LEG IS WRITTEN AS A PLAIN ROW THAT SAYS WHAT IT IS, AND IS COUNTED")
    func unpairedLegsAreDisclosed() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-05", amountMinor: -10000, account: "Alpha",
                        transferTo: "Beta")
            ]
        )
        #expect(plan.unpairedTransferCount == 1)

        let receipt = try store.commitImport(plan)
        #expect(receipt.unpairedTransferCount == 1)
        let row = try #require(try store.transaction(id: receipt.transactionIds[0]))
        #expect(row.transferGroupId == nil)
        // Every report reads an uncategorised row BY SIGN, so this one is about
        // to be counted as £100 of spending. It says on its face that it is not.
        #expect(row.notes.contains("(transfer)"))
    }

    @Test("an account the file names and the book does not is created, with the file's currency and balance")
    func newAccountsAreCreated() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -5000, currency: "EUR",
                        account: "Holiday Fund", payee: "Airline")
            ],
            declared: [
                DeclaredAccount(name: "Holiday Fund", currency: "EUR", openingBalanceMinor: 12345)
            ]
        )
        #expect(plan.accountsToCreateCount == 1)

        let receipt = try store.commitImport(plan)
        #expect(receipt.accountsCreated == 1)
        let id = try #require(receipt.batch.createdAccountIds.first)
        let account = try #require(try store.book().accounts.first { $0.id == id })
        #expect(account.name == "Holiday Fund")
        #expect(account.currency == "EUR")
        #expect(account.openingBalanceMinor == 12345)
        #expect(account.type == .current)
        #expect(account.groupId == nil)
        #expect(!account.archived)
        // The web app's own palette, so the same file imported in either app
        // produces the same-looking list.
        #expect(account.colour == LedgerStore.importAccountPalette[0])
        // 12345 − 5000 = 7345.
        #expect(try store.balance(of: id) == 7345)
        // The row went into the account this import made, in that account's
        // currency.
        let row = try #require(try store.transaction(id: receipt.transactionIds[0]))
        #expect(row.accountId == id)
        #expect(row.currency == "EUR")
    }

    @Test("categories, payees and tags: created once, reused where they exist, and recorded on the batch")
    func entitiesAreCreatedAndRecorded() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                // An existing payee, an existing tag, and a tag written three
                // ways that are one tag.
                planRow(1, date: "2026-09-01", amountMinor: -900, account: "Alpha",
                        payee: "Corner Shop", tags: ["Holiday", "  holiday  ", "Weekend"]),
                // A new payee and a category path the book does not have.
                planRow(2, date: "2026-09-02", amountMinor: -1900, account: "Alpha",
                        payee: "Model Shop", categoryPath: ["Hobbies", "Model Trains"]),
            ]
        )
        let receipt = try store.commitImport(plan)

        // The existing payee was reused, so it is NOT recorded as created --
        // undoing this import must not remove a payee that was already here.
        #expect(receipt.batch.createdPayeeIds.count == 1)
        let newPayee = try #require(
            try store.book().payees.first { $0.id == receipt.batch.createdPayeeIds[0] })
        #expect(newPayee.name == "Model Shop")

        // One new tag, and the existing "Holiday" reused whatever the spacing.
        #expect(receipt.batch.createdTagIds.count == 1)
        let first = try #require(try store.transaction(id: receipt.transactionIds[0]))
        #expect(first.tagIds.count == 2)
        #expect(first.tagIds[0] == "tg1")  // row order is data, and it is kept
        #expect(first.tagIds[1] == receipt.batch.createdTagIds[0])

        // Two categories created, parent before child, and the child is what
        // the row is filed under.
        #expect(receipt.batch.createdCategoryIds.count == 2)
        let categories = try store.book().categories
        let parent = try #require(categories.first { $0.id == receipt.batch.createdCategoryIds[0] })
        let child = try #require(categories.first { $0.id == receipt.batch.createdCategoryIds[1] })
        #expect(parent.name == "Hobbies")
        #expect(parent.parentId == nil)
        #expect(parent.kind == .expense)  // the first row using it is negative
        #expect(child.name == "Model Trains")
        #expect(child.parentId == parent.id)
        let second = try #require(try store.transaction(id: receipt.transactionIds[1]))
        #expect(second.categoryId == child.id)
    }

    @Test("a new path that starts at a category the book already has does NOT fork a second tree")
    func categoryKindComesFromTheExistingRoot() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // "Food" exists as an EXPENSE root. A refund filed under Food > Refunds
        // is positive, so the sign alone would make an INCOME "Food" beside it.
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: 1500, account: "Alpha",
                        payee: "Corner Shop", categoryPath: ["Food", "Refunds"])
            ]
        )
        let receipt = try store.commitImport(plan)
        #expect(receipt.batch.createdCategoryIds.count == 1)  // only the leaf

        let categories = try store.book().categories
        #expect(categories.count { Import.nameKey($0.name) == "food" } == 1)
        let leaf = try #require(categories.first { $0.id == receipt.batch.createdCategoryIds[0] })
        #expect(leaf.name == "Refunds")
        #expect(leaf.parentId == "c-food")
        #expect(leaf.kind == .expense)  // the root's kind, not the sign's
    }

    @Test("the payee learns its category from what this import just wrote (D17)")
    func payeesLearnFromTheImport() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -900, account: "Alpha",
                        payee: "Kiosk", categoryPath: ["Food", "Groceries"]),
                planRow(2, date: "2026-09-02", amountMinor: -1100, account: "Alpha",
                        payee: "Kiosk", categoryPath: ["Food", "Groceries"]),
            ]
        )
        let receipt = try store.commitImport(plan)
        let payee = try #require(
            try store.book().payees.first { $0.id == receipt.batch.createdPayeeIds.first })
        #expect(payee.name == "Kiosk")
        // Learned INSIDE the import, from the two rows it wrote.
        #expect(payee.defaultCategoryId == "c-sub")
    }

    @Test("the notes keep what the file said, and drop only what would be said twice")
    func notesAreJoined() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha",
                        payee: "Kiosk", description: "Card purchase", notes: "ref 88"),
                // A description that is only the payee again adds nothing.
                planRow(2, date: "2026-09-02", amountMinor: -200, account: "Alpha",
                        payee: "Kiosk", description: "kiosk"),
                // No payee at all: the description IS the row's name.
                planRow(3, date: "2026-09-03", amountMinor: -300, account: "Alpha",
                        description: "Parking"),
            ]
        )
        let receipt = try store.commitImport(plan)
        let rows = try receipt.transactionIds.compactMap { try store.transaction(id: $0) }
        #expect(rows[0].notes == "Card purchase \u{2014} ref 88")
        #expect(rows[1].notes == "")
        #expect(rows[2].notes == "Parking")
        // A row with no payee hashes on its description, which is what the plan
        // matched with.
        #expect(
            rows[2].dedupeHash
                == Dedupe.makeDedupeHash(
                    accountId: "w-a", date: "2026-09-03", amountMinor: -300,
                    payeeOrDescription: "Parking"
                )
        )
    }

    @Test("A WHOLE FILE IS ONE CHANGE, NOT ONE CHANGE PER ROW")
    func anImportIsOneAct() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        #expect(try store.localEdits().count == 0)

        // Six rows, two accounts made, three payees, two tags, a category tree
        // -- as many separate writes as a small file ever produces.
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "One"),
                planRow(2, date: "2026-09-02", amountMinor: -200, account: "Alpha", payee: "Two",
                        tags: ["Fresh"]),
                planRow(3, date: "2026-09-03", amountMinor: -300, account: "Alpha", payee: "Two",
                        categoryPath: ["Hobbies", "Kites"]),
                planRow(4, date: "2026-09-04", amountMinor: -400, account: "New One",
                        payee: "Three", tags: ["Other"]),
                planRow(5, date: "2026-09-05", amountMinor: -500, account: "New Two"),
                planRow(6, date: "2026-09-06", amountMinor: 600, account: "Alpha"),
            ]
        )
        #expect(plan.importableCount == 6)
        #expect(plan.accountsToCreateCount == 2)

        try store.commitImport(plan)

        // The banner the owner reads says "1 change not in your web app", and
        // it is telling the truth: they imported one file, once.
        let edits = try store.localEdits()
        #expect(edits.count == 1)
        #expect(edits.firstAt == EditFixture.now)
        #expect(edits.lastAt == EditFixture.now)
        #expect(edits.countLine == "1 change not in your web app")
    }

    @Test("an imported transaction opens in the editor like any other")
    func importedRowsAreOrdinaryRows() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -900, account: "Alpha",
                        payee: "Kiosk", categoryPath: ["Food", "Groceries"], tags: ["Holiday"])
            ]
        )
        let receipt = try store.commitImport(plan)
        let draft = try #require(try store.transactionDraft(forId: receipt.transactionIds[0]))
        #expect(draft.accountId == "w-a")
        #expect(draft.amountMinor == -900)
        #expect(draft.payeeName == "Kiosk")
        #expect(draft.categoryId == "c-sub")
        #expect(draft.tagNames == ["Holiday"])
    }
}

// MARK: - Nothing halfway

struct ImportCommitAtomicityTests {

    @Test("AN IMPORT THAT FAILS HALFWAY LEAVES THE BOOK BYTE FOR BYTE AS IT WAS")
    func aFailedImportChangesNothing() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.exportReproducingSourceHash()
        let countsBefore = try store.liveCounts()
        let editsBefore = try store.localEdits().count

        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "Kiosk"),
                planRow(2, date: "2026-09-02", amountMinor: -200, account: "Alpha", payee: "Kiosk"),
                planRow(3, date: "2026-09-03", amountMinor: -300, account: "New Account",
                        payee: "Kiosk", categoryPath: ["Hobbies"], tags: ["Fresh"]),
            ]
        )
        #expect(plan.importableCount == 3)
        #expect(plan.accountsToCreateCount == 1)

        // Fail with two rows already inserted -- and after an account, a
        // category and a tag have been created, so a rollback that did not work
        // would be obvious rather than subtle.
        var reached: [String] = []
        // WHAT THE ROLLBACK HAS TO UNDO IS RECORDED AS IT HAPPENS. A test that
        // only checks the store afterwards passes just as happily against a
        // commit that never wrote anything at all, so the probe asserts on the
        // way through that the rows really were in: the account, the category,
        // the tag and two transactions are all visible to this connection at
        // the moment the failure is thrown.
        var sawWork: [String: Int] = [:]
        #expect(throws: StopHere.self) {
            try store.commitImport(plan) { step, done in
                reached.append("\(step):\(done)")
                if step == "transaction" && done == 2 {
                    for table in ["accounts", "categories", "tags", "transactions"] {
                        sawWork[table] = try store.liveCount(table)
                    }
                    throw StopHere(step: step, done: done)
                }
            }
        }
        #expect(reached == ["accounts:1", "categories:1", "tags:1", "transaction:1", "transaction:2"])
        #expect(sawWork["accounts"] == (countsBefore["accounts"] ?? 0) + 1)
        #expect(sawWork["categories"] == (countsBefore["categories"] ?? 0) + 1)
        #expect(sawWork["tags"] == (countsBefore["tags"] ?? 0) + 1)
        #expect(sawWork["transactions"] == (countsBefore["transactions"] ?? 0) + 2)

        // THE ONLY QUESTION THAT MATTERS: what does the store contain now?
        #expect(try store.exportReproducingSourceHash() == before)
        #expect(try store.liveCounts() == countsBefore)
        // Tombstones too -- a rollback that left a deleted row deleted would
        // not show up in a live count.
        for table in StoreSchema.allTombstonedTables {
            #expect(try store.deletedCount(table) == 0, "\(table) gained a tombstone")
        }
        #expect(try store.localEdits().count == editsBefore)
        #expect(try store.importBatches().count == 2)  // the two the fixture came with
        #expect(try store.integrityCheck() == "ok")
    }

    @Test("A CONCURRENT READER NEVER SEES A HALF-WRITTEN IMPORT, NOT EVEN FOR A MOMENT")
    func aReaderNeverSeesAPartialImport() throws {
        let scratch = try ScratchDirectory()
        let path = scratch.file("ledger.sqlite").path
        let store = try LedgerStore.open(path: path)
        try store.importBackup(text: StoreFixture.backupText)
        store.environment = .fixed(now: EditFixture.now, idPrefix: "e")

        let watched = ["accounts", "categories", "payees", "tags", "transactions", "import_batches"]
        var before: [String: Int64] = [:]
        for table in watched {
            before[table] = try store.connection.scalarInt("SELECT count(*) FROM \(table)") ?? -1
        }

        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "Kiosk"),
                planRow(2, date: "2026-09-02", amountMinor: -200, account: "Fresh Account",
                        payee: "Someone", categoryPath: ["Hobbies"], tags: ["New"]),
            ]
        )

        // A SECOND connection, read-only, opened DURING the write. In WAL mode
        // it sees the last committed snapshot, so anything visible early would
        // be visible here.
        var observations: [(String, [String: Int64])] = []
        try store.commitImport(plan) { step, done in
            let reader = try SQLiteConnection(path: path, readOnly: true)
            var counts: [String: Int64] = [:]
            for table in watched {
                counts[table] = try reader.scalarInt("SELECT count(*) FROM \(table)") ?? -1
            }
            observations.append(("\(step):\(done)", counts))
        }

        #expect(observations.count >= 5)
        for (where_, counts) in observations {
            for table in watched {
                #expect(counts[table] == before[table], "\(table) visible early, at \(where_)")
            }
        }
        // And once it commits, all of it appears at once.
        #expect(try store.liveCount("transactions") == 4)
        #expect(try store.liveCount("accounts") == 4)
        #expect(try store.liveCount("import_batches") == 3)
    }

    @Test("an account deleted since the preview refuses the whole import rather than dropping its rows")
    func aDeletedAccountRefusesTheImport() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "Kiosk"),
                // Gamma has no transactions, so it can be deleted under us.
                planRow(2, date: "2026-09-02", amountMinor: -200, account: "Gamma", payee: "Kiosk"),
            ]
        )
        try store.deleteAccount(id: "w-c")
        let after = try store.liveCounts()

        let refusal = editError { try store.commitImport(plan) }
        #expect(refusal == .unknownAccount("w-c"))
        // Half a statement is worse than none of it: the row for Alpha was not
        // written either.
        #expect(try store.liveCounts() == after)
        #expect(try store.localEdits().count == 1)  // the delete, and nothing else
    }

    @Test("D31: A PREVIEW BUILT BEFORE THE ACCOUNT CHANGED CURRENCY IS REFUSED, NOT WRITTEN")
    func aStalePlanIsRefused() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // Gamma is GBP and holds nothing, so its currency can still be changed.
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: 50000, account: "Gamma",
                        payee: "Konbini", amountText: "500")
            ]
        )
        #expect(plan.rows[0].amountMinor == 50000)
        #expect(plan.rows[0].resolvedCurrency == "GBP")

        try store.saveAccount(
            AccountDraft(
                id: "w-c", name: "Gamma", type: .loan, currency: "JPY",
                openingBalanceMinor: 500000, colour: "#333333"
            )
        )
        let hash = try store.exportContentHash()

        let refusal = editError { try store.commitImport(plan) }
        #expect(refusal == .importPlanIsStale(accountName: "Gamma", plannedIn: "GBP", nowHolds: "JPY"))
        // The sentence has to be usable: it names the account and both
        // currencies, and says nothing was written.
        let message = try #require(refusal).description
        #expect(message.contains("Gamma"))
        #expect(message.contains("GBP"))
        #expect(message.contains("JPY"))
        #expect(message.contains("Nothing was imported"))
        // 50,000 yen was NOT written where 500 belonged.
        #expect(try store.exportContentHash() == hash)
        #expect(try store.balance(of: "w-c") == 500000)
    }

    @Test("a category deleted since the preview refuses the import -- the import uses the editors' own checks")
    func aDeletedCategoryRefusesTheImport() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha",
                        payee: "Kiosk", categoryPath: ["Food", "Groceries"])
            ]
        )
        #expect(plan.rows[0].chosenCategoryId == "c-sub")

        // Removed under us -- which is what a book restored from the web app,
        // or a second window, can do between the preview and the tap.
        try store.softDelete(table: "categories", id: "c-sub", at: EditFixture.later)
        let counts = try store.liveCounts()

        // The refusal comes from `writeTransaction`, the same function the
        // transaction editor calls: there is no bulk path with a laxer idea of
        // what a valid row is.
        #expect(editError { try store.commitImport(plan) } == .unknownCategory("c-sub"))
        #expect(try store.liveCounts() == counts)
    }

    @Test("a new account the file wants under an impossible currency refuses the whole import")
    func anImpossibleAccountRefusesTheImport() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let hash = try store.exportReproducingSourceHash()
        // A file declaring a currency that is not a currency. The account
        // editor refuses this, so the import does too -- `writeAccount` is the
        // same function.
        let plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-01", amountMinor: -100, currency: "ZZZZ",
                        account: "Odd Account", payee: "Kiosk")
            ],
            defaultCurrency: "ZZZZ"
        )
        #expect(plan.accountsToCreateCount == 1)
        #expect(editError { try store.commitImport(plan) } == .badCurrency("ZZZZ"))
        #expect(try store.exportReproducingSourceHash() == hash)
    }

    @Test("a plan whose rows are all duplicates is refused rather than committed as an empty batch")
    func nothingToWriteIsRefused() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let hash = try store.exportContentHash()
        // A row that cannot be read at all, and nothing else.
        let plan = try planAgainst(
            store, [planRow(1, date: nil, amountMinor: nil, account: "Alpha", error: "no date")]
        )
        #expect(plan.importableCount == 0)

        let refusal = editError { try store.commitImport(plan) }
        #expect(refusal == .importWouldWriteNothing(rowsRead: 1, duplicates: 0, unreadable: 1))
        #expect(try store.exportContentHash() == hash)
        #expect(try store.importBatches().count == 2)
    }

    @Test("THE ADDITIVE CHECK CAN ACTUALLY SEE A REMOVAL, AND AN UNRECORDED ROW")
    func theAdditiveCheckFires() throws {
        // A check that has never been shown to fire is not a check. This drives
        // `refuseUnlessAdditive` directly with a census that says an import did
        // something an import may never do.
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let batch = ImportBatch(
            id: "b", source: .csv, fileName: "f.csv", rowCount: 1, importedAt: EditFixture.now,
            createdAccountIds: [], createdCategoryIds: [], createdPayeeIds: [], createdTagIds: [],
            createdGroupIds: []
        )
        let before = try store.rowCensus()

        // What an honest commit of that batch looks like: one transaction and
        // one batch row, and nothing else moved anywhere.
        var honest = before.live
        honest["transactions"] = (before.live["transactions"] ?? 0) + 1
        honest["import_batches"] = (before.live["import_batches"] ?? 0) + 1
        try store.refuseUnlessAdditive(
            before: before,
            after: LedgerStore.RowCensus(live: honest, deleted: before.deleted),
            batch: batch
        )

        // 1. A BOOK THAT SHRANK -- which is what a RESTORE looks like from
        //    here, and the one thing this path may never do.
        var restored = honest
        restored["transactions"] = 0
        let shrank = try #require(
            storeError {
                try store.refuseUnlessAdditive(
                    before: before,
                    after: LedgerStore.RowCensus(live: restored, deleted: before.deleted),
                    batch: batch
                )
            }
        )
        #expect(String(describing: shrank).contains("transactions"))
        #expect(String(describing: shrank).contains("never replaces or removes"))

        // 2. A row REMOVED -- a tombstone that was not there before. A live
        //    count alone would not see this: the row left the live view and a
        //    new one arrived in its place.
        var deleted = before.deleted
        deleted["payees"] = (before.deleted["payees"] ?? 0) + 1
        let removedOne = try #require(
            storeError {
                try store.refuseUnlessAdditive(
                    before: before,
                    after: LedgerStore.RowCensus(live: honest, deleted: deleted),
                    batch: batch
                )
            }
        )
        #expect(String(describing: removedOne).contains("payees"))

        // 3. A CATEGORY CREATED THAT THE BATCH DOES NOT RECORD -- the exact
        //    shape of bug that leaves undo unable to remove what the import
        //    made, and leaves the owner a category with no explanation.
        var unrecorded = honest
        unrecorded["categories"] = (before.live["categories"] ?? 0) + 1
        let orphan = try #require(
            storeError {
                try store.refuseUnlessAdditive(
                    before: before,
                    after: LedgerStore.RowCensus(live: unrecorded, deleted: before.deleted),
                    batch: batch
                )
            }
        )
        #expect(String(describing: orphan).contains("categories"))

        // 4. And a row the batch records that was never written -- a batch that
        //    lies the other way.
        var missing = honest
        missing["transactions"] = before.live["transactions"] ?? 0
        #expect(
            storeError {
                try store.refuseUnlessAdditive(
                    before: before,
                    after: LedgerStore.RowCensus(live: missing, deleted: before.deleted),
                    batch: batch
                )
            } != nil
        )
    }

    @Test("A COMMIT THAT SOMEHOW REMOVED OR ADDED SOMETHING IT DID NOT RECORD IS ROLLED BACK")
    func theAdditiveCheckIsWiredIntoTheCommit() throws {
        // The test above proves the check can SEE these two things. This proves
        // it is actually on the path -- the probe reaches into the very
        // transaction the commit is running in and does what a future bug would
        // do, and the whole import has to come back out.
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let hash = try store.exportReproducingSourceHash()
        let rows = [
            planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "Kiosk")
        ]

        // 1. A row REMOVED that this import did not create -- one keystroke's
        //    worth of difference between adding rows and restoring a backup.
        let removed = storeError {
            try store.commitImport(try planAgainst(store, rows)) { step, _ in
                guard step == "batch" else { return }
                try store.softDelete(table: "payees", id: "p1", at: EditFixture.later)
            }
        }
        #expect(String(describing: try #require(removed)).contains("payees"))
        #expect(try store.liveRowExists("payees", id: "p1"))
        #expect(try store.exportReproducingSourceHash() == hash)

        // 2. A row CREATED that the batch does not record -- which would leave
        //    undo unable to remove it, for ever.
        let unrecorded = storeError {
            try store.commitImport(try planAgainst(store, rows)) { step, _ in
                guard step == "batch" else { return }
                try store.connection.execute(
                    "INSERT INTO tags (id, name, name_lower, deleted_at) "
                        + "VALUES ('stray', 'Stray', 'stray', NULL)"
                )
            }
        }
        #expect(String(describing: try #require(unrecorded)).contains("tags"))
        #expect(!(try store.liveRowExists("tags", id: "stray")))
        #expect(try store.exportReproducingSourceHash() == hash)
        #expect(try store.localEdits().count == 0)

        // And with nothing interfering, the same import goes in.
        #expect(try store.commitImport(try planAgainst(store, rows)).transactionCount == 1)
    }

    @Test("an import never touches this device's own schedules")
    func schedulesAreLeftAlone() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        try store.saveSchedule(
            ScheduleDraft(
                name: "Rent", accountId: "w-a", amountMinor: -95000, payeeName: "Landlord",
                cadence: .monthly, startDate: "2026-09-01"
            )
        )
        let schedulesBefore = try store.liveCount("schedules")
        #expect(schedulesBefore == 1)

        let plan = try planAgainst(
            store,
            [planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "Kiosk")]
        )
        try store.commitImport(plan)
        // A restore CLEARS every ledger table; this one may not touch a table
        // that is not even in a backup file.
        #expect(try store.liveCount("schedules") == schedulesBefore)
        #expect(try store.deletedCount("schedules") == 0)
    }
}

// MARK: - Importing the same file twice

struct ImportCommitIdempotenceTests {

    @Test("RE-IMPORTING THE SAME FILE ADDS NOTHING")
    func reimportingAddsNothing() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let rows = [
            planRow(1, date: "2026-09-01", amountMinor: -1250, account: "Alpha", payee: "Kiosk"),
            planRow(2, date: "2026-09-02", amountMinor: -4000, account: "Alpha",
                    description: "Fuel stop"),
            planRow(3, date: "2026-09-03", amountMinor: 5000, currency: "EUR", account: "Beta",
                    payee: "Refunds Ltd"),
        ]
        try store.commitImport(try planAgainst(store, rows))
        let hash = try store.exportContentHash()
        let counts = try store.liveCounts()

        // The same file again, planned against the book it just went into.
        let second = try planAgainst(store, rows)
        // Every row met the row it wrote last time -- which is only true if the
        // dedupe key the commit stored is the key the plan matches on.
        #expect(second.exactDuplicateCount == 3)
        #expect(second.importableCount == 0)

        let refusal = editError { try store.commitImport(second) }
        #expect(refusal == .importWouldWriteNothing(rowsRead: 3, duplicates: 3, unreadable: 0))
        #expect(try store.exportContentHash() == hash)
        #expect(try store.liveCounts() == counts)
    }

    @Test("D32: TWO GENUINELY IDENTICAL PURCHASES IN ONE FILE BOTH SURVIVE, AND STAY TWO")
    func twoIdenticalPurchasesBothSurvive() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // The same coffee, twice, on the same day. Two real purchases.
        let rows = [
            planRow(1, date: "2026-09-01", amountMinor: -350, account: "Alpha", payee: "Kiosk"),
            planRow(2, date: "2026-09-01", amountMinor: -350, account: "Alpha", payee: "Kiosk"),
        ]
        let receipt = try store.commitImport(try planAgainst(store, rows))
        #expect(receipt.transactionCount == 2)
        // 97500 − 350 − 350. If either had been swallowed the balance would say so.
        #expect(try store.balance(of: "w-a") == 96800)

        // Importing the file again: two rows meet the two rows already there.
        let again = try planAgainst(store, rows)
        #expect(again.exactDuplicateCount == 2)
        #expect(editError { try store.commitImport(again) } != nil)
        #expect(try store.balance(of: "w-a") == 96800)

        // And a THIRD identical purchase, in a file of three: two are consumed
        // by what is already there and exactly one is new.
        let third = try planAgainst(store, rows + [
            planRow(3, date: "2026-09-01", amountMinor: -350, account: "Alpha", payee: "Kiosk")
        ])
        #expect(third.exactDuplicateCount == 2)
        #expect(third.importableCount == 1)
        #expect(try store.commitImport(third).transactionCount == 1)
        #expect(try store.balance(of: "w-a") == 96450)
        #expect(try store.rowsIn(account: "w-a").count == 4)  // the fixture's one, plus three
    }

    @Test("a near duplicate the owner accepts is written; one they leave alone is not")
    func decisionsAreHonoured() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // The book already holds this. A row a day later for the same amount
        // and a similar payee is a NEAR duplicate: never resolved automatically.
        try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-09-01", amountMinor: -1250, payeeName: "Kiosk Ltd"
            )
        )
        var plan = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-02", amountMinor: -1250, account: "Alpha", payee: "Kiosk"),
                planRow(2, date: "2026-09-05", amountMinor: -700, account: "Alpha", payee: "Kiosk"),
            ]
        )
        #expect(plan.nearDuplicateCount == 1)
        #expect(plan.importableCount == 1)  // the near duplicate defaults to skip

        let firstReceipt = try store.commitImport(plan)
        #expect(firstReceipt.transactionCount == 1)
        #expect(firstReceipt.decisionsSkipped == 1)

        // Now the owner says yes to it.
        plan.setDecision(.add, forRowAt: 0)
        #expect(plan.importableCount == 2)
        // The second row is now an exact duplicate of what the first commit
        // wrote, so only the accepted near duplicate is new.
        let replanned = try planAgainst(
            store,
            [
                planRow(1, date: "2026-09-02", amountMinor: -1250, account: "Alpha", payee: "Kiosk"),
                planRow(2, date: "2026-09-05", amountMinor: -700, account: "Alpha", payee: "Kiosk"),
            ]
        )
        var accepted = replanned
        #expect(accepted.nearDuplicateCount == 1)
        accepted.setDecision(.add, forRowAt: 0)
        let secondReceipt = try store.commitImport(accepted)
        #expect(secondReceipt.transactionCount == 1)
        #expect(secondReceipt.decisionsSkipped == 0)
    }
}

// MARK: - A real export, all the way through

struct ImportCommitReportTests {

    @Test("THE ORACLE'S REPORT FIXTURE, PARSED AND IMPORTED: EVERY ACCOUNT ENDS ON THE BALANCE THE FILE STATES")
    func aWholeReportExportReconcilesInTheStore() throws {
        // THE PROPERTY THE WHOLE PATH EXISTS FOR, asserted where it actually
        // matters -- not on the plan, but on the balances the accounts screen
        // will draw after the import has been written:
        //
        //     opening + Σ(that account's rows) == the balance the file states
        //
        // The CSV is read out of the repository's own oracle fixtures at run
        // time, never copied here, and every figure in it is invented.
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.createBook(baseCurrency: "GBP")
        store.environment = .fixed(now: EditFixture.now, idPrefix: "e")

        let parsed = Import.parseMoneyWizReportCsv(
            try PlanFixture.csv(caseId: "import.report.real-export"))
        let plan = try planAgainst(
            store, parsed.rows, fileName: "report.csv", source: .moneywiz,
            declared: Import.reportPlanOptions(parsed.accounts)
        )
        let receipt = try store.commitImport(plan)

        // 18 rows, two of which cannot be read; ten accounts created.
        #expect(receipt.rowsRead == 18)
        #expect(receipt.transactionCount == 16)
        #expect(receipt.unreadableRows == 2)
        #expect(receipt.accountsCreated == 10)
        #expect(try store.liveCount("transactions") == 16)

        let accountsByName = try Dictionary(
            uniqueKeysWithValues: store.book().accounts.map { ($0.name, $0) })
        var reconciled = 0
        for declared in parsed.accounts {
            let account = try #require(accountsByName[declared.name], "\(declared.name) is missing")
            guard let opening = declared.openingBalanceMinor,
                  let stated = declared.currentBalanceMinor
            else {
                // An account the file could not state a trustworthy opening
                // balance for is created at ZERO rather than at a guess.
                #expect(account.openingBalanceMinor == 0)
                continue
            }
            #expect(account.openingBalanceMinor == opening)
            #expect(try store.balance(of: account.id) == stated, "\(declared.name) must reconcile")
            reconciled += 1
        }
        #expect(reconciled == 7, "seven of the nine declared accounts state a usable balance")

        #expect(try store.auditMoneyColumns().isEmpty)
        #expect(try store.integrityCheck() == "ok")

        // And the whole of it comes back out again.
        let hashAfter = try store.exportContentHash()
        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        let undone = try store.undoImport(batchId: receipt.batchId)
        #expect(undone.transactionCount == 16)
        #expect(undone.accountIds.count == 10)
        #expect(try store.liveCount("transactions") == 0)
        #expect(try store.exportContentHash() != hashAfter)
    }

    @Test("re-importing that whole export into the book it just made adds nothing")
    func theWholeReportIsIdempotent() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.createBook(baseCurrency: "GBP")
        store.environment = .fixed(now: EditFixture.now, idPrefix: "e")

        let parsed = Import.parseMoneyWizReportCsv(
            try PlanFixture.csv(caseId: "import.report.real-export"))
        func freshPlan() throws -> ImportPlan {
            try planAgainst(
                store, parsed.rows, fileName: "report.csv", source: .moneywiz,
                declared: Import.reportPlanOptions(parsed.accounts)
            )
        }
        try store.commitImport(try freshPlan())
        let hash = try store.exportContentHash()

        let second = try freshPlan()
        // Sixteen rows written, sixteen rows matched. Not fifteen, and not
        // seventeen: a consumed match is one match (D32).
        #expect(second.exactDuplicateCount == 16)
        #expect(second.importableCount == 0)
        // The accounts all exist now, so there is nothing left to create.
        #expect(second.accountsToCreateCount == 0)
        #expect(editError { try store.commitImport(second) } != nil)
        #expect(try store.exportContentHash() == hash)
    }

    @Test("an import into a device with no book at all is refused")
    func thereHasToBeABookFirst() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        store.environment = .fixed(now: EditFixture.now, idPrefix: "e")
        let plan = try planAgainst(
            store,
            [planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "Kiosk")]
        )
        #expect(editError { try store.commitImport(plan) } == .noBook)
        #expect(try store.isEmpty())
    }
}

// MARK: - Undo

struct ImportUndoTests {

    /// Import a file that creates one of everything, so an undo has something
    /// of every kind to take back.
    private func importEverything(into store: LedgerStore) throws -> ImportReceipt {
        try store.commitImport(
            try planAgainst(
                store,
                [
                    planRow(1, date: "2026-09-01", amountMinor: -1250, account: "Alpha",
                            payee: "Kiosk", categoryPath: ["Hobbies", "Model Trains"],
                            tags: ["Fresh"]),
                    planRow(2, date: "2026-09-02", amountMinor: -400, currency: "EUR",
                            account: "Holiday Fund", payee: "Airline"),
                    planRow(3, date: "2026-09-03", amountMinor: -10000, account: "Alpha",
                            transferTo: "Beta"),
                    planRow(4, date: "2026-09-03", amountMinor: 8500, currency: "EUR",
                            account: "Beta", transferTo: "Alpha"),
                ],
                declared: [
                    DeclaredAccount(name: "Holiday Fund", currency: "EUR", openingBalanceMinor: 0)
                ]
            )
        )
    }

    @Test("UNDOING AN IMPORT RETURNS THE BOOK TO EXACTLY WHAT IT WAS, BYTE FOR BYTE")
    func undoRestoresTheBookExactly() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.exportReproducingSourceHash()
        let countsBefore = try store.liveCounts()

        let receipt = try importEverything(into: store)
        #expect(receipt.transactionCount == 4)
        #expect(receipt.accountsCreated == 1)
        #expect(receipt.categoriesCreated == 2)
        #expect(receipt.tagsCreated == 1)
        #expect(try store.exportReproducingSourceHash() != before)

        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        let undone = try store.undoImport(batchId: receipt.batchId)

        #expect(undone.transactionCount == 4)
        #expect(undone.accountIds.count == 1)
        #expect(undone.categoryIds.count == 2)
        #expect(undone.payeeIds.count == 2)
        #expect(undone.tagIds.count == 1)
        #expect(undone.keptAccountIds.isEmpty)
        #expect(undone.keptCategoryIds.isEmpty)

        // THE WHOLE CLAIM, IN ONE LINE: the book re-exports to the same bytes
        // it did before the import. Not "the right number of rows" -- the same
        // file, payees' learned categories included.
        #expect(try store.exportReproducingSourceHash() == before)
        #expect(try store.liveCounts() == countsBefore)
        #expect(try store.importBatches().count == 2)
        #expect(try store.auditMoneyColumns().isEmpty)
        // Two acts by the owner: the import, and taking it back.
        #expect(try store.localEdits().count == 2)
    }

    @Test("NOTHING IS DESTROYED: an undone import is tombstoned, not deleted")
    func undoTombstonesRatherThanDeletes() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try importEverything(into: store)
        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        try store.undoImport(batchId: receipt.batchId)

        for id in receipt.transactionIds {
            #expect(try store.deletedAt("transactions", id) == EditFixture.later)
            // Still there, with its amount and its splits, because a tombstone
            // is a save and not a destruction.
            #expect(
                try store.connection.scalarInt(
                    "SELECT count(*) FROM transactions WHERE id = '\(id)'") == 1
            )
        }
        #expect(try store.deletedAt("import_batches", receipt.batchId) == EditFixture.later)
    }

    @Test("UNDO DOES NOT RESURRECT A ROW A LATER EDIT REMOVED")
    func undoDoesNotResurrect() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try importEverything(into: store)

        // The owner deletes one of the imported rows themselves, on another day.
        let deletedDay = "2026-09-04T09:00:00.000Z"
        store.environment = .fixed(now: deletedDay, idPrefix: "d")
        let firstId = receipt.transactionIds[0]
        try store.deleteTransaction(id: firstId)
        #expect(try store.deletedAt("transactions", firstId) == deletedDay)

        // Undoing the import must not bring it back, and must not re-stamp it:
        // WHEN it was deleted is a fact.
        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        let undone = try store.undoImport(batchId: receipt.batchId)
        #expect(!undone.transactionIds.contains(firstId))
        #expect(try store.deletedAt("transactions", firstId) == deletedDay)
        #expect(try store.transaction(id: firstId) == nil)
        // The rest went now.
        #expect(try store.deletedAt("transactions", receipt.transactionIds[1]) == EditFixture.later)
    }

    @Test("undo still removes a row the owner EDITED after the import")
    func undoFollowsProvenanceThroughAnEdit() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try importEverything(into: store)

        // Re-categorise it, rename its payee, move it: it is still a row this
        // import put in the book.
        let id = receipt.transactionIds[0]
        var draft = try #require(try store.transactionDraft(forId: id))
        draft.amountMinor = -9999
        draft.payeeName = "Somewhere Else"
        try store.saveTransaction(draft)
        #expect(try store.transaction(id: id)?.importBatchId == receipt.batchId)

        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        let undone = try store.undoImport(batchId: receipt.batchId)
        #expect(undone.transactionIds.contains(id))
        #expect(try store.transaction(id: id) == nil)
    }

    @Test("UNDO KEEPS AN ACCOUNT THE OWNER HAS USED SINCE, AND EVERYTHING IN IT")
    func undoKeepsAnAccountInUse() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try importEverything(into: store)
        let created = try #require(receipt.batch.createdAccountIds.first)

        // The owner starts using the account the import made.
        let mine = try store.saveTransaction(
            TransactionDraft(
                accountId: created, date: "2026-09-10", amountMinor: -2500, payeeName: "My Shop"
            )
        )

        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        let undone = try store.undoImport(batchId: receipt.batchId)
        #expect(undone.accountIds.isEmpty)
        #expect(undone.keptAccountIds == [created])
        // The account is still there, and so is the transaction the owner made.
        #expect(try store.liveAccount(id: created) != nil)
        #expect(try store.transaction(id: mine.id) != nil)
        #expect(try store.balance(of: created) == -2500)
    }

    @Test("undo keeps a category the owner has filed something under, and its parent with it")
    func undoKeepsACategoryInUse() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try importEverything(into: store)
        let parent = try #require(receipt.batch.createdCategoryIds.first)
        let leaf = try #require(receipt.batch.createdCategoryIds.last)

        // A transaction of the owner's own, filed under the imported category.
        try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-09-10", amountMinor: -600, payeeName: "My Shop",
                categoryId: leaf
            )
        )

        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        let undone = try store.undoImport(batchId: receipt.batchId)
        #expect(undone.categoryIds.isEmpty)
        // The leaf is in use; the parent has a live child, so it stays too --
        // otherwise the leaf would be orphaned under an id that is gone.
        #expect(Set(undone.keptCategoryIds) == Set([parent, leaf]))
        let categories = try store.book().categories.map(\.id)
        #expect(categories.contains(parent))
        #expect(categories.contains(leaf))
    }

    @Test("a payee or tag still on a live row survives the undo")
    func undoKeepsAPayeeStillInUse() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try importEverything(into: store)
        let payeeId = try #require(receipt.batch.createdPayeeIds.first)
        let tagId = try #require(receipt.batch.createdTagIds.first)
        let payeeName = try #require(try store.payeeName(id: payeeId))

        // The owner types their own transaction with the same payee and tag.
        try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-09-10", amountMinor: -600, payeeName: payeeName,
                tagNames: ["Fresh"]
            )
        )

        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        let undone = try store.undoImport(batchId: receipt.batchId)
        #expect(!undone.payeeIds.contains(payeeId))
        #expect(!undone.tagIds.contains(tagId))
        #expect(try store.payeeName(id: payeeId) == payeeName)
        #expect(try store.liveRowExists("tags", id: tagId))
    }

    @Test("undoing twice is refused, and the second attempt changes nothing")
    func undoIsNotIdempotentlyDestructive() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try importEverything(into: store)
        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        try store.undoImport(batchId: receipt.batchId)
        let hash = try store.exportContentHash()
        let edits = try store.localEdits().count

        let refusal = editError { try store.undoImport(batchId: receipt.batchId) }
        #expect(refusal == .unknownImportBatch(receipt.batchId))
        #expect(try store.exportContentHash() == hash)
        #expect(try store.localEdits().count == edits)
        #expect(editError { try store.undoImport(batchId: "never-existed") } != nil)
    }

    @Test("an import batch that arrived in a RESTORED book can be undone too, extras and all")
    func undoWorksOnABatchFromTheWebApp() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // "ib2" is the fixture's sample-data batch: it carries the two lists
        // only a sample writes (D19) -- one budget and one FX rate.
        #expect(try store.liveRowExists("budgets", id: "b1"))
        #expect(try store.liveRowExists("fx_rates", id: "EUR:GBP"))

        let undone = try store.undoImport(batchId: "ib2")
        #expect(undone.transactionCount == 0)
        #expect(!(try store.liveRowExists("budgets", id: "b1")))
        #expect(!(try store.liveRowExists("fx_rates", id: "EUR:GBP")))

        // And "ib1" is an ordinary csv batch with one transaction and the payee
        // it created.
        let other = try store.undoImport(batchId: "ib1")
        #expect(other.transactionIds == ["t2"])
        #expect(other.payeeIds == ["p1"])
        #expect(try store.transaction(id: "t2") == nil)
    }

    @Test("an FX rate the owner has edited since is NOT removed by undoing the batch that made it")
    func undoLeavesAnEditedRateAlone() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        // A rate row has a fixed id, so editing it OVERWRITES the sample's row
        // rather than adding one. `asOf` moving is the proof that this is the
        // owner's rate now -- and removing it would drop their EUR accounts out
        // of net worth.
        try store.connection.execute(
            "UPDATE fx_rates SET rate = 0.9, as_of = '2026-09-01T00:00:00.000Z' "
                + "WHERE id = 'EUR:GBP'"
        )
        try store.undoImport(batchId: "ib2")
        #expect(try store.liveRowExists("fx_rates", id: "EUR:GBP"))
        // The budget, which carries no such evidence, still goes.
        #expect(!(try store.liveRowExists("budgets", id: "b1")))
    }

    @Test("the import list is newest first, and an undone import is off it")
    func importBatchesAreListedNewestFirst() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let receipt = try store.commitImport(
            try planAgainst(
                store,
                [planRow(1, date: "2026-09-01", amountMinor: -100, account: "Alpha", payee: "Kiosk")]
            )
        )
        // The fixture's two are dated August and January; this one is today.
        #expect(try store.importBatches().map(\.id) == [receipt.batchId, "ib1", "ib2"])
        store.environment = .fixed(now: EditFixture.later, idPrefix: "u")
        try store.undoImport(batchId: receipt.batchId)
        #expect(try store.importBatches().map(\.id) == ["ib1", "ib2"])
    }
}
