// What the import PLAN does, before anything is written.
//
// The oracle has no `buildPlan` case -- it states what the PARSERS produce, not
// what planning decides -- so this file works the other way round: it drives
// the oracle's own report fixtures through the real parser and then states, BY
// HAND, what the plan must make of them. Every expectation below is arithmetic
// a person can check on paper, and the fixture CSVs are read out of
// tools/oracle/cases at run time rather than copied here, so there is only ever
// one copy of them to drift.
//
// Cases marked HAND-BUILT construct their own rows and their own tiny book,
// because the shape being tested (a near duplicate, a two-day transfer gap, a
// row bound for a 3-decimal account) is not in any fixture. Their expectations
// are hand-calculated too, and the calculation is written out in the comment.
//
// The thing all of this is defending: this is the code that decides what money
// gets written into the owner's ledger, and every bug it can have is a silent
// wrong number.
import Testing

@testable import MyMoneyKit

// MARK: - Shared helpers

enum PlanFixture {
    /// The `csv` input of one oracle case, read from the repository's own
    /// fixtures. Never copied into this file: a second copy is a copy that can
    /// disagree with the first.
    static func csv(caseId: String) throws -> String {
        let file = try OracleTests.load("import.json")
        guard let hit = file.cases.first(where: { $0.id == caseId }),
              let csv = hit.input["csv"]?.stringValue
        else {
            Issue.record("oracle case \(caseId) is missing or carries no csv input")
            return ""
        }
        return csv
    }

    /// Parse a Report fixture and plan it against a book.
    static func planReport(
        caseId: String, ledger: ImportLedger = ImportLedger(), defaultCurrency: String = "GBP"
    ) throws -> (plan: ImportPlan, parsed: MoneyWizReportResult) {
        let parsed = Import.parseMoneyWizReportCsv(try csv(caseId: caseId))
        let plan = Import.buildPlan(
            rows: parsed.rows,
            ledger: ledger,
            options: ImportPlanOptions(
                source: .moneywiz, fileName: "report.csv", defaultCurrency: defaultCurrency,
                declaredAccounts: Import.reportPlanOptions(parsed.accounts)
            )
        )
        return (plan, parsed)
    }

    static func newAccount(_ plan: ImportPlan, _ name: String) -> NewAccountPlan? {
        plan.newAccounts.first { $0.name == name }
    }
}

/// A parsed row, built by hand. Defaults are a GBP row in "Everyday".
func planRow(
    _ index: Int,
    date: String? = "2026-03-15",
    amountMinor: Int64? = nil,
    currency: String? = "GBP",
    account: String? = "Everyday",
    payee: String? = nil,
    description: String? = nil,
    categoryPath: [String] = [],
    tags: [String] = [],
    notes: String? = nil,
    transferTo: String? = nil,
    amountText: String? = nil,
    amountRule: AmountRule = .asWritten,
    error: String? = nil
) -> ParsedRow {
    ParsedRow(
        index: index, date: date, amountMinor: amountMinor, currency: currency,
        accountName: account, payeeName: payee, description: description,
        categoryPath: categoryPath, tags: tags, notes: notes,
        transferAccountName: transferTo, amountText: amountText, amountRule: amountRule,
        error: error
    )
}

func planAccount(_ id: String, _ name: String, _ currency: String = "GBP") -> Account {
    Account(id: id, name: name, type: .current, currency: currency, openingBalanceMinor: 0)
}

/// An existing transaction with the dedupe key the import path would give it.
func planTx(
    _ id: String, account: String, date: String, amountMinor: Int64, currency: String = "GBP",
    payeeId: String? = nil, label: String
) -> Transaction {
    Transaction(
        id: id, accountId: account, date: date, amountMinor: amountMinor, currency: currency,
        payeeId: payeeId, notes: payeeId == nil ? label : "",
        dedupeHash: Dedupe.makeDedupeHash(
            accountId: account, date: date, amountMinor: amountMinor, payeeOrDescription: label
        )
    )
}

func planOptions(
    _ declared: [DeclaredAccount] = [], fixedAccountId: String? = nil,
    defaultCurrency: String = "GBP"
) -> ImportPlanOptions {
    ImportPlanOptions(
        source: .csv, fileName: "statement.csv", defaultCurrency: defaultCurrency,
        fixedAccountId: fixedAccountId, declaredAccounts: declared
    )
}

// MARK: - The oracle's report fixtures, planned

struct ImportPlanOracleTests {

    @Test("the whole real-export fixture, planned against an empty book")
    func realExportIntoEmptyBook() throws {
        // HAND-CALCULATED from the fixture: 18 data rows, of which two cannot
        // be imported (one unreadable amount, one impossible date). Everything
        // else lands in an account this import would create.
        let (plan, _) = try PlanFixture.planReport(caseId: "import.report.real-export")

        #expect(plan.rowsRead == 18)
        #expect(plan.errorCount == 2)
        #expect(plan.importableCount == 16)
        #expect(plan.exactDuplicateCount == 0)
        #expect(plan.nearDuplicateCount == 0)
        #expect(plan.currencyMismatchCount == 0)
        #expect(plan.ambiguousScaleCount == 0)
        // Both transfer legs are in the file, on the same date, same currency,
        // equal magnitudes -- they pair, so nothing invents income.
        #expect(plan.unpairedTransferCount == 0)

        // Ten accounts: nine the rows name (including one the file never
        // declared) plus one the file declares with a balance and no rows.
        #expect(plan.accountsToCreateCount == 10)
        #expect(plan.newAccounts.count == 10)
        #expect(plan.existingAccountsWithOpeningBalance.isEmpty)

        // Nine distinct category paths, eleven payees, four tags -- counted off
        // the fixture's own rows, skipping the two that error.
        #expect(plan.newCategoryPaths.count == 9)
        #expect(plan.newPayees.count == 11)
        #expect(plan.newTags.count == 4)

        // The two unimportable rows are REPORTED, with their file row numbers.
        #expect(plan.problems.count == 2)
        #expect(plan.problems.map(\.rowNumber) == [21, 25])
        #expect(plan.problems.allSatisfy { !$0.reason.isEmpty })
        // And they are still in `rows`, in place, not quietly dropped.
        #expect(plan.rows.count == 18)
    }

    @Test("every derived opening balance makes its account's closing balance come out right")
    func openingBalancesReconcile() throws {
        // THE PROPERTY THE WHOLE REPORT PATH EXISTS FOR, and the reason the
        // owner's real export reconciled account by account:
        //
        //     opening + Σ(that account's importable rows) == the file's balance
        //
        // Checked here against the fixture's own stated balances, for every
        // account the file could derive one for. An account with a row that
        // will not import gets NO opening balance -- balance − Σ(the rows that
        // did parse) is not an opening balance, it is that number plus the
        // missing rows -- and those are asserted to be absent rather than
        // guessed.
        let (plan, parsed) = try PlanFixture.planReport(caseId: "import.report.real-export")

        var summed = 0
        for account in parsed.accounts {
            guard let new = PlanFixture.newAccount(plan, account.name) else {
                Issue.record("\(account.name) should be created by this import")
                continue
            }
            guard let opening = account.openingBalanceMinor else {
                #expect(new.openingBalanceMinor == nil, "a refused opening balance must stay refused")
                continue
            }
            let total = plan.rows
                .filter { $0.isImportable && $0.row.accountName == account.name }
                .compactMap(\.amountMinor)
                .reduce(Int64(0), +)
            #expect(new.openingBalanceMinor == opening)
            #expect(opening + total == account.currentBalanceMinor, "\(account.name) must reconcile")
            summed += 1
        }
        #expect(summed == 7, "seven of the nine declared accounts state a usable balance")
    }

    @Test("an account the file declares but no row uses is still created, with its money")
    func balanceOnlyAccountSurvives() throws {
        // Dropping it silently would leave net worth short with nothing on
        // screen to explain it.
        let (plan, _) = try PlanFixture.planReport(caseId: "import.report.real-export")
        let dormant = PlanFixture.newAccount(plan, "Dormant Pot")
        #expect(dormant != nil)
        #expect(dormant?.openingBalanceMinor == 4200)
        #expect(dormant?.create == true)
        #expect(plan.rows.contains { $0.row.accountName == "Dormant Pot" } == false)
    }

    @Test("an account named only by a transaction, never declared, is created with no balance")
    func undeclaredAccountIsCreated() throws {
        let (plan, _) = try PlanFixture.planReport(caseId: "import.report.real-export")
        let ghost = PlanFixture.newAccount(plan, "Ghost Account")
        #expect(ghost != nil)
        #expect(ghost?.openingBalanceMinor == nil, "nothing in the file states one")
        #expect(ghost?.currency == "GBP", "the row's own currency is the only evidence")
    }

    @Test("the two legs of one transfer pair with each other, and only each other")
    func transferLegsPair() throws {
        let (plan, _) = try PlanFixture.planReport(caseId: "import.report.real-export")
        let legs = plan.rows.indices.filter { plan.rows[$0].row.transferAccountName != nil }
        #expect(legs.count == 2)
        guard legs.count == 2 else { return }
        #expect(plan.rows[legs[0]].transferPairIndex == legs[1])
        #expect(plan.rows[legs[1]].transferPairIndex == legs[0])
        // Paired legs carry no category: a transfer is not income or spending.
        #expect(plan.rows[legs[0]].chosenCategoryId == nil)
        #expect(plan.rows[legs[1]].chosenCategoryId == nil)
    }

    @Test("a 0-decimal account's amount keeps its scale (D31), and the account still reconciles")
    func zeroDecimalAccountScale() throws {
        // HAND-CALCULATED: the fixture's third account is a 0-decimal currency
        // with a stated balance of 5000 minor units, one row of -1200, and a
        // derived opening balance of 6200. 6200 − 1200 = 5000. If the plan read
        // that row at two decimals it would be -120000 and the account would be
        // out by a factor of a hundred -- which is exactly D31.
        let (plan, parsed) = try PlanFixture.planReport(caseId: "import.report.opening-balances")
        guard let yen = parsed.accounts.first(where: { $0.currency == "JPY" }) else {
            Issue.record("the fixture should declare a 0-decimal account")
            return
        }
        let rows = plan.rows.filter { $0.row.accountName == yen.name }
        #expect(rows.count == 1)
        #expect(rows.first?.amountMinor == -1200)
        let new = PlanFixture.newAccount(plan, yen.name)
        #expect(new?.currency == "JPY")
        #expect(new?.openingBalanceMinor == 6200)
        #expect((new?.openingBalanceMinor ?? 0) - 1200 == yen.currentBalanceMinor)
    }

    @Test("a transfer whose other side is not in the file is counted, not hidden")
    func unpairedLegIsCounted() throws {
        // HAND-CALCULATED: the fixture's one transfer row names an account that
        // has no rows of its own, so nothing can pair with it. Written as an
        // ordinary uncategorised transaction it reads as real spending, so the
        // preview has to say so.
        let (plan, _) = try PlanFixture.planReport(caseId: "import.report.opening-balances")
        #expect(plan.rowsRead == 5)
        #expect(plan.errorCount == 0)
        #expect(plan.importableCount == 5)
        #expect(plan.unpairedTransferCount == 1)
        #expect(plan.accountsToCreateCount == 3, "the transfer target is not created")
        #expect(plan.newCategoryPaths.count == 4)
        #expect(plan.newPayees.count == 4)
        #expect(plan.newTags.count == 3)
    }

    @Test("planning the same file twice gives the same plan, and changes nothing")
    func planningIsPure() throws {
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday Current")])
        let first = try PlanFixture.planReport(caseId: "import.report.real-export", ledger: ledger).plan
        let second = try PlanFixture.planReport(caseId: "import.report.real-export", ledger: ledger).plan
        #expect(first.rows == second.rows)
        #expect(first.newAccounts == second.newAccounts)
        #expect(first.importableCount == second.importableCount)
        #expect(first.newCategoryPaths == second.newCategoryPaths)
        // The book handed in is untouched -- it is a value, and planning never
        // had anywhere to write even if it wanted one.
        #expect(ledger.accounts.count == 1)
        #expect(ledger.transactions.isEmpty)
    }
}

// MARK: - D30: the account's currency, never the file's

struct ImportPlanCurrencyTests {

    @Test("a row in another currency lands in the account's currency, counted and disclosed")
    func mismatchIsCountedNotConverted() {
        // HAND-BUILT. A EUR row into a GBP account: the amount is kept exactly
        // as the file stated it (100.00 → 10000 minor units) because it is the
        // account-currency figure, and the disagreement is DISCLOSED. Nothing
        // is converted: a guessed rate is a made-up number.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday", "GBP")])
        let rows = [
            planRow(1, amountMinor: -10000, currency: "EUR", amountText: "-100.00"),
            planRow(2, amountMinor: -2500, currency: "GBP", amountText: "-25.00"),
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.currencyMismatchCount == 1)
        #expect(plan.rows[0].currencyMismatch)
        #expect(plan.rows[0].amountMinor == -10000, "the stated figure is not rescaled between 2-dp currencies")
        #expect(plan.rows[1].currencyMismatch == false)
        #expect(plan.importableCount == 2)
    }

    @Test("a mismatch on a row that will not be written is not disclosed")
    func mismatchOnlyCountsForWrittenRows() {
        // HAND-BUILT. The EUR row is an exact duplicate of something already in
        // the book, so it is skipped -- and a warning about a row nobody is
        // importing is noise that hides the ones that matter.
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -10000, label: "Shop")
        let ledger = ImportLedger(
            accounts: [planAccount("a1", "Everyday", "GBP")], transactions: [existing]
        )
        let rows = [planRow(1, amountMinor: -10000, currency: "EUR", payee: "Shop", amountText: "-100.00")]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.rows[0].action == .skipExactDuplicate)
        #expect(plan.rows[0].currencyMismatch, "the row still disagrees…")
        #expect(plan.currencyMismatchCount == 0, "…but nothing will be written, so nothing is claimed")
    }

    @Test("the file's declaration of an account's currency beats a row's")
    func declaredCurrencyWins() {
        // HAND-BUILT. A Report export states an account's LEDGER currency on its
        // header row; the Currency column on a row describes the purchase. A new
        // account must take the former.
        let rows = [planRow(1, amountMinor: -1000, currency: "USD", account: "Holiday", amountText: "-10.00")]
        let plan = Import.buildPlan(
            rows: rows, ledger: ImportLedger(),
            options: planOptions([DeclaredAccount(name: "Holiday", currency: "EUR", openingBalanceMinor: 500)])
        )
        #expect(plan.newAccounts.first?.currency == "EUR")
        #expect(plan.rows[0].currencyMismatch, "the row's USD is not the ledger's EUR")
        #expect(plan.currencyMismatchCount == 1)
    }

    @Test("an existing account dictates the currency, whatever the file declares")
    func existingAccountWins() {
        // HAND-BUILT. The book is the authority for an account it already holds.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Holiday", "GBP")])
        let rows = [planRow(1, amountMinor: -1000, currency: "EUR", account: "Holiday", amountText: "-10.00")]
        let plan = Import.buildPlan(
            rows: rows, ledger: ledger,
            options: planOptions([DeclaredAccount(name: "Holiday", currency: "EUR", openingBalanceMinor: 500)])
        )
        #expect(plan.newAccounts.isEmpty)
        #expect(plan.rows[0].accountId == "a1")
        #expect(plan.rows[0].currencyMismatch)
        #expect(plan.existingAccountsWithOpeningBalance == ["Holiday"])
    }

    @Test("an existing account's opening balance is never rewritten, only named")
    func existingOpeningBalanceIsLeftAlone() {
        // HAND-BUILT. Silently moving a balance the owner set is moving money
        // they never touched. The cost is that the account can end up
        // disagreeing with the file, so the preview is told which ones.
        let ledger = ImportLedger(accounts: [
            planAccount("a1", "Everyday"), planAccount("a2", "Savings"),
        ])
        let rows = [planRow(1, amountMinor: -1000, amountText: "-10.00")]
        let plan = Import.buildPlan(
            rows: rows, ledger: ledger,
            options: planOptions([
                DeclaredAccount(name: "everyday", currency: "GBP", openingBalanceMinor: 999),
                DeclaredAccount(name: "Savings", currency: "GBP", openingBalanceMinor: 100),
                DeclaredAccount(name: "Brand New", currency: "GBP", openingBalanceMinor: 7),
            ])
        )
        // Matched case-insensitively, and reported under the name THIS app uses.
        #expect(plan.existingAccountsWithOpeningBalance == ["Everyday", "Savings"])
        #expect(plan.newAccounts.map(\.name) == ["Brand New"])
        #expect(plan.newAccounts.first?.openingBalanceMinor == 7)
    }
}

// MARK: - D31: scale follows the resolved account

struct ImportPlanScaleTests {

    @Test("a 500-unit row into a 0-decimal account is 500, not 50,000")
    func zeroDecimalRescale() {
        // HAND-CALCULATED. The parser had to guess a currency before the account
        // was known and guessed a 2-decimal one, so "500" reached the plan as
        // 50000 minor units. The account is 0-decimal, so the true figure is
        // 500. Getting this wrong multiplies the owner's balance by a hundred.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Yen Pocket", "JPY")])
        let rows = [planRow(1, amountMinor: 50000, currency: nil, account: "Yen Pocket", amountText: "500")]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.rows[0].amountMinor == 500)
        #expect(plan.rows[0].row.amountMinor == 50000, "what the parser said is still on the row")
        #expect(plan.rows[0].action == .add)
        #expect(plan.errorCount == 0)
    }

    @Test("a valid 3-decimal amount the parser rejected is accepted once the account is known")
    func threeDecimalRescue() {
        // HAND-CALCULATED. "12.345" has more precision than GBP allows, so the
        // parser refused it outright and flagged the row. The account is a
        // 3-decimal currency, where it is a perfectly ordinary 12345 minor
        // units, and the parser's verdict was reached at the wrong scale.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Gulf", "KWD")])
        let rows = [
            planRow(
                1, amountMinor: nil, currency: nil, account: "Gulf", amountText: "12.345",
                error: "Unrecognised amount \u{201C}12.345\u{201D}"
            )
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.rows[0].amountMinor == 12345)
        #expect(plan.rows[0].action == .add)
        #expect(plan.rows[0].error == nil)
        #expect(plan.errorCount == 0)
        #expect(plan.problems.isEmpty)
    }

    @Test("a 0-decimal row landing in a 2-decimal account is rescaled the other way")
    func rescaleUpwards() {
        // HAND-CALCULATED. The file says the row is in a 0-decimal currency, so
        // the parser read "1200" as 1200 minor units. The account it actually
        // lands in has two decimals, where the same text means 120000. Both the
        // scale correction and the currency disagreement are recorded.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday", "GBP")])
        let rows = [planRow(1, amountMinor: -1200, currency: "JPY", amountText: "-1200")]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.rows[0].amountMinor == -120000)
        #expect(plan.rows[0].currencyMismatch)
        #expect(plan.currencyMismatchCount == 1)
    }

    @Test("an amount that cannot be re-read at the account's scale is refused, not written")
    func ambiguousScaleIsRefused() {
        // HAND-BUILT, and a deliberate DIVERGENCE from the web app, which writes
        // this row at a scale it knows is wrong.
        //
        // A statement with separate debit and credit columns, both filled on one
        // row: no single cell produced the amount, so there is no text to re-read
        // once the account turns out to be 0-decimal. The parser's number is
        // provably a hundred times too big and cannot be fixed. It is reported
        // with its row number and left out.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Yen Pocket", "JPY")])
        let rows = [
            planRow(7, amountMinor: 50000, currency: nil, account: "Yen Pocket", amountText: nil),
            planRow(8, amountMinor: -1200, currency: nil, account: "Yen Pocket", amountText: "-1200"),
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.ambiguousScaleCount == 1)
        #expect(plan.rows[0].action == .error)
        #expect(plan.rows[0].amountMinor == nil)
        #expect(plan.problems.map(\.rowNumber) == [7])
        #expect(plan.problems.first?.reason.contains("100") == true, "say how wrong it would have been")
        #expect(plan.rows[1].amountMinor == -1200, "the row that CAN be re-read still imports")
        #expect(plan.importableCount == 1)
    }

    @Test("a debit column's sign survives being re-derived")
    func debitRuleSurvivesRescale() {
        // HAND-CALCULATED. A debit cell states a magnitude and the column means
        // "money out"; re-reading it at the account's currency must not lose
        // that. "500" in a debit column of a 0-decimal account is −500.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Yen Pocket", "JPY")])
        let rows = [
            planRow(
                1, amountMinor: -50000, currency: nil, account: "Yen Pocket",
                amountText: "500", amountRule: .debit
            )
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())
        #expect(plan.rows[0].amountMinor == -500)
    }

    @Test("an amount that parses at neither scale stays an error, named")
    func unrescuableAmount() {
        let ledger = ImportLedger(accounts: [planAccount("a1", "Yen Pocket", "JPY")])
        let rows = [
            planRow(
                4, amountMinor: nil, currency: nil, account: "Yen Pocket",
                amountText: "twelve", error: "Unrecognised amount \u{201C}twelve\u{201D}"
            )
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())
        #expect(plan.errorCount == 1)
        #expect(plan.problems.first?.rowNumber == 4)
        #expect(plan.problems.first?.reason.contains("twelve") == true)
    }

    @Test("the decimal style is decided once per scale, never per row")
    func decimalStyleIsPerFile() {
        // HAND-CALCULATED. Both rows land in the same 2-decimal account and the
        // column is European ("1.234,56"). Deciding per row would let the second
        // row read "1.234" as one-point-two-three-four while the first reads it
        // as a thousand.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday", "EUR")])
        let rows = [
            planRow(1, amountMinor: nil, currency: "JPY", account: "Everyday", amountText: "1.234,56"),
            planRow(2, amountMinor: nil, currency: "JPY", account: "Everyday", amountText: "1.234"),
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())
        #expect(plan.rows[0].amountMinor == 123456)
        #expect(plan.rows[1].amountMinor == 123400, "grouped thousands, not one-point-two")
    }
}

// MARK: - D32: a duplicate match is consumed

struct ImportPlanDedupeTests {

    @Test("two identical rows against one existing transaction: one skipped, one kept")
    func matchIsConsumed() {
        // THE BUG D32 EXISTS FOR, hand-calculated. Two legitimate identical
        // purchases in one file both match the single transaction already in the
        // book. Without consumption both are skipped and one real purchase
        // vanishes with nothing on screen to say so.
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -320, label: "Coffee")
        let ledger = ImportLedger(
            accounts: [planAccount("a1", "Everyday")], transactions: [existing]
        )
        let rows = [
            planRow(1, amountMinor: -320, payee: "Coffee", amountText: "-3.20"),
            planRow(2, amountMinor: -320, payee: "Coffee", amountText: "-3.20"),
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.exactDuplicateCount == 1)
        #expect(plan.importableCount == 1)
        #expect(plan.rows[0].action == .skipExactDuplicate)
        #expect(plan.rows[1].action == .add)
    }

    @Test("re-importing the same file still skips every row")
    func reImportIsANoOp() {
        // The other half of D32: N incoming rows meet N existing transactions,
        // so all N are absorbed. Consumption must not make a re-import start
        // duplicating the book.
        let existing = (0..<3).map {
            planTx("t\($0)", account: "a1", date: "2026-03-15", amountMinor: -320, label: "Coffee")
        }
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: existing)
        let rows = (1...3).map { planRow($0, amountMinor: -320, payee: "Coffee", amountText: "-3.20") }
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.exactDuplicateCount == 3)
        #expect(plan.importableCount == 0)
    }

    @Test("a near duplicate is flagged for a decision, never resolved automatically")
    func nearDuplicateNeedsADecision() {
        // HAND-CALCULATED. Same account, same amount, one day apart, a payee
        // name one character different -- similar enough to ask about, not
        // similar enough to act on. It defaults to skip: never silently doubled,
        // and never silently dropped either, because it is shown.
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -1999, label: "Sample Shop")
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: [existing])
        let rows = [planRow(1, date: "2026-03-16", amountMinor: -1999, payee: "Sample Shopp", amountText: "-19.99")]
        var plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.nearDuplicateCount == 1)
        #expect(plan.rows[0].action == .needsDecision)
        #expect(plan.rows[0].decision == .skip)
        #expect(plan.rows[0].nearDuplicateOf?.id == "t1")
        #expect(plan.importableCount == 0)

        plan.setDecision(.add, forRowAt: 0)
        #expect(plan.importableCount == 1, "the counters follow the decision")
        #expect(plan.nearDuplicateCount == 1, "it is still a near duplicate, just an accepted one")
    }

    @Test("a near-duplicate match is consumed too")
    func nearMatchIsConsumed() {
        // HAND-CALCULATED. One existing transaction, two similar incoming rows:
        // only one of them can be explained by it.
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -1999, label: "Sample Shop")
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: [existing])
        let rows = [
            planRow(1, amountMinor: -1999, payee: "Sample Shopp", amountText: "-19.99"),
            planRow(2, amountMinor: -1999, payee: "Sample Shopp", amountText: "-19.99"),
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.nearDuplicateCount == 1)
        #expect(plan.rows[0].action == .needsDecision)
        #expect(plan.rows[1].action == .add)
        #expect(plan.importableCount == 1)
    }

    @Test("an exact match is never stolen by a near one")
    func exactPassRunsFirst() {
        // HAND-CALCULATED, and the reason the two passes are ordered. Row 1 is
        // merely SIMILAR to the one existing transaction; row 2 is IDENTICAL to
        // it. Scanning row by row, row 1 would claim it as a near duplicate and
        // row 2 -- an exact re-import -- would then be written a second time.
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -1999, label: "Sample Shop")
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: [existing])
        let rows = [
            planRow(1, amountMinor: -1999, payee: "Sample Shopp", amountText: "-19.99"),
            planRow(2, amountMinor: -1999, payee: "Sample Shop", amountText: "-19.99"),
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.rows[1].action == .skipExactDuplicate, "the exact re-import wins the match")
        #expect(plan.rows[0].action == .add, "and the merely-similar row is a real purchase")
        #expect(plan.importableCount == 1)
    }

    @Test("identical rows within one file are not duplicates of each other")
    func inFileRepeatsAreKept() {
        // Two identical same-day coffees in one export are two coffees.
        // Duplicates are only ever detected against what is ALREADY in the book.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")])
        let rows = (1...2).map { planRow($0, amountMinor: -320, payee: "Coffee", amountText: "-3.20") }
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.exactDuplicateCount == 0)
        #expect(plan.nearDuplicateCount == 0)
        #expect(plan.importableCount == 2)
    }

    @Test("a row bound for an account that does not exist yet cannot be a duplicate")
    func newAccountRowsSkipDedupe() {
        // Nothing is in an account that has never existed, so there is nothing
        // for the row to duplicate -- and a match against some OTHER account's
        // transaction would be a row landing in the wrong ledger.
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -320, label: "Coffee")
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: [existing])
        let rows = [planRow(1, amountMinor: -320, account: "Somewhere Else", payee: "Coffee", amountText: "-3.20")]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.exactDuplicateCount == 0)
        #expect(plan.importableCount == 1)
        #expect(plan.newAccounts.map(\.name) == ["Somewhere Else"])
    }

    @Test("a match two days away is not a duplicate")
    func dedupeWindowIsOneDay() {
        let existing = planTx("t1", account: "a1", date: "2026-03-13", amountMinor: -1999, label: "Sample Shop")
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: [existing])
        let rows = [planRow(1, date: "2026-03-15", amountMinor: -1999, payee: "Sample Shop", amountText: "-19.99")]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.nearDuplicateCount == 0)
        #expect(plan.exactDuplicateCount == 0)
        #expect(plan.importableCount == 1)
    }

    @Test("a transaction with no payee is matched on the description it was imported under")
    func labelFallsBackToNotes() {
        // The dedupe key uses the payee when there is one and the description
        // otherwise, on BOTH sides, so a re-import matches what a previous
        // import wrote.
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -500, label: "Card payment")
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: [existing])
        let rows = [planRow(1, amountMinor: -500, description: "Card payment", amountText: "-5.00")]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())
        #expect(plan.rows[0].action == .skipExactDuplicate)
    }
}

// MARK: - Transfers

struct ImportPlanTransferTests {

    @Test("legs a day apart pair; legs two days apart do not")
    func oneDayTolerance() {
        // HAND-CALCULATED. Real exports routinely book the money leaving on one
        // day and arriving the next.
        let ledger = ImportLedger(accounts: [
            planAccount("a1", "Everyday"), planAccount("a2", "Savings"),
        ])
        func legs(_ secondDate: String) -> ImportPlan {
            Import.buildPlan(
                rows: [
                    planRow(1, date: "2026-03-15", amountMinor: -10000, account: "Everyday",
                            transferTo: "Savings", amountText: "-100.00"),
                    planRow(2, date: secondDate, amountMinor: 10000, account: "Savings",
                            transferTo: "Everyday", amountText: "100.00"),
                ],
                ledger: ledger, options: planOptions()
            )
        }
        let nextDay = legs("2026-03-16")
        #expect(nextDay.rows[0].transferPairIndex == 1)
        #expect(nextDay.unpairedTransferCount == 0)

        let twoDays = legs("2026-03-17")
        #expect(twoDays.rows[0].transferPairIndex == nil)
        #expect(twoDays.unpairedTransferCount == 2, "both legs become ordinary transactions")
    }

    @Test("a same-date partner is never lost to a day-apart one")
    func sameDateWinsOverNeighbour() {
        // HAND-CALCULATED. Row 1 leaves on the 15th. Row 2 arrives on the 16th,
        // row 3 arrives on the 15th. A single pass with a one-day window would
        // take row 2 and strand row 3; two passes cannot.
        let ledger = ImportLedger(accounts: [
            planAccount("a1", "Everyday"), planAccount("a2", "Savings"),
        ])
        let plan = Import.buildPlan(
            rows: [
                planRow(1, date: "2026-03-15", amountMinor: -10000, account: "Everyday",
                        transferTo: "Savings", amountText: "-100.00"),
                planRow(2, date: "2026-03-16", amountMinor: 10000, account: "Savings",
                        transferTo: "Everyday", amountText: "100.00"),
                planRow(3, date: "2026-03-15", amountMinor: 10000, account: "Savings",
                        transferTo: "Everyday", amountText: "100.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].transferPairIndex == 2, "the same-date leg wins")
        #expect(plan.rows[1].transferPairIndex == nil)
        #expect(plan.unpairedTransferCount == 1)
    }

    @Test("same-currency legs must agree exactly on magnitude")
    func magnitudesMustMatchWithinACurrency() {
        // HAND-CALCULATED. Both accounts are GBP, so the two amounts CAN be
        // compared -- and £100 out is not £90 in. Pairing them would hide a
        // £10 discrepancy inside a transfer where no report would ever show it.
        let ledger = ImportLedger(accounts: [
            planAccount("a1", "Everyday"), planAccount("a2", "Savings"),
        ])
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -10000, account: "Everyday", transferTo: "Savings", amountText: "-100.00"),
                planRow(2, amountMinor: 9000, account: "Savings", transferTo: "Everyday", amountText: "90.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].transferPairIndex == nil)
        #expect(plan.unpairedTransferCount == 2)
    }

    @Test("cross-currency legs pair on file order, because magnitudes cannot be compared")
    func crossCurrencyPairsOnOrder() {
        // HAND-CALCULATED. −€100 and +£85 cannot be matched by magnitude: both
        // legs' amounts are stored explicitly and a rate may never be guessed.
        // File order is the only signal there is.
        let ledger = ImportLedger(accounts: [
            planAccount("a1", "Euro Pot", "EUR"), planAccount("a2", "Everyday", "GBP"),
        ])
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -10000, currency: "EUR", account: "Euro Pot",
                        transferTo: "Everyday", amountText: "-100.00"),
                planRow(2, amountMinor: 8500, currency: "GBP", account: "Everyday",
                        transferTo: "Euro Pot", amountText: "85.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].transferPairIndex == 1)
        #expect(plan.unpairedTransferCount == 0)
    }

    @Test("two legs in the same direction never pair")
    func signsMustOppose() {
        let ledger = ImportLedger(accounts: [
            planAccount("a1", "Everyday"), planAccount("a2", "Savings"),
        ])
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -10000, account: "Everyday", transferTo: "Savings", amountText: "-100.00"),
                planRow(2, amountMinor: -10000, account: "Savings", transferTo: "Everyday", amountText: "-100.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].transferPairIndex == nil)
        #expect(plan.unpairedTransferCount == 2)
    }

    @Test("a leg whose partner is a skipped duplicate is counted as unpaired")
    func partnerSkippedMakesLegUnpaired() {
        // HAND-CALCULATED, and the subtle one. The two legs DO pair -- but the
        // incoming half is already in the book, so only the outgoing half will
        // be written, as an ordinary uncategorised transaction that every report
        // reads by sign as £100 of real spending.
        let existing = planTx("t1", account: "a2", date: "2026-03-15", amountMinor: 10000,
                              label: "Transfer from current")
        let ledger = ImportLedger(
            accounts: [planAccount("a1", "Everyday"), planAccount("a2", "Savings")],
            transactions: [existing]
        )
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -10000, account: "Everyday", description: "To savings",
                        transferTo: "Savings", amountText: "-100.00"),
                planRow(2, amountMinor: 10000, account: "Savings", description: "Transfer from current",
                        transferTo: "Everyday", amountText: "100.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].transferPairIndex == 1, "they still pair…")
        #expect(plan.rows[1].action == .skipExactDuplicate)
        #expect(plan.importableCount == 1)
        #expect(plan.unpairedTransferCount == 1, "…but only one of them is being written")
    }

    @Test("a leg whose partner's account is unticked is counted as unpaired")
    func untickingAnAccountStrandsALeg() {
        // HAND-CALCULATED. Unticking an account does not just remove its rows:
        // it changes what the rows that remain MEAN.
        var plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -10000, account: "Everyday", transferTo: "Savings", amountText: "-100.00"),
                planRow(2, amountMinor: 10000, account: "Savings", transferTo: "Everyday", amountText: "100.00"),
            ],
            ledger: ImportLedger(), options: planOptions()
        )
        #expect(plan.unpairedTransferCount == 0)
        #expect(plan.importableCount == 2)
        #expect(plan.accountsToCreateCount == 2)

        plan.setCreateAccount(named: "savings", false)
        #expect(plan.accountsToCreateCount == 1)
        #expect(plan.importableCount == 1)
        #expect(plan.unpairedTransferCount == 1)
    }

    @Test("an error row is never anybody's transfer partner")
    func errorRowsDoNotPair() {
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -10000, account: "Everyday", transferTo: "Savings", amountText: "-100.00"),
                planRow(2, date: nil, amountMinor: 10000, account: "Savings", transferTo: "Everyday",
                        amountText: "100.00", error: "Unrecognised date \u{201C}31/02/2026\u{201D}"),
            ],
            ledger: ImportLedger(), options: planOptions()
        )
        #expect(plan.rows[0].transferPairIndex == nil)
        #expect(plan.unpairedTransferCount == 1)
        #expect(plan.errorCount == 1)
        #expect(plan.problems.first?.rowNumber == 2)
    }
}

// MARK: - Entities the import would create

struct ImportPlanEntityTests {

    @Test("an existing category path is matched, and only a missing one is created")
    func categoryPathsResolve() {
        // HAND-BUILT. Matching is case and whitespace insensitive at every
        // level, and a path is only new when a level of it is genuinely absent.
        let ledger = ImportLedger(categories: [
            Category(id: "c1", name: "Food & Drink", kind: .expense),
            Category(id: "c2", name: "Groceries", parentId: "c1", kind: .expense),
        ])
        let rows = [
            planRow(1, amountMinor: -1000, categoryPath: ["food & drink", "  Groceries "], amountText: "-10.00"),
            planRow(2, amountMinor: -1000, categoryPath: ["Food & Drink", "Coffee"], amountText: "-10.00"),
            planRow(3, amountMinor: -1000, categoryPath: ["Food & Drink", "Coffee"], amountText: "-10.00"),
        ]
        let plan = Import.buildPlan(rows: rows, ledger: ledger, options: planOptions())

        #expect(plan.rows[0].chosenCategoryId == "c2")
        #expect(plan.rows[1].chosenCategoryId == nil)
        #expect(plan.newCategoryPaths == [["Food & Drink", "Coffee"]], "listed once, not per row")
    }

    @Test("a level with two matches prefers the kind the row's sign implies")
    func categoryKindPreference() {
        // HAND-BUILT. A book can hold an income "Interest" and an expense
        // "Interest"; a positive row means the income one. Picking by sign stops
        // a refund forking a duplicate tree of the wrong kind.
        let ledger = ImportLedger(categories: [
            Category(id: "c1", name: "Interest", kind: .expense),
            Category(id: "c2", name: "Interest", kind: .income),
        ])
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: 5000, categoryPath: ["Interest"], amountText: "50.00"),
                planRow(2, amountMinor: -5000, categoryPath: ["Interest"], amountText: "-50.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].chosenCategoryId == "c2")
        #expect(plan.rows[1].chosenCategoryId == "c1")
        #expect(plan.newCategoryPaths.isEmpty)
    }

    @Test("a payee's learned category is suggested only when the row brings none")
    func payeeSuggestion() {
        // HAND-BUILT. What the file says about a transaction beats what a payee
        // usually means.
        let ledger = ImportLedger(
            categories: [Category(id: "c1", name: "Groceries", kind: .expense)],
            payees: [Payee(id: "p1", name: "Sample Grocer", defaultCategoryId: "c1")]
        )
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -1000, payee: "sample grocer", amountText: "-10.00"),
                planRow(2, amountMinor: -1000, payee: "Sample Grocer",
                        categoryPath: ["Groceries"], amountText: "-10.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].suggestedCategoryId == "c1")
        #expect(plan.rows[0].chosenCategoryId == "c1")
        #expect(plan.rows[1].suggestedCategoryId == nil, "the row said what it was")
        #expect(plan.rows[1].chosenCategoryId == "c1")
        #expect(plan.newPayees.isEmpty, "the payee already exists")
    }

    @Test("a paired transfer leg gets no category and no suggestion")
    func pairedLegsAreNotCategorised() {
        let ledger = ImportLedger(
            categories: [Category(id: "c1", name: "Groceries", kind: .expense)],
            payees: [Payee(id: "p1", name: "Sample Grocer", defaultCategoryId: "c1")]
        )
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -10000, account: "Everyday", payee: "Sample Grocer",
                        transferTo: "Savings", amountText: "-100.00"),
                planRow(2, amountMinor: 10000, account: "Savings", payee: "Sample Grocer",
                        transferTo: "Everyday", amountText: "100.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.rows[0].transferPairIndex == 1)
        #expect(plan.rows[0].chosenCategoryId == nil)
        #expect(plan.rows[1].chosenCategoryId == nil)
    }

    @Test("new payees and tags are listed once each, tidied, and never if they exist")
    func payeesAndTags() {
        let ledger = ImportLedger(tags: [Tag(id: "g1", name: "Work")])
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -1000, payee: "  Sample   Grocer ",
                        tags: ["work", "monthly", " monthly "], amountText: "-10.00"),
                planRow(2, amountMinor: -1000, payee: "SAMPLE GROCER", tags: ["Monthly"], amountText: "-10.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.newPayees == ["Sample Grocer"], "collapsed whitespace, first spelling wins")
        #expect(plan.newTags == ["monthly"], "\u{201C}work\u{201D} already exists")
    }

    @Test("an existing payee is matched by the key the store stores, not by its display name")
    func payeeMatchedByStoredKey() {
        // HAND-BUILT. `name_lower` is stored data, and it is the column the
        // commit step queries (`live_payees WHERE name_lower = ?`). If the plan
        // matched on the display name instead, a row whose stored key disagreed
        // would be listed as a payee this import CREATES while the write would
        // find the existing one -- a preview that does not describe what happens.
        let ledger = ImportLedger(
            payees: [Payee(id: "p1", name: "Renamed Later", nameLower: "sample grocer")],
            tags: [Tag(id: "g1", name: "Renamed Too", nameLower: "work")]
        )
        let plan = Import.buildPlan(
            rows: [planRow(1, amountMinor: -1000, payee: "Sample Grocer", tags: ["Work"], amountText: "-10.00")],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.newPayees.isEmpty)
        #expect(plan.newTags.isEmpty)
    }

    @Test("the plan and the store agree, character for character, on when two names are the same")
    func nameKeysAgree() {
        // The plan matches accounts and categories with `Import.nameKey` and
        // matches payees and tags against the `name_lower` the store writes with
        // `Names.key`. Those two have to be the same rule or the plan and the
        // write disagree about identity -- and the disagreement would only show
        // up as a duplicate payee nobody asked for. The awkward cases are the
        // ones that arrive from a paste out of a bank statement: a non-breaking
        // space, a zero-width no-break space, a doubled space, an accent.
        let names = [
            "Alderney", " Alderney ", "ALDERNEY", "Sample  Grocer", "Caf\u{E9} Paris",
            "a\u{A0}b", "\u{FEFF}Lead", "trail\u{FEFF}", "", "   ",
        ]
        for name in names {
            #expect(Import.nameKey(name) == Names.key(name), "disagreed about \u{201C}\(name)\u{201D}")
        }
    }
}

// MARK: - Rows that cannot be understood

struct ImportPlanRefusalTests {

    @Test("an unreadable row is reported with its row number and reason, never dropped")
    func errorsAreReported() {
        let plan = Import.buildPlan(
            rows: [
                planRow(3, date: nil, amountMinor: -500, amountText: "-5.00",
                        error: "Unrecognised date \u{201C}31/02/2026\u{201D}"),
                planRow(4, amountMinor: -500, amountText: "-5.00"),
                planRow(9, amountMinor: nil, amountText: "twelve pounds",
                        error: "Unrecognised amount \u{201C}twelve pounds\u{201D}"),
            ],
            ledger: ImportLedger(), options: planOptions()
        )
        #expect(plan.rowsRead == 3)
        #expect(plan.errorCount == 2)
        #expect(plan.importableCount == 1)
        #expect(plan.problems.map(\.rowNumber) == [3, 9])
        #expect(plan.problems[0].description.hasPrefix("Row 3: "))
        #expect(plan.problems[1].reason.contains("twelve pounds"))
        #expect(plan.rows.count == 3, "an error row keeps its place in the file")
    }

    @Test("a row with no account and no fixed account is an error, not a guess")
    func rowWithNoAccount() {
        let plan = Import.buildPlan(
            rows: [planRow(2, amountMinor: -500, account: nil, amountText: "-5.00")],
            ledger: ImportLedger(), options: planOptions()
        )
        #expect(plan.errorCount == 1)
        #expect(plan.problems.first?.rowNumber == 2)
        #expect(plan.newAccounts.isEmpty, "an error row must not conjure an account nobody uses")
    }

    @Test("a fixed account pins every row, whatever the file says")
    func fixedAccountWins() {
        // A generic CSV can be imported into one chosen account.
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")])
        let plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -500, account: nil, amountText: "-5.00"),
                planRow(2, amountMinor: -500, account: "Some Other Name", amountText: "-5.00"),
            ],
            ledger: ledger, options: planOptions(fixedAccountId: "a1")
        )
        #expect(plan.errorCount == 0)
        #expect(plan.rows.allSatisfy { $0.accountId == "a1" })
        #expect(plan.newAccounts.isEmpty)
    }

    @Test("an error row contributes no account, no category, no payee and no tag")
    func errorRowsContributeNothing() {
        let plan = Import.buildPlan(
            rows: [
                planRow(1, date: nil, amountMinor: -500, account: "Ghost", payee: "Nobody",
                        categoryPath: ["Invented"], tags: ["never"], amountText: "-5.00",
                        error: "Unrecognised date \u{201C}x\u{201D}"),
            ],
            ledger: ImportLedger(), options: planOptions()
        )
        #expect(plan.newAccounts.isEmpty)
        #expect(plan.newCategoryPaths.isEmpty)
        #expect(plan.newPayees.isEmpty)
        #expect(plan.newTags.isEmpty)
        #expect(plan.importableCount == 0)
    }
}

// MARK: - The two edits a preview offers

struct ImportPlanEditTests {

    @Test("the totals cannot go stale: every edit recounts")
    func countsFollowEdits() {
        let existing = planTx("t1", account: "a1", date: "2026-03-15", amountMinor: -1999, label: "Sample Shop")
        let ledger = ImportLedger(accounts: [planAccount("a1", "Everyday")], transactions: [existing])
        var plan = Import.buildPlan(
            rows: [
                planRow(1, amountMinor: -1999, payee: "Sample Shopp", amountText: "-19.99"),
                planRow(2, amountMinor: -500, account: "New Pot", payee: "Kiosk", amountText: "-5.00"),
            ],
            ledger: ledger, options: planOptions()
        )
        #expect(plan.importableCount == 1)

        plan.setDecision(.add, forRowAt: 0)
        #expect(plan.importableCount == 2)

        plan.setCreateAccount(named: "New Pot", false)
        #expect(plan.importableCount == 1)
        #expect(plan.accountsToCreateCount == 0)

        plan.setCreateAccount(named: "New Pot", true)
        plan.setDecision(.skip, forRowAt: 0)
        #expect(plan.importableCount == 1)
    }

    @Test("a decision is only offered where there is one to make")
    func decisionsOnlyApplyToNearDuplicates() {
        var plan = Import.buildPlan(
            rows: [
                planRow(1, date: nil, amountMinor: -500, amountText: "-5.00", error: "Unrecognised date"),
                planRow(2, amountMinor: -500, amountText: "-5.00"),
            ],
            ledger: ImportLedger(), options: planOptions()
        )
        plan.setDecision(.add, forRowAt: 0)
        #expect(plan.rows[0].action == .error, "an unreadable row is not a decision")
        #expect(plan.errorCount == 1)

        plan.setDecision(.skip, forRowAt: 1)
        #expect(plan.rows[1].decision == nil)
        #expect(plan.importableCount == 1)

        plan.setDecision(.add, forRowAt: 99)  // out of range: ignored, not a crash
        #expect(plan.rowsRead == 2)
    }

    @Test("a declared account with no name is not created")
    func namelessDeclaredAccountIsSkipped() {
        // A balance-only account is the one thing this plan creates that
        // nothing in the file's rows asked for, so it is the one place an
        // unnamed account could appear -- holding money, in a list, with
        // nothing to call it.
        let plan = Import.buildPlan(
            rows: [planRow(1, amountMinor: -500, amountText: "-5.00")],
            ledger: ImportLedger(),
            options: planOptions([
                DeclaredAccount(name: "   ", currency: "GBP", openingBalanceMinor: 5000),
                DeclaredAccount(name: "Real Pot", currency: "GBP", openingBalanceMinor: 100),
            ])
        )
        #expect(plan.newAccounts.map(\.name) == ["Everyday", "Real Pot"])
    }

    @Test("unticking an account nobody named changes nothing")
    func untickingAnUnknownAccount() {
        var plan = Import.buildPlan(
            rows: [planRow(1, amountMinor: -500, account: "New Pot", amountText: "-5.00")],
            ledger: ImportLedger(), options: planOptions()
        )
        plan.setCreateAccount(named: "Not In This File", false)
        #expect(plan.accountsToCreateCount == 1)
        #expect(plan.importableCount == 1)
    }
}
