// The import wizard's state machine: file → (map) → preview → confirm → done.
//
// ─────────────────────────────────────────────────────────────────────────────
// NOTHING HERE WRITES UNTIL `commit()` IS CALLED, AND `commit()` IS CALLED FROM
// ONE PLACE
//
// Reading a statement, guessing its columns, correcting them, resolving every
// row against the book and working out what WOULD happen are all pure reads.
// `Import.buildPlan` is a pure function of (rows, a snapshot of the book,
// options); it cannot reach a database, because it is not given one. The only
// call in this file that changes anything is `LedgerService.commitImport`, and
// it is reached from the preview screen's confirmation and from nowhere else.
//
// So a file that arrives can be opened, examined, re-mapped, re-read under a
// different date ordering and abandoned, any number of times, and the book is
// exactly as it was.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PLAN IS BUILT AGAINST A SNAPSHOT, AND THE COMMIT IS NOT
//
// `ImportContext` is a copy of the book taken when the wizard opens. The plan
// -- including every duplicate decision -- is resolved against that copy. The
// COMMIT is not: `LedgerStore.commitImport` re-reads the accounts and
// categories inside its own transaction and refuses outright if one of them has
// changed currency or been deleted since (`importPlanIsStale`,
// `unknownAccount`, `unknownCategory`). That is the right division. A preview
// has to be a still photograph or the numbers on it would move while they were
// being read; a write has to be checked against the book as it is at the
// instant of writing, and it is.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE WORK IS OFF THE MAIN ACTOR
//
// Parsing a statement and planning it against a book with tens of thousands of
// transactions is not free, and the screen has to keep drawing while it
// happens. Both are pure functions over `Sendable` values, so both run in a
// detached task and the answer comes back as a value.
import Foundation
import MyMoneyKit
import Observation

// MARK: - What the wizard needs to know about the book

/// A copy of the book, taken once when the wizard opens.
///
/// Everything a plan is resolved against, plus the few lookups the preview
/// needs to turn ids back into names. Read in ONE go, so no two parts of the
/// screen can be describing the book at two different moments.
struct ImportContext: Sendable {
    /// What `Import.buildPlan` resolves against. Live rows only -- a
    /// tombstoned transaction handed to the planner would sit in the dedupe
    /// index and silently absorb an incoming row.
    let ledger: ImportLedger
    /// Accounts the owner can pin an import to, in the order the sidebar shows
    /// them. Archived accounts are left out: pinning a statement into an
    /// account the owner has put away is almost certainly a mis-tap.
    let choosableAccounts: [Account]
    let accountsById: [String: Account]
    let categoryNameById: [String: String]
    let payeeNameById: [String: String]
    let baseCurrency: String
    /// Mappings the BOOK carries -- saved by the web app when it read a file of
    /// the same shape. Keyed by file signature.
    let savedMappings: [String: ColumnMapping]

    /// The name of an account already in the book.
    func accountName(_ id: String) -> String? { accountsById[id]?.name }
}

// MARK: - What an import did

/// What a committed import added, in the terms the Done screen states.
///
/// A VALUE OF THIS APP'S OWN rather than the kit's `ImportReceipt`, for two
/// reasons. The screen wants NAMES ("created Everyday Current") where the
/// receipt carries ids, and the names are in the plan the owner just approved.
/// And a value this app can construct is a value a reach measurement can put on
/// screen without committing anything -- see `Reach.importMeasurement`.
struct ImportOutcome: Sendable, Hashable {
    let batchId: String
    let fileName: String
    /// Transactions written. The batch's own count, which is what LANDED --
    /// not the number of rows the file held.
    let transactionCount: Int
    /// The accounts this import created, by name.
    let accountsCreated: [String]
    let categoriesCreated: Int
    let payeesCreated: Int
    let tagsCreated: Int
    /// Rows identical to something already in the book.
    let duplicatesSkipped: Int
    /// Near-duplicates the owner left set to skip.
    let decisionsSkipped: Int
    /// Rows that could not be read at all.
    let unreadableRows: Int
    /// Rows written whose file declared a currency other than their account's.
    let currencyMismatchCount: Int
    /// Rows written whose opposite transfer leg was not.
    let unpairedTransferCount: Int
    /// When it happened, for the list of imports that can still be undone.
    let importedAt: Date

    init(receipt: ImportReceipt, plan: ImportPlan, importedAt: Date = Date()) {
        batchId = receipt.batchId
        fileName = receipt.fileName
        transactionCount = receipt.transactionCount
        // Named from the PLAN rather than looked up from the receipt's ids: the
        // plan is what the owner ticked, and these are exactly the accounts
        // that were on screen beside those tick boxes.
        accountsCreated = plan.newAccounts.filter(\.create).map(\.name)
        categoriesCreated = receipt.categoriesCreated
        payeesCreated = receipt.payeesCreated
        tagsCreated = receipt.tagsCreated
        duplicatesSkipped = receipt.duplicatesSkipped
        decisionsSkipped = receipt.decisionsSkipped
        unreadableRows = receipt.unreadableRows
        currencyMismatchCount = receipt.currencyMismatchCount
        unpairedTransferCount = receipt.unpairedTransferCount
        self.importedAt = importedAt
    }

    /// For a measurement, and for nothing else. See `Reach.importMeasurement`.
    init(
        batchId: String, fileName: String, transactionCount: Int, accountsCreated: [String],
        categoriesCreated: Int, payeesCreated: Int, tagsCreated: Int, duplicatesSkipped: Int,
        decisionsSkipped: Int, unreadableRows: Int, currencyMismatchCount: Int,
        unpairedTransferCount: Int, importedAt: Date
    ) {
        self.batchId = batchId
        self.fileName = fileName
        self.transactionCount = transactionCount
        self.accountsCreated = accountsCreated
        self.categoriesCreated = categoriesCreated
        self.payeesCreated = payeesCreated
        self.tagsCreated = tagsCreated
        self.duplicatesSkipped = duplicatesSkipped
        self.decisionsSkipped = decisionsSkipped
        self.unreadableRows = unreadableRows
        self.currencyMismatchCount = currencyMismatchCount
        self.unpairedTransferCount = unpairedTransferCount
        self.importedAt = importedAt
    }

    /// Everything that was skipped, whatever the reason. The number that has to
    /// add up with `transactionCount` against the file's own row count.
    var skippedCount: Int { duplicatesSkipped + decisionsSkipped + unreadableRows }
}

/// What undoing an import took back, and what it deliberately left.
struct ImportUndoOutcome: Sendable, Hashable {
    let transactionCount: Int
    let accountsRemoved: Int
    let categoriesRemoved: Int
    let payeesRemoved: Int
    let tagsRemoved: Int
    /// Things the import created that something else has used since, and which
    /// were therefore kept rather than removed.
    let keptCount: Int

    init(_ undone: UndoneImport) {
        transactionCount = undone.transactionCount
        accountsRemoved = undone.accountIds.count
        categoriesRemoved = undone.categoryIds.count
        payeesRemoved = undone.payeeIds.count
        tagsRemoved = undone.tagIds.count
        keptCount = undone.keptAccountIds.count + undone.keptCategoryIds.count
    }
}

// MARK: - The wizard

/// Which of the file's three shapes this is. It decides whether there is a
/// mapping step at all, and what the preview can say about balances.
enum ImportLayout: Hashable {
    /// MoneyWiz's Report export: account header rows carrying each account's
    /// closing balance, interleaved with transactions. The only layout that can
    /// supply an opening balance, and so the only one whose preview can check
    /// each account against the figure the file states.
    case moneyWizReport
    /// MoneyWiz's flat export: one row per transaction.
    case moneyWizFlat
    /// Anything else with a header row and columns.
    case generic

    var isMoneyWiz: Bool { self != .generic }

    var source: ImportSource { isMoneyWiz ? .moneywiz : .csv }

    /// What the owner is told this file is, before anything else is said about
    /// it.
    var headline: String {
        switch self {
        case .moneyWizReport: return "MoneyWiz report export"
        case .moneyWizFlat: return "MoneyWiz export"
        case .generic: return "Spreadsheet or bank statement"
        }
    }
}

enum ImportWizardStep: Hashable {
    /// Which column is what. Generic CSV only -- a MoneyWiz export names its
    /// own columns, so there is nothing to correct.
    case map
    /// What would happen, in full. The step this whole screen exists for.
    case preview
    /// What happened, and the way back out of it.
    case done
}

@MainActor
@Observable
final class ImportWizardModel: Identifiable {
    nonisolated let id = UUID()

    // What arrived
    let fileName: String
    let layout: ImportLayout
    /// The file's text, kept because a MoneyWiz export may have to be re-read
    /// under a different date ordering.
    private let text: String
    /// The raw table, header row included. What the map step shows samples from.
    private(set) var table: CSVTable
    /// The header row as it stands in the file.
    private(set) var headers: [String]

    // What the book looked like when this started
    let context: ImportContext
    private let service: LedgerService

    // Where we are
    private(set) var step: ImportWizardStep
    /// True while a parse, a plan or a commit is in flight. Every button that
    /// could start a second one is disabled by it.
    private(set) var busy = false
    /// Something went wrong that is not a refusal by the plan. Shown in place,
    /// never swallowed.
    private(set) var problem: String?

    // The mapping step
    var mapping = CSVMapping()
    private(set) var mappingOrigin: MappingOrigin = .guessed
    /// The account every row is pinned to, whatever the file says. Empty means
    /// "use the file's own Account column".
    var fixedAccountId = ""

    // The preview step
    private(set) var plan: ImportPlan?
    /// What the parser said about the file: unrecognised columns, rows it could
    /// not make sense of at all.
    private(set) var parserWarnings: [String] = []
    /// MoneyWiz Report layout only: one summary per account in the file.
    private(set) var reportAccounts: [ReportAccount] = []
    /// How the dates in a MoneyWiz file were read. Correctable, because an
    /// all-ambiguous column (every value ≤ 12/12) cannot be told apart from a
    /// day-first one, and the wrong choice transposes every date in the file.
    private(set) var dateOrder: DateOrder = .dmy

    // The done step
    private(set) var outcome: ImportOutcome?
    private(set) var undone: ImportUndoOutcome?

    /// Work a stray dismissal would destroy: a file is loaded and nothing has
    /// been written yet. False on the done step -- there is nothing left to
    /// lose once it has landed, and the undo is on screen.
    var hasUnsavedWork: Bool { step != .done }

    // MARK: Starting

    /// Build a wizard for a file that has already been identified as delimited
    /// text. Returns nil when there is no table in it at all -- which
    /// `IncomingFile.kind` has already ruled out, so this is a guard rather
    /// than a path the owner reaches.
    init?(fileName: String, text: String, context: ImportContext, service: LedgerService) {
        let table = CSV.parse(text)
        guard let header = table.data.first, table.data.count >= 2 else { return nil }
        let headers = header.map(Names.clean)
        self.fileName = fileName
        self.text = text
        self.table = table
        self.headers = headers
        self.context = context
        self.service = service

        // ORDER MATTERS, and it is the web app's order for the same reason. A
        // Report export also passes the flat MoneyWiz header test -- it has
        // Account, Date, Amount and Payee columns -- but the two layouts mean
        // opposite things by them: in a report file the "Account" column holds
        // the account's CURRENCY on account rows and the account NAME on
        // transaction rows. Read as a flat export it would import account
        // headers as transactions and file everything under accounts called
        // after currency codes. So the report test goes first, always.
        if Import.isMoneyWizReportCsv(headers: headers) {
            layout = .moneyWizReport
            step = .preview
        } else if Import.isMoneyWizCsv(headers: headers) {
            layout = .moneyWizFlat
            step = .preview
        } else {
            layout = .generic
            step = .map
        }
        parserWarnings = table.errors
    }

    /// Read the file. For a MoneyWiz export this also builds the plan, because
    /// there is nothing for the owner to correct first; for a generic CSV it
    /// only works out the mapping to offer.
    func start() async {
        switch layout {
        case .moneyWizReport, .moneyWizFlat:
            await rebuildFromMoneyWiz()
        case .generic:
            loadMapping()
        }
    }

    // MARK: The mapping step

    /// The guess, or the mapping this device or this book already holds for a
    /// file of the same shape.
    ///
    /// GUESS FIRST, ALWAYS. The signature depends on `headerRow`, which is only
    /// known from a guess -- a headerless file keys on its column count, and
    /// until something has decided the file is headerless there is no key to
    /// look under.
    private func loadMapping() {
        let sampleRows = Array(table.data.dropFirst().prefix(10))
        let guessed = CSVMapping(Import.guessMapping(headers: headers, sampleRows: sampleRows))
        let signature = ImportFileSignature.of(headers: headers, headerRow: guessed.headerRow)

        if let remembered = MappingMemory.remembered(for: signature) {
            mapping = remembered
            mappingOrigin = .device
            return
        }
        // The book's own memory: a mapping the web app saved when it read a
        // file of this shape, carried here inside the backup.
        if let stored = context.savedMappings.first(where: {
            ImportFileSignature.matches(storedKey: $0.key, signature: signature)
        }) {
            mapping = CSVMapping(stored.value)
            mappingOrigin = .book
            return
        }
        mapping = guessed
        mappingOrigin = .guessed
    }

    /// How many columns the map step has to offer. The header row is not
    /// always the widest: a bank export routinely leaves the last column off
    /// the header and fills it on every row, and a column nobody can see is a
    /// column nobody can map.
    var columnCount: Int {
        max(headers.count, table.data.prefix(25).map(\.count).max() ?? 0)
    }

    /// The first couple of data rows, for showing what a column holds.
    func sampleRows(limit: Int = 2) -> [[String]] {
        Array((mapping.headerRow ? Array(table.data.dropFirst()) : table.data).prefix(limit))
    }

    /// How many rows of this file the parser will look at.
    ///
    /// Counted the way `parseWithMapping` counts, because this number is on
    /// screen for the owner to hold against the file: a row of nothing but
    /// empty cells is not a row, and a count that included them would be a
    /// number that never matches anything.
    var dataRowCount: Int {
        (mapping.headerRow ? Array(table.data.dropFirst()) : table.data)
            .count { row in row.contains { !Names.clean($0).isEmpty } }
    }

    /// What a column is called: its header, or its position when the file has
    /// no header row (or an empty cell where one should be).
    func columnLabel(_ column: Int) -> String {
        guard mapping.headerRow, column < headers.count else { return "Column \(column + 1)" }
        let header = Names.clean(headers[column])
        return header.isEmpty ? "Column \(column + 1)" : header
    }

    /// What is still missing before this file can be previewed.
    var missingRequirements: [String] {
        mapping.missingRequirements(fixedAccountChosen: !fixedAccountId.isEmpty)
    }

    /// The account every row would be pinned to, if one has been chosen.
    var fixedAccount: Account? { context.accountsById[fixedAccountId] }

    /// The currency an amount with no Currency column is read at. The pinned
    /// account's if there is one, because that is the currency the row will be
    /// STORED in (D30), and only otherwise the book's base.
    var mappingCurrency: String { fixedAccount?.currency ?? context.baseCurrency }

    /// Apply the mapping and go to the preview. The one place the mapping is
    /// remembered: while it is being edited it is half-built, and half-built is
    /// not an answer worth offering back next time.
    func continueFromMap() async {
        guard !busy, missingRequirements.isEmpty else { return }
        busy = true
        problem = nil
        defer { busy = false }

        MappingMemory.remember(
            mapping,
            for: ImportFileSignature.of(headers: headers, headerRow: mapping.headerRow)
        )

        let data = table.data
        let columnMapping = mapping.columnMapping
        let currency = mappingCurrency
        let rows = await Task.detached {
            Import.parseWithMapping(data, mapping: columnMapping, fixedCurrency: currency)
        }.value

        await buildPlan(
            rows: rows,
            options: ImportPlanOptions(
                source: .csv,
                fileName: fileName,
                defaultCurrency: context.baseCurrency,
                fixedAccountId: fixedAccountId.isEmpty ? nil : fixedAccountId
            )
        )
        if plan != nil { step = .preview }
    }

    // MARK: The MoneyWiz path

    /// Read a MoneyWiz file and plan it.
    ///
    /// The account summaries and the rows come from the SAME parse, always. A
    /// re-read under a different date ordering changes every date, which
    /// changes which transfer legs pair and which rows look like duplicates --
    /// and therefore the sums behind every derived opening balance. Carrying
    /// the old summaries over would show balances worked out from rows that no
    /// longer exist.
    private func rebuildFromMoneyWiz(order: DateOrderOption = .auto) async {
        busy = true
        problem = nil
        defer { busy = false }

        let text = self.text
        let isReport = layout == .moneyWizReport
        if isReport {
            let parsed = await Task.detached {
                Import.parseMoneyWizReportCsv(text, dateFormat: order)
            }.value
            reportAccounts = parsed.accounts
            parserWarnings = parsed.warnings
            dateOrder = parsed.detectedDateFormat
            await buildPlan(
                rows: parsed.rows,
                options: ImportPlanOptions(
                    source: .moneywiz,
                    fileName: fileName,
                    defaultCurrency: context.baseCurrency,
                    declaredAccounts: Import.reportPlanOptions(parsed.accounts)
                )
            )
        } else {
            let parsed = await Task.detached {
                Import.parseMoneyWizCsv(text, dateFormat: order)
            }.value
            parserWarnings = parsed.warnings
            dateOrder = parsed.detectedDateFormat
            await buildPlan(
                rows: parsed.rows,
                options: ImportPlanOptions(
                    source: .moneywiz, fileName: fileName, defaultCurrency: context.baseCurrency
                )
            )
        }
        // The parser reports what it DETECTED; once the owner has overridden
        // it, the chosen ordering is what the rows were actually read with.
        if case .fixed(let chosen) = order { dateOrder = chosen }
    }

    /// Re-read a MoneyWiz file under a different date ordering (D20).
    ///
    /// The whole plan is rebuilt, and every near-duplicate decision starts
    /// over, because every date has changed and so has every dedupe match. The
    /// screen says so before this runs.
    func setDateOrder(_ order: DateOrder) async {
        guard layout.isMoneyWiz, order != dateOrder, !busy else { return }
        await rebuildFromMoneyWiz(order: .fixed(order))
    }

    /// One data cell of the file's date column, spelled out under the current
    /// reading. An ambiguous export -- 03/04 is either -- can then be checked
    /// at a glance instead of after the import.
    var dateExample: (raw: String, spelled: String)? {
        guard let column = headers.firstIndex(where: { Names.key($0) == "date" }) else {
            return nil
        }
        for row in table.data.dropFirst() {
            guard column < row.count else { continue }
            let raw = row[column].trimmingCharacters(in: .whitespaces)
            guard !raw.isEmpty else { continue }
            guard let iso = Import.parseDateString(raw, format: .fixed(dateOrder)) else {
                continue
            }
            // Spelled with a long month on purpose: rendered as DD/MM/YYYY it
            // would look identical to the raw cell and prove nothing.
            return (raw, Display.dateSpoken(iso))
        }
        return nil
    }

    // MARK: Planning

    private func buildPlan(rows: [ParsedRow], options: ImportPlanOptions) async {
        let ledger = context.ledger
        plan = await Task.detached {
            Import.buildPlan(rows: rows, ledger: ledger, options: options)
        }.value
    }

    // MARK: The two edits the preview offers

    func setDecision(_ decision: ImportDecision, forRowAt index: Int) {
        plan?.setDecision(decision, forRowAt: index)
    }

    /// Answer every near-duplicate at once. The screen offers this because a
    /// file can hold hundreds of them and deciding each one individually is not
    /// a thing anybody does on a phone.
    func decideAll(_ decision: ImportDecision) {
        guard var plan else { return }
        for index in plan.rows.indices where plan.rows[index].action == .needsDecision {
            plan.setDecision(decision, forRowAt: index)
        }
        self.plan = plan
    }

    func setCreateAccount(named name: String, _ create: Bool) {
        plan?.setCreateAccount(named: name, create)
    }

    // MARK: Committing

    /// Back one step. The generic path goes preview → map; the MoneyWiz path
    /// has no map step, so its Back closes the wizard and returns to the file.
    func back() {
        guard step == .preview, layout == .generic else { return }
        step = .map
    }

    /// Write the plan. The ONE call in this file that changes the book.
    func commit() async {
        guard let plan, !busy, plan.importableCount > 0 else { return }
        busy = true
        problem = nil
        defer { busy = false }
        do {
            let receipt = try await service.commitImport(plan)
            let outcome = ImportOutcome(receipt: receipt, plan: plan)
            self.outcome = outcome
            ImportHistory.record(outcome)
            step = .done
        } catch {
            problem = AppModel.message(for: error)
        }
    }

    /// Put this wizard on its final step with a MADE-UP result, so that step's
    /// bar can be measured.
    ///
    /// It writes nothing, it records nothing, and it refuses outright unless
    /// `MYMONEY_REACH=1` is in the launch environment -- which no shipped
    /// launch sets. See `Reach.ImportMeasurement`: the alternative was a
    /// measurement that committed a real import in order to photograph the undo
    /// button, and there is no version of that worth the number.
    func presentMeasurementOutcome() {
        guard Reach.isMeasuring, outcome == nil else { return }
        outcome = ImportOutcome(
            batchId: "measurement", fileName: fileName,
            transactionCount: plan?.importableCount ?? 0,
            accountsCreated: plan?.newAccounts.filter(\.create).map(\.name) ?? [],
            categoriesCreated: 0, payeesCreated: 0, tagsCreated: 0,
            duplicatesSkipped: plan?.exactDuplicateCount ?? 0, decisionsSkipped: 0,
            unreadableRows: plan?.errorCount ?? 0, currencyMismatchCount: 0,
            unpairedTransferCount: 0, importedAt: Date()
        )
        step = .done
    }

    /// Take the whole import back.
    ///
    /// EXACT, AND IT SAYS WHAT IT KEPT. Removal is a tombstone save, so nothing
    /// is destroyed; anything the import created that has since been used -- an
    /// account with a transaction added to it, a category something else is
    /// filed under -- is kept and counted rather than dragged out from under
    /// the row that now needs it.
    func undo() async {
        guard let outcome, undone == nil, !busy else { return }
        busy = true
        problem = nil
        defer { busy = false }
        do {
            undone = ImportUndoOutcome(try await service.undoImport(batchId: outcome.batchId))
            ImportHistory.forget(batchId: outcome.batchId)
        } catch {
            problem = AppModel.message(for: error)
        }
    }
}
