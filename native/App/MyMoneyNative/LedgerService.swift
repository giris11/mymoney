// The one door to the database.
//
// `LedgerStore` says of itself: "deliberately not Sendable: one owner, one
// thread. A later phase that needs it from several tasks should put an actor in
// front of it." This is that actor. It is the ONLY thing in the app that holds
// a store, and nothing it returns is a reference to one -- every value that
// leaves here is a `Sendable` struct, so there is no way for a view to end up
// holding the database and touching it from the main thread while an import is
// running on another.
//
// WHY THE WORK IS OFF THE MAIN ACTOR AT ALL. Importing the owner's real backup
// parses 3 MB of JSON, validates it against its own manifest, and writes eleven
// tables inside one transaction. On the main thread that is a frozen app for
// as long as it takes. Every method here is `async` from the caller's side, so
// the UI keeps drawing and can say what it is doing.
//
// THIS COPY CAN NOW BE EDITED, AND IT IS STILL A COPY. Every mutation below
// goes to the LOCAL database and nowhere else: there is no method here that
// writes to the web app, and there cannot be one -- the web app has no server
// and this process has no access to its IndexedDB. What the edits do create is
// DIVERGENCE, which is the thing this phase has to be honest about rather than
// prevent, and `LedgerStore.localEdits()` counts it so the UI can say how far
// this copy has drifted from the backup it was made from.
//
// EVERY MUTATION IS ONE `await`. The store does the whole thing -- validate,
// write, count -- inside one SQLite transaction, so there is no state in this
// actor to keep consistent and nothing to undo if a call throws. A refusal
// comes back as an `EditRefusal` carrying the two sentences the owner needs:
// what was wrong, and what was NOT changed.
import Foundation
import MyMoneyKit

/// What the app knows about the book it is holding, without holding the book.
struct LedgerSummary: Sendable {
    let snapshot: AccountsSnapshot
    let transactionCount: Int
    let accountCount: Int
    let provenance: StoreProvenance
    /// How far this copy has drifted from the file it was imported from. The
    /// number the banner shows, and the reason the banner is a statement of
    /// fact rather than a warning.
    let localEdits: LocalEdits
    /// Where the local copy lives, so the owner can be told exactly what this
    /// app has and where.
    let storePath: String
}

/// A backup file this app has just written, and what is in it.
struct ExportedBackup: Sendable, Hashable {
    let url: URL
    let byteCount: Int
    /// The canonical fingerprint of the file, the same one the import screen
    /// prints for a file it read. Two identical books produce the same hash,
    /// which is what makes "did this land intact?" a question with an answer.
    let contentHash: String
    let accountCount: Int
    let transactionCount: Int
}

/// What an import verified, in the words the owner should see.
struct ImportSummary: Sendable {
    let accountCount: Int
    let transactionCount: Int
    /// Every table the file carried, for the detail list.
    let rowCounts: [(table: String, count: Int)]
    let netWorthMinor: Int64
    let baseCurrency: String
    let missingRateCurrencies: [String]
    /// The file carried a manifest this build knows how to check, and the rows
    /// were recomputed against it and agreed. False means the file simply made
    /// no checkable claim -- not that a claim failed, which is a refusal.
    let manifestVerified: Bool
    /// The store re-exported to the same canonical content hash it read.
    let reproducesSource: Bool
    let contentHash: String
    let exportedAt: String
    let warnings: [String]
    let fileName: String
}

/// Why an import was refused, with the disagreement named.
struct ImportRefusal: Error, Sendable {
    let headline: String
    /// One line per thing that disagreed. Empty for a file that was not a
    /// backup at all.
    let problems: [String]
    let fileName: String
}

actor LedgerService {
    private var store: LedgerStore?

    /// Where the local copy of the book lives.
    ///
    /// Application Support, under the bundle id, which is the directory macOS
    /// and iOS both mean by "data this app owns that the user did not create".
    /// NOT Documents: on iOS that is user-visible and syncable, and a shadow
    /// copy of a ledger appearing in Files beside the real backups is exactly
    /// the confusion this whole phase is trying to avoid.
    static func defaultStoreURL() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true
        )
        let directory = base.appendingPathComponent(
            Bundle.main.bundleIdentifier ?? "com.gs.MyMoneyNative", isDirectory: true
        )
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("ledger.sqlite")
    }

    private func opened() throws -> LedgerStore {
        if let store { return store }
        let store = try LedgerStore.open(at: try Self.defaultStoreURL())
        self.store = store
        return store
    }

    /// Everything the accounts screen needs, or nil when this device holds no
    /// book yet.
    func summary() throws -> LedgerSummary? {
        let store = try opened()
        if try store.isEmpty() { return nil }
        return LedgerSummary(
            snapshot: try store.accountsSnapshot(),
            transactionCount: try store.registerCount(scope: .allAccounts),
            accountCount: try store.liveCount("accounts"),
            provenance: try store.provenance(),
            localEdits: try store.localEdits(),
            storePath: store.path
        )
    }

    func registerLookups() throws -> RegisterLookups {
        try opened().registerLookups()
    }

    // MARK: - Starting a book here
    //
    // THE OTHER WAY A BOOK CAN GET ONTO THIS DEVICE, and until now there was
    // no other way: `importBackup` was the only door, so somebody opening the
    // app for the first time was told that the way to begin was to go and use
    // a different app first. These two calls are what the first run writes.

    /// Start a book: a settings row in the chosen currency, the seeded category
    /// tree, and whatever starting accounts the owner accepted.
    ///
    /// ONE CALL, so first run is ONE COMMIT. The kit refuses outright if this
    /// device already holds a book (`StoreError.bookAlreadyExists`) and there
    /// is no flag that overrides it -- "start fresh" is a button, and a button
    /// that can replace an imported ledger is a way to lose one.
    @discardableResult
    func createBook(baseCurrency: String, startingAccounts: [AccountDraft]) throws -> CreatedBook {
        try opened().createBook(
            baseCurrency: baseCurrency, startingAccounts: startingAccounts
        )
    }

    /// Write this book out as a backup file, and say what is in it.
    ///
    /// ─────────────────────────────────────────────────────────────────────
    /// WHY THIS HAD TO EXIST THE MOMENT A BOOK COULD BE CREATED HERE. Until
    /// now every book on this device was a COPY of one the web app held, so
    /// there was always somewhere to get it back from and an export was a
    /// convenience nobody had written. A book started here has no such
    /// counterpart: this app is its only home, and an app that can create a
    /// book, replace it on import, and never let it out is an app in which the
    /// only thing you can do with your own ledger is lose it. Import already
    /// warns that it replaces; this is what makes that warning survivable.
    ///
    /// THE FILE IS THE SAME FORMAT THE IMPORTER READS, produced by the same
    /// writer the round-trip check uses -- so a file exported here can be
    /// imported here, imported by the web app, and verified by both. The
    /// content hash is reported so it can be compared against the one the
    /// import screen prints for a file.
    ///
    /// Nothing is recorded on the book: an export is a READ. In particular
    /// `lastBackupAt` is deliberately not written, because that would make
    /// looking at your own ledger a change to it, and the local-edit count
    /// would climb for a button that copied bytes out.
    func exportBackup(to directory: URL, today: String) throws -> ExportedBackup {
        let store = try opened()
        let text = try store.exportBackupText()
        let hash = try store.exportContentHash()
        let url = directory.appendingPathComponent("mymoney-backup-\(today).json")
        try Data(text.utf8).write(to: url, options: .atomic)
        return ExportedBackup(
            url: url,
            byteCount: text.utf8.count,
            contentHash: hash,
            accountCount: try store.liveCount("accounts"),
            transactionCount: try store.liveCount("transactions")
        )
    }

    /// Change the currency every total is reported in.
    ///
    /// Converts nothing and re-denominates nothing: each account keeps its own
    /// currency and its own integer minor units, and `Balances.netWorth`
    /// redoes the conversion from the book's rates each time a total is drawn.
    /// A first-run choice that could not be undone would be a trap.
    @discardableResult
    func setBaseCurrency(_ code: String) throws -> Settings {
        try opened().setBaseCurrency(code)
    }

    // MARK: - Reads the editors open on

    func quickAddContext() throws -> QuickAddContext {
        try opened().quickAddContext()
    }

    /// The draft an editor opens on, or nil when this row is a transfer leg --
    /// in which case the caller asks for `transferDraft` instead. Two doors,
    /// because a transfer edited through the ordinary one would be written back
    /// as half a transfer.
    func transactionDraft(id: String) throws -> TransactionDraft? {
        try opened().transactionDraft(forId: id)
    }

    func transferDraft(legId: String) throws -> TransferDraft? {
        try opened().transferDraft(forLegId: legId)
    }

    func transaction(id: String) throws -> Transaction? {
        try opened().transaction(id: id)
    }

    // MARK: - Mutations
    //
    // Each of these is a single call into the store, which does all of it
    // inside one transaction. Nothing here catches an error and continues:
    // a refusal is the answer, and it is the caller's job to show it.

    func save(_ draft: TransactionDraft) throws -> Transaction {
        try opened().saveTransaction(draft)
    }

    func save(_ draft: TransferDraft) throws -> TransferPair {
        try opened().saveTransfer(draft)
    }

    func deleteTransaction(id: String) throws -> DeletedTransactions {
        try opened().deleteTransaction(id: id)
    }

    func undoDelete(_ receipt: DeletedTransactions) throws -> Int {
        try opened().undoDelete(receipt)
    }

    func save(_ draft: AccountDraft) throws -> Account {
        try opened().saveAccount(draft)
    }

    func setAccountArchived(id: String, archived: Bool) throws {
        try opened().setAccountArchived(id: id, archived: archived)
    }

    func setAccountExcluded(id: String, excluded: Bool) throws {
        try opened().setAccountExcluded(id: id, excluded: excluded)
    }

    func moveAccount(id: String, toGroup groupId: String?) throws {
        try opened().moveAccount(id: id, toGroup: groupId)
    }

    func reorderAccount(id: String, _ direction: MoveDirection) throws {
        try opened().reorderAccount(id: id, direction)
    }

    func deleteAccount(id: String) throws -> DeletedRecord {
        try opened().deleteAccount(id: id)
    }

    func save(_ draft: AccountGroupDraft) throws -> AccountGroup {
        try opened().saveAccountGroup(draft)
    }

    func deleteAccountGroup(id: String) throws -> DeletedRecord {
        try opened().deleteAccountGroup(id: id)
    }

    func reorderAccountGroup(id: String, _ direction: MoveDirection) throws {
        try opened().reorderAccountGroup(id: id, direction)
    }

    func undoDelete(_ receipt: DeletedRecord) throws {
        try opened().undoDelete(receipt)
    }

    func registerCount(scope: RegisterScope) throws -> Int {
        try opened().registerCount(scope: scope)
    }

    func registerCount(
        scope: RegisterScope, search: RegisterSearch, lookups: RegisterLookups
    ) throws -> Int {
        try opened().registerCount(scope: scope, search: search, lookups: lookups)
    }

    func registerPage(
        scope: RegisterScope, search: RegisterSearch = .none, after cursor: RegisterCursor?,
        limit: Int, lookups: RegisterLookups
    ) throws -> RegisterPage {
        try opened().registerPage(
            scope: scope, search: search, after: cursor, limit: limit, lookups: lookups
        )
    }

    // MARK: - What the widget is given

    /// Publish the widget's snapshot, and say whether any FIGURE moved.
    ///
    /// The file is rewritten every time -- its `asOf` stamp is newer, and that
    /// stamp is the whole reason a widget is allowed to show an old number --
    /// but the answer is about the figures alone, because waking WidgetKit is
    /// rationed and spending a wake on "nothing changed" costs a later one that
    /// mattered.
    ///
    /// `directory` nil means this build has no shared container; nothing is
    /// written and nothing pretends to have been. See `SharedContainer`.
    @discardableResult
    func publishSnapshot(today: String, to directory: URL?, asOf: Date = Date()) -> Bool {
        guard let directory else { return false }
        let stamp = Self.stamp(asOf)
        do {
            let store = try opened()
            guard try !store.isEmpty() else {
                // NO BOOK MEANS NO WIDGET. A widget still showing last month's
                // net worth for a book that is not on the device any more is
                // the most misleading state this feature has.
                let had = SnapshotFile.read(from: directory) != nil
                SnapshotFile.remove(from: directory)
                return had
            }
            // The SAME `Book` the dashboard and the reports were drawn from --
            // cached against SQLite's own write counter, so this costs a read
            // only when something actually changed.
            let book = try reportBook()
            guard let snapshot = try store.ledgerSnapshot(book: book, today: today, asOf: stamp)
            else { return false }
            let previous = SnapshotFile.read(from: directory)
            try SnapshotFile.write(snapshot, to: directory)
            return previous.map { !$0.sameFigures(as: snapshot) } ?? true
        } catch {
            // A snapshot that could not be written is not an error the owner
            // needs to see: the app is unaffected and the widget says how old
            // its figures are, which is the honest answer either way.
            return false
        }
    }

    /// The ISO instant `SnapshotFreshness` reads back.
    private nonisolated static func stamp(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    // MARK: - What an intent writes through

    /// Everything a spoken entry needs to resolve itself, in one read.
    ///
    /// The intent runs with no screen and, often, no running app. It gets the
    /// SAME context the Quick Add sheet gets -- the same default account, the
    /// same payee index with its learned categories, the same category list --
    /// because a transaction added by voice must land where a transaction added
    /// by hand would have landed.
    func intentContext() throws -> QuickAddContext {
        try opened().quickAddContext()
    }

    /// Read a backup file into the local copy, replacing whatever was there.
    ///
    /// THE REFUSAL IS THE FEATURE. `BackupImporter` recomputes every count and
    /// every total the file claims, from the file's own rows, under the file's
    /// own manifest version, and throws before the database is opened for
    /// writing if any of them disagree. This method's whole job is to turn that
    /// into something a person can read; it adds no check of its own and
    /// relaxes none.
    ///
    /// `requiringExactRoundTrip` is deliberately NOT set. It would turn "this
    /// build cannot re-serialise one key it does not model" into a refusal of a
    /// perfectly sound backup, and refusing a sound backup is the worst outcome
    /// available here. The round trip is REPORTED instead -- see
    /// `ImportSummary.reproducesSource` -- so the owner sees the evidence
    /// rather than being protected from it.
    func importBackup(data: Data, fileName: String) throws -> ImportSummary {
        let store = try opened()
        let result: StoreImportResult
        do {
            result = try store.importBackup(data: data, replacingExistingBook: true)
        } catch let error as BackupImportError {
            switch error {
            case .manifestDisagrees(let problems):
                throw ImportRefusal(
                    headline:
                        "This file's own summary does not match the rows inside it, so nothing "
                        + "was imported and the copy already on this device is untouched.",
                    problems: problems,
                    fileName: fileName
                )
            case .invalid(let message):
                throw ImportRefusal(
                    headline: "This is not a backup this app can read.",
                    problems: [message],
                    fileName: fileName
                )
            }
        }

        let snapshot = try store.accountsSnapshot()
        let counts = Schema.allTables.map { table in
            (table: table, count: result.rowCounts[table] ?? 0)
        }
        return ImportSummary(
            accountCount: result.rowCounts["accounts"] ?? 0,
            transactionCount: result.rowCounts["transactions"] ?? 0,
            rowCounts: counts,
            netWorthMinor: snapshot.netWorth.totalBaseMinor,
            baseCurrency: snapshot.netWorth.baseCurrency,
            missingRateCurrencies: snapshot.netWorth.missingRateCurrencies,
            manifestVerified: result.imported.verified,
            reproducesSource: result.reproducesSource,
            contentHash: result.sourceContentHash,
            exportedAt: result.imported.file.exportedAt,
            warnings: result.warnings,
            fileName: fileName
        )
    }

    // MARK: - The screens that read the whole book
    //
    // Every report in `Reports` takes a `Book`, because that is the shape its
    // arithmetic was proved in and re-expressing six reports as SQL would be
    // six new places for a rounding rule to drift. Building one is cheap and
    // not free, and the reports screen builds one every time a date changes --
    // so the last one is kept.
    //
    // THE CACHE CANNOT GO STALE, and not because anybody remembers to clear
    // it. `store.writeToken()` is SQLite's own count of rows changed on this
    // connection: same token, same rows. A mutation added to this file next
    // year invalidates the cache without knowing the cache exists, which is
    // the only kind of cache that belongs anywhere near a ledger.

    private var cachedBook: (book: Book, token: Int64)?

    private func reportBook() throws -> Book {
        let store = try opened()
        let token = store.writeToken()
        if let cached = cachedBook, cached.token == token { return cached.book }
        let book = try store.book()
        cachedBook = (book, token)
        return book
    }

    /// Everything the dashboard draws, plus the register's own first page for
    /// the recent-transactions list.
    ///
    /// The rows come from `registerPage` rather than from the book, so the
    /// rules about what a row is CALLED are stated once, in the kit, and the
    /// dashboard and the register cannot come to disagree about a transfer's
    /// name.
    func dashboard(today: String, recentLimit: Int = 8) throws -> DashboardScreen? {
        let store = try opened()
        if try store.isEmpty() { return nil }
        let book = try reportBook()
        let lookups = try store.registerLookups()
        let page = try store.registerPage(
            scope: .allAccounts, after: nil, limit: recentLimit, lookups: lookups
        )
        return DashboardScreen(
            summary: try Dashboard.summary(book: book, today: today),
            recent: page.rows,
            transactionCount: try store.registerCount(scope: .allAccounts)
        )
    }

    // MARK: Budgets

    func budgetsScreen(today: String) throws -> BudgetsScreen {
        let book = try reportBook()
        return BudgetsScreen(
            lines: try book.allBudgetProgress(refDate: today),
            archived: Budgets.archived(book.budgets),
            baseCurrency: book.baseCurrency,
            categories: try opened().categoryChoices()
        )
    }

    /// One budget in one window of its own grid. `offset` is a number of
    /// PERIODS from the window containing today -- an offset rather than a
    /// pair of dates, so a window can only ever be one that is on the grid.
    func budgetDetail(id: String, offset: Int, today: String) throws -> BudgetDetailScreen? {
        let book = try reportBook()
        guard let budget = book.budgets.first(where: { $0.id == id }) else { return nil }
        let current = try Budgets.windowContaining(
            period: budget.period, startDate: budget.startDate, date: today
        )
        let window =
            offset == 0
            ? current
            : try Budgets.shiftWindow(
                period: budget.period, startDate: budget.startDate, window: current, by: offset
            )
        let covered = Categories.descendantIds(book.categories, rootIds: budget.categoryIds)
        var byId: [String: MyMoneyKit.Category] = [:]
        for c in book.categories { byId[c.id] = c }
        return BudgetDetailScreen(
            budget: budget,
            offset: offset,
            isCurrentPeriod: window == current,
            progress: try book.budgetProgress(budget, inWindowStarting: window.start),
            categoryNames: budget.categoryIds.map {
                Categories.categoryPathName(byId, id: $0)
            },
            rows: try contributingRows(book: book, window: window, covered: covered),
            baseCurrency: book.baseCurrency
        )
    }

    /// The transactions that actually count toward a budget in a window, in
    /// the register's own words and newest first.
    ///
    /// SAME PREDICATE AS THE ARITHMETIC. A list built from "anything in these
    /// categories" would include transfer legs, and would show a £50 shop in
    /// full when only £8 of it was filed under the budget's category -- and the
    /// list would then not add up to the figure above it.
    /// `Budgets.contributions` decides, exactly as it does for the total.
    ///
    /// THE ROWS ARE NAMED BY `Register`, not by this file. Which of payee, note
    /// or "No payee" wins is a rule stated once in the kit and held to tests
    /// there; restating it here would give the budget screen its own opinion
    /// about what a transaction is called.
    private func contributingRows(
        book: Book, window: PeriodWindow, covered: Set<String>
    ) throws -> [BudgetContribution] {
        var payeeNames: [String: String] = [:]
        for p in book.payees { payeeNames[p.id] = p.name }
        var categoriesById: [String: MyMoneyKit.Category] = [:]
        for c in book.categories { categoriesById[c.id] = c }

        var out: [BudgetContribution] = []
        for tx in book.transactions where window.contains(tx.date) {
            let parts = Budgets.contributions(of: tx, covering: covered)
            if parts.isEmpty { continue }
            let title = Register.title(
                payeeName: tx.payeeId.flatMap { payeeNames[$0] },
                notes: tx.notes,
                // A transfer never contributes to a budget, so this is always
                // false here -- passed explicitly rather than hardcoded so the
                // call reads the same as the register's.
                isTransfer: tx.transferGroupId != nil
            )
            let path = tx.categoryId.map { Categories.categoryPathName(categoriesById, id: $0) }
            let line = Register.categoryLine(
                isTransfer: tx.transferGroupId != nil,
                amountMinor: tx.amountMinor,
                otherAccountName: nil,
                splitCategoryCount: Set(tx.splits.compactMap(\.categoryId)).count,
                hasSplits: !tx.splits.isEmpty,
                categoryPath: (path?.isEmpty ?? true) ? nil : path
            )
            out.append(
                BudgetContribution(
                    id: tx.id,
                    date: tx.date,
                    title: title.text,
                    titleIsPlaceholder: title.isPlaceholder,
                    categoryText: Register.categoryText(line),
                    amountMinor: tx.amountMinor,
                    countedMinor: try Money.sum(parts),
                    currency: tx.currency,
                    isPartOfASplit: !tx.splits.isEmpty
                )
            )
        }
        // Newest first, with the id as a stable tiebreak so two rows on one day
        // cannot swap places between one look and the next.
        return out.sorted {
            $0.date != $1.date ? $0.date > $1.date : $0.id < $1.id
        }
    }

    func saveBudget(_ draft: BudgetDraft) throws -> Budget {
        try opened().saveBudget(draft)
    }

    func setBudgetArchived(id: String, archived: Bool) throws {
        try opened().setBudgetArchived(id: id, archived: archived)
    }

    func deleteBudget(id: String) throws -> DeletedRecord {
        try opened().deleteBudget(id: id)
    }

    // MARK: Schedules

    /// Everything the scheduled-payments screen needs, from one read.
    ///
    /// The plan and the schedule list come out of the SAME read of the store,
    /// so a row on screen and the warning above it are always about the same
    /// book -- the reason `accountsSnapshot` is one call rather than three.
    func schedulesScreen(
        today: String, horizonDays: Int = Upcoming.defaultHorizonDays
    ) throws -> SchedulesScreen {
        let store = try opened()
        return SchedulesScreen(
            plan: try store.upcoming(today: today, horizonDays: horizonDays),
            schedules: try store.schedules(),
            accounts: try store.accountBalances().map(\.account),
            today: today,
            horizonDays: horizonDays,
            categories: try store.categoryChoices()
        )
    }

    func scheduleDetail(id: String, today: String) throws -> ScheduleDetailScreen? {
        let store = try opened()
        guard let schedule = try store.schedule(id: id) else { return nil }
        let accounts = try store.accountBalances().map(\.account)
        let account = accounts.first { $0.id == schedule.accountId }
        let categories = try store.categoryChoices()
        let calendar = schedule.calendar
        var next: [String] = []
        if let calendar, let start = CalendarDate(iso: today) {
            var index = calendar.firstIndex(onOrAfter: start) ?? 0
            while next.count < 6, let date = calendar.date(at: index) {
                next.append(date.iso)
                index += 1
            }
        }
        var remaining: Int? = nil
        if let calendar, let last = calendar.lastIndex, let start = CalendarDate(iso: today),
            let from = calendar.firstIndex(onOrAfter: start)
        {
            remaining = max(0, last - from + 1)
        }
        return ScheduleDetailScreen(
            schedule: schedule,
            history: try store.scheduleHistory(id: id),
            nextDates: next,
            // The account's currency, never a guess: a schedule's amount is in
            // the account's currency and in no other.
            currency: account?.currency ?? "",
            accountName: account?.name ?? "an account not in this copy",
            categoryPath: schedule.categoryId.flatMap { id in
                categories.first { $0.id == id }?.path
            },
            remainingCount: remaining
        )
    }

    @discardableResult
    func save(_ draft: ScheduleDraft) throws -> Schedule {
        try opened().saveSchedule(draft)
    }

    /// The dates this schedule has already taken a decision about.
    ///
    /// Read by the EDITOR, so that changing the cadence or the first date can
    /// say how many of them the new grid would leave stranded -- before the
    /// save rather than afterwards in the history. See
    /// `ScheduleCalendar.datesOffTheGrid`.
    func settledOccurrenceDates(scheduleId: String) throws -> [String] {
        try opened().scheduleHistory(id: scheduleId).map(\.occurrenceDate)
    }

    func setSchedulePaused(id: String, paused: Bool) throws {
        try opened().setSchedulePaused(id: id, paused: paused)
    }

    func setScheduleAutoPost(id: String, autoPost: Bool) throws {
        try opened().setScheduleAutoPost(id: id, autoPost: autoPost)
    }

    func setScheduleRemind(id: String, remind: Bool) throws {
        try opened().setScheduleRemind(id: id, remind: remind)
    }

    func deleteSchedule(id: String) throws -> DeletedRecord {
        try opened().deleteSchedule(id: id)
    }

    @discardableResult
    func postScheduled(_ posting: SchedulePosting) throws -> Transaction {
        try opened().postScheduled(posting)
    }

    func skipOccurrence(scheduleId: String, occurrenceDate: String) throws {
        try opened().skipOccurrence(scheduleId: scheduleId, occurrenceDate: occurrenceDate)
    }

    func unskipOccurrence(scheduleId: String, occurrenceDate: String) throws {
        try opened().unskipOccurrence(scheduleId: scheduleId, occurrenceDate: occurrenceDate)
    }

    /// The schedules that enter themselves, entered.
    ///
    /// Returns nothing to do when this device holds no book at all -- opening
    /// the app on a fresh install must not create a store's worth of anything.
    func postDue(today: String) throws -> AutoPostResult {
        let store = try opened()
        if try store.isEmpty() { return AutoPostResult(posted: [], heldBack: 0, refusals: []) }
        return try store.postDue(today: today)
    }

    /// Which schedule made this transaction, for the badge on the editor.
    func scheduleOrigin(forTransactionId id: String) throws -> ScheduleOrigin? {
        try opened().scheduleOrigin(forTransactionId: id)
    }

    /// How much is waiting, for the badge in the sidebar.
    ///
    /// The same `Upcoming.plan` every other schedule figure comes from, asked
    /// for a count. A cheaper query that counted rows some other way would be a
    /// second definition of "due", and the badge would eventually disagree with
    /// the screen it points at.
    func dueCounts(today: String) throws -> (due: Int, overdue: Int, warnings: Int) {
        let store = try opened()
        if try store.isEmpty() { return (0, 0, 0) }
        let plan = try store.upcoming(today: today)
        return (plan.due.count, plan.overdue.count, plan.warnings.count)
    }

    /// What is due over the reminder horizon, with the schedules that asked to
    /// be reminded about.
    ///
    /// A SEPARATE, LONGER WINDOW from the screen's. The screen shows the next
    /// thirty days because that is a useful thing to look at; the reminders
    /// need to reach as far as the last day a notification could usefully be
    /// set for, which is further.
    func reminderInput(today: String) throws -> (occurrences: [DueOccurrence], reminding: Set<String>) {
        let store = try opened()
        if try store.isEmpty() { return ([], []) }
        let plan = try store.upcoming(today: today, horizonDays: 90)
        let reminding = Set(try store.schedules().filter(\.remind).map(\.id))
        return (plan.all, reminding)
    }

    // MARK: Reports

    func earliestTransactionDate() throws -> String? {
        try opened().earliestTransactionDate()
    }

    // MARK: Insights

    /// Everything the insights screen shows, worked out from the same cached
    /// `Book` the reports use.
    ///
    /// `today` is passed in rather than read here for the same reason the
    /// dashboard passes it: every "next expected", "8 days late" and "no
    /// payment since" on one screen has to be about the same day.
    func insights(today: String) throws -> InsightsScreen? {
        let store = try opened()
        if try store.isEmpty() { return nil }
        return InsightsScreen(
            report: try Insights.report(book: try reportBook(), today: today),
            transactionCount: try store.registerCount(scope: .allAccounts)
        )
    }

    /// One report, already reduced to what the screen draws.
    func report(_ kind: ReportKind, range: DateRange, parentId: String?) throws -> ReportScreen {
        let book = try reportBook()
        let data: ReportData
        switch kind {
        case .netWorth:
            data = .netWorth(
                series: try Reports.netWorthSeries(range, book: book),
                headline: try book.netWorth()
            )
        case .byCategory:
            data = .category(
                report: try Reports.spendingByCategory(range, parentId: parentId, book: book),
                trail: Categories.ancestorTrail(book.categories, id: parentId)
            )
        case .incomeExpense:
            data = .incomeExpense(try Reports.incomeVsExpenseByMonth(range, book: book))
        case .cashFlow:
            data = .cashFlow(try Reports.cashFlowByMonth(range, book: book))
        case .byPayee:
            data = .payee(try Reports.spendingByPayee(range, book: book))
        case .byTag:
            data = .tag(try Reports.spendingByTag(range, book: book))
        }
        return ReportScreen(kind: kind, range: range, data: data, baseCurrency: book.baseCurrency)
    }

    // MARK: - Bringing a statement's rows in
    //
    // A DIFFERENT THING FROM `importBackup`, and the difference is the whole
    // safety argument. `importBackup` REPLACES the book: one file in, eleven
    // tables cleared and rewritten, and afterwards this device holds exactly
    // what the file held. The three calls below ADD to it: rows from a
    // spreadsheet or a bank statement become transactions alongside everything
    // already here, nothing is cleared, and the whole batch can be taken back.
    //
    // NEITHER OF THEM IS A SECOND WRITE PATH. `commitImport` goes through the
    // same `writeTransaction` the transaction editor, the transfer editor,
    // Quick Add and Siri go through -- same validation, same currency read off
    // the account, same category checks -- and it does the whole batch inside
    // one SQLite transaction with an additive census that rolls the lot back
    // unless the live counts grew by exactly what the batch wrote down.

    /// A copy of the book for the import wizard to resolve a file against.
    ///
    /// ONE READ. The plan, the account pickers and the names the preview puts
    /// beside a duplicate all come from this single snapshot, so no two parts
    /// of that screen can be describing the book at two different moments.
    ///
    /// It goes through `reportBook`, which is cached on SQLite's own count of
    /// rows changed -- so opening the wizard right after drawing a report costs
    /// nothing, and a write anywhere invalidates it without knowing the cache
    /// exists.
    func importContext() throws -> ImportContext {
        let book = try reportBook()
        return ImportContext(
            // The LIVE rows: `book()` reads the `live_*` views, never the base
            // tables. A tombstoned transaction handed to the planner would sit
            // in its dedupe index and silently absorb an incoming row, so a
            // re-import after a delete would skip exactly the row the owner
            // deleted on purpose.
            ledger: ImportLedger(book: book),
            choosableAccounts: book.accounts
                .filter { !$0.archived }
                .sorted { ($0.sortOrder, $0.name) < ($1.sortOrder, $1.name) },
            accountsById: Dictionary(
                book.accounts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first }
            ),
            categoryNameById: Dictionary(
                book.categories.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }
            ),
            payeeNameById: Dictionary(
                book.payees.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first }
            ),
            baseCurrency: book.baseCurrency,
            savedMappings: book.settings?.savedMappings ?? [:],
            bookExists: book.settings != nil
        )
    }

    /// Write an import plan. Additive, all or nothing, undoable.
    ///
    /// `creatingBookWithBaseCurrency` is non-nil only when the wizard was
    /// opened on a device with NO BOOK -- then the settings row, the seeded
    /// categories and the whole import land in one transaction. It is ignored
    /// when a book is already here; it can never replace one.
    func commitImport(
        _ plan: ImportPlan, creatingBookWithBaseCurrency baseCurrency: String? = nil
    ) throws -> ImportReceipt {
        let receipt = try opened().commitImport(
            plan, creatingBookWithBaseCurrency: baseCurrency
        )
        // The cached book is now wrong by exactly the rows just written. It
        // would invalidate itself on the write token anyway; this is here so
        // that a reader between the two lines cannot see the old one.
        cachedBook = nil
        return receipt
    }

    /// Take one back. Removal is a tombstone save, so nothing is destroyed and
    /// anything the import created that has been used since is kept.
    func undoImport(batchId: String) throws -> UndoneImport {
        let undone = try opened().undoImport(batchId: batchId)
        cachedBook = nil
        return undone
    }

    /// The ids of every import batch the book holds, for deciding which of the
    /// imports this DEVICE recorded are still there to be undone.
    func importBatchIds() throws -> Set<String> {
        Set(try opened().importBatches().map(\.id))
    }
}
