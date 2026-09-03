// A plain bank CSV, which never says which account it is for.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SECOND DEAD END
//
// A MoneyWiz Report declares its accounts. A bank's own CSV does not: it is one
// account's statement, and every row of it means "this account" without ever
// naming it. The planner answered that with `fixedAccountId` -- pin every row
// to an account already in the book -- which works right up until the book has
// no accounts to pin to. Then the picker was empty, the requirement could not
// be satisfied, and the only live control on the screen was the one that gave
// up.
//
// So an account can now be NAMED rather than only chosen, and the planner
// treats that name exactly as it treats a name the file itself stated: matched
// against the book first, created otherwise, tickable in the preview, its
// currency fixing the scale its amounts are read at.
//
// EVERY FIGURE, NAME AND PAYEE BELOW IS INVENTED.
import Foundation
import Testing

@testable import MyMoneyKit

struct ImportPinnedAccountTests {

    /// Two rows of a statement with no Account column at all.
    private static func statementRows() -> [ParsedRow] {
        [
            planRow(1, date: "2026-03-01", amountMinor: -350, account: nil, payee: "Kiosk"),
            planRow(2, date: "2026-03-02", amountMinor: -700, account: nil, payee: "Baker"),
        ]
    }

    private static func plan(
        rows: [ParsedRow] = statementRows(),
        ledger: ImportLedger = ImportLedger(),
        name: String = "Card",
        currency: String = "GBP",
        opening: Int64? = nil,
        fixedAccountId: String? = nil
    ) -> ImportPlan {
        Import.buildPlan(
            rows: rows, ledger: ledger,
            options: ImportPlanOptions(
                source: .csv, fileName: "bank.csv", defaultCurrency: "GBP",
                fixedAccountId: fixedAccountId,
                fixedNewAccount: DeclaredAccount(
                    name: name, currency: currency, openingBalanceMinor: opening
                )
            )
        )
    }

    // MARK: - The plan

    @Test("A FILE WITH NO ACCOUNT COLUMN CAN BE PINNED TO AN ACCOUNT THAT DOES NOT EXIST YET")
    func pinsToANewAccount() {
        let plan = Self.plan()

        #expect(plan.importableCount == 2)
        #expect(plan.errorCount == 0)
        #expect(plan.newAccounts.map(\.name) == ["Card"])
        #expect(plan.newAccounts[0].currency == "GBP")
        #expect(plan.accountsToCreateCount == 1)
        // Every row says where it goes, so nothing downstream has to re-derive
        // it from a file that never said.
        #expect(plan.rows.allSatisfy { $0.newAccountName == "Card" })
        #expect(plan.rows.allSatisfy { $0.accountId == nil })
    }

    @Test("unticking the account it would create drops every row, and says so in the counts")
    func untickingDropsTheRows() {
        var plan = Self.plan()
        plan.setCreateAccount(named: "Card", false)

        #expect(plan.accountsToCreateCount == 0)
        #expect(plan.importableCount == 0)
        #expect(plan.rows.allSatisfy { !$0.isImportable })
    }

    @Test("a name that is ALREADY in the book files the rows into that account, not a second one")
    func matchesAnExistingAccountByName() {
        let existing = planAccount("a1", "Card", "GBP")
        let plan = Self.plan(ledger: ImportLedger(accounts: [existing]), name: "  card  ")

        // Case- and whitespace-insensitively, the way every account lookup in
        // the importer is keyed.
        #expect(plan.newAccounts.isEmpty)
        #expect(plan.importableCount == 2)
        #expect(plan.rows.allSatisfy { $0.accountId == "a1" })
        #expect(plan.rows.allSatisfy { $0.newAccountName == nil })
    }

    @Test("THE PINNED ACCOUNT'S CURRENCY FIXES THE SCALE ITS AMOUNTS ARE READ AT (D31)")
    func currencyFixesTheScale() {
        // "500" parsed at the file's assumed two decimals is 50000 minor units.
        // Landing in a nought-decimal account it must be 500, not 50,000 -- the
        // account decides the scale, and the account here is one that does not
        // exist yet.
        let rows = [
            planRow(
                1, date: "2026-03-01", amountMinor: 50000, currency: nil, account: nil,
                payee: "Vending", amountText: "500"
            )
        ]
        let plan = Self.plan(rows: rows, name: "Tokyo cash", currency: "JPY")

        #expect(plan.rows[0].resolvedCurrency == "JPY")
        #expect(plan.rows[0].amountMinor == 500)
        #expect(plan.newAccounts[0].currency == "JPY")
    }

    @Test("a row that declares another currency is stored in the account's, and counted (D30)")
    func currencyMismatchIsDisclosed() {
        let rows = [
            planRow(
                1, date: "2026-03-01", amountMinor: -400, currency: "EUR", account: nil,
                payee: "Ferry", amountText: "-4.00"
            )
        ]
        let plan = Self.plan(rows: rows, name: "Card", currency: "GBP")

        #expect(plan.rows[0].resolvedCurrency == "GBP")
        #expect(plan.currencyMismatchCount == 1)
        #expect(plan.importableCount == 1)
    }

    @Test("an id beats a name: a chosen account wins and no account is created")
    func chosenAccountWins() {
        let existing = planAccount("a9", "Everyday", "GBP")
        let plan = Self.plan(
            ledger: ImportLedger(accounts: [existing]), name: "Card", fixedAccountId: "a9"
        )

        #expect(plan.newAccounts.isEmpty)
        #expect(plan.rows.allSatisfy { $0.accountId == "a9" })
    }

    @Test("a blank name pins nothing, and the rows still say what is missing")
    func blankNamePinsNothing() {
        let plan = Self.plan(name: "   ")

        #expect(plan.newAccounts.isEmpty)
        #expect(plan.importableCount == 0)
        #expect(plan.errorCount == 2)
        #expect(plan.problems.allSatisfy { $0.reason.contains("No account") })
    }

    @Test("a row that cannot be read is still counted against the account it was bound for")
    func unreadableRowsKeepTheirAccount() {
        let rows = [
            planRow(1, date: "2026-03-01", amountMinor: -350, account: nil, payee: "Kiosk"),
            // No date at all: unreadable, and it must not vanish from the
            // account's line -- the file's row count and the account's
            // "n added, m skipped" have to keep adding up.
            planRow(2, date: nil, amountMinor: -700, account: nil, payee: "Baker"),
        ]
        let plan = Self.plan(rows: rows)

        #expect(plan.importableCount == 1)
        #expect(plan.errorCount == 1)
        #expect(plan.rows.allSatisfy { $0.newAccountName == "Card" })
    }

    @Test("with nothing pinned at all, a file with no account column still refuses every row")
    func nothingPinnedStillRefuses() {
        let plan = Import.buildPlan(
            rows: Self.statementRows(), ledger: ImportLedger(),
            options: ImportPlanOptions(
                source: .csv, fileName: "bank.csv", defaultCurrency: "GBP"
            )
        )
        #expect(plan.errorCount == 2)
        #expect(plan.importableCount == 0)
    }

    @Test("the file's OWN account names still win where it has them")
    func fileNamesStillWin() {
        let rows = [
            planRow(1, date: "2026-03-01", amountMinor: -350, account: "Savings", payee: "Kiosk")
        ]
        // A pin is for a file with no Account column. Where the file names one,
        // the file is describing an export and the pin is describing a guess.
        let plan = Import.buildPlan(
            rows: rows, ledger: ImportLedger(),
            options: ImportPlanOptions(
                source: .csv, fileName: "bank.csv", defaultCurrency: "GBP",
                declaredAccounts: [
                    DeclaredAccount(name: "Savings", currency: "EUR", openingBalanceMinor: nil)
                ],
                fixedNewAccount: DeclaredAccount(
                    name: "Savings", currency: "GBP", openingBalanceMinor: nil
                )
            )
        )
        #expect(plan.newAccounts.map(\.currency) == ["EUR"])
    }

    // MARK: - Through the store, which is where the money lands

    @Test("THE ROWS LAND IN THE ACCOUNT THE OWNER NAMED, on a device with no book at all")
    func landsOnAnEmptyDevice() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        store.environment = .fixed(now: EditFixture.now, idPrefix: "p")

        let plan = Self.plan(name: "Card", currency: "GBP")
        let receipt = try store.commitImport(plan, creatingBookWithBaseCurrency: "GBP")

        #expect(receipt.transactionCount == 2)
        let account = try #require(try store.book().accounts.first)
        #expect(account.name == "Card")
        #expect(account.currency == "GBP")
        #expect(account.openingBalanceMinor == 0)
        // −3.50 and −7.00 against an opening of nought.
        #expect(try store.balance(of: account.id) == -1050)
        for row in try store.rowsIn(account: account.id) {
            #expect(row.currency == "GBP")
            #expect(row.importBatchId == receipt.batchId)
        }
    }

    @Test("into a book that already has the account, nothing is created and the rows join it")
    func landsInAnExistingAccount() throws {
        let scratch = try ScratchDirectory()
        let store = try EditFixture.store(scratch)
        let before = try store.book().accounts.count
        // "Alpha" is in the fixture book, in GBP.
        let plan = Import.buildPlan(
            rows: Self.statementRows(), ledger: ImportLedger(book: try store.book()),
            options: ImportPlanOptions(
                source: .csv, fileName: "bank.csv", defaultCurrency: "GBP",
                fixedNewAccount: DeclaredAccount(
                    name: "alpha", currency: "GBP", openingBalanceMinor: nil
                )
            )
        )
        #expect(plan.newAccounts.isEmpty)

        let receipt = try store.commitImport(plan)

        #expect(receipt.accountsCreated == 0)
        #expect(try store.book().accounts.count == before)
        #expect(try store.balance(of: "w-a") == 97500 - 1050)
    }

    @Test("an opening balance stated for the new account is applied, and the balance proves it")
    func openingBalanceIsApplied() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        store.environment = .fixed(now: EditFixture.now, idPrefix: "q")

        let plan = Self.plan(name: "Card", currency: "GBP", opening: 20000)
        try store.commitImport(plan, creatingBookWithBaseCurrency: "GBP")

        let account = try #require(try store.book().accounts.first)
        #expect(account.openingBalanceMinor == 20000)
        #expect(try store.balance(of: account.id) == 20000 - 1050)
    }

    @Test("the import is undoable, and takes the account it created with it")
    func undoTakesTheAccount() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        store.environment = .fixed(now: EditFixture.now, idPrefix: "r")
        let receipt = try store.commitImport(
            Self.plan(), creatingBookWithBaseCurrency: "GBP"
        )

        let undone = try store.undoImport(batchId: receipt.batchId)

        #expect(undone.transactionCount == 2)
        #expect(undone.accountIds.count == 1)
        #expect(try store.book().accounts.isEmpty)
    }
}
