// A statement arriving at a device that has nothing on it yet.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SUITE IS ABOUT
//
// A fresh install, no book, a real MoneyWiz Report export chosen from the share
// sheet. The file was read correctly -- the row count and every column named on
// screen -- and then the one button that could do anything with it was greyed
// out, with no sentence anywhere saying why. The rule behind it was "a
// statement adds rows to a book, and there is no book".
//
// THAT RULE IS WRONG FOR THIS FILE. A Report export DECLARES its accounts: each
// account's name, its ledger currency and its closing balance sit on header
// rows, and the parser works backwards from them to an opening balance. It is a
// description of a whole ledger. There is nothing it needs from a book that it
// does not bring with it, so it can populate an empty device exactly, and the
// balances can be checked against the figures the file itself states.
//
// EVERY FIGURE, NAME, PAYEE AND FILE NAME BELOW IS INVENTED.
import Foundation
import Testing

@testable import MyMoneyKit

struct ImportEmptyDeviceTests {

    /// A Report export in the shape the parser expects: account header rows
    /// carrying a name and a closing balance, transactions under each.
    ///
    /// Everyday (GBP): closes at 150.00 after −3.50 and +100.00, so it opened
    /// at 53.50. Holiday (EUR): closes at 80.00 after −20.00, so it opened at
    /// 100.00. Both sums are checked below rather than asserted as magic.
    /// Header row, account header rows ("Name" filled, "Account" holding the
    /// account's CURRENCY) and transaction rows ("Name" empty, "Account"
    /// holding the account's NAME) -- the shape the real export has, and the
    /// trap the parser exists to not fall into.
    static let reportCsv = """
        Name,Current balance,Account,Transfers,Description,Payee,Category,Date,Memo,Amount,Currency,Cheque N°,Tags,Balance
        Everyday,150.00,GBP,,,,,,,,,,,
        ,,Everyday,,Coffee,Kiosk,Food,2026-03-01,,-3.50,GBP,,,
        ,,Everyday,,Wages,Employer,Income,2026-03-02,,100.00,GBP,,,
        Holiday,80.00,EUR,,,,,,,,,,,
        ,,Holiday,,Ferry,Ferries,Travel,2026-03-03,,-20.00,EUR,,,
        """

    /// The plan a file like that produces against a book that does not exist.
    static func planForEmptyBook(
        _ text: String = reportCsv, defaultCurrency: String = "GBP"
    ) -> ImportPlan {
        let parsed = Import.parseMoneyWizReportCsv(text, dateFormat: .auto)
        return Import.buildPlan(
            rows: parsed.rows,
            ledger: ImportLedger(),
            options: ImportPlanOptions(
                source: .moneywiz, fileName: "report.csv", defaultCurrency: defaultCurrency,
                declaredAccounts: Import.reportPlanOptions(parsed.accounts)
            )
        )
    }

    private static func emptyStore(_ scratch: ScratchDirectory) throws -> LedgerStore {
        let store = try scratch.store()
        store.environment = .fixed(now: EditFixture.now, idPrefix: "n")
        return store
    }

    // MARK: - The file can populate a device with no book at all

    @Test("A FILE THAT DECLARES ITS ACCOUNTS POPULATES A DEVICE WITH NO BOOK, EXACTLY")
    func populatesAnEmptyDevice() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        #expect(try store.isEmpty())

        let plan = Self.planForEmptyBook()
        // The plan alone already knows the whole answer -- this is the part
        // that was never broken, and the reason refusing the file was the app
        // declining to do something it could already do.
        #expect(plan.accountsToCreateCount == 2)
        #expect(plan.importableCount == 3)
        #expect(plan.newAccounts.map(\.name) == ["Everyday", "Holiday"])
        #expect(plan.newAccounts.map(\.currency) == ["GBP", "EUR"])
        // 150.00 − (−3.50 + 100.00) = 53.50, and 80.00 − (−20.00) = 100.00.
        #expect(plan.newAccounts.map(\.openingBalanceMinor) == [5350, 10000])

        let receipt = try store.commitImport(plan, creatingBookWithBaseCurrency: "GBP")

        #expect(receipt.transactionCount == 3)
        #expect(receipt.accountsCreated == 2)
        let book = try store.book()
        #expect(book.baseCurrency == "GBP")
        #expect(book.settings?.onboarded == true)

        // THE FIGURES THE FILE STATES, recomputed from the rows that landed.
        let everyday = try #require(book.accounts.first { $0.name == "Everyday" })
        let holiday = try #require(book.accounts.first { $0.name == "Holiday" })
        #expect(everyday.currency == "GBP")
        #expect(holiday.currency == "EUR")
        #expect(try store.balance(of: everyday.id) == 15000)
        #expect(try store.balance(of: holiday.id) == 8000)
    }

    @Test("the whole thing is ONE transaction: a failure part-way leaves no book at all")
    func bookAndRowsLandTogether() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        let plan = Self.planForEmptyBook()

        struct StopHere: Error {}
        #expect(throws: StopHere.self) {
            try store.commitImport(plan, creatingBookWithBaseCurrency: "GBP") { step, _ in
                if step == "transaction" { throw StopHere() }
            }
        }
        // Not "a book with no rows in it", which would be a device that looks
        // set up and holds nothing. Nothing at all.
        #expect(try store.isEmpty())
        #expect(try store.book().accounts.isEmpty)
    }

    @Test("with no book and no currency it still refuses, and says what to do")
    func stillRefusesWithNoCurrency() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        let plan = Self.planForEmptyBook()

        #expect(editError { try store.commitImport(plan) } == .noBook)
        #expect(
            editError { try store.commitImport(plan, creatingBookWithBaseCurrency: nil) }
                == .noBook
        )
        #expect(EditError.noBook.problem.contains("no book on this device"))
        #expect(try store.isEmpty())
    }

    @Test("a base currency that is not a currency is refused, and nothing is written")
    func refusesABadCurrency() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        let plan = Self.planForEmptyBook()

        #expect(
            editError { try store.commitImport(plan, creatingBookWithBaseCurrency: "pounds") }
                == .badCurrency("pounds")
        )
        #expect(try store.isEmpty())
    }

    @Test("the currency is IGNORED when a book is already here \u{2014} it can never replace one")
    func neverReplacesABook() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.exportContentHash()
        let baseBefore = try store.book().baseCurrency

        let plan = try planAgainst(
            store,
            [planRow(1, date: "2026-09-01", amountMinor: -1250, account: "Alpha", payee: "Kiosk")]
        )
        _ = try store.commitImport(plan, creatingBookWithBaseCurrency: "JPY")

        #expect(try store.book().baseCurrency == baseBefore)
        #expect(try store.exportContentHash() != before)  // the rows did land
        #expect(try store.book().accounts.count == 3)  // and no book was seeded over it
    }

    // MARK: - A book with accounts already in it

    @Test("a book with NO ACCOUNTS accepts a file that declares its own")
    func emptyBookWithNoAccounts() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        try store.createBook(baseCurrency: "GBP")
        #expect(try store.book().accounts.isEmpty)

        let plan = Self.planForEmptyBook()
        let receipt = try store.commitImport(plan, creatingBookWithBaseCurrency: nil)

        #expect(receipt.accountsCreated == 2)
        #expect(receipt.transactionCount == 3)
        #expect(try store.book().accounts.count == 2)
    }

    @Test("the seeded categories are reused, not doubled, by the file's own paths")
    func categoriesAreReusedNotDoubled() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        let plan = Self.planForEmptyBook()
        // Planned against nothing, so every path in the file is "new".
        #expect(plan.newCategoryPaths.contains(["Food"]))

        try store.commitImport(plan, creatingBookWithBaseCurrency: "GBP")

        // One "Food" root, not two: the book is created first, inside the same
        // transaction, and the import resolves against what is then there.
        let roots = try store.book().categories.filter { ($0.parentId ?? "").isEmpty }
        let foodRoots = roots.filter { Import.nameKey($0.name) == Import.nameKey("Food") }
        #expect(foodRoots.count <= 1)
        for name in Set(roots.map { Import.nameKey($0.name) }) {
            #expect(roots.count { Import.nameKey($0.name) == name } == 1)
        }
    }

    @Test("the whole import can still be undone, and the book it created stays")
    func undoLeavesTheBook() throws {
        let scratch = try ScratchDirectory()
        let store = try Self.emptyStore(scratch)
        let receipt = try store.commitImport(
            Self.planForEmptyBook(), creatingBookWithBaseCurrency: "GBP"
        )

        let undone = try store.undoImport(batchId: receipt.batchId)

        #expect(undone.transactionCount == 3)
        #expect(undone.accountIds.count == 2)
        #expect(try store.book().transactions.isEmpty)
        #expect(try store.book().accounts.isEmpty)
        // The BOOK is not undone -- undo takes back what the import added, and
        // deletion in this app is a tombstone save, never a hard delete. The
        // device is left with an empty book, which is a state it has a screen
        // for, rather than with half of one.
        #expect(try !store.isEmpty())
        #expect(try store.book().baseCurrency == "GBP")
    }
}
